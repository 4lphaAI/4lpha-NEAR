import { TGAS, YOCTO_PER_NEAR as N } from './amounts.js';

export const OUTLAYER_CONTRACT = 'outlayer.near';
export const OUTLAYER_API_DEFAULT = 'https://api.outlayer.ai';
export const WNEAR = 'wrap.near';
export const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
export const RHEA = 'token.rhealab.near';
export const ZEC = 'zec.omft.near';
export const CLASSIC_EXCHANGE = 'v2.ref-finance.near';
export const DCL = 'dclv2.ref-labs.near';
export const validPoint = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= -800_000 && v < 800_000;
export const GRID_LP_TOKENS: readonly string[] = [WNEAR, USDC, 'usdt.tether-token.near', 'zec.omft.near',
  '2260fac5e5542a773aa44fbcfedf7c193bc2c599.factory.bridge.near', 'aurora', 'token.rhealab.near',
  'token.v2.ref-finance.near', 'aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near', 'npro.nearmobile.near', 'itlx.intellex_xyz.near'];
export const TOKEN_DECIMALS: Readonly<Record<string, number>> = { [WNEAR]: 24, [USDC]: 6, [RHEA]: 18, [ZEC]: 8 };
export interface PinnedPool { poolId: number; kind: 'SIMPLE_POOL'; tokens: readonly [string, string]; feeBps: number; }
// Index 0 stays 4512: Grid and LP read CLASSIC_POOLS[0]. 6458 and 6065 serve Trade V1 only (spec section 4); 6065 charges no fee.
export const CLASSIC_POOLS: readonly PinnedPool[] = [{ poolId: 4512, kind: 'SIMPLE_POOL', tokens: [USDC, WNEAR], feeBps: 30 },
  { poolId: 6458, kind: 'SIMPLE_POOL', tokens: [RHEA, WNEAR], feeBps: 30 }, { poolId: 6065, kind: 'SIMPLE_POOL', tokens: [WNEAR, ZEC], feeBps: 0 }];
export const PAIRS = [{ id: 'usdc-wnear', classicPool: 4512 }] as const;
export const GAS = { swap: 300n * TGAS, simpleCall: 30n * TGAS, storePolicy: 100n * TGAS };
export const MONEY = {
  gasMargin: N / 200n, sweepReserve: N / 100n, transferHoldBound: N / 100n, storageDeposit: N / 800n,
  storageYoctoPerByte: 10n ** 19n, minDeposit: N * 4n / 10n, maxDeposit: N * 2n, maxLiveJobs: 15,
  nativePerTxCeiling: N / 4n, policyCostCeiling: N * 3n / 100n, readyFloor: N * 32n / 100n,
};
