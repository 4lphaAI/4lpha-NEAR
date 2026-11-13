import { setTimeout as sleep } from 'node:timers/promises';
import { accessKeyProvider } from '../core/auth.js';
import { dbPath, freeFirst, lpAiEnv, outlayerUrl, rpcEnv, rpcLabel, webEnv } from '../core/config.js';
import { advanceJob, processReveals, type WorkerDeps } from '../core/hire.js';
import { createNearRpc } from '../core/near-rpc.js';
import { reconcileEvery, reconcileWallet } from '../core/ops.js';
import { createOutLayerClient } from '../core/outlayer.js';
import { CLASSIC_POOLS } from '../core/pins.js';
import { requireVenue } from '../core/rhea-classic.js';
import { loadKek } from '../core/secrets.js';
import { openStore } from '../core/store.js';
import { sampleTradePools } from '../core/trade.js';

async function main() {
  const kek = loadKek(process.env.FOURLPHA_WORKER_KEK);
  const { origin, gridV1, gridV2, lpV1, tradeV1 } = webEnv();
  const endpoints = rpcEnv();
  const outlayer = createOutLayerClient(outlayerUrl());
  const store = openStore(dbPath(), 'worker');
  const rpc = createNearRpc(endpoints, undefined, undefined, { coordinator: store.rpcCoordinator() });
  const idleEndpoints = freeFirst(endpoints), idleRpc = createNearRpc(idleEndpoints, undefined, undefined, { coordinator: store.rpcCoordinator() });
  if (!store.acquireWorkerLock(process.pid, Date.now())) { store.close(); throw new Error(); }
  let stop = false;
  const quit = () => { stop = true; };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
  const timer = setInterval(() => { try { if (!store.heartbeat('worker', Date.now())) quit(); } catch { quit(); } }, 10_000);
  const d: WorkerDeps = { store, rpc, outlayer, kek, origin, now: Date.now, provider: accessKeyProvider(endpoints.read[0], rpc), idleRpc, live: process.env.FOURLPHA_WORKER_LIVE === '1', gridV1, gridV2, lpV1, tradeV1, ai: lpAiEnv() };
  let venueAt = 0;
  const lastReconcile = new Map<string, number>();
  try {
    console.log(`RPC: ${rpcLabel(endpoints)}${idleEndpoints === endpoints ? '' : ', idle reads dRPC first'}`);
    console.log(d.ai ? 'AI: on' : 'AI: off');
    console.log(d.live ? 'Worker ready for approved live hires.' : 'Worker started with live operations disabled.');
    do {
      if (!store.ownsWorkerLock()) throw new Error();
      await processReveals(d);
      const t = Date.now();
      const recovery = await Promise.allSettled(store.inFlightOps().map(async op => {
        if (op.state === 'ambiguous' && t - (lastReconcile.get(op.walletId) ?? 0) < reconcileEvery(op, t)) return;
        lastReconcile.set(op.walletId, t);
        await reconcileWallet(d, op.walletId);
      }));
      if (recovery.some(r => r.status === 'rejected')) throw new Error();
      if (t - venueAt >= 3_600_000) {
        venueAt = t;
        const pinned = await requireVenue(rpc, CLASSIC_POOLS[0]).then(() => true, () => false);
        store.setMeta('venue_classic', JSON.stringify({ at: t, pinned }));
      }
      // Trade V1 10.2: one shared sample a minute per pool with a running trade job. A failed read is skipped, never fatal.
      if (d.live && d.tradeV1) await sampleTradePools({ ...d, rpc: idleRpc });
      if (!stop) {
        const updates = await Promise.allSettled(store.activeJobs().map(job => advanceJob(d, job.id)));
        if (updates.some(r => r.status === 'rejected')) throw new Error();
      }
      if (stop || process.argv.includes('--once')) break;
      await sleep(2_000);
    } while (!stop);
  } finally {
    clearInterval(timer);
    store.releaseWorkerLock();
    store.close();
    kek.fill(0);
  }
}

main().catch(() => { console.error('Worker stopped. Check the KEK, the database and the worker lock.'); process.exitCode = 1; });
