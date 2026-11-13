import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { Challenge, SignedAnswer } from './auth.js';
import { CoreError, record } from './errors.js';
import type { JobKind, JobMode, JobState } from './hire.js';
import type { GridSettings, GridState } from './grid.js';
import { parseGridSettings } from './grid-settings.js';
import type { LpSettings, LpState } from './lp.js';
import { parseLpSettings } from './lp-settings.js';
import type { Caps, PolicyRules, StorePolicyPayload } from './policy.js';
import type { TradeState } from './trade.js';
import { MONEY } from './pins.js';
import { TRADE_PAIRS } from './trade-pairs.js';
import { parseTradeSettings, TRADE_LIFE_MS, type TradeSettings } from './trade-settings.js';
import { MEME, type MemeAgent, type MemeAuction, type MemeLog, type MemePosition, type MemeSettings } from './meme-paper.js';
import { rpcSchema, sqliteRpcCoordinator } from './rpc-pacing.js';
import type { DemoAgent, DemoEndReason, DemoNext } from './demo-sim.js';

export type Role = 'web' | 'worker' | 'watchdog' | 'meme' | 'demo';
export interface Job {
  id: string; owner: string; kind: JobKind; mode: JobMode; pair: string; depositYocto: bigint; caps: Caps | null;
  state: JobState; reason: string | null; version: number; walletId: string | null; agentAccount: string | null;
  walletPubkey: string | null; rules: PolicyRules | null; payload: StorePolicyPayload | null; armedHash: string | null;
  linkConfirmedAt: number | null; createdAt: number; updatedAt: number;
  gridV1: boolean; lpV1: boolean; lpV2: boolean; gridV2: boolean;
  /** Trade V1: the job has a trade_jobs row (Schedule buy or Auto DCA). */
  trade: boolean;
  /** Display only: the owner's label for the agent. It never steers an action. */
  name: string | null;
}
/** Letters, digits, spaces and . _ - only, 1 to 40 characters after trimming. */
export function parseJobName(v: unknown): string | null | 'invalid' {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return 'invalid';
  const name = v.trim().replace(/\s+/gu, ' ');
  return /^[\p{L}\p{N} ._-]{1,40}$/u.test(name) ? name : 'invalid';
}
type JobPatch = Partial<Pick<Job, 'reason' | 'walletId' | 'agentAccount' | 'walletPubkey' | 'rules' | 'caps' | 'payload' | 'armedHash' | 'linkConfirmedAt'>>;
export interface WalletSecrets { apiKeyCt: Buffer; linkCt: Buffer | null; }
export interface Reveal { id: string; jobId: string; signed: SignedAnswer; nonce: string; webPub: string; sealed: string | null; createdAt: number; }
export interface StoredAlert { id: string; jobId: string; severity: 'info' | 'halt' | 'critical'; kind: string; detail: Record<string, string>; createdAt: number; }
export interface HoldingRow { block: number; holdings: string; updatedAt: number; }
export const WALLET_ALERT_HALT = 'A wallet alert halted this job. Review the alert and your recovery options.';
export const RPC_WAIT = 'Waiting for verified chain data. No new trades will be sent; checks retry automatically.';
export const RPC_UNAVAILABLE_REASON = 'Finalized chain data is unavailable.';
export const RESUMING_REASON = 'Waiting for the worker to check readiness.';
/** Fix 4 F4-5: the reason of a job whose lost-reply halt was proven and released to the owner's Resume. */
export const RECONCILED_PAUSE = 'Submission reconciled. Sign a resume request to run the readiness checks again.';
/** Fix 4 F4-4: a redacted answer to a submission with no usable reply (no body, no secret). */
export interface NoReplySeen { kind: string; reason: string | null; http: number | null; }
/**
 * `at` is the start of the latest send of the row: the original, then each same-key re-send. `pending` is true from the start
 * of a re-send until its answer, at `answeredAt`. `stopped` ends the re-sends of a row that is not exit after a freeze (audit M-3).
 */
export interface NoReply { first: NoReplySeen | null; last: NoReplySeen | null; resends: number; at: number; answeredAt?: number; pending?: boolean; stopped?: boolean; }
const legacyBlind = (a: StoredAlert) => a.kind === 'blind' && a.severity === 'halt';
const fresh = (at: unknown, now: number): at is number => typeof at === 'number' && Number.isSafeInteger(at) && at <= now && now - at <= 60_000;
interface BlindProof { at: number; block: number; journal: string; }
export interface OpRow {
  id: string; jobId: string; walletId: string; kind: string; purpose: string; idemKey: string; request: string;
  state: 'submitted' | 'ambiguous' | 'finished'; counted: number; nativeSpend: bigint; http: number | null; code: string | null;
  requestId: string | null; txHash: string | null; verdict: string | null; used: bigint | null; nativeIn: bigint | null; gasBurnt: bigint | null;
  before: string | null; after: string | null; message: string | null; createdAt: number; submittedAt: number | null;
  finishedAt: number | null; finishedBlock: number | null;
}
export interface BudgetRow { used24h: number; used1h: number; blockedUntil: number | null; nativeSpent24h: bigint; }

const schema = `
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, created_at INT NOT NULL, expires_at INT NOT NULL);
CREATE TABLE IF NOT EXISTS challenges (nonce TEXT PRIMARY KEY, purpose TEXT NOT NULL, job_id TEXT, message TEXT NOT NULL, issued_at INT NOT NULL, used_at INT);
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL, mode TEXT NOT NULL, pair TEXT NOT NULL,
  deposit_yocto TEXT NOT NULL, caps TEXT, state TEXT NOT NULL, reason TEXT, version INT NOT NULL, wallet_id TEXT UNIQUE, agent_account TEXT UNIQUE,
  wallet_pubkey TEXT, rules TEXT, payload TEXT, armed_hash TEXT, link_confirmed_at INT, created_at INT NOT NULL, updated_at INT NOT NULL);
CREATE TABLE IF NOT EXISTS wallet_secrets (wallet_id TEXT PRIMARY KEY, api_key_ct BLOB NOT NULL, link_ct BLOB, created_at INT NOT NULL);
CREATE TABLE IF NOT EXISTS ops (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, wallet_id TEXT, kind TEXT NOT NULL, purpose TEXT NOT NULL, idem_key TEXT UNIQUE NOT NULL,
  request TEXT NOT NULL, state TEXT NOT NULL, counted INT NOT NULL, native_spend TEXT NOT NULL, http INT, code TEXT, request_id TEXT, tx_hash TEXT,
  verdict TEXT, used TEXT, native_in TEXT, gas_burnt TEXT, before TEXT, after TEXT, message TEXT, created_at INT NOT NULL, submitted_at INT, finished_at INT, finished_block INT);
CREATE UNIQUE INDEX IF NOT EXISTS active_op_wallet ON ops (wallet_id) WHERE wallet_id IS NOT NULL AND state <> 'finished';
CREATE TABLE IF NOT EXISTS reveals (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, signed TEXT NOT NULL, nonce TEXT NOT NULL, web_pub TEXT NOT NULL, sealed TEXT,
  created_at INT NOT NULL, sealed_at INT, taken_at INT);
CREATE TABLE IF NOT EXISTS alerts (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, severity TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL,
  created_at INT NOT NULL, acknowledged_at INT);
CREATE TABLE IF NOT EXISTS watch_state (job_id TEXT PRIMARY KEY, block INT NOT NULL, holdings TEXT NOT NULL, updated_at INT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS grid_jobs (job_id TEXT PRIMARY KEY REFERENCES jobs(id), registration_issued_at INT, state TEXT);
CREATE TABLE IF NOT EXISTS lp_jobs (job_id TEXT PRIMARY KEY REFERENCES jobs(id), registration_issued_at INT, state TEXT);
CREATE TABLE IF NOT EXISTS lp_settings (job_id TEXT PRIMARY KEY REFERENCES jobs(id), settings TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS grid_settings (job_id TEXT PRIMARY KEY REFERENCES jobs(id), settings TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS job_names (job_id TEXT PRIMARY KEY REFERENCES jobs(id), name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS trade_jobs (job_id TEXT PRIMARY KEY REFERENCES jobs(id), settings TEXT NOT NULL, state TEXT);
CREATE TABLE IF NOT EXISTS meme_agents (id TEXT PRIMARY KEY, owner TEXT NOT NULL, state TEXT NOT NULL, end_reason TEXT, settings TEXT NOT NULL,
  created_at INT NOT NULL, ends_at INT NOT NULL, updated_at INT NOT NULL, version INT NOT NULL);
CREATE TABLE IF NOT EXISTS meme_auctions (meme_id INT PRIMARY KEY, owner TEXT NOT NULL, start_ms INT NOT NULL, end_ms INT NOT NULL,
  last TEXT NOT NULL, samples TEXT NOT NULL, ask TEXT, outcome TEXT, token_id TEXT, pool_id INT, resolved_at INT, updated_at INT NOT NULL);
CREATE TABLE IF NOT EXISTS meme_positions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, meme_id INT NOT NULL, symbol TEXT NOT NULL,
  status TEXT NOT NULL, close_code TEXT, deposit_yocto TEXT NOT NULL, net_yocto TEXT NOT NULL, tokens TEXT, pool_id INT, token_id TEXT,
  launched_at INT, mark_yocto TEXT, mark_at INT, peak_bps INT, exit_yocto TEXT, pnl_yocto TEXT, opened_at INT NOT NULL, closed_at INT,
  version INT NOT NULL, UNIQUE(agent_id,meme_id));
CREATE TABLE IF NOT EXISTS meme_log (id TEXT PRIMARY KEY, agent_id TEXT, kind TEXT NOT NULL, meme_id INT, at INT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS meme_log_agent_at ON meme_log(agent_id,at);
CREATE INDEX IF NOT EXISTS meme_log_meme_at ON meme_log(meme_id,at);
`;
// Demo mode 3.1: these exist only in a demo instance's database (the demo process, seed.js, or a web with FOURLPHA_DEMO=1), never next to live tables by default.
const demoSchema = `
CREATE TABLE IF NOT EXISTS demo_agents (id TEXT PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL, pair TEXT NOT NULL, state TEXT NOT NULL, end_reason TEXT,
  settings TEXT NOT NULL, deposit_yocto TEXT NOT NULL, sim TEXT, seed INT NOT NULL, created_at INT NOT NULL, ends_at INT NOT NULL, updated_at INT NOT NULL, version INT NOT NULL);
CREATE TABLE IF NOT EXISTS demo_log (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, at INT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS demo_log_agent_at ON demo_log(agent_id,at);
`;
/** Demo mode D-1: visitor caps; seeds (operator showcase agents) skip them. Grid and LP run 7 days (seeds 14), the trade kinds the live 6-day life. */
export const DEMO_LIMITS = { perOwner: 3, total: 100, day: 86_400_000 } as const;
const DEMO_REASONS: readonly DemoEndReason[] = ['owner-stopped', 'operator-stopped', 'term-ended', 'stop-loss', 'take-profit', 'budget', 'runs', 'date', 'tp', 'sl', 'reserve'];
const DEMO_ACTIVE = "('running','stopping')";

type Row = NonNullable<ReturnType<ReturnType<DatabaseSync['prepare']>['get']>>;
export function json(v: unknown): string { return JSON.stringify(v, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value); }
function nullable<T>(v: unknown): T | null { return v == null ? null : v as T; }
function fromJson<T>(v: unknown): T { return JSON.parse(String(v)) as T; }
function capsFrom(v: unknown): Caps | null {
  if (v == null) return null;
  const c = fromJson<{ nativePerTx: string; nativeDaily: string; tokenPerTx: Record<string, string>; tokenDaily: Record<string, string> }>(v);
  const parse = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([k, val]) => [k, BigInt(val)]));
  return { nativePerTx: BigInt(c.nativePerTx), nativeDaily: BigInt(c.nativeDaily), tokenPerTx: parse(c.tokenPerTx), tokenDaily: parse(c.tokenDaily) };
}
function jobFrom(r: Row): Job {
  return { id: String(r.id), owner: String(r.owner), kind: r.kind as JobKind, mode: r.mode as JobMode, pair: String(r.pair), depositYocto: BigInt(String(r.deposit_yocto)),
    caps: capsFrom(r.caps), state: r.state as JobState, reason: nullable(r.reason), version: Number(r.version), walletId: nullable(r.wallet_id),
    agentAccount: nullable(r.agent_account), walletPubkey: nullable(r.wallet_pubkey), rules: fromJson(r.rules), payload: fromJson(r.payload), armedHash: nullable(r.armed_hash),
    linkConfirmedAt: nullable(r.link_confirmed_at), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at), gridV1: r.grid_v1 === 1, lpV1: r.lp_v1 === 1, lpV2: r.lp_v2 === 1, gridV2: r.grid_v2 === 1, trade: r.trade_v1 === 1, name: nullable(r.job_name) };
}
const jobCols = { reason: 'reason', walletId: 'wallet_id', agentAccount: 'agent_account', walletPubkey: 'wallet_pubkey', rules: 'rules', caps: 'caps',
  payload: 'payload', armedHash: 'armed_hash', linkConfirmedAt: 'link_confirmed_at' } as const;
const opCols: Record<keyof OpRow, string> = { id: 'id', jobId: 'job_id', walletId: 'wallet_id', kind: 'kind', purpose: 'purpose', idemKey: 'idem_key',
  request: 'request', state: 'state', counted: 'counted', nativeSpend: 'native_spend', http: 'http', code: 'code', requestId: 'request_id', txHash: 'tx_hash',
  verdict: 'verdict', used: 'used', nativeIn: 'native_in', gasBurnt: 'gas_burnt', before: 'before', after: 'after', message: 'message', createdAt: 'created_at',
  submittedAt: 'submitted_at', finishedAt: 'finished_at', finishedBlock: 'finished_block' };
const opKeys = Object.keys(opCols) as (keyof OpRow)[];
function opFrom(r: Row): OpRow {
  const o = Object.fromEntries(opKeys.map(k => [k, r[opCols[k]]])) as unknown as OpRow;
  return { ...o, nativeSpend: BigInt(o.nativeSpend), used: o.used === null ? null : BigInt(o.used), nativeIn: o.nativeIn === null ? null : BigInt(o.nativeIn),
    gasBurnt: o.gasBurnt === null ? null : BigInt(o.gasBurnt) };
}
function sql(v: unknown): SQLInputValue { return v == null ? null : typeof v === 'string' || typeof v === 'number' ? v : typeof v === 'bigint' ? v.toString() : json(v); }
type WorkerLock = { pid: number; instance: string; heartbeat: number };
const TERMINAL = "('stopped','failed','cancelled','retired')";
export const RETIRE_REASON = 'Retired by the owner. The agent wallet held only dust.';
const RETIRE_OP_MESSAGE = 'Closed at retire. This submission was never resolved; the wallet held only dust.';
const PENDING = "('draft','registered','policy_prepared','armed','link_confirmed','funded')";
const JOBS = 'SELECT jobs.*, EXISTS(SELECT 1 FROM grid_jobs WHERE job_id=jobs.id) AS grid_v1, EXISTS(SELECT 1 FROM lp_jobs WHERE job_id=jobs.id) AS lp_v1, EXISTS(SELECT 1 FROM lp_settings WHERE job_id=jobs.id) AS lp_v2, EXISTS(SELECT 1 FROM grid_settings WHERE job_id=jobs.id) AS grid_v2, EXISTS(SELECT 1 FROM trade_jobs WHERE job_id=jobs.id) AS trade_v1, (SELECT name FROM job_names WHERE job_id=jobs.id) AS job_name FROM jobs';
const memeAgentCols: Record<keyof MemeAgent, string> = { id: 'id', owner: 'owner', state: 'state', endReason: 'end_reason', settings: 'settings',
  createdAt: 'created_at', endsAt: 'ends_at', updatedAt: 'updated_at', version: 'version' };
const memeAuctionCols: Record<keyof MemeAuction, string> = { memeId: 'meme_id', owner: 'owner', startMs: 'start_ms', endMs: 'end_ms', last: 'last',
  samples: 'samples', ask: 'ask', outcome: 'outcome', tokenId: 'token_id', poolId: 'pool_id', resolvedAt: 'resolved_at', updatedAt: 'updated_at' };
const memePositionCols: Record<keyof MemePosition, string> = { id: 'id', agentId: 'agent_id', memeId: 'meme_id', symbol: 'symbol', status: 'status',
  closeCode: 'close_code', depositYocto: 'deposit_yocto', netYocto: 'net_yocto', tokens: 'tokens', poolId: 'pool_id', tokenId: 'token_id',
  launchedAt: 'launched_at', markYocto: 'mark_yocto', markAt: 'mark_at', peakBps: 'peak_bps', exitYocto: 'exit_yocto', pnlYocto: 'pnl_yocto',
  openedAt: 'opened_at', closedAt: 'closed_at', version: 'version' };
function memeAgentFrom(r: Row): MemeAgent {
  const a = Object.fromEntries(Object.entries(memeAgentCols).map(([k, c]) => [k, r[c]])) as unknown as MemeAgent;
  return { ...a, settings: fromJson(r.settings) };
}
function memeLogFrom(r: Row): MemeLog {
  return { id: String(r.id), agentId: nullable(r.agent_id), kind: r.kind as MemeLog['kind'], memeId: nullable(r.meme_id), at: Number(r.at), data: fromJson(r.data) };
}
function memeAuctionFrom(r: Row): MemeAuction {
  const a = Object.fromEntries(Object.entries(memeAuctionCols).map(([k, c]) => [k, r[c]])) as unknown as MemeAuction;
  return { ...a, last: fromJson(r.last), samples: fromJson(r.samples), ask: fromJson(r.ask) };
}
function memePositionFrom(r: Row): MemePosition { return Object.fromEntries(Object.entries(memePositionCols).map(([k, c]) => [k, r[c]])) as unknown as MemePosition; }
function demoAgentFrom(r: Row): DemoAgent {
  return { id: String(r.id), owner: String(r.owner), kind: r.kind as DemoAgent['kind'], pair: String(r.pair), state: r.state as DemoAgent['state'], endReason: nullable(r.end_reason),
    settings: fromJson(r.settings), depositYocto: String(r.deposit_yocto), sim: r.sim == null ? null : fromJson(r.sim), seed: Number(r.seed), createdAt: Number(r.created_at),
    endsAt: Number(r.ends_at), updatedAt: Number(r.updated_at), version: Number(r.version) };
}

export class Store {
  readonly #db: DatabaseSync;
  #instance: string | null = null;
  constructor(path: string, readonly role: Role, demo = role === 'demo') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    this.#db.exec(schema);
    // Demo mode D-7: a demo store never opens a database that carries live money, and refuses before any demo table is created in it.
    if (demo && (this.activeJobs().length > 0 || this.readHeartbeat('worker') !== null)) {
      this.#db.close(); throw new CoreError('forbidden', 'A demo store cannot open a database with a live job or a worker heartbeat.');
    }
    if (demo) this.#db.exec(demoSchema);
    this.#db.exec(rpcSchema);
  }
  close() { this.#db.close(); }
  rpcCoordinator() {
    return sqliteRpcCoordinator(this.#db, this.role, (fn, lockBudget) => {
      if (lockBudget === undefined || lockBudget >= 5000) return this.#tx(fn);
      this.#db.exec(`PRAGMA busy_timeout=${lockBudget}`);
      try { return this.#tx(fn); }
      finally { this.#db.exec('PRAGMA busy_timeout=5000'); }
    });
  }
  #only(role: Role) { if (this.role !== role) throw new CoreError('forbidden', 'This process cannot perform that store action.'); }
  #one(q: string, ...p: SQLInputValue[]) { return this.#db.prepare(q).get(...p); }
  #all(q: string, ...p: SQLInputValue[]) { return this.#db.prepare(q).all(...p); }
  #run(q: string, ...p: SQLInputValue[]) { return this.#db.prepare(q).run(...p).changes !== 0; }
  #tx<T>(fn: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.#db.exec('COMMIT'); return result; }
    catch (e) { this.#db.exec('ROLLBACK'); throw e; }
  }
  createJob(i: Pick<Job, 'owner' | 'kind' | 'mode' | 'pair' | 'depositYocto'> & { gridV1?: boolean; lpV1?: boolean; lpSettings?: LpSettings; gridSettings?: GridSettings; tradeSettings?: TradeSettings; name?: string }, now: number, max = MONEY.maxLiveJobs): Job {
    this.#only('web');
    return this.#tx(() => {
      const { live, pending } = this.jobCounts(i.owner);
      if (live >= max || pending > 0) throw new CoreError('limit_reached', 'A hire is already pending or the live job limit was reached.');
      const id = randomUUID();
      this.#run("INSERT INTO jobs (id,owner,kind,mode,pair,deposit_yocto,state,version,created_at,updated_at) VALUES (?,?,?,?,?,?,'draft',0,?,?)",
        id, i.owner, i.kind, i.mode, i.pair, i.depositYocto.toString(), now, now);
      if (i.gridV1) this.#run('INSERT INTO grid_jobs (job_id) VALUES (?)', id);
      if (i.lpV1) this.#run('INSERT INTO lp_jobs (job_id) VALUES (?)', id);
      if (i.lpSettings) {
        if (i.kind !== 'lp' || !i.lpV1 || i.gridV1 || parseLpSettings(i.lpSettings) === 'invalid') throw new CoreError('bad_request', 'Invalid LP settings.');
        this.#run('INSERT INTO lp_settings (job_id,settings) VALUES (?,?)', id, json(i.lpSettings));
      }
      if (i.name !== undefined) {
        const name = parseJobName(i.name);
        if (name === 'invalid' || name === null) throw new CoreError('bad_request', 'Invalid agent name.');
        this.#run('INSERT INTO job_names (job_id,name) VALUES (?,?)', id, name);
      }
      if (i.gridSettings) {
        const g = parseGridSettings(i.gridSettings);
        if (i.kind !== 'grid' || !i.gridV1 || i.lpV1 || i.lpSettings || g === 'invalid') throw new CoreError('bad_request', 'Invalid Grid settings.');
        this.#run('INSERT INTO grid_settings (job_id,settings) VALUES (?,?)', id, json(g));
        // Spec 2c section 2: an independent V2 marker, written before any strategy state exists.
        this.#run('INSERT INTO meta VALUES (?,?)', `grid_v2:${id}`, String(g.step));
      }
      // Trade V1 5.1: the settings are written once with the job and never updated; a trade kind never runs without them.
      if (i.tradeSettings || i.kind === 'schedule' || i.kind === 'dca') {
        const t = i.tradeSettings ? parseTradeSettings(i.tradeSettings) : 'invalid';
        if (t === 'invalid' || t.strategy !== i.kind || i.gridV1 || i.lpV1 || i.lpSettings || i.gridSettings || !TRADE_PAIRS.some(p => p.id === i.pair)) {
          throw new CoreError('bad_request', 'Invalid trade settings.');
        }
        this.#run('INSERT INTO trade_jobs (job_id,settings) VALUES (?,?)', id, json(t));
      }
      return this.getJob(id)!;
    });
  }
  jobCounts(owner: string): { live: number; pending: number } {
    return { live: Number(this.#one(`SELECT count(*) n FROM jobs WHERE mode='live' AND state NOT IN ${TERMINAL}`)?.n),
      pending: Number(this.#one(`SELECT count(*) n FROM jobs WHERE mode='live' AND owner=? AND state IN ${PENDING}`, owner)?.n) };
  }
  getJob(id: string): Job | null { const r = this.#one(`${JOBS} WHERE id=?`, id); return r ? jobFrom(r) : null; }
  jobByWallet(id: string): Job | null { const r = this.#one(`${JOBS} WHERE wallet_id=?`, id); return r ? jobFrom(r) : null; }
  listJobs(owner: string): Job[] { return this.#all(`${JOBS} WHERE owner=? ORDER BY created_at DESC`, owner).map(jobFrom); }
  activeJobs(): Job[] { return this.#all(`${JOBS} WHERE mode='live' AND state NOT IN ${TERMINAL} ORDER BY created_at`).map(jobFrom); }
  grid(jobId: string): { state: GridState | null; issued: boolean } | null {
    const r = this.#one('SELECT state,registration_issued_at FROM grid_jobs WHERE job_id=?', jobId);
    return r ? { state: fromJson(r.state), issued: r.registration_issued_at !== null } : null;
  }
  lp(jobId: string): { state: LpState | null; issued: boolean } | null {
    const r = this.#one('SELECT state,registration_issued_at FROM lp_jobs WHERE job_id=?', jobId);
    return r ? { state: fromJson(r.state), issued: r.registration_issued_at !== null } : null;
  }
  lpSettings(jobId: string): LpSettings | null | 'invalid' {
    const row = this.#one('SELECT settings FROM lp_settings WHERE job_id=?', jobId);
    if (!row) return null;
    try { return parseLpSettings(fromJson(row.settings)); } catch { return 'invalid'; }
  }
  gridSettings(jobId: string): GridSettings | null | 'invalid' {
    const row = this.#one('SELECT settings FROM grid_settings WHERE job_id=?', jobId);
    if (!row) return null;
    try { return parseGridSettings(fromJson(row.settings)); } catch { return 'invalid'; }
  }
  trade(jobId: string): { settings: TradeSettings | 'invalid'; state: TradeState | null } | null {
    const r = this.#one('SELECT settings,state FROM trade_jobs WHERE job_id=?', jobId);
    if (!r) return null;
    let settings: TradeSettings | 'invalid';
    try { settings = parseTradeSettings(fromJson(r.settings)); } catch { settings = 'invalid'; }
    return { settings, state: fromJson(r.state) };
  }
  /** Retire spec 2.2 step 5: the only way into `retired`. It closes the wallet's old ambiguous row in the same transaction. */
  retireJob(job: Job, opId: string | null, now: number): boolean {
    this.#only('web');
    return this.#tx(() => {
      if (!['halted', 'paused', 'frozen'].includes(job.state) || !this.#one('SELECT 1 FROM jobs WHERE id=? AND state=? AND version=?', job.id, job.state, job.version)) return false;
      const op = this.inFlightOp(job.walletId ?? '');
      if ((op?.id ?? null) !== opId || (op && (op.state !== 'ambiguous' || op.jobId !== job.id))) return false;
      if (op) this.#run("UPDATE ops SET state='finished',verdict='unknown',message=?,finished_at=? WHERE id=? AND state='ambiguous'", RETIRE_OP_MESSAGE, now, op.id);
      return this.#cas(job.id, job.state, job.version, 'retired', { reason: RETIRE_REASON }, now);
    });
  }
  issueDclRegistration(job: Job, sessionHash: string, now: number): boolean {
    this.#only('web');
    const table = job.lpV1 ? 'lp_jobs' : 'grid_jobs';
    return this.#tx(() => {
      const heartbeat = this.readHeartbeat('watchdog');
      return this.getSession(sessionHash, now)?.accountId === job.owner && heartbeat !== null && Number.isSafeInteger(heartbeat) && heartbeat <= now && now - heartbeat <= 60_000 &&
        !this.watchWaiting(job.id) && !this.openAlerts(job.id).some(a => a.severity !== 'info') && !this.inFlightOp(job.walletId ?? '') &&
        this.#run(`UPDATE ${table} SET registration_issued_at=? WHERE job_id=? AND registration_issued_at IS NULL
        AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND owner=? AND state='link_confirmed' AND link_confirmed_at IS NOT NULL AND version=?)`,
        now, job.id, job.id, job.owner, job.version);
    });
  }
  saveGrid(job: Job, from: GridState | null, to: GridState): boolean {
    this.#only('worker');
    return this.#tx(() => this.ownsWorkerLock() && this.#run(`UPDATE grid_jobs SET state=? WHERE job_id=? AND state IS ?
      AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND state='running' AND version=?)`, json(to), job.id, from === null ? null : json(from), job.id, job.version));
  }
  saveLp(job: Job, from: LpState | null, to: LpState): boolean {
    this.#only('worker');
    return this.#tx(() => this.ownsWorkerLock() && this.#run(`UPDATE lp_jobs SET state=? WHERE job_id=? AND state IS ?
      AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND state='running' AND version=?)`, json(to), job.id, from === null ? null : json(from), job.id, job.version));
  }
  saveTrade(job: Job, from: TradeState | null, to: TradeState): boolean {
    this.#only('worker');
    return this.#tx(() => this.ownsWorkerLock() && this.#run(`UPDATE trade_jobs SET state=? WHERE job_id=? AND state IS ?
      AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND state='running' AND version=?)`, json(to), job.id, from === null ? null : json(from), job.id, job.version));
  }
  /**
   * Trade V1 10.4: every trade end in one transaction, as protectStop. A row-less pending step is dropped; a journaled one is never dropped,
   * except the settled take-profit sale that `to` applies.
   */
  tradeStop(job: Job, from: TradeState, to: TradeState, reason: string): boolean {
    this.#only('worker');
    return this.#tx(() => {
      const done = to.done, row = from.pending ? this.gridStep(job.id, from.pending.id) : null;
      const sale = row?.kind === 'swap' && fromJson<{ swap?: { unwrapNear?: boolean } }>(row.request).swap?.unwrapNear === true;
      if (!job.trade || !done || to.pending !== null || !this.ownsWorkerLock() || this.inFlightOp(job.walletId ?? '') ||
        (row && !(done.kind === 'tp' && sale && row.state === 'finished' && row.verdict === 'swapped')) ||
        !this.#one('SELECT 1 FROM trade_jobs WHERE job_id=? AND state=?', job.id, json(from)) ||
        !this.#cas(job.id, 'running', job.version, 'stopping', { reason }, done.at)) return false;
      this.#run('UPDATE trade_jobs SET state=? WHERE job_id=?', json(to), job.id);
      if (!this.#one("SELECT 1 FROM alerts WHERE job_id=? AND kind='trade_done'", job.id)) this.#run('INSERT INTO alerts VALUES (?,?,?,?,?,?,NULL)',
        randomUUID(), job.id, 'info', 'trade_done', json({ kind: done.kind, message: reason }), done.at);
      return true;
    });
  }
  protectStop(job: Job, from: LpState, to: LpState): boolean {
    this.#only('worker');
    return this.#tx(() => {
      const settings = this.lpSettings(job.id), fired = to.protect?.fired;
      if (!job.lpV2 || !settings || settings === 'invalid' || !fired ||
        !(fired.kind === 'stop-loss' ? settings.stopLossPct > 0 : fired.kind === 'take-profit' && settings.takeProfitPct > 0) ||
        !this.ownsWorkerLock() || this.inFlightOp(job.walletId ?? '') || (from.pending && this.gridStep(job.id, from.pending.id)) ||
        !this.#one('SELECT 1 FROM lp_jobs WHERE job_id=? AND state=?', job.id, json(from)) ||
        !this.#cas(job.id, 'running', job.version, 'stopping', { reason: 'LP protection confirmed. Stop and withdraw.' }, fired.at)) return false;
      this.#run('UPDATE lp_jobs SET state=? WHERE job_id=?', json(to), job.id);
      if (!this.#one("SELECT 1 FROM alerts WHERE job_id=? AND kind='protect_stop'", job.id)) this.#run('INSERT INTO alerts VALUES (?,?,?,?,?,?,NULL)',
        randomUUID(), job.id, 'info', 'protect_stop', json({ ...fired, message: `LP ${fired.kind} confirmed. Stop and withdraw.` }), fired.at);
      return true;
    });
  }
  gridProtectStop(job: Job, from: GridState, to: GridState): boolean {
    this.#only('worker');
    return this.#tx(() => {
      const settings = this.gridSettings(job.id), fired = to.protect?.fired;
      if (!job.gridV2 || !settings || settings === 'invalid' || !fired ||
        !(fired.kind === 'stop-loss' ? settings.stopLossPct > 0 : fired.kind === 'take-profit' && settings.takeProfitPct > 0) ||
        !this.ownsWorkerLock() || this.inFlightOp(job.walletId ?? '') || (from.pending && this.gridStep(job.id, from.pending.id)) ||
        !this.#one('SELECT 1 FROM grid_jobs WHERE job_id=? AND state=?', job.id, json(from)) ||
        !this.#cas(job.id, 'running', job.version, 'stopping', { reason: 'Grid protection confirmed. Stop and withdraw.' }, fired.at)) return false;
      this.#run('UPDATE grid_jobs SET state=? WHERE job_id=?', json(to), job.id);
      if (!this.#one("SELECT 1 FROM alerts WHERE job_id=? AND kind='protect_stop'", job.id)) this.#run('INSERT INTO alerts VALUES (?,?,?,?,?,?,NULL)',
        randomUUID(), job.id, 'info', 'protect_stop', json({ ...fired, message: `Grid ${fired.kind} confirmed. Stop and withdraw.` }), fired.at);
      return true;
    });
  }
  casJob(id: string, from: JobState, version: number, to: JobState, patch: JobPatch = {}, now = Date.now()): boolean {
    // Demo mode 3.2: allow-list, so a new role is refused by default. Only the web and the worker change jobs.
    if (this.role === 'watchdog') throw new CoreError('forbidden', 'The watchdog cannot change jobs.');
    if (this.role !== 'web') this.#only('worker');
    if (from === 'halted' && to !== 'halted' && to !== 'stopping') return false;
    if (from === 'retired' || to === 'retired') return false; // Retire spec 2.1: only retireJob enters `retired`, and nothing leaves it.
    if (this.role === 'worker' && from === 'running' && to === 'stopping') return false; // Only protectStop may stop strategy without the owner.
    if (this.role === 'web' && (Object.keys(patch).some(k => k !== 'reason' && k !== 'linkConfirmedAt') ||
      !['link_confirmed', 'cancelled', 'resuming', 'stopping'].includes(to))) throw new CoreError('forbidden', 'The web process cannot make that job change.');
    if (['walletId', 'agentAccount'].some(k => Object.hasOwn(patch, k))) throw new CoreError('forbidden', 'Wallet identity is immutable.');
    if (this.role === 'worker' && ((to === 'ready' && ['funded', 'resuming'].includes(from)) || (from === 'ready' && to === 'running'))) {
      return this.#tx(() => !this.watchWaiting(id) && !this.openAlerts(id).some(a => a.severity !== 'info') && this.#cas(id, from, version, to, patch, now));
    }
    return this.#cas(id, from, version, to, patch, now);
  }
  #cas(id: string, from: JobState, version: number, to: JobState, patch: JobPatch, now: number): boolean {
    const keys = Object.keys(patch) as (keyof JobPatch)[];
    return this.#run(`UPDATE jobs SET state=?,version=version+1,updated_at=?${keys.map(k => `,${jobCols[k]}=?`).join('')} WHERE id=? AND state=? AND version=?`,
      to, now, ...keys.map(k => sql(patch[k])), id, from, version);
  }
  attachWallet(job: Job, walletId: string, agentAccount: string, secrets: WalletSecrets, now: number): boolean {
    this.#only('worker');
    return this.#tx(() => {
      const current = this.getJob(job.id);
      if (!current || current.owner !== job.owner || current.walletId || !['draft', 'cancelled'].includes(current.state) ||
        this.jobByWallet(walletId) || this.#one('SELECT id FROM jobs WHERE agent_account=?', agentAccount)) return false;
      if (!this.#cas(current.id, current.state, current.version, current.state === 'draft' ? 'registered' : 'cancelled', { walletId, agentAccount }, now)) return false;
      this.putSecrets(walletId, secrets, now);
      return true;
    });
  }
  putSecrets(walletId: string, secrets: WalletSecrets, now: number) {
    this.#only('worker');
    this.#run('INSERT INTO wallet_secrets (wallet_id,api_key_ct,link_ct,created_at) VALUES (?,?,?,?)', walletId, secrets.apiKeyCt, secrets.linkCt, now);
  }
  getSecrets(walletId: string): WalletSecrets | null {
    this.#only('worker');
    const r = this.#one('SELECT api_key_ct,link_ct FROM wallet_secrets WHERE wallet_id=?', walletId);
    return r ? { apiKeyCt: Buffer.from(r.api_key_ct as Uint8Array), linkCt: r.link_ct ? Buffer.from(r.link_ct as Uint8Array) : null } : null;
  }
  insertOp(op: OpRow, expected?: { version: number; state: JobState; now: number }): boolean {
    this.#only('worker');
    return this.#tx(() => {
      if (!this.ownsWorkerLock() || this.inFlightOp(op.walletId)) return false;
      const bound = this.jobByWallet(op.walletId);
      if (bound && bound.id !== op.jobId) return false;
      if (op.purpose !== 'exit' && (this.watchWaiting(op.jobId) || this.openAlerts(op.jobId).some(a => a.severity !== 'info'))) return false;
      if (expected) {
        const job = this.getJob(op.jobId), heartbeat = this.readHeartbeat('watchdog');
        if (!job || job.walletId !== op.walletId || job.version !== expected.version || job.state !== expected.state ||
          (op.purpose !== 'exit' && !fresh(heartbeat, expected.now))) return false;
      }
      const step = fromJson<{ step?: string }>(op.request).step;
      if (step && ((this.grid(op.jobId) ?? this.lp(op.jobId) ?? this.trade(op.jobId))?.state?.pending?.id !== step || this.gridStep(op.jobId, step))) return false;
      return this.#run(`INSERT INTO ops (${opKeys.map(k => opCols[k]).join(',')}) VALUES (${opKeys.map(() => '?').join(',')})`, ...opKeys.map(k => sql(op[k])));
    });
  }
  countPolicyOp(job: Job, kind: 'encrypt_policy' | 'sign_policy', now: number): boolean {
    this.#only('worker');
    const id = randomUUID();
    return this.#tx(() => this.ownsWorkerLock() && !this.watchWaiting(job.id) && !this.openAlerts(job.id).some(a => a.severity !== 'info') &&
      this.#run(`INSERT INTO ops (id,job_id,wallet_id,kind,purpose,idem_key,request,state,counted,native_spend,created_at,submitted_at,finished_at)
      VALUES (?,?,?,?,'setup',?,'{}','finished',1,'0',?,?,?)`, id, job.id, job.walletId, kind, id, now, now, now));
  }
  updateOp(id: string, patch: Partial<Pick<OpRow, 'state' | 'counted' | 'nativeSpend' | 'http' | 'code' | 'requestId' | 'txHash' | 'verdict' | 'used' | 'nativeIn' | 'gasBurnt' | 'after' | 'message' | 'finishedAt' | 'finishedBlock'>>): boolean {
    this.#only('worker');
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    return this.#run(`UPDATE ops SET ${keys.map(k => `${opCols[k]}=?`).join(',')} WHERE id=? AND state<>'finished'`, ...keys.map(k => sql(patch[k])), id);
  }
  inFlightOp(walletId: string): OpRow | null { const r = this.#one("SELECT * FROM ops WHERE wallet_id=? AND state<>'finished'", walletId); return r ? opFrom(r) : null; }
  inFlightOps(): OpRow[] { return this.#all("SELECT * FROM ops WHERE state<>'finished'").map(opFrom); }
  opsSince(walletId: string, block: number): OpRow[] { return this.#all("SELECT * FROM ops WHERE wallet_id=? AND state='finished' AND finished_block>? ORDER BY finished_block", walletId, block).map(opFrom); }
  jobOps(jobId: string): OpRow[] { return this.#all('SELECT * FROM ops WHERE job_id=? ORDER BY created_at DESC,id', jobId).map(opFrom); }
  watchJournal(jobId: string): string {
    // Strategy state participates in DCL identity checks even when the operations have not changed.
    return createHash('sha256').update(json([this.jobOps(jobId), this.grid(jobId), this.lp(jobId), this.gridSettings(jobId), this.lpSettings(jobId)])).digest('hex');
  }
  gridStep(jobId: string, step: string): OpRow | null {
    const r = this.#one("SELECT * FROM ops WHERE job_id=? AND json_extract(request,'$.step')=?", jobId, step);
    return r ? opFrom(r) : null;
  }
  budgetView(walletId: string, now: number): BudgetRow {
    const rows = this.#all('SELECT submitted_at,native_spend FROM ops WHERE wallet_id=? AND counted=1 AND submitted_at>?', walletId, now - 86_400_000);
    const block = Number(this.meta(`quota:${walletId}`));
    return { used24h: rows.length, used1h: rows.filter(r => Number(r.submitted_at) > now - 3_600_000).length,
      nativeSpent24h: rows.reduce((total, r) => total + BigInt(String(r.native_spend)), 0n), blockedUntil: block > now ? block : null };
  }
  recentOps(walletId: string, now: number): OpRow[] { return this.#all('SELECT * FROM ops WHERE wallet_id=? AND counted=1 AND submitted_at>? ORDER BY submitted_at DESC', walletId, now - 86_400_000).map(opFrom); }
  putChallenge(c: Challenge) { this.#only('web'); this.#run('INSERT INTO challenges VALUES (?,?,?,?,?,NULL)', c.nonce, c.purpose, c.jobId, c.message, c.issuedAt); }
  getChallenge(nonce: string): Challenge | null {
    const r = this.#one('SELECT * FROM challenges WHERE nonce=? AND used_at IS NULL', nonce);
    return r ? { nonce, purpose: r.purpose as Challenge['purpose'], jobId: nullable(r.job_id), message: String(r.message), issuedAt: Number(r.issued_at) } : null;
  }
  useChallenge(c: Challenge, now: number): boolean {
    // Allow-list (demo mode 3.2): only the web and the worker (reveal sealing) use challenges.
    if (this.role === 'watchdog') throw new CoreError('forbidden', 'The watchdog cannot use challenges.');
    if (this.role !== 'worker') this.#only('web');
    return this.#run('UPDATE challenges SET used_at=? WHERE nonce=? AND used_at IS NULL AND purpose=? AND job_id IS ? AND message=? AND issued_at=? AND issued_at>? AND issued_at<=?',
      now, c.nonce, c.purpose, c.jobId, c.message, c.issuedAt, now - 300_000, now);
  }
  putSession(hash: string, account: string, created: number, expires: number) { this.#only('web'); this.#run('INSERT INTO sessions VALUES (?,?,?,?)', hash, account, created, expires); }
  getSession(hash: string, now: number): { accountId: string } | null {
    this.#only('web'); const r = this.#one('SELECT account_id FROM sessions WHERE token_hash=? AND expires_at>?', hash, now);
    return r ? { accountId: String(r.account_id) } : null;
  }
  deleteSession(hash: string) { this.#only('web'); this.#run('DELETE FROM sessions WHERE token_hash=?', hash); }
  insertReveal(r: Reveal) { this.#only('web'); this.#run('INSERT INTO reveals VALUES (?,?,?,?,?,NULL,?,NULL,NULL)', r.id, r.jobId, json(r.signed), r.nonce, r.webPub, r.createdAt); }
  #revealFrom(r: Row): Reveal { return { id: String(r.id), jobId: String(r.job_id), signed: fromJson(r.signed), nonce: String(r.nonce), webPub: String(r.web_pub), sealed: nullable(r.sealed), createdAt: Number(r.created_at) }; }
  getReveal(id: string): Reveal | null { const r = this.#one('SELECT * FROM reveals WHERE id=?', id); return r ? this.#revealFrom(r) : null; }
  pendingReveals(): Reveal[] { this.#only('worker'); return this.#all('SELECT * FROM reveals WHERE sealed_at IS NULL').map(r => this.#revealFrom(r)); }
  sealReveal(r: Reveal, sealed: string, c: Challenge, now: number): boolean {
    this.#only('worker');
    return this.#tx(() => {
      if (!this.#one('SELECT 1 FROM reveals WHERE id=? AND job_id=? AND nonce=? AND web_pub=? AND signed=? AND sealed_at IS NULL AND created_at>?',
        r.id, r.jobId, r.nonce, r.webPub, json(r.signed), now - 60_000) || !this.useChallenge(c, now)) return false;
      return this.#run('UPDATE reveals SET sealed=?,sealed_at=? WHERE id=?', sealed, now, r.id);
    });
  }
  takeReveal(r: Reveal, now: number): boolean {
    this.#only('web');
    return this.#tx(() => {
      if (!r.sealed || !this.#run('DELETE FROM reveals WHERE id=? AND job_id=? AND sealed=? AND created_at>?', r.id, r.jobId, r.sealed, now - 60_000)) return false;
      this.setMeta(`reveal_delivered:${r.jobId}`, String(now));
      return true;
    });
  }
  expireReveals(now: number) { this.#only('worker'); this.#run('DELETE FROM reveals WHERE created_at<=?', now - 60_000); }
  insertAlert(a: Omit<StoredAlert, 'id'>): boolean {
    // Allow-list (demo mode 3.2): only the worker and the watchdog create alerts.
    if (this.role === 'web') throw new CoreError('forbidden', 'The web process cannot create alerts.');
    if (this.role !== 'worker') this.#only('watchdog');
    return this.#tx(() => {
      if ((a.severity !== 'info' || a.kind === 'blind') && this.#one('SELECT 1 FROM alerts WHERE job_id=? AND kind=? AND severity=? AND acknowledged_at IS NULL', a.jobId, a.kind, a.severity)) return false;
      return this.#run('INSERT INTO alerts VALUES (?,?,?,?,?,?,NULL)', randomUUID(), a.jobId, a.severity, a.kind, json(a.detail), a.createdAt);
    });
  }
  openAlerts(jobId: string): StoredAlert[] {
    return this.#all('SELECT * FROM alerts WHERE job_id=? AND acknowledged_at IS NULL ORDER BY created_at DESC', jobId)
      .map(r => ({ id: String(r.id), jobId, severity: r.severity as StoredAlert['severity'], kind: String(r.kind), detail: fromJson(r.detail), createdAt: Number(r.created_at) }));
  }
  getWatch(jobId: string): HoldingRow | null {
    const r = this.#one('SELECT * FROM watch_state WHERE job_id=?', jobId);
    return r ? { block: Number(r.block), holdings: String(r.holdings), updatedAt: Number(r.updated_at) } : null;
  }
  putWatch(jobId: string, r: HoldingRow) {
    this.#only('watchdog'); this.#run('INSERT INTO watch_state VALUES (?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET block=excluded.block,holdings=excluded.holdings,updated_at=excluded.updated_at', jobId, r.block, r.holdings, r.updatedAt);
  }
  watchWaiting(jobId: string): boolean {
    const value = this.meta(`watch_blind:${jobId}`);
    return value !== null && value !== '0';
  }
  invalidateWatch(jobId: string, blind = false): number {
    this.#only('watchdog');
    return this.#tx(() => {
      this.#run('DELETE FROM meta WHERE key=?', `watch_clean:${jobId}`);
      if (!blind) return 0;
      const key = `watch_blind:${jobId}`, value = Number(this.meta(key) ?? '0');
      const count = Number.isSafeInteger(value) && value >= 0 ? Math.min(value + 1, Number.MAX_SAFE_INTEGER) : 1;
      this.setMeta(key, String(count));
      return count;
    });
  }
  finishWatch(job: Job, old: HoldingRow | null, next: HoldingRow, journal: string, blind: string | null, safePolicy: boolean): void {
    this.#only('watchdog');
    this.#tx(() => {
      const key = `watch_clean:${job.id}`;
      this.#run('DELETE FROM meta WHERE key=?', key);
      if (!Number.isSafeInteger(next.block) || next.block <= (old?.block ?? 0) || !Number.isSafeInteger(next.updatedAt) ||
        this.getJob(job.id)?.version !== job.version || this.watchJournal(job.id) !== journal ||
        this.meta(`watch_blind:${job.id}`) !== blind || json(this.getWatch(job.id)) !== json(old)) return;
      const alerts = this.openAlerts(job.id).filter(a => a.severity !== 'info');
      const rows = this.jobOps(job.id);
      const complete = !this.inFlightOp(job.walletId ?? '') && rows.every(o => o.state === 'finished' &&
        (o.txHash === null || (o.finishedBlock !== null && Number.isSafeInteger(o.finishedBlock) && o.finishedBlock > 0 && o.finishedBlock <= next.block)));
      // Halt review M-2: a trade job goes on after a denied step (TF-8), so a denied row, which has no transaction, does not keep its wait.
      const clean = safePolicy && complete && alerts.every(legacyBlind) && !rows.some(o => (job.trade ? ['unknown', 'unclear', 'busy'] : ['unknown', 'unclear', 'busy', 'denied']).includes(o.verdict ?? ''));
      if (!complete || (!clean && this.watchWaiting(job.id))) return;
      if (!old && alerts.some(legacyBlind)) return; // A legacy halt cannot establish evidence for an unobserved interval.
      this.putWatch(job.id, next);
      if (!clean) return;
      // A blocking alert that appeared during a wait must be processed by the normal halt path first.
      if (alerts.length && job.state !== 'halted') return;
      if (job.armedHash) this.setMeta(key, json({ at: next.updatedAt, block: next.block, version: job.version, journal, hadBaseline: old !== null }));
      this.setMeta(`watch_blind:${job.id}`, '0');
      this.#run("UPDATE alerts SET acknowledged_at=? WHERE job_id=? AND kind='blind' AND severity='info' AND acknowledged_at IS NULL", next.updatedAt, job.id);
    });
  }
  clearWatchReason(job: Job, now: number): boolean {
    this.#only('worker');
    return this.#tx(() => {
      const checked = this.getWatch(job.id)?.updatedAt;
      return job.reason === RPC_UNAVAILABLE_REASON && fresh(checked, now) && checked > job.updatedAt && this.ownsWorkerLock() &&
        !this.watchWaiting(job.id) && !this.openAlerts(job.id).some(a => a.severity !== 'info') &&
        this.#cas(job.id, job.state, job.version, job.state, { reason: null }, now);
    });
  }
  blindHalt(job: Job): boolean {
    const alerts = this.openAlerts(job.id).filter(a => a.severity !== 'info');
    return job.state === 'halted' && job.reason === WALLET_ALERT_HALT && alerts.length > 0 && alerts.every(legacyBlind);
  }
  blindResumeHistoryBlocked(jobId: string, rows = this.jobOps(jobId)): boolean {
    return !!(this.grid(jobId)?.state?.protect?.fired || this.lp(jobId)?.state?.protect?.fired ||
      this.#one("SELECT 1 FROM alerts WHERE job_id=? AND kind='protect_stop'", jobId)) ||
      rows.some(o => o.state !== 'finished' || o.purpose === 'exit' ||
        (o.verdict === null ? !['encrypt_policy', 'sign_policy'].includes(o.kind) : !['success', 'swapped', 'refunded', 'reverted', 'frozen', 'quota'].includes(o.verdict)));
  }
  blindResumeProof(job: Job, now: number): BlindProof | null {
    if (this.getJob(job.id)?.version !== job.version || !this.blindHalt(job) || job.mode !== 'live' || !job.walletId || !job.agentAccount ||
      job.walletPubkey !== `ed25519:${job.agentAccount}` || !job.armedHash || job.linkConfirmedAt === null ||
      this.meta(`watch_blind:${job.id}`) !== '0' || !fresh(this.readHeartbeat('watchdog'), now) || this.inFlightOp(job.walletId)) return null;
    const baseline = this.getWatch(job.id);
    let p: ReturnType<typeof record>;
    try { p = record(JSON.parse(this.meta(`watch_clean:${job.id}`) ?? 'null')); } catch { return null; }
    if (!p || !fresh(p.at, now) || p.at <= job.updatedAt || p.hadBaseline !== true || p.version !== job.version || !baseline ||
      p.block !== baseline.block || baseline.updatedAt !== p.at || !Number.isSafeInteger(baseline.block) || baseline.block <= 0 ||
      this.openAlerts(job.id).some(a => legacyBlind(a) && !(a.createdAt < (p.at as number))) || p.journal !== this.watchJournal(job.id)) return null;
    const rows = this.jobOps(job.id);
    if (this.blindResumeHistoryBlocked(job.id, rows) ||
      rows.some(o => o.txHash !== null && (o.finishedBlock === null || !Number.isSafeInteger(o.finishedBlock) || o.finishedBlock <= 0 || o.finishedBlock > baseline.block))) return null;
    return { at: p.at, block: baseline.block, journal: p.journal as string };
  }
  resumeBlind(job: Job, sessionHash: string, c: Challenge, checked: BlindProof, block: number, now: number): boolean {
    this.#only('web');
    return this.#tx(() => {
      const current = this.getJob(job.id);
      if (!current || current.version !== job.version || current.owner !== job.owner || this.getSession(sessionHash, now)?.accountId !== current.owner ||
        c.purpose !== 'resume' || c.jobId !== current.id) return false;
      const p = this.blindResumeProof(current, now);
      if (!p || p.journal !== checked.journal || p.at !== checked.at || p.block !== checked.block || p.block > block || !this.useChallenge(c, now)) return false;
      // The immediate transaction holds the version and all eligibility inputs stable after nonce use.
      if (!this.#cas(job.id, 'halted', job.version, 'resuming', { reason: RESUMING_REASON }, now)) throw new CoreError('conflict', 'The job changed.');
      this.#run("UPDATE alerts SET acknowledged_at=? WHERE job_id=? AND kind='blind' AND severity='halt' AND acknowledged_at IS NULL", now, job.id);
      this.#run('DELETE FROM meta WHERE key=?', `watch_clean:${job.id}`);
      return true;
    });
  }
  /**
   * Fix 4 F4-5: a halt whose only cause was a lost reply, now proven from chain, waits in `paused` for the owner's signed
   * Resume. Any other blocking alert, an exit row or an unclean history keeps the job halted.
   */
  releaseReconciledHalt(job: Job, opId: string, now: number): boolean {
    this.#only('worker');
    return this.#tx(() => {
      const current = this.getJob(job.id), rows = this.jobOps(job.id), op = rows.find(o => o.id === opId);
      const alerts = this.openAlerts(job.id).filter(a => a.severity !== 'info');
      if (!current || current.version !== job.version || current.state !== 'halted' || current.mode !== 'live' || !current.walletId || !this.ownsWorkerLock() ||
        this.inFlightOp(current.walletId) || !op || op.jobId !== current.id || op.state !== 'finished' || op.purpose === 'exit' ||
        !['success', 'swapped', 'refunded', 'reverted'].includes(op.verdict ?? '') || this.blindResumeHistoryBlocked(current.id, rows) ||
        !alerts.length || !alerts.every(a => a.kind === 'op_ambiguous' && a.severity === 'halt')) return false;
      if (!this.#cas(current.id, 'halted', current.version, 'paused', { reason: RECONCILED_PAUSE }, now)) return false;
      this.#run("UPDATE alerts SET acknowledged_at=? WHERE job_id=? AND kind='op_ambiguous' AND severity='halt' AND acknowledged_at IS NULL", now, current.id);
      return true;
    });
  }
  /** Fix 4 F4-4: the diagnosis record of a submission with no usable reply, or null. */
  noReply(opId: string): NoReply | null {
    try {
      const r = record(JSON.parse(this.meta(`op_no_reply:${opId}`) ?? 'null'));
      return r && Number.isSafeInteger(r.at) && Number.isSafeInteger(r.resends) ? r as unknown as NoReply : null;
    } catch { return null; }
  }
  /** Records an answer at `now`; `at` (the start of the latest send) is kept once set. */
  noteNoReply(opId: string, seen: NoReplySeen, now: number) {
    const prev = this.noReply(opId);
    this.setMeta(`op_no_reply:${opId}`, json({ ...prev, first: prev?.first ?? seen, last: seen, resends: prev?.resends ?? 0, at: prev?.at ?? now, answeredAt: now, pending: false }));
  }
  /** Marks the start of a same-key re-send before it is sent, so the watchdog and the reconcile pacing see it. */
  noteResend(opId: string, now: number) {
    const prev = this.noReply(opId);
    this.setMeta(`op_no_reply:${opId}`, json({ ...prev, first: prev?.first ?? null, last: prev?.last ?? null, resends: (prev?.resends ?? 0) + 1, at: now, pending: true }));
  }
  /** Audit M-3: no further re-send of this row. */
  stopResend(opId: string, now: number) {
    const prev = this.noReply(opId);
    this.setMeta(`op_no_reply:${opId}`, json({ ...prev, first: prev?.first ?? null, last: prev?.last ?? null, resends: prev?.resends ?? 0, at: prev?.at ?? now, stopped: true }));
  }
  /** Audit M-3: the watchdog saw the owner freeze the job's wallet at or after `since`. */
  frozenSince(jobId: string, since: number): boolean {
    return !!this.#one("SELECT 1 FROM alerts WHERE job_id=? AND kind='frozen' AND created_at>=?", jobId, since);
  }
  meta(key: string): string | null { return nullable(this.#one('SELECT value FROM meta WHERE key=?', key)?.value); }
  setMeta(key: string, value: string) {
    if (key.startsWith('watch_clean:')) this.#only('watchdog');
    // Allow-list (demo mode 3.2): the paper processes write only their own keys; any other role is refused.
    const own = this.role === 'meme' ? key.startsWith('meme_') || key === 'heartbeat:meme' : this.role === 'demo' ? key.startsWith('demo_') || key === 'heartbeat:demo'
      : this.role === 'web' || this.role === 'worker' || this.role === 'watchdog';
    if (!own) this.#only('worker');
    this.#run('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, value);
  }
  readHeartbeat(name: 'watchdog' | 'worker' | 'meme' | 'demo'): number | null {
    if (name === 'worker') return this.#lock()?.heartbeat ?? null;
    const v = this.meta(`heartbeat:${name}`); return v === null ? null : Number(v);
  }
  heartbeat(name: 'watchdog' | 'worker' | 'meme' | 'demo', now: number): boolean {
    this.#only(name);
    if (name === 'meme') { this.setMeta('heartbeat:meme', String(now)); return true; }
    if (name === 'demo') { this.setMeta('heartbeat:demo', String(now)); return true; }
    if (name === 'watchdog') { this.setMeta('heartbeat:watchdog', String(now)); return true; }
    return this.#tx(() => {
      const lock = this.#lock();
      if (!lock || lock.instance !== this.#instance) return false;
      this.setMeta('worker_lock', json({ ...lock, heartbeat: now })); return true;
    });
  }
  #lock(): WorkerLock | null { const v = this.meta('worker_lock'); return v === null ? null : fromJson<WorkerLock>(v); }
  acquireWorkerLock(pid: number, now: number, check = process.kill.bind(process)): boolean {
    this.#only('worker');
    return this.#tx(() => {
      const existing = this.#lock();
      if (existing) {
        if (!Number.isSafeInteger(existing.pid) || existing.pid <= 0 || !Number.isSafeInteger(existing.heartbeat) || now - existing.heartbeat <= 60_000) return false;
        try { check(existing.pid, 0); return false; }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') return false; }
      }
      this.#instance = randomUUID(); this.setMeta('worker_lock', json({ pid, instance: this.#instance, heartbeat: now })); return true;
    });
  }
  ownsWorkerLock(): boolean { return this.role === 'worker' && this.#instance !== null && this.#lock()?.instance === this.#instance; }
  releaseWorkerLock(): void {
    this.#only('worker');
    this.#tx(() => { if (this.ownsWorkerLock()) this.#run('DELETE FROM meta WHERE key=?', 'worker_lock'); });
    this.#instance = null;
  }

  createMemeAgent(owner: string, settings: MemeSettings, now: number): MemeAgent {
    this.#only('web');
    return this.#tx(() => {
      if (Number(this.#one("SELECT count(*) n FROM meme_agents WHERE state='running' AND owner=?", owner)?.n) >= MEME.ownerLimit ||
          Number(this.#one("SELECT count(*) n FROM meme_agents WHERE state='running'")?.n) >= MEME.totalLimit) throw new CoreError('limit_reached', 'Paper agent limit reached.');
      const id = randomUUID();
      this.#run("INSERT INTO meme_agents VALUES (?,?,'running',NULL,?,?,?,?,0)", id, owner, json(settings), now, now + settings.termDays * MEME.day, now);
      return this.getMemeAgent(id)!;
    });
  }
  getMemeAgent(id: string): MemeAgent | null { const r = this.#one('SELECT * FROM meme_agents WHERE id=?', id); return r ? memeAgentFrom(r) : null; }
  memeAgents(owner?: string): MemeAgent[] {
    return (owner === undefined ? this.#all("SELECT * FROM meme_agents WHERE state<>'ended' ORDER BY created_at DESC") :
      this.#all('SELECT * FROM meme_agents WHERE owner=? ORDER BY created_at DESC', owner)).map(memeAgentFrom);
  }
  casMemeAgent(a: MemeAgent, state: MemeAgent['state'], endReason: MemeAgent['endReason'], now: number): boolean {
    if (this.role === 'web') {
      if (a.state !== 'running' || state !== 'ending' || endReason !== 'owner-stopped') this.#only('meme');
    } else {
      this.#only('meme');
      if (!((a.state === 'running' && state === 'ending' && endReason === 'term-ended' && now >= a.endsAt) ||
          (a.state === 'ending' && state === 'ended' && endReason === a.endReason))) throw new CoreError('forbidden', 'Invalid paper lifecycle change.');
    }
    return this.#run('UPDATE meme_agents SET state=?,end_reason=?,updated_at=?,version=version+1 WHERE id=? AND state=? AND version=?', state, endReason, now, a.id, a.state, a.version);
  }
  memeAuctions(): MemeAuction[] { return this.#all('SELECT * FROM meme_auctions ORDER BY end_ms,meme_id').map(memeAuctionFrom); }
  getMemeAuction(id: number): MemeAuction | null { const r = this.#one('SELECT * FROM meme_auctions WHERE meme_id=?', id); return r ? memeAuctionFrom(r) : null; }
  saveMemeAuction(from: MemeAuction | null, to: MemeAuction): boolean {
    this.#only('meme');
    const cols = Object.values(memeAuctionCols), values = (Object.keys(memeAuctionCols) as (keyof MemeAuction)[]).map(k => sql(to[k]));
    if (!from) return this.#run(`INSERT OR IGNORE INTO meme_auctions (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...values);
    // Trade V0 2: auctions have no version column, so compare the stored snapshot.
    return this.#run(`UPDATE meme_auctions SET ${cols.map(c => `${c}=?`).join(',')} WHERE meme_id=? AND updated_at=? AND last=? AND samples=? AND ask IS ? AND outcome IS ? AND pool_id IS ?`,
      ...values, from.memeId, from.updatedAt, json(from.last), json(from.samples), sql(from.ask), from.outcome, from.poolId);
  }
  memePositions(agentId?: string): MemePosition[] {
    return (agentId === undefined ? this.#all("SELECT * FROM meme_positions WHERE status<>'closed' ORDER BY opened_at DESC") :
      this.#all('SELECT * FROM meme_positions WHERE agent_id=? ORDER BY opened_at DESC', agentId)).map(memePositionFrom);
  }
  insertMemePosition(a: MemeAgent, p: MemePosition): boolean {
    this.#only('meme');
    return this.#tx(() => {
      if (!this.#one("SELECT 1 FROM meme_agents WHERE id=? AND state='running' AND version=?", a.id, a.version)) return false;
      const keys = Object.keys(memePositionCols) as (keyof MemePosition)[];
      return this.#run(`INSERT OR IGNORE INTO meme_positions (${keys.map(k => memePositionCols[k]).join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map(k => sql(p[k])));
    });
  }
  casMemePosition(p: MemePosition, to: MemePosition): boolean {
    this.#only('meme');
    const keys = (Object.keys(memePositionCols) as (keyof MemePosition)[]).filter(k => !['id', 'agentId', 'memeId', 'version'].includes(k));
    return this.#run(`UPDATE meme_positions SET ${keys.map(k => `${memePositionCols[k]}=?`).join(',')},version=version+1 WHERE id=? AND version=?`, ...keys.map(k => sql(to[k])), p.id, p.version);
  }
  logMeme(row: Omit<MemeLog, 'id'>) {
    this.#only('meme'); this.#run('INSERT INTO meme_log VALUES (?,?,?,?,?,?)', randomUUID(), row.agentId, row.kind, row.memeId, row.at, json(row.data));
  }
  memeLogs(agentId: string | null, limit = 50): MemeLog[] {
    const rows = agentId === null ? this.#all('SELECT * FROM meme_log WHERE agent_id IS NULL ORDER BY at DESC,rowid DESC LIMIT ?', limit) :
      this.#all(`SELECT * FROM meme_log WHERE agent_id=? OR (agent_id IS NULL AND kind IN ('screen','ask') AND meme_id IN
        (SELECT meme_id FROM meme_log WHERE agent_id=? AND meme_id IS NOT NULL)) ORDER BY at DESC,rowid DESC LIMIT ?`, agentId, agentId, limit);
    return rows.map(memeLogFrom);
  }
  /** The shared per-minute cycle rows between two times, newest first (the Run log of one agent's life). */
  memeCycles(from: number, to: number, limit: number): MemeLog[] {
    return this.#all("SELECT * FROM meme_log WHERE agent_id IS NULL AND kind='cycle' AND at>=? AND at<=? ORDER BY at DESC,rowid DESC LIMIT ?", from, to, limit).map(memeLogFrom);
  }
  pruneMemeLogs() {
    this.#only('meme');
    for (const r of this.#all('SELECT DISTINCT agent_id FROM meme_log')) this.#run(`DELETE FROM meme_log WHERE agent_id IS ? AND rowid NOT IN
      (SELECT rowid FROM meme_log WHERE agent_id IS ? ORDER BY at DESC,rowid DESC LIMIT ?)`, r.agent_id, r.agent_id, r.agent_id === null ? 5000 : 2000);
  }

  /** Demo mode 3.2: the web creates only visitor agents (a 64-hex owner hash), the demo role only operator seeds. Visitor caps hold in one transaction. */
  createDemoAgent(i: Pick<DemoAgent, 'owner' | 'kind' | 'pair' | 'settings' | 'depositYocto' | 'seed'>, now: number): DemoAgent {
    if (!(this.role === 'web' && i.seed === 0 && /^[0-9a-f]{64}$/.test(i.owner)) && !(this.role === 'demo' && i.seed === 1 && i.owner === 'operator')) {
      throw new CoreError('forbidden', 'This process cannot perform that store action.');
    }
    return this.#tx(() => {
      if (i.seed === 0 && (Number(this.#one(`SELECT count(*) n FROM demo_agents WHERE state IN ${DEMO_ACTIVE} AND owner=?`, i.owner)?.n) >= DEMO_LIMITS.perOwner ||
        Number(this.#one(`SELECT count(*) n FROM demo_agents WHERE state IN ${DEMO_ACTIVE} AND seed=0`)?.n) >= DEMO_LIMITS.total)) throw new CoreError('limit_reached', 'Demo agent limit reached.');
      const id = randomUUID(), trade = i.kind === 'schedule' || i.kind === 'dca';
      const ends = now + (trade ? TRADE_LIFE_MS : (i.seed === 1 ? 14 : 7) * DEMO_LIMITS.day);
      this.#run("INSERT INTO demo_agents VALUES (?,?,?,?,'running',NULL,?,?,NULL,?,?,?,?,0)", id, i.owner, i.kind, i.pair, json(i.settings), i.depositYocto, i.seed, now, ends, now);
      return this.getDemoAgent(id)!;
    });
  }
  getDemoAgent(id: string): DemoAgent | null { const r = this.#one('SELECT * FROM demo_agents WHERE id=?', id); return r ? demoAgentFrom(r) : null; }
  demoAgents(owner: string): DemoAgent[] { return this.#all('SELECT * FROM demo_agents WHERE owner=? ORDER BY created_at DESC,rowid DESC', owner).map(demoAgentFrom); }
  demoActive(): DemoAgent[] { return this.#all(`SELECT * FROM demo_agents WHERE state IN ${DEMO_ACTIVE} ORDER BY created_at,rowid`).map(demoAgentFrom); }
  /** The owner's stop from the web: running to stopping; a seed is never stopped from the web. */
  stopDemoAgent(a: DemoAgent, now: number): boolean {
    this.#only('web');
    return this.#run("UPDATE demo_agents SET state='stopping',end_reason='owner-stopped',updated_at=?,version=version+1 WHERE id=? AND state='running' AND seed=0 AND version=?", now, a.id, a.version);
  }
  /** One simulation step: the state change and its log rows in one transaction, compare-and-set on version. */
  saveDemo(a: DemoAgent, next: DemoNext, now: number): boolean {
    this.#only('demo');
    const r = next.endReason;
    if (!((a.state === 'running' && next.state === 'running' && r === null) ||
      (a.state === 'running' && next.state === 'stopping' && r !== null && r !== 'owner-stopped' && DEMO_REASONS.includes(r)) ||
      (a.state === 'stopping' && (next.state === 'stopping' || next.state === 'ended') && r === a.endReason))) throw new CoreError('forbidden', 'Invalid demo lifecycle change.');
    return this.#tx(() => {
      if (!this.#run('UPDATE demo_agents SET state=?,end_reason=?,sim=?,updated_at=?,version=version+1 WHERE id=? AND state=? AND version=?',
        next.state, r, next.sim === null ? null : json(next.sim), now, a.id, a.state, a.version)) return false;
      for (const row of next.log) this.#run('INSERT INTO demo_log VALUES (?,?,?,?,?)', randomUUID(), a.id, row.kind, now, json(row.data));
      if (next.log.length) this.#run(`DELETE FROM demo_log WHERE agent_id=? AND rowid NOT IN
        (SELECT rowid FROM demo_log WHERE agent_id=? ORDER BY at DESC,rowid DESC LIMIT 2000)`, a.id, a.id);
      return true;
    });
  }
  /** Section 6: reserves one NEAR AI call of the UTC day before it is made; 50 a day, visitor agents at most 40 of them. */
  reserveDemoAi(day: string, seed: boolean): boolean {
    this.#only('demo');
    return this.#tx(() => {
      const key = `demo_ai:${day}`, count = Number(this.meta(key) ?? '0');
      if (count >= (seed ? 50 : 40)) return false;
      this.setMeta(key, String(count + 1));
      return true;
    });
  }
  demoLog(agentId: string, limit: number): { id: string; kind: string; at: number; data: Record<string, unknown> }[] {
    return this.#all('SELECT id,kind,at,data FROM demo_log WHERE agent_id=? ORDER BY at DESC,rowid DESC LIMIT ?', agentId, limit)
      .map(r => ({ id: String(r.id), kind: String(r.kind), at: Number(r.at), data: fromJson(r.data) }));
  }
}

export function openStore(path: string, role: Role, demo?: boolean): Store { return new Store(path, role, demo); }
