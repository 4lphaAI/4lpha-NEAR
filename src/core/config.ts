import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { CoreError, record } from './errors.js';
import { DEFAULT_RPC, DRPC_READ, type RpcEndpoints } from './near-rpc.js';
import { OUTLAYER_API_DEFAULT } from './pins.js';
import { createLpAi } from './lp-ai.js';

export interface WebEnv { host: string; port: number; origin: string; liveHires: boolean; gridV1?: boolean; gridV2?: boolean; lpV1?: boolean; memePaper?: boolean; tradeV1?: boolean; demo?: boolean; demoDb?: string; }

export function webEnv(env: NodeJS.ProcessEnv = process.env): WebEnv {
  const host = env.FOURLPHA_WEB_HOST || '127.0.0.1';
  const port = Number(env.FOURLPHA_WEB_PORT || 8090);
  const bindHost = host.includes(':') ? `[${host}]` : host;
  const input = env.FOURLPHA_WEB_ORIGIN || `http://${bindHost}:${port}`;
  const origin = new URL(input);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !['http:', 'https:'].includes(origin.protocol) || origin.origin !== input) {
    throw new CoreError('bad_request', 'Invalid web origin or port.');
  }
  // Demo mode D-7: a demo instance never sits next to live hires, so the anonymous demo cookie never shares a process with live money.
  if (env.FOURLPHA_DEMO === '1' && env.FOURLPHA_LIVE_HIRES === '1') throw new CoreError('bad_request', 'Demo mode and live hires cannot run in one web process.');
  // Demo in the main app (DEMO-MODE-COMBINED-PLAN section 1): the demo routes use a second store on their own database, never the live one.
  // A standalone demo web (FOURLPHA_DEMO=1) ignores this path and keeps its single demo database.
  const demoDb = env.FOURLPHA_DEMO === '1' ? undefined : env.FOURLPHA_DEMO_DB_PATH || undefined;
  const file = (p: string) => process.platform === 'win32' ? resolve(p).toLowerCase().replace(/[. ]+$/, '') : resolve(p);
  if (demoDb !== undefined && file(demoDb) === file(env.FOURLPHA_DB_PATH || 'data/4lpha-near.db')) throw new CoreError('bad_request', 'The demo database must be a different file from the live database.');
  return { host, port, origin: origin.origin, liveHires: env.FOURLPHA_LIVE_HIRES === '1', gridV1: env.FOURLPHA_GRID_V1 === '1', gridV2: env.FOURLPHA_GRID_V1 === '1' && env.FOURLPHA_GRID_V2 === '1', lpV1: env.FOURLPHA_LP_V1 === '1', memePaper: env.FOURLPHA_MEME_PAPER === '1', tradeV1: env.FOURLPHA_TRADE_V1 === '1',
    ...(env.FOURLPHA_DEMO === '1' ? { demo: true } : demoDb !== undefined ? { demoDb } : {}) };
}

export function localEnv(path = '.env.local'): Record<string, string | undefined> {
  try { return parseEnv(readFileSync(path, 'utf8')); }
  catch (e) {
    if (record(e)?.code === 'ENOENT') return {};
    throw new CoreError('bad_request', 'The local settings file cannot be read.');
  }
}

export function lpAiEnv(local = localEnv()) {
  return local.NEAR_AI_API_KEY ? createLpAi(local.NEAR_AI_API_KEY, local.NEAR_AI_MODEL || 'z-ai/glm-5.3-flash') : undefined;
}

export function rpcEnv(env: NodeJS.ProcessEnv = process.env, local = localEnv()): RpcEndpoints {
  const r = env.FOURLPHA_RPC_URLS?.split(',').map(s => s.trim());
  if (r && (r.length !== 2 || !r[0] || !r[1])) throw new CoreError('bad_request', 'Set exactly two read RPC URLs.');
  let auth: RpcEndpoints['auth'];
  if (!r && local.Near_RPC !== undefined) {
    const url = URL.canParse(local.Near_RPC) ? new URL(local.Near_RPC) : null, token = local.Auth_Token;
    // A broken local file refuses to start and never falls back to the public RPC. The message carries no value from the file.
    if (!url || url.protocol !== 'https:' || !url.hostname.endsWith('.near-mainnet.quiknode.pro') || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash || !token || /\s/.test(token)) throw new CoreError('bad_request', 'Set a valid Near_RPC and Auth_Token in the local settings file.');
    auth = { origin: url.origin, token };
  }
  const archival = env.FOURLPHA_ARCHIVAL_RPC_URL;
  return { read: r ? [r[0], r[1]] : auth ? [auth.origin, DEFAULT_RPC.read[0], DRPC_READ] : [...DEFAULT_RPC.read, DRPC_READ], archival: archival || auth?.origin || DEFAULT_RPC.archival,
    ...(archival ? { archivalOverride: true } : {}), ...(auth ? { auth } : {}) };
}

/** RPC budget hotfix (operator, 2026-11-12): the watchdog and the web read public dRPC first and fall back to QuickNode, then public FastNEAR.
 * Receipts keep the archival route. The worker keeps QuickNode first. Without QuickNode settings the endpoints are unchanged. */
export function dRpcFirst(endpoints: RpcEndpoints): RpcEndpoints {
  return endpoints.auth ? { ...endpoints, read: [DRPC_READ, endpoints.auth.origin, DEFAULT_RPC.read[0]] } : endpoints;
}

/** RPC budget (operator, 2026-11-13): the worker's idle evaluation reads try public dRPC, then public FastNEAR, then QuickNode.
 * Reads that decide or prove a submission keep the worker's QuickNode-first client. Without QuickNode settings the endpoints are unchanged. */
export function freeFirst(endpoints: RpcEndpoints): RpcEndpoints {
  return endpoints.auth ? { ...endpoints, read: [DRPC_READ, DEFAULT_RPC.read[0], endpoints.auth.origin] } : endpoints;
}

export function rpcLabel(endpoints: RpcEndpoints): string {
  return endpoints.auth ? (endpoints.read[0] === DRPC_READ ? 'dRPC first, QuickNode fallback' : 'QuickNode') : endpoints.read[0] === DEFAULT_RPC.read[0] ? 'public FastNEAR' : 'custom';
}

export function dbPath() { return process.env.FOURLPHA_DB_PATH || 'data/4lpha-near.db'; }
export function outlayerUrl() { return process.env.FOURLPHA_OUTLAYER_API || OUTLAYER_API_DEFAULT; }
