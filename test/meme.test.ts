import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import ts from 'typescript';
import { YOCTO_PER_NEAR as N } from '../src/core/amounts.js';
import { tokenHash } from '../src/core/auth.js';
import { record } from '../src/core/errors.js';
import { askMeme, memeJoin, memePrompt } from '../src/core/meme-ask.js';
import { findMemePool, parseMeme, parseMemePool, readMeme, readMemeStakes, sellMeme, type MemeView } from '../src/core/meme-cooking.js';
import { memeTick } from '../src/core/meme-cycle.js';
import { MEME, canEnterMeme, memeExit, memeWindow, screenMeme, stakeSummary, staleMemeMark, type MemeAuction, type MemePosition } from '../src/core/meme-paper.js';
import { createNearAi, type NearAi } from '../src/core/near-ai.js';
import { createNearRpc, DEFAULT_RPC, MemeNotFinalized } from '../src/core/near-rpc.js';
import { json, openStore } from '../src/core/store.js';
import { createHandler } from '../src/web/server.js';
import { opRow } from './chain.js';
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
const join: NearAi = async () => ({ data: { action: 'join', confidence: 70 } });
const stakes = Array.from({ length: 10 }, (_, i): [string, string] => [`stake${i}.near`, String(6n * N)]);

test('Trade 1: fixture readers, fixed panic classification and discovery across absent ids', async t => {
  const rpcFixture = (name: string) => createNearRpc(DEFAULT_RPC, async () => ({ status: 200, text: JSON.stringify(fixture(name)) }), async () => {});
  assert.equal((await readMeme(rpcFixture('mc-get_meme-2313').view, 2313)).kind, 'ok');
  for (const [name, id] of [['mc-get_meme-2250', 2250], ['mc-get_meme-2318', 2318], ['mc-get_meme-999999', 999999]] as const)
    assert.equal((await readMeme(rpcFixture(name).view, id)).kind, 'absent');
  assert.equal((await readMeme(rpcFixture('mc-get_finalized_meme-2250').view, 2250, true)).kind, 'ok');
  assert.equal((await readMeme(rpcFixture('mc-get_finalized_meme-2250-at-219636931').view, 2250, true)).kind, 'pending');
  assert.equal((await readMeme(rpcFixture('mc-get_meme-2250-at-219636931').view, 2250)).kind, 'ok');
  assert.equal((await readMeme(rpcFixture('mc-get_meme-2319').view, 2319)).kind, 'ok');
  assert.equal((await readMeme(rpcFixture('mc-get_finalized_meme-2318').view, 2318, true)).kind, 'not-finalized');
  assert.equal((await readMemeStakes(rpcFixture('mc-get_meme_stakes-2313').view, 2313)).kind, 'ok');
  assert.equal((await readMemeStakes(rpcFixture('mc-get_meme_stakes-2250').view, 2250)).kind, 'absent');
  const unrelated = createNearRpc(DEFAULT_RPC, async () => ({ status: 200, text: JSON.stringify({ result: { error: 'another execution failure' } }) }), async () => {});
  assert.equal((await readMeme(unrelated.view, 2318, true)).kind, 'unreadable');
  const live = decoded('mc-get_meme-2313');
  const view = (value: unknown): MemeView => async () => ({ height: 1, value });
  assert.equal((await readMeme(view({ ...record(live), deposit_token_id: 'other.near' }), 2313)).kind, 'ignored');
  assert.equal((await readMeme(view({ ...record(live), total_staked: '1.5' }), 2313)).kind, 'unreadable');
  assert.equal((await readMeme(view({ ...record(live), start_timestamp_ms: null }), 2313)).kind, 'ok');
  assert.equal((await readMeme(view({ ...record(live), start_timestamp_ms: 'invalid' }), 2313)).kind, 'unreadable');
  assert.equal((await readMeme(view({ ...record(live), symbol: 'x'.repeat(32) }), 2313)).kind, 'ok');
  assert.equal((await readMeme(view({ ...record(live), symbol: 'x'.repeat(33) }), 2313)).kind, 'unreadable');
  assert.equal((await readMeme(dummyRpc().view, 2313)).kind, 'unreadable');
  const parsed = parseMeme(live, 2313);
  assert.ok(!json(parsed).includes('icon') && !json(parsed).includes('reference') && !json(parsed).includes('name'));
  assert.deepEqual(stakeSummary({ ...parsed, total_staked: '0' }, [['a.near', '0']]), { depositors: 0, creatorShare: 0, topShare: 0 });
  assert.deepEqual(stakeSummary({ ...parsed, total_staked: '10' }, [[parsed.owner, '3'], ['other.near', '7'], ['zero.near', '0']]), { depositors: 2, creatorShare: 0.3, topShare: 0.7 });
  const h = setup(t); h.meme.setMeta('meme_high_id', '2300');
  h.setAnswer(async (_c, method, args) => ({ height: 1, value: method === 'get_meme' && args.meme_id === 2313 ? live : null }));
  for (let i = 1; i <= 10; i++) {
    h.calls.length = 0; await h.tick();
    assert.equal(h.calls.filter(c => c.method === 'get_meme').length, i === 10 ? 15 : 3);
  }
  assert.equal(h.meme.meta('meme_high_id'), '2313');
  h.setAnswer(async () => ({ height: 1, value: null })); await h.tick();
  assert.equal(h.meme.meta('meme_high_id'), '2313');
  const gap = setup(t); gap.meme.setMeta('meme_high_id', '2313'); gap.meme.setMeta('meme_tick_no', '9');
  gap.setAnswer(async (_c, method, args) => ({ height: 1, value: method === 'get_meme' && args.meme_id === 2319 ? { ...record(live), id: 2319 } : null }));
  await gap.tick(); assert.equal(gap.meme.meta('meme_high_id'), '2319');
});

test('Trade 2: pool finder requires exactly wNEAR and the launched token', () => {
  const pools = decoded('ref-get_pools-8930-20');
  assert.deepEqual(findMemePool(pools, 8930, 2250), { poolId: 8943, tokenId: 'nene-2250.meme-cooking.near' });
  const pool = parseMemePool(decoded('ref-get_pool-8943'));
  assert.equal(findMemePool([{ ...pool, token_account_ids: [...pool.token_account_ids, 'third.near'] }], 0, 2250), null);
  assert.equal(findMemePool([{ ...pool, token_account_ids: ['nene-2250.meme-cooking.near', 'other.near'] }], 0, 2250), null);
});

test('Trade 3: constant-product sell values match the chain vector and hand arithmetic', () => {
  const abg = parseMemePool(decoded('ref-get_pool-5720-at-223910063'));
  assert.equal(sellMeme(abg, 'wrap.near', 5n * N), 177556738033547939121308n);
  const nene = parseMemePool(decoded('ref-get_pool-8943'));
  // floor(10^24 * 9990 * 316472387132917758329467666 / (156998647296236397378009045 * 10000 + 10^24 * 9990)).
  assert.equal(sellMeme(nene, 'nene-2250.meme-cooking.near', N), 2001016598386499340534629n);
});

test('Trade 4: screens report the first failure and entry-window bounds are strict', () => {
  const a = auction();
  const bad = { ...a, endMs: a.startMs + 2 * MEME.day, last: { ...a.last, deposit_token_id: 'other.near', depositors: 0,
    creatorShare: 0.95, total_staked: '0', hard_cap: '0' } };
  assert.equal(screenMeme(bad), 'deposit-token'); bad.last.deposit_token_id = 'wrap.near';
  assert.equal(screenMeme(bad), 'too-long'); bad.endMs = a.endMs;
  assert.equal(screenMeme(bad), 'few-depositors'); bad.last.depositors = 10;
  assert.equal(screenMeme(bad), 'creator-funded'); bad.last.creatorShare = 0.899999;
  assert.equal(screenMeme(bad), 'far-from-soft-cap'); bad.last.total_staked = String(50n * N);
  assert.equal(screenMeme(bad), 'hard-cap'); bad.last.hard_cap = String(500n * N);
  assert.equal(screenMeme(bad), null);
  const unscheduled = { ...a, startMs: a.endMs - MEME.day, last: { ...a.last, start_timestamp_ms: null } };
  assert.equal(screenMeme(unscheduled), null);
  assert.equal(screenMeme({ ...unscheduled, startMs: unscheduled.startMs - 1 }), 'too-long');
  assert.equal(memeWindow(a, a.endMs - 10 * MEME.minute), true);
  assert.equal(memeWindow(a, a.endMs - 10 * MEME.minute - 1), false);
  assert.equal(memeWindow(a, a.endMs - MEME.minute), false);
  assert.equal(memeWindow({ endMs: testNow + 2 * MEME.minute }, testNow), true);
});

test('Trade 5: per-agent limits, cutoff, duplicates and at most one entry per tick', async t => {
  const h = setup(t), a = h.ag;
  assert.equal(canEnterMeme(a, [], 1, testNow), true);
  assert.equal(canEnterMeme({ ...a, state: 'ending' }, [], 1, testNow), false);
  assert.equal(canEnterMeme(a, [], 1, a.endsAt - 2 * MEME.hour), false);
  assert.equal(canEnterMeme(a, [], 1, testNow, true), false);
  assert.equal(canEnterMeme(a, [position(a.id, 1, { status: 'closed' })], 1, testNow), false);
  assert.equal(canEnterMeme(a, [position(a.id, 2), position(a.id, 3)], 1, testNow), false);
  assert.equal(canEnterMeme({ ...a, settings: { ...a.settings, capitalNear: 15 } }, [position(a.id, 2)], 1, testNow), false);
  for (const id of [2250, 2251]) h.meme.saveMemeAuction(null, auction(id));
  h.setAnswer(async (_c, method, args) => ({ height: 1, value: method === 'get_meme_stakes' ? stakes :
    [2250, 2251].includes(Number(args.meme_id)) ? auction(Number(args.meme_id)).last : null }));
  await h.tick(join);
  assert.equal(h.meme.memePositions(a.id).length, 1);
  assert.equal(h.meme.memePositions(a.id)[0].netYocto, String(995n * N / 100n));
});

test('Trade 6: shared resolution, dilution, early launch, refunds, waiting and six-hour bound', async t => {
  const launch = async (early: boolean, found = true, ending = false) => {
    const h = setup(t), a = auction(); a.endMs = early ? testNow + MEME.hour : testNow - 1;
    h.meme.saveMemeAuction(null, a);
    const second = h.web.createMemeAgent(owner, { ...MEME.defaults }, testNow);
    for (const ag of [h.ag, second]) h.meme.insertMemePosition(ag, position(ag.id));
    if (ending) for (const ag of [h.ag, second]) h.web.casMemeAgent(ag, 'ending', 'owner-stopped', testNow);
    h.setAnswer(async (_c, method) => ({ height: 1, value: method === 'get_finalized_meme' ? decoded('mc-get_finalized_meme-2250') :
      method === 'get_number_of_pools' ? 8950 : method === 'get_pools' ? found ? Array(43).fill(null).concat([decoded('ref-get_pool-8943')]) : [] :
      method === 'get_pool' ? decoded('ref-get_pool-8943') : null }));
    await h.tick();
    const p = h.meme.memePositions(h.ag.id)[0];
    assert.equal(h.calls.filter(c => c.method === 'get_finalized_meme').length, 1);
    if (found) {
      const net = BigInt(p.netYocto), m = record(decoded('mc-get_finalized_meme-2250'))!;
      assert.equal(p.tokens, String(BigInt(String(m.amount_to_be_distributed)) * net / (BigInt(String(m.total_staked)) + net)));
      assert.equal(p.launchedAt, testNow); assert.equal(p.status, ending ? 'closed' : 'open'); assert.equal(p.poolId, 8943);
      if (ending) { assert.equal(p.closeCode, 'ended'); assert.equal(h.meme.getMemeAgent(h.ag.id)?.state, 'ended'); }
      assert.equal(h.calls.filter(c => c.method === 'get_pool').length, 1);
    } else assert.equal(p.status, 'deposited');
  };
  await launch(false); await launch(true); await launch(true, false); await launch(true, true, true);
  for (const mode of ['record', 'settled', 'waiting', 'unresolved'] as const) {
    const h = setup(t), a = auction(); a.endMs = testNow - 1;
    a.last.total_staked = String((mode === 'waiting' || mode === 'unresolved' ? 100n : 50n) * N);
    h.meme.saveMemeAuction(null, a); h.meme.insertMemePosition(h.ag, position(h.ag.id));
    h.setAnswer(async (_c, method, args) => {
      if (method === 'get_finalized_meme') {
        if (mode === 'settled') throw new MemeNotFinalized();
        return { height: 1, value: null };
      }
      return { height: 1, value: args.meme_id === 2250 && mode !== 'settled' ? a.last : null };
    });
    if (mode === 'unresolved') h.setNow(a.endMs + 6 * MEME.hour);
    await h.tick(); const p = h.meme.memePositions(h.ag.id)[0];
    assert.equal(p.closeCode, mode === 'waiting' ? null : mode === 'unresolved' ? 'unresolved' : 'refunded');
    if (mode !== 'waiting') assert.equal(p.pnlYocto, '0');
    assert.equal(h.calls.filter(c => c.method === 'get_meme' && c.args.meme_id === 2250).length, mode === 'settled' ? 0 : 1);
  }
});

test('Trade 7: exit precedence, exact stop and trailing bounds, time and stale ending marks', async t => {
  const h = setup(t), a = h.ag, p = position(a.id, 2250, { status: 'open', launchedAt: testNow, peakBps: 2000 });
  assert.equal(memeExit({ ...a, state: 'ending' }, p, 7n * N, testNow + 4 * MEME.hour).closeCode, 'ended');
  assert.equal(memeExit(a, p, 7n * N, testNow + 4 * MEME.hour).closeCode, 'stop');
  assert.equal(memeExit(a, p, 105n * N / 10n, testNow).closeCode, 'trailing');
  assert.equal(memeExit(a, { ...p, peakBps: 1999 }, 105n * N / 10n, testNow).closeCode, null);
  assert.equal(memeExit(a, p, 105n * N / 10n + 10n ** 21n, testNow).closeCode, null);
  assert.equal(memeExit(a, { ...p, peakBps: null }, 10n * N, testNow + 4 * MEME.hour).closeCode, 'time');
  assert.equal(memeExit(a, p, 7n * N + 1n, testNow).pnlBps, -3000, 'negative bps use floor');
  assert.equal(staleMemeMark({ ...a, state: 'ending' }, p, testNow + 10 * MEME.minute), false);
  h.meme.insertMemePosition(a, { ...p, tokenId: 'nene-2250.meme-cooking.near', poolId: 8943, tokens: '1', markYocto: String(9n * N), markAt: testNow });
  h.web.casMemeAgent(a, 'ending', 'owner-stopped', testNow);
  h.setAnswer(async () => { throw new Error('unreadable'); }); h.setNow(testNow + 10 * MEME.minute + 1);
  await h.tick();
  const closed = h.meme.memePositions(a.id)[0]; assert.equal(closed.closeCode, 'ended'); assert.equal(closed.exitYocto, String(9n * N));
  const empty = setup(t); empty.meme.insertMemePosition(empty.ag, { ...p, id: 'empty', agentId: empty.ag.id });
  empty.web.casMemeAgent(empty.ag, 'ending', 'owner-stopped', testNow); empty.setNow(testNow + 11 * MEME.minute);
  await empty.tick(); assert.equal(empty.meme.memePositions(empty.ag.id)[0].exitYocto, '0');
});

test('Trade 8: numeric prompt, exact AI schema, fixed failures, bounded client and a single stored ask', async t => {
  const a = auction(), prompt = memePrompt(a, testNow);
  assert.deepEqual(Object.keys(prompt), ['durationMinutes', 'minutesLeft', 'depositors', 'totalStakedNear', 'softCapNear', 'hardCapNear', 'teamPct', 'cliffDays', 'vestingDays', 'creatorSharePct', 'topSharePct', 'stakedChange30mNear', 'depositorsChange30m']);
  assert.ok(Object.values(prompt).every(v => v === null || typeof v === 'number'));
  assert.ok(!json(prompt).includes(a.owner) && !json(prompt).includes(a.last.symbol));
  a.samples = [{ at: testNow - 30 * MEME.minute, totalStaked: String(50n * N), depositors: 8 }];
  assert.equal(memePrompt(a, testNow).stakedChange30mNear, 10); assert.equal(memePrompt(a, testNow).depositorsChange30m, 2);
  assert.equal(memeJoin(await askMeme(join, a, testNow)), true);
  for (const data of [{ action: 'join', confidence: 70, reason: 'extra' }, { action: ['join'], confidence: 70 }, { action: 'join', confidence: '70' },
    { action: 'join', confidence: 69 }, { action: 'join', confidence: 101 }, { action: 'join' }])
    assert.equal(memeJoin(await askMeme(async () => ({ data }), a, testNow)), false);
  for (const error of ['unavailable', 'timeout', 'http', 'malformed'] as const) {
    assert.deepEqual(await askMeme(async () => ({ data: null, error }), a, testNow), { failure: error });
  }
  assert.deepEqual(await askMeme(null, a, testNow), { failure: 'ai-off' });
  const payload = (content: unknown) => JSON.stringify({ choices: [{ message: { content } }] });
  const client = createNearAi('fake-test-key', undefined, async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.temperature, 0); assert.equal(body.max_tokens, 200); assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(init?.redirect, 'error'); return new Response(payload('{"action":"join","confidence":70}'));
  });
  assert.deepEqual(await client('system', 'user'), { data: { action: 'join', confidence: 70 } });
  for (const [response, expected] of [[new Response('', { status: 429 }), 'http'], [new Response(payload('not json')), 'malformed'],
    [new Response('x'.repeat(16385)), 'malformed'], [new Response(payload(123)), 'malformed']] as const) {
    assert.equal((await createNearAi('fake-test-key', undefined, async () => response)('s', 'u')).error, expected);
  }
  assert.equal((await createNearAi('fake-test-key', undefined, async () => { throw new Error('fake-test-key'); })('s', 'u')).error, 'unavailable');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timeout = createNearAi('fake-test-key', undefined, async () => new Promise<Response>(() => {}))('s', 'u');
  t.mock.timers.tick(15_000); assert.equal((await timeout).error, 'timeout');
  t.mock.timers.reset();
  const h = setup(t); h.meme.saveMemeAuction(null, auction());
  h.setAnswer(async (_c, method, args) => ({ height: 1, value: method === 'get_meme_stakes' ? stakes : args.meme_id === 2250 ? auction().last : null }));
  let asks = 0;
  const skip: NearAi = async () => { asks++; return { data: { action: 'join', confidence: 69 } }; };
  await h.tick(skip); await h.tick(skip);
  assert.equal(asks, 1); assert.equal(h.meme.memePositions(h.ag.id).length, 0);
  assert.equal(h.meme.memeLogs(null).filter(r => r.kind === 'ask').length, 1);
  assert.equal(h.meme.memeLogs(null).filter(r => r.kind === 'screen').length, 1);
  assert.equal(h.meme.memeLogs(h.ag.id).filter(r => r.kind === 'cycle' && r.memeId === 2250).length, 1);
  for (const ai of [null, (async () => ({ data: null, error: 'unavailable' as const }))] as const) {
    const failed = setup(t); failed.meme.saveMemeAuction(null, auction());
    failed.setAnswer(async (_c, method, args) => ({ height: 1, value: method === 'get_meme_stakes' ? stakes : args.meme_id === 2250 ? auction().last : null }));
    await failed.tick(ai); await failed.tick(join);
    assert.equal(failed.meme.memeLogs(null).filter(r => r.kind === 'ask').length, 1);
    assert.equal(failed.meme.memePositions(failed.ag.id).length, 0);
  }
});

test('Trade 9: the 31st view is skipped and the cycle records the read budget', async t => {
  const h = setup(t);
  let lastAgent = h.ag;
  for (let i = 0; i < 11; i++) {
    const ag = i === 0 ? h.ag : h.web.createMemeAgent(`owner${i}.near`, { ...MEME.defaults, maxOpen: 3, capitalNear: 30 }, testNow);
    lastAgent = ag;
    for (let j = 0; j < 3; j++) h.meme.insertMemePosition(ag, position(ag.id, i * 3 + j, { status: 'open', tokens: '1', tokenId: 'nene-2250.meme-cooking.near', poolId: i * 3 + j, launchedAt: testNow }));
  }
  h.web.casMemeAgent(lastAgent, 'ending', 'owner-stopped', testNow);
  h.setNow(testNow + 11 * MEME.minute);
  h.setAnswer(async () => ({ height: 1, value: decoded('ref-get_pool-8943') }));
  const cycle = await h.tick(); assert.equal(cycle.reads, 30); assert.equal(h.calls.length, 30); assert.ok(cycle.budget >= 1);
  assert.equal(h.meme.memeLogs(null).find(r => r.kind === 'cycle')?.data.budget, cycle.budget);
  assert.ok(h.meme.memePositions(lastAgent.id).every(p => p.status === 'open'));
  assert.equal(h.meme.memeLogs(lastAgent.id).filter(r => r.kind === 'mark').length, 0);
});

test('Trade 10: term end, owner stop, completed ending and running-agent limits', async t => {
  const h = setup(t); h.setNow(h.ag.endsAt); await h.tick();
  assert.equal(h.meme.getMemeAgent(h.ag.id)?.state, 'ended'); assert.equal(h.meme.getMemeAgent(h.ag.id)?.endReason, 'term-ended');
  const stopped = h.web.createMemeAgent(owner, { ...MEME.defaults }, testNow);
  assert.equal(h.web.casMemeAgent(stopped, 'ending', 'owner-stopped', testNow), true); await h.tick();
  assert.equal(h.meme.getMemeAgent(stopped.id)?.state, 'ended');
  for (let i = 0; i < 3; i++) h.web.createMemeAgent(owner, { ...MEME.defaults }, testNow);
  assert.throws(() => h.web.createMemeAgent(owner, { ...MEME.defaults }, testNow), { code: 'limit_reached' });
  for (let i = 0; i < 47; i++) h.web.createMemeAgent(`limit${i}.near`, { ...MEME.defaults }, testNow);
  assert.throws(() => h.web.createMemeAgent('last.near', { ...MEME.defaults }, testNow), { code: 'limit_reached' });
});

test('Trade 11: API flag, settings, session, public view and owner-only stop', async t => {
  const h = setup(t), origin = 'https://app.test', token = 'a'.repeat(43), foreign = 'b'.repeat(43);
  h.web.putSession(tokenHash(token), owner, testNow, testNow + MEME.hour);
  h.web.putSession(tokenHash(foreign), 'foreign.near', testNow, testNow + MEME.hour);
  async function request(path: string, method = 'GET', input?: unknown, session?: string, enabled = true) {
    const handler = createHandler({ store: h.web, rpc: dummyRpc(), now: () => testNow,
      env: { host: '127.0.0.1', port: 8090, origin, liveHires: false, memePaper: enabled } });
    const req = Object.assign(Readable.from(input === undefined ? [] : [Buffer.from(json(input))]), { url: path, method,
      headers: { host: 'app.test', origin, cookie: session ? `fourlpha_session=${session}` : undefined, 'content-type': 'application/json' } }) as unknown as IncomingMessage;
    let out = ''; const res = { statusCode: 200, setHeader: () => {}, end: (s: string) => { out = s; } };
    await handler(req, res as unknown as ServerResponse);
    return { status: res.statusCode, body: JSON.parse(out) as { data: unknown; error?: { code: string } } };
  }
  assert.equal((await request('/api/meme/options', 'GET', undefined, undefined, false)).body.error?.code, 'not_found');
  const opts = record((await request('/api/meme/options')).body.data)!;
  assert.equal(opts.enabled, true); assert.equal(typeof opts.ai, 'boolean'); assert.deepEqual(opts.defaults, MEME.defaults);
  assert.equal((await request('/api/meme', 'POST', MEME.defaults)).status, 401);
  const invalid = [{ ...MEME.defaults, perAuctionNear: 0 }, { ...MEME.defaults, perAuctionNear: 51 }, { ...MEME.defaults, maxOpen: 4 },
    { ...MEME.defaults, capitalNear: 19 }, { ...MEME.defaults, capitalNear: 501 }, { ...MEME.defaults, termDays: 8 },
    { ...MEME.defaults, perAuctionNear: 1.5 }, { ...MEME.defaults, extra: true }, { perAuctionNear: 10 }];
  for (const input of invalid) assert.equal((await request('/api/meme', 'POST', input, token)).status, 400);
  const created = await request('/api/meme', 'POST', MEME.defaults, token);
  assert.equal(created.status, 201); const id = String(record(created.body.data)?.id);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const publicView = record((await request(`/api/meme/${id}`)).body.data)!;
  assert.equal(record(publicView.agent)?.isOwner, false); assert.equal(record(publicView.summary)?.pnlNear, '0');
  assert.equal(record(record((await request(`/api/meme/${id}`, 'GET', undefined, token)).body.data)?.agent)?.isOwner, true);
  assert.equal((await request('/api/meme', 'GET', undefined, token)).status, 200);
  assert.equal((await request(`/api/meme/${id}/stop`, 'POST', {}, foreign)).body.error?.code, 'not_found');
  assert.equal((await request(`/api/meme/${id}/stop`, 'POST', {}, token)).status, 200);
  assert.equal((await request(`/api/meme/${id}/stop`, 'POST', {}, token)).body.error?.code, 'conflict');
  assert.equal((await request('/api/meme/00000000-0000-4000-8000-000000000000')).body.error?.code, 'not_found');
});

test('Trade 12: runtime import isolation and meme store cannot write money tables', t => {
  const forbidden = new Set(['outlayer.ts', 'secrets.ts', 'ops.ts', 'policy.ts', 'watchdog.ts', 'hire.ts']);
  const roots = [...readdirSync('src/meme').filter(p => p.endsWith('.ts')).map(p => resolve('src/meme', p)),
    ...readdirSync('src/core').filter(p => /^meme-.*\.ts$/.test(p)).map(p => resolve('src/core', p))];
  const visited = new Set<string>();
  function walk(path: string) {
    if (visited.has(path)) return; visited.add(path);
    assert.ok(!forbidden.has(path.split(/[\\/]/).at(-1)!));
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      if (specifier.startsWith('.')) walk(resolve(dirname(path), specifier.replace(/\.js$/, '.ts')));
    }
  }
  roots.forEach(walk);
  const h = setup(t);
  assert.throws(() => h.meme.createJob({ owner, kind: 'grid', mode: 'live', pair: 'usdc-wnear', depositYocto: N }, testNow), { code: 'forbidden' });
  assert.throws(() => h.meme.casJob('no-job', 'running', 0, 'stopping'), { code: 'forbidden' });
  assert.throws(() => h.meme.insertOp(opRow({ id: 'no-job', walletId: 'no-wallet' })), { code: 'forbidden' });
  assert.throws(() => h.meme.setMeta('worker_lock', '{}'), { code: 'forbidden' });
  assert.throws(() => h.meme.putSecrets('no-wallet', { apiKeyCt: Buffer.alloc(0), linkCt: null }, testNow), { code: 'forbidden' });
});
