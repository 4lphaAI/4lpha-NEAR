// Zero-spend live check for Phase 1 fix 4 (docs/specs/PHASE-1-FIX-4-SPEC.md): OutLayer answers a re-sent idempotency
// key with the request that already holds it. Runbook: docs/runbooks/PHASE-1-HIRE-RUNBOOK.md, "Same-key re-send check".
//
// Usage, from the repository root after `npm run build`:
//   node scripts\probe-same-key-resend.mjs JOB_ID              plan only: reads the local journal, sends nothing
//   node scripts\probe-same-key-resend.mjs JOB_ID --yes-live   asks for that job's management link (hidden), sends one request
//
// It picks the job's latest finished agent storage registration that has an OutLayer request id and sends the same
// registration again (POST /wallet/v1/storage-deposit, same token, no account id) with that row's idempotency key.
// Expected: HTTP 200 with `error: duplicate_idempotency_key` and the journaled request id. If OutLayer did not
// deduplicate, a registration of an account that is already registered answers `already_registered` and sends no
// transaction. The management link, its key and the idempotency key are never printed or written.
import readline from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { keyFrom, policyProblem } from './recover-near.mjs';

const clean = x => typeof x === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(x) && !x.startsWith('wk_') ? x : '-';

/** The verdict for one answer to the re-sent registration. */
export function judge(http, data, journaled) {
  const body = data && typeof data === 'object' ? data : null;
  if (http === 200 && body?.error === 'duplicate_idempotency_key') {
    return body.request_id === journaled
      ? { pass: true, line: `PASS: OutLayer answered duplicate_idempotency_key with the journaled request id (status ${clean(body.status)}). Nothing ran twice.` }
      : { pass: false, line: `NOT PROVEN: the duplicate answer names another request id (${clean(body.request_id)}). Keep this output for review.` };
  }
  if (http === 200 && body?.already_registered === true) {
    return { pass: false, line: 'NOT PROVEN: OutLayer handled the registration again (already_registered, no transaction). The same key was not deduplicated. Keep this output for review.' };
  }
  if (http === 409) return { pass: false, line: 'INCONCLUSIVE: wallet_busy, another request is in flight. Run again in a minute.' };
  if (http === 403 || http === 429) return { pass: false, line: `INCONCLUSIVE: refused (${clean(body?.error)}). A refusal holds nothing. Check the freeze or the quota and run again.` };
  return { pass: false, line: `NOT PROVEN: HTTP ${http}${body?.error ? `, ${clean(body.error)}` : ''}${body?.tx_hash ? ', with a transaction hash' : ''}. Keep this output for review.` };
}

/** The job and the storage row to re-send, read from the local journal (read-only). Returns a stop reason as a string. */
export function pick(dbPath, prefix) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const jobs = db.prepare('SELECT id, owner, agent_account AS agent FROM jobs WHERE id LIKE ?').all(`${prefix}%`);
    if (jobs.length !== 1 || typeof jobs[0].agent !== 'string') return jobs.length ? 'that job has no agent wallet.' : 'no single job matches that id.';
    const job = jobs[0];
    const row = db.prepare("SELECT request, request_id AS requestId, idem_key AS idem FROM ops WHERE job_id=? AND kind='storage' AND state='finished' AND verdict='success' AND request_id IS NOT NULL ORDER BY created_at DESC LIMIT 1").get(job.id);
    if (!row) return 'that job has no finished agent storage registration with an OutLayer request id.';
    let token = null;
    try { token = JSON.parse(row.request).receiver; } catch { token = null; }
    if (typeof token !== 'string' || !token) return 'the journaled registration has no token.';
    return { job: String(job.id), owner: String(job.owner), agent: job.agent, token, requestId: String(row.requestId), idem: String(row.idem) };
  } finally { db.close(); }
}

function askHidden(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = s => { if (!muted) rl.output.write(s); };
    rl.question(question, answer => { rl.close(); process.stdout.write('\n'); resolve(answer); });
    muted = true;
  });
}

async function main() {
  const [prefix, flag] = process.argv.slice(2);
  if (!prefix || !/^[0-9a-f-]{8,36}$/.test(prefix) || (flag !== undefined && flag !== '--yes-live')) {
    console.error('Usage: node scripts\\probe-same-key-resend.mjs JOB_ID [--yes-live]\n  JOB_ID: the job id, or its first 8 characters, from the job page.');
    process.exit(1);
  }
  const { outlayerUrl } = await import(new URL('../dist/src/core/config.js', import.meta.url).href);
  // The local launcher (start-near.cmd) keeps its jobs in data\local.db.
  const db = process.env.FOURLPHA_DB_PATH || 'data/local.db';
  console.log(`Journal: ${db}`);
  const picked = pick(db, prefix);
  if (typeof picked === 'string') { console.error(`STOP: ${picked}`); process.exit(2); }
  console.log(`Job ${picked.job}, agent ${picked.agent}: will re-send the agent registration on ${picked.token} under the key of OutLayer request ${clean(picked.requestId)}.`);
  if (flag !== '--yes-live') { console.log('Plan only. Run again with --yes-live to send that one request.'); return; }
  const key = keyFrom(await askHidden('Paste the management link of this job (hidden) and press Enter: '));
  if (!key) { console.error('STOP: no wk_ key found in what you pasted.'); process.exit(1); }
  const base = outlayerUrl(), auth = { authorization: `Bearer ${key}` };
  const read = async (path, init) => {
    try {
      const res = await fetch(new URL(path, base).href, { ...init, redirect: 'error', signal: AbortSignal.timeout(95_000) });
      let data = null; try { data = JSON.parse(await res.text()); } catch { data = null; }
      return { http: res.status, data };
    } catch { return { http: 0, data: null }; }
  };
  const policy = await read('/wallet/v1/policy', { headers: auth });
  const problem = policyProblem(policy.http, policy.data, picked.agent, picked.owner);
  if (problem) { console.error(`STOP: ${problem}`); process.exit(3); }
  const answer = await read('/wallet/v1/storage-deposit', { method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'x-idempotency-key': picked.idem }, body: JSON.stringify({ token: picked.token }) });
  const d = answer.data && typeof answer.data === 'object' ? answer.data : {};
  console.log(`Answer: HTTP ${answer.http}, error ${clean(d.error)}, request id matches the journal: ${d.request_id === picked.requestId ? 'yes' : 'no'}, status ${clean(d.status)}, transaction hash returned: ${d.tx_hash || d.result?.tx_hash ? 'yes' : 'no'}.`);
  const verdict = judge(answer.http, answer.data, picked.requestId);
  console.log(verdict.line);
  process.exitCode = verdict.pass ? 0 : 4;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
