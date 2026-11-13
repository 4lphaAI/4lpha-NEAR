// Demo mode spec section 10, test 12: the demo page renders the live bodies for each kind with no live control and no wallet sentence,
// Stop only for the owner, the deploy screens post the demo body, and /account lists this browser's demo agents.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import type { ReactElement, ReactNode } from 'react';
import { demoStep, type DemoAgent, type DemoMarket } from '../../src/core/demo-sim';
import { DEMO_OMITS, demoPublicView } from '../../src/core/demo-view';
import { gridSettingsFromRequest } from '../../src/core/grid-settings';
import { lpSettingsFromPrices } from '../../src/core/lp-settings';
import { toNearDown } from '../../src/core/rhea-dcl';
import { json, openStore } from '../../src/core/store';
import { outGivenIn, TRADE_RESERVE, tradePlan, tradeSettingsFromRequest } from '../../src/core/trade-settings';
import { fmt } from '../lib/near-format';

// Spec 8.1, verbatim. Not imported from the screen: its module graph holds the wallet connector, which must stay out of this bundle.
const DEMO_BANNER = 'Simulated agent. No wallet, no deposit, nothing is signed. Prices and pool data are read live from NEAR mainnet; the agent applies the live strategy rules to simulated balances.';

const require = createRequire(process.cwd() + '/package.json');
const React = require('react') as typeof import('react');
const { renderToStaticMarkup } = require('react-dom/server') as typeof import('react-dom/server');
type Node = ReactElement<Record<string, unknown>>;
const N = 10n ** 24n, MIN = 60_000, NOW = 1_800_000_000_000, P0 = 402042;
const POOL = { wnear: toNearDown(10n ** 12n, P0).toString(), token: (10n ** 12n).toString() };
const ID = '11111111-2222-4333-8444-555555555555';

/** Real public views from the backend: one agent per kind, ticked on a synthetic market, then projected as GET /api/demo/<id> answers. */
async function views() {
  const dir = mkdtempSync(join(tmpdir(), '4lpha-demo-ui-')), web = openStore(join(dir, 'd.db'), 'web'), demo = openStore(join(dir, 'd.db'), 'demo');
  const lp = lpSettingsFromPrices({ range: { mode: 'server' }, ai: false, compound: { on: false }, stopLossPct: 0, takeProfitPct: 0 });
  const schedule = tradeSettingsFromRequest('schedule', { amountNear: '0.10', intervalSec: 3600, budgetNear: '0.20', end: { kind: 'budget' } }, NOW);
  const dca = tradeSettingsFromRequest('dca', { baseNear: '0.10', orderNear: '0.10', levels: 3, stepBps: 100, tpBps: 150, slBps: 0 }, NOW);
  if (lp === 'invalid' || schedule === 'invalid' || dca === 'invalid') throw new Error('settings');
  const bodies = [{ kind: 'grid', pair: 'usdc-wnear', settings: gridSettingsFromRequest({ preset: 'balanced', orders: 4, stopLossPct: 0, takeProfitPct: 0 }), depositYocto: N },
    { kind: 'lp', pair: 'usdc-wnear', settings: lp, depositYocto: 12n * N / 10n }, { kind: 'schedule', pair: 'trade-usdc', settings: schedule, depositYocto: tradePlan(schedule) + TRADE_RESERVE },
    { kind: 'dca', pair: 'trade-rhea', settings: dca, depositYocto: tradePlan(dca) + TRADE_RESERVE }] as const;
  // One synthetic minute k, then the projection at minute k with that minute's samples.
  const tick = async (a: DemoAgent, k: number) => {
    const at = NOW + k * MIN, pool = { at, block: k, ...POOL }, history = Array.from({ length: 12 }, (_, j) => ({ ...pool, at: at - (12 - j) * MIN }));
    const m: DemoMarket = { dcl: { at, block: k, point: P0, liquidity: '38363638340228440', volX: String(1000 * k), volY: String(10n ** 21n * BigInt(k)), protocolBps: 2000 },
      pools: { 4512: pool, 6458: pool, 6065: pool }, history: { 4512: history, 6458: history, 6065: history } };
    demo.saveDemo(a, await demoStep(a, m, at), at); return demo.getDemoAgent(a.id)!;
  };
  const project = (a: DemoAgent, k: number) => {
    const at = NOW + k * MIN;
    demo.setMeta('demo_dcl', JSON.stringify([{ at, block: k, point: P0, liquidity: '38363638340228440', volX: '1', volY: '1', protocolBps: 2000 }]));
    for (const id of [4512, 6458, 6065]) demo.setMeta(`demo_px:${id}`, JSON.stringify([{ at, block: k, ...POOL }]));
    const as = (isOwner: boolean) => { const v = JSON.parse(json(demoPublicView(web, a, at + 1000, isOwner))) as { job: { id: string } }; v.job.id = ID; return v; };
    return { owner: as(true), visitor: as(false) };
  };
  const out: Record<string, { owner: unknown; visitor: unknown }> = {};
  for (const [i, b] of bodies.entries()) {
    let a: DemoAgent = web.createDemoAgent({ owner: String(i).repeat(64), kind: b.kind, pair: b.pair, settings: b.settings as DemoAgent['settings'], depositYocto: b.depositYocto.toString(), seed: 0 }, NOW);
    for (let k = 1; k <= 12; k++) a = await tick(a, k);
    out[b.kind] = project(a, 12);
  }
  // Audit F-1: a Schedule buy that bought, was stopped by its owner and settled to `ended`.
  let e: DemoAgent = web.createDemoAgent({ owner: '9'.repeat(64), kind: 'schedule', pair: 'trade-usdc', settings: schedule, depositYocto: (tradePlan(schedule) + TRADE_RESERVE).toString(), seed: 0 }, NOW);
  let k = 1;
  for (; k <= 12; k++) e = await tick(e, k);
  assert.ok(web.stopDemoAgent(e, NOW + k * MIN));
  for (e = web.getDemoAgent(e.id)!; e.state !== 'ended' && k < 20; k++) e = await tick(e, k);
  assert.equal(e.state, 'ended');
  out.ended = project(e, k - 1);
  web.close(); demo.close(); rmSync(dir, { recursive: true });
  return out;
}

// One screen file with slot-backed hooks (effects run once, as web/test/meme-ui.test.ts), the session and the API scripted.
async function mount(file: string, name: string, props: object, respond: (path: string, body?: object) => unknown, account: string | null = null, options: object | null = null) {
  const { build } = require('esbuild') as typeof import('esbuild');
  const slots: unknown[] = [], effects: (() => void | (() => void))[] = [], calls: { path: string; body?: object }[] = [], routes: string[] = [], prepared: number[] = [];
  let cursor = 0, first = true;
  const lpDraft = { rangeMode: 'explicit', minPrice: '', maxPrice: '', ai: false, compound: true, minFeeBps: '100', stopLossPct: '0', takeProfitPct: '0', edited: {}, prefilled: {} };
  const session = { state: { account, options, optionsError: false, busy: false, logoutPending: false, message: '', lpDraft, jobs: [], lastPollMs: 0 },
    login: async () => {}, refresh: async () => {}, refreshLpOptions: async () => {}, setLpField: () => {}, prepareHire: async () => { prepared.push(1); } };
  const hooks = { ...React,
    useState(initial: unknown) { const i = cursor++; if (first) slots[i] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
      return [slots[i], (v: unknown) => { slots[i] = typeof v === 'function' ? (v as (x: unknown) => unknown)(slots[i]) : v; }]; },
    useRef(initial: unknown) { const i = cursor++; if (first) slots[i] = { current: initial }; return slots[i]; },
    useCallback(fn: unknown) { return fn; },
    useEffect(effect: () => void | (() => void)) { if (first) effects.push(effect); },
  };
  Object.defineProperty(globalThis, '__demoUi', { configurable: true, value: { hooks, session, api: async (path: string, body?: object) => {
    calls.push({ path, body }); const answer = respond(path, body); if (answer instanceof Error) throw answer; return answer;
  } } });
  const base = file.split('/').at(-1)!;
  const result = await build({ entryPoints: [file], bundle: true, write: false, format: 'esm', platform: 'node', tsconfig: 'web/tsconfig.json', logLevel: 'silent', plugins: [{ name: 'demo-ui', setup(b) {
    b.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, args => args.path === 'react' && args.importer.endsWith(base)
      ? { path: 'hooks', namespace: 'du' } : { path: pathToFileURL(require.resolve(args.path)).href, external: true });
    b.onResolve({ filter: /^@\/lib\/near-(session|wallet)$/ }, args => ({ path: args.path.endsWith('session') ? 'session' : 'api', namespace: 'du' }));
    b.onLoad({ filter: /.*/, namespace: 'du' }, args => ({ contents: args.path === 'hooks' ? 'export default globalThis.__demoUi.hooks;'
      : args.path === 'session' ? 'export const useNearSession = () => globalThis.__demoUi.session;'
        : 'export const api = (...a) => globalThis.__demoUi.api(...a); export const sign = () => {}; export const sendCall = () => {}; export const clearSelectedWallet = () => {}; export const transferWallet = () => {};' }));
  } }] });
  const module = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0]!.text + `\n// ${Math.random()}`).toString('base64')) as Record<string, (p: object) => Node>;
  const render = () => { cursor = 0; const tree = module[name]!({ ...props, go: (r: string) => routes.push(r) }); first = false; return tree; };
  render();
  const cleanups = effects.map(e => e());
  for (let i = 0; i < 5; i++) await new Promise<void>(r => setImmediate(r));
  return { render, calls, routes, prepared, cleanup: () => { cleanups.forEach(c => c?.()); Reflect.deleteProperty(globalThis, '__demoUi'); } };
}
function all(tree: ReactNode, predicate: (n: Node) => boolean, found: Node[] = []): Node[] {
  for (const child of React.Children.toArray(tree)) {
    if (!React.isValidElement<Record<string, unknown>>(child)) continue;
    if (predicate(child)) found.push(child);
    all(child.props.children as ReactNode, predicate, found);
  }
  return found;
}
const labelled = (tree: ReactNode, label: string) => all(tree, n => n.props.children === label)[0];
function page(t: { after(fn: () => void): void }) {
  const saved = (['document', 'window'] as const).map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const);
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { setInterval: () => 1, clearInterval() {} } });
  t.after(() => { for (const [k, v] of saved) { if (v) Object.defineProperty(globalThis, k, v); else Reflect.deleteProperty(globalThis, k); } });
}

test('demo page: each kind renders the live body under the banner with the omits, no live control, no wallet sentence, and Stop only for the owner', async t => {
  page(t);
  const fixtures = await views();
  for (const [kind, { owner, visitor }] of Object.entries(fixtures)) {
    for (const [view, isOwner] of [[visitor, false], [owner, true]] as const) {
      const f = await mount('web/components/near/NearDemoScreen.tsx', 'NearDemoScreen', { agentId: ID }, path => path === `/api/demo/${ID}` ? view : new Error('Not found.'));
      // The whole markup, attributes included (hover text sits in title and aria-label).
      const tree = f.render(), html = renderToStaticMarkup(tree);
      assert.deepEqual(f.calls.map(c => c.path), [`/api/demo/${ID}`], kind);
      assert.ok(html.includes(DEMO_BANNER), kind);
      for (const line of DEMO_OMITS) assert.ok(html.includes(line.replace(/'/g, '&#x27;')), `${kind}: ${line}`);
      assert.doesNotMatch(html, />(Fund|Fund the agent|Freeze|Freeze now|Unfreeze|Stop and withdraw|Reveal management link|Prepare hire)</, kind);
      for (const sentence of ['in the agent wallet', 'in your wallet', 'key custody']) assert.ok(!html.includes(sentence), `${kind}: ${sentence}`);
      assert.equal(labelled(tree, 'Stop') !== undefined, isOwner && kind !== 'ended', `${kind}: Stop only for the owner of a running agent`);
      assert.equal(html.includes('Read-only'), !isOwner);
      if (kind === 'lp') assert.match(html, /estimated: /, 'LP fees are labelled estimated');
      if (kind === 'schedule' || kind === 'dca') { assert.match(html, /\/ wNEAR · Simulated/); assert.doesNotMatch(html, /· Mainnet/); }
      if (kind === 'ended') {
        // Audit F-1: the Value tile of an ended trade agent is its final result in NEAR (the token sold back on the pool), not the settled ledger's 0.
        const r = (view as { demo: { result: { near: string; token: string } } }).demo.result;
        assert.ok(BigInt(r.token) > 0n, 'the fixture bought tokens');
        assert.equal(all(tree, n => n.props.label === 'Value')[0]!.props.value, fmt((BigInt(r.near) + outGivenIn(BigInt(r.token), BigInt(POOL.token), BigInt(POOL.wnear), 30)).toString()));
      }
      assert.equal(html.includes(String.fromCharCode(0x2014)), false, `${kind}: no em dash in the whole markup`);
      f.cleanup();
    }
  }
  // The owner's Stop asks first, then posts to the stop route.
  const f = await mount('web/components/near/NearDemoScreen.tsx', 'NearDemoScreen', { agentId: ID }, (path, body) => body ? true : fixtures.grid!.owner);
  (labelled(f.render(), 'Stop')!.props.onClick as () => void)();
  assert.equal(f.calls.filter(c => c.body).length, 0);
  await (labelled(f.render(), 'Confirm stop')!.props.onClick as () => Promise<void>)();
  assert.deepEqual(f.calls.filter(c => c.body), [{ path: `/api/demo/${ID}/stop`, body: {} }]);
  f.cleanup();
});

const HIRE = { kind: 'grid', liveEnabled: false, demo: true, gridV1: true, gridV2: true, lpV1: true, minDeposit: N.toString(), maxDeposit: (2n * N).toString(),
  lp: { minDeposit: (12n * N / 10n).toString(), maxDeposit: (3n * N).toString(), point: P0, ai: true },
  trade: { enabled: true, reserveNear: '0.4', pairs: [{ id: 'trade-usdc', symbol: 'USDC', token: 'usdc', decimals: 6, poolId: 4512, feeBps: 30, spot: null }],
    bounds: { schedule: { amountNear: ['0.10', '0.24'], budgetNear: ['0.20', '1.60'], intervalSec: [3600, 14400, 28800, 43200, 86400], runs: [1, 16], dateMaxMs: NOW + 6 * 86_400_000 },
      dca: { orderNear: ['0.10', '0.24'], levels: [1, 8], maxStepBps: [3000, 3000, 2450, 1650, 1200, 900, 650, 500], tpBps: [150, 5000], slBps: [100, 9000], planMaxNear: '1.60' } },
    defaults: { schedule: { pair: 'trade-usdc', amountNear: '0.10', budgetNear: '0.20', intervalSec: 3600, end: { kind: 'budget' } },
      dca: { pair: 'trade-usdc', baseNear: '0.10', orderNear: '0.10', levels: 3, stepBps: 100, tpBps: 150, slBps: 0 } } } };
// Demo in the main app (DEMO-MODE-COMBINED-PLAN sections 2 and 4.3): the Demo | Live switch replaces the old secondary demo button.
test('deploy screens: the Demo | Live switch; signed out Demo is the default and Start demo agent posts the form values as the demo body for each kind', async t => {
  page(t);
  const price = (p: number) => (1e18 / 1.0001 ** p).toFixed(6);
  const DEMO_LINE = 'Demo runs on live prices and simulates the fills. No wallet, no deposit, nothing is signed.';
  const toggle = (tree: ReactNode) => all(tree, n => Array.isArray(n.props.options) && JSON.stringify(n.props.options).includes('"demo"'))[0];
  const respond = (path: string, body?: object) => path === '/api/demo/options' ? { enabled: true, hire: HIRE } : path === '/api/demo' && body ? { id: ID }
    : path === '/api/meme/options' ? { enabled: true, ai: false, bounds: {}, defaults: {} } : new Error('Not found.');
  const open = (kind: 'grid' | 'lp' | 'schedule' | 'dca', account: string | null = null, options: object | null = null) => kind === 'schedule' || kind === 'dca'
    ? mount('web/components/near/NearTradeDeployScreen.tsx', 'NearTradeDeployScreen', { model: kind }, respond, account, options)
    : mount('web/components/near/NearDeployScreen.tsx', 'NearDeployScreen', { kind }, respond, account, options);
  const expected = {
    grid: { kind: 'grid', pair: 'usdc-wnear', depositYocto: N.toString(), grid: { preset: 'balanced', orders: 4, stopLossPct: 0, takeProfitPct: 0 } },
    lp: { kind: 'lp', pair: 'usdc-wnear', depositYocto: (12n * N / 10n).toString(), lp: { range: { mode: 'explicit', minPrice: price(P0 + 100), maxPrice: price(P0 - 100) }, ai: true,
      compound: { on: true, minFeeBps: 100 }, stopLossPct: 0, takeProfitPct: 0 } },
    schedule: { kind: 'schedule', pair: 'trade-usdc', depositYocto: (6n * N / 10n).toString(), trade: { amountNear: '0.10', intervalSec: 3600, budgetNear: '0.20', end: { kind: 'budget' } } },
    dca: { kind: 'dca', pair: 'trade-usdc', depositYocto: (8n * N / 10n).toString(), trade: { baseNear: '0.10', orderNear: '0.10', levels: 3, stepBps: 100, tpBps: 150, slBps: 0 } },
  } as const;
  const start = async (f: Awaited<ReturnType<typeof mount>>) => {
    await (labelled(f.render(), 'Start demo agent')!.props.onClick as () => Promise<void>)();
    for (let i = 0; i < 3; i++) await new Promise<void>(r => setImmediate(r));
  };
  // Signed out: the switch shows with Demo selected, no live hire text, and Start demo agent posts the demo body.
  for (const kind of ['grid', 'lp', 'schedule', 'dca'] as const) {
    const f = await open(kind);
    assert.ok(f.calls.some(c => c.path === '/api/demo/options'), `${kind}: the demo options are read without a session`);
    const tree = f.render(), html = renderToStaticMarkup(tree);
    assert.equal(toggle(tree)?.props.value, 'demo', kind);
    assert.ok(html.includes(DEMO_LINE), kind);
    for (const text of ['Connect wallet to hire', 'Prepare hire', 'Hire the agent wallet', 'Real funds.', 'key custody', 'Live hires are disabled.', 'from your wallet', 'your wallet', 'agent wallet'])
      assert.ok(!html.includes(text), `${kind}: ${text}`);
    await start(f);
    assert.deepEqual(f.calls.filter(c => c.body), [{ path: '/api/demo', body: expected[kind] }], kind);
    assert.deepEqual(f.routes, [`/demo/${ID}`], kind);
    f.cleanup();
  }
  // Signed in: the switch shows only when the live options report demo: true, with Live selected, and Live is exactly the screen without the switch.
  // Without demo: true no demo request is made and no switch shows.
  for (const kind of ['grid', 'schedule'] as const) {
    const markup: string[] = [];
    for (const demo of [true, false]) {
      const signed = await open(kind, 'owner.near', { ...HIRE, liveEnabled: true, demo });
      assert.deepEqual(signed.calls.filter(c => c.path.startsWith('/api/demo')).map(c => c.path), demo ? ['/api/demo/options'] : [], `${kind}: demo ${demo}`);
      const tree = signed.render();
      assert.equal(toggle(tree)?.props.value, demo ? 'live' : undefined, `${kind}: demo ${demo}`);
      markup.push(renderToStaticMarkup(tree).replace(/<div class="fl-seg"[^]*?<\/div>/, ''));
      signed.cleanup();
    }
    assert.ok(markup[0]!.includes('Prepare hire') && !markup[0]!.includes(DEMO_LINE), kind);
    assert.equal(markup[0], markup[1], `${kind}: Live is the live screen`);
  }
  // Audit R-1: signed in on a web whose own live options report every strategy off, Demo takes the form from the demo options and posts the signed-out bodies.
  const demoWebLive = { ...HIRE, liveEnabled: false, demo: true, gridV1: false, gridV2: false, lpV1: false, lp: null, trade: { ...HIRE.trade, enabled: false } };
  for (const kind of ['grid', 'lp', 'schedule', 'dca'] as const) {
    const signed = await open(kind, 'owner.near', demoWebLive);
    // Audit C-5: live hires off on this web, so Demo is the default even with a wallet session.
    assert.equal(toggle(signed.render())!.props.value, 'demo', `${kind}: Demo by default when live hires are off`);
    { const tree = signed.render(), html = renderToStaticMarkup(tree), button = labelled(tree, 'Start demo agent')!;
      // Audit C-1: signed in, Demo shows no live control or live sentence, and a form submit prepares no live hire.
      assert.deepEqual([button.props.type, button.props.disabled], ['button', false], `signed in ${kind}`);
      for (const text of ['Prepare hire', 'Hire the agent wallet', 'Real funds.', 'key custody', 'Live hires are disabled.', 'your wallet', 'agent wallet'])
        assert.ok(!html.includes(text), `signed in ${kind}: ${text}`);
      (all(tree, n => n.type === 'form')[0]!.props.onSubmit as (e: object) => void)({ preventDefault() {} });
      for (let i = 0; i < 3; i++) await new Promise<void>(r => setImmediate(r));
      assert.equal(signed.prepared.length, 0, `signed in ${kind}: a submit in Demo prepares no live hire`); }
    if (kind === 'grid' || kind === 'lp') assert.match(renderToStaticMarkup(signed.render()), kind === 'grid' ? /Tight Scalp/ : new RegExp(`point ${P0}`), `${kind}: the Demo form follows the demo options`);
    await start(signed);
    assert.deepEqual(signed.calls.filter(c => c.body), [{ path: '/api/demo', body: expected[kind] }], `signed in ${kind}`);
    signed.cleanup();
  }
  // The remembered choice wins over the default, and a pick is remembered.
  const saved = new Map<string, string>([['fourlpha_deploy_mode', 'live']]);
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { setInterval: () => 1, clearInterval() {},
    localStorage: { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => { saved.set(k, v); } } } });
  const out = await open('grid');
  assert.equal(toggle(out.render())!.props.value, 'live', 'signed out, remembered Live');
  assert.ok(labelled(out.render(), 'Connect wallet to hire'));
  (toggle(out.render())!.props.onChange as (v: string) => void)('demo');
  assert.equal(saved.get('fourlpha_deploy_mode'), 'demo');
  out.cleanup();
  const signedIn = await open('dca', 'owner.near', { ...HIRE, liveEnabled: true });
  assert.equal(toggle(signedIn.render())!.props.value, 'demo', 'signed in, remembered Demo');
  assert.ok(labelled(signedIn.render(), 'Start demo agent'));
  signedIn.cleanup();
  // A visitor on a live instance (the demo routes answer not_found) sees no switch and the live screen.
  const live = await mount('web/components/near/NearDeployScreen.tsx', 'NearDeployScreen', { kind: 'grid' }, () => new Error('Not found.'));
  assert.equal(toggle(live.render()), undefined);
  assert.ok(labelled(live.render(), 'Connect wallet to hire'));
  live.cleanup();
});

test('account: the demo agents of this browser are listed with /demo/<id> links, with or without a wallet session', async () => {
  const list = [{ id: ID, kind: 'grid', pair: 'usdc-wnear', state: 'running', endReason: null, createdAt: NOW, endsAt: NOW + 7 * 86_400_000, value: N.toString() }];
  const f = await mount('web/components/near/NearDemoAgents.tsx', 'NearDemoAgents', {}, path => path === '/api/demo' ? list : new Error('Not found.'));
  const html = renderToStaticMarkup(f.render());
  assert.match(html, /Demo agents \(this browser\)/); assert.match(html, /Grid Keeper · 11111111 · Simulated/); assert.match(html, /running · Value: 1\.000000 NEAR/);
  const link = all(f.render(), n => n.type === 'a')[0]!;
  assert.equal(link.props.href, `/demo/${ID}`);
  (link.props.onClick as (e: object) => void)({ preventDefault() {} });
  assert.deepEqual(f.routes, [`/demo/${ID}`]);
  f.cleanup();
  const none = await mount('web/components/near/NearDemoAgents.tsx', 'NearDemoAgents', {}, () => new Error('Not found.'));
  assert.equal(renderToStaticMarkup(none.render()), '', 'a live instance (not_found) adds nothing');
  none.cleanup();
  const kit = (await import('node:fs')).readFileSync('web/components/near/NearAccountScreen.tsx', 'utf8');
  assert.match(kit, /<NearDemoAgents go=\{go\} \/>/);
  assert.match((await import('node:fs')).readFileSync('web/components/KitApp.tsx', 'utf8'), /route\.startsWith\("\/demo\/"\)/);
});
