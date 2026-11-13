import test from 'node:test';
import assert from 'node:assert/strict';
import { RpcUnavailable } from '../src/core/near-rpc.js';
import { watchOnce } from '../src/core/watchdog.js';
import { json, RPC_UNAVAILABLE_REASON } from '../src/core/store.js';
import { WNEAR } from '../src/core/pins.js';
import { gasAccounting, parseTxStatus } from '../src/core/receipts.js';
import { YOCTO_PER_NEAR as N } from '../src/core/amounts.js';
import { agent, fixture, stores, testNow } from './helpers.js';
import { armedJob, chain, opRow } from './chain.js';

function setup(t: Parameters<typeof stores>[0], state: 'running' | 'registered' = 'running') {
  const db = stores(t), { job } = armedJob(db.web, db.worker, state), c = chain();
  let now = testNow + 1;
  if (state === 'registered') c.setPolicy(null);
  return { ...db, job, c, run: () => watchOnce({ store: db.watch, rpc: c.rpc, now: () => now++ }) };
}

test('audit: a pre-arm RPC outage recovers without watchdog changing job state or identity', async t => {
  const h = setup(t, 'registered');
  const before = h.worker.getJob(h.job.id);
  h.c.setReadable(false);
  await h.run();
  assert.equal(h.worker.countPolicyOp(h.job, 'encrypt_policy', testNow + 10), false);
  h.c.setReadable(true);
  h.c.setHoldings({ height: 11 });
  await h.run();
  assert.equal(h.watch.watchWaiting(h.job.id), false);
  assert.deepEqual(h.worker.getJob(h.job.id), before);
  assert.equal(h.worker.countPolicyOp(h.job, 'encrypt_policy', testNow + 11), true);
});

test('audit: a receipt extending above the snapshot cannot clear a wait using a lower journal block', async t => {
  const h = setup(t);
  await h.run();
  const raw = fixture('tx-1.27-wrap'), wrap = 45n * N / 1000n;
  const gas = gasAccounting(parseTxStatus(raw), agent).burnt;
  const hash = h.c.addTx(raw, 29);
  assert.ok(h.worker.insertOp(opRow(h.job, { state: 'finished', verdict: 'success', finishedBlock: 20, txHash: hash,
    request: json({ receiver: WNEAR, method: 'near_deposit', args: {}, deposit: wrap.toString() }) })));
  h.c.setHoldings({ native: h.c.native - wrap - gas, wnear: h.c.wnear + wrap, height: 30 });
  await h.run();
  assert.equal(h.watch.watchWaiting(h.job.id), true);
  assert.equal(h.watch.getWatch(h.job.id)?.block, 10);
  assert.equal(h.watch.meta(`watch_clean:${h.job.id}`), null);
  h.c.setHoldings({ height: 100 });
  await h.run();
  assert.equal(h.watch.watchWaiting(h.job.id), false);
  assert.equal(h.watch.getWatch(h.job.id)?.block, 100);
});

test('audit: journal mutation during a complete read preserves the outage baseline until rechecked', async t => {
  const h = setup(t);
  await h.run();
  const row = opRow(h.job, { state: 'ambiguous', kind: 'storage', purpose: 'setup' });
  assert.ok(h.worker.insertOp(row));
  h.c.setReadable(false);
  await h.run();
  h.c.setReadable(true);
  h.c.setHoldings({ height: 11 });
  const original = h.c.rpc.view;
  h.c.rpc.view = async (...args) => {
    if (args[1] === 'get_wallet_policy') assert.ok(h.worker.updateOp(row.id, { state: 'finished', verdict: 'success', message: 'Registration reconciled.' }));
    return original(...args);
  };
  await h.run();
  assert.equal(h.watch.watchWaiting(h.job.id), true);
  assert.equal(h.watch.getWatch(h.job.id)?.block, 10);
  assert.equal(h.watch.meta(`watch_clean:${h.job.id}`), null);
  h.c.rpc.view = original;
  h.c.setHoldings({ height: 12 });
  await h.run();
  assert.equal(h.watch.watchWaiting(h.job.id), false);
  assert.equal(h.watch.getWatch(h.job.id)?.block, 12);
});

test('audit: a money alert arriving during successful reads cannot be covered by a clean proof', async t => {
  const h = setup(t);
  await h.run();
  h.c.setReadable(false);
  await h.run();
  h.c.setReadable(true);
  h.c.setHoldings({ height: 11 });
  const original = h.c.rpc.view;
  h.c.rpc.view = async (...args) => {
    if (args[1] === 'get_wallet_policy') h.worker.insertAlert({ jobId: h.job.id, kind: 'token_outflow', severity: 'halt',
      detail: { message: 'Concurrent money alert.' }, createdAt: testNow + 1 });
    return original(...args);
  };
  await h.run();
  assert.equal(h.watch.watchWaiting(h.job.id), true);
  assert.equal(h.watch.getWatch(h.job.id)?.block, 10);
  assert.equal(h.watch.meta(`watch_clean:${h.job.id}`), null);
  assert.equal(h.worker.openAlerts(h.job.id).filter(a => a.severity === 'halt').length, 1);
});

test('audit: watchdog verification cannot mutate a worker-owned waiting reason', async t => {
  const h = setup(t);
  assert.ok(h.worker.casJob(h.job.id, 'running', h.job.version, 'running', { reason: RPC_UNAVAILABLE_REASON }, testNow));
  const before = h.worker.getJob(h.job.id);
  await h.run();
  assert.deepEqual(h.worker.getJob(h.job.id), before);
});

test('audit: an unexpected exception is a persistent halt rather than a transient read wait', async t => {
  const h = setup(t);
  await h.run();
  h.c.rpc.finalBlock = async () => { throw new Error('Diagnostic text must not escape.'); };
  await h.run();
  const alerts = h.watch.openAlerts(h.job.id);
  assert.ok(alerts.some(a => a.kind === 'verification_error' && a.severity === 'halt'));
  assert.ok(!json(alerts).includes('Diagnostic text'));
  assert.equal(h.watch.meta(`watch_clean:${h.job.id}`), null);
  h.c.rpc.finalBlock = async () => { throw new RpcUnavailable(); };
  await h.run();
  assert.ok(h.watch.openAlerts(h.job.id).some(a => a.kind === 'verification_error' && a.severity === 'halt'));
});
