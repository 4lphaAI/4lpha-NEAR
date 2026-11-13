// Audit evidence for Trade V0 part B (UI), from UI-AUDIT-REPORT.md. Wired: scripts/test-ui.mjs runs every file in web/test/.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { ReactElement, ReactNode } from 'react';

const require = createRequire(process.cwd() + '/package.json');
const React = require('react') as typeof import('react');
const { renderToStaticMarkup } = require('react-dom/server') as typeof import('react-dom/server');

type Call = { path: string; body?: object };
type Node = ReactElement<Record<string, unknown>>;
type Respond = (path: string, body?: object) => unknown;
const modules = new Map<string, Promise<Record<string, (props: object) => ReactElement>>>();

// One bundle per screen. The stubs look the harness up at call time, so one cached module serves every mount.
function load(file: string): Promise<Record<string, (props: object) => ReactElement>> {
  let loaded = modules.get(file);
  if (!loaded) {
    loaded = (async () => {
      const { build } = require('esbuild') as typeof import('esbuild');
      const base = file.split('/').at(-1)!;
      const result = await build({ entryPoints: [file], bundle: true, write: false, format: 'esm', platform: 'node', tsconfig: 'web/tsconfig.json', logLevel: 'silent', plugins: [{ name: 'audit', setup(b) {
        b.onResolve({ filter: /^react(?:\/.*)?$/ }, args => args.path === 'react' && args.importer.endsWith(base)
          ? { path: 'hooks', namespace: 'audit' } : { path: pathToFileURL(require.resolve(args.path)).href, external: true });
        b.onResolve({ filter: /^@\/lib\/near-(session|wallet)$/ }, args => ({ path: args.path.endsWith('session') ? 'session' : 'api', namespace: 'audit' }));
        b.onLoad({ filter: /.*/, namespace: 'audit' }, args => ({ contents: args.path === 'hooks' ? 'export default new Proxy({}, { get: (_, key) => globalThis.__audit.hooks[key] });'
          : args.path === 'session' ? 'export const useNearSession = () => globalThis.__audit.session;'
            : 'export const api = (...a) => globalThis.__audit.api(...a);' }));
      } }] });
      return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0]!.text).toString('base64')) as Promise<Record<string, (props: object) => ReactElement>>;
    })();
    modules.set(file, loaded);
  }
  return loaded;
}

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

async function mount(file: string, name: string, respond: Respond, account: string | null = 'owner.near') {
  const module = await load(file);
  const slots: unknown[] = [], effects: (() => void | (() => void))[] = [], calls: Call[] = [], routes: string[] = [];
  let cursor = 0, first = true, logins = 0;
  const session = { state: { account, busy: false, logoutPending: false, message: '', jobs: [] as unknown[], lastPollMs: 0 },
    login: async () => { logins++; }, refresh: async () => {} };
  const hooks = { ...React,
    useState(initial: unknown) {
      const index = cursor++;
      if (first) slots[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
      return [slots[index], (value: unknown) => { slots[index] = typeof value === 'function' ? (value as (v: unknown) => unknown)(slots[index]) : value; }];
    },
    useRef(initial: unknown) { const index = cursor++; if (first) slots[index] = { current: initial }; return slots[index]; },
    useEffect(effect: () => void | (() => void)) { if (first) effects.push(effect); },
  };
  const context = { hooks, session, api: async (path: string, body?: object) => {
    calls.push({ path, body });
    const answer = respond(path, body);
    if (answer instanceof Error) throw answer;
    return answer;
  } };
  const render = () => {
    Object.defineProperty(globalThis, '__audit', { configurable: true, value: context });
    cursor = 0;
    const tree = module[name]!({ agentId: '11111111-2222-4333-8444-555555555555', go: (route: string) => routes.push(route) });
    first = false;
    return tree;
  };
  render();
  const cleanups = effects.map(effect => effect());
  await settle();
  return { render, calls, routes, session, logins: () => logins, posts: () => calls.filter(call => call.body), gets: () => calls.filter(call => !call.body),
    cleanup: () => { cleanups.forEach(cleanup => cleanup?.()); Reflect.deleteProperty(globalThis, '__audit'); } };
}

function all(tree: ReactNode, predicate: (node: Node) => boolean, found: Node[] = []): Node[] {
  for (const child of React.Children.toArray(tree)) {
    if (!React.isValidElement<Record<string, unknown>>(child)) continue;
    if (predicate(child)) found.push(child);
    all(child.props.children as ReactNode, predicate, found);
  }
  return found;
}
const one = (tree: ReactNode, predicate: (node: Node) => boolean) => all(tree, predicate)[0];
const button = (tree: ReactNode, label: string) => one(tree, node => node.props.children === label);

// A document and window that record the poll timer and the visibility listener.
function dom(t: { after(fn: () => void): void }) {
  const saved = (['document', 'window'] as const).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const page = { visibilityState: 'visible', listeners: [] as [string, () => void][], timers: [] as { fn: () => void; ms: number; id: number }[], cleared: [] as number[], removed: [] as string[],
    unmounts: [] as (() => void)[] };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    get visibilityState() { return page.visibilityState; },
    addEventListener(type: string, fn: () => void) { page.listeners.push([type, fn]); },
    removeEventListener(type: string) { page.removed.push(type); } } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    setInterval(fn: () => void, ms: number) { const id = page.timers.length + 1; page.timers.push({ fn, ms, id }); return id; },
    clearInterval(id: number) { page.cleared.push(id); } } });
  // Unmount first: a screen's effect cleanup still needs this window.
  t.after(() => { for (const unmount of page.unmounts) unmount(); for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); } });
  return page;
}

const HOSTILE = '<img src=x onerror=alert(1)>';
const ESCAPED = '&lt;img src=x onerror=alert(1)&gt;';
const MEME = 'web/components/near/NearMemeScreen.tsx', DEPLOY = 'web/components/near/NearTradeDeployScreen.tsx', ACCOUNT = 'web/components/near/NearAccountScreen.tsx';
const settings = { perAuctionNear: 10, maxOpen: 2, capitalNear: 20, termDays: 7 };
const agent = (patch: Record<string, unknown> = {}) => ({ id: '11111111-2222-4333-8444-555555555555', owner: 'owner.near', state: 'running', endReason: null, settings, createdAt: 0, endsAt: 1, isOwner: true, ...patch });
const position = (meme_id: number, patch: Record<string, unknown> = {}) => ({ meme_id, symbol: HOSTILE, status: 'deposited', closeCode: null, depositNear: '10', tokens: null, poolId: null,
  launchedAt: null, markNear: null, markAt: null, pnlBps: null, peakBps: null, exitNear: null, pnlNear: null, openedAt: 0, closedAt: null, ...patch });
const auction = (meme_id: number, ask: unknown) => ({ meme_id, symbol: HOSTILE, endMs: 2, depositors: 12, totalStakedNear: '60', softCapNear: '100', screen: 'pass', ask, checkedAt: 1, windowOpensAt: 1, windowClosesAt: 2 });
const fullView = (patch: Record<string, unknown> = {}) => ({ agent: agent(),
  summary: { deposited: 1, open: 1, closed: 1, refunded: 1, wins: 0, pnlNear: '0', winRateBps: 0 },
  positions: [position(2313), position(2250, { status: 'open', poolId: 8943, markNear: '11', pnlBps: 1000, peakBps: 1200, symbol: '"><script>alert(2)</script>' }),
    position(2249, { status: 'closed', closeCode: 'refunded', exitNear: '0', pnlNear: '0' })],
  auctions: [auction(2319, { action: 'join', confidence: 80 }), auction(2320, { failure: 'ai-off' }), auction(2321, null)],
  log: [{ kind: 'entry', meme_id: 2313, at: 3, data: { note: HOSTILE, '<b>key</b>': 1 } }, { kind: 'cycle', meme_id: null, at: 4, data: { reads: 3 } }],
  runs: [{ at: 4, reads: 3, budget: 0, unreadable: 0, invalid: 0, overrun: false, probed: [2321, 2323], discovered: [], refreshed: 0, tracked: 1, inWindow: 0, nextWindowAt: 1, screened: 0, asked: 0, entries: 0, exits: 0 }],
  meta: { lastTickAt: 5 }, ...patch });
const optionsAnswer = (patch: Record<string, unknown> = {}) => ({ enabled: true, ai: true, bounds: { perAuctionNear: [1, 50], maxOpen: [1, 3], capitalMax: 500, termDays: [7, 30] }, defaults: settings, ...patch });

function tab(f: { render: () => ReactElement }, name: string) {
  const toggle = one(f.render(), node => Array.isArray(node.props.options) && (node.props.options as unknown[]).includes('Auctions'))!;
  (toggle.props.onChange as (value: string) => void)(name);
  return f.render();
}

test('audit: every tab renders chain-derived text as text, never as markup', async t => {
  const page = dom(t);
  const f = await mount(MEME, 'NearMemeScreen', () => fullView());
  page.unmounts.push(f.cleanup);
  for (const name of ['Open', 'Closed', 'Auctions', 'Run log', 'Decision log']) {
    const tree = tab(f, name), html = renderToStaticMarkup(tree);
    assert.equal(one(tree, node => 'dangerouslySetInnerHTML' in node.props), undefined, name);
    assert.doesNotMatch(html, /<img|<script|<b>/i, name);
    if (name !== 'Run log') assert.ok(html.includes(ESCAPED), `${name} shows the hostile text escaped`);
  }
  assert.ok(renderToStaticMarkup(tab(f, 'Open')).includes('&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;'));
  assert.ok(renderToStaticMarkup(tab(f, 'Decision log')).includes('&lt;b&gt;key&lt;/b&gt;'));
});

test('audit: links go only to meme.cooking by numeric id, pool ids stay text, and tabs filter by status', async t => {
  const page = dom(t);
  const f = await mount(MEME, 'NearMemeScreen', () => fullView());
  page.unmounts.push(f.cleanup);
  const anchors = (tree: ReactNode) => all(tree, node => node.type === 'a');
  const expected: Record<string, string[]> = { Open: ['2313', '2250'], Closed: ['2249'], Auctions: ['2319', '2320', '2321'], 'Run log': [], 'Decision log': ['2313'] };
  for (const [name, ids] of Object.entries(expected)) {
    const tree = tab(f, name), links = anchors(tree);
    assert.deepEqual(links.map(link => link.props.href), ids.map(id => `https://meme.cooking/meme/${id}`), name);
    for (const link of links) { assert.equal(link.props.target, '_blank'); assert.equal(link.props.rel, 'noreferrer'); }
    assert.equal(all(tree, node => node.type === 'article').length, ids.length, name);
  }
  const open = renderToStaticMarkup(tab(f, 'Open'));
  assert.match(open, /Rhea pool: 8943/);
  assert.doesNotMatch(open, /href="[^"]*8943/);
  const auctions = renderToStaticMarkup(tab(f, 'Auctions'));
  assert.match(auctions, /Screen: pass/); assert.match(auctions, /AI: join \(80%\)/); assert.match(auctions, /AI: ai-off/); assert.match(auctions, /AI: pending/);
});

test('audit: the page carries the paper banner, the four tiles, the five tabs and the section 8 limits', async t => {
  const page = dom(t);
  const f = await mount(MEME, 'NearMemeScreen', () => fullView({ agent: agent({ isOwner: false }) }), null);
  page.unmounts.push(f.cleanup);
  const tree = f.render(), html = renderToStaticMarkup(tree);
  assert.match(html, /Paper trading \(no real orders\)/);
  assert.match(html, /Read-only/);
  assert.deepEqual(all(tree, node => typeof node.props.label === 'string' && 'value' in node.props).map(node => node.props.label), ['Paper capital', 'Paper P&L (closed)', 'Win rate', 'State']);
  assert.deepEqual(one(tree, node => Array.isArray(node.props.options))!.props.options, ['Open', 'Closed', 'Auctions', 'Run log', 'Decision log']);
  for (const limit of [/does not change the auction/, /soft cap/, /0\.5% refund fee is not counted/, /whole position sells at that minute/, /only refunds are possible/]) assert.match(html, limit);
  assert.equal(html.includes(String.fromCharCode(0x2014)), false);
});

test('audit: Stop needs isOwner, the same signed-in account, no pending logout and a running agent', async t => {
  const page = dom(t);
  let current = fullView();
  const f = await mount(MEME, 'NearMemeScreen', () => current);
  page.unmounts.push(f.cleanup);
  const stop = () => button(f.render(), 'Stop');
  assert.ok(stop());
  f.session.state.logoutPending = true; assert.equal(stop(), undefined); assert.match(renderToStaticMarkup(f.render()), /Read-only/);
  f.session.state.logoutPending = false; assert.ok(stop());
  f.session.state.account = 'visitor.near'; assert.equal(stop(), undefined);
  f.session.state.account = 'owner.near'; assert.ok(stop());
  current.agent.isOwner = false; assert.equal(stop(), undefined);
  for (const state of ['ending', 'ended']) {
    current = fullView({ agent: agent({ state }) });
    const g = await mount(MEME, 'NearMemeScreen', () => current);
    assert.equal(button(g.render(), 'Stop'), undefined, state);
    assert.equal(button(g.render(), 'Confirm stop'), undefined, state);
    g.cleanup();
  }
});

test('audit: Cancel sends nothing, a refused stop reports an error, a confirmed stop shows the refreshed state', async t => {
  const page = dom(t);
  let refuse = true, state = 'running';
  const f = await mount(MEME, 'NearMemeScreen', (path, body) => {
    if (!body) return fullView({ agent: agent({ state }) });
    assert.equal(path, '/api/meme/11111111-2222-4333-8444-555555555555/stop');
    if (refuse) return new Error('conflict');
    state = 'ending'; return true;
  });
  page.unmounts.push(f.cleanup);
  (button(f.render(), 'Stop')!.props.onClick as () => void)();
  assert.ok(button(f.render(), 'Confirm stop'));
  (button(f.render(), 'Cancel')!.props.onClick as () => void)();
  assert.equal(button(f.render(), 'Confirm stop'), undefined);
  assert.equal(f.posts().length, 0);
  (button(f.render(), 'Stop')!.props.onClick as () => void)();
  await (button(f.render(), 'Confirm stop')!.props.onClick as () => Promise<void>)();
  assert.equal(f.posts().length, 1);
  assert.match(renderToStaticMarkup(f.render()), /Could not stop the paper agent/);
  refuse = false;
  await (button(f.render(), 'Confirm stop')!.props.onClick as () => Promise<void>)();
  assert.deepEqual(f.posts().map(call => call.path), ['/api/meme/11111111-2222-4333-8444-555555555555/stop', '/api/meme/11111111-2222-4333-8444-555555555555/stop']);
  const html = renderToStaticMarkup(f.render());
  assert.equal(button(f.render(), 'Stop'), undefined);
  assert.equal(button(f.render(), 'Confirm stop'), undefined);
  assert.match(html, /ending/);
});

test('audit: the agent page polls every 15 s only while visible and stops on unmount', async t => {
  const page = dom(t);
  const f = await mount(MEME, 'NearMemeScreen', () => fullView());
  assert.equal(f.gets().length, 1);
  assert.deepEqual(page.timers.map(timer => timer.ms), [15000]);
  assert.deepEqual(page.listeners.map(([type]) => type), ['visibilitychange']);
  page.timers[0]!.fn(); await settle();
  assert.equal(f.gets().length, 2);
  page.visibilityState = 'hidden';
  page.timers[0]!.fn(); page.listeners[0]![1](); await settle();
  assert.equal(f.gets().length, 2, 'no request while hidden');
  page.visibilityState = 'visible';
  page.listeners[0]![1](); await settle();
  assert.equal(f.gets().length, 3, 'returning to the tab refreshes at once');
  assert.ok(f.gets().every(call => call.path === '/api/meme/11111111-2222-4333-8444-555555555555'));
  f.cleanup();
  assert.deepEqual(page.cleared, [page.timers[0]!.id]);
  assert.deepEqual(page.removed, ['visibilitychange']);
});

function deploy(f: Awaited<ReturnType<typeof mount>>) {
  const submit = async () => { const form = one(f.render(), node => node.type === 'form')!; await (form.props.onSubmit as (e: object) => Promise<void>)({ preventDefault() {} }); };
  const set = (key: string, value: string) => { const group = one(f.render(), node => 'section' in node.props && 'set' in node.props)!; (group.props.set as (k: string, v: string) => void)(key, value); };
  // Returns true when the submit reached POST /api/meme.
  const accepted = async (values: Record<string, string>) => {
    for (const [key, value] of Object.entries(values)) set(key, value);
    const before = f.posts().length; await submit();
    return f.posts().length === before + 1;
  };
  return { submit, set, accepted };
}

test('audit: each bound of each setting rejects on its own (no masking by the capital rule)', async t => {
  const f = await mount(DEPLOY, 'NearTradeDeployScreen', (_path, body) => body ? { id: 'paper-id' } : optionsAnswer());
  t.after(f.cleanup);
  const { accepted } = deploy(f);
  const wide = { maxOpen: '1', capitalNear: '500', termDays: '7' };
  assert.equal(await accepted({ ...wide, perAuctionNear: '0' }), false);
  assert.equal(await accepted({ ...wide, perAuctionNear: '1' }), true);
  assert.equal(await accepted({ ...wide, perAuctionNear: '50' }), true);
  assert.equal(await accepted({ ...wide, perAuctionNear: '51' }), false);
  assert.equal(await accepted({ ...wide, perAuctionNear: '1', maxOpen: '0' }), false);
  assert.equal(await accepted({ ...wide, perAuctionNear: '1', maxOpen: '3' }), true);
  assert.equal(await accepted({ ...wide, perAuctionNear: '1', maxOpen: '4' }), false);
  assert.equal(await accepted({ perAuctionNear: '10', maxOpen: '2', capitalNear: '19', termDays: '7' }), false);
  assert.equal(await accepted({ perAuctionNear: '10', maxOpen: '2', capitalNear: '20', termDays: '7' }), true);
  assert.equal(await accepted({ perAuctionNear: '10', maxOpen: '2', capitalNear: '500', termDays: '30' }), true);
  assert.equal(await accepted({ perAuctionNear: '10', maxOpen: '2', capitalNear: '501', termDays: '7' }), false);
  assert.equal(await accepted({ perAuctionNear: '10', maxOpen: '2', capitalNear: '20', termDays: '8' }), false);
  for (const bad of ['', ' ', '1.0', '-1', '1e1', '0x10', '10 ']) assert.equal(await accepted({ perAuctionNear: bad, maxOpen: '1', capitalNear: '500', termDays: '7' }), false, JSON.stringify(bad));
  assert.deepEqual(f.posts().at(-1), { path: '/api/meme', body: { perAuctionNear: 10, maxOpen: 2, capitalNear: 500, termDays: 30 } });
});

test('audit: the bounds and defaults come from /api/meme/options, and a disabled or unreachable server blocks Create', async t => {
  const narrow = optionsAnswer({ bounds: { perAuctionNear: [2, 5], maxOpen: [1, 2], capitalMax: 40, termDays: [30] }, defaults: { perAuctionNear: 2, maxOpen: 1, capitalNear: 10, termDays: 30 } });
  const f = await mount(DEPLOY, 'NearTradeDeployScreen', (_path, body) => body ? { id: 'paper-id' } : narrow);
  t.after(f.cleanup);
  assert.deepEqual(f.gets().map(call => call.path), ['/api/meme/options']);
  const { accepted, submit } = deploy(f);
  await submit();
  assert.deepEqual(f.posts(), [{ path: '/api/meme', body: { perAuctionNear: 2, maxOpen: 1, capitalNear: 10, termDays: 30 } }]);
  const base = { perAuctionNear: '2', maxOpen: '1', capitalNear: '10', termDays: '30' };
  assert.equal(await accepted({ ...base, perAuctionNear: '1' }), false);
  assert.equal(await accepted({ ...base, perAuctionNear: '6' }), false);
  assert.equal(await accepted({ ...base, maxOpen: '3', capitalNear: '40' }), false);
  assert.equal(await accepted({ ...base, capitalNear: '41' }), false);
  assert.equal(await accepted({ ...base, termDays: '7' }), false);
  assert.match(renderToStaticMarkup(f.render()), /AI gate: on/);

  const off = await mount(DEPLOY, 'NearTradeDeployScreen', (_path, body) => body ? { id: 'paper-id' } : optionsAnswer({ enabled: false }));
  await deploy(off).submit();
  assert.equal(off.posts().length, 0);
  off.cleanup();

  const down = await mount(DEPLOY, 'NearTradeDeployScreen', (_path, body) => body ? { id: 'paper-id' } : new Error('not found'));
  await deploy(down).submit();
  assert.equal(down.posts().length, 0);
  const html = renderToStaticMarkup(down.render());
  assert.match(html, /Paper trading is unavailable on this server\./); assert.match(html, /AI gate: unavailable/);
  down.cleanup();
});

test('audit: signed out the button only starts the login; a failed create stays on the page; a double submit posts once', async t => {
  const out = await mount(DEPLOY, 'NearTradeDeployScreen', (_path, body) => body ? { id: 'paper-id' } : optionsAnswer(), null);
  const connect = button(out.render(), 'Connect wallet to create')!;
  assert.equal(connect.props.type, 'button'); assert.equal(connect.props.disabled, false);
  (connect.props.onClick as () => void)();
  await deploy(out).submit();
  assert.equal(out.logins(), 1); assert.equal(out.posts().length, 0);
  const html = renderToStaticMarkup(out.render());
  for (const text of [/Deploy your <span[^>]*>Trading<\/span> Agent/, />Degen</, /Paper trades meme\.cooking auctions\. Nothing is signed\./]) assert.match(html, text);
  assert.equal(html.includes(String.fromCharCode(0x2014)), false);
  out.cleanup();

  let fail = true;
  const f = await mount(DEPLOY, 'NearTradeDeployScreen', (_path, body) => !body ? optionsAnswer() : fail ? new Error('limit') : { id: 'paper-id' });
  t.after(f.cleanup);
  const create = button(f.render(), 'Create')!;
  assert.equal(create.props.type, 'submit'); assert.equal(create.props.disabled, false); assert.equal(create.props.onClick, undefined);
  await deploy(f).submit();
  assert.deepEqual(f.routes, []);
  assert.match(renderToStaticMarkup(f.render()), /Could not create the paper agent/);
  fail = false;
  const form = one(f.render(), node => node.type === 'form')!, onSubmit = form.props.onSubmit as (e: object) => Promise<void>;
  await Promise.all([onSubmit({ preventDefault() {} }), onSubmit({ preventDefault() {} })]);
  assert.equal(f.posts().length, 2, 'one refused create plus exactly one accepted create');
  assert.deepEqual(f.routes, ['/meme/paper-id']);
});

test('audit: /account lists the signed-in owner paper agents with /meme/<id> links and polls only while visible', async t => {
  const page = dom(t);
  const list = [agent({ id: '11111111-2222-4333-8444-555555555555' }), agent({ id: '66666666-7777-4888-8999-000000000000', state: 'ended', endReason: 'owner-stopped' })];
  const f = await mount(ACCOUNT, 'NearAccountScreen', path => path === '/api/meme' ? list : new Error('unexpected'));
  const section = () => one(f.render(), node => node.props['aria-label'] === 'Paper agents');
  assert.deepEqual(f.gets().map(call => call.path), ['/api/meme']);
  const html = renderToStaticMarkup(section()!);
  assert.match(html, /Paper agents/); assert.match(html, /Trading Agent · 11111111/); assert.match(html, /running · Paper capital: 20 NEAR/); assert.match(html, /ended · Paper capital: 20 NEAR/);
  const links = all(section()!, node => node.type === 'a');
  assert.deepEqual(links.map(link => link.props.href), list.map(a => '/meme/' + a.id));
  let prevented = 0;
  (links[0]!.props.onClick as (e: object) => void)({ preventDefault() { prevented++; } });
  assert.equal(prevented, 1); assert.deepEqual(f.routes, ['/meme/' + list[0]!.id]);
  assert.deepEqual(page.timers.map(timer => timer.ms), [15000]);
  page.visibilityState = 'hidden'; page.timers[0]!.fn(); await settle();
  assert.equal(f.gets().length, 1, 'no request while hidden');
  page.visibilityState = 'visible'; page.timers[0]!.fn(); await settle();
  assert.equal(f.gets().length, 2);
  // Another account in the same tab never sees the previous owner's list.
  f.session.state.account = 'other.near';
  const shown = section(), other = shown ? renderToStaticMarkup(shown) : '';
  assert.doesNotMatch(other, /11111111|66666666/);
  f.cleanup();

  const out = await mount(ACCOUNT, 'NearAccountScreen', () => new Error('unexpected'), null);
  assert.equal(one(out.render(), node => node.props['aria-label'] === 'Paper agents'), undefined);
  assert.equal(out.calls.length, 0);
  out.cleanup();
});

test('Run log and Decision log: plain headlines, filters, readable decisions, auction times and a stale-process warning', async t => {
  const page = dom(t);
  const run = (at: number, patch: Record<string, unknown> = {}) => ({ at, reads: 3, budget: 0, unreadable: 0, invalid: 0, overrun: false, probed: [2321, 2323], discovered: [],
    refreshed: 0, tracked: 1, inWindow: 0, nextWindowAt: 1, screened: 0, asked: 0, entries: 0, exits: 0, ...patch });
  const runs = [run(30, { entries: 1, screened: 1, asked: 1 }), run(20, { unreadable: 1 }), run(10), run(8, { overrun: true }), run(7, { budget: 1, probed: null }),
    run(5, { probed: null, discovered: null, tracked: null, nextWindowAt: null })];
  const log = [{ kind: 'entry', meme_id: 2313, at: 30, data: { deposit: '10000000000000000000000000', net: '9950000000000000000000000' } },
    { kind: 'ask', meme_id: 2313, at: 30, data: { action: 'join', confidence: 80, code: 'join' } },
    { kind: 'ask', meme_id: 2314, at: 29, data: { action: 'join', confidence: 60, code: 'ai-skip' } },
    { kind: 'cycle', meme_id: 2313, at: 30, data: { screen: 'few-depositors' } }];
  const f = await mount(MEME, 'NearMemeScreen', () => fullView({ runs, log, meta: { lastTickAt: 5 } }));
  page.unmounts.push(f.cleanup);
  const runHtml = renderToStaticMarkup(tab(f, 'Run log'));
  for (const line of [/Paper entry/, /Some chain reads failed/, /Watching 1 auction; none in its decision window/, /checked ids 2321 to 2323 · 1 tracked/, /Scanned for new auctions/, /3 reads/, /The cycle ran out of time/, /Read limit reached/])
    assert.match(runHtml, line);
  const filter = one(tab(f, 'Run log'), node => Array.isArray(node.props.options) && (node.props.options as unknown[]).includes('Failed'))!;
  (filter.props.onChange as (value: string) => void)('Failed');
  const failed = renderToStaticMarkup(f.render());
  assert.match(failed, /Some chain reads failed/); assert.match(failed, /ran out of time/); assert.doesNotMatch(failed, /Watching 1 auction|Read limit reached/);
  const decisions = renderToStaticMarkup(tab(f, 'Decision log'));
  assert.match(decisions, /Paper entry: 10 NEAR \(9\.95 NEAR after the 0\.5% fee\)/); assert.match(decisions, /AI: join \(80%\)/); assert.match(decisions, /Checked: fewer than 10 depositors/);
  assert.match(decisions, /AI: join at 60%, below the 70% bar, so no entry/);
  const auctions = renderToStaticMarkup(tab(f, 'Auctions'));
  assert.match(auctions, /Last checked: /); assert.match(auctions, /Decision window: /);
  assert.match(renderToStaticMarkup(f.render()), /No cycle in the last 3 minutes: is the meme paper process running\?/);
  const empty = await mount(MEME, 'NearMemeScreen', () => fullView({ log: [], runs: [], meta: { lastTickAt: Date.now() } }));
  page.unmounts.push(empty.cleanup);
  assert.doesNotMatch(renderToStaticMarkup(empty.render()), /No cycle in the last 3 minutes/);
  assert.match(renderToStaticMarkup(tab(empty, 'Decision log')), /No decisions yet\./);
  assert.match(renderToStaticMarkup(tab(empty, 'Run log')), /No cycles recorded since this agent was created\./);
});
