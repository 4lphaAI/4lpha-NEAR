import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHAIN_CACHE_MS, createHandler, PUBLIC_CACHE_MS, PUBLIC_OVERRIDES, TERMINAL_CACHE_MS } from '../src/web/server.js';
import { tradeSettingsFromRequest, type TradeSettings } from '../src/core/trade-settings.js';
import { YOCTO_PER_NEAR as N } from '../src/core/amounts.js';
import { newChallenge, tokenHash, type Challenge } from '../src/core/auth.js';
import { processReveals, setJob } from '../src/core/hire.js';
import { RpcUnavailable, type NearRpc } from '../src/core/near-rpc.js';
import { DCL, USDC, WNEAR } from '../src/core/pins.js';
import { DCL_POOL, DCL_STORAGE } from '../src/core/rhea-dcl.js';
import { WALLET_ALERT_HALT, type OpRow } from '../src/core/store.js';
import { watchOnce } from '../src/core/watchdog.js';
import { seal, SecretString, walletAad } from '../src/core/secrets.js';
import { agent, dummyOutLayer, dummyRpc, fullAccess, identity, owner, stores, testNow } from './helpers.js';
import { armedJob, chain, opRow } from './chain.js';

const origin = 'https://app.test';
const sign = identity();
function handler(t: Parameters<typeof stores>[0], liveHires = true, uiRoot?: string, rpc: NearRpc = dummyRpc(), now = () => testNow, marketData?: { url: string; token: string; fetch?: typeof fetch }) {
  const { web, worker, watch } = stores(t);
  const kek = Buffer.alloc(32, 4);
  const run = createHandler({ store: web, rpc, now, uiRoot, env: { host: '127.0.0.1', port: 8090, origin, liveHires }, provider: fullAccess, ...(marketData ? { marketData } : {}),
    wait: () => processReveals({ store: worker, rpc, now, kek, origin, provider: fullAccess, outlayer: dummyOutLayer(), live: true }) });
  async function request(path: string, method = 'GET', input?: unknown, cookie?: string, headers?: Record<string, string>) {
    const req = Object.assign(Readable.from(input === undefined ? [] : [Buffer.from(JSON.stringify(input))]), { url: path, method,
      headers: { host: 'app.test', origin, cookie, 'content-type': 'application/json', ...headers } }) as unknown as IncomingMessage;
    const h = new Map<string, string>();
    let out = '';
    const res = { statusCode: 200, setHeader: (key: string, value: string) => h.set(key, value), end: (text: string) => { out = text; } };
    await run(req, res as unknown as ServerResponse);
    out = String(out);
    return { status: res.statusCode, headers: h, text: out, envelope: (h.get('Content-Type')?.startsWith('application/json') ? JSON.parse(out) : {}) as { data: unknown; error?: { code: string } } };
  }
  const token = 'a'.repeat(43), cookie = `fourlpha_session=${token}`;
  web.putSession(tokenHash(token), owner, testNow, testNow + 600_000);
  return { web, worker, watch, request, cookie, kek };
}

test('web Host and Origin checks, envelope, real signature and secure session cookie', async t => {
  const { request } = handler(t);
  assert.equal((await request('/api/me', 'GET', undefined, undefined, { host: 'attacker.test' })).status, 403);
  assert.equal((await request('/api/login', 'POST', {}, undefined, { origin: 'https://attacker.test' })).status, 403);
  const c = (await request('/api/challenge?purpose=login')).envelope.data as Challenge;
  const s = sign(c);
  const login = await request('/api/login', 'POST', { signed: s });
  assert.deepEqual(login.envelope, { data: { accountId: owner } });
  assert.match(login.headers.get('Set-Cookie')!, /HttpOnly; SameSite=Strict; Secure; Max-Age=43200/);
  assert.equal((await request('/api/login', 'POST', { signed: s })).status, 401);
});

test('I-2 hire owner comes from session and a foreign session cannot see or cancel a job', async t => {
  const { request, web, cookie } = handler(t);
  const r = await request('/api/jobs', 'POST', { owner: 'attacker.near', kind: 'grid', mode: 'live', pair: 'usdc-wnear', depositYocto: '400000000000000000000000' }, cookie);
  assert.equal(r.status, 201);
  const { id } = r.envelope.data as { id: string };
  assert.equal(web.getJob(id)?.owner, owner);
  const token = 'b'.repeat(43); web.putSession(tokenHash(token), 'attacker.near', testNow, testNow + 600_000);
  const other = `fourlpha_session=${token}`;
  assert.equal((await request(`/api/jobs/${id}`, 'GET', undefined, other)).status, 404);
  assert.equal((await request(`/api/jobs/${id}/cancel`, 'POST', {}, other)).status, 404);
});

test('I-11 only a signed one-use reveal returns the link with no-store', async t => {
  const { request, web, worker, cookie, kek } = handler(t);
  const j = web.createJob({ owner, kind: 'grid', mode: 'live', pair: 'usdc-wnear', depositYocto: 400000000000000000000000n }, testNow);
  const b = { id: j.id, owner, walletId: 'wallet-test', agentAccount: agent };
  const link = 'https://example.test/?key=wk_test_fake';
  worker.attachWallet(j, b.walletId, agent, { apiKeyCt: seal(kek, new SecretString('wk_test_fake'), walletAad(b, 'api_key')),
    linkCt: seal(kek, new SecretString(link), walletAad(b, 'link')) }, testNow);
  const p = `/api/jobs/${j.id}`;
  assert.equal((await request(`${p}/reveal`, 'POST', {}, cookie)).status, 401);
  const c = (await request(`/api/challenge?purpose=reveal&job=${j.id}`, 'GET', undefined, cookie)).envelope.data as Challenge;
  const signed = sign(c);
  assert.equal((await request(`${p}/link-confirmed`, 'POST', { saved: true }, cookie)).status, 409);
  const r = await request(`${p}/reveal`, 'POST', { signed }, cookie);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(r.envelope, { data: { link } });
  assert.equal((await request(`${p}/reveal`, 'POST', { signed }, cookie)).status, 401);
  assert.doesNotMatch((await request(p, 'GET', undefined, cookie)).text, /wk_test_fake/);
  assert.doesNotMatch((await request('/api/jobs', 'GET', undefined, cookie)).text, /wk_test_fake/);
});

test('F-1 disabled flag refuses creation', async t => {
  const { request, cookie, web } = handler(t, false);
  assert.equal((await request('/api/jobs', 'POST', {}, cookie)).envelope.error?.code, 'live_disabled');
  assert.deepEqual(web.listJobs(owner), []);
});

test('signed resume only moves an owner from paused to resuming, and cannot be replayed', async t => {
  const { request, web, worker, cookie } = handler(t);
  const { job } = armedJob(web, worker, 'paused');
  const p = `/api/jobs/${job.id}`;
  assert.equal((await request(`${p}/resume`, 'POST', {}, cookie)).status, 401);
  const c = (await request(`/api/challenge?purpose=resume&job=${job.id}`, 'GET', undefined, cookie)).envelope.data as Challenge;
  assert.equal((await request(`${p}/resume`, 'POST', { signed: identity('attacker.near')(c) }, cookie)).status, 401);
  const signed = sign(c);
  assert.equal((await request(`${p}/resume`, 'POST', { signed }, cookie)).status, 200);
  assert.equal(web.getJob(job.id)?.state, 'resuming');
  assert.equal((await request(`${p}/resume`, 'POST', { signed }, cookie)).status, 409);
  assert.equal(web.getChallenge(c.nonce), null);
});

async function legacyHalt(t: Parameters<typeof stores>[0], baseline = true, unsafeVerdict?: string) {
  const c = chain();
  let clock = testNow;
  const now = () => clock, h = handler(t, true, undefined, c.rpc, now);
  const { job: j } = armedJob(h.web, h.worker);
  if (unsafeVerdict) assert.ok(h.worker.insertOp(opRow(j, { state: 'finished', verdict: unsafeVerdict })));
  const pass = () => watchOnce({ store: h.watch, rpc: c.rpc, now });
  if (baseline) await pass();
  const alert = { jobId: j.id, kind: 'blind', severity: 'halt' as const, detail: { message: 'Legacy blind halt.' }, createdAt: now() };
  assert.ok(h.watch.insertAlert(alert));
  assert.ok(setJob(h.worker, j, 'halted', now(), { reason: WALLET_ALERT_HALT }));
  const job = h.web.getJob(j.id)!, path = `/api/jobs/${j.id}`, challengePath = `/api/challenge?purpose=resume&job=${j.id}`;
  clock += 1000;
  c.setHoldings({ height: 11 });
  await pass();
  return { ...h, c, job, path, pass, now, alert, challengePath, advance: (ms: number) => { clock += ms; },
    challenge: async () => (await h.request(challengePath, 'GET', undefined, h.cookie)).envelope.data as Challenge };
}

test('legacy recovery requires a job- and origin-bound owner signature and a fresh session', async t => {
  const h = await legacyHalt(t);
  const c = await h.challenge();
  const post = (signed: ReturnType<typeof sign>, cookie = h.cookie) => h.request(`${h.path}/resume`, 'POST', { signed }, cookie);
  assert.match(c.message, /Origin https:\/\/app\.test$/);
  assert.equal((await post(sign(c), '')).status, 401);
  assert.equal((await post(identity('attacker.near')(c))).status, 401);
  assert.equal((await post(sign(c, 'https://attacker.test'))).status, 401);
  for (const other of [newChallenge('resume', 'a-different-job', h.now(), origin), newChallenge('resume', h.job.id, h.now(), 'https://attacker.test'),
    newChallenge('reveal', h.job.id, h.now()), newChallenge('resume', h.job.id, h.now() - 300_000, origin)]) {
    h.web.putChallenge(other);
    assert.equal((await post(sign(other))).status, 401);
    assert.ok(h.web.getChallenge(other.nonce));
  }
  assert.equal(h.web.getJob(h.job.id)?.state, 'halted');
  assert.equal(h.web.openAlerts(h.job.id).length, 1);
  assert.ok(h.web.getChallenge(c.nonce));
});

test('legacy recovery rejects missing, malformed, stale and future proof, including no baseline', async t => {
  const h = await legacyHalt(t), key = `watch_clean:${h.job.id}`;
  const proof = JSON.parse(h.watch.meta(key)!) as Record<string, unknown>;
  for (const bad of ['null', '{', JSON.stringify({ ...proof, at: h.now() + 1 }), JSON.stringify({ ...proof, at: h.now() - 60_001 })]) {
    h.watch.setMeta(key, bad);
    assert.equal((await h.request(h.challengePath, 'GET', undefined, h.cookie)).status, 409);
  }
  h.watch.invalidateWatch(h.job.id);
  assert.equal((await h.request(h.challengePath, 'GET', undefined, h.cookie)).status, 409);
  const empty = await legacyHalt(t, false);
  empty.c.setHoldings({ height: 12 });
  await empty.pass();
  assert.equal(empty.watch.getWatch(empty.job.id), null);
  assert.equal((await empty.request(empty.challengePath, 'GET', undefined, empty.cookie)).status, 409);
});

test('legacy recovery transaction leaves nonce and blind alert intact on a race', async t => {
  for (const race of ['stop', 'new alert', 'new blind', 'reserve op', 'proof expires'] as const) await t.test(race, async st => {
    const h = await legacyHalt(st), c = await h.challenge(), query = h.c.rpc.query;
    assert.ok(c);
    h.c.rpc.query = async args => {
      if (race === 'stop') assert.ok(setJob(h.web, h.job, 'stopping', h.now()));
      else if (race === 'new alert') assert.ok(h.watch.insertAlert({ ...h.alert, kind: 'token_outflow' }));
      else if (race === 'new blind') h.watch.invalidateWatch(h.job.id, true);
      else if (race === 'reserve op') assert.ok(h.worker.insertOp(opRow(h.job, { purpose: 'exit' })));
      else { h.advance(60_001); h.watch.heartbeat('watchdog', h.now()); }
      return query(args);
    };
    assert.equal((await h.request(`${h.path}/resume`, 'POST', { signed: sign(c) }, h.cookie)).status, 409);
    assert.ok(h.web.getChallenge(c.nonce));
    assert.ok(h.web.openAlerts(h.job.id).some(a => a.kind === 'blind'));
    assert.equal(h.web.getJob(h.job.id)?.state, race === 'stop' ? 'stopping' : 'halted');
  });
});

test('fresh policy mismatch or freeze and previous unsafe operation outcomes refuse legacy recovery', async t => {
  const h = await legacyHalt(t), c = await h.challenge();
  for (const policy of [null, { owner: 'attacker.near', encrypted_data: 'QUFBQQ==', frozen: false, storage_deposit: '1' },
    { owner, encrypted_data: 'changed', frozen: false, storage_deposit: '1' }, { owner, encrypted_data: 'QUFBQQ==', frozen: true, storage_deposit: '1' }]) {
    h.c.setPolicy(policy);
    assert.equal((await h.request(`${h.path}/resume`, 'POST', { signed: sign(c) }, h.cookie)).status, 409);
    assert.ok(h.web.getChallenge(c.nonce));
  }
  for (const verdict of ['unknown', 'unclear', 'denied']) await t.test(verdict, async st => {
    const a = await legacyHalt(st, true, verdict);
    assert.equal(a.web.blindResumeProof(a.job, a.now()), null);
  });
});

test('generic state changes and previously fired protection cannot bypass legacy recovery', async t => {
  const h = await legacyHalt(t), { job } = h;
  assert.ok(h.web.blindResumeProof(job, h.now()));
  for (const state of ['ready', 'running', 'funded', 'resuming'] as const) {
    assert.equal(setJob(h.worker, job, state, h.now()), false);
    assert.equal(h.worker.casJob(job.id, job.state, job.version, state, {}, h.now()), false);
  }
  assert.equal(h.web.casJob(job.id, job.state, job.version, 'resuming', {}, h.now()), false);
  assert.ok(h.worker.insertAlert({ ...h.alert, kind: 'protect_stop', severity: 'info' }));
  assert.equal(h.web.blindResumeProof(job, h.now()), null);
});

test('halted views distinguish unreadable policy, missing policy, missing proof and eligibility', async t => {
  const h = await legacyHalt(t);
  const view = async () => (await h.request(h.path, 'GET', undefined, h.cookie)).envelope.data as { canResumeBlind: boolean; resumeBlockedReason: string | null };
  const healthy = await view();
  assert.equal(healthy.canResumeBlind, true);
  assert.equal(healthy.resumeBlockedReason, null);
  const c = await h.challenge(), rpcView = h.c.rpc.view;
  h.c.rpc.view = async (contract, method, args, block) => {
    if (method === 'get_wallet_policy') throw new Error('internal RPC endpoint detail');
    return rpcView(contract, method, args, block);
  };
  const unreadable = await view();
  assert.equal(unreadable.canResumeBlind, false);
  assert.match(unreadable.resumeBlockedReason!, /Waiting for finalized wallet policy data/);
  assert.doesNotMatch(unreadable.resumeBlockedReason!, /endpoint/);
  h.c.rpc.view = rpcView;
  h.c.setPolicy(null);
  const missing = await view();
  assert.equal(missing.canResumeBlind, false);
  assert.match(missing.resumeBlockedReason!, /has no finalized policy/);
  assert.equal((await h.request(`${h.path}/resume`, 'POST', { signed: sign(c), canResumeBlind: true, resumeBlockedReason: null }, h.cookie)).status, 409);
  assert.ok(h.web.getChallenge(c.nonce));
  h.c.setPolicy({ owner, encrypted_data: 'QUFBQQ==', frozen: false, storage_deposit: '1' });
  h.watch.invalidateWatch(h.job.id, true);
  assert.match((await view()).resumeBlockedReason!, /full recent watchdog verification/);
});

test('UI dispatcher serves only confined ASCII static files and SPA routes, keeping legacy and API separate', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'fourlpha-ui-')), ui = join(dir, 'ui');
  mkdirSync(ui); mkdirSync(join(ui, 'fonts'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(ui, 'index.html'), '<html>UI index</html>');
  writeFileSync(join(ui, 'main.js'), 'UI script');
  writeFileSync(join(ui, 'fonts', 'font.woff2'), 'font');
  writeFileSync(join(dir, 'outside.js'), 'OUTSIDE FILE');
  mkdirSync(join(dir, 'outside')); writeFileSync(join(dir, 'outside', 'file.js'), 'OUTSIDE DIRECTORY');
  const { request, cookie } = handler(t, true, ui);
  for (const route of ['/', '/account/x', '/account']) {
    const r = await request(route);
    assert.equal(r.status, 200); assert.equal(r.text, '<html>UI index</html>');
    assert.equal(r.headers.get('Content-Type'), 'text/html; charset=utf-8');
  }
  for (const route of ['/main.js', '/main.js?x=..']) {
    const r = await request(route); assert.equal(r.text, 'UI script'); assert.equal(r.headers.get('Content-Type'), 'text/javascript; charset=utf-8');
  }
  assert.equal((await request('/fonts/font.woff2')).headers.get('Content-Type'), 'font/woff2');
  for (const route of ['/x.json', '/x.map', '/MAIN.JS', '/main.js/..', '/..%2fsrc/web/server.ts', '/%2e%2e/package.json', '/a\\b']) assert.equal((await request(route)).status, 404, route);
  const doubled = await request('//etc/passwd'); assert.ok([403, 404].includes(doubled.status)); assert.doesNotMatch(doubled.text, /OUTSIDE/);
  // API paths are checked while a valid index.html exists, so a wrong SPA fallback would show up as HTML.
  for (const route of ['/api/unknown', '/api%2fjobs']) {
    const r = await request(route, 'GET', undefined, cookie); assert.notEqual(r.headers.get('Content-Type'), 'text/html; charset=utf-8'); assert.notEqual(r.status, 200);
  }
  symlinkSync(join(dir, 'outside'), join(ui, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await request('/linked/file.js')).status, 404);
  await t.test('a file symlink inside UI_ROOT cannot be served', async t => {
    try { symlinkSync(join(dir, 'outside.js'), join(ui, 'link.js'), 'file'); }
    catch (e) { if (process.platform === 'win32' && (e as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Windows denies unprivileged file symlink creation.'); return; } throw e; }
    assert.equal((await request('/link.js')).status, 404);
  });
  await t.test('a symlinked index cannot be served through SPA fallback', async t => {
    unlinkSync(join(ui, 'index.html'));
    try { symlinkSync(join(dir, 'outside.js'), join(ui, 'index.html'), 'file'); }
    catch (e) { if (process.platform === 'win32' && (e as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Windows denies unprivileged file symlink creation.'); return; } throw e; }
    assert.equal((await request('/account/x')).status, 404);
  });
  assert.equal((await request('/', 'HEAD')).status, 400);
  assert.match((await request('/legacy')).text, /id="hire-form"/);
});

test('GET jobs includes operation creation and finish times', async t => {
  const { request, web, worker, cookie } = handler(t);
  const { job } = armedJob(web, worker, 'paused');
  assert.equal(worker.insertOp(opRow(job, { state: 'finished', verdict: 'success', finishedAt: testNow + 1000 })), true);
  assert.equal(worker.insertOp(opRow(job)), true);
  const result = await request('/api/jobs', 'GET', undefined, cookie);
  const jobs = result.envelope.data as { id: string; operations: { createdAt: number; finishedAt: number | null }[] }[];
  const row = jobs.find(j => j.id === job.id)!;
  assert.ok(row);
  assert.equal(row.operations.length, 2);
  assert.equal(row.operations.length, web.jobOps(job.id).length);
  for (const [i, op] of row.operations.entries()) {
    assert.equal(op.createdAt, web.jobOps(job.id)[i]!.createdAt);
    assert.equal(op.finishedAt, web.jobOps(job.id)[i]!.finishedAt);
  }
});

test('market data routes are public, validate before forwarding and answer 503 when unconfigured', async t => {
  const calls: string[] = [];
  const { request, cookie } = handler(t, true, undefined, dummyRpc(), () => testNow, { url: 'http://dp.test', token: 'dp-secret-token', fetch: (async (u: string) => { calls.push(u); return new Response('{}'); }) as unknown as typeof fetch });
  // Public agent page T-5: no session needed with the demo off; the data plane answer '{}' is not usable, so the routes answer 503 after one upstream call each.
  assert.notEqual((await request('/api/market-data/ohlcv?kind=pool&address=rhea-4512')).status, 401);
  assert.notEqual((await request('/api/pool-liquidity?address=rhea-dcl-usdc-wnear')).status, 401);
  assert.equal(calls.length, 2); calls.length = 0;
  for (const q of ['kind=token&address=rhea-4512', 'kind=pool', 'kind=pool&address=0xabc', 'kind=pool&address=rhea-4512&interval=4h', 'kind=pool&address=rhea-4512&limit=0',
    'kind=pool&address=rhea-4512&limit=501', 'kind=pool&address=rhea-4512&limit=abc', 'kind=pool&address=rhea-4512&currency=eur']) {
    const r = await request(`/api/market-data/ohlcv?${q}`, 'GET', undefined, cookie);
    assert.equal(r.status, 400, q);
    assert.equal(r.envelope.error?.code, 'bad_request');
  }
  for (const q of ['', 'address=../x', 'address=rhea-4512&window=0', 'address=rhea-4512&window=1001', 'address=rhea-4512&window=1.5']) {
    assert.equal((await request(`/api/pool-liquidity?${q}`, 'GET', undefined, cookie)).status, 400, q);
  }
  assert.deepEqual(calls, []);
  const bare = handler(t);
  for (const path of ['/api/market-data/ohlcv?kind=pool&address=rhea-4512', '/api/pool-liquidity?address=rhea-dcl-usdc-wnear']) {
    const r = await bare.request(path, 'GET', undefined, bare.cookie);
    assert.equal(r.status, 503);
    assert.deepEqual(r.envelope, { data: null, error: { code: 'market_data_unconfigured', message: 'Market data is not configured.' } });
  }
});

test('market data routes forward the path, header and query and pass the answer through', async t => {
  const seen: { url: string; token: string | null }[] = [];
  const answers: Record<string, unknown> = {
    '/near/pools/rhea-4512/ohlcv': { data: [{ timestamp: 60000, open: 3.5, high: 3.6, low: 3.4, close: 3.55, volume: null }], meta: { poolKey: 'rhea-4512', source: 'near-chain', volumeCurrency: null } },
    '/near/pools/rhea-dcl-usdc-wnear/liquidity': { data: { bins: [{ tickLower: 401768, liquidity: '5' }, { tickLower: 401769, liquidity: '0' }], currentTick: 401769, blockNumber: '123', truncated: false }, meta: { source: 'near-chain' } },
  };
  const fake = (async (u: string, init: RequestInit) => {
    seen.push({ url: u, token: new Headers(init.headers).get('x-dp-token') });
    return new Response(JSON.stringify(answers[new URL(u).pathname]));
  }) as unknown as typeof fetch;
  const { request, cookie } = handler(t, true, undefined, dummyRpc(), () => testNow, { url: 'http://dp.test/', token: 'dp-secret-token', fetch: fake });
  const candles = await request('/api/market-data/ohlcv?kind=pool&address=rhea-4512&interval=5m&limit=100&currency=usd', 'GET', undefined, cookie);
  assert.equal(candles.status, 200);
  assert.deepEqual(candles.envelope, answers['/near/pools/rhea-4512/ohlcv']);
  await request('/api/market-data/ohlcv?kind=pool&address=rhea-4512', 'GET', undefined, cookie);
  const liquidity = await request('/api/pool-liquidity?address=rhea-dcl-usdc-wnear&window=30', 'GET', undefined, cookie);
  await request('/api/pool-liquidity?address=rhea-dcl-usdc-wnear', 'GET', undefined, cookie);
  assert.deepEqual(seen.map(s => s.url), [
    'http://dp.test/near/pools/rhea-4512/ohlcv?interval=5m&limit=100&currency=usd', 'http://dp.test/near/pools/rhea-4512/ohlcv?interval=1m&limit=300&currency=token',
    'http://dp.test/near/pools/rhea-dcl-usdc-wnear/liquidity?window=30', 'http://dp.test/near/pools/rhea-dcl-usdc-wnear/liquidity?window=60']);
  assert.ok(seen.every(s => s.token === 'dp-secret-token'));
  // DCL points become display ticks (tick = -point), ascending.
  assert.deepEqual(liquidity.envelope, { data: { bins: [{ tickLower: -401769, liquidity: '0' }, { tickLower: -401768, liquidity: '5' }], currentTick: -401769, blockNumber: '123', truncated: false }, meta: { source: 'near-chain' } });
});

test('market data failures are sanitized and never carry the token, the URL or the upstream body', async t => {
  const modes = [() => new Response('boom dp-secret-token http://dp.test', { status: 500 }), () => new Response('not json dp-secret-token'), () => new Response(JSON.stringify({ data: 1 })),
    () => new Response(JSON.stringify({ data: { bins: [{ tickLower: 'x' }], currentTick: 1 }, meta: {} })), () => { throw new Error('connect dp-secret-token http://dp.test'); }];
  for (const mode of modes) {
    const { request, cookie } = handler(t, true, undefined, dummyRpc(), () => testNow, { url: 'http://dp.test', token: 'dp-secret-token', fetch: (async () => mode()) as unknown as typeof fetch });
    for (const path of ['/api/market-data/ohlcv?kind=pool&address=rhea-4512', '/api/pool-liquidity?address=rhea-dcl-usdc-wnear']) {
      const r = await request(path, 'GET', undefined, cookie);
      assert.equal(r.status, 503);
      assert.deepEqual(r.envelope, { data: null, error: { code: 'market_data_unavailable', message: 'Market data is unavailable.' } });
      assert.ok(!r.text.includes('dp-secret-token') && !r.text.includes('dp.test'));
    }
  }
  const missing = handler(t, true, undefined, dummyRpc(), () => testNow, { url: 'http://dp.test', token: 'dp-secret-token', fetch: (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch });
  assert.equal((await missing.request('/api/pool-liquidity?address=rhea-4512', 'GET', undefined, missing.cookie)).status, 404);
  assert.deepEqual((await missing.request('/api/pool-liquidity?address=rhea-4512', 'GET', undefined, missing.cookie)).envelope, { data: null, error: { code: 'not_found', message: 'Liquidity profile is not recorded yet.' } });
  assert.equal((await missing.request('/api/market-data/ohlcv?kind=pool&address=rhea-4512', 'GET', undefined, missing.cookie)).text.includes('Price history is not recorded yet.'), true);
  const warnings: string[] = [], warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
  try {
    const refused = handler(t, true, undefined, dummyRpc(), () => testNow, { url: 'http://dp.test', token: 'dp-secret-token', fetch: (async () => new Response('no dp-secret-token', { status: 401 })) as unknown as typeof fetch });
    assert.equal((await refused.request('/api/market-data/ohlcv?kind=pool&address=rhea-4512', 'GET', undefined, refused.cookie)).text.includes('Market data is unavailable.'), true);
  } finally { console.warn = warn; }
  assert.deepEqual(warnings, ['Market data upstream refused the request (HTTP 401).']);
  const dead = handler(t, true, undefined, dummyRpc(), () => testNow, { url: 'http://dp.test', token: 'dp-secret-token', fetch: (async () => new Response(JSON.stringify({ data: [], meta: { staleness: 'dead' } }))) as unknown as typeof fetch });
  const out = await dead.request('/api/market-data/ohlcv?kind=pool&address=rhea-4512', 'GET', undefined, dead.cookie);
  assert.deepEqual([out.status, out.envelope.error], [503, { code: 'market_data_unavailable', message: 'Market data is out of date.' }]);
});

// Display only: the job view lists Grid fills (completed claims) and LP compounds from the operation journal.
function dclJob(h: ReturnType<typeof handler>, over: Parameters<typeof h.web.createJob>[0]) {
  h.worker.acquireWorkerLock(process.pid, testNow);
  const j = h.web.createJob(over, testNow), b = { id: j.id, owner, walletId: 'wallet-test', agentAccount: agent };
  h.worker.attachWallet(j, b.walletId, agent, { apiKeyCt: seal(h.kek, new SecretString('wk_test_fake'), walletAad(b, 'api_key')),
    linkCt: seal(h.kek, new SecretString('https://example.test/?key=wk_test_fake'), walletAad(b, 'link')) }, testNow);
  return h.worker.getJob(j.id)!;
}

test('Grid job view lists completed claims as fills, newest first, capped at 50, and skips rows that lack fields', async t => {
  const h = handler(t), job = dclJob(h, { owner, kind: 'grid', mode: 'live', pair: 'usdc-wnear', depositYocto: 1_000_000_000_000_000_000_000_000n, gridV1: true });
  const order = (sell: string, point: number) => ({ id: '17387', owner: agent, pool: `${USDC}|${WNEAR}|100`, sell, buy: sell === USDC ? WNEAR : USDC, point, original: '2000000',
    deposit: '2000000', instant: '0', remain: '0', bought: '9000', unclaimed: '0', cancelled: '0', created: '1' });
  const claim = (sell: string, point: number, at: number, patch: Partial<OpRow> = {}) => opRow(job, { kind: 'dcl_claim', state: 'finished', verdict: 'success', finishedAt: at, txHash: `tx${at}`,
    before: JSON.stringify({ dcl: { order: order(sell, point) } }), after: JSON.stringify({ dclProof: { orderId: '17387', completed: true, claimed: '9000' } }), ...patch });
  const fills = async () => ((await h.request(`/api/jobs/${job.id}`, 'GET', undefined, h.cookie)).envelope.data as { grid: { fills: unknown[] } }).grid.fills;
  for (const row of [
    claim(USDC, 401_900, testNow + 1000),
    claim(WNEAR, 402_100, testNow + 3000),
    claim(WNEAR, 402_100, testNow + 4000, { after: JSON.stringify({ dclProof: { orderId: '17387', completed: false, claimed: '9000' } }) }),
    claim(WNEAR, 402_100, testNow + 5000, { verdict: 'refunded' }),
    claim(WNEAR, 402_100, testNow + 6000, { before: '{' }),
    claim(WNEAR, 402_100, testNow + 7000, { before: JSON.stringify({ dcl: {} }) }),
    claim(WNEAR, 402_100, testNow + 8000, { after: JSON.stringify({ dclProof: { orderId: '17387', completed: true } }) }),
    claim(WNEAR, 402_100, testNow + 9000, { kind: 'dcl_cancel' }),
  ]) assert.equal(h.worker.insertOp(row), true);
  assert.deepEqual(await fills(), [
    { at: testNow + 3000, side: 'sell', point: 402_100, sold: '2000000', bought: '9000', txHash: `tx${testNow + 3000}` },
    { at: testNow + 1000, side: 'buy', point: 401_900, sold: '2000000', bought: '9000', txHash: `tx${testNow + 1000}` },
  ]);
  for (let i = 0; i < 50; i++) assert.equal(h.worker.insertOp(claim(WNEAR, 402_100, testNow + 10_000 + i)), true);
  const capped = await fills() as { at: number }[];
  assert.equal(capped.length, 50);
  assert.deepEqual([capped[0]!.at, capped[49]!.at], [testNow + 10_049, testNow + 10_000]);
});

test('LP V2 job view counts successful strategy compounds and reports the last one', async t => {
  const h = handler(t), job = dclJob(h, { owner, kind: 'lp', mode: 'live', pair: 'usdc-wnear', depositYocto: 1_500_000_000_000_000_000_000_000n, lpV1: true,
    lpSettings: { v: 2, range: { mode: 'server' }, ai: false, compound: { on: true, minFeeBps: 100 }, stopLossPct: 0, takeProfitPct: 0 } });
  const remove = (reason: string, at: number, patch: Partial<OpRow> = {}) => opRow(job, { kind: 'dcl_remove', purpose: 'strategy', state: 'finished', verdict: 'success',
    request: JSON.stringify({ lpReason: reason }), createdAt: at, finishedAt: at + 10, ...patch });
  const compounds = async () => ((await h.request(`/api/jobs/${job.id}`, 'GET', undefined, h.cookie)).envelope.data as { lp: { compounds: unknown } }).lp.compounds;
  assert.deepEqual(await compounds(), { count: 0, lastAt: null });
  for (const row of [
    remove('compound', testNow + 1000), remove('compound', testNow + 5000), remove('rotate', testNow + 7000),
    remove('compound', testNow + 8000, { verdict: 'refunded' }), remove('compound', testNow + 9000, { purpose: 'exit' }),
  ]) assert.equal(h.worker.insertOp(row), true);
  assert.deepEqual(await compounds(), { count: 2, lastAt: testNow + 5010 });
});

function countingRpc(base: NearRpc, calls: string[]): NearRpc {
  return { ...base,
    finalBlock: async () => { calls.push('finalBlock'); return base.finalBlock!(); },
    query: async p => { calls.push(String(p.request_type)); return base.query(p); },
    view: async (contract, method, args, block) => { calls.push(method); return base.view(contract, method, args, block); },
    viewAccount: async id => { calls.push(`account:${id === owner ? 'owner' : 'other'}`); return base.viewAccount(id); } };
}
const FULL_READ = ['account:owner', 'finalBlock', 'ft_balance_of', 'ft_balance_of', 'get_wallet_policy', 'view_account'];
const CACHED_READ = ['account:owner', 'get_wallet_policy'];

test('the job list reuses a job\'s balance reads for a minute while the job is unchanged; single reads and changes read fresh', async t => {
  let clock = testNow;
  const c = chain(), calls: string[] = [], h = handler(t, true, undefined, countingRpc(c.rpc, calls), () => clock), { job } = armedJob(h.web, h.worker, 'paused');
  const read = async (path: string) => { calls.length = 0; assert.equal((await h.request(path, 'GET', undefined, h.cookie)).status, 200); return [...calls].sort(); };
  assert.deepEqual(await read('/api/jobs'), FULL_READ);
  clock += 10_000;
  assert.deepEqual(await read('/api/jobs'), CACHED_READ);
  assert.deepEqual(await read(`/api/jobs/${job.id}`), FULL_READ);
  assert.deepEqual(await read('/api/jobs'), CACHED_READ);
  assert.equal(h.worker.insertOp(opRow(job)), true);
  assert.deepEqual(await read('/api/jobs'), FULL_READ);
  clock += 10_000;
  assert.deepEqual(await read('/api/jobs'), CACHED_READ);
  clock += CHAIN_CACHE_MS;
  assert.deepEqual(await read('/api/jobs'), FULL_READ);
});

test('the job list shows the owner\'s freeze at once and never reuses a failed read', async t => {
  let clock = testNow;
  const c = chain(), calls: string[] = [], h = handler(t, true, undefined, countingRpc(c.rpc, calls), () => clock);
  armedJob(h.web, h.worker, 'paused');
  const list = async () => { calls.length = 0; const r = await h.request('/api/jobs', 'GET', undefined, h.cookie); return (r.envelope.data as { frozen: boolean | null; agentBalance: string | null }[])[0]!; };
  assert.equal((await list()).frozen, false);
  c.freeze(true); clock += 5_000;
  assert.equal((await list()).frozen, true);
  assert.deepEqual([...calls].sort(), CACHED_READ);
  c.setReadable(false); clock += CHAIN_CACHE_MS;
  const blind = await list();
  assert.deepEqual([blind.frozen, blind.agentBalance], [null, null]);
  c.setReadable(true); clock += 5_000;
  const back = await list();
  assert.deepEqual([...calls].sort(), FULL_READ);
  assert.deepEqual([back.frozen, back.agentBalance], [true, c.native.toString()]);
});

test('the job list reads every setup state fresh on every request', async t => {
  for (const state of ['armed', 'link_confirmed'] as const) {
    let clock = testNow;
    const c = chain(), calls: string[] = [], h = handler(t, true, undefined, countingRpc(c.rpc, calls), () => clock);
    armedJob(h.web, h.worker, state);
    for (let i = 0; i < 3; i++) {
      calls.length = 0; clock += 5_000;
      assert.equal((await h.request('/api/jobs', 'GET', undefined, h.cookie)).status, 200);
      assert.deepEqual([...calls].sort(), FULL_READ, state);
    }
  }
});

test('a Grid job\'s DCL reads are reused by the job list, and a failed DCL read is not', async t => {
  let clock = testNow, dclDown = false;
  const c = chain(), calls: string[] = [];
  const dcl: NearRpc = { ...c.rpc, view: async (contract, method, args, block) => {
    if (contract !== DCL) return c.rpc.view(contract, method, args, block);
    if (dclDown) throw new RpcUnavailable();
    const value = ({ get_metadata: { version: '2.4.2', state: 'Running' }, get_pool: { pool_id: DCL_POOL, token_x: USDC, token_y: WNEAR, fee: 100, point_delta: 1, state: 'Running', current_point: 402_000 },
      storage_balance_bounds: { min: String(DCL_STORAGE), max: null }, get_user_storage_detail: null, list_active_orders: [], list_history_orders: [], list_user_assets: {}, list_lostfound: {}, list_liquidities: [] } as Record<string, unknown>)[method];
    if (value === undefined) throw new RpcUnavailable();
    return { height: c.height, blockId: `block-${c.height}`, value };
  } };
  const h = handler(t, true, undefined, countingRpc(dcl, calls), () => clock);
  armedJob(h.web, h.worker, 'paused', undefined, { gridV1: true });
  const list = async () => { calls.length = 0; clock += 5_000; assert.equal((await h.request('/api/jobs', 'GET', undefined, h.cookie)).status, 200); return [...calls].sort(); };
  const views = ['get_metadata', 'get_pool', 'get_user_storage_detail', 'list_active_orders', 'list_history_orders', 'list_liquidities', 'list_lostfound', 'list_user_assets', 'storage_balance_bounds'];
  const full = [...FULL_READ, ...views].sort();
  assert.deepEqual(await list(), full);
  assert.deepEqual(await list(), CACHED_READ);
  dclDown = true; clock += CHAIN_CACHE_MS;
  assert.ok((await list()).includes('get_metadata'));
  assert.ok((await list()).includes('get_metadata'));
  dclDown = false;
  assert.deepEqual(await list(), full);
  assert.deepEqual(await list(), CACHED_READ);
});

test('the job list reuses a stopped job\'s reads, policy and failures included, for ten minutes', async t => {
  let clock = testNow;
  const c = chain(), calls: string[] = [], h = handler(t, true, undefined, countingRpc(c.rpc, calls), () => clock);
  armedJob(h.web, h.worker, 'stopped');
  let n = 0;
  const list = async () => {
    const token = String(++n).padStart(43, 'b');
    h.web.putSession(tokenHash(token), owner, clock, clock + 600_000); calls.length = 0;
    assert.equal((await h.request('/api/jobs', 'GET', undefined, `fourlpha_session=${token}`)).status, 200); return [...calls].sort();
  };
  c.setReadable(false);
  assert.ok((await list()).includes('finalBlock'));
  c.setReadable(true); clock += 60_000;
  assert.deepEqual(await list(), ['account:owner']);
  clock += TERMINAL_CACHE_MS;
  assert.ok((await list()).includes('get_wallet_policy'));
  clock += 60_000;
  assert.deepEqual(await list(), ['account:owner']);
});

// Public agent page (docs/specs/PUBLIC-AGENT-PAGE-SPEC.md).
function publicJob(h: ReturnType<typeof handler>, over: Parameters<typeof h.web.createJob>[0]) {
  const j = dclJob(h, over);
  assert.equal(h.worker.casJob(j.id, j.state, j.version, 'running', { linkConfirmedAt: testNow }, testNow), true);
  return h.worker.getJob(j.id)!;
}

test('T-1 the public view is the owner view with the owner-only fields replaced, for Grid, LP and trade jobs', async t => {
  // Audit M-1: the list is pinned here, so dropping an entry fails; grid.test and lp.test check the overrides where the owner values are true.
  assert.deepEqual(PUBLIC_OVERRIDES, { ownerBalance: null, payload: null, canReveal: false, linkDelivered: false, canFund: false, canStopEarly: false, canResumeBlind: false, resumeBlockedReason: null });
  assert.equal(PUBLIC_CACHE_MS, 30_000);
  const h = handler(t);
  const jobs = [
    publicJob(h, { owner, kind: 'grid', mode: 'live', pair: 'usdc-wnear', depositYocto: 1_000_000_000_000_000_000_000_000n, gridV1: true }),
    publicJob(h, { owner, kind: 'lp', mode: 'live', pair: 'usdc-wnear', depositYocto: 1_500_000_000_000_000_000_000_000n, lpV1: true }),
    publicJob(h, { owner, kind: 'schedule', mode: 'live', pair: 'trade-usdc', depositYocto: 600_000_000_000_000_000_000_000n,
      tradeSettings: tradeSettingsFromRequest('schedule', { amountNear: '0.10', intervalSec: 3600, budgetNear: '0.20', end: { kind: 'budget' } }, testNow) as TradeSettings }),
  ];
  for (const job of jobs) {
    const mine = (await h.request(`/api/jobs/${job.id}`, 'GET', undefined, h.cookie)).envelope.data as Record<string, unknown>;
    const r = await h.request(`/api/public/jobs/${job.id}`);
    assert.equal(r.status, 200, job.kind);
    const pub = r.envelope.data as Record<string, unknown>;
    assert.deepEqual(Object.keys(pub).sort(), Object.keys(mine).sort(), job.kind);
    for (const [key, value] of Object.entries(mine)) {
      if (Object.hasOwn(PUBLIC_OVERRIDES, key)) assert.deepEqual(pub[key], PUBLIC_OVERRIDES[key as keyof typeof PUBLIC_OVERRIDES], `${job.kind} ${key}`);
      else if ((key === 'grid' || key === 'lp') && value) assert.deepEqual(pub[key], { ...(value as object), canRegister: false }, `${job.kind} ${key}`);
      else assert.deepEqual(pub[key], value, `${job.kind} ${key}`);
    }
    assert.equal(job.kind === 'grid' ? !!pub.grid : job.kind === 'lp' ? !!pub.lp : !!pub.trade, true, job.kind);
  }
});

test('T-2 the public route answers 404 with no chain read for unknown, malformed, POST and never link-confirmed jobs', async t => {
  const c = chain(), calls: string[] = [], h = handler(t, true, undefined, countingRpc(c.rpc, calls));
  const expect404 = async (path: string, method = 'GET') => {
    calls.length = 0;
    const r = await h.request(path, method, method === 'POST' ? {} : undefined);
    assert.equal(r.status, 404, `${method} ${path}`);
    assert.deepEqual(r.envelope, { data: null, error: { code: 'not_found', message: 'Not found.' } }, `${method} ${path}`);
    assert.deepEqual(calls, [], `${method} ${path}`);
  };
  await expect404('/api/public/jobs/00000000-0000-4000-8000-000000000000');
  await expect404('/api/public/jobs/not-a-uuid');
  await expect404('/api/public/jobs/');
  const { job: running } = armedJob(h.web, h.worker, 'running');
  await expect404(`/api/public/jobs/${running.id}`, 'POST');
  await expect404(`/api/public/jobs/${running.id}/stop`);
  // One pending hire per owner: each never-confirmed job is checked, then closed before the next one is created.
  const close = (id: string) => { const j = h.worker.getJob(id)!; assert.equal(h.worker.casJob(j.id, j.state, j.version, 'cancelled', {}, testNow), true); };
  const draft = h.web.createJob({ owner, kind: 'grid', mode: 'live', pair: 'usdc-wnear', depositYocto: N }, testNow);
  await expect404(`/api/public/jobs/${draft.id}`); close(draft.id);
  for (const state of ['registered', 'policy_prepared', 'armed', 'cancelled'] as const) {
    const j = dclJob(h, { owner, kind: 'grid', mode: 'live', pair: 'usdc-wnear', depositYocto: N, gridV1: true });
    if (state !== 'registered') assert.equal(h.worker.casJob(j.id, j.state, j.version, state, {}, testNow), true);
    await expect404(`/api/public/jobs/${j.id}`);
    if (state !== 'cancelled') close(j.id);
  }
  calls.length = 0;
  assert.equal((await h.request(`/api/public/jobs/${running.id}`)).status, 200);
});

test('T-3 one public answer per job is shared for 30 s', async t => {
  let clock = testNow;
  const c = chain(), calls: string[] = [], h = handler(t, true, undefined, countingRpc(c.rpc, calls), () => clock), { job } = armedJob(h.web, h.worker, 'paused');
  const read = async () => { calls.length = 0; const r = await h.request(`/api/public/jobs/${job.id}`); return { status: r.status, calls: [...calls] }; };
  const first = await read();
  assert.equal(first.status, 200);
  assert.ok(first.calls.length > 0);
  assert.equal(first.calls.includes('account:owner'), false, 'the public view never reads the owner account');
  clock += PUBLIC_CACHE_MS - 1;
  assert.deepEqual(await read(), { status: 200, calls: [] });
  clock += 1;
  assert.ok((await read()).calls.length > 0);
});

test('T-4 a visitor session still cannot read or act on a public job through the owner routes', async t => {
  const h = handler(t), { job } = armedJob(h.web, h.worker, 'running');
  const token = 'c'.repeat(43), visitor = `fourlpha_session=${token}`;
  h.web.putSession(tokenHash(token), 'visitor.near', testNow, testNow + 600_000);
  assert.equal((await h.request(`/api/public/jobs/${job.id}`, 'GET', undefined, visitor)).status, 200);
  assert.equal((await h.request(`/api/jobs/${job.id}`, 'GET', undefined, visitor)).status, 404);
  for (const action of ['stop', 'retire', 'resume', 'cancel', 'reveal', 'link-confirmed']) {
    assert.equal((await h.request(`/api/jobs/${job.id}/${action}`, 'POST', {}, visitor)).status, 404, action);
  }
  assert.equal(h.web.getJob(job.id)!.state, 'running');
  assert.equal((await h.request(`/api/jobs/${job.id}/stop`, 'POST', {})).status, 401);
});
