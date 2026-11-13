import { MEME, memeNear, memePnlBps, screenMeme, type MemeAgent, type MemeLog } from './meme-paper.js';
import type { Store } from './store.js';

export function memeAgentView(a: MemeAgent, account?: string) {
  return { id: a.id, owner: a.owner, state: a.state, endReason: a.endReason, settings: a.settings, createdAt: a.createdAt, endsAt: a.endsAt, isOwner: account === a.owner };
}
export function memePublicView(store: Store, a: MemeAgent, now: number, account?: string) {
  const own = store.memeLogs(a.id, 500), positions = store.memePositions(a.id), closed = positions.filter(p => p.status === 'closed'),
    traded = closed.filter(p => p.closeCode !== 'refunded' && p.closeCode !== 'unresolved'), wins = traded.filter(p => BigInt(p.pnlYocto ?? '0') > 0n).length;
  return { agent: memeAgentView(a, account), summary: { deposited: positions.filter(p => p.status === 'deposited').length,
    open: positions.filter(p => p.status === 'open').length, closed: closed.length, refunded: closed.filter(p => p.closeCode === 'refunded').length,
    wins, pnlNear: memeNear(closed.reduce((n, p) => n + BigInt(p.pnlYocto ?? '0'), 0n)), winRateBps: traded.length ? Math.floor(wins * 10_000 / traded.length) : 0 },
    positions: positions.map(p => ({ meme_id: p.memeId, symbol: p.symbol, status: p.status, closeCode: p.closeCode, depositNear: memeNear(p.depositYocto),
      tokens: p.tokens, poolId: p.poolId, launchedAt: p.launchedAt, markNear: memeNear(p.markYocto), markAt: p.markAt,
      pnlBps: p.markYocto === null ? null : memePnlBps(BigInt(p.markYocto), BigInt(p.depositYocto)), peakBps: p.peakBps,
      exitNear: memeNear(p.exitYocto), pnlNear: memeNear(p.pnlYocto), openedAt: p.openedAt, closedAt: p.closedAt })),
    auctions: store.memeAuctions().filter(a => a.endMs > now && !a.outcome).slice(0, 20).map(a => ({ meme_id: a.memeId, symbol: a.last.symbol,
      endMs: a.endMs, depositors: a.last.depositors, totalStakedNear: memeNear(a.last.total_staked), softCapNear: memeNear(a.last.soft_cap), screen: screenMeme(a) ?? 'pass', ask: a.ask,
      checkedAt: a.updatedAt, windowOpensAt: a.endMs - MEME.entryWindowMs, windowClosesAt: a.endMs - MEME.entryBufferMs })),
    log: own.slice(0, 50).map(r => ({ kind: r.kind, meme_id: r.memeId, at: r.at, data: r.data })), runs: memeRuns(store, a, own),
    meta: { lastTickAt: store.readHeartbeat('meme') } };
}
const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : null;
/** The Run log: the shared per-minute cycles during this agent's life, with this agent's own events of the same tick. */
function memeRuns(store: Store, a: MemeAgent, rows: MemeLog[]) {
  const end = a.state === 'ended' ? a.updatedAt : Number.MAX_SAFE_INTEGER, own = new Map<number, MemeLog[]>();
  for (const r of rows) own.set(r.at, [...own.get(r.at) ?? [], r]);
  return store.memeCycles(a.createdAt, end, 60).filter(r => Number.isSafeInteger(r.at)).map(r => {
    const d = r.data, mine = own.get(r.at) ?? [], probed = Array.isArray(d.probed) && d.probed.length === 2 && d.probed.every(n => count(n) !== null) ? d.probed as [number, number] : null;
    return { at: r.at, reads: count(d.reads), budget: count(d.budget), unreadable: count(d.unreadable), invalid: count(d.invalid), overrun: d.overrun === true,
      probed, discovered: Array.isArray(d.discovered) ? d.discovered.filter(n => count(n) !== null) as number[] : null, refreshed: count(d.refreshed),
      tracked: count(d.tracked), inWindow: count(d.inWindow), nextWindowAt: count(d.nextWindowAt),
      screened: mine.filter(e => e.kind === 'cycle' && e.memeId !== null).length, asked: mine.filter(e => e.kind === 'ask').length,
      entries: mine.filter(e => e.kind === 'entry').length, exits: mine.filter(e => e.kind === 'exit').length };
  });
}
export const MEME_OPTIONS = { enabled: true, bounds: { perAuctionNear: MEME.perAuctionNear, maxOpen: MEME.maxOpen, capitalMax: MEME.capitalMax, termDays: MEME.termDays }, defaults: MEME.defaults };
