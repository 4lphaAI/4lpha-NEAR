// Pure helpers moved from src/web/page/app.ts (post-LP version) without logic
// change. No window, no wallet connector, no fetch: safe to import in tests.

/** A sanitized error message the server chose to send; the actions show it as it is (Retire spec 3). */
export class ServerError extends Error {}

export interface Challenge { message: string; nonce: string; recipient: string; }
export interface Call { methodName: string; args: object; gas: string; deposit: string; }
export interface Payload extends Call { receiverId: string; caller: string; }
export interface JobOperation {
  id: string; kind: string; verdict: string | null; state: string; txHash: string | null; message: string | null;
  createdAt: number; finishedAt: number | null;
}
export interface Job {
  id: string; owner: string; kind: string; state: string; reason: string | null; depositYocto: string; networkCost?: string; agentAccount: string | null;
  walletPubkey: string | null; agentBalance: string | null; ownerBalance: string | null; payload: Payload | null;
  canReveal: boolean; linkDelivered: boolean; linkConfirmed: boolean; canFund: boolean; frozen: boolean | null;
  canStopEarly: boolean;
  waitingForChain: boolean; blindHalt: boolean; canResumeBlind: boolean;
  resumeBlockedReason: string | null;
  name?: string | null;
  grid: { available: boolean; enabled: boolean; issued: boolean; registered: boolean; canRegister: boolean; point: number | null; anchor: number | null;
    internal: Record<string, string>; lost: Record<string, string>; positions: number;
    lanes: { generation: number; sell: string; amount: string; native: boolean; orderId: string | null; points: [number, number] | null }[];
    orders: { id: string; sell: string; buy: string; point: number; remain: string; bought: string; unclaimed: string }[];
    fills?: { at: number; side: 'buy' | 'sell'; point: number; sold: string; bought: string; txHash: string | null }[];
    settings?: { v: 2; step: number; orders: number; stopLossPct: number; takeProfitPct: number } | 'invalid' | null;
    protect?: { kind: string; since: number; block: number; fired?: { kind: string; value: string; basis: string; block: number; at: number } } | null;
    value?: string | null } | null;
  lp: { available: boolean; enabled: boolean; issued: boolean; registered: boolean; canRegister: boolean; point: number | null; internal: Record<string, string>; lost: Record<string, string>;
    positions: number; ledger: { usdc: string; wnear: string; native: string; inUsdc: string; inWnear: string } | null; rotations: number; pending: { kind: string } | null;
    range: { left: number; right: number; leftPrice: number; rightPrice: number; inRange: boolean | null; outSince: number | null } | null;
    position: { id: string; liquidity: string; paidX: string; paidY: string; fees: string[] | null; openedAt?: number | null; estimate: string[] | null } | null;
    // LP V2 fields (present when the job is V2; app.ts post-V2 lines 7-9).
    settings?: LpSettingsView | 'invalid' | null; recentred?: boolean; initialPosition?: string; positionValue?: string | null; valueLow?: string | null; valueHigh?: string | null;
    lastDecision?: { at: number; verdict: string; code?: string; range: { left: number; right: number } } | null;
    compounds?: { count: number; lastAt: number | null };
    protect?: { fired?: { kind: string; value: string; basis: string; block: number; at: number } } | null } | null;
  pendingSubmission: 'submitted' | 'ambiguous' | null;
  holdings: { tokens: Record<string, string>; block: number } | null; extraTokens: { token: string; amount: string }[];
  operations: JobOperation[];
  alerts: { kind: string; severity: string; detail: Record<string, string> }[];
  /** Trade V1 (spec section 12): present for Schedule buy and Auto DCA jobs, null otherwise. */
  trade?: TradeView | null;
}

/** Yocto NEAR, raw token units and yocto per raw token, as exact decimal strings (spec section 12). */
export type Ratio = { num: string; den: string };
export type TradeSettingsView =
  | { v: 1; strategy: 'schedule'; amount: string; intervalSec: number; budget: string; end: { kind: 'budget' } | { kind: 'runs'; runs: number } | { kind: 'date'; atMs: number } }
  | { v: 1; strategy: 'dca'; base: string; order: string; levels: number; stepBps: number; tpBps: number; slBps: number };
export type TradeLevelState = 'waiting' | 'armed' | 'filled' | 'skipped';
export interface TradeView {
  strategy: 'schedule' | 'dca';
  pair: { id: 'trade-usdc' | 'trade-rhea' | 'trade-zec'; symbol: 'USDC' | 'RHEA' | 'ZEC'; token: string; decimals: number; poolId: number; feeBps: number };
  settings: TradeSettingsView | 'invalid';
  endsAt: number | null;
  ledger: { spent: string; bought: string; sold: string; proceeds: string; gasBuy: string; gasSell: string; wnear: string };
  avgCost: Ratio | null; spot: Ratio | null; value: string | null; walletValue: string | null; pnl: string | null;
  schedule: { anchor: number | null; currentSlot: number | null; currentSlotTaken: boolean; fills: number; postponed: number; nextDueAt: number | null; remaining: string } | null;
  dca: { p0: Ratio | null; levels: { k: number; price: Ratio | null; need: string | null; state: TradeLevelState }[]; tpLine: string | null; slLine: string | null;
    protect: { since: number; block: number } | null } | null;
  buys: { opId: string; kind: 'wrap' | 'swap'; side: 'buy' | 'sell'; amount: string; verdict: string | null; used: string | null; out: string | null; nativeIn: string | null;
    txHash: string | null; message: string | null; at: number }[];
  done: { kind: 'budget' | 'runs' | 'date' | 'life' | 'tp' | 'tp-cap' | 'tp-short' | 'sl'; at: number; value?: string; line?: string } | null;
}

export const CHAIN_WAIT = 'Waiting for verified chain data. No new trades will be sent; checks retry automatically.';
export const BLIND_RESUME = 'Sign a message to resume. The worker repeats its safety checks before trading.';
export const STOPPING_WAIT = 'Please wait a few minutes. Your funds are on their way back to your wallet, sent in several small transfers.';
export const BLIND_CHECKS = 'Verification checks must finish before this job can resume.';
export function waitingForChain(job: Pick<Job, 'waitingForChain' | 'state' | 'frozen'>): boolean {
  return job.waitingForChain && job.frozen !== true && ['registered', 'policy_prepared', 'link_confirmed', 'funded', 'ready', 'running', 'resuming'].includes(job.state);
}
export function resumeLabel(job: Pick<Job, 'state'>): 'Resume' | 'Check and resume' | null {
  return job.state === 'paused' ? 'Resume' : job.state === 'halted' ? 'Check and resume' : null;
}
export function canRequestResume(job: Pick<Job, 'state' | 'canResumeBlind'>): boolean {
  return job.state === 'paused' || job.state === 'halted' && job.canResumeBlind === true;
}

/** LP V2 owner settings as the server returns them (src/core/lp.ts LpSettings). */
export interface LpSettingsView {
  v?: 2; range?: { mode: 'server' } | { mode: 'explicit'; left: number; right: number };
  ai: boolean; compound: { on: boolean; minFeeBps?: number }; stopLossPct: number; takeProfitPct: number;
}

export const WNEAR = 'wrap.near';
/** Bundled logos of the pinned tokens, by display symbol (the NEAR edition has no token-icon API). */
export function tokenLogo(symbol: string | null | undefined): string | null {
  return symbol === 'wNEAR' || symbol === 'NEAR' ? '/design/tokens/near.svg' : symbol === 'USDC' ? '/design/tokens/usdc.svg' : null;
}
export const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
export const DCL = 'dclv2.ref-labs.near';
export const RHEA = 'token.rhealab.near';
export const ZEC = 'zec.omft.near';

export function fmt(raw: string | null) {
  if (raw === null) return 'Unavailable';
  const n = BigInt(raw), unit = 10n ** 24n;
  return `${n / unit}.${(n % unit).toString().padStart(24, '0').slice(0, 6)} NEAR`;
}

export function exactNear(n: bigint) {
  const unit = 10n ** 24n, fraction = (n % unit).toString().padStart(24, '0').replace(/0+$/, '');
  return `${n / unit}${fraction ? `.${fraction}` : ''} NEAR`;
}

/** A raw token amount in whole tokens, exact, trailing zeros trimmed (Trade V1 display rounding). */
export function tokenAmount(raw: string, decimals: number): string {
  const n = BigInt(raw), abs = n < 0n ? -n : n, unit = 10n ** BigInt(decimals);
  const fraction = (abs % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${n < 0n ? '-' : ''}${abs / unit}${fraction ? `.${fraction}` : ''}`;
}

/** A yocto-per-raw ratio as NEAR per whole token (or its inverse), 6 significant digits. Display only. */
export function ratioPrice(r: Ratio, decimals: number, inverse = false): string {
  const num = BigInt(r.num) * 10n ** BigInt(decimals), den = BigInt(r.den) * 10n ** 24n;
  const [a, b] = inverse ? [den, num] : [num, den];
  return b === 0n ? '-' : (Number(a * 10n ** 18n / b) / 1e18).toPrecision(6);
}

/** asset() with wNEAR cut to 6 decimals, for compact table cells. */
export function assetShort(token: string, raw: string) {
  return token === WNEAR ? fmt(raw).replace(' NEAR', ' wNEAR') : asset(token, raw);
}

export function asset(token: string, raw: string) {
  if (token === WNEAR) return exactNear(BigInt(raw)).replace(' NEAR', ' wNEAR');
  if (token === RHEA) return `${tokenAmount(raw, 18)} RHEA`;
  if (token === ZEC) return `${tokenAmount(raw, 8)} ZEC`;
  if (token !== USDC) return `${raw} raw units of ${token}`;
  const n = BigInt(raw);
  return `${n / 1000000n}.${(n % 1000000n).toString().padStart(6, '0')} USDC`;
}

/** app.ts depositYocto, taking the field text as a parameter. */
export function depositYocto(text: string): bigint {
  const parts = /^(\d+)(?:\.(\d{1,24}))?$/.exec(text.trim());
  if (!parts) throw new Error('4lpha: Enter a valid NEAR deposit.');
  return BigInt(parts[1] + (parts[2] ?? '').padEnd(24, '0'));
}

/** app.ts lines 128-135: the setup checklist and the index of the current step (-1 when none). */
export function setupStep(job: Job): { step: number; labels: string[] } {
  const dcl = job.grid ?? job.lp, extra = dcl ? 1 : 0;
  const step = ['draft', 'registered'].includes(job.state) ? 0 : job.state === 'policy_prepared' ? 1 : job.state === 'armed' ? 2 : job.state === 'link_confirmed' ? 3 + Number(dcl?.registered ?? false)
    : ['funded', 'resuming'].includes(job.state) ? 4 + extra : ['ready', 'running'].includes(job.state) ? 5 + extra : -1;
  const labels = ['Prepare the job', 'Store the policy and verify the owner', 'Reveal and save the management link', ...(dcl ? ['Register the agent on DCL from your wallet'] : []),
    'Fund from your wallet', 'Register tokens', 'Ready'];
  return { step, labels };
}

/** app.ts lines 196-197: the DCL registration payload the owner may sign. */
export function isDclRegistrationPayload(p: Payload, job: Job): boolean {
  const args = p.args as { account_id?: string; registration_only?: boolean };
  return !(p.caller !== job.owner || p.receiverId !== DCL || p.methodName !== 'storage_deposit' || p.deposit !== '500000000000000000000000' ||
    p.gas !== '50000000000000' || args.account_id !== job.agentAccount || args.registration_only !== true);
}

/** app.ts line 203: the policy payload the owner may sign. Args, gas and deposit pass through unchecked, as today. */
export function isPolicyPayload(p: Payload, job: Job): boolean {
  return !(p.caller !== job.owner || p.receiverId !== 'outlayer.near' || p.methodName !== 'store_wallet_policy');
}

/** app.ts line 231: the freeze or unfreeze call, built locally. */
export function freezeCall(job: Job, frozen: boolean): { receiverId: string; call: Call } {
  return { receiverId: 'outlayer.near', call: { methodName: frozen ? 'unfreeze_wallet' : 'freeze_wallet', args: { wallet_pubkey: job.walletPubkey }, gas: '30000000000000', deposit: '0' } };
}

/** app.ts line 185: the funding instruction, shown only when job.canFund. */
export function fundingLine(job: Job): string {
  return `From your wallet's Send screen, send ${exactNear(BigInt(job.depositYocto) - BigInt(job.agentBalance ?? '0'))} to ${job.agentAccount}. Verify the recipient before sending.`;
}

/** app.ts line 148: USDC per NEAR at a DCL point of the USDC / wNEAR pool. */
export function priceUsdcPerNear(point: number | null): number | null {
  return point === null ? null : 10 ** 18 / 1.0001 ** point;
}
