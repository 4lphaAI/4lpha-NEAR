import { YOCTO_PER_NEAR as N } from './amounts.js';
import { record } from './errors.js';
import type { LpRange, LpSettings } from './lp.js';
import { validPoint } from './pins.js';

// Kept apart from lp.ts so the store, which every process opens, does not load the LP strategy and its money modules (Trade V0 isolation).
export function parseLpSettings(value: unknown): LpSettings | 'invalid' {
  const r = record(value), range = record(r?.range), c = record(r?.compound);
  const keys = (v: Record<string, unknown> | null, want: string[]) => !!v && Object.keys(v).length === want.length && want.every(k => Object.hasOwn(v, k));
  const integer = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
  if (!keys(r, ['v', 'range', 'ai', 'compound', 'stopLossPct', 'takeProfitPct']) || r?.v !== 2 || typeof r.ai !== 'boolean' ||
    !integer(r.stopLossPct, 0, 90) || !integer(r.takeProfitPct, 0, 500) ||
    !(range?.mode === 'server' ? keys(range, ['mode']) : range?.mode === 'explicit' && keys(range, ['mode', 'left', 'right']) &&
      validPoint(range.left) && validPoint(range.right) && integer(range.right - range.left, 20, 2000)) ||
    !(c?.on === false ? keys(c, ['on']) : c?.on === true && keys(c, ['on', 'minFeeBps']) && integer(c.minFeeBps, 10, 1000))) return 'invalid';
  return r as unknown as LpSettings;
}

export function lpRangeOk(range: LpRange, point: number): boolean {
  const w = range.right - range.left, margin = Math.ceil(w / 10);
  return validPoint(range.left) && validPoint(range.right) && w >= 20 && w <= 2000 && point >= range.left + margin && point < range.right - margin;
}
export function lpCentred(width: number, point: number): LpRange | null {
  const left = point - Math.floor(width / 2), right = left + width;
  return validPoint(left) && validPoint(right) ? { left, right } : null;
}

// Demo mode spec section 2: moved byte-identical from lp.ts, which re-exports them, so the demo reuses the live LP rules without loading the strategy.
export const LP_MIN_DEPOSIT = 12n * N / 10n;
export const LP_CONFIRM_MS = 300_000;
export const LP_MAX_ROTATIONS = 2;
export const LP_RESERVE = 8n * N / 10n;
export const LP_COMPOUND_FLOOR = N / 20n;
export function lpSettingsFromPrices(value: unknown): LpSettings | 'invalid' {
  const r = record(value), range = record(r?.range);
  if (!r || Object.keys(r).length !== 5 || !['range', 'ai', 'compound', 'stopLossPct', 'takeProfitPct'].every(k => Object.hasOwn(r, k)) || !range) return 'invalid';
  let converted: LpSettings['range'];
  if (range.mode === 'server' && Object.keys(range).length === 1) converted = { mode: 'server' };
  else {
    const price = (v: unknown) => typeof v === 'string' && /^\d+(?:\.\d{1,6})?$/.test(v) && Number.isFinite(Number(v)) && Number(v) > 0;
    if (range.mode !== 'explicit' || Object.keys(range).length !== 3 || !price(range.minPrice) || !price(range.maxPrice) || Number(range.minPrice) >= Number(range.maxPrice)) return 'invalid';
    const point = (v: unknown) => Math.round(Math.log(1e18 / Number(v)) / Math.log(1.0001));
    converted = { mode: 'explicit', left: point(range.maxPrice), right: point(range.minPrice) };
  }
  return parseLpSettings({ ...r, v: 2, range: converted });
}
