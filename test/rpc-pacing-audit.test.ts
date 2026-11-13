import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { RpcCoordinator, RpcGrant, RpcGroup } from '../src/core/rpc-pacing.js';
import { createNearRpc, DEFAULT_RPC, RpcUnavailable, type Fetcher } from '../src/core/near-rpc.js';
import { stores } from './helpers.js';

const group: RpcGroup = { key: '1'.repeat(64), spacing: 500 };
function isGrant(value: RpcGrant | number | null): value is RpcGrant { return typeof value === 'object' && value !== null; }

test('pacing audit: independent connections share spacing and capacity; wrong release cannot free a slot', t => {
  const db = stores(t), a = db.web.rpcCoordinator(), b = db.watch.rpcCoordinator(), c = db.worker.rpcCoordinator();
  let clock = 1000;
  const now = () => clock, ids = [randomUUID(), randomUUID(), randomUUID()];
  for (const [i, gate] of [a, b, c].entries()) assert.ok(gate.enqueue(group, ids[i], 30_000, false, now));
  // Watchdog preference only changes who receives the first slot, not its global spacing.
  assert.ok(isGrant(b.take(group, ids[1], 10_000, now)));
  assert.equal(typeof a.take(group, ids[0], 10_000, now), 'number');
  clock += 500;
  assert.ok(isGrant(a.take(group, ids[0], 10_000, now)));
  clock += 500;
  a.finish(group, randomUUID(), 0);
  assert.equal(typeof c.take(group, ids[2], 10_000, now), 'number');
  b.finish(group, ids[1], 0);
  assert.ok(isGrant(c.take(group, ids[2], 10_000, now)));
});

test('pacing audit: expired request deadline does not release a still-live HTTP lease', t => {
  const db = stores(t), gate = db.web.rpcCoordinator();
  let clock = 1000;
  const now = () => clock, first = randomUUID(), second = randomUUID(), third = randomUUID();
  assert.ok(gate.enqueue(group, first, 1500, false, now));
  assert.ok(isGrant(gate.take(group, first, 10_000, now)));
  clock = 1500;
  assert.ok(gate.enqueue(group, second, 2000, false, now));
  assert.ok(isGrant(gate.take(group, second, 10_000, now)));
  clock = 2000;
  assert.ok(gate.enqueue(group, third, 5000, false, now));
  assert.equal(typeof gate.take(group, third, 10_000, now), 'number');
  clock = 2500;
  assert.ok(isGrant(gate.take(group, third, 10_000, now)));
});

test('pacing audit: cooldown survives another connection and cannot be shortened by a late completion', t => {
  const db = stores(t), a = db.web.rpcCoordinator(), b = db.worker.rpcCoordinator();
  let clock = 1000;
  const now = () => clock, first = randomUUID(), second = randomUUID();
  assert.ok(a.enqueue(group, first, 30_000, false, now));
  assert.ok(isGrant(a.take(group, first, 10_000, now)));
  clock = 1500;
  assert.ok(b.enqueue(group, second, 30_000, false, now));
  assert.ok(isGrant(b.take(group, second, 10_000, now)));
  a.finish(group, first, 12_000);
  b.finish(group, second, 4000);
  clock = 5000;
  assert.equal(b.enqueue(group, randomUUID(), 30_000, true, now), false);
  clock = 12_000;
  const next = randomUUID();
  assert.ok(b.enqueue(group, next, 30_000, true, now));
  assert.ok(isGrant(b.take(group, next, 10_000, now)));
});

test('pacing audit: aged UI tickets precede new priority tickets and cancelled tickets never receive a grant', t => {
  const db = stores(t), web = db.web.rpcCoordinator(), watch = db.watch.rpcCoordinator();
  let clock = 1000;
  const now = () => clock, ui = randomUUID(), priority = randomUUID();
  assert.ok(web.enqueue(group, ui, 20_000, false, now));
  clock = 4001;
  assert.ok(watch.enqueue(group, priority, 20_000, false, now));
  assert.equal(typeof watch.take(group, priority, 10_000, now), 'number');
  assert.ok(isGrant(web.take(group, ui, 10_000, now)));
  watch.cancel(group, priority);
  clock = 5000;
  assert.equal(watch.take(group, priority, 10_000, now), null);
});

test('pacing audit: queued requests expire without consuming a start slot', t => {
  const db = stores(t), gate: RpcCoordinator = db.web.rpcCoordinator();
  let clock = 1000;
  const now = () => clock, expired = randomUUID(), next = randomUUID();
  assert.ok(gate.enqueue(group, expired, 2000, false, now));
  clock = 2000;
  assert.equal(gate.take(group, expired, 10_000, now), null);
  assert.ok(gate.enqueue(group, next, 30_000, false, now));
  assert.ok(isGrant(gate.take(group, next, 10_000, now)));
});

test('pacing audit: public read and archival clients honor the same cross-connection cooldown', async t => {
  const db = stores(t);
  let clock = 1000, calls = 0, limited = true;
  const now = () => clock, wait = async (ms: number) => { clock += ms; };
  const send: Fetcher = async () => {
    calls++;
    return limited ? { status: 429, text: '{"error":{"code":-429,"message":"Rate limits exceeded"}}' }
      : { status: 200, text: '{"result":{"checked":true}}' };
  };
  const a = createNearRpc(DEFAULT_RPC, send, wait, { now, coordinator: db.web.rpcCoordinator() });
  const b = createNearRpc(DEFAULT_RPC, send, wait, { now, coordinator: db.worker.rpcCoordinator() });
  await assert.rejects(a.query({ request_type: 'view_account', account_id: 'owner.near' }), RpcUnavailable);
  assert.equal(calls, 1);
  await assert.rejects(b.txStatus('dummy-hash', 'owner.near'), RpcUnavailable);
  await assert.rejects(b.query({ request_type: 'view_account', account_id: 'owner.near' }), RpcUnavailable);
  assert.equal(calls, 1);
  clock = 11_000;
  limited = false;
  assert.deepEqual(await b.txStatus('dummy-hash', 'owner.near'), { checked: true });
  assert.equal(calls, 2);
  // The first client's failed promise must not remain cached after the shared cooldown.
  assert.deepEqual(await a.query({ request_type: 'view_account', account_id: 'owner.near' }), { checked: true });
  assert.equal(calls, 3);
});

test('pacing audit: coalesced reads return independent values and later requests read again', async t => {
  const db = stores(t);
  let clock = 1000, calls = 0;
  let release!: () => void;
  const response = new Promise<void>(resolve => { release = resolve; });
  const rpc = createNearRpc(DEFAULT_RPC, async () => {
    calls++;
    await response;
    return { status: 200, text: '{"result":{"nested":{"value":1}}}' };
  }, async ms => { clock += ms; }, { now: () => clock, coordinator: db.web.rpcCoordinator() });
  const params = { request_type: 'view_account', account_id: 'owner.near', block_id: 'block-a' };
  const first = rpc.query(params), second = rpc.query(params);
  assert.equal(calls, 1);
  release();
  const [a, b] = await Promise.all([first, second]) as { nested: { value: number } }[];
  a.nested.value = 9;
  assert.equal(b.nested.value, 1);
  await rpc.query(params);
  assert.equal(calls, 2);
  await Promise.all([rpc.query(params), rpc.query({ ...params, block_id: 'block-b' })]);
  assert.equal(calls, 4);
});

test('pacing audit: an expired caller budget never reaches the HTTP fetcher', async t => {
  const db = stores(t);
  let calls = 0;
  const rpc = createNearRpc(DEFAULT_RPC, async () => {
    calls++;
    return { status: 200, text: '{"result":{}}' };
  }, async () => {}, { now: () => 1000, deadline: () => 999, coordinator: db.watch.rpcCoordinator() });
  await assert.rejects(rpc.query({ request_type: 'view_account', account_id: 'owner.near' }), RpcUnavailable);
  assert.equal(calls, 0);
});

test('pacing audit: invalid persisted coordinator state cannot fall back to an unpaced request', async t => {
  const db = stores(t), gate = db.web.rpcCoordinator();
  let clock = 1000, calls = 0;
  const rpc = createNearRpc(DEFAULT_RPC, async () => {
    calls++;
    return { status: 200, text: '{"result":{}}' };
  }, async ms => { clock += ms; }, { now: () => clock, coordinator: gate });
  await rpc.query({ request_type: 'view_account', account_id: 'owner.near' });
  const raw = new DatabaseSync(db.path);
  try { raw.prepare('UPDATE rpc_groups SET cooldown_until=?').run(9007199254740993n); }
  finally { raw.close(); }
  await assert.rejects(rpc.query({ request_type: 'view_account', account_id: 'owner.near' }), RpcUnavailable);
  assert.equal(calls, 1);
});
