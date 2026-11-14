// Re-check evidence for the fixes applied after UI-AUDIT-REPORT.md (L-1, M-1, L-3). Wired: scripts/test-ui.mjs runs every file in web/test/.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { ReactElement, ReactNode } from 'react';
import { AGENTS } from '@/lib/design-data';
import { SIGMA_REACTIONS } from '@/lib/sigma-pet';

const require = createRequire(process.cwd() + '/package.json');
const React = require('react') as typeof import('react');
const { renderToStaticMarkup } = require('react-dom/server') as typeof import('react-dom/server');

type Call = { path: string; body?: object };
type Node = ReactElement<Record<string, unknown>>;
type Respond = (path: string, body?: object) => unknown;
const modules = new Map<string, Promise<Record<string, (props: object) => ReactElement>>>();

// One bundle per screen. With `slots` the file's own `react` import is the harness (state in slots, effects run once); without it React is real.
function load(file: string, slots: boolean): Promise<Record<string, (props: object) => ReactElement>> {
  const key = `${file}:${slots}`;
  let loaded = modules.get(key);
  if (!loaded) {
    loaded = (async () => {
      const { build } = require('esbuild') as typeof import('esbuild');
      const base = file.split('/').at(-1)!;
      const result = await build({ entryPoints: [file], bundle: true, write: false, format: 'esm', platform: 'node', tsconfig: 'web/tsconfig.json', logLevel: 'silent', plugins: [{ name: 'recheck', setup(b) {
        b.onResolve({ filter: /^react(?:\/.*)?$/ }, args => slots && args.path === 'react' && args.importer.endsWith(base)
          ? { path: 'hooks', namespace: 'recheck' } : { path: pathToFileURL(require.resolve(args.path)).href, external: true });
        b.onResolve({ filter: /^@\/lib\/near-(session|wallet)$/ }, args => ({ path: args.path.endsWith('session') ? 'session' : 'api', namespace: 'recheck' }));
        b.onLoad({ filter: /.*/, namespace: 'recheck' }, args => ({ contents: args.path === 'hooks' ? 'export default new Proxy({}, { get: (_, key) => globalThis.__recheck.hooks[key] });'
          : args.path === 'session' ? 'export const useNearSession = () => globalThis.__recheck.session;'
            : 'export const api = (...a) => globalThis.__recheck.api(...a);' }));
      } }] });
      return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0]!.text + `\n// ${key}`).toString('base64')) as Promise<Record<string, (props: object) => ReactElement>>;
    })();
    modules.set(key, loaded);
  }
  return loaded;
}
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

async function mount(file: string, name: string, agentId: string, respond: Respond) {
  const module = await load(file, true);
  const slots: unknown[] = [], effects: (() => void | (() => void))[] = [], calls: Call[] = [];
  let cursor = 0, first = true;
  const session = { state: { account: 'owner.near' as string | null, busy: false, logoutPending: false, message: '', jobs: [] as unknown[], lastPollMs: 0 }, login: async () => {}, refresh: async () => {} };
  const hooks = { ...React,
    useState(initial: unknown) {
      const index = cursor++;
      if (first) slots[index] = initial;
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
    Object.defineProperty(globalThis, '__recheck', { configurable: true, value: context });
    cursor = 0;
    const tree = module[name]!({ agentId, go: () => {} });
    first = false;
    return tree;
  };
  render();
  const cleanups = effects.map(effect => effect());
  await settle();
  return { render, calls, cleanup: () => { cleanups.forEach(cleanup => cleanup?.()); Reflect.deleteProperty(globalThis, '__recheck'); } };
}
function all(tree: ReactNode, predicate: (node: Node) => boolean, found: Node[] = []): Node[] {
  for (const child of React.Children.toArray(tree)) {
    if (!React.isValidElement<Record<string, unknown>>(child)) continue;
    if (predicate(child)) found.push(child);
    all(child.props.children as ReactNode, predicate, found);
  }
  return found;
}
const tiles = (tree: ReactNode) => all(tree, node => typeof node.props.label === 'string' && 'value' in node.props).length;
// A document and window that record the poll timer and the visibility listener. Mounted screens are unmounted before they are restored.
function dom(t: { after(fn: () => void): void }) {
  const saved = (['document', 'window'] as const).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const page = { timers: [] as { fn: () => void; id: number }[], cleared: [] as number[], listeners: [] as (() => void)[], removed: 0, unmounts: [] as (() => void)[] };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { visibilityState: 'visible',
    addEventListener(_type: string, fn: () => void) { page.listeners.push(fn); }, removeEventListener() { page.removed++; } } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    setInterval(fn: () => void) { const id = page.timers.length + 1; page.timers.push({ fn, id }); return id; }, clearInterval(id: number) { page.cleared.push(id); } } });
  t.after(() => { for (const unmount of page.unmounts) unmount(); for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); } });
  return page;
}

const MEME = 'web/components/near/NearMemeScreen.tsx', ACCOUNT = 'web/components/near/NearAccountScreen.tsx', DETAIL = 'web/components/screens/AgentDetailScreen.tsx';
const ID = '11111111-2222-4333-8444-555555555555', OTHER = '66666666-7777-4888-8999-000000000000';
const agent = (patch: Record<string, unknown> = {}) => ({ id: ID, owner: 'owner.near', state: 'running', endReason: null, settings: { perAuctionNear: 10, maxOpen: 2, capitalNear: 20, termDays: 7 }, createdAt: 0, endsAt: 1, isOwner: true, ...patch });
const view = (patch: Record<string, unknown> = {}) => ({ agent: agent(), summary: { deposited: 0, open: 0, closed: 0, refunded: 0, wins: 0, pnlNear: '0', winRateBps: 0 }, positions: [], auctions: [], log: [], runs: [], meta: { lastTickAt: null }, ...patch });

test('recheck L-1: an id that is not a UUID asks the server nothing, starts no poll and shows not found', async t => {
  const page = dom(t);
  for (const id of ['options', '', 'x'.repeat(36), ID.slice(0, -1), ID + '0', `${ID}/stop`]) {
    const f = await mount(MEME, 'NearMemeScreen', id, () => view());
    assert.equal(f.calls.length, 0, JSON.stringify(id));
    const tree = f.render(), html = renderToStaticMarkup(tree);
    assert.match(html, /Paper agent not found\./, JSON.stringify(id));
    assert.match(html, /Paper trading \(no real orders\)/);
    assert.equal(tiles(tree), 0);
    f.cleanup();
  }
  assert.deepEqual(page.timers, []);
  assert.deepEqual(page.listeners, []);
});

test('recheck L-1: an answer that is not the view of this agent shows not found, and a real view still renders', async t => {
  const page = dom(t);
  const answers: Record<string, unknown> = {
    'the options answer': { enabled: true, ai: false, bounds: {}, defaults: {} }, 'an empty object': {}, 'a list': [agent()],
    'the view of another agent': view({ agent: agent({ id: OTHER }) }), 'a view without positions': view({ positions: undefined }),
    'a view without a log': view({ log: null }), 'a view without runs': view({ runs: undefined }), 'a view with an unknown state': view({ agent: agent({ state: 'paused' }) }),
    'a view without the owner flag': view({ agent: agent({ isOwner: undefined }) }), 'a view without settings': view({ agent: agent({ settings: undefined }) }),
  };
  for (const [name, answer] of Object.entries(answers)) {
    const f = await mount(MEME, 'NearMemeScreen', ID, () => answer);
    page.unmounts.push(f.cleanup);
    assert.deepEqual(f.calls.map(call => call.path), ['/api/meme/' + ID], name);
    let tree: ReactElement | undefined;
    assert.doesNotThrow(() => { tree = f.render(); }, name);
    assert.match(renderToStaticMarkup(tree!), /Paper agent not found\./, name);
    assert.equal(tiles(tree!), 0, name);
  }
  const good = await mount(MEME, 'NearMemeScreen', ID, () => view());
  page.unmounts.push(good.cleanup);
  assert.equal(tiles(good.render()), 4);
  assert.doesNotMatch(renderToStaticMarkup(good.render()), /Paper agent not found\./);
});

// What the account page adds below the copied account content: the children it passes into that content's frame.
const paperPart = (tree: ReactElement) => renderToStaticMarkup(React.createElement(React.Fragment, null, ...React.Children.toArray((tree as Node).props.children as ReactNode)));

test('recheck M-1: with the paper flag off the account page adds nothing and stops asking', async t => {
  const page = dom(t);
  // The server answers not_found, message "Not found.", on every /api/meme route while the flag is off.
  const f = await mount(ACCOUNT, 'NearAccountScreen', '', () => new Error('Not found.'));
  page.unmounts.push(f.cleanup);
  assert.equal(paperPart(f.render()), '');
  assert.deepEqual(f.calls.map(call => call.path), ['/api/meme']);
  assert.deepEqual(page.cleared, [page.timers[0]!.id]);
  assert.equal(page.removed, 1);
  page.timers[0]!.fn(); page.listeners[0]!(); await settle();
  assert.equal(f.calls.length, 1, 'no further request after not_found');
  assert.equal(paperPart(f.render()), '');
});

test('Account: no paper agents means no paper section', async t => {
  const page = dom(t);
  const f = await mount(ACCOUNT, 'NearAccountScreen', '', () => []);
  page.unmounts.push(f.cleanup);
  assert.deepEqual(f.calls.map(call => call.path), ['/api/meme']);
  assert.equal(paperPart(f.render()), '');
});

test('recheck M-1: with the flag on a failed request shows the message, keeps polling, and the list comes back', async t => {
  const page = dom(t);
  let fail = true, missing = false;
  const f = await mount(ACCOUNT, 'NearAccountScreen', '', () => missing ? new Error('Not found.') : fail ? new Error('A valid wallet signature or session is required.') : [agent()]);
  page.unmounts.push(f.cleanup);
  const message = /Paper agents are unavailable on this server or your session has expired\./;
  let html = paperPart(f.render());
  assert.match(html, message); assert.doesNotMatch(html, /aria-label="Paper agents"/);
  assert.deepEqual(page.cleared, []); assert.equal(page.removed, 0);
  fail = false; page.timers[0]!.fn(); await settle();
  html = paperPart(f.render());
  assert.match(html, /aria-label="Paper agents"/); assert.match(html, /Trading Agent · 11111111/); assert.doesNotMatch(html, message);
  fail = true; page.timers[0]!.fn(); await settle();
  html = paperPart(f.render());
  assert.match(html, message); assert.match(html, /Trading Agent · 11111111/);
  assert.equal(f.calls.length, 3);
  // The API turning not_found later (the server restarted without the flag) removes the list and the message.
  missing = true; page.timers[0]!.fn(); await settle();
  assert.equal(paperPart(f.render()), '');
  assert.equal(f.calls.length, 4);
});

test('recheck L-3: the trader card, detail page and pet line describe a paper agent and claim no wallet, freeze, gas or real trade', async () => {
  const trader = AGENTS.find(a => a.id === 'ai-token-trader')!;
  const card = [trader.tagline, trader.protocol, trader.pair, trader.priceUnit].join(' | ');
  assert.match(card, /on paper/); assert.match(card, /No real orders/); assert.match(card, /meme\.cooking/);
  assert.doesNotMatch(card, /Rhea|RHEA|USDC|profit|return/i);
  const module = await load(DETAIL, false);
  const Detail = module.AgentDetailScreen as (props: Record<string, unknown>) => ReactElement;
  const page = (id: string) => renderToStaticMarkup(React.createElement(Detail, { agent: AGENTS.find(a => a.id === id), go: () => {} }));
  const paper = page('ai-token-trader');
  for (const text of [/Paper only\. No deposit or agent wallet\./, /joins on paper after an AI gate/, /Place real orders or create a wallet\./, /Only the owner can stop it\./, /Try the demo: no wallet or funds needed\./, /No deposit, agent wallet or real orders\./, /paper agent fee/]) assert.match(paper, text);
  for (const claim of [/freeze the agent wallet/, /Network gas/, /Takes 3 steps/, /performance fee/, /on-chain/, /Rhea/, /revoke/, /swap/i, /take profit|stop loss/i]) assert.doesNotMatch(paper, claim);
  assert.equal(paper.includes(String.fromCharCode(0x2014)), false);
  // The other agents keep their own text.
  const lp = page('range-pilot');
  for (const text of [/Takes 3 steps\. You can revoke anytime\./, /You can freeze the agent wallet anytime\./, /performance fee/, /Gas is paid from the agent wallet/]) assert.match(lp, text);
  assert.doesNotMatch(lp, /Paper only|paper agent/);
  const line = SIGMA_REACTIONS['deploy.trade'].bubbleText ?? '';
  assert.match(line, /Paper/); assert.match(line, /No real orders or agent wallet/); assert.doesNotMatch(line, /capped spend|Pinned universe/);
});
