import { YOCTO_PER_NEAR as N } from './amounts.js';
import { record } from './errors.js';
import { GRID_BOOTSTRAP, gridProtectStep, gridSettingsFromRequest, lanePoints, offsets, restingSide, type GridProtect } from './grid-settings.js';
import type { GridSettings } from './grid.js';
import type { LpAiInput } from './lp-ai.js';
import { LP_COMPOUND_FLOOR, LP_CONFIRM_MS, LP_MAX_ROTATIONS, LP_MIN_DEPOSIT, LP_RESERVE, lpCentred, lpRangeOk, lpSettingsFromPrices } from './lp-settings.js';
import type { LpLedger, LpRange, LpSettings } from './lp.js';
import { PAIRS, USDC, WNEAR, validPoint } from './pins.js';
import { DCL_POOL, limitProceeds, otherToken, toNearDown, type DclToken } from './rhea-dcl.js';
import { TRADE_PAIRS, type TradePair } from './trade-pairs.js';
import { levelNeed, medianWait, outGivenIn, roundBasis, roundReset, tpLine, TRADE_RESERVE, tradePlan, tradeSettingsFromRequest, type DcaRound, type RoundBase, type Sample, type TradeSettings } from './trade-settings.js';

// Demo mode (docs/specs/DEMO-MODE-SPEC.md): a simulation that applies the live rules and constants through shared pure functions to simulated
// balances. It signs nothing and holds no key. Every value here is display money for a simulation, never a live amount.
export const DEMO_KINDS = ['grid', 'lp', 'schedule', 'dca'] as const;
export type DemoKind = typeof DEMO_KINDS[number];
export type DemoEndReason = 'owner-stopped' | 'operator-stopped' | 'term-ended' | 'stop-loss' | 'take-profit' | 'budget' | 'runs' | 'date' | 'tp' | 'sl' | 'reserve';
export type DemoSettings = GridSettings | LpSettings | TradeSettings;
export type DemoOp = 'wrap' | 'unwrap' | 'swap' | 'dcl_place' | 'dcl_claim' | 'dcl_cancel' | 'dcl_deposit' | 'dcl_add' | 'dcl_remove' | 'dcl_withdraw' | 'ft_transfer' | 'native_transfer';
export interface DemoLogRow { kind: 'op' | 'fill' | 'decision' | 'end'; data: Record<string, unknown>; }
interface Common { status: string; paid: { near: string; token: string }; stopAt: number | null; }
export interface DemoOrder { point: number; amount: string; filled: boolean; payout: string; }
export interface DemoLane { generation: number; sell: DclToken; amount: string; native: boolean; order: DemoOrder | null; }
export interface DemoGridSim extends Common { native: string; wnear: string; usdc: string; anchor: number; bootstrap: number; lanes: DemoLane[]; protect: GridProtect | null; }
export interface DemoPosition { n: number; left: number; right: number; liquidity: string; paidX: string; paidY: string; feeX: string; feeY: string; }
export type DemoRange = LpRange & { verdict: 'fallback' | 'accepted' | 'rebuild'; code?: string };
export interface DemoLpSim extends Common {
  ledger: LpLedger; reserve: string; swap: { tokenIn: DclToken; amount: string } | null; position: DemoPosition | null; count: number;
  range: LpRange; nextRange: DemoRange | null; out: { side: 'below' | 'above'; since: number; block: number } | null; rotations: number[];
  compounds: number; lastCompound: number; mark: { at: number; volX: string; volY: string; inRange: boolean } | null; history: { at: number; point: number }[];
  protect: { kind: 'stop-loss' | 'take-profit'; since: number; block: number; fired?: { kind: string; value: string; basis: string; block: number; at: number } } | null;
  lastDecision: { at: number; verdict: string; code?: string; range: LpRange } | null; recentred: boolean;
}
export interface DemoTradeSim extends Common {
  native: string; wnear: string; token: string; spent: string; bought: string; sold: string; proceeds: string; gasBuy: string; gasSell: string;
  fills: number; lastSlot: number | null; anchor: number; buy: { amount: string; floor: string; slot?: number; level?: number } | null;
  p0: { num: string; den: string } | null; levels: ('waiting' | 'armed' | 'filled' | 'skipped')[]; protect: { since: number; block: number } | null;
  /** Auto DCA rounds, as the live state (docs/specs/TRADE-V1-DCA-ROUNDS-SPEC.md 3). Absent: round 1. */
  round?: number; roundBase?: RoundBase; cooldownUntil?: number | null; rounds?: DcaRound[];
}
export type DemoSim = DemoGridSim | DemoLpSim | DemoTradeSim;
export interface DemoAgent {
  id: string; owner: string; kind: DemoKind; pair: string; state: 'running' | 'stopping' | 'ended'; endReason: DemoEndReason | null;
  settings: DemoSettings; depositYocto: string; sim: DemoSim | null; seed: number; createdAt: number; endsAt: number; updatedAt: number; version: number;
}
export interface DemoNext { state: DemoAgent['state']; endReason: DemoEndReason | null; sim: DemoSim | null; log: DemoLogRow[]; }
/** One DCL sample (section 1): amounts are decimal strings. */
export interface DemoDcl { at: number; block: number; point: number; liquidity: string; volX: string; volY: string; protocolBps: number; }
/** This tick's samples only: a pool that failed this tick is absent. `history` is the stored list per classic pool, for the median guard. */
export interface DemoMarket { dcl: DemoDcl | null; pools: Readonly<Record<number, Sample | undefined>>; history: Readonly<Record<number, readonly Sample[]>>; }
export type DemoDecide = (input: LpAiInput, fallback: LpRange) => Promise<(LpRange & { verdict: 'accepted' | 'fallback'; code?: string }) | null>;

/** Section 5.0: gas per operation kind, each at or above the measured live cost (FINDINGS 1.27, 1.39, Trade V1 AD-5). */
export const SIM_GAS: Readonly<Record<DemoOp, bigint>> = {
  swap: 3n * N / 1000n, dcl_place: 15n * N / 10_000n, dcl_claim: 15n * N / 10_000n, dcl_cancel: 15n * N / 10_000n,
  wrap: 11n * N / 10_000n, unwrap: 11n * N / 10_000n, native_transfer: 11n * N / 10_000n, ft_transfer: 11n * N / 10_000n,
  dcl_deposit: 3n * N / 1000n, dcl_add: 3n * N / 1000n, dcl_remove: 3n * N / 1000n, dcl_withdraw: 3n * N / 1000n,
};
/** A strategy step must leave this much native NEAR after its gas, or the agent ends with `reserve` (section 5.0). */
const FLOOR = 3n * N / 100n;
const DAY = 86_400_000;
/** Restated from trade.ts SL_CONFIRM_MS and SL_RESET_MS (private there): a stop loss confirms 5 to 30 minutes after the first breach. */
const SL_CONFIRM_MS = 300_000, SL_RESET_MS = 1_800_000;
const COMPOUND_GAP_MS = 21_600_000;
export const TP_NOTE = 'Take profit sale.';
const b =(v: string) => BigInt(v);
const min = (x: bigint, y: bigint) => x < y ? x : y;
const exactKeys = (r: Record<string, unknown> | null, keys: string[]) => !!r && Object.keys(r).length === keys.length && keys.every(k => Object.hasOwn(r, k));

/**
 * Section 5: the one creation validator, used by POST /api/demo and seed.js. It reuses the live parsers and restates only the deposit bounds of
 * hire.ts draftProblems (1 to 2 NEAR for Grid, 1.2 to 3 NEAR for LP, plan plus 0.4 NEAR for the trade kinds) and the range rule left <= point < right.
 */
export function demoCreate(body: unknown, market: { point: number | null }, now: number):
  { kind: DemoKind; pair: string; depositYocto: bigint; settings: DemoSettings } | 'invalid' | 'rpc_unavailable' {
  const r = record(body), kind = r?.kind;
  if (!r || typeof kind !== 'string' || !(DEMO_KINDS as readonly string[]).includes(kind)) return 'invalid';
  const key = kind === 'grid' ? 'grid' : kind === 'lp' ? 'lp' : 'trade';
  if (!exactKeys(r, ['kind', 'pair', 'depositYocto', key]) || typeof r.pair !== 'string' || typeof r.depositYocto !== 'string' || !/^\d{1,30}$/.test(r.depositYocto)) return 'invalid';
  const deposit = b(r.depositYocto), pair = r.pair;
  if (kind === 'grid') {
    const settings = gridSettingsFromRequest(r.grid);
    return settings === 'invalid' || pair !== PAIRS[0].id || deposit < N || deposit > 2n * N ? 'invalid' : { kind, pair, depositYocto: deposit, settings };
  }
  if (kind === 'lp') {
    const settings = lpSettingsFromPrices(r.lp);
    if (settings === 'invalid' || pair !== PAIRS[0].id || deposit < LP_MIN_DEPOSIT || deposit > 3n * N) return 'invalid';
    if (settings.range.mode === 'explicit') {
      if (market.point === null) return 'rpc_unavailable';
      if (market.point < settings.range.left || market.point >= settings.range.right) return 'invalid';
    }
    return { kind, pair, depositYocto: deposit, settings };
  }
  const settings = tradeSettingsFromRequest(kind, r.trade, now);
  return settings === 'invalid' || !TRADE_PAIRS.some(p => p.id === pair) || deposit !== tradePlan(settings) + TRADE_RESERVE ? 'invalid'
    : { kind: kind as 'schedule' | 'dca', pair, depositYocto: deposit, settings };
}

// ---- LP arithmetic (section 5.2.1): discrete per point, in doubles, fitted to the mainnet vectors.
const sq = (i: number) => Math.pow(1.0001, i / 2);
/** x (USDC raw) and y (wNEAR yocto) of liquidity L over [left, right) at point c. The current point counts on the wNEAR side. */
export function lpXY(L: number, left: number, right: number, c: number): [number, number] {
  let x = 0, y = 0;
  for (let i = Math.max(c + 1, left); i < right; i++) x += L / sq(i);
  for (let i = left; i <= Math.min(c, right - 1); i++) y += L * sq(i);
  return [x, y];
}
/** L = floor(min(X / x(1), Y / y(1))) over the sides the range has at c. */
export function lpLiquidity(X: bigint, Y: bigint, left: number, right: number, c: number): bigint {
  const [x1, y1] = lpXY(1, left, right, c), sides = [...(x1 > 0 ? [Number(X) / x1] : []), ...(y1 > 0 ? [Number(Y) / y1] : [])];
  return sides.length ? BigInt(Math.floor(Math.min(...sides))) : 0n;
}
/** The amounts a removal returns now (floor). */
export function lpValueXY(p: Pick<DemoPosition, 'liquidity' | 'left' | 'right'>, c: number): [bigint, bigint] {
  const [x, y] = lpXY(Number(p.liquidity), p.left, p.right, c);
  return [BigInt(Math.floor(x)), BigInt(Math.floor(y))];
}
/** Section 5.2.4 (estimate, U-1): the fee of the input volume, less the protocol share, times the position's share of the active liquidity. One floor. */
export function lpFee(delta: bigint, L: bigint, poolLiquidity: bigint, protocolBps: number): bigint {
  return delta > 0n ? delta * 100n * BigInt(10_000 - protocolBps) * L / (1_000_000n * 10_000n * (poolLiquidity + L)) : 0n;
}

// ---- Values in NEAR (section 5.0: USDC converts at the DCL point with toNearDown, as the live view does).
/** Restates grid.ts gridValue: an open order counts its amount in its sell token, a filled, unclaimed order its payout in the bought token. */
export function gridValueOf(s: DemoGridSim, point: number): bigint {
  let near = b(s.native) + b(s.wnear), usdc = b(s.usdc);
  for (const l of s.lanes) if (l.order) {
    const n = b(l.order.filled ? l.order.payout : l.order.amount);
    if ((l.sell === USDC) !== l.order.filled) usdc += n; else near += n;
  }
  return near + toNearDown(usdc, point);
}
/** As live LP V2 protection (lp.ts tickLp): low counts the whole wallet, reserve included, and the position at the point; high adds the fees. */
export function lpValues(s: DemoLpSim, point: number): { low: bigint; high: bigint; x: bigint; y: bigint } {
  const [x, y] = s.position ? lpValueXY(s.position, point) : [0n, 0n], l = s.ledger;
  const low = b(s.reserve) + b(l.native) + b(l.wnear) + b(l.inWnear) + y + toNearDown(b(l.usdc) + b(l.inUsdc) + x, point);
  return { low, high: low + b(s.position?.feeY ?? '0') + toNearDown(b(s.position?.feeX ?? '0'), point), x, y };
}
/** Trade kinds: native + wNEAR + the held token sold back on this sample's reserves (the held token equals H until the exit pays it out). */
export function tradeValueOf(s: DemoTradeSim, pair: TradePair, px: Sample): bigint {
  return b(s.native) + b(s.wnear) + outGivenIn(b(s.token), b(px.token), b(px.wnear), pair.pin.feeBps);
}

// ---- The tick (sections 5.1 to 5.4). At most one simulated transaction per agent and tick.
interface Work { state: DemoAgent['state']; endReason: DemoEndReason | null; log: DemoLogRow[]; }
function stop(w: Work, s: Common, reason: DemoEndReason, now: number, note?: string) {
  // A stopping agent keeps the reason it entered stopping with (spec 3.2).
  if (w.state !== 'running') return;
  w.state = 'stopping'; w.endReason = reason; s.stopAt = now;
  w.log.push({ kind: 'end', data: { reason, ...(note ? { note } : {}) } });
}
const op = (w: Work, kind: DemoOp, amount: bigint, gas: bigint, extra: { out?: bigint; note?: string } = {}) =>
  w.log.push({ kind: 'op', data: { kind, amount: amount.toString(), ...(extra.out !== undefined ? { out: extra.out.toString() } : {}), gas: gas.toString(), ...(extra.note ? { note: extra.note } : {}) } });
/** Section 5.0 reserve end: the step's gas, and the native NEAR it moves out, must leave 0.03 NEAR. */
const afford = (native: bigint, gas: bigint, spend = 0n) => gas + spend <= native - FLOOR;

export async function demoStep(a: DemoAgent, m: DemoMarket, now: number, decide?: DemoDecide): Promise<DemoNext> {
  const w: Work = { state: a.state, endReason: a.endReason, log: [] };
  if (a.state === 'ended') return { ...w, sim: a.sim };
  const sim = a.sim === null ? null : structuredClone(a.sim);
  // Each kind mutates `w` (state, reason, log), so the result is read after the step.
  const next = a.kind === 'grid' ? grid(a, a.settings as GridSettings, sim as DemoGridSim | null, m, now, w)
    : a.kind === 'lp' ? await lp(a, a.settings as LpSettings, sim as DemoLpSim | null, m, now, w, decide)
      : trade(a, a.settings as TradeSettings, sim as DemoTradeSim | null, m, now, w);
  return { state: w.state, endReason: w.endReason, sim: next, log: w.log };
}

function grid(a: DemoAgent, g: GridSettings, s: DemoGridSim | null, m: DemoMarket, now: number, w: Work): DemoGridSim | null {
  const dcl = m.dcl, pool = m.pools[4512];
  if (!dcl) return s;
  if (!s) {
    // 1. Start: the anchor is the first sampled point, as live tickGrid.
    const init: DemoGridSim = { native: a.depositYocto, wnear: '0', usdc: '0', anchor: dcl.point, bootstrap: 0, protect: null, status: 'Bootstrapping.',
      paid: { near: '0', token: '0' }, stopAt: null,
      lanes: offsets(g.step, g.orders).map((_, i) => ({ generation: 0, sell: i < g.orders / 2 ? USDC : WNEAR, amount: '0', native: false, order: null })) };
    if (offsets(g.step, g.orders).some((_, i) => lanePoints(dcl.point, i, g.step, g.orders).some(p => !validPoint(p)))) stop(w, init, 'reserve', now, 'anchor too close to the point limit');
    return init;
  }
  // 5. Fill, all or nothing, before the step: an order the point moved strictly past is consumed for good (no transaction, no gas).
  for (const l of s.lanes) if (l.order && !l.order.filled && (l.sell === USDC ? dcl.point > l.order.point : dcl.point < l.order.point)) {
    const proceeds = limitProceeds(l.sell, b(l.order.amount), l.order.point) - 1n;
    l.order = { ...l.order, filled: true, payout: (proceeds > 0n ? proceeds : 0n).toString() };
  }
  const claim = (i: number) => {
    const l = s.lanes[i], o = l.order!, bought = otherToken(l.sell), gas = min(SIM_GAS.dcl_claim, b(s.native));
    s.native = (b(s.native) - gas).toString();
    // 6. A NEAR-buying claim pays native NEAR on DCL 2.4.2 (FINDINGS 1.41), so the lane wraps it before its reverse order.
    if (bought === WNEAR) s.native = (b(s.native) + b(o.payout)).toString(); else s.usdc = (b(s.usdc) + b(o.payout)).toString();
    op(w, 'dcl_claim', b(o.payout), gas);
    w.log.push({ kind: 'fill', data: { side: l.sell === WNEAR ? 'sell' : 'buy', point: o.point, sold: o.amount, bought: o.payout } });
    s.lanes[i] = { generation: l.generation + 1, sell: bought, amount: o.payout, native: bought === WNEAR, order: null };
  };
  if (w.state === 'stopping') { gridExit(s, now, w, claim); return s; }
  if (now >= a.endsAt) { stop(w, s, 'term-ended', now); return s; }
  // 8. Protection after bootstrap, through the live gridProtectStep.
  if (s.bootstrap === 3) {
    const r = gridProtectStep(s.protect, { value: gridValueOf(s, dcl.point), deposit: b(a.depositYocto), settings: g, now, block: dcl.block, runningSince: a.createdAt });
    s.protect = r.protect;
    if (r.fire) { stop(w, s, r.protect!.fired!.kind, now); return s; }
  }
  const native = b(s.native);
  // 2. Bootstrap, one step per tick: wrap 0.2, swap 0.2 wNEAR to USDC on 4512, wrap 0.2.
  if (s.bootstrap < 3) {
    const kind = s.bootstrap === 1 ? 'swap' : 'wrap', gas = SIM_GAS[kind];
    if (kind === 'swap' && !pool) return s;
    if (!afford(native, gas, kind === 'wrap' ? GRID_BOOTSTRAP : 0n)) { stop(w, s, 'reserve', now); return s; }
    s.native = (native - gas - (kind === 'wrap' ? GRID_BOOTSTRAP : 0n)).toString();
    if (kind === 'wrap') {
      s.wnear = (b(s.wnear) + GRID_BOOTSTRAP).toString();
      op(w, 'wrap', GRID_BOOTSTRAP, gas);
      if (++s.bootstrap === 3) { const lanes = s.lanes.filter(l => l.sell === WNEAR); for (const l of lanes) l.amount = (GRID_BOOTSTRAP / BigInt(lanes.length)).toString(); }
    } else {
      const out = outGivenIn(GRID_BOOTSTRAP, b(pool!.wnear), b(pool!.token), 30), lanes = s.lanes.filter(l => l.sell === USDC);
      s.wnear = (b(s.wnear) - GRID_BOOTSTRAP).toString(); s.usdc = (b(s.usdc) + out).toString();
      // The USDC output is split evenly over the USDC lanes; the remainder stays in the ledger.
      for (const l of lanes) l.amount = (out / BigInt(lanes.length)).toString();
      op(w, 'swap', GRID_BOOTSTRAP, gas, { out });
      s.bootstrap = 2;
    }
    s.status = s.bootstrap === 3 ? 'Placing orders.' : 'Bootstrapping.';
    return s;
  }
  const filled = s.lanes.findIndex(l => l.order?.filled);
  if (filled >= 0) {
    if (!afford(native, SIM_GAS.dcl_claim)) { stop(w, s, 'reserve', now); return s; }
    claim(filled); s.status = 'A full fill was claimed.';
    return s;
  }
  // 4. Placement, one per tick, lanes with generation > 0 first, on the resting side and never on an occupied point.
  const candidates = s.lanes.map((lane, i) => ({ lane, i })).sort((x, y) => Number(y.lane.generation > 0) - Number(x.lane.generation > 0));
  for (const { lane, i } of candidates) {
    if (lane.order) continue;
    const point = lanePoints(s.anchor, i, g.step, s.lanes.length)[lane.generation % 2], n = b(lane.amount);
    if (n <= 0n) continue;
    if (lane.native) {
      if (!afford(native, SIM_GAS.wrap, n)) { stop(w, s, 'reserve', now); return s; }
      s.native = (native - n - SIM_GAS.wrap).toString(); s.wnear = (b(s.wnear) + n).toString(); lane.native = false;
      op(w, 'wrap', n, SIM_GAS.wrap); s.status = 'Wrapping a lane payout.';
      return s;
    }
    if (!restingSide(lane.sell, point, dcl.point) || s.lanes.some(l => l.order?.point === point)) continue;
    if (!afford(native, SIM_GAS.dcl_place)) { stop(w, s, 'reserve', now); return s; }
    s.native = (native - SIM_GAS.dcl_place).toString();
    if (lane.sell === USDC) s.usdc = (b(s.usdc) - n).toString(); else s.wnear = (b(s.wnear) - n).toString();
    lane.order = { point, amount: lane.amount, filled: false, payout: '0' };
    op(w, 'dcl_place', n, SIM_GAS.dcl_place, { note: `${lane.sell === USDC ? 'sell USDC' : 'sell wNEAR'} at ${point}` });
    s.status = 'An order was placed.';
    return s;
  }
  s.status = 'Waiting for a full fill or an available resting price and slot.';
  return s;
}

/** 5.1 step 9, in the live exit order (ops.ts: unwrap, token, native last): claims, cancels, unwrap, USDC, then native NEAR less its own gas. */
function gridExit(s: DemoGridSim, now: number, w: Work, claim: (i: number) => void) {
  const gas = (k: DemoOp) => min(SIM_GAS[k], b(s.native)), filled = s.lanes.findIndex(l => l.order?.filled), open = s.lanes.findIndex(l => l.order && !l.order.filled);
  s.status = 'Stopping: settling the simulated balances.';
  if (filled >= 0) { claim(filled); return; }
  if (open >= 0) {
    const l = s.lanes[open], n = b(l.order!.amount), g = gas('dcl_cancel');
    s.native = (b(s.native) - g).toString();
    if (l.sell === USDC) s.usdc = (b(s.usdc) + n).toString(); else s.wnear = (b(s.wnear) + n).toString();
    l.order = null; op(w, 'dcl_cancel', n, g);
    return;
  }
  settleExit(s, w, b(s.usdc), () => { s.usdc = '0'; });
}
/** The shared tail of an exit for the Grid and trade ledgers: unwrap, the token, then native NEAR less its own gas, which ends the agent. */
function settleExit(s: { native: string; wnear: string; paid: Common['paid']; status: string }, w: Work, held: bigint, clear: () => void) {
  const gas = (k: DemoOp) => min(SIM_GAS[k], b(s.native));
  if (b(s.wnear) > 0n) {
    const g = gas('unwrap'), n = b(s.wnear);
    s.native = (b(s.native) - g + n).toString(); s.wnear = '0'; op(w, 'unwrap', n, g);
    return;
  }
  if (held > 0n) {
    const g = gas('ft_transfer');
    s.native = (b(s.native) - g).toString(); clear();
    s.paid = { ...s.paid, token: (b(s.paid.token) + held).toString() }; op(w, 'ft_transfer', held, g);
    return;
  }
  const native = b(s.native), g = gas('native_transfer');
  if (native > 0n) { s.paid = { ...s.paid, near: (b(s.paid.near) + native - g).toString() }; s.native = '0'; op(w, 'native_transfer', native - g, g); }
  w.state = 'ended'; s.status = 'Ended. The simulated result is what a live Stop and withdraw pays the owner.';
}

/** Restated from trade.ts slotAt (private there). */
export const slotAt = (s: Extract<TradeSettings, { strategy: 'schedule' }>, anchor: number, now: number) => Math.floor((now - anchor) / (s.intervalSec * 1000));
/** Restated from trade.ts scheduleEnd (private there): budget, runs, date, then the planned life. */
function scheduleEnd(s: Extract<TradeSettings, { strategy: 'schedule' }>, st: DemoTradeSim, now: number, endsAt: number): 'budget' | 'runs' | 'date' | 'life' | null {
  if (b(s.budget) - b(st.spent) < b(s.amount)) return 'budget';
  if (s.end.kind === 'runs' && st.fills >= s.end.runs) return 'runs';
  if (s.end.kind === 'date' && now >= s.end.atMs) return 'date';
  return now >= endsAt ? 'life' : null;
}

function trade(a: DemoAgent, t: TradeSettings, s: DemoTradeSim | null, m: DemoMarket, now: number, w: Work): DemoTradeSim {
  const pair = TRADE_PAIRS.find(p => p.id === a.pair)!, fee = pair.pin.feeBps, px = m.pools[pair.pin.poolId];
  if (!s) {
    return { native: a.depositYocto, wnear: '0', token: '0', spent: '0', bought: '0', sold: '0', proceeds: '0', gasBuy: '0', gasSell: '0', fills: 0, lastSlot: null,
      anchor: a.createdAt, buy: null, p0: null, levels: t.strategy === 'dca' ? Array.from({ length: t.levels }, () => 'waiting' as const) : [], protect: null,
      status: 'Waiting for the first buy.', paid: { near: '0', token: '0' }, stopAt: null };
  }
  if (w.state === 'stopping') { s.buy = null; s.status = 'Stopping: settling the simulated balances.'; settleExit(s, w, b(s.token), () => { s.token = '0'; }); return s; }
  // Life end (and for Schedule buy its other ends) first, as live: they need no pool sample.
  const end = t.strategy === 'schedule' ? scheduleEnd(t, s, now, a.endsAt) : now >= a.endsAt ? 'life' : null;
  if (end) { stop(w, s, end === 'life' ? 'term-ended' : end, now); return s; }
  if (!px) return s;
  const rW = b(px.wnear), rT = b(px.token);
  // Stop loss, only with a held position (live guard, trade.ts): confirmed by the same breach 5 to 30 minutes later at a later block.
  if (t.strategy === 'dca') {
    const h = b(s.bought) - b(s.sold), k = roundBasis(s).k, value = h > 0n ? outGivenIn(h, rT, rW, fee) : 0n;
    const breach = t.slBps > 0 && h > 0n && value * 10_000n <= k * BigInt(10_000 - t.slBps), prev = s.protect;
    if (breach && prev && now - prev.since >= SL_CONFIRM_MS && now - prev.since <= SL_RESET_MS && px.block > prev.block) { stop(w, s, 'sl', now); return s; }
    s.protect = breach ? prev && now - prev.since <= SL_RESET_MS ? prev : { since: now, block: px.block } : null;
  }
  // The swap tick of a planned buy: below its floor nothing is swapped and no gas is charged; the wNEAR stays and the buy is planned again.
  if (s.buy) {
    const amount = b(s.buy.amount), out = outGivenIn(amount, rW, rT, fee);
    if (out < b(s.buy.floor)) { s.buy = null; s.status = 'The price moved beyond the buy floor. Nothing was swapped; the wNEAR is used by the next buy.'; return s; }
    if (!afford(b(s.native), SIM_GAS.swap)) { stop(w, s, 'reserve', now); return s; }
    s.native = (b(s.native) - SIM_GAS.swap).toString(); s.gasBuy = (b(s.gasBuy) + SIM_GAS.swap).toString();
    s.wnear = (b(s.wnear) - amount).toString(); s.token = (b(s.token) + out).toString();
    s.spent = (b(s.spent) + amount).toString(); s.bought = (b(s.bought) + out).toString(); s.fills += 1;
    if (s.buy.slot !== undefined) s.lastSlot = s.buy.slot;
    if (s.buy.level !== undefined) s.levels[s.buy.level - 1] = 'filled';
    else if (t.strategy === 'dca') s.p0 = { num: amount.toString(), den: out.toString() };
    op(w, 'swap', amount, SIM_GAS.swap, { out }); s.buy = null; s.status = 'Bought.';
    return s;
  }
  // A buy wraps only the shortfall over the held wNEAR (one tick, skipped when none), then swaps on the next tick.
  const plan = (amount: bigint, quote: bigint, tag: { slot?: number; level?: number }, floor = quote * 9_950n / 10_000n) => {
    const wrap = amount - b(s.wnear);
    if (wrap > 0n) {
      if (!afford(b(s.native), SIM_GAS.wrap, wrap)) { stop(w, s, 'reserve', now); return; }
      s.native = (b(s.native) - wrap - SIM_GAS.wrap).toString(); s.wnear = (b(s.wnear) + wrap).toString(); s.gasBuy = (b(s.gasBuy) + SIM_GAS.wrap).toString();
      op(w, 'wrap', wrap, SIM_GAS.wrap);
    }
    s.buy = { amount: amount.toString(), floor: floor.toString(), ...tag }; s.status = 'Buying.';
  };
  const list = m.history[pair.pin.poolId] ?? [];
  if (t.strategy === 'schedule') {
    const slot = slotAt(t, s.anchor, now);
    if (s.lastSlot === slot) { s.status = `Next buy at ${new Date(s.anchor + (slot + 1) * t.intervalSec * 1000).toISOString()}.`; return s; }
    const wait = medianWait(list, now, px);
    if (wait) { s.status = wait; return s; }
    plan(b(t.amount), outGivenIn(b(t.amount), rW, rT, fee), { slot });
    return s;
  }
  // Auto DCA, as live planDca: base buy (after a take profit, not before the round's 60 s pause), arming, take profit, one level fire.
  if (!s.p0) {
    if (s.cooldownUntil != null && now < s.cooldownUntil) { s.status = `Next round at ${new Date(s.cooldownUntil).toISOString()}.`; return s; }
    const wait = medianWait(list, now, px);
    if (wait) { s.status = wait; return s; }
    plan(b(t.base), outGivenIn(b(t.base), rW, rT, fee), {});
    return s;
  }
  const p0 = { num: b(s.p0.num), den: b(s.p0.den) }, order = b(t.order), tokens = outGivenIn(order, rW, rT, fee);
  const crossed = (k: number) => tokens >= levelNeed(order, p0, k, t.stepBps), armed = t.levels <= 3 ? 1 : 2;
  while (s.levels.filter(l => l === 'armed').length < armed && s.levels.includes('waiting')) {
    const k = s.levels.indexOf('waiting');
    s.levels[k] = crossed(k + 1) ? 'skipped' : 'armed';
  }
  const round = roundBasis(s), h = b(s.bought) - b(s.sold), quote = outGivenIn(h, rT, rW, fee);
  if (h > 0n && quote >= tpLine(round.k, t.tpBps)) {
    if (!afford(b(s.native), SIM_GAS.swap)) { stop(w, s, 'reserve', now); return s; }
    s.token = (b(s.token) - h).toString(); s.sold = (b(s.sold) + h).toString(); s.proceeds = (b(s.proceeds) + quote).toString();
    s.native = (b(s.native) + quote - SIM_GAS.swap).toString(); s.gasSell = (b(s.gasSell) + SIM_GAS.swap).toString();
    op(w, 'swap', h, SIM_GAS.swap, { out: quote, note: TP_NOTE });
    // Rounds spec 3: the sale starts the next round, as live; the agent keeps running.
    const n = s.round ?? 1;
    Object.assign(s, roundReset(s, now));
    s.status = `Take profit sold round ${n}. Round ${n + 1} starts after a 60 s pause.`;
    return s;
  }
  const fire = s.levels.findIndex((l, i) => l === 'armed' && crossed(i + 1));
  if (fire >= 0 && round.spent + order <= tradePlan(t)) { plan(order, tokens, { level: fire + 1 }, levelNeed(order, p0, fire + 1, t.stepBps)); return s; }
  s.status = s.levels.every(l => l === 'filled' || l === 'skipped') ? 'Waiting for take profit, stop loss or the planned end.' : 'Waiting for a level or take profit.';
  return s;
}

async function lp(a: DemoAgent, v: LpSettings, s: DemoLpSim | null, m: DemoMarket, now: number, w: Work, decide?: DemoDecide): Promise<DemoLpSim | null> {
  const dcl = m.dcl, pool = m.pools[4512];
  if (!dcl) return s;
  const point = dcl.point;
  if (!s) {
    const principal = b(a.depositYocto) - LP_RESERVE;
    const range = v.range.mode === 'explicit' ? { left: v.range.left, right: v.range.right } : lpCentred(200, point);
    const init: DemoLpSim = { ledger: { usdc: '0', wnear: '0', native: principal.toString(), inUsdc: '0', inWnear: '0' }, reserve: LP_RESERVE.toString(),
      swap: { tokenIn: WNEAR, amount: (principal / 2n).toString() }, position: null, count: 0, range: range ?? { left: point, right: point + 1 }, nextRange: null, out: null,
      rotations: [], compounds: 0, lastCompound: 0, mark: null, history: [{ at: now, point }], protect: null, lastDecision: null, recentred: false,
      status: 'Opening the position.', paid: { near: '0', token: '0' }, stopAt: null };
    if (!range) stop(w, init, 'reserve', now, 'range too close to the point limit');
    return init;
  }
  s.history = [...s.history, { at: now, point }].slice(-60);
  // 5.2.4 accrual window: only from a mark of the last minute or so, with the position in range at the mark and now.
  if (s.position) {
    const inRange = point >= s.position.left && point < s.position.right, mk = s.mark, L = b(s.position.liquidity), pl = b(dcl.liquidity);
    if (mk && now - mk.at <= 180_000 && mk.inRange && inRange) {
      s.position.feeX = (b(s.position.feeX) + lpFee(b(dcl.volX) - b(mk.volX), L, pl, dcl.protocolBps)).toString();
      s.position.feeY = (b(s.position.feeY) + lpFee(b(dcl.volY) - b(mk.volY), L, pl, dcl.protocolBps)).toString();
    }
    s.mark = { at: now, volX: dcl.volX, volY: dcl.volY, inRange };
  }
  const reserve = b(s.reserve), l = s.ledger;
  const credit = (k: keyof LpLedger, n: bigint) => { l[k] = (b(l[k]) + n).toString(); };
  const remove = (gas: bigint) => {
    const [x, y] = lpValueXY(s.position!, point), p = s.position!;
    credit('usdc', x + b(p.feeX)); credit('wnear', y + b(p.feeY));
    s.reserve = (b(s.reserve) - gas).toString(); op(w, 'dcl_remove', b(p.liquidity), gas, { note: `${x + b(p.feeX)} USDC raw and ${y + b(p.feeY)} wNEAR yocto, fees included` });
    s.position = null; s.mark = null;
  };
  if (w.state === 'stopping') {
    // 5.2.5 exit, in the live order: removal, DCL balances, unwrap, USDC, then native NEAR plus the reserve less its own gas.
    const gas = (k: DemoOp) => min(SIM_GAS[k], b(s.reserve));
    s.status = 'Stopping: settling the simulated balances.';
    if (s.position) { remove(gas('dcl_remove')); return s; }
    for (const [key, to] of [['inUsdc', 'usdc'], ['inWnear', 'wnear']] as const) if (b(l[key]) > 0n) {
      const g = gas('dcl_withdraw'), n = b(l[key]);
      credit(to, n); l[key] = '0'; s.reserve = (b(s.reserve) - g).toString(); op(w, 'dcl_withdraw', n, g);
      return s;
    }
    if (b(l.wnear) > 0n) { const g = gas('unwrap'), n = b(l.wnear); credit('native', n); l.wnear = '0'; s.reserve = (b(s.reserve) - g).toString(); op(w, 'unwrap', n, g); return s; }
    if (b(l.usdc) > 0n) {
      const g = gas('ft_transfer'), n = b(l.usdc);
      l.usdc = '0'; s.reserve = (b(s.reserve) - g).toString(); s.paid = { ...s.paid, token: (b(s.paid.token) + n).toString() }; op(w, 'ft_transfer', n, g);
      return s;
    }
    const total = b(l.native) + b(s.reserve), g = min(SIM_GAS.native_transfer, total);
    if (total > 0n) { s.paid = { ...s.paid, near: (b(s.paid.near) + total - g).toString() }; l.native = '0'; s.reserve = '0'; op(w, 'native_transfer', total - g, g); }
    w.state = 'ended'; s.status = 'Ended. The simulated result is what a live Stop and withdraw pays the owner.';
    return s;
  }
  if (now >= a.endsAt) { stop(w, s, 'term-ended', now); return s; }
  // 5.2.5 protection, restated from lp.ts tickLp: stop loss on the high value, take profit on the low value, against the deposit.
  if (v.stopLossPct > 0 || v.takeProfitPct > 0) {
    const { low, high } = lpValues(s, point), basis = b(a.depositYocto), prev = s.protect;
    const kind = v.stopLossPct > 0 && high * 100n <= basis * BigInt(100 - v.stopLossPct) ? 'stop-loss'
      : v.takeProfitPct > 0 && low * 100n >= basis * BigInt(100 + v.takeProfitPct) ? 'take-profit' : null;
    s.protect = kind ? prev?.kind === kind && now - prev.since <= 1_800_000 ? prev : { kind, since: now, block: dcl.block } : null;
    if (kind && prev?.kind === kind && now - prev.since >= 300_000 && now - prev.since <= 1_800_000 && dcl.block > prev.block) {
      s.protect = { ...prev, fired: { kind, value: (kind === 'stop-loss' ? high : low).toString(), basis: basis.toString(), block: dcl.block, at: now } };
      stop(w, s, kind, now);
      return s;
    }
  }
  const pos = s.position;
  if (pos) {
    if (point >= pos.left && point < pos.right) {
      const wasOut = s.out !== null;
      s.out = null; s.nextRange = null; s.status = 'In range.';
      // Compound: in range, no rotation pending, 6 hours since the last one, and the fees at least max(position x minFeeBps, the floor), position value only.
      if (v.compound.on && lpRangeOk(s.range, point) && !wasOut && !s.swap && now - s.lastCompound >= COMPOUND_GAP_MS) {
        const [x, y] = lpValueXY(pos, point), feeValue = b(pos.feeY) + toNearDown(b(pos.feeX), point);
        const threshold = (y + toNearDown(x, point)) * BigInt(v.compound.minFeeBps) / 10_000n;
        if (feeValue >= (threshold > LP_COMPOUND_FLOOR ? threshold : LP_COMPOUND_FLOOR)) {
          if (!afford(reserve, SIM_GAS.dcl_remove)) { stop(w, s, 'reserve', now); return s; }
          remove(SIM_GAS.dcl_remove);
          s.nextRange = { ...s.range, verdict: 'rebuild' }; s.lastCompound = now; s.compounds += 1;
          s.lastDecision = { at: now, verdict: 'rebuild', range: s.range }; s.status = 'Compounding.';
        }
      }
      return s;
    }
    // 5.2.3 rotation: the same side again at least 5 minutes later at a later block, at most 2 rotations in a rolling 24 hours.
    const side = point < pos.left ? 'below' : 'above';
    if (!s.out || s.out.side !== side) { s.out = { side, since: now, block: dcl.block }; s.nextRange = null; s.status = 'Out of range, confirming.'; return s; }
    if (now - s.out.since < LP_CONFIRM_MS || dcl.block === s.out.block) { s.status = 'Out of range, confirming.'; return s; }
    if (s.rotations.filter(at => at > now - DAY).length >= LP_MAX_ROTATIONS) {
      s.status = 'Out of range. The rotation limit of 2 per 24 hours is reached; the position earns no fees until the price returns or the window rolls.';
      return s;
    }
    if (!s.nextRange) {
      const width = s.range.right - s.range.left, fallback = lpCentred(width, point);
      if (!fallback) { stop(w, s, 'reserve', now, 'range too close to the point limit'); return s; }
      const input: LpAiInput = { poolId: DCL_POOL, fee: 100, point, range: s.range, bounds: { minWidth: Math.max(20, Math.ceil(width / 2)), maxWidth: Math.min(2000, 2 * width) }, history: s.history };
      const decision = v.ai && decide ? await decide(input, fallback).catch(() => ({ ...fallback, verdict: 'fallback' as const, code: 'unavailable' })) : { ...fallback, verdict: 'fallback' as const, code: 'off' };
      // A rotation whose AI call waits for the tick's single slot stays confirmed and is decided on a later tick.
      if (decision === null) { s.status = 'Out of range, waiting for the range decision.'; return s; }
      s.nextRange = { left: decision.left, right: decision.right, verdict: decision.verdict, ...(decision.code ? { code: decision.code } : {}) };
      w.log.push({ kind: 'decision', data: { verdict: s.nextRange.verdict, ...(s.nextRange.code ? { code: s.nextRange.code } : {}), left: decision.left, right: decision.right } });
      s.status = 'Out of range, rotating.';
      return s;
    }
    if (!afford(reserve, SIM_GAS.dcl_remove)) { stop(w, s, 'reserve', now); return s; }
    remove(SIM_GAS.dcl_remove);
    s.out = null; s.rotations = [...s.rotations.filter(at => at > now - DAY), now];
    // Swap half of the dominant token: above the range half of the wNEAR to USDC, below half of the USDC to native NEAR (then wrapped).
    s.swap = side === 'above' ? { tokenIn: WNEAR, amount: (b(l.wnear) / 2n).toString() } : { tokenIn: USDC, amount: (b(l.usdc) / 2n).toString() };
    s.lastDecision = { at: now, verdict: s.nextRange.verdict, ...(s.nextRange.code ? { code: s.nextRange.code } : {}), range: { left: s.nextRange.left, right: s.nextRange.right } };
    s.status = 'Rotating.';
    return s;
  }
  // 5.2.2 open, one step per tick in the live order: wrap, swap on 4512, wrap, deposit USDC, deposit wNEAR, add.
  const spend = (kind: DemoOp) => { if (!afford(reserve, SIM_GAS[kind])) { stop(w, s, 'reserve', now); return false; } s.reserve = (reserve - SIM_GAS[kind]).toString(); return true; };
  if (s.swap && b(s.swap.amount) > 0n) {
    const amount = b(s.swap.amount);
    if (s.swap.tokenIn === WNEAR && b(l.wnear) < amount) {
      const wrap = min(amount - b(l.wnear), b(l.native));
      if (wrap <= 0n || !spend('wrap')) { if (wrap <= 0n) stop(w, s, 'reserve', now, 'no NEAR left to wrap'); return s; }
      credit('native', -wrap); credit('wnear', wrap); op(w, 'wrap', wrap, SIM_GAS.wrap); s.status = 'Opening the position.';
      return s;
    }
    if (!pool || !spend('swap')) return s;
    if (s.swap.tokenIn === WNEAR) { const out = outGivenIn(amount, b(pool.wnear), b(pool.token), 30); credit('wnear', -amount); credit('usdc', out); op(w, 'swap', amount, SIM_GAS.swap, { out }); }
    else { const out = outGivenIn(amount, b(pool.token), b(pool.wnear), 30); credit('usdc', -amount); credit('native', out); op(w, 'swap', amount, SIM_GAS.swap, { out }); }
    s.swap = null; s.status = 'Opening the position.';
    return s;
  }
  s.swap = null;
  if (b(l.native) > 0n) { const n = b(l.native); if (!spend('wrap')) return s; credit('native', -n); credit('wnear', n); op(w, 'wrap', n, SIM_GAS.wrap); return s; }
  for (const [key, to, token] of [['usdc', 'inUsdc', 'USDC'], ['wnear', 'inWnear', 'wNEAR']] as const) if (b(l[key]) > 0n) {
    const n = b(l[key]);
    if (!spend('dcl_deposit')) return s;
    l[key] = '0'; credit(to, n); op(w, 'dcl_deposit', n, SIM_GAS.dcl_deposit, { note: token });
    return s;
  }
  if (b(l.inUsdc) > 0n && b(l.inWnear) > 0n) {
    const planned = s.nextRange ?? s.range, rebuild = s.nextRange?.verdict === 'rebuild';
    const range = rebuild || lpRangeOk(planned, point) ? { left: planned.left, right: planned.right } : lpCentred(planned.right - planned.left, point);
    if (!range) { stop(w, s, 'reserve', now, 'range too close to the point limit'); return s; }
    if (!spend('dcl_add')) return s;
    const X = b(l.inUsdc), Y = b(l.inWnear), L = lpLiquidity(X, Y, range.left, range.right, point), [x, y] = lpXY(Number(L), range.left, range.right, point);
    // Paid amounts round up; the rest returns to the wallet ledger, as live DCL refunds it.
    const paidX = min(BigInt(Math.ceil(x)), X), paidY = min(BigInt(Math.ceil(y)), Y);
    l.inUsdc = '0'; l.inWnear = '0'; credit('usdc', X - paidX); credit('wnear', Y - paidY);
    s.count += 1;
    s.position = { n: s.count, left: range.left, right: range.right, liquidity: L.toString(), paidX: paidX.toString(), paidY: paidY.toString(), feeX: '0', feeY: '0' };
    s.recentred = range.left !== planned.left || range.right !== planned.right;
    s.range = range; s.nextRange = null; s.out = null; s.mark = { at: now, volX: dcl.volX, volY: dcl.volY, inRange: point >= range.left && point < range.right };
    op(w, 'dcl_add', L, SIM_GAS.dcl_add, { note: `points ${range.left} to ${range.right}` }); s.status = 'In range.';
    return s;
  }
  s.status = 'Waiting: the LP agent has nothing it can open.';
  return s;
}
