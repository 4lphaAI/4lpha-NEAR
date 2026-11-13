import { YOCTO_PER_NEAR as N } from './amounts.js';
import { nativeSpendProblems } from './budget.js';
import { CoreError, record } from './errors.js';
import type { Intent } from './evidence.js';
import { receipt, update } from './grid.js';
import { boundWallet, setJob, type WorkerDeps } from './hire.js';
import { readHoldings, type Holdings } from './holdings.js';
import type { NearRpc } from './near-rpc.js';
import { exitBudget, watchdogFresh, type GuardedOps, type OpKind } from './ops.js';
import { WNEAR } from './pins.js';
import { readTradePool } from './rhea-classic.js';
import { tradePair, TRADE_PAIRS, type TradePair } from './trade-pairs.js';
import { ladderFactor, TRADE_LIFE_MS, tradePlan, type TradeSettings } from './trade-settings.js';
// Demo mode spec section 2: pure trade rules moved byte-identical to trade-settings.ts; re-exported here so every import keeps working.
export { levelNeed, medianWait, outGivenIn, tpLine } from './trade-settings.js';
import { levelNeed, medianWait, outGivenIn, tpLine, type Sample } from './trade-settings.js';
import type { Job, OpRow, Store } from './store.js';

// Trade V1 (spec docs/specs/TRADE-V1-SCHEDULE-DCA-SPEC.md): Schedule buy and Auto DCA on one pinned classic pool. Every money action is deterministic (R-6).
type Ratio = { num: string; den: string };
type Schedule = Extract<TradeSettings, { strategy: 'schedule' }>;
type Dca = Extract<TradeSettings, { strategy: 'dca' }>;
export interface TradeStep { id: string; kind: 'wrap' | 'swap'; side: 'buy' | 'sell'; amount: string; floor?: string; slot?: number; level?: number; plannedAt: number; }
export interface TradeState {
  v: 1; sequence: number; pending: TradeStep | null; failures: number; failedAt: number | null;
  /** The buy in progress. */
  buy: { amount: string; floor?: string; slot?: number; level?: number } | null;
  /** wNEAR wrapped by the job and not yet swapped (proven). */
  wnear: string;
  /** wNEAR used by settled buys (proven `used`). */
  spent: string;
  /** Gas burnt by every buy wrap and buy swap, any verdict: part of the basis K (AD-5). */
  gasBuy: string;
  gasSell: string;
  bought: string; sold: string; proceeds: string;
  fills: number;
  anchor: number | null; lastSlot: number | null;
  p0: Ratio | null;
  levels: ('waiting' | 'armed' | 'filled' | 'skipped')[];
  protect: { since: number; block: number } | null;
  done: { kind: 'budget' | 'runs' | 'date' | 'life' | 'tp' | 'tp-cap' | 'tp-short' | 'sl'; at: number; value?: string; line?: string } | null;
}
type DoneKind = NonNullable<TradeState['done']>['kind'];

export const TRADE_SETTINGS_INVALID = 'Trade settings are unreadable. Stop and withdraw.';
export const TRADE_EVAL_MS = 60_000;
/** T-7: a wrap needs this much free NEAR beyond its amount, so its swap always finds the 0.320 NEAR hold (FINDINGS 1.26). */
export const TRADE_WRAP_ROOM = 321n * N / 1000n;
const STALE_MS = 120_000, BACKOFF_MS = 300_000, MAX_FAILURES = 3, SLIPPAGE_BPS = 50;
const SAMPLE_GAP_MS = 55_000, SAMPLE_FRESH_MS = 60_000, SAMPLES_KEPT = 60;
const SL_CONFIRM_MS = 300_000, SL_RESET_MS = 1_800_000;
const UNSETTLED = 'A trade operation did not settle as expected. Stop and withdraw to recover the funds.';
const REASONS: Record<DoneKind, string> = {
  budget: 'Schedule finished: budget spent. Paying the owner.',
  runs: 'Schedule finished: all buys done. Paying the owner.',
  date: 'Schedule finished: end date reached. Paying the owner.',
  life: 'The trade job reached its planned 6-day end. Paying the owner.',
  tp: 'Take profit sold the position. Paying the owner.',
  'tp-cap': 'Take profit reached, but the position is larger than one sale may carry. Stop and withdraw pays NEAR and the token.',
  'tp-short': 'Take profit reached, but the wallet holds less of the token than the agent bought. Stop and withdraw pays NEAR and the token.',
  sl: 'Stop loss confirmed. Nothing was sold. Paying the owner NEAR and the token.',
};

/** AD-4: null until the policy payload carries the signed valid_until. */
export function tradeEndsAt(j: Pick<Job, 'createdAt' | 'payload'>): number | null {
  const v = j.payload?.args.valid_until;
  return typeof v === 'number' ? Math.min(j.createdAt + TRADE_LIFE_MS, v * 1000 - 3_600_000) : null;
}
export const tradeDeadline = (j: Pick<Job, 'createdAt' | 'payload'>): number => tradeEndsAt(j) ?? j.createdAt + TRADE_LIFE_MS;
const big = (v: string) => BigInt(v);
const slotAt = (s: Schedule, anchor: number, now: number) => Math.floor((now - anchor) / (s.intervalSec * 1000));

function samples(store: Store, pair: TradePair): Sample[] {
  try {
    const v: unknown = JSON.parse(store.meta(`trade_px:${pair.pin.poolId}`) ?? '[]');
    return Array.isArray(v) ? v.filter((x: unknown): x is Sample => {
      const r = record(x);
      return typeof r?.at === 'number' && typeof r.block === 'number' && typeof r.wnear === 'string' && /^\d+$/.test(r.wnear) && typeof r.token === 'string' && /^\d+$/.test(r.token);
    }) : [];
  } catch { return []; }
}
/** The last shared sample of the pool if it is under 60 s old (the view's spot). */
export function tradeSpot(store: Store, pair: TradePair, now: number): Sample | null {
  const last = samples(store, pair).at(-1);
  return last && last.at <= now && now - last.at < SAMPLE_FRESH_MS ? last : null;
}
/** Spec 10.2: the stored sample when fresh, else one finalized read appended to the shared history (at least 55 s apart, 60 kept). */
export async function tradePoolRead(d: { store: Store; rpc: NearRpc; now: () => number }, pair: TradePair): Promise<Sample> {
  const now = d.now(), fresh = tradeSpot(d.store, pair, now);
  if (fresh) return fresh;
  const pool = await readTradePool(d.rpc, pair), list = samples(d.store, pair), last = list.at(-1);
  const sample = { at: now, block: pool.height, wnear: pool.wnear.toString(), token: pool.token.toString() };
  if (!last || now - last.at >= SAMPLE_GAP_MS) d.store.setMeta(`trade_px:${pair.pin.poolId}`, JSON.stringify([...list, sample].slice(-SAMPLES_KEPT)));
  return sample;
}
/** The worker samples every pool with a running trade job once a minute, so the median guard has history before a slot. */
export async function sampleTradePools(d: WorkerDeps): Promise<void> {
  const pools = new Map<number, TradePair>();
  for (const j of d.store.activeJobs()) {
    const pair = j.trade && j.state === 'running' ? TRADE_PAIRS.find(p => p.id === j.pair) : undefined;
    if (pair) pools.set(pair.pin.poolId, pair);
  }
  for (const pair of pools.values()) {
    // A failed read is tried again only after the sample gap, not on every 2 s pass (FINDINGS 1.40).
    const failed = `trade_px_fail:${pair.pin.poolId}`;
    if (d.now() - Number(d.store.meta(failed) ?? 0) < SAMPLE_GAP_MS) continue;
    await tradePoolRead(d, pair).catch(() => d.store.setMeta(failed, String(d.now())));
  }
}

function scheduleEnd(s: Schedule, st: TradeState, now: number, endsAt: number): DoneKind | null {
  if (big(s.budget) - big(st.spent) < big(s.amount)) return 'budget';
  if (s.end.kind === 'runs' && st.fills >= s.end.runs) return 'runs';
  if (s.end.kind === 'date' && now >= s.end.atMs) return 'date';
  return now >= endsAt ? 'life' : null;
}

/**
 * Spec 10.1 idle gate: a pending step is never delayed; DCA evaluates once a minute; Schedule only while its slot is open or an end holds.
 * The Schedule skip holds only while a live watchdog has seen the wallet unfrozen; otherwise the job evaluates once a minute and the worker reads
 * the policy itself, so it records a freeze and an unfreeze never resumes it (R-5).
 */
export function tradeDue(store: Store, j: Job, now: number): boolean {
  const t = store.trade(j.id), s = t?.settings, st = t?.state;
  if (st?.pending) return true;
  if (s && s !== 'invalid' && s.strategy === 'schedule' && st?.anchor != null && st.lastSlot === slotAt(s, st.anchor, now) && !scheduleEnd(s, st, now, tradeDeadline(j)) &&
    store.meta(`watch_frozen:${j.id}`) === 'false' && watchdogFresh(store, now)) return false;
  if (now - Number(store.meta(`trade_eval:${j.id}`) ?? 0) < TRADE_EVAL_MS) return false;
  store.setMeta(`trade_eval:${j.id}`, String(now));
  return true;
}

/** ops.run holds a submission to the pending step: kind, amount, direction and floor. */
export function tradeIntent(state: TradeState | null, kind: OpKind, amount: bigint, args: { tokenIn?: string; floor?: bigint } = {}): TradeStep {
  const p = state?.pending;
  if (!p || p.kind !== kind || big(p.amount) !== amount || (kind === 'wrap' && p.side !== 'buy') ||
    (kind === 'swap' && ((args.tokenIn === WNEAR) !== (p.side === 'buy') || p.floor === undefined || args.floor === undefined || big(p.floor) !== args.floor))) {
    throw new CoreError('conflict', 'The trade step changed before submission.');
  }
  return p;
}

function initial(s: TradeSettings, now: number): TradeState {
  return { v: 1, sequence: 0, pending: null, failures: 0, failedAt: null, buy: null, wnear: '0', spent: '0', gasBuy: '0', gasSell: '0', bought: '0', sold: '0', proceeds: '0',
    fills: 0, anchor: s.strategy === 'schedule' ? now : null, lastSlot: null, p0: null, levels: s.strategy === 'dca' ? Array.from({ length: s.levels }, () => 'waiting' as const) : [],
    protect: null, done: null };
}

/** Spec 10.3: the only source of ledger changes is a finished journal row. */
function applyTradeStep(d: WorkerDeps, j: Job, s: TradeSettings, pair: TradePair, old: TradeState, row: OpRow) {
  if (row.state !== 'finished') return;
  const p = old.pending!, next: TradeState = { ...old, sequence: old.sequence + 1, pending: null, levels: [...old.levels] };
  if (row.verdict === 'quota' || row.verdict === 'frozen') {
    next.pending = { ...p, id: `${j.id}:${next.sequence}` };
    d.store.saveTrade(j, old, next);
    return;
  }
  const burnt = row.gasBurnt ?? 0n, amount = big(p.amount), output = receipt(row).output;
  const add = (v: string, n: bigint) => (big(v) + n).toString();
  const bad = () => update(d, j, UNSETTLED, true);
  const fail = () => { next.failures = old.failures + 1; next.failedAt = d.now(); };
  if (p.kind === 'wrap') {
    next.gasBuy = add(old.gasBuy, burnt);
    if (row.verdict === 'success' && output?.[WNEAR] === p.amount && old.buy) {
      next.wnear = add(old.wnear, amount);
      const { amount: buyAmount, ...tag } = old.buy;
      next.pending = { id: `${j.id}:${next.sequence}`, kind: 'swap', side: 'buy', amount: buyAmount, ...tag, plannedAt: d.now() };
    } else if (row.verdict === 'reverted' || row.verdict === 'denied') { fail(); next.buy = null; }
    else return bad();
  } else if (p.side === 'buy') {
    const got = typeof output?.[pair.token] === 'string' ? big(output[pair.token] as string) : 0n;
    next.gasBuy = add(old.gasBuy, burnt);
    if (row.verdict === 'swapped' && row.used === amount && got > 0n && big(old.wnear) >= amount) {
      next.spent = add(old.spent, amount); next.bought = add(old.bought, got); next.wnear = add(old.wnear, -amount);
      next.fills = old.fills + 1; next.buy = null; next.failures = 0;
      if (p.slot !== undefined) next.lastSlot = p.slot;
      if (p.level !== undefined) next.levels[p.level - 1] = 'filled';
      else if (s.strategy === 'dca') next.p0 = { num: amount.toString(), den: got.toString() };
    } else if (row.verdict === 'refunded') { fail(); next.buy = null; }
    else return bad();
  } else {
    next.gasSell = add(old.gasSell, burnt);
    if (row.verdict === 'swapped' && row.used === amount && (row.nativeIn ?? 0n) > 0n) {
      next.sold = add(old.sold, amount); next.proceeds = add(old.proceeds, row.nativeIn!);
      // The settled sale and the end are one store transaction, so a crash cannot leave a sold position running.
      d.store.tradeStop(j, old, { ...next, buy: null, done: { kind: 'tp', at: d.now(), value: row.nativeIn!.toString(), ...(p.floor ? { line: p.floor } : {}) } }, REASONS.tp);
      return;
    } else if (row.verdict === 'refunded') fail();
    else return bad();
  }
  if (!d.store.saveTrade(j, old, next)) return;
  if (next.failures >= MAX_FAILURES) update(d, j, 'Three trade steps in a row failed. Stop and withdraw.', true);
  else if (next.failures === 0 && j.reason) setJob(d.store, j, j.state, d.now(), { reason: null });
}

export async function tickTrade(d: WorkerDeps, j: Job, ops: GuardedOps) {
  const t = d.store.trade(j.id);
  if (!t || t.settings === 'invalid') { update(d, j, TRADE_SETTINGS_INVALID, true); return; }
  let pair: TradePair;
  try { pair = tradePair(j.pair); } catch { update(d, j, 'The trade pair is not pinned. Stop and withdraw.', true); return; }
  const s = t.settings, now = d.now(), old = t.state;
  // 1. A journaled outcome first: a finished row is applied once, an unfinished one is waited for. It is never planned again.
  if (old?.pending) {
    const row = d.store.gridStep(j.id, old.pending.id);
    if (row) { applyTradeStep(d, j, s, pair, old, row); return; }
  }
  if (!old) { d.store.saveTrade(j, null, initial(s, now)); return; }
  const stop = (from: TradeState, base: TradeState, kind: DoneKind, extra: { value?: string; line?: string } = {}, reason = REASONS[kind]) =>
    d.store.tradeStop(j, from, { ...base, pending: null, buy: null, sequence: from.pending ? from.sequence + 1 : from.sequence, done: { kind, at: now, ...extra } }, reason);
  // 2a. Clock and ledger ends need no pool or venue, so an unreadable or changed pool never keeps an expired job running.
  const end = s.strategy === 'schedule' ? scheduleEnd(s, old, now, tradeDeadline(j)) : now >= tradeDeadline(j) ? 'life' : null;
  if (end) { stop(old, old, end); return; }
  const runningSince = Number(d.store.meta(`trade_running_since:${j.id}`) ?? 0);
  const backoff = old.failedAt !== null && now < old.failedAt + BACKOFF_MS;
  // A step planned before the job last entered running (a freeze and resume, a restart) never goes out on old checks.
  const stale = !!old.pending && (now - old.pending.plannedAt > STALE_MS || old.pending.plannedAt < runningSince);
  const slot = s.strategy === 'schedule' ? slotAt(s, old.anchor ?? now, now) : null;
  // 2b. The shared read, only for protection or planning. A failed read or a broken pin throws: no evaluation, submission or plan this tick.
  // A stale row-less step is dropped first, so a lasting read failure leaves the job idle on the once-a-minute gate.
  const px = s.strategy === 'dca' || (!backoff && (!old.pending || stale) && old.lastSlot !== slot) ? await tradePoolRead(d, pair).catch((e: unknown) => {
    if (stale) d.store.saveTrade(j, old, { ...old, pending: null, buy: null, sequence: old.sequence + 1 });
    throw e;
  }) : null;
  let cur = old;
  // 2c. Stop loss, only with a receipt-proven position (9.4 entry guard).
  if (s.strategy === 'dca' && px) {
    const h = big(old.bought) - big(old.sold), k = big(old.spent) + big(old.gasBuy);
    const value = h > 0n ? outGivenIn(h, big(px.token), big(px.wnear), pair.pin.feeBps) : 0n;
    const breach = s.slBps > 0 && h > 0n && value * 10_000n <= k * BigInt(10_000 - s.slBps);
    const prev = old.protect && old.protect.since >= runningSince ? old.protect : null;
    if (breach && prev && now - prev.since >= SL_CONFIRM_MS && now - prev.since <= SL_RESET_MS && px.block > prev.block) {
      stop(old, old, 'sl', { value: value.toString(), line: (k * BigInt(10_000 - s.slBps) / 10_000n).toString() });
      return;
    }
    const protect = breach ? prev && now - prev.since <= SL_RESET_MS ? prev : { since: now, block: px.block } : null;
    if (JSON.stringify(protect) !== JSON.stringify(old.protect)) {
      cur = { ...old, protect };
      if (!d.store.saveTrade(j, old, cur)) return;
    }
  }
  // 3. Back-off after a failed step (TF-8).
  if (backoff) { update(d, j, 'Waiting five minutes after a failed trade step.'); return; }
  // 4. A row-less pending step: stale ones are dropped (their buy too, the wNEAR kept), fresh ones are submitted.
  if (cur.pending) {
    if (!stale) { await submit(d, j, s, pair, ops, cur); return; }
    const dropped = { ...cur, pending: null, buy: null, sequence: cur.sequence + 1 };
    if (!d.store.saveTrade(j, cur, dropped)) return;
    cur = dropped;
  }
  // 5. Plan new work; it is submitted by step 4 of the next pass.
  if (s.strategy === 'schedule') {
    if (cur.lastSlot === slot) { update(d, j, `Next buy at ${new Date(cur.anchor! + (slot! + 1) * s.intervalSec * 1000).toISOString()}.`); return; }
    const wait = medianWait(samples(d.store, pair), now, px!);
    if (wait) { update(d, j, wait); return; }
    planBuy(d, j, cur, cur, big(s.amount), outGivenIn(big(s.amount), big(px!.wnear), big(px!.token), pair.pin.feeBps), { slot: slot! }, now);
    return;
  }
  await planDca(d, j, s, pair, cur, px!, now, stop);
}

/** A buy wraps only the shortfall over the held wNEAR, then swaps. Its floor is 99.5 % of the planning quote (7.3) or the level price (9.1). */
function planBuy(d: WorkerDeps, j: Job, from: TradeState, base: TradeState, amount: bigint, quote: bigint, tag: { slot?: number; level?: number }, now: number, floor = quote * 9_950n / 10_000n) {
  const wrap = amount - big(base.wnear), id = `${j.id}:${base.sequence}`;
  const pending: TradeStep = wrap > 0n ? { id, kind: 'wrap', side: 'buy', amount: wrap.toString(), ...tag, plannedAt: now }
    : { id, kind: 'swap', side: 'buy', amount: amount.toString(), floor: floor.toString(), ...tag, plannedAt: now };
  if (d.store.saveTrade(j, from, { ...base, pending, buy: { amount: amount.toString(), floor: floor.toString(), ...tag } })) update(d, j, 'Buying.');
}

async function planDca(d: WorkerDeps, j: Job, s: Dca, pair: TradePair, from: TradeState, px: Sample, now: number,
  stop: (from: TradeState, base: TradeState, kind: DoneKind, extra?: { value?: string; line?: string }, reason?: string) => boolean) {
  const fee = pair.pin.feeBps, rW = big(px.wnear), rT = big(px.token), order = big(s.order);
  // 1. Base buy at market, guarded like a Schedule slot.
  if (!from.p0) {
    const wait = medianWait(samples(d.store, pair), now, px);
    if (wait) { update(d, j, wait); return; }
    planBuy(d, j, from, from, big(s.base), outGivenIn(big(s.base), rW, rT, fee), {}, now);
    return;
  }
  const p0 = { num: big(from.p0.num), den: big(from.p0.den) }, tokens = outGivenIn(order, rW, rT, fee);
  const crossed = (k: number) => tokens >= levelNeed(order, p0, k, s.stepBps);
  // 2. Arming (AD-9): only the next 1 or 2 levels; a level already crossed when armed is skipped for the round.
  const levels = [...from.levels], armed = s.levels <= 3 ? 1 : 2;
  while (levels.filter(l => l === 'armed').length < armed && levels.includes('waiting')) {
    const k = levels.indexOf('waiting');
    levels[k] = crossed(k + 1) ? 'skipped' : 'armed';
  }
  const next: TradeState = { ...from, levels };
  // 3. Take profit on the whole position, before levels. The sale is always of H with the full line as its floor.
  const h = big(from.bought) - big(from.sold), k = big(from.spent) + big(from.gasBuy), line = tpLine(k, s.tpBps), quote = outGivenIn(h, rT, rW, fee);
  if (h > 0n && quote >= line) {
    const snap = await readHoldings(d.rpc, boundWallet(j).agentAccount, [WNEAR, pair.token]), done = { value: quote.toString(), line: line.toString() };
    if ((snap.tokens[pair.token] ?? 0n) < h) { stop(from, next, 'tp-short', done); return; }
    if (!j.caps || h >= j.caps.tokenPerTx[pair.token] - 1n) { stop(from, next, 'tp-cap', done); return; }
    // TP-fit (6.3): the ops.run guard with zero prior spend and the 1 yocto attached. Waiting can never help a sale that fails it.
    const { native } = await exitBudget(d.rpc, j, snap, quote);
    if (nativeSpendProblems({ used24h: 0, used1h: 0, blockedUntil: null, nativeSpent24h: 0n }, 1n, j.caps.nativeDaily, 'strategy', native).length) {
      stop(from, next, 'tp-cap', done, 'Take profit reached, but its NEAR would exceed the signed daily limit. Stop and withdraw pays NEAR and the token.');
      return;
    }
    const pending: TradeStep = { id: `${j.id}:${from.sequence}`, kind: 'swap', side: 'sell', amount: h.toString(), floor: line.toString(), plannedAt: now };
    if (d.store.saveTrade(j, from, { ...next, pending })) update(d, j, 'Take profit reached. Selling the position.');
    return;
  }
  // 4. One level fire per evaluation, the shallowest armed level that is crossed.
  const fire = levels.findIndex((l, i) => l === 'armed' && crossed(i + 1));
  if (fire >= 0 && big(from.spent) + order <= tradePlan(s)) {
    planBuy(d, j, from, next, order, tokens, { level: fire + 1 }, now, levelNeed(order, p0, fire + 1, s.stepBps));
    return;
  }
  if (levels.some((l, i) => l !== from.levels[i]) && !d.store.saveTrade(j, from, next)) return;
  update(d, j, levels.every(l => l === 'filled' || l === 'skipped') ? 'Waiting for take profit, stop loss or the planned end.' : 'Waiting for a level or take profit.');
}

async function submit(d: WorkerDeps, j: Job, s: TradeSettings, pair: TradePair, ops: GuardedOps, st: TradeState) {
  const p = st.pending!;
  try {
    if (p.kind === 'wrap') await ops.wrap(big(p.amount));
    else await ops.swap({ pin: pair.pin, tokenIn: p.side === 'buy' ? WNEAR : pair.token, tokenOut: p.side === 'buy' ? pair.token : WNEAR, amountIn: big(p.amount),
      slippageBps: SLIPPAGE_BPS, unwrapNear: p.side === 'sell', floor: big(p.floor ?? '0') });
  } catch (e) {
    // With no journal row the guarded call could not have submitted: drop the step and its buy, keep the wNEAR, and plan again from fresh reads.
    if (!d.store.gridStep(j.id, p.id)) d.store.saveTrade(j, st, { ...st, pending: null, buy: null, sequence: st.sequence + 1 });
    throw e;
  }
  const finished = d.store.gridStep(j.id, p.id);
  if (finished) applyTradeStep(d, j, s, pair, st, finished);
}

/** Spec section 12: the trade block of the job view. Exact strings; nothing is rounded here. */
export function tradeView(store: Store, j: Job, holdings: Holdings | null, now: number) {
  const t = store.trade(j.id);
  if (!t) return null;
  const pair = tradePair(j.pair), s = t.settings, st = t.state, fee = pair.pin.feeBps;
  const zero = { spent: '0', bought: '0', sold: '0', proceeds: '0', gasBuy: '0', gasSell: '0', wnear: '0' };
  const ledger = st ? { spent: st.spent, bought: st.bought, sold: st.sold, proceeds: st.proceeds, gasBuy: st.gasBuy, gasSell: st.gasSell, wnear: st.wnear } : zero;
  const px = tradeSpot(store, pair, now), h = big(ledger.bought) - big(ledger.sold), k = big(ledger.spent) + big(ledger.gasBuy);
  const value = px && st ? outGivenIn(h, big(px.token), big(px.wnear), fee) : null;
  const held = holdings?.tokens[pair.token];
  const walletValue = px && held !== undefined ? outGivenIn(held, big(px.token), big(px.wnear), fee) : null;
  const plan = s === 'invalid' ? null : tradePlan(s), p0 = st?.p0 ? { num: big(st.p0.num), den: big(st.p0.den) } : null;
  const at = st?.done?.at ?? now;
  const currentSlot = s !== 'invalid' && s.strategy === 'schedule' && st?.anchor != null ? slotAt(s, st.anchor, at) : null;
  const taken = currentSlot !== null && st?.lastSlot === currentSlot;
  return {
    strategy: j.kind as 'schedule' | 'dca',
    pair: { id: pair.id, symbol: pair.symbol, token: pair.token, decimals: pair.decimals, poolId: pair.pin.poolId, feeBps: fee },
    settings: s, endsAt: tradeEndsAt(j), ledger,
    avgCost: big(ledger.bought) > 0n ? { num: ledger.spent, den: ledger.bought } : null,
    spot: px ? { num: px.wnear, den: px.token } : null,
    value: value?.toString() ?? null, walletValue: walletValue?.toString() ?? null,
    pnl: value === null ? null : (big(ledger.proceeds) + value - k - big(ledger.gasSell)).toString(),
    schedule: s !== 'invalid' && s.strategy === 'schedule' ? { anchor: st?.anchor ?? null, currentSlot, currentSlotTaken: taken, fills: st?.fills ?? 0,
      postponed: currentSlot === null ? 0 : Math.max(0, currentSlot - (st?.fills ?? 0) + (taken ? 1 : 0)),
      nextDueAt: currentSlot === null || st?.anchor == null ? null : st.anchor + (currentSlot + (taken ? 1 : 0)) * s.intervalSec * 1000,
      remaining: (plan! > big(ledger.spent) ? plan! - big(ledger.spent) : 0n).toString() } : null,
    dca: s !== 'invalid' && s.strategy === 'dca' ? { p0: st?.p0 ?? null,
      levels: Array.from({ length: s.levels }, (_, i) => {
        const f = ladderFactor(i + 1, s.stepBps);
        return { k: i + 1, price: p0 ? { num: (p0.num * f.num).toString(), den: (p0.den * f.den).toString() } : null,
          need: p0 ? levelNeed(big(s.order), p0, i + 1, s.stepBps).toString() : null, state: st?.levels[i] ?? 'waiting' as const };
      }),
      tpLine: p0 ? tpLine(k, s.tpBps).toString() : null, slLine: p0 && s.slBps > 0 ? (k * BigInt(10_000 - s.slBps) / 10_000n).toString() : null,
      protect: st?.protect ?? null } : null,
    buys: store.jobOps(j.id).filter(o => o.purpose === 'strategy' && (o.kind === 'wrap' || o.kind === 'swap')).map(o => {
      const i = JSON.parse(o.request) as Intent, side = o.kind === 'wrap' || i.receiver === WNEAR ? 'buy' as const : 'sell' as const;
      const out = receipt(o).output?.[pair.token];
      return { opId: o.id, kind: o.kind as 'wrap' | 'swap', side, amount: o.kind === 'wrap' ? i.deposit : String(i.args?.amount ?? '0'), verdict: o.verdict,
        used: o.used?.toString() ?? null, out: o.kind === 'swap' && side === 'buy' && typeof out === 'string' ? out : null,
        nativeIn: side === 'sell' && o.nativeIn !== null ? o.nativeIn.toString() : null, txHash: o.txHash, message: o.message, at: o.createdAt };
    }),
    done: st?.done ?? null,
  };
}
