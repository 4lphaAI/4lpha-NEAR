import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { readHoldings } from '../src/core/holdings.js';
import { createNearRpc, DEFAULT_RPC, RpcUnavailable, type Fetcher } from '../src/core/near-rpc.js';
import { USDC, WNEAR } from '../src/core/pins.js';
import { readChainPolicy } from '../src/core/policy.js';
import { DCL_POOL, DCL_STORAGE, readDcl } from '../src/core/rhea-dcl.js';
import { RPC_QUEUE_LIMIT, type RpcGroup } from '../src/core/rpc-pacing.js';
import { openStore } from '../src/core/store.js';
import { agent, owner, stores, testNow } from './helpers.js';

const publicGroup: RpcGroup = { key: createHash('sha256').update('public FastNEAR').digest('hex'), spacing: 500 };
const reply = (result: unknown) => ({ status: 200, text: JSON.stringify({ result }) });

test('SQLite scheduling coordinates with a contending child process', async t => {
  const { path, web } = stores(t), group = publicGroup, now = () => testNow;
  const script = `
    import { DatabaseSync } from 'node:sqlite';
    import { randomUUID } from 'node:crypto';
    import { openStore } from ${JSON.stringify(new URL('../src/core/store.js', import.meta.url).href)};
    const db = openStore(process.argv[1], 'meme'), lock = new DatabaseSync(process.argv[1]);
    const gate = db.rpcCoordinator(), g = ${JSON.stringify(group)}, now = () => ${testNow};
    const id = randomUUID();
    lock.exec('BEGIN IMMEDIATE');
    process.send('locked');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 125);
    lock.exec('COMMIT');
    gate.enqueue(g, id, now() + 30000, false, now);
    process.send(typeof gate.take(g, id, 10000, now));
    lock.close(); db.close(); process.disconnect();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, path], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  const closed = once(child, 'close');
  const messages: string[] = [];
  child.on('message', m => { if (typeof m === 'string') messages.push(m); });
  const [first] = await Promise.race([once(child, 'message'), closed]);
  assert.equal(first, 'locked');
  const gate = web.rpcCoordinator(), id = randomUUID();
  assert.ok(gate.enqueue(group, id, now() + 30_000, false, now));
  const outcome = typeof gate.take(group, id, 10_000, now);
  assert.deepEqual(await closed, [0, null]);
  assert.deepEqual([outcome, messages[1]].sort(), ['number', 'object']);
});

test('shared queue caps waiting tickets and prunes expired tickets before admitting later work', t => {
  const { web, watch } = stores(t);
  const a = web.rpcCoordinator(), b = watch.rpcCoordinator();
  let time = 1000;
  const now = () => time;
  for (let i = 0; i < RPC_QUEUE_LIMIT; i++) assert.ok(a.enqueue(publicGroup, randomUUID(), 2000, false, now));
  const fresh = randomUUID();
  assert.equal(b.enqueue(publicGroup, fresh, 3000, false, now), false);
  time = 2000;
  assert.ok(b.enqueue(publicGroup, fresh, 3000, false, now));
  assert.deepEqual(b.take(publicGroup, fresh, 10_000, now), { token: fresh, timeout: 1000 });
});

test('expired logical budgets cannot wait for the SQLite lock during cleanup', async t => {
  const { path, web } = stores(t), gate = web.rpcCoordinator(), at = testNow, now = () => at;
  const active = randomUUID(), waiting = randomUUID();
  assert.ok(gate.enqueue(publicGroup, active, at + 1000, false, now));
  assert.ok(gate.take(publicGroup, active, 1000, now));
  assert.ok(gate.enqueue(publicGroup, waiting, at + 1000, false, now));
  const script = `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('BEGIN IMMEDIATE');
    process.send('locked');
    setTimeout(() => process.exit(1), 3000).unref();
    process.once('message', () => { db.exec('COMMIT'); db.close(); process.disconnect(); });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, path], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  const closed = once(child, 'close');
  assert.equal((await Promise.race([once(child, 'message'), closed]))[0], 'locked');
  try {
    const start = performance.now();
    assert.throws(() => gate.cancel(publicGroup, waiting, 0), /locked/i);
    assert.throws(() => gate.finish(publicGroup, active, at + 10_000, 0), /locked/i);
    assert.ok(performance.now() - start < 1500);
  } finally {
    if (child.connected) child.send('unlock');
    await closed;
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) AS n FROM rpc_tickets').get()?.n, 2);
    assert.equal(db.prepare('SELECT cooldown_until FROM rpc_groups').get()?.cooldown_until, 0);
  } finally { db.close(); }
});

test('a queued ordinary read and a queued receipt expire with zero attempts', async t => {
  const { web, worker } = stores(t);
  let time = 1000, calls = 0;
  const now = () => time, wait = async (ms: number) => { time += ms; };
  const occupy = web.rpcCoordinator(), receipt = worker.rpcCoordinator();
  // Two active leases outlive each logical call's queue deadline.
  for (const start of [0, 500]) {
    time = 1000 + start;
    const id = randomUUID();
    assert.ok(occupy.enqueue(publicGroup, id, 40_000, false, now));
    assert.deepEqual(occupy.take(publicGroup, id, 30_000, now), { token: id, timeout: 30_000 });
  }
  const rpc = createNearRpc(DEFAULT_RPC, async () => { calls++; return reply({}); }, wait,
    { coordinator: receipt, now, deadline: () => 1800 });
  await assert.rejects(rpc.query({ request_type: 'view_account' }), RpcUnavailable);
  assert.equal(time, 1800);
  time = 1500;
  await assert.rejects(rpc.txStatus('dummy', owner), RpcUnavailable);
  assert.equal(time, 1800);
  assert.equal(calls, 0);
});

test('Retry-After delta/date, malformed and capped values control cross-client recovery', async t => {
  const cases = [
    { status: 429, header: '2', span: 2000, body: '' },
    { status: 200, header: new Date(testNow + 3000).toUTCString(), span: 3000, body: '{"error":{"code":-429}}' },
    { status: 429, header: 'invalid', span: 10_000, body: '' },
    { status: 429, header: '99999', span: 3_600_000, body: '' },
    { status: 503, header: '13', span: 13_000, body: '' },
  ];
  for (const row of cases) await t.test(`HTTP ${row.status}, wait ${row.span} ms`, async st => {
    const { path, web, worker } = stores(st);
    let time = testNow, attempts = 0;
    const now = () => time, wait = async (ms: number) => { time += ms; };
    const send: Fetcher = async () => ++attempts === 1 ? { status: row.status, text: row.body, retryAfter: row.header } : reply({ recovered: true });
    const a = createNearRpc(DEFAULT_RPC, send, wait, { coordinator: web.rpcCoordinator(), now });
    const b = createNearRpc(DEFAULT_RPC, send, wait, { coordinator: worker.rpcCoordinator(), now });
    await assert.rejects(a.finalBlock!(), RpcUnavailable);
    time += row.span - 1;
    await assert.rejects(b.txStatus('dummy', owner), RpcUnavailable);
    assert.equal(attempts, 1);
    time++;
    assert.deepEqual(await b.txStatus('dummy', owner), { recovered: true });
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.deepEqual(db.prepare('SELECT id FROM rpc_groups').all().map(r => r.id), [publicGroup.key]);
      assert.equal(db.prepare('SELECT count(*) AS n FROM rpc_tickets').get()?.n, 0);
    } finally { db.close(); }
  });
});

test('an explicit archival override remains authoritative when it names the throttled primary', async () => {
  const endpoint = 'https://primary.invalid', starts: string[] = [];
  const rpc = createNearRpc({ read: [endpoint, DEFAULT_RPC.read[0]], archival: endpoint, archivalOverride: true, auth: { origin: endpoint, token: 'dummy' } },
    async url => { starts.push(url); return { status: 429, text: '' }; }, undefined, { now: () => testNow });
  await assert.rejects(rpc.txStatus('dummy', owner), RpcUnavailable);
  assert.deepEqual(starts, [endpoint]);
});

test('Web, Worker, Watchdog and Meme finish block-pinned views under the shared provider cap', async t => {
  const { web, worker, watch, path } = stores(t), meme = openStore(path, 'meme');
  let time = testNow, active = 0, max = 0;
  const now = () => time, starts: number[] = [];
  const timers: { at: number; wake: () => void }[] = [];
  const wait = (ms: number) => new Promise<void>(wake => { timers.push({ at: now() + ms, wake }); });
  const bytes = (value: unknown) => [...Buffer.from(JSON.stringify(value))];
  const block = { block_height: 100, block_hash: 'block-pinned' };
  const policy = { owner, frozen: false, encrypted_data: 'dummy', storage_deposit: '1' };
  const views: Record<string, unknown> = {
    get_wallet_policy: policy, ft_balance_of: '0', get_metadata: { version: '2.4.2', state: 'Running' },
    get_pool: { pool_id: DCL_POOL, token_x: USDC, token_y: WNEAR, fee: 100, point_delta: 1, state: 'Running', current_point: 401_000 },
    storage_balance_bounds: { min: String(DCL_STORAGE), max: null }, get_user_storage_detail: null,
    list_active_orders: [], list_history_orders: [], list_user_assets: {}, list_lostfound: {}, list_liquidities: [],
  };
  let rejected = 0;
  const provider: Fetcher = async (_url, body) => {
    const last = starts.at(-1);
    starts.push(now());
    if (active === 2 || (last !== undefined && now() - last < 500)) { rejected++; return { status: 429, text: '' }; }
    max = Math.max(max, ++active);
    await wait(575);
    active--;
    const request = JSON.parse(body) as { method: string; params: { request_type: string; method_name: string; block_id?: string; finality?: string } };
    if (request.method === 'block') {
      assert.equal(request.params.finality, 'final');
      return reply({ header: { height: block.block_height, hash: block.block_hash } });
    }
    assert.equal(request.params.block_id, block.block_hash);
    return request.params.request_type === 'view_account' ? reply({ ...block, amount: '2000000000000000000000000', locked: '0', storage_usage: 182 })
      : reply({ ...block, result: bytes(views[request.params.method_name]) });
  };
  try {
    const tasks = [web, worker, watch, meme].map(async store => {
      const rpc = createNearRpc(DEFAULT_RPC, provider, wait, { now, coordinator: store.rpcCoordinator() });
      const holdings = await readHoldings(rpc, agent, [WNEAR, USDC]);
      const [dcl, p] = await Promise.all([readDcl(rpc, agent, holdings), readChainPolicy(rpc, `ed25519:${agent}`, holdings)]);
      assert.equal(holdings.block, block.block_height);
      assert.equal(dcl.point, 401_000);
      assert.equal(p.entry?.owner, owner);
      return now() - testNow;
    });
    let done = false;
    const result = Promise.allSettled(tasks).then(results => { done = true; return results; });
    for (let i = 0; !done && i < 1000; i++) {
      await new Promise<void>(resolve => setImmediate(resolve));
      if (done) break;
      assert.ok(timers.length, 'pending reads have no wake-up');
      time = Math.min(...timers.map(timer => timer.at));
      for (const timer of timers.filter(timer => timer.at === time)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.wake();
      }
    }
    assert.equal(done, true);
    for (const outcome of await result) {
      if (outcome.status === 'rejected') throw outcome.reason;
      assert.ok(outcome.value < 30_000);
    }
    assert.equal(rejected, 0);
    assert.equal(max, 2);
    assert.equal(starts.length, 56);
  } finally { meme.close(); }
});
