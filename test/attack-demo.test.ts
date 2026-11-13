import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { spendableNear, type AccountView } from '../src/core/near-rpc.js';

type Core = Record<string, unknown>;
interface Offline { loadCore(): Promise<Core>; run(c: Core, log: (line: string) => void): number; }
type Result = { kind: string; code?: string | null; message?: string; requestId?: string | null; txHash?: string | null; http?: number; inFlightRequestId?: string | null;
  status?: string | null; terminal?: boolean; reason?: string; retryAfterSeconds?: number | null };
type Options = { agent: string; owner: string; target: string; live: boolean };
interface Live {
  AMOUNT: bigint; KEEP: bigint; EXIT: Record<string, number>;
  parseArgs(args: string[]): Options | null;
  attack(d: object, o: Options): Promise<string>;
}
const offline = async () => await import(pathToFileURL(resolve('scripts/attack-demo.mjs')).href) as Offline;
const liveMod = async () => await import(pathToFileURL(resolve('scripts/attack-demo-live.mjs')).href) as Live;

async function runWith(patch: Core = {}) {
  const m = await offline(), lines: string[] = [];
  const failed = m.run({ ...await m.loadCore(), ...patch }, line => lines.push(line));
  return { failed, lines };
}

test('offline attack demo: every attack is stopped by the real checks', async () => {
  const { failed, lines } = await runWith();
  assert.equal(failed, 0);
  const results = lines.filter(l => l.startsWith('  RESULT:'));
  assert.equal(results.length, 9);
  assert.equal(results.filter(l => l.startsWith('  RESULT: BLOCKED by ')).length, 7);
  assert.equal(results.filter(l => l.startsWith('  RESULT: DETECTED, NOT PREVENTED')).length, 2);
  assert.ok(results.some(l => l.includes('raises token_outflow')) && results.some(l => l.includes('raises native_outflow')));
  assert.equal(lines.filter(l => l.startsWith('  CHECK:')).length, 2);
  assert.ok(lines.filter(l => l.startsWith('  CHECK:')).every(l => l.endsWith(': OK')));
  assert.ok(lines.some(l => l.startsWith('  CONTROL:') && l.endsWith('is allowed')));
  assert.ok(lines.includes('Summary: 7 attacks, 7 stopped, 2 detected not prevented (tokens, and NEAR through wrapping, with a stolen key).'));
});

test('offline attack demo fails when a check is weakened', async () => {
  const core = await (await offline()).loadCore();
  const accepted = (_input: unknown, _answer: unknown) => ({ left: 1, right: 2, verdict: 'accepted' });
  const openGuard = () => [], closedGuard = () => ['refused'];
  const money = core.MONEY as Record<string, bigint>;
  for (const patch of [{ lpAiRange: accepted }, { recipientProblems: openGuard }, { recipientProblems: closedGuard }, { unexplained: () => ({}) },
    { MONEY: { ...money, nativePerTxCeiling: money.nativePerTxCeiling * 2n } }]) {
    const { failed } = await runWith(patch);
    assert.ok(failed > 0, Object.keys(patch)[0]);
  }
  const real = core.buildRules as (i: unknown) => { addresses: { mode: string; list: string[] } };
  const { failed } = await runWith({ buildRules: (i: unknown) => { const r = real(i); return { ...r, addresses: { ...r.addresses, list: [...r.addresses.list, 'attacker.near'] } }; } });
  assert.ok(failed > 0);
  assert.ok((await runWith({ recipientProblems: openGuard })).lines.some(l => l.includes('NOT STOPPED')));
});

const N = 10n ** 24n, AGENT = 'b'.repeat(64), OWNER = 'owner.near', TARGET = 'other.near', FAKE_KEY = 'wk_fakeKeyForOfflineTests123';
const goodPolicy = { policy: 'stored', frozen: false, controller: `ed25519:${AGENT}`,
  rules: { transaction_types: ['transfer', 'call'], allowed_tokens: ['native', 'nep141:wrap.near'], addresses: { mode: 'whitelist', list: [OWNER, 'wrap.near'] } } };
const whitelistRefusal: Result = { kind: 'denied', code: 'policy_denied', message: `Address '${TARGET}' is not in whitelist` };

function fakes(m: Live, o: { answer?: Result; policy?: { http: number; data: unknown }; key?: string | null; balance?: bigint; drop?: boolean; inflow?: boolean; stuck?: boolean;
  noTarget?: boolean; unreadable?: boolean; unreadableAfter?: boolean; goneAfter?: boolean } = {}) {
  let height = 100, balance = o.balance ?? N / 100n, sent = false;
  const transfers: { key: unknown; to: string; amount: bigint; idem: string }[] = [], lines: string[] = [];
  let asked = 0;
  const d = {
    readAt: async (account: string): Promise<{ height: number; account: AccountView | null }> => {
      if (o.unreadable || (o.unreadableAfter && sent)) throw new Error('unreadable');
      if (!(o.stuck && sent)) height += 3;
      if (account === AGENT && o.goneAfter && sent) return { height, account: null };
      return { height, account: account === TARGET && o.noTarget ? null : { amount: account === AGENT ? balance : N, locked: 0n, storageUsage: 182 } };
    },
    spendable: (a: AccountView | null) => spendableNear(a, m.KEEP),
    askKey: async () => { asked++; return o.key === undefined ? FAKE_KEY : o.key; },
    policy: async () => o.policy ?? { http: 200, data: goodPolicy },
    transfer: async (key: unknown, to: string, amount: bigint, idem: string) => {
      transfers.push({ key, to, amount, idem }); sent = true;
      if (o.drop) balance -= amount;
      if (o.inflow) balance += amount;
      return o.answer ?? whitelistRefusal;
    },
    sleep: async () => {},
    now: () => 1_800_000_000_000,
    log: (line: string) => lines.push(line),
  };
  return { d, transfers, lines, asked: () => asked };
}
async function liveRun(o: Parameters<typeof fakes>[1] = {}, opts: { target?: string; live?: boolean } = {}) {
  const m = await liveMod(), f = fakes(m, o);
  const outcome = await m.attack(f.d, { agent: AGENT, owner: OWNER, target: opts.target ?? TARGET, live: opts.live ?? true });
  assert.ok(f.transfers.length <= 1);
  assert.ok(f.lines.every(l => !l.includes(FAKE_KEY)));
  return { outcome, ...f, m };
}

test('live attack: constants, exit codes and the command line', async () => {
  const m = await liveMod();
  assert.equal(m.AMOUNT, 10n ** 21n);
  assert.equal(m.KEEP, 5n * 10n ** 21n);
  assert.deepEqual(m.EXIT, { plan: 0, pass: 0, refused: 1, read: 2, stopped: 3, fail: 4 });
  assert.deepEqual(m.parseArgs([AGENT, OWNER, TARGET]), { agent: AGENT, owner: OWNER, target: TARGET, live: false });
  assert.deepEqual(m.parseArgs([AGENT, OWNER, TARGET, '--yes-live']), { agent: AGENT, owner: OWNER, target: TARGET, live: true });
  for (const bad of [[], [AGENT, OWNER], ['owner.near', OWNER, TARGET], [AGENT, 'Bad Owner', TARGET], [AGENT, OWNER, 'bad target'], [AGENT, OWNER, TARGET, '--live'],
    [AGENT, OWNER, TARGET, '--yes-live', 'extra']]) assert.equal(m.parseArgs(bad), null, bad.join(' '));
});

test('live attack: a whitelist refusal with an unchanged balance passes, one request to the target', async () => {
  const r = await liveRun();
  assert.equal(r.outcome, 'pass');
  assert.equal(r.transfers.length, 1);
  assert.deepEqual({ to: r.transfers[0].to, amount: r.transfers[0].amount, key: r.transfers[0].key }, { to: TARGET, amount: r.m.AMOUNT, key: FAKE_KEY });
  assert.match(r.transfers[0].idem, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual((await liveRun()).transfers[0].idem, r.transfers[0].idem);
  assert.ok(r.lines.some(l => l.startsWith('OutLayer answered: HTTP 403 policy_denied')));
  assert.ok(r.lines.some(l => l.startsWith('PASS:')));
  // Audit M-4 and re-check N-1: reads advance 3 blocks each; the pre-send read is block 109, the first read after the
  // answer (112) is the anchor, and the compared read is the first at least 10 above it (124).
  assert.ok(r.lines.some(l => l.startsWith('Agent at block 124:')), r.lines.join('\n'));
});

test('live attack: plan only and every refusal before sending send nothing', async () => {
  const plan = await liveRun({}, { live: false });
  assert.equal(plan.outcome, 'plan'); assert.equal(plan.transfers.length, 0); assert.equal(plan.asked(), 0);
  for (const [name, o, opts, outcome] of [
    ['target is owner', {}, { target: OWNER }, 'refused'], ['target is agent', {}, { target: AGENT }, 'refused'], ['no target', { noTarget: true }, {}, 'refused'],
    ['low balance', { balance: N / 1000n }, {}, 'refused'], ['unreadable', { unreadable: true }, {}, 'read'], ['no key', { key: null }, {}, 'refused'],
  ] as const) {
    const r = await liveRun(o, opts);
    assert.equal(r.outcome, outcome, name);
    assert.equal(r.transfers.length, 0);
  }
  const rules = goodPolicy.rules, without = (k: string) => Object.fromEntries(Object.entries(goodPolicy).filter(([key]) => key !== k));
  const policies: [string, unknown][] = [['null', null], ['not stored', { ...goodPolicy, policy: null }], ['other controller', { ...goodPolicy, controller: `ed25519:${'c'.repeat(64)}` }],
    ['no controller', without('controller')], ['frozen', { ...goodPolicy, frozen: true }], ['freeze unknown', without('frozen')], ['no rules', { ...goodPolicy, rules: {} }],
    ['not a whitelist', { ...goodPolicy, rules: { ...rules, addresses: { mode: 'blacklist', list: [OWNER, 'wrap.near'] } } }],
    ['owner not listed', { ...goodPolicy, rules: { ...rules, addresses: { mode: 'whitelist', list: ['wrap.near'] } } }],
    ['target listed', { ...goodPolicy, rules: { ...rules, addresses: { mode: 'whitelist', list: [OWNER, TARGET] } } }],
    ['no transfer type', { ...goodPolicy, rules: { ...rules, transaction_types: ['call'] } }], ['no native token', { ...goodPolicy, rules: { ...rules, allowed_tokens: ['nep141:wrap.near'] } }]];
  for (const [name, data] of policies) {
    const r = await liveRun({ policy: { http: 200, data } });
    assert.equal(r.outcome, 'refused', name); assert.equal(r.transfers.length, 0);
  }
  const http = await liveRun({ policy: { http: 500, data: goodPolicy } });
  assert.equal(http.outcome, 'refused'); assert.equal(http.transfers.length, 0);
});

test('live attack: every other answer stops or fails, never passes', async () => {
  for (const [name, o, outcome] of [
    ['balance dropped', { drop: true }, 'stopped'],
    ['balance rose', { inflow: true }, 'stopped'],
    ['no later block', { stuck: true }, 'stopped'],
    ['unreadable after', { unreadableAfter: true }, 'stopped'],
    ['agent gone after', { goneAfter: true }, 'stopped'],
    ['frozen', { answer: { kind: 'denied', code: 'wallet_frozen', message: 'Wallet is frozen by controller' } }, 'stopped'],
    ['frozen naming the whitelist', { answer: { kind: 'denied', code: 'wallet_frozen', message: `Address '${TARGET}' is not in whitelist` } }, 'stopped'],
    ['cap refusal', { answer: { kind: 'denied', code: 'policy_denied', message: 'Per-transaction limit exceeded for native' } }, 'stopped'],
    ['whitelist without the target', { answer: { kind: 'denied', code: 'policy_denied', message: "Address 'someone.near' is not in whitelist" } }, 'stopped'],
    ['accepted', { answer: { kind: 'accepted', requestId: 'r1', status: 'success', terminal: true, txHash: 'tx1' } }, 'fail'],
    ['reverted', { answer: { kind: 'reverted', requestId: 'r1', txHash: 'tx1', message: 'The on-chain transaction failed.' } }, 'fail'],
    ['ambiguous', { answer: { kind: 'ambiguous', reason: 'network' } }, 'stopped'],
    ['quota', { answer: { kind: 'quota', retryAfterSeconds: null } }, 'stopped'],
    ['busy', { answer: { kind: 'busy', inFlightRequestId: null } }, 'stopped'],
    ['rejected', { answer: { kind: 'rejected', http: 400, code: null, message: 'OutLayer rejected the request.' } }, 'stopped'],
  ] as const) {
    const r = await liveRun(o);
    assert.equal(r.outcome, outcome, name);
    assert.equal(r.transfers.length, 1);
    assert.ok(!r.lines.some(l => l.startsWith('PASS:')), name);
    if (name === 'ambiguous') assert.ok(r.lines.some(l => l.includes('may have been sent')));
  }
});
