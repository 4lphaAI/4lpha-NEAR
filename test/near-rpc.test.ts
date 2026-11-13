import test from 'node:test';
import assert from 'node:assert/strict';
import { createNearRpc, DEFAULT_RPC, DRPC_READ, RpcUnavailable, spendableNear } from '../src/core/near-rpc.js';
import { rpcEnv } from '../src/core/config.js';
import { fixture } from './helpers.js';

const ep = { read: ['https://rpc1.test', 'https://rpc2.test'] as const, archival: 'https://archive.test' };
const answer = (r: unknown) => ({ status: 200, text: JSON.stringify(r) });
const res = (result: unknown) => answer({ result });
const unknownTx = answer({ error: { cause: { name: 'UNKNOWN_TRANSACTION' } } });
const quick = { read: [ep.read[0], DEFAULT_RPC.read[0]] as const, archival: ep.read[0], auth: { origin: ep.read[0], token: 'test-only' } };
function fakeClock(start = 1000) {
  let time = start;
  const waits: number[] = [];
  return { now: () => time, wait: async (ms: number) => { waits.push(ms); time += ms; }, advance: (ms: number) => { time += ms; }, waits };
}

test('configured reads retain QuickNode and FastNEAR, then use dRPC and return to QuickNode after recovery', async () => {
  const clock = fakeClock(), urls: string[] = [];
  const endpoints = rpcEnv({}, { Near_RPC: 'https://dummy.near-mainnet.quiknode.pro', Auth_Token: 'dummy' });
  let recovered = false;
  const rpc = createNearRpc(endpoints, async (url, body) => {
    urls.push(url);
    assert.equal(JSON.parse(body).params.finality, 'final');
    if (url === endpoints.auth!.origin && !recovered) return answer({ error: { code: -32003, message: 'daily request limit reached' } });
    if (url === DEFAULT_RPC.read[0]) return { status: 429, text: '' };
    return res({ header: { height: 10, hash: 'final-block' } });
  }, clock.wait, clock);
  assert.deepEqual(await rpc.finalBlock!(), { height: 10, id: 'final-block' });
  assert.deepEqual(urls, [endpoints.auth!.origin, DEFAULT_RPC.read[0], DRPC_READ]);
  urls.length = 0;
  await rpc.finalBlock!();
  assert.deepEqual(urls, [DRPC_READ]);
  clock.advance(3_600_001); recovered = true; urls.length = 0;
  await rpc.finalBlock!();
  assert.deepEqual(urls, [endpoints.auth!.origin]);
});

test('dRPC is read-only fallback: mismatched blocks fail and archival never falls through to it', async () => {
  const clock = fakeClock(), urls: string[] = [];
  const endpoints = { ...quick, read: [...quick.read, DRPC_READ] as const };
  const rpc = createNearRpc(endpoints, async (url, body) => {
    urls.push(url);
    if (url !== DRPC_READ) return { status: 429, text: '' };
    assert.equal(JSON.parse(body).params.block_id, 'pinned');
    return res({ block_height: 10, block_hash: 'wrong-block', result: [...Buffer.from('0')] });
  }, clock.wait, clock);
  await assert.rejects(rpc.view('wrap.near', 'ft_balance_of', {}, 'pinned'), RpcUnavailable);
  assert.deepEqual(urls, [quick.auth.origin, DEFAULT_RPC.read[0], DRPC_READ]);
  urls.length = 0;
  await assert.rejects(rpc.txStatus('hash', 'owner.near'), RpcUnavailable);
  assert.deepEqual(urls, []);
  clock.advance(10_001);
  await assert.rejects(rpc.blockHeight!('old-block'), RpcUnavailable);
  assert.deepEqual(urls, [DEFAULT_RPC.archival]);
});

test('all three unavailable read providers fail within the existing attempt bound', async () => {
  const clock = fakeClock(), urls: string[] = [];
  const rpc = createNearRpc({ ...quick, read: [...quick.read, DRPC_READ] }, async url => {
    urls.push(url); return { status: 429, text: '' };
  }, clock.wait, clock);
  await assert.rejects(rpc.finalBlock!(), RpcUnavailable);
  assert.deepEqual(urls, [quick.auth.origin, DEFAULT_RPC.read[0], DRPC_READ]);
});

test('QuickNode throttling skips the primary across reads and receipts until cooldown expires', async () => {
  const clock = fakeClock();
  const urls: string[] = [];
  const rpc = createNearRpc(quick, async (url, body) => {
    urls.push(url);
    if (url === quick.auth.origin) return { status: 429, text: '' };
    const request = JSON.parse(body);
    if (request.method === 'EXPERIMENTAL_tx_status') {
      assert.equal(request.params.wait_until, 'FINAL');
      return res({ final_execution_status: 'FINAL' });
    }
    assert.equal(request.params.finality, 'final');
    return res({ amount: '2000', locked: '0', storage_usage: 182 });
  }, clock.wait, clock);
  assert.equal((await rpc.viewAccount('owner.near'))?.amount, 2000n);
  await rpc.viewAccount('owner.near');
  await rpc.txStatus('hash', 'owner.near');
  assert.deepEqual(urls, [quick.auth.origin, DEFAULT_RPC.read[0], DEFAULT_RPC.read[0], DEFAULT_RPC.archival]);
  clock.advance(60_001);
  await rpc.viewAccount('owner.near');
  assert.deepEqual(urls.slice(-2), [quick.auth.origin, DEFAULT_RPC.read[0]]);
});

test('QuickNode network failure and daily quota fall back without accepting another block', async () => {
  const clock = fakeClock();
  for (const daily of [false, true]) {
    const urls: string[] = [];
    const rpc = createNearRpc(quick, async (url, body) => {
      urls.push(url);
      if (url === quick.auth.origin) {
        if (daily) return answer({ error: { code: -32003, message: 'daily request limit reached' } });
        throw new Error('network');
      }
      assert.equal(JSON.parse(body).params.block_id, 'pinned');
      return res({ block_height: 1, block_hash: 'different', result: [...Buffer.from('0')] });
    }, clock.wait, clock);
    await assert.rejects(rpc.view('wrap.near', 'ft_balance_of', {}, 'pinned'), RpcUnavailable);
    assert.deepEqual(urls, [quick.auth.origin, DEFAULT_RPC.read[0]]);
    if (daily) {
      clock.advance(60_001);
      await assert.rejects(rpc.view('wrap.near', 'ft_balance_of', {}, 'pinned'), RpcUnavailable);
      assert.equal(urls.at(-1), DEFAULT_RPC.read[0]);
    }
  }
});

test('QuickNode fallback failures remain bounded and custom archival stays authoritative', async () => {
  const clock = fakeClock();
  const urls: string[] = [];
  const rpc = createNearRpc({ ...quick, archival: ep.archival }, async url => {
    urls.push(url); return { status: 429, text: '' };
  }, clock.wait, clock);
  await assert.rejects(rpc.viewAccount('owner.near'), RpcUnavailable);
  assert.deepEqual(urls, [quick.auth.origin, DEFAULT_RPC.read[0]]);
  urls.length = 0;
  await assert.rejects(rpc.txStatus('hash', 'owner.near'), RpcUnavailable);
  assert.deepEqual(urls, [ep.archival]);
});

test('QuickNode receipt timeout leaves time for archival fallback', async () => {
  const clock = fakeClock();
  const urls: string[] = [];
  const rpc = createNearRpc(quick, async (url, _body, timeout) => {
    urls.push(url);
    if (url === quick.auth.origin) {
      assert.equal(timeout, 10_000); clock.advance(timeout); throw new Error('timeout');
    }
    assert.ok(timeout > 0 && timeout <= 20_000);
    return res({ final_execution_status: 'FINAL' });
  }, clock.wait, clock);
  assert.deepEqual(await rpc.txStatus('hash', 'owner.near'), { final_execution_status: 'FINAL' });
  assert.deepEqual(urls, [quick.auth.origin, DEFAULT_RPC.archival]);
});

test('1.27 JSON-RPC error without cause retries on the other read endpoint', async () => {
  const urls: string[] = [];
  const rpc = createNearRpc(ep, async (url, body) => {
    urls.push(url); assert.equal(JSON.parse(body).params.finality, 'final');
    return urls.length === 1 ? answer(fixture('rpc-error-no-cause')) : res({ amount: '2000', locked: '0', storage_usage: 182 });
  });
  assert.equal((await rpc.viewAccount('owner.near'))?.amount, 2000n);
  assert.deepEqual(urls, ep.read);
});
test('F-8 reads alternate at most four times then return unavailable', async () => {
  const clock = fakeClock();
  const urls: string[] = [];
  const rpc = createNearRpc(ep, async url => { urls.push(url); return answer({ error: { code: -32000, message: 'retryable' } }); }, clock.wait, clock);
  await assert.rejects(rpc.viewAccount('owner.near'), RpcUnavailable);
  assert.deepEqual(urls, [...ep.read, ...ep.read]);
});
test('definitive UNKNOWN_ACCOUNT does not retry', async () => {
  let tries = 0;
  const rpc = createNearRpc(ep, async () => { tries++; return answer(fixture('rpc-unknown-account')); });
  assert.equal(await rpc.viewAccount('owner.near'), null);
  assert.equal(tries, 1);
});
test('UNKNOWN_TRANSACTION is retried on archival with FINAL', async () => {
  let tries = 0;
  const rpc = createNearRpc(ep, async (url, body) => {
    assert.equal(url, ep.archival); assert.equal(JSON.parse(body).params.wait_until, 'FINAL');
    return ++tries === 1 ? answer({ error: { cause: { name: 'UNKNOWN_TRANSACTION' } } }) : res({ final_execution_status: 'FINAL' });
  });
  assert.deepEqual(await rpc.txStatus('tx-test', 'owner.near'), { final_execution_status: 'FINAL' });
});
test('concurrent hold quotes share each read and use the higher protocol price', async () => {
  let calls = 0;
  const clock = fakeClock();
  const rpc = createNearRpc(ep, async (_url, body) => {
    calls++;
    return res(JSON.parse(body).method === 'gas_price' ? { gas_price: '100000000' } : { min_gas_price: '1000000000' });
  }, clock.wait, clock);
  assert.deepEqual(await Promise.all(Array.from({ length: 7 }, () => rpc.holdGasPrice())), Array(7).fill(1000000000n));
  assert.equal(calls, 2);
  assert.equal(spendableNear({ amount: 395587000000000000000000n, locked: 0n, storageUsage: 182 }, 10000000000000000000000n), 383767000000000000000000n);
  assert.equal(spendableNear({ amount: 100n, locked: 0n, storageUsage: 182 }, 0n), 0n);
});
test('M-6 UNKNOWN_TRANSACTION keeps retrying past four attempts', async () => {
  const urls: string[] = [], clock = fakeClock();
  const rpc = createNearRpc(ep, async url => { urls.push(url); return urls.length <= 5 ? unknownTx : res({ final_execution_status: 'FINAL' }); }, clock.wait, clock);
  assert.deepEqual(await rpc.txStatus('tx-test', 'owner.near'), { final_execution_status: 'FINAL' });
  assert.deepEqual(urls, Array(6).fill(ep.archival));
  assert.deepEqual(clock.waits, [250, 500, 1000, 2000, 2000]);
});
test('M-6 txStatus gives up at the deadline', async () => {
  const clock = fakeClock();
  let tries = 0;
  const rpc = createNearRpc(ep, async (_url, _body, ms) => {
    tries++;
    assert.ok(clock.now() < 31_000 && ms <= 31_000 - clock.now());
    return unknownTx;
  }, clock.wait, clock);
  await assert.rejects(rpc.txStatus('tx-test', 'owner.near'), RpcUnavailable);
  assert.ok(tries > 4);
  assert.equal(clock.now(), 31_000);
});
test('M-6 a throttled archive receives no identical retries even after UNKNOWN_TRANSACTION', async () => {
  const clock = fakeClock();
  let tries = 0;
  const limited = { status: 429, text: '' };
  await assert.rejects(createNearRpc(ep, async () => { tries++; return limited; }, clock.wait, clock).txStatus('tx-test', 'owner.near'), RpcUnavailable);
  assert.equal(tries, 1);
  tries = 0;
  await assert.rejects(createNearRpc(ep, async () => ++tries === 1 ? unknownTx : limited, clock.wait, clock).txStatus('tx-test', 'owner.near'), RpcUnavailable);
  assert.equal(tries, 2);
});
test('M-6 a non-txStatus read answering UNKNOWN_TRANSACTION still stops at four attempts', async () => {
  let tries = 0;
  const clock = fakeClock();
  // The guard turns a lost attempt bound into a failed count instead of a hung suite.
  const rpc = createNearRpc(ep, async () => { if (++tries > 50) throw new Error('runaway'); return unknownTx; }, clock.wait, clock);
  await assert.rejects(rpc.viewAccount('owner.near'), RpcUnavailable);
  assert.equal(tries, 4);
  assert.deepEqual(clock.waits, [250, 500, 1000]);
});
test('M-6 a node timeout answer stays inside the deadline and cools the archive', async () => {
  const start = 1_000;
  const clock = fakeClock(start);
  let tries = 0;
  const rpc = createNearRpc(ep, async (_url, _body, ms) => {
    tries++; assert.ok(clock.now() < start + 30_000); assert.ok(ms <= start + 30_000 - clock.now());
    clock.advance(10_400);
    return { status: 408, text: JSON.stringify({ error: { cause: { name: 'TIMEOUT_ERROR' } } }) };
  }, clock.wait, clock);
  await assert.rejects(rpc.txStatus('tx-test', 'owner.near'), RpcUnavailable);
  assert.equal(tries, 1);
});
