// Recovery of NEAR from an agent wallet to its owner, without the worker (runbook "Recovery without the worker",
// docs/runbooks/PHASE-1-HIRE-RUNBOOK.md). One command instead of hand-typed transfers.
//
// Usage, from the repository root after `npm run build`, with the worker stopped:
//   node scripts\recover-near.mjs AGENT_ACCOUNT OWNER_ACCOUNT              plan only: reads the balance, sends nothing
//   node scripts\recover-near.mjs AGENT_ACCOUNT OWNER_ACCOUNT --yes-live   asks for the management link (hidden) and sends
//
// Before sending it requires, from OutLayer with the pasted key: a stored policy (a wallet without one is unrestricted),
// the owner on the policy's address whitelist, the wallet not frozen, and, when OutLayer reports it, the wallet key of
// the agent named on the command line. It refuses while the agent still holds wNEAR or USDC (recover those first with
// the runbook, while the wallet still has gas). It sends native NEAR to the owner in parts of at most 0.249 NEAR (the
// policy caps each native transfer at 0.25 NEAR), keeping storage plus 0.01 NEAR. Protection against paying twice is
// the finalized balance: read before each part, and after each part the script waits until it has dropped by that part.
// It stops at the first answer that is not a clear success and never re-sends on its own. The idempotency key is
// derived from the agent and the balance before the part, so the same balance gives the same key. The key is never
// printed or written anywhere. Value inside DCL is not handled here.
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

export const PART = 249_000_000_000_000_000_000_000n; // 0.249 NEAR
export const GAS_KEEP = 10_000_000_000_000_000_000_000n; // 0.01 NEAR
export const MIN_PART = 2_000_000_000_000_000_000_000n; // 0.002 NEAR: smaller parts cost about their own value in gas
const IMPLICIT = /^[0-9a-f]{64}$/;
const ACCOUNT = /^(?=.{2,64}$)([a-z0-9]+[-_.])*[a-z0-9]+$/;

export const near = raw => { const s = raw.toString().padStart(25, '0'); return `${s.slice(0, -24)}.${s.slice(-24, -18)} NEAR`; };

/** The parts to send for a spendable amount: full 0.249 parts, then the remainder if it is at least MIN_PART. */
export function plan(spendable) {
  const parts = [];
  for (let left = spendable; left >= MIN_PART; left -= left > PART ? PART : left) parts.push(left > PART ? PART : left);
  return parts;
}

/** The wk_ key from a pasted management link or a bare key; null when none is found. */
export function keyFrom(text) {
  const m = /(?:^|key=)(wk_[A-Za-z0-9]+)/.exec(text.trim());
  return m ? m[1] : null;
}

/** The OutLayer policy answer (GET /wallet/v1/policy) checked for this recovery. Returns a stop reason, or null. */
export function policyProblem(http, data, agent, owner) {
  if (http !== 200 || !data || typeof data !== 'object') return 'could not read the wallet policy with this key. Check the link you pasted.';
  if (data.policy !== 'stored') return 'this wallet has no stored policy, so nothing would limit a transfer. Use the runbook by hand.';
  if (typeof data.controller === 'string' && data.controller !== `ed25519:${agent}`) return 'the pasted link belongs to another agent wallet than the one on the command line.';
  const list = data.rules && data.rules.addresses && data.rules.addresses.mode === 'whitelist' ? data.rules.addresses.list : null;
  if (!Array.isArray(list) || !list.includes(owner)) return 'the owner account you typed is not on this wallet\'s policy whitelist. Check the account.';
  if (data.frozen === true) return 'the wallet is frozen. Unfreeze it on the agent page (or with your wallet) first, then run this again.';
  if (data.frozen !== false) return 'could not read the freeze state. Run this again in a minute.';
  return null;
}

/**
 * The recovery loop, with every dependency injected so it can be tested offline.
 * d: { policy(): Promise<{http, data}>, tokens(): Promise<string[] | null> (names of non-zero token balances),
 *      readAccount(): Promise<{amount, locked, storageUsage} | null>, spendable(account): bigint,
 *      transfer(to, amount, idem): Promise<SubmitResult>, request(requestId): Promise<SubmitResult>, sleep(ms), log(line) }
 */
export async function recover(d, o) {
  const stop = (why, code) => (d.log(`STOP: ${why}`), code);
  const p = await d.policy();
  const problem = policyProblem(p.http, p.data, o.agent, o.owner);
  if (problem) return stop(problem, 'policy');
  const tokens = await d.tokens();
  if (tokens === null) return stop('could not read the agent token balances. Nothing was sent. Try again in a minute.', 'read');
  if (tokens.length) return stop(`the agent still holds ${tokens.join(' and ')}. Recover those first with the runbook, while the wallet still has gas for the calls.`, 'tokens');
  for (let index = 1; ; index++) {
    const account = await d.readAccount();
    if (!account) return stop('could not read the agent balance. Nothing more was sent. Try again in a minute.', 'read');
    const spendable = d.spendable(account);
    const part = spendable > PART ? PART : spendable;
    if (part < MIN_PART) return d.log(`Done. The agent keeps ${near(account.amount)} for its storage and gas.`), 'done';
    const idem = `recover:${o.agent.slice(0, 16)}:${account.amount}`;
    d.log(`Part ${index}: sending ${near(part)} to ${o.owner}...`);
    const first = await d.transfer(o.owner, part, idem);
    const submitted = first.kind === 'accepted';
    let result = first;
    for (let polls = 0; result.kind === 'accepted' && !result.txHash && result.requestId && polls < 10; polls++) { await d.sleep(3_000); result = await d.request(result.requestId); }
    const tx = result.txHash ?? first.txHash ?? null, request = first.requestId ?? null;
    if (result.kind !== 'accepted' || !result.txHash || (result.terminal && !['success', 'completed'].includes(result.status ?? ''))) {
      if (submitted || result.kind === 'ambiguous' || result.kind === 'reverted') {
        return stop(`part ${index} may have been sent (${[request && `request ${request}`, tx && `tx ${tx}`].filter(Boolean).join(', ') || 'no id returned'}; last answer: ${result.kind}${result.status ? ' ' + result.status : ''}). Check the agent balance on the agent page or an explorer BEFORE running again.`, 'stopped');
      }
      const why = result.kind === 'denied' ? `${result.code}: OutLayer refused part ${index}. Nothing was sent.`
        : result.kind === 'quota' ? `OutLayer's rate limit refused part ${index}. Nothing was sent. Wait (the free tier allows 100 operations a day per wallet) before running again.`
          : result.kind === 'busy' ? `another operation is in flight on this wallet${result.inFlightRequestId ? ` (request ${result.inFlightRequestId})` : ''}. Wait until it finishes and check the balance before running again.`
            : `OutLayer rejected part ${index}. Nothing was sent.`;
      return stop(why, 'stopped');
    }
    d.log(`  tx ${result.txHash}`);
    let landed = false;
    for (let waits = 0; waits < 40 && !landed; waits++) {
      await d.sleep(3_000);
      const after = await d.readAccount();
      landed = !!after && after.amount <= account.amount - part;
    }
    if (!landed) return stop(`part ${index} has tx ${result.txHash} but the balance has not dropped yet. Check it on an explorer before running again.`, 'unsettled');
  }
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
  const [agent, owner, flag] = process.argv.slice(2);
  if (!agent || !IMPLICIT.test(agent) || !owner || !ACCOUNT.test(owner) || (flag !== undefined && flag !== '--yes-live')) {
    console.error('Usage: node scripts\\recover-near.mjs AGENT_ACCOUNT OWNER_ACCOUNT [--yes-live]\n  AGENT_ACCOUNT: the 64-character agent wallet on the job page; OWNER_ACCOUNT: your account.');
    process.exit(1);
  }
  const core = file => import(new URL(`../dist/src/core/${file}`, import.meta.url).href);
  const { rpcEnv, rpcLabel, outlayerUrl } = await core('config.js');
  const { createNearRpc, spendableNear } = await core('near-rpc.js');
  const { createOutLayerClient } = await core('outlayer.js');
  const { SecretString } = await core('secrets.js');
  const endpoints = rpcEnv(), rpc = createNearRpc(endpoints);
  console.log(`RPC: ${rpcLabel(endpoints)}`);
  if (rpcLabel(endpoints) !== 'QuickNode') { console.error('STOP: expected the QuickNode RPC from .env.local. Run this from the repository root.'); process.exit(1); }
  const readAccount = () => rpc.viewAccount(agent).catch(() => null);
  const spendable = account => spendableNear(account, GAS_KEEP);
  const tokens = async () => {
    try {
      const final = await rpc.finalBlock();
      const out = [];
      for (const [id, name] of [['wrap.near', 'wNEAR'], ['17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', 'USDC']]) {
        const v = (await rpc.view(id, 'ft_balance_of', { account_id: agent }, final.id)).value;
        if (typeof v !== 'string' || !/^\d+$/.test(v)) return null;
        if (BigInt(v) > 0n) out.push(name);
      }
      return out;
    } catch { return null; }
  };
  const account = await readAccount();
  if (!account) { console.error('STOP: could not read the agent balance.'); process.exit(2); }
  const parts = plan(spendable(account));
  console.log(`Agent ${agent}: ${near(account.amount)}. To send to ${owner}: ${parts.length} part(s): ${parts.map(near).join(', ') || 'nothing'}.`);
  if (flag !== '--yes-live') { console.log('Plan only. Stop the worker (Ctrl+C in its window), then run again with --yes-live to send.'); return; }
  if (parts.length === 0) return;
  const key = keyFrom(await askHidden('Paste your management link (hidden) and press Enter: '));
  if (!key) { console.error('STOP: no wk_ key found in what you pasted.'); process.exit(1); }
  const secret = new SecretString(key), base = outlayerUrl(), client = createOutLayerClient(base);
  const outcome = await recover({
    policy: async () => {
      try {
        const res = await fetch(new URL('/wallet/v1/policy', base).href, { headers: { authorization: `Bearer ${secret.reveal()}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
        let data = null; try { data = JSON.parse(await res.text()); } catch { data = null; }
        return { http: res.status, data };
      } catch { return { http: 0, data: null }; }
    },
    tokens, readAccount, spendable,
    transfer: (to, amount, idem) => client.transfer(secret, to, amount, idem),
    request: requestId => client.request(secret, requestId),
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    log: line => console.log(line),
  }, { agent, owner });
  process.exitCode = outcome === 'done' ? 0 : 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
