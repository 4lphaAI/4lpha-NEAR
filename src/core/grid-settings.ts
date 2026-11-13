import { YOCTO_PER_NEAR as N } from './amounts.js';
import { record } from './errors.js';
import type { GridPreset, GridSettings } from './grid.js';
import { USDC } from './pins.js';
import type { DclToken } from './rhea-dcl.js';

// Kept apart from grid.ts so the store, which every process opens, does not load the Grid strategy and its money modules (Trade V0 isolation).
/** Spec 2c G2-1: the BNB product's four presets, in DCL points (1 point = 0.01 %). */
export const GRID_STEPS: Readonly<Record<GridPreset, number>> = { tight: 45, balanced: 90, wide: 150, volatile: 300 };
const integer = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const exactKeys = (r: Record<string, unknown> | null, keys: string[]) => !!r && Object.keys(r).length === keys.length && keys.every(k => Object.hasOwn(r, k));

export function parseGridSettings(value: unknown): GridSettings | 'invalid' {
  const r = record(value);
  if (!r || !exactKeys(r, ['v', 'step', 'orders', 'stopLossPct', 'takeProfitPct']) || r.v !== 2 || !Object.values(GRID_STEPS).includes(r.step as number) ||
    (r.orders !== 2 && r.orders !== 4) || !integer(r.stopLossPct, 0, 90) || !integer(r.takeProfitPct, 0, 500)) return 'invalid';
  return { v: 2, step: r.step as number, orders: r.orders, stopLossPct: r.stopLossPct as number, takeProfitPct: r.takeProfitPct as number };
}

// Demo mode spec section 2: moved byte-identical from grid.ts, which re-exports them, so the demo reuses the live Grid rules without loading the strategy.
export const GRID_BOOTSTRAP = N / 5n;
/** Spec 2c section 12: four lanes (two each side) or two (one each side). Lane i sells USDC while i < orders / 2. */
export const offsets = (step: number, orders: number): readonly (readonly [number, number])[] =>
  orders === 2 ? [[step, 0], [-step, 0]] : [[step, 0], [2 * step, step], [-step, 0], [-2 * step, -step]];

/** The hire request shape: exactly { preset, orders, stopLossPct, takeProfitPct }. */
export function gridSettingsFromRequest(value: unknown): GridSettings | 'invalid' {
  const r = record(value);
  if (!r || !exactKeys(r, ['preset', 'orders', 'stopLossPct', 'takeProfitPct']) || typeof r.preset !== 'string' || !Object.hasOwn(GRID_STEPS, r.preset)) return 'invalid';
  return parseGridSettings({ v: 2, step: GRID_STEPS[r.preset as GridPreset], orders: r.orders, stopLossPct: r.stopLossPct, takeProfitPct: r.takeProfitPct });
}
export interface GridProtect {
  kind: 'stop-loss' | 'take-profit'; since: number; block: number;
  fired?: { kind: 'stop-loss' | 'take-profit'; value: string; basis: string; block: number; at: number };
}

export const lanePoints = (anchor: number, i: number, step: number, orders: number) => offsets(step, orders)[i].map(n => anchor + n);
export const restingSide = (sell: DclToken, point: number, current: number) => sell === USDC ? point > current : point < current;

/** LP V2's confirmation rule for Grid: two breaches of one kind 5 to 30 minutes apart at later blocks. */
export function gridProtectStep(prev: GridProtect | null | undefined, i: { value: bigint; deposit: bigint; settings: GridSettings; now: number; block: number; runningSince: number }):
  { protect: GridProtect | null; fire: boolean } {
  const { value, deposit, settings: s, now, block } = i;
  const kind = s.stopLossPct > 0 && value * 100n <= deposit * BigInt(100 - s.stopLossPct) ? 'stop-loss'
    : s.takeProfitPct > 0 && value * 100n >= deposit * BigInt(100 + s.takeProfitPct) ? 'take-profit' : null;
  // An observation from before the job last entered running (a freeze and Resume) never confirms.
  const previous = prev && !prev.fired && prev.since >= i.runningSince ? prev : null;
  if (!kind) return { protect: null, fire: false };
  if (previous?.kind === kind && now - previous.since >= 300_000 && now - previous.since <= 1_800_000 && block > previous.block) {
    return { protect: { ...previous, fired: { kind, value: value.toString(), basis: deposit.toString(), block, at: now } }, fire: true };
  }
  return { protect: previous?.kind === kind && now - previous.since <= 1_800_000 ? previous : { kind, since: now, block }, fire: false };
}
