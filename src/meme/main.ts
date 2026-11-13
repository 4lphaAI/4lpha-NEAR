import { setTimeout as sleep } from 'node:timers/promises';
import { dbPath, localEnv, rpcLabel } from '../core/config.js';
import { memeTick } from '../core/meme-cycle.js';
import { MEME } from '../core/meme-paper.js';
import { createNearAi } from '../core/near-ai.js';
import { createNearRpc, DEFAULT_RPC, httpFetcher } from '../core/near-rpc.js';
import { openStore } from '../core/store.js';

async function main() {
  if (process.env.FOURLPHA_MEME_PAPER !== '1') throw new Error();
  const args = process.argv.slice(2);
  let once = false, from = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--once') once = true;
    else if (args[i] === '--from-id' && /^\d+$/.test(args[i + 1] ?? '')) from = Number(args[++i]);
    else throw new Error();
  }
  if (!Number.isSafeInteger(from) || from < 0) throw new Error();
  const local = localEnv(), ai = local.NEAR_AI_API_KEY ? createNearAi(local.NEAR_AI_API_KEY, local.NEAR_AI_MODEL || undefined) : null;
  const store = openStore(dbPath(), 'meme');
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
    const next = Math.floor((Date.now() - MEME.tickSecond * 1000) / MEME.minute + 1) * MEME.minute + MEME.tickSecond * 1000;
    await sleep(Math.max(1, next - Date.now()), undefined, { signal: controller.signal }).catch(() => {});
  };
  try {
    store.setMeta('meme_high_id', String(Math.max(from, Number(store.meta('meme_high_id') ?? '0'))));
    console.log(`RPC: ${rpcLabel(DEFAULT_RPC)}`); console.log(`AI: ${ai ? 'on' : 'off'}`);
    if (!once) await wait();
    while (!stop) {
      deadline = Date.now() + MEME.tickMs;
      console.log(`cycle ${JSON.stringify(await memeTick({ store, rpc, ai, now: Date.now }))}`);
      if (once || stop) break;
      await wait();
    }
  } finally { store.close(); process.off('SIGINT', quit); process.off('SIGTERM', quit); }
}
main().catch(() => { console.error('Meme paper process stopped. Check the paper flag, arguments and database access.'); process.exitCode = 1; });
