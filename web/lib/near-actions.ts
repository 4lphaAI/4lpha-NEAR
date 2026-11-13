import { canRequestResume, depositYocto, freezeCall, isDclRegistrationPayload, isPolicyPayload, ServerError, type Job, type Payload } from './near-format';
import type { api, sign, sendCall, transferWallet } from './near-wallet';
import type { PendingTransfer } from './hire-run';

/** Spec UI step 3, section 4: per-job persisted pending-transfer markers (localStorage in the browser). */
export interface TransferStore { get(key: string): string | null; set(key: string, value: string): void; remove(key: string): void; keys(): string[]; }
export const TRANSFER_PREFIX = '4lpha:near-transfer:v1:';
const FUNDED = ['funded', 'resuming', 'ready', 'running'];
const DECIMAL = /^\d+$/;
const RESET_AFTER_MS = 120_000;

function parseTransfer(raw: string | null, account: string, jobId: string): PendingTransfer | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    return v.account === account && v.jobId === jobId && typeof v.amount === 'string' && DECIMAL.test(v.amount) && typeof v.baseBalance === 'string' && DECIMAL.test(v.baseBalance)
      && typeof v.at === 'number' && Number.isFinite(v.at) ? { account, jobId, amount: v.amount, baseBalance: v.baseBalance, at: v.at } : null;
  } catch { return null; }
}

export interface HireOptions {
  liveEnabled: boolean; demo?: boolean; gridV1: boolean; gridV2?: boolean; lpV1: boolean; minDeposit: string; maxDeposit: string;
  lp: { minDeposit: string; maxDeposit: string; point: number | null; ai: boolean } | null;
  trade?: TradeOptions;
}

/** Trade V1 spec 5.3: the trade block of GET /api/hire/options. */
export interface TradeOptions {
  enabled: boolean;
  reserveNear: string;
  pairs: { id: 'trade-usdc' | 'trade-rhea' | 'trade-zec'; symbol: 'USDC' | 'RHEA' | 'ZEC'; token: string; decimals: number; poolId: number; feeBps: number; spot: { num: string; den: string } | null }[];
  bounds: {
    schedule: { amountNear: [string, string]; budgetNear: [string, string]; intervalSec: number[]; runs: [number, number]; dateMaxMs: number };
    dca: { orderNear: [string, string]; levels: [number, number]; maxStepBps: number[]; tpBps: [number, number]; slBps: [number, number]; planMaxNear: string };
  };
  defaults: {
    schedule: { pair: string; amountNear: string; budgetNear: string; intervalSec: number; end: { kind: 'budget' } };
    dca: { pair: string; baseNear: string; orderNear: string; levels: number; stepBps: number; tpBps: number; slBps: number };
  };
}
/** The trade part of a hire: the pinned pair and the request settings of spec 5.1. */
export interface TradeHire { pair: string; settings: object; }

export interface LpForm {
  rangeMode: 'explicit' | 'server'; minPrice: string; maxPrice: string; ai: boolean;
  compound: boolean; minFeeBps: string; stopLossPct: string; takeProfitPct: string;
}
export interface GridForm { preset: 'tight' | 'balanced' | 'wide' | 'volatile'; orders: string; stopLossPct: string; takeProfitPct: string; }
export interface LpDraft extends LpForm {
  edited: Partial<Record<keyof LpForm, boolean>>;
  prefilled: Partial<Record<'minPrice' | 'maxPrice' | 'ai', boolean>>;
}
const initialLpDraft: LpDraft = {
  rangeMode: 'explicit', minPrice: '', maxPrice: '', ai: false, compound: true,
  minFeeBps: '100', stopLossPct: '0', takeProfitPct: '0', edited: {}, prefilled: {},
};

export function applyLpPrefill(draft: LpDraft, options: HireOptions): LpDraft {
  if (!options.lp) return draft;
  const next = { ...draft, prefilled: { ...draft.prefilled } };
  if (!draft.edited.ai && !draft.prefilled.ai) { next.ai = options.lp.ai; next.prefilled.ai = true; }
  if (options.lp.point !== null) {
    if (!draft.edited.minPrice && !draft.prefilled.minPrice) {
      next.minPrice = (1e18 / 1.0001 ** (options.lp.point + 100)).toFixed(6); next.prefilled.minPrice = true;
    }
    if (!draft.edited.maxPrice && !draft.prefilled.maxPrice) {
      next.maxPrice = (1e18 / 1.0001 ** (options.lp.point - 100)).toFixed(6); next.prefilled.maxPrice = true;
    }
  }
  return next;
}

export function createNearActions(d: { api: typeof api; sign: typeof sign; sendCall: typeof sendCall; now: () => number; clearWallet: () => void; changed: () => void;
  transferWallet?: typeof transferWallet; transferStore?: TransferStore | null; lock?: <T>(name: string, fn: () => Promise<T>) => Promise<T> }) {
  const state = {
    mounted: false, account: null as string | null, options: null as HireOptions | null, optionsError: false,
    jobs: [] as Job[], lastPollMs: 0, message: '', busy: false, logoutPending: false,
    lpDraft: initialLpDraft,
  };
  let generation = 0;
  let idle: Promise<void> = Promise.resolve(), release = () => {};
  let poll: Promise<void> | null = null, lastStart = -Infinity;
  const links = new Map<string, string>(), mounts = new Map<string, symbol>();
  const saved = new Set<string>(), sentPolicy = new Set<string>(), pendingFreeze = new Map<string, boolean>();
  const transfers = new Map<string, PendingTransfer>();
  const storageKey = (account: string, jobId: string) => TRANSFER_PREFIX + account + ':' + jobId;
  const lock = d.lock ?? (<T>(_name: string, fn: () => Promise<T>) => fn());
  function storedTransfer(account: string, jobId: string): PendingTransfer | null {
    try { return parseTransfer(d.transferStore?.get(storageKey(account, jobId)) ?? null, account, jobId); } catch { return null; }
  }
  function dropTransfer(account: string, jobId: string) {
    transfers.delete(account + ':' + jobId);
    try { d.transferStore?.remove(storageKey(account, jobId)); } catch { /* Storage can be unavailable. */ }
  }
  function loadTransfers() {
    if (!state.account) return;
    const prefix = TRANSFER_PREFIX + state.account + ':';
    let keys: string[] = [];
    try { keys = d.transferStore?.keys() ?? []; } catch { keys = []; }
    for (const k of keys) {
      if (!k.startsWith(prefix)) continue;
      const jobId = k.slice(prefix.length), marker = storedTransfer(state.account, jobId);
      if (marker) transfers.set(state.account + ':' + jobId, marker);
    }
  }
  /** Spec section 4 clear rules (a) and (b), applied to each job list: positive evidence only. */
  function settleTransfers(jobs: Job[]) {
    for (const m of [...transfers.values()]) {
      if (m.account !== state.account) continue;
      const job = jobs.find(j => j.id === m.jobId);
      if (!job) continue;
      const reached = job.agentBalance !== null && DECIMAL.test(job.agentBalance) && BigInt(job.agentBalance) >= BigInt(m.baseBalance) + BigInt(m.amount);
      // The worker operates only after funded, so operations on the job are positive evidence that funding passed.
      if (FUNDED.includes(job.state) || reached || job.operations.length > 0) {
        dropTransfer(m.account, m.jobId);
        if (state.message === 'Transfer submitted. Waiting for the finalized balance.') state.message = '';
      }
    }
  }
  const key = (id: string) => `${state.account}:${id}`;
  const guardFor = () => { const g = generation, a = state.account; return () => generation === g && state.account === a && !state.logoutPending; };
  const error = (e: unknown) => e instanceof ServerError ? e.message : e instanceof Error && e.message.startsWith('4lpha: ') ? e.message.slice('4lpha: '.length) : 'The action could not be completed. Check your wallet and the job status.';
  function clear() {
    links.clear(); saved.clear(); sentPolicy.clear(); pendingFreeze.clear(); transfers.clear(); d.clearWallet();
    state.options = null; state.optionsError = false; state.jobs = []; state.lastPollMs = 0; state.message = '';
  }
  function accountChanged(account: string | null, signIn = false) {
    if (account !== state.account) state.lpDraft = initialLpDraft;
    if (account !== state.account || signIn) { generation++; clear(); state.account = account; loadTransfers(); d.changed(); }
  }
  async function options() {
    const guard = guardFor();
    if (!state.account || !guard()) return;
    try {
      const result = await d.api<HireOptions>('/api/hire/options');
      if (!guard()) return;
      state.options = result; state.optionsError = false;
      state.lpDraft = applyLpPrefill(state.lpDraft, result);
    } catch { if (!guard()) return; state.optionsError = true; }
    d.changed();
  }
  function requestJobs() {
    const guard = guardFor();
    if (!state.account || !guard()) return Promise.resolve();
    lastStart = d.now();
    const request = (async () => {
      try {
        const jobs = await d.api<Job[]>('/api/jobs');
        if (!guard()) return;
        state.jobs = jobs; state.lastPollMs = d.now();
        settleTransfers(jobs);
        for (const job of jobs) if (pendingFreeze.get(job.id) === job.frozen) pendingFreeze.delete(job.id);
        if (state.message === 'Job status is temporarily unavailable.') state.message = '';
      } catch { if (!guard()) return; state.message = 'Job status is temporarily unavailable.'; }
      d.changed();
    })();
    poll = request;
    void request.finally(() => { if (poll === request) poll = null; });
    return request;
  }
  async function snapshot(guard: () => boolean) {
    while (poll) { await poll; if (!guard()) return; }
    if (!guard()) return;
    await requestJobs();
    if (!guard()) return;
  }
  async function run<T>(fn: (guard: () => boolean) => Promise<T>, refreshAfter = true): Promise<T | undefined> {
    if (state.busy || state.logoutPending) return;
    state.busy = true; idle = new Promise(resolve => { release = resolve; });
    const guard = guardFor(); state.message = ''; d.changed();
    try {
      const value = await fn(guard);
      if (!guard()) return;
      if (refreshAfter) { await snapshot(guard); if (!guard()) return; }
      return value;
    } catch (e) { if (guard()) { state.message = error(e); d.changed(); } }
    finally { state.busy = false; release(); d.changed(); }
  }
  const actions = {
    state, sentPolicy, pendingFreeze,
    async mount() {
      const guard = guardFor();
      try {
        const result = await d.api<{ accountId: string }>('/api/me');
        if (!guard()) return;
        accountChanged(result.accountId);
      } catch { if (!guard()) return; }
      finally { state.mounted = true; d.changed(); }
      const current = guardFor();
      if (state.account && current()) {
        await options(); if (!current()) return;
        await snapshot(current); if (!current()) return;
      }
    },
    login() {
      return run(async guard => {
        const signed = await d.sign('login', undefined, guard); if (!guard()) return;
        const result = await d.api<{ accountId: string }>('/api/login', { signed }); if (!guard()) return;
        accountChanged(result.accountId, true);
        const current = guardFor();
        await options(); if (!current()) return;
        await snapshot(current); if (!current()) return;
      }, false);
    },
    async logout() {
      if (state.logoutPending) return;
      state.logoutPending = true; generation++; clear(); state.lpDraft = initialLpDraft; state.account = null; d.changed();
      const logoutGeneration = generation;
      await idle;
      state.busy = true; d.changed();
      try { await d.api('/api/logout', {}); }
      catch (e) { if (generation === logoutGeneration) state.message = error(e); }
      finally { state.busy = false; state.logoutPending = false; d.changed(); }
    },
    refresh() {
      if (!state.account || state.logoutPending || state.busy || saved.size || poll || d.now() - lastStart < 15000) return Promise.resolve();
      return requestJobs();
    },
    refreshLpOptions() {
      if (state.options?.lp?.point === null) return options();
      return Promise.resolve();
    },
    setLpField<K extends keyof LpForm>(field: K, value: LpForm[K]) {
      state.lpDraft = { ...state.lpDraft, [field]: value, edited: { ...state.lpDraft.edited, [field]: true } }; d.changed();
    },
    prepareHire(kind: 'grid' | 'lp' | 'schedule' | 'dca', depositText: string, lp?: LpForm, grid?: GridForm, name?: string, trade?: TradeHire) {
      return run(async guard => {
        if (!guard()) return;
        const number = (value: string) => {
          if (!/^\d+$/.test(value)) throw new Error('4lpha: Enter whole numbers for LP percentages and fee basis points.');
          return Number(value);
        };
        const settings = kind === 'lp' ? {
          range: lp!.rangeMode === 'server' ? { mode: 'server' } : { mode: 'explicit', minPrice: lp!.minPrice.trim(), maxPrice: lp!.maxPrice.trim() },
          ai: lp!.ai,
          compound: lp!.compound ? { on: true, minFeeBps: number(lp!.minFeeBps) } : { on: false },
          stopLossPct: number(lp!.stopLossPct), takeProfitPct: number(lp!.takeProfitPct),
        } : undefined;
        // Spec 2c: Grid V2 settings, same whole-number rule as LP. Absent means a V1 hire.
        if (kind === 'grid' && grid && grid.orders !== '2' && grid.orders !== '4') throw new Error('4lpha: Choose 2 or 4 orders.');
        const gridSettings = kind === 'grid' && grid ? { preset: grid.preset, orders: Number(grid.orders), stopLossPct: number(grid.stopLossPct), takeProfitPct: number(grid.takeProfitPct) } : undefined;
        const result = await d.api<{ id: string }>('/api/jobs', { kind, pair: trade ? trade.pair : 'usdc-wnear', mode: 'live', depositYocto: depositYocto(depositText).toString(),
          ...(settings ? { lp: settings } : {}), ...(gridSettings ? { grid: gridSettings } : {}), ...(trade ? { trade: trade.settings } : {}), ...(name?.trim() ? { name: name.trim() } : {}) });
        if (!guard()) return;
        return result.id;
      });
    },
    registerDcl(job: Job) {
      return run(async guard => {
        const p = await d.api<Payload>(`/api/jobs/${job.id}/dcl-registration`, {}); if (!guard()) return;
        if (!isDclRegistrationPayload(p, job)) throw new Error();
        await d.sendCall(job, p.receiverId, { methodName: p.methodName, args: p.args, gas: p.gas, deposit: p.deposit }, guard); if (!guard()) return;
        state.message = 'Registration submitted. Wait for finalized DCL storage before funding.'; d.changed();
      });
    },
    storePolicy(job: Job) {
      return run(async guard => {
        const p = job.payload!;
        if (!isPolicyPayload(p, job)) throw new Error();
        if (!guard()) return;
        await d.sendCall(job, p.receiverId, { methodName: p.methodName, args: p.args, gas: p.gas, deposit: p.deposit }, guard); if (!guard()) return;
        sentPolicy.add(job.id); state.message = 'Policy submitted. Waiting for finalized owner and rule checks.'; d.changed();
      });
    },
    mountJob(id: string) {
      const k = key(id), token = Symbol(); mounts.set(k, token);
      return () => { if (mounts.get(k) === token) { mounts.delete(k); links.delete(k); saved.delete(k); d.changed(); } };
    },
    link(id: string) { return links.get(key(id)); },
    isSaved(id: string) { return saved.has(key(id)); },
    setSaved(id: string, value: boolean) { if (value) saved.add(key(id)); else saved.delete(key(id)); d.changed(); },
    reveal(job: Job) {
      return run(async guard => {
        const k = key(job.id), token = mounts.get(k);
        const current = () => guard() && token !== undefined && mounts.get(k) === token;
        if (!current()) return;
        const signed = await d.sign('reveal', job.id, current); if (!current()) return;
        const result = await d.api<{ link: string }>(`/api/jobs/${job.id}/reveal`, { signed }); if (!current()) return;
        links.set(k, result.link); d.changed();
      });
    },
    hideLink(job: Job) { return run(async guard => { if (!guard()) return; links.delete(key(job.id)); d.changed(); }); },
    confirmLink(job: Job) {
      return run(async guard => {
        if (!saved.has(key(job.id))) throw new Error('4lpha: Save the link and tick the confirmation first.');
        await d.api(`/api/jobs/${job.id}/link-confirmed`, { saved: true }); if (!guard()) return;
        links.delete(key(job.id)); saved.delete(key(job.id)); d.changed();
      });
    },
    cancel(job: Job) { return run(async guard => { await d.api(`/api/jobs/${job.id}/cancel`, {}); if (!guard()) return; }); },
    toggleFreeze(job: Job) {
      return run(async guard => {
        const { receiverId, call } = freezeCall(job, job.frozen!);
        if (!guard()) return;
        await d.sendCall(job, receiverId, call, guard); if (!guard()) return;
        pendingFreeze.set(job.id, !job.frozen); state.message = 'Transaction submitted. Waiting for the finalized freeze state.'; d.changed();
      });
    },
    resume(job: Job) {
      return run(async guard => {
        if (!canRequestResume(job)) return;
        const available = () => {
          const current = state.jobs.find(j => j.id === job.id);
          return !!(current && current.state === job.state && canRequestResume(current));
        };
        if (!available()) return;
        const signed = await d.sign('resume', job.id, guard); if (!guard()) return;
        if (!available()) return;
        await d.api(`/api/jobs/${job.id}/resume`, { signed }); if (!guard()) return;
      });
    },
    stop(job: Job) { return run(async guard => { await d.api(`/api/jobs/${job.id}/stop`, {}); if (!guard()) return; }); },
    /** Retire spec 2.2: the server checks the chain and moves a dead dust-only job to `retired`. */
    retire(job: Job) { return run(async guard => { await d.api(`/api/jobs/${job.id}/retire`, {}); if (!guard()) return; }); },
    transfer(id: string): PendingTransfer | null { return state.account ? transfers.get(state.account + ':' + id) ?? null : null; },
    /** Another tab wrote or removed a marker (the storage event). */
    syncTransfer(storageKeyName: string | null, value: string | null) {
      if (!state.account || storageKeyName === null || !storageKeyName.startsWith(TRANSFER_PREFIX + state.account + ':')) return;
      const jobId = storageKeyName.slice((TRANSFER_PREFIX + state.account + ':').length), marker = parseTransfer(value, state.account, jobId);
      if (marker) transfers.set(state.account + ':' + jobId, marker); else transfers.delete(state.account + ':' + jobId);
      d.changed();
    },
    /** Spec UI step 3, section 4: fresh read, preconditions, wallet preflight, marker under a cross-tab lock, then the Transfer. */
    fund(job: Job) {
      return run(async guard => {
        const fresh = await d.api<Job>(`/api/jobs/${job.id}`).catch(() => null);
        if (!guard()) return;
        if (!fresh || fresh.id !== job.id || !state.account || fresh.owner !== state.account) throw new Error('4lpha: Could not read the job. Try again.');
        const dcl = fresh.grid ?? fresh.lp, closed = new Error('4lpha: Funding is not open for this job.');
        if (!(fresh.canFund === true && fresh.state === 'link_confirmed' && fresh.linkConfirmed === true && fresh.frozen !== true &&
          typeof fresh.agentAccount === 'string' && /^[0-9a-f]{64}$/.test(fresh.agentAccount) && (!dcl || dcl.registered === true) &&
          DECIMAL.test(fresh.depositYocto) && fresh.agentBalance !== null && DECIMAL.test(fresh.agentBalance))) throw closed;
        const deposit = BigInt(fresh.depositYocto), base = BigInt(fresh.agentBalance), amount = deposit - base;
        if (amount <= 0n || amount > deposit) throw closed;
        const account = state.account, receiver = fresh.agentAccount;
        if (!d.transferWallet) throw new Error('4lpha: This wallet cannot send a transfer from the page. Use the manual line on the agent page.');
        const send = await d.transferWallet(fresh, guard);
        if (!guard()) return;
        const marker: PendingTransfer = { account, jobId: fresh.id, amount: amount.toString(), baseBalance: base.toString(), at: d.now() };
        const claimed = await lock(`4lpha-fund:${account}:${fresh.id}`, async () => {
          if (transfers.has(account + ':' + fresh.id) || storedTransfer(account, fresh.id)) return 'pending';
          try { if (!d.transferStore) throw new Error(); d.transferStore.set(storageKey(account, fresh.id), JSON.stringify(marker)); }
          catch { return 'storage'; }
          transfers.set(account + ':' + fresh.id, marker);
          return 'ok';
        });
        if (claimed === 'pending') throw new Error('4lpha: A transfer is already submitted. Wait for the finalized balance.');
        if (claimed === 'storage') throw new Error('4lpha: This browser cannot record the transfer. Use the manual line on the agent page.');
        d.changed();
        if (!guard()) { dropTransfer(account, fresh.id); return; }
        try { await send(receiver, amount.toString()); }
        catch (e) {
          // Signing was invoked: a broadcast followed by a rejected promise is possible, so the marker stays.
          if (!guard()) throw undefined;
          void e;
          throw new Error('4lpha: Your wallet did not confirm. If no transfer appears in your wallet activity, you can reset it below.');
        }
        if (!guard()) return;
        state.message = 'Transfer submitted. Waiting for the finalized balance.'; d.changed();
      });
    },
    /** The owner's reset of a pending marker: acknowledged, at least two minutes old, after a successful fresh read. */
    resetTransfer(job: Job, acknowledged: boolean) {
      return run(async guard => {
        const account = state.account, marker = account ? transfers.get(account + ':' + job.id) : undefined;
        if (!account || !marker) return;
        if (!acknowledged) throw new Error('4lpha: Tick the confirmation first.');
        if (d.now() - marker.at < RESET_AFTER_MS) throw new Error('4lpha: Wait two minutes after the wallet prompt before resetting.');
        const fresh = await d.api<Job>(`/api/jobs/${job.id}`).catch(() => null);
        if (!guard()) return;
        if (!fresh || fresh.id !== job.id || fresh.agentBalance === null || !DECIMAL.test(fresh.agentBalance)) throw new Error('4lpha: Could not read the agent balance. Try again.');
        dropTransfer(account, job.id);
        d.changed();
      });
    },
  };
  return actions;
}
