import { parseAmount, isAccountId, YOCTO_PER_NEAR } from './amounts.js';
import { verifySigned } from './auth.js';
import { nativeSpendProblems, opsProblems } from './budget.js';
import { CoreError } from './errors.js';
import { drainGrid, GRID_EVAL_MS, GRID_SETTINGS_INVALID, GRID_V1_STEP, gridKnownOrders, gridOrderGate, gridSettingsFromRequest, jobGridStep, tickGrid } from './grid.js';
import { drainLp, LP_EVAL_MS, LP_MIN_DEPOSIT, lpGate, lpKnownPositions, lpSettingsFromPrices, tickLp } from './lp.js';
import type { ReportActivity } from './activity.js';
import type { LpAi } from './lp-ai.js';
import { readHoldings, registered } from './holdings.js';
import type { NearRpc } from './near-rpc.js';
import { createLiveOps, exitBudget, exitToOwner, watchdogFresh, workerPolicy, type GuardedOps } from './ops.js';
import type { OutLayerClient } from './outlayer.js';
import { CLASSIC_POOLS, MONEY, OUTLAYER_CONTRACT, PAIRS, USDC, WNEAR } from './pins.js';
import { apiGateProblems, buildRules, defaultCaps, policyHash, readChainPolicy, rulesMismatches, storePayload, walletPubkeyFrom } from './policy.js';
import { quote, requireVenue } from './rhea-classic.js';
import { dclBlocked, dclOpen, dclRegistered, lpBlocked, readDcl, requireDclRegistration } from './rhea-dcl.js';
import { open, seal, sealForRelay, walletAad, type SecretString } from './secrets.js';
import { RPC_UNAVAILABLE_REASON, WALLET_ALERT_HALT, type Job, type Store } from './store.js';
import { tickTrade, TRADE_SETTINGS_INVALID, tradeDue } from './trade.js';
import { tradePair, TRADE_PAIRS } from './trade-pairs.js';
import { TRADE_RESERVE, tradePlan, tradeSettingsFromRequest } from './trade-settings.js';

export type JobKind = 'grid' | 'lp' | 'schedule' | 'dca';
export type JobMode = 'live' | 'dry-run';
export type JobState = 'draft' | 'registered' | 'policy_prepared' | 'armed' | 'link_confirmed' | 'funded' | 'ready' | 'running'
  | 'frozen' | 'paused' | 'resuming' | 'halted' | 'stopping' | 'stopped' | 'failed' | 'cancelled' | 'retired';
type Actor = 'web' | 'worker';
const w = (to: JobState) => ({ to, by: 'worker' as const });
const b = (to: JobState) => ({ to, by: 'web' as const });
export const TRANSITIONS: Readonly<Record<JobState, readonly { to: JobState; by: Actor }[]>> = {
  draft: [w('registered'), w('failed'), b('cancelled')],
  registered: [w('policy_prepared'), w('failed'), w('halted'), b('cancelled')],
  policy_prepared: [w('armed'), w('failed'), w('halted'), b('cancelled')],
  armed: [b('link_confirmed'), w('halted'), b('cancelled')],
  link_confirmed: [w('funded'), w('halted'), b('cancelled'), b('stopping')],
  funded: [w('ready'), w('frozen'), w('halted'), b('stopping')],
  ready: [w('running'), w('frozen'), w('halted'), b('stopping')],
  running: [w('frozen'), w('halted'), w('stopping'), b('stopping')],
  frozen: [w('paused'), w('halted'), b('stopping')],
  paused: [w('frozen'), w('halted'), b('resuming'), b('stopping')],
  resuming: [w('ready'), w('frozen'), w('halted'), b('stopping')],
  // Retire spec 2.1: `retired` is entered only by store.retireJob, never through a transition.
  halted: [b('stopping')], stopping: [w('stopped'), w('halted')], stopped: [], failed: [], cancelled: [], retired: [],
};
export function canTransition(from: JobState, to: JobState, by: Actor): boolean { return TRANSITIONS[from].some(t => t.to === to && t.by === by); }

export function draftProblems(i: { session: { accountId: string } | null; kind: unknown; pair: unknown; mode: unknown; depositYocto: unknown;
  liveEnabled: boolean; gridV1?: boolean; gridV2?: boolean; lpV1?: boolean; lp?: unknown; grid?: unknown; point?: number | null; liveJobs: number; ownerPendingLive: number;
  tradeV1?: boolean; trade?: unknown; now?: number }): string[] {
  const p: string[] = [];
  if (!isAccountId(i.session?.accountId)) p.push('Sign in with a NEAR account.');
  // Trade V1 5.2: its own branch, so no Grid or LP rule changes and no trade hire passes a Grid or LP check.
  if (i.kind === 'schedule' || i.kind === 'dca') {
    const settings = tradeSettingsFromRequest(i.kind, i.trade, i.now ?? Date.now());
    if (!i.tradeV1 || i.mode !== 'live' || !TRADE_PAIRS.some(pair => pair.id === i.pair)) p.push('Only live trade jobs on a pinned trade pair can be hired.');
    if (settings === 'invalid') p.push('Choose valid trade settings.');
    else {
      try { if (parseAmount(i.depositYocto, 'deposit') !== tradePlan(settings) + TRADE_RESERVE) p.push('The deposit must be the plan plus 0.4 NEAR.'); }
      catch { p.push('The deposit must be the plan plus 0.4 NEAR.'); }
    }
    if (!i.liveEnabled) p.push('Live hires are disabled.');
    if (i.liveJobs >= MONEY.maxLiveJobs || i.ownerPendingLive > 0) p.push('A hire is already pending or the live job limit was reached.');
    return p;
  }
  if (!(i.kind === 'grid' || (i.kind === 'lp' && i.lpV1)) || i.mode !== 'live' || !PAIRS.some(pair => pair.id === i.pair)) p.push('Only live Grid or LP jobs for USDC/wNEAR can be hired.');
  const v2 = i.kind === 'lp' && i.lp !== undefined;
  if (v2) {
    const settings = lpSettingsFromPrices(i.lp);
    if (settings === 'invalid' || (settings.range.mode === 'explicit' && (i.point == null || i.point < settings.range.left || i.point >= settings.range.right))) p.push('Choose valid LP settings and a range containing the finalized price.');
  }
  if (i.grid !== undefined && (i.kind !== 'grid' || !i.gridV1 || !i.gridV2 || gridSettingsFromRequest(i.grid) === 'invalid')) p.push('Choose valid Grid settings.');
  const depositProblem = i.kind === 'lp' ? `Choose a deposit of 1.2 to ${v2 ? 3 : 2} NEAR.` : i.gridV1 ? 'Choose a deposit of 1 to 2 NEAR.' : 'Choose a deposit of 0.4 to 2 NEAR.';
  try {
    const d = parseAmount(i.depositYocto, 'deposit');
    if (d < (i.kind === 'lp' ? LP_MIN_DEPOSIT : i.gridV1 ? YOCTO_PER_NEAR : MONEY.minDeposit) || d > (v2 ? 3n * YOCTO_PER_NEAR : MONEY.maxDeposit)) p.push(depositProblem);
  } catch { p.push(depositProblem); }
  if (!i.liveEnabled) p.push('Live hires are disabled.');
  if (i.liveJobs >= MONEY.maxLiveJobs || i.ownerPendingLive > 0) p.push('A hire is already pending or the live job limit was reached.');
  return p;
}

/** How often the funding wait reads the chain when the worker has an idle client. */
export const FUND_EVAL_MS = 15_000;
/** `idleRpc` (RPC budget, 2026-11-13) serves only the Grid and LP evaluation ticks and the funding wait; guarded operations, receipts, policy checks and exits use `rpc`. */
export interface WorkerDeps { store: Store; rpc: NearRpc; idleRpc?: NearRpc; outlayer: OutLayerClient; kek: Buffer; live: boolean; gridV1?: boolean; gridV2?: boolean; lpV1?: boolean; tradeV1?: boolean; ai?: LpAi; activity?: ReportActivity; origin: string; provider: unknown; now: () => number; }
export interface JobStrategy { kind: JobKind; tick(ops: GuardedOps, jobId: string): Promise<void>; exit(ops: GuardedOps, jobId: string): Promise<'done' | 'retry'>; }
export const STRATEGIES: Readonly<Partial<Record<JobKind, JobStrategy>>> = {};
/** Trade V1 11.1: a trade job holds its one pinned token; this alone gives the watchdog, holdings, recipient checks, exit and view the right token. */
export const jobTokens = (job: Job): readonly string[] => job.trade ? [tradePair(job.pair).token] : [USDC];
export const jobMaxDeposit = (job: Job): bigint => job.lpV2 ? 3n * YOCTO_PER_NEAR : MONEY.maxDeposit;

export function boundWallet(job: Job) {
  if (!job.walletId || !job.agentAccount || !/^[0-9a-f]{64}$/.test(job.agentAccount) || !isAccountId(job.owner)) throw new CoreError('policy_invalid', 'Wallet identity is invalid.');
  return { id: job.id, owner: job.owner, walletId: job.walletId, agentAccount: job.agentAccount };
}

export function readWalletSecret(store: Store, kek: Buffer, job: Job, purpose: 'api_key' | 'link'): SecretString {
  const b = boundWallet(job);
  const row = store.getSecrets(b.walletId);
  const ct = purpose === 'api_key' ? row?.apiKeyCt : row?.linkCt;
  if (!ct) throw new CoreError('policy_invalid', 'The wallet secret is unavailable.');
  return open(kek, ct, walletAad(b, purpose));
}

export function setJob(store: Store, j: Job, to: JobState, now: number, patch: Parameters<Store['casJob']>[4] = {}): boolean {
  if (j.state === 'link_confirmed' && to === 'stopping' && !j.gridV1 && !j.lpV1 && !j.trade) return false;
  if ((store.role !== 'web' && store.role !== 'worker') || (!canTransition(j.state, to, store.role) && !(store.role === 'worker' && j.state === to))) return false;
  return store.casJob(j.id, j.state, j.version, to, patch, now);
}

function reason(d: WorkerDeps, job: Job, message: string) {
  if (job.reason !== message) setJob(d.store, job, job.state, d.now(), { reason: message });
}

async function register(d: WorkerDeps, job: Job) {
  const { store, outlayer, kek, now } = d;
  if (job.walletId) return;
  const marker = `register_attempts:${job.id}`;
  const attempts = Number(store.meta(marker) ?? 0);
  if (attempts >= 2) { setJob(store, job, 'failed', now(), { reason: 'Wallet registration result is unknown. Do not fund this job.' }); return; }
  store.setMeta(marker, String(attempts + 1));
  const { result, error } = await outlayer.register();
  if (!result) {
    if (error?.message === 'Wallet registration result is unknown.' && attempts === 0) return;
    setJob(store, job, 'failed', now(), { reason: 'Wallet registration failed. Do not fund this job.' });
    return;
  }
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(result.walletId) || !/^[0-9a-f]{64}$/.test(result.nearAccountId)) {
    setJob(store, job, 'failed', now(), { reason: 'The returned wallet identity is invalid. Do not fund this job.' });
    return;
  }
  const binding = { id: job.id, owner: job.owner, walletId: result.walletId, agentAccount: result.nearAccountId };
  const attached = store.attachWallet(job, result.walletId, result.nearAccountId, { apiKeyCt: seal(kek, result.apiKey, walletAad(binding, 'api_key')),
    linkCt: result.managementLink ? seal(kek, result.managementLink, walletAad(binding, 'link')) : null }, now());
  const current = store.getJob(job.id);
  if (current && (current.state === 'registered' || current.state === 'draft') && (!attached || error || !result.managementLink)) {
    setJob(store, current, 'failed', now(), { reason: 'Wallet registration did not complete. Do not fund this job.' });
  }
}

async function prepare(d: WorkerDeps, job: Job) {
  const { store, rpc, outlayer, now } = d;
  const b = boundWallet(job);
  const key = readWalletSecret(store, d.kek, job, 'api_key');
  // Trade V1 11.2: a trade job quotes its own pool, and its token cap uses 10 times the quote (AD-8).
  const pair = job.trade ? tradePair(job.pair) : null, pin = pair ? pair.pin : CLASSIC_POOLS[0], token = pair ? pair.token : USDC;
  await requireVenue(rpc, pin);
  const price = await quote(rpc, pin, WNEAR, YOCTO_PER_NEAR, token);
  const caps = defaultCaps(job.depositYocto, { [token]: pair ? 10n * price : price });
  const rules = buildRules({ owner: job.owner, depositYocto: job.depositYocto, maxDeposit: jobMaxDeposit(job), tokens: jobTokens(job), usesDcl: job.gridV1 || job.lpV1, caps });
  const budget = store.budgetView(b.walletId, now());
  if (budget.used1h + 2 > 29 || budget.used24h + 2 > 100) { reason(d, job, 'Waiting for policy preparation quota.'); return; }
  if (!store.countPolicyOp(job, 'encrypt_policy', now())) return;
  const { encryptedBase64 } = await outlayer.encryptPolicy(key, b.walletId, rules);
  if (!store.countPolicyOp(job, 'sign_policy', now())) return;
  const signed = await outlayer.signPolicy(key, encryptedBase64, job.owner);
  const walletPubkey = walletPubkeyFrom(signed.publicKeyHex, b.agentAccount);
  if ((await readChainPolicy(rpc, walletPubkey)).entry) throw new CoreError('policy_invalid', 'This wallet already has a policy. Do not fund this job.');
  const estimate = await rpc.view(OUTLAYER_CONTRACT, 'estimate_wallet_policy_cost', { wallet_pubkey: walletPubkey, encrypted_data: encryptedBase64, storage_refund_to: null });
  const payload = storePayload(walletPubkey, encryptedBase64, signed, job.owner, parseAmount(estimate.value, 'policy storage estimate'));
  setJob(store, job, 'policy_prepared', now(), { rules, caps, payload, walletPubkey, reason: null });
}

async function arm(d: WorkerDeps, job: Job) {
  const { store, outlayer, now } = d;
  if (!job.payload || !job.rules || !job.walletPubkey || !job.caps || rulesMismatches(buildRules({ owner: job.owner, depositYocto: job.depositYocto, maxDeposit: jobMaxDeposit(job),
    usesDcl: job.gridV1 || job.lpV1, tokens: jobTokens(job), caps: job.caps }), job.rules).length) throw new CoreError('policy_invalid', 'The prepared wallet policy is incomplete.');
  const b = boundWallet(job);
  const pubkey = job.walletPubkey;
  if (pubkey !== `ed25519:${b.agentAccount}` || job.payload.args.wallet_pubkey !== pubkey || job.payload.caller !== job.owner) throw new CoreError('policy_invalid', 'The prepared policy identity is invalid.');
  const marker = `policy_check:${job.id}`;
  const last = store.meta(marker);
  if (last !== null && now() - Number(last) < 15_000) return;
  store.setMeta(marker, String(now()));
  const expected = job.payload.args.encrypted_data;
  async function check() {
    const { entry } = await readChainPolicy(d.rpc, pubkey);
    if (!entry) { reason(d, job, 'Waiting for the finalized wallet policy.'); return null; }
    if (entry.owner !== job.owner || entry.encrypted !== expected) {
      const ownerMismatch = entry.owner !== job.owner;
      store.insertAlert({ jobId: job.id, severity: ownerMismatch ? 'critical' : 'halt', kind: ownerMismatch ? 'owner_mismatch' : 'policy_changed',
        detail: { message: 'The finalized wallet policy does not match the prepared policy. Do not fund this job.' }, createdAt: now() });
      setJob(store, job, 'halted', now(), { reason: 'The finalized wallet policy does not match the prepared policy. Do not fund this job.' });
      return null;
    }
    if (entry.frozen) { reason(d, job, 'The wallet policy is frozen.'); return null; }
    return entry;
  }
  if (!await check()) return;
  const api = await outlayer.getPolicy(readWalletSecret(store, d.kek, job, 'api_key'));
  const invalidation = `cache_invalidated:${job.id}`;
  if (api.http === 200 && api.policy === 'none' && store.meta(invalidation) === null) {
    store.setMeta(invalidation, '1');
    await outlayer.invalidateCache(b.walletId);
    return;
  }
  if (apiGateProblems(api, job.rules, false).length) { reason(d, job, 'Waiting for OutLayer to confirm the prepared rules.'); return; }
  const entry = await check();
  if (entry) setJob(store, job, 'armed', now(), { armedHash: policyHash(entry), reason: null });
}

async function ready(d: WorkerDeps, job: Job) {
  const { store, rpc, now } = d, b = boundWallet(job), tokens = jobTokens(job);
  if (store.watchWaiting(job.id)) return;
  if (!watchdogFresh(store, now())) { reason(d, job, 'Waiting for a fresh watchdog heartbeat.'); return; }
  const snap = await readHoldings(rpc, b.agentAccount, [WNEAR, ...tokens]);
  const venue = job.gridV1 || job.lpV1 ? await readDcl(rpc, b.agentAccount, snap, job.gridV1 ? gridKnownOrders(store, job.id) : []) : undefined;
  const lp = job.lpV1 ? { known: lpKnownPositions(store, job.id), positions: [store.lp(job.id)?.state?.position].flatMap(p => p ? [p] : []) } : undefined;
  if (venue) {
    requireDclRegistration(venue, job.owner);
    if (job.lpV2 && store.lpSettings(job.id) === 'invalid') { reason(d, job, 'LP settings are unreadable. Stop and withdraw.'); return; }
    const gridState = job.gridV1 ? store.grid(job.id)?.state ?? null : null, step = job.gridV1 ? jobGridStep(store, job.id, gridState) : GRID_V1_STEP;
    if (step === 'invalid') { reason(d, job, GRID_SETTINGS_INVALID); return; }
    // Fix 4 F4-7: a step that finished while the job was halted is applied by the first strategy tick, before that tick's own
    // gates; until then the state lags the chain, so resuming readiness only refuses an unknown DCL holding for it.
    const lpState = lp ? store.lp(job.id)?.state ?? null : null, pending = (lp ? lpState : gridState)?.pending;
    const finished = job.state === 'resuming' && !!pending && store.gridStep(job.id, pending.id)?.state === 'finished' && !(lp ? lpBlocked(venue, lp.known) : dclBlocked(venue));
    if (!finished && !(lp ? lpGate(lpState, venue, lp.known, job.state === 'resuming' ? snap : undefined) : gridOrderGate(gridState, venue, step))) {
      reason(d, job, `${lp ? 'LP' : 'Grid'} readiness is waiting for the watchdog or an unresolved DCL holding.`); return;
    }
  }
  const ops = createLiveOps({ ...d, jobId: job.id });
  const registrations = [...[WNEAR, ...tokens].map(token => ({ token, who: 'agent' as const, account: b.agentAccount })),
    ...tokens.map(token => ({ token, who: 'owner' as const, account: job.owner }))];
  for (const r of registrations) if (!await registered(rpc, r.token, r.account, snap)) {
    const o = await ops.registerStorage(r.token, r.who, 'setup');
    if (o.verdict === 'success') reason(d, job, 'Storage registration finalized. Checking the remaining setup.');
    else if (o.message) reason(d, job, o.message);
    return;
  }
  if (snap.spendable < MONEY.readyFloor) { reason(d, job, 'The wallet needs at least 0.320 NEAR free to be ready.'); return; }
  const { reserve, native } = await exitBudget(rpc, job, snap, 0n, venue, undefined, lp);
  const budget = store.budgetView(b.walletId, now());
  if (!job.caps || opsProblems(budget, 'setup', reserve - 1, now()).length || nativeSpendProblems(budget, 0n, job.caps.nativeDaily, 'setup', native).length) {
    reason(d, job, 'Waiting for enough budget to reserve the exit.'); return;
  }
  if (store.watchWaiting(job.id) || !watchdogFresh(store, now()) || store.inFlightOp(b.walletId) || store.openAlerts(job.id).some(a => a.severity !== 'info') || await workerPolicy(d, job) !== 'ok') return;
  setJob(store, job, 'ready', now(), { reason: null });
}

async function afterArm(d: WorkerDeps, job: Job) {
  const { store, rpc, now } = d, b = boundWallet(job);
  if (job.state === 'halted' || job.state === 'armed') return;
  if (job.linkConfirmedAt === null) { reason(d, job, 'The management link must be confirmed.'); return; }
  if (store.inFlightOp(b.walletId)) { reason(d, job, 'Submission is unresolved. Use the saved management link for recovery.'); return; }
  // An idle LP job evaluates once a minute, before any chain read. A pending step is never delayed.
  if (job.lpV1 && job.state === 'running' && !store.lp(job.id)?.state?.pending) {
    if (now() - Number(store.meta(`lp_eval:${job.id}`) ?? 0) < LP_EVAL_MS) return;
    store.setMeta(`lp_eval:${job.id}`, String(now()));
  }
  // An idle Grid job (its last tick found nothing to do) waits out the same minute before any chain read. A pending step is never delayed.
  if (job.gridV1 && job.state === 'running' && !store.grid(job.id)?.state?.pending && now() - Number(store.meta(`grid_eval:${job.id}`) ?? 0) < GRID_EVAL_MS) return;
  // Trade V1 10.1: the same gate before any chain read; a Schedule job with its slot taken and no end does not evaluate at all.
  if (job.trade && job.state === 'running' && !tradeDue(store, job, now())) return;
  if (await workerPolicy(d, job, job.state === 'stopping') !== 'ok') return;
  if (job.state !== 'stopping' && job.state !== 'frozen' && store.watchWaiting(job.id)) return;
  if (job.trade && !d.tradeV1 && ['link_confirmed', 'funded', 'resuming', 'ready', 'running'].includes(job.state)) {
    reason(d, job, job.state === 'link_confirmed' ? 'Trade is disabled. Do not fund this job.' : 'Trade is disabled. An owner can still freeze or stop and withdraw.'); return;
  }
  if (job.trade && ['link_confirmed', 'funded', 'resuming', 'ready', 'running'].includes(job.state) && store.trade(job.id)?.settings === 'invalid') {
    if (job.state === 'running') setJob(store, job, 'halted', now(), { reason: TRADE_SETTINGS_INVALID }); else reason(d, job, TRADE_SETTINGS_INVALID);
    return;
  }
  if (job.gridV1 && !d.gridV1 && ['link_confirmed', 'funded', 'resuming', 'ready', 'running'].includes(job.state)) {
    reason(d, job, 'Grid is disabled. An owner can still freeze or stop and withdraw.'); return;
  }
  if (job.lpV1 && !d.lpV1 && ['link_confirmed', 'funded', 'resuming', 'ready', 'running'].includes(job.state)) {
    reason(d, job, 'LP is disabled. An owner can still freeze or stop and withdraw.'); return;
  }
  if (job.gridV2 && !d.gridV2 && ['link_confirmed', 'funded', 'resuming', 'ready', 'running'].includes(job.state)) {
    reason(d, job, 'Grid V2 is disabled. An owner can still freeze or stop and withdraw.'); return;
  }
  if (job.gridV1 && ['link_confirmed', 'funded', 'resuming', 'ready', 'running'].includes(job.state) && jobGridStep(store, job.id, store.grid(job.id)?.state ?? null) === 'invalid') {
    if (job.state === 'running') setJob(store, job, 'halted', now(), { reason: GRID_SETTINGS_INVALID }); else reason(d, job, GRID_SETTINGS_INVALID);
    return;
  }
  if (job.state === 'link_confirmed') {
    // The funding wait only decides when to move to funded, at most every 15 s on the idle client. ready() then reads holdings, DCL,
    // registrations, the exit budget and the policy on the QuickNode-first client before anything is signed.
    if (d.idleRpc) {
      if (now() - Number(store.meta(`fund_eval:${job.id}`) ?? 0) < FUND_EVAL_MS) return;
      store.setMeta(`fund_eval:${job.id}`, String(now()));
    }
    const idle = d.idleRpc ?? rpc;
    if (job.gridV1 || job.lpV1) {
      const snap = await readHoldings(idle, b.agentAccount, [WNEAR, ...jobTokens(job)]);
      const venue = await readDcl(idle, b.agentAccount, snap);
      if (!dclRegistered(venue, job.owner, true) || !(job.lpV1 ? lpGate(null, venue, []) : gridOrderGate(null, venue, GRID_V1_STEP))) { reason(d, job, 'Wait for finalized owner-paid DCL registration before funding.'); return; }
      if (!watchdogFresh(store, now()) || store.watchWaiting(job.id)) { reason(d, job, `Waiting for a fresh ${job.lpV1 ? 'LP' : 'Grid'} watchdog check.`); return; }
      if (snap.native >= job.depositYocto) setJob(store, job, 'funded', now(), { reason: null });
    } else {
      const account = await idle.viewAccount(b.agentAccount);
      if (account && account.amount >= job.depositYocto) setJob(store, job, 'funded', now(), { reason: null });
    }
  } else if (job.state === 'funded' || job.state === 'resuming') await ready(d, job);
  else if (job.state === 'frozen') setJob(store, job, 'paused', now(), { reason: 'Unfrozen. Sign a resume request to run the readiness checks again.' });
  else if (job.state === 'ready' && (job.gridV1 || job.lpV1 || job.trade || STRATEGIES[job.kind])) {
    // Spec 2c section 3: protection observations from before this transition never confirm.
    if (job.gridV1) store.setMeta(`grid_running_since:${job.id}`, String(now()));
    // Trade V1 9.4 and 10.3: a stop-loss observation or a row-less step from before this transition is discarded by the next tick.
    if (job.trade) store.setMeta(`trade_running_since:${job.id}`, String(now()));
    // Activity: one event per job; a resume re-sends the same key and body, which the service treats as the same event.
    if (setJob(store, job, 'running', now(), { reason: null })) d.activity?.({ eventType: 'agent.hired', actor: job.owner, idempotencyKey: `job:${job.id}:hired`, payload: { agent: job.kind } });
  }
  else if (job.state === 'running') {
    // Guarded operations keep the QuickNode-first client; only the Grid and LP evaluation reads use the idle client.
    const ops = createLiveOps({ ...d, jobId: job.id }), idle = d.idleRpc ? { ...d, rpc: d.idleRpc } : d;
    if (job.gridV1) await tickGrid(idle, job, ops);
    else if (job.lpV1) await tickLp(idle, job, ops);
    else if (job.trade) await tickTrade(d, job, ops);
    else await STRATEGIES[job.kind]?.tick(ops, job.id);
  }
  else if (job.state === 'stopping') {
    const ops = createLiveOps({ ...d, jobId: job.id }), strategy = STRATEGIES[job.kind];
    if (!job.caps || (job.gridV1 ? !await drainGrid(d, job, ops) : job.lpV1 ? !await drainLp(d, job, ops) : strategy && await strategy.exit(ops, job.id) !== 'done')) return;
    const status = await exitToOwner(ops, { caps: job.caps, tokens: jobTokens(job) });
    if (status === 'done') {
      if (job.gridV1 || job.lpV1) {
        const snap = await readHoldings(rpc, b.agentAccount, [WNEAR, ...jobTokens(job)]);
        const venue = await readDcl(rpc, b.agentAccount, snap, job.gridV1 ? gridKnownOrders(store, job.id) : []);
        if ((job.gridV1 ? dclBlocked(venue) || dclOpen(venue).length : lpBlocked(venue, [])) || Object.values(venue.assets).some(n => n > 0n) || Object.values(snap.tokens).some(n => n > 0n) || snap.spendable > MONEY.sweepReserve) return;
      }
      if (setJob(store, job, 'stopped', now(), { reason: null })) d.activity?.({ eventType: 'agent.withdrawn', actor: job.owner, idempotencyKey: `job:${job.id}:withdrawn`, payload: { agent: job.kind } });
    }
    else if (status === 'blocked') reason(d, job, 'Withdrawal is waiting for the wallet, finalized reads or exit budget.');
  }
}

export async function advanceJob(d: WorkerDeps, jobId: string): Promise<JobState> {
  const job = d.store.getJob(jobId);
  if (!job) throw new CoreError('not_found', 'Job not found.');
  if (!d.live || !d.store.ownsWorkerLock()) {
    if (job.state === 'draft') reason(d, job, 'Live worker is disabled.');
    return job.state;
  }
  try {
    if (job.gridV1 && !d.gridV1 && ['draft', 'registered', 'policy_prepared'].includes(job.state)) {
      reason(d, job, 'Grid is disabled. Do not fund this job.'); return job.state;
    }
    if (job.lpV1 && !d.lpV1 && ['draft', 'registered', 'policy_prepared'].includes(job.state)) {
      reason(d, job, 'LP is disabled. Do not fund this job.'); return job.state;
    }
    if (job.gridV2 && !d.gridV2 && ['draft', 'registered', 'policy_prepared'].includes(job.state)) {
      reason(d, job, 'Grid V2 is disabled. Do not fund this job.'); return job.state;
    }
    if (job.trade && !d.tradeV1 && ['draft', 'registered', 'policy_prepared'].includes(job.state)) {
      reason(d, job, 'Trade is disabled. Do not fund this job.'); return job.state;
    }
    if (job.gridV1 && ['draft', 'registered', 'policy_prepared'].includes(job.state) && jobGridStep(d.store, job.id, null) === 'invalid') {
      reason(d, job, GRID_SETTINGS_INVALID); return job.state;
    }
    if (job.walletId && job.state !== 'stopping' && job.state !== 'halted' && d.store.openAlerts(job.id).some(a => a.severity !== 'info')) {
      setJob(d.store, job, 'halted', d.now(), { reason: WALLET_ALERT_HALT });
      return d.store.getJob(jobId)?.state ?? job.state;
    }
    if ((job.state === 'registered' || job.state === 'policy_prepared') && d.store.watchWaiting(job.id)) return job.state;
    if (['registered', 'policy_prepared', 'link_confirmed', 'funded', 'ready', 'running', 'resuming'].includes(job.state) &&
      job.reason === RPC_UNAVAILABLE_REASON && d.store.clearWatchReason(job, d.now())) return job.state;
    if (job.state === 'draft') await register(d, job);
    else if (job.state === 'registered') await prepare(d, job);
    else if (job.state === 'policy_prepared') await arm(d, job);
    else if (job.walletId && !['failed', 'cancelled', 'stopped', 'retired'].includes(job.state)) await afterArm(d, job);
  } catch (e) {
    if (e instanceof CoreError && e.code === 'rpc_unavailable') reason(d, job, (job.gridV1 || job.lpV1) && job.state === 'stopping'
      ? 'Finalized wallet or DCL status is unavailable. Use the saved management link for recovery if this persists.' : e.message);
    else if (job.state === 'registered' || job.state === 'draft' || job.state === 'policy_prepared') {
      setJob(d.store, job, 'failed', d.now(), { reason: 'Wallet preparation stopped. Do not fund this job.' });
    } else if (e instanceof CoreError) reason(d, job, e.message);
    else throw e;
  }
  return d.store.getJob(jobId)?.state ?? job.state;
}

export async function processReveals(d: WorkerDeps): Promise<void> {
  const { store, origin, provider, now, kek } = d;
  store.expireReveals(now());
  for (const r of store.pendingReveals()) {
    const job = store.getJob(r.jobId);
    const c = store.getChallenge(r.nonce);
    if (!job?.walletId || c?.purpose !== 'reveal' || c.jobId !== job.id || r.signed.nonce !== c.nonce || r.signed.accountId !== job.owner ||
      !(await verifySigned(c, r.signed, origin, provider, now())).ok) continue;
    try {
      const link = readWalletSecret(store, kek, job, 'link');
      store.sealReveal(r, sealForRelay(link, r.webPub, r.id), c, now());
    } catch { /* An invalid row never delivers a link. */ }
  }
}
