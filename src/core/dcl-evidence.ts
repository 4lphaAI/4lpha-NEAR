import { parseAmount } from './amounts.js';
import { record } from './errors.js';
import { DCL, USDC, WNEAR } from './pins.js';
import { dclAction, dclIdentity, DCL_POOL, otherToken, pinnedLptId, pinnedOrderId, sameOrder, type DclOrder, type DclPosition, type DclToken } from './rhea-dcl.js';
import { classifyOutcome, classifySwap, nativePaidTo, readAction, receiptBranch, type SignedAction, type TxStatus } from './receipts.js';

export interface DclProof {
  orderId?: string;
  discovered?: string[];
  completed?: boolean;
  cancelled?: bigint;
  claimed?: bigint;
  created?: bigint;
  bought?: bigint;
  lptId?: string;
  liquidity?: bigint;
  paidX?: bigint;
  paidY?: bigint;
  removed?: bigint;
  x?: bigint;
  y?: bigint;
  discoveredPositions?: string[];
  payouts: Record<string, bigint>;
}
export interface DclBefore { order?: DclOrder; asset?: bigint; position?: DclPosition; assets?: Partial<Record<DclToken, bigint>>; }
export function readDclBefore(serialized: string | null): DclBefore | undefined {
  if (!serialized) return undefined;
  const before = record(JSON.parse(serialized))?.dcl;
  const r = record(before);
  if (!r) return undefined;
  const o = record(r.order), p = record(r.position), a = record(r.assets);
  if (o) return { order: { ...(o as unknown as DclOrder), original: raw(o.original), deposit: raw(o.deposit), instant: raw(o.instant), remain: raw(o.remain),
    bought: raw(o.bought), unclaimed: raw(o.unclaimed), cancelled: raw(o.cancelled), created: raw(o.created) } };
  // Serialized amounts are strings. A remove needs the position and the internal balances together.
  return { ...(r.asset === undefined ? {} : { asset: raw(r.asset) }), ...(p ? { position: { ...(p as unknown as DclPosition), amount: raw(p.amount), feeX: raw(p.feeX), feeY: raw(p.feeY) } } : {}),
    ...(a ? { assets: Object.fromEntries(Object.entries(a).map(([t, n]) => [t, raw(n)])) } : {}) };
}

type Receipt = TxStatus['receipts'][number];
const value = (s: unknown): unknown => typeof s === 'string' ? JSON.parse(Buffer.from(s, 'base64').toString('utf8')) : undefined;
const raw = (n: unknown) => parseAmount(n, 'DCL receipt amount');
const action = (r: Receipt) => r.actions.length === 1 ? readAction(r.actions[0], r.receiver) : null;
const status = (tx: TxStatus, r: Receipt) => tx.outcomes.find(o => o.id === r.id)?.status;
const good = (tx: TxStatus, r: Receipt) => { const s = status(tx, r); return !!s && (Object.hasOwn(s, 'SuccessValue') || Object.hasOwn(s, 'SuccessReceiptId')); };

function events(tx: TxStatus, r: Receipt) {
  if (r.receiver !== DCL || !good(tx, r)) return [];
  return (tx.outcomes.find(o => o.id === r.id)?.logs ?? []).flatMap(log => {
    if (!log.startsWith('EVENT_JSON:')) return [];
    const e = record(JSON.parse(log.slice(11)));
    if (e?.standard !== 'dcl.ref') return [];
    if (e.version !== '1.0.0' || typeof e.event !== 'string' || !Array.isArray(e.data) || e.data.length !== 1 || !record(e.data[0])) throw new Error();
    return [{ name: e.event, data: record(e.data[0])! }];
  });
}

export function discoveredDclOrders(tx: TxStatus, root: string, agent: string): string[] {
  const ids = new Set<string>();
  for (const r of receiptBranch(tx, root)) try {
    for (const e of events(tx, r)) if (e.name === 'order_added' && e.data.owner_id === agent && pinnedOrderId(e.data.order_id)) ids.add(e.data.order_id);
  } catch { /* An unreadable event cannot establish a known id. */ }
  return [...ids];
}

// A lenient scan like discoveredDclOrders: it lets the worker drain a position whose strict proof failed.
export function discoveredDclPositions(tx: TxStatus, root: string, agent: string): string[] {
  const ids = new Set<string>();
  for (const r of receiptBranch(tx, root)) try {
    for (const e of events(tx, r)) if (e.name === 'liquidity_added' && e.data.owner_id === agent && pinnedLptId(e.data.lpt_id)) ids.add(e.data.lpt_id);
  } catch { /* An unreadable event cannot establish a known id. */ }
  return [...ids];
}

function payouts(tx: TxStatus, branch: Receipt[], agent: string, want: Record<string, bigint>): Record<string, bigint> | null {
  const got: Record<string, bigint> = {};
  const count = new Set<string>();
  let unwrap: Receipt | undefined;
  for (const r of branch) {
    if (r.predecessor === DCL && r.receiver === WNEAR && action(r)?.method === 'near_withdraw') {
      if (unwrap || !good(tx, r)) return null;
      unwrap = r;
    }
    const tokenCalls = r.receiver === USDC || r.receiver === WNEAR;
    const incoming = r.receiver === agent && r.predecessor !== 'system' && r.actions.some(a => readAction(a, r.receiver)?.kind === 'Transfer');
    const tokenPayout = tokenCalls && r.actions.some(a => readAction(a, r.receiver)?.method === 'ft_transfer');
    if (!incoming && !tokenPayout) continue;
    const a = action(r), args = record(a?.args);
    if (!good(tx, r) || r.predecessor !== DCL || !a) return null;
    const asset = incoming ? 'native' : r.receiver;
    if (count.has(asset)) return null;
    count.add(asset);
    if (incoming && a.kind === 'Transfer') got.native = a.deposit;
    else if (tokenPayout && a.method === 'ft_transfer' && a.deposit === 1n && args?.receiver_id === agent) got[asset] = raw(args.amount);
    else return null;
  }
  const native = got.native ?? 0n;
  if (native !== nativePaidTo(tx, agent) || (native > 0n && got[WNEAR] !== undefined) || (native > 0n) !== !!unwrap) return null;
  if (unwrap) {
    const back = receiptBranch(tx, unwrap.id).filter(r => r.predecessor === WNEAR && r.receiver === DCL && action(r)?.kind === 'Transfer');
    const callbacks = branch.filter(r => r.predecessor === DCL && r.receiver === DCL && action(r)?.method === 'callback_post_withdraw_near');
    const callback = callbacks.length === 1 ? callbacks[0] : null, args = record(callback && action(callback)?.args);
    if (raw(record(action(unwrap)?.args)?.amount) !== native || action(unwrap)?.deposit !== 1n || back.length !== 1 || !good(tx, back[0]) ||
      action(back[0])?.deposit !== native + 1n || !callback || !good(tx, callback) || args?.user_id !== agent || raw(args?.amount) !== native ||
      !receiptBranch(tx, callback.id).some(r => r.predecessor === DCL && r.receiver === agent && action(r)?.kind === 'Transfer' && action(r)?.deposit === native)) return null;
  }
  for (const token of [USDC, WNEAR]) if (got[token] !== undefined) {
    const callbacks = branch.filter(r => {
      const a = action(r), args = record(a?.args);
      return r.predecessor === DCL && r.receiver === DCL && a?.method === 'callback_post_withdraw_asset' && args?.token_id === token;
    });
    if (callbacks.length !== 1 || !good(tx, callbacks[0]) || value(status(tx, callbacks[0])?.SuccessValue) !== true ||
      record(action(callbacks[0])?.args)?.user_id !== agent || raw(record(action(callbacks[0])?.args)?.amount) !== got[token]) return null;
  }
  if (Object.values(got).some(n => n === 0n) || (got[USDC] ?? 0n) !== (want[USDC] ?? 0n) || (got[WNEAR] ?? native) !== (want[WNEAR] ?? 0n)) return null;
  return got;
}

type Proven = { verdict: 'success' | 'refunded'; used: bigint | null; dcl: DclProof };
function lpReceipt(tx: TxStatus, root: Receipt, branch: Receipt[], a: SignedAction, signed: NonNullable<ReturnType<typeof dclAction>>, agent: string, prior?: DclBefore): Proven | null {
  const args = record(a.args), all = branch.flatMap(r => events(tx, r));
  if (signed.kind === 'dcl_deposit') {
    const token = signed.token!, n = signed.raw!;
    const receives = branch.filter(r => r.predecessor === token && r.receiver === DCL);
    const on = receives.length === 1 ? receives[0] : null, call = on && action(on), onArgs = record(call && call.args);
    if (!on || call?.method !== 'ft_on_transfer' || call.deposit !== 0n || onArgs?.sender_id !== agent || raw(onArgs?.amount) !== n || onArgs?.msg !== args?.msg) return null;
    const resolves = branch.filter(r => r.predecessor === token && r.receiver === token && action(r)?.method === 'ft_resolve_transfer');
    if (resolves.length !== 1) return null;
    const resolve = resolves[0], res = record(action(resolve)?.args);
    if (status(tx, root)?.SuccessReceiptId !== resolve.id || res?.sender_id !== agent || res.receiver_id !== DCL || raw(res.amount) !== n) return null;
    const resolved = raw(value(status(tx, resolve)?.SuccessValue));
    if (raw(value(tx.status.SuccessValue)) !== resolved || all.length || !payouts(tx, branch, agent, {})) return null;
    if (resolved === n && value(status(tx, on)?.SuccessValue) === '0' && classifyOutcome(tx).verdict === 'success') return { verdict: 'success', used: n, dcl: { payouts: {} } };
    // The same refund test as a refused order: the failure sits in DCL's receipt and the token contract returns the full amount.
    if (resolved === 0n && classifySwap(tx, { agent, tokenIn: token, exchange: DCL, amountIn: n }).verdict === 'refunded') return { verdict: 'refunded', used: 0n, dcl: { payouts: {} } };
    return null;
  }
  const rootValue = value(status(tx, root)?.SuccessValue), logs = events(tx, root);
  if (all.length !== 1 || logs.length !== 1) return null;
  const e = logs[0].data;
  if (signed.kind === 'dcl_add') {
    const lptId = e.lpt_id, x = signed.x!, y = signed.y!;
    if (logs[0].name !== 'liquidity_added' || rootValue !== lptId || !pinnedLptId(lptId) || e.owner_id !== agent || e.pool_id !== DCL_POOL || e.left_point !== signed.left || e.right_point !== signed.right) return null;
    const added = raw(e.added_amount), paidX = raw(e.paid_token_x), paidY = raw(e.paid_token_y);
    if (added <= 0n || raw(e.cur_amount) !== added || paidX > x || paidY > y) return null;
    const paid = payouts(tx, branch, agent, { [USDC]: x - paidX, [WNEAR]: y - paidY });
    return paid ? { verdict: 'success', used: null, dcl: { lptId, liquidity: added, paidX, paidY, payouts: paid } } : null;
  }
  const position = prior?.position, n = signed.amount!, top = value(tx.status.SuccessValue);
  if (!position || position.id !== signed.lptId || position.owner !== agent || !Array.isArray(rootValue) || rootValue.length !== 2 || !Array.isArray(top) || top.length !== 2) return null;
  const x = raw(rootValue[0]), y = raw(rootValue[1]);
  if (raw(top[0]) !== x || raw(top[1]) !== y || logs[0].name !== 'liquidity_removed' || e.owner_id !== agent || e.lpt_id !== signed.lptId || e.pool_id !== position.pool ||
    e.left_point !== position.left || e.right_point !== position.right || raw(e.removed_amount) !== n || n > position.amount || raw(e.cur_amount) !== position.amount - n ||
    raw(e.refund_token_x) !== x || raw(e.refund_token_y) !== y || x < BigInt(signed.minX!) || y < BigInt(signed.minY!)) return null;
  const paid = payouts(tx, branch, agent, { [USDC]: x, [WNEAR]: y });
  return paid ? { verdict: 'success', used: null, dcl: { lptId: signed.lptId, removed: n, x, y, payouts: paid } } : null;
}

export function dclReceipt(tx: TxStatus, root: Receipt, a: SignedAction, agent: string, prior?: DclBefore): { verdict: 'success' | 'refunded'; used: bigint | null; dcl: DclProof } | null {
  const signed = dclAction(a);
  if (!signed) return null;
  const branch = receiptBranch(tx, root.id);
  if (signed.kind === 'dcl_place') {
    const sell = signed.sell!, n = signed.raw!, msg = record(a.args)?.msg;
    const receives = branch.filter(r => r.predecessor === sell && r.receiver === DCL);
    const on = receives.length === 1 ? receives[0] : null, call = on && action(on), args = record(call && call.args);
    if (!on || call?.method !== 'ft_on_transfer' || call.deposit !== 0n || args?.sender_id !== agent || raw(args?.amount) !== n || args?.msg !== msg) return null;
    const resolves = branch.filter(r => r.predecessor === sell && r.receiver === sell && action(r)?.method === 'ft_resolve_transfer');
    if (resolves.length !== 1) return null;
    const resolve = resolves[0], res = record(action(resolve)?.args);
    if (status(tx, root)?.SuccessReceiptId !== resolve.id || res?.sender_id !== agent || res.receiver_id !== DCL || raw(res.amount) !== n) return null;
    const resolved = raw(value(status(tx, resolve)?.SuccessValue));
    if (raw(value(tx.status.SuccessValue)) !== resolved) return null;
    const transfer = classifySwap(tx, { agent, tokenIn: sell, exchange: DCL, amountIn: n });
    const logs = branch.flatMap(r => events(tx, r));
    const noPayout = payouts(tx, branch, agent, {});
    if (resolved === 0n && noPayout && !logs.length && (transfer.verdict === 'refunded' || classifyOutcome(tx).verdict === 'success')) return { verdict: 'refunded', used: 0n, dcl: { payouts: {} } };
    const onLogs = events(tx, on), added = onLogs.filter(e => e.name === 'order_added');
    const zero = onLogs.filter(e => e.name === 'swap');
    if (added.length !== 1 || zero.length > 1 || logs.length !== 1 + zero.length || transfer.verdict !== 'swapped' || !noPayout) return null;
    if (zero.length) {
      const z = zero[0].data;
      if (z.swapper !== agent || z.pool_id !== added[0].data.pool_id || z.token_in !== sell || z.token_out !== otherToken(sell) || z.referral_id !== null ||
        [z.amount_in, z.amount_out, z.total_fee, z.protocol_fee, z.referral_fee].some(n => raw(n) !== 0n)) return null;
    }
    const o = dclIdentity(added[0].data, agent);
    if (!pinnedOrderId(o.id) || o.sell !== sell || o.buy !== otherToken(sell) || o.point !== signed.point || o.original !== n ||
      raw(added[0].data.original_deposit_amount) !== n || raw(added[0].data.swap_earn_amount) !== 0n) return null;
    return { verdict: 'success', used: n, dcl: { orderId: o.id, created: raw(added[0].data.created_at), payouts: {} } };
  }
  // A refused deposit has an inner failure and no prior state, so it dispatches before the gate below.
  if (signed.kind === 'dcl_deposit') return lpReceipt(tx, root, branch, a, signed, agent);
  if (!prior || classifyOutcome(tx).verdict !== 'success') return null;
  if (signed.kind === 'dcl_add' || signed.kind === 'dcl_remove') return lpReceipt(tx, root, branch, a, signed, agent, prior);
  if (signed.kind === 'dcl_withdraw') {
    const token = signed.token!, want = prior.asset ?? 0n;
    if (want <= 0n || branch.flatMap(r => events(tx, r)).length) return null;
    const paid = payouts(tx, branch, agent, { [token]: want });
    if (!paid) return null;
    return { verdict: 'success', used: null, dcl: { payouts: paid } };
  }
  const id = signed.id!, order = prior.order;
  if (!order || order.id !== id || order.owner !== agent) return null;
  const pair = value(status(tx, root)?.SuccessValue);
  const top = value(tx.status.SuccessValue);
  if (!Array.isArray(pair) || pair.length !== 2 || !Array.isArray(top) || top.length !== 2) return null;
  const cancelled = raw(pair[0]), claimed = raw(pair[1]);
  if (raw(top[0]) !== cancelled || raw(top[1]) !== claimed || cancelled > order.remain || (signed.kind === 'dcl_claim' && cancelled !== 0n)) return null;
  const logs = events(tx, root);
  const c = logs[0]?.name === 'order_cancelled' ? logs[0].data : null;
  const completed = logs[1]?.name === 'order_completed' ? logs[1].data : null;
  if (!c || logs.length !== (completed ? 2 : 1) || branch.flatMap(r => events(tx, r)).length !== logs.length ||
    !sameOrder(order, dclIdentity(c, agent)) || raw(c.created_at) !== order.created || raw(c.actual_cancel_amount) !== cancelled ||
    raw(c.cancel_amount) !== order.cancelled + cancelled || raw(c.bought_amount) < claimed || raw(c.remain_amount) + raw(c.cancel_amount) > order.original ||
    (signed.kind === 'dcl_claim' ? raw(c.request_cancel_amount) !== 0n : c.request_cancel_amount !== null)) return null;
  if (completed && (!sameOrder(order, dclIdentity(completed, agent)) || raw(completed.created_at) !== order.created ||
    raw(completed.original_deposit_amount) !== order.deposit || raw(completed.swap_earn_amount) !== order.instant ||
    raw(completed.bought_amount) !== raw(c.bought_amount) || raw(completed.cancel_amount) !== raw(c.cancel_amount) || raw(c.remain_amount) !== 0n)) return null;
  const paid = payouts(tx, branch, agent, { [order.sell]: cancelled, [order.buy]: claimed });
  return paid ? { verdict: 'success', used: null, dcl: { orderId: id, completed: !!completed, cancelled, claimed, bought: raw(c.bought_amount), payouts: paid } } : null;
}
