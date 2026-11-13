import { parseAmount } from './amounts.js';
import { record } from './errors.js';
import { accountFromResult, RpcUnavailable, spendableNear, type AccountView, type NearRpc } from './near-rpc.js';

export interface Holdings { block: number; native: bigint; tokens: Readonly<Record<string, bigint>>; }
export interface Snapshot extends Holdings { blockId: string; account: AccountView | null; spendable: bigint; }

export async function readHoldings(rpc: NearRpc, account: string, tokens: readonly string[]): Promise<Snapshot> {
  if (!rpc.finalBlock) throw new RpcUnavailable();
  const block = await rpc.finalBlock();
  const [raw, ...balances] = await Promise.all([rpc.query({ request_type: 'view_account', account_id: account, block_id: block.id }),
    ...tokens.map(token => rpc.view(token, 'ft_balance_of', { account_id: account }, block.id))]);
  const r = record(raw);
  if (raw !== null && (r?.block_hash !== block.id || r.block_height !== block.height)) throw new RpcUnavailable();
  const a = raw === null ? null : accountFromResult(raw);
  try {
    const amounts = balances.map(v => {
      if (v.height !== block.height || v.blockId !== block.id) throw new RpcUnavailable();
      return parseAmount(v.value, 'token balance');
    });
    return { block: block.height, blockId: block.id, native: a?.amount ?? 0n, account: a, spendable: spendableNear(a, 0n), tokens: Object.fromEntries(tokens.map((t, i) => [t, amounts[i]])) };
  } catch { throw new RpcUnavailable(); }
}

export async function registered(rpc: NearRpc, token: string, account: string, snapshot?: Snapshot): Promise<boolean> {
  const r = await rpc.view(token, 'storage_balance_of', { account_id: account }, snapshot?.blockId);
  if (snapshot && (r.blockId !== snapshot.blockId || r.height !== snapshot.block)) throw new RpcUnavailable();
  if (r.value === null) return false;
  const v = record(r.value);
  try {
    const total = parseAmount(v?.total, 'registered storage');
    const available = parseAmount(v?.available, 'available storage');
    if (total === 0n || available > total) throw new RpcUnavailable();
    return true;
  } catch { throw new RpcUnavailable(); }
}

export function parseHoldings(raw: string): Holdings {
  const r = record(JSON.parse(raw));
  const tokens = record(r?.tokens);
  if (!tokens || typeof r?.block !== 'number' || !Number.isSafeInteger(r.block)) throw new RpcUnavailable();
  return { block: r.block, native: parseAmount(r.native, 'native balance'), tokens: Object.fromEntries(Object.entries(tokens).map(([t, a]) => [t, parseAmount(a, 'token balance')])) };
}

export function holdingsDelta(prev: Holdings, now: Holdings): Readonly<Record<string, bigint>> {
  return { native: now.native - prev.native, ...Object.fromEntries(Object.keys(now.tokens).filter(t => Object.hasOwn(prev.tokens, t)).map(t => [t, now.tokens[t] - prev.tokens[t]])) };
}

export function unexplained(delta: Readonly<Record<string, bigint>>, provenEffects: readonly Readonly<Record<string, bigint>>[]): Readonly<Record<string, bigint>> {
  return Object.fromEntries(Object.entries(delta).flatMap(([k, actual]) => {
    const expected = provenEffects.reduce((n, e) => n + (e[k] ?? 0n), 0n);
    return actual < expected ? [[k, expected - actual]] : [];
  }));
}
