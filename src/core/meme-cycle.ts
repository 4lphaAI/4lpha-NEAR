import { randomUUID } from 'node:crypto';
import { YOCTO_PER_NEAR as N } from './amounts.js';
import { askMeme, memeJoin } from './meme-ask.js';
import { findMemePool, parseMemePool, readMeme, readMemeStakes, sellMeme, type MemePool, type MemeRead, type MemeRecord, type MemeView } from './meme-cooking.js';
import { MEME, canEnterMeme, memeExit, memeResolution, memeWindow, screenMeme, stakeSummary, staleMemeMark,
  type MemeAgent, type MemeAuction, type MemePosition } from './meme-paper.js';
import type { NearAi } from './near-ai.js';
import { MemeNotFinalized, type NearRpc } from './near-rpc.js';
import type { Store } from './store.js';

export async function memeTick(d: { store: Store; rpc: NearRpc; ai: NearAi | null; now: () => number }) {
  const { store, rpc, ai, now } = d, at = now(), deadline = at + MEME.tickMs;
  const tick = Number(store.meta('meme_tick_no') ?? '0') + 1;
  store.setMeta('meme_tick_no', String(tick));
  let reads = 0, budget = 0, unreadable = 0, overrun = false;
  const invalidReads = new Set<string>();
  const budgetError = new Error('budget');
  const cache = new Map<string, ReturnType<MemeView>>();
  const view: MemeView = (contract, method, args) => {
    const key = JSON.stringify([contract, method, args]), existing = cache.get(key);
    if (existing) return existing;
    const request = async (): ReturnType<MemeView> => {
      if (reads >= MEME.readLimit) { budget++; throw budgetError; }
      if (now() >= deadline) { overrun = true; throw new Error('timeout'); }
      reads++;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([rpc.view(contract, method, args), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { overrun = true; reject(new Error('timeout')); }, Math.max(1, deadline - now()));
        })]);
      } catch (e) { if (!(e instanceof MemeNotFinalized)) unreadable++; throw e; }
      finally { clearTimeout(timer); }
    };
    // Preserve the RPC's fixed not-finalized classification through the cache.
    const result = request();
    cache.set(key, result); return result;
  };
  const log = (agentId: string | null, kind: Parameters<Store['logMeme']>[0]['kind'], memeId: number | null, data: Record<string, unknown>) =>
    store.logMeme({ agentId, kind, memeId, at, data });
  const effective = (a: MemeAgent): MemeAgent => a.state === 'running' && at >= a.endsAt ? { ...a, state: 'ending', endReason: 'term-ended' } : a;
  const agent = (id: string) => effective(store.getMemeAgent(id)!);
  const close = (p: MemePosition, code: MemePosition['closeCode'], value: bigint, pnl = value - BigInt(p.depositYocto)) => {
    if (store.casMemePosition(p, { ...p, status: 'closed', closeCode: code, exitYocto: String(value), pnlYocto: String(pnl), closedAt: at }))
      log(p.agentId, 'exit', p.memeId, { code, value: String(value), pnl: String(pnl) });
  };
  const mark = async (p: MemePosition) => {
    const a = agent(p.agentId);
    try {
      const raw = await view('v2.ref-finance.near', 'get_pool', { pool_id: p.poolId });
      let pool: MemePool;
      try {
        pool = parseMemePool(raw.value);
        if (!pool.token_account_ids.includes('wrap.near') || !pool.token_account_ids.includes(p.tokenId!)) throw new Error();
      } catch (e) { invalidReads.add(`get_pool:${p.poolId}`); throw e; }
      const value = sellMeme(pool, p.tokenId!, BigInt(p.tokens!)), exit = memeExit(a, p, value, at);
      const count = Number(store.meta(`meme_marks:${p.id}`) ?? '0') + 1;
      store.setMeta(`meme_marks:${p.id}`, String(count));
      const marked = { ...p, markYocto: String(value), markAt: at, peakBps: exit.peakBps };
      if (!store.casMemePosition(p, marked)) return;
      if (p.peakBps === null || exit.peakBps > p.peakBps || count % MEME.markEvery === 0) log(p.agentId, 'mark', p.memeId, { value: String(value), pnlBps: exit.pnlBps, peakBps: exit.peakBps });
      if (exit.closeCode) close({ ...marked, version: p.version + 1 }, exit.closeCode, value);
    } catch (e) {
      if (e === budgetError) return;
      log(p.agentId, 'mark', p.memeId, { failure: 'unreadable' });
      if (staleMemeMark(a, p, at)) close(p, 'ended', BigInt(p.markYocto ?? '0'));
    }
  };
  for (const p of store.memePositions().filter(p => p.status === 'open')) await mark(p);

  let pools: Promise<{ from: number; value: unknown }> | undefined;
  const launchPool = () => pools ??= (async () => {
    const n = (await view('v2.ref-finance.near', 'get_number_of_pools', {})).value;
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) { invalidReads.add('get_number_of_pools'); throw new Error(); }
    const from = Math.max(0, n - 50);
    return { from, value: (await view('v2.ref-finance.near', 'get_pools', { from_index: from, limit: 50 })).value };
  })();
  const pending = store.memePositions().filter(p => p.status === 'deposited');
  for (const id of new Set(pending.map(p => p.memeId))) {
    let a = store.getMemeAuction(id);
    if (!a) continue;
    const positions = pending.filter(p => p.memeId === id);
    const finalized = await readMeme(view, id, true);
    if (finalized.kind === 'unreadable' && finalized.invalid) invalidReads.add(`get_finalized_meme:${id}`);
    let code: 'refunded' | 'unresolved' | null = null;
    if (finalized.kind === 'ok') {
      try {
        const list = await launchPool();
        let found: ReturnType<typeof findMemePool>;
        try { found = findMemePool(list.value, list.from, id); }
        catch (e) { invalidReads.add('get_pools'); throw e; }
        if (found) {
          const updated = { ...a, outcome: 'launched' as const, ...found, resolvedAt: at, updatedAt: at };
          if (store.saveMemeAuction(a, updated)) a = updated;
          for (const p of positions) {
            const net = BigInt(p.netYocto), m = finalized.value;
            const opened: MemePosition = { ...p, status: 'open', tokens: String(BigInt(m.amount_to_be_distributed) * net / (BigInt(m.total_staked) + net)),
              ...found, launchedAt: at };
            if (store.casMemePosition(p, opened)) {
              log(p.agentId, 'resolve', id, { code: 'launched', tokens: opened.tokens, poolId: found.poolId });
              await mark({ ...opened, version: p.version + 1 });
            }
          }
          continue;
        }
      } catch { log(null, 'resolve', id, { failure: 'unreadable' }); }
    }
    if (finalized.kind === 'not-finalized') code = 'refunded';
    if (finalized.kind === 'pending') {
      const current = await readMeme(view, id);
      if (current.kind === 'unreadable' && current.invalid) invalidReads.add(`get_meme:${id}`);
      if (current.kind === 'ok') code = memeResolution(a, current.value, at);
    }
    if (!code && at >= a.endMs + MEME.resolveMs) code = 'unresolved';
    if (code) {
      store.saveMemeAuction(a, { ...a, outcome: code === 'refunded' ? 'failed' : 'unresolved', resolvedAt: at, updatedAt: at });
      for (const p of positions) close(p, code, BigInt(p.netYocto), 0n);
    }
  }
  for (const a of store.memeAgents()) {
    let current = a;
    if (a.state === 'running' && at >= a.endsAt && store.casMemeAgent(a, 'ending', 'term-ended', at)) current = store.getMemeAgent(a.id)!;
    if (current.state === 'ending' && !store.memePositions(a.id).some(p => p.status !== 'closed')) store.casMemeAgent(current, 'ended', current.endReason, at);
  }

  const fresh = new Set<number>();
  const refresh = async (id: number, answer?: MemeRead<MemeRecord>) => {
    const old = store.getMemeAuction(id), read = answer ?? await readMeme(view, id);
    if (read.kind === 'unreadable' && read.invalid) invalidReads.add(`get_meme:${id}`);
    if (read.kind !== 'ok') return;
    const m = read.value;
    if (!old && at >= Number(m.end_timestamp_ms)) return;
    const stakes = await readMemeStakes(view, id);
    if (stakes.kind === 'unreadable' && stakes.invalid) invalidReads.add(`get_meme_stakes:${id}`);
    if (stakes.kind !== 'ok') return;
    const summary = stakeSummary(m, stakes.value);
    const next: MemeAuction = { memeId: id, owner: m.owner, startMs: old?.startMs ?? (m.start_timestamp_ms === null ? at : Number(m.start_timestamp_ms)), endMs: Number(m.end_timestamp_ms), last: { ...m, ...summary },
      samples: [...(old?.samples ?? []), { at, totalStaked: m.total_staked, depositors: summary.depositors }].slice(-MEME.sampleLimit), ask: old?.ask ?? null,
      outcome: old?.outcome ?? null, tokenId: old?.tokenId ?? null, poolId: old?.poolId ?? null, resolvedAt: old?.resolvedAt ?? null, updatedAt: at };
    if (store.saveMemeAuction(old, next)) fresh.add(id);
  };
  // Entry-window reads precede discovery to preserve the section 1 read priority.
  for (const a of store.memeAuctions().filter(a => !a.outcome && memeWindow(a, at))) await refresh(a.memeId);
  const high = Number(store.meta('meme_high_id') ?? '0'), probes = tick % 10 === 0 ? 15 : 3, discovered: number[] = [], budgetBefore = budget;
  let highest = high;
  for (let offset = 1; offset <= probes; offset++) {
    const id = high + offset, read = await readMeme(view, id);
    if (read.kind === 'unreadable' && read.invalid) invalidReads.add(`get_meme:${id}`);
    if (read.kind === 'ok' || read.kind === 'ignored') highest = Math.max(highest, id);
    if (read.kind === 'ok') { const known = store.getMemeAuction(id) !== null; await refresh(id, read); if (!known && fresh.has(id)) discovered.push(id); }
  }
  store.setMeta('meme_high_id', String(highest));
  const probed = budget === budgetBefore && !overrun ? [high + 1, high + probes] : null;
  for (const a of store.memeAuctions().filter(a => !a.outcome && a.endMs > at && !fresh.has(a.memeId) && !memeWindow(a, at) && at - a.updatedAt >= 10 * MEME.minute)) await refresh(a.memeId);

  const entered = new Set<string>();
  for (let a of store.memeAuctions().filter(a => fresh.has(a.memeId) && !a.outcome && memeWindow(a, at))) {
    const code = screenMeme(a), candidates = store.memeAgents().filter(ag => canEnterMeme(ag, store.memePositions(ag.id), a.memeId, at, entered.has(ag.id)));
    if (!store.meta(`meme_screen:${a.memeId}`)) {
      for (const ag of candidates) log(ag.id, 'cycle', a.memeId, { screen: code ?? 'pass' });
      log(null, 'screen', a.memeId, { code: code ?? 'pass' });
      store.setMeta(`meme_screen:${a.memeId}`, '1');
    }
    if (code) continue;
    if (candidates.length && a.ask === null && now() < deadline) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const ask = await Promise.race([askMeme(ai, a, at), new Promise<{ failure: 'timeout' }>(resolve => {
          timer = setTimeout(() => { overrun = true; resolve({ failure: 'timeout' }); }, Math.max(1, deadline - now()));
        })]);
        const next = { ...a, ask, updatedAt: at };
        if (store.saveMemeAuction(a, next)) {
          a = next;
          log(null, 'ask', a.memeId, { ...ask, code: 'failure' in ask ? ask.failure === 'ai-off' ? 'ai-off' : `ai-${ask.failure}` : memeJoin(ask) ? 'join' : 'ai-skip' });
        }
      } finally { clearTimeout(timer); }
    }
    if (!memeJoin(a.ask) || now() >= deadline) continue;
    for (const candidate of candidates) {
      const ag = store.getMemeAgent(candidate.id)!;
      if (!canEnterMeme(ag, store.memePositions(ag.id), a.memeId, at, entered.has(ag.id))) continue;
      const deposit = BigInt(ag.settings.perAuctionNear) * N;
      const p: MemePosition = { id: randomUUID(), agentId: ag.id, memeId: a.memeId, symbol: a.last.symbol, status: 'deposited', closeCode: null,
        depositYocto: String(deposit), netYocto: String(deposit * MEME.feeNumerator / MEME.feeDenominator), tokens: null, poolId: null, tokenId: null, launchedAt: null,
        markYocto: null, markAt: null, peakBps: null, exitYocto: null, pnlYocto: null, openedAt: at, closedAt: null, version: 0 };
      if (store.insertMemePosition(ag, p)) { entered.add(ag.id); log(ag.id, 'entry', a.memeId, { deposit: p.depositYocto, net: p.netYocto }); }
    }
  }
  overrun ||= now() >= deadline;
  const cycle = { reads, budget, unreadable, invalid: invalidReads.size, overrun };
  // Log-only scan facts for the Run log; the returned cycle and every decision above are unchanged.
  const tracked = store.memeAuctions().filter(a => !a.outcome && a.endMs > at), opens = tracked.map(a => a.endMs - MEME.entryWindowMs).filter(t => t > at);
  log(null, 'cycle', null, { ...cycle, probed, discovered, refreshed: fresh.size, tracked: tracked.length,
    inWindow: tracked.filter(a => memeWindow(a, at)).length, nextWindowAt: opens.length ? Math.min(...opens) : null });
  store.heartbeat('meme', now()); store.pruneMemeLogs();
  return cycle;
}
