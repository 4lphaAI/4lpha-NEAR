import { parseAmount } from './amounts.js';
import { record } from './errors.js';
import type { DemoDcl } from './demo-sim.js';
import { RpcUnavailable, type NearRpc } from './near-rpc.js';
import { DCL, USDC, WNEAR, validPoint } from './pins.js';
import { DCL_POOL } from './rhea-dcl.js';
import type { Store } from './store.js';
import type { Sample } from './trade-settings.js';

/**
 * Demo mode section 1: one finalized DCL sample. Every check of readPoolPoint (rhea-dcl.ts) applies; in addition it reads the active liquidity,
 * the input volumes and the protocol fee rate. Any failed check makes the whole sample unreadable: nothing is guessed.
 */
export async function readDemoDcl(rpc: NearRpc, now: number): Promise<DemoDcl> {
  try {
    if (!rpc.finalBlock) throw new RpcUnavailable();
    const block = await rpc.finalBlock();
    const [meta, pool] = await Promise.all([rpc.view(DCL, 'get_metadata', {}, block.id), rpc.view(DCL, 'get_pool', { pool_id: DCL_POOL }, block.id)]);
    const m = record(meta.value), p = record(pool.value);
    if ([meta, pool].some(r => r.height !== block.height || r.blockId !== block.id) || m?.version !== '2.4.2' || m.state !== 'Running' ||
      p?.pool_id !== DCL_POOL || p.token_x !== USDC || p.token_y !== WNEAR || p.fee !== 100 || p.point_delta !== 1 || p.state !== 'Running' || !validPoint(p.current_point) ||
      typeof m.protocol_fee_rate !== 'number' || !Number.isInteger(m.protocol_fee_rate) || m.protocol_fee_rate < 0 || m.protocol_fee_rate > 10_000) throw new RpcUnavailable();
    return { at: now, block: block.height, point: p.current_point, liquidity: parseAmount(p.liquidity, 'DCL liquidity').toString(),
      volX: parseAmount(p.volume_x_in, 'DCL volume').toString(), volY: parseAmount(p.volume_y_in, 'DCL volume').toString(), protocolBps: m.protocol_fee_rate };
  } catch { throw new RpcUnavailable(); }
}

const digits = (v: unknown) => typeof v === 'string' && /^\d+$/.test(v);
const list = (store: Store, key: string): unknown[] => { try { const v: unknown = JSON.parse(store.meta(key) ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
/** The demo's own samples (meta keys it owns, never the live trade_px:*). Malformed entries are dropped. */
export function demoDclSamples(store: Store): DemoDcl[] {
  return list(store, 'demo_dcl').filter((x): x is DemoDcl => {
    const r = record(x);
    return typeof r?.at === 'number' && typeof r.block === 'number' && validPoint(r.point) && digits(r.liquidity) && digits(r.volX) && digits(r.volY) && typeof r.protocolBps === 'number';
  });
}
export function demoSamples(store: Store, poolId: number): Sample[] {
  return list(store, `demo_px:${poolId}`).filter((x): x is Sample => {
    const r = record(x);
    return typeof r?.at === 'number' && typeof r.block === 'number' && digits(r.wnear) && digits(r.token);
  });
}
