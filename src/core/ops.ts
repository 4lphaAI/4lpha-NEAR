import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseAmount, YOCTO_PER_NEAR as N } from './amounts.js';
import { exitNative, exitReserve, freeNearProblems, holdFor, nativeSpendProblems, opsProblems, type Purpose } from './budget.js';
import { CoreError, record, redactText } from './errors.js';
import { intentOrderIds, intentPositionIds, matchesIntent, provenEffects, receiptInterval, recipientProblems, type Intent, type OpKind, type OpVerdict } from './evidence.js';
import { readDclBefore, type DclBefore } from './dcl-evidence.js';
import { LP_CENTRE_TOLERANCE, lpGate, lpIntent, lpKnownPositions, lpRangeOk, type LpPosition } from './lp.js';
import { GRID_BOOTSTRAP, GRID_SETTINGS_INVALID, gridIntent, gridKnownOrders, gridOrderGate, jobGridStep, restingSide } from './grid.js';
import { boundWallet, jobMaxDeposit, jobTokens, readWalletSecret, setJob } from './hire.js';
import { holdingsDelta, parseHoldings, readHoldings, registered, unexplained, type Holdings, type Snapshot } from './holdings.js';
import { RpcUnavailable, type NearRpc } from './near-rpc.js';
import type { CallRequest, OutLayerClient, SubmitResult } from './outlayer.js';
import { CLASSIC_EXCHANGE, CLASSIC_POOLS, GAS, MONEY, USDC, WNEAR, type PinnedPool } from './pins.js';
import { buildRules, chainGateProblems, readChainPolicy, rulesMismatches, type Caps } from './policy.js';
import { ftTransferCall, minOut, pinnedPool, quote, readTradePool, requireVenue, swapCall, unwrapCall, wrapCall } from './rhea-classic.js';
import { tradeDeadline, tradeIntent, TRADE_SETTINGS_INVALID, TRADE_WRAP_ROOM } from './trade.js';
import { tradePair } from './trade-pairs.js';
import { completedOrder, DCL_GAS, jobDclKinds, dclAction, dclBlocked, dclClose, dclDeposit, dclOpen, dclPlace, dclToken, dclWithdraw, limitProceeds, lpAdd, lpBlocked, lpRemove, otherToken, readDcl, requireDclRegistration, sameOrder, type DclKind, type DclState, type DclToken } from './rhea-dcl.js';
import { parseTxStatus, type SignedAction } from './receipts.js';
import type { SecretString } from './secrets.js';
import { json, type Job, type OpRow, type Store } from './store.js';

export type { OpKind, OpVerdict, Holdings };
export interface OpResult { opId: string; kind: OpKind; verdict: OpVerdict; txHash: string | null; used: bigint | null; nativeIn: bigint | null; burnt: bigint | null; message: string | null; }
export interface GuardedOps {
  holdings(): Promise<Holdings & { spendable?: bigint }>;
  quote(pin: PinnedPool, tokenIn: string, amountIn: bigint, tokenOut: string): Promise<bigint>;
  registerStorage(token: string, who: 'agent' | 'owner', purpose: 'setup' | 'exit'): Promise<OpResult>;
  wrap(amount: bigint): Promise<OpResult>;
  unwrap(amount: bigint, purpose: 'strategy' | 'exit'): Promise<OpResult>;
  /** `floor` is the absolute strategy minimum of a trade swap (T-3); Grid and LP never pass it. */
  swap(o: { pin: PinnedPool; tokenIn: string; tokenOut: string; amountIn: bigint; slippageBps: number; unwrapNear: boolean; floor?: bigint }): Promise<OpResult>;
  transferNearToOwner(amount: bigint): Promise<OpResult>;
  transferTokenToOwner(token: string, amount: bigint): Promise<OpResult>;
  placeDcl?(sell: DclToken, amount: bigint, point: number): Promise<OpResult>;
  closeDcl?(id: string, kind: 'dcl_claim' | 'dcl_cancel', purpose: 'strategy' | 'exit'): Promise<OpResult>;
  withdrawDcl?(token: DclToken): Promise<OpResult>;
  depositDcl?(token: DclToken, amount: bigint): Promise<OpResult>;
  addLp?(left: number, right: number, x: bigint, y: bigint): Promise<OpResult>;
  removeLp?(lptId: string, amount: bigint, minX: string, minY: string, purpose: 'strategy' | 'exit', reason?: 'rotation' | 'compound'): Promise<OpResult>;
}
/** The live switch and strategy flags gate a reconcile re-send as they gate a first send (fix 4 audit H-1). */
interface ReconcileDeps { store: Store; rpc: NearRpc; outlayer: OutLayerClient; kek: Buffer; now?: () => number; wait?: (ms: number) => Promise<unknown>;
  gridV1?: boolean; gridV2?: boolean; lpV1?: boolean; tradeV1?: boolean; live?: boolean; }
interface OpsDeps extends ReconcileDeps { jobId: string; now: () => number; }
type Plan = { kind: OpKind; purpose: Purpose; intent: Intent; call?: CallRequest; tokenSpend?: { token: string; amount: bigint }; projectedNative: bigint; projectedUsdc?: bigint; already?: boolean; floor?: bigint };

export class WalletLanes {
  readonly #lanes = new Map<string, Promise<void>>();
  run<T>(walletId: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.#lanes.get(walletId) ?? Promise.resolve()).then(fn);
    const tail = next.then(() => {}, () => {});
    this.#lanes.set(walletId, tail);
    void tail.then(() => { if (this.#lanes.get(walletId) === tail) this.#lanes.delete(walletId); });
    return next;
  }
}
const lanes = new WalletLanes();
const emptyResult = (kind: OpKind): OpResult => ({ opId: '', kind, verdict: 'success', txHash: null, used: null, nativeIn: null, burnt: null, message: null });
const result = (row: OpRow, verdict: OpVerdict, extra: Partial<OpResult> = {}): OpResult => ({ ...emptyResult(row.kind as OpKind), opId: row.id, verdict, txHash: row.txHash, ...extra });
const refused = (p: string[]) => { if (p.length) throw new CoreError('limit_reached', p[0]); };
const jobAllowed = (j: Job) => ({ agent: boundWallet(j).agentAccount, owner: j.owner, tokens: jobTokens(j), dclKinds: jobDclKinds(j) });
const asIntent = (call: CallRequest): Intent => ({ receiver: call.receiverId, method: call.methodName, args: call.args, deposit: call.deposit.toString() });

function jobAlert(store: Store, j: Job, kind: string, severity: 'halt' | 'critical', message: string, now: number) {
  if (store.insertAlert({ jobId: j.id, kind, severity, detail: { message: redactText(message) }, createdAt: now })) {
    console.error(`${severity} ${kind} job=${j.id}: ${redactText(message)}`);
  }
}

function halt(store: Store, job: Job, kind: string, message: string, now: number, severity: 'halt' | 'critical' = 'halt') {
  const j = store.getJob(job.id) ?? job;
  jobAlert(store, j, kind, severity, message, now);
  if (j.state !== 'halted' || j.reason !== message) setJob(store, j, 'halted', now, { reason: redactText(message) });
}

/** RPC budget (2026-11-12): a submission still ambiguous an hour after it was sent is rechecked every 2 minutes instead of every 15 s. The wallet stays blocked either way.
 *  The retire route also uses AMBIGUOUS_SLOW_AFTER_MS as its one-hour wait before an unresolved row may be closed (Retire spec 2.2 step 3). */
export const AMBIGUOUS_SLOW_AFTER_MS = 3_600_000, AMBIGUOUS_SLOW_MS = 120_000;
export function reconcileEvery(op: Pick<OpRow, 'state' | 'submittedAt'>, now: number): number {
  return op.state === 'ambiguous' && op.submittedAt !== null && now - op.submittedAt >= AMBIGUOUS_SLOW_AFTER_MS ? AMBIGUOUS_SLOW_MS : 15_000;
}

export function watchdogFresh(store: Store, now: number): boolean {
  const h = store.readHeartbeat('watchdog');
  return h !== null && Number.isSafeInteger(h) && h <= now && now - h <= 60_000;
}

export async function workerPolicy(d: { store: Store; rpc: NearRpc; now: () => number }, job: Job, exit = false): Promise<'ok' | 'frozen' | 'invalid'> {
  const wallet = boundWallet(job), pubkey = `ed25519:${wallet.agentAccount}`;
  if (job.walletPubkey !== pubkey || !job.armedHash) throw new CoreError('policy_invalid', 'The armed wallet identity is incomplete.');
  const { entry } = await readChainPolicy(d.rpc, pubkey);
  const p = chainGateProblems(entry, job.owner, false, exit ? null : job.armedHash);
  const n = d.now();
  if (p.includes('policy_missing')) { halt(d.store, job, 'policy_missing', 'The wallet has no policy. Use the saved management link.', n, 'critical'); return 'invalid'; }
  if (p.includes('owner_mismatch')) { halt(d.store, job, 'owner_mismatch', 'The finalized wallet policy has a different owner.', n, 'critical'); return 'invalid'; }
  if (p.includes('policy_changed')) { halt(d.store, job, 'policy_changed', 'The finalized wallet policy changed.', n); return 'invalid'; }
  if (p.includes('frozen')) {
    if (job.state === 'stopping') {
      if (job.reason !== 'Unfreeze to withdraw.') setJob(d.store, job, 'stopping', n, { reason: 'Unfreeze to withdraw.' });
    } else if (job.state !== 'frozen') setJob(d.store, job, 'frozen', n, { reason: 'The wallet is frozen.' });
    return 'frozen';
  }
  return 'ok';
}

function tokenSpend(row: OpRow, token: string): bigint {
  if (row.state === 'finished' && !['success', 'swapped', 'unclear', 'busy'].includes(row.verdict ?? '')) return 0n;
  const i = JSON.parse(row.request) as Intent;
  if (row.kind === 'unwrap' && token === WNEAR) return parseAmount(i.args?.amount, 'unwrap amount');
  if ((row.kind === 'transfer_token_owner' || row.kind === 'swap' || row.kind === 'dcl_place' || row.kind === 'dcl_deposit') && i.receiver === token) return parseAmount(i.args?.amount, 'token amount');
  return 0n;
}

function confirmedCaps(job: Job): Caps {
  if (!job.caps || !job.rules || rulesMismatches(buildRules({ owner: job.owner, depositYocto: job.depositYocto, maxDeposit: jobMaxDeposit(job), usesDcl: job.gridV1 || job.lpV1, tokens: jobTokens(job), caps: job.caps }), job.rules).length) {
    throw new CoreError('policy_invalid', 'The armed wallet limits are invalid.');
  }
  return job.caps;
}

export async function exitBudget(rpc: NearRpc, j: Job, before: Snapshot, projectedNative = 0n, venue?: DclState, plan?: { wrap?: bigint; usdc?: bigint; place?: { sell: DclToken; raw: bigint; point: number }; lpOpen?: { left: number; right: number; x: bigint; y: bigint } },
  lp?: { known: readonly string[]; positions: readonly LpPosition[] }): Promise<{ reserve: number; native: bigint }> {
  const caps = confirmedCaps(j), tokens = jobTokens(j);
  let wnear = before.tokens[WNEAR], usdc = before.tokens[USDC];
  if ((j.gridV1 && (!venue || dclBlocked(venue))) || (j.lpV1 && (!venue || !lp || lpBlocked(venue, lp.known)))) throw new CoreError('conflict', 'DCL state is unresolved. Exit budget cannot be verified.');
  if (venue) {
    const total: Record<DclToken, bigint> = { [USDC]: usdc + (venue.assets[USDC] ?? 0n), [WNEAR]: wnear + (venue.assets[WNEAR] ?? 0n) };
    // Both bounds are upper bounds: converting inside the range happens at points between its ends.
    if (j.lpV1) for (const p of venue.liquidities) {
      const paid = lp!.positions.find(x => x.id === p.id);
      if (!paid) throw new CoreError('conflict', 'A DCL position has no recorded amounts. Exit budget cannot be verified.');
      total[USDC] += BigInt(paid.paidX) + limitProceeds(WNEAR, BigInt(paid.paidY), p.left) + p.feeX;
      total[WNEAR] += BigInt(paid.paidY) + limitProceeds(USDC, BigInt(paid.paidX), p.right) + p.feeY;
    }
    else for (const o of dclOpen(venue)) {
      if (!dclToken(o.sell)) throw new CoreError('policy_invalid', 'An order is outside the pinned Grid pool.');
      // The account can need either a full refund or a payout at its limit. Keep both per-asset bounds.
      total[o.sell] += o.original;
      const buy = otherToken(o.sell), bound = limitProceeds(o.sell, o.original, o.point);
      total[buy] += o.unclaimed > bound ? o.unclaimed : bound;
    }
    if (plan?.place) total[otherToken(plan.place.sell)] += limitProceeds(plan.place.sell, plan.place.raw, plan.place.point);
    if (j.lpV2 && plan?.lpOpen) {
      const p = plan.lpOpen;
      // The offered principal is already internal. Replacing it with position bounds adds only its possible conversion.
      total[USDC] += limitProceeds(WNEAR, p.y, p.left);
      total[WNEAR] += limitProceeds(USDC, p.x, p.right);
    }
    // Wallet holdings already include the intended order input, so the refund adds no principal.
    wnear = total[WNEAR] + (plan?.wrap ?? 0n);
    usdc = total[USDC] + (plan?.usdc ?? 0n);
  }
  const missing = (await Promise.all(tokens.map(t => registered(rpc, t, j.owner, before)))).filter(x => !x).length;
  const spendable = before.spendable - (plan?.wrap ?? 0n);
  const spendableAboveReserve = spendable > MONEY.sweepReserve ? spendable - MONEY.sweepReserve : 0n;
  return { reserve: exitReserve({ sweepYocto: spendableAboveReserve + wnear + projectedNative, nativePerTx: caps.nativePerTx, wnear,
    wnearPerTx: caps.tokenPerTx[WNEAR], tokens: tokens.map(t => ({ balance: t === USDC ? usdc : before.tokens[t], perTx: caps.tokenPerTx[t] })) }) + (venue ? 6 : 0),
  native: exitNative({ spendableAboveReserve, wnear, missingOwnerRegistrations: missing }) + projectedNative };
}

function durableReply(store: Store, row: OpRow, reply: SubmitResult) {
  if (reply.kind === 'accepted' || reply.kind === 'reverted') {
    const noTx = reply.kind === 'accepted' && reply.alreadyRegistered && !reply.txHash && !row.txHash && (row.kind === 'storage' || row.kind === 'storage_owner');
    const patch = { requestId: reply.requestId ?? row.requestId, txHash: reply.txHash ?? row.txHash, http: row.http ?? (reply.kind === 'accepted' ? 200 : 422), ...(noTx ? { code: 'already_registered' } : {}) };
    store.updateOp(row.id, patch); Object.assign(row, patch);
  } else if (reply.kind === 'busy') {
    const patch = { code: 'wallet_busy', http: 409, requestId: reply.inFlightRequestId };
    store.updateOp(row.id, patch); Object.assign(row, patch);
  }
}

async function poll(d: ReconcileDeps, row: OpRow, key: SecretString, limit: number, waitFirst: boolean) {
  const id = row.requestId;
  if (!id) return;
  for (let n = 0; n < limit; n++) {
    if (waitFirst || n) await (d.wait ?? sleep)(4_000);
    let answer: SubmitResult;
    try { answer = await d.outlayer.request(key, id); } catch { return; }
    if (answer.kind === 'accepted' || answer.kind === 'reverted') {
      if ((answer.requestId && answer.requestId !== id) || (row.txHash && answer.txHash && row.txHash !== answer.txHash)) return;
      durableReply(d.store, row, answer);
      if (answer.kind === 'reverted' || answer.terminal) return;
    } else if (answer.kind === 'quota' || answer.kind === 'denied' || answer.kind === 'rejected') return;
  }
}

function quarantine(d: ReconcileDeps, row: OpRow, job: Job, message = 'Submission is unresolved. The wallet is blocked pending finalized proof.'): OpResult {
  const n = (d.now ?? Date.now)();
  d.store.updateOp(row.id, { state: 'ambiguous', verdict: 'unknown', message });
  halt(d.store, job, 'op_ambiguous', message, n);
  return result(row, 'unknown', { message });
}

/**
 * Fix 4 (ruling 2026-11-12). OutLayer writes the idempotency key on its request row before any funds move, and its
 * documented recovery after a lost reply is a re-send of the same request under the same key. A new key stays forbidden.
 */
const RESEND_WAITS = [5_000, 15_000, 30_000];
export const RESEND_EVERY_MS = 120_000, RESEND_MAX_EVERY_MS = 900_000, RESEND_MAX_AGE_MS = 86_400_000;
/** Audit L-3: after the three F4-1 re-sends, reconcile waits 2, 4, 8, then 15 minutes after each answer. */
export function resendEvery(resends: number): number { return Math.min(RESEND_EVERY_MS * 2 ** Math.max(0, Math.min(resends, 16) - 3), RESEND_MAX_EVERY_MS); }
/** The time until which a 429 blocks the wallet (ruling 2026-11-06), as `settle` stores it. */
const quotaUntil = (a: { retryAfterSeconds: number | null; limitReached?: boolean }, now: number) => now + Math.min(a.retryAfterSeconds ?? (a.limitReached ? 3_600 : 60), 86_400) * 1000;
const BUILDER_GAS: Readonly<Record<string, bigint>> = { swap: GAS.swap, wrap: GAS.simpleCall, unwrap: GAS.simpleCall, transfer_token_owner: GAS.simpleCall, ...DCL_GAS };
const digits = (x: unknown) => typeof x === 'string' && /^[0-9]{1,40}$/.test(x) ? BigInt(x) : null;
const seenOf = (a: SubmitResult) => ({ kind: a.kind, reason: a.kind === 'ambiguous' ? a.reason : null,
  http: a.kind === 'ambiguous' ? a.http ?? null : a.kind === 'rejected' ? a.http : ({ accepted: 200, reverted: 422, busy: 409, quota: 429, denied: 403 } as const)[a.kind] });

/** F4-3: the journaled request rebuilt for its original endpoint, or null when it cannot be rebuilt exactly. */
export function resendOf(outlayer: OutLayerClient, row: OpRow, job: Job, key: SecretString): (() => Promise<SubmitResult>) | null {
  let intent: Intent;
  try { intent = JSON.parse(row.request) as Intent; } catch { return null; }
  const deposit = digits(intent?.deposit);
  if (!intent || typeof intent.receiver !== 'string' || deposit === null) return null;
  const receiver = intent.receiver, method = intent.method;
  if (row.kind === 'transfer_near_owner') return receiver === job.owner && method === null ? () => outlayer.transfer(key, job.owner, deposit, row.idemKey) : null;
  if (row.kind === 'storage' || row.kind === 'storage_owner') {
    return method === 'storage_deposit' ? () => outlayer.storageDeposit(key, receiver, row.kind === 'storage_owner' ? job.owner : null, row.idemKey) : null;
  }
  const gas = intent.gas === undefined ? (Object.hasOwn(BUILDER_GAS, row.kind) ? BUILDER_GAS[row.kind] : null) : digits(intent.gas), args = record(intent.args);
  if (!gas || typeof method !== 'string' || !args) return null;
  return () => outlayer.call(key, { receiverId: receiver, methodName: method, args, gas, deposit }, row.idemKey);
}

/**
 * F4-1 and F4-2: one re-send after each wait. Only `accepted` (the duplicate answer included) or `reverted` that names a request
 * or a transaction is applied to the row (audit L-2). A 429 stores its wait and ends the attempts (L-4); `wallet_frozen` ends them
 * and, for a row that is not exit, every later re-send (M-3).
 */
async function recover(d: ReconcileDeps, row: OpRow, resend: () => Promise<SubmitResult>, waits: readonly number[]): Promise<SubmitResult | null> {
  const now = d.now ?? Date.now;
  for (const ms of waits) {
    if (ms > 0) await (d.wait ?? sleep)(ms);
    d.store.noteResend(row.id, now());
    let answer: SubmitResult;
    try { answer = await resend(); } catch { answer = { kind: 'ambiguous', reason: 'network' }; }
    d.store.noteNoReply(row.id, seenOf(answer), now());
    if ((answer.kind === 'accepted' && (answer.requestId || answer.txHash || answer.alreadyRegistered)) || (answer.kind === 'reverted' && (answer.requestId || answer.txHash))) {
      durableReply(d.store, row, answer); return answer;
    }
    if (answer.kind === 'quota') { d.store.setMeta(`quota:${row.walletId}`, String(quotaUntil(answer, now()))); return null; }
    if (answer.kind === 'denied' && answer.code === 'wallet_frozen') { if (row.purpose !== 'exit') d.store.stopResend(row.id, now()); return null; }
  }
  return null;
}

/** H-1: the live switch and, for a row that is not exit, the strategy flags a first send needs. */
function resendEnabled(d: ReconcileDeps, row: OpRow, job: Job): boolean {
  return d.live === true && (row.purpose === 'exit' ||
    ((!job.gridV1 || d.gridV1 === true) && (!job.gridV2 || d.gridV2 === true) && (!job.lpV1 || d.lpV1 === true) && (!job.trade || d.tradeV1 === true)));
}

/**
 * F4-2: a reconcile re-send needs the live worker (H-1), a row that never got a usable reply, inside 24 h of its submission, the
 * paced interval after the last answer (M-1, L-3), no 429 wait (L-4), no freeze seen for a row that is not exit (M-3), a fresh
 * watchdog with no read wait (M-2) and no blocking alert other than `op_ambiguous`.
 */
function resendDue(d: ReconcileDeps, row: OpRow, job: Job): boolean {
  const now = (d.now ?? Date.now)(), note = d.store.noReply(row.id), last = note ? note.answeredAt ?? note.at : row.submittedAt;
  const quota = Number(d.store.meta(`quota:${row.walletId}`) ?? 0), exit = row.purpose === 'exit';
  return resendEnabled(d, row, job) && row.http === null && row.code === null && !row.requestId && !row.txHash && typeof row.submittedAt === 'number' &&
    row.submittedAt <= now && now - row.submittedAt < RESEND_MAX_AGE_MS && typeof last === 'number' && now - last >= resendEvery(note?.resends ?? 0) &&
    !(Number.isFinite(quota) && quota > now) && (exit || (!note?.stopped && !d.store.frozenSince(job.id, row.submittedAt))) &&
    watchdogFresh(d.store, now) && !d.store.watchWaiting(job.id) &&
    d.store.openAlerts(job.id).every(a => a.severity === 'info' || (a.kind === 'op_ambiguous' && a.severity === 'halt'));
}

/** Phase 1 fix 3 (ruling 2026-11-11): the release message of an unanswered setup registration. */
export const REGISTRATION_RELEASED = 'Released for exit: the registration is still absent 10 minutes after a submission that got no answer. If it arrives later it costs at most its deposit and gas.';
const RELEASE_AFTER_MS = 600_000;

/**
 * Phase 1 fix 3: an unanswered setup token registration (no hash, no request id) is released for exit only, after
 * 10 minutes, when the finalized chain shows the registration still absent and no tracked asset fell. Nothing is
 * re-sent; the job stays halted. A late arrival costs at most the deposit and gas (accepted residual risk).
 */
async function releaseRegistration(d: ReconcileDeps, row: OpRow, job: Job): Promise<OpResult | null> {
  const now = (d.now ?? Date.now)();
  // Audit M-1: only a job the quarantine already halted. Audit L-3: only a submission that got no answer at all.
  if (job.state !== 'halted' || row.state !== 'ambiguous' || row.txHash !== null || row.requestId !== null || row.http !== null || row.code !== null ||
    row.purpose !== 'setup' || (row.kind !== 'storage' && row.kind !== 'storage_owner')) return null;
  // Fix 4 audit L-1: the 10 quiet minutes count from the latest send, so a pass that just re-sent never releases.
  const sent = Math.max(typeof row.submittedAt === 'number' ? row.submittedAt : 0, d.store.noReply(row.id)?.at ?? 0);
  if (typeof row.submittedAt !== 'number' || !Number.isSafeInteger(row.submittedAt) || row.submittedAt > now || now - sent < RELEASE_AFTER_MS || !row.before) return null;
  const allow = jobAllowed(job);
  let intent: Intent, before: Holdings;
  try { intent = JSON.parse(row.request) as Intent; before = parseHoldings(row.before); } catch { return null; }
  const args = record(intent?.args), account = row.kind === 'storage' ? allow.agent : allow.owner;
  // The job's tokens: USDC for Grid and LP, and the pinned USDC, RHEA or ZEC for a trade job (jobTokens).
  if (intent.method !== 'storage_deposit' || ![WNEAR, ...allow.tokens].includes(intent.receiver) || args?.registration_only !== true || args.account_id !== account ||
    intent.deposit !== MONEY.storageDeposit.toString()) return null;
  const tracked = [WNEAR, ...allow.tokens];
  if (tracked.some(t => !Object.hasOwn(before.tokens, t))) return null;
  try {
    const after = await readHoldings(d.rpc, allow.agent, tracked);
    if (after.block <= before.block || await registered(d.rpc, intent.receiver, account, after) || Object.keys(unexplained(holdingsDelta(before, after), [])).length) return null;
    d.store.updateOp(row.id, { state: 'finished', verdict: 'unclear', message: REGISTRATION_RELEASED, after: json(after), finishedAt: now });
    return result(row, 'unclear', { message: REGISTRATION_RELEASED });
  } catch { return null; }
}

async function finishFromChain(d: ReconcileDeps, row: OpRow, job: Job): Promise<OpResult | null> {
  const { store, rpc } = d;
  if (!row.before || (!row.txHash && row.code !== 'already_registered')) return null;
  try {
    const allow = jobAllowed(job);
    const intent = JSON.parse(row.request) as Intent;
    const before = parseHoldings(row.before);
    if (!row.txHash) {
      // No transaction was sent, so the journaled pair must be registered and no tracked asset may have fallen.
      const after = await readHoldings(rpc, allow.agent, [WNEAR, ...allow.tokens]);
      if (!await registered(rpc, intent.receiver, String(intent.args?.account_id), after) || Object.keys(unexplained(holdingsDelta(before, after), [])).length) return null;
      store.updateOp(row.id, { state: 'finished', verdict: 'success', message: null, nativeSpend: 0n, after: json(after), finishedAt: (d.now ?? Date.now)() });
      return result(row, 'success');
    }
    const tx = parseTxStatus(await rpc.txStatus(row.txHash, allow.agent));
    if (tx.hash !== row.txHash || !matchesIntent(tx, intent, allow)) return null;
    const interval = await receiptInterval(rpc, tx);
    if (!interval || interval.first <= before.block) return null;
    const after = await readHoldings(rpc, allow.agent, [WNEAR, ...allow.tokens]);
    if (interval.last > after.block) return null;
    const dclBefore = readDclBefore(row.before);
    const proof = provenEffects(tx, row.kind as OpKind, intent, allow, dclBefore);
    const discovered = row.kind === 'dcl_place' ? intentOrderIds(tx, intent, allow) : [];
    const discoveredPositions = row.kind === 'dcl_add' ? intentPositionIds(tx, intent, allow) : [];
    let dclChecked = true, survivingClaim = false;
    if (row.kind.startsWith('dcl_') && proof?.dcl) {
      try {
        const { orderId, completed } = proof.dcl;
        const dcl = await readDcl(rpc, allow.agent, after, job.lpV1 ? [] : [...new Set([...gridKnownOrders(store, job.id), ...discovered, ...(orderId ? [orderId] : [])])]);
        if (row.kind === 'dcl_place' && orderId) {
          const signed = record(intent.args), r = record(JSON.parse(String(signed?.msg))), order = record(r?.LimitOrderWithSwap);
          const actual = dcl.orders[orderId];
          dclChecked = !!actual && actual.sell === intent.receiver && actual.buy === order?.buy_token && actual.point === order?.point && actual.original === proof.used &&
            actual.deposit === proof.used && actual.instant === 0n && actual.cancelled === 0n && actual.created === proof.dcl.created;
        } else if (row.kind === 'dcl_withdraw') dclChecked = (dcl.assets[String(intent.args?.token_id)] ?? 0n) === 0n;
        else if (row.kind === 'dcl_deposit') dclChecked = (dcl.assets[intent.receiver] ?? 0n) === (dclBefore?.asset ?? 0n) + (proof.used ?? 0n);
        else if (row.kind === 'dcl_add') {
          const args = record(intent.args), position = dcl.liquidities.find(p => p.id === proof.dcl?.lptId);
          dclChecked = !!position && position.owner === allow.agent && position.pool === args?.pool_id && position.left === args?.left_point && position.right === args?.right_point &&
            position.amount === proof.dcl.liquidity && position.mft === '' && (dcl.assets[USDC] ?? 0n) === (dclBefore?.assets?.[USDC] ?? 0n) - parseAmount(args?.amount_x, 'offered x') &&
            (dcl.assets[WNEAR] ?? 0n) === (dclBefore?.assets?.[WNEAR] ?? 0n) - parseAmount(args?.amount_y, 'offered y');
        } else if (row.kind === 'dcl_remove') {
          dclChecked = !dcl.liquidities.some(p => p.id === proof.dcl?.lptId) && (dcl.assets[USDC] ?? 0n) === (dclBefore?.assets?.[USDC] ?? 0n) && (dcl.assets[WNEAR] ?? 0n) === (dclBefore?.assets?.[WNEAR] ?? 0n);
        }
        else if (orderId && dclBefore?.order) {
          const closed = completedOrder(dcl, orderId);
          const previous = dclBefore.order;
          survivingClaim = row.kind === 'dcl_claim' && !!dcl.orders[orderId] && !closed && (proof.dcl.claimed ?? 0n) > 0n;
          dclChecked = completed === true && !!closed && sameOrder(closed, previous) && closed.cancelled === previous.cancelled + (proof.dcl.cancelled ?? 0n) &&
            closed.created === previous.created && closed.bought === proof.dcl.bought && closed.bought === previous.bought - previous.unclaimed + (proof.dcl.claimed ?? 0n) &&
            (row.purpose === 'exit' || (proof.dcl.claimed ?? 0n) > 0n);
        } else dclChecked = proof.verdict === 'refunded' && discovered.length === 0;
      } catch (e) { if (e instanceof RpcUnavailable) throw e; dclChecked = false; }
    }
    const storageChecked = row.kind === 'storage' || row.kind === 'storage_owner'
      ? proof?.verdict !== 'success' || await registered(rpc, intent.receiver, String(intent.args?.account_id), after) : true;
    const balanceOk = proof !== null && !Object.keys(unexplained(holdingsDelta(before, after), [proof.effects])).length;
    const verdict = proof && storageChecked && balanceOk && dclChecked ? row.code === 'wallet_busy' ? 'busy' : proof.verdict : 'unclear';
    const message = verdict === 'unclear' ? survivingClaim ? 'The DCL claim paid out but the original order is still open. Stop and withdraw to recover the funds.'
      : 'Finalized transaction evidence and wallet holdings do not agree.' : verdict === 'busy' ? 'The existing wallet request was reconciled.' : null;
    const n = (d.now ?? Date.now)();
    store.updateOp(row.id, { state: 'finished', verdict, message, used: proof?.used ?? null, nativeIn: proof?.nativeIn ?? null,
      gasBurnt: proof?.burnt ?? null, nativeSpend: row.nativeSpend + (proof?.burnt ?? 0n),
      after: json({ ...after, ...(job.gridV1 || job.lpV1 || job.trade ? { effects: proof?.effects, dclProof: proof?.dcl || discovered.length || discoveredPositions.length ? { ...proof?.dcl, discovered, ...(row.kind === 'dcl_add' ? { discoveredPositions } : {}) } : undefined } : {}) }), finishedAt: n, finishedBlock: interval.last });
    if (verdict === 'unclear') halt(store, job, 'op_unclear', message!, n);
    return result(row, verdict, { message, used: proof?.used ?? null, nativeIn: proof?.nativeIn ?? null, burnt: proof?.burnt ?? null });
  } catch { return null; }
}

/** Retries failed reads within a bound. The row stays submitted and OutLayer is never called here. */
async function proveFromChain(d: ReconcileDeps, row: OpRow, job: Job): Promise<OpResult | null> {
  const now = d.now ?? Date.now, first = now(), inTime = () => now() - first < 40_000;
  for (let tries = 1; ; tries++) {
    const proven = await finishFromChain(d, row, job);
    if (proven || tries >= 6 || (!row.txHash && row.code !== 'already_registered') || !inTime()) return proven;
    await (d.wait ?? sleep)(5_000);
    if (!inTime()) return null;
  }
}

async function settle(d: ReconcileDeps, row: OpRow, job: Job, key: SecretString, answer: SubmitResult, resend: (() => Promise<SubmitResult>) | null = null): Promise<OpResult> {
  const { store } = d, now = d.now ?? Date.now;
  durableReply(store, row, answer);
  // Fix 4 F4-1: a lost reply is recovered under the same key before the row is quarantined.
  if (answer.kind === 'ambiguous') {
    store.noteNoReply(row.id, seenOf(answer), row.submittedAt ?? now());
    if (resend && !row.requestId && !row.txHash) answer = await recover(d, row, resend, RESEND_WAITS) ?? answer;
  }
  function terminal(verdict: OpVerdict, http: number, code: string | null, message: string | null): OpResult {
    store.updateOp(row.id, { state: 'finished', verdict, code, http, message, nativeSpend: 0n, finishedAt: now() });
    return result(row, verdict, { message });
  }
  if (answer.kind === 'denied') {
    const message = redactText(answer.message);
    if (answer.code === 'wallet_frozen') {
      const current = store.getJob(job.id) ?? job;
      if (current.state === 'stopping') setJob(store, current, 'stopping', now(), { reason: 'Unfreeze to withdraw.' });
      else setJob(store, current, 'frozen', now(), { reason: 'The wallet is frozen.' });
      return terminal('frozen', 403, answer.code, message);
    }
    if (store.recentOps(row.walletId, now()).some(o => o.id !== row.id && o.code === 'policy_denied')) halt(store, job, 'op_denied', 'OutLayer denied a second operation that passed local limits.', now());
    return terminal('denied', 403, answer.code, message);
  }
  if (answer.kind === 'quota') {
    store.setMeta(`quota:${row.walletId}`, String(quotaUntil(answer, now())));
    return terminal('quota', 429, null, 'OutLayer quota is temporarily blocked.');
  }
  if (answer.kind === 'rejected') {
    halt(store, job, 'op_rejected', 'OutLayer rejected the operation. Check the job and wallet credentials.', now());
    return terminal('denied', answer.http, answer.code, 'OutLayer rejected the operation.');
  }
  if (answer.kind === 'reverted' && !row.txHash) await poll(d, row, key, 1, false);
  if (answer.kind === 'accepted' && !answer.terminal && row.requestId) await poll(d, row, key, 15, true);
  if (answer.kind === 'busy' && row.requestId) await poll(d, row, key, 15, true);
  return await proveFromChain(d, row, job) ?? quarantine(d, row, job);
}

export async function reconcileWallet(d: ReconcileDeps, walletId: string): Promise<'clean' | 'halted'> {
  return lanes.run(walletId, async () => {
    const { store } = d;
    const row = store.inFlightOp(walletId);
    if (!row) return 'clean';
    const job = store.jobByWallet(walletId);
    if (!store.ownsWorkerLock() || !job || row.jobId !== job.id) return 'halted';
    try {
      const key = readWalletSecret(store, d.kek, job, 'api_key');
      // Fix 4 F4-2: a row that never got a usable reply is re-sent under its own key; a conclusive answer is proven like a fresh one.
      // Audit M-2: the finalized policy is read right before a re-send, as before a first send; a freeze ends a row's re-sends (M-3).
      let answered = false;
      if (resendDue(d, row, job)) {
        const policy = await workerPolicy({ store, rpc: d.rpc, now: d.now ?? Date.now }, job, row.purpose === 'exit');
        if (policy === 'frozen' && row.purpose !== 'exit') store.stopResend(row.id, (d.now ?? Date.now)());
        const resend = policy === 'ok' ? resendOf(d.outlayer, row, job, key) : null;
        if (resend) answered = await recover(d, row, resend, [0]) !== null;
      }
      if (!row.txHash && row.requestId) await poll(d, row, key, 15, false);
      const verdict = await (row.state === 'submitted' || answered ? proveFromChain : finishFromChain)(d, row, job) ?? await releaseRegistration(d, row, job);
      if (verdict) {
        if (verdict.verdict === 'unclear' && verdict.message !== REGISTRATION_RELEASED) return 'halted';
        const current = store.getJob(job.id), now = (d.now ?? Date.now)();
        // F4-5: a proven lost reply releases the halt to the owner's signed Resume when nothing else blocks the job.
        if (row.state === 'ambiguous' && current?.state === 'halted' && !store.releaseReconciledHalt(current, row.id, now)) {
          setJob(store, current, 'halted', now, { reason: 'Submission reconciled. Use Stop and withdraw to return funds to the owner.' });
        }
        return 'clean';
      }
    } catch { /* The possible submission must stay reserved. */ }
    quarantine(d, row, job);
    return 'halted';
  });
}

export function createLiveOps(d: OpsDeps): GuardedOps {
  const { store, rpc, outlayer, now } = d;
  function getJob(): Job {
    const j = store.getJob(d.jobId);
    if (!j) throw new CoreError('not_found', 'Job not found.');
    return j;
  }
  const holdings = (j: Job) => readHoldings(rpc, boundWallet(j).agentAccount, [WNEAR, ...jobTokens(j)]);
  function run(purpose: Purpose, make: (j: Job, s: Snapshot) => Promise<Plan> | Plan): Promise<OpResult> {
    const id = boundWallet(getJob()).walletId;
    return lanes.run(id, async () => {
      const j = getJob(), b = boundWallet(j);
      if (!store.ownsWorkerLock() || b.walletId !== id || store.inFlightOp(id)) throw new CoreError('conflict', 'The wallet is blocked pending reconciliation.');
      if (j.linkConfirmedAt === null || (purpose === 'exit' ? j.state !== 'stopping' : purpose === 'strategy' ? j.state !== 'running' : !['funded', 'resuming'].includes(j.state))) {
        throw new CoreError('conflict', 'The job does not allow this operation.');
      }
      if (j.gridV1 && (d.live !== true || (purpose !== 'exit' && d.gridV1 !== true))) throw new CoreError('live_disabled', 'Grid operations are disabled. Stop and withdraw remains available with the live worker.');
      if (j.lpV1 && (d.live !== true || (purpose !== 'exit' && d.lpV1 !== true))) throw new CoreError('live_disabled', 'LP operations are disabled. Stop and withdraw remains available with the live worker.');
      if (j.gridV2 && purpose !== 'exit' && d.gridV2 !== true) throw new CoreError('live_disabled', 'Grid operations are disabled. Stop and withdraw remains available with the live worker.');
      if (j.trade && (d.live !== true || (purpose !== 'exit' && d.tradeV1 !== true))) throw new CoreError('live_disabled', 'Trade is disabled. An owner can still freeze or stop and withdraw.');
      if (purpose !== 'exit' && (store.watchWaiting(j.id) || !watchdogFresh(store, now()) || store.openAlerts(j.id).some(a => a.severity !== 'info'))) throw new CoreError('conflict', 'The watchdog has halted this job or is unavailable.');
      const caps = confirmedCaps(j);
      const key = readWalletSecret(store, d.kek, j, 'api_key');
      const before = await holdings(j), plan = await make(j, before), { intent, kind } = plan;
      const amount = parseAmount(intent.deposit, 'native spend');
      const act: SignedAction = { receiver: intent.receiver, method: intent.method, args: intent.args, deposit: amount, kind: intent.method ? 'FunctionCall' : 'Transfer', gas: plan.call?.gas };
      const dcl = dclAction(act);
      if (kind.startsWith('dcl_') && (!jobDclKinds(j).includes(kind as DclKind) || dcl?.kind !== kind)) throw new CoreError('forbidden', 'The DCL operation is not part of this job.');
      if (recipientProblems(act, jobAllowed(j)).length) throw new CoreError('forbidden', 'The operation does not use a pinned destination.');
      if ((amount === 0n && (!dcl || kind === 'dcl_place')) || amount >= caps.nativePerTx) throw new CoreError('limit_reached', 'The native per-transaction cap would be reached.');
      let venue: DclState | undefined, dclBefore: DclBefore | undefined;
      if (j.gridV1) {
        venue = await readDcl(rpc, b.agentAccount, before, gridKnownOrders(store, j.id));
        if (dclBlocked(venue)) throw new CoreError('conflict', 'DCL holds an unresolved order, another pool, lost-found, or a position. Use the saved management link for recovery.');
        if (purpose !== 'exit') {
          requireDclRegistration(venue, j.owner);
          const state = store.grid(j.id)?.state ?? null, step = jobGridStep(store, j.id, state);
          if (step === 'invalid') throw new CoreError('conflict', GRID_SETTINGS_INVALID);
          if (!gridOrderGate(state, venue, step)) throw new CoreError('conflict', 'The DCL account has an unknown or unresolved order.');
          if (purpose === 'strategy') intent.step = gridIntent(state, step, kind, kind === 'wrap' ? amount : (plan.tokenSpend?.amount ?? 0n), dcl ?? {}).id;
        } else if (!dcl && (dclOpen(venue).length || Object.values(venue.assets).some(n => n > 0n))) {
          throw new CoreError('conflict', 'Drain DCL orders and balances before sweeping the wallet.');
        }
        if (dcl?.kind === 'dcl_place') {
          const open = dclOpen(venue), storage = venue.storage!;
          if (purpose !== 'strategy' || open.length >= (store.grid(j.id)?.state?.lanes.length ?? 0) || storage.orders + storage.positions >= storage.slots || open.some(o => o.point === dcl.point) ||
            !restingSide(dcl.sell!, dcl.point!, venue.point)) throw new CoreError('conflict', 'Waiting for an available DCL slot and an uncrossed resting price.');
        } else if (dcl?.kind === 'dcl_claim' || dcl?.kind === 'dcl_cancel') {
          const order = dclOpen(venue).find(o => o.id === dcl.id);
          if (!order || (dcl.kind === 'dcl_claim' ? order.remain !== 0n || order.unclaimed <= 0n : purpose !== 'exit' || order.remain <= 0n)) {
            throw new CoreError('conflict', 'The DCL order is not ready for this close action.');
          }
          dclBefore = { order };
        } else if (dcl?.kind === 'dcl_withdraw') {
          const asset = venue.assets[dcl.token!] ?? 0n;
          if (purpose !== 'exit' || asset <= 0n || dclOpen(venue).length) throw new CoreError('conflict', 'DCL internal withdrawal requires positive funds and no open orders.');
          dclBefore = { asset };
        }
        if (plan.call) intent.gas = plan.call.gas.toString();
      } else if (j.lpV1) {
        venue = await readDcl(rpc, b.agentAccount, before, []);
        const known = lpKnownPositions(store, j.id);
        if (lpBlocked(venue, known)) throw new CoreError('conflict', 'DCL holds an unknown position, order, lost-found, or a farmed position. Use the saved management link for recovery.');
        const state = store.lp(j.id)?.state ?? null;
        if (purpose !== 'exit') {
          if (j.lpV2 && store.lpSettings(j.id) === 'invalid') throw new CoreError('conflict', 'LP settings are unreadable. Stop and withdraw.');
          requireDclRegistration(venue, j.owner);
          if (!lpGate(state, venue, known)) throw new CoreError('conflict', 'The DCL account holds something the LP job did not record.');
          if (purpose === 'strategy') intent.step = lpIntent(state, kind, kind === 'wrap' ? amount : dcl?.kind === 'dcl_remove' ? dcl.amount! : (plan.tokenSpend?.amount ?? 0n), { ...dcl, reason: intent.lpReason }).id;
        } else if (!dcl && (venue.liquidities.length || Object.values(venue.assets).some(n => n > 0n))) {
          throw new CoreError('conflict', 'Drain DCL positions and balances before sweeping the wallet.');
        }
        const internal = { [USDC]: venue.assets[USDC] ?? 0n, [WNEAR]: venue.assets[WNEAR] ?? 0n };
        if (dcl?.kind === 'dcl_deposit') {
          if (purpose !== 'strategy' || venue.liquidities.length) throw new CoreError('conflict', 'A DCL deposit needs a strategy step and no open position.');
          dclBefore = { asset: venue.assets[dcl.token!] ?? 0n };
        } else if (dcl?.kind === 'dcl_add') {
          // A drifted point replans: the next evaluation re-centres the range on the new point.
          const rangeOk = j.lpV2 ? state?.nextRange?.verdict === 'rebuild' ? state.range?.left === dcl.left && state.range?.right === dcl.right
            : lpRangeOk({ left: dcl.left!, right: dcl.right! }, venue.point) : Math.abs(venue.point - (dcl.left! + dcl.right!) / 2) <= LP_CENTRE_TOLERANCE;
          if (purpose !== 'strategy' || venue.liquidities.length || internal[USDC] !== dcl.x || internal[WNEAR] !== dcl.y || !rangeOk) {
            throw new CoreError('conflict', 'The LP range is not centred on the current point or the DCL balances differ.');
          }
          dclBefore = { assets: internal };
        } else if (dcl?.kind === 'dcl_remove') {
          const position = venue.liquidities.find(p => p.id === dcl.lptId);
          const settings = j.lpV2 ? store.lpSettings(j.id) : null;
          const inRange = !!position && venue.point >= position.left && venue.point < position.right;
          const eligible = intent.lpReason === 'compound' ? j.lpV2 && settings && settings !== 'invalid' && settings.compound.on && inRange : !inRange;
          if (!position || !known.includes(position.id) || position.amount !== dcl.amount || (purpose === 'strategy' && !eligible)) {
            throw new CoreError('conflict', 'The DCL position is not ready for this removal.');
          }
          dclBefore = { position, assets: internal };
        } else if (dcl?.kind === 'dcl_withdraw') {
          const asset = venue.assets[dcl.token!] ?? 0n;
          if (purpose !== 'exit' || asset <= 0n || venue.liquidities.length) throw new CoreError('conflict', 'DCL internal withdrawal requires positive funds and no open position.');
          dclBefore = { asset };
        }
        if (plan.call) intent.gas = plan.call.gas.toString();
      } else if (j.trade && purpose !== 'exit') {
        // A watchdog read wait is refused above and in insertOp (store.watchWaiting), as for Grid and LP.
        const t = store.trade(j.id);
        if (!t || t.settings === 'invalid') throw new CoreError('conflict', TRADE_SETTINGS_INVALID);
        if (purpose === 'strategy') intent.step = tradeIntent(t.state, kind, kind === 'wrap' ? amount : (plan.tokenSpend?.amount ?? 0n), { tokenIn: plan.tokenSpend?.token, floor: plan.floor }).id;
      }
      if (plan.tokenSpend) {
        const { token, amount: raw } = plan.tokenSpend;
        const spent = store.recentOps(id, now()).reduce((n, o) => n + tokenSpend(o, token), 0n);
        if (raw <= 0n || raw >= caps.tokenPerTx[token] || raw + spent > caps.tokenDaily[token] || raw > before.tokens[token]) {
          throw new CoreError('limit_reached', 'The token limit or available balance would be exceeded.');
        }
      }
      if (plan.already) return emptyResult(kind);
      const budget = store.budgetView(id, now());
      const reserve = purpose === 'exit' ? { reserve: 0, native: 0n } : await exitBudget(rpc, j, before, plan.projectedNative, venue, venue ? {
        wrap: kind === 'wrap' ? amount : undefined, usdc: plan.projectedUsdc,
        place: dcl?.kind === 'dcl_place' ? { sell: dcl.sell!, raw: dcl.raw!, point: dcl.point! } : undefined,
        lpOpen: j.lpV2 && dcl?.kind === 'dcl_add' ? { left: dcl.left!, right: dcl.right!, x: dcl.x!, y: dcl.y! } : undefined,
      } : undefined, j.lpV1 ? { known: lpKnownPositions(store, j.id), positions: [store.lp(j.id)?.state?.position].flatMap(p => p ? [p] : []) } : undefined);
      refused(opsProblems(budget, purpose, reserve.reserve, now()));
      const nativeProblems = nativeSpendProblems(budget, amount, caps.nativeDaily, purpose, reserve.native);
      refused(j.lpV2 && nativeProblems.length && purpose !== 'exit' ? ['Waiting for the native exit reservation']
        : j.trade && nativeProblems.length && purpose === 'strategy' ? ['Waiting for the native daily window.'] : nativeProblems);
      const price = kind === 'transfer_near_owner' ? 0n : await rpc.holdGasPrice();
      const hold = holdFor(kind, amount, price);
      if ((j.gridV1 || j.lpV1) && purpose === 'strategy') {
        const exitHold = holdFor('dcl_withdraw', 0n, price).needFree + 3n * N / 100n;
        if (before.spendable < hold.needFree + (exitHold > 3n * N / 10n ? exitHold : 3n * N / 10n)) {
          throw new CoreError('limit_reached', 'The agent needs more free NEAR to submit this ' + (j.gridV1 ? 'Grid' : 'LP') + ' operation and preserve the DCL exit reserve.');
        }
      } else refused(freeNearProblems(before.account, hold));
      // Trade V1 T-7: a wrap leaves 0.321 NEAR free, so the 300 Tgas swap after it always finds its 0.320 NEAR hold.
      if (j.trade && kind === 'wrap' && before.spendable < amount + TRADE_WRAP_ROOM) throw new CoreError('limit_reached', 'The agent needs the wrap amount plus 0.321 NEAR free to wrap and then swap.');
      if (await workerPolicy(d, j, purpose === 'exit') !== 'ok') throw new CoreError('policy_invalid', 'The finalized wallet policy does not allow this operation.');
      // Halt review H-1: a trade step is sent only while the receipt route answers, so its proof can be read.
      if (j.trade && purpose !== 'exit') { if (!rpc.blockHeight) throw new RpcUnavailable(); await rpc.blockHeight(before.blockId); }
      const n = now();
      // Trade V1 T-9: no strategy step is journaled at or after the planned end.
      if (j.trade && purpose === 'strategy' && n >= tradeDeadline(j)) throw new CoreError('conflict', 'The trade job reached its planned end.');
      const row: OpRow = { id: randomUUID(), jobId: j.id, walletId: id, kind, purpose, idemKey: randomUUID(), request: json(intent), state: 'submitted', counted: 1,
        nativeSpend: amount, http: null, code: null, requestId: null, txHash: null, verdict: null, used: null, nativeIn: null, gasBurnt: null,
        before: json(dclBefore ? { ...before, dcl: dclBefore } : before), after: null, message: null, createdAt: n, submittedAt: n, finishedAt: null, finishedBlock: null };
      if (!store.insertOp(row, { version: j.version, state: j.state, now: n })) throw new CoreError('conflict', 'The wallet state changed before submission.');
      let answer: SubmitResult;
      try {
        if (plan.call) answer = await outlayer.call(key, plan.call, row.idemKey);
        else if (kind === 'transfer_near_owner') answer = await outlayer.transfer(key, j.owner, amount, row.idemKey);
        else answer = await outlayer.storageDeposit(key, intent.receiver, kind === 'storage_owner' ? j.owner : null, row.idemKey);
      } catch { answer = { kind: 'ambiguous', reason: 'network' }; }
      return settle(d, row, j, key, answer, resendOf(outlayer, row, j, key));
    });
  }
  return {
    holdings: () => holdings(getJob()),
    async quote(pin, tokenIn, amountIn, tokenOut) { await requireVenue(rpc, pin); return quote(rpc, pin, tokenIn, amountIn, tokenOut); },
    registerStorage: (token, who, purpose) => run(purpose, async (j, s) => {
      const b = boundWallet(j), account = who === 'owner' ? j.owner : b.agentAccount;
      if ((token !== WNEAR && !jobTokens(j).includes(token)) || (who === 'owner' && token === WNEAR) || (purpose === 'exit' && who !== 'owner')) throw new CoreError('forbidden', 'That registration is not part of this job.');
      return { kind: who === 'owner' ? 'storage_owner' : 'storage', purpose, projectedNative: 0n, already: await registered(rpc, token, account, s),
        intent: { receiver: token, method: 'storage_deposit', deposit: MONEY.storageDeposit.toString(), args: { account_id: account, registration_only: true } } };
    }),
    wrap: amount => run('strategy', async (j, s) => {
      if (!await registered(rpc, WNEAR, boundWallet(j).agentAccount, s)) throw new CoreError('policy_invalid', 'The agent must be registered on wNEAR.');
      const call = wrapCall(amount);
      return { kind: 'wrap', purpose: 'strategy', intent: asIntent(call), call, projectedNative: 0n };
    }),
    unwrap: (amount, purpose) => run(purpose, () => {
      const call = unwrapCall(amount);
      return { kind: 'unwrap', purpose, intent: asIntent(call), call, projectedNative: 0n, tokenSpend: { token: WNEAR, amount } };
    }),
    swap: o => run('strategy', async (j, s) => {
      const pin = pinnedPool(o.pin);
      if (j.gridV1 && (pin.poolId !== CLASSIC_POOLS[0].poolId || o.tokenIn !== WNEAR || o.tokenOut !== USDC || o.amountIn !== GRID_BOOTSTRAP || o.slippageBps !== 50 || o.unwrapNear)) {
        throw new CoreError('forbidden', 'Only the pinned Grid bootstrap swap is allowed.');
      }
      // The amount is held to the pending step by lpIntent.
      if (j.lpV1 && (pin.poolId !== CLASSIC_POOLS[0].poolId || o.slippageBps !== 50 || !(o.tokenIn === WNEAR ? o.tokenOut === USDC && !o.unwrapNear : o.tokenIn === USDC && o.tokenOut === WNEAR && o.unwrapNear))) {
        throw new CoreError('forbidden', 'Only the pinned LP swaps are allowed.');
      }
      // Trade V1 T-2: on the job's own pool, wNEAR to the token without unwrap or the token to native NEAR, always with a strategy floor.
      const pair = j.trade ? tradePair(j.pair) : null;
      if (pair && (pin.poolId !== pair.pin.poolId || o.slippageBps !== 50 || o.floor === undefined ||
        !(o.tokenIn === WNEAR ? o.tokenOut === pair.token && !o.unwrapNear : o.tokenIn === pair.token && o.tokenOut === WNEAR && o.unwrapNear))) {
        throw new CoreError('forbidden', 'Only the pinned trade swaps are allowed.');
      }
      await requireVenue(rpc, pin);
      if (pair) {
        const pool = await readTradePool(rpc, pair);
        if (pool.wnear < pair.minWnearReserve || pool.token <= 0n) throw new CoreError('conflict', 'The pool holds less than 10,000 wNEAR or none of the token.');
      }
      const fresh = await quote(rpc, pin, o.tokenIn, o.amountIn, o.tokenOut);
      if (fresh <= 0n || !await registered(rpc, o.tokenOut, boundWallet(j).agentAccount, s)) throw new CoreError('policy_invalid', 'The swap quote or output registration is unavailable.');
      // T-3: a fresh quote below the strategy floor is refused before any journal row; otherwise the floor raises the signed minimum.
      if (o.floor !== undefined && fresh < o.floor) throw new CoreError('conflict', "The fresh quote is below the agent's limit.");
      const slipped = minOut(fresh, o.slippageBps), minimum = o.floor !== undefined && o.floor > slipped ? o.floor : slipped, call = swapCall({ ...o, pin, minOut: minimum });
      return { kind: 'swap', purpose: 'strategy', call, intent: { ...asIntent(call), swap: { tokenOut: o.tokenOut, amountIn: o.amountIn.toString(), minOut: minimum.toString(), unwrapNear: o.unwrapNear } },
        projectedNative: o.tokenOut === WNEAR ? fresh : 0n, projectedUsdc: j.gridV1 ? fresh : j.lpV1 ? (o.tokenOut === USDC ? fresh : 0n) : undefined, tokenSpend: { token: o.tokenIn, amount: o.amountIn },
        ...(o.floor !== undefined ? { floor: o.floor } : {}) };
    }),
    transferNearToOwner: amount => run('exit', j => ({ kind: 'transfer_near_owner', purpose: 'exit', projectedNative: 0n,
      intent: { receiver: j.owner, method: null, args: null, deposit: amount.toString() } })),
    transferTokenToOwner: (token, amount) => run('exit', async (j, s) => {
      if (!jobTokens(j).includes(token) || !await registered(rpc, token, j.owner, s)) throw new CoreError('policy_invalid', 'The owner must be registered for this job token.');
      const call = ftTransferCall(token, j.owner, amount);
      return { kind: 'transfer_token_owner', purpose: 'exit', intent: asIntent(call), call, projectedNative: 0n, tokenSpend: { token, amount } };
    }),
    placeDcl: (sell, amount, point) => run('strategy', () => {
      const call = dclPlace(sell, amount, point);
      return { kind: 'dcl_place', purpose: 'strategy', call, intent: asIntent(call), tokenSpend: { token: sell, amount }, projectedNative: 0n };
    }),
    closeDcl: (id, kind, purpose) => run(purpose, () => {
      const call = dclClose(id, kind);
      return { kind, purpose, call, intent: asIntent(call), projectedNative: 0n };
    }),
    depositDcl: (token, amount) => run('strategy', () => {
      const call = dclDeposit(token, amount);
      return { kind: 'dcl_deposit', purpose: 'strategy', call, intent: asIntent(call), tokenSpend: { token, amount }, projectedNative: 0n };
    }),
    addLp: (left, right, x, y) => run('strategy', () => {
      const call = lpAdd(left, right, x, y);
      return { kind: 'dcl_add', purpose: 'strategy', call, intent: asIntent(call), projectedNative: 0n };
    }),
    removeLp: (lptId, amount, minX, minY, purpose, reason) => run(purpose, () => {
      const call = lpRemove(lptId, amount, minX, minY);
      return { kind: 'dcl_remove', purpose, call, intent: { ...asIntent(call), ...(reason ? { lpReason: reason } : {}) }, projectedNative: 0n };
    }),
    withdrawDcl: token => run('exit', () => {
      const call = dclWithdraw(token);
      return { kind: 'dcl_withdraw', purpose: 'exit', call, intent: asIntent(call), projectedNative: 0n };
    }),
  };
}

export async function exitToOwner(ops: GuardedOps, job: { tokens: readonly string[]; caps: Caps }): Promise<'done' | 'blocked' | 'halted'> {
  function next(v: OpResult): 'blocked' | 'halted' | null {
    return v.verdict === 'success' ? null : v.verdict === 'unclear' || v.verdict === 'unknown' ? 'halted' : 'blocked';
  }
  const chunk = (balance: bigint, cap: bigint) => { if (cap <= 1n) throw new CoreError('policy_invalid', 'Invalid exit cap.'); return balance < cap ? balance : cap - 1n; };
  try {
    let s = await ops.holdings();
    while ((s.tokens[WNEAR] ?? 0n) > 0n) {
      const r = next(await ops.unwrap(chunk(s.tokens[WNEAR], job.caps.tokenPerTx[WNEAR]), 'exit'));
      if (r) return r;
      const after = await ops.holdings(); if (after.tokens[WNEAR] >= s.tokens[WNEAR]) return 'blocked'; s = after;
    }
    for (const token of job.tokens) if ((s.tokens[token] ?? 0n) > 0n) {
      const r = next(await ops.registerStorage(token, 'owner', 'exit')); if (r) return r;
      s = await ops.holdings();
      while ((s.tokens[token] ?? 0n) > 0n) {
        const transfer = next(await ops.transferTokenToOwner(token, chunk(s.tokens[token], job.caps.tokenPerTx[token])));
        if (transfer) return transfer;
        const after = await ops.holdings(); if (after.tokens[token] >= s.tokens[token]) return 'blocked'; s = after;
      }
    }
    while ((s.spendable ?? 0n) > MONEY.sweepReserve) {
      const transfer = next(await ops.transferNearToOwner(chunk(s.spendable! - MONEY.sweepReserve, job.caps.nativePerTx)));
      if (transfer) return transfer;
      const after = await ops.holdings(); if ((after.spendable ?? 0n) >= s.spendable!) return 'blocked'; s = after;
    }
    return s.spendable === undefined || Object.values(s.tokens).some(a => a > 0n) ? 'blocked' : 'done';
  } catch (e) {
    if (e instanceof CoreError) return 'blocked';
    throw e;
  }
}
