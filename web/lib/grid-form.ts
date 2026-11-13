import type { GridForm } from './near-actions';

/** The Deploy page's Grid Exit group. Keys are distinct from the LP mode-row keys (tpOn, slOn). */
export interface GridExit { gridTpOn: boolean; gridTakeProfit: string; gridSlOn: boolean; gridStopLoss: string; }

/** The BNB product's TP/SL prefill per preset (its Deploy page PRESETS). */
export const GRID_PRESET_EXIT: Readonly<Record<GridForm['preset'], { gridTakeProfit: string; gridStopLoss: string }>> = {
  tight: { gridTakeProfit: '3', gridStopLoss: '5' },
  balanced: { gridTakeProfit: '6', gridStopLoss: '10' },
  wide: { gridTakeProfit: '12', gridStopLoss: '15' },
  volatile: { gridTakeProfit: '25', gridStopLoss: '25' },
};

/** As in the BNB product, a preset overwrites the TP and SL values and leaves both checkboxes as they are. */
export function applyGridPreset(exit: GridExit, preset: GridForm['preset']): GridExit {
  return { ...exit, ...GRID_PRESET_EXIT[preset] };
}

/** The Grid settings sent with a hire: only when the server reports Grid V2; an unticked threshold sends 0. */
export function gridFormFrom(i: { serverGridV2: boolean; preset: GridForm['preset']; orders: string; exit: GridExit }): GridForm | undefined {
  if (!i.serverGridV2) return undefined;
  return { preset: i.preset, orders: i.orders, stopLossPct: i.exit.gridSlOn ? i.exit.gridStopLoss : '0', takeProfitPct: i.exit.gridTpOn ? i.exit.gridTakeProfit : '0' };
}
