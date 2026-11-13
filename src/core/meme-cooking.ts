import { isAccountId, parseAmount } from './amounts.js';
import { record } from './errors.js';
import { MemeNotFinalized, type NearRpc } from './near-rpc.js';

export interface MemeRecord {
  id: number; owner: string; start_timestamp_ms: string | null; end_timestamp_ms: string; symbol: string; decimals: number;
  total_supply: string; deposit_token_id: string; soft_cap: string; hard_cap: string | null;
  team_allocation: { amount: string; vesting_duration_ms: number; cliff_duration_ms: number } | null;
  pool_amount: string; amount_to_be_distributed: string; total_staked: string; total_withdrawal_fees: string;
}
export interface MemePool { pool_kind: 'SIMPLE_POOL'; token_account_ids: [string, string]; amounts: [string, string]; total_fee: number; }
export interface FinalizedMeme { id: number; deposit_token_id: string; pool_amount: string; amount_to_be_distributed: string; total_staked: string; }
export type MemeRead<T> = { kind: 'ok'; value: T } | { kind: 'absent' | 'ignored' | 'pending' | 'not-finalized' | 'unreadable' | 'budget'; invalid?: true };
export type MemeView = NearRpc['view'];
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

export function parseMeme(v: unknown, id: number): MemeRecord {
  const r = record(v);
  if (!r || r.id !== id || !isAccountId(r.owner) || !isAccountId(r.deposit_token_id) || typeof r.symbol !== 'string' || r.symbol.length > 32 ||
      !integer(r.decimals)) throw new Error();
  const start = r.start_timestamp_ms == null ? null : parseAmount(r.start_timestamp_ms, 'timestamp'), end = parseAmount(r.end_timestamp_ms, 'timestamp');
  if ((start !== null && end < start) || end > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error();
  const amount = (key: string) => parseAmount(r[key], 'auction amount').toString();
  const team = r.team_allocation == null ? null : record(r.team_allocation);
  if (r.team_allocation != null && (!team || !integer(team.vesting_duration_ms) || !integer(team.cliff_duration_ms))) throw new Error();
  const total_supply = amount('total_supply');
  if (BigInt(total_supply) === 0n) throw new Error();
  return { id, owner: r.owner, deposit_token_id: r.deposit_token_id, symbol: r.symbol, decimals: r.decimals,
    start_timestamp_ms: start?.toString() ?? null, end_timestamp_ms: end.toString(), total_supply,
    soft_cap: amount('soft_cap'), hard_cap: r.hard_cap == null ? null : amount('hard_cap'),
    team_allocation: team ? { amount: parseAmount(team.amount, 'team amount').toString(), vesting_duration_ms: team.vesting_duration_ms as number,
      cliff_duration_ms: team.cliff_duration_ms as number } : null,
    pool_amount: amount('pool_amount'), amount_to_be_distributed: amount('amount_to_be_distributed'),
    total_staked: amount('total_staked'), total_withdrawal_fees: amount('total_withdrawal_fees') };
}

export function readMeme(view: MemeView, id: number, finalized: true): Promise<MemeRead<FinalizedMeme>>;
export function readMeme(view: MemeView, id: number, finalized?: false): Promise<MemeRead<MemeRecord>>;
export async function readMeme(view: MemeView, id: number, finalized = false): Promise<MemeRead<MemeRecord | FinalizedMeme>> {
  let arrived = false;
  try {
    const { value } = await view('meme-cooking.near', finalized ? 'get_finalized_meme' : 'get_meme', { meme_id: id });
    arrived = true;
    if (value === null) return { kind: finalized ? 'pending' : 'absent' };
    let parsed: MemeRecord | FinalizedMeme;
    if (finalized) {
      const r = record(value);
      if (!r || r.id !== id || !isAccountId(r.deposit_token_id)) throw new Error();
      parsed = { id, deposit_token_id: r.deposit_token_id, pool_amount: parseAmount(r.pool_amount, 'pool amount').toString(),
        amount_to_be_distributed: parseAmount(r.amount_to_be_distributed, 'distribution').toString(), total_staked: parseAmount(r.total_staked, 'stake').toString() };
    } else parsed = parseMeme(value, id);
    return parsed.deposit_token_id === 'wrap.near' ? { kind: 'ok', value: parsed } : { kind: 'ignored' };
  } catch (e) {
    if (e instanceof MemeNotFinalized && finalized) return { kind: 'not-finalized' };
    return arrived ? { kind: 'unreadable', invalid: true } : { kind: 'unreadable' };
  }
}

export async function readMemeStakes(view: MemeView, id: number): Promise<MemeRead<[string, string][]>> {
  let arrived = false;
  try {
    const { value } = await view('meme-cooking.near', 'get_meme_stakes', { meme_id: id });
    arrived = true;
    if (value === null) return { kind: 'absent' };
    if (!Array.isArray(value)) throw new Error();
    const seen = new Set<string>();
    const stakes = value.map((row: unknown): [string, string] => {
      if (!Array.isArray(row) || row.length !== 2 || !isAccountId(row[0]) || seen.has(row[0])) throw new Error();
      seen.add(row[0]); return [row[0], parseAmount(row[1], 'stake').toString()];
    });
    return { kind: 'ok', value: stakes };
  } catch { return arrived ? { kind: 'unreadable', invalid: true } : { kind: 'unreadable' }; }
}

export function parseMemePool(v: unknown): MemePool {
  const r = record(v), ids = r?.token_account_ids, amounts = r?.amounts;
  if (!r || r.pool_kind !== 'SIMPLE_POOL' || !Array.isArray(ids) || ids.length !== 2 || !ids.every(isAccountId) || ids[0] === ids[1] ||
      !Array.isArray(amounts) || amounts.length !== 2 || !integer(r.total_fee) || r.total_fee >= 10_000) throw new Error();
  return { pool_kind: 'SIMPLE_POOL', token_account_ids: [ids[0], ids[1]],
    amounts: [parseAmount(amounts[0], 'reserve').toString(), parseAmount(amounts[1], 'reserve').toString()], total_fee: r.total_fee };
}

export function findMemePool(pools: unknown, from: number, id: number): { poolId: number; tokenId: string } | null {
  if (!Array.isArray(pools)) throw new Error();
  for (const [i, raw] of pools.entries()) {
    const r = record(raw), ids = r?.token_account_ids;
    if (r?.pool_kind !== 'SIMPLE_POOL' || !Array.isArray(ids) || ids.length !== 2 || !ids.includes('wrap.near')) continue;
    const token = ids.find((v: unknown) => typeof v === 'string' && v.endsWith(`-${id}.meme-cooking.near`));
    if (typeof token === 'string') { parseMemePool(raw); return { poolId: from + i, tokenId: token }; }
  }
  return null;
}

export function sellMeme(pool: MemePool, tokenIn: string, amount: bigint): bigint {
  const i = pool.token_account_ids.indexOf(tokenIn);
  if (i < 0 || amount < 0n) throw new Error();
  const input = BigInt(pool.amounts[i]), output = BigInt(pool.amounts[1 - i]), paid = amount * BigInt(10_000 - pool.total_fee);
  const denominator = input * 10_000n + paid;
  if (denominator === 0n) throw new Error();
  return paid * output / denominator;
}
