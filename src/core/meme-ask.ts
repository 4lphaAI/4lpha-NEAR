import { YOCTO_PER_NEAR as N } from './amounts.js';
import { record } from './errors.js';
import { MEME, type MemeAsk, type MemeAuction } from './meme-paper.js';
import type { NearAi } from './near-ai.js';

export const MEME_SYSTEM = 'Given numbers about one meme.cooking auction, answer only JSON {"action":"join"|"skip","confidence":<integer 0..100>}. '
  + '12 % of auctions launch. Auctions with 10 or more depositors launch 66 to 76 % of the time. '
  + 'The median sell value after launch is 1.04 per NEAR at +5 min and 0.42 at +24 h.';

export function memePrompt(a: MemeAuction, now: number) {
  const m = a.last, team = m.team_allocation, round = (n: number) => Math.round(n * 100) / 100;
  const near = (n: string) => round(Number(BigInt(n)) / Number(N));
  const old = a.samples.filter(s => s.at <= now - 25 * MEME.minute).reduce<MemeAuction['samples'][number] | null>((best, s) =>
    !best || Math.abs(s.at - (now - 30 * MEME.minute)) < Math.abs(best.at - (now - 30 * MEME.minute)) ? s : best, null);
  return { durationMinutes: round((a.endMs - a.startMs) / MEME.minute), minutesLeft: round((a.endMs - now) / MEME.minute),
    depositors: m.depositors, totalStakedNear: near(m.total_staked), softCapNear: near(m.soft_cap), hardCapNear: m.hard_cap === null ? null : near(m.hard_cap),
    teamPct: team ? round(Number(BigInt(team.amount)) * 100 / Number(BigInt(m.total_supply))) : 0,
    cliffDays: team ? round(team.cliff_duration_ms / MEME.day) : null, vestingDays: team ? round(team.vesting_duration_ms / MEME.day) : null,
    creatorSharePct: round(m.creatorShare * 100), topSharePct: round(m.topShare * 100),
    stakedChange30mNear: old ? round(Number(BigInt(m.total_staked) - BigInt(old.totalStaked)) / Number(N)) : null,
    depositorsChange30m: old ? m.depositors - old.depositors : null };
}
export function memeJoin(ask: MemeAsk | null): boolean { return ask !== null && 'action' in ask && ask.action === 'join' && ask.confidence >= MEME.joinConfidence; }
export async function askMeme(ai: NearAi | null, auction: MemeAuction, now: number): Promise<MemeAsk> {
  if (!ai) return { failure: 'ai-off' };
  const result = await ai(MEME_SYSTEM, JSON.stringify(memePrompt(auction, now)));
  if (result.error) return { failure: result.error };
  const r = record(result.data);
  if (!r || Object.keys(r).length !== 2 || (r.action !== 'join' && r.action !== 'skip') ||
      !Number.isSafeInteger(r.confidence) || Number(r.confidence) < 0 || Number(r.confidence) > 100) return { failure: 'malformed' };
  return { action: r.action as 'join' | 'skip', confidence: r.confidence as number };
}
