import { CoreError } from './errors.js';
import type { OpKind } from './evidence.js';
import { spendableNear, type AccountView } from './near-rpc.js';
import { GAS, MONEY } from './pins.js';
import { DCL_GAS, type DclKind } from './rhea-dcl.js';

export interface BudgetView { used24h: number; used1h: number; blockedUntil: number | null; nativeSpent24h: bigint; }
export type Purpose = 'setup' | 'strategy' | 'exit';

function chunks(balance: bigint, cap: bigint): bigint {
  if (balance < 0n || cap <= 1n) throw new CoreError('policy_invalid', 'The exit chunk limit is invalid.');
  return (balance + cap - 2n) / (cap - 1n);
}
function atLeastOne(n: bigint) { return n < 1n ? 1n : n; }

export function exitReserve(o: { sweepYocto: bigint; nativePerTx: bigint; wnear: bigint; wnearPerTx: bigint; tokens: readonly { balance: bigint; perTx: bigint }[] }): number {
  const reserve = chunks(o.sweepYocto, o.nativePerTx) + atLeastOne(chunks(o.wnear, o.wnearPerTx)) + 2n +
    o.tokens.reduce((total, t) => total + atLeastOne(chunks(t.balance, t.perTx)) + 1n, 0n);
  return reserve > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(reserve);
}

export function opsProblems(v: BudgetView, purpose: Purpose, reserve: number, now: number): string[] {
  return [...(v.blockedUntil !== null && v.blockedUntil > now ? ['OutLayer quota is temporarily blocked.'] : []),
    ...(v.used1h + 1 > 29 ? ['The rolling hourly operations limit was reached.'] : []),
    ...(v.used24h + 1 + (purpose === 'exit' ? 0 : reserve) > 100 ? ['The daily operations budget must leave room for exit.'] : [])];
}

export function exitNative(o: { spendableAboveReserve: bigint; wnear: bigint; missingOwnerRegistrations: number }): bigint {
  return o.spendableAboveReserve + o.wnear + BigInt(o.missingOwnerRegistrations) * MONEY.storageDeposit;
}

export function nativeSpendProblems(v: BudgetView, amount: bigint, dailyCap: bigint, purpose: Purpose, exitNativeYocto: bigint): string[] {
  const limit = purpose === 'exit' ? dailyCap : dailyCap - exitNativeYocto - MONEY.sweepReserve;
  return v.nativeSpent24h + amount > limit ? ['The rolling native spend limit must leave room for exit.'] : [];
}

export function gasHold(gas: bigint, price: bigint): bigint { return gas * price * 105n / 100n; }
export type HoldRule = { needFree: bigint; basis: 'gas-hold' | 'storage-30tgas' | 'transfer-bound' };

export function holdFor(kind: OpKind, amount: bigint, price: bigint): HoldRule {
  if (kind === 'transfer_near_owner') return { needFree: amount + MONEY.transferHoldBound, basis: 'transfer-bound' };
  if (kind === 'storage' || kind === 'storage_owner') return { needFree: gasHold(GAS.simpleCall, price) + MONEY.gasMargin + MONEY.storageDeposit, basis: 'storage-30tgas' };
  if (Object.hasOwn(DCL_GAS, kind)) return { needFree: gasHold(DCL_GAS[kind as DclKind], price) + MONEY.gasMargin + amount, basis: 'gas-hold' };
  return { needFree: gasHold(kind === 'swap' ? GAS.swap : GAS.simpleCall, price) + MONEY.gasMargin + (kind === 'wrap' ? amount : 1n), basis: 'gas-hold' };
}

export function freeNearProblems(a: AccountView | null, rule: HoldRule): string[] {
  return spendableNear(a, 0n) < rule.needFree ? ['The agent wallet does not have enough free NEAR for this operation.'] : [];
}
