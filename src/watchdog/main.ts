import { setTimeout as sleep } from 'node:timers/promises';
import { dbPath, dRpcFirst, rpcEnv, rpcLabel } from '../core/config.js';
import { createNearRpc } from '../core/near-rpc.js';
import { openStore } from '../core/store.js';
import { watchOnce } from '../core/watchdog.js';

async function main() {
  const store = openStore(dbPath(), 'watchdog'), endpoints = dRpcFirst(rpcEnv());
  const rpc = createNearRpc(endpoints, undefined, undefined, { coordinator: store.rpcCoordinator() });
  let stop = false;
  const quit = () => { stop = true; };
  process.on('SIGINT', quit); process.on('SIGTERM', quit);
  try {
    console.log(`RPC: ${rpcLabel(endpoints)}`);
    console.log('Watchdog started.');
    do {
      const started = Date.now();
      for (const a of await watchOnce({ store, rpc, now: Date.now })) console.log(`${a.severity} ${a.kind} job=${a.jobId}: ${a.detail.message}`);
      if (stop || process.argv.includes('--once')) break;
      // RPC budget (2026-11-12): up to 30 s between passes, never more than 45 s from one pass start to the next, so a pass keeps the 45 s budget
      // it had inside the 60 s heartbeat window that the worker and web require.
      await sleep(Math.min(30_000, Math.max(0, 45_000 - (Date.now() - started))));
    } while (!stop);
  } finally { store.close(); }
}
main().catch(() => { console.error('Watchdog stopped. Check database access and RPC settings.'); process.exitCode = 1; });
