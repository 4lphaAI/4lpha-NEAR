import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { realpathSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { accessKeyProvider, newChallenge, newSessionToken, RECIPIENT, SESSION_TTL, signedAnswer, tokenHash, verifySigned } from '../core/auth.js';
import { parseAmount, YOCTO_PER_NEAR } from '../core/amounts.js';
import { dbPath, dRpcFirst, localEnv, rpcEnv, rpcLabel, webEnv, type WebEnv } from '../core/config.js';
import { CoreError, fail, ok, record, type ErrorCode } from '../core/errors.js';
import { readDclBefore } from '../core/dcl-evidence.js';
import { GRID_V1_STEP, gridKnownOrders, gridOrderGate, gridSettingsFromRequest, gridValue, jobGridStep, lanePoints, receipt } from '../core/grid.js';
import { draftProblems, jobTokens, setJob } from '../core/hire.js';
import { readHoldings, type Snapshot } from '../core/holdings.js';
import { LP_MIN_DEPOSIT, LP_RESERVE, lpGate, lpKnownPositions, lpRotations, lpSettingsFromPrices } from '../core/lp.js';
import { createNearRpc, DEFAULT_RPC, spendableNear, type NearRpc } from '../core/near-rpc.js';
import { AMBIGUOUS_SLOW_AFTER_MS, watchdogFresh } from '../core/ops.js';
import { GRID_LP_TOKENS, MONEY, PAIRS, USDC, WNEAR } from '../core/pins.js';
import { policyHash, readChainPolicy, type ChainPolicyEntry } from '../core/policy.js';
import { DCL_STORAGE, dclOpen, dclRegistered, dclRegistration, predictRemove, readDcl, readPoolPoint, toNearDown, type DclState } from '../core/rhea-dcl.js';
import { newRelayKey, openRelay } from '../core/secrets.js';
import { DEMO_LIMITS, json, openStore, parseJobName, RESUMING_REASON, RPC_UNAVAILABLE_REASON, type Job, type OpRow, type Store } from '../core/store.js';
import { validMemeSettings } from '../core/meme-paper.js';
import { MEME_OPTIONS, memeAgentView, memePublicView } from '../core/meme-view.js';
import { readTradePool } from '../core/rhea-classic.js';
import { tradeView } from '../core/trade.js';
import { TRADE_PAIRS } from '../core/trade-pairs.js';
import { maxStepBps, TRADE_LIFE_MS, tradeSettingsFromRequest } from '../core/trade-settings.js';
import { demoDclSamples, demoSamples } from '../core/demo-market.js';
import { demoCreate, DEMO_KINDS } from '../core/demo-sim.js';
import { demoPublicView, demoSummary } from '../core/demo-view.js';

const errors: Record<ErrorCode, [number, string]> = {
  bad_request: [400, 'Invalid request.'], bad_amount: [400, 'Invalid amount.'], unauthorized: [401, 'A valid wallet signature or session is required.'],
  forbidden: [403, 'This request is not allowed.'], not_found: [404, 'Not found.'], conflict: [409, 'The job changed or is not ready for this action.'],
  live_disabled: [503, 'Live hires are disabled.'], limit_reached: [409, 'A hire is already pending or the live job limit was reached.'],
  policy_invalid: [409, 'The wallet policy is not valid.'], rpc_unavailable: [503, 'Finalized chain data is unavailable.'],
  outlayer_error: [503, 'OutLayer is unavailable.'], market_data_unconfigured: [503, 'Market data is not configured.'],
  market_data_unavailable: [503, 'Market data is unavailable.'], internal: [500, 'An internal error occurred.'],
};
const SESSION_COOKIE = 'fourlpha_session';
/** Demo mode 7.1: an anonymous owner cookie. Only its SHA-256 is stored; it grants nothing outside /api/demo. */
const DEMO_COOKIE = 'fourlpha_demo';
const assets: Record<string, [string, URL]> = {
  '/legacy': ['text/html; charset=utf-8', new URL('../../../src/web/page/index.html', import.meta.url)],
  '/app.js': ['text/javascript; charset=utf-8', new URL('../../web/app.js', import.meta.url)],
};

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new CoreError('bad_request', 'Expected JSON.');
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const part of req as AsyncIterable<Buffer>) {
    length += part.length;
    if (length > 16_384) throw new CoreError('bad_request', 'Request is too large.');
    chunks.push(part);
  }
  try { const r = record(JSON.parse(Buffer.concat(chunks).toString('utf8'))); if (r) return r; } catch { /* Invalid body. */ }
  throw new CoreError('bad_request', 'Expected JSON.');
}

// The four pools the data plane records (docs/specs/NEAR-MARKET-DATA-PLAN.md). The first is the DCL pool: Grid and LP, and the only one with a liquidity profile.
/** How long the job list may reuse a job's chain reads while nothing about the job changed. */
export const CHAIN_CACHE_MS = 60_000;
/** A stopped, failed, cancelled or retired job drives no decision, so the job list reuses its chain reads, policy included, for ten minutes. */
export const TERMINAL_CACHE_MS = 600_000;
/** Public agent page 3.3: one public answer per job is shared by every visitor for 30 s. */
export const PUBLIC_CACHE_MS = 30_000;
/** Public agent page 3.2: the owner-only view fields and their public values. A new owner-only field of `view` must be added here. */
export const PUBLIC_OVERRIDES = { ownerBalance: null, payload: null, canReveal: false, linkDelivered: false, canFund: false, canStopEarly: false,
  canResumeBlind: false, resumeBlockedReason: null } as const;
const POOL_KEYS = ['rhea-dcl-usdc-wnear', 'rhea-4512', 'rhea-6458', 'rhea-6065'];
const CHART_INTERVALS = ['1m', '5m', '15m', '1h'];
/** A CoreError whose own message is shown to the browser (the others show the fixed text of their code). */
type ShownText = 'Price history is not recorded yet.' | 'Liquidity profile is not recorded yet.' | 'Market data is out of date.'
  | 'Only a halted, paused or frozen job can be retired.' | 'This job has no agent wallet. Cancel it instead.' | 'An operation is still unresolved. Try again later.'
  | 'Could not verify the agent wallet. Try again.' | 'The agent wallet still holds funds. Use Stop and withdraw or the management link first.' | 'The job changed. Reload and try again.';
/** Retire spec 2.2 step 4: below 0.02 NEAR counts as dust, the same line as the account page. */
const RETIRE_DUST = YOCTO_PER_NEAR * 2n / 100n;
class Shown extends CoreError { constructor(code: ErrorCode, message: ShownText) { super(code, message); } }

export function createHandler(d: { store: Store; rpc: NearRpc; env: WebEnv; now: () => number; ai?: boolean; provider?: unknown; wait?: (ms: number) => Promise<unknown>; uiRoot?: string;
  marketData?: { url: string; token: string; fetch?: typeof fetch }; demoStore?: Store }) {
  const { store, rpc, env, now } = d;
  // The store of the demo routes: the one database of a standalone demo web, or the second store of the main app on its own demo database
  // (DEMO-MODE-COMBINED-PLAN section 1). Without either the demo is off; the live store never serves a demo route in the main app.
  const demoStore = env.demo ? store : d.demoStore ?? null;
  const origin = new URL(env.origin);
  const provider = d.provider ?? accessKeyProvider(env.origin, rpc);
  const wait = d.wait ?? sleep;
  let uiRoot: string | null = null;
  try { uiRoot = realpathSync(d.uiRoot ?? fileURLToPath(new URL('../../ui', import.meta.url))); } catch { /* UI not built. */ }
  const memeAi = env.memePaper === true && !!localEnv().NEAR_AI_API_KEY;
  const cookieFlags = `Path=/; HttpOnly; SameSite=Strict${origin.protocol === 'https:' ? '; Secure' : ''}`;

  const blindResumeEnabled = (job: Job) => env.liveHires && (!job.gridV1 || env.gridV1) && (!job.gridV2 || env.gridV2) && (!job.lpV1 || env.lpV1);
  function blindChainReady(job: Job, holdings: Snapshot, policy: ChainPolicyEntry | null, venue: DclState | null): boolean {
    if (!holdings.account || policy?.owner !== job.owner || policy.frozen || policyHash(policy) !== job.armedHash) return false;
    if (!job.gridV1 && !job.lpV1) return true;
    if (!venue || !dclRegistered(venue, job.owner)) return false;
    if (job.gridV1) {
      const state = store.grid(job.id)?.state ?? null, step = jobGridStep(store, job.id, state);
      return step !== 'invalid' && gridOrderGate(state, venue, step);
    }
    const settings = store.lpSettings(job.id);
    return (!job.lpV2 || !!settings && settings !== 'invalid') &&
      lpGate(store.lp(job.id)?.state ?? null, venue, lpKnownPositions(store, job.id), holdings);
  }

  async function chainReads(job: Job, withPolicy = true) {
    const tracked = [WNEAR, ...jobTokens(job)];
    const held = job.agentAccount && job.armedHash ? readHoldings(rpc, job.agentAccount, tracked).catch(() => null) : Promise.resolve(null);
    const policyKey = withPolicy && job.armedHash ? job.walletPubkey : null;
    const [account, holdings, policyRead] = await Promise.all([
      job.agentAccount && !job.armedHash ? rpc.viewAccount(job.agentAccount).catch(() => undefined) : null,
      held,
      policyKey ? (store.blindHalt(job) ? held.then(snap => snap ? readChainPolicy(rpc, policyKey, snap) : null) : readChainPolicy(rpc, policyKey))
        .catch(() => null) : null,
    ]);
    const extras = job.agentAccount && holdings && ['stopping', 'stopped'].includes(job.state) ? await Promise.all(GRID_LP_TOKENS.filter(t => !tracked.includes(t)).map(async token => {
      try {
        const value = await rpc.view(token, 'ft_balance_of', { account_id: job.agentAccount }, holdings.blockId);
        if (value.height !== holdings.block || value.blockId !== holdings.blockId) return null;
        const amount = parseAmount(value.value, 'token balance');
        return amount > 0n ? { token, amount } : null;
      } catch { return null; }
    })) : [];
    const lpPosition = job.lpV1 ? store.lp(job.id)?.state?.position ?? null : null;
    const venue = (job.gridV1 || job.lpV1) && job.agentAccount && holdings ? await readDcl(rpc, job.agentAccount, holdings, job.gridV1 ? gridKnownOrders(store, job.id) : []).catch(() => null) : null;
    // The estimate is one extra read. When it fails the rest of the view still renders.
    const estimate = lpPosition && holdings && venue ? await predictRemove(rpc, lpPosition.id, BigInt(lpPosition.liquidity), holdings).catch(() => null) : null;
    return { account, holdings, policyRead, extras, venue, estimate };
  }
  // RPC budget (2026-11-12): the job list reuses a job's balance and DCL reads for up to a minute while nothing about the job changed.
  // The wallet policy (freeze state) is read fresh on every request. Setup states, a blind halt, the single-job read and every action read everything fresh.
  // Only a complete answer is reused, so a failed read is retried on the next request. A terminal job reuses any answer for TERMINAL_CACHE_MS.
  type ChainReads = Awaited<ReturnType<typeof chainReads>>;
  const chainCache = new Map<string, { at: number; ttl: number; key: string; value: Promise<ChainReads> }>();
  const TERMINAL_STATES = ['stopped', 'failed', 'cancelled', 'retired'];
  const SETUP_STATES = ['draft', 'registered', 'policy_prepared', 'armed', 'ready', 'link_confirmed', 'funded'];
  const complete = (job: Job, r: ChainReads) => job.armedHash ? !!r.holdings && (!(job.gridV1 || job.lpV1) || !!r.venue) && (!(job.lpV1 && store.lp(job.id)?.state?.position) || !!r.estimate)
    : !job.agentAccount || r.account !== undefined;
  function cachedChainReads(job: Job, rows: OpRow[]) {
    const t = now(), key = JSON.stringify([job.version, job.state, job.updatedAt, job.armedHash, rows.map(r => [r.id, r.state, r.finishedBlock]), store.lp(job.id)?.state?.position?.id ?? null]);
    for (const [id, e] of chainCache) if (t - e.at >= e.ttl || t < e.at) chainCache.delete(id);
    const hit = chainCache.get(job.id);
    if (hit && hit.key === key) return hit.value;
    const terminal = TERMINAL_STATES.includes(job.state);
    const entry = { at: t, ttl: terminal ? TERMINAL_CACHE_MS : CHAIN_CACHE_MS, key, value: chainReads(job, terminal) };
    chainCache.set(job.id, entry);
    const drop = () => { if (chainCache.get(job.id) === entry) chainCache.delete(job.id); };
    entry.value.then(r => { if (!terminal && !complete(job, r)) drop(); }, drop);
    return entry.value;
  }

  async function view(job: Job, list?: { owner: Promise<Awaited<ReturnType<NearRpc['viewAccount']>> | undefined> }) {
    const blindHalt = store.blindHalt(job);
    const inFlight = job.walletId ? store.inFlightOp(job.walletId) : null;
    const rows = store.jobOps(job.id);
    const cache = !!list && !SETUP_STATES.includes(job.state) && !blindHalt, livePolicyRead = cache && !TERMINAL_STATES.includes(job.state);
    const [reads, owner, livePolicy] = await Promise.all([
      cache ? cachedChainReads(job, rows) : chainReads(job),
      list ? list.owner : rpc.viewAccount(job.owner).catch(() => undefined),
      livePolicyRead && job.armedHash && job.walletPubkey ? readChainPolicy(rpc, job.walletPubkey).catch(() => null) : null,
    ]);
    const { account, holdings, extras, venue, estimate } = reads, policyRead = livePolicyRead ? livePolicy : reads.policyRead;
    const policy = policyRead?.entry ?? null;
    // Display only: a Grid fill is a successful claim of a completed order (the order is journaled in before.dcl). A row that lacks a field is skipped.
    const fills = job.gridV1 ? rows.flatMap(o => {
      if (o.kind !== 'dcl_claim' || o.verdict !== 'success' || o.finishedAt === null) return [];
      try {
        const order = readDclBefore(o.before)?.order, { dcl } = receipt(o);
        if (!order || dcl?.completed !== true || typeof dcl.claimed !== 'string' || !/^\d+$/.test(dcl.claimed) || !Number.isSafeInteger(order.point) || (order.sell !== WNEAR && order.sell !== USDC)) return [];
        return [{ at: o.finishedAt, side: order.sell === WNEAR ? 'sell' as const : 'buy' as const, point: order.point, sold: order.original.toString(), bought: dcl.claimed, txHash: o.txHash }];
      } catch { return []; }
    }).sort((a, b) => b.at - a.at).slice(0, 50) : [];
    const compounds = rows.filter(o => o.kind === 'dcl_remove' && o.purpose === 'strategy' && o.verdict === 'success' && record(JSON.parse(o.request))?.lpReason === 'compound');
    const operations = rows.map(o => ({ id: o.id, kind: o.kind, verdict: o.verdict, state: o.state, txHash: o.txHash, message: o.message, createdAt: o.createdAt, finishedAt: o.finishedAt }));
    const grid = job.gridV1 ? store.grid(job.id) : null, state = grid?.state, step = grid ? jobGridStep(store, job.id, state ?? null) : GRID_V1_STEP;
    const lp = job.lpV1 ? store.lp(job.id) : null, lpState = lp?.state, lpPosition = lpState?.position ?? null;
    const price = (point: number) => 10 ** 18 / 1.0001 ** point;
    const listed = lpPosition ? venue?.liquidities.find(p => p.id === lpPosition.id) : undefined;
    const positionValue = estimate && venue ? estimate[1] + toNearDown(estimate[0], venue.point) : null;
    const valueLow = job.lpV2 && holdings && venue && (!lpPosition || positionValue !== null) ? holdings.spendable + holdings.tokens[WNEAR] + (venue.assets[WNEAR] ?? 0n) + (estimate?.[1] ?? 0n) + toNearDown(holdings.tokens[USDC] + (venue.assets[USDC] ?? 0n) + (estimate?.[0] ?? 0n), venue.point) : null;
    const valueHigh = valueLow !== null && venue ? valueLow + (listed?.feeY ?? 0n) + toNearDown(listed?.feeX ?? 0n, venue.point) : null;
    const alerts = store.openAlerts(job.id);
    const goodPolicy = policy?.owner === job.owner && !policy.frozen && policyHash(policy) === job.armedHash;
    const linked = job.state === 'link_confirmed' && job.linkConfirmedAt !== null;
    const waiting = store.watchWaiting(job.id);
    const eligible = linked && holdings !== null && goodPolicy && !waiting && watchdogFresh(store, now()) && !alerts.some(a => a.severity !== 'info') && !inFlight;
    const dclEligible = eligible && env.liveHires && venue &&
      (job.lpV1 ? env.lpV1 && lpGate(null, venue, []) : env.gridV1 && (!job.gridV2 || env.gridV2) && step !== 'invalid' && gridOrderGate(null, venue, GRID_V1_STEP)) ? venue : null;
    const recovery = blindHalt && blindResumeEnabled(job) ? store.blindResumeProof(job, now()) : null;
    const canResumeBlind = !!(recovery && holdings && holdings.block >= recovery.block && blindChainReady(job, holdings, policy, venue));
    let resumeBlockedReason: string | null = null;
    if (job.state === 'halted' && !canResumeBlind) {
      if (inFlight || rows.some(o => ['unknown', 'unclear', 'busy'].includes(o.verdict ?? '') || (o.txHash !== null && o.finishedBlock === null))) {
        resumeBlockedReason = 'A pending or uncertain transaction must be reconciled before this job can resume.';
      } else if (!blindHalt || store.blindResumeHistoryBlocked(job.id, rows)) {
        resumeBlockedReason = 'This halt requires review. Check the job alerts or use Stop and withdraw.';
      } else if (!blindResumeEnabled(job)) {
        resumeBlockedReason = 'Live trading or this strategy is disabled.';
      } else if (!policyRead && holdings) {
        resumeBlockedReason = 'Waiting for finalized wallet policy data. Checks retry automatically.';
      } else if (policyRead && !policy) {
        resumeBlockedReason = 'The wallet has no finalized policy. Review your recovery options.';
      } else if (policy && (policy.owner !== job.owner || policyHash(policy) !== job.armedHash)) {
        resumeBlockedReason = 'The finalized wallet policy does not match this job. Review your recovery options.';
      } else if (policy?.frozen) {
        resumeBlockedReason = 'The wallet is frozen. Unfreeze it to allow the recovery checks to pass.';
      } else if (!holdings) {
        resumeBlockedReason = 'Waiting for finalized wallet balances. Checks retry automatically.';
      } else if (!holdings.account) {
        resumeBlockedReason = 'The agent wallet does not exist at the finalized block.';
      } else if ((job.gridV1 || job.lpV1) && !venue) {
        resumeBlockedReason = 'Waiting for finalized DCL data. Checks retry automatically.';
      } else if (venue && !dclRegistered(venue, job.owner)) {
        resumeBlockedReason = venue.storage === null ? 'The agent wallet has no finalized DCL registration.' : 'The finalized DCL registration does not match this job.';
      } else if (!blindChainReady(job, holdings, policy, venue)) {
        resumeBlockedReason = 'The finalized strategy holdings or settings do not match this job.';
      } else {
        resumeBlockedReason = 'Waiting for a full recent watchdog verification. Checks retry automatically.';
      }
    }
    const canRegister = (issued: boolean) => !!(dclEligible && dclEligible.storage === null && holdings?.native === 0n && Object.values(holdings.tokens).every(n => n === 0n) && !issued);
    return { id: job.id, owner: job.owner, kind: job.kind, pair: job.pair, mode: job.mode, state: job.state, reason: job.reason, name: job.name,
      depositYocto: job.depositYocto, agentAccount: job.agentAccount, walletPubkey: job.walletPubkey,
      agentBalance: job.armedHash ? holdings?.native ?? null : account === undefined ? null : account?.amount ?? 0n,
      ownerBalance: owner === undefined ? null : spendableNear(owner, 0n), // Only a v2 payload that is still valid for at least 10 minutes can be signed (OutLayer contract change, 2026-11-10).
      payload: !waiting && job.state === 'policy_prepared' && typeof job.payload?.args.valid_until === 'number' && job.payload.args.valid_until * 1000 > now() + 600_000 ? job.payload : null,
      holdings: holdings ? { tokens: holdings.tokens, block: holdings.block } : null, extraTokens: extras.filter(x => x !== null), operations,
      canReveal: job.walletId !== null, linkDelivered: store.meta(`reveal_delivered:${job.id}`) !== null, linkConfirmed: job.linkConfirmedAt !== null,
      // Trade V1 TF-1: funding a trade job also needs the web trade flag; early Stop and withdraw does not.
      canFund: !!(eligible && holdings.native < job.depositYocto && (job.trade ? env.tradeV1 === true : (!job.gridV1 && !job.lpV1) || (dclEligible && dclRegistered(dclEligible, job.owner, true)))),
      canStopEarly: !!((job.gridV1 || job.lpV1 || job.trade) && linked && policy?.owner === job.owner && holdings && (holdings.native > 0n || Object.values(holdings.tokens).some(n => n > 0n)) && !inFlight),
      waitingForChain: waiting || job.reason === RPC_UNAVAILABLE_REASON, blindHalt, canResumeBlind, resumeBlockedReason,
      frozen: policy?.owner === job.owner ? policy.frozen : null,
      pendingSubmission: inFlight?.state ?? null, alerts,
      trade: tradeView(store, job, holdings, now()),
      grid: grid ? { canRegister: canRegister(grid.issued), issued: grid.issued,
        registered: !!venue && dclRegistered(venue, job.owner), available: !!venue, enabled: env.gridV1 === true, point: venue?.point ?? null,
        anchor: state?.anchor ?? null, internal: venue?.assets ?? {}, lost: venue?.lost ?? {}, positions: venue?.positions ?? 0,
        orders: venue ? [...dclOpen(venue), ...venue.active.filter(o => !venue.orders[o.id])] : [], fills,
        lanes: state?.lanes.map((l, i) => ({ generation: l.generation, sell: l.sell, amount: l.amount, orderId: l.orderId, native: l.native,
          points: step === 'invalid' ? null : lanePoints(state.anchor, i, step, state.lanes.length) })) ?? [],
        // Display only (PnL): the job value of V1 and V2 jobs, under the gate the strategy uses.
        value: holdings && venue && step !== 'invalid' && gridOrderGate(state ?? null, venue, step) ? gridValue(holdings, venue) : null,
        ...(job.gridV2 ? { settings: store.gridSettings(job.id), protect: state?.protect ?? null } : {}) } : null,
      lp: lp ? { canRegister: canRegister(lp.issued), issued: lp.issued, registered: !!venue && dclRegistered(venue, job.owner), available: !!venue, enabled: env.lpV1 === true,
        point: venue?.point ?? null, internal: venue?.assets ?? {}, lost: venue?.lost ?? {}, positions: venue?.positions ?? 0, ledger: lpState?.ledger ?? null,
        rotations: lpRotations(rows, now()), pending: lpState?.pending ?? null,
        ...(job.lpV2 ? { settings: store.lpSettings(job.id), recentred: lpState?.recentred ?? false, lastDecision: lpState?.lastDecision ?? null,
          protect: lpState?.protect ?? null, valueLow, valueHigh, positionValue, initialPosition: job.depositYocto - LP_RESERVE,
          compounds: { count: compounds.length, lastAt: compounds.reduce<number | null>((at, o) => Math.max(at ?? 0, o.finishedAt ?? o.createdAt), null) } } : {}),
        range: lpPosition ? { left: lpPosition.left, right: lpPosition.right, leftPrice: price(lpPosition.left), rightPrice: price(lpPosition.right),
          inRange: venue ? venue.point >= lpPosition.left && venue.point < lpPosition.right : null, outSince: lpState?.out?.since ?? null } : null,
        position: lpPosition ? { id: lpPosition.id, liquidity: lpPosition.liquidity, paidX: lpPosition.paidX, paidY: lpPosition.paidY,
          fees: listed ? [listed.feeX, listed.feeY] : null,
          // Display only (fee APR): when the add that created this position finished.
          openedAt: rows.find(o => o.kind === 'dcl_add' && o.verdict === 'success' && (() => { try { return record(record(JSON.parse(o.after ?? 'null'))?.dclProof)?.lptId === lpPosition.id; } catch { return false; } })())?.finishedAt ?? null,
          estimate: estimate ? [estimate[0].toString(), estimate[1].toString()] : null } : null } : null };
  }

  // Read-only forward to the data plane. The URL and token stay in this function: every failure is a fixed message.
  async function marketData(path: string, query: Record<string, string>, missing: ShownText): Promise<{ data: unknown; meta: Record<string, unknown> }> {
    const md = d.marketData;
    if (!md) throw new CoreError('market_data_unconfigured', 'Market data is not configured.');
    let upstream: Response;
    try {
      upstream = await (md.fetch ?? fetch)(`${md.url.replace(/\/+$/, '')}${path}?${new URLSearchParams(query)}`, { headers: { 'x-dp-token': md.token }, redirect: 'error', signal: AbortSignal.timeout(8_000) });
    } catch { throw new CoreError('market_data_unavailable', 'Market data is unavailable.'); }
    if (upstream.status === 404) throw new Shown('not_found', missing);
    if (upstream.status === 401 || upstream.status === 403) console.warn(`Market data upstream refused the request (HTTP ${upstream.status}).`);
    const answer = upstream.ok ? record(await upstream.json().catch(() => null)) : null, meta = record(answer?.meta);
    if (!answer || !meta || answer.data === undefined) throw new CoreError('market_data_unavailable', 'Market data is unavailable.');
    if (meta.staleness === 'dead') throw new Shown('market_data_unavailable', 'Market data is out of date.');
    return { data: answer.data, meta };
  }
  // A whole number in [min, max]; absent means the default.
  function bounded(value: string | null, fallback: number, min: number, max: number): number {
    const n = value === null ? fallback : /^\d{1,4}$/.test(value) ? Number(value) : NaN;
    if (!(n >= min && n <= max)) throw new CoreError('bad_request', 'Invalid market data request.');
    return n;
  }

  // Demo mode 7.4 (D-4): market data answers are cached for 30 s by their validated values only (at most 64 entries); identical misses share one
  // upstream request, and at most 60 upstream requests start per rolling minute across both routes. Only successful answers are cached.
  const marketCache = new Map<string, { at: number; answer: unknown }>(), marketPending = new Map<string, Promise<unknown>>(), marketStarts: number[] = [];
  async function cachedMarket(key: string, load: () => Promise<unknown>): Promise<unknown> {
    if (!d.marketData) throw new CoreError('market_data_unconfigured', 'Market data is not configured.');
    const hit = marketCache.get(key);
    if (hit && now() - hit.at < 30_000) return hit.answer;
    let running = marketPending.get(key);
    if (!running) {
      while (marketStarts.length && marketStarts[0]! <= now() - 60_000) marketStarts.shift();
      if (marketStarts.length >= 60) throw new CoreError('market_data_unavailable', 'Market data is unavailable.');
      marketStarts.push(now());
      running = load().then(answer => {
        marketCache.delete(key); marketCache.set(key, { at: now(), answer });
        if (marketCache.size > 64) marketCache.delete(marketCache.keys().next().value!);
        return answer;
      }).finally(() => { marketPending.delete(key); });
      marketPending.set(key, running);
    }
    return running;
  }

  // Public agent page 3.3: only successful views of public jobs are stored; concurrent misses for one job share one build.
  const publicCache = new Map<string, { at: number; answer: unknown }>(), publicPending = new Map<string, Promise<unknown>>();
  function publicView(job: Job): Promise<unknown> {
    const hit = publicCache.get(job.id);
    if (hit && now() - hit.at < PUBLIC_CACHE_MS) return Promise.resolve(hit.answer);
    let running = publicPending.get(job.id);
    if (!running) {
      running = view(job, { owner: Promise.resolve(undefined) }).then(v => {
        const answer = { ...v, ...PUBLIC_OVERRIDES, grid: v.grid ? { ...v.grid, canRegister: false } : v.grid, lp: v.lp ? { ...v.lp, canRegister: false } : v.lp };
        publicCache.set(job.id, { at: now(), answer });
        return answer;
      }).finally(() => { publicPending.delete(job.id); });
      publicPending.set(job.id, running);
    }
    return running;
  }
  // Demo mode 7.2 (review H-3): at most 6 creations per remote address in a rolling 24 hours, in memory, at most 10,000 addresses (oldest dropped).
  const demoCreations = new Map<string, number[]>();
  const demoPoint = () => { const s = demoStore && demoDclSamples(demoStore).at(-1); return s && s.at <= now() && now() - s.at < 180_000 ? s.point : null; };

  let optionsPoint: { at: number; point: number | null } = { at: -Infinity, point: null };
  // Trade V1 5.3: one pool read per pair per 60 s, and none while the trade flag is off.
  const tradeSpots = new Map<string, { at: number; spot: { num: string; den: string } | null }>();
  async function tradeSpot(pair: (typeof TRADE_PAIRS)[number]) {
    const cached = tradeSpots.get(pair.id);
    if (cached && now() - cached.at < 60_000) return cached.spot;
    const spot = await readTradePool(rpc, pair).then(p => ({ num: p.wnear.toString(), den: p.token.toString() }), () => null);
    tradeSpots.set(pair.id, { at: now(), spot });
    return spot;
  }
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (data: unknown, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(json(data)); };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      if (req.headers.host !== origin.host || (req.method === 'POST' && req.headers.origin !== env.origin)) throw new CoreError('forbidden', 'Invalid request origin.');
      const url = new URL(req.url ?? '/', env.origin);
      if (url.origin !== env.origin) throw new CoreError('forbidden', 'Invalid request origin.');
      const path = (req.url ?? '/').split('?')[0]!;
      if (!/^\/[A-Za-z0-9._/-]*$/.test(path) || path.includes('//') || path.includes('/./') || path.includes('/../') || path.endsWith('/.') || path.endsWith('/..')) throw new CoreError('not_found', 'Not found.');
      if ((path === '/api/meme' || path.startsWith('/api/meme/')) && !env.memePaper) throw new CoreError('not_found', 'Not found.');
      if ((path === '/api/demo' || path.startsWith('/api/demo/')) && !demoStore) throw new CoreError('not_found', 'Not found.');
      if (!['POST', 'GET'].includes(req.method ?? '')) throw new CoreError('bad_request', 'Invalid method.');
      if (path !== '/api' && !path.startsWith('/api/')) {
        const asset = req.method === 'GET' ? assets[path] : undefined;
        if (asset) { const content = await readFile(asset[1]); res.setHeader('Content-Type', asset[0]); res.end(content); return; }
        const types: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2' };
        const extension = extname(path);
        const type = extension ? types[extension] : /^\/(?:[a-z0-9-]+(?:\/[A-Za-z0-9._-]+)*)?$/.test(path) ? 'text/html; charset=utf-8' : undefined;
        if (req.method === 'GET' && type && uiRoot) {
          const file = resolve(uiRoot, extension ? path.slice(1) : 'index.html');
          try {
            if ((await lstat(file)).isFile() && (await realpath(file)).startsWith(uiRoot + sep)) {
              const content = await readFile(file); res.setHeader('Content-Type', type); res.end(content); return;
            }
          } catch { /* Missing or unsafe UI asset. */ }
        }
        throw new CoreError('not_found', 'Not found.');
      }

      const token = req.headers.cookie?.split(';').map(p => p.trim()).find(p => p.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
      const hash = token && /^[A-Za-z0-9_-]{43}$/.test(token) ? tokenHash(token) : null;
      const session = hash ? store.getSession(hash, now()) : null;
      function ownerJob(id: string | null) {
        if (!session) throw new CoreError('unauthorized', 'Sign in first.');
        const job = id ? store.getJob(id) : null;
        if (!job || job.owner !== session.accountId) throw new CoreError('not_found', 'Job not found.');
        return job;
      }
      async function proof(input: unknown, purpose: 'login' | 'reveal' | 'resume', job: Job | null) {
        const signed = signedAnswer(input);
        const c = store.getChallenge(signed.nonce);
        if (!c || c.purpose !== purpose || c.jobId !== (job?.id ?? null) || (job && signed.accountId !== job.owner) ||
          !(await verifySigned(c, signed, env.origin, provider, now())).ok) throw new CoreError('unauthorized', 'Invalid signature.');
        return { signed, c };
      }

      if (req.method === 'GET' && path === '/api/challenge') {
        const purpose = url.searchParams.get('purpose');
        const id = url.searchParams.get('job');
        if (!(purpose === 'login' && id === null) && purpose !== 'reveal' && purpose !== 'resume') throw new CoreError('bad_request', 'Invalid challenge purpose.');
        const job = purpose === 'login' ? null : ownerJob(id);
        if (job && (!job.walletId || (purpose === 'resume' && job.state !== 'paused' &&
          !(blindResumeEnabled(job) && store.blindResumeProof(job, now()))))) throw new CoreError('conflict', 'This challenge is not available.');
        const c = newChallenge(purpose, job?.id ?? null, now(), env.origin);
        store.putChallenge(c); send(ok({ ...c, recipient: RECIPIENT })); return;
      }
      if (req.method === 'POST' && path === '/api/login') {
        const { signed, c } = await proof((await body(req)).signed, 'login', null);
        const t = now();
        if (!store.useChallenge(c, t)) throw new CoreError('unauthorized', 'Challenge was already used.');
        const pair = newSessionToken();
        store.putSession(pair.hash, signed.accountId, t, t + SESSION_TTL);
        res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${pair.token}; ${cookieFlags}; Max-Age=${SESSION_TTL / 1000}`);
        send(ok({ accountId: signed.accountId })); return;
      }
      if (path === '/api/meme' || path.startsWith('/api/meme/')) {
        if (path === '/api/meme/options' && req.method === 'GET') {
          send(ok({ ...MEME_OPTIONS, ai: memeAi })); return;
        }
        if (path === '/api/meme') {
          if (!session) throw new CoreError('unauthorized', 'Sign in first.');
          if (req.method === 'GET') { send(ok(store.memeAgents(session.accountId).map(a => memeAgentView(a, session.accountId)))); return; }
          const input = await body(req);
          if (!validMemeSettings(input)) throw new CoreError('bad_request', 'Invalid paper settings.');
          send(ok({ id: store.createMemeAgent(session.accountId, input, now()).id }), 201); return;
        }
        const meme = /^\/api\/meme\/([0-9a-f-]{36})(?:\/(stop))?$/.exec(path);
        const a = meme ? store.getMemeAgent(meme[1]) : null;
        if (!a) throw new CoreError('not_found', 'Not found.');
        if (!meme![2] && req.method === 'GET') { send(ok(memePublicView(store, a, now(), session?.accountId))); return; }
        if (meme![2] === 'stop' && req.method === 'POST') {
          if (!session) throw new CoreError('unauthorized', 'Sign in first.');
          if (session.accountId !== a.owner) throw new CoreError('not_found', 'Not found.');
          if (a.state !== 'running' || !store.casMemeAgent(a, 'ending', 'owner-stopped', now())) throw new CoreError('conflict', 'Paper agent changed.');
          send(ok(true)); return;
        }
        throw new CoreError('not_found', 'Not found.');
      }
      if (demoStore && (path === '/api/demo' || path.startsWith('/api/demo/'))) {
        // Demo mode section 7: no session and no RPC call; the routes read the demo samples from meta. A demo cookie grants nothing elsewhere.
        const demoToken = req.headers.cookie?.split(';').map(p => p.trim()).find(p => p.startsWith(`${DEMO_COOKIE}=`))?.slice(DEMO_COOKIE.length + 1);
        const demoCookie = demoToken && /^[0-9a-f]{32}$/.test(demoToken) ? demoToken : null;
        const demoOwner = demoCookie ? createHash('sha256').update(demoCookie).digest('hex') : null;
        if (path === '/api/demo/options' && req.method === 'GET') {
          const lpOn = (DEMO_KINDS as readonly string[]).includes('lp'), day = new Date(now()).toISOString().slice(0, 10);
          const ai = d.ai === true && Number(demoStore.meta(`demo_ai:${day}`) ?? '0') < 50;
          const spot = (poolId: number) => { const s = demoSamples(demoStore, poolId).at(-1); return s && s.at <= now() && now() - s.at < 120_000 ? { num: s.wnear, den: s.token } : null; };
          // `hire` has the shape of GET /api/hire/options, filled for the demo: no live hires, the live bounds, defaults and display text.
          send(ok({ enabled: true, kinds: DEMO_KINDS, ai, limits: { perOwner: DEMO_LIMITS.perOwner, total: DEMO_LIMITS.total, termDays: { grid: 7, lp: 7, schedule: 6, dca: 6 } },
            hire: { kind: 'grid', pairs: PAIRS, liveEnabled: false, demo: true, gridV1: true, gridV2: true, lpV1: lpOn, dclStorage: DCL_STORAGE,
              lp: lpOn ? { minDeposit: LP_MIN_DEPOSIT, maxDeposit: 3n * YOCTO_PER_NEAR, point: demoPoint(), ai } : null,
              minDeposit: YOCTO_PER_NEAR, maxDeposit: MONEY.maxDeposit,
              nativePerTx: MONEY.nativePerTxCeiling, readyFloor: MONEY.readyFloor, agentFloorNear: '0.328045', freezeReserveNear: '0.1',
              ownerAtStoreNear: '0.117631', ownerAdditionalNear: '0.123525', policyCostNear: '0.0164', netCostNear: '0.040101',
              trade: { enabled: true, reserveNear: '0.4',
                pairs: TRADE_PAIRS.map(p => ({ id: p.id, symbol: p.symbol, token: p.token, decimals: p.decimals, poolId: p.pin.poolId, feeBps: p.pin.feeBps, spot: spot(p.pin.poolId) })),
                bounds: { schedule: { amountNear: ['0.10', '0.24'], budgetNear: ['0.20', '1.60'], intervalSec: [3600, 14400, 28800, 43200, 86400], runs: [1, 16], dateMaxMs: now() + TRADE_LIFE_MS },
                  dca: { orderNear: ['0.10', '0.24'], levels: [1, 8], maxStepBps: [1, 2, 3, 4, 5, 6, 7, 8].map(maxStepBps), tpBps: [50, 5000], slBps: [100, 9000], planMaxNear: '1.60' } },
                defaults: { schedule: { pair: 'trade-usdc', amountNear: '0.10', budgetNear: '0.20', intervalSec: 3600, end: { kind: 'budget' } },
                  dca: { pair: 'trade-usdc', baseNear: '0.10', orderNear: '0.10', levels: 3, stepBps: 100, tpBps: 150, slBps: 0 } } } } })); return;
        }
        if (path === '/api/demo') {
          if (req.method === 'GET') { send(ok(demoOwner ? demoStore.demoAgents(demoOwner).map(a => demoSummary(demoStore, a, now())) : [])); return; }
          const created = demoCreate(await body(req), { point: demoPoint() }, now());
          if (created === 'invalid') throw new CoreError('bad_request', 'Invalid demo agent.');
          if (created === 'rpc_unavailable') throw new CoreError('rpc_unavailable', 'Finalized chain data is unavailable.');
          const address = req.socket.remoteAddress ?? '', recent = (demoCreations.get(address) ?? []).filter(at => at > now() - 86_400_000);
          if (recent.length >= 6) throw new CoreError('limit_reached', 'Demo agent limit reached.');
          const cookie = demoCookie ?? randomBytes(16).toString('hex');
          const a = demoStore.createDemoAgent({ owner: createHash('sha256').update(cookie).digest('hex'), kind: created.kind, pair: created.pair, settings: created.settings,
            depositYocto: created.depositYocto.toString(), seed: 0 }, now());
          demoCreations.delete(address); demoCreations.set(address, [...recent, now()]);
          if (demoCreations.size > 10_000) demoCreations.delete(demoCreations.keys().next().value!);
          if (!demoCookie) res.setHeader('Set-Cookie', `${DEMO_COOKIE}=${cookie}; ${cookieFlags}; Max-Age=${30 * 86_400}`);
          send(ok({ id: a.id }), 201); return;
        }
        const demo = /^\/api\/demo\/([0-9a-f-]{36})(?:\/(stop))?$/.exec(path);
        const a = demo ? demoStore.getDemoAgent(demo[1]!) : null;
        if (!a) throw new CoreError('not_found', 'Not found.');
        if (!demo![2] && req.method === 'GET') { send(ok(demoPublicView(demoStore, a, now(), demoOwner !== null && a.owner === demoOwner))); return; }
        if (demo![2] === 'stop' && req.method === 'POST') {
          if (demoOwner === null || a.owner !== demoOwner) throw new CoreError('not_found', 'Not found.');
          if (a.state !== 'running' || !demoStore.stopDemoAgent(a, now())) throw new CoreError('conflict', 'Demo agent changed.');
          send(ok(true)); return;
        }
        throw new CoreError('not_found', 'Not found.');
      }
      if (req.method === 'GET' && path === '/api/market-data/ohlcv') {
        // Public agent page P-5: public in every mode, so a visitor's chart renders on a demo or a public agent page (data plane only, cached, capped).
        const q = url.searchParams, key = q.get('address'), interval = q.get('interval') ?? '1m', currency = q.get('currency') ?? 'token';
        if (q.get('kind') !== 'pool' || !key || !POOL_KEYS.includes(key) || !CHART_INTERVALS.includes(interval) || !['token', 'usd'].includes(currency)) throw new CoreError('bad_request', 'Invalid market data request.');
        const limit = bounded(q.get('limit'), 300, 1, 500);
        send(await cachedMarket(`ohlcv|${key}|${interval}|${limit}|${currency}`, async () => {
          const answer = await marketData(`/near/pools/${key}/ohlcv`, { interval, limit: String(limit), currency }, 'Price history is not recorded yet.');
          if (!Array.isArray(answer.data)) throw new CoreError('market_data_unavailable', 'Market data is unavailable.');
          return answer;
        })); return;
      }
      if (req.method === 'GET' && path === '/api/pool-liquidity') {
        const q = url.searchParams, key = q.get('address');
        if (!key || !POOL_KEYS.includes(key)) throw new CoreError('bad_request', 'Invalid market data request.');
        const window = bounded(q.get('window'), 60, 1, 1000);
        send(await cachedMarket(`liquidity|${key}|${window}`, async () => {
          const answer = await marketData(`/near/pools/${key}/liquidity`, { window: String(window) }, 'Liquidity profile is not recorded yet.'), data = record(answer.data);
          const bins = Array.isArray(data?.bins) ? data.bins.map(record) : null;
          if (!data || !bins || typeof data.currentTick !== 'number' || bins.some(b => typeof b?.tickLower !== 'number')) throw new CoreError('market_data_unavailable', 'Market data is unavailable.');
          // The data plane speaks DCL points; the pages show tick = -point (web/lib/near-map.ts tickOf), ascending, so the profile lines up with the rungs and the range.
          return { data: { ...data, currentTick: -data.currentTick, bins: bins.map(b => ({ ...b, tickLower: -(b!.tickLower as number) })).reverse() }, meta: answer.meta };
        })); return;
      }
      if (path.startsWith('/api/public/jobs/')) {
        // Public agent page 3.1: no session. A job whose management link was never confirmed answers like an unknown id, with no chain read.
        const id = /^\/api\/public\/jobs\/([0-9a-f-]{36})$/.exec(path)?.[1], job = id && req.method === 'GET' ? store.getJob(id) : null;
        if (!job || job.linkConfirmedAt === null) throw new CoreError('not_found', 'Not found.');
        send(ok(await publicView(job))); return;
      }
      if (!session || !hash) throw new CoreError('unauthorized', 'Sign in first.');
      if (req.method === 'POST' && path === '/api/logout') {
        store.deleteSession(hash); res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; ${cookieFlags}; Max-Age=0`); send(ok(true)); return;
      }
      if (req.method === 'GET' && path === '/api/me') { send(ok(session)); return; }
      if (req.method === 'GET' && path === '/api/hire/options') {
        // The page polls every 5 s; keep the prefill point for 60 s so the poll adds no steady read load.
        if (env.lpV1 && now() - optionsPoint.at >= 60_000) optionsPoint = { at: now(), point: await readPoolPoint(rpc).catch(() => null) };
        const point = env.lpV1 ? optionsPoint.point : null;
        send(ok({ kind: 'grid', pairs: PAIRS, liveEnabled: env.liveHires, demo: demoStore !== null, gridV1: env.gridV1 === true, gridV2: env.gridV1 === true && env.gridV2 === true, lpV1: env.lpV1 === true, dclStorage: env.gridV1 || env.lpV1 ? DCL_STORAGE : null,
          lp: env.lpV1 ? { minDeposit: LP_MIN_DEPOSIT, maxDeposit: 3n * YOCTO_PER_NEAR, point, ai: d.ai === true } : null,
          minDeposit: env.gridV1 ? YOCTO_PER_NEAR : MONEY.minDeposit, maxDeposit: MONEY.maxDeposit,
          nativePerTx: MONEY.nativePerTxCeiling, readyFloor: MONEY.readyFloor, agentFloorNear: '0.328045', freezeReserveNear: '0.1',
          ownerAtStoreNear: '0.117631', ownerAdditionalNear: '0.123525', policyCostNear: '0.0164', netCostNear: '0.040101',
          trade: { enabled: env.tradeV1 === true && env.liveHires, reserveNear: '0.4',
            pairs: await Promise.all(TRADE_PAIRS.map(async p => ({ id: p.id, symbol: p.symbol, token: p.token, decimals: p.decimals, poolId: p.pin.poolId, feeBps: p.pin.feeBps,
              spot: env.tradeV1 === true && env.liveHires ? await tradeSpot(p) : null }))),
            bounds: { schedule: { amountNear: ['0.10', '0.24'], budgetNear: ['0.20', '1.60'], intervalSec: [3600, 14400, 28800, 43200, 86400], runs: [1, 16], dateMaxMs: now() + TRADE_LIFE_MS },
              dca: { orderNear: ['0.10', '0.24'], levels: [1, 8], maxStepBps: [1, 2, 3, 4, 5, 6, 7, 8].map(maxStepBps), tpBps: [50, 5000], slBps: [100, 9000], planMaxNear: '1.60' } },
            defaults: { schedule: { pair: 'trade-usdc', amountNear: '0.10', budgetNear: '0.20', intervalSec: 3600, end: { kind: 'budget' } },
              dca: { pair: 'trade-usdc', baseNear: '0.10', orderNear: '0.10', levels: 3, stepBps: 100, tpBps: 150, slBps: 0 } } } })); return;
      }
      if (path === '/api/jobs') {
        if (req.method === 'GET') {
          const jobs = store.listJobs(session.accountId), owner = jobs.length ? rpc.viewAccount(session.accountId).catch(() => undefined) : Promise.resolve(undefined);
          send(ok(await Promise.all(jobs.map(job => view(job, { owner }))))); return;
        }
        if (!env.liveHires) throw new CoreError('live_disabled', 'Live hires are disabled.');
        const input = await body(req), counts = store.jobCounts(session.accountId);
        if (counts.live >= MONEY.maxLiveJobs || counts.pending > 0) throw new CoreError('limit_reached', 'Hire limit reached.');
        const point = input.kind === 'lp' && record(record(input.lp)?.range)?.mode === 'explicit' ? await readPoolPoint(rpc) : null;
        if (draftProblems({ session, kind: input.kind, mode: input.mode, pair: input.pair, depositYocto: input.depositYocto, liveEnabled: env.liveHires,
          liveJobs: counts.live, ownerPendingLive: counts.pending, gridV1: env.gridV1, gridV2: env.gridV1 === true && env.gridV2 === true, lpV1: env.lpV1, lp: input.lp, grid: input.grid, point,
          tradeV1: env.tradeV1, trade: input.trade, now: now() }).length) throw new CoreError('bad_request', 'Invalid hire.');
        if (input.kind === 'schedule' || input.kind === 'dca') {
          const tradeSettings = tradeSettingsFromRequest(input.kind, input.trade, now()), name = parseJobName(input.name);
          if (tradeSettings === 'invalid' || name === 'invalid' || typeof input.pair !== 'string') throw new CoreError('bad_request', 'Invalid trade settings.');
          const job = store.createJob({ owner: session.accountId, kind: input.kind, mode: 'live', pair: input.pair, depositYocto: parseAmount(input.depositYocto, 'deposit'),
            tradeSettings, ...(name ? { name } : {}) }, now());
          send(ok({ id: job.id, state: job.state }), 201); return;
        }
        const kind = input.kind === 'lp' ? 'lp' : 'grid';
        const settings = kind === 'lp' && input.lp !== undefined ? lpSettingsFromPrices(input.lp) : null;
        if (settings === 'invalid') throw new CoreError('bad_request', 'Invalid LP settings.');
        const name = parseJobName(input.name);
        if (name === 'invalid') throw new CoreError('bad_request', 'Invalid agent name.');
        const gridSettings = kind === 'grid' && input.grid !== undefined ? gridSettingsFromRequest(input.grid) : null;
        if (gridSettings === 'invalid') throw new CoreError('bad_request', 'Invalid Grid settings.');
        const job = store.createJob({ owner: session.accountId, kind, mode: 'live', pair: PAIRS[0].id, depositYocto: parseAmount(input.depositYocto, 'deposit'),
          gridV1: kind === 'grid' && env.gridV1, lpV1: kind === 'lp' && env.lpV1, ...(settings ? { lpSettings: settings } : {}), ...(gridSettings ? { gridSettings } : {}), ...(name ? { name } : {}) }, now());
        send(ok({ id: job.id, state: job.state }), 201); return;
      }
      const match = /^\/api\/jobs\/([0-9a-f-]{36})(?:\/([a-z-]+))?$/.exec(path);
      if (!match) throw new CoreError('not_found', 'Not found.');
      const job = ownerJob(match[1]), action = match[2];
      if (req.method === 'GET' && !action) { send(ok(await view(job))); return; }
      if (req.method !== 'POST') throw new CoreError('not_found', 'Not found.');
      if (action === 'cancel') {
        if ((job.gridV1 || job.lpV1 || job.trade) && job.agentAccount) {
          const holdings = await readHoldings(rpc, job.agentAccount, [WNEAR, ...jobTokens(job)]);
          if (holdings.native > 0n || Object.values(holdings.tokens).some(n => n > 0n)) throw new CoreError('conflict', job.trade ? 'A funded job must use the withdrawal path.' : 'A funded Grid or LP job must use the withdrawal path.');
        }
        if (!setJob(store, job, 'cancelled', now(), { reason: null })) throw new CoreError('conflict', 'Cannot cancel.');
        send(ok(true)); return;
      }
      if (action === 'link-confirmed') {
        if ((await body(req)).saved !== true || !store.meta(`reveal_delivered:${job.id}`) ||
          !setJob(store, job, 'link_confirmed', now(), { linkConfirmedAt: now(), reason: null })) throw new CoreError('conflict', 'Link not delivered and confirmed.');
        send(ok(true)); return;
      }
      if (action === 'stop') {
        const inFlight = job.walletId ? store.inFlightOp(job.walletId) : null;
        if (job.state === 'link_confirmed' && (!(job.gridV1 || job.lpV1 || job.trade) || !(await view(job)).canStopEarly)) throw new CoreError('conflict', 'This job cannot withdraw yet.');
        if (job.linkConfirmedAt === null || inFlight?.state === 'ambiguous' || !setJob(store, job, 'stopping', now(), { reason: null })) {
          throw new CoreError('conflict', 'This job cannot withdraw yet.');
        }
        send(ok(true)); return;
      }
      if (action === 'retire') {
        // Retire spec 2.2: a dead job whose agent wallet holds only dust leaves the active set. Nothing is sent and the wallet is not touched.
        if (!['halted', 'paused', 'frozen'].includes(job.state)) throw new Shown('conflict', 'Only a halted, paused or frozen job can be retired.');
        if (!job.walletId || !job.agentAccount) throw new Shown('conflict', 'This job has no agent wallet. Cancel it instead.');
        const op = store.inFlightOp(job.walletId);
        if (op && (op.state !== 'ambiguous' || op.submittedAt === null || now() - op.submittedAt < AMBIGUOUS_SLOW_AFTER_MS)) throw new Shown('conflict', 'An operation is still unresolved. Try again later.');
        let dust: boolean;
        try {
          const snap = await readHoldings(rpc, job.agentAccount, [WNEAR, ...jobTokens(job)]);
          const dcl = job.gridV1 || job.lpV1 ? await readDcl(rpc, job.agentAccount, snap, job.gridV1 ? gridKnownOrders(store, job.id) : []) : null;
          dust = snap.native < RETIRE_DUST && Object.values(snap.tokens).every(n => n === 0n) && (dcl === null ||
            ([...Object.values(dcl.assets), ...Object.values(dcl.lost)].every(n => n === 0n) && dclOpen(dcl).length === 0 && dcl.liquidities.length === 0 &&
            dcl.active.length === 0 && !dcl.history.some(o => o.remain > 0n || o.unclaimed > 0n)));
        } catch { throw new Shown('rpc_unavailable', 'Could not verify the agent wallet. Try again.'); }
        if (!dust) throw new Shown('conflict', 'The agent wallet still holds funds. Use Stop and withdraw or the management link first.');
        if (!store.retireJob(job, op?.id ?? null, now())) throw new Shown('conflict', 'The job changed. Reload and try again.');
        send(ok(true)); return;
      }
      if (action === 'dcl-registration') {
        const shown = await view(job);
        if (!hash || !(shown.grid ?? shown.lp)?.canRegister || !store.issueDclRegistration(job, hash, now()) || !job.agentAccount) throw new CoreError('conflict', 'DCL registration cannot be issued.');
        send(ok({ ...dclRegistration(job.agentAccount), caller: job.owner })); return;
      }
      if (action === 'resume') {
        if (job.state !== 'paused' && !store.blindHalt(job)) throw new CoreError('conflict', 'This job cannot resume.');
        const { c } = await proof((await body(req)).signed, 'resume', job);
        if (job.state === 'halted') {
          const checked = blindResumeEnabled(job) && store.blindResumeProof(job, now());
          if (!checked || !hash || !job.agentAccount || !job.walletPubkey) throw new CoreError('conflict', 'The job is waiting for verification or cannot resume.');
          const holdings = await readHoldings(rpc, job.agentAccount, [WNEAR, ...jobTokens(job)]);
          const [policy, venue] = await Promise.all([
            readChainPolicy(rpc, job.walletPubkey, holdings).then(r => r.entry),
            job.gridV1 || job.lpV1 ? readDcl(rpc, job.agentAccount, holdings, job.gridV1 ? gridKnownOrders(store, job.id) : []) : null,
          ]);
          if (holdings.block < checked.block || !blindChainReady(job, holdings, policy, venue) ||
            !store.resumeBlind(job, hash, c, checked, holdings.block, now())) throw new CoreError('conflict', 'The job is waiting for verification or cannot resume.');
          send(ok(true)); return;
        }
        if (!store.useChallenge(c, now())) throw new CoreError('unauthorized', 'Challenge was already used.');
        if (!setJob(store, job, 'resuming', now(), { reason: RESUMING_REASON })) throw new CoreError('conflict', 'The job changed.');
        send(ok(true)); return;
      }
      if (action === 'reveal') {
        if (origin.protocol !== 'https:' && !['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname)) throw new CoreError('forbidden', 'HTTPS required.');
        if (!job.walletId) throw new CoreError('conflict', 'No wallet is registered.');
        const { signed, c } = await proof((await body(req)).signed, 'reveal', job);
        const id = randomUUID(), key = newRelayKey();
        store.insertReveal({ id, jobId: job.id, nonce: c.nonce, signed, webPub: key.publicDer, sealed: null, createdAt: now() });
        const deadline = now() + 30_000;
        for (let i = 0; i < 120 && now() < deadline; i++) {
          if (res.destroyed) return;
          const r = store.getReveal(id);
          if (r?.sealed) {
            const link = openRelay(r.sealed, key, id);
            if (!store.takeReveal(r, now())) throw new CoreError('conflict', 'Reveal expired.');
            send(ok({ link: link.reveal() })); return;
          }
          await wait(250);
        }
        throw new CoreError('outlayer_error', 'The worker did not complete the reveal.');
      }
      throw new CoreError('not_found', 'Not found.');
    } catch (e) {
      const code = e instanceof CoreError ? e.code : 'internal';
      const [status, fixed] = errors[code], message = e instanceof Shown ? e.message : fixed;
      if (!res.destroyed && !res.headersSent) send(fail(code, message), status);
    }
  };
}

function main() {
  const env = webEnv();
  // Demo mode D-7: a demo web needs its own database path (never the live default) and reads only public FastNEAR, logins included, so anonymous
  // visitors never spend the QuickNode quota (FINDINGS 1.40). The demo store refuses a database with a live job or a worker heartbeat (store.ts).
  if (env.demo && !process.env.FOURLPHA_DB_PATH) { console.error('Demo web stopped: set FOURLPHA_DB_PATH to a separate demo database.'); process.exitCode = 1; return; }
  const endpoints = env.demo ? DEFAULT_RPC : dRpcFirst(rpcEnv()), store = openStore(dbPath(), 'web', env.demo === true);
  // Demo in the main app (DEMO-MODE-COMBINED-PLAN section 1): a second store, demo flag on, on its own database; the live store above is opened as before.
  // Its constructor refuses a database with a live job or a worker heartbeat (D-7), which stops the start.
  const sameFile = (a: string, b: string) => { try { const x = statSync(a, { bigint: true }), y = statSync(b, { bigint: true }); return x.dev === y.dev && x.ino === y.ino; } catch { return false; } };
  if (env.demoDb !== undefined && sameFile(dbPath(), env.demoDb)) { console.error('Web stopped: the demo database is the live database.'); process.exitCode = 1; store.close(); return; }
  const demoStore = env.demoDb === undefined ? undefined : openStore(env.demoDb, 'web', true);
  const rpc = createNearRpc(endpoints, undefined, undefined, { coordinator: store.rpcCoordinator() });
  const local = localEnv(), dataPlaneUrl = process.env.DATA_PLANE_URL || local.DATA_PLANE_URL, dataPlaneToken = process.env.DATA_PLANE_TOKEN || local.DATA_PLANE_TOKEN;
  const handler = createHandler({ env, store, rpc, now: Date.now, provider: accessKeyProvider(endpoints.read[0], rpc), ai: !!local.NEAR_AI_API_KEY, ...(demoStore ? { demoStore } : {}),
    ...(dataPlaneUrl && dataPlaneToken ? { marketData: { url: dataPlaneUrl, token: dataPlaneToken } } : {}) });
  const server = createServer((req, res) => { void handler(req, res); });
  server.on('error', () => { console.error('Web server could not start.'); process.exitCode = 1; });
  server.listen(env.port, env.host, () => { console.log(`RPC: ${rpcLabel(endpoints)}`); console.log(`4lpha NEAR web: ${env.origin}`); });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
