import { parseAmount } from './amounts.js';
import { CoreError, record } from './errors.js';
import { RpcUnavailable, type NearRpc } from './near-rpc.js';
import type { CallRequest } from './outlayer.js';
import { CLASSIC_EXCHANGE, CLASSIC_POOLS, GAS, WNEAR, type PinnedPool } from './pins.js';
import type { TradePair } from './trade-pairs.js';

export async function readExchangeMeta(rpc: NearRpc): Promise<{ version: string; state: string }> {
  const r = record((await rpc.view(CLASSIC_EXCHANGE, 'metadata', {})).value);
  if (typeof r?.version !== 'string' || typeof r.state !== 'string') throw new RpcUnavailable();
  return { version: r.version, state: r.state };
}

export function poolProblems(pool: unknown, pin: PinnedPool): string[] {
  const r = record(pool), t = r?.token_account_ids;
  return [...(r?.pool_kind !== pin.kind ? ['Pool kind changed.'] : []),
    ...(!Array.isArray(t) || t.length !== 2 || !pin.tokens.every(id => t.includes(id)) ? ['Pool tokens changed.'] : [])];
}

export function pinnedPool(candidate: PinnedPool): PinnedPool {
  const pin = CLASSIC_POOLS.find(p => candidate.poolId === p.poolId && candidate.kind === p.kind && candidate.feeBps === p.feeBps &&
    candidate.tokens.length === 2 && p.tokens.every(t => candidate.tokens.includes(t)));
  if (!pin) throw new CoreError('bad_request', 'The requested pool is not pinned.');
  return pin;
}

export async function readPool(rpc: NearRpc, candidate: PinnedPool): Promise<{ height: number; amounts: Readonly<Record<string, bigint>> }> {
  const pin = pinnedPool(candidate);
  const { height, value } = await rpc.view(CLASSIC_EXCHANGE, 'get_pool', { pool_id: pin.poolId });
  if (poolProblems(value, pin).length) throw new CoreError('policy_invalid', 'The classic pool does not match its pin.');
  const r = record(value);
  if (!Array.isArray(r?.amounts) || r.amounts.length !== 2 || !Array.isArray(r.token_account_ids)) throw new RpcUnavailable();
  const amounts = r.amounts;
  try { return { height, amounts: Object.fromEntries(r.token_account_ids.map((t, i) => [t, parseAmount(amounts[i], 'pool balance')])) }; }
  catch { throw new RpcUnavailable(); }
}

/** Trade V1 spec section 4: one get_pool read with the fee pinned too. poolProblems stays unchanged for Grid and LP, whose reads carry no fee check. */
export async function readTradePool(rpc: NearRpc, pair: TradePair): Promise<{ height: number; wnear: bigint; token: bigint; fee: number }> {
  const pin = pinnedPool(pair.pin);
  const { height, value } = await rpc.view(CLASSIC_EXCHANGE, 'get_pool', { pool_id: pin.poolId });
  const r = record(value), problems = [...poolProblems(value, pin), ...(typeof r?.total_fee === 'number' && r.total_fee !== pin.feeBps ? ['Pool fee changed.'] : [])];
  if (problems.length) throw new CoreError('policy_invalid', `Classic pool ${pin.poolId} does not match its pin. ${problems.join(' ')}`);
  if (typeof r?.total_fee !== 'number' || !Array.isArray(r.amounts) || r.amounts.length !== 2 || !Array.isArray(r.token_account_ids)) throw new RpcUnavailable();
  const ids = r.token_account_ids, amounts = r.amounts;
  try {
    const of = (token: string) => parseAmount(amounts[ids.indexOf(token)], 'pool balance');
    return { height, wnear: of(WNEAR), token: of(pair.token), fee: r.total_fee };
  } catch { throw new RpcUnavailable(); }
}

export async function quote(rpc: NearRpc, candidate: PinnedPool, tokenIn: string, amountIn: bigint, tokenOut: string): Promise<bigint> {
  const pin = pinnedPool(candidate);
  if (amountIn <= 0n || tokenIn === tokenOut || !pin.tokens.includes(tokenIn) || !pin.tokens.includes(tokenOut)) throw new CoreError('bad_request', 'Invalid swap direction or amount.');
  const r = await rpc.view(CLASSIC_EXCHANGE, 'get_return', { pool_id: pin.poolId, token_in: tokenIn, amount_in: amountIn.toString(), token_out: tokenOut });
  try { return parseAmount(r.value, 'quote'); } catch { throw new RpcUnavailable(); }
}

export async function requireVenue(rpc: NearRpc, pin: PinnedPool): Promise<void> {
  const m = await readExchangeMeta(rpc);
  if (m.version !== '1.9.21' || m.state !== 'Running') throw new CoreError('policy_invalid', 'The classic exchange does not match its pin.');
  await readPool(rpc, pin);
}

export function minOut(quote: bigint, slippageBps: number): bigint {
  if (quote <= 0n || !Number.isInteger(slippageBps) || slippageBps < 10 || slippageBps > 500) throw new CoreError('bad_amount', 'Invalid quote or slippage.');
  const min = quote * BigInt(10_000 - slippageBps) / 10_000n;
  if (min <= 0n) throw new CoreError('bad_amount', 'The minimum output is too small.');
  return min;
}

type Swap = { pin: PinnedPool; tokenIn: string; tokenOut: string; amountIn: bigint; minOut: bigint; unwrapNear: boolean };
export function swapMsg(o: Swap): string {
  const pin = pinnedPool(o.pin);
  if (o.tokenIn === o.tokenOut || !pin.tokens.includes(o.tokenIn) || !pin.tokens.includes(o.tokenOut) || o.amountIn <= 0n || o.minOut <= 0n || (o.unwrapNear && o.tokenOut !== WNEAR)) {
    throw new CoreError('bad_request', 'Invalid pinned swap.');
  }
  return JSON.stringify({ force: 0, actions: [{ pool_id: pin.poolId, token_in: o.tokenIn, token_out: o.tokenOut,
    amount_in: o.amountIn.toString(), min_amount_out: o.minOut.toString() }], ...(o.unwrapNear ? { skip_unwrap_near: false } : {}) });
}
export function swapCall(o: Swap): CallRequest {
  return { receiverId: o.tokenIn, methodName: 'ft_transfer_call', args: { receiver_id: CLASSIC_EXCHANGE, amount: o.amountIn.toString(), msg: swapMsg(o) }, gas: GAS.swap, deposit: 1n };
}
export function wrapCall(amount: bigint): CallRequest { return { receiverId: WNEAR, methodName: 'near_deposit', args: {}, gas: GAS.simpleCall, deposit: amount }; }
export function unwrapCall(amount: bigint): CallRequest { return { receiverId: WNEAR, methodName: 'near_withdraw', args: { amount: amount.toString() }, gas: GAS.simpleCall, deposit: 1n }; }
export function ftTransferCall(token: string, to: string, amount: bigint): CallRequest {
  return { receiverId: token, methodName: 'ft_transfer', args: { receiver_id: to, amount: amount.toString() }, gas: GAS.simpleCall, deposit: 1n };
}
