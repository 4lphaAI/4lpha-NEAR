import { YOCTO_PER_NEAR as N } from './amounts.js';
import { record } from './errors.js';

// Pure: the store, the hire checks and the web read it, so it imports only amounts and errors (Trade V1 spec T-11).
export type TradeEnd = { kind: 'budget' } | { kind: 'runs'; runs: number } | { kind: 'date'; atMs: number };
export type TradeSettings =
  | { v: 1; strategy: 'schedule'; amount: string; intervalSec: number; budget: string; end: TradeEnd }
  | { v: 1; strategy: 'dca'; base: string; order: string; levels: number; stepBps: number; tpBps: number; slBps: number };

/** AD-7: the deposit is the plan plus this reserve, which pays gas and the exit and comes back minus gas. */
export const TRADE_RESERVE = 4n * N / 10n;
/** AD-4: the planned operating life of a Schedule buy job (and the furthest date end). */
export const TRADE_LIFE_MS = 6 * 86_400_000;
/** AD-4 (operator, 2026-11-13): an Auto DCA job runs up to 30 days. */
export const DCA_LIFE_MS = 30 * 86_400_000;
export const tradeLifeMs = (kind: string): number => kind === 'dca' ? DCA_LIFE_MS : TRADE_LIFE_MS;
export const TRADE_INTERVALS: readonly number[] = [3600, 14400, 28800, 43200, 86400];
export const TRADE_BUY_MIN = N / 10n, TRADE_BUY_MAX = 24n * N / 100n, TRADE_BUDGET_MIN = N / 5n, TRADE_PLAN_MAX = 16n * N / 10n;
export const TRADE_MAX_RUNS = 16;

const integer = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const exactKeys = (r: Record<string, unknown> | null, keys: string[]) => !!r && Object.keys(r).length === keys.length && keys.every(k => Object.hasOwn(r, k));
const yocto = (v: unknown) => typeof v === 'string' && /^\d{1,30}$/.test(v) ? BigInt(v) : null;
const buy = (v: bigint | null): v is bigint => v !== null && v >= TRADE_BUY_MIN && v <= TRADE_BUY_MAX;
/** Section 5.1: a request amount is a NEAR decimal string with at most 2 fraction digits. */
const near = (v: unknown) => {
  const m = typeof v === 'string' ? /^(\d{1,6})(?:\.(\d{1,2}))?$/.exec(v) : null;
  return m ? (BigInt(m[1]) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'))) * (N / 100n) : null;
};

/** x1.2 ladder: S_k = sum of 6^i x 5^(k-1-i) for i < k, which is 6^k - 5^k. */
const ladderSum = (k: number) => 6n ** BigInt(k) - 5n ** BigInt(k);
/** Spec 9.2: f_k = (10000 x 5^(k-1) - stepBps x S_k) / (10000 x 5^(k-1)) as an exact ratio. */
export function ladderFactor(k: number, stepBps: number): { num: bigint; den: bigint } {
  const den = 10_000n * 5n ** BigInt(k - 1);
  return { num: den - BigInt(stepBps) * ladderSum(k), den };
}
/** The largest multiple of 50, at most 3000, that keeps the deepest of N levels at most 90 % below P0. */
export function maxStepBps(levels: number): number {
  for (let step = 3000; step >= 50; step -= 50) if (BigInt(step) * ladderSum(levels) <= 9000n * 5n ** BigInt(levels - 1)) return step;
  return 0;
}
export function tradePlan(s: TradeSettings): bigint {
  return s.strategy === 'schedule' ? BigInt(s.budget) : BigInt(s.base) + BigInt(s.levels) * BigInt(s.order);
}

function validEnd(v: unknown): TradeEnd | null {
  const e = record(v);
  if (e?.kind === 'budget' && exactKeys(e, ['kind'])) return { kind: 'budget' };
  if (e?.kind === 'runs' && exactKeys(e, ['kind', 'runs']) && integer(e.runs, 1, TRADE_MAX_RUNS)) return { kind: 'runs', runs: e.runs };
  if (e?.kind === 'date' && exactKeys(e, ['kind', 'atMs']) && integer(e.atMs, 1, Number.MAX_SAFE_INTEGER)) return { kind: 'date', atMs: e.atMs };
  return null;
}

/** The stored form. Every bound of section 5.2 except the clock rule of a date end; anything else is 'invalid' (TF-2). */
export function parseTradeSettings(value: unknown): TradeSettings | 'invalid' {
  const r = record(value);
  if (r?.v !== 1) return 'invalid';
  if (r.strategy === 'schedule') {
    const amount = yocto(r.amount), budget = yocto(r.budget), end = validEnd(r.end);
    if (!exactKeys(r, ['v', 'strategy', 'amount', 'intervalSec', 'budget', 'end']) || !buy(amount) || budget === null || budget < TRADE_BUDGET_MIN ||
      budget > TRADE_PLAN_MAX || budget < amount || typeof r.intervalSec !== 'number' || !TRADE_INTERVALS.includes(r.intervalSec) || !end) return 'invalid';
    return { v: 1, strategy: 'schedule', amount: amount.toString(), intervalSec: r.intervalSec, budget: budget.toString(), end };
  }
  if (r.strategy === 'dca') {
    const base = yocto(r.base), order = yocto(r.order);
    if (!exactKeys(r, ['v', 'strategy', 'base', 'order', 'levels', 'stepBps', 'tpBps', 'slBps']) || !buy(base) || !buy(order) || !integer(r.levels, 1, 8) ||
      !integer(r.stepBps, 50, maxStepBps(r.levels)) || r.stepBps % 50 !== 0 || !integer(r.tpBps, 50, 5000) || r.tpBps % 10 !== 0 ||
      !(r.slBps === 0 || (integer(r.slBps, 100, 9000) && r.slBps % 100 === 0)) || base + BigInt(r.levels) * order > TRADE_PLAN_MAX) return 'invalid';
    return { v: 1, strategy: 'dca', base: base.toString(), order: order.toString(), levels: r.levels, stepBps: r.stepBps, tpBps: r.tpBps, slBps: r.slBps as number };
  }
  return 'invalid';
}

/** The hire request (section 5.1), in NEAR with at most 2 fraction digits, converted to the stored form. A date end must lie one interval to 6 days ahead. */
export function tradeSettingsFromRequest(kind: unknown, input: unknown, now: number): TradeSettings | 'invalid' {
  const r = record(input);
  if (kind === 'schedule' && exactKeys(r, ['amountNear', 'intervalSec', 'budgetNear', 'end'])) {
    const amount = near(r!.amountNear), budget = near(r!.budgetNear), end = validEnd(r!.end);
    if (amount === null || budget === null || !end || typeof r!.intervalSec !== 'number' ||
      (end.kind === 'date' && (end.atMs < now + r!.intervalSec * 1000 || end.atMs > now + TRADE_LIFE_MS))) return 'invalid';
    return parseTradeSettings({ v: 1, strategy: 'schedule', amount: amount.toString(), intervalSec: r!.intervalSec, budget: budget.toString(), end });
  }
  if (kind === 'dca' && exactKeys(r, ['baseNear', 'orderNear', 'levels', 'stepBps', 'tpBps', 'slBps'])) {
    const base = near(r!.baseNear), order = near(r!.orderNear);
    if (base === null || order === null) return 'invalid';
    return parseTradeSettings({ v: 1, strategy: 'dca', base: base.toString(), order: order.toString(), levels: r!.levels, stepBps: r!.stepBps, tpBps: r!.tpBps, slBps: r!.slBps });
  }
  return 'invalid';
}

// Demo mode spec section 2: moved byte-identical from trade.ts, which re-exports them, so the demo reuses the live trade rules without loading the strategy.
export interface Sample { at: number; block: number; wnear: string; token: string; }
const MEDIAN_WINDOW_MS = 1_800_000, MEDIAN_MIN_AGE_MS = 30_000, MEDIAN_MIN_SAMPLES = 10, MEDIAN_BPS = 200n;
/** AD-5: the TP line covers the measured 0.002518 NEAR sale gas. */
const TP_SALE_GAS = 3n * N / 1000n;
const big = (v: string) => BigInt(v);

/** Spec 7.1: the constant-product output, equal to get_return on 5720, 6458 and 6065 (FINDINGS 1.43, 1.45). */
export function outGivenIn(t: bigint, rIn: bigint, rOut: bigint, fee: number): bigint {
  const x = t * BigInt(10_000 - fee), d = rIn * 10_000n + x;
  return d > 0n ? x * rOut / d : 0n;
}
/** AD-5 and 6.5: ceil((K + 0.003 NEAR) x (10000 + tpBps) / 10000). */
export function tpLine(k: bigint, tpBps: number): bigint { return ((k + TP_SALE_GAS) * BigInt(10_000 + tpBps) + 9_999n) / 10_000n; }
/** Spec 9.2: the raw tokens at which an order's effective price is at most L_k = P0 x f_k. */
export function levelNeed(order: bigint, p0: { num: bigint; den: bigint }, k: number, stepBps: number): bigint {
  const f = ladderFactor(k, stepBps), n = order * p0.den * f.den, d = p0.num * f.num;
  return (n + d - 1n) / d;
}

/**
 * Spec 7.3: at least 10 samples aged 30 s to 30 min, and the spot within 2 % of their median. The lower median of an even count is used,
 * so pushing the token dearer needs 6 of 10 samples (RR-4); a cheaper token only helps the buyer. Returns the wait reason, or null.
 */
export function medianWait(list: readonly Sample[], now: number, spot: Sample): string | null {
  const window = list.filter(s => s.at > now - MEDIAN_WINDOW_MS && s.at <= now - MEDIAN_MIN_AGE_MS);
  if (window.length < MEDIAN_MIN_SAMPLES) return 'Waiting: collecting 30 minutes of price history.';
  const sorted = [...window].sort((a, b) => { const x = big(a.wnear) * big(b.token) - big(b.wnear) * big(a.token); return x < 0n ? -1 : x > 0n ? 1 : 0; });
  const m = sorted[Math.floor((sorted.length - 1) / 2)]!, diff = big(spot.wnear) * big(m.token) - big(m.wnear) * big(spot.token);
  return (diff < 0n ? -diff : diff) * 10_000n <= MEDIAN_BPS * big(m.wnear) * big(spot.token) ? null : 'Waiting: the pool price moved more than 2 % from its 30-minute median.';
}
