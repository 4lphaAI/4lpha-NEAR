import { YOCTO_PER_NEAR as N } from './amounts.js';
import { CoreError } from './errors.js';
import { CLASSIC_POOLS, RHEA, USDC, ZEC, type PinnedPool } from './pins.js';

// Pure: the store and the web read it, so it imports only amounts, errors and pins (Trade V1 spec T-11).
export interface TradePair { id: 'trade-usdc' | 'trade-rhea' | 'trade-zec'; token: string; symbol: 'USDC' | 'RHEA' | 'ZEC'; decimals: 6 | 18 | 8; pin: PinnedPool; minWnearReserve: bigint; }
const pool = (id: number) => CLASSIC_POOLS.find(p => p.poolId === id)!;
/** Spec section 4: each pair is pinned by token contract and classic pool id. 10,000 wNEAR is a third of 6065's measured depth (TF-4). */
export const TRADE_PAIRS: readonly TradePair[] = [
  { id: 'trade-usdc', token: USDC, symbol: 'USDC', decimals: 6, pin: pool(4512), minWnearReserve: 10_000n * N },
  { id: 'trade-rhea', token: RHEA, symbol: 'RHEA', decimals: 18, pin: pool(6458), minWnearReserve: 10_000n * N },
  { id: 'trade-zec', token: ZEC, symbol: 'ZEC', decimals: 8, pin: pool(6065), minWnearReserve: 10_000n * N },
];

export function tradePair(id: string): TradePair {
  const pair = TRADE_PAIRS.find(p => p.id === id);
  if (!pair) throw new CoreError('policy_invalid', 'The trade pair is not pinned.');
  return pair;
}
