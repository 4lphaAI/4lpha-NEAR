import { YOCTO_PER_NEAR as N } from './amounts.js';
import { CoreError, record } from './errors.js';
import { behindProof, receipt, update } from './grid.js';
import { RpcUnavailable } from './near-rpc.js';
import { lpAiRange, type LpAiInput } from './lp-ai.js';
import { boundWallet, setJob, type WorkerDeps } from './hire.js';
import { readHoldings, type Snapshot } from './holdings.js';
import type { GuardedOps, OpKind } from './ops.js';
import { CLASSIC_POOLS, USDC, WNEAR } from './pins.js';
import { DCL_POOL, dclToken, lpBlocked, pinnedLptId, predictRemove, readDcl, requireDclRegistration, toNearDown, validPoint, type DclState, type DclToken } from './rhea-dcl.js';
import type { Job, OpRow, Store } from './store.js';

export const LP_POSITION = 4n * N / 10n;
export const LP_HALF_WIDTH = 100;
// The drift allowed between the planned centre and the fresh point when the position opens (spec section 6, review LOW-1).
export const LP_CENTRE_TOLERANCE = 25;
export const LP_EVAL_MS = 60_000;
export const LP_DUST = N / 100n;
export const LP_REMOVE_MIN_BPS = 9_900n;
export const LP_MAX_FAILURES = 3;
// Demo mode spec section 2: moved byte-identical to lp-settings.ts; re-exported here so every import keeps working.
export { LP_COMPOUND_FLOOR, LP_CONFIRM_MS, LP_MAX_ROTATIONS, LP_MIN_DEPOSIT, LP_RESERVE, lpSettingsFromPrices } from './lp-settings.js';
import { LP_COMPOUND_FLOOR, LP_CONFIRM_MS, LP_MAX_ROTATIONS, LP_RESERVE } from './lp-settings.js';
export interface LpRange { left: number; right: number; }
export interface LpSettings {
  v: 2;
  range: { mode: 'server' } | ({ mode: 'explicit' } & LpRange);
  ai: boolean;
  compound: { on: false } | { on: true; minFeeBps: number };
  stopLossPct: number;
  takeProfitPct: number;
}
export { parseLpSettings } from './lp-settings.js';
import { parseLpSettings } from './lp-settings.js';
export { lpCentred, lpRangeOk } from './lp-settings.js';
import { lpCentred, lpRangeOk } from './lp-settings.js';

export interface LpLedger { usdc: string; wnear: string; native: string; inUsdc: string; inWnear: string; }
export interface LpPosition { id: string; left: number; right: number; liquidity: string; paidX: string; paidY: string; }
export interface LpStep {
  id: string;
  kind: 'wrap' | 'swap' | 'dcl_deposit' | 'dcl_add' | 'dcl_remove';
  amount: string;
  token?: DclToken;
  left?: number;
  right?: number;
  lptId?: string;
  minX?: string;
  minY?: string;
  side?: 'below' | 'above';
  reason?: 'rotation' | 'compound';
}
export interface LpState {
  ledger: LpLedger;
  swap: { tokenIn: DclToken; amount: string } | null;
  position: LpPosition | null;
  out: { side: 'below' | 'above'; since: number; block: number } | null;
  failures: number;
  sequence: number;
  pending: LpStep | null;
  range?: LpRange | null;
  nextRange?: (LpRange & { verdict: 'fallback' | 'accepted' | 'pending' | 'rebuild' | 'owner'; code?: string }) | null;
  attempt?: { id: number; fallback: LpRange; called: boolean } | null;
  history?: { at: number; point: number }[];
  protect?: { kind: 'stop-loss' | 'take-profit'; since: number; block: number; fired?: { kind: string; value: string; basis: string; block: number; at: number } } | null;
  lastDecision?: { at: number; verdict: string; code?: string; range: LpRange } | null;
  recentred?: boolean;
}

/** Successful strategy removals started in the last 24 hours. The journal is the counter, so a lost state update cannot hide a rotation. */
export const lpRotations = (rows: readonly OpRow[], now: number) =>
  rows.filter(r => r.kind === 'dcl_remove' && r.purpose === 'strategy' && r.verdict === 'success' && r.createdAt > now - 86_400_000 && record(JSON.parse(r.request))?.lpReason !== 'compound').length;

/**
 * Position ids the worker created: any dcl_add row that carries one (no verdict check, like gridKnownOrders), minus ids with a successful removal,
 * plus the state position. The watchdog passes a block: it keeps only rows finished by then and ignores the state.
 */
export function lpKnownPositions(store: Store, jobId: string, upTo?: number): string[] {
  const ids = new Set<string>(), removed = new Set<string>();
  for (const row of store.jobOps(jobId)) {
    if (!row.kind.startsWith('dcl_') || (upTo !== undefined && (row.finishedBlock === null || row.finishedBlock > upTo))) continue;
    const { dcl } = receipt(row);
    if (row.kind === 'dcl_add') {
      if (pinnedLptId(dcl?.lptId)) ids.add(dcl.lptId);
      if (Array.isArray(dcl?.discoveredPositions)) for (const id of dcl.discoveredPositions) if (pinnedLptId(id)) ids.add(id);
    } else if (row.kind === 'dcl_remove' && row.verdict === 'success' && pinnedLptId(dcl?.lptId)) removed.add(dcl.lptId);
  }
  const known = [...ids].filter(id => !removed.has(id));
  const open = upTo === undefined ? store.lp(jobId)?.state?.position : null;
  return open && !known.includes(open.id) ? [...known, open.id] : known;
}

/** The one gate. A null state means DCL must hold nothing for the agent. Without holdings the wallet clause is skipped. */
export function lpGate(state: LpState | null, venue: DclState, knownPositions: readonly string[], holdings?: Snapshot): boolean {
  if (lpBlocked(venue, knownPositions)) return false;
  if (!state) return venue.liquidities.length === 0 && Object.values(venue.assets).every(n => n === 0n);
  const { ledger: l, position: p } = state, listed = venue.liquidities;
  if ((venue.assets[USDC] ?? 0n) !== BigInt(l.inUsdc) || (venue.assets[WNEAR] ?? 0n) !== BigInt(l.inWnear)) return false;
  if (p ? listed.length !== 1 || listed[0].id !== p.id || listed[0].pool !== DCL_POOL || listed[0].left !== p.left || listed[0].right !== p.right ||
    listed[0].amount !== BigInt(p.liquidity) || listed[0].mft !== '' : listed.length !== 0) return false;
  return !holdings || ((holdings.tokens[USDC] ?? 0n) >= BigInt(l.usdc) && (holdings.tokens[WNEAR] ?? 0n) >= BigInt(l.wnear) && holdings.spendable >= BigInt(l.native));
}

export function lpIntent(state: LpState | null, kind: OpKind, amount: bigint,
  args: { token?: DclToken; left?: number; right?: number; lptId?: string; minX?: string; minY?: string; reason?: 'rotation' | 'compound' } = {}): LpStep {
  const p = state?.pending;
  if (!p || p.kind !== kind || BigInt(p.amount) !== amount || p.token !== args.token || p.left !== args.left || p.right !== args.right ||
    p.lptId !== args.lptId || p.minX !== args.minX || p.minY !== args.minY || (p.reason ?? 'rotation') !== (args.reason ?? 'rotation')) throw new CoreError('conflict', 'The LP step changed before submission.');
  return p;
}

function applyStep(d: WorkerDeps, j: Job, s: LpState, p: LpStep, row: OpRow) {
  if (row.state !== 'finished') return;
  const next: LpState = { ...s, sequence: s.sequence + 1, pending: null, ledger: { ...s.ledger } };
  if (row.verdict === 'quota' || row.verdict === 'frozen') {
    if (j.lpV2 && p.kind === 'dcl_remove') next.pending = { ...p, id: `${j.id}:${next.sequence}` };
    d.store.saveLp(j, s, next);
    return;
  }
  const failed = row.verdict === 'refunded' ? p.kind === 'swap' || p.kind === 'dcl_deposit' : row.verdict === 'reverted' && (p.kind === 'dcl_add' || p.kind === 'dcl_remove');
  if (failed) {
    next.failures += 1;
    // A refused removal leaves the range to be judged again.
    if (p.kind === 'dcl_remove') {
      next.out = null;
      if (j.lpV2) { next.attempt = null; next.nextRange = null; }
    }
    if (d.store.saveLp(j, s, next) && next.failures >= LP_MAX_FAILURES) update(d, j, `The LP ${p.kind.replace('_', ' ')} step failed ${LP_MAX_FAILURES} times in a row. Stop and withdraw.`, true);
    return;
  }
  const { output, dcl } = receipt(row), ledger = next.ledger, amount = BigInt(p.amount), pay = record(dcl?.payouts);
  const num = (v: unknown) => typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : 0n;
  const add = (key: keyof LpLedger, n: bigint) => {
    const v = BigInt(ledger[key]) + n;
    if (v < 0n) throw new CoreError('conflict', 'The LP ledger would go negative.');
    ledger[key] = v.toString();
  };
  try {
    if (p.kind === 'wrap' && row.verdict === 'success' && output?.[WNEAR] === p.amount) { add('native', -amount); add('wnear', amount); }
    else if (p.kind === 'swap' && row.verdict === 'swapped' && row.used === amount && s.swap) {
      if (s.swap.tokenIn === WNEAR) {
        const o = num(output?.[USDC]);
        if (o <= 0n) throw new CoreError('conflict', 'No swap output.');
        add('wnear', -amount); add('usdc', o);
      } else {
        if (!row.nativeIn || row.nativeIn <= 0n) throw new CoreError('conflict', 'No swap output.');
        add('usdc', -amount); add('native', row.nativeIn);
      }
      next.swap = null;
    } else if (p.kind === 'dcl_deposit' && row.verdict === 'success' && row.used === amount && p.token) {
      add(p.token === USDC ? 'usdc' : 'wnear', -amount); add(p.token === USDC ? 'inUsdc' : 'inWnear', amount);
    } else if (p.kind === 'dcl_add' && row.verdict === 'success' && pinnedLptId(dcl?.lptId) && num(dcl.liquidity) > 0n) {
      ledger.inUsdc = ledger.inWnear = '0';
      next.position = { id: dcl.lptId, left: p.left!, right: p.right!, liquidity: num(dcl.liquidity).toString(), paidX: num(dcl.paidX).toString(), paidY: num(dcl.paidY).toString() };
      add('usdc', num(pay?.[USDC]));
      // A native refund below the dust floor stays in the wallet as gas.
      if (num(pay?.native) >= LP_DUST) add('native', num(pay?.native));
      add('wnear', num(pay?.[WNEAR]));
      next.out = null;
      if (j.lpV2) { next.range = { left: p.left!, right: p.right! }; next.nextRange = null; next.attempt = null; }
    } else if (j.lpV2 && p.kind === 'dcl_remove' && p.reason === 'compound' && row.verdict === 'success' && s.position && dcl?.lptId === s.position.id) {
      add('usdc', num(pay?.[USDC])); add('native', num(pay?.native)); add('wnear', num(pay?.[WNEAR]));
      next.position = null; next.out = null; next.swap = null;
      next.nextRange = { ...s.range!, verdict: 'rebuild' }; next.attempt = null;
      next.lastDecision = { at: d.now(), verdict: 'rebuild', range: s.range! };
    } else if (p.kind === 'dcl_remove' && row.verdict === 'success' && s.position && dcl?.lptId === s.position.id && p.side) {
      add('usdc', num(pay?.[USDC])); add('native', num(pay?.native)); add('wnear', num(pay?.[WNEAR]));
      next.position = null; next.out = null;
      const tokenIn = p.side === 'above' ? WNEAR : USDC;
      const half = (tokenIn === WNEAR ? BigInt(ledger.wnear) + BigInt(ledger.native) : BigInt(ledger.usdc)) / 2n;
      if (half <= 0n) throw new CoreError('conflict', 'Nothing to swap.');
      next.swap = { tokenIn, amount: half.toString() };
      if (j.lpV2) {
        if (!s.nextRange) throw new CoreError('conflict', 'No rotation range.');
        next.lastDecision = { at: d.now(), verdict: s.nextRange.verdict, ...(s.nextRange.code ? { code: s.nextRange.code } : {}), range: { left: s.nextRange.left, right: s.nextRange.right } };
        next.attempt = null;
      }
    } else throw new CoreError('conflict', 'Unexpected result.');
  } catch {
    update(d, j, 'An LP operation did not settle as expected. Stop and withdraw to recover the funds.', true);
    return;
  }
  next.failures = 0;
  if (d.store.saveLp(j, s, next) && j.reason) setJob(d.store, j, j.state, d.now(), { reason: null });
}

export async function tickLp(d: WorkerDeps, j: Job, ops: GuardedOps) {
  const raw = d.store.lp(j.id)?.state ?? null;
  const settings = j.lpV2 ? d.store.lpSettings(j.id) : null;
  if (j.lpV2 && (!settings || settings === 'invalid')) { update(d, j, 'LP settings are unreadable. Stop and withdraw.', true); return; }
  const v2 = settings && settings !== 'invalid' ? settings : null;
  const old = raw && j.lpV2 ? { range: null, nextRange: null, attempt: null, history: [], protect: null, lastDecision: null, ...raw } : raw;
  if (old?.pending) {
    const p = old.pending, row = d.store.gridStep(j.id, p.id);
    if (row) { applyStep(d, j, raw!, p, row); return; }
  }

  const b = boundWallet(j), now = d.now();
  // V1 retains its pending-step path. V2 observes and protects before an unsubmitted step.
  const snap = !old?.pending || v2 ? await readHoldings(d.rpc, b.agentAccount, [WNEAR, USDC]) : null;
  // An idle read older than a proven step is retried, never judged (the watchdog's rule): a public node may trail QuickNode by a block or two.
  if (snap && behindProof(d, j, snap.block)) throw new RpcUnavailable();
  const venue = snap ? await readDcl(d.rpc, b.agentAccount, snap, []) : null;
  if (venue) {
    requireDclRegistration(venue, j.owner);
    if (!lpGate(old, venue, lpKnownPositions(d.store, j.id), snap!)) {
      update(d, j, 'DCL or the wallet holds something the LP job did not record. Stop and withdraw or use the saved management link.', true);
      return;
    }
  }
  if (!old) {
    const principal = v2 ? j.depositYocto - LP_RESERVE : LP_POSITION;
    const range = v2 ? v2.range.mode === 'explicit' ? { left: v2.range.left, right: v2.range.right } : lpCentred(200, venue!.point) : null;
    if (v2 && !range) { update(d, j, 'The LP range is too close to the DCL point limit.', true); return; }
    d.store.saveLp(j, raw, { ledger: { usdc: '0', wnear: '0', native: principal.toString(), inUsdc: '0', inWnear: '0' }, swap: { tokenIn: WNEAR, amount: (principal / 2n).toString() },
      position: null, out: null, failures: 0, sequence: 0, pending: null,
      ...(v2 ? { range, nextRange: null, attempt: null, history: [{ at: now, point: venue!.point }], protect: null, lastDecision: null } : {}) });
    return;
  }
  let next: LpState = v2 ? { ...old, history: [...old.history!, { at: now, point: venue!.point }].slice(-60) } : old;
  if (v2 && (v2.stopLossPct > 0 || v2.takeProfitPct > 0)) {
    const [x, y] = old.position ? await predictRemove(d.rpc, old.position.id, BigInt(old.position.liquidity), snap!) : [0n, 0n];
    const point = venue!.point, listed = venue!.liquidities[0];
    const low = snap!.spendable + snap!.tokens[WNEAR] + (venue!.assets[WNEAR] ?? 0n) + y + toNearDown(snap!.tokens[USDC] + (venue!.assets[USDC] ?? 0n) + x, point);
    const high = low + (listed?.feeY ?? 0n) + toNearDown(listed?.feeX ?? 0n, point), basis = j.depositYocto;
    const kind = v2.stopLossPct > 0 && high * 100n <= basis * BigInt(100 - v2.stopLossPct) ? 'stop-loss'
      : v2.takeProfitPct > 0 && low * 100n >= basis * BigInt(100 + v2.takeProfitPct) ? 'take-profit' : null;
    const previous = old.protect;
    next.protect = kind ? previous?.kind === kind && now - previous.since <= 1_800_000 ? previous : { kind, since: now, block: snap!.block } : null;
    if (kind && previous?.kind === kind && now - previous.since >= 300_000 && now - previous.since <= 1_800_000 && snap!.block > previous.block) {
      next.protect = { ...previous, fired: { kind, value: (kind === 'stop-loss' ? high : low).toString(), basis: basis.toString(), block: snap!.block, at: now } };
      if (old.pending) { next.pending = null; next.sequence += 1; }
      d.store.protectStop(j, raw!, next);
      return;
    }
  }
  if (old.pending) {
    const p = old.pending;
    if (v2 && !d.store.saveLp(j, raw, next)) return;
    const from = v2 ? next : raw!;
    try {
      if (p.kind === 'wrap') await ops.wrap(BigInt(p.amount));
      else if (p.kind === 'swap') {
        const tokenIn = old.swap!.tokenIn;
        await ops.swap({ pin: CLASSIC_POOLS[0], tokenIn, tokenOut: tokenIn === WNEAR ? USDC : WNEAR, amountIn: BigInt(p.amount), slippageBps: 50, unwrapNear: tokenIn === USDC });
      } else if (p.kind === 'dcl_deposit') await ops.depositDcl!(p.token!, BigInt(p.amount));
      else if (p.kind === 'dcl_add') await ops.addLp!(p.left!, p.right!, BigInt(old.ledger.inUsdc), BigInt(old.ledger.inWnear));
      else await ops.removeLp!(p.lptId!, BigInt(p.amount), p.minX!, p.minY!, 'strategy', p.reason);
    } catch (e) {
      // With no journal row, the guarded call could not have submitted. Replan against the next finalized point.
      if (!d.store.gridStep(j.id, p.id)) d.store.saveLp(j, from, { ...from, sequence: old.sequence + 1, pending: null,
        ...(v2 && p.kind === 'dcl_remove' ? { attempt: null, nextRange: null, out: null } : {}) });
      throw e;
    }
    const finished = d.store.gridStep(j.id, p.id);
    if (finished) applyStep(d, j, from, p, finished);
    return;
  }

  const point = venue!.point, l = old.ledger;
  const schedule = (step: Omit<LpStep, 'id'>) => { d.store.saveLp(j, raw, { ...next, pending: { ...step, id: `${j.id}:${old.sequence}` } }); };
  const halt = (message: string) => update(d, j, message, true);

  const pos = old.position;
  if (pos) {
    if (point >= pos.left && point < pos.right) {
      if (v2) {
        if (old.attempt) { next.attempt = null; next.nextRange = null; }
        next.out = null;
        if (v2.compound.on && next.range && lpRangeOk(next.range, point) && !old.out && !old.swap && !next.nextRange) {
          const last = d.store.jobOps(j.id).filter(r => r.kind === 'dcl_remove' && r.purpose === 'strategy' && record(JSON.parse(r.request))?.lpReason === 'compound')
            .reduce((at, r) => Math.max(at, r.createdAt), 0);
          if (now - last >= 21_600_000) {
            const [x, y] = await predictRemove(d.rpc, pos.id, BigInt(pos.liquidity), snap!);
            const listed = venue!.liquidities[0], fee = listed.feeY + toNearDown(listed.feeX, point), value = y + toNearDown(x, point);
            const threshold = value * BigInt(v2.compound.minFeeBps) / 10_000n;
            if (fee >= (threshold > LP_COMPOUND_FLOOR ? threshold : LP_COMPOUND_FLOOR)) {
              schedule({ kind: 'dcl_remove', amount: pos.liquidity, lptId: pos.id, minX: (x * LP_REMOVE_MIN_BPS / 10_000n).toString(), minY: (y * LP_REMOVE_MIN_BPS / 10_000n).toString(), reason: 'compound' });
              return;
            }
          }
        }
        d.store.saveLp(j, raw, next);
      } else if (old.out) d.store.saveLp(j, raw, { ...old, out: null });
      update(d, j, 'In range.');
      return;
    }
    const side = point < pos.left ? 'below' : 'above';
    if (!old.out || old.out.side !== side) {
      d.store.saveLp(j, raw, { ...next, out: { side, since: now, block: snap!.block }, ...(v2 ? { attempt: null, nextRange: null } : {}) });
      update(d, j, 'Out of range, confirming.');
      return;
    }
    if (now - old.out.since < LP_CONFIRM_MS || snap!.block === old.out.block) { if (v2) d.store.saveLp(j, raw, next); update(d, j, 'Out of range, confirming.'); return; }
    if (lpRotations(d.store.jobOps(j.id), now) >= LP_MAX_ROTATIONS) {
      if (v2) d.store.saveLp(j, raw, next);
      update(d, j, 'Out of range. The rotation limit of 2 per 24 hours is reached; the position earns no fees until the price returns or the window rolls.');
      return;
    }
    const [x, y] = await predictRemove(d.rpc, pos.id, BigInt(pos.liquidity), snap!);
    if (v2 && !old.attempt) {
      const range = next.range!, width = range.right - range.left, fallback = lpCentred(width, point);
      if (!fallback) { halt('The LP range is too close to the DCL point limit.'); return; }
      next.attempt = { id: old.sequence, fallback, called: true };
      next.nextRange = { ...fallback, verdict: v2.ai && d.ai ? 'pending' : 'fallback', ...(!v2.ai || !d.ai ? { code: 'off' } : {}) };
      if (!d.store.saveLp(j, raw, next)) return;
      if (v2.ai && d.ai) {
        const input: LpAiInput = { poolId: DCL_POOL, fee: 100, point, range, bounds: { minWidth: Math.max(20, Math.ceil(width / 2)), maxWidth: Math.min(2000, 2 * width) }, history: next.history! };
        let decision: NonNullable<LpState['nextRange']>;
        try { decision = lpAiRange(input, await d.ai(input, AbortSignal.timeout(20_000))); }
        catch (e) { decision = { ...fallback, verdict: 'fallback', code: e instanceof Error && ['unavailable', 'timeout', 'http', 'malformed'].includes(e.message) ? e.message : 'unavailable' }; }
        const current = d.store.getJob(j.id), state = d.store.lp(j.id)?.state;
        if (current?.state === 'running' && current.version === j.version && state?.attempt?.id === next.attempt.id && d.store.meta(`watch_frozen:${j.id}`) !== 'true') {
          d.store.saveLp(j, state, { ...state, nextRange: decision });
        }
      }
      return;
    }
    if (v2 && next.nextRange?.verdict === 'pending') next.nextRange = { ...next.attempt!.fallback, verdict: 'fallback', code: 'unavailable' };
    const min = (n: bigint) => (n * LP_REMOVE_MIN_BPS / 10_000n).toString();
    schedule({ kind: 'dcl_remove', amount: pos.liquidity, lptId: pos.id, minX: side === 'below' ? min(x) : '0', minY: side === 'above' ? min(y) : '0', side, ...(v2 ? { reason: 'rotation' as const } : {}) });
    return;
  }

  const perTx = j.caps ? j.caps.nativePerTx - 1n : 0n;
  if (old.swap) {
    const amount = BigInt(old.swap.amount);
    if (old.swap.tokenIn === WNEAR && BigInt(l.wnear) < amount) {
      const wrap = [amount - BigInt(l.wnear), BigInt(l.native), perTx].reduce((a, c) => c < a ? c : a);
      if (wrap <= 0n) { halt('The LP job has no NEAR left to wrap. Stop and withdraw.'); return; }
      schedule({ kind: 'wrap', amount: wrap.toString() });
    } else schedule({ kind: 'swap', amount: old.swap.amount });
    return;
  }
  let native = BigInt(l.native);
  if (native > 0n && native < LP_DUST) { native = 0n; next = { ...next, ledger: { ...l, native: '0' } }; }
  if (native >= LP_DUST && perTx > 0n) { schedule({ kind: 'wrap', amount: (native < perTx ? native : perTx).toString() }); return; }
  if (BigInt(l.usdc) > 0n) { schedule({ kind: 'dcl_deposit', amount: l.usdc, token: USDC }); return; }
  if (BigInt(l.wnear) > 0n) { schedule({ kind: 'dcl_deposit', amount: l.wnear, token: WNEAR }); return; }
  if (BigInt(l.inUsdc) > 0n && BigInt(l.inWnear) > 0n) {
    let left = point - LP_HALF_WIDTH, right = point + LP_HALF_WIDTH;
    if (v2) {
      const planned = next.nextRange ?? next.range!, rebuild = next.nextRange?.verdict === 'rebuild';
      const range = rebuild || lpRangeOk(planned, point) ? planned : lpCentred(planned.right - planned.left, point);
      if (!range) { halt('The LP range is too close to the DCL point limit.'); return; }
      left = range.left; right = range.right;
      next.range = { left, right };
      next.recentred = left !== planned.left || right !== planned.right;
    }
    if (!validPoint(left) || !validPoint(right)) { halt('The LP range is too close to the DCL point limit.'); return; }
    schedule({ kind: 'dcl_add', amount: '0', left, right });
    return;
  }
  halt('The LP job has nothing it can open. Stop and withdraw.');
}

export async function drainLp(d: WorkerDeps, j: Job, ops: GuardedOps): Promise<boolean> {
  const b = boundWallet(j), s = await readHoldings(d.rpc, b.agentAccount, [WNEAR, USDC]);
  const venue = await readDcl(d.rpc, b.agentAccount, s, []);
  if (lpBlocked(venue, lpKnownPositions(d.store, j.id))) {
    update(d, j, 'DCL exit is blocked by an unknown position, order, lost-found or a farmed position. Use the saved management link for recovery.');
    return false;
  }
  const settle = (r: { verdict: string; message: string | null }, done: string) => {
    if (r.verdict === 'success') update(d, j, done);
    else if (r.message && d.store.getJob(j.id)?.state === 'stopping') update(d, j, r.message);
  };
  // The exit takes no minimum, so slippage cannot refuse it.
  for (const p of venue.liquidities) {
    settle(await ops.removeLp!(p.id, p.amount, '0', '0', 'exit'), 'A DCL position was removed. Checking remaining balances.');
    return false;
  }
  for (const [token, amount] of Object.entries(venue.assets)) if (dclToken(token) && amount > 0n) {
    settle(await ops.withdrawDcl!(token), 'A DCL balance was returned to the agent wallet. Checking remaining balances.');
    return false;
  }
  return true;
}
