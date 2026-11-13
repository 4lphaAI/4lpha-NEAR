import test from 'node:test';
import assert from 'node:assert/strict';
import { fmtNear, fmtUnits, isAccountId, parseAmount } from '../src/core/amounts.js';

test('amounts use digit strings and NEAR ids retain their account boundaries', () => {
  for (const x of [1, -1n, '', '-1', '1.0', ' 1', '1e2', null]) assert.throws(() => parseAmount(x, 'amount'));
  assert.equal(parseAmount('00042', 'amount'), 42n);
  assert.equal(fmtNear(-320000000000000000000000n), '-0.320000 NEAR');
  assert.equal(fmtUnits(56478n, 6, 'USDC'), '0.056478 USDC');
  for (const id of ['owner.near', 'a'.repeat(64), 'ab_c.d-2']) assert.equal(isAccountId(id), true);
  for (const id of ['A.near', 'a', 'a'.repeat(65), '.near', 'a_.near', 'a.near\n']) assert.equal(isAccountId(id), false);
});
