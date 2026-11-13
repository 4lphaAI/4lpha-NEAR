import { setTimeout as sleep } from 'node:timers/promises';
import { localEnv, lpAiEnv, rpcLabel } from '../core/config.js';
import { demoTick } from '../core/demo-cycle.js';
import { createNearRpc, DEFAULT_RPC, httpFetcher } from '../core/near-rpc.js';
import { openStore } from '../core/store.js';

// Demo mode section 4: the simulation process. Public FastNEAR only (never QuickNode, FINDINGS 1.40), no wallet, no worker key, nothing is signed.
const MINUTE = 60_000, TICK_SECOND = 40, TICK_MS = 40_000;

async function main() {
  // A demo process needs its own database path: it never falls back to the live default.
  const path = process.env.FOURLPHA_DB_PATH;
  if (process.env.FOURLPHA_DEMO !== '1' || !path) throw new Error();
  const args = process.argv.slice(2), once = args.includes('--once');
  if (args.some(a => a !== '--once')) throw new Error();
  const ai = lpAiEnv(localEnv());
  // D-7: the demo store refuses a database with a live job or a worker heartbeat (store.ts constructor).
  const store = openStore(path, 'demo');
  let deadline = 0;
  const send = httpFetcher();
  const rpc = createNearRpc(DEFAULT_RPC, async (url, body, ms) => {
    const reply = await send(url, body, ms);
    if (reply.status === 429) console.log('HTTP 429 from public FastNEAR.');
    return reply;
  }, undefined, { coordinator: store.rpcCoordinator(), deadline: () => deadline });
  let stop = false;
  const controller = new AbortController();
  const quit = () => { stop = true; controller.abort(); };
  process.on('SIGINT', quit); process.on('SIGTERM', quit);
  const wait = async () => {
    const next = Math.floor((Date.now() - TICK_SECOND * 1000) / MINUTE + 1) * MINUTE + TICK_SECOND * 1000;
    await sleep(Math.max(1, next - Date.now()), undefined, { signal: controller.signal }).catch(() => {});
  };
  try {
    console.log(`RPC: ${rpcLabel(DEFAULT_RPC)}`); console.log(`AI: ${ai ? 'on' : 'off'}`);
    if (!once) await wait();
    while (!stop) {
      const started = Date.now();
      deadline = started + TICK_MS;
      try {
        const cycle = await demoTick({ store, rpc, ...(ai ? { ai } : {}), now: Date.now });
        console.log(`cycle ${JSON.stringify(cycle)}${Date.now() - started > TICK_MS ? ' overrun' : ''}`);
      } catch { console.log('Demo tick failed. The next tick starts on the next minute.'); }
      if (once || stop) break;
      await wait();
    }
  } finally { store.close(); process.off('SIGINT', quit); process.off('SIGTERM', quit); }
}
main().catch(() => { console.error('Demo process stopped. Check FOURLPHA_DEMO, FOURLPHA_DB_PATH, the arguments and that no live job or worker uses the database.'); process.exitCode = 1; });
