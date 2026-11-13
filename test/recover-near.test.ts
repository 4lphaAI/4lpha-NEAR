import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { spendableNear } from '../src/core/near-rpc.js';

type Result = { kind: string; txHash?: string | null; requestId?: string | null; status?: string | null; terminal?: boolean; code?: string; inFlightRequestId?: string | null };
type Account = { amount: bigint; locked: bigint; storageUsage: number };
interface Mod {
  PART: bigint; GAS_KEEP: bigint; MIN_PART: bigint;
  plan(spendable: bigint): bigint[];
  keyFrom(text: string): string | null;
  policyProblem(http: number, data: unknown, agent: string, owner: string): string | null;
  recover(d: object, o: { agent: string; owner: string }): Promise<string>;
}
const load = async () => await import(pathToFileURL(resolve('scripts/recover-near.mjs')).href) as Mod;
const N = 10n ** 24n, AGENT = 'b'.repeat(64), OWNER = 'owner.near';
const goodPolicy = { policy: 'stored', frozen: false, controller: `ed25519:${AGENT}`, rules: { addresses: { mode: 'whitelist', list: [OWNER, 'wrap.near'] } } };

function chain(m: Mod, start: bigint, answer: (amount: bigint, idem: string, i: number) => Result,
  o: { land?: boolean; policy?: { http: number; data: unknown }; tokens?: string[] | null; poll?: () => Result } = {}) {
  let balance = start;
  const sent: { to: string; amount: bigint; idem: string }[] = [], logs: string[] = [];
  const d = {
    policy: async () => o.policy ?? { http: 200, data: goodPolicy },
    tokens: async () => o.tokens === undefined ? [] : o.tokens,
    readAccount: async (): Promise<Account> => ({ amount: balance, locked: 0n, storageUsage: 182 }),
    spendable: (a: Account) => spendableNear(a, m.GAS_KEEP),
    transfer: async (to: string, amount: bigint, idem: string) => {
      sent.push({ to, amount, idem });
      const r = answer(amount, idem, sent.length);
      if (r.kind === 'accepted' && (o.land ?? true)) balance -= amount + 10n ** 20n;
      return r;
    },
    request: async () => o.poll ? o.poll() : ({ kind: 'accepted', txHash: 'TXR', status: 'success', terminal: true }),
    sleep: async () => {}, log: (l: string) => { logs.push(l); },
  };
  return { d, sent, logs, balance: () => balance, setBalance: (b: bigint) => { balance = b; } };
}
const ok = (): Result => ({ kind: 'accepted', txHash: 'TX', status: 'success', terminal: true });
const run = (m: Mod, c: ReturnType<typeof chain>) => m.recover(c.d, { agent: AGENT, owner: OWNER });

test('recover-near: plan splits into 0.249 NEAR parts and skips dust; the key comes from a link or a bare key', async () => {
  const m = await load();
  assert.deepEqual(m.plan(988_180_000_000_000_000_000_000n), [m.PART, m.PART, m.PART, 241_180_000_000_000_000_000_000n]);
  assert.deepEqual(m.plan(m.PART + m.MIN_PART - 1n), [m.PART]);
  assert.deepEqual(m.plan(0n), []);
  assert.equal(m.keyFrom('https://app.outlayer.ai/wallet?key=wk_abc123'), 'wk_abc123');
  assert.equal(m.keyFrom('  wk_abc123 '), 'wk_abc123');
  assert.equal(m.keyFrom('https://app.outlayer.ai/wallet'), null);
});

test('recover-near: the policy must be stored, list the owner, match the agent key and not be frozen', async () => {
  const m = await load();
  assert.equal(m.policyProblem(200, goodPolicy, AGENT, OWNER), null);
  assert.equal(m.policyProblem(200, { ...goodPolicy, controller: undefined }, AGENT, OWNER), null, 'controller absent: allowed, the balance-drop check stops a wrong wallet');
  const bad: [number, unknown, RegExp][] = [
    [401, goodPolicy, /could not read/], [200, null, /could not read/], [200, { ...goodPolicy, policy: 'none' }, /no stored policy/],
    [200, { ...goodPolicy, controller: 'ed25519:' + 'c'.repeat(64) }, /another agent wallet/],
    [200, { ...goodPolicy, rules: { addresses: { mode: 'whitelist', list: ['ownr.near'] } } }, /not on this wallet's policy whitelist/],
    [200, { ...goodPolicy, rules: {} }, /whitelist/], [200, { ...goodPolicy, frozen: true }, /frozen/], [200, { ...goodPolicy, frozen: undefined }, /freeze state/],
  ];
  for (const [http, data, want] of bad) assert.match(m.policyProblem(http, data, AGENT, OWNER) ?? '', want);
  for (const policy of [{ http: 200, data: { ...goodPolicy, policy: 'none' } }, { http: 200, data: { ...goodPolicy, frozen: true } }]) {
    const c = chain(m, N, ok, { policy });
    assert.equal(await run(m, c), 'policy'); assert.equal(c.sent.length, 0);
  }
});

test('recover-near: tokens still in the wallet or an unreadable token balance send nothing', async () => {
  const m = await load();
  const held = chain(m, N, ok, { tokens: ['wNEAR'] });
  assert.equal(await run(m, held), 'tokens'); assert.equal(held.sent.length, 0);
  const unknown = chain(m, N, ok, { tokens: null });
  assert.equal(await run(m, unknown), 'read'); assert.equal(unknown.sent.length, 0);
});

test('recover-near: every part goes to the owner after a fresh read, until only storage and gas remain', async () => {
  const m = await load();
  const c = chain(m, N, ok);
  assert.equal(await run(m, c), 'done');
  assert.equal(c.sent.length, 4);
  assert.ok(c.sent.every(s => s.to === OWNER && s.amount <= m.PART));
  assert.equal(new Set(c.sent.map(s => s.idem)).size, 4, 'each balance gives its own key');
  assert.ok(c.balance() > 0n && c.balance() < 13n * 10n ** 21n, 'about 0.012 NEAR stays');
});

test('recover-near: a rerun after a lost answer on a later part reuses that part\'s key (same balance, same key)', async () => {
  const m = await load();
  const a = chain(m, N, (_amount, _idem, i) => i === 2 ? { kind: 'ambiguous' } : ok());
  assert.equal(await run(m, a), 'stopped');
  const b = chain(m, a.balance(), () => ({ kind: 'ambiguous' }), { land: false });
  await run(m, b);
  assert.equal(a.sent[1]!.idem, b.sent[0]!.idem);
  assert.match(a.logs.join('\n'), /may have been sent.*BEFORE running again/);
});

test('recover-near: stops at the first unclear answer, never re-sends, and says when a part may have been sent', async () => {
  const m = await load();
  const cases: [Result, RegExp][] = [
    [{ kind: 'denied', code: 'policy_denied' }, /policy_denied.*Nothing was sent/], [{ kind: 'quota' }, /rate limit.*Nothing was sent. Wait/],
    [{ kind: 'rejected' }, /rejected part 1. Nothing was sent/], [{ kind: 'busy', inFlightRequestId: 'R9' }, /in flight.*R9/],
    [{ kind: 'reverted', txHash: 'TV' }, /may have been sent.*tx TV/], [{ kind: 'ambiguous' }, /may have been sent/],
    [{ kind: 'accepted', txHash: null, requestId: null }, /may have been sent/], [{ kind: 'accepted', txHash: 'T', status: 'failed', terminal: true }, /may have been sent.*tx T.*failed/],
  ];
  for (const [answer, want] of cases) {
    const c = chain(m, N, () => answer, { land: false });
    assert.equal(await run(m, c), 'stopped', answer.kind);
    assert.equal(c.sent.length, 1);
    assert.match(c.logs.join('\n'), want);
  }
  // An accepted submit whose status poll hits a limit or a rejection still warns that the part may have been sent.
  for (const poll of [() => ({ kind: 'quota' }), () => ({ kind: 'rejected' }), () => ({ kind: 'accepted', txHash: null, requestId: 'R1' })]) {
    const c = chain(m, N, () => ({ kind: 'accepted', txHash: null, requestId: 'R1', status: 'pending', terminal: false }), { land: false, poll });
    assert.equal(await run(m, c), 'stopped');
    assert.match(c.logs.join('\n'), /may have been sent \(request R1/);
    assert.doesNotMatch(c.logs.join('\n'), /Nothing was sent/);
  }
  const stuck = chain(m, N, ok, { land: false });
  assert.equal(await run(m, stuck), 'unsettled'); assert.equal(stuck.sent.length, 1);
  const polled = chain(m, N, () => ({ kind: 'accepted', txHash: null, requestId: 'R1', status: 'pending', terminal: false }));
  assert.equal(await run(m, polled), 'done');
});

// Phase 1 fix 4: the zero-spend same-key re-send check.
test('probe-same-key-resend: only the duplicate answer naming the journaled request passes', async () => {
  const { judge } = await import(pathToFileURL(resolve('scripts/probe-same-key-resend.mjs')).href) as { judge(http: number, data: unknown, journaled: string): { pass: boolean; line: string } };
  assert.equal(judge(200, { error: 'duplicate_idempotency_key', request_id: 'R1', status: 'success' }, 'R1').pass, true);
  for (const [http, data] of [[200, { error: 'duplicate_idempotency_key', request_id: 'R2' }], [200, { already_registered: true, tx_hash: null }],
    [200, { request_id: 'R1', status: 'success', tx_hash: 'T' }], [409, { error: 'wallet_busy' }], [403, { error: 'wallet_frozen' }], [0, null], [502, null]] as const) {
    const v = judge(http, data, 'R1');
    assert.equal(v.pass, false, JSON.stringify(data));
    assert.ok(!v.line.includes('wk_'));
  }
  assert.match(judge(200, { error: 'duplicate_idempotency_key', request_id: 'wk_secret' }, 'R1').line, /\(-\)/, 'a key-like id is never echoed');
});
