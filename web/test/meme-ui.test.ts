import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { ReactElement, ReactNode } from 'react';
import type { MemeView } from '@/components/near/NearMemeScreen';

const require = createRequire(process.cwd() + '/package.json');
const React = require('react') as typeof import('react');
const { renderToStaticMarkup } = require('react-dom/server') as typeof import('react-dom/server');

// Exercise the screen handlers without a DOM or wallet, using the existing esbuild test pattern.
async function fixture(screen: 'NearTradeDeployScreen' | 'NearMemeScreen', response: unknown) {
  const { build } = require('esbuild') as typeof import('esbuild');
  const slots: unknown[] = [], effects: (() => void | (() => void))[] = [], calls: { path: string; body?: object }[] = [];
  let cursor = 0, first = true;
  const session = { state: { account: 'owner.near' as string | null, busy: false, logoutPending: false, message: '' }, login: async () => {} };
  const hooks = { ...React,
    useState(initial: unknown) {
      const index = cursor++;
      if (first) slots[index] = initial;
      return [slots[index], (value: unknown) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef(initial: unknown) { const index = cursor++; if (first) slots[index] = { current: initial }; return slots[index]; },
    useEffect(effect: () => void | (() => void)) { if (first) effects.push(effect); },
  };
  Object.defineProperty(globalThis, '__memeUi', { configurable: true, value: { hooks, session, api: async (path: string, body?: object) => {
    calls.push({ path, body }); return body ? { id: 'paper-id' } : response;
  } } });
  const result = await build({ entryPoints: [`web/components/near/${screen}.tsx`], bundle: true, write: false, format: 'esm', platform: 'node', tsconfig: 'web/tsconfig.json', plugins: [{ name: 'paper-fixture', setup(build) {
    build.onResolve({ filter: /^react(?:\/.*)?$/ }, args => args.path === 'react' && args.importer.endsWith(`${screen}.tsx`)
      ? { path: 'hooks', namespace: 'fake' } : { path: pathToFileURL(require.resolve(args.path)).href, external: true });
    build.onResolve({ filter: /^@\/lib\/near-(session|wallet)$/ }, args => ({ path: args.path.endsWith('session') ? 'session' : 'api', namespace: 'fake' }));
    build.onLoad({ filter: /.*/, namespace: 'fake' }, args => ({ contents: args.path === 'hooks' ? 'export default globalThis.__memeUi.hooks;'
      : args.path === 'session' ? 'export const useNearSession = () => globalThis.__memeUi.session;'
        : 'export const api = globalThis.__memeUi.api;' }));
  } }] });
  const module = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0]!.text).toString('base64')) as Record<string, (props: object) => ReactElement>;
  const routes: string[] = [];
  const render = () => { cursor = 0; const tree = module[screen]!({ agentId: '11111111-2222-4333-8444-555555555555', go: (route: string) => routes.push(route) }); first = false; return tree; };
  render();
  const cleanups = effects.map(effect => effect());
  await new Promise<void>(resolve => setImmediate(resolve));
  return { render, calls, routes, session, cleanup: () => { cleanups.forEach(cleanup => cleanup?.()); Reflect.deleteProperty(globalThis, '__memeUi'); } };
}

type Node = ReactElement<Record<string, unknown>>;
function find(tree: ReactNode, predicate: (node: Node) => boolean): Node | undefined {
  for (const child of React.Children.toArray(tree)) {
    if (!React.isValidElement<Record<string, unknown>>(child)) continue;
    if (predicate(child)) return child;
    const found = find(child.props.children as ReactNode, predicate);
    if (found) return found;
  }
  return undefined;
}

test('Trade deploy validates the four settings and creates through the session API', async t => {
  const defaults = { perAuctionNear: 10, maxOpen: 2, capitalNear: 20, termDays: 7 };
  const f = await fixture('NearTradeDeployScreen', { enabled: true, ai: false, bounds: { perAuctionNear: [1, 50], maxOpen: [1, 3], capitalMax: 500, termDays: [7, 30] }, defaults });
  t.after(f.cleanup);
  const submit = async () => { const form = find(f.render(), node => node.type === 'form')!; await (form.props.onSubmit as (e: object) => Promise<void>)({ preventDefault() {} }); };
  const set = (key: string, value: string) => { const group = find(f.render(), node => 'section' in node.props && 'set' in node.props)!; (group.props.set as (k: string, v: string) => void)(key, value); };
  assert.match(renderToStaticMarkup(f.render()), /off on this server: the agent will not enter/);
  for (const [key, bad] of [['perAuctionNear', '0'], ['perAuctionNear', '51'], ['perAuctionNear', '1.5'], ['maxOpen', '0'], ['maxOpen', '4'], ['capitalNear', '19'], ['capitalNear', '501'], ['termDays', '8']]) {
    set(key!, bad!); await submit();
    assert.equal(f.calls.filter(call => call.body).length, 0);
    set(key!, String(defaults[key as keyof typeof defaults]));
  }
  f.session.state.account = null;
  await submit(); assert.equal(f.calls.filter(call => call.body).length, 0);
  f.session.state.account = 'owner.near';
  await submit();
  assert.deepEqual(f.calls.filter(call => call.body), [{ path: '/api/meme', body: defaults }]);
  assert.deepEqual(f.routes, ['/meme/paper-id']);
});

test('Meme screen shows Stop only for its owner, confirms, and escapes HTML symbols', async t => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document'), originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { setInterval: () => 1, clearInterval() {} } });
  const view: MemeView = {
    agent: { id: '11111111-2222-4333-8444-555555555555', owner: 'owner.near', state: 'running', endReason: null, settings: { perAuctionNear: 10, maxOpen: 2, capitalNear: 20, termDays: 7 }, createdAt: 0, endsAt: 1, isOwner: false },
    summary: { deposited: 1, open: 0, closed: 0, refunded: 0, wins: 0, pnlNear: '0', winRateBps: 0 },
    positions: [{ meme_id: 2313, symbol: '<img src=x onerror=alert(1)>', status: 'deposited', closeCode: null, depositNear: '10', tokens: null, poolId: null, launchedAt: null, markNear: null, markAt: null, pnlBps: null, peakBps: null, exitNear: null, pnlNear: null, openedAt: 0, closedAt: null }],
    auctions: [], log: [], runs: [], meta: { lastTickAt: null },
  };
  const f = await fixture('NearMemeScreen', view);
  t.after(() => {
    f.cleanup();
    for (const [key, value] of [['document', originalDocument], ['window', originalWindow]] as const) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
  });
  const stop = () => find(f.render(), node => node.props.children === 'Stop');
  assert.equal(stop(), undefined);
  let html = renderToStaticMarkup(f.render());
  assert.match(html, /Read-only/); assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/); assert.doesNotMatch(html, /<img src="?x/);
  view.agent.isOwner = true;
  assert.ok(stop());
  f.session.state.account = null; assert.equal(stop(), undefined);
  f.session.state.account = 'visitor.near'; assert.equal(stop(), undefined);
  f.session.state.account = 'owner.near';
  (stop()!.props.onClick as () => void)();
  assert.equal(f.calls.filter(call => call.body).length, 0);
  const confirm = find(f.render(), node => node.props.children === 'Confirm stop')!;
  await (confirm.props.onClick as () => Promise<void>)();
  assert.deepEqual(f.calls.filter(call => call.body), [{ path: '/api/meme/11111111-2222-4333-8444-555555555555/stop', body: {} }]);
});
