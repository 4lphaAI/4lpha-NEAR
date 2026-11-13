import test from 'node:test';
import assert from 'node:assert/strict';
import { exitReserve, freeNearProblems, gasHold, holdFor } from '../src/core/budget.js';
import { TGAS, YOCTO_PER_NEAR as N } from '../src/core/amounts.js';

const u = (microNear: number) => BigInt(microNear) * (N / 1_000_000n);
const ceil = (n: bigint, d: bigint) => Number((n + d - 1n) / d);

test('7.1 through 7.5 gas, storage, floors and two-chunk sweep arithmetic', () => {
  const price = 1_000_000_000n;
  assert.equal(gasHold(300n * TGAS, price), u(315000));
  assert.equal(gasHold(30n * TGAS, price), u(31500));
  assert.equal(holdFor('swap', 1n, price).needFree, u(320000) + 1n);
  assert.equal(holdFor('wrap', u(45000), price).needFree, u(81500));
  for (const kind of ['unwrap', 'transfer_token_owner'] as const) assert.equal(holdFor(kind, 1n, price).needFree, u(36500) + 1n);
  for (const kind of ['storage', 'storage_owner'] as const) assert.equal(holdFor(kind, u(1250), price).needFree, u(37750));
  assert.equal(holdFor('transfer_near_owner', u(250000) - 1n, price).needFree, u(260000) - 1n);
  assert.equal(u(1820 + 1441 + 1486 + 1486 + 196 + 1616 + 320000), u(328045));
  assert.equal(u(16731 + 100900), u(117631));
  assert.equal(u(15210 + 1200 + 7115 + 100000), u(123525));
  let balance = u(395587), sent = 0n, count = 0;
  while (balance > u(11820)) {
    const available = balance - u(11820), cap = u(250000) - 1n, chunk = available < cap ? available : cap;
    const a = { amount: balance, storageUsage: 182, locked: 0n };
    assert.deepEqual(freeNearProblems(a, holdFor('transfer_near_owner', chunk, price)), []);
    if (count === 1) assert.ok(freeNearProblems(a, holdFor('wrap', chunk, price)).length);
    balance -= chunk + u(835); sent += chunk; count++;
  }
  assert.deepEqual([count, sent, balance], [2, u(382932), u(10985)]);
  assert.equal(u(6623 + 15210 + 1200 + 4413 + 1670 + 10985), u(40101));
});

test('7.6 and 7.7 exit and strategy operation table and wrap path bounds', () => {
  for (const [d, c, wraps, sweep, reserve, hire, later] of [[1, 50000, 14, 20, 25, 54, 75], [1, 100000, 7, 10, 15, 71, 85], [1, 250000, 3, 4, 9, 81, 91],
    [2, 50000, 34, 40, 45, 14, 55], [2, 100000, 17, 20, 25, 51, 75], [2, 250000, 7, 8, 13, 73, 87]]) {
    const cap = u(c), s = BigInt(d) * N - u(12000), w = BigInt(d) * N - u(328045);
    const r = exitReserve({ sweepYocto: s, nativePerTx: cap, wnear: 0n, wnearPerTx: 2n * N, tokens: [{ balance: 0n, perTx: 10000n }] });
    assert.deepEqual([ceil(w, cap - 1n), ceil(s, cap - 1n), r, 100 - r - 6 - wraps - 1, 100 - r], [wraps, sweep, reserve, hire, later]);
  }
  assert.deepEqual([50000, 100000, 250000].map(c => 29n * u(c)), [u(1450000), u(2900000), u(7250000)]);
  assert.deepEqual([[1, 250000], [2, 250000], [2, 100000]].map(([d, c]) => ceil(BigInt(d) * N - u(1820), u(c) - 1n) + 1), [5, 9, 21]);
});
