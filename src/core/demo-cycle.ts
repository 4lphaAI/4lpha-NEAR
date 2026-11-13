import { demoDclSamples, demoSamples, readDemoDcl } from './demo-market.js';
import { demoStep, type DemoDecide, type DemoMarket } from './demo-sim.js';
import { lpAiRange, type LpAi } from './lp-ai.js';
import type { NearRpc } from './near-rpc.js';
import { readTradePool } from './rhea-classic.js';
import type { Store } from './store.js';
import { TRADE_PAIRS } from './trade-pairs.js';
import type { Sample } from './trade-settings.js';

const KEPT = 60;

/**
 * Demo mode section 4: one tick. Market reads first (every pool, whether or not an agent exists, so the median guard has history), then each
 * active agent oldest first with at most one simulated transaction, then the heartbeat. Nothing here signs, submits or writes a live table.
 */
export async function demoTick(d: { store: Store; rpc: NearRpc; ai?: LpAi; now: () => number }) {
  const { store, now } = d, at = now();
  let reads = 0, unreadable = 0, steps = 0, ai = 0;
  const rpc: NearRpc = { ...d.rpc, view: (...args) => { reads++; return d.rpc.view(...args); },
    ...(d.rpc.finalBlock ? { finalBlock: () => { reads++; return d.rpc.finalBlock!(); } } : {}) };
  const dcl = await readDemoDcl(rpc, at).catch(() => null);
  if (dcl) store.setMeta('demo_dcl', JSON.stringify([...demoDclSamples(store), dcl].slice(-KEPT))); else unreadable++;
  const pools: Record<number, Sample | undefined> = {}, history: Record<number, Sample[]> = {};
  for (const pair of TRADE_PAIRS) {
    const id = pair.pin.poolId, pool = await readTradePool(rpc, pair).catch(() => null);
    history[id] = demoSamples(store, id);
    if (!pool) { unreadable++; continue; }
    pools[id] = { at, block: pool.height, wnear: pool.wnear.toString(), token: pool.token.toString() };
    history[id] = [...history[id], pools[id]].slice(-KEPT);
    store.setMeta(`demo_px:${id}`, JSON.stringify(history[id]));
  }
  const market: DemoMarket = { dcl, pools, history }, day = new Date(at).toISOString().slice(0, 10), agents = store.demoActive();
  // Section 6: at most one NEAR AI call per tick, reserved before it is made; a refused reservation is the code `budget`.
  let slot = false;
  for (const a of agents) {
    const decide: DemoDecide = async (input, fallback) => {
      if (!d.ai) return { ...fallback, verdict: 'fallback', code: 'off' };
      if (slot) return null;
      if (!store.reserveDemoAi(day, a.seed === 1)) return { ...fallback, verdict: 'fallback', code: 'budget' };
      slot = true; ai++;
      try { return lpAiRange(input, await d.ai(input, AbortSignal.timeout(20_000))); }
      catch (e) { return { ...fallback, verdict: 'fallback', code: e instanceof Error && ['unavailable', 'timeout', 'http', 'malformed'].includes(e.message) ? e.message : 'unavailable' }; }
    };
    // One failing agent never ends the tick for the later agents or skips the heartbeat: the failure is logged on that agent, which is tried again next tick.
    try {
      const next = await demoStep(a, market, at, decide);
      if (next.log.some(r => r.kind === 'op')) steps++;
      if (next.state !== a.state || next.log.length || JSON.stringify(next.sim) !== JSON.stringify(a.sim)) store.saveDemo(a, next, at);
    } catch {
      console.log(`Demo agent ${a.id}: simulation step failed; tried again next tick.`);
      try { store.saveDemo(a, { state: a.state, endReason: a.endReason, sim: a.sim, log: [{ kind: 'decision', data: { error: 'The simulation step failed; it is tried again next tick.' } }] }, at); }
      catch { /* The agent changed meanwhile or cannot be saved; the next tick reads it again. */ }
    }
  }
  store.heartbeat('demo', now());
  return { agents: agents.length, steps, reads, unreadable, ai };
}
