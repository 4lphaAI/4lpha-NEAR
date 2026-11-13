// Spec UI step 3, section 4: the session wires the cross-tab lock, the localStorage marker store and the storage event.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { ReactElement } from 'react';

const require = createRequire(process.cwd() + '/package.json');
const React = require('react') as typeof import('react');
type Node = ReactElement<Record<string, unknown>>;
const PREFIX = '4lpha:near-transfer:v1:';
const JOB = '78bae146-0000-4000-8000-000000000001';

async function load() {
  const effects: (() => void | (() => void))[] = [];
  const hooks = { ...React, useReducer: () => [0, () => {}], useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => {}], useEffect: (fn: () => void | (() => void)) => { effects.push(fn); } };
  Object.defineProperty(globalThis, '__wiring', { configurable: true, value: { hooks } });
  const { build } = require('esbuild') as typeof import('esbuild');
  const result = await build({ entryPoints: ['web/lib/near-session.tsx'], bundle: true, write: false, format: 'esm', platform: 'node', tsconfig: 'web/tsconfig.json', logLevel: 'silent', plugins: [{ name: 'wiring', setup(b) {
    b.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, args => args.path === 'react' && args.importer.endsWith('near-session.tsx')
      ? { path: 'hooks', namespace: 'w' } : { path: pathToFileURL(require.resolve(args.path)).href, external: true });
    b.onResolve({ filter: /near-wallet$/ }, () => ({ path: 'wallet', namespace: 'w' }));
    b.onLoad({ filter: /.*/, namespace: 'w' }, args => ({ contents: args.path === 'hooks' ? 'export default globalThis.__wiring.hooks;'
      : `export const api = async (path) => path === '/api/me' ? { accountId: 'owner.near' } : path === '/api/jobs' ? [] : path === '/api/hire/options' ? null : true;
         export const sign = async () => ({}); export const sendCall = async () => {}; export const clearSelectedWallet = () => {}; export const transferWallet = async () => async () => {};` }));
  } }] });
  const module = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0]!.text + `\n// ${Math.random()}`).toString('base64')) as Record<string, unknown>;
  return { module, effects };
}
function fakeBrowser(t: { after(fn: () => void): void }, locks: boolean) {
  const saved = (['window', 'document', 'navigator'] as const).map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const);
  const data = new Map<string, string>(), listeners = new Map<string, (e: unknown) => void>(), requests: string[] = [];
  const localStorage = { get length() { return data.size; }, key: (i: number) => [...data.keys()][i] ?? null, getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage, setInterval: () => 1, clearInterval() {}, addEventListener: (n: string, fn: (e: unknown) => void) => { listeners.set(n, fn); }, removeEventListener() {} } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: locks ? { locks: { request: (name: string, fn: () => Promise<unknown>) => { requests.push(name); return fn(); } } } : {} });
  t.after(() => { for (const [k, v] of saved) { if (v) Object.defineProperty(globalThis, k, v); else Reflect.deleteProperty(globalThis, k); } });
  return { data, listeners, requests };
}

test('session wiring: lock uses the Web Locks API when present; the store keeps only marker keys', async t => {
  const b = fakeBrowser(t, true);
  const { module } = await load();
  const lock = module.lock as <T>(n: string, fn: () => Promise<T>) => Promise<T>;
  assert.equal(await lock('4lpha-fund:x', async () => 7), 7);
  assert.deepEqual(b.requests, ['4lpha-fund:x']);
  b.data.set('other', '1'); b.data.set(PREFIX + 'owner.near:' + JOB, '{}');
  const store = module.transferStore as { keys(): string[]; set(k: string, v: string): void; remove(k: string): void; get(k: string): string | null };
  assert.deepEqual(store.keys(), [PREFIX + 'owner.near:' + JOB]);
  store.set('k', 'v'); assert.equal(store.get('k'), 'v'); store.remove('k'); assert.equal(store.get('k'), null);
});

test('session wiring: without Web Locks the function runs directly; the provider forwards storage events to the session', async t => {
  const b = fakeBrowser(t, false);
  const { module, effects } = await load();
  assert.equal(await (module.lock as <T>(n: string, fn: () => Promise<T>) => Promise<T>)('x', async () => 3), 3);
  const tree = (module.NearSessionProvider as (p: object) => Node)({ children: null });
  for (const e of effects) e();
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  const onStorage = b.listeners.get('storage');
  assert.ok(onStorage, 'storage listener registered');
  const marker = { account: 'owner.near', jobId: JOB, amount: '1', baseBalance: '0', at: 1 };
  onStorage!({ key: PREFIX + 'owner.near:' + JOB, newValue: JSON.stringify(marker) });
  const value = tree.props.value as { transfer(id: string): unknown };
  assert.deepEqual(value.transfer(JOB), marker);
  onStorage!({ key: PREFIX + 'owner.near:' + JOB, newValue: null });
  assert.equal(value.transfer(JOB), null);
});
