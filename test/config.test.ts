import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dRpcFirst, freeFirst, localEnv, rpcEnv, rpcLabel } from '../src/core/config.js';
import { CoreError } from '../src/core/errors.js';
import { createNearRpc, DEFAULT_RPC, DRPC_READ, httpFetcher } from '../src/core/near-rpc.js';

const origin = 'https://h0st5ecret.near-mainnet.quiknode.pro', token = 'tok3n-value';
const local = { Near_RPC: origin, Auth_Token: token };
const urls = { FOURLPHA_RPC_URLS: 'https://a.test, https://b.test' };

test('RPC QuickNode from the local file sets all endpoints and the token', () => {
  assert.deepEqual(rpcEnv({}, { Near_RPC: `${origin}/`, Auth_Token: token }), { read: [origin, DEFAULT_RPC.read[0], DRPC_READ], archival: origin, auth: { origin, token } });
});

test('RPC FOURLPHA_RPC_URLS wins and carries no token', () => {
  const expected = { read: ['https://a.test', 'https://b.test'], archival: DEFAULT_RPC.archival };
  assert.deepEqual(rpcEnv(urls, local), expected);
  assert.deepEqual(rpcEnv(urls, { Near_RPC: 'broken', Auth_Token: '' }), expected);
  assert.throws(() => rpcEnv({ FOURLPHA_RPC_URLS: '' }, local), /exactly two/);
});

test('RPC an archival override keeps QuickNode reads and never gets the token', () => {
  const e = rpcEnv({ FOURLPHA_ARCHIVAL_RPC_URL: 'https://archive.test' }, local);
  assert.deepEqual(e, { read: [origin, DEFAULT_RPC.read[0], DRPC_READ], archival: 'https://archive.test', archivalOverride: true, auth: { origin, token } });
  assert.notEqual(e.archival, e.auth?.origin);
  assert.equal(rpcEnv({ ...urls, FOURLPHA_ARCHIVAL_RPC_URL: 'https://archive.test' }, local).archival, 'https://archive.test');
});

test('RPC with no settings stays on the public endpoints with no token', () => {
  assert.deepEqual(rpcEnv({}, {}), { read: [...DEFAULT_RPC.read, DRPC_READ], archival: DEFAULT_RPC.archival });
});

test('RPC a broken local file refuses and leaks no value', () => {
  const secret = 'h0st5ecret';
  const broken: Record<string, string | undefined>[] = [
    { Near_RPC: `not a url ${secret}`, Auth_Token: token },
    { Near_RPC: '', Auth_Token: token },
    { Near_RPC: `http://${secret}.near-mainnet.quiknode.pro`, Auth_Token: token },
    { Near_RPC: `https://${secret}.example.test`, Auth_Token: token },
    { Near_RPC: `https://${secret}.near-mainnet.quiknode.pro.example.test`, Auth_Token: token },
    { Near_RPC: 'https://near-mainnet.quiknode.pro', Auth_Token: token },
    { Near_RPC: `https://${secret}@x.near-mainnet.quiknode.pro`, Auth_Token: token },
    { Near_RPC: `https://x:${secret}@x.near-mainnet.quiknode.pro`, Auth_Token: token },
    { Near_RPC: `https://x.near-mainnet.quiknode.pro/${secret}`, Auth_Token: token },
    { Near_RPC: `https://x.near-mainnet.quiknode.pro/?k=${secret}`, Auth_Token: token },
    { Near_RPC: `https://x.near-mainnet.quiknode.pro/#${secret}`, Auth_Token: token },
    { Near_RPC: origin, Auth_Token: '' },
    { Near_RPC: origin },
    { Near_RPC: origin, Auth_Token: `${token} x` },
    { Near_RPC: origin, Auth_Token: `${token}\tx` },
  ];
  for (const file of broken) {
    assert.throws(() => rpcEnv({}, file), e => e instanceof CoreError && e.code === 'bad_request' && !e.message.includes(secret) && !e.message.includes(token), JSON.stringify(file));
  }
});

test('RPC localEnv reads a file and returns empty when it is missing', t => {
  const dir = mkdtempSync(join(tmpdir(), '4lpha-near-test-')), file = join(dir, 'settings');
  t.after(() => rmSync(dir, { recursive: true }));
  writeFileSync(file, `Near_RPC=${origin}\nAuth_Token=${token}\n`);
  assert.deepEqual(localEnv(file), local);
  assert.deepEqual(localEnv(join(dir, 'missing')), {});
  assert.throws(() => localEnv(dir), e => e instanceof CoreError && e.code === 'bad_request' && !e.message.includes(dir));
});

test('RPC the token goes only to its origin, only in the header', async t => {
  const calls: { url: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return new Response(JSON.stringify({ result: { header: { height: 1, hash: 'h' } } }), { headers: { 'Retry-After': '2' } });
  });
  const auth = { origin, token }, body = '{"id":"test"}';
  assert.equal((await httpFetcher(auth)(origin, body, 1_000)).retryAfter, '2');
  await httpFetcher(auth)('https://other.test', body, 1_000);
  await httpFetcher(auth)(DRPC_READ, body, 1_000);
  await httpFetcher()(origin, body, 1_000);
  const rpc = createNearRpc(rpcEnv({ FOURLPHA_ARCHIVAL_RPC_URL: 'https://archive.test' }, local));
  await rpc.finalBlock!();
  await rpc.txStatus('tx-test', 'owner.near');
  const sent = calls.map(c => ({ url: c.url, token: (c.init.headers as Record<string, string>)['x-token'] }));
  assert.deepEqual(sent, [{ url: origin, token }, { url: 'https://other.test', token: undefined }, { url: DRPC_READ, token: undefined }, { url: origin, token: undefined },
    { url: origin, token }, { url: 'https://archive.test', token: undefined }]);
  for (const c of calls) {
    assert.equal(c.init.redirect, 'error');
    assert.ok(!c.url.includes(token)); assert.ok(!String(c.init.body).includes(token));
  }
});

test('RPC label', () => {
  assert.equal(rpcLabel(rpcEnv({}, local)), 'QuickNode');
  assert.equal(rpcLabel(rpcEnv({}, {})), 'public FastNEAR');
  assert.equal(rpcLabel(rpcEnv(urls, local)), 'custom');
});

test('the watchdog and web endpoints read dRPC first, then QuickNode and FastNEAR; receipts and a setup without QuickNode are unchanged', () => {
  const origin = 'https://example.near-mainnet.quiknode.pro', token = 'test-token';
  const quick = rpcEnv({}, { Near_RPC: `${origin}/`, Auth_Token: token }), first = dRpcFirst(quick);
  assert.deepEqual(first, { read: [DRPC_READ, origin, DEFAULT_RPC.read[0]], archival: origin, auth: { origin, token } });
  assert.equal(rpcLabel(first), 'dRPC first, QuickNode fallback');
  assert.equal(rpcLabel(quick), 'QuickNode');
  const plain = rpcEnv({}, {});
  assert.equal(dRpcFirst(plain), plain);
});

test('the worker idle client reads dRPC, then FastNEAR, then QuickNode; a setup without QuickNode is unchanged', () => {
  const origin = 'https://example.near-mainnet.quiknode.pro', token = 'test-token';
  const quick = rpcEnv({}, { Near_RPC: `${origin}/`, Auth_Token: token });
  assert.deepEqual(freeFirst(quick), { read: [DRPC_READ, DEFAULT_RPC.read[0], origin], archival: origin, auth: { origin, token } });
  const plain = rpcEnv({}, {});
  assert.equal(freeFirst(plain), plain);
});
