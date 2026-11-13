import { CoreError, record, redactText } from './errors.js';
import type { PolicyRules } from './policy.js';
import { SecretString } from './secrets.js';

export interface RegisterResult { walletId: string; nearAccountId: string; apiKey: SecretString; managementLink: SecretString | null; }
export interface ApiPolicyView { http: number; policy: string | null; frozen: boolean | null; rules: unknown; capabilities: unknown; approval: unknown; }
export interface CallRequest { receiverId: string; methodName: string; args: Record<string, unknown>; gas: bigint; deposit: bigint; }
export type SubmitResult =
  | { kind: 'accepted'; requestId: string | null; status: string | null; terminal: boolean; txHash: string | null; alreadyRegistered?: true }
  | { kind: 'denied'; code: 'policy_denied' | 'wallet_frozen'; message: string }
  | { kind: 'reverted'; requestId: string | null; txHash: string | null; message: string }
  | { kind: 'busy'; inFlightRequestId: string | null }
  | { kind: 'quota'; retryAfterSeconds: number | null; limitReached?: boolean }
  | { kind: 'rejected'; http: number; code: string | null; message: string }
  | { kind: 'ambiguous'; reason: 'network' | 'timeout' | 'server' | 'unparseable'; http?: number };
/** OutLayer's sign-policy answer. `version`, `locked` and `validUntil` are inside the signature and go into `store_wallet_policy` unchanged. */
export interface SignedPolicy { signatureHex: string; publicKeyHex: string; version: number; locked: boolean; validUntil: number; }
export interface OutLayerClient {
  register(): Promise<{ result: RegisterResult | null; error: CoreError | null }>;
  encryptPolicy(key: SecretString, walletId: string, rules: PolicyRules): Promise<{ encryptedBase64: string }>;
  signPolicy(key: SecretString, encryptedBase64: string, caller: string): Promise<SignedPolicy>;
  getPolicy(key: SecretString): Promise<ApiPolicyView>;
  invalidateCache(walletId: string): Promise<number>;
  call(key: SecretString, req: CallRequest, idemKey: string): Promise<SubmitResult>;
  transfer(key: SecretString, to: string, amount: bigint, idemKey: string): Promise<SubmitResult>;
  storageDeposit(key: SecretString, token: string, accountId: string | null, idemKey: string): Promise<SubmitResult>;
  request(key: SecretString, requestId: string): Promise<SubmitResult>;
}

const TERMINAL = new Set(['success', 'completed', 'partially_failed', 'failed', 'refunded', 'rejected', 'cancelled', 'needs_review']);
const str = (x: unknown) => typeof x === 'string' && x.length ? x : null;
const identifier = (x: unknown) => typeof x === 'string' && /^[a-zA-Z0-9._-]{1,128}$/.test(x) && !x.startsWith('wk_') ? x : null;
const seconds = (x: unknown) => typeof x === 'number' && Number.isSafeInteger(x) && x > 0 ? x : null;
type Fetcher = (url: string, init: RequestInit) => Promise<{ status: number; text(): Promise<string>; headers?: { get(name: string): string | null } }>;
type Reply = { http: number; data: Record<string, unknown> | null; retryAfter: string | null } | { reason: 'network' | 'timeout' };

function submission(reply: Reply): SubmitResult {
  if ('reason' in reply) return { kind: 'ambiguous', reason: reply.reason };
  const { http, data, retryAfter } = reply;
  // Fix 4 F4-4: the HTTP status of an ambiguous answer is kept for diagnosis.
  if (http >= 500 || http === 408) return { kind: 'ambiguous', reason: 'server', http };
  if (http === 429) return { kind: 'quota', retryAfterSeconds: seconds(data?.retry_after_seconds) ?? (retryAfter !== null && /^[0-9]+$/.test(retryAfter) ? seconds(Number(retryAfter)) : null),
    ...(data?.error === 'operation_limit_reached' ? { limitReached: true } : {}) };
  if (http === 409) return { kind: 'busy', inFlightRequestId: identifier(data?.in_flight_request_id) };
  if (!data) return { kind: 'ambiguous', reason: 'unparseable', http };
  const requestId = identifier(data.request_id);
  const txHash = identifier(data.tx_hash) ?? identifier(record(data.result)?.tx_hash);
  const status = str(data.status);
  const code = str(data.error);
  if (http === 200 && (!code || code === 'duplicate_idempotency_key')) return { kind: 'accepted', requestId, status, terminal: TERMINAL.has(status ?? ''), txHash, ...(data.already_registered === true ? { alreadyRegistered: true as const } : {}) };
  if (http === 403 && (code === 'policy_denied' || code === 'wallet_frozen')) return { kind: 'denied', code, message: redactText(str(data.message) ?? 'OutLayer refused the operation.') };
  if (http === 422 && code === 'onchain_tx_failed') return { kind: 'reverted', requestId, txHash, message: 'The on-chain transaction failed.' };
  if (http >= 400 && http < 500) return { kind: 'rejected', http, code: code && /^[a-z0-9_]{1,64}$/.test(code) && !code.startsWith('wk_') ? code : null, message: 'OutLayer rejected the request.' };
  return { kind: 'ambiguous', reason: 'unparseable', http };
}

export function createOutLayerClient(baseUrl: string, fetcher: Fetcher = fetch): OutLayerClient {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new CoreError('bad_request', 'OutLayer must use an HTTPS origin.');
  async function api(path: string, method: string, body?: unknown, key?: SecretString, idem?: string): Promise<Reply> {
    const signal = AbortSignal.timeout(95_000);
    try {
      const headers = new Headers();
      if (body !== undefined) headers.set('content-type', 'application/json');
      if (key) headers.set('authorization', `Bearer ${key.reveal()}`);
      if (idem) headers.set('x-idempotency-key', idem);
      const res = await fetcher(new URL(path, base).href, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal, redirect: 'error' });
      const text = await res.text(), retryAfter = res.headers?.get('retry-after') ?? null;
      try { return { http: res.status, data: record(JSON.parse(text)), retryAfter }; }
      catch { return { http: res.status, data: null, retryAfter }; }
    } catch { return { reason: signal.aborted ? 'timeout' : 'network' }; }
  }
  return {
    async register() {
      const r = await api('/register', 'POST', {});
      if ('reason' in r) return { result: null, error: new CoreError('outlayer_error', 'Wallet registration result is unknown.') };
      const key = str(r.data?.api_key);
      const link = str(r.data?.handoff_url);
      const result = key ? { walletId: str(r.data?.wallet_id) ?? '', nearAccountId: str(r.data?.near_account_id) ?? '', apiKey: new SecretString(key), managementLink: link ? new SecretString(link) : null } : null;
      const error = r.http === 200 && result ? null : new CoreError('outlayer_error', r.http >= 500 || r.http === 408 || !r.data ? 'Wallet registration result is unknown.' : 'OutLayer refused wallet registration.');
      return { result, error };
    },
    async encryptPolicy(key, wallet_id, rules) {
      const r = await api('/wallet/v1/encrypt-policy', 'POST', { wallet_id, rules }, key);
      const encryptedBase64 = 'http' in r && r.http === 200 ? str(r.data?.encrypted_base64) : null;
      if (!encryptedBase64) throw new CoreError('outlayer_error', 'Could not encrypt the wallet policy.');
      return { encryptedBase64 };
    },
    async signPolicy(key, encrypted_data, caller) {
      const r = await api('/wallet/v1/sign-policy', 'POST', { encrypted_data, caller }, key);
      const data = 'http' in r && r.http === 200 ? r.data : null;
      const signatureHex = str(data?.signature_hex), publicKeyHex = str(data?.public_key_hex);
      const version = data?.version, locked = data?.locked, validUntil = data?.valid_until;
      if (!signatureHex || !publicKeyHex || data?.status !== undefined || !Number.isSafeInteger(version) || (version as number) < 1 || typeof locked !== 'boolean' ||
        !Number.isSafeInteger(validUntil) || (validUntil as number) < 1) throw new CoreError('outlayer_error', 'Could not prepare the wallet policy signature.');
      return { signatureHex, publicKeyHex, version: version as number, locked, validUntil: validUntil as number };
    },
    async getPolicy(key) {
      const r = await api('/wallet/v1/policy', 'GET', undefined, key);
      const data = 'http' in r ? r.data : null;
      return { http: 'http' in r ? r.http : 0, policy: str(data?.policy), frozen: typeof data?.frozen === 'boolean' ? data.frozen : null,
        rules: data?.rules, capabilities: data?.capabilities, approval: data?.approval };
    },
    async invalidateCache(wallet_id) {
      const r = await api('/wallet/v1/invalidate-cache', 'POST', { wallet_id });
      return 'http' in r ? r.http : 0;
    },
    async call(key, r, idem) { return submission(await api('/wallet/v1/call', 'POST', { receiver_id: r.receiverId, method_name: r.methodName, args: r.args, gas: r.gas.toString(), deposit: r.deposit.toString() }, key, idem)); },
    async transfer(key, to, amount, idem) { return submission(await api('/wallet/v1/transfer', 'POST', { chain: 'near', to, amount: amount.toString() }, key, idem)); },
    async storageDeposit(key, token, accountId, idem) { return submission(await api('/wallet/v1/storage-deposit', 'POST', { token, ...(accountId === null ? {} : { account_id: accountId }) }, key, idem)); },
    async request(key, requestId) { return submission(await api(`/wallet/v1/requests/${encodeURIComponent(requestId)}`, 'GET', undefined, key)); },
  };
}
