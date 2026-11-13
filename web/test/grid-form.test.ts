import assert from 'node:assert/strict';
import test from 'node:test';
import { applyGridPreset, GRID_PRESET_EXIT, gridFormFrom, type GridExit } from '@/lib/grid-form';

const exit: GridExit = { gridTpOn: true, gridTakeProfit: '6', gridSlOn: false, gridStopLoss: '10' };

test('Grid form sends settings only when the server reports Grid V2, and an unticked threshold sends 0', () => {
  assert.equal(gridFormFrom({ serverGridV2: false, preset: 'tight', orders: '4', exit }), undefined);
  assert.deepEqual(gridFormFrom({ serverGridV2: true, preset: 'tight', orders: '2', exit }), { preset: 'tight', orders: '2', stopLossPct: '0', takeProfitPct: '6' });
  assert.deepEqual(gridFormFrom({ serverGridV2: true, preset: 'wide', orders: '4', exit: { ...exit, gridTpOn: false, gridSlOn: true } }),
    { preset: 'wide', orders: '4', stopLossPct: '10', takeProfitPct: '0' });
});

test('Grid preset overwrites the TP and SL values with the BNB prefill and leaves both checkboxes', () => {
  assert.deepEqual(GRID_PRESET_EXIT, { tight: { gridTakeProfit: '3', gridStopLoss: '5' }, balanced: { gridTakeProfit: '6', gridStopLoss: '10' },
    wide: { gridTakeProfit: '12', gridStopLoss: '15' }, volatile: { gridTakeProfit: '25', gridStopLoss: '25' } });
  assert.deepEqual(applyGridPreset(exit, 'volatile'), { gridTpOn: true, gridTakeProfit: '25', gridSlOn: false, gridStopLoss: '25' });
  assert.deepEqual(applyGridPreset({ ...exit, gridTpOn: false, gridSlOn: true }, 'tight'), { gridTpOn: false, gridTakeProfit: '3', gridSlOn: true, gridStopLoss: '5' });
});
