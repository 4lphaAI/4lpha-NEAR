import { YOCTO_PER_NEAR as N } from './amounts.js';
import type { MemeRecord } from './meme-cooking.js';

export const MEME = { perAuctionNear: [1, 50], maxOpen: [1, 3], capitalMax: 500, termDays: [7, 30],
  defaults: { perAuctionNear: 10, maxOpen: 2, capitalNear: 20, termDays: 7 }, minute: 60_000, hour: 3_600_000,
  day: 86_400_000, readLimit: 30, tickMs: 20_000, tickSecond: 25, ownerLimit: 3, totalLimit: 50,
  entryWindowMs: 600_000, entryBufferMs: 60_000, minDepositors: 10, creatorMaxShare: 0.9, feeNumerator: 995n, feeDenominator: 1000n,
  cutoffMs: 7_200_000, resolveMs: 21_600_000, stopBps: -3000, trailingAtBps: 2000, trailingDropBps: 1500,
  holdMs: 14_400_000, staleMs: 600_000, sampleLimit: 60, markEvery: 10, joinConfidence: 70 } as const;
export interface MemeSettings { perAuctionNear: number; maxOpen: number; capitalNear: number; termDays: number; }
export type MemeAsk = { action: 'join' | 'skip'; confidence: number } | { failure: 'ai-off' | 'unavailable' | 'timeout' | 'http' | 'malformed' };
export interface MemeAgent { id: string; owner: string; state: 'running' | 'ending' | 'ended'; endReason: 'owner-stopped' | 'term-ended' | null;
  settings: MemeSettings; createdAt: number; endsAt: number; updatedAt: number; version: number; }
export interface MemeAuction { memeId: number; owner: string; startMs: number; endMs: number;
  last: MemeRecord & { depositors: number; creatorShare: number; topShare: number };
  samples: { at: number; totalStaked: string; depositors: number }[]; ask: MemeAsk | null;
  outcome: 'launched' | 'failed' | 'unresolved' | null; tokenId: string | null; poolId: number | null; resolvedAt: number | null; updatedAt: number; }
export interface MemePosition { id: string; agentId: string; memeId: number; symbol: string; status: 'deposited' | 'open' | 'closed';
  closeCode: 'refunded' | 'unresolved' | 'stop' | 'trailing' | 'time' | 'ended' | null;
  depositYocto: string; netYocto: string; tokens: string | null; poolId: number | null; tokenId: string | null; launchedAt: number | null;
  markYocto: string | null; markAt: number | null; peakBps: number | null; exitYocto: string | null; pnlYocto: string | null;
  openedAt: number; closedAt: number | null; version: number; }
export interface MemeLog { id: string; agentId: string | null; kind: 'cycle' | 'screen' | 'ask' | 'entry' | 'resolve' | 'mark' | 'exit';
  memeId: number | null; at: number; data: Record<string, unknown>; }

export function validMemeSettings(r: Record<string, unknown>): r is Record<string, unknown> & MemeSettings {
  return Object.keys(r).length === 4 && ['perAuctionNear', 'maxOpen', 'capitalNear', 'termDays'].every(k => Number.isSafeInteger(r[k])) &&
    Number(r.perAuctionNear) >= MEME.perAuctionNear[0] && Number(r.perAuctionNear) <= MEME.perAuctionNear[1] && Number(r.maxOpen) >= MEME.maxOpen[0] && Number(r.maxOpen) <= MEME.maxOpen[1] &&
    Number(r.capitalNear) >= Number(r.maxOpen) * Number(r.perAuctionNear) && Number(r.capitalNear) <= MEME.capitalMax && MEME.termDays.some(n => n === r.termDays);
}
export function stakeSummary(m: MemeRecord, stakes: [string, string][]) {
  const total = BigInt(m.total_staked), positive = stakes.filter(([, n]) => BigInt(n) > 0n);
  const share = (n: bigint) => total === 0n ? 0 : Number(n) / Number(total);
  return { depositors: positive.length, creatorShare: share(BigInt(stakes.find(([a]) => a === m.owner)?.[1] ?? '0')),
    topShare: share(positive.reduce((max, [, n]) => BigInt(n) > max ? BigInt(n) : max, 0n)) };
}
export function memeWindow(a: Pick<MemeAuction, 'endMs'>, now: number): boolean { return now >= a.endMs - MEME.entryWindowMs && now < a.endMs - MEME.entryBufferMs; }
export function screenMeme(a: MemeAuction): string | null {
  const m = a.last;
  if (m.deposit_token_id !== 'wrap.near') return 'deposit-token';
  if (a.endMs - a.startMs > MEME.day) return 'too-long';
  if (m.depositors < MEME.minDepositors) return 'few-depositors';
  if (m.creatorShare >= MEME.creatorMaxShare) return 'creator-funded';
  if (BigInt(m.total_staked) * 2n < BigInt(m.soft_cap)) return 'far-from-soft-cap';
  if (m.hard_cap !== null && BigInt(m.total_staked) >= BigInt(m.hard_cap)) return 'hard-cap';
  return null;
}
export function canEnterMeme(a: MemeAgent, positions: MemePosition[], memeId: number, now: number, entered = false): boolean {
  const active = positions.filter(p => p.status !== 'closed');
  return !entered && a.state === 'running' && now < a.endsAt - Math.min(MEME.cutoffMs, (a.endsAt - a.createdAt) / 2) &&
    active.length < a.settings.maxOpen && !positions.some(p => p.memeId === memeId) &&
    active.reduce((n, p) => n + BigInt(p.depositYocto), BigInt(a.settings.perAuctionNear) * N) <= BigInt(a.settings.capitalNear) * N;
}
export function memePnlBps(value: bigint, deposit: bigint): number {
  const n = (value - deposit) * 10_000n;
  return Number(n >= 0n ? n / deposit : -((-n + deposit - 1n) / deposit));
}
export function memeExit(a: MemeAgent, p: MemePosition, value: bigint, now: number) {
  const pnlBps = memePnlBps(value, BigInt(p.depositYocto)), peakBps = Math.max(p.peakBps ?? pnlBps, pnlBps);
  const closeCode = a.state === 'ending' ? 'ended' : pnlBps <= MEME.stopBps ? 'stop' :
    peakBps >= MEME.trailingAtBps && pnlBps <= peakBps - MEME.trailingDropBps ? 'trailing' : now - p.launchedAt! >= MEME.holdMs ? 'time' : null;
  return { pnlBps, peakBps, closeCode } as const;
}
export function staleMemeMark(a: MemeAgent, p: MemePosition, now: number): boolean {
  return a.state === 'ending' && now - (p.markAt ?? p.launchedAt ?? p.openedAt) > MEME.staleMs;
}
export function memeResolution(a: MemeAuction, current: MemeRecord | null, now: number): 'refunded' | 'unresolved' | null {
  if (current !== null && now >= a.endMs && BigInt(current.total_staked) < BigInt(current.soft_cap)) return 'refunded';
  return now >= a.endMs + MEME.resolveMs ? 'unresolved' : null;
}
export function memeNear(raw: string | bigint | null): string | null {
  if (raw === null) return null;
  const n = BigInt(raw), abs = n < 0n ? -n : n, fraction = (abs % N).toString().padStart(24, '0').replace(/0+$/, '');
  return `${n < 0n ? '-' : ''}${abs / N}${fraction ? `.${fraction}` : ''}`;
}
