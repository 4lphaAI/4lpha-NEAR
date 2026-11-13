import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseAmount } from './amounts.js';
import { CoreError, record } from './errors.js';
import { MONEY } from './pins.js';
import { memoryRpcCoordinator, RPC_QUEUE_LIMIT, type RpcCoordinator, type RpcGroup } from './rpc-pacing.js';

export interface RpcEndpoints { read: readonly [string, string, ...string[]]; archival: string; archivalOverride?: true; auth?: { origin: string; token: string }; }
export type Fetcher = (url: string, body: string, timeoutMs: number) => Promise<{ status: number; text: string; retryAfter?: string }>;
export interface AccountView { amount: bigint; locked: bigint; storageUsage: number; }
export interface NearRpc {
  query(params: Record<string, unknown>): Promise<unknown>;
  view(contract: string, method: string, args: Record<string, unknown>, blockId?: string): Promise<{ height: number; value: unknown; blockId?: string }>;
  viewAccount(accountId: string): Promise<AccountView | null>;
  viewAccessKey(accountId: string, publicKey: string): Promise<{ fullAccess: boolean } | null>;
  txStatus(txHash: string, sender: string): Promise<unknown>;
  holdGasPrice(): Promise<bigint>;
  finalBlock?(): Promise<{ height: number; id: string }>;
  blockHeight?(id: string): Promise<number>;
}
export class RpcUnavailable extends CoreError { constructor() { super('rpc_unavailable', 'Finalized chain data is unavailable.'); } }
export class MemeNotFinalized extends CoreError { constructor() { super('bad_request', 'Meme is not finalized.'); } }
class Definitive extends Error { constructor(readonly kind: string) { super(kind); } }
export const DRPC_READ = 'https://near.drpc.org';
export const DEFAULT_RPC: RpcEndpoints = {
  read: ['https://free.rpc.fastnear.com', 'https://rpc.mainnet.fastnear.com'], archival: 'https://archival-rpc.mainnet.fastnear.com',
};

export function accountFromResult(v: unknown): AccountView {
  const r = record(v);
  try {
    if (!r || typeof r.storage_usage !== 'number' || !Number.isSafeInteger(r.storage_usage) || r.storage_usage < 0) throw new RpcUnavailable();
    return { amount: parseAmount(r.amount, 'balance'), locked: parseAmount(r.locked, 'locked balance'), storageUsage: r.storage_usage };
  } catch { throw new RpcUnavailable(); }
}

export function httpFetcher(auth?: RpcEndpoints['auth']): Fetcher {
  return async (url, body, ms) => {
    // Only the token's own origin receives it, so an archival override never does, and redirects are refused.
    const headers = { 'content-type': 'application/json', ...(auth && url === auth.origin ? { 'x-token': auth.token } : {}) };
    const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(ms), redirect: 'error' });
    return { status: res.status, text: await res.text(), retryAfter: res.headers.get('retry-after') ?? undefined };
  };
}

const digest = (identity: string) => createHash('sha256').update(identity).digest('hex');
function endpointIdentity(url: string): string {
  try { const parsed = new URL(url); parsed.hash = ''; return parsed.href; }
  catch { throw new RpcUnavailable(); }
}
const publicEndpoints = new Set([...DEFAULT_RPC.read, DEFAULT_RPC.archival].map(endpointIdentity));
const publicGroup = { key: digest('public FastNEAR'), spacing: 500 } as const;
function route(url: string, auth: RpcEndpoints['auth']) {
  const identity = endpointIdentity(url);
  const group: RpcGroup = publicEndpoints.has(identity) ? publicGroup : { key: digest(identity), spacing: 250 };
  return { url, group, quick: url === auth?.origin };
}
function cooldown(reply: Awaited<ReturnType<Fetcher>>, error: Record<string, unknown> | null, quick: boolean, now: number): number {
  const message = String(error?.message);
  const daily = error?.code === -32003 && /daily/i.test(message);
  const throttled = daily || reply.status === 429 || error?.code === -429 || /rate.?limit|too many requests|request limit/i.test(message);
  const fallback = quick ? daily ? 3_600_000 : 60_000 : 10_000;
  if (throttled || reply.status === 408 || reply.status >= 500) {
    const retry = reply.retryAfter?.trim() ?? '';
    const ms = /^\d+$/.test(retry) ? Math.min(Number(retry), 3600) * 1000 : /[A-Za-z]/.test(retry) ? Date.parse(retry) - now : NaN;
    return now + (Number.isFinite(ms) && ms > 0 ? Math.min(ms, 3_600_000) : fallback);
  }
  return 0;
}

export function createNearRpc(endpoints: RpcEndpoints, fetcher: Fetcher = httpFetcher(endpoints.auth), wait: (ms: number) => Promise<unknown> = sleep,
  options: { coordinator?: RpcCoordinator; now?: () => number; deadline?: () => number } = {}): NearRpc {
  const now = options.now ?? Date.now, coordinator = options.coordinator ?? memoryRpcCoordinator();
  const readRoutes = endpoints.read.map(url => route(url, endpoints.auth));
  const archival = route(endpoints.archival, endpoints.auth);
  const archiveRoutes = archival.quick && !endpoints.archivalOverride ? [archival, route(DEFAULT_RPC.archival, endpoints.auth)] : [archival];
  const pending = new Map<string, Promise<unknown>>();
  let warnedUntil = 0;
  async function limited(r: typeof archival, body: string, tx: boolean, archive: boolean, deadline: number) {
    const ticket = randomUUID();
    if (!coordinator.enqueue(r.group, ticket, deadline, tx || archive, now)) return null;
    let granted = false;
    try {
      while (now() < deadline) {
        const grant = coordinator.take(r.group, ticket, tx && !r.quick ? 30_000 : 10_000, now, deadline);
        if (grant === null) return null;
        if (typeof grant === 'number') { await wait(grant); continue; }
        granted = true;
        let until = 0;
        try {
          const timeout = Math.min(grant.timeout, deadline - now());
          if (timeout < 1) throw new RpcUnavailable();
          let reply;
          try { reply = await fetcher(r.url, body, timeout); }
          catch {
            until = now() + (r.quick ? 60_000 : 10_000);
            return { status: 0, json: null, cooled: true };
          }
          let json: Record<string, unknown> | null = null;
          try { json = record(JSON.parse(reply.text)); } catch { /* Unusable JSON consumes one attempt. */ }
          until = cooldown(reply, record(json?.error), r.quick, now());
          if (now() >= deadline) throw new RpcUnavailable();
          return { status: reply.status, json, cooled: until > 0 };
        } finally {
          coordinator.finish(r.group, grant.token, until, Math.max(0, deadline - now()));
          if (r.quick && until > 0) {
            if (warnedUntil <= now()) console.warn('RPC: QuickNode unavailable; using configured RPC fallbacks.');
            warnedUntil = Math.max(warnedUntil, until);
          }
        }
      }
      return null;
    } finally {
      if (!granted) coordinator.cancel(r.group, ticket, Math.max(0, deadline - now()));
    }
  }
  async function perform(method: string, params: unknown, body: string, tx: boolean, archive: boolean, deadline: number): Promise<unknown> {
    const routes = tx || archive ? archiveRoutes : readRoutes;
    let counted = 0, attempts = 0, next = 0, cooled = false;
    while (counted < 4 && now() < deadline) {
      if (attempts && !cooled) await wait(Math.min(250 * (2 ** Math.min(attempts - 1, 3)), deadline - now()));
      if (now() >= deadline) break;
      let reply = null;
      // Receipt/history always try the configured archival route first. Reads alternate actual attempts.
      for (let j = 0; j < routes.length && !reply; j++) {
        const index = (next + j) % routes.length;
        reply = await limited(routes[index], body, tx, archive, deadline);
        if (reply && !(tx || archive)) next = (index + 1) % routes.length;
      }
      if (!reply) break;
      attempts++;
      const { status, json } = reply;
      cooled = reply.cooled;
      counted++;
      try {
        if (status !== 200) {
          if (status >= 400 && status < 500 && status !== 408 && status !== 429) throw new Definitive('HTTP');
          continue;
        }
        const err = record(json?.error);
        const name = record(err?.cause)?.name;
        // Trade V0 1: preserve only the pinned missing-finalization classification, never raw execution text.
        if (method === 'query' && record(params)?.account_id === 'meme-cooking.near' && record(params)?.method_name === 'get_finalized_meme' &&
            ((name === 'CONTRACT_EXECUTION_ERROR' && JSON.stringify(err).includes('No value found for the given key')) ||
            (typeof record(json?.result)?.error === 'string' && String(record(json?.result)?.error).includes('No value found for the given key')))) throw new MemeNotFinalized();
        // M-6: only receipt UNKNOWN_TRANSACTION retries beyond the four-attempt budget.
        if (tx && name === 'UNKNOWN_TRANSACTION' && !cooled) counted--;
        if (name === 'UNKNOWN_ACCOUNT' || name === 'UNKNOWN_ACCESS_KEY') throw new Definitive(name);
        if (name === 'CONTRACT_EXECUTION_ERROR' || name === 'NO_CONTRACT_CODE' || name === 'INVALID_ACCOUNT') throw new Definitive('PANIC');
        if (!json || json.error || !Object.hasOwn(json, 'result') || (method === 'query' && json.result === null)) continue;
        if (record(json.result)?.error && method === 'query') throw new Definitive('PANIC');
        return json.result;
      } catch (e) {
        if (e instanceof Definitive && e.kind === 'HTTP') break;
        if (e instanceof Definitive && e.kind === 'PANIC') throw new CoreError('bad_request', 'Chain view failed.');
        throw e;
      }
    }
    throw new RpcUnavailable();
  }
  async function request(method: string, params: unknown, tx = false, archive = false): Promise<unknown> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: '4lpha-near', method, params });
    const key = (tx ? 'tx:' : archive ? 'archive:' : 'read:') + body;
    let running = pending.get(key);
    if (!running) {
      if (pending.size >= RPC_QUEUE_LIMIT) throw new RpcUnavailable();
      const deadline = Math.min(now() + 30_000, options.deadline?.() ?? Infinity);
      running = perform(method, params, body, tx, archive, deadline).finally(() => { pending.delete(key); });
      pending.set(key, running);
    }
    try { return structuredClone(await running); }
    catch (e) { if (e instanceof Definitive || e instanceof CoreError) throw e; throw new RpcUnavailable(); }
  }
  const query = async (params: Record<string, unknown>) => {
    const { finality: _ignored, ...rest } = params;
    try { return await request('query', { ...rest, ...(rest.block_id ? {} : { finality: 'final' }) }); }
    catch (e) { if (e instanceof Definitive) return null; throw e; }
  };
  return {
    query,
    async view(contract, method, args, blockId) {
      const r = record(await query({ request_type: 'call_function', account_id: contract, method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString('base64'), ...(blockId ? { block_id: blockId } : {}) }));
      if (typeof r?.block_height !== 'number' || !Number.isSafeInteger(r.block_height) || !Array.isArray(r.result) ||
          !r.result.every(b => Number.isInteger(b) && b >= 0 && b <= 255) || (blockId && r.block_hash !== blockId)) throw new RpcUnavailable();
      try { return { height: r.block_height, value: JSON.parse(Buffer.from(r.result).toString('utf8')) as unknown,
        blockId: typeof r.block_hash === 'string' ? r.block_hash : undefined }; }
      catch { throw new RpcUnavailable(); }
    },
    async viewAccount(account_id) {
      const raw = await query({ request_type: 'view_account', account_id });
      return raw === null ? null : accountFromResult(raw);
    },
    async viewAccessKey(account_id, public_key) {
      const raw = await query({ request_type: 'view_access_key', account_id, public_key });
      if (raw === null) return null;
      const permission = record(raw)?.permission;
      if (permission === 'FullAccess') return { fullAccess: true };
      if (record(permission)?.FunctionCall) return { fullAccess: false };
      throw new RpcUnavailable();
    },
    txStatus: (tx_hash, sender_account_id) => request('EXPERIMENTAL_tx_status', { tx_hash, sender_account_id, wait_until: 'FINAL' }, true),
    async holdGasPrice() {
      const [gp, pc] = await Promise.all([request('gas_price', [null]), request('EXPERIMENTAL_protocol_config', { finality: 'final' })]);
      try {
        const a = parseAmount(record(gp)?.gas_price, 'gas price');
        const b = parseAmount(record(pc)?.min_gas_price, 'protocol gas price');
        if (a <= 0n || b <= 0n) throw new RpcUnavailable();
        return a > b ? a : b;
      } catch { throw new RpcUnavailable(); }
    },
    async finalBlock() {
      const h = record(record(await request('block', { finality: 'final' }))?.header);
      if (typeof h?.height !== 'number' || !Number.isSafeInteger(h.height) || typeof h.hash !== 'string' || !h.hash) throw new RpcUnavailable();
      return { height: h.height, id: h.hash };
    },
    async blockHeight(id) {
      const h = record(record(await request('block', { block_id: id }, false, true))?.header);
      if (h?.hash !== id || typeof h.height !== 'number' || !Number.isSafeInteger(h.height) || h.height < 0) throw new RpcUnavailable();
      return h.height;
    },
  };
}

export function spendableNear(a: AccountView | null, reserve: bigint): bigint {
  if (!a) return 0n;
  const free = a.amount - BigInt(a.storageUsage) * MONEY.storageYoctoPerByte - a.locked - reserve;
  return free > 0n ? free : 0n;
}
