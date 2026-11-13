// Audit evidence for Trade V0 part A (final audit 2026-11-10), included in `npm test`.
// Each case states the spec rule it checks, including the corrected resolution rules.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { YOCTO_PER_NEAR as N } from '../src/core/amounts.js';
import { tokenHash } from '../src/core/auth.js';
import { CoreError, record } from '../src/core/errors.js';
import { askMeme, memeJoin, memePrompt } from '../src/core/meme-ask.js';
import { findMemePool, parseMeme, parseMemePool, readMeme, readMemeStakes, type MemeView } from '../src/core/meme-cooking.js';
import { memeTick } from '../src/core/meme-cycle.js';
import { MEME, canEnterMeme, memeExit, memeResolution, screenMeme, staleMemeMark, validMemeSettings, type MemeAuction, type MemePosition } from '../src/core/meme-paper.js';
import { memePublicView } from '../src/core/meme-view.js';
import { createNearAi, type NearAi } from '../src/core/near-ai.js';
import { createNearRpc, DEFAULT_RPC, MemeNotFinalized } from '../src/core/near-rpc.js';
import { json, openStore } from '../src/core/store.js';
import { createHandler } from '../src/web/server.js';
import { dummyRpc, fixture, owner, stores, testNow } from './helpers.js';

function decoded(name: string): unknown {
  const r = record(record(fixture(name))?.result)!;
  return JSON.parse(Buffer.from(r.result as number[]).toString('utf8')) as unknown;
}
function auction(id = 2250, now = testNow): MemeAuction {
  const m = parseMeme({ ...record(decoded('mc-get_meme-2313'))!, id, start_timestamp_ms: String(now - 55 * MEME.minute),
    end_timestamp_ms: String(now + 5 * MEME.minute), total_staked: String(60n * N) }, id);
  return { memeId: id, owner: m.owner, startMs: Number(m.start_timestamp_ms), endMs: Number(m.end_timestamp_ms),
    last: { ...m, depositors: 10, creatorShare: 0.1, topShare: 0.1 }, samples: [], ask: null, outcome: null, tokenId: null, poolId: null, resolvedAt: null, updatedAt: now - MEME.minute };
}
function position(agentId: string, id = 2250, patch: Partial<MemePosition> = {}): MemePosition {
  return { id: `${agentId}:${id}`, agentId, memeId: id, symbol: 'NENE', status: 'deposited', closeCode: null, depositYocto: String(10n * N),
    netYocto: String(995n * N / 100n), tokens: null, poolId: null, tokenId: null, launchedAt: null, markYocto: null, markAt: null,
    peakBps: null, exitYocto: null, pnlYocto: null, openedAt: testNow, closedAt: null, version: 0, ...patch };
}
function setup(t: Parameters<typeof stores>[0]) {
  const db = stores({ after(fn) { t.after(() => { meme.close(); fn(); }); } }), meme = openStore(db.path, 'meme');
  let now = testNow;
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  let answer: MemeView = async (_contract, method) => {
    if (method === 'get_finalized_meme') throw new MemeNotFinalized();
    return { height: 1, value: null };
  };
  const rpc = dummyRpc({ view: async (contract, method, args) => { calls.push({ method, args }); return answer(contract, method, args); } });
  const ag = db.web.createMemeAgent(owner, { ...MEME.defaults }, now);
  meme.setMeta('meme_high_id', '2318');
  return { ...db, meme, ag, calls, rpc, setNow(n: number) { now = n; }, setAnswer(fn: MemeView) { answer = fn; },
    tick: (ai: NearAi | null = null) => memeTick({ store: meme, rpc, ai, now: () => now }) };
}
const stakes = Array.from({ length: 10 }, (_, i): [string, string] => [`stake${i}.near`, String(6n * N)]);
const PANIC = 'wasm execution failed with error: HostError(GuestPanic { panic_msg: "No value found for the given key" })';
const rpcText = (text: unknown) => createNearRpc(DEFAULT_RPC, async () => ({ status: 200, text: JSON.stringify(text) }), async () => {});

test('Audit 2: the not-finalized classification is limited to meme-cooking.near get_finalized_meme and carries no raw text', async () => {
  const panic = { jsonrpc: '2.0', result: { block_hash: 'x', block_height: 1, error: PANIC, logs: [] }, id: 1 };
  // Same panic text, other method on the same contract: the generic fixed view failure, not the meme class.
  await assert.rejects(rpcText(panic).view('meme-cooking.near', 'get_meme', { meme_id: 1 }),
    (e: unknown) => e instanceof CoreError && !(e instanceof MemeNotFinalized) && e.message === 'Chain view failed.');
  // Same panic text, same method name on another contract.
  await assert.rejects(rpcText(panic).view('other.near', 'get_finalized_meme', { meme_id: 1 }),
    (e: unknown) => e instanceof CoreError && !(e instanceof MemeNotFinalized));
  // The pinned read: fixed class, fixed message, none of the node's text.
  await assert.rejects(rpcText(panic).view('meme-cooking.near', 'get_finalized_meme', { meme_id: 1 }),
    (e: unknown) => e instanceof MemeNotFinalized && e.message === 'Meme is not finalized.' && !e.message.includes('wasm') && e.code === 'bad_request');
  // The error-object shape some nodes use for the same panic.
  const named = { jsonrpc: '2.0', error: { name: 'HANDLER_ERROR', cause: { name: 'CONTRACT_EXECUTION_ERROR', info: { vm_error: PANIC } }, code: -32000, data: PANIC }, id: 1 };
  await assert.rejects(rpcText(named).view('meme-cooking.near', 'get_finalized_meme', { meme_id: 1 }), (e: unknown) => e instanceof MemeNotFinalized);
  await assert.rejects(rpcText(named).view('meme-cooking.near', 'get_meme', { meme_id: 1 }), (e: unknown) => !(e instanceof MemeNotFinalized));
  // Another execution failure of the pinned read stays unreadable.
  const other = { jsonrpc: '2.0', error: { cause: { name: 'CONTRACT_EXECUTION_ERROR', info: { vm_error: 'Exceeded the prepaid gas.' } } }, id: 1 };
  assert.equal((await readMeme(rpcText(other).view, 1, true)).kind, 'unreadable');
  // readMeme never reports not-finalized for the live read, whatever the view throws.
  assert.equal((await readMeme(async () => { throw new MemeNotFinalized(); }, 1)).kind, 'unreadable');
});

test('Audit 3a: --from-id 2318 never reads the open auction 2313; --from-id 2312 stores it on the first tick', async t => {
  const live = decoded('mc-get_meme-2313');
  const answer: MemeView = async (_c, method, args) => {
    if (method === 'get_finalized_meme') throw new MemeNotFinalized();
    return { height: 1, value: args.meme_id === 2313 ? method === 'get_meme' ? { ...record(live)!, end_timestamp_ms: String(testNow + 20 * MEME.hour), start_timestamp_ms: String(testNow - MEME.hour) } : decoded('mc-get_meme_stakes-2313') : null };
  };
  const high = setup(t); high.setAnswer(answer);
  for (let i = 0; i < 10; i++) await high.tick();
  assert.equal(high.calls.filter(c => c.args.meme_id === 2313).length, 0);
  assert.equal(high.meme.getMemeAuction(2313), null);
  const low = setup(t); low.meme.setMeta('meme_high_id', '2312'); low.setAnswer(answer);
  const cycle = await low.tick();
  assert.equal(cycle.reads, 4, 'three probes plus the stakes of 2313, as in the live smoke tick');
  assert.equal(low.meme.getMemeAuction(2313)?.last.depositors, 3);
  assert.equal(low.meme.meta('meme_high_id'), '2313');
});

test('Audit 3b: read priority is marks, resolutions, entry-window auctions, discovery, then other refreshes', async t => {
  const h = setup(t);
  const second = h.web.createMemeAgent('second.near', { ...MEME.defaults }, testNow);
  h.meme.insertMemePosition(h.ag, position(h.ag.id, 7001, { status: 'open', tokens: '1', tokenId: 'nene-2250.meme-cooking.near', poolId: 8943, launchedAt: testNow }));
  h.meme.insertMemePosition(second, position(second.id, 7001, { status: 'open', tokens: '1', tokenId: 'nene-2250.meme-cooking.near', poolId: 8943, launchedAt: testNow }));
  const waiting = auction(7002); h.meme.saveMemeAuction(null, waiting); h.meme.insertMemePosition(h.ag, position(h.ag.id, 7002));
  h.meme.insertMemePosition(second, position(second.id, 7002));
  h.meme.saveMemeAuction(null, auction(7003));
  const far = auction(7004); far.endMs = testNow + 5 * MEME.hour; far.updatedAt = testNow - 11 * MEME.minute; h.meme.saveMemeAuction(null, far);
  const recent = auction(7005); recent.endMs = testNow + 5 * MEME.hour; recent.updatedAt = testNow - 9 * MEME.minute; h.meme.saveMemeAuction(null, recent);
  h.setAnswer(async (_c, method, args) => {
    if (method === 'get_finalized_meme') return { height: 1, value: null }; // live auction: pending (M-1)
    if (method === 'get_pool') return { height: 1, value: decoded('ref-get_pool-8943') };
    if (method === 'get_meme_stakes') return { height: 1, value: stakes };
    const id = Number(args.meme_id);
    return { height: 1, value: id >= 7002 && id <= 7005 ? { ...auction(id).last, end_timestamp_ms: String(id >= 7004 ? testNow + 5 * MEME.hour : testNow + 5 * MEME.minute) } : null };
  });
  await h.tick();
  const order = h.calls.map(c => `${c.method}:${String(c.args.meme_id ?? c.args.pool_id)}`);
  assert.deepEqual(order, ['get_pool:8943', 'get_finalized_meme:7002', 'get_meme:7002', 'get_meme_stakes:7002', 'get_meme:7003', 'get_meme_stakes:7003',
    'get_meme:2319', 'get_meme:2320', 'get_meme:2321', 'get_meme:7004', 'get_meme_stakes:7004']);
  // Shared reads: two agents on pool 8943 and on meme 7002 cost one read each; 7005 was refreshed 9 minutes ago and is not read.
});

test('Audit 3c: when marks use the whole budget, nothing below them in the priority order is read', async t => {
  const h = setup(t);
  for (let i = 0; i < 10; i++) {
    const ag = i === 0 ? h.ag : h.web.createMemeAgent(`o${i}.near`, { ...MEME.defaults, maxOpen: 3, capitalNear: 30 }, testNow);
    for (let j = 0; j < 3; j++) h.meme.insertMemePosition(ag, position(ag.id, 100 + i * 3 + j, { status: 'open', tokens: '1', tokenId: 'nene-2250.meme-cooking.near', poolId: i * 3 + j, launchedAt: testNow }));
  }
  h.meme.saveMemeAuction(null, auction(7003));
  h.setAnswer(async () => ({ height: 1, value: decoded('ref-get_pool-8943') }));
  const cycle = await h.tick();
  assert.equal(cycle.reads, 30); assert.ok(h.calls.every(c => c.method === 'get_pool'));
  assert.equal(cycle.budget, 4, 'the window read of 7003 and the three probes were skipped and counted');
  assert.equal(cycle.unreadable, 0, 'a budget skip is not an unreadable read');
  assert.equal(h.meme.meta('meme_high_id'), '2318');
});

test('Audit 4a: screen thresholds at their exact boundaries', () => {
  const a = auction(), soft = BigInt(a.last.soft_cap);
  const with_ = (patch: Partial<MemeAuction['last']>, more: Partial<MemeAuction> = {}): MemeAuction => ({ ...a, ...more, last: { ...a.last, ...patch } });
  assert.equal(screenMeme(a), null);
  assert.equal(screenMeme(with_({}, { endMs: a.startMs + MEME.day })), null, 'exactly 24 h passes');
  assert.equal(screenMeme(with_({}, { endMs: a.startMs + MEME.day + 1 })), 'too-long');
  assert.equal(screenMeme(with_({ depositors: 9 })), 'few-depositors');
  assert.equal(screenMeme(with_({ depositors: 10 })), null);
  assert.equal(screenMeme(with_({ creatorShare: 0.9 })), 'creator-funded');
  assert.equal(screenMeme(with_({ creatorShare: 0.8999 })), null);
  assert.equal(screenMeme(with_({ total_staked: String(soft / 2n) })), null);
  assert.equal(screenMeme(with_({ total_staked: String(soft / 2n - 1n) })), 'far-from-soft-cap');
  assert.equal(screenMeme(with_({ hard_cap: a.last.total_staked })), 'hard-cap', 'total equal to the hard cap fails');
  assert.equal(screenMeme(with_({ hard_cap: String(BigInt(a.last.total_staked) + 1n) })), null);
  assert.equal(screenMeme(with_({ hard_cap: null })), null);
});

test('Audit 4b: a deposited position is not refunded before the end while the record is still below the soft cap', async t => {
  const h = setup(t), a = auction(); // ends in 5 minutes, 60 NEAR of a 100 NEAR soft cap
  h.meme.saveMemeAuction(null, a); h.meme.insertMemePosition(h.ag, position(h.ag.id));
  h.setAnswer(async (_c, method, args) => {
    if (method === 'get_finalized_meme') return { height: 1, value: null }; // live auction: pending (M-1)
    return { height: 1, value: method === 'get_meme_stakes' ? stakes : args.meme_id === 2250 ? a.last : null };
  });
  await h.tick();
  assert.equal(h.meme.memePositions(h.ag.id)[0].status, 'deposited');
  h.setNow(a.endMs - 1); await h.tick();
  assert.equal(h.meme.memePositions(h.ag.id)[0].status, 'deposited');
  h.setNow(a.endMs); await h.tick();
  const p = h.meme.memePositions(h.ag.id)[0];
  assert.equal(p.closeCode, 'refunded'); assert.equal(p.pnlYocto, '0'); assert.equal(p.exitYocto, p.netYocto);
  assert.equal(h.meme.getMemeAuction(2250)?.outcome, 'failed');
});

test('Audit 4c: unresolved needs the full six hours; an unreadable finalized read waits', async t => {
  const h = setup(t), a = auction(); a.endMs = testNow - 1; a.last.total_staked = String(100n * N);
  h.meme.saveMemeAuction(null, a); h.meme.insertMemePosition(h.ag, position(h.ag.id));
  h.setAnswer(async () => { throw new Error('rpc down'); });
  h.setNow(a.endMs + 6 * MEME.hour - 1); await h.tick();
  assert.equal(h.meme.memePositions(h.ag.id)[0].status, 'deposited');
  h.setNow(a.endMs + 6 * MEME.hour); await h.tick();
  assert.equal(h.meme.memePositions(h.ag.id)[0].closeCode, 'unresolved');
  assert.equal(h.meme.getMemeAuction(2250)?.outcome, 'unresolved');
});

test('Audit 4d: a launched auction whose pool is never found closes unresolved at six hours and lets an ending agent end', async t => {
  const h = setup(t), a = auction(); a.endMs = testNow - 1;
  h.meme.saveMemeAuction(null, a); h.meme.insertMemePosition(h.ag, position(h.ag.id));
  h.web.casMemeAgent(h.ag, 'ending', 'owner-stopped', testNow);
  h.setAnswer(async (_c, method) => ({ height: 1, value: method === 'get_finalized_meme' ? decoded('mc-get_finalized_meme-2250') : method === 'get_number_of_pools' ? 9000 : method === 'get_pools' ? [] : null }));
  h.setNow(a.endMs + MEME.resolveMs - 1); await h.tick();
  assert.equal(h.meme.memePositions(h.ag.id)[0].status, 'deposited');
  assert.equal(h.meme.getMemeAgent(h.ag.id)?.state, 'ending');
  h.setNow(a.endMs + MEME.resolveMs); await h.tick();
  const p = h.meme.memePositions(h.ag.id)[0];
  assert.equal(p.status, 'closed'); assert.equal(p.closeCode, 'unresolved'); assert.equal(p.pnlYocto, '0');
  assert.equal(h.meme.getMemeAuction(2250)?.outcome, 'unresolved');
  assert.equal(h.meme.getMemeAgent(h.ag.id)?.state, 'ended');
});

test('Audit 4e: exits at the remaining boundaries and precedence pairs', () => {
  const a = { id: 'a', owner, state: 'running' as const, endReason: null, settings: { ...MEME.defaults }, createdAt: testNow, endsAt: testNow + 7 * MEME.day, updatedAt: testNow, version: 0 };
  const p = position('a', 2250, { status: 'open', launchedAt: testNow, peakBps: 0 });
  assert.equal(memeExit(a, p, 7001n * N / 1000n, testNow).pnlBps, -2999);
  assert.equal(memeExit(a, p, 7001n * N / 1000n, testNow).closeCode, null, '-2999 does not stop');
  assert.equal(memeExit(a, p, 7n * N, testNow).closeCode, 'stop');
  assert.equal(memeExit(a, { ...p, peakBps: 5000 }, 13n * N, testNow + 5 * MEME.hour).closeCode, 'trailing', 'trailing wins over time');
  assert.equal(memeExit(a, p, 10n * N, testNow + 4 * MEME.hour - 1).closeCode, null);
  assert.equal(memeExit(a, p, 13n * N, testNow).peakBps, 3000, 'the peak includes the current mark');
  assert.equal(memeExit(a, { ...p, peakBps: 5000 }, 13n * N, testNow).peakBps, 5000);
});

test('Audit 4f: an ending agent with a deposited position stays ending, then ends in the tick that closes it', async t => {
  const h = setup(t), a = auction();
  h.meme.saveMemeAuction(null, a); h.meme.insertMemePosition(h.ag, position(h.ag.id));
  h.web.casMemeAgent(h.ag, 'ending', 'owner-stopped', testNow);
  h.setAnswer(async (_c, method, args) => {
    if (method === 'get_finalized_meme') return { height: 1, value: null }; // live auction: pending (M-1)
    return { height: 1, value: method === 'get_meme_stakes' ? stakes : args.meme_id === 2250 ? a.last : null };
  });
  await h.tick();
  assert.equal(h.meme.getMemeAgent(h.ag.id)?.state, 'ending');
  h.setNow(a.endMs); await h.tick();
  assert.equal(h.meme.getMemeAgent(h.ag.id)?.state, 'ended'); assert.equal(h.meme.getMemeAgent(h.ag.id)?.endReason, 'owner-stopped');
});

test('Audit 4g: mark rows are written on a new peak and on every 10th mark only', async t => {
  const h = setup(t);
  h.meme.insertMemePosition(h.ag, position(h.ag.id, 2250, { status: 'open', tokens: String(N), tokenId: 'nene-2250.meme-cooking.near', poolId: 8943, launchedAt: testNow, depositYocto: String(2n * N) }));
  h.setAnswer(async (_c, method) => {
    if (method === 'get_finalized_meme') throw new MemeNotFinalized();
    return { height: 1, value: method === 'get_pool' ? decoded('ref-get_pool-8943') : null };
  });
  for (let i = 0; i < 10; i++) { h.setNow(testNow + i * MEME.minute); await h.tick(); }
  const marks = h.meme.memeLogs(h.ag.id, 500).filter(r => r.kind === 'mark');
  assert.deepEqual(marks.map(r => r.at).sort(), [testNow, testNow + 9 * MEME.minute]);
  assert.equal(h.meme.memePositions(h.ag.id)[0].markAt, testNow + 9 * MEME.minute);
});

test('Audit 5: the gate joins only on action join with confidence 70 or more, one shared ask for two agents', async t => {
  const a = auction();
  assert.equal(memeJoin({ action: 'skip', confidence: 100 }), false);
  assert.equal(memeJoin({ action: 'join', confidence: 100 }), true);
  assert.equal(memeJoin({ failure: 'ai-off' }), false); assert.equal(memeJoin(null), false);
  for (const data of [{ action: 'buy', confidence: 90 }, { action: 'join', confidence: 70.5 }, { action: 'join', confidence: -1 }, { action: 'JOIN', confidence: 90 },
    { action: 'join', confidence: null }, [{ action: 'join', confidence: 90 }], null, 'join', { action: 'join', Confidence: 90 }])
    assert.deepEqual(await askMeme(async () => ({ data }), a, testNow), { failure: 'malformed' });
  assert.deepEqual(await askMeme(async () => ({ data: { action: 'skip', confidence: 100 } }), a, testNow), { action: 'skip', confidence: 100 });
  for (const [reply, entries] of [[{ action: 'skip', confidence: 100 }, 0], [{ action: 'join', confidence: 100 }, 1]] as const) {
    const h = setup(t), second = h.web.createMemeAgent('second.near', { ...MEME.defaults }, testNow);
    h.meme.saveMemeAuction(null, auction());
    h.setAnswer(async (_c, method, args) => {
      if (method === 'get_finalized_meme') throw new MemeNotFinalized();
      return { height: 1, value: method === 'get_meme_stakes' ? stakes : args.meme_id === 2250 ? auction().last : null };
    });
    let asks = 0; const sent: string[] = [];
    const ai: NearAi = async (_system, user) => { asks++; sent.push(user); return { data: reply }; };
    await h.tick(ai);
    assert.equal(asks, 1);
    for (const ag of [h.ag, second]) assert.equal(h.meme.memePositions(ag.id).length, entries);
    assert.deepEqual(h.meme.getMemeAuction(2250)?.ask, reply);
    // What actually left the process: 13 numeric keys, no symbol, owner or staker account.
    const user = JSON.parse(sent[0]) as Record<string, unknown>;
    assert.equal(Object.keys(user).length, 13); assert.ok(Object.values(user).every(v => v === null || typeof v === 'number'));
    assert.ok(!sent[0].includes('REAL') && !sent[0].includes('.near'));
    // The stored rows carry closed codes and numbers only.
    assert.ok(!json(h.meme.memeLogs(null, 500)).includes('REAL'));
  }
});

test('Audit 6: API flag, sessions, ownership and the exact public shape', async t => {
  const h = setup(t), origin = 'https://app.test', token = 'a'.repeat(43), foreign = 'b'.repeat(43), expired = 'c'.repeat(43);
  h.web.putSession(tokenHash(token), owner, testNow, testNow + MEME.hour);
  h.web.putSession(tokenHash(foreign), 'foreign.near', testNow, testNow + MEME.hour);
  h.web.putSession(tokenHash(expired), owner, testNow - 2 * MEME.hour, testNow - MEME.hour);
  let rpcCalls = 0;
  const rpc = dummyRpc({ view: async () => { rpcCalls++; throw new Error(); }, query: async () => { rpcCalls++; throw new Error(); }, viewAccount: async () => { rpcCalls++; return null; } });
  async function request(path: string, method = 'GET', input?: unknown, session?: string, flag: 'on' | 'off' | 'unset' = 'on', requestOrigin = origin) {
    const handler = createHandler({ store: h.web, rpc, now: () => testNow, env: { host: '127.0.0.1', port: 8090, origin, liveHires: false, ...(flag === 'unset' ? {} : { memePaper: flag === 'on' }) } });
    const req = Object.assign(Readable.from(input === undefined ? [] : [Buffer.from(json(input))]), { url: path, method,
      headers: { host: 'app.test', origin: requestOrigin, cookie: session ? `fourlpha_session=${session}` : undefined, 'content-type': 'application/json' } }) as unknown as IncomingMessage;
    let out = ''; const res = { statusCode: 200, setHeader: () => {}, end: (s: string) => { out = s; } };
    await handler(req, res as unknown as ServerResponse);
    return { status: res.statusCode, body: JSON.parse(out) as { data: unknown; error?: { code: string; message: string } } };
  }
  const id = h.ag.id;
  // Fail-closed flag: every route, with or without a session, and with the flag undefined.
  for (const enabled of ['off', 'unset'] as const) for (const [path, method] of [['/api/meme/options', 'GET'], ['/api/meme', 'GET'], ['/api/meme', 'POST'], [`/api/meme/${id}`, 'GET'], [`/api/meme/${id}/stop`, 'POST']] as const) {
    const r = await request(path, method, method === 'POST' ? MEME.defaults : undefined, token, enabled);
    assert.equal(r.status, 404); assert.equal(r.body.error?.code, 'not_found');
  }
  assert.equal(h.web.memeAgents(owner).length, 1, 'nothing was created while the flag was off');
  // Sessions.
  assert.equal((await request('/api/meme')).status, 401);
  assert.equal((await request('/api/meme', 'GET', undefined, expired)).status, 401);
  assert.equal((await request('/api/meme', 'POST', MEME.defaults, expired)).status, 401);
  assert.equal((await request(`/api/meme/${id}/stop`, 'POST', {})).status, 401);
  assert.equal((await request(`/api/meme/${id}/stop`, 'POST', {}, expired)).status, 401);
  assert.equal((await request('/api/meme', 'POST', MEME.defaults, token, 'on', 'https://evil.test')).status, 403);
  assert.equal(h.web.getMemeAgent(id)?.state, 'running');
  // The list is the caller's own agents only.
  assert.deepEqual((await request('/api/meme', 'GET', undefined, foreign)).body.data, []);
  const mine = (await request('/api/meme', 'GET', undefined, token)).body.data as Record<string, unknown>[];
  assert.equal(mine.length, 1); assert.equal(mine[0].id, id); assert.equal(mine[0].isOwner, true);
  assert.deepEqual(Object.keys(mine[0]), ['id', 'owner', 'state', 'endReason', 'settings', 'createdAt', 'endsAt', 'isOwner']);
  // isOwner only for the owner's valid session.
  for (const [session, expected] of [[undefined, false], [foreign, false], [expired, false], [token, true]] as const)
    assert.equal(record(record((await request(`/api/meme/${id}`, 'GET', undefined, session)).body.data)?.agent)?.isOwner, expected);
  // Exact public shape (spec section 6), with one position, one auction and one log row.
  h.meme.saveMemeAuction(null, { ...auction(), ask: { action: 'join', confidence: 80 } });
  h.meme.insertMemePosition(h.ag, position(id));
  h.meme.logMeme({ agentId: id, kind: 'entry', memeId: 2250, at: testNow, data: { deposit: '1' } });
  h.meme.heartbeat('meme', testNow);
  const view = record((await request(`/api/meme/${id}`)).body.data)!;
  assert.deepEqual(Object.keys(view), ['agent', 'summary', 'positions', 'auctions', 'log', 'runs', 'meta']);
  assert.deepEqual(Object.keys(record(view.summary)!), ['deposited', 'open', 'closed', 'refunded', 'wins', 'pnlNear', 'winRateBps']);
  assert.deepEqual(Object.keys((view.positions as Record<string, unknown>[])[0]), ['meme_id', 'symbol', 'status', 'closeCode', 'depositNear', 'tokens', 'poolId', 'launchedAt',
    'markNear', 'markAt', 'pnlBps', 'peakBps', 'exitNear', 'pnlNear', 'openedAt', 'closedAt']);
  assert.deepEqual((view.auctions as unknown[])[0], { meme_id: 2250, symbol: 'REAL', endMs: testNow + 5 * MEME.minute, depositors: 10, totalStakedNear: '60', softCapNear: '100',
    screen: 'pass', ask: { action: 'join', confidence: 80 }, checkedAt: auction().updatedAt, windowOpensAt: testNow + 5 * MEME.minute - MEME.entryWindowMs,
    windowClosesAt: testNow + 5 * MEME.minute - MEME.entryBufferMs });
  assert.deepEqual(view.runs, []);
  assert.deepEqual((view.log as unknown[])[0], { kind: 'entry', meme_id: 2250, at: testNow, data: { deposit: '1' } });
  assert.deepEqual(view.meta, { lastTickAt: testNow });
  // Stop: owner only, and never on a non-running agent.
  assert.equal((await request(`/api/meme/${id}/stop`, 'POST', {}, foreign)).status, 404);
  assert.equal(h.web.getMemeAgent(id)?.state, 'running');
  assert.equal((await request(`/api/meme/${id}/stop`, 'POST', {}, token)).status, 200);
  assert.equal(h.web.getMemeAgent(id)?.endReason, 'owner-stopped');
  assert.equal((await request(`/api/meme/${id}/stop`, 'GET', undefined, token)).status, 404);
  assert.equal((await request('/api/meme/not-a-uuid/stop', 'POST', {}, token)).status, 404);
  // The owner limit reaches the caller as limit_reached, and bad JSON types are refused.
  for (let i = 0; i < 3; i++) assert.equal((await request('/api/meme', 'POST', MEME.defaults, token)).status, 201);
  assert.equal((await request('/api/meme', 'POST', MEME.defaults, token)).body.error?.code, 'limit_reached');
  for (const input of [{ ...MEME.defaults, termDays: '7' }, { ...MEME.defaults, maxOpen: 0 }, { ...MEME.defaults, perAuctionNear: 50, maxOpen: 3, capitalNear: 149 }, [10, 2, 20, 7]])
    assert.equal((await request('/api/meme', 'POST', input, foreign)).status, 400);
  assert.equal((await request('/api/meme', 'POST', { perAuctionNear: 50, maxOpen: 3, capitalNear: 500, termDays: 30 }, foreign)).status, 201);
  assert.equal(rpcCalls, 0, 'no meme route makes a chain call');
});

test('Audit 1: store roles around the paper tables and the money tables', t => {
  const h = setup(t), forbidden = { code: 'forbidden' };
  // The meme role and the tables that gate money actions.
  assert.throws(() => h.meme.insertAlert({ jobId: 'j', severity: 'critical', kind: 'outflow', detail: {}, createdAt: testNow }), forbidden);
  assert.throws(() => h.meme.useChallenge({ nonce: 'n', purpose: 'login', jobId: null, message: 'm', issuedAt: testNow }, testNow), forbidden);
  assert.throws(() => h.meme.putWatch('j', { block: 1, holdings: '{}', updatedAt: testNow }), forbidden);
  assert.throws(() => h.meme.putSession('h', owner, testNow, testNow + 1), forbidden);
  assert.throws(() => h.meme.getSecrets('w'), forbidden);
  assert.throws(() => h.meme.acquireWorkerLock(1, testNow), forbidden);
  assert.throws(() => h.meme.heartbeat('watchdog', testNow), forbidden);
  for (const key of ['watch_blind:j', 'quota:w', 'reveal_delivered:j', 'heartbeat:watchdog', 'worker_lock']) assert.throws(() => h.meme.setMeta(key, '0'), forbidden);
  assert.throws(() => h.meme.createMemeAgent(owner, { ...MEME.defaults }, testNow), forbidden);
  assert.throws(() => h.meme.casMemeAgent(h.ag, 'ending', 'owner-stopped', testNow), forbidden, 'only the web records an owner stop');
  assert.throws(() => h.meme.casMemeAgent(h.ag, 'ending', 'term-ended', h.ag.endsAt - 1), forbidden, 'no term end before the term');
  assert.throws(() => h.meme.casMemeAgent(h.ag, 'ended', null, testNow), forbidden, 'running never jumps to ended');
  // The web role: create and owner stop only.
  const a = auction(), p = position(h.ag.id);
  assert.throws(() => h.web.saveMemeAuction(null, a), forbidden);
  assert.throws(() => h.web.insertMemePosition(h.ag, p), forbidden);
  assert.throws(() => h.web.casMemePosition(p, p), forbidden);
  assert.throws(() => h.web.logMeme({ agentId: null, kind: 'cycle', memeId: null, at: testNow, data: {} }), forbidden);
  assert.throws(() => h.web.pruneMemeLogs(), forbidden);
  assert.throws(() => h.web.heartbeat('meme', testNow), forbidden);
  assert.throws(() => h.web.casMemeAgent(h.ag, 'ending', 'term-ended', h.ag.endsAt), forbidden);
  assert.throws(() => h.web.casMemeAgent({ ...h.ag, state: 'ending' }, 'ended', null, testNow), forbidden);
  // The money processes cannot touch the paper tables.
  for (const s of [h.worker, h.watch]) {
    assert.throws(() => s.createMemeAgent(owner, { ...MEME.defaults }, testNow), forbidden);
    assert.throws(() => s.casMemeAgent(h.ag, 'ending', 'owner-stopped', testNow), forbidden);
    assert.throws(() => s.saveMemeAuction(null, a), forbidden);
    assert.throws(() => s.insertMemePosition(h.ag, p), forbidden);
    assert.throws(() => s.logMeme({ agentId: null, kind: 'cycle', memeId: null, at: testNow, data: {} }), forbidden);
  }
  // An entry is refused once the web has moved the agent (stale version), so a stop cannot be raced into a new position.
  h.web.casMemeAgent(h.ag, 'ending', 'owner-stopped', testNow);
  assert.equal(h.meme.insertMemePosition(h.ag, p), false);
});

const windowAnswer = (endMs: number, broken: 'none' | 'stakes' | 'meme' = 'none'): MemeView => async (_c, method, args) => {
  if (method === 'get_finalized_meme') throw new MemeNotFinalized();
  if (method === 'get_meme_stakes') { if (broken === 'stakes') throw new Error('down'); return { height: 1, value: stakes }; }
  if (args.meme_id !== 2250) return { height: 1, value: null };
  if (broken === 'meme') throw new Error('down');
  return { height: 1, value: { ...auction().last, end_timestamp_ms: String(endMs) } };
};
const counting = () => { const c = { asks: 0, ai: (async () => { c.asks++; return { data: { action: 'join', confidence: 100 } }; }) as NearAi }; return c; };

test('Audit 4h: the tick screens, asks and enters only inside the entry window', async t => {
  const h = setup(t), a = auction(), ai = counting(); a.endMs = testNow + 30 * MEME.minute; a.updatedAt = testNow - 11 * MEME.minute;
  a.last.end_timestamp_ms = String(a.endMs);
  h.meme.saveMemeAuction(null, a); h.setAnswer(windowAnswer(a.endMs));
  await h.tick(ai.ai);
  assert.equal(h.meme.getMemeAuction(2250)?.updatedAt, testNow, 'the auction was refreshed this tick, so only the window keeps it out');
  assert.equal(ai.asks, 0); assert.equal(h.meme.getMemeAuction(2250)?.ask, null); assert.equal(h.meme.memePositions(h.ag.id).length, 0);
  h.setNow(a.endMs - 10 * MEME.minute - 1); await h.tick(ai.ai);
  assert.equal(ai.asks, 0); assert.equal(h.meme.memePositions(h.ag.id).length, 0);
  h.setNow(a.endMs - 10 * MEME.minute); await h.tick(ai.ai);
  assert.equal(ai.asks, 1); assert.equal(h.meme.memePositions(h.ag.id).length, 1);
  const late = setup(t), b = auction(), ai2 = counting(); b.endMs = testNow + MEME.minute; b.last.end_timestamp_ms = String(b.endMs);
  late.meme.saveMemeAuction(null, b); late.setAnswer(windowAnswer(b.endMs));
  await late.tick(ai2.ai);
  assert.equal(ai2.asks, 0, 'exactly 60 s before the end is outside the window'); assert.equal(late.meme.memePositions(late.ag.id).length, 0);
});

test('Audit 4i: an auction whose reads failed this tick is not screened, asked or entered on stored data', async t => {
  for (const broken of ['stakes', 'meme'] as const) {
    const h = setup(t), ai = counting(); h.meme.saveMemeAuction(null, auction()); h.setAnswer(windowAnswer(auction().endMs, broken));
    const cycle = await h.tick(ai.ai);
    assert.equal(cycle.unreadable, 1); assert.equal(ai.asks, 0); assert.equal(h.meme.memePositions(h.ag.id).length, 0);
    assert.equal(h.meme.memeLogs(null, 100).filter(r => r.kind === 'screen').length, 0);
    h.setAnswer(windowAnswer(auction().endMs)); h.setNow(testNow + MEME.minute); await h.tick(ai.ai);
    assert.equal(ai.asks, 1); assert.equal(h.meme.memePositions(h.ag.id).length, 1);
  }
});

test('Audit 5b: no ask while no running agent could enter; the ask happens once one can', async t => {
  const h = setup(t), ai = counting(); h.meme.saveMemeAuction(null, auction()); h.setAnswer(windowAnswer(auction().endMs));
  h.web.casMemeAgent(h.ag, 'ending', 'owner-stopped', testNow);
  await h.tick(ai.ai);
  assert.equal(ai.asks, 0); assert.equal(h.meme.getMemeAuction(2250)?.ask, null);
  const next = h.web.createMemeAgent('next.near', { ...MEME.defaults }, testNow);
  h.setNow(testNow + MEME.minute); await h.tick(ai.ai);
  assert.equal(ai.asks, 1); assert.equal(h.meme.memePositions(next.id).length, 1);
});

test('Audit 3d: discovery edge cases, the heartbeat and the sample cap', async t => {
  const live = record(decoded('mc-get_meme-2313'))!;
  const h = setup(t);
  h.setAnswer(async (_c, method, args) => {
    if (method === 'get_finalized_meme') throw new MemeNotFinalized();
    if (method === 'get_meme_stakes') return { height: 1, value: stakes };
    // 2319: another deposit token. 2320: a record that already ended. 2321: absent.
    return { height: 1, value: args.meme_id === 2319 ? { ...live, id: 2319, deposit_token_id: 'usdc.near' } :
      args.meme_id === 2320 ? { ...live, id: 2320, start_timestamp_ms: String(testNow - MEME.hour), end_timestamp_ms: String(testNow) } : null };
  });
  await h.tick();
  assert.equal(h.meme.meta('meme_high_id'), '2320', 'any non-null id raises high');
  assert.equal(h.meme.getMemeAuction(2319), null); assert.equal(h.meme.getMemeAuction(2320), null);
  assert.equal(h.meme.readHeartbeat('meme'), testNow); assert.equal(h.web.readHeartbeat('meme'), testNow);
  const far = auction(2400); far.endMs = testNow + 20 * MEME.hour; far.last.end_timestamp_ms = String(far.endMs); far.updatedAt = testNow - 10 * MEME.minute;
  h.meme.saveMemeAuction(null, far);
  h.setAnswer(async (_c, method, args) => {
    if (method === 'get_finalized_meme') throw new MemeNotFinalized();
    return { height: 1, value: method === 'get_meme_stakes' ? stakes : args.meme_id === 2400 ? far.last : null };
  });
  for (let i = 0; i < 63; i++) { h.setNow(testNow + i * 10 * MEME.minute); await h.tick(); }
  const stored = h.meme.getMemeAuction(2400)!;
  assert.equal(stored.samples.length, 60); assert.equal(stored.samples.at(-1)?.at, testNow + 62 * 10 * MEME.minute);
  assert.equal(stored.samples[0].at, testNow + 3 * 10 * MEME.minute, 'the oldest samples were dropped');
});

test('Audit 4j: per-agent rules, exits and resolution at the boundaries the build suite leaves open', () => {
  const a = { id: 'a', owner, state: 'running' as const, endReason: null, settings: { perAuctionNear: 10, maxOpen: 2, capitalNear: 30, termDays: 7 },
    createdAt: testNow, endsAt: testNow + 7 * MEME.day, updatedAt: testNow, version: 0 };
  // Max open on its own: capital 30 would allow a third 10 NEAR deposit, maxOpen 2 does not.
  assert.equal(canEnterMeme({ ...a, settings: { ...a.settings, capitalNear: 500 } }, [position('a', 2), position('a', 3)], 1, testNow), false);
  assert.equal(canEnterMeme(a, [position('a', 2)], 1, testNow), true);
  // Capital exactly used is allowed, one NEAR short is not.
  assert.equal(canEnterMeme({ ...a, settings: { ...a.settings, capitalNear: 20 } }, [position('a', 2)], 1, testNow), true);
  assert.equal(canEnterMeme({ ...a, settings: { ...a.settings, capitalNear: 19 } }, [position('a', 2)], 1, testNow), false);
  // Closed positions free both the slot and the capital.
  assert.equal(canEnterMeme({ ...a, settings: { ...a.settings, capitalNear: 20 } }, [position('a', 2), position('a', 3, { status: 'closed' }), position('a', 4, { status: 'closed' })], 1, testNow), true);
  // Entry cutoff: exactly two hours before the term end.
  assert.equal(canEnterMeme(a, [], 1, a.endsAt - 2 * MEME.hour - 1), true);
  assert.equal(canEnterMeme(a, [], 1, a.endsAt - 2 * MEME.hour), false);
  // Trailing is not armed below a 2000 peak.
  const open = position('a', 2250, { status: 'open', launchedAt: testNow });
  assert.equal(memeExit(a, { ...open, peakBps: 1999 }, 104n * N / 10n, testNow).closeCode, null);
  assert.equal(memeExit(a, { ...open, peakBps: 2000 }, 104n * N / 10n, testNow).closeCode, 'trailing');
  // A stale mark only closes for an ending agent.
  const old = { ...open, markYocto: String(9n * N), markAt: testNow };
  assert.equal(staleMemeMark(a, old, testNow + MEME.hour), false);
  assert.equal(staleMemeMark({ ...a, state: 'ending' }, old, testNow + MEME.hour), true);
  // After the end the record read now decides, not the stored one.
  const au = auction(); au.endMs = testNow - 1; au.last.total_staked = String(100n * N);
  assert.equal(memeResolution(au, { ...au.last, total_staked: String(50n * N) }, testNow), 'refunded');
  assert.equal(memeResolution(au, { ...au.last, total_staked: au.last.soft_cap }, testNow), null, 'at the soft cap: wait for finalize');
  assert.equal(memeResolution({ ...au, last: { ...au.last, total_staked: String(50n * N) } }, { ...au.last }, testNow), null);
  assert.equal(memeResolution(au, null, testNow), null, 'settled with a stored total at the soft cap: wait');
});

test('Audit 6b: each settings bound on its own, the term length and the closed-only summary', t => {
  const ok = (r: Record<string, unknown>) => validMemeSettings(r);
  assert.equal(ok({ perAuctionNear: 50, maxOpen: 3, capitalNear: 150, termDays: 30 }), true);
  assert.equal(ok({ perAuctionNear: 1, maxOpen: 1, capitalNear: 1, termDays: 7 }), true);
  assert.equal(ok({ perAuctionNear: 51, maxOpen: 1, capitalNear: 500, termDays: 7 }), false, 'perAuctionNear above 50 with ample capital');
  assert.equal(ok({ perAuctionNear: 1, maxOpen: 4, capitalNear: 500, termDays: 7 }), false, 'maxOpen above 3 with ample capital');
  assert.equal(ok({ perAuctionNear: 1, maxOpen: 0, capitalNear: 500, termDays: 7 }), false);
  assert.equal(ok({ perAuctionNear: 0, maxOpen: 1, capitalNear: 500, termDays: 7 }), false);
  assert.equal(ok({ perAuctionNear: 10, maxOpen: 2, capitalNear: 20, termDays: 14 }), false);
  const h = setup(t);
  assert.equal(h.ag.endsAt, testNow + 7 * MEME.day);
  assert.equal(h.web.createMemeAgent('long.near', { ...MEME.defaults, termDays: 30 }, testNow).endsAt, testNow + 30 * MEME.day);
  const done = { status: 'closed' as const, closedAt: testNow };
  h.meme.insertMemePosition(h.ag, position(h.ag.id, 1, { ...done, closeCode: 'time', exitYocto: String(11n * N), pnlYocto: String(N) }));
  h.meme.insertMemePosition(h.ag, position(h.ag.id, 2, { ...done, closeCode: 'stop', exitYocto: String(7n * N), pnlYocto: String(-3n * N) }));
  h.meme.insertMemePosition(h.ag, position(h.ag.id, 3, { ...done, closeCode: 'refunded', exitYocto: String(995n * N / 100n), pnlYocto: '0' }));
  h.meme.insertMemePosition(h.ag, position(h.ag.id, 4, { status: 'open', tokens: '1', poolId: 8943, tokenId: 'nene-2250.meme-cooking.near', launchedAt: testNow, markYocto: String(15n * N), markAt: testNow, peakBps: 5000 }));
  h.meme.insertMemePosition(h.ag, position(h.ag.id, 5));
  const view = memePublicView(h.web, h.web.getMemeAgent(h.ag.id)!, testNow);
  assert.deepEqual(view.summary, { deposited: 1, open: 1, closed: 3, refunded: 1, wins: 1, pnlNear: '-2', winRateBps: 5000 });
  const marked = view.positions.find(p => p.meme_id === 4)!;
  assert.equal(marked.pnlBps, 5000); assert.equal(marked.markNear, '15'); assert.equal(marked.pnlNear, null);
});

test('Audit 2b: reader and pool-finder edge cases', async () => {
  const live = record(decoded('mc-get_meme-2313'))!, view = (value: unknown): MemeView => async () => ({ height: 1, value });
  assert.equal((await readMeme(view(live), 2314)).kind, 'unreadable', 'a record with another id is not accepted');
  assert.equal((await readMeme(view({ ...record(decoded('mc-get_finalized_meme-2250'))!, id: 2251 }), 2250, true)).kind, 'unreadable');
  assert.equal((await readMeme(view({ ...live, total_supply: '0' }), 2313)).kind, 'unreadable');
  assert.equal((await readMeme(view({ ...live, hard_cap: undefined, team_allocation: undefined }), 2313)).kind, 'ok', 'hard cap and team allocation may be absent');
  assert.equal((await readMemeStakes(view([['a.near', '1'], ['a.near', '2']]), 1)).kind, 'unreadable');
  assert.equal((await readMemeStakes(view([['a.near', '-1']]), 1)).kind, 'unreadable');
  const pool = parseMemePool(decoded('ref-get_pool-8943'));
  assert.equal(findMemePool([pool], 0, 250), null, 'id 250 does not match the token of id 2250');
  assert.equal(findMemePool([pool], 0, 50), null);
  assert.deepEqual(findMemePool([{ ...pool, pool_kind: 'RATED_SWAP' }, pool], 100, 2250), { poolId: 101, tokenId: 'nene-2250.meme-cooking.near' });
  const a = auction(); a.samples = [{ at: testNow - 10 * MEME.minute, totalStaked: String(50n * N), depositors: 8 }];
  assert.equal(memePrompt(a, testNow).stakedChange30mNear, null); assert.equal(memePrompt(a, testNow).depositorsChange30m, null);
  a.samples = [{ at: testNow - 25 * MEME.minute, totalStaked: String(50n * N), depositors: 8 }];
  assert.equal(memePrompt(a, testNow).stakedChange30mNear, 10);
});

test('Audit 4k: a pool without wNEAR is never used for a mark', async t => {
  const h = setup(t);
  h.meme.insertMemePosition(h.ag, position(h.ag.id, 2250, { status: 'open', tokens: String(N), tokenId: 'nene-2250.meme-cooking.near', poolId: 9000, launchedAt: testNow }));
  h.setAnswer(async (_c, method) => {
    if (method === 'get_finalized_meme') throw new MemeNotFinalized();
    return { height: 1, value: method === 'get_pool' ? { ...record(decoded('ref-get_pool-8943'))!, token_account_ids: ['nene-2250.meme-cooking.near', 'usdc.near'] } : null };
  });
  await h.tick();
  const p = h.meme.memePositions(h.ag.id)[0];
  assert.equal(p.markYocto, null); assert.equal(p.status, 'open');
  assert.deepEqual(h.meme.memeLogs(h.ag.id).filter(r => r.kind === 'mark').map(r => r.data), [{ failure: 'unreadable' }]);
});

test('Audit 5c: the client sends the key only as the bearer header to the pinned endpoint and caps the body at 16 KiB', async () => {
  const key = 'audit-fake-key-0123456789';
  const seen: { url: string; method?: string; auth: string | undefined; body: string }[] = [];
  const reply = (pad: number) => JSON.stringify({ choices: [{ message: { content: '{"action":"join","confidence":70}' } }], pad: 'x'.repeat(pad) });
  const base = Buffer.byteLength(reply(0));
  const send = (text: string): typeof fetch => async (url, init) => {
    seen.push({ url: String(url), method: init?.method, auth: (init?.headers as Record<string, string> | undefined)?.Authorization, body: String(init?.body) });
    return new Response(text);
  };
  const fits = await createNearAi(key, 'model-x', send(reply(16_384 - base)))('system text', 'user text');
  assert.deepEqual(fits, { data: { action: 'join', confidence: 70 } });
  const over = await createNearAi(key, 'model-x', send(reply(16_385 - base)))('system text', 'user text');
  assert.deepEqual(over, { data: null, error: 'malformed' }, 'a valid answer one byte over 16 KiB is refused');
  assert.equal(seen[0].url, 'https://cloud-api.near.ai/v1/chat/completions'); assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].auth, `Bearer ${key}`);
  const sent = JSON.parse(seen[0].body) as Record<string, unknown>;
  assert.equal(sent.model, 'model-x'); assert.ok(!seen[0].body.includes(key), 'the key is not in the request body');
  assert.deepEqual(sent.messages, [{ role: 'system', content: 'system text' }, { role: 'user', content: 'user text' }]);
  for (const failing of [async () => { throw new Error(`boom ${key}`); }, async () => new Response(`denied ${key}`, { status: 401 }), async () => new Response(`not json ${key}`)] as (typeof fetch)[])
    assert.ok(!JSON.stringify(await createNearAi(key, undefined, failing)('s', 'u')).includes(key), 'no failure carries the key or the reply text');
});

test('Audit 12: the compiled runtime graph of the paper code, re-exports and dynamic imports included, reaches no money module', () => {
  const forbidden = ['outlayer.js', 'secrets.js', 'ops.js', 'policy.js', 'watchdog.js', 'hire.js', 'grid.js', 'lp.js', 'rhea-dcl.js', 'rhea-classic.js'];
  const roots = [resolve('dist/src/meme/main.js'), ...readdirSync('dist/src/core').filter(p => /^(meme-.*|near-ai)\.js$/.test(p)).map(p => resolve('dist/src/core', p))];
  const seen = new Set<string>();
  const walk = (path: string) => {
    if (seen.has(path)) return; seen.add(path);
    const source = readFileSync(path, 'utf8');
    for (const m of source.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (spec.startsWith('.')) walk(resolve(dirname(path), spec));
    }
  };
  roots.forEach(walk);
  const names = [...seen].map(p => p.split(sep).at(-1)!);
  assert.ok(names.includes('store.js') && names.includes('near-rpc.js'), 'the walk followed the graph');
  assert.deepEqual(names.filter(n => forbidden.includes(n)), []);
});

test('Audit 4l: a failing screen stops the ask and the entry, and is logged once with its first code', async t => {
  const h = setup(t), ai = counting(), few = stakes.slice(0, 9); h.meme.saveMemeAuction(null, auction());
  h.setAnswer(async (_c, method, args) => {
    if (method === 'get_finalized_meme') throw new MemeNotFinalized();
    return { height: 1, value: method === 'get_meme_stakes' ? few : args.meme_id === 2250 ? auction().last : null };
  });
  for (let i = 0; i < 3; i++) { h.setNow(testNow + i * MEME.minute); await h.tick(ai.ai); }
  assert.equal(ai.asks, 0); assert.equal(h.meme.getMemeAuction(2250)?.ask, null); assert.equal(h.meme.memePositions(h.ag.id).length, 0);
  assert.deepEqual(h.meme.memeLogs(null, 100).filter(r => r.kind === 'screen').map(r => r.data), [{ code: 'few-depositors' }]);
  assert.equal(h.meme.memeLogs(null, 100).filter(r => r.kind === 'ask').length, 0);
});

test('Audit 4m: at the term end an open position closes ended at the current mark in the same tick', async t => {
  const h = setup(t);
  h.meme.insertMemePosition(h.ag, position(h.ag.id, 2250, { status: 'open', tokens: String(N), tokenId: 'nene-2250.meme-cooking.near', poolId: 8943, launchedAt: h.ag.endsAt - MEME.hour, depositYocto: String(2n * N) }));
  h.setAnswer(async (_c, method) => {
    if (method === 'get_finalized_meme') throw new MemeNotFinalized();
    return { height: 1, value: method === 'get_pool' ? decoded('ref-get_pool-8943') : null };
  });
  h.setNow(h.ag.endsAt - 1); await h.tick();
  assert.equal(h.meme.memePositions(h.ag.id)[0].status, 'open'); assert.equal(h.meme.getMemeAgent(h.ag.id)?.state, 'running');
  h.setNow(h.ag.endsAt); await h.tick();
  const p = h.meme.memePositions(h.ag.id)[0];
  assert.equal(p.closeCode, 'ended'); assert.equal(p.exitYocto, '2001016598386499340534629');
  assert.equal(p.pnlYocto, String(2001016598386499340534629n - 2n * N));
  assert.equal(h.meme.getMemeAgent(h.ag.id)?.state, 'ended'); assert.equal(h.meme.getMemeAgent(h.ag.id)?.endReason, 'term-ended');
});

test('Audit 1b: position updates are compare-and-set on the version, and only an ignored id still raises high', async t => {
  const h = setup(t), p = position(h.ag.id);
  assert.equal(h.meme.insertMemePosition(h.ag, p), true);
  assert.equal(h.meme.insertMemePosition(h.ag, { ...p, id: 'other-id' }), false, 'one position per agent and meme');
  assert.equal(h.meme.casMemePosition(p, { ...p, markYocto: '1' }), true);
  assert.equal(h.meme.casMemePosition(p, { ...p, markYocto: '2' }), false, 'a stale version does not write');
  assert.equal(h.meme.memePositions(h.ag.id)[0].markYocto, '1'); assert.equal(h.meme.memePositions(h.ag.id)[0].version, 1);
  const live = record(decoded('mc-get_meme-2313'))!;
  h.setAnswer(async (_c, method, args) => {
    if (method === 'get_finalized_meme') throw new MemeNotFinalized();
    return { height: 1, value: method === 'get_meme' && args.meme_id === 2320 ? { ...live, id: 2320, deposit_token_id: 'usdc.near' } : null };
  });
  await h.tick();
  assert.equal(h.meme.meta('meme_high_id'), '2320'); assert.equal(h.meme.getMemeAuction(2320), null);
});

test('Audit 4n: pending finalization refunds only from a below-cap record after the end; a null record waits and the settled-failure panic refunds', async t => {
  assert.equal((await readMeme(rpcText(fixture('mc-get_finalized_meme-2250-at-219636931')).view, 2250, true)).kind, 'pending');
  const live = await rpcText(fixture('mc-get_meme-2250-at-219636931')).view('meme-cooking.near', 'get_meme', { meme_id: 2250 });
  assert.equal(record(live.value)?.id, 2250, 'the same block has a non-null auction record');
  assert.equal(record(live.value)?.start_timestamp_ms, undefined, 'the historical fixture has no required start timestamp field');
  const chain = setup(t), recorded = auction();
  chain.meme.saveMemeAuction(null, recorded); chain.meme.insertMemePosition(chain.ag, position(chain.ag.id));
  chain.setAnswer(async (_c, method, args) => ({ height: 1, value: method === 'get_finalized_meme' ? decoded('mc-get_finalized_meme-2250-at-219636931') :
    method === 'get_meme_stakes' ? stakes : args.meme_id === 2250 ? recorded.last : null }));
  chain.setNow(recorded.endMs - 1); await chain.tick();
  assert.equal(chain.meme.memePositions(chain.ag.id)[0].status, 'deposited');
  for (const mode of ['record', 'at-cap', 'null', 'panic'] as const) {
    const h = setup(t), a = auction();
    h.meme.saveMemeAuction(null, a); h.meme.insertMemePosition(h.ag, position(h.ag.id));
    h.setAnswer(async (_c, method, args) => {
      if (method === 'get_finalized_meme' && mode === 'panic') throw new MemeNotFinalized();
      return { height: 1, value: method === 'get_finalized_meme' || mode === 'null' ? null :
        args.meme_id === 2250 ? { ...a.last, total_staked: mode === 'at-cap' ? a.last.soft_cap : a.last.total_staked } : null };
    });
    h.setNow(a.endMs + MEME.minute); await h.tick();
    const p = h.meme.memePositions(h.ag.id)[0];
    if (mode === 'record' || mode === 'panic') {
      assert.equal(p.closeCode, 'refunded'); assert.equal(p.pnlYocto, '0'); assert.equal(p.exitYocto, p.netYocto);
    } else assert.equal(p.status, 'deposited', 'pending null or a record at the cap must wait');
    assert.equal(h.calls.filter(c => c.method === 'get_meme' && c.args.meme_id === 2250).length, mode === 'panic' ? 0 : 1);
  }
});

test('Audit 2c: the log keeps the last 2,000 rows per agent and 5,000 shared rows', async t => {
  const h = setup(t);
  for (let i = 0; i < 2003; i++) h.meme.logMeme({ agentId: h.ag.id, kind: 'mark', memeId: 1, at: testNow + i, data: {} });
  for (let i = 0; i < 5003; i++) h.meme.logMeme({ agentId: null, kind: 'cycle', memeId: null, at: testNow + i, data: {} });
  h.setNow(testNow + 10_000); await h.tick(); // the tick adds one shared cycle row, then prunes
  const mine = h.meme.memeLogs(h.ag.id, 10_000).filter(r => r.agentId === h.ag.id), shared = h.meme.memeLogs(null, 10_000);
  assert.equal(mine.length, 2000); assert.equal(mine.at(-1)?.at, testNow + 3, 'the oldest agent rows went');
  assert.equal(shared.length, 5000); assert.equal(shared[0].at, testNow + 10_000); assert.equal(shared.at(-1)?.at, testNow + 4);
});

// Added in the re-check of 2026-11-11.
test('Audit 4o: the settled-failure panic refunds whatever the stored total says, and a launch found after six hours stays launched', async t => {
  const h = setup(t), a = auction(); a.last.total_staked = a.last.soft_cap; // stored total at the soft cap, auction still before its end
  h.meme.saveMemeAuction(null, a); h.meme.insertMemePosition(h.ag, position(h.ag.id));
  h.setAnswer(async (_c, method) => { if (method === 'get_finalized_meme') throw new MemeNotFinalized(); return { height: 1, value: null }; });
  await h.tick();
  assert.equal(h.meme.memePositions(h.ag.id)[0].closeCode, 'refunded'); assert.equal(h.meme.getMemeAuction(2250)?.outcome, 'failed');
  const late = setup(t), b = auction(); b.endMs = testNow - 7 * MEME.hour;
  late.meme.saveMemeAuction(null, b); late.meme.insertMemePosition(late.ag, position(late.ag.id));
  late.setAnswer(async (_c, method) => ({ height: 1, value: method === 'get_finalized_meme' ? decoded('mc-get_finalized_meme-2250') :
    method === 'get_number_of_pools' ? 8950 : method === 'get_pools' ? Array(43).fill(null).concat([decoded('ref-get_pool-8943')]) :
    method === 'get_pool' ? decoded('ref-get_pool-8943') : null }));
  await late.tick();
  assert.equal(late.meme.memePositions(late.ag.id)[0].status, 'open'); assert.equal(late.meme.getMemeAuction(2250)?.outcome, 'launched');
});

test('Audit 3e: a live record without start_timestamp_ms keeps its first stored time, and cycle rows count invalid answers', async t => {
  // Chain evidence: get_meme(2319) read live on 2026-11-11 03:01 UTC (block 224007272) and get_meme(2250) at block 219636931 carry no
  // start_timestamp_ms key. In the public list 2273 of 2320 auctions and 260 of 267 launched ones have no start.
  const real = decoded('mc-get_meme-2319');
  assert.equal(Object.hasOwn(record(real)!, 'start_timestamp_ms'), false);
  assert.equal((await readMeme(async () => ({ height: 1, value: real }), 2319)).kind, 'ok');
  const h = setup(t), open = { ...record(real)!, id: 2319, end_timestamp_ms: String(testNow + 12 * MEME.hour), total_staked: String(60n * N) };
  h.setAnswer(async (_c, method, args) => ({ height: 1, value: method === 'get_finalized_meme' ? null : method === 'get_meme_stakes' ? stakes : args.meme_id === 2319 ? open : null }));
  const cycle = await h.tick();
  assert.equal(h.meme.getMemeAuction(2319)?.startMs, testNow); assert.equal(h.meme.meta('meme_high_id'), '2319');
  assert.equal(h.meme.getMemeAuction(2319)?.last.start_timestamp_ms, null);
  assert.deepEqual(cycle, { reads: 4, budget: 0, unreadable: 0, invalid: 0, overrun: false });
  // The logged row adds log-only scan facts for the Run log; the returned cycle is unchanged.
  assert.deepEqual(h.meme.memeLogs(null).find(r => r.kind === 'cycle')?.data, { ...cycle, probed: [2319, 2321], discovered: [2319], refreshed: 1, tracked: 1, inWindow: 0,
    nextWindowAt: Number(open.end_timestamp_ms) - MEME.entryWindowMs });
  h.setNow(testNow + 10 * MEME.minute); await h.tick();
  assert.equal(h.meme.getMemeAuction(2319)?.updatedAt, testNow + 10 * MEME.minute);
  assert.equal(h.meme.getMemeAuction(2319)?.startMs, testNow, 'a refresh preserves the first stored time');
  h.meme.insertMemePosition(h.ag, position(h.ag.id, 2319));
  h.setAnswer(async (_c, method, args) => {
    if (method === 'get_meme' && args.meme_id === 2321) throw new Error('rpc down');
    return { height: 1, value: method === 'get_finalized_meme' ? null : args.meme_id === 2319 ? { ...open, total_staked: 'invalid' } : null };
  });
  h.setNow(Number(open.end_timestamp_ms) - 5 * MEME.minute);
  h.calls.length = 0;
  const invalid = await h.tick();
  assert.deepEqual(invalid, { reads: 5, budget: 0, unreadable: 1, invalid: 1, overrun: false });
  assert.equal(h.calls.filter(c => c.method === 'get_meme' && c.args.meme_id === 2319).length, 1, 'resolution and refresh share the invalid read');
  const logged = h.meme.memeLogs(null).find(r => r.kind === 'cycle')!.data;
  assert.deepEqual({ reads: logged.reads, budget: logged.budget, unreadable: logged.unreadable, invalid: logged.invalid, overrun: logged.overrun }, invalid);
  assert.deepEqual([logged.discovered, logged.tracked, logged.inWindow, logged.nextWindowAt], [[], 1, 1, null], 'inside the window: nothing new, one tracked, no later window');
});

// Added in re-check 2 of 2026-11-11.
test('Audit 3f: a scheduled start is kept from the chain, the 24 h screen uses the stored start, and a bad start is refused', async t => {
  const live = record(decoded('mc-get_meme-2313'))!, value = (v: unknown): MemeView => async () => ({ height: 1, value: v });
  const { start_timestamp_ms: _scheduled, ...unscheduled } = live;
  assert.equal((await readMeme(value(unscheduled), 2313)).kind, 'ok', 'team allocation without a start parses');
  assert.equal((await readMeme(value({ ...live, start_timestamp_ms: String(Number(live.end_timestamp_ms) + 1) }), 2313)).kind, 'unreadable', 'a start after the end');
  assert.equal((await readMeme(value({ ...live, start_timestamp_ms: 1794236400000 }), 2313)).kind, 'unreadable', 'a start that is not a string');
  const answer = (record2319: unknown): MemeView => async (_c, method, args) => ({ height: 1, value: method === 'get_finalized_meme' ? null :
    method === 'get_meme_stakes' ? stakes : args.meme_id === 2319 ? record2319 : null });
  // A scheduled start: the chain value is stored, not the tick time, and a refresh keeps it.
  const h = setup(t), start = testNow - 3 * MEME.hour;
  h.setAnswer(answer({ ...live, id: 2319, start_timestamp_ms: String(start), end_timestamp_ms: String(testNow + 12 * MEME.hour) }));
  await h.tick();
  assert.equal(h.meme.getMemeAuction(2319)?.startMs, start);
  h.setNow(testNow + 10 * MEME.minute); await h.tick();
  assert.equal(h.meme.getMemeAuction(2319)?.updatedAt, testNow + 10 * MEME.minute); assert.equal(h.meme.getMemeAuction(2319)?.startMs, start);
  // No start: the first stored time decides the 24 h screen in the tick. First stored 24 h before the end passes, one minute earlier is too long.
  for (const [lead, screen, asks] of [[MEME.day, 'pass', 1], [MEME.day + MEME.minute, 'too-long', 0]] as const) {
    const u = setup(t), ai = counting(), end = testNow + lead;
    u.setAnswer(answer({ ...unscheduled, id: 2319, end_timestamp_ms: String(end), total_staked: String(60n * N) }));
    await u.tick(ai.ai);
    assert.equal(u.meme.getMemeAuction(2319)?.startMs, testNow); assert.equal(ai.asks, 0);
    u.setNow(end - 5 * MEME.minute); await u.tick(ai.ai);
    assert.equal(u.meme.getMemeAuction(2319)?.startMs, testNow);
    assert.deepEqual(u.meme.memeLogs(null, 100).filter(r => r.kind === 'screen').map(r => r.data), [{ code: screen }]);
    assert.equal(ai.asks, asks);
  }
});

test('Audit 3g: invalid counts answers that arrived and failed validation, once per read, and never a failed transport', async t => {
  const live = record(decoded('mc-get_meme-2313'))!, open = { ...live, id: 2319, end_timestamp_ms: String(testNow + 12 * MEME.hour) };
  const run = async (prepare: (h: ReturnType<typeof setup>) => void, answer: MemeView) => { const h = setup(t); prepare(h); h.setAnswer(answer); const c = await h.tick(); return [c.invalid, c.unreadable]; };
  const deposited = (h: ReturnType<typeof setup>) => { const a = auction(); a.endMs = testNow - 1; h.meme.saveMemeAuction(null, a); h.meme.insertMemePosition(h.ag, position(h.ag.id)); };
  const marked = (h: ReturnType<typeof setup>) => { for (const ag of [h.ag, h.web.createMemeAgent('second.near', { ...MEME.defaults }, testNow)])
    h.meme.insertMemePosition(ag, position(ag.id, 2250, { status: 'open', tokens: '1', tokenId: 'nene-2250.meme-cooking.near', poolId: 9000, launchedAt: testNow })); };
  const finalized = decoded('mc-get_finalized_meme-2250');
  // Stakes: a duplicate row is invalid; a failed call is unreadable.
  assert.deepEqual(await run(() => {}, async (_c, m, a) => ({ height: 1, value: m === 'get_meme_stakes' ? [['a.near', '1'], ['a.near', '2']] : a.meme_id === 2319 ? open : null })), [1, 0]);
  assert.deepEqual(await run(() => {}, async (_c, m, a) => { if (m === 'get_meme_stakes') throw new Error('down'); return { height: 1, value: a.meme_id === 2319 ? open : null }; }), [0, 1]);
  // A malformed record at a newly probed id: the case that hid H-1.
  assert.deepEqual(await run(() => {}, async (_c, m, a) => ({ height: 1, value: m === 'get_meme' && a.meme_id === 2319 ? { ...open, decimals: '18' } : null })), [1, 0]);
  // A finalized record with another id.
  assert.deepEqual(await run(deposited, async (_c, m) => ({ height: 1, value: m === 'get_finalized_meme' ? { ...record(finalized)!, id: 1 } : null })), [1, 0]);
  // A malformed live record read only by the resolution (the auction has ended, so nothing refreshes it).
  assert.deepEqual(await run(deposited, async (_c, m, a) => ({ height: 1, value: m === 'get_finalized_meme' ? null : a.meme_id === 2250 ? { ...auction().last, total_staked: 'x' } : null })), [1, 0]);
  // The pool count and the pool list of a launch.
  assert.deepEqual(await run(deposited, async (_c, m) => ({ height: 1, value: m === 'get_finalized_meme' ? finalized : m === 'get_number_of_pools' ? '8950' : null })), [1, 0]);
  assert.deepEqual(await run(deposited, async (_c, m) => ({ height: 1, value: m === 'get_finalized_meme' ? finalized : m === 'get_number_of_pools' ? 8950 : m === 'get_pools' ? {} : null })), [1, 0]);
  // One bad pool read shared by two positions counts once; a failed pool call is unreadable.
  assert.deepEqual(await run(marked, async (_c, m) => ({ height: 1, value: m === 'get_pool' ? { ...record(decoded('ref-get_pool-8943'))!, token_account_ids: ['nene-2250.meme-cooking.near', 'usdc.near'] } : null })), [1, 0]);
  assert.deepEqual(await run(marked, async (_c, m) => { if (m === 'get_pool') throw new Error('down'); return { height: 1, value: null }; }), [0, 1]);
  // Answers that are not failures: null records, another deposit token, the settled-failure panic.
  assert.deepEqual(await run(deposited, async (_c, m, a) => { if (m === 'get_finalized_meme') throw new MemeNotFinalized(); return { height: 1, value: a.meme_id === 2319 ? { ...open, deposit_token_id: 'usdc.near' } : null }; }), [0, 0]);
});

test('Run log: shared cycles inside the agent life only, with the agent own events of the same tick and old rows read as unknown', async t => {
  const h = setup(t), created = h.ag.createdAt;
  h.meme.logMeme({ agentId: null, kind: 'cycle', memeId: null, at: created - 60_000, data: { reads: 3, budget: 0, unreadable: 0, invalid: 0, overrun: false } });
  h.meme.logMeme({ agentId: null, kind: 'cycle', memeId: null, at: created + 60_000, data: { reads: 3, budget: 0, unreadable: 0, invalid: 0, overrun: false } });
  h.meme.logMeme({ agentId: null, kind: 'cycle', memeId: null, at: created + 120_000, data: { reads: 5, budget: 1, unreadable: 0, invalid: 0, overrun: true,
    probed: [2319, 2321], discovered: [2319, 'x'], refreshed: 1, tracked: 2, inWindow: 1, nextWindowAt: created + 600_000 } });
  h.meme.logMeme({ agentId: h.ag.id, kind: 'cycle', memeId: 2319, at: created + 120_000, data: { screen: 'pass' } });
  h.meme.logMeme({ agentId: h.ag.id, kind: 'entry', memeId: 2319, at: created + 120_000, data: { deposit: '1', net: '1' } });
  h.meme.logMeme({ agentId: null, kind: 'ask', memeId: 2319, at: created + 120_000, data: { action: 'join', confidence: 80, code: 'join' } });
  const runs = memePublicView(h.web, h.web.getMemeAgent(h.ag.id)!, created + 180_000).runs;
  assert.deepEqual(runs.map(r => r.at), [created + 120_000, created + 60_000], 'newest first, nothing before the agent was created');
  assert.deepEqual(runs[0], { at: created + 120_000, reads: 5, budget: 1, unreadable: 0, invalid: 0, overrun: true, probed: [2319, 2321], discovered: [2319], refreshed: 1,
    tracked: 2, inWindow: 1, nextWindowAt: created + 600_000, screened: 1, asked: 1, entries: 1, exits: 0 });
  assert.deepEqual([runs[1].probed, runs[1].discovered, runs[1].tracked, runs[1].nextWindowAt], [null, null, null, null]);
  assert.ok(h.web.casMemeAgent(h.web.getMemeAgent(h.ag.id)!, 'ending', 'owner-stopped', created + 80_000));
  assert.ok(h.meme.casMemeAgent(h.meme.getMemeAgent(h.ag.id)!, 'ended', 'owner-stopped', created + 90_000));
  for (let i = 1; i <= 400; i++) h.meme.logMeme({ agentId: null, kind: 'cycle', memeId: null, at: created + 120_000 + i * 60_000, data: { reads: 3 } });
  assert.deepEqual(memePublicView(h.web, h.web.getMemeAgent(h.ag.id)!, created + 120_000 + 401 * 60_000).runs.map(r => r.at), [created + 60_000], 'nothing after the agent ended, however many cycles ran since');
});
