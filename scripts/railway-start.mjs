// Container launcher (Railway or any Linux host): runs the five processes of the local stack in one container,
// with the same per-process settings as the local stack. One container, because the processes share one
// SQLite database and Railway attaches a volume to one service only. Nothing here prints a setting value.
//
// Variables read here:
//   FOURLPHA_WEB_ORIGIN    the public https origin, exactly as the browser sees it (required)
//   PORT                   set by Railway; the web listens on it
//   FOURLPHA_DATA_DIR      folder for both databases, default /data (the volume)
//   FOURLPHA_WORKER_KEK    32 bytes in base64; passed to the worker only (required)
//   FOURLPHA_LIVE_HIRES    "1" turns real-money hires on in the web (only the web sees it)
//   FOURLPHA_WORKER_LIVE   "1" lets the worker act on funded jobs (only the worker sees it)
//   Near_RPC, Auth_Token, NEAR_AI_API_KEY, NEAR_AI_MODEL, DATA_PLANE_URL, DATA_PLANE_TOKEN
//                          written to .env.local at start, where every process reads them as on a local machine
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fail = message => { console.error(`Launcher stopped: ${message}`); process.exit(1); };

const origin = process.env.FOURLPHA_WEB_ORIGIN;
if (!origin || !URL.canParse(origin) || new URL(origin).origin !== origin) fail('set FOURLPHA_WEB_ORIGIN to the public origin, for example https://name.up.railway.app (no trailing slash).');
const port = process.env.PORT || process.env.FOURLPHA_WEB_PORT || '8090';
const kek = process.env.FOURLPHA_WORKER_KEK;
if (!kek) fail('set FOURLPHA_WORKER_KEK (32 random bytes in base64). Keep it: the stored wallet keys cannot be read without it.');
const liveHires = process.env.FOURLPHA_LIVE_HIRES === '1', workerLive = process.env.FOURLPHA_WORKER_LIVE === '1';

const dataDir = resolve(process.env.FOURLPHA_DATA_DIR || '/data');
mkdirSync(dataDir, { recursive: true });
const liveDb = join(dataDir, 'near.db'), demoDb = join(dataDir, 'near-demo.db');

// The processes read these from .env.local in their working folder (src/core/config.ts localEnv). The file lives in the
// container's own file system, not on the volume, is rewritten on every start and is readable by this user only.
const LOCAL_KEYS = ['Near_RPC', 'Auth_Token', 'NEAR_AI_API_KEY', 'NEAR_AI_MODEL', 'DATA_PLANE_URL', 'DATA_PLANE_TOKEN'];
const lines = [];
for (const k of LOCAL_KEYS) {
  const v = process.env[k];
  if (!v) continue;
  if (/^[^\s#"'`\\]+$/.test(v)) lines.push(`${k}=${v}`);
  else if (!/['\r\n]/.test(v)) lines.push(`${k}='${v}'`);
  else fail(`the value of ${k} has a character the settings file cannot hold.`);
}
writeFileSync(join(root, '.env.local'), lines.length ? lines.join('\n') + '\n' : '', { mode: 0o600 });
console.log(`Settings file: ${lines.length} keys written (${LOCAL_KEYS.filter(k => process.env[k]).join(', ') || 'none'}).`);

// Every process starts from the container environment without the secrets and switches; each one then gets only what
// the local stack gives it. Custom RPC overrides are cleared so the settings file decides, as on a local machine.
const STRIP = [...LOCAL_KEYS, 'FOURLPHA_WORKER_KEK', 'FOURLPHA_LIVE_HIRES', 'FOURLPHA_WORKER_LIVE', 'FOURLPHA_RPC_URLS', 'FOURLPHA_ARCHIVAL_RPC_URL',
  'FOURLPHA_DEMO', 'FOURLPHA_DEMO_DB_PATH', 'FOURLPHA_GRID_V1', 'FOURLPHA_GRID_V2', 'FOURLPHA_LP_V1', 'FOURLPHA_TRADE_V1', 'FOURLPHA_MEME_PAPER'];
const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !STRIP.includes(k)));
const shared = { ...base, FOURLPHA_DB_PATH: liveDb, FOURLPHA_WEB_HOST: '0.0.0.0', FOURLPHA_WEB_PORT: port, FOURLPHA_WEB_ORIGIN: origin,
  FOURLPHA_GRID_V1: '1', FOURLPHA_GRID_V2: '1', FOURLPHA_LP_V1: '1', FOURLPHA_TRADE_V1: '1', FOURLPHA_MEME_PAPER: '1' };

// The Trade paper start id is read on every start; without it the scan keeps its saved floor.
let fromId = '';
try { fromId = execFileSync(process.execPath, [join(root, 'scripts', 'meme-start-id.mjs')], { cwd: root, timeout: 45_000, encoding: 'utf8' }).trim().split('\n')[0]; } catch { /* API unavailable */ }
if (!/^\d+$/.test(fromId)) { fromId = ''; console.log('meme.cooking API unavailable: Trade paper keeps its saved start point.'); }
else console.log(`Trade paper start id: ${fromId}`);

const specs = [
  { name: 'watchdog', script: 'dist/src/watchdog/main.js', env: shared },
  { name: 'web', script: 'dist/src/web/server.js', env: { ...shared, FOURLPHA_DEMO_DB_PATH: demoDb, ...(liveHires ? { FOURLPHA_LIVE_HIRES: '1' } : {}) } },
  { name: 'worker', script: 'dist/src/worker/main.js', env: { ...shared, FOURLPHA_WORKER_KEK: kek, ...(workerLive ? { FOURLPHA_WORKER_LIVE: '1' } : {}) }, retryQuickExit: true },
  { name: 'meme', script: 'dist/src/meme/main.js', env: shared, args: fromId ? ['--from-id', fromId] : [] },
  // The demo simulation runs on the demo database only, with the demo flag and none of the live switches, strategy flags or the worker key.
  { name: 'demo', script: 'dist/src/demo/main.js', env: { ...base, FOURLPHA_DB_PATH: demoDb, FOURLPHA_DEMO: '1' } },
];

console.log(`4lpha NEAR container: ${origin}, data ${dataDir}, live hires ${liveHires ? 'ON' : 'off'}, live worker ${workerLive ? 'ON' : 'off'}.`);
const running = new Map();
let stopping = false;

function start(spec, attempt = 1) {
  const started = Date.now();
  const child = spawn(process.execPath, [join(root, spec.script), ...(spec.args ?? [])], { cwd: root, env: spec.env, stdio: ['ignore', 'pipe', 'pipe'] });
  running.set(spec.name, child);
  for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on('line', line => console.log(`[${spec.name}] ${line}`));
  child.on('exit', (code, signal) => {
    running.delete(spec.name);
    if (stopping) { if (running.size === 0) process.exit(process.exitCode ?? 0); return; }
    // A worker started right after the previous container stopped finds its lock still fresh (it expires 60 seconds
    // after the last heartbeat) and exits at once. Only such quick exits are retried, for about 2 minutes.
    if (spec.retryQuickExit && code !== 0 && Date.now() - started < 20_000 && attempt < 8) {
      console.log(`[${spec.name}] stopped right after start (often the previous run's lock). Retry ${attempt} of 7 in 15 seconds.`);
      setTimeout(() => { if (!stopping) start(spec, attempt + 1); }, 15_000);
      return;
    }
    console.log(`[${spec.name}] stopped (${signal ?? `exit code ${code}`}). Stopping the container so the platform restarts it.`);
    shutdown(1);
  });
}

function shutdown(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of running.values()) child.kill('SIGTERM');
  if (running.size === 0) process.exit(code);
  // The worker finishes its current step on SIGTERM; give every process time before the platform kills the container.
  setTimeout(() => process.exit(code), 25_000).unref();
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
for (const spec of specs) start(spec);
