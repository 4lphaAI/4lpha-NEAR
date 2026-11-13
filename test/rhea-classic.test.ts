import test from 'node:test';
import assert from 'node:assert/strict';
import { CLASSIC_POOLS, USDC, WNEAR } from '../src/core/pins.js';
import { ftTransferCall, minOut, poolProblems, quote, requireVenue, swapCall, swapMsg, unwrapCall, wrapCall } from '../src/core/rhea-classic.js';
import { dummyRpc } from './helpers.js';

test('I-16 only the pinned classic version, pool kind, and exact pair', async () => {
  const p = CLASSIC_POOLS[0];
  const pool = { pool_kind: 'SIMPLE_POOL', token_account_ids: [WNEAR, USDC], amounts: ['100', '10'] };
  assert.deepEqual(poolProblems(pool, p), []);
  assert.equal(poolProblems({ ...pool, pool_kind: 'DEGEN_SWAP', token_account_ids: [WNEAR, WNEAR] }, p).length, 2);
  const rpc = dummyRpc({ view: async (_c, m) => ({ height: 5, value: m === 'metadata' ? { version: '1.9.21', state: 'Running' } : m === 'get_pool' ? pool : '150259' }) });
  await requireVenue(rpc, p);
  await assert.rejects(requireVenue(dummyRpc({ view: async () => ({ height: 5, value: { version: '1.9.22', state: 'Running' } }) }), p));
  assert.equal(await quote(rpc, p, WNEAR, 40000000000000000000000n, USDC), 150259n);
});

test('D9 and 1.27 exact one-hop messages and attached gas/deposit', () => {
  const input = { pin: CLASSIC_POOLS[0], tokenIn: WNEAR, tokenOut: USDC, amountIn: 40000000000000000000000n, minOut: 148756n, unwrapNear: false };
  assert.equal(minOut(150259n, 100), 148756n);
  assert.equal(swapMsg(input), `{"force":0,"actions":[{"pool_id":4512,"token_in":"${WNEAR}","token_out":"${USDC}","amount_in":"40000000000000000000000","min_amount_out":"148756"}]}`);
  assert.throws(() => swapMsg({ ...input, unwrapNear: true }));
  assert.equal(JSON.parse(swapMsg({ ...input, tokenOut: WNEAR, tokenIn: USDC, unwrapNear: true })).skip_unwrap_near, false);
  assert.deepEqual([swapCall(input).gas, swapCall(input).deposit, wrapCall(25n).deposit, unwrapCall(25n).gas, ftTransferCall(USDC, 'owner.near', 3n).deposit],
    [300000000000000n, 1n, 25n, 30000000000000n, 1n]);
});
