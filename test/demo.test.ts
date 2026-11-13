// Demo mode (docs/specs/DEMO-MODE-SPEC.md section 10): offline, on fixtures and synthetic markets only. Nothing here signs or reaches a network.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { YOCTO_PER_NEAR as N } from '../src/core/amounts.js';
import { tokenHash } from '../src/core/auth.js';
import { webEnv } from '../src/core/config.js';
import { demoTick } from '../src/core/demo-cycle.js';
import { readDemoDcl } from '../src/core/demo-market.js';
import { demoStep, gridValueOf, lpFee, lpLiquidity, lpValues, lpXY, SIM_GAS, TP_NOTE, tradeValueOf, type DemoAgent, type DemoDcl, type DemoGridSim,
  type DemoLogRow, type DemoLpSim, type DemoMarket, type DemoTradeSim } from '../src/core/demo-sim.js';
import { DEMO_OMITS, demoPublicView } from '../src/core/demo-view.js';
import { record } from '../src/core/errors.js';
import { gridSettingsFromRequest, lanePoints } from '../src/core/grid-settings.js';
import type { GridSettings } from '../src/core/grid.js';
import { setJob } from '../src/core/hire.js';
import type { LpAi } from '../src/core/lp-ai.js';
import { lpSettingsFromPrices } from '../src/core/lp-settings.js';
import type { LpSettings } from '../src/core/lp.js';
import { createNearRpc, DEFAULT_RPC, RpcUnavailable, type NearRpc } from '../src/core/near-rpc.js';
import { CLASSIC_EXCHANGE, DCL, USDC, WNEAR } from '../src/core/pins.js';
import { limitProceeds, toNearDown } from '../src/core/rhea-dcl.js';
import { openStore, Store } from '../src/core/store.js';
import { TRADE_PAIRS } from '../src/core/trade-pairs.js';
import { levelNeed, outGivenIn, tpLine, TRADE_RESERVE, tradePlan, tradeSettingsFromRequest, type Sample, type TradeSettings } from '../src/core/trade-settings.js';
import { createHandler } from '../src/web/server.js';
import { opRow } from './chain.js';
import { dummyRpc, fixture, owner, stores, testNow } from './helpers.js';

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const near = (s: string) => { const [i, f = ''] = s.split('.'); return BigInt(i!) * N + BigInt(f.padEnd(24, '0')); };
const decoded = (name: string) => JSON.parse(Buffer.from(record(record(fixture(name))?.result)!.result as number[]).toString('utf8')) as Record<string, unknown>;
const P0 = 402042;
// The 4512 reserves of the fixture at 224191815, and a pool priced exactly at the DCL point P0 (1,000,000 USDC against its value in wNEAR).
const FIXTURE_POOL = { wnear: '271436970224245096312173074759', token: '941666931471' };
const FAIR_POOL = { wnear: toNearDown(10n ** 12n, P0).toString(), token: (10n ** 12n).toString() };
const dclAt = (point: number, at: number, block: number, patch: Partial<DemoDcl> = {}): DemoDcl =>
  ({ at, block, point, liquidity: '38363638340228440', volX: '1000', volY: '1000', protocolBps: 2000, ...patch });
function market(at: number, block: number, o: { point?: number | null; pool?: { wnear: string; token: string } | null; history?: Sample[]; dcl?: Partial<DemoDcl> } = {}): DemoMarket {
  const pool = o.pool === null ? undefined : { at, block, ...(o.pool ?? FAIR_POOL) };
  return { dcl: o.point === null ? null : dclAt(o.point ?? P0, at, block, o.dcl), pools: { 4512: pool, 6458: pool, 6065: pool }, history: { 4512: o.history ?? [], 6458: o.history ?? [], 6065: o.history ?? [] } };
}
const history = (at: number, pool = FAIR_POOL, n = 12) => Array.from({ length: n }, (_, i) => ({ at: at - (i + 1) * MIN, block: 1, ...pool })).reverse();
function agentOf(kind: DemoAgent['kind'], settings: DemoAgent['settings'], deposit: bigint, patch: Partial<DemoAgent> = {}): DemoAgent {
  return { id: '11111111-2222-4333-8444-555555555555', owner: 'a'.repeat(64), kind, pair: kind === 'grid' || kind === 'lp' ? 'usdc-wnear' : 'trade-usdc', state: 'running', endReason: null,
    settings, depositYocto: deposit.toString(), sim: null, seed: 0, createdAt: testNow, endsAt: testNow + (kind === 'grid' || kind === 'lp' ? 7 * DAY : 6 * DAY), updatedAt: testNow, version: 0, ...patch };
}
async function step(a: DemoAgent, m: DemoMarket, now: number, decide?: Parameters<typeof demoStep>[3]) {
  const next = await demoStep(a, m, now, decide);
  assert.ok(next.log.filter(r => r.kind === 'op').length <= 1, 'at most one simulated transaction per tick');
  return { a: { ...a, state: next.state, endReason: next.endReason, sim: next.sim, version: a.version + 1 }, log: next.log };
}
const ops = (log: DemoLogRow[]) => log.filter(r => r.kind === 'op').map(r => String(r.data.kind));
/** The shared test database plus a demo store (and a meme store), closed before the temporary folder is removed (Windows). */
function withDemo(t: Parameters<typeof stores>[0], meme = false) {
  const extra: Store[] = [];
  const db = stores({ after(fn) { t.after(() => { for (const s of extra) s.close(); fn(); }); } });
  extra.push(openStore(db.path, 'demo'));
  if (meme) extra.push(openStore(db.path, 'meme'));
  return { ...db, demo: extra[0]!, meme: extra[1] };
}
const GRID = gridSettingsFromRequest({ preset: 'balanced', orders: 4, stopLossPct: 0, takeProfitPct: 0 }) as GridSettings;
const LP_SERVER = lpSettingsFromPrices({ range: { mode: 'server' }, ai: false, compound: { on: false }, stopLossPct: 0, takeProfitPct: 0 }) as LpSettings;
const SCHEDULE = tradeSettingsFromRequest('schedule', { amountNear: '0.10', intervalSec: 3600, budgetNear: '0.20', end: { kind: 'budget' } }, testNow) as TradeSettings;
const DCA = tradeSettingsFromRequest('dca', { baseNear: '0.10', orderNear: '0.10', levels: 3, stepBps: 100, tpBps: 150, slBps: 0 }, testNow) as TradeSettings;

// ---- 1. DCL reader
function fixtureRpc(pool = 'dcl-get_pool-usdc-wnear-100-at-224191815', edit: { meta?: (m: Record<string, unknown>) => void; pool?: (p: Record<string, unknown>) => void; height?: number } = {}) {
  const envelope = (name: string, change?: (v: Record<string, unknown>) => void) => {
    const f = structuredClone(fixture(name)) as { result: { block_hash: string; block_height: number; result: number[] } }, value = decoded(name);
    change?.(value);
    const p = record(record(fixture(pool))?.result)!;
    // The metadata fixture is at 224191815; served at the pool fixture's block so both views answer the same block.
    return { ...f, result: { ...f.result, block_hash: p.block_hash, block_height: name === pool && edit.height ? edit.height : p.block_height, result: [...Buffer.from(JSON.stringify(value))] } };
  };
  const head = record(record(fixture(pool))?.result)!;
  // A scripted clock, so the public pacing spacing passes at once.
  let clock = testNow;
  return createNearRpc(DEFAULT_RPC, async (_url, body) => {
    const r = JSON.parse(body) as { method: string; params: { method_name?: string } };
    const text = r.method === 'block' ? { jsonrpc: '2.0', id: '4lpha-near', result: { header: { height: head.block_height, hash: head.block_hash } } }
      : r.params.method_name === 'get_metadata' ? envelope('dcl-get_metadata-at-224191815', edit.meta) : envelope(pool, edit.pool);
    return { status: 200, text: JSON.stringify(text) };
  }, async ms => { clock += Number(ms); }, { now: () => clock });
}
test('demo 1: the DCL reader parses the fixtures and refuses any changed pin, height or amount', async () => {
  const a = await readDemoDcl(fixtureRpc(), testNow), b = await readDemoDcl(fixtureRpc('dcl-get_pool-usdc-wnear-100-at-224191016'), testNow);
  assert.deepEqual(a, { at: testNow, block: 224191815, point: 402042, liquidity: '38363638340228440', volX: '938346379644874', volY: '394974450645950107623494817815790', protocolBps: 2000 });
  assert.deepEqual([b.point, b.block, b.liquidity, b.volX, b.protocolBps], [402048, 224191016, '38363638340228440', '938340389317330', 2000]);
  const refused = [{ meta: (m: Record<string, unknown>) => { m.version = '2.4.3'; } }, { pool: (p: Record<string, unknown>) => { p.fee = 200; } }, { height: 224191814 },
    { pool: (p: Record<string, unknown>) => { p.volume_x_in = '1.5'; } }, { pool: (p: Record<string, unknown>) => { p.liquidity = -1; } }, { meta: (m: Record<string, unknown>) => { m.protocol_fee_rate = 10_001; } },
    { meta: (m: Record<string, unknown>) => { m.state = 'Paused'; } }, { pool: (p: Record<string, unknown>) => { p.current_point = 800_000; } }];
  for (const edit of refused) await assert.rejects(readDemoDcl(fixtureRpc(undefined, edit), testNow), RpcUnavailable, JSON.stringify(Object.keys(edit)));
});

// ---- 2. LP arithmetic
test('demo 2: LP amounts reproduce the mainnet vectors A, B and C; L from amounts; out-of-range sides', () => {
  const within = (x: number, chain: bigint) => assert.ok(Math.abs(Math.ceil(x) - Number(chain)) <= 1, `${x} vs ${chain}`);
  const rel = (y: number, chain: bigint) => assert.ok(Math.abs(y / Number(chain) - 1) < 1e-9, `${y} vs ${chain}`);
  const [ax, ay] = lpXY(2882102904699, 401533, 401733, 401600);
  within(ax, 722176n); rel(ay, 102727895713676404911226n);
  assert.equal(lpLiquidity(722176n, near('0.2'), 401533, 401733, 401600), 2882102904692n, 'the X side binds');
  const [bx, by] = lpXY(3532376032350, 401294, 401494, 401427);
  within(bx, 447140n); rel(by, 245566611474843081813259n);
  const [cx, cy] = lpXY(2882102904699, 401533, 401733, 401500);
  assert.equal(Math.floor(cx), 1096070); assert.equal(cy, 0, 'below the range: all USDC');
  const [dx, dy] = lpXY(3532376032350, 401294, 401494, 401303);
  assert.equal(Math.floor(dx), 1291220); assert.ok(Math.abs(dy / 1.82691e22 - 1) < 1e-5);
  assert.deepEqual(lpXY(1000, 401533, 401733, 401733), [0, lpXY(1000, 401533, 401733, 401733)[1]], 'at or above the right edge: all wNEAR');
  assert.ok(lpXY(1000, 401533, 401733, 401733)[1] > 0);
});

// ---- 3. LP fees
function lpSim(patch: Partial<DemoLpSim> = {}): DemoLpSim {
  return { ledger: { usdc: '0', wnear: '0', native: '0', inUsdc: '0', inWnear: '0' }, reserve: near('0.8').toString(), swap: null, count: 1,
    position: { n: 1, left: 401900, right: 402200, liquidity: '2882102904699', paidX: '0', paidY: '0', feeX: '0', feeY: '0' }, range: { left: 401900, right: 402200 },
    nextRange: null, out: null, rotations: [], compounds: 0, lastCompound: 0, mark: null, history: [], protect: null, lastDecision: null, recentred: false,
    status: 'In range.', paid: { near: '0', token: '0' }, stopAt: null, ...patch };
}
test('demo 3: LP fees: the fixture vector, in range at both ends only, never negative, never across a gap, never before the position', async () => {
  assert.equal(lpFee(5990327544n, 2882102904699n, 38363638340228440n, 2000), 35n);
  assert.equal(lpFee(1594433972256614723314421758n, 2882102904699n, 38363638340228440n, 2000), 9581943277035491460n);
  const v0 = { volX: '938340389317330', volY: '394972856211977851008771503394032' }, v1 = { volX: '938346379644874', volY: '394974450645950107623494817815790' };
  const fees = async (mark: DemoLpSim['mark'], now: number, point: number, vol = v1) => {
    const a = agentOf('lp', LP_SERVER, near('1.2'), { sim: lpSim({ mark }) });
    const next = (await step(a, market(now, 2, { point, dcl: vol }), now)).a.sim as DemoLpSim;
    return [next.position!.feeX, next.position!.feeY];
  };
  const mark = { at: testNow, ...v0, inRange: true };
  assert.deepEqual(await fees(mark, testNow + MIN, 402042), ['35', '9581943277035491460']);
  assert.deepEqual(await fees({ ...mark, inRange: false }, testNow + MIN, 402042), ['0', '0'], 'out of range at the mark');
  assert.deepEqual(await fees(mark, testNow + MIN, 402200), ['0', '0'], 'out of range now');
  assert.deepEqual(await fees({ ...mark, ...v1 }, testNow + MIN, 402042, v0), ['0', '0'], 'a lower later volume gives 0');
  assert.deepEqual(await fees(mark, testNow + 181_000, 402042), ['0', '0'], 'no fee across a gap over 180 s');
  assert.deepEqual(await fees(mark, testNow + 180_000, 402042), ['35', '9581943277035491460']);
  assert.deepEqual(await fees(null, testNow + MIN, 402042), ['0', '0'], 'no mark: no fee');
  // The first tick after dcl_add earns nothing: the add sets the mark.
  let a = agentOf('lp', LP_SERVER, near('1.2'), { sim: lpSim({ position: null, ledger: { usdc: '0', wnear: '0', native: '0', inUsdc: '700000', inWnear: near('0.2').toString() } }) });
  ({ a } = await step(a, market(testNow, 2, { dcl: v0 }), testNow));
  assert.equal((a.sim as DemoLpSim).position!.feeX, '0');
  ({ a } = await step(a, market(testNow + MIN, 3, { dcl: v1 }), testNow + MIN));
  assert.ok(BigInt((a.sim as DemoLpSim).position!.feeX) > 0n, 'the next minute accrues');
});

// ---- 4. Grid
test('demo 4: Grid bootstrap, lanes, placement, the strict all-or-nothing fill, claims, the reverse wrap, protection and exit', async () => {
  for (const [preset, step] of [['tight', 45], ['balanced', 90], ['wide', 150], ['volatile', 300]] as const) {
    assert.deepEqual([0, 1, 2, 3].map(i => lanePoints(P0, i, step, 4)), [[P0 + step, P0], [P0 + 2 * step, P0 + step], [P0 - step, P0], [P0 - 2 * step, P0 - step]], preset);
    assert.deepEqual([0, 1].map(i => lanePoints(P0, i, step, 2)), [[P0 + step, P0], [P0 - step, P0]], preset);
  }
  let a = agentOf('grid', GRID, N), t = testNow, block = 10, log: DemoLogRow[] = [];
  const tick = async (o: Parameters<typeof market>[2] = {}) => { t += MIN; block++; ({ a, log } = await step(a, market(t, block, { pool: FIXTURE_POOL, ...o }), t)); return ops(log); };
  assert.deepEqual(await tick(), [], 'the start sets the anchor only');
  assert.equal((a.sim as DemoGridSim).anchor, P0);
  assert.deepEqual([await tick(), await tick(), await tick()], [['wrap'], ['swap'], ['wrap']]);
  let s = a.sim as DemoGridSim;
  assert.equal(s.usdc, '691756', 'the bootstrap vector on the 4512 fixture');
  assert.deepEqual(s.lanes.map(l => l.amount), ['345878', '345878', near('0.1').toString(), near('0.1').toString()]);
  assert.deepEqual([await tick(), await tick(), await tick(), await tick(), await tick()], [['dcl_place'], ['dcl_place'], ['dcl_place'], ['dcl_place'], []]);
  s = a.sim as DemoGridSim;
  assert.deepEqual(s.lanes.map(l => l.order!.point), [P0 + 90, P0 + 180, P0 - 90, P0 - 180], 'each lane rests on its side of the point');
  assert.equal(await tick({ point: P0 + 90 }).then(() => (a.sim as DemoGridSim).lanes[0]!.order!.filled), false, 'an equal point is not a fill');
  // Two orders crossed in one tick, the point back inside on the next: both stay filled and are claimed on two ticks.
  assert.deepEqual(await tick({ point: P0 + 181 }), ['dcl_claim']);
  assert.ok((a.sim as DemoGridSim).lanes[1]!.order!.filled);
  const before = gridValueOf(a.sim as DemoGridSim, P0);
  assert.deepEqual(await tick({ point: P0 }), ['dcl_claim']);
  assert.equal(log.filter(r => r.kind === 'fill').length, 1);
  s = a.sim as DemoGridSim;
  assert.deepEqual(s.lanes.slice(0, 2).map(l => [l.generation, l.sell, l.native, l.order]), [[1, WNEAR, true, null], [1, WNEAR, true, null]]);
  assert.equal(gridValueOf(s, P0), before - SIM_GAS.dcl_claim, 'a filled, unclaimed order counted its payout');
  // The NEAR-buying claim paid native NEAR: one wrap before the reverse order, which rests below the point at the lane's second point.
  assert.deepEqual(await tick({ point: P0 + 1 }), ['wrap']);
  assert.deepEqual(await tick({ point: P0 + 1 }), ['dcl_place']);
  s = a.sim as DemoGridSim;
  assert.deepEqual([s.lanes[0]!.order!.point, s.lanes[0]!.sell], [P0, WNEAR], 'the reverse lane uses its second point');
  assert.deepEqual(await tick({ point: P0 + 1 }), ['wrap']);
  assert.deepEqual(await tick({ point: P0 + 1 }), [], 'a wNEAR sell at P0 + 90 never rests above the point');
  // Never on an occupied point: lane 1 would sell USDC at P0 + 90, where lane 0 already rests.
  const occupied = agentOf('grid', GRID, N, { sim: { native: N.toString(), wnear: '0', usdc: '1000', anchor: P0, bootstrap: 3, protect: null, status: '', paid: { near: '0', token: '0' }, stopAt: null, lanes: [
    { generation: 0, sell: USDC, amount: '500', native: false, order: { point: P0 + 90, amount: '500', filled: false, payout: '0' } },
    { generation: 1, sell: USDC, amount: '500', native: false, order: null }, { generation: 0, sell: WNEAR, amount: '0', native: false, order: null },
    { generation: 0, sell: WNEAR, amount: '0', native: false, order: null }] } });
  assert.deepEqual(ops((await step(occupied, market(t, 1), t)).log), []);
  assert.deepEqual(ops((await step({ ...occupied, sim: { ...occupied.sim as DemoGridSim, lanes: (occupied.sim as DemoGridSim).lanes.map((l, i) => i === 0 ? { ...l, order: null, amount: '0' } : l) } }, market(t, 1), t)).log), ['dcl_place']);
  // Reserve end: a lane wrap that would leave less than 0.03 NEAR after its gas ends the agent with reserve; exactly 0.03 NEAR left still wraps.
  const wrapLane = (native: bigint) => agentOf('grid', GRID, N, { sim: { native: native.toString(), wnear: '0', usdc: '0', anchor: P0, bootstrap: 3, protect: null, status: '',
    paid: { near: '0', token: '0' }, stopAt: null, lanes: [{ generation: 1, sell: WNEAR, amount: near('0.1').toString(), native: true, order: null }] } });
  const poor = await step(wrapLane(near('0.1') + SIM_GAS.wrap + near('0.03') - 1n), market(t, 1), t);
  assert.deepEqual([poor.a.state, poor.a.endReason, ops(poor.log)], ['stopping', 'reserve', []]);
  assert.deepEqual(ops((await step(wrapLane(near('0.1') + SIM_GAS.wrap + near('0.03')), market(t, 1), t)).log), ['wrap']);
  // Term end: a step at the end of the term moves to stopping with term-ended.
  const term = await step(occupied, market(occupied.endsAt, 1), occupied.endsAt);
  assert.deepEqual([term.a.state, term.a.endReason], ['stopping', 'term-ended']);

  // Payout of 0.1 wNEAR at 401882 is the claimed 352662 USDC raw of FINDINGS 1.39.
  const lane = { generation: 0, sell: WNEAR as typeof WNEAR, amount: near('0.1').toString(), native: false, order: { point: 401882, amount: near('0.1').toString(), filled: false, payout: '0' } };
  const one = agentOf('grid', GRID, N, { sim: { native: N.toString(), wnear: '0', usdc: '0', anchor: 401972, bootstrap: 3, lanes: [lane], protect: null, status: '', paid: { near: '0', token: '0' }, stopAt: null } });
  const filled = await step(one, market(t, 1, { point: 401881 }), t);
  assert.deepEqual(filled.log.find(r => r.kind === 'fill')!.data, { side: 'sell', point: 401882, sold: near('0.1').toString(), bought: '352662' }, 'filled and claimed in one tick');
  assert.equal((filled.a.sim as DemoGridSim).lanes[0]!.amount, '352662');
  assert.equal(limitProceeds(WNEAR, near('0.1'), 401882), 352663n);
  // Conservation of a wNEAR-sell claim: the payout moves from the filled order to the USDC ledger, and the value falls by exactly the claim gas.
  const unclaimed = { ...one.sim as DemoGridSim, lanes: [{ ...lane, order: { ...lane.order, filled: true, payout: '352662' } }] };
  assert.equal(gridValueOf(filled.a.sim as DemoGridSim, 401881), gridValueOf(unclaimed, 401881) - SIM_GAS.dcl_claim);

  // Protection through gridProtectStep: a breach confirms 5 minutes later at a later block and resets after 30.
  const sl = gridSettingsFromRequest({ preset: 'balanced', orders: 4, stopLossPct: 10, takeProfitPct: 0 }) as GridSettings;
  const low = agentOf('grid', sl, N, { sim: { native: near('0.85').toString(), wnear: '0', usdc: '0', anchor: P0, bootstrap: 3, protect: null, status: '', paid: { near: '0', token: '0' }, stopAt: null,
    lanes: [0, 1, 2, 3].map(() => ({ generation: 0, sell: USDC, amount: '0', native: false, order: null })) } });
  const first = await step(low, market(testNow, 5), testNow);
  assert.deepEqual((first.a.sim as DemoGridSim).protect, { kind: 'stop-loss', since: testNow, block: 5 });
  assert.equal((await step(first.a, market(testNow + 5 * MIN, 5), testNow + 5 * MIN)).a.state, 'running', 'the same block never confirms');
  const fire = await step(first.a, market(testNow + 5 * MIN, 6), testNow + 5 * MIN);
  assert.deepEqual([fire.a.state, fire.a.endReason], ['stopping', 'stop-loss']);
  const reset = await step(first.a, market(testNow + 31 * MIN, 9), testNow + 31 * MIN);
  assert.deepEqual([reset.a.state, (reset.a.sim as DemoGridSim).protect?.since], ['running', testNow + 31 * MIN]);

  // Exit in the live order and the result.
  const exiting = agentOf('grid', GRID, N, { state: 'stopping', endReason: 'owner-stopped', sim: { native: near('0.5').toString(), wnear: near('0.05').toString(), usdc: '1000', anchor: P0, bootstrap: 3,
    protect: null, status: '', paid: { near: '0', token: '0' }, stopAt: null, lanes: [
      { generation: 0, sell: USDC, amount: '300000', native: false, order: { point: P0 + 90, amount: '300000', filled: true, payout: near('0.1').toString() } },
      { generation: 0, sell: WNEAR, amount: near('0.1').toString(), native: false, order: { point: P0 - 90, amount: near('0.1').toString(), filled: false, payout: '0' } }] } });
  let e = exiting;
  const seen: string[] = [];
  for (let i = 0; i < 6 && e.state !== 'ended'; i++) { const r = await step(e, market(t, 1), t); seen.push(...ops(r.log)); e = r.a; }
  assert.deepEqual(seen, ['dcl_claim', 'dcl_cancel', 'unwrap', 'ft_transfer', 'native_transfer']);
  assert.equal(e.state, 'ended');
  const g = SIM_GAS;
  assert.deepEqual(e.sim!.paid, { near: (near('0.5') + near('0.1') + near('0.1') + near('0.05') - g.dcl_claim - g.dcl_cancel - g.unwrap - g.ft_transfer - g.native_transfer).toString(), token: '1000' });
});

// ---- 5. LP
test('demo 5: LP open, ranges, rotation limits, compound, protection with the reserve and exit', async () => {
  const D = near('1.2'), lpAgent = (settings = LP_SERVER, patch: Partial<DemoAgent> = {}) => agentOf('lp', settings, D, patch);
  let a = lpAgent(), t = testNow, block = 1, log: DemoLogRow[] = [];
  const tick = async (o: Parameters<typeof market>[2] = {}, decide?: Parameters<typeof demoStep>[3]) => { t += MIN; block++; ({ a, log } = await step(a, market(t, block, o), t, decide)); return ops(log); };
  await tick();
  assert.equal(lpValues(a.sim as DemoLpSim, P0).low, D, 'value at creation equals the deposit');
  const seen: string[] = [];
  for (let i = 0; i < 6; i++) seen.push(...await tick());
  assert.deepEqual(seen, ['wrap', 'swap', 'wrap', 'dcl_deposit', 'dcl_deposit', 'dcl_add']);
  let s = a.sim as DemoLpSim;
  assert.deepEqual(s.range, { left: P0 - 100, right: P0 + 100 }, 'server range: 100 points each side');
  const gas = SIM_GAS.wrap * 2n + SIM_GAS.swap + SIM_GAS.dcl_deposit * 2n + SIM_GAS.dcl_add, { high } = lpValues(s, P0);
  assert.ok(high <= D - gas && D - gas - high <= near('0.2') * 31n / 10_000n + 2n * 10n ** 18n, `within gas and the swap fee: ${D - high}`);
  assert.equal(s.protect, null);
  // Explicit range and recentring at the add.
  const explicit = (minPrice: string, maxPrice: string) => lpSettingsFromPrices({ range: { mode: 'explicit', minPrice, maxPrice }, ai: false, compound: { on: false }, stopLossPct: 0, takeProfitPct: 0 }) as LpSettings;
  const price = (p: number) => (1e18 / 1.0001 ** p).toFixed(6);
  const opened = async (settings: LpSettings) => { let x = lpAgent(settings), b = 1; for (let i = 0; i < 7; i++) x = (await step(x, market(testNow + i * MIN, b++), testNow + i * MIN)).a; return x.sim as DemoLpSim; };
  const wide = await opened(explicit(price(P0 + 150), price(P0 - 150)));
  assert.deepEqual([wide.range, wide.recentred], [{ left: P0 - 150, right: P0 + 150 }, false]);
  const edge = await opened(explicit(price(P0 + 190), price(P0 - 10)));
  assert.deepEqual([edge.range, edge.recentred], [{ left: P0 - 100, right: P0 + 100 }, true], 'a range whose margin misses the point is re-centred');
  // Out of range: confirmed by the same side 5 minutes later at a later block, then a decision, a removal and a rebuild; at most 2 rotations a day.
  const out = P0 - 150;
  assert.deepEqual(await tick({ point: out }), []);
  assert.equal(a.sim!.status, 'Out of range, confirming.');
  t += 3 * MIN; assert.deepEqual(await tick({ point: out }), []);
  assert.equal((a.sim as DemoLpSim).nextRange, null, 'four minutes do not confirm');
  t += MIN; assert.deepEqual(await tick({ point: out }), []);
  assert.deepEqual([(a.sim as DemoLpSim).nextRange?.verdict, (a.sim as DemoLpSim).nextRange?.code, log[0]?.kind], ['fallback', 'off', 'decision']);
  assert.deepEqual(await tick({ point: out }), ['dcl_remove']);
  s = a.sim as DemoLpSim;
  assert.deepEqual([s.position, s.swap?.tokenIn, s.rotations.length], [null, USDC, 1], 'below the range: half of the USDC is swapped');
  const rebuild: string[] = [];
  for (let i = 0; i < 6; i++) rebuild.push(...await tick({ point: out }));
  assert.deepEqual(rebuild, ['swap', 'wrap', 'dcl_deposit', 'dcl_deposit', 'dcl_add'], 'then in range');
  assert.deepEqual([(a.sim as DemoLpSim).range, (a.sim as DemoLpSim).lastDecision?.verdict], [{ left: out - 100, right: out + 100 }, 'fallback']);
  const limited = lpAgent(LP_SERVER, { sim: lpSim({ rotations: [t - HOUR, t - 2 * HOUR], out: { side: 'below', since: t - 10 * MIN, block: 1 } }) });
  const blocked = await step(limited, market(t, 9, { point: 401800 }), t);
  assert.match(blocked.a.sim!.status, /rotation limit of 2 per 24 hours/);
  assert.equal((await step({ ...limited, sim: lpSim({ rotations: [t - DAY - 1, t - 2 * HOUR], out: { side: 'below', since: t - 10 * MIN, block: 1 } }) }, market(t, 9, { point: 401800 }), t)).log[0]?.kind, 'decision', 'the window rolls');
  // AI: an accepted range and a decide that waits for the tick's slot.
  const ai = lpSettingsFromPrices({ range: { mode: 'server' }, ai: true, compound: { on: false }, stopLossPct: 0, takeProfitPct: 0 }) as LpSettings;
  const due = lpAgent(ai, { sim: lpSim({ out: { side: 'below', since: t - 10 * MIN, block: 1 } }) });
  const accepted = await step(due, market(t, 9, { point: 401800 }), t, async () => ({ left: 401700, right: 401900, verdict: 'accepted' }));
  assert.deepEqual((accepted.a.sim as DemoLpSim).nextRange, { left: 401700, right: 401900, verdict: 'accepted' });
  const waiting = await step(due, market(t, 9, { point: 401800 }), t, async () => null);
  assert.deepEqual([(waiting.a.sim as DemoLpSim).nextRange, waiting.log], [null, []]);
  // Compound: the fee threshold on the position value only, and the 6-hour gap.
  const compound = lpSettingsFromPrices({ range: { mode: 'server' }, ai: false, compound: { on: true, minFeeBps: 100 }, stopLossPct: 0, takeProfitPct: 0 }) as LpSettings;
  const rich = (feeY: string, lastCompound = 0) => lpAgent(compound, { sim: lpSim({ lastCompound, position: { ...lpSim().position!, feeY } }) });
  assert.deepEqual(ops((await step(rich(near('0.05').toString()), market(t, 9), t)).log), ['dcl_remove']);
  assert.deepEqual(ops((await step(rich((near('0.05') - 1n).toString()), market(t, 9), t)).log), [], 'below the 0.05 NEAR floor');
  assert.deepEqual(ops((await step(rich(near('0.05').toString(), t - 5 * HOUR), market(t, 9), t)).log), [], 'within 6 hours of the last compound');
  const big = lpAgent(compound, { sim: lpSim({ position: { ...lpSim().position!, liquidity: '1000000000000000', feeY: near('0.06').toString() } }) });
  const value = lpValues(big.sim as DemoLpSim, P0);
  assert.ok((value.y + toNearDown(value.x, P0)) / 100n > near('0.06'), 'a large position needs more than the floor');
  assert.deepEqual(ops((await step(big, market(t, 9), t)).log), []);
  // Protection counts the reserve: 0.8 NEAR of reserve keeps a 50 % stop loss far away; a drained ledger fires after 5 minutes.
  const sl = lpSettingsFromPrices({ range: { mode: 'server' }, ai: false, compound: { on: false }, stopLossPct: 50, takeProfitPct: 0 }) as LpSettings;
  const kept = await step(lpAgent(sl, { sim: lpSim({ position: null }) }), market(t, 9), t);
  assert.deepEqual([kept.a.state, (kept.a.sim as DemoLpSim).protect], ['running', null], 'the 0.8 NEAR reserve is counted');
  const drained = lpAgent(sl, { sim: lpSim({ position: null, reserve: near('0.5').toString() }) });
  const breach = await step(drained, market(t, 9), t);
  assert.equal((breach.a.sim as DemoLpSim).protect?.kind, 'stop-loss');
  const fired = await step(breach.a, market(t + 5 * MIN, 10), t + 5 * MIN);
  assert.deepEqual([fired.a.state, fired.a.endReason], ['stopping', 'stop-loss']);
  // Term end: a step at the end of the term moves to stopping with term-ended.
  const term = await step(lpAgent(LP_SERVER, { sim: lpSim() }), market(testNow + 7 * DAY, 9), testNow + 7 * DAY);
  assert.deepEqual([term.a.state, term.a.endReason], ['stopping', 'term-ended']);
  // Conservation of a removal with fees: the value after equals the high value before less the removal gas (the USDC side is floored once: at most 1 yocto).
  const withFees = lpAgent(LP_SERVER, { state: 'stopping', endReason: 'owner-stopped', sim: lpSim({ position: { ...lpSim().position!, feeX: '1234', feeY: near('0.01').toString() } }) });
  const removed = await step(withFees, market(t, 9), t);
  const drop = lpValues(withFees.sim as DemoLpSim, P0).high - lpValues(removed.a.sim as DemoLpSim, P0).high;
  assert.deepEqual(ops(removed.log), ['dcl_remove']);
  assert.ok(drop <= SIM_GAS.dcl_remove && drop >= SIM_GAS.dcl_remove - 1n, `${drop}`);
  // Exit.
  let e = lpAgent(LP_SERVER, { state: 'stopping', endReason: 'owner-stopped', sim: lpSim({ ledger: { usdc: '5', wnear: '7', native: '11', inUsdc: '13', inWnear: '17' } }) });
  const exit: string[] = [];
  for (let i = 0; i < 8 && e.state !== 'ended'; i++) { const r = await step(e, market(t, 9), t); exit.push(...ops(r.log)); e = r.a; }
  assert.deepEqual(exit, ['dcl_remove', 'dcl_withdraw', 'dcl_withdraw', 'unwrap', 'ft_transfer', 'native_transfer']);
  assert.equal(e.state, 'ended');
});

test('demo 5: the LP AI budget: reserved before the call, 50 a day and 40 for visitors, one call per tick, each fallback code', async t => {
  const db = withDemo(t), demo = db.demo;
  for (let i = 0; i < 40; i++) assert.equal(demo.reserveDemoAi('2027-01-15', false), true);
  assert.equal(demo.reserveDemoAi('2027-01-15', false), false, 'the 41st for a visitor agent');
  for (let i = 0; i < 10; i++) assert.equal(demo.reserveDemoAi('2027-01-15', true), true);
  assert.equal(demo.reserveDemoAi('2027-01-15', true), false, 'the 51st of the day');
  assert.equal(demo.reserveDemoAi('2027-01-16', true), true, 'a new UTC day');
  // demoTick with a scripted chain and model: two due rotations, one call per tick.
  const ai = lpSettingsFromPrices({ range: { mode: 'server' }, ai: true, compound: { on: false }, stopLossPct: 0, takeProfitPct: 0 }) as LpSettings;
  const point = 401800, at = testNow + 10 * DAY;
  const rpc = (block: number): NearRpc => dummyRpc({ finalBlock: async () => ({ height: block, id: `b${block}` }),
    view: async (contract, method, args) => contract === DCL ? { height: block, blockId: `b${block}`, value: method === 'get_metadata' ? { version: '2.4.2', state: 'Running', protocol_fee_rate: 2000 }
      : { pool_id: `${USDC}|${WNEAR}|100`, token_x: USDC, token_y: WNEAR, fee: 100, point_delta: 1, state: 'Running', current_point: point, liquidity: '1', volume_x_in: '1', volume_y_in: '1' } }
      : contract === CLASSIC_EXCHANGE ? (() => { const pin = TRADE_PAIRS.find(p => p.pin.poolId === args.pool_id)!.pin;
        return { height: block, value: { pool_kind: 'SIMPLE_POOL', token_account_ids: pin.tokens, amounts: pin.tokens.map(x => x === WNEAR ? FAIR_POOL.wnear : FAIR_POOL.token), total_fee: pin.feeBps } }; })()
        : (() => { throw new RpcUnavailable(); })() });
  const codes: [LpAi | undefined, string, string?][] = [[undefined, 'fallback', 'off'], [async () => ({ left: 401700, right: 401900 }), 'accepted'],
    [async () => { throw new Error('timeout'); }, 'fallback', 'timeout'], [async () => { throw new Error('http'); }, 'fallback', 'http'],
    [async () => { throw new Error('malformed'); }, 'fallback', 'malformed'], [async () => { throw new Error('anything'); }, 'fallback', 'unavailable'],
    [async () => ({ left: 401790, right: 401810 }), 'fallback', 'width'], [async () => ({ left: 401500, right: 401700 }), 'fallback', 'misplaced']];
  for (const [model, verdict, code] of codes) {
    const a = db.web.createDemoAgent({ owner: createHash('sha256').update(String(Math.random())).digest('hex'), kind: 'lp', pair: 'usdc-wnear', settings: ai, depositYocto: near('1.2').toString(), seed: 0 }, at);
    const b = db.web.createDemoAgent({ owner: createHash('sha256').update(String(Math.random())).digest('hex'), kind: 'lp', pair: 'usdc-wnear', settings: ai, depositYocto: near('1.2').toString(), seed: 0 }, at);
    for (const x of [a, b]) assert.ok(demo.saveDemo(x, { state: 'running', endReason: null, sim: lpSim({ out: { side: 'below', since: at - 10 * MIN, block: 1 } }), log: [] }, at));
    const cycle = await demoTick({ store: demo, rpc: rpc(5), ...(model ? { ai: model } : {}), now: () => at + MIN });
    assert.deepEqual([cycle.reads, cycle.unreadable], [6, 0]);
    const [first, second] = [a, b].map(x => (demo.getDemoAgent(x.id)!.sim as DemoLpSim).nextRange);
    assert.deepEqual([first?.verdict, first?.code], [verdict, code], `${verdict} ${code}`);
    if (model) assert.equal(second, null, 'the second rotation waits for the next tick');
    for (const x of [a, b]) db.web.stopDemoAgent(demo.getDemoAgent(x.id)!, at);
    for (const x of [a, b]) { const y = demo.getDemoAgent(x.id)!; demo.saveDemo(y, { state: 'ended', endReason: 'owner-stopped', sim: y.sim, log: [] }, at); }
  }
  // The visitors' 40 calls of the day spent: a visitor agent's rotation gets the code budget through the cycle, and no call is made.
  const day = new Date(at + MIN).toISOString().slice(0, 10);
  while (demo.reserveDemoAi(day, false)) { /* spend */ }
  const a = db.web.createDemoAgent({ owner: 'c'.repeat(64), kind: 'lp', pair: 'usdc-wnear', settings: ai, depositYocto: near('1.2').toString(), seed: 0 }, at);
  demo.saveDemo(a, { state: 'running', endReason: null, sim: lpSim({ out: { side: 'below', since: at - 10 * MIN, block: 1 } }), log: [] }, at);
  let called = 0;
  await demoTick({ store: demo, rpc: rpc(6), ai: async () => { called++; return {}; }, now: () => at + MIN });
  assert.deepEqual([(demo.getDemoAgent(a.id)!.sim as DemoLpSim).nextRange?.code, called], ['budget', 0]);
  // F-11: a step that throws is logged on its agent; the later agent still steps and the heartbeat is written.
  db.web.stopDemoAgent(demo.getDemoAgent(a.id)!, at);
  { const y = demo.getDemoAgent(a.id)!; demo.saveDemo(y, { state: 'ended', endReason: 'owner-stopped', sim: y.sim, log: [] }, at); }
  const bad = db.web.createDemoAgent({ owner: 'd'.repeat(64), kind: 'lp', pair: 'usdc-wnear', settings: ai, depositYocto: near('1.2').toString(), seed: 0 }, at);
  const good = db.web.createDemoAgent({ owner: 'e'.repeat(64), kind: 'lp', pair: 'usdc-wnear', settings: ai, depositYocto: near('1.2').toString(), seed: 0 }, at);
  demo.saveDemo(bad, { state: 'running', endReason: null, sim: { broken: true } as unknown as DemoLpSim, log: [] }, at);
  demo.saveDemo(good, { state: 'running', endReason: null, sim: lpSim({ out: { side: 'below', since: at - 10 * MIN, block: 1 } }), log: [] }, at);
  const beat = at + 2 * MIN;
  await demoTick({ store: demo, rpc: rpc(7), now: () => beat });
  assert.ok(demo.demoLog(bad.id, 10).some(r => r.kind === 'decision' && JSON.stringify(r.data).includes('simulation step failed')), 'the failure is logged on the agent');
  assert.equal((demo.getDemoAgent(good.id)!.sim as DemoLpSim).nextRange?.verdict, 'fallback', 'the later agent still steps');
  assert.equal(demo.readHeartbeat('demo'), beat, 'the heartbeat is written');
});

// ---- 6. Schedule buy
test('demo 6: Schedule buy slots, the median guard, amounts, the floor, every end and one buy per slot', async () => {
  const deposit = tradePlan(SCHEDULE) + TRADE_RESERVE;
  let a = agentOf('schedule', SCHEDULE, deposit), t = testNow, block = 1, log: DemoLogRow[] = [];
  const tick = async (at: number, o: Parameters<typeof market>[2] = {}) => { t = at; block++; ({ a, log } = await step(a, market(t, block, { history: history(t), ...o }), t)); return ops(log); };
  await tick(testNow);
  assert.deepEqual(await tick(testNow + MIN, { history: history(testNow + MIN, FAIR_POOL, 9) }), []);
  assert.equal(a.sim!.status, 'Waiting: collecting 30 minutes of price history.');
  assert.deepEqual(await tick(testNow + 2 * MIN), ['wrap']);
  assert.equal(log[0]!.data.amount, near('0.1').toString());
  assert.deepEqual(await tick(testNow + 3 * MIN), ['swap']);
  let s = a.sim as DemoTradeSim;
  assert.deepEqual([s.spent, s.fills, s.lastSlot, s.wnear], [near('0.1').toString(), 1, 0, '0']);
  assert.equal(s.bought, outGivenIn(near('0.1'), BigInt(FAIR_POOL.wnear), BigInt(FAIR_POOL.token), 30).toString());
  assert.deepEqual(await tick(testNow + 30 * MIN), [], 'one buy per slot');
  assert.match(a.sim!.status, /^Next buy at /);
  // The floor: the next slot plans at one price; the swap tick finds 1 % fewer tokens, swaps nothing and keeps the wNEAR.
  assert.deepEqual(await tick(testNow + HOUR + MIN), ['wrap']);
  const dear = { wnear: FAIR_POOL.wnear, token: (BigInt(FAIR_POOL.token) * 99n / 100n).toString() };
  assert.deepEqual(await tick(testNow + HOUR + 2 * MIN, { pool: dear }), []);
  s = a.sim as DemoTradeSim;
  assert.deepEqual([s.wnear, s.buy, s.fills], [near('0.1').toString(), null, 1]);
  assert.deepEqual(await tick(testNow + HOUR + 3 * MIN), [], 'the next buy wraps only the shortfall: none');
  assert.ok((a.sim as DemoTradeSim).buy);
  assert.deepEqual(await tick(testNow + HOUR + 4 * MIN), ['swap']);
  assert.deepEqual([await tick(testNow + HOUR + 5 * MIN), a.state, a.endReason], [[], 'stopping', 'budget']);
  // Each end code: runs, date, the planned life.
  const ends = async (settings: TradeSettings, sim: Partial<DemoTradeSim>, now: number) => {
    const x = agentOf('schedule', settings, tradePlan(settings) + TRADE_RESERVE);
    const init = (await step(x, market(testNow, 1), testNow)).a;
    return (await step({ ...init, sim: { ...init.sim as DemoTradeSim, ...sim } }, market(now, 2), now)).a.endReason;
  };
  const runs = tradeSettingsFromRequest('schedule', { amountNear: '0.10', intervalSec: 3600, budgetNear: '0.30', end: { kind: 'runs', runs: 1 } }, testNow) as TradeSettings;
  assert.equal(await ends(runs, { fills: 1 }, testNow + 2 * HOUR), 'runs');
  const date = tradeSettingsFromRequest('schedule', { amountNear: '0.10', intervalSec: 3600, budgetNear: '0.30', end: { kind: 'date', atMs: testNow + 2 * HOUR } }, testNow) as TradeSettings;
  assert.equal(await ends(date, {}, testNow + 2 * HOUR), 'date');
  assert.equal(await ends(date, {}, testNow + 2 * HOUR - 1), null);
  assert.equal(await ends(SCHEDULE, {}, testNow + 6 * DAY), 'term-ended');
  // Exit, in the live order.
  let e = { ...a };
  const exit: string[] = [];
  for (let i = 0; i < 5 && e.state !== 'ended'; i++) { const r = await step(e, market(t, 9), t); exit.push(...ops(r.log)); e = r.a; }
  assert.deepEqual([exit, e.state], [['ft_transfer', 'native_transfer'], 'ended']);
});

// ---- 7. Auto DCA
test('demo 7: Auto DCA base buy, arming and skipping, one level per evaluation, the level floor, take profit, stop loss and life end', async () => {
  const deposit = tradePlan(DCA) + TRADE_RESERVE, W = BigInt(FAIR_POOL.wnear), T = BigInt(FAIR_POOL.token);
  const poolAt = (tokenPct: bigint) => ({ wnear: FAIR_POOL.wnear, token: (T * tokenPct / 100n).toString() });
  const bought = async (settings: TradeSettings) => {
    let x = agentOf('dca', settings, tradePlan(settings) + TRADE_RESERVE), at = testNow;
    for (let i = 0; i < 3; i++) { at += MIN; x = (await step(x, market(at, i + 2, { history: history(at) }), at)).a; }
    return { x, at };
  };
  let { x: a, at: t } = await bought(DCA);
  let s = a.sim as DemoTradeSim;
  assert.deepEqual([s.fills, s.p0?.num], [1, near('0.1').toString()], 'the base buy');
  void deposit;
  const tick = async (pool = FAIR_POOL, extra: Partial<DemoMarket> = {}) => { t += MIN; const r = await step(a, { ...market(t, 10 + t / MIN, { pool, history: history(t, pool) }), ...extra }, t); a = r.a; return ops(r.log); };
  assert.deepEqual(await tick(), []);
  assert.deepEqual((a.sim as DemoTradeSim).levels, ['armed', 'waiting', 'waiting'], 'one level armed at a time for 3 levels');
  // The level floor: planned at a 2 % cheaper token, the swap tick finds the old price, so nothing is swapped and the level stays armed.
  assert.deepEqual(await tick(poolAt(102n)), ['wrap']);
  assert.equal((a.sim as DemoTradeSim).buy?.level, 1);
  assert.deepEqual(await tick(), []);
  assert.deepEqual([(a.sim as DemoTradeSim).levels[0], (a.sim as DemoTradeSim).buy], ['armed', null]);
  assert.deepEqual(await tick(poolAt(102n)), [], 'the next fire wraps only the shortfall: none');
  assert.deepEqual(await tick(poolAt(102n)), ['swap']);
  assert.deepEqual((a.sim as DemoTradeSim).levels, ['filled', 'waiting', 'waiting']);
  assert.deepEqual(await tick(poolAt(102n)), [], 'level 2 (2.2 % under P0) is armed, not crossed');
  assert.deepEqual((a.sim as DemoTradeSim).levels, ['filled', 'armed', 'waiting']);
  assert.deepEqual(await tick(poolAt(110n)), ['wrap'], 'level 2 fires at a 10 % cheaper token');
  assert.deepEqual(await tick(poolAt(110n)), ['swap']);
  // A level already crossed when armed is skipped.
  assert.deepEqual(await tick(poolAt(110n)), []);
  assert.deepEqual((a.sim as DemoTradeSim).levels, ['filled', 'filled', 'skipped']);
  // One level per evaluation, with two armed (5 levels).
  const five = tradeSettingsFromRequest('dca', { baseNear: '0.10', orderNear: '0.10', levels: 5, stepBps: 100, tpBps: 150, slBps: 0 }, testNow) as TradeSettings;
  const f = await bought(five);
  const armed = await step(f.x, market(f.at + MIN, 50, { history: history(f.at + MIN) }), f.at + MIN);
  assert.deepEqual((armed.a.sim as DemoTradeSim).levels, ['armed', 'armed', 'waiting', 'waiting', 'waiting']);
  const deep = await step(armed.a, market(f.at + 2 * MIN, 51, { pool: poolAt(120n) }), f.at + 2 * MIN);
  assert.deepEqual([(deep.a.sim as DemoTradeSim).buy?.level, ops(deep.log)], [1, ['wrap']], 'only the shallowest crossed level');
  const p0 = { num: BigInt((f.x.sim as DemoTradeSim).p0!.num), den: BigInt((f.x.sim as DemoTradeSim).p0!.den) };
  assert.ok(outGivenIn(near('0.1'), W, T * 120n / 100n, 30) >= levelNeed(near('0.1'), p0, 2, 100), 'both levels were crossed');
  // Take profit: the token dearer by enough sells the whole position to native NEAR and ends with tp.
  s = a.sim as DemoTradeSim;
  const h = BigInt(s.bought) - BigInt(s.sold), line = tpLine(BigInt(s.spent) + BigInt(s.gasBuy), 150);
  t += MIN;
  const sale = await step(a, market(t, 99, { pool: poolAt(80n) }), t);
  const native0 = BigInt(s.native), proceeds0 = BigInt(s.proceeds), quote = outGivenIn(h, T * 80n / 100n, W, 30);
  a = sale.a; s = a.sim as DemoTradeSim;
  assert.deepEqual([ops(sale.log), sale.log.find(r => r.kind === 'op')!.data.note], [['swap'], TP_NOTE]);
  assert.deepEqual([a.state, a.endReason, s.token, s.sold], ['stopping', 'tp', '0', h.toString()]);
  assert.ok(BigInt(s.proceeds) >= line);
  // Conservation of the sale: the native balance gains the proceeds once, less the swap gas.
  assert.deepEqual([BigInt(s.native) - native0, BigInt(s.proceeds) - proceeds0], [quote - SIM_GAS.swap, quote]);
  // Stop loss: no breach while nothing is held; a breach confirmed 5 minutes later at a later block ends with sl and sells nothing.
  const slSettings = tradeSettingsFromRequest('dca', { baseNear: '0.10', orderNear: '0.10', levels: 3, stepBps: 100, tpBps: 150, slBps: 1000 }, testNow) as TradeSettings;
  const empty = (await step(agentOf('dca', slSettings, tradePlan(slSettings) + TRADE_RESERVE), market(testNow, 1), testNow)).a;
  const none = await step(empty, market(testNow + 10 * MIN, 2, { pool: poolAt(150n), history: history(testNow + 10 * MIN, FAIR_POOL, 3) }), testNow + 10 * MIN);
  assert.equal((none.a.sim as DemoTradeSim).protect, null, 'no breach while H is 0');
  const sl = await bought(slSettings);
  const breach = await step(sl.x, market(sl.at + MIN, 60, { pool: poolAt(150n) }), sl.at + MIN);
  assert.equal(breach.a.state, 'running');
  assert.ok((breach.a.sim as DemoTradeSim).protect);
  assert.equal((await step(breach.a, market(sl.at + 6 * MIN, 60, { pool: poolAt(150n) }), sl.at + 6 * MIN)).a.state, 'running', 'the same block never confirms');
  const confirmed = await step(breach.a, market(sl.at + 6 * MIN, 61, { pool: poolAt(150n) }), sl.at + 6 * MIN);
  assert.deepEqual([confirmed.a.state, confirmed.a.endReason, ops(confirmed.log)], ['stopping', 'sl', []]);
  assert.equal((await step(sl.x, market(testNow + 6 * DAY, 70), testNow + 6 * DAY)).a.endReason, 'term-ended');
});

// ---- 8. Store: deny by default
test('demo 8: store roles: the demo role is denied every write outside its own; four guards are allow-lists; caps, seeds, CAS and moves', async t => {
  const plain = stores(t), raw = new DatabaseSync(plain.path);
  assert.equal(raw.prepare("SELECT count(*) n FROM sqlite_schema WHERE name IN ('demo_agents','demo_log')").get()!.n, 0, 'a live database has no demo tables');
  raw.close();
  const db = withDemo(t, true), demo = db.demo, meme = db.meme!;
  const names = Object.getOwnPropertyNames(Store.prototype).filter(n => n !== 'constructor').sort();
  assert.deepEqual(names, ['acquireWorkerLock', 'activeJobs', 'attachWallet', 'blindHalt', 'blindResumeHistoryBlocked', 'blindResumeProof', 'budgetView', 'casJob', 'casMemeAgent',
    'casMemePosition', 'clearWatchReason', 'close', 'countPolicyOp', 'createDemoAgent', 'createJob', 'createMemeAgent', 'deleteSession', 'demoActive', 'demoAgents', 'demoLog',
    'expireReveals', 'finishWatch', 'frozenSince', 'getChallenge', 'getDemoAgent', 'getJob', 'getMemeAgent', 'getMemeAuction', 'getReveal', 'getSecrets', 'getSession', 'getWatch', 'grid',
    'gridProtectStop', 'gridSettings', 'gridStep', 'heartbeat', 'inFlightOp', 'inFlightOps', 'insertAlert', 'insertMemePosition', 'insertOp', 'insertReveal', 'invalidateWatch',
    'issueDclRegistration', 'jobByWallet', 'jobCounts', 'jobOps', 'listJobs', 'logMeme', 'lp', 'lpSettings', 'memeAgents', 'memeAuctions', 'memeCycles', 'memeLogs', 'memePositions', 'meta',
    'noReply', 'noteNoReply', 'noteResend',
    'openAlerts', 'opsSince', 'ownsWorkerLock', 'pendingReveals', 'protectStop', 'pruneMemeLogs', 'putChallenge', 'putSecrets', 'putSession', 'putWatch', 'readHeartbeat',
    'recentOps', 'releaseReconciledHalt', 'releaseWorkerLock', 'reserveDemoAi', 'resumeBlind', 'retireJob', 'rpcCoordinator', 'saveDemo', 'saveGrid', 'saveLp', 'saveMemeAuction', 'saveTrade', 'sealReveal', 'setMeta',
    'stopDemoAgent', 'stopResend', 'takeReveal', 'trade', 'tradeStop', 'updateOp', 'useChallenge', 'watchJournal', 'watchWaiting'], 'a new store method must be classified here');
  const allowed = new Set(['activeJobs', 'blindHalt', 'blindResumeHistoryBlocked', 'blindResumeProof', 'budgetView', 'getChallenge', 'getJob', 'getMemeAgent', 'getMemeAuction', 'getReveal',
    'getWatch', 'grid', 'gridSettings', 'gridStep', 'inFlightOp', 'inFlightOps', 'jobByWallet', 'jobCounts', 'jobOps', 'listJobs', 'lp', 'lpSettings', 'memeAgents', 'memeAuctions', 'memeCycles',
    'memeLogs', 'memePositions', 'meta', 'noReply', 'frozenSince', 'openAlerts', 'opsSince', 'ownsWorkerLock', 'readHeartbeat', 'recentOps', 'trade', 'watchJournal', 'watchWaiting',
    'getDemoAgent', 'demoAgents', 'demoActive', 'demoLog', 'saveDemo', 'reserveDemoAi', 'createDemoAgent', 'setMeta', 'heartbeat', 'rpcCoordinator', 'close']);
  for (const name of names.filter(n => !allowed.has(n))) {
    assert.throws(() => (demo as unknown as Record<string, () => unknown>)[name]!(), { code: 'forbidden' }, name);
  }
  for (const key of ['worker_lock', 'trade_px:4512', 'heartbeat:watchdog', 'heartbeat:worker', 'watch_blind:x', 'watch_clean:x', 'quota:w', 'grid_v2:x', 'meme_high_id', 'reveal_delivered:x']) {
    assert.throws(() => demo.setMeta(key, '1'), { code: 'forbidden' }, key);
  }
  demo.setMeta('demo_dcl', '[]'); assert.equal(demo.heartbeat('demo', testNow), true); assert.equal(demo.readHeartbeat('demo'), testNow);
  for (const name of ['worker', 'watchdog', 'meme'] as const) assert.throws(() => demo.heartbeat(name, testNow), { code: 'forbidden' });
  // Existing roles keep their behaviour in the four rewritten guards and in setJob.
  assert.throws(() => db.watch.casJob('x', 'running', 0, 'stopping'), { code: 'forbidden', message: 'The watchdog cannot change jobs.' });
  assert.throws(() => meme.casJob('x', 'running', 0, 'stopping'), { code: 'forbidden', message: 'This process cannot perform that store action.' });
  assert.equal(db.web.casJob('x', 'running', 0, 'stopping'), false); assert.equal(db.worker.casJob('x', 'running', 0, 'halted'), false);
  const c = { nonce: 'n', purpose: 'login' as const, jobId: null, message: 'm', issuedAt: testNow };
  assert.throws(() => db.watch.useChallenge(c, testNow), { message: 'The watchdog cannot use challenges.' });
  assert.throws(() => meme.useChallenge(c, testNow), { code: 'forbidden' }); assert.throws(() => demo.useChallenge(c, testNow), { code: 'forbidden' });
  assert.equal(db.web.useChallenge(c, testNow), false); assert.equal(db.worker.useChallenge(c, testNow), false);
  const alert = { jobId: 'x', severity: 'info' as const, kind: 'k', detail: {}, createdAt: testNow };
  assert.throws(() => db.web.insertAlert(alert), { message: 'The web process cannot create alerts.' });
  assert.throws(() => meme.insertAlert(alert), { code: 'forbidden' });
  assert.equal(db.worker.insertAlert(alert), true); assert.equal(db.watch.insertAlert(alert), true);
  assert.throws(() => meme.setMeta('demo_dcl', '1'), { code: 'forbidden' }); meme.setMeta('meme_x', '1');
  const job = db.web.createJob({ owner, kind: 'grid', mode: 'live', pair: 'usdc-wnear', depositYocto: N }, testNow);
  for (const s of [db.watch, meme, demo]) assert.equal(setJob(s, job, 'cancelled', testNow), false);
  assert.equal(setJob(db.web, job, 'cancelled', testNow), true);
  assert.throws(() => demo.insertOp(opRow({ id: job.id, walletId: 'w' })), { code: 'forbidden' });
  // Web creates only visitor agents, demo only seeds; web cannot save a step.
  const grid = { kind: 'grid' as const, pair: 'usdc-wnear', settings: GRID, depositYocto: N.toString() };
  const hash = (n: number) => createHash('sha256').update(`cookie${n}`).digest('hex');
  assert.throws(() => db.web.createDemoAgent({ ...grid, owner: 'operator', seed: 1 }, testNow), { code: 'forbidden' });
  assert.throws(() => db.web.createDemoAgent({ ...grid, owner: hash(1), seed: 1 }, testNow), { code: 'forbidden' }, 'web never creates a seed, even with a hash owner');
  assert.throws(() => db.web.createDemoAgent({ ...grid, owner: 'not-a-hash', seed: 0 }, testNow), { code: 'forbidden' });
  assert.throws(() => demo.createDemoAgent({ ...grid, owner: hash(1), seed: 0 }, testNow), { code: 'forbidden' });
  assert.throws(() => db.worker.createDemoAgent({ ...grid, owner: hash(1), seed: 0 }, testNow), { code: 'forbidden' });
  const a = db.web.createDemoAgent({ ...grid, owner: hash(1), seed: 0 }, testNow);
  assert.deepEqual([a.state, a.endsAt - a.createdAt, a.seed], ['running', 7 * DAY, 0]);
  assert.throws(() => db.web.saveDemo(a, { state: 'running', endReason: null, sim: null, log: [] }, testNow), { code: 'forbidden' });
  assert.throws(() => db.web.reserveDemoAi('2027-01-15', true), { code: 'forbidden' }, 'only the demo process reserves AI calls');
  const seed = demo.createDemoAgent({ ...grid, owner: 'operator', seed: 1 }, testNow);
  assert.equal(seed.endsAt - seed.createdAt, 14 * DAY);
  assert.equal(demo.createDemoAgent({ kind: 'dca', pair: 'trade-usdc', settings: DCA, depositYocto: (tradePlan(DCA) + TRADE_RESERVE).toString(), owner: 'operator', seed: 1 }, testNow).endsAt - testNow, 30 * DAY);
  assert.equal(demo.createDemoAgent({ kind: 'schedule', pair: 'trade-usdc', settings: SCHEDULE, depositYocto: (tradePlan(SCHEDULE) + TRADE_RESERVE).toString(), owner: 'operator', seed: 1 }, testNow).endsAt - testNow, 6 * DAY);
  // Caps: 3 per owner and 100 visitor agents in running or stopping; seeds are exempt.
  db.web.createDemoAgent({ ...grid, owner: hash(1), seed: 0 }, testNow); db.web.createDemoAgent({ ...grid, owner: hash(1), seed: 0 }, testNow);
  assert.throws(() => db.web.createDemoAgent({ ...grid, owner: hash(1), seed: 0 }, testNow), { code: 'limit_reached' });
  for (let i = 2; i < 99; i++) db.web.createDemoAgent({ ...grid, owner: hash(i), seed: 0 }, testNow);
  assert.throws(() => db.web.createDemoAgent({ ...grid, owner: hash(200), seed: 0 }, testNow), { code: 'limit_reached' });
  demo.createDemoAgent({ ...grid, owner: 'operator', seed: 1 }, testNow);
  // Allowed moves and compare-and-set on version.
  const next = (state: DemoAgent['state'], endReason: DemoAgent['endReason']) => ({ state, endReason, sim: null, log: [] });
  assert.throws(() => demo.saveDemo(a, next('running', 'reserve'), testNow), { code: 'forbidden' });
  assert.throws(() => demo.saveDemo(a, next('stopping', 'owner-stopped'), testNow), { code: 'forbidden' }, 'only the web stops for the owner');
  assert.throws(() => demo.saveDemo(a, next('ended', 'reserve'), testNow), { code: 'forbidden' });
  assert.equal(demo.saveDemo(a, next('running', null), testNow), true);
  assert.equal(demo.saveDemo(a, next('running', null), testNow), false, 'a stale version');
  const fresh = demo.getDemoAgent(a.id)!;
  assert.equal(demo.saveDemo(fresh, { ...next('stopping', 'operator-stopped'), log: [{ kind: 'end', data: { reason: 'operator-stopped' } }] }, testNow), true, 'the operator stop');
  const stopping = demo.getDemoAgent(a.id)!;
  assert.throws(() => demo.saveDemo(stopping, next('ended', 'reserve'), testNow), { code: 'forbidden' }, 'a stopping agent keeps its reason');
  assert.equal(demo.saveDemo(stopping, next('ended', 'operator-stopped'), testNow), true);
  assert.equal(demo.demoLog(a.id, 10)[0]!.kind, 'end');
  // The log keeps the last 2,000 rows per agent.
  assert.ok(demo.saveDemo(demo.getDemoAgent(seed.id)!, { ...next('running', null), log: Array.from({ length: 2001 }, (_, i) => ({ kind: 'op' as const, data: { i } })) }, testNow));
  assert.equal(demo.demoLog(seed.id, 5000).length, 2000);
  assert.equal(db.web.stopDemoAgent(demo.getDemoAgent(seed.id)!, testNow), false, 'a seed is never stopped from the web');
  const b = db.web.demoAgents(hash(1))[1]!;
  assert.equal(db.web.stopDemoAgent(b, testNow), true); assert.equal(db.web.stopDemoAgent(b, testNow), false);
});

test('demo 8: a demo store refuses a database with a live job or a worker heartbeat before any demo table is created in it (D-7)', async t => {
  for (const live of ['job', 'worker'] as const) {
    const db = stores(t);
    if (live === 'job') db.web.createJob({ owner, kind: 'grid', mode: 'live', pair: 'usdc-wnear', depositYocto: N }, testNow);
    else assert.ok(db.worker.acquireWorkerLock(process.pid, testNow));
    assert.throws(() => openStore(db.path, 'demo'), { code: 'forbidden' }, `${live}: demo process and seed.js`);
    assert.throws(() => openStore(db.path, 'web', true), { code: 'forbidden' }, `${live}: demo web`);
    const raw = new DatabaseSync(db.path);
    assert.equal(raw.prepare("SELECT count(*) n FROM sqlite_schema WHERE name LIKE 'demo%'").get()!.n, 0, `${live}: no demo table`);
    raw.close();
  }
});

// ---- 9. API
const ORIGIN = 'https://app.test';
function api(t: Parameters<typeof stores>[0], o: { demo?: boolean; marketData?: { url: string; token: string; fetch: typeof fetch }; now?: () => number } = {}) {
  const db = withDemo(t), demo = db.demo;
  const run = createHandler({ store: db.web, rpc: dummyRpc(), now: o.now ?? (() => testNow), ai: true, ...(o.marketData ? { marketData: o.marketData } : {}),
    env: { host: '127.0.0.1', port: 8090, origin: ORIGIN, liveHires: false, ...(o.demo === false ? {} : { demo: true }) } });
  async function request(path: string, method = 'GET', input?: unknown, cookie?: string, headers: Record<string, string | undefined> = {}, address = '203.0.113.7') {
    const raw = typeof input === 'string' ? input : input === undefined ? undefined : JSON.stringify(input);
    const req = Object.assign(Readable.from(raw === undefined ? [] : [Buffer.from(raw)]), { url: path, method, socket: { remoteAddress: address },
      headers: { host: 'app.test', origin: ORIGIN, cookie, 'content-type': 'application/json', ...headers } }) as unknown as IncomingMessage;
    const h = new Map<string, string>();
    let out = '';
    const res = { statusCode: 200, setHeader: (k: string, v: string) => h.set(k, v), end: (s: string) => { out = String(s); } };
    await run(req, res as unknown as ServerResponse);
    return { status: res.statusCode, headers: h, text: out, body: JSON.parse(out) as { data: unknown; error?: { code: string } } };
  }
  return { ...db, demo, request };
}
const gridBody = { kind: 'grid', pair: 'usdc-wnear', depositYocto: N.toString(), grid: { preset: 'balanced', orders: 4, stopLossPct: 0, takeProfitPct: 0 } };
test('demo 9: the API: flag, options, anonymous creation with a hashed cookie, validation, limits, public view, owner stop', async t => {
  assert.equal((await api(t, { demo: false }).request('/api/demo/options')).body.error?.code, 'not_found');
  const h = api(t);
  const options = record((await h.request('/api/demo/options')).body.data)!;
  assert.deepEqual([options.enabled, options.kinds, options.limits], [true, ['grid', 'lp', 'schedule', 'dca'], { perOwner: 3, total: 100, termDays: { grid: 7, lp: 7, schedule: 6, dca: 30 } }]);
  const hire = record(options.hire)!;
  const live = createHandler({ store: h.web, rpc: dummyRpc(), now: () => testNow, env: { host: '127.0.0.1', port: 8090, origin: ORIGIN, liveHires: true, gridV1: true, gridV2: true, lpV1: true, tradeV1: true } });
  h.web.putSession(tokenHash('s'.repeat(43)), owner, testNow, testNow + HOUR);
  let liveOut = '';
  await live(Object.assign(Readable.from([]), { url: '/api/hire/options', method: 'GET', headers: { host: 'app.test', cookie: `fourlpha_session=${'s'.repeat(43)}` } }) as unknown as IncomingMessage,
    { statusCode: 200, setHeader() {}, end: (s: string) => { liveOut = s; } } as unknown as ServerResponse);
  const liveHire = record(record(JSON.parse(liveOut))?.data)!;
  assert.deepEqual(Object.keys(hire).sort(), Object.keys(liveHire).sort(), 'the hire block has the shape of /api/hire/options');
  assert.deepEqual([hire.liveEnabled, hire.gridV1, hire.gridV2, hire.lpV1], [false, true, true, true]);
  assert.deepEqual(record(hire.trade)!.bounds, record(liveHire.trade)!.bounds); assert.deepEqual(record(hire.trade)!.defaults, record(liveHire.trade)!.defaults);
  for (const k of ['nativePerTx', 'readyFloor', 'agentFloorNear', 'freezeReserveNear', 'ownerAtStoreNear', 'ownerAdditionalNear', 'policyCostNear', 'netCostNear', 'dclStorage', 'minDeposit', 'maxDeposit'])
    assert.deepEqual(hire[k], liveHire[k], k);
  // Creation without a session sets the cookie and stores only its hash.
  const created = await h.request('/api/demo', 'POST', gridBody);
  assert.equal(created.status, 201);
  const cookieLine = created.headers.get('Set-Cookie')!, cookie = /^fourlpha_demo=([0-9a-f]{32});/.exec(cookieLine)![1]!;
  assert.match(cookieLine, /; Path=\/; HttpOnly; SameSite=Strict; Secure; Max-Age=2592000$/);
  const id = String(record(created.body.data)!.id), stored = h.web.getDemoAgent(id)!;
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(stored.owner, createHash('sha256').update(cookie).digest('hex'));
  for (const file of [h.path, `${h.path}-wal`]) assert.ok(!(existsSync(file) && readFileSync(file).includes(cookie)), 'the cookie value is never stored');
  const again = await h.request('/api/demo', 'POST', gridBody, `fourlpha_demo=${cookie}`);
  assert.equal(again.headers.get('Set-Cookie'), undefined, 'a valid cookie is kept');
  const short = await h.request('/api/demo', 'POST', gridBody, 'fourlpha_demo=abc', {}, '198.51.100.3');
  assert.match(short.headers.get('Set-Cookie') ?? '', /^fourlpha_demo=[0-9a-f]{32};/, 'a malformed cookie is replaced by a new one');
  const mine = (await h.request('/api/demo', 'GET', undefined, `fourlpha_demo=${cookie}`)).body.data as { id: string; value: string | null }[];
  assert.deepEqual(mine.map(x => x.id), [String(record(again.body.data)!.id), id]);
  assert.equal(mine[0]!.value, N.toString(), 'the value before the first tick is the deposit');
  assert.deepEqual((await h.request('/api/demo')).body.data, [], 'no cookie: an empty list');
  // Validation.
  const bad = [{ ...gridBody, extra: 1 }, { ...gridBody, name: 'x' }, { ...gridBody, depositYocto: (N - 1n).toString() }, { ...gridBody, depositYocto: (2n * N + 1n).toString() },
    { ...gridBody, pair: 'trade-usdc' }, { ...gridBody, depositYocto: 1 }, { kind: 'lp', pair: 'usdc-wnear', depositYocto: near('1.19').toString(), lp: { range: { mode: 'server' }, ai: false, compound: { on: false }, stopLossPct: 0, takeProfitPct: 0 } },
    { kind: 'schedule', pair: 'trade-usdc', depositYocto: near('0.6').toString(), trade: { amountNear: '0.10', intervalSec: 3600, budgetNear: '0.30', end: { kind: 'budget' } } },
    { kind: 'dca', pair: 'trade-nope', depositYocto: near('0.8').toString(), trade: { baseNear: '0.10', orderNear: '0.10', levels: 3, stepBps: 100, tpBps: 150, slBps: 0 } }, { kind: 'grid' }, 'x'];
  for (const input of bad) assert.equal((await h.request('/api/demo', 'POST', input)).body.error?.code, 'bad_request', JSON.stringify(input));
  assert.equal((await h.request('/api/demo', 'POST', { kind: 'schedule', pair: 'trade-zec', depositYocto: near('0.7').toString(), trade: { amountNear: '0.10', intervalSec: 3600, budgetNear: '0.30', end: { kind: 'budget' } } }, undefined, {}, '198.51.100.1')).status, 201);
  const price = (p: number) => (1e18 / 1.0001 ** p).toFixed(6);
  const lp = { kind: 'lp', pair: 'usdc-wnear', depositYocto: near('1.2').toString(), lp: { range: { mode: 'explicit', minPrice: price(P0 + 100), maxPrice: price(P0 - 100) }, ai: false, compound: { on: false }, stopLossPct: 0, takeProfitPct: 0 } };
  assert.equal((await h.request('/api/demo', 'POST', lp, undefined, {}, '198.51.100.2')).body.error?.code, 'rpc_unavailable', 'no sample');
  h.demo.setMeta('demo_dcl', JSON.stringify([dclAt(P0, testNow - 181_000, 1)]));
  assert.equal((await h.request('/api/demo', 'POST', lp, undefined, {}, '198.51.100.2')).body.error?.code, 'rpc_unavailable', 'a stale sample');
  h.demo.setMeta('demo_dcl', JSON.stringify([dclAt(P0 + 150, testNow - 1000, 1)]));
  assert.equal((await h.request('/api/demo', 'POST', lp, undefined, {}, '198.51.100.2')).body.error?.code, 'bad_request', 'the range must contain the point');
  h.demo.setMeta('demo_dcl', JSON.stringify([dclAt(P0, testNow - 1000, 1)]));
  assert.equal((await h.request('/api/demo', 'POST', lp, undefined, {}, '198.51.100.2')).status, 201);
  // At most 6 creations per address in 24 hours, whatever the cookie.
  const codes: number[] = [];
  for (let i = 0; i < 100; i++) codes.push((await h.request('/api/demo', 'POST', gridBody, undefined, {}, '192.0.2.9')).status);
  assert.deepEqual([codes.filter(c => c === 201).length, codes.slice(6).every(c => c === 409)], [6, true]);
  assert.equal((await h.request('/api/demo', 'POST', gridBody, undefined, { origin: undefined }, '192.0.2.10')).body.error?.code, 'forbidden');
  assert.equal((await h.request('/api/demo', 'POST', JSON.stringify({ ...gridBody, pad: 'x'.repeat(16_400) }), undefined, {}, '192.0.2.11')).body.error?.code, 'bad_request');
  // The public view and the owner stop.
  const view = await h.request(`/api/demo/${id}`);
  assert.equal(record(record(view.body.data)!.demo)!.isOwner, false);
  assert.ok(!view.text.includes(stored.owner) && !view.text.includes(cookie));
  assert.equal(record(record((await h.request(`/api/demo/${id}`, 'GET', undefined, `fourlpha_demo=${cookie}`)).body.data)!.demo)!.isOwner, true);
  assert.equal((await h.request('/api/demo/00000000-0000-4000-8000-000000000000')).body.error?.code, 'not_found');
  assert.equal((await h.request(`/api/demo/${id}/stop`, 'POST', {}, `fourlpha_demo=${'f'.repeat(32)}`)).body.error?.code, 'not_found');
  assert.equal((await h.request(`/api/demo/${id}/stop`, 'POST', {})).body.error?.code, 'not_found');
  assert.equal((await h.request(`/api/demo/${id}/stop`, 'POST', {}, `fourlpha_demo=${cookie}`)).status, 200);
  assert.equal((await h.request(`/api/demo/${id}/stop`, 'POST', {}, `fourlpha_demo=${cookie}`)).body.error?.code, 'conflict');
  const seed = h.demo.createDemoAgent({ owner: 'operator', kind: 'grid', pair: 'usdc-wnear', settings: GRID, depositYocto: N.toString(), seed: 1 }, testNow);
  assert.equal((await h.request(`/api/demo/${seed.id}/stop`, 'POST', {}, `fourlpha_demo=${cookie}`)).body.error?.code, 'not_found');
  assert.throws(() => webEnv({ FOURLPHA_DEMO: '1', FOURLPHA_LIVE_HIRES: '1' }), { code: 'bad_request' });
  assert.equal(webEnv({ FOURLPHA_DEMO: '1' }).demo, true); assert.equal(webEnv({}).demo, undefined);
});

test('demo 9: market data on a demo instance: no session, the same validation, a cache keyed by validated values and 60 upstream starts a minute', async t => {
  const calls: string[] = [];
  const fake = (async (u: string) => { calls.push(u); return new Response(JSON.stringify(u.includes('liquidity') ? { data: { bins: [{ tickLower: 1 }], currentTick: 1 }, meta: {} } : { data: [], meta: {} })); }) as unknown as typeof fetch;
  const h = api(t, { marketData: { url: 'http://dp.test', token: 'dp-token', fetch: fake } });
  assert.equal((await h.request('/api/market-data/ohlcv?kind=pool&address=rhea-4512')).status, 200);
  assert.equal((await h.request('/api/pool-liquidity?address=rhea-dcl-usdc-wnear')).status, 200);
  for (const q of ['kind=token&address=rhea-4512', 'kind=pool&address=0xabc', 'kind=pool&address=rhea-4512&limit=501']) assert.equal((await h.request(`/api/market-data/ohlcv?${q}`)).status, 400, q);
  assert.equal((await h.request('/api/pool-liquidity?address=rhea-4512&window=1001')).status, 400);
  assert.equal(calls.length, 2);
  assert.equal((await h.request('/api/market-data/ohlcv?kind=pool&address=rhea-4512&z=anything&limit=300')).status, 200);
  assert.equal(calls.length, 2, 'an unknown extra parameter is served from the cache');
  for (let i = 1; i <= 58; i++) assert.equal((await h.request(`/api/market-data/ohlcv?kind=pool&address=rhea-6458&limit=${i}`)).status, 200);
  assert.equal(calls.length, 60);
  const refused = await h.request('/api/market-data/ohlcv?kind=pool&address=rhea-6458&limit=59');
  assert.deepEqual([refused.status, refused.body.error?.code, calls.length], [503, 'market_data_unavailable', 60], 'the 61st miss of a minute');
  assert.equal((await h.request('/api/market-data/ohlcv?kind=pool&address=rhea-6458&limit=58')).status, 200, 'cached entries are still served');
  const live = api(t, { demo: false, marketData: { url: 'http://dp.test', token: 'dp-token', fetch: fake } });
  assert.equal((await live.request('/api/market-data/ohlcv?kind=pool&address=rhea-4512')).status, 200, 'public agent page P-5: a live instance answers without a session too');
  const bare = api(t);
  assert.equal((await bare.request('/api/market-data/ohlcv?kind=pool&address=rhea-4512')).body.error?.code, 'market_data_unconfigured');
});

// ---- Demo in the main app (docs/specs/DEMO-MODE-COMBINED-PLAN.md section 4)
test('demo combined 1: webEnv accepts a separate demo database with live hires, refuses the live database path, and keeps the standalone rules', () => {
  const live = { FOURLPHA_LIVE_HIRES: '1', FOURLPHA_DB_PATH: 'data/live.db' };
  const env = webEnv({ ...live, FOURLPHA_DEMO_DB_PATH: 'data/live-demo.db' });
  assert.deepEqual([env.liveHires, env.demoDb, env.demo], [true, 'data/live-demo.db', undefined]);
  for (const bad of [{ ...live, FOURLPHA_DEMO_DB_PATH: 'data/live.db' }, { ...live, FOURLPHA_DEMO_DB_PATH: './data/../data/live.db' },
    { FOURLPHA_LIVE_HIRES: '1', FOURLPHA_DEMO_DB_PATH: 'data/4lpha-near.db' }, { FOURLPHA_LIVE_HIRES: '1', FOURLPHA_DEMO_DB_PATH: './data/4lpha-near.db' }])
    assert.throws(() => webEnv(bad), { code: 'bad_request' }, JSON.stringify(bad));
  assert.equal(webEnv({ FOURLPHA_DEMO_DB_PATH: '' }).demoDb, undefined);
  // Standalone: unchanged, and a demo database path is ignored there.
  assert.throws(() => webEnv({ FOURLPHA_DEMO: '1', FOURLPHA_LIVE_HIRES: '1', FOURLPHA_DEMO_DB_PATH: 'data/live-demo.db' }), { code: 'bad_request' });
  const standalone = webEnv({ FOURLPHA_DEMO: '1', FOURLPHA_DB_PATH: 'data/demo.db', FOURLPHA_DEMO_DB_PATH: 'data/demo.db' });
  assert.deepEqual([standalone.demo, standalone.demoDb, standalone.liveHires], [true, undefined, false]);
});

test('demo combined 2: one web, two databases: the demo routes use only the demo database; live routes and hire options behave as before', async t => {
  const db = stores(t), dir = mkdtempSync(join(tmpdir(), '4lpha-near-demo-')), demoPath = join(dir, 'demo.db');
  const demoWeb = openStore(demoPath, 'web', true), demoSim = openStore(demoPath, 'demo');
  t.after(() => { demoWeb.close(); demoSim.close(); rmSync(dir, { recursive: true }); });
  const calls: string[] = [];
  const fake = (async (u: string) => { calls.push(u); return new Response(JSON.stringify(u.includes('liquidity') ? { data: { bins: [{ tickLower: 1 }], currentTick: 1 }, meta: {} } : { data: [], meta: {} })); }) as unknown as typeof fetch;
  const env = { host: '127.0.0.1', port: 8090, origin: ORIGIN, liveHires: true, gridV1: true, gridV2: true, lpV1: true, tradeV1: true };
  const base = { store: db.web, rpc: dummyRpc(), now: () => testNow, ai: true, marketData: { url: 'http://dp.test', token: 'dp-token', fetch: fake } };
  const combined = createHandler({ ...base, demoStore: demoWeb, env: { ...env, demoDb: demoPath } }), live = createHandler({ ...base, env });
  async function call(run: typeof live, path: string, method = 'GET', input?: unknown, cookie?: string) {
    const req = Object.assign(Readable.from(input === undefined ? [] : [Buffer.from(JSON.stringify(input))]), { url: path, method, socket: { remoteAddress: '203.0.113.7' },
      headers: { host: 'app.test', origin: ORIGIN, cookie, 'content-type': 'application/json' } }) as unknown as IncomingMessage;
    const h = new Map<string, string>();
    let out = '';
    const res = { statusCode: 200, setHeader: (k: string, v: string) => h.set(k, v), end: (s: string) => { out = String(s); } };
    await run(req, res as unknown as ServerResponse);
    return { status: res.statusCode, headers: h, body: JSON.parse(out) as { data: unknown; error?: { code: string } } };
  }
  // The demo options read the demo database: its point, its spot and its AI budget.
  const day = new Date(testNow).toISOString().slice(0, 10);
  demoSim.setMeta('demo_dcl', JSON.stringify([dclAt(P0, testNow - 1000, 1)]));
  demoSim.setMeta('demo_px:4512', JSON.stringify([{ at: testNow - 1000, block: 1, ...FAIR_POOL }]));
  demoSim.setMeta(`demo_ai:${day}`, '50');
  const options = record((await call(combined, '/api/demo/options')).body.data)!, hire = record(options.hire)!;
  assert.deepEqual([options.ai, hire.demo, record(hire.lp)!.point], [false, true, P0]);
  assert.deepEqual((record(hire.trade)!.pairs as { id: string; spot: unknown }[]).find(p => p.id === 'trade-usdc')!.spot, { num: FAIR_POOL.wnear, den: FAIR_POOL.token });
  // Create, list, view and stop without a session: every row lands in the demo database.
  const created = await call(combined, '/api/demo', 'POST', gridBody);
  assert.equal(created.status, 201);
  const cookie = `fourlpha_demo=${/^fourlpha_demo=([0-9a-f]{32});/.exec(created.headers.get('Set-Cookie')!)![1]}`, id = String(record(created.body.data)!.id);
  assert.equal(demoWeb.getDemoAgent(id)!.state, 'running');
  assert.deepEqual(((await call(combined, '/api/demo', 'GET', undefined, cookie)).body.data as { id: string }[]).map(a => a.id), [id]);
  assert.equal(record(record((await call(combined, `/api/demo/${id}`)).body.data)!.demo)!.isOwner, false);
  assert.equal((await call(combined, `/api/demo/${id}/stop`, 'POST', {}, cookie)).status, 200);
  assert.equal(demoWeb.getDemoAgent(id)!.state, 'stopping');
  const raw = (path: string, q: string) => { const r = new DatabaseSync(path); try { return Number(r.prepare(q).get()!.n); } finally { r.close(); } };
  assert.equal(raw(demoPath, 'SELECT count(*) n FROM demo_agents'), 1);
  assert.equal(raw(db.path, "SELECT count(*) n FROM sqlite_schema WHERE name LIKE 'demo%'"), 0, 'the live database has no demo table');
  assert.equal(raw(db.path, "SELECT count(*) n FROM meta WHERE key LIKE 'demo%'"), 0);
  // Live routes as before; /api/hire/options gains only `demo`. The live handler without a demo store answers not_found on the demo routes.
  const session = `fourlpha_session=${'s'.repeat(43)}`;
  db.web.putSession(tokenHash('s'.repeat(43)), owner, testNow, testNow + HOUR);
  const [withDemo, without] = [record((await call(combined, '/api/hire/options', 'GET', undefined, session)).body.data)!, record((await call(live, '/api/hire/options', 'GET', undefined, session)).body.data)!];
  assert.deepEqual([withDemo.demo, without.demo], [true, false]);
  assert.deepEqual({ ...withDemo, demo: false }, without);
  for (const path of ['/api/jobs', '/api/me']) assert.deepEqual((await call(combined, path, 'GET', undefined, session)).body, (await call(live, path, 'GET', undefined, session)).body, path);
  assert.equal((await call(live, '/api/demo/options')).body.error?.code, 'not_found');
  // Market data answers without a session in every mode (public agent page P-5).
  assert.equal((await call(combined, '/api/market-data/ohlcv?kind=pool&address=rhea-4512')).status, 200);
  assert.equal((await call(combined, '/api/pool-liquidity?address=rhea-dcl-usdc-wnear')).status, 200);
  assert.notEqual((await call(live, '/api/pool-liquidity?address=rhea-4512')).status, 401);
  // main() (not started here): the live store opens as before, then the demo store on the demo path with the demo flag, and only that one reaches the handler.
  const main = readFileSync('src/web/server.ts', 'utf8'), liveAt = main.indexOf("openStore(dbPath(), 'web', env.demo === true)"), demoAt = main.indexOf("openStore(env.demoDb, 'web', true)");
  assert.ok(liveAt > 0 && demoAt > liveAt && main.includes('...(demoStore ? { demoStore } : {})'), 'main() opens the demo store on its own path after the live store');
});

// ---- 10. Isolation
test('demo 10: the runtime closure of the demo modules is pinned and reaches no money module; no QuickNode route; the moves are the same objects', async () => {
  const forbidden = ['outlayer.js', 'secrets.js', 'ops.js', 'policy.js', 'watchdog.js', 'hire.js', 'grid.js', 'lp.js', 'trade.js', 'budget.js', 'evidence.js', 'dcl-evidence.js', 'holdings.js'];
  const seen = new Set<string>();
  const walk = (path: string) => {
    if (seen.has(path)) return; seen.add(path);
    for (const m of readFileSync(path, 'utf8').matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = m[1] ?? m[2] ?? m[3]!;
      if (spec.startsWith('.')) walk(resolve(dirname(path), spec));
    }
  };
  const roots = [...readdirSync('dist/src/demo').filter(f => f.endsWith('.js')).map(f => resolve('dist/src/demo', f)),
    ...readdirSync('dist/src/core').filter(f => /^demo-.*\.js$/.test(f)).map(f => resolve('dist/src/core', f))];
  assert.deepEqual(roots.map(p => p.split(sep).slice(-2).join('/')).sort(), ['core/demo-cycle.js', 'core/demo-market.js', 'core/demo-sim.js', 'core/demo-view.js', 'demo/main.js', 'demo/seed.js']);
  roots.forEach(walk);
  const closure = [...seen].map(p => p.split(sep).slice(-2).join('/')).sort();
  assert.deepEqual(closure.filter(p => forbidden.includes(p.split('/')[1]!)), []);
  assert.deepEqual(closure, ['core/amounts.js', 'core/config.js', 'core/demo-cycle.js', 'core/demo-market.js', 'core/demo-sim.js', 'core/demo-view.js', 'core/errors.js',
    'core/grid-settings.js', 'core/lp-ai.js', 'core/lp-settings.js', 'core/meme-paper.js', 'core/near-rpc.js', 'core/pins.js', 'core/rhea-classic.js', 'core/rhea-dcl.js',
    'core/rpc-pacing.js', 'core/store.js', 'core/trade-pairs.js', 'core/trade-settings.js', 'demo/main.js', 'demo/seed.js'], 'the pinned allowed set');
  for (const file of [...readdirSync('src/demo').map(f => `src/demo/${f}`), ...readdirSync('src/core').filter(f => /^demo-.*\.ts$/.test(f)).map(f => `src/core/${f}`)]) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /rpcEnv/, file); assert.doesNotMatch(source, /httpFetcher\(\s*[^)\s]/, file);
  }
  // The demo process refuses without FOURLPHA_DEMO=1 or FOURLPHA_DB_PATH before it opens a store. Checked on the source: a test never starts the process.
  const main = readFileSync('src/demo/main.ts', 'utf8'), refusal = main.indexOf("if (process.env.FOURLPHA_DEMO !== '1' || !path) throw new Error();");
  assert.ok(refusal > 0 && refusal < main.indexOf('openStore('), 'the flag and database path refusals come before the store');
  const load = (f: string) => import(pathToFileURL(resolve('dist/src/core', f)).href) as Promise<Record<string, unknown>>;
  const [grid, gs, lp, ls, trade, ts] = await Promise.all(['grid.js', 'grid-settings.js', 'lp.js', 'lp-settings.js', 'trade.js', 'trade-settings.js'].map(load));
  for (const k of ['GRID_BOOTSTRAP', 'gridSettingsFromRequest', 'lanePoints', 'restingSide', 'gridProtectStep']) assert.equal(grid![k], gs![k], k);
  for (const k of ['lpSettingsFromPrices', 'LP_MIN_DEPOSIT', 'LP_RESERVE', 'LP_CONFIRM_MS', 'LP_MAX_ROTATIONS', 'LP_COMPOUND_FLOOR']) assert.equal(lp![k], ls![k], k);
  for (const k of ['outGivenIn', 'levelNeed', 'tpLine', 'medianWait']) { assert.equal(trade![k], ts![k], k); assert.equal(typeof ts![k], 'function'); }
});

// ---- 11. View, 12 lives in web/test/demo-ui.test.ts, 13. Conservation
const JOB_KEYS = ['agentAccount', 'agentBalance', 'alerts', 'blindHalt', 'canFund', 'canResumeBlind', 'canReveal', 'canStopEarly', 'depositYocto', 'extraTokens', 'frozen', 'grid',
  'holdings', 'id', 'kind', 'linkConfirmed', 'linkDelivered', 'lp', 'name', 'operations', 'owner', 'ownerBalance', 'payload', 'pendingSubmission', 'reason', 'resumeBlockedReason',
  'state', 'trade', 'waitingForChain', 'walletPubkey'];
test('demo 11: the public view has every key of the page Job, the fixed values of 7.3 and decimal strings for every amount', async t => {
  const db = withDemo(t), demo = db.demo;
  const lpBody = lpSettingsFromPrices({ range: { mode: 'server' }, ai: false, compound: { on: false }, stopLossPct: 0, takeProfitPct: 0 }) as LpSettings;
  const bodies = [{ kind: 'grid', pair: 'usdc-wnear', settings: GRID, depositYocto: N }, { kind: 'lp', pair: 'usdc-wnear', settings: lpBody, depositYocto: near('1.2') },
    { kind: 'schedule', pair: 'trade-usdc', settings: SCHEDULE, depositYocto: tradePlan(SCHEDULE) + TRADE_RESERVE }, { kind: 'dca', pair: 'trade-rhea', settings: DCA, depositYocto: tradePlan(DCA) + TRADE_RESERVE }] as const;
  for (const [i, body] of bodies.entries()) {
    let a = db.web.createDemoAgent({ owner: createHash('sha256').update(`v${i}`).digest('hex'), kind: body.kind, pair: body.pair, settings: body.settings, depositYocto: body.depositYocto.toString(), seed: 0 }, testNow);
    const before = demoPublicView(db.web, a, testNow, false);
    assert.deepEqual(Object.keys(before.job).sort(), JOB_KEYS, `${body.kind} before the first tick`);
    for (let k = 0; k < 9; k++) {
      const at = testNow + (k + 1) * MIN, next = await demoStep(a, market(at, k + 2, { history: history(at) }), at);
      demo.saveDemo(a, next, at); a = demo.getDemoAgent(a.id)!;
    }
    demo.setMeta('demo_dcl', JSON.stringify([dclAt(P0, testNow + 9 * MIN, 11)]));
    for (const id of [4512, 6458, 6065]) demo.setMeta(`demo_px:${id}`, JSON.stringify([{ at: testNow + 9 * MIN, block: 11, ...FAIR_POOL }]));
    const { job, demo: meta } = demoPublicView(db.web, a, testNow + 9 * MIN + 1000, true);
    assert.deepEqual(Object.keys(job).sort(), JOB_KEYS, body.kind);
    assert.deepEqual([job.owner, job.agentAccount, job.walletPubkey, job.ownerBalance, job.payload, job.canReveal, job.linkDelivered, job.linkConfirmed, job.canFund, job.canStopEarly,
      job.waitingForChain, job.blindHalt, job.canResumeBlind, job.resumeBlockedReason, job.frozen, job.pendingSubmission, job.alerts, job.extraTokens, job.name],
      ['demo', null, null, null, null, false, false, false, false, false, false, false, false, null, null, null, [], [], null], body.kind);
    assert.deepEqual([meta.simulated, meta.isOwner, meta.seed, meta.omits, meta.ai.cap], [true, true, false, DEMO_OMITS, 50]);
    const amounts: unknown[] = [job.depositYocto, job.agentBalance, ...Object.values(job.holdings.tokens)];
    assert.ok(job.operations.length > 0 && job.operations.every(o => o.txHash === null && o.state === 'finished' && ['success', 'swapped'].includes(o.verdict)), body.kind);
    if (job.grid) amounts.push(job.grid.value, ...job.grid.orders.flatMap(o => [o.remain, o.bought, o.unclaimed]), ...job.grid.lanes.map(l => l.amount));
    if (job.lp) amounts.push(job.lp.valueLow, job.lp.valueHigh, job.lp.initialPosition, job.lp.positionValue, ...Object.values(job.lp.ledger!), job.lp.position!.liquidity, ...job.lp.position!.estimate!, ...job.lp.position!.fees);
    if (job.trade) amounts.push(...Object.values(job.trade.ledger), job.trade.value, job.trade.walletValue, job.trade.pnl?.replace(/^-/, ''));
    for (const v of amounts) assert.match(String(v), /^\d+$/, `${body.kind}: ${String(v)}`);
    assert.equal(JSON.stringify(job).includes(a.owner), false);
  }
});

function totalValue(a: DemoAgent, point: number, px: Sample): bigint {
  const s = a.sim!, paid = s.paid;
  if (a.kind === 'grid') {
    const g = s as DemoGridSim;
    let nearPart = BigInt(g.native) + BigInt(g.wnear) + BigInt(paid.near), usdc = BigInt(g.usdc) + BigInt(paid.token);
    for (const l of g.lanes) if (l.order) { const n = BigInt(l.order.filled ? l.order.payout : l.order.amount); if ((l.sell === USDC) !== l.order.filled) usdc += n; else nearPart += n; }
    return nearPart + toNearDown(usdc, point);
  }
  if (a.kind === 'lp') {
    const l = s as DemoLpSim, v = lpValues({ ...l, ledger: { ...l.ledger, usdc: (BigInt(l.ledger.usdc) + BigInt(paid.token)).toString() } }, point);
    return v.high + BigInt(paid.near);
  }
  const tr = s as DemoTradeSim, pair = TRADE_PAIRS.find(p => p.id === a.pair)!;
  return tradeValueOf({ ...tr, token: (BigInt(tr.token) + BigInt(paid.token)).toString() }, pair, px) + BigInt(paid.near);
}
test('demo 13: conservation on an unchanged market: no step invents value, each falls by its gas, and the result is the value before the exit less the exit gas', async () => {
  const lpBody = lpSettingsFromPrices({ range: { mode: 'server' }, ai: false, compound: { on: false }, stopLossPct: 0, takeProfitPct: 0 }) as LpSettings;
  const kinds = [agentOf('grid', GRID, N), agentOf('lp', lpBody, near('1.2')), agentOf('schedule', SCHEDULE, tradePlan(SCHEDULE) + TRADE_RESERVE), agentOf('dca', DCA, tradePlan(DCA) + TRADE_RESERVE)];
  const px = { at: 0, block: 0, ...FAIR_POOL };
  for (let a of kinds) {
    let at = testNow;
    const tick = async () => {
      at += MIN;
      const before = a.sim ? totalValue(a, P0, px) : BigInt(a.depositYocto), r = await step(a, market(at, at / MIN, { history: history(at) }), at);
      const after = totalValue(r.a, P0, px), op = r.log.find(x => x.kind === 'op'), gas = op ? BigInt(String(op.data.gas)) : 0n;
      if (!op) assert.equal(after, before, `${a.kind}: no step, no change`);
      else if (op.data.kind === 'swap' || op.data.kind === 'dcl_add') assert.ok(after <= before - gas && after >= before - gas - near('0.002'), `${a.kind} ${String(op.data.kind)}: ${before - after}`);
      else assert.equal(after, before - gas, `${a.kind} ${String(op.data.kind)}`);
      a = r.a;
      return { before, gas, op };
    };
    const strategy: string[] = [], exit: string[] = [];
    for (let i = 0; i < 12; i++) { const { op } = await tick(); if (op) strategy.push(String(op.data.kind)); }
    assert.equal(a.state, 'running', a.kind);
    assert.ok(strategy.includes('wrap') && strategy.includes(a.kind === 'grid' ? 'dcl_place' : a.kind === 'lp' ? 'dcl_add' : 'swap'), `${a.kind}: ${strategy.join(',')}`);
    a = { ...a, state: 'stopping', endReason: 'owner-stopped' };
    const start = totalValue(a, P0, px);
    let exitGas = 0n;
    for (let i = 0; i < 10 && a.state !== 'ended'; i++) { const { gas, op } = await tick(); exitGas += gas; if (op) exit.push(String(op.data.kind)); }
    assert.equal(a.state, 'ended', a.kind);
    assert.equal(exit.at(-1), 'native_transfer', `${a.kind}: ${exit.join(',')}`);
    const pair = TRADE_PAIRS.find(p => p.id === a.pair);
    const result = BigInt(a.sim!.paid.near) + (pair ? outGivenIn(BigInt(a.sim!.paid.token), BigInt(px.token), BigInt(px.wnear), pair.pin.feeBps) : toNearDown(BigInt(a.sim!.paid.token), P0));
    assert.equal(result, start - exitGas, `${a.kind}: the result`);
  }
});
