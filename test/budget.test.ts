import test from 'node:test';
import assert from 'node:assert/strict';
import { exitReserve, nativeSpendProblems, opsProblems, type BudgetView } from '../src/core/budget.js';
import { YOCTO_PER_NEAR as N } from '../src/core/amounts.js';

const view = (p: Partial<BudgetView> = {}): BudgetView => ({ used24h: 0, used1h: 0, blockedUntil: null, nativeSpent24h: 0n, ...p });

test('A4, I-17 exit keeps daily operation reserve and honors hourly and 429 limits', () => {
  assert.equal(opsProblems(view({ used24h: 95 }), 'strategy', 5, 10).length, 1);
  assert.deepEqual(opsProblems(view({ used24h: 95 }), 'exit', 5, 10), []);
  assert.equal(opsProblems(view({ used1h: 29 }), 'exit', 5, 10).length, 1);
  assert.equal(opsProblems(view({ blockedUntil: 11 }), 'exit', 5, 10).length, 1);
  assert.deepEqual(opsProblems(view({ blockedUntil: 10 }), 'exit', 5, 10), []);
  assert.equal(exitReserve({ sweepYocto: 1n, nativePerTx: N / 4n, wnear: 0n, wnearPerTx: N, tokens: [{ balance: 25n, perTx: 10n }] }), 8);
});

test('D-1 native spend gate reserves fresh exit and projected native or wNEAR output', () => {
  const current = view({ nativeSpent24h: 19n * N / 10n }), exit = 99n * N / 100n;
  assert.deepEqual(nativeSpendProblems(current, N / 10n, 3n * N, 'strategy', exit), []);
  assert.equal(nativeSpendProblems(current, N / 10n + 1n, 3n * N, 'strategy', exit).length, 1);
  assert.deepEqual(nativeSpendProblems(current, 11n * N / 10n, 3n * N, 'exit', exit), []);
  assert.equal(nativeSpendProblems(current, 11n * N / 10n + 1n, 3n * N, 'exit', exit).length, 1);
  const before = view({ nativeSpent24h: 26n * N / 10n });
  assert.deepEqual(nativeSpendProblems(before, 1n, 3n * N, 'strategy', 35n * N / 100n), []);
  assert.equal(nativeSpendProblems(before, 1n, 3n * N, 'strategy', 90n * N / 100n).length, 1);
});
