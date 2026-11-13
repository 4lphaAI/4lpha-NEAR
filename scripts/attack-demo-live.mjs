// Attack demo, live leg (docs/specs/ATTACK-DEMO-SPEC.md section 4, runbook docs/runbooks/ATTACK-DEMO-RUNBOOK.md).
//
// Plays an attacker who stole an agent's wk_ key and asks OutLayer to pay an account that is not on the wallet policy's
// whitelist. One request at most: 0.001 NEAR from the agent wallet to TARGET_ACCOUNT. The target must be an account the
// operator owns, so that if the policy failed the money would reach the operator. Expected: HTTP 403 policy_denied
// naming the whitelist, and an unchanged agent balance.
//
// Usage, from the repository root after `npm run build`, with the job's wallet not in use by the worker:
//   node scripts\attack-demo-live.mjs AGENT_ACCOUNT OWNER_ACCOUNT TARGET_ACCOUNT              plan only: reads, sends nothing
//   node scripts\attack-demo-live.mjs AGENT_ACCOUNT OWNER_ACCOUNT TARGET_ACCOUNT --yes-live   asks for the management link (hidden), sends once
//
// It never re-sends and never prints or writes the key. Exit codes: 0 pass or plan printed, 1 usage or refused before
// sending, 2 read failure before sending, 3 stopped after sending, 4 the policy let the transfer through.
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { keyFrom, near } from './recover-near.mjs';

export const AMOUNT = 1_000_000_000_000_000_000_000n; // 0.001 NEAR
export const KEEP = 5_000_000_000_000_000_000_000n; // 0.005 NEAR left for storage and gas
const IMPLICIT = /^[0-9a-f]{64}$/;
const ACCOUNT = /^(?=.{2,64}$)([a-z0-9]+[-_.])*[a-z0-9]+$/;

/** The plan-only refusals; null when the request may be prepared. */
export function planProblem(o, agentAccount, targetAccount, spendable) {
  if (o.target === o.owner || o.target === o.agent) return 'the target must be another account than the owner and the agent.';
  if (!agentAccount) return 'the agent account does not exist on chain. Check the 64-character account on the job page.';
  if (!targetAccount) return 'the target account does not exist on chain. Use an existing account you own.';
  if (spendable < AMOUNT) return `the agent needs at least ${near(AMOUNT + KEEP)} free (plus its storage), so that a refusal can only come from the policy.`;
  return null;
}

/** The OutLayer policy answer (GET /wallet/v1/policy) checked before the request. Returns a stop reason, or null. */
export function policyProblem(http, data, o) {
  if (http !== 200 || !data || typeof data !== 'object') return 'could not read the wallet policy with this key. Check the link you pasted.';
  if (data.policy !== 'stored') return 'this wallet has no stored policy, so nothing would limit the transfer.';
  // Required, not only checked when present: PASS reads the typed agent's balance, so the key must be that agent's (audit L-1).
  if (data.controller !== `ed25519:${o.agent}`) return 'the pasted link does not belong to the agent wallet on the command line.';
  if (data.frozen === true) return 'the wallet is frozen, so a refusal would show the freeze, not the whitelist. Unfreeze it or use another wallet.';
  if (data.frozen !== false) return 'could not read the freeze state. Run this again in a minute.';
  const rules = data.rules && typeof data.rules === 'object' ? data.rules : {};
  const list = rules.addresses && rules.addresses.mode === 'whitelist' ? rules.addresses.list : null;
  if (!Array.isArray(list)) return 'the policy has no address whitelist.';
  // Native transfers allowed by type and token, so the only whitelist refusal left is the address one (audit L-2).
  if (!Array.isArray(rules.transaction_types) || !rules.transaction_types.includes('transfer') || !Array.isArray(rules.allowed_tokens) || !rules.allowed_tokens.includes('native')) {
    return 'the policy does not allow native transfers by type and token, so a refusal would not show the address whitelist.';
  }
  if (!list.includes(o.owner)) return 'the owner account you typed is not on this wallet\'s whitelist. Check the account.';
  if (list.includes(o.target)) return 'the target is on this wallet\'s whitelist, so the transfer would be allowed. Pick an account that is not on it.';
  return null;
}

/**
 * The attack, with every dependency injected so it can be tested offline.
 * d: { readAt(account): Promise<{height, account: {amount, locked, storageUsage} | null}> (throws when unreadable),
 *      spendable(account): bigint, askKey(): Promise<opaque key | null>, policy(key): Promise<{http, data}>,
 *      transfer(key, to, amount, idem): Promise<SubmitResult>, sleep(ms), now(): number, log(line) }
 * o: { agent, owner, target, live }
 * Returns 'plan', 'refused', 'read', 'pass', 'stopped' or 'fail'.
 */
export async function attack(d, o) {
  const stop = (why, code) => (d.log(`STOP: ${why}`), code);
  let agentRead, targetRead;
  try { agentRead = await d.readAt(o.agent); targetRead = await d.readAt(o.target); }
  catch { return stop('could not read the accounts. Nothing was sent. Try again in a minute.', 'read'); }
  const problem = planProblem(o, agentRead.account, targetRead.account, d.spendable(agentRead.account));
  if (problem) return stop(`${problem} Nothing was sent.`, 'refused');
  d.log(`Agent ${o.agent}: ${near(agentRead.account.amount)}. Target ${o.target} exists.`);
  d.log(`Attack: with the agent's own wk_ key, ask OutLayer to send ${near(AMOUNT)} from the agent to ${o.target}.`);
  d.log('Expected: HTTP 403 policy_denied naming the whitelist, and an unchanged agent balance.');
  if (!o.live) { d.log('Plan only. Run again with --yes-live to send the one request.'); return 'plan'; }

  const key = await d.askKey();
  if (!key) return stop('no wk_ key found in what you pasted. Nothing was sent.', 'refused');
  const p = await d.policy(key);
  const pp = policyProblem(p.http, p.data, o);
  if (pp) return stop(`${pp} Nothing was sent.`, 'refused');
  d.log(`Policy: stored, not frozen, ${p.data.rules.addresses.list.length} whitelisted accounts, the owner on it, ${o.target} not on it.`);
  let before;
  try { before = await d.readAt(o.agent); } catch { return stop('could not read the agent balance. Nothing was sent. Try again in a minute.', 'read'); }
  if (!before.account || d.spendable(before.account) < AMOUNT) return stop(`the agent no longer has ${near(AMOUNT + KEEP)} free. Nothing was sent.`, 'refused');
  // A fresh key per run: a stored key of an earlier refused run must not come back as a duplicate "accepted". A UUID, the
  // only key form proven with OutLayer (audit L-3). A re-run after an ambiguous answer is therefore a new request (spec 4.4).
  const idem = randomUUID();
  d.log(`${new Date(d.now()).toISOString()} Sending one request: transfer ${near(AMOUNT)} to ${o.target} (agent ${near(before.account.amount)} at block ${before.height}).`);
  const r = await d.transfer(key, o.target, AMOUNT, idem);

  if (r.kind === 'denied' && r.code === 'policy_denied' && /whitelist/i.test(r.message) && r.message.includes(o.target)) {
    d.log(`OutLayer answered: HTTP 403 ${r.code} "${r.message}"`);
    // Audit M-4: the margin counts from the first finalized block read after the answer, so a transfer signed at the
    // answer would have landed in the compared block, even when one read comes from a lagging node.
    let anchor = before.height, anchored = false, after = null;
    for (let i = 0; i < 10 && !after; i++) {
      await d.sleep(3_000);
      let a = null;
      try { a = await d.readAt(o.agent); } catch { continue; }
      if (!anchored) { anchored = true; anchor = Math.max(anchor, a.height); } else if (a.height >= anchor + 10) after = a;
    }
    if (!after || !after.account) return stop('could not read the agent balance after the answer. Check the agent on an explorer.', 'stopped');
    if (after.account.amount !== before.account.amount) {
      return stop(`the agent balance changed from ${near(before.account.amount)} to ${near(after.account.amount)} (the wallet must stay idle during the test). Check the agent on an explorer.`, 'stopped');
    }
    d.log(`Agent at block ${after.height}: ${near(after.account.amount)} (was ${near(before.account.amount)} at block ${before.height}). Nothing moved.`);
    d.log(`PASS: the wallet policy refused a payment to ${o.target}, outside the whitelist, made with the agent's own key.`);
    return 'pass';
  }
  if (r.kind === 'denied') return stop(`OutLayer refused for another reason: ${r.code} "${r.message}". Nothing was sent, but this is not the whitelist refusal.`, 'stopped');
  if (r.kind === 'accepted' || r.kind === 'reverted') {
    const ids = [r.requestId && `request ${r.requestId}`, r.txHash && `tx ${r.txHash}`].filter(Boolean).join(', ') || 'no id returned';
    d.log(`FAIL: OutLayer ${r.kind === 'accepted' ? 'accepted' : 'signed and submitted'} the transfer (${ids}). The policy did not refuse a payment outside the whitelist.`);
    d.log(`If it landed, ${near(AMOUNT)} went to ${o.target}, your own account. Do not run this again. Record the ids.`);
    return 'fail';
  }
  if (r.kind === 'ambiguous') return stop('no clear answer from OutLayer: the transfer may have been sent. Check the agent balance on an explorer before running again.', 'stopped');
  if (r.kind === 'quota') return stop('OutLayer\'s rate limit refused the request. Nothing was sent. Wait (the free tier allows 100 operations a day per wallet) before running again.', 'stopped');
  if (r.kind === 'busy') return stop(`another operation is in flight on this wallet${r.inFlightRequestId ? ` (request ${r.inFlightRequestId})` : ''}. Stop the worker or use another wallet.`, 'stopped');
  return stop(`OutLayer rejected the request (HTTP ${r.http}${r.code ? ` ${r.code}` : ''}). Nothing was sent.`, 'stopped');
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

export const EXIT = { plan: 0, pass: 0, refused: 1, read: 2, stopped: 3, fail: 4 };

/** The command line as { agent, owner, target, live }, or null when it is not valid. */
export function parseArgs(args) {
  const [agent, owner, target, flag] = args;
  if (args.length < 3 || args.length > 4 || !IMPLICIT.test(agent) || !ACCOUNT.test(owner) || !ACCOUNT.test(target) || (flag !== undefined && flag !== '--yes-live')) return null;
  return { agent, owner, target, live: flag === '--yes-live' };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o) {
    console.error('Usage: node scripts\\attack-demo-live.mjs AGENT_ACCOUNT OWNER_ACCOUNT TARGET_ACCOUNT [--yes-live]\n'
      + '  AGENT_ACCOUNT: the 64-character agent wallet on the job page; OWNER_ACCOUNT: your account on its policy;\n'
      + '  TARGET_ACCOUNT: another existing account you own, not on the policy\'s whitelist.');
    process.exit(1);
  }
  const core = file => import(new URL(`../dist/src/core/${file}`, import.meta.url).href);
  const { rpcEnv, rpcLabel, outlayerUrl } = await core('config.js');
  const { accountFromResult, createNearRpc, spendableNear } = await core('near-rpc.js');
  const { createOutLayerClient } = await core('outlayer.js');
  const { SecretString } = await core('secrets.js');
  const endpoints = rpcEnv(), rpc = createNearRpc(endpoints);
  console.log(`RPC: ${rpcLabel(endpoints)}`);
  const base = outlayerUrl(), client = createOutLayerClient(base);
  const outcome = await attack({
    // The account is read at the block id of a fresh finalized block, and the answer must be for that block (audit L-4).
    readAt: async account => {
      const b = await rpc.finalBlock();
      const raw = await rpc.query({ request_type: 'view_account', account_id: account, block_id: b.id });
      if (raw !== null && (raw?.block_hash !== b.id || raw?.block_height !== b.height)) throw new Error('read for another block');
      return { height: b.height, account: raw === null ? null : accountFromResult(raw) };
    },
    spendable: account => spendableNear(account, KEEP),
    askKey: async () => { const key = keyFrom(await askHidden('Paste the management link of this agent (hidden) and press Enter: ')); return key ? new SecretString(key) : null; },
    policy: async secret => {
      try {
        const res = await fetch(new URL('/wallet/v1/policy', base).href, { headers: { authorization: `Bearer ${secret.reveal()}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
        let data = null; try { data = JSON.parse(await res.text()); } catch { data = null; }
        return { http: res.status, data };
      } catch { return { http: 0, data: null }; }
    },
    transfer: (secret, to, amount, idem) => client.transfer(secret, to, amount, idem),
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    now: () => Date.now(),
    log: line => console.log(line),
  }, o);
  process.exitCode = EXIT[outcome];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
