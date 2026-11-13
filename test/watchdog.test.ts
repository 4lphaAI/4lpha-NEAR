import test from 'node:test';
import assert from 'node:assert/strict';
import { YOCTO_PER_NEAR as N } from '../src/core/amounts.js';
import { RpcUnavailable } from '../src/core/near-rpc.js';
import { USDC, WNEAR } from '../src/core/pins.js';
import { gasAccounting, parseTxStatus, signedAction } from '../src/core/receipts.js';
import { json, openStore } from '../src/core/store.js';
import { advanceJob, type WorkerDeps } from '../src/core/hire.js';
import { createLiveOps } from '../src/core/ops.js';
import { recipientProblems, watchOnce } from '../src/core/watchdog.js';
import { agent, dummyOutLayer, fixture, owner, stores, testNow } from './helpers.js';
import { armedJob, chain, opRow } from './chain.js';

function setup(t: Parameters<typeof stores>[0], state: 'registered' | 'running' = 'running') {
  const { web, worker, watch, path } = stores(t), { job, kek } = armedJob(web, worker, state), c = chain();
  if (state === 'registered') c.setPolicy(null);
  const d: WorkerDeps = { store: worker, rpc: c.rpc, now: () => testNow, live: true, outlayer: dummyOutLayer(), kek, origin: 'https://app.test', provider: {} };
  return { c, worker, watch, job, d, path, run: () => watchOnce({ store: watch, rpc: c.rpc, now: () => testNow }) };
}
/** A journaled wrap whose effects are on chain above the baseline, with its receipts unreadable until the returned call. */
function landedWrapUnreadable({ c, worker, job }: ReturnType<typeof setup>) {
  const wrap = 45n * N / 1000n, raw = fixture('tx-1.27-wrap'), gas = gasAccounting(parseTxStatus(raw), agent).burnt;
  assert.ok(worker.insertOp(opRow(job, { state: 'finished', verdict: 'success', finishedBlock: 20, txHash: c.addTx(raw),
    request: json({ receiver: WNEAR, method: 'near_deposit', args: {}, deposit: wrap.toString() }) })));
  c.setHoldings({ native: c.native - wrap - gas, wnear: c.wnear + wrap, height: 30 });
  const real = c.rpc.txStatus;
  c.rpc.txStatus = async () => { throw new RpcUnavailable(); };
  return () => { c.rpc.txStatus = real; };
}

test('watchdog alerts on an unexplained finalized token decrease', async t => {
  const { c, run, watch } = setup(t);
  assert.deepEqual(await run(), []);
  c.setHoldings({ wnear: c.wnear - 1n, height: 11 });
  const [alert] = await run();
  assert.equal(alert.kind, 'token_outflow');
  assert.equal(alert.detail.asset, WNEAR);
  assert.equal(alert.severity, 'halt');
  assert.equal(watch.readHeartbeat('watchdog'), testNow);
});

test('watchdog defers submitted rows and only a finalized receipt-proven wrap explains its effects', async t => {
  const { c, run, worker, watch, job } = setup(t);
  await run();
  const wrap = 45n * N / 1000n, raw = fixture('tx-1.27-wrap'), gas = gasAccounting(parseTxStatus(raw), agent).burnt;
  const hash = c.addTx(raw);
  const row = opRow(job, { request: json({ receiver: WNEAR, method: 'near_deposit', args: {}, deposit: wrap.toString() }), txHash: hash });
  assert.ok(worker.insertOp(row));
  c.setHoldings({ native: c.native - wrap - gas, wnear: c.wnear + wrap, height: 30 });
  assert.deepEqual(await run(), []);
  assert.equal(watch.getWatch(job.id)?.block, 10);
  worker.updateOp(row.id, { state: 'finished', finishedBlock: 20, verdict: 'success', after: '{"native":"0"}' });
  assert.deepEqual(await run(), []);
  assert.equal(watch.getWatch(job.id)?.block, 30);
});

test('a legitimate wrap cannot cover an unrelated USDC outflow during the read wait', async t => {
  const { c, run, worker, watch, job } = setup(t);
  await run();
  const wrap = 45n * N / 1000n, raw = fixture('tx-1.27-wrap'), gas = gasAccounting(parseTxStatus(raw), agent).burnt;
  assert.ok(worker.insertOp(opRow(job, { state: 'finished', finishedBlock: 20, txHash: c.addTx(raw),
    request: json({ receiver: WNEAR, method: 'near_deposit', args: {}, deposit: wrap.toString() }) })));
  c.setReadable(false);
  await run();
  c.setReadable(true);
  c.setHoldings({ native: c.native - wrap - gas, wnear: c.wnear + wrap, usdc: c.usdc - 5n, height: 30 });
  const alerts = await run();
  assert.deepEqual(alerts.map(a => [a.kind, a.detail.asset, a.detail.amount]), [['token_outflow', USDC, '5']]);
  assert.equal(watch.getWatch(job.id)?.block, 10);
  assert.equal(watch.watchWaiting(job.id), true);
  const two = setup(t);
  await two.run();
  assert.ok(two.worker.insertOp(opRow(two.job, { state: 'ambiguous' })));
  two.c.setHoldings({ wnear: two.c.wnear - 1n, height: 11 });
  assert.equal((await two.run())[0]?.kind, 'token_outflow');
});

test('watchdog checks finalized signed recipient even when the attempted token transfer failed', async t => {
  const { c, run, worker, job } = setup(t);
  await run();
  const raw = fixture('tx-1.19-ft-transfer-unregistered');
  const a = signedAction(parseTxStatus(raw))!;
  const allowed = { owner, agent, tokens: [USDC], dclKinds: [] };
  assert.ok(recipientProblems(a, allowed).length);
  for (const method of ['nft_transfer', 'mft_transfer']) assert.ok(recipientProblems({ ...a, method }, allowed).length);
  const row = opRow(job, { kind: 'transfer_token_owner', state: 'finished', finishedBlock: 20, txHash: c.addTx(raw), verdict: 'reverted' });
  assert.ok(worker.insertOp(row)); c.setHoldings({ height: 30 });
  assert.ok((await run()).some(a => a.kind === 'bad_recipient' && a.severity === 'critical'));
});

test('policy changes and missing policies alert, and before arming native loss is critical', async t => {
  const one = setup(t);
  one.c.setPolicy({ owner, encrypted_data: 'changed', frozen: false, storage_deposit: '1' });
  assert.ok((await one.run()).some(a => a.kind === 'policy_changed' && a.severity === 'halt'));
  one.c.setPolicy(null);
  assert.ok((await one.run()).some(a => a.kind === 'policy_missing' && a.severity === 'critical'));
  const two = setup(t, 'registered');
  await two.run();
  two.c.setHoldings({ native: two.c.native - 1n, height: 11 });
  assert.ok((await two.run()).some(a => a.kind === 'native_outflow' && a.severity === 'critical'));
});

test('the first blind pass blocks new setup and strategy, including after restart; three passes alert once', async t => {
  const { c, run, worker, watch, job, d, path } = setup(t);
  await run();
  c.setReadable(false);
  assert.deepEqual(await run(), []);
  assert.equal(await advanceJob(d, job.id), 'running');
  assert.equal(worker.insertOp(opRow(job, { purpose: 'setup' })), false);
  await assert.rejects(createLiveOps({ ...d, jobId: job.id }).wrap(1n), { code: 'conflict' });
  assert.deepEqual(await run(), []);
  assert.deepEqual((await run()).map(a => [a.kind, a.severity]), [['blind', 'info']]);
  assert.deepEqual(await run(), []);
  assert.equal(watch.getWatch(job.id)?.block, 10);
  assert.equal(worker.openAlerts(job.id).filter(a => a.kind === 'blind').length, 1);
  worker.releaseWorkerLock();
  const restarted = openStore(path, 'worker');
  try {
    assert.ok(restarted.acquireWorkerLock(process.pid, testNow));
    assert.equal(restarted.insertOp(opRow(job)), false);
    assert.equal(restarted.insertOp(opRow({ ...job, id: 'another-job' })), false);
    watch.setMeta(`watch_blind:${job.id}`, 'broken');
    assert.equal(restarted.insertOp(opRow(job)), false);
    assert.equal(restarted.insertOp(opRow(job, { purpose: 'exit' })), true);
  } finally { restarted.close(); }
});

test('11 an unreadable receipt is a blind pass, not an outflow', async t => {
  const s = setup(t), { run, watch, worker, job } = s;
  await run();
  const readable = landedWrapUnreadable(s);
  assert.deepEqual(await run(), []);
  assert.deepEqual(worker.openAlerts(job.id).filter(a => a.severity !== 'info'), []);
  assert.equal(watch.getWatch(job.id)?.block, 10);
  assert.equal(watch.meta(`watch_blind:${job.id}`), '1');
  readable();
  assert.deepEqual(await run(), []);
  assert.deepEqual(worker.openAlerts(job.id).filter(a => a.severity !== 'info'), []);
  assert.equal(watch.getWatch(job.id)?.block, 30);
  assert.equal(watch.meta(`watch_blind:${job.id}`), '0');
});

test('11 three passes with unreadable receipts raise blind', async t => {
  const s = setup(t), { run, watch, job } = s;
  await run();
  landedWrapUnreadable(s);
  assert.deepEqual(await run(), []);
  assert.deepEqual(await run(), []);
  assert.deepEqual((await run()).map(a => [a.kind, a.severity]), [['blind', 'info']]);
  assert.equal(watch.getWatch(job.id)?.block, 10);
});

test('a receipt parser error halts verification and keeps the baseline', async t => {
  const s = setup(t), { c, run, watch, job } = s;
  await run();
  landedWrapUnreadable(s);
  c.rpc.txStatus = async () => ({});
  assert.ok((await run()).some(a => a.kind === 'verification_error' && a.severity === 'halt'));
  assert.equal(watch.getWatch(job.id)?.block, 10);
  assert.equal(watch.meta(`watch_blind:${job.id}`), '0');
});

test('same-block, older-block and live-submission deferrals preserve an existing blind wait', async t => {
  const s = setup(t), { c, run, watch, job } = s;
  await run();
  landedWrapUnreadable(s);
  await run();
  assert.equal(watch.meta(`watch_blind:${job.id}`), '1');
  // The baseline did not move, so a same-block pass is one at the baseline's own block.
  c.setHoldings({ height: 10 });
  assert.deepEqual(await run(), []);
  assert.equal(watch.meta(`watch_blind:${job.id}`), '1');
  c.setHoldings({ height: 9 });
  await run();
  assert.equal(watch.meta(`watch_blind:${job.id}`), '2');
  c.setHoldings({ height: 15 }); // The landed wrap in the journal is newer than this snapshot.
  await run();
  assert.equal(watch.meta(`watch_blind:${job.id}`), '2');
  const row = opRow(job, { purpose: 'exit' });
  assert.ok(s.worker.insertOp(row));
  c.setHoldings({ height: 30 });
  await run();
  assert.equal(watch.meta(`watch_blind:${job.id}`), '2');
  assert.equal(watch.getWatch(job.id)?.block, 10);
});

// ---------------------------------------------------------------------------------------------------------------------
// HALT REVIEW, re-check of fix round 2 (b4afa82). Paste at the end of test/watchdog.test.ts (it uses that file's setup).
// Both pass at b4afa82 and pin that M-1 and M-2 are scoped to trade jobs: a Grid, LP or Phase 1 job keeps master's
// behaviour until the operator rules. They fail on mutants R5 (240 s for every job) and R7 (denied never blocks).
// ---------------------------------------------------------------------------------------------------------------------
test('HALT R5: for a job that is not a trade job the watchdog skips a submitted operation for 60 s, not longer', async t => {
  for (const [age, alerts] of [[60_000, []], [61_000, ['native_outflow']]] as const) {
    const { c, run, worker, job } = setup(t);
    assert.equal(job.trade, false);
    await run();
    const wrap = 45n * N / 1000n, raw = fixture('tx-1.27-wrap'), gas = gasAccounting(parseTxStatus(raw), agent).burnt;
    assert.ok(worker.insertOp(opRow(job, { request: json({ receiver: WNEAR, method: 'near_deposit', args: {}, deposit: wrap.toString() }), txHash: c.addTx(raw), submittedAt: testNow - age })));
    c.setHoldings({ native: c.native - wrap - gas, wnear: c.wnear + wrap, height: 30 });
    assert.deepEqual((await run()).filter(a => a.severity !== 'info').map(a => a.kind), alerts, `submitted ${age} ms ago`);
  }
});

test('HALT R7: for a job that is not a trade job a denied row still keeps a read wait', async t => {
  const { c, run, worker, watch, job } = setup(t);
  await run();
  assert.ok(worker.insertOp(opRow(job, { state: 'finished', verdict: 'denied', finishedAt: testNow })));
  c.setReadable(false); await run(); c.setReadable(true);
  assert.equal(watch.watchWaiting(job.id), true);
  c.setHoldings({ height: 30 }); await run();
  c.setHoldings({ height: 40 }); await run();
  assert.equal(watch.watchWaiting(job.id), true, 'unchanged master behaviour: complete passes do not release this wait');
  assert.equal(watch.getWatch(job.id)?.block, 10, 'and the baseline does not move');
});

test('fix 4 F4-6: the watchdog skips for 240 s from a re-send start only while it waits or after an answer the worker proves', async t => {
  const pending = { kind: 'pending' } as const;
  const cases: [string, number | null, { kind: string } | null, string[], boolean?][] = [
    ['pending at 240 s', 240_000, pending, []],
    ['pending at 241 s', 241_000, pending, ['native_outflow']],
    ['answered accepted', 100_000, { kind: 'accepted' }, []],
    ['answered reverted', 100_000, { kind: 'reverted' }, []],
    ['answered with another lost reply (audit M-1)', 100_000, { kind: 'ambiguous' }, ['native_outflow']],
    ['answered wallet_frozen (audit M-1)', 100_000, { kind: 'denied' }, ['native_outflow']],
    ['no re-send, only the first answer', null, { kind: 'ambiguous' }, ['native_outflow']],
    ['nothing recorded', null, null, ['native_outflow']],
    ['pending with a stale worker heartbeat', 100_000, pending, ['native_outflow'], true],
    ['a re-send start in the future', -1_000, pending, ['native_outflow']],
  ];
  for (const [name, age, answer, alerts, staleWorker] of cases) {
    const { c, run, worker, job } = setup(t);
    await run();
    const wrap = 45n * N / 1000n, raw = fixture('tx-1.27-wrap'), gas = gasAccounting(parseTxStatus(raw), agent).burnt;
    const row = opRow(job, { state: 'ambiguous', request: json({ receiver: WNEAR, method: 'near_deposit', args: {}, deposit: wrap.toString() }), txHash: c.addTx(raw), submittedAt: testNow - 3_600_000 });
    assert.ok(worker.insertOp(row));
    if (age !== null) worker.noteResend(row.id, testNow - age);
    if (answer && answer.kind !== 'pending') worker.noteNoReply(row.id, { kind: answer.kind, reason: null, http: null }, testNow - (age ?? 3_590_000) + 10_000);
    if (staleWorker) worker.heartbeat('worker', testNow - 61_000);
    c.setHoldings({ native: c.native - wrap - gas, wnear: c.wnear + wrap, height: 30 });
    assert.deepEqual((await run()).filter(a => a.severity !== 'info').map(a => a.kind), alerts, name);
  }
});
