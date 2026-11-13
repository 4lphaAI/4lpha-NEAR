import { YOCTO_PER_NEAR as N } from './amounts.js';
import { CoreError, record } from './errors.js';
import { RpcUnavailable } from './near-rpc.js';
import { boundWallet, setJob, type WorkerDeps } from './hire.js';
import { readHoldings } from './holdings.js';
import type { GuardedOps, OpKind } from './ops.js';
import { CLASSIC_POOLS, USDC, WNEAR } from './pins.js';
import { dclBlocked, dclOpen, dclToken, otherToken, pinnedOrderId, readDcl, requireDclRegistration, toNearDown, validPoint, type DclState, type DclToken } from './rhea-dcl.js';
import type { Snapshot } from './holdings.js';
import type { Job, OpRow, Store } from './store.js';

export const GRID_V1_STEP = 100;
/** An idle running Grid job reads the chain at most once a minute. A tick that schedules or runs a step never sets the gate. */
export const GRID_EVAL_MS = 60_000;
export type GridPreset = 'tight' | 'balanced' | 'wide' | 'volatile';
export { GRID_STEPS, parseGridSettings } from './grid-settings.js';
import { GRID_STEPS, parseGridSettings } from './grid-settings.js';
// Demo mode spec section 2: pure Grid rules moved byte-identical to grid-settings.ts; re-exported here so every import keeps working.
export { GRID_BOOTSTRAP, gridProtectStep, gridSettingsFromRequest, lanePoints, restingSide } from './grid-settings.js';
export type { GridProtect } from './grid-settings.js';
import { GRID_BOOTSTRAP, gridProtectStep, lanePoints, offsets, restingSide, type GridProtect } from './grid-settings.js';
export interface GridSettings { v: 2; step: number; orders: 2 | 4; stopLossPct: number; takeProfitPct: number; }
export const GRID_SETTINGS_INVALID = 'Grid settings are unreadable. Stop and withdraw.';
const exactKeys = (r: Record<string, unknown> | null, keys: string[]) => !!r && Object.keys(r).length === keys.length && keys.every(k => Object.hasOwn(r, k));

/**
 * The job's step from its three copies of V2 identity: the settings row, the hire-time marker and the state.
 * 100 only when none says V2; the settings step only when all agree; anything else is invalid.
 */
export function gridStep(settings: GridSettings | null | 'invalid', marker: string | null, state: GridState | null): number | 'invalid' {
  if (settings === null && marker === null) return !state || (state.v2 === undefined && state.step === undefined && state.lanes.length === 4) ? GRID_V1_STEP : 'invalid';
  if (settings === null || settings === 'invalid' || marker !== String(settings.step)) return 'invalid';
  if (state && (state.v2 !== true || state.step !== settings.step || state.lanes.length !== settings.orders)) return 'invalid';
  return settings.step;
}
export const jobGridStep = (store: Store, jobId: string, state: GridState | null) => gridStep(store.gridSettings(jobId), store.meta(`grid_v2:${jobId}`), state);
export interface GridLane { generation: number; sell: DclToken; amount: string; orderId: string | null; native: boolean; }
export interface GridStep {
  id: string;
  kind: 'wrap' | 'swap' | 'dcl_place' | 'dcl_claim';
  lane: number | null;
  amount: string;
  orderId?: string;
  sell?: DclToken;
  point?: number;
}
export interface GridState {
  anchor: number; bootstrap: number; lanes: GridLane[]; sequence: number; pending: GridStep | null;
  v2?: true; step?: number; protect?: GridProtect | null;
}

const lanePoint = (s: GridState, i: number, step: number) => lanePoints(s.anchor, i, step, s.lanes.length)[s.lanes[i].generation % 2];

export function receipt(row: OpRow) {
  const r = record(JSON.parse(row.after ?? 'null'));
  const dcl = record(r?.dclProof);
  return { output: record(r?.effects), dcl };
}

export function gridKnownOrders(store: Store, jobId: string): string[] {
  const ids = new Set<string>(), completed = new Set<string>();
  for (const l of store.grid(jobId)?.state?.lanes ?? []) if (l.orderId) ids.add(l.orderId);
  for (const row of store.jobOps(jobId)) {
    if (!row.kind.startsWith('dcl_')) continue;
    const { dcl } = receipt(row);
    if (row.kind === 'dcl_place') {
      if (pinnedOrderId(dcl?.orderId)) ids.add(dcl.orderId);
      if (Array.isArray(dcl?.discovered)) for (const id of dcl.discovered) if (pinnedOrderId(id)) ids.add(id);
    } else if (row.verdict === 'success' && dcl?.completed === true && pinnedOrderId(dcl.orderId)) completed.add(dcl.orderId);
  }
  return [...ids].filter(id => !completed.has(id));
}

/** Value in NEAR at the venue's block: wallet, DCL internal balances and every open lane order, each counted once. */
export function gridValue(snap: Pick<Snapshot, 'spendable' | 'tokens'>, venue: DclState): bigint {
  let near = snap.spendable + (snap.tokens[WNEAR] ?? 0n) + (venue.assets[WNEAR] ?? 0n);
  let usdc = (snap.tokens[USDC] ?? 0n) + (venue.assets[USDC] ?? 0n);
  for (const o of dclOpen(venue)) {
    if (o.sell === WNEAR) { near += o.remain; usdc += o.unclaimed; } else { usdc += o.remain; near += o.unclaimed; }
  }
  return near + toNearDown(usdc, venue.point);
}

export function gridOrderGate(state: GridState | null, dcl: DclState, step: number): boolean {
  if (dclBlocked(dcl) || Object.values(dcl.assets).some(n => n > 0n)) return false;
  const lanes = state?.lanes ?? [];
  const open = dclOpen(dcl);
  // A strategy claim that pays without closing its order leaves that order for owner exit.
  return open.length <= lanes.length && open.every(o => o.cancelled === 0n && o.bought === o.unclaimed &&
    lanes.some((l, i) => l.orderId === o.id && l.sell === o.sell && BigInt(l.amount) === o.original && lanePoint(state!, i, step) === o.point)) &&
    lanes.every(l => l.orderId === null || open.some(o => o.id === l.orderId));
}

export function gridIntent(state: GridState | null, step: number, kind: OpKind, amount: bigint, args: { id?: string; sell?: DclToken; point?: number } = {}): GridStep {
  const p = state?.pending;
  if (!state || !p || p.kind !== kind || BigInt(p.amount) !== amount || p.orderId !== args.id || p.sell !== args.sell || p.point !== args.point) throw new CoreError('conflict', 'The Grid lane changed before submission.');
  const lane = p.lane === null ? null : state.lanes[p.lane];
  if ((!lane && (p.lane !== null || state.bootstrap >= 3 || amount !== GRID_BOOTSTRAP || kind !== (state.bootstrap === 1 ? 'swap' : 'wrap'))) ||
    (lane && (state.bootstrap !== 3 || (kind === 'dcl_claim' ? lane.orderId !== args.id : lane.orderId !== null || BigInt(lane.amount) !== amount ||
      (kind === 'wrap' ? !lane.native || lane.sell !== WNEAR : kind !== 'dcl_place' || lane.native || lane.sell !== args.sell || lanePoint(state, p.lane!, step) !== args.point))))) {
    throw new CoreError('conflict', 'The Grid lane cannot submit this operation.');
  }
  return p;
}

export function update(d: WorkerDeps, job: Job, message: string, halt = false) {
  if (halt || job.reason !== message) setJob(d.store, job, halt ? 'halted' : job.state, d.now(), { reason: message });
}

function applyStep(d: WorkerDeps, j: Job, s: GridState, p: GridStep, row: OpRow) {
  if (row.state !== 'finished') return;
  const next = { ...s, sequence: s.sequence + 1, pending: null, lanes: s.lanes.map(l => ({ ...l })) };
  if (row.verdict === 'quota' || row.verdict === 'frozen') {
    d.store.saveGrid(j, s, next);
    return;
  }
  const { output, dcl } = receipt(row);
  const lane = p.lane === null ? null : next.lanes[p.lane];
  const bad = () => update(d, j, 'A Grid operation did not settle as expected. Stop and withdraw to recover the funds.', true);
  if (p.kind === 'swap' && row.verdict === 'swapped' && s.bootstrap === 1 && row.used === GRID_BOOTSTRAP) {
    const n = typeof output?.[USDC] === 'string' ? BigInt(output[USDC]) : 0n;
    // Spec 2c section 12: the proven USDC output is split over the USDC lanes; dust stays in the wallet.
    const usdcLanes = next.lanes.filter(l => l.sell === USDC);
    if (n < BigInt(usdcLanes.length)) return bad();
    for (const l of usdcLanes) l.amount = (n / BigInt(usdcLanes.length)).toString();
    next.bootstrap = 2;
  } else if (row.verdict !== 'success') return bad();
  else if (p.kind === 'wrap') {
    if (output?.[WNEAR] !== p.amount) return bad();
    if (lane) lane.native = false;
    else {
      next.bootstrap += 1;
      if (next.bootstrap === 3) { const nearLanes = next.lanes.filter(l => l.sell === WNEAR); for (const l of nearLanes) l.amount = (GRID_BOOTSTRAP / BigInt(nearLanes.length)).toString(); }
    }
  } else if (p.kind === 'dcl_place' && lane && pinnedOrderId(dcl?.orderId)) lane.orderId = dcl.orderId;
  else if (p.kind === 'dcl_claim' && lane && dcl?.completed === true && dcl.orderId === lane.orderId) {
    const bought = otherToken(lane.sell), payouts = record(dcl.payouts);
    const n = payouts?.[bought] ?? (bought === WNEAR ? payouts?.native : undefined);
    if (typeof n !== 'string' || BigInt(n) <= 0n || n !== dcl.claimed) return bad();
    lane.orderId = null;
    lane.generation += 1;
    lane.sell = bought;
    lane.native = bought === WNEAR && typeof payouts?.native === 'string';
    lane.amount = n;
  } else return bad();
  if (d.store.saveGrid(j, s, next) && j.reason) setJob(d.store, j, j.state, d.now(), { reason: null });
}

/**
 * Spec 2c section 3: reads and evaluates protection for a V2 job with a threshold, after bootstrap.
 * Returns the state to continue with (saved when the observation changed), or null when the tick must end.
 */
async function protectGrid(d: WorkerDeps, j: Job, s: GridState, settings: GridSettings, step: number, read?: { snap: Snapshot; venue: DclState }): Promise<GridState | null> {
  if (s.bootstrap !== 3 || (settings.stopLossPct === 0 && settings.takeProfitPct === 0)) return s;
  let snap = read?.snap, venue = read?.venue;
  if (!snap || !venue) {
    const b = boundWallet(j);
    snap = await readHoldings(d.rpc, b.agentAccount, [WNEAR, USDC]);
    // An idle read older than a proven step is retried, never judged (the watchdog's rule): a public node may trail QuickNode by a block or two.
    if (behindProof(d, j, snap.block)) throw new RpcUnavailable();
    venue = await readDcl(d.rpc, b.agentAccount, snap, gridKnownOrders(d.store, j.id));
    requireDclRegistration(venue, j.owner);
    if (!gridOrderGate(s, venue, step)) { update(d, j, 'DCL has an unknown or unresolved holding. Stop and withdraw or use the saved management link.', true); return null; }
  }
  const now = d.now();
  const r = gridProtectStep(s.protect, { value: gridValue(snap, venue), deposit: j.depositYocto, settings, now, block: snap.block,
    runningSince: Number(d.store.meta(`grid_running_since:${j.id}`) ?? 0) });
  if (r.fire) {
    d.store.gridProtectStop(j, s, { ...s, protect: r.protect, ...(s.pending ? { pending: null, sequence: s.sequence + 1 } : {}) });
    return null;
  }
  if (JSON.stringify(r.protect) === JSON.stringify(s.protect ?? null)) return s;
  const next = { ...s, protect: r.protect };
  return d.store.saveGrid(j, s, next) ? next : null;
}

/** True when a finalized snapshot is older than a step this job already proved. */
export const behindProof = (d: { store: WorkerDeps['store'] }, j: Job, block: number) => d.store.jobOps(j.id).some(r => r.finishedBlock !== null && r.finishedBlock > block);

export async function tickGrid(d: WorkerDeps, j: Job, ops: GuardedOps) {
  let old = d.store.grid(j.id)?.state ?? null;
  const raw = d.store.gridSettings(j.id), step = gridStep(raw, d.store.meta(`grid_v2:${j.id}`), old);
  if (step === 'invalid') { update(d, j, GRID_SETTINGS_INVALID, true); return; }
  const settings = raw && raw !== 'invalid' ? raw : null;
  if (old?.pending) {
    const p = old.pending, row = d.store.gridStep(j.id, p.id);
    if (row) { applyStep(d, j, old, p, row); return; }
    // V2 observes and protects before an unsubmitted step, like LP V2.
    if (settings) { const next = await protectGrid(d, j, old, settings, step); if (!next) return; old = next; }
    try {
      if (p.kind === 'wrap') await ops.wrap(BigInt(p.amount));
      else if (p.kind === 'swap') await ops.swap({ pin: CLASSIC_POOLS[0], tokenIn: WNEAR, tokenOut: USDC, amountIn: GRID_BOOTSTRAP, slippageBps: 50, unwrapNear: false });
      else if (p.kind === 'dcl_place') await ops.placeDcl!(p.sell!, BigInt(p.amount), p.point!);
      else await ops.closeDcl!(p.orderId!, 'dcl_claim', 'strategy');
    } catch (e) {
      // With no journal row, the guarded call could not have submitted. Replan against the next finalized point, after the idle minute
      // (RPC budget hotfix, 2026-11-12: a refusal such as a short exit reserve otherwise re-reads the chain every few seconds).
      if (!d.store.gridStep(j.id, p.id) && d.store.saveGrid(j, old, { ...old, sequence: old.sequence + 1, pending: null }) &&
        e instanceof CoreError && e.code === 'limit_reached') d.store.setMeta(`grid_eval:${j.id}`, String(d.now()));
      throw e;
    }
    const finished = d.store.gridStep(j.id, p.id);
    if (finished) applyStep(d, j, old, p, finished);
    return;
  }

  const b = boundWallet(j);
  const snap = await readHoldings(d.rpc, b.agentAccount, [WNEAR, USDC]);
  // An idle read older than a proven step is retried, never judged (the watchdog's rule): a public node may trail QuickNode by a block or two.
  if (behindProof(d, j, snap.block)) throw new RpcUnavailable();
  const venue = await readDcl(d.rpc, b.agentAccount, snap, gridKnownOrders(d.store, j.id));
  requireDclRegistration(venue, j.owner);
  if (!gridOrderGate(old, venue, step)) { update(d, j, 'DCL has an unknown or unresolved holding. Stop and withdraw or use the saved management link.', true); return; }
  if (!old) {
    const orders = settings ? settings.orders : 4;
    if (offsets(step, orders).some((_, i) => lanePoints(venue.point, i, step, orders).some(p => !validPoint(p)))) { update(d, j, 'The Grid anchor is too close to the DCL point limit.', true); return; }
    d.store.saveGrid(j, null, { anchor: venue.point, bootstrap: 0, sequence: 0, pending: null,
      lanes: offsets(step, orders).map((_, i) => ({ generation: 0, sell: i < orders / 2 ? USDC : WNEAR, amount: '0', orderId: null, native: false })),
      ...(settings ? { v2: true as const, step } : {}) });
    return;
  }
  if (settings) { const next = await protectGrid(d, j, old, settings, step, { snap, venue }); if (!next) return; old = next; }
  const from = old;
  const schedule = (s: Omit<GridStep, 'id'>) => d.store.saveGrid(j, from, { ...from, pending: { ...s, id: `${j.id}:${from.sequence}` } });
  if (old.bootstrap < 3) { schedule({ kind: old.bootstrap === 1 ? 'swap' : 'wrap', lane: null, amount: GRID_BOOTSTRAP.toString() }); return; }
  for (const [i, lane] of old.lanes.entries()) if (lane.orderId) {
    const order = venue.orders[lane.orderId];
    if (order?.remain === 0n && order.unclaimed > 0n) { schedule({ kind: 'dcl_claim', lane: i, orderId: lane.orderId, amount: '0' }); return; }
  }
  const open = dclOpen(venue), storage = venue.storage!;
  const candidates = old.lanes.map((lane, i) => ({ lane, i })).sort((a, b) => Number(b.lane.generation > 0) - Number(a.lane.generation > 0));
  for (const { lane, i } of candidates) {
    if (lane.orderId) continue;
    const point = lanePoint(old, i, step), n = BigInt(lane.amount);
    if (n <= 0n) { update(d, j, 'A Grid lane has no confirmed proceeds.', true); return; }
    if (lane.native) {
      if (!j.caps || n >= j.caps.nativePerTx) { update(d, j, 'The lane payout exceeds the signed wrap cap. Stop and withdraw to recover it.', true); return; }
      schedule({ kind: 'wrap', lane: i, amount: lane.amount }); return;
    }
    if (!restingSide(lane.sell, point, venue.point) || open.some(o => o.point === point) || open.length >= old.lanes.length || storage.orders + storage.positions >= storage.slots) continue;
    if (!j.caps || n >= j.caps.tokenPerTx[lane.sell]) { update(d, j, 'The lane amount exceeds its signed token cap. Stop and withdraw to recover it.', true); return; }
    schedule({ kind: 'dcl_place', lane: i, sell: lane.sell, amount: lane.amount, point }); return;
  }
  d.store.setMeta(`grid_eval:${j.id}`, String(d.now()));
  update(d, j, 'Waiting for a full fill or an available resting price and slot.');
}

export async function drainGrid(d: WorkerDeps, j: Job, ops: GuardedOps): Promise<boolean> {
  const b = boundWallet(j), s = await readHoldings(d.rpc, b.agentAccount, [WNEAR, USDC]);
  const venue = await readDcl(d.rpc, b.agentAccount, s, gridKnownOrders(d.store, j.id));
  if (dclBlocked(venue)) { update(d, j, 'DCL exit is blocked by an unresolved order, another pool, lost-found, or a position. Use the saved management link for recovery.'); return false; }
  for (const o of dclOpen(venue)) {
    if (o.remain === 0n && o.unclaimed === 0n) { update(d, j, 'Waiting for finalized DCL order completion.'); return false; }
    const r = await ops.closeDcl!(o.id, o.remain > 0n ? 'dcl_cancel' : 'dcl_claim', 'exit');
    if (r.verdict === 'success') update(d, j, 'A DCL order closed. Checking remaining orders and balances.');
    else if (r.message && d.store.getJob(j.id)?.state === 'stopping') update(d, j, r.message);
    return false;
  }
  for (const [token, amount] of Object.entries(venue.assets)) if (dclToken(token) && amount > 0n) {
    const r = await ops.withdrawDcl!(token);
    if (r.verdict === 'success') update(d, j, 'A DCL balance was returned to the agent wallet. Checking remaining balances.');
    else if (r.message && d.store.getJob(j.id)?.state === 'stopping') update(d, j, r.message);
    return false;
  }
  return true;
}
