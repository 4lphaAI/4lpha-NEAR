import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyOutcome, classifySwap, finalReceiptBlocks, gasAccounting, parseTxStatus, signedAction } from '../src/core/receipts.js';
import { CLASSIC_EXCHANGE, USDC, WNEAR } from '../src/core/pins.js';
import { agent, fixture, owner } from './helpers.js';

test('1.25 and 1.27 classify only all receipt outcomes and resolved input', () => {
  const cases = [
    ['tx-1.25-swap-and-refund', USDC, 1n, 'refunded', 0n, 0n],
    ['tx-1.27-swap-in', WNEAR, 15000000000000000000000n, 'swapped', 15000000000000000000000n, 0n],
    ['tx-1.27-swap-refund-e68', WNEAR, 15000000000000000000000n, 'refunded', 0n, 0n],
    ['tx-1.27-swap-out-native', USDC, 56478n, 'swapped', 56478n, 14894302024651019464265n],
  ] as const;
  for (const [name, tokenIn, amountIn, verdict, used, nativeIn] of cases) {
    const tx = parseTxStatus(fixture(name));
    const swap = classifySwap(tx, { agent, exchange: CLASSIC_EXCHANGE, tokenIn, amountIn });
    assert.deepEqual([swap.verdict, swap.used, swap.nativeIn], [verdict, used, nativeIn], name);
    assert.ok(gasAccounting(tx, agent).burnt > 0n);
    if (name !== cases[0][0]) assert.ok(finalReceiptBlocks(tx)?.length, name);
  }
  const tx = parseTxStatus(fixture('tx-1.27-swap-in'));
  tx.outcomes.find(r => r.executor === CLASSIC_EXCHANGE)!.status = { Failure: 'Synthetic failure' };
  assert.equal(classifySwap(tx, { agent, tokenIn: WNEAR, exchange: CLASSIC_EXCHANGE, amountIn: 15000000000000000000000n }).verdict, 'unclear');
});

test('1.21/1.26 unwrap gas counts only system refunds', () => {
  const tx = parseTxStatus(fixture('tx-1.21-unwrap'));
  assert.equal(classifyOutcome(tx).verdict, 'success');
  assert.deepEqual(gasAccounting(tx, agent), { burnt: 1030387546631700000000n, refunded: 29888814110032300000000n, held: 30919201656664000000000n });
});

test('1.4 failed logs are ignored and 1.19 shows an unregistered recipient', () => {
  const tx = parseTxStatus(fixture('tx-1.19-ft-transfer-unregistered'));
  tx.outcomes.find(o => Object.hasOwn(o.status, 'Failure'))!.logs.push('fake positive log');
  const result = classifyOutcome(tx);
  assert.ok(['failure', 'inner-failure'].includes(result.verdict));
  assert.ok(result.receipts.some(r => r.status === 'Failure' && r.ignoredLogs > 0 && !r.logs.length));
  assert.equal(signedAction(tx)?.method, 'ft_transfer');
});

test('1.16, 1.18 and 1.27 signed call and transfer evidence', () => {
  for (const [name, method] of [['tx-1.16-store-policy', 'store_wallet_policy'], ['tx-1.18-storage-owner', 'storage_deposit'],
    ['tx-1.27-storage-usdc', 'storage_deposit'], ['tx-1.27-wrap', 'near_deposit']]) {
    const tx = parseTxStatus(fixture(name));
    assert.equal(classifyOutcome(tx).verdict, 'success');
    assert.equal(signedAction(tx)?.method, method);
    assert.ok(gasAccounting(tx, tx.signer).burnt > 0n);
  }
  const transfer = parseTxStatus(fixture('tx-1.18-native-transfer'));
  assert.deepEqual(signedAction(transfer), { receiver: owner, kind: 'Transfer', method: null, args: null, deposit: 10000000000000000000000n });
  assert.equal(classifyOutcome(transfer).verdict, 'success');
});
