import { demoDclSamples } from '../core/demo-market.js';
import { demoCreate, type DemoAgent } from '../core/demo-sim.js';
import { openStore, type Store } from '../core/store.js';

// Demo mode section 8.3: the operator's showcase agents and stops. Store role `demo`; seeds skip the visitor caps.
function stopOne(store: Store, a: DemoAgent, now: number): boolean {
  return a.state === 'running' && store.saveDemo(a, { state: 'stopping', endReason: 'operator-stopped', sim: a.sim, log: [{ kind: 'end', data: { reason: 'operator-stopped' } }] }, now);
}

function main() {
  const path = process.env.FOURLPHA_DB_PATH;
  if (process.env.FOURLPHA_DEMO !== '1' || process.env.FOURLPHA_LIVE_HIRES === '1' || !path) throw new Error();
  const [command, arg, extra] = process.argv.slice(2);
  if (extra !== undefined || !arg || (command !== 'create' && command !== 'stop')) throw new Error();
  // D-7: the demo store refuses a database with a live job or a worker heartbeat (store.ts constructor).
  const store = openStore(path, 'demo');
  try {
    const now = Date.now();
    if (command === 'create') {
      const input = demoCreate(JSON.parse(arg) as unknown, { point: demoDclSamples(store).at(-1)?.point ?? null }, now);
      if (input === 'invalid' || input === 'rpc_unavailable') { console.error(input === 'invalid' ? 'Invalid demo agent body.' : 'No DCL sample yet. Start the demo process first.'); process.exitCode = 1; return; }
      const a = store.createDemoAgent({ owner: 'operator', kind: input.kind, pair: input.pair, settings: input.settings, depositYocto: input.depositYocto.toString(), seed: 1 }, now);
      console.log(`created ${a.id} /demo/${a.id}`);
      return;
    }
    const targets = arg === '--visitors' ? store.demoActive().filter(a => a.seed === 0) : [store.getDemoAgent(arg)].filter((a): a is DemoAgent => a !== null);
    console.log(`stopped ${targets.filter(a => stopOne(store, a, now)).length}`);
  } finally { store.close(); }
}
try { main(); } catch { console.error('Seed stopped. Check FOURLPHA_DEMO, FOURLPHA_DB_PATH, the arguments and that no live job or worker uses the database.'); process.exitCode = 1; }
