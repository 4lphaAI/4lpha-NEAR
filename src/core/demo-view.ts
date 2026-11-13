import { demoDclSamples, demoSamples } from './demo-market.js';
import { gridValueOf, lpValues, slotAt, TP_NOTE, tradeValueOf, type DemoAgent, type DemoGridSim, type DemoLpSim, type DemoTradeSim } from './demo-sim.js';
import { lanePoints } from './grid-settings.js';
import type { GridSettings } from './grid.js';
import { LP_RESERVE } from './lp-settings.js';
import type { LpSettings } from './lp.js';
import { USDC, WNEAR } from './pins.js';
import { otherToken, toNearDown } from './rhea-dcl.js';
import type { Store } from './store.js';
import { TRADE_PAIRS, type TradePair } from './trade-pairs.js';
import { ladderFactor, levelNeed, outGivenIn, tpLine, tradePlan, type Sample, type TradeSettings } from './trade-settings.js';

/** Section 9: shown on every demo page. */
export const DEMO_OMITS: readonly string[] = [
  'Grid orders fill all at once when the price passes them; partial fills, queue position and other traders are not modelled.',
  'Swaps use the pool reserves of that minute; the trade itself does not move the price.',
  "LP fees are an estimate: the pool's swap volume since the last minute times the 0.01 % fee, less the protocol share, times the position's share of the active liquidity.",
  'Gas is a fixed amount per kind of transaction, at or above every measured live transaction.',
  'No transaction fails or is refunded, and no RPC or OutLayer limit applies.',
  'A live job also needs a wallet policy, funding, token registrations and (Grid and LP) a 0.5 NEAR DCL registration paid by the owner; none of these is simulated.',
];
const DAY = 86_400_000;
const b = (v: string) => BigInt(v);
const price = (point: number) => 10 ** 18 / 1.0001 ** point;
const DONE: Readonly<Record<string, 'budget' | 'runs' | 'date' | 'life' | 'tp' | 'sl'>> = { 'term-ended': 'life', budget: 'budget', runs: 'runs', date: 'date', tp: 'tp', sl: 'sl' };

/** Section 7.3: a sample is used for display when under 180 s old (DCL) or 120 s old (classic pools), else the field is null. */
function samples(store: Store, now: number) {
  const dcl = demoDclSamples(store).at(-1);
  return { dcl: dcl && dcl.at <= now && now - dcl.at < 180_000 ? dcl : null,
    px: (pair: TradePair): Sample | null => { const s = demoSamples(store, pair.pin.poolId).at(-1); return s && s.at <= now && now - s.at < 120_000 ? s : null; } };
}
const pairOf = (a: DemoAgent) => TRADE_PAIRS.find(p => p.id === a.pair)!;

/** The agent value in NEAR, as its page shows it: the simulated holdings plus what the exit already paid; the deposit before the first tick. */
export function demoValue(store: Store, a: DemoAgent, now: number): bigint | null {
  if (!a.sim) return b(a.depositYocto);
  const { dcl, px } = samples(store, now), paid = a.sim.paid;
  if (a.kind === 'grid' || a.kind === 'lp') {
    if (!dcl) return null;
    const own = a.kind === 'grid' ? gridValueOf(a.sim as DemoGridSim, dcl.point) : lpValues(a.sim as DemoLpSim, dcl.point).high;
    return own + b(paid.near) + toNearDown(b(paid.token), dcl.point);
  }
  const pair = pairOf(a), p = px(pair);
  return p ? tradeValueOf(a.sim as DemoTradeSim, pair, p) + b(paid.near) + outGivenIn(b(paid.token), b(p.token), b(p.wnear), pair.pin.feeBps) : null;
}
export function demoSummary(store: Store, a: DemoAgent, now: number) {
  return { id: a.id, kind: a.kind, pair: a.pair, state: a.state, endReason: a.endReason, createdAt: a.createdAt, endsAt: a.endsAt, value: demoValue(store, a, now)?.toString() ?? null };
}

/** Section 7.3: `job` in the exact shape of the page's Job (web/lib/near-format.ts), so the live body components render it; `demo` says what it is. */
export function demoPublicView(store: Store, a: DemoAgent, now: number, isOwner: boolean) {
  const { dcl, px } = samples(store, now), point = dcl?.point ?? null, sim = a.sim, deposit = b(a.depositYocto);
  const rows = store.demoLog(a.id, 500), ops = rows.filter(r => r.kind === 'op'), value = demoValue(store, a, now);
  const trading = a.kind === 'schedule' || a.kind === 'dca', pair = trading ? pairOf(a) : null, token = pair?.token ?? USDC;
  const g = a.kind === 'grid' && sim ? sim as DemoGridSim : null, l = a.kind === 'lp' && sim ? sim as DemoLpSim : null, t = trading && sim ? sim as DemoTradeSim : null;
  const native = g?.native ?? t?.native ?? (l ? (b(l.ledger.native) + b(l.reserve)).toString() : a.depositYocto);
  const wnear = g?.wnear ?? t?.wnear ?? l?.ledger.wnear ?? '0', held = g?.usdc ?? t?.token ?? l?.ledger.usdc ?? '0';
  const reason = a.state === 'running' ? sim?.status ?? 'Waiting for the first market sample.' : a.state === 'stopping' ? 'Stopping: settling the simulated balances.'
    : 'Ended. The simulated result is what a live Stop and withdraw pays the owner.';
  const p = pair ? px(pair) : null;
  const job = {
    id: a.id, owner: 'demo', kind: a.kind, state: a.state === 'ended' ? 'stopped' : a.state, reason, depositYocto: a.depositYocto, agentAccount: null, walletPubkey: null,
    agentBalance: native, ownerBalance: null, payload: null, canReveal: false, linkDelivered: false, linkConfirmed: false, canFund: false, frozen: null, canStopEarly: false,
    waitingForChain: false, blindHalt: false, canResumeBlind: false, resumeBlockedReason: null, name: null,
    grid: a.kind === 'grid' ? gridBlock(a, g, rows, point, value) : null,
    lp: a.kind === 'lp' ? lpBlock(a, l, point, value, now) : null,
    pendingSubmission: null, holdings: { tokens: { [WNEAR]: wnear, [token]: held }, block: dcl?.block ?? p?.block ?? 0 }, extraTokens: [],
    operations: ops.map(r => ({ id: r.id, kind: String(r.data.kind), verdict: r.data.kind === 'swap' ? 'swapped' : 'success', state: 'finished', txHash: null,
      message: typeof r.data.note === 'string' ? r.data.note : null, createdAt: r.at, finishedAt: r.at })),
    alerts: [],
    trade: pair ? tradeBlock(a, t, pair, p, ops, now) : null,
  };
  const day = new Date(now).toISOString().slice(0, 10);
  // `value` is the tile value for every kind: the simulated holdings plus what the exit already paid, so an ended agent shows its result, not 0.
  return { job, demo: { simulated: true, isOwner, seed: a.seed === 1, endsAt: a.endsAt, endReason: a.endReason, value: value?.toString() ?? null, result: a.state === 'ended' && sim ? sim.paid : null,
    ai: { usedToday: Number(store.meta(`demo_ai:${day}`) ?? '0'), cap: 50 }, lastTickAt: store.readHeartbeat('demo'), omits: DEMO_OMITS } };
}

function gridBlock(a: DemoAgent, s: DemoGridSim | null, rows: ReturnType<Store['demoLog']>, point: number | null, value: bigint | null) {
  const settings = a.settings as GridSettings;
  return { canRegister: false, issued: false, registered: true, available: true, enabled: true, point, anchor: s?.anchor ?? null, internal: {}, lost: {}, positions: 0,
    // A filled, unclaimed order is listed with nothing remaining and its payout unclaimed, as live lists remain + unclaimed.
    orders: s ? s.lanes.flatMap((l, i) => l.order ? [{ id: `demo-${i}-${l.generation}`, sell: l.sell, buy: otherToken(l.sell), point: l.order.point,
      remain: l.order.filled ? '0' : l.order.amount, bought: l.order.filled ? l.order.payout : '0', unclaimed: l.order.filled ? l.order.payout : '0' }] : []) : [],
    fills: rows.filter(r => r.kind === 'fill').slice(0, 50).map(r => ({ at: r.at, side: r.data.side === 'sell' ? 'sell' as const : 'buy' as const, point: Number(r.data.point),
      sold: String(r.data.sold), bought: String(r.data.bought), txHash: null })),
    lanes: s ? s.lanes.map((l, i) => ({ generation: l.generation, sell: l.sell, amount: l.amount, orderId: l.order ? `demo-${i}-${l.generation}` : null, native: l.native,
      points: lanePoints(s.anchor, i, settings.step, s.lanes.length) })) : [],
    value: value?.toString() ?? null, settings, protect: s?.protect ?? null };
}

function lpBlock(a: DemoAgent, s: DemoLpSim | null, point: number | null, value: bigint | null, now: number) {
  const pos = s?.position ?? null, vals = s && point !== null ? lpValues(s, point) : null, paid = s?.paid;
  const extra = paid && point !== null ? b(paid.near) + toNearDown(b(paid.token), point) : 0n;
  return { canRegister: false, issued: false, registered: true, available: true, enabled: true, point,
    internal: s ? { [USDC]: s.ledger.inUsdc, [WNEAR]: s.ledger.inWnear } : {}, lost: {}, positions: pos ? 1 : 0, ledger: s?.ledger ?? null,
    rotations: s ? s.rotations.filter(at => at > now - DAY).length : 0, pending: null,
    settings: a.settings as LpSettings, recentred: s?.recentred ?? false, lastDecision: s?.lastDecision ?? null, protect: s?.protect ?? null,
    valueLow: !s ? a.depositYocto : vals ? (vals.low + extra).toString() : null, valueHigh: value?.toString() ?? null,
    positionValue: pos && vals && point !== null ? (vals.y + toNearDown(vals.x, point)).toString() : null, initialPosition: (b(a.depositYocto) - LP_RESERVE).toString(),
    compounds: { count: s?.compounds ?? 0, lastAt: s && s.compounds > 0 ? s.lastCompound : null },
    range: pos ? { left: pos.left, right: pos.right, leftPrice: price(pos.left), rightPrice: price(pos.right), inRange: point === null ? null : point >= pos.left && point < pos.right,
      outSince: s?.out?.since ?? null } : null,
    position: pos ? { id: `demo#${pos.n}`, liquidity: pos.liquidity, paidX: pos.paidX, paidY: pos.paidY, fees: [pos.feeX, pos.feeY],
      estimate: vals ? [vals.x.toString(), vals.y.toString()] : null } : null };
}

/** Field by field as trade.ts tradeView, from the simulation state; buys come from the simulated operations and carry no transaction hash. */
function tradeBlock(a: DemoAgent, s: DemoTradeSim | null, pair: TradePair, px: Sample | null, ops: ReturnType<Store['demoLog']>, now: number) {
  const t = a.settings as TradeSettings, fee = pair.pin.feeBps;
  const ledger = s ? { spent: s.spent, bought: s.bought, sold: s.sold, proceeds: s.proceeds, gasBuy: s.gasBuy, gasSell: s.gasSell, wnear: s.wnear }
    : { spent: '0', bought: '0', sold: '0', proceeds: '0', gasBuy: '0', gasSell: '0', wnear: '0' };
  const h = b(ledger.bought) - b(ledger.sold), k = b(ledger.spent) + b(ledger.gasBuy);
  const value = px && s ? outGivenIn(h, b(px.token), b(px.wnear), fee) : null, walletValue = px && s ? outGivenIn(b(s.token), b(px.token), b(px.wnear), fee) : null;
  const plan = tradePlan(t), p0 = s?.p0 ? { num: b(s.p0.num), den: b(s.p0.den) } : null;
  const kind = a.endReason ? DONE[a.endReason] : undefined, done = kind ? { kind, at: s?.stopAt ?? a.updatedAt } : null;
  // An agent that is not running counts no more slots: the slot clock stops when it entered stopping, and no next buy is due.
  const at = a.state === 'running' ? now : s?.stopAt ?? a.updatedAt, currentSlot = t.strategy === 'schedule' && s ? slotAt(t, s.anchor, at) : null, taken = currentSlot !== null && s?.lastSlot === currentSlot;
  return {
    strategy: a.kind as 'schedule' | 'dca',
    pair: { id: pair.id, symbol: pair.symbol, token: pair.token, decimals: pair.decimals, poolId: pair.pin.poolId, feeBps: fee },
    settings: t, endsAt: a.endsAt, ledger,
    avgCost: b(ledger.bought) > 0n ? { num: ledger.spent, den: ledger.bought } : null,
    spot: px ? { num: px.wnear, den: px.token } : null,
    value: value?.toString() ?? null, walletValue: walletValue?.toString() ?? null,
    pnl: value === null ? null : (b(ledger.proceeds) + value - k - b(ledger.gasSell)).toString(),
    schedule: t.strategy === 'schedule' ? { anchor: s?.anchor ?? null, currentSlot, currentSlotTaken: taken, fills: s?.fills ?? 0,
      postponed: currentSlot === null ? 0 : Math.max(0, currentSlot - (s?.fills ?? 0) + (taken ? 1 : 0)),
      nextDueAt: currentSlot === null || !s || a.state !== 'running' ? null : s.anchor + (currentSlot + (taken ? 1 : 0)) * t.intervalSec * 1000,
      remaining: (plan > b(ledger.spent) ? plan - b(ledger.spent) : 0n).toString() } : null,
    dca: t.strategy === 'dca' ? { p0: s?.p0 ?? null,
      levels: Array.from({ length: t.levels }, (_, i) => {
        const f = ladderFactor(i + 1, t.stepBps);
        return { k: i + 1, price: p0 ? { num: (p0.num * f.num).toString(), den: (p0.den * f.den).toString() } : null,
          need: p0 ? levelNeed(b(t.order), p0, i + 1, t.stepBps).toString() : null, state: s?.levels[i] ?? 'waiting' as const };
      }),
      tpLine: p0 ? tpLine(k, t.tpBps).toString() : null, slLine: p0 && t.slBps > 0 ? (k * BigInt(10_000 - t.slBps) / 10_000n).toString() : null,
      protect: s?.protect ?? null } : null,
    buys: ops.filter(r => r.data.kind === 'wrap' || r.data.kind === 'swap').map(r => {
      const swap = r.data.kind === 'swap', sell = r.data.note === TP_NOTE, out = typeof r.data.out === 'string' ? r.data.out : null;
      return { opId: r.id, kind: r.data.kind as 'wrap' | 'swap', side: sell ? 'sell' as const : 'buy' as const, amount: String(r.data.amount), verdict: swap ? 'swapped' : 'success',
        used: swap ? String(r.data.amount) : null, out: swap && !sell ? out : null, nativeIn: sell ? out : null, txHash: null,
        message: typeof r.data.note === 'string' ? r.data.note : null, at: r.at };
    }),
    done,
  };
}
