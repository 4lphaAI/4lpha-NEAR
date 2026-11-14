// Audit evidence for findings H-1, M-1 and L-1 of UI-AUDIT-REPORT.md, now fixed. Each test states the wanted behaviour. Wired with the fixes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { ReactElement, ReactNode } from 'react';
import { AGENTS } from '@/lib/design-data';

const require = createRequire(process.cwd() + '/package.json');
const React = require('react') as typeof import('react');
const { renderToStaticMarkup } = require('react-dom/server') as typeof import('react-dom/server');
type Node = ReactElement<Record<string, unknown>>;
type After = { after(fn: () => void): void };

// Bundles one component file. Its own `react` import becomes the hooks object current at load time; `stubs` replaces
// the components KitApp mounts with named markers; the session and API modules become the scripted ones.
async function bundle(file: string, hooks: object, o: { stubs?: boolean; session?: object; api?: (path: string) => Promise<unknown> } = {}) {
  const { build } = require('esbuild') as typeof import('esbuild');
  const base = file.split('/').at(-1)!;
  Object.defineProperty(globalThis, '__auditOpen', { configurable: true, value: { hooks, session: o.session, api: o.api } });
  const result = await build({ entryPoints: [file], bundle: true, write: false, format: 'esm', platform: 'node', tsconfig: 'web/tsconfig.json', logLevel: 'silent', plugins: [{ name: 'audit-open', setup(b) {
    b.onResolve({ filter: /^react(?:\/.*)?$/ }, args => args.path === 'react' && args.importer.endsWith(base)
      ? { path: 'hooks', namespace: 'audit' } : { path: pathToFileURL(require.resolve(args.path)).href, external: true });
    b.onResolve({ filter: /^@\/lib\/near-(session|wallet)$/ }, args => ({ path: args.path.endsWith('session') ? 'session' : 'api', namespace: 'audit' }));
    if (o.stubs) b.onResolve({ filter: /^@\/(components\/|lib\/sigma-pet$)/ }, args => ({ path: 'stub:' + args.path.split('/').at(-1)!, namespace: 'audit' }));
    b.onLoad({ filter: /.*/, namespace: 'audit' }, args => ({ contents: args.path === 'hooks' ? 'export default globalThis.__auditOpen.hooks;'
      : args.path === 'session' ? 'const s = globalThis.__auditOpen.session; export const useNearSession = () => s;'
        : args.path === 'api' ? 'export const api = globalThis.__auditOpen.api;'
          : args.path === 'stub:sigma-pet' ? 'export const dispatchSigmaPetReaction = () => {};' : `export function ${args.path.slice(5)}() { return null; }` }));
  } }] });
  // A unique tail keeps identical bundles from sharing one cached module: each captures its own hooks.
  return await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0]!.text + `\n// ${Math.random()}`).toString('base64')) as Record<string, (props: object) => Node>;
}
function slotHooks() {
  const slots: unknown[] = [], effects: (() => void | (() => void))[] = [];
  const s = { slots, effects, cursor: 0, first: true };
  const hooks = { ...React,
    useState(initial: unknown) { const index = s.cursor++; if (s.first) slots[index] = initial; return [slots[index], (value: unknown) => { slots[index] = typeof value === 'function' ? (value as (v: unknown) => unknown)(slots[index]) : value; }]; },
    useRef(initial: unknown) { const index = s.cursor++; if (s.first) slots[index] = { current: initial }; return slots[index]; },
    useEffect(effect: () => void | (() => void)) { if (s.first) effects.push(effect); } };
  return { s, hooks };
}
function find(tree: ReactNode, predicate: (node: Node) => boolean): Node | undefined {
  for (const child of React.Children.toArray(tree)) {
    if (!React.isValidElement<Record<string, unknown>>(child)) continue;
    if (predicate(child)) return child;
    const found = find(child.props.children as ReactNode, predicate);
    if (found) return found;
  }
  return undefined;
}
function page(t: After) {
  const saved = (['document', 'window'] as const).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const location = { pathname: '/' };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location, innerWidth: 1280, scrollTo() {}, addEventListener() {}, removeEventListener() {},
    history: { pushState(_s: unknown, _t: string, url: string) { location.pathname = url; }, replaceState() {} }, setInterval: () => 1, clearInterval() {} } });
  const unmounts: (() => void)[] = [];
  t.after(() => { for (const unmount of unmounts) unmount(); for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); } });
  return { location, unmounts };
}

// The real KitApp with working route state. `screen()` is the element it mounts now; its props carry KitApp's own go and onHire.
async function kitApp() {
  const { s, hooks } = slotHooks();
  const module = await bundle('web/components/KitApp.tsx', hooks, { stubs: true });
  const render = () => { s.cursor = 0; const tree = module.KitApp!({}); s.first = false; return tree; };
  const parts = () => React.Children.toArray(render().props.children as ReactNode) as Node[];
  return { screen: () => parts()[1]!, go: (route: string) => (parts()[0]!.props.go as (r: string) => void)(route), route: () => String(s.slots[0]) };
}
const screenName = (node: Node) => (node.type as { name: string }).name;
// One ported design screen called with the props KitApp gives it (its only hook is one useState).
async function designScreen(file: string, name: string, props: Record<string, unknown>) {
  const module = await bundle(file, { ...React, useState: (initial: unknown) => [initial, () => {}], useEffect() {} });
  return module[name]!(props);
}

test('audit H-1: the Hire button on the enabled AI Token Trader card opens the trade deploy screen', async t => {
  page(t);
  const kit = await kitApp();
  assert.equal(screenName(kit.screen()), 'MarketplaceScreen');
  const market = await designScreen('web/components/screens/MarketplaceScreen.tsx', 'MarketplaceScreen', kit.screen().props);
  const card = find(market, node => node.props.id === 'ai-token-trader' && typeof node.props.onHire === 'function')!;
  assert.notEqual(card.props.disabled, true);
  (card.props.onHire as () => void)();
  assert.equal(screenName(kit.screen()), 'NearTradeDeployScreen', `after Hire the app is on ${kit.route()}`);
});

// Operator, 2026-11-14: the paper agent's detail page has only Try demo now (no Hire Now), and it opens the Degen trade screen.
test('audit H-1: Try demo now on the AI Token Trader detail page opens the trade deploy screen', async t => {
  page(t);
  const kit = await kitApp();
  kit.go('/agent/ai-token-trader');
  assert.equal(screenName(kit.screen()), 'AgentDetailScreen');
  assert.equal((kit.screen().props.agent as { id: string }).id, 'ai-token-trader');
  const detail = await designScreen('web/components/screens/AgentDetailScreen.tsx', 'AgentDetailScreen', kit.screen().props);
  assert.equal(find(detail, node => node.props.children === 'Hire Now'), undefined);
  const demo = find(detail, node => node.props.children === 'Try demo now')!;
  (demo.props.onClick as () => void)();
  assert.equal(screenName(kit.screen()), 'NearTradeDeployScreen', `after Try demo now the app is on ${kit.route()}`);
  assert.equal(kit.route(), '/deploy/trade/degen');
});

// A screen with slot-backed state, a signed-in session and a scripted API, effects run once (the pattern of web/test/meme-ui.test.ts).
async function mounted(file: string, name: string, agentId: string, respond: (path: string) => unknown) {
  const { s, hooks } = slotHooks();
  const module = await bundle(file, hooks, { session: { state: { account: 'owner.near', busy: false, logoutPending: false, message: '', jobs: [], lastPollMs: 0 }, login: async () => {}, refresh: async () => {} },
    api: async (path: string) => { const answer = respond(path); if (answer instanceof Error) throw answer; return answer; } });
  const render = () => { s.cursor = 0; const tree = module[name]!({ agentId, go: () => {} }); s.first = false; return tree; };
  render();
  const cleanups = s.effects.map(effect => effect());
  for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve));
  return { render, cleanup: () => cleanups.forEach(cleanup => cleanup?.()) };
}

test('audit M-1: with the paper flag off (the default) the account page shows no paper error to Grid and LP owners', async t => {
  const p = page(t);
  // What the server answers on every /api/meme route while FOURLPHA_MEME_PAPER is not 1.
  const f = await mounted('web/components/near/NearAccountScreen.tsx', 'NearAccountScreen', '', () => new Error('Not found.'));
  p.unmounts.push(f.cleanup);
  const section = find(f.render(), node => node.props['aria-label'] === 'Paper agents');
  assert.equal(section ? renderToStaticMarkup(section) : '', '', 'the account page should stay as it was when paper trading is off');
});

test('audit L-1: /meme/options (or any answer that is not an agent view) does not crash the page', async t => {
  const p = page(t);
  // GET /api/meme/options is a real route, so the agent page receives a well-formed envelope that is not an agent view.
  const f = await mounted('web/components/near/NearMemeScreen.tsx', 'NearMemeScreen', 'options', () => ({ enabled: true, ai: false, bounds: {}, defaults: {} }));
  p.unmounts.push(f.cleanup);
  assert.doesNotThrow(() => f.render());
});

test('audit: the card is enabled, /deploy/trade and /meme/<id> mount the new screens, and the Grid and LP routes are unchanged', async t => {
  page(t);
  assert.equal(AGENTS.find(a => a.id === 'ai-token-trader')?.disabled, false);
  const kit = await kitApp();
  kit.go('/deploy/trade'); assert.equal(screenName(kit.screen()), 'NearTradeDeployScreen');
  kit.go('/meme/11111111-2222-4333-8444-555555555555');
  assert.equal(screenName(kit.screen()), 'NearMemeScreen');
  assert.equal(kit.screen().props.agentId, '11111111-2222-4333-8444-555555555555');
  for (const [route, kind] of [['/deploy/grid', 'grid'], ['/deploy/lp', 'lp']] as const) {
    kit.go(route);
    assert.equal(screenName(kit.screen()), 'NearDeployScreen'); assert.equal(kit.screen().props.kind, kind);
  }
  kit.go('/account'); assert.equal(screenName(kit.screen()), 'NearAccountScreen');
  kit.go('/account/abc'); assert.equal(screenName(kit.screen()), 'NearJobScreen');
});
