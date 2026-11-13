import test from 'node:test';
import assert from 'node:assert/strict';
import { YOCTO_PER_NEAR as N } from '../src/core/amounts.js';
import { provenEffects } from '../src/core/evidence.js';
import { readHoldings } from '../src/core/holdings.js';
import { RpcUnavailable } from '../src/core/near-rpc.js';
import { AMBIGUOUS_SLOW_AFTER_MS, AMBIGUOUS_SLOW_MS, createLiveOps, exitToOwner, reconcileEvery, reconcileWallet, REGISTRATION_RELEASED, RESEND_EVERY_MS, RESEND_MAX_AGE_MS, RESEND_MAX_EVERY_MS, resendEvery, resendOf, WalletLanes, type GuardedOps, type OpKind, type OpResult } from '../src/core/ops.js';
import { canTransition, setJob } from '../src/core/hire.js';
import { CLASSIC_POOLS, MONEY, USDC, WNEAR } from '../src/core/pins.js';
import { gasAccounting, parseTxStatus } from '../src/core/receipts.js';
import { json, openStore, RECONCILED_PAUSE } from '../src/core/store.js';
import { watchOnce } from '../src/core/watchdog.js';
import { createOutLayerClient, type OutLayerClient, type SubmitResult } from '../src/core/outlayer.js';
import { SecretString } from '../src/core/secrets.js';
import { ftTransferCall, swapCall, unwrapCall, wrapCall } from '../src/core/rhea-classic.js';
import { DatabaseSync } from 'node:sqlite';
import { accepted, agent, dummyOutLayer, fixture, owner, stores, testNow } from './helpers.js';
import { armedJob, chain, opRow } from './chain.js';

const wrap = 45n * N / 1000n;
const swapInput = 15n * N / 1000n;
const swap = { pin: CLASSIC_POOLS[0], tokenIn: WNEAR, tokenOut: USDC, amountIn: swapInput, slippageBps: 100, unwrapNear: false };
const wrapFixture = () => fixture('tx-1.27-wrap');
const fee = (raw: unknown) => gasAccounting(parseTxStatus(raw), agent).burnt;
const unwrapAmount = 5000000000000000000000n;
const unwrapIntent = { receiver: WNEAR, method: 'near_withdraw', args: { amount: unwrapAmount.toString() }, deposit: '1' };
const unwrapAllowed = { agent, owner, tokens: [USDC], dclKinds: [] };
/** The captured transaction with the payout rebuilt. */
function unwrapTx(paid = unwrapAmount + 1n) {
  const raw = fixture('tx-1.21-unwrap-full') as { receipts: { predecessor_id: string; receipt: { Action: { actions: { Transfer: { deposit: string } }[] } } }[] };
  raw.receipts.find(r => r.predecessor_id === WNEAR)!.receipt.Action.actions[0].Transfer.deposit = paid.toString();
  return raw;
}

function setup(t: Parameters<typeof stores>[0], state: 'running' | 'stopping' | 'funded' = 'running') {
  const { web, worker, watch, path } = stores(t), { job, kek } = armedJob(web, worker, state), c = chain();
  let now = testNow;
  watch.heartbeat('watchdog', now);
  const waits: number[] = [];
  const ops = (outlayer: OutLayerClient, wait = async (ms: number) => { waits.push(ms); }) => createLiveOps({ store: worker, rpc: c.rpc, outlayer, kek, jobId: job.id, now: () => now, wait });
  return { web, worker, watch, path, job, kek, c, ops, waits, setNow: (t: number) => { now = t; } };
}
/** Fails txStatus for the first `failures` calls, running `during` inside each read. */
function failTxStatus(c: ReturnType<typeof chain>, failures = Infinity, during = () => {}) {
  const real = c.rpc.txStatus, seen = { calls: 0 };
  c.rpc.txStatus = async (h, s) => { seen.calls++; during(); if (seen.calls <= failures) throw new RpcUnavailable(); return real(h, s); };
  return seen;
}
function landWrap(c: ReturnType<typeof chain>) {
  const raw = wrapFixture();
  c.setHoldings({ native: c.native - wrap - fee(raw), wnear: c.wnear + wrap, height: 30 });
  return accepted(c.addTx(raw));
}
const limited = (body: object, retryAfter?: string) => createOutLayerClient('https://outlayer.test', async () => ({ status: 429, text: async () => JSON.stringify(body),
  headers: new Headers(retryAfter === undefined ? {} : { 'retry-after': retryAfter }) }));
/** A 200 with no transaction through the real adapter. `effect` runs on the chain as the reply is made. */
const noTxReply = (effect = () => {}, body: object = {}) => createOutLayerClient('https://outlayer.test', async () => {
  effect();
  return { status: 200, text: async () => JSON.stringify({ request_id: 'request-test', status: 'success', token: USDC, account_id: owner, already_registered: true, tx_hash: null, ...body }) };
});

test('I-8 a committed reservation and idempotency key precede submission; finalized wrap proves its effects', async t => {
  const { job, worker, c, ops } = setup(t);
  const raw = wrapFixture();
  let calls = 0;
  const result = await ops(dummyOutLayer({ call: async (_key, req, idem) => {
    calls++;
    const row = worker.inFlightOp(job.walletId!);
    assert.equal(row?.state, 'submitted'); assert.equal(row?.idemKey, idem); assert.equal(req.deposit, wrap);
    const h = c.addTx(raw);
    c.setHoldings({ native: c.native - wrap - fee(raw), wnear: c.wnear + wrap, height: 30 });
    return accepted(h);
  } })).wrap(wrap);
  assert.equal(result.verdict, 'success');
  assert.equal(calls, 1);
  assert.equal(worker.inFlightOp(job.walletId!), null);
  assert.equal(worker.jobOps(job.id)[0].nativeSpend, wrap + fee(raw));
});

test('I-10 ambiguous balances are not proof and block retries, later strategy and withdrawals', async t => {
  const { job, worker, c, ops } = setup(t);
  let calls = 0;
  const api = dummyOutLayer({ call: async () => { calls++; throw new Error('Simulated lost response'); }, transfer: async () => { calls++; return accepted('wrong'); } });
  const o = ops(api);
  assert.equal((await o.wrap(wrap)).verdict, 'unknown');
  assert.equal(worker.inFlightOp(job.walletId!)?.state, 'ambiguous');
  assert.equal(worker.getJob(job.id)?.state, 'halted');
  c.setHoldings({ native: c.native - wrap - fee(wrapFixture()), wnear: c.wnear + wrap, height: 30 });
  await assert.rejects(o.wrap(wrap));
  await assert.rejects(o.transferNearToOwner(1n));
  assert.equal(calls, 4, 'fix 4: the original and three same-key re-sends, then nothing');
});

test('I-8 persisted submission survives worker restart and requires matching finalized chain evidence', async t => {
  const { job, worker, path, kek, c } = setup(t);
  const before = await readHoldings(c.rpc, agent, [WNEAR, USDC]);
  const raw = wrapFixture();
  const hash = c.addTx(raw);
  const row = opRow(job, { txHash: hash, nativeSpend: wrap, before: json(before), request: json({ receiver: WNEAR, method: 'near_deposit', args: {}, deposit: wrap.toString() }) });
  assert.ok(worker.insertOp(row));
  worker.releaseWorkerLock();
  const next = openStore(path, 'worker');
  try {
    assert.ok(next.acquireWorkerLock(process.pid, testNow));
    assert.equal(next.insertOp(opRow(job)), false);
    assert.equal(await reconcileWallet({ store: next, rpc: c.rpc, outlayer: dummyOutLayer(), kek, now: () => testNow, wait: async () => {} }, job.walletId!), 'halted');
    assert.equal(next.inFlightOp(job.walletId!)?.state, 'ambiguous');
    assert.equal(next.insertOp(opRow(job)), false);
    c.setHoldings({ native: c.native - wrap - fee(raw), wnear: c.wnear + wrap, height: 30 });
    assert.equal(await reconcileWallet({ store: next, rpc: c.rpc, outlayer: dummyOutLayer(), kek, now: () => testNow }, job.walletId!), 'clean');
    assert.equal(next.inFlightOp(job.walletId!), null);
    // Fix 4 F4-5: the proven lost reply was the only blocking alert, so the job waits for the owner's Resume.
    assert.equal(next.getJob(job.id)?.state, 'paused');
    assert.equal(next.getJob(job.id)?.reason, RECONCILED_PAUSE);
  } finally { next.releaseWorkerLock(); next.close(); }
});

test('1.27 422 E68 proves the finalized refund and is never resent', async t => {
  const { c, ops } = setup(t);
  const raw = fixture('tx-1.27-swap-refund-e68');
  c.setQuote('114097');
  let calls = 0;
  const res = await ops(dummyOutLayer({ call: async () => {
    calls++; c.setHoldings({ native: c.native - 1n - fee(raw), height: 30 });
    return { kind: 'reverted', requestId: 'request', txHash: c.addTx(raw), message: 'E68' };
  } })).swap(swap);
  assert.equal(calls, 1);
  assert.equal(res.verdict, 'refunded');
  assert.equal(res.used, 0n);
});

test('I-9 successful archived swaps prove the pinned token and native output', async t => {
  const { c, ops } = setup(t);
  const rawIn = fixture('tx-1.27-swap-in'), rawOut = fixture('tx-1.27-swap-out-native');
  const nativeIn = 14894302024651019464265n;
  const o = ops(dummyOutLayer({ call: async (_key, req) => {
    if (req.receiverId === WNEAR) {
      c.setHoldings({ native: c.native - 1n - fee(rawIn), wnear: c.wnear - swapInput, usdc: c.usdc + 56478n, height: 30 });
      return accepted(c.addTx(rawIn, 11, 'swap-in-test'));
    }
    c.setHoldings({ native: c.native - 1n - fee(rawOut) + nativeIn, usdc: c.usdc - 56478n, height: 60 });
    return accepted(c.addTx(rawOut, 31, 'swap-out-test'));
  } }));
  assert.equal((await o.swap(swap)).verdict, 'swapped');
  c.setQuote(nativeIn.toString());
  const out = await o.swap({ ...swap, tokenIn: USDC, tokenOut: WNEAR, amountIn: 56478n, unwrapNear: true });
  assert.equal(out.verdict, 'swapped');
  assert.equal(out.nativeIn, nativeIn);
});

test('I-17 a projected wNEAR or native output can refuse submission while the current reserve alone would pass', async t => {
  const { c, job, worker, ops } = setup(t);
  c.setHoldings({ native: N * 3n / 10n + 182n * MONEY.storageYoctoPerByte, wnear: 6n * N / 100n });
  c.setQuote((55n * N / 100n).toString());
  assert.ok(worker.insertOp(opRow(job, { state: 'finished', kind: 'wrap', nativeSpend: 26n * N / 10n })));
  let calls = 0;
  const o = ops(dummyOutLayer({ call: async () => { calls++; return accepted('wrong'); } }));
  for (const unwrapNear of [true, false]) {
    await assert.rejects(o.swap({ ...swap, tokenIn: USDC, tokenOut: WNEAR, amountIn: 56478n, unwrapNear }), /native spend/);
  }
  assert.equal(calls, 0);
});

test('403 is terminal, a second denial halts, and a frozen answer moves the job', async t => {
  const one = setup(t);
  let calls = 0;
  const out = dummyOutLayer({ call: async () => { calls++; return { kind: 'denied', code: 'policy_denied', message: 'Denied' }; } });
  assert.equal((await one.ops(out).wrap(wrap)).verdict, 'denied');
  assert.equal(one.worker.inFlightOp(one.job.walletId!), null);
  assert.equal((await one.ops(out).wrap(wrap)).verdict, 'denied');
  assert.equal(one.worker.getJob(one.job.id)?.state, 'halted');
  assert.equal(calls, 2);
  const two = setup(t);
  assert.equal((await two.ops(dummyOutLayer({ call: async () => ({ kind: 'denied', code: 'wallet_frozen', message: 'Frozen' }) })).wrap(wrap)).verdict, 'frozen');
  assert.equal(two.worker.getJob(two.job.id)?.state, 'frozen');
});

test('429 blocks another request until the reported retry time', async t => {
  const { c, worker, job, ops } = setup(t);
  let calls = 0;
  const o = ops(dummyOutLayer({ call: async () => { calls++; return { kind: 'quota', retryAfterSeconds: 42 }; } }));
  assert.equal((await o.wrap(wrap)).verdict, 'quota');
  assert.equal(worker.budgetView(job.walletId!, testNow).blockedUntil, testNow + 42_000);
  await assert.rejects(o.wrap(wrap));
  assert.equal(calls, 1); assert.ok(c.native > 0n);
});

test('I-8 wallet lanes serialize without blocking an unrelated wallet', async () => {
  const lanes = new WalletLanes(), order: string[] = [];
  let release!: () => void;
  const a = lanes.run('w', async () => { order.push('one'); await new Promise<void>(r => { release = r; }); });
  const b = lanes.run('w', async () => { order.push('two'); });
  await lanes.run('other', async () => { order.push('other'); });
  assert.deepEqual(order, ['one', 'other']);
  release(); await Promise.all([a, b]);
  assert.deepEqual(order, ['one', 'other', 'two']);
});

test('I-12, I-13, I-14 and F-5 to F-8 gate refusals send zero requests', async t => {
  const { job, worker, watch, c, ops } = setup(t);
  let calls = 0;
  const o = ops(dummyOutLayer({ call: async () => { calls++; return accepted('wrong'); }, storageDeposit: async () => { calls++; return accepted('wrong'); } }));
  await assert.rejects(o.wrap(job.caps!.nativePerTx));
  c.setReadable(false); await assert.rejects(o.wrap(wrap)); c.setReadable(true);
  c.setVenue('1.9.22'); await assert.rejects(o.swap(swap)); c.setVenue('1.9.21');
  c.setHoldings({ native: MONEY.readyFloor }); await assert.rejects(o.swap(swap));
  c.setHoldings({ native: N });
  watch.heartbeat('watchdog', testNow - 60_001); await assert.rejects(o.wrap(wrap));
  watch.heartbeat('watchdog', testNow);
  watch.insertAlert({ jobId: job.id, kind: 'test', severity: 'halt', detail: {}, createdAt: testNow });
  await assert.rejects(o.wrap(wrap));
  assert.equal(calls, 0); assert.equal(worker.inFlightOp(job.walletId!), null);
});

test('exit transfers amount plus 0.01 free even with an alert, stale watchdog and wrong venue', async t => {
  const { job, watch, c, ops } = setup(t, 'stopping');
  const raw = fixture('tx-1.18-native-transfer'), amount = N / 100n;
  c.setVenue('wrong'); c.setHoldings({ native: amount + MONEY.sweepReserve + 182n * MONEY.storageYoctoPerByte });
  watch.heartbeat('watchdog', testNow - 60_001);
  watch.insertAlert({ jobId: job.id, kind: 'policy_changed', severity: 'halt', detail: {}, createdAt: testNow });
  let calls = 0;
  const o = ops(dummyOutLayer({ transfer: async (_key, to, a) => {
    calls++; assert.equal(to, job.owner); assert.equal(a, amount);
    c.setHoldings({ native: c.native - a - fee(raw), height: 30 });
    return accepted(c.addTx(raw));
  } }));
  await assert.rejects(o.transferTokenToOwner('wrong.near', 1n));
  assert.equal((await o.transferNearToOwner(amount)).verdict, 'success');
  assert.equal(calls, 1);
});

test('F-10 legitimate wrap does not explain a simultaneous unrelated token withdrawal', async t => {
  const { job, worker, c, ops } = setup(t);
  const raw = wrapFixture();
  const o = ops(dummyOutLayer({ call: async () => {
    c.setHoldings({ native: c.native - wrap - fee(raw), wnear: c.wnear + wrap, usdc: c.usdc - 1n, height: 30 });
    return accepted(c.addTx(raw));
  } }));
  assert.equal((await o.wrap(wrap)).verdict, 'unclear');
  assert.equal(worker.inFlightOp(job.walletId!), null);
  assert.equal(worker.getJob(job.id)?.state, 'halted');
});

test('10.5 exit order and per-token chunks return only tracked balances and leave the measured residue', async t => {
  const { job } = setup(t, 'stopping');
  const initial = 395587n * N / 1000000n, locked = 182n * MONEY.storageYoctoPerByte;
  let native = initial - 12n, wnear = 12n, usdc = 25n;
  const order: string[] = [];
  const ok = (kind: OpKind): OpResult => ({ opId: '', kind, verdict: 'success', txHash: null, used: null, nativeIn: null, burnt: null, message: null });
  const fake: GuardedOps = {
    holdings: async () => ({ block: 1, native, spendable: native - locked, tokens: { [WNEAR]: wnear, [USDC]: usdc } }),
    quote: async () => 1n, wrap: async () => { throw new Error(); }, swap: async () => { throw new Error(); },
    registerStorage: async (_token, who) => { order.push(`registration:${who}`); return ok('storage_owner'); },
    unwrap: async amount => { order.push(`unwrap:${amount}`); native += amount; wnear -= amount; return ok('unwrap'); },
    transferTokenToOwner: async (_token, amount) => { order.push(`token:${amount}`); usdc -= amount; return ok('transfer_token_owner'); },
    transferNearToOwner: async amount => { order.push('native'); native -= amount + 835n * N / 1000000n; return ok('transfer_near_owner'); },
  };
  assert.equal(await exitToOwner(fake, { tokens: [USDC], caps: { ...job.caps!, tokenPerTx: { [WNEAR]: 10n, [USDC]: 10n } } }), 'done');
  assert.deepEqual(order, ['unwrap:9', 'unwrap:3', 'registration:owner', 'token:9', 'token:9', 'token:7', 'native', 'native']);
  assert.equal(native, 10985n * N / 1000000n);
});

test('H-1 a real near_withdraw fixture proves success', () => {
  const raw = fixture('tx-1.21-unwrap-full');
  const proof = provenEffects(parseTxStatus(raw), 'unwrap', unwrapIntent, unwrapAllowed);
  assert.equal(proof?.verdict, 'success');
  assert.equal(proof?.effects[WNEAR], -5000000000000000000000n);
  assert.equal(proof?.effects.native, unwrapAmount - fee(raw));
});

test('H-1 a payout other than amount plus the deposit proves nothing', () => {
  assert.notEqual(provenEffects(parseTxStatus(unwrapTx()), 'unwrap', unwrapIntent, unwrapAllowed), null);
  for (const paid of [unwrapAmount, unwrapAmount + 2n]) assert.equal(provenEffects(parseTxStatus(unwrapTx(paid)), 'unwrap', unwrapIntent, unwrapAllowed), null);
});

test('H-1 Stop and withdraw with wNEAR does not halt on a successful unwrap', async t => {
  const { job, worker, watch, c, ops } = setup(t, 'stopping');
  const dog = () => watchOnce({ store: watch, rpc: c.rpc, now: () => testNow });
  const raw = unwrapTx();
  await dog();
  const res = await ops(dummyOutLayer({ call: async (_key, req) => {
    assert.equal(req.methodName, 'near_withdraw');
    c.setHoldings({ native: c.native + unwrapAmount - fee(raw), wnear: c.wnear - unwrapAmount, height: 30 });
    return accepted(c.addTx(raw));
  } })).unwrap(unwrapAmount, 'exit');
  assert.equal(res.verdict, 'success');
  const row = worker.jobOps(job.id)[0];
  assert.equal(row.state, 'finished'); assert.equal(row.verdict, 'success');
  assert.equal(worker.getJob(job.id)?.state, 'stopping');
  assert.equal(worker.inFlightOp(job.walletId!), null);
  await dog();
  assert.deepEqual(worker.openAlerts(job.id).filter(a => a.severity !== 'info').map(a => a.kind), []);
});

test('10.3 a settlement read that fails once still finishes the operation', async t => {
  const { job, worker, c, ops, waits } = setup(t);
  failTxStatus(c, 1);
  let calls = 0;
  assert.equal((await ops(dummyOutLayer({ call: async () => { calls++; return landWrap(c); } })).wrap(wrap)).verdict, 'success');
  assert.equal(worker.jobOps(job.id)[0].verdict, 'success');
  assert.equal(worker.getJob(job.id)?.state, 'running');
  assert.deepEqual(waits, [5000]);
  assert.equal(calls, 1);
});

test('10.3 a head behind the receipts is retried', async t => {
  const { job, worker, c, ops } = setup(t);
  const raw = wrapFixture();
  let waited = 0;
  const o = ops(dummyOutLayer({ call: async () => {
    c.setHoldings({ native: c.native - wrap - fee(raw), wnear: c.wnear + wrap, height: 11 });
    return accepted(c.addTx(raw));
  } }), async () => { waited++; c.setHoldings({ height: 30 }); });
  assert.equal((await o.wrap(wrap)).verdict, 'success');
  assert.equal(waited, 1);
  assert.equal(worker.jobOps(job.id)[0].verdict, 'success');
});

test('10.3 a persistent read failure quarantines after six tries with no resend', async t => {
  const { job, worker, c, ops, waits } = setup(t);
  const seen = failTxStatus(c);
  let calls = 0;
  assert.equal((await ops(dummyOutLayer({ call: async () => { calls++; return landWrap(c); } })).wrap(wrap)).verdict, 'unknown');
  assert.equal(seen.calls, 6);
  assert.deepEqual(waits, [5000, 5000, 5000, 5000, 5000]);
  assert.equal(worker.inFlightOp(job.walletId!)?.state, 'ambiguous');
  assert.equal(worker.getJob(job.id)?.state, 'halted');
  assert.equal(calls, 1);
});

test('10.3 retries stop once 40 s have passed', async t => {
  const one = setup(t);
  const seen = failTxStatus(one.c, Infinity, () => one.setNow(testNow + 40_000));
  assert.equal((await one.ops(dummyOutLayer({ call: async () => landWrap(one.c) })).wrap(wrap)).verdict, 'unknown');
  assert.equal(seen.calls, 1);
  assert.deepEqual(one.waits, []);
  assert.equal(one.worker.inFlightOp(one.job.walletId!)?.state, 'ambiguous');
  // A wait that crosses the limit starts no further try either.
  const two = setup(t);
  const after = failTxStatus(two.c);
  let waited = 0;
  const o = two.ops(dummyOutLayer({ call: async () => landWrap(two.c) }), async () => { waited++; two.setNow(testNow + 40_000); });
  assert.equal((await o.wrap(wrap)).verdict, 'unknown');
  assert.equal(after.calls, 1);
  assert.equal(waited, 1);
});

test('10.3 a row with no hash is quarantined after the same-key re-sends, with no chain read', async t => {
  const { job, worker, c, ops, waits } = setup(t);
  const seen = failTxStatus(c);
  let calls = 0;
  assert.equal((await ops(dummyOutLayer({ call: async () => { calls++; return { kind: 'ambiguous', reason: 'server' }; } })).wrap(wrap)).verdict, 'unknown');
  assert.deepEqual(waits, [5000, 15000, 30000]);
  assert.equal(calls, 4);
  assert.equal(seen.calls, 0);
  assert.equal(worker.inFlightOp(job.walletId!)?.state, 'ambiguous');
});

test('10.3 reconcile retries a submitted row and tries an ambiguous row once', async t => {
  const { job, worker, kek, c } = setup(t);
  const before = await readHoldings(c.rpc, agent, [WNEAR, USDC]);
  assert.ok(worker.insertOp(opRow(job, { txHash: c.addTx(wrapFixture()), nativeSpend: wrap, before: json(before), request: json({ receiver: WNEAR, method: 'near_deposit', args: {}, deposit: wrap.toString() }) })));
  const seen = failTxStatus(c), d = { store: worker, rpc: c.rpc, outlayer: dummyOutLayer(), kek, now: () => testNow, wait: async () => {} };
  assert.equal(await reconcileWallet(d, job.walletId!), 'halted');
  assert.equal(seen.calls, 6);
  assert.equal(worker.inFlightOp(job.walletId!)?.state, 'ambiguous');
  assert.equal(await reconcileWallet(d, job.walletId!), 'halted');
  assert.equal(seen.calls, 7);
});

test('10.1 rate_limited with no time blocks for 60 s', async t => {
  const { job, worker, ops } = setup(t);
  assert.equal((await ops(limited({ error: 'rate_limited' })).wrap(wrap)).verdict, 'quota');
  assert.equal(worker.budgetView(job.walletId!, testNow).blockedUntil, testNow + 60_000);
});

test('10.1 operation_limit_reached with no time asks again after an hour', async t => {
  const { job, worker, ops } = setup(t);
  assert.equal((await ops(limited({ error: 'operation_limit_reached', retry_after_seconds: null })).wrap(wrap)).verdict, 'quota');
  assert.equal(worker.budgetView(job.walletId!, testNow).blockedUntil, testNow + 3_600_000);
});

test('10.1 a reported wait is clamped to 24 hours', async t => {
  const { job, worker, c, ops, setNow } = setup(t, 'stopping');
  const raw = fixture('tx-1.18-native-transfer'), amount = N / 100n;
  let calls = 0;
  const o = ops(createOutLayerClient('https://outlayer.test', async () => {
    if (++calls === 1) return { status: 429, text: async () => '{"error":"rate_limited"}', headers: new Headers({ 'Retry-After': '2000000000' }) };
    c.setHoldings({ native: c.native - amount - fee(raw), height: 30 });
    return { status: 200, text: async () => JSON.stringify({ request_id: 'request-test', status: 'success', tx_hash: c.addTx(raw) }) };
  }));
  assert.equal((await o.transferNearToOwner(amount)).verdict, 'quota');
  assert.equal(worker.budgetView(job.walletId!, testNow).blockedUntil, testNow + 86_400_000);
  setNow(testNow + 86_399_999);
  await assert.rejects(o.transferNearToOwner(amount));
  assert.equal(calls, 1);
  setNow(testNow + 86_400_000);
  assert.equal((await o.transferNearToOwner(amount)).verdict, 'success');
  assert.equal(calls, 2);
});

test('10.1 already_registered finishes as success after a finalized read', async t => {
  const { job, worker, c, ops, waits } = setup(t, 'funded');
  c.registration.delete(`${USDC}:${owner}`);
  assert.equal((await ops(noTxReply(() => c.registration.add(`${USDC}:${owner}`))).registerStorage(USDC, 'owner', 'setup')).verdict, 'success');
  const row = worker.jobOps(job.id)[0];
  assert.equal(row.state, 'finished'); assert.equal(row.verdict, 'success'); assert.equal(row.nativeSpend, 0n);
  assert.equal(row.code, 'already_registered'); assert.equal(row.finishedBlock, null); assert.equal(row.finishedAt, testNow);
  assert.equal(worker.getJob(job.id)?.state, 'funded');
  assert.equal(worker.inFlightOp(job.walletId!), null);
  assert.deepEqual(waits, []);
});

test('10.1 already_registered that the chain denies is quarantined after the tries', async t => {
  const { job, worker, kek, c, ops, waits } = setup(t, 'funded');
  c.registration.delete(`${USDC}:${owner}`);
  assert.equal((await ops(noTxReply()).registerStorage(USDC, 'owner', 'setup')).verdict, 'unknown');
  assert.deepEqual(waits, [5000, 5000, 5000, 5000, 5000]);
  assert.equal(worker.inFlightOp(job.walletId!)?.state, 'ambiguous');
  assert.equal(worker.getJob(job.id)?.state, 'halted');
  c.registration.add(`${USDC}:${owner}`);
  assert.equal(await reconcileWallet({ store: worker, rpc: c.rpc, outlayer: dummyOutLayer(), kek, now: () => testNow, wait: async () => {} }, job.walletId!), 'clean');
  assert.equal(worker.inFlightOp(job.walletId!), null);
  assert.equal(worker.jobOps(job.id)[0].verdict, 'success');
  assert.equal(worker.jobOps(job.id)[0].message, null);
  // Fix 4 F4-5: a proven setup registration releases the halt to the owner's Resume.
  assert.equal(worker.getJob(job.id)?.state, 'paused');
});

test('10.1 already_registered does not finish over a fallen balance', async t => {
  const { job, worker, c, ops } = setup(t, 'funded');
  c.registration.delete(`${USDC}:${owner}`);
  const o = ops(noTxReply(() => { c.registration.add(`${USDC}:${owner}`); c.setHoldings({ native: c.native - 1n }); }));
  assert.equal((await o.registerStorage(USDC, 'owner', 'setup')).verdict, 'unknown');
  assert.equal(worker.inFlightOp(job.walletId!)?.state, 'ambiguous');
  assert.equal(worker.jobOps(job.id)[0].finishedAt, null);
});

test('10.1 already_registered checks the journaled pair, not the reply', async t => {
  // The reply names a pair the chain does show as registered, so only the journaled one can decide.
  const others = { token: WNEAR, account_id: agent };
  const one = setup(t, 'funded');
  one.c.registration.delete(`${USDC}:${owner}`);
  assert.equal((await one.ops(noTxReply(undefined, others)).registerStorage(USDC, 'owner', 'setup')).verdict, 'unknown');
  assert.equal(one.worker.inFlightOp(one.job.walletId!)?.state, 'ambiguous');
  const two = setup(t, 'funded');
  two.c.registration.delete(`${USDC}:${owner}`);
  assert.equal((await two.ops(noTxReply(() => two.c.registration.add(`${USDC}:${owner}`), others)).registerStorage(USDC, 'owner', 'setup')).verdict, 'success');
  assert.equal(two.worker.inFlightOp(two.job.walletId!), null);
});

test('10.1 already_registered with a hash takes the receipt path', async t => {
  const { job, worker, c, ops } = setup(t, 'funded');
  const raw = fixture('tx-1.27-storage-usdc'), hash = c.addTx(raw);
  c.registration.delete(`${USDC}:${agent}`);
  const o = ops(noTxReply(() => { c.registration.add(`${USDC}:${agent}`); c.setHoldings({ native: c.native - MONEY.storageDeposit - fee(raw), height: 30 }); }, { tx_hash: hash }));
  assert.equal((await o.registerStorage(USDC, 'agent', 'setup')).verdict, 'success');
  const row = worker.jobOps(job.id)[0];
  assert.equal(row.txHash, hash); assert.equal(row.code, null);
  assert.equal(row.gasBurnt, fee(raw)); assert.equal(row.nativeSpend, MONEY.storageDeposit + fee(raw));
  assert.ok(row.finishedBlock !== null);
  // A marker that a later answer's hash joins is ignored in the same way.
  const two = setup(t, 'funded'), hash2 = two.c.addTx(raw);
  two.c.registration.delete(`${USDC}:${agent}`);
  const o2 = two.ops(dummyOutLayer({
    storageDeposit: async () => ({ kind: 'accepted', requestId: 'request-test', status: 'pending', terminal: false, txHash: null, alreadyRegistered: true }),
    request: async () => { two.c.registration.add(`${USDC}:${agent}`); two.c.setHoldings({ native: two.c.native - MONEY.storageDeposit - fee(raw), height: 30 }); return accepted(hash2); },
  }));
  assert.equal((await o2.registerStorage(USDC, 'agent', 'setup')).verdict, 'success');
  const marked = two.worker.jobOps(two.job.id)[0];
  assert.equal(marked.code, 'already_registered'); assert.equal(marked.gasBurnt, fee(raw)); assert.ok(marked.finishedBlock !== null);
});

test('10.1 already_registered on another operation kind is ignored', async t => {
  const { job, worker, ops, waits } = setup(t);
  assert.equal((await ops(noTxReply()).wrap(wrap)).verdict, 'unknown');
  assert.deepEqual(waits, []);
  const row = worker.inFlightOp(job.walletId!);
  assert.equal(row?.state, 'ambiguous'); assert.equal(row?.code, null);
  // A storage answer without the exact flag takes the same path, even with the chain agreeing.
  const two = setup(t, 'funded');
  two.c.registration.delete(`${USDC}:${owner}`);
  assert.equal((await two.ops(noTxReply(() => two.c.registration.add(`${USDC}:${owner}`), { already_registered: 'true' })).registerStorage(USDC, 'owner', 'setup')).verdict, 'unknown');
  assert.deepEqual(two.waits, []);
  assert.equal(two.worker.inFlightOp(two.job.walletId!)?.code, null);
});

// Phase 1 fix 3: an unanswered setup registration is released for exit only, after 10 minutes, on chain evidence.
const lostReply = (count: { n: number }) => dummyOutLayer({
  storageDeposit: async () => { count.n++; return { kind: 'ambiguous', reason: 'network' }; },
  call: async () => { count.n++; throw new Error('no submission expected'); }, transfer: async () => { count.n++; throw new Error('no submission expected'); },
});
const reconcileAt = (s: ReturnType<typeof setup>, at: number, outlayer: OutLayerClient, extra: { live?: boolean } = {}) =>
  reconcileWallet({ store: s.worker, rpc: s.c.rpc, outlayer, kek: s.kek, now: () => at, wait: async () => {}, live: true, ...extra }, s.job.walletId!);

test('fix 3: an unanswered setup registration (agent on wNEAR, owner on USDC) is released for exit after 10 minutes', async t => {
  for (const who of ['agent', 'owner'] as const) {
    const s = setup(t, 'funded'), token = who === 'agent' ? WNEAR : USDC, account = who === 'agent' ? agent : owner, count = { n: 0 };
    s.c.registration.delete(`${token}:${account}`);
    assert.equal((await s.ops(lostReply(count)).registerStorage(token, who, 'setup')).verdict, 'unknown');
    const row = s.worker.inFlightOp(s.job.walletId!)!;
    assert.equal(row.state, 'ambiguous'); assert.equal(row.kind, who === 'agent' ? 'storage' : 'storage_owner');
    assert.equal(s.worker.getJob(s.job.id)?.state, 'halted');
    assert.equal(count.n, 4, 'fix 4: the original and three same-key re-sends');
    const reads = { n: 0 }, finalBlock = s.c.rpc.finalBlock!;
    s.c.rpc.finalBlock = async () => { reads.n++; return finalBlock(); };
    assert.equal(await reconcileAt(s, row.submittedAt! + 599_999, lostReply(count)), 'halted');
    assert.equal(reads.n, 0, 'no chain read before 10 minutes');
    assert.equal(s.worker.inFlightOp(s.job.walletId!)?.state, 'ambiguous');
    s.c.setHoldings({ height: s.c.height + 1 });
    assert.equal(await reconcileAt(s, row.submittedAt! + 600_000, lostReply(count)), 'clean');
    const done = s.worker.jobOps(s.job.id).find(o => o.id === row.id)!;
    assert.equal(done.state, 'finished'); assert.equal(done.verdict, 'unclear'); assert.equal(done.message, REGISTRATION_RELEASED);
    assert.equal(done.nativeSpend, row.nativeSpend, 'the possible spend stays counted');
    assert.equal(s.worker.inFlightOp(s.job.walletId!), null);
    const j = s.worker.getJob(s.job.id)!;
    assert.equal(j.state, 'halted'); assert.match(j.reason ?? '', /Submission reconciled\. Use Stop and withdraw/);
    assert.equal(canTransition('halted', 'stopping', 'web'), true); assert.equal(canTransition('halted', 'resuming', 'web'), false);
    assert.ok(s.worker.openAlerts(s.job.id).some(a => a.kind === 'op_ambiguous'), 'the alert stays');
    await assert.rejects(s.ops(lostReply(count)).registerStorage(token, who, 'setup'), 'setup still refuses on the halted job');
    await assert.rejects(s.ops(lostReply(count)).wrap(wrap), 'strategy still refuses on the halted job');
    assert.equal(count.n, 4, 'nothing more was sent: the watchdog was stale for the reconcile re-sends');
    const again = openStore(s.path, 'worker');
    try { assert.equal(again.jobOps(s.job.id).find(o => o.id === row.id)?.state, 'finished'); } finally { again.close(); }
    // What the stop route does once no submission is ambiguous: the owner's Stop and withdraw moves halted to stopping.
    assert.equal(s.web.inFlightOp(s.job.walletId!), null);
    assert.ok(setJob(s.web, s.web.getJob(s.job.id)!, 'stopping', testNow + 600_001, { reason: null }));
    assert.equal(s.worker.getJob(s.job.id)?.state, 'stopping');
  }
});

test('fix 3: the release is refused on any missing condition and other kinds stay quarantined', async t => {
  const request = (over: Record<string, unknown> = {}, args: Record<string, unknown> = {}) =>
    json({ receiver: WNEAR, method: 'storage_deposit', deposit: MONEY.storageDeposit.toString(), args: { account_id: agent, registration_only: true, ...args }, ...over });
  const attempt = async (patch: (s: ReturnType<typeof setup>, before: string) => Partial<Parameters<typeof opRow>[1]> | null, chainSetup = (_s: ReturnType<typeof setup>) => {}, halted = true) => {
    const s = setup(t, 'funded');
    s.c.registration.delete(`${WNEAR}:${agent}`);
    const before = json(await readHoldings(s.c.rpc, agent, [WNEAR, USDC]));
    const row = opRow(s.job, { kind: 'storage', purpose: 'setup', state: 'ambiguous', verdict: 'unknown', request: request(), before, submittedAt: testNow, nativeSpend: MONEY.storageDeposit, ...(patch(s, before) ?? {}) });
    assert.ok(s.worker.insertOp(row));
    if (halted) assert.ok(setJob(s.worker, s.worker.getJob(s.job.id)!, 'halted', testNow, { reason: 'Submission is unresolved.' }));
    s.c.setHoldings({ height: s.c.height + 1 });
    chainSetup(s);
    const count = { n: 0 };
    const outcome = await reconcileAt(s, testNow + 600_000, lostReply(count));
    assert.equal(count.n, 0);
    return { outcome, state: s.worker.jobOps(s.job.id).find(o => o.id === row.id)?.state, job: s.worker.getJob(s.job.id)?.state };
  };
  assert.deepEqual(await attempt(() => ({})), { outcome: 'clean', state: 'finished', job: 'halted' }, 'positive control');
  // Audit M-1: a job that is not halted (a quarantine interrupted between the row and the halt) is halted first, never released.
  assert.deepEqual(await attempt(() => ({}), undefined, false), { outcome: 'halted', state: 'ambiguous', job: 'halted' }, 'job not halted');
  const refusals: [string, (s: ReturnType<typeof setup>, before: string) => Partial<Parameters<typeof opRow>[1]>, ((s: ReturnType<typeof setup>) => void)?][] = [
    ['registration exists', () => ({}), s => { s.c.registration.add(`${WNEAR}:${agent}`); }],
    ['a tracked asset fell', () => ({}), s => { s.c.setHoldings({ native: s.c.native - 1n }); }],
    ['a tracked token fell', () => ({}), s => { s.c.setHoldings({ usdc: s.c.usdc - 1n }); }],
    ['the snapshot is not newer', () => ({}), s => { s.c.setHoldings({ height: s.c.height - 1 }); }],
    ['an http answer was recorded', () => ({ http: 500 })],
    ['the row is still submitted (job halted for another reason)', () => ({ state: 'submitted', verdict: null })],
    ['a code was recorded', () => ({ code: 'wallet_busy' })],
    ['another method', () => ({ request: request({ method: 'near_deposit' }) })],
    ['read fails', () => ({}), s => { s.c.setReadable(false); }],
    ['before missing', () => ({ before: null })],
    ['before lacks a tracked token', (_s, before) => { const b = JSON.parse(before); delete b.tokens[USDC]; return { before: JSON.stringify(b) }; }],
    ['submittedAt missing', () => ({ submittedAt: null })],
    ['submittedAt in the future', () => ({ submittedAt: testNow + 700_000 })],
    ['purpose strategy', () => ({ purpose: 'strategy' })],
    ['kind wrap (account matching the non-storage branch)', () => ({ kind: 'wrap', request: request({}, { account_id: owner }) })],
    ['receiver not a pinned token', () => ({ request: request({ receiver: 'v2.ref-finance.near' }) })],
    ['registration_only false', () => ({ request: request({}, { registration_only: false }) })],
    ['account does not match the kind', () => ({ request: request({}, { account_id: owner }) })],
    ['deposit differs', () => ({ request: request({ deposit: (MONEY.storageDeposit + 1n).toString() }) })],
    ['request id set', () => ({ requestId: 'request-x' })],
    ['tx hash set', () => ({ txHash: 'tx-x' })],
  ];
  for (const [name, patch, chainSetup] of refusals) assert.deepEqual(await attempt(patch, chainSetup), { outcome: 'halted', state: 'ambiguous', job: 'halted' }, name);
  // Audit M-2: a row still 'submitted' (worker killed during the submit) is quarantined first, then released on the next pass.
  {
    const s = setup(t, 'funded');
    s.c.registration.delete(`${WNEAR}:${agent}`);
    const before = json(await readHoldings(s.c.rpc, agent, [WNEAR, USDC]));
    const row = opRow(s.job, { kind: 'storage', purpose: 'setup', request: request(), before, submittedAt: testNow, nativeSpend: MONEY.storageDeposit });
    assert.ok(s.worker.insertOp(row));
    s.c.setHoldings({ height: s.c.height + 1 });
    const count = { n: 0 };
    assert.equal(await reconcileAt(s, testNow + 600_000, lostReply(count)), 'halted');
    assert.equal(s.worker.inFlightOp(s.job.walletId!)?.state, 'ambiguous');
    assert.equal(s.worker.getJob(s.job.id)?.state, 'halted');
    assert.ok(s.worker.openAlerts(s.job.id).some(a => a.kind === 'op_ambiguous'));
    assert.equal(await reconcileAt(s, testNow + 615_000, lostReply(count)), 'clean');
    assert.equal(s.worker.inFlightOp(s.job.walletId!), null);
    assert.equal(count.n, 0);
  }
  // An unanswered strategy operation stays quarantined however old.
  const s = setup(t);
  const count = { n: 0 };
  assert.equal((await s.ops(dummyOutLayer({ call: async () => { count.n++; return { kind: 'ambiguous', reason: 'network' }; } })).wrap(wrap)).verdict, 'unknown');
  const row = s.worker.inFlightOp(s.job.walletId!)!;
  assert.equal(await reconcileAt(s, row.submittedAt! + 10 * 86_400_000, lostReply(count)), 'halted');
  assert.equal(s.worker.inFlightOp(s.job.walletId!)?.state, 'ambiguous');
});

test('an ambiguous submission is rechecked every 15 s for its first hour, then every 2 minutes; other states and a missing send time stay at 15 s', () => {
  const at = (state: 'ambiguous' | 'submitted', submittedAt: number | null, now: number) => reconcileEvery({ state, submittedAt }, now);
  assert.equal(at('ambiguous', testNow, testNow + AMBIGUOUS_SLOW_AFTER_MS - 1), 15_000);
  assert.equal(at('ambiguous', testNow, testNow + AMBIGUOUS_SLOW_AFTER_MS), AMBIGUOUS_SLOW_MS);
  assert.equal(AMBIGUOUS_SLOW_MS, 120_000);
  assert.equal(at('ambiguous', null, testNow + 10 * AMBIGUOUS_SLOW_AFTER_MS), 15_000);
  assert.equal(at('submitted', testNow, testNow + 10 * AMBIGUOUS_SLOW_AFTER_MS), 15_000);
});

// Phase 1 fix 4 (ruling 2026-11-12): a lost OutLayer reply is recovered by a re-send of the same request under the same key.
const hashOf = (a: SubmitResult) => a.kind === 'accepted' ? a.txHash! : '';
const lostCall = (keys: string[]) => dummyOutLayer({ call: async (_k, _r, idem) => { keys.push(idem); return { kind: 'ambiguous', reason: 'network' }; } });

test('fix 4 F4-1: a lost reply recovered by the duplicate answer under the same key settles with no halt', async t => {
  const s = setup(t), keys: string[] = [];
  let hash = '';
  const api = dummyOutLayer({
    call: async (_k, _r, idem) => {
      keys.push(idem);
      if (keys.length === 1) return { kind: 'ambiguous', reason: 'server', http: 502 };
      hash = hashOf(landWrap(s.c));
      return { kind: 'accepted', requestId: 'request-dup', status: 'processing', terminal: false, txHash: null };
    },
    request: async (_k, id) => { assert.equal(id, 'request-dup'); return { kind: 'accepted', requestId: 'request-dup', status: 'success', terminal: true, txHash: hash }; },
  });
  assert.equal((await s.ops(api).wrap(wrap)).verdict, 'success');
  assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]);
  assert.deepEqual(s.waits.slice(0, 2), [5000, 4000], '5 s before the re-send, then the first poll');
  const row = s.worker.jobOps(s.job.id)[0];
  assert.equal(row.state, 'finished'); assert.equal(row.requestId, 'request-dup'); assert.equal(row.idemKey, keys[0]);
  assert.equal(s.worker.getJob(s.job.id)?.state, 'running');
  assert.equal(s.worker.openAlerts(s.job.id).filter(a => a.severity !== 'info').length, 0);
  const note = s.worker.noReply(row.id)!;
  assert.deepEqual(note.first, { kind: 'ambiguous', reason: 'server', http: 502 });
  assert.deepEqual(note.last, { kind: 'accepted', reason: null, http: 200 });
  assert.equal(note.resends, 1);
});

test('fix 4 F4-1: a re-send answered by rejected, policy_denied, busy, another lost reply or an accepted body with no id is never applied', async t => {
  for (const answers of [
    [{ kind: 'ambiguous', reason: 'timeout' }, { kind: 'busy', inFlightRequestId: 'other' }, { kind: 'accepted', requestId: null, status: null, terminal: false, txHash: null }, { kind: 'busy', inFlightRequestId: null }],
    [{ kind: 'ambiguous', reason: 'network' }, { kind: 'rejected', http: 401, code: null, message: 'no' }, { kind: 'denied', code: 'policy_denied', message: 'no' }, { kind: 'reverted', requestId: null, txHash: null, message: 'x' }],
  ] as SubmitResult[][]) {
    const s = setup(t);
    let i = 0;
    assert.equal((await s.ops(dummyOutLayer({ call: async () => answers[i++] })).wrap(wrap)).verdict, 'unknown');
    assert.equal(i, 4);
    const row = s.worker.inFlightOp(s.job.walletId!)!;
    assert.equal(row.state, 'ambiguous'); assert.equal(row.http, null); assert.equal(row.code, null); assert.equal(row.requestId, null);
    assert.equal(s.worker.getJob(s.job.id)?.state, 'halted', 'neither frozen nor finished');
    assert.equal(s.worker.meta(`quota:${s.job.walletId}`), null);
    assert.deepEqual(s.worker.openAlerts(s.job.id).filter(a => a.severity !== 'info').map(a => a.kind), ['op_ambiguous']);
    const note = s.worker.noReply(row.id)!;
    assert.equal(note.resends, 3); assert.equal(note.pending, false); assert.equal(note.stopped, undefined);
  }
});

test('fix 4 audit L-4 and M-3: a re-send 429 stores its wait and stops; wallet_frozen stops and ends the re-sends of a strategy row', async t => {
  {
    const s = setup(t);
    let i = 0;
    const answers: SubmitResult[] = [{ kind: 'ambiguous', reason: 'network' }, { kind: 'quota', retryAfterSeconds: 600 }];
    assert.equal((await s.ops(dummyOutLayer({ call: async () => answers[i++] })).wrap(wrap)).verdict, 'unknown');
    assert.equal(i, 2, 'no re-send after a 429');
    assert.equal(s.worker.meta(`quota:${s.job.walletId}`), String(testNow + 600_000));
    const row = s.worker.inFlightOp(s.job.walletId!)!, keys: string[] = [];
    assert.equal(row.state, 'ambiguous'); assert.equal(row.verdict, 'unknown');
    s.watch.heartbeat('watchdog', testNow + 300_000);
    await reconcileAt(s, testNow + 300_000, lostCall(keys));
    assert.equal(keys.length, 0, 'the reported wait is honoured');
    s.watch.heartbeat('watchdog', testNow + 600_000);
    await reconcileAt(s, testNow + 600_000, lostCall(keys));
    assert.equal(keys.length, 1, 'and the re-send follows once it ends');
  }
  {
    const s = setup(t);
    let i = 0;
    const answers: SubmitResult[] = [{ kind: 'ambiguous', reason: 'network' }, { kind: 'denied', code: 'wallet_frozen', message: 'frozen' }];
    assert.equal((await s.ops(dummyOutLayer({ call: async () => answers[i++] })).wrap(wrap)).verdict, 'unknown');
    assert.equal(i, 2, 'no re-send after wallet_frozen');
    const row = s.worker.inFlightOp(s.job.walletId!)!, keys: string[] = [];
    assert.equal(s.worker.getJob(s.job.id)?.state, 'halted'); assert.equal(s.worker.noReply(row.id)?.stopped, true);
    s.watch.heartbeat('watchdog', testNow + 3_600_000);
    await reconcileAt(s, testNow + 3_600_000, lostCall(keys));
    assert.equal(keys.length, 0, 'a frozen strategy row is never re-sent');
  }
});

test('fix 4 F4-2 and F4-5: reconcile re-sends under the same key on a growing interval, proves the answer and releases the halt to Resume', async t => {
  const s = setup(t), keys: string[] = [];
  assert.equal((await s.ops(lostCall(keys)).wrap(wrap)).verdict, 'unknown');
  const row = s.worker.inFlightOp(s.job.walletId!)!;
  assert.equal(keys.length, 4);
  const at = (ms: number, api: OutLayerClient) => { s.watch.heartbeat('watchdog', testNow + ms); return reconcileAt(s, testNow + ms, api); };
  assert.equal(await at(RESEND_EVERY_MS - 1, lostCall(keys)), 'halted');
  assert.equal(keys.length, 4, 'not before 2 minutes after the last answer');
  assert.equal(await at(RESEND_EVERY_MS, lostCall(keys)), 'halted');
  assert.equal(keys.length, 5);
  assert.equal(await at(RESEND_EVERY_MS + resendEvery(4) - 1, lostCall(keys)), 'halted');
  assert.equal(keys.length, 5, 'the next one waits 4 minutes after that answer');
  const lands = dummyOutLayer({ call: async (_k, req, idem) => { keys.push(idem); assert.equal(req.deposit, wrap); return landWrap(s.c); } });
  assert.equal(await at(RESEND_EVERY_MS + resendEvery(4), lands), 'clean');
  assert.ok(keys.every(k => k === row.idemKey), 'one key for every send');
  const done = s.worker.jobOps(s.job.id).find(o => o.id === row.id)!;
  assert.equal(done.state, 'finished'); assert.equal(done.verdict, 'success');
  const j = s.worker.getJob(s.job.id)!;
  assert.equal(j.state, 'paused'); assert.equal(j.reason, RECONCILED_PAUSE);
  assert.equal(s.worker.openAlerts(s.job.id).filter(a => a.severity !== 'info').length, 0, 'the op_ambiguous alert is acknowledged');
  assert.equal(canTransition('paused', 'resuming', 'web'), true, 'the owner signs the existing Resume');
});

test('fix 4 F4-2: no reconcile re-send after 24 h, with a stale watchdog, under another blocking alert, or for a row that got a reply', async t => {
  const lost = async (s: ReturnType<typeof setup>, keys: string[]) => { assert.equal((await s.ops(lostCall(keys)).wrap(wrap)).verdict, 'unknown'); return s.worker.inFlightOp(s.job.walletId!)!; };
  {
    const s = setup(t), keys: string[] = [];
    await lost(s, keys);
    s.watch.heartbeat('watchdog', testNow + RESEND_MAX_AGE_MS);
    await reconcileAt(s, testNow + RESEND_MAX_AGE_MS, lostCall(keys));
    assert.equal(keys.length, 4, 'not after 24 h');
    s.watch.heartbeat('watchdog', testNow + RESEND_MAX_AGE_MS - 1);
    await reconcileAt(s, testNow + RESEND_MAX_AGE_MS - 1, lostCall(keys));
    assert.equal(keys.length, 5, 'still inside 24 h');
    s.watch.heartbeat('watchdog', testNow + RESEND_MAX_AGE_MS + RESEND_MAX_EVERY_MS);
    await reconcileAt(s, testNow + RESEND_MAX_AGE_MS + RESEND_MAX_EVERY_MS, lostCall(keys));
    assert.equal(keys.length, 5, 'the 24 h count from the submission, not from the last send');
  }
  {
    const s = setup(t), keys: string[] = [];
    await lost(s, keys);
    s.watch.heartbeat('watchdog', testNow + RESEND_EVERY_MS);
    await reconcileAt(s, testNow + RESEND_EVERY_MS, lostCall(keys), { live: false });
    assert.equal(keys.length, 4, 'audit H-1: a worker with live operations off never re-sends');
    assert.ok(s.worker.insertAlert({ jobId: s.job.id, kind: 'frozen', severity: 'info', detail: { message: 'x' }, createdAt: testNow - 1 }));
    await reconcileAt(s, testNow + RESEND_EVERY_MS, lostCall(keys));
    assert.equal(keys.length, 5, 'an info alert from before the submission does not block (audit D8b)');
  }
  {
    const s = setup(t), keys: string[] = [];
    await lost(s, keys);
    assert.ok(s.worker.insertAlert({ jobId: s.job.id, kind: 'frozen', severity: 'info', detail: { message: 'x' }, createdAt: testNow + 1 }));
    s.watch.heartbeat('watchdog', testNow + RESEND_EVERY_MS);
    await reconcileAt(s, testNow + RESEND_EVERY_MS, lostCall(keys));
    assert.equal(keys.length, 4, 'audit M-3: a freeze seen after the submission ends the re-sends of a strategy row');
  }
  {
    const s = setup(t), keys: string[] = [];
    await lost(s, keys);
    s.watch.invalidateWatch(s.job.id, true);
    s.watch.heartbeat('watchdog', testNow + RESEND_EVERY_MS);
    await reconcileAt(s, testNow + RESEND_EVERY_MS, lostCall(keys));
    assert.equal(keys.length, 4, 'audit M-2: no re-send during a watchdog read wait');
  }
  {
    const s = setup(t), keys: string[] = [];
    const row = await lost(s, keys);
    s.c.setPolicy(null);
    s.watch.heartbeat('watchdog', testNow + RESEND_EVERY_MS);
    await reconcileAt(s, testNow + RESEND_EVERY_MS, lostCall(keys));
    assert.equal(keys.length, 4, 'audit M-2: no re-send without a finalized policy');
    assert.ok(s.worker.openAlerts(s.job.id).some(a => a.kind === 'policy_missing'));
    assert.equal(s.worker.inFlightOp(s.job.walletId!)?.id, row.id);
  }
  {
    const s = setup(t), keys: string[] = [];
    const row = await lost(s, keys);
    s.c.freeze(true);
    s.watch.heartbeat('watchdog', testNow + RESEND_EVERY_MS);
    await reconcileAt(s, testNow + RESEND_EVERY_MS, lostCall(keys));
    assert.equal(keys.length, 4, 'audit M-3: no re-send to a frozen wallet');
    assert.equal(s.worker.noReply(row.id)?.stopped, true, 'and none after the unfreeze');
  }
  {
    const s = setup(t), keys: string[] = [];
    await lost(s, keys);
    await reconcileAt(s, testNow + 61_000 + RESEND_EVERY_MS, lostCall(keys));
    assert.equal(keys.length, 4, 'stale watchdog');
  }
  {
    const s = setup(t), keys: string[] = [];
    await lost(s, keys);
    assert.ok(s.worker.insertAlert({ jobId: s.job.id, kind: 'token_outflow', severity: 'halt', detail: { message: 'x' }, createdAt: testNow }));
    s.watch.heartbeat('watchdog', testNow + RESEND_EVERY_MS);
    await reconcileAt(s, testNow + RESEND_EVERY_MS, lostCall(keys));
    assert.equal(keys.length, 4, 'another blocking alert');
  }
  {
    const s = setup(t), keys: string[] = [];
    const row = await lost(s, keys);
    s.worker.updateOp(row.id, { http: 409, code: 'wallet_busy' });
    s.watch.heartbeat('watchdog', testNow + RESEND_EVERY_MS);
    await reconcileAt(s, testNow + RESEND_EVERY_MS, lostCall(keys));
    assert.equal(keys.length, 4, 'a row with a recorded reply');
  }
});

test('fix 4 F4-5: the release needs a finished non-exit proven row, a clean history, only op_ambiguous alerts and the same job version', async t => {
  const halted = async (state: 'running' | 'stopping' = 'running', before = (_s: ReturnType<typeof setup>) => {}) => {
    const s = setup(t, state), keys: string[] = [];
    before(s);
    const api = dummyOutLayer({ call: async (_k, _r, idem) => { keys.push(idem); return { kind: 'ambiguous', reason: 'network' }; },
      transfer: async (_k, _to, _a, idem) => { keys.push(idem); return { kind: 'ambiguous', reason: 'network' }; } });
    if (state === 'stopping') await s.ops(api).transferNearToOwner(N / 10n); else await s.ops(api).wrap(wrap);
    const row = s.worker.inFlightOp(s.job.walletId!)!;
    assert.equal(s.worker.getJob(s.job.id)?.state, 'halted');
    return { s, row };
  };
  const finish = (s: ReturnType<typeof setup>, id: string, verdict = 'success') => s.worker.updateOp(id, { state: 'finished', verdict, finishedAt: testNow });
  {
    const { s, row } = await halted();
    assert.equal(s.worker.releaseReconciledHalt(s.worker.getJob(s.job.id)!, row.id, testNow), false, 'the row is still in flight');
    finish(s, row.id);
    const stale = s.worker.getJob(s.job.id)!;
    assert.ok(setJob(s.worker, stale, 'halted', testNow, { reason: 'changed' }));
    assert.equal(s.worker.releaseReconciledHalt(stale, row.id, testNow), false, 'another job version');
    assert.equal(s.worker.releaseReconciledHalt(s.worker.getJob(s.job.id)!, row.id, testNow), true);
    assert.equal(s.worker.getJob(s.job.id)?.state, 'paused');
  }
  {
    const { s, row } = await halted();
    finish(s, row.id, 'unclear');
    assert.equal(s.worker.releaseReconciledHalt(s.worker.getJob(s.job.id)!, row.id, testNow), false, 'unclear verdict');
  }
  {
    const { s, row } = await halted();
    finish(s, row.id);
    assert.ok(s.worker.insertAlert({ jobId: s.job.id, kind: 'token_outflow', severity: 'halt', detail: { message: 'x' }, createdAt: testNow }));
    assert.equal(s.worker.releaseReconciledHalt(s.worker.getJob(s.job.id)!, row.id, testNow), false, 'another blocking alert');
    assert.equal(s.worker.getJob(s.job.id)?.state, 'halted');
  }
  {
    const { s, row } = await halted('running', s => assert.ok(s.worker.insertOp(opRow(s.job, { state: 'finished', verdict: 'unclear', finishedAt: testNow, createdAt: testNow - 1 }))));
    finish(s, row.id);
    assert.equal(s.worker.releaseReconciledHalt(s.worker.getJob(s.job.id)!, row.id, testNow), false, 'an unclear row in the history');
  }
  {
    const { s, row } = await halted('stopping');
    assert.equal(row.purpose, 'exit');
    finish(s, row.id);
    assert.equal(s.worker.releaseReconciledHalt(s.worker.getJob(s.job.id)!, row.id, testNow), false, 'an exit row');
  }
});

test('fix 4 F4-3: the re-send is rebuilt from the journal for its own endpoint, or not at all', async t => {
  const { job } = setup(t), key = new SecretString('wk_test_fake'), seen: unknown[] = [];
  const api = dummyOutLayer({
    call: async (_k, req, idem) => { seen.push(['call', req, idem]); return accepted('h'); },
    transfer: async (_k, to, amount, idem) => { seen.push(['transfer', to, amount, idem]); return accepted('h'); },
    storageDeposit: async (_k, token, account, idem) => { seen.push(['storage', token, account, idem]); return accepted('h'); },
  });
  const send = async (kind: string, request: unknown) => {
    seen.length = 0;
    const f = resendOf(api, opRow(job, { kind, idemKey: 'idem-1', request: typeof request === 'string' ? request : json(request) }), job, key);
    if (!f) return null;
    await f();
    return seen[0];
  };
  const swapArgs = { receiver_id: 'v2.ref-finance.near', amount: '5', msg: '{}' };
  assert.deepEqual(await send('transfer_near_owner', { receiver: owner, method: null, args: null, deposit: '7' }), ['transfer', owner, 7n, 'idem-1']);
  assert.deepEqual(await send('storage', { receiver: USDC, method: 'storage_deposit', args: { account_id: agent }, deposit: '1250' }), ['storage', USDC, null, 'idem-1']);
  assert.deepEqual(await send('storage_owner', { receiver: USDC, method: 'storage_deposit', args: { account_id: owner }, deposit: '1250' }), ['storage', USDC, owner, 'idem-1']);
  assert.deepEqual(await send('swap', { receiver: WNEAR, method: 'ft_transfer_call', args: swapArgs, deposit: '1', gas: '300000000000000', step: 's:1' }),
    ['call', { receiverId: WNEAR, methodName: 'ft_transfer_call', args: swapArgs, gas: 300_000_000_000_000n, deposit: 1n }, 'idem-1']);
  assert.deepEqual(await send('swap', { receiver: WNEAR, method: 'ft_transfer_call', args: swapArgs, deposit: '1' }),
    ['call', { receiverId: WNEAR, methodName: 'ft_transfer_call', args: swapArgs, gas: swapCall({ ...swap, minOut: 1n }).gas, deposit: 1n }, 'idem-1'], 'builder gas');
  assert.deepEqual(await send('wrap', { receiver: WNEAR, method: 'near_deposit', args: {}, deposit: '9' }),
    ['call', { receiverId: WNEAR, methodName: 'near_deposit', args: {}, gas: wrapCall(9n).gas, deposit: 9n }, 'idem-1']);
  for (const [kind, request] of [
    ['transfer_near_owner', { receiver: 'attacker.near', method: null, args: null, deposit: '7' }],
    ['storage', { receiver: USDC, method: 'ft_transfer', args: {}, deposit: '1' }],
    ['dcl_mystery', { receiver: WNEAR, method: 'x', args: {}, deposit: '1' }],
    ['swap', { receiver: WNEAR, method: null, args: swapArgs, deposit: '1' }],
    ['swap', { receiver: WNEAR, method: 'ft_transfer_call', args: null, deposit: '1' }],
    ['swap', { receiver: WNEAR, method: 'ft_transfer_call', args: swapArgs, deposit: '1', gas: 'lots' }],
    ['wrap', { receiver: WNEAR, method: 'near_deposit', args: {}, deposit: '-9' }],
    ['wrap', 'not json'],
  ] as const) assert.equal(await send(kind, request), null, `${kind} ${JSON.stringify(request)}`);
  // Audit A8b, A8c: the exit rows of a Trade job carry no journaled gas.
  assert.deepEqual(await send('unwrap', { receiver: WNEAR, method: 'near_withdraw', args: { amount: '5' }, deposit: '1' }),
    ['call', { receiverId: WNEAR, methodName: 'near_withdraw', args: { amount: '5' }, gas: unwrapCall(5n).gas, deposit: 1n }, 'idem-1']);
  assert.deepEqual(await send('transfer_token_owner', { receiver: USDC, method: 'ft_transfer', args: { receiver_id: owner, amount: '5' }, deposit: '1' }),
    ['call', { receiverId: USDC, methodName: 'ft_transfer', args: { receiver_id: owner, amount: '5' }, gas: ftTransferCall(USDC, owner, 5n).gas, deposit: 1n }, 'idem-1']);
});

test('fix 4 audit L-7: the re-send start is recorded before the send, a reverted answer is applied, a first busy is not re-sent', async t => {
  {
    const s = setup(t);
    let i = 0, seen: ReturnType<typeof s.worker.noReply> = null;
    const api = dummyOutLayer({ call: async () => {
      if (i++ === 0) return { kind: 'ambiguous', reason: 'network' };
      seen = s.worker.noReply(s.worker.inFlightOp(s.job.walletId!)!.id);
      return { kind: 'reverted', requestId: 'request-r', txHash: null, message: 'failed' };
    }, request: async () => ({ kind: 'reverted', requestId: 'request-r', txHash: null, message: 'failed' }) });
    await s.ops(api).wrap(wrap);
    assert.deepEqual([seen!.resends, seen!.pending, seen!.at], [1, true, testNow], 'R3: pending and counted while the re-send is in flight');
    const row = s.worker.jobOps(s.job.id)[0];
    assert.equal(i, 2, 'R1e: the reverted answer ended the re-sends');
    assert.equal(row.requestId, 'request-r'); assert.equal(row.http, 422);
  }
  {
    const s = setup(t);
    let calls = 0;
    assert.equal((await s.ops(dummyOutLayer({ call: async () => { calls++; return { kind: 'busy', inFlightRequestId: null }; } })).wrap(wrap)).verdict, 'unknown');
    assert.equal(calls, 1, 'R7: only a lost reply is re-sent, not a first wallet_busy');
  }
});

test('fix 4 audit L-3: the reconcile interval grows 2, 4, 8, then 15 minutes after the three F4-1 re-sends', () => {
  assert.deepEqual([0, 3, 4, 5, 6, 7, 50].map(resendEvery), [RESEND_EVERY_MS, RESEND_EVERY_MS, 240_000, 480_000, RESEND_MAX_EVERY_MS, RESEND_MAX_EVERY_MS, RESEND_MAX_EVERY_MS]);
  assert.equal(RESEND_MAX_EVERY_MS, 900_000);
});

test('fix 4 audit L-1: fix 3 counts its 10 quiet minutes from the latest re-send', async t => {
  const s = setup(t, 'funded'), count = { n: 0 };
  s.c.registration.delete(`${WNEAR}:${agent}`);
  assert.equal((await s.ops(lostReply(count)).registerStorage(WNEAR, 'agent', 'setup')).verdict, 'unknown');
  const row = s.worker.inFlightOp(s.job.walletId!)!;
  s.c.setHoldings({ height: s.c.height + 1 });
  s.watch.heartbeat('watchdog', testNow + 600_000);
  assert.equal(await reconcileAt(s, testNow + 600_000, lostReply(count)), 'halted');
  assert.equal(count.n, 5, 're-sent in this pass');
  assert.equal(s.worker.inFlightOp(s.job.walletId!)?.id, row.id, 'and not released in the same pass');
  s.c.setHoldings({ height: s.c.height + 1 });
  assert.equal(await reconcileAt(s, testNow + 1_200_000, lostReply(count)), 'clean', 'released 10 minutes after that re-send (stale watchdog, no re-send)');
  assert.equal(count.n, 5);
});

test('fix 4 audit S7: the release needs an open op_ambiguous alert', async t => {
  const s = setup(t);
  await s.ops(lostCall([])).wrap(wrap);
  const row = s.worker.inFlightOp(s.job.walletId!)!;
  s.worker.updateOp(row.id, { state: 'finished', verdict: 'success', finishedAt: testNow });
  const raw = new DatabaseSync(s.path);
  try { raw.prepare('UPDATE alerts SET acknowledged_at=? WHERE job_id=?').run(testNow, s.job.id); } finally { raw.close(); }
  assert.equal(s.worker.releaseReconciledHalt(s.worker.getJob(s.job.id)!, row.id, testNow), false);
  assert.equal(s.worker.getJob(s.job.id)?.state, 'halted');
});

test('fix 4 audit H-1: a strategy row of a Grid job is re-sent only with the Grid flags on', async t => {
  const { web, worker, watch } = stores(t), { job, kek } = armedJob(web, worker, 'running', N, { gridV1: true }), c = chain();
  assert.ok(worker.insertOp(opRow(job, { state: 'ambiguous', verdict: 'unknown', submittedAt: testNow, request: json({ receiver: WNEAR, method: 'near_deposit', args: {}, deposit: wrap.toString(), gas: '30000000000000' }) })));
  const keys: string[] = [], at = testNow + RESEND_EVERY_MS;
  watch.heartbeat('watchdog', at);
  const go = (flags: object) => reconcileWallet({ store: worker, rpc: c.rpc, outlayer: lostCall(keys), kek, now: () => at, wait: async () => {}, live: true, ...flags }, job.walletId!);
  await go({});
  assert.equal(keys.length, 0, 'Grid disabled in this worker');
  await go({ gridV1: true });
  assert.equal(keys.length, 1);
});

test('fix 4 audit M-1: the reconcile interval counts from the answer, not from the start of the re-send', async t => {
  const s = setup(t), keys: string[] = [];
  await s.ops(lostCall(keys)).wrap(wrap);
  let clock = testNow + RESEND_EVERY_MS;
  const slow = dummyOutLayer({ call: async (_k, _r, idem) => { keys.push(idem); clock += 100_000; return { kind: 'ambiguous', reason: 'network' }; } });
  const at = (t: number) => { clock = t; s.watch.heartbeat('watchdog', t); return reconcileWallet({ store: s.worker, rpc: s.c.rpc, outlayer: slow, kek: s.kek, now: () => clock, wait: async () => {}, live: true }, s.job.walletId!); };
  await at(testNow + RESEND_EVERY_MS);
  assert.equal(keys.length, 5);
  const answered = testNow + RESEND_EVERY_MS + 100_000;
  assert.equal(s.worker.noReply(s.worker.inFlightOp(s.job.walletId!)!.id)?.answeredAt, answered);
  await at(answered + resendEvery(4) - 1);
  assert.equal(keys.length, 5, 'not yet: 4 minutes after the answer');
  await at(answered + resendEvery(4));
  assert.equal(keys.length, 6);
});

