import { isAccountId, parseAmount, TGAS, YOCTO_PER_NEAR as N } from './amounts.js';
import { CoreError, record } from './errors.js';
import { RpcUnavailable, type NearRpc } from './near-rpc.js';
import type { CallRequest } from './outlayer.js';
import { DCL, USDC, WNEAR } from './pins.js';
import type { SignedAction } from './receipts.js';

export const DCL_POOL = `${USDC}|${WNEAR}|100`;
export const DCL_STORAGE = N / 2n;
export const DCL_GAS = { dcl_place: 250n * TGAS, dcl_claim: 180n * TGAS, dcl_cancel: 180n * TGAS, dcl_withdraw: 250n * TGAS,
  dcl_deposit: 150n * TGAS, dcl_add: 150n * TGAS, dcl_remove: 150n * TGAS };
export type DclKind = keyof typeof DCL_GAS;
export type DclToken = typeof USDC | typeof WNEAR;
export const GRID_DCL_KINDS: readonly DclKind[] = ['dcl_place', 'dcl_claim', 'dcl_cancel', 'dcl_withdraw'];
export const LP_DCL_KINDS: readonly DclKind[] = ['dcl_deposit', 'dcl_add', 'dcl_remove', 'dcl_withdraw'];
export const jobDclKinds = (job: { gridV1: boolean; lpV1: boolean }): readonly DclKind[] => job.gridV1 ? GRID_DCL_KINDS : job.lpV1 ? LP_DCL_KINDS : [];
export interface DclPosition { id: string; owner: string; pool: string; left: number; right: number; amount: bigint; mft: string; feeX: bigint; feeY: bigint; }
export interface DclIdentity { id: string; owner: string; pool: string; sell: string; buy: string; point: number; original: bigint; }
export interface DclOrder extends DclIdentity { deposit: bigint; instant: bigint; remain: bigint; bought: bigint; unclaimed: bigint; cancelled: bigint; created: bigint; }
export interface DclState {
  point: number;
  storage: { sponsor: string; locked: bigint; slots: number; orders: number; positions: number } | null;
  active: DclOrder[];
  history: DclOrder[];
  orders: Record<string, DclOrder | null>;
  assets: Record<string, bigint>;
  lost: Record<string, bigint>;
  positions: number;
  liquidities: DclPosition[];
}

export const dclToken = (t: unknown): t is DclToken => t === USDC || t === WNEAR;
export const otherToken = (t: DclToken): DclToken => t === USDC ? WNEAR : USDC;
export { validPoint } from './pins.js';
import { validPoint } from './pins.js';
const parts = (pool: unknown) => {
  const p = typeof pool === 'string' ? pool.split('|') : [];
  if (p.length !== 3 || !isAccountId(p[0]) || !isAccountId(p[1]) || p[0] >= p[1] || !/^\d{1,5}$/.test(p[2])) throw new RpcUnavailable();
  return p;
};
const idOf = (pool: string, id: unknown) => typeof id === 'string' && id.startsWith(`${pool}#`) && /^(?:0|[1-9]\d{0,19})$/.test(id.slice(pool.length + 1)) && BigInt(id.slice(pool.length + 1)) <= 2n ** 64n - 1n;
export const pinnedOrderId = (id: unknown): id is string => idOf(DCL_POOL, id);
// Order ids and lpt ids share one shape, so each use site names which one it means.
export const pinnedLptId = (id: unknown): id is string => idOf(DCL_POOL, id);
const amount = (v: unknown) => {
  if (typeof v !== 'string' || v.length > 39) throw new RpcUnavailable();
  const n = parseAmount(v, 'DCL amount');
  if (n > 2n ** 128n - 1n) throw new RpcUnavailable();
  return n;
};
const uint = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const rows = (v: unknown): unknown[] => { if (!Array.isArray(v)) throw new RpcUnavailable(); return v; };

export function dclIdentity(v: unknown, owner: string): DclIdentity {
  const r = record(v), p = parts(r?.pool_id);
  if (!r || typeof r.pool_id !== 'string' || !idOf(r.pool_id, r.order_id) || r.owner_id !== owner || !validPoint(r.point) ||
    typeof r.sell_token !== 'string' || typeof r.buy_token !== 'string' || r.sell_token === r.buy_token || !p.slice(0, 2).includes(r.sell_token) || !p.slice(0, 2).includes(r.buy_token)) throw new RpcUnavailable();
  const original = amount(r.original_amount);
  if (original === 0n) throw new RpcUnavailable();
  return { id: String(r.order_id), owner, pool: r.pool_id, sell: r.sell_token, buy: r.buy_token, point: r.point, original };
}

export const sameOrder = (a: DclIdentity, b: DclIdentity) => a.id === b.id && a.owner === b.owner && a.pool === b.pool && a.sell === b.sell && a.buy === b.buy && a.point === b.point && a.original === b.original;

function readOrder(v: unknown, owner: string, history: boolean): DclOrder {
  const r = record(v), i = dclIdentity(r, owner);
  const o = { ...i, deposit: amount(r?.original_deposit_amount), instant: amount(r?.swap_earn_amount), remain: amount(r?.remain_amount),
    bought: amount(r?.bought_amount), unclaimed: history && r?.unclaimed_amount === null ? 0n : amount(r?.unclaimed_amount), cancelled: amount(r?.cancel_amount), created: amount(r?.created_at) };
  if (o.deposit < o.original || o.remain + o.cancelled > o.original || o.unclaimed > o.bought) throw new RpcUnavailable();
  return o;
}

function assetMap(v: unknown): Record<string, bigint> {
  const r = record(v);
  if (!r) throw new RpcUnavailable();
  return Object.fromEntries(Object.entries(r).map(([token, raw]) => { if (!isAccountId(token)) throw new RpcUnavailable(); return [token, amount(raw)]; }));
}

export async function readDcl(rpc: NearRpc, owner: string, block: { blockId: string; block: number }, known: readonly string[] = []): Promise<DclState> {
  try {
    if (!isAccountId(owner) || known.some(id => !pinnedOrderId(id))) throw new RpcUnavailable();
    const view = async (method: string, args: Record<string, unknown>) => {
      const r = await rpc.view(DCL, method, args, block.blockId);
      if (r.height !== block.block || r.blockId !== block.blockId) throw new RpcUnavailable();
      return r.value;
    };
    const account = { account_id: owner };
    const [meta, pool, bounds, s, a, h, assets, lost, l] = await Promise.all([
      view('get_metadata', {}), view('get_pool', { pool_id: DCL_POOL }), view('storage_balance_bounds', {}), view('get_user_storage_detail', { user_id: owner }),
      view('list_active_orders', account), view('list_history_orders', account), view('list_user_assets', account), view('list_lostfound', account), view('list_liquidities', account),
    ]);
    const m = record(meta), p = record(pool), b = record(bounds), raw = record(s);
    // Pinned to the version checked in FINDINGS 1.38. Any other version blocks every DCL read, exit included (ruling 2026-11-07).
    if (m?.version !== '2.4.2' || m.state !== 'Running' || p?.pool_id !== DCL_POOL || p.token_x !== USDC || p.token_y !== WNEAR ||
      p.fee !== 100 || p.point_delta !== 1 || p.state !== 'Running' || !validPoint(p.current_point) || amount(b?.min) !== DCL_STORAGE || b?.max !== null) throw new RpcUnavailable();
    let storage: DclState['storage'] = null;
    if (s !== null) {
      if (!isAccountId(raw?.sponsor_id) || !uint(raw.max_slots) || !uint(raw.cur_order_slots) || !uint(raw.cur_liquidity_slots) || raw.cur_order_slots + raw.cur_liquidity_slots > raw.max_slots) throw new RpcUnavailable();
      const locked = amount(raw.locked_near), forAssets = amount(raw.storage_for_asset), perSlot = amount(raw.slot_price);
      if (perSlot === 0n || locked < forAssets || (locked - forAssets) / perSlot !== BigInt(raw.max_slots)) throw new RpcUnavailable();
      storage = { sponsor: raw.sponsor_id, locked, slots: raw.max_slots, orders: raw.cur_order_slots, positions: raw.cur_liquidity_slots };
    }
    const active = rows(a).map(x => readOrder(x, owner, false)), history = rows(h).map(x => readOrder(x, owner, true));
    if (new Set(active.map(o => o.id)).size !== active.length || new Set(history.map(o => o.id)).size !== history.length) throw new RpcUnavailable();
    // v_liquidity is ignored and not required. A position on another pool must parse, so that lpBlocked can see it.
    const liquidities = rows(l).map((v): DclPosition => {
      const r = record(v);
      parts(r?.pool_id);
      if (!r || typeof r.pool_id !== 'string' || !idOf(r.pool_id, r.lpt_id) || r.owner_id !== owner || !validPoint(r.left_point) || !validPoint(r.right_point) ||
        r.left_point >= r.right_point || typeof r.mft_id !== 'string') throw new RpcUnavailable();
      return { id: String(r.lpt_id), owner, pool: r.pool_id, left: r.left_point, right: r.right_point, amount: amount(r.amount), mft: r.mft_id,
        feeX: amount(r.unclaimed_fee_x), feeY: amount(r.unclaimed_fee_y) };
    });
    const positions = liquidities.length;
    const orders = Object.fromEntries(await Promise.all([...new Set([...known, ...active.filter(o => o.pool === DCL_POOL).map(o => o.id),
      ...history.filter(o => o.pool === DCL_POOL && (o.remain > 0n || o.unclaimed > 0n)).map(o => o.id)])].map(async id => {
      const v = await view('get_order', { order_id: id });
      const o = v === null ? null : readOrder(v, owner, false);
      const listed = active.find(r => r.id === id) ?? history.find(r => r.id === id);
      if (o && (o.id !== id || (listed && !sameOrder(o, listed)))) throw new RpcUnavailable();
      return [id, o] as const;
    })));
    return { point: p.current_point, storage, active, history, orders, assets: assetMap(assets), lost: assetMap(lost), positions, liquidities };
  } catch { throw new RpcUnavailable(); }
}

/** Reads predict_remove_liquidity at the given finalized block. Any failure, a panic such as E207 included, is an unavailable read. */
export async function predictRemove(rpc: NearRpc, lptId: string, amountRaw: bigint, block: { blockId: string; block: number }): Promise<[bigint, bigint]> {
  try {
    if (!pinnedLptId(lptId) || amountRaw <= 0n) throw new RpcUnavailable();
    const r = await rpc.view(DCL, 'predict_remove_liquidity', { lpt_id: lptId, amount: amountRaw.toString() }, block.blockId);
    if (r.height !== block.block || r.blockId !== block.blockId || !Array.isArray(r.value) || r.value.length !== 2) throw new RpcUnavailable();
    return [amount(r.value[0]), amount(r.value[1])];
  } catch { throw new RpcUnavailable(); }
}

export async function readPoolPoint(rpc: NearRpc): Promise<number> {
  try {
    if (!rpc.finalBlock) throw new RpcUnavailable();
    const block = await rpc.finalBlock();
    const [meta, pool] = await Promise.all([rpc.view(DCL, 'get_metadata', {}, block.id), rpc.view(DCL, 'get_pool', { pool_id: DCL_POOL }, block.id)]);
    const m = record(meta.value), p = record(pool.value);
    if ([meta, pool].some(r => r.height !== block.height || r.blockId !== block.id) || m?.version !== '2.4.2' || m.state !== 'Running' ||
      p?.pool_id !== DCL_POOL || p.token_x !== USDC || p.token_y !== WNEAR || p.fee !== 100 || p.point_delta !== 1 || p.state !== 'Running' || !validPoint(p.current_point)) throw new RpcUnavailable();
    return p.current_point;
  } catch { throw new RpcUnavailable(); }
}

export function toNearDown(raw: bigint, point: number): bigint {
  if (raw < 0n || !validPoint(point)) throw new RpcUnavailable();
  const scale = 10n ** 60n;
  const ceil = (n: bigint) => (n + scale - 1n) / scale;
  let factor = point < 0 ? scale * 10_000n / 10_001n : scale * 10_001n / 10_000n, power = scale;
  let upperFactor = point < 0 ? (scale * 10_000n + 10_000n) / 10_001n : factor, upper = scale;
  for (let p = Math.abs(point); p > 0; p = Math.floor(p / 2)) {
    if (p % 2) { power = power * factor / scale; upper = ceil(upper * upperFactor); }
    if (p > 1) { factor = factor * factor / scale; upperFactor = ceil(upperFactor * upperFactor); }
  }
  const low = raw * power / scale;
  if (low === raw * upper / scale) return low;
  // Exact integer boundaries can straddle the directed bounds, such as 10001 at point -1.
  const exponent = BigInt(Math.abs(point));
  return raw * (point < 0 ? 10_000n : 10_001n) ** exponent / (point < 0 ? 10_001n : 10_000n) ** exponent;
}

export function dclRegistered(s: DclState, owner: string, initial = false): boolean {
  const r = s.storage;
  return !!r && r.sponsor === owner && r.locked >= DCL_STORAGE && r.slots >= 4 && (!initial || r.slots - r.orders - r.positions >= 4);
}

export function completedOrder(s: DclState, id: string): DclOrder | undefined {
  const o = s.orders[id];
  return o && (o.remain > 0n || o.unclaimed > 0n) ? undefined : s.history.find(r => r.id === id && r.remain === 0n && r.unclaimed === 0n && (!o || sameOrder(r, o)));
}

export function dclOpen(s: DclState): DclOrder[] {
  return Object.entries(s.orders).flatMap(([id, o]) => o && !completedOrder(s, id) ? [o] : []);
}

export function dclBlocked(s: DclState): boolean {
  return s.positions > 0 || (s.storage?.positions ?? 0) > 0 || Object.values(s.lost).some(n => n > 0n) || Object.entries(s.assets).some(([t, n]) => !dclToken(t) && n > 0n) ||
    s.active.some(o => o.pool !== DCL_POOL || !s.orders[o.id]) || s.history.some(o => (o.remain > 0n || o.unclaimed > 0n) && !s.orders[o.id]) ||
    Object.entries(s.orders).some(([id, o]) => !o && !completedOrder(s, id)) || (s.storage?.orders ?? 0) > dclOpen(s).length;
}

/** True if DCL holds anything LP V1 does not cover. A known position that is not listed does not block. */
export function lpBlocked(s: DclState, knownPositions: readonly string[]): boolean {
  return s.active.length > 0 || s.history.some(o => o.remain > 0n || o.unclaimed > 0n) || Object.values(s.lost).some(n => n > 0n) ||
    Object.entries(s.assets).some(([t, n]) => !dclToken(t) && n > 0n) ||
    s.liquidities.some(p => !knownPositions.includes(p.id) || p.pool !== DCL_POOL || p.mft !== '') ||
    (s.storage?.positions ?? 0) !== s.liquidities.length || (s.storage?.orders ?? 0) > 0;
}

export function dclRegistration(agent: string): CallRequest {
  return { receiverId: DCL, methodName: 'storage_deposit', args: { account_id: agent, registration_only: true }, gas: 50n * TGAS, deposit: DCL_STORAGE };
}

export function dclPlace(sell: DclToken, raw: bigint, point: number): CallRequest {
  return { receiverId: sell, methodName: 'ft_transfer_call', args: { receiver_id: DCL, amount: raw.toString(),
    msg: JSON.stringify({ LimitOrderWithSwap: { client_id: '', pool_id: DCL_POOL, buy_token: otherToken(sell), point } }) }, gas: DCL_GAS.dcl_place, deposit: 1n };
}
export function dclClose(id: string, kind: 'dcl_claim' | 'dcl_cancel'): CallRequest {
  return { receiverId: DCL, methodName: 'cancel_order', args: { order_id: id, ...(kind === 'dcl_claim' ? { amount: '0' } : {}) }, gas: DCL_GAS[kind], deposit: 0n };
}
export function dclWithdraw(token: DclToken): CallRequest {
  return { receiverId: DCL, methodName: 'withdraw_asset', args: { token_id: token }, gas: DCL_GAS.dcl_withdraw, deposit: 0n };
}

export function dclDeposit(token: DclToken, raw: bigint): CallRequest {
  if (!dclToken(token) || raw <= 0n) throw new CoreError('bad_request', 'Invalid DCL deposit.');
  return { receiverId: token, methodName: 'ft_transfer_call', args: { receiver_id: DCL, amount: raw.toString(), msg: '"Deposit"' }, gas: DCL_GAS.dcl_deposit, deposit: 1n };
}
export function lpAdd(left: number, right: number, x: bigint, y: bigint): CallRequest {
  if (!validPoint(left) || !validPoint(right) || left >= right || x <= 0n || y <= 0n) throw new CoreError('bad_request', 'Invalid LP range or amounts.');
  return { receiverId: DCL, methodName: 'add_liquidity', args: { pool_id: DCL_POOL, left_point: left, right_point: right, amount_x: x.toString(), amount_y: y.toString(),
    min_amount_x: '0', min_amount_y: '0' }, gas: DCL_GAS.dcl_add, deposit: 0n };
}
export function lpRemove(lptId: string, amountRaw: bigint, minX: string, minY: string): CallRequest {
  if (!pinnedLptId(lptId) || amountRaw <= 0n || !/^\d+$/.test(minX) || !/^\d+$/.test(minY)) throw new CoreError('bad_request', 'Invalid LP removal.');
  return { receiverId: DCL, methodName: 'remove_liquidity', args: { lpt_id: lptId, amount: amountRaw.toString(), min_amount_x: minX, min_amount_y: minY }, gas: DCL_GAS.dcl_remove, deposit: 0n };
}

export interface DclActionFields { kind: DclKind; sell?: DclToken; raw?: bigint; point?: number; id?: string; token?: DclToken;
  left?: number; right?: number; x?: bigint; y?: bigint; lptId?: string; amount?: bigint; minX?: string; minY?: string; }
export function dclAction(a: SignedAction): DclActionFields | null {
  const r = record(a.args);
  if (a.kind !== 'FunctionCall' || !r) return null;
  try {
    // The deposit message is the JSON string "Deposit", which the order branch below must never see.
    if (a.method === 'ft_transfer_call' && a.deposit === 1n && dclToken(a.receiver) && Object.keys(r).length === 3 && r.receiver_id === DCL && r.msg === '"Deposit"') {
      const raw = amount(r.amount);
      return raw > 0n ? { kind: 'dcl_deposit', token: a.receiver, raw } : null;
    }
    if (a.method === 'ft_transfer_call' && a.deposit === 1n && dclToken(a.receiver) && Object.keys(r).length === 3 && r.receiver_id === DCL && typeof r.msg === 'string') {
      const msg = record(JSON.parse(r.msg)), order = record(msg?.LimitOrderWithSwap), raw = amount(r.amount);
      if (msg && Object.keys(msg).length === 1 && order && Object.keys(order).length === 4 && order.client_id === '' && order.pool_id === DCL_POOL &&
        order.buy_token === otherToken(a.receiver) && validPoint(order.point) && raw > 0n) return { kind: 'dcl_place', sell: a.receiver, raw, point: order.point };
    }
    if (a.receiver === DCL && a.deposit === 0n) {
      if (a.method === 'withdraw_asset' && Object.keys(r).length === 1 && dclToken(r.token_id)) return { kind: 'dcl_withdraw', token: r.token_id };
      if (a.method === 'add_liquidity' && Object.keys(r).length === 7 && r.pool_id === DCL_POOL && validPoint(r.left_point) && validPoint(r.right_point) && r.left_point < r.right_point &&
        r.min_amount_x === '0' && r.min_amount_y === '0') {
        const x = amount(r.amount_x), y = amount(r.amount_y);
        if (x > 0n && y > 0n) return { kind: 'dcl_add', left: r.left_point, right: r.right_point, x, y };
      }
      if (a.method === 'remove_liquidity' && Object.keys(r).length === 4 && pinnedLptId(r.lpt_id)) {
        const n = amount(r.amount), minX = amount(r.min_amount_x), minY = amount(r.min_amount_y);
        if (n > 0n) return { kind: 'dcl_remove', lptId: r.lpt_id, amount: n, minX: minX.toString(), minY: minY.toString() };
      }
      if (a.method === 'cancel_order' && pinnedOrderId(r.order_id)) {
        if (Object.keys(r).length === 2 && r.amount === '0') return { kind: 'dcl_claim', id: r.order_id };
        if (Object.keys(r).length === 1) return { kind: 'dcl_cancel', id: r.order_id };
      }
    }
  } catch { return null; }
  return null;
}

export function requireDclRegistration(s: DclState, owner: string) {
  if (!dclRegistered(s, owner)) throw new CoreError('policy_invalid', 'Owner-paid DCL registration is not finalized or has unexpected storage.');
}

// Directed rounding at each multiply keeps the fixed-point power an upper bound in either direction.
export function limitProceeds(sell: DclToken, raw: bigint, point: number): bigint {
  if (raw < 0n || !validPoint(point)) throw new RpcUnavailable();
  const scale = 10n ** 60n;
  const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
  let p = sell === USDC ? point : -point;
  let factor = p < 0 ? ceil(scale * 10_000n, 10_001n) : scale * 10_001n / 10_000n;
  let power = scale;
  for (p = Math.abs(p); p > 0; p = Math.floor(p / 2)) {
    if (p % 2) power = ceil(power * factor, scale);
    if (p > 1) factor = ceil(factor * factor, scale);
  }
  return ceil(raw * power, scale);
}
