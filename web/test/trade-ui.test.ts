// Trade V1 part B (spec section 15.11): the deploy cards and forms, the hire body, the job detail, the formatting and the account row.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { ReactElement, ReactNode } from 'react';
import { createNearActions, type TradeOptions } from '@/lib/near-actions';
import { asset, canRequestResume, fmt, resumeLabel, RHEA, tokenAmount, USDC, WNEAR, ZEC, type Job, type TradeView } from '@/lib/near-format';
import { FundsCards, JobDetails } from '@/components/near/NearJobPanels';
import { catalogId, catalogName, rowPresentation, toPortfolio, tradeNearTotal, valuation } from '@/lib/near-map';
import { agentDeployKind, AGENTS } from '@/lib/design-data';
import { hireText, liveHire, TRADE_DISABLED, USDC_NOTE, DCA_NOTE } from '@/components/near/NearTradeDeployScreen';
import { NearTradeDetail, REFUND_TEXT } from '@/components/near/NearTradeDetail';
import { tradeRowValue } from '@/components/near/NearAccountScreen';
import type { api } from '@/lib/near-wallet';

const require = createRequire(process.cwd() + '/package.json');
const React = require('react') as typeof import('react');
const { renderToStaticMarkup } = require('react-dom/server') as typeof import('react-dom/server');
type Node = ReactElement<Record<string, unknown>>;
const N = 10n ** 24n, near = (s: string) => { const [i, f = ''] = s.split('.'); return (BigInt(i!) * N + BigInt(f.padEnd(24, '0'))).toString(); };
const EM_DASH = String.fromCharCode(0x2014);

const OPTIONS: TradeOptions = {
  enabled: true, reserveNear: '0.4',
  pairs: [{ id: 'trade-usdc', symbol: 'USDC', token: USDC, decimals: 6, poolId: 4512, feeBps: 30, spot: { num: '261368' + '0'.repeat(24), den: '977325000000' } },
    { id: 'trade-rhea', symbol: 'RHEA', token: RHEA, decimals: 18, poolId: 6458, feeBps: 30, spot: null },
    { id: 'trade-zec', symbol: 'ZEC', token: ZEC, decimals: 8, poolId: 6065, feeBps: 0, spot: null }],
  bounds: { schedule: { amountNear: ['0.10', '0.24'], budgetNear: ['0.20', '1.60'], intervalSec: [3600, 14400, 28800, 43200, 86400], runs: [1, 16], dateMaxMs: Date.now() + 6 * 86_400_000 },
    dca: { orderNear: ['0.10', '0.24'], levels: [1, 8], maxStepBps: [3000, 3000, 2450, 1650, 1200, 900, 650, 500], tpBps: [150, 5000], slBps: [100, 9000], planMaxNear: '1.60' } },
  defaults: { schedule: { pair: 'trade-usdc', amountNear: '0.10', budgetNear: '0.20', intervalSec: 3600, end: { kind: 'budget' } },
    dca: { pair: 'trade-usdc', baseNear: '0.10', orderNear: '0.10', levels: 3, stepBps: 100, tpBps: 150, slBps: 0 } },
};

// The screen with slot-backed hooks and a scripted session, as web/test/ui-audit-evidence.test.ts mounts it; react-dom stays external for the popup.
async function mount(model: 'degen' | 'schedule' | 'dca', trade: TradeOptions | null) {
  const { build } = require('esbuild') as typeof import('esbuild');
  const slots: unknown[] = [], effects: (() => void | (() => void))[] = [], routes: string[] = [], hires: unknown[][] = [], calls: string[] = [];
  let cursor = 0, first = true;
  const session = { state: { account: 'owner.near' as string | null, busy: false, logoutPending: false, message: '', jobs: [], lastPollMs: 0,
    options: trade === null ? null : { liveEnabled: true, gridV1: true, lpV1: true, minDeposit: '1', maxDeposit: '2', lp: null, trade } },
    login: async () => {}, refresh: async () => {}, mountJob: () => () => {}, prepareHire: async (...a: unknown[]) => { hires.push(a); return 'job-id'; } };
  const hooks = { ...React,
    useState(initial: unknown) {
      const index = cursor++;
      if (first) slots[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
      return [slots[index], (value: unknown) => { slots[index] = typeof value === 'function' ? (value as (v: unknown) => unknown)(slots[index]) : value; }];
    },
    useRef(initial: unknown) { const index = cursor++; if (first) slots[index] = { current: initial }; return slots[index]; },
    useEffect(effect: () => void | (() => void)) { if (first) effects.push(effect); },
  };
  Object.defineProperty(globalThis, '__tradeUi', { configurable: true, value: { hooks, session, api: async (path: string) => { calls.push(path); throw new Error('Not found.'); } } });
  const result = await build({ entryPoints: ['web/components/near/NearTradeDeployScreen.tsx'], bundle: true, write: false, format: 'esm', platform: 'node', tsconfig: 'web/tsconfig.json', logLevel: 'silent', plugins: [{ name: 'trade-ui', setup(b) {
    b.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, args => args.path === 'react' && args.importer.endsWith('NearTradeDeployScreen.tsx')
      ? { path: 'hooks', namespace: 'tu' } : { path: pathToFileURL(require.resolve(args.path)).href, external: true });
    b.onResolve({ filter: /^@\/lib\/near-(session|wallet)$/ }, args => ({ path: args.path.endsWith('session') ? 'session' : 'api', namespace: 'tu' }));
    b.onLoad({ filter: /.*/, namespace: 'tu' }, args => ({ contents: args.path === 'hooks' ? 'export default globalThis.__tradeUi.hooks;'
      : args.path === 'session' ? 'export const useNearSession = () => globalThis.__tradeUi.session;'
        : 'export const api = (...a) => globalThis.__tradeUi.api(...a); export const sign = () => {}; export const sendCall = () => {}; export const clearSelectedWallet = () => {}; export const transferWallet = () => {};' }));
  } }] });
  const module = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0]!.text + `\n// ${Math.random()}`).toString('base64')) as Record<string, (props: object) => ReactElement>;
  const render = () => { cursor = 0; const tree = module.NearTradeDeployScreen!({ go: (route: string) => routes.push(route), model }); first = false; return tree; };
  render();
  effects.forEach(effect => effect());
  for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve));
  return { render, routes, hires, calls, session, cleanup: () => Reflect.deleteProperty(globalThis, '__tradeUi') };
}
function all(tree: ReactNode, predicate: (node: Node) => boolean, found: Node[] = []): Node[] {
  for (const child of React.Children.toArray(tree)) {
    if (!React.isValidElement<Record<string, unknown>>(child)) continue;
    if (predicate(child)) found.push(child);
    all(child.props.children as ReactNode, predicate, found);
  }
  return found;
}
const text = (node: Node): string => React.Children.toArray(node.props.children as ReactNode).map(c => typeof c === 'string' ? c : React.isValidElement<Record<string, unknown>>(c) ? text(c) : '').join('');
const cards = (tree: ReactNode) => all(tree, n => n.type === 'button' && typeof n.props.style === 'object' && (n.props.style as { textAlign?: string }).textAlign === 'left').map(text);
const groupSet = (tree: ReactNode) => all(tree, n => 'section' in n.props && 'set' in n.props)[0]!.props.set as (k: string, v: unknown) => void;
const submit = async (tree: ReactNode) => { const form = all(tree, n => n.type === 'form')[0]!; await (form.props.onSubmit as (e: object) => unknown)({ preventDefault() {} }); };

const tiles = (tree: ReactNode) => all(tree, n => n.type === 'button' && typeof n.props.style === 'object' && (n.props.style as { textAlign?: string }).textAlign === 'center');

test('15.11 one row of models: Degen (paper mode), Schedule buy and Auto DCA (real funds), Smart Portfolio coming soon', async t => {
  const on = await mount('degen', OPTIONS); t.after(on.cleanup);
  assert.deepEqual(tiles(on.render()).map(text), ['Degen', 'Schedule buy', 'Auto DCA', 'Smart Portfolio']);
  const degen = renderToStaticMarkup(on.render());
  assert.match(degen, />Paper</); assert.match(degen, /Create the paper agent/);
  assert.equal((degen.match(/>Mainnet</g) ?? []).length, 2, 'each live model has the Mainnet tag');
  assert.match(degen, /Coming soon/);
  for (const tile of tiles(on.render())) (tile.props.onClick as () => void)();
  assert.deepEqual(on.routes, ['/deploy/trade/schedule', '/deploy/trade/dca'], 'Degen is already selected and Smart Portfolio is not clickable');
  assert.equal(tiles(on.render())[3]!.props.disabled, true);
  on.cleanup();
  const off = await mount('degen', { ...OPTIONS, enabled: false }); t.after(off.cleanup);
  assert.deepEqual(tiles(off.render()).map(text), ['Degen', 'Smart Portfolio'], 'no live model on /deploy/trade while the server disables them');
  off.cleanup();
  // A visitor (no server options yet) sees every model and every venue, as Grid V2 does.
  const visitor = await mount('degen', null); t.after(visitor.cleanup);
  assert.deepEqual(tiles(visitor.render()).map(text), ['Degen', 'Schedule buy', 'Auto DCA', 'Smart Portfolio']);
  const venues = renderToStaticMarkup(visitor.render());
  for (const venue of ['Rhea', 'OutLayer', 'meme.cooking', 'NEAR AI']) assert.ok(venues.includes(`<span>${venue}</span>`), venue);
  visitor.cleanup();
  for (const model of ['schedule', 'dca'] as const) {
    const f = await mount(model, OPTIONS);
    const row = tiles(f.render());
    assert.deepEqual(row.map(text), ['Degen', 'Schedule buy', 'Auto DCA', 'Smart Portfolio']);
    assert.deepEqual(row.filter(n => (n.props.style as { border?: string }).border === '1px solid var(--cat-yield)').map(text), [model === 'schedule' ? 'Schedule buy' : 'Auto DCA']);
    const html = renderToStaticMarkup(f.render());
    assert.match(html, model === 'schedule' ? /Amount per buy/ : /Max DCA orders/);
    assert.doesNotMatch(html, /Create the paper agent/);
    f.cleanup();
  }
  const disabled = await mount('schedule', { ...OPTIONS, enabled: false }); t.after(disabled.cleanup);
  assert.match(renderToStaticMarkup(disabled.render()), new RegExp(TRADE_DISABLED.replace(/\./g, '\\.')));
  await submit(disabled.render()); assert.equal(disabled.hires.length, 0);
});

test('15.11 the router passes the model and the marketplace cards route to it', () => {
  const kit = readFileSync('web/components/KitApp.tsx', 'utf8');
  for (const route of ['/deploy/trade/schedule', '/deploy/trade/dca']) assert.ok(kit.includes(`"${route}"`), route);
  const card = (id: string) => AGENTS.find(a => a.id === id)!;
  assert.equal(card('recurring-buy').disabled, undefined); assert.equal(card('auto-dca').disabled, undefined);
  assert.equal(agentDeployKind(card('recurring-buy')), 'trade/schedule'); assert.equal(agentDeployKind(card('auto-dca')), 'trade/dca');
  assert.equal(agentDeployKind(card('ai-token-trader')), 'trading'); assert.equal(agentDeployKind(card('grid-keeper')), 'grid');
});

test('15.11 each form validates against the bounds in TradeOptions and the hire body goes through prepareHire, never /api/meme', async t => {
  const now = Date.now();
  const sched = (patch: Record<string, unknown>, o = OPTIONS) => liveHire('schedule', { amountNear: '0.10', budgetNear: '0.20', intervalSec: '3600', endRule: 'budget', runs: '2', date: '', ...patch }, o, now);
  const dca = (patch: Record<string, unknown>, o = OPTIONS) => liveHire('dca', { baseNear: '0.10', orderNear: '0.10', levels: '3', stepPct: '1', tpPct: '1.5', slOn: false, slPct: '10', ...patch }, o, now);
  assert.deepEqual(sched({}), { settings: { amountNear: '0.10', intervalSec: 3600, budgetNear: '0.20', end: { kind: 'budget' } }, plan: BigInt(near('0.2')) });
  assert.match(String(sched({ amountNear: '0.09' })), /0\.10 to 0\.24 NEAR per buy/); assert.match(String(sched({ amountNear: '0.25' })), /per buy/);
  assert.match(String(sched({ amountNear: '0.105' })), /per buy/, 'at most two fraction digits');
  assert.match(String(sched({ budgetNear: '1.61' })), /total budget/); assert.match(String(sched({ amountNear: '0.24', budgetNear: '0.23' })), /total budget/);
  assert.match(String(sched({ intervalSec: '1800' })), /frequency/);
  assert.match(String(sched({ endRule: 'runs', runs: '17' })), /1 to 16 buys/);
  assert.deepEqual((sched({ endRule: 'runs', runs: '16' }) as { settings: { end: object } }).settings.end, { kind: 'runs', runs: 16 });
  assert.match(String(sched({ endRule: 'date', date: new Date(now + 1_000).toISOString() })), /end date/);
  assert.equal((sched({ endRule: 'date', date: new Date(now + 2 * 3_600_000).toISOString() }) as { settings: { end: { kind: string } } }).settings.end.kind, 'date');
  const narrow = { ...OPTIONS, bounds: { ...OPTIONS.bounds, schedule: { ...OPTIONS.bounds.schedule, amountNear: ['0.12', '0.20'] as [string, string] } } };
  assert.match(String(sched({}, narrow)), /0\.12 to 0\.20 NEAR per buy/, 'the bounds come from the server options');
  assert.deepEqual(dca({ slOn: true, slPct: '15' }), { settings: { baseNear: '0.10', orderNear: '0.10', levels: 3, stepBps: 100, tpBps: 150, slBps: 1500 }, plan: BigInt(near('0.4')) });
  assert.match(String(dca({ levels: '4', stepPct: '17' })), /0\.5 to 16\.5 %/, 'the step maximum follows maxStepBps(N)');
  assert.equal(typeof dca({ levels: '4', stepPct: '16.5' }), 'object');
  assert.match(String(dca({ stepPct: '1.25' })), /steps of 0\.5 %/); assert.match(String(dca({ tpPct: '1.4' })), /take profit/); assert.match(String(dca({ tpPct: '1.55' })), /take profit/);
  assert.match(String(dca({ slOn: true, slPct: '91' })), /stop loss/); assert.match(String(dca({ levels: '9' })), /1 to 8 DCA orders/);
  assert.match(String(dca({ baseNear: '0.24', orderNear: '0.24', levels: '6', stepPct: '9' })), /at most 1\.60 NEAR/);
  for (const model of ['schedule', 'dca'] as const) {
    const f = await mount(model, OPTIONS); t.after(f.cleanup);
    await submit(f.render());
    assert.equal(f.hires.length, 1);
    const [kind, deposit, lp, grid, name, trade] = f.hires[0]!;
    assert.deepEqual([kind, deposit, lp, grid, name], [model, model === 'schedule' ? '0.6' : '0.8', undefined, undefined, model === 'schedule' ? 'Schedule buy 01' : 'Auto DCA 01']);
    assert.deepEqual(trade, model === 'schedule' ? { pair: 'trade-usdc', settings: { amountNear: '0.10', intervalSec: 3600, budgetNear: '0.20', end: { kind: 'budget' } } }
      : { pair: 'trade-usdc', settings: { baseNear: '0.10', orderNear: '0.10', levels: 3, stepBps: 100, tpBps: 150, slBps: 0 } });
    assert.deepEqual(f.calls, ['/api/meme/options'], 'a live card never calls /api/meme');
    groupSet(f.render())('pair', 'trade-rhea');
    const html = renderToStaticMarkup(f.render());
    assert.doesNotMatch(html, /NEAR is the unit/, 'the USDC note is only on the USDC option');
    f.cleanup();
  }
  // The body prepareHire sends for a trade hire.
  const bodies: unknown[] = [];
  const actions = createNearActions({ api: (async (path: string, body?: object) => { if (path === '/api/me') return { accountId: 'owner.near' }; if (path === '/api/jobs' && body) { bodies.push(body); return { id: 'j' }; } return path === '/api/jobs' ? [] : OPTIONS; }) as typeof api,
    sign: async () => ({ accountId: 'owner.near', publicKey: 'x', signature: 'x', nonce: 'x' }), sendCall: async () => {}, clearWallet: () => {}, now: () => 0, changed: () => {} });
  await actions.mount();
  const settings = { baseNear: '0.10', orderNear: '0.10', levels: 1, stepBps: 100, tpBps: 150, slBps: 0 };
  assert.equal(await actions.prepareHire('dca', '0.6', undefined, undefined, ' Auto DCA 01 ', { pair: 'trade-rhea', settings }), 'j');
  assert.deepEqual(bodies, [{ kind: 'dca', pair: 'trade-rhea', mode: 'live', depositYocto: near('0.6'), trade: settings, name: 'Auto DCA 01' }]);
});

test('15.11 the USDC note, the DCA note and the hire text: no promise of an end at the latest, and the no-sale take profit ends named', async t => {
  const f = await mount('dca', OPTIONS); t.after(f.cleanup);
  const html = renderToStaticMarkup(f.render());
  assert.ok(html.includes(USDC_NOTE)); assert.ok(html.includes(DCA_NOTE.replace(/&/g, '&amp;')));
  const dca = hireText('dca').join(' '), schedule = hireText('schedule').join(' ');
  assert.doesNotMatch(dca + schedule, /at the latest/i);
  for (const part of [/too large for one sale/, /exceed the signed daily limit/, /holds less than the agent bought/, /ends without selling and returns the token/, /Stop loss does not sell/,
    /0\.4 NEAR reserve, which pays gas and comes back minus gas/, /key custody only/, /watchdog only alerts/, /NEAR plus the token/, /You choose these settings; the policy is signed/,
    /planned operating duration is 6 days/, /keep the funds in the agent wallet longer/, /RHEA and ZEC swaps have not been run/, /ZEC pool charges no fee/]) assert.match(dca, part);
  assert.doesNotMatch(schedule, /Take profit/);
  assert.equal(html.includes(EM_DASH), false);
});

function tradeJob(trade: Partial<TradeView> = {}, over: Partial<Job> = {}): Job {
  const view: TradeView = {
    strategy: 'dca', pair: { id: 'trade-rhea', symbol: 'RHEA', token: RHEA, decimals: 18, poolId: 6458, feeBps: 30 },
    settings: { v: 1, strategy: 'dca', base: near('0.1'), order: near('0.1'), levels: 3, stepBps: 100, tpBps: 150, slBps: 1000 }, endsAt: 1_900_000_000_000,
    ledger: { spent: near('0.1'), bought: '9792988176548991243', sold: '0', proceeds: '0', gasBuy: near('0.002640'), gasSell: '0', wnear: near('0.1') },
    avgCost: { num: near('0.1'), den: '9792988176548991243' }, spot: { num: '112376915111888666470198909136', den: '11038192113637089006712523' },
    value: near('0.0993'), walletValue: near('0.0993'), pnl: '-' + near('0.0033'),
    schedule: null,
    dca: { p0: { num: near('0.1'), den: '9792988176548991243' }, levels: [
      { k: 1, price: { num: '990000000000000000000000000', den: '97929881765489912430000' }, need: '9891907249039384084', state: 'filled' },
      { k: 2, price: { num: '4890000000000000000000000000', den: '489649408827449562150000' }, need: '10013280349232102500', state: 'skipped' },
      { k: 3, price: null, need: null, state: 'armed' }], tpLine: near('0.106384'), slLine: near('0.091'), protect: null },
    buys: [
      { opId: 'b', kind: 'swap', side: 'buy', amount: near('0.1'), verdict: 'refunded', used: '0', out: null, nativeIn: null, txHash: 'tx-refund', message: null, at: 3 },
      { opId: 'c', kind: 'swap', side: 'buy', amount: near('0.1'), verdict: 'unclear', used: null, out: null, nativeIn: null, txHash: null, message: 'Finalized transaction evidence and wallet holdings do not agree.', at: 2 },
      { opId: 'a', kind: 'wrap', side: 'buy', amount: near('0.1'), verdict: 'success', used: null, out: null, nativeIn: null, txHash: 'tx-wrap', message: null, at: 1 }],
    done: null, ...trade,
  };
  return { id: '78bae146-0000-4000-8000-000000000009', owner: 'owner.near', kind: view.strategy, state: 'running', reason: null, depositYocto: near('1'), agentAccount: 'a'.repeat(64),
    walletPubkey: 'ed25519:x', agentBalance: near('0.5'), ownerBalance: near('3'), payload: null, canReveal: true, linkDelivered: true, linkConfirmed: true, canFund: false, frozen: false,
    canStopEarly: true, grid: null, lp: null, pendingSubmission: null, holdings: { tokens: { [WNEAR]: near('0.1'), [RHEA]: '9792988176548991243' }, block: 9 }, extraTokens: [],
    operations: [], alerts: [], waitingForChain: false, blindHalt: false, canResumeBlind: false, resumeBlockedReason: null, trade: view, ...over };
}

test('15.11 the detail renders a refunded buy, a skipped level and the order history; it renders before the policy, before the first tick and with unreadable settings', () => {
  const job = tradeJob();
  const html = renderToStaticMarkup(React.createElement(NearTradeDetail, { job }));
  const log = renderToStaticMarkup(React.createElement(NearTradeDetail, { job, tab: 'Order history' }));
  assert.ok(log.includes(REFUND_TEXT)); assert.match(log, /data-verdict="refunded"[^>]*border:1px solid var\(--warning\)/); assert.match(log, /data-verdict="unclear"[^>]*var\(--loss\)/);
  assert.match(html, /<span>skipped<\/span>/); assert.match(html, /<span>filled<\/span>/);
  assert.match(html, /-0\.003300 NEAR/);
  assert.match(html, /NEAR per RHEA/); assert.doesNotMatch(html, /USDC per NEAR/);
  assert.equal(html.includes(EM_DASH), false);
  // Merge with master: the agent page's funds cards and Details tab name the trade token and no DCL registration; a halted trade job's Check and resume is disabled.
  const rowsOf = all(FundsCards({ job }), n => typeof n.props.symbol === 'string' && 'amount' in n.props).map(n => [n.props.symbol, n.props.amount]);
  assert.deepEqual(rowsOf.slice(0, 3), [['NEAR', '0.500000'], ['wNEAR', '0.100000'], ['RHEA', '9.792988176548991243']]);
  assert.equal(all(JobDetails({ job }), n => n.props.label === 'DCL registration').length, 0);
  const halted = { ...job, state: 'halted', resumeBlockedReason: 'This halt requires review. Check the job alerts or use Stop and withdraw.' };
  assert.deepEqual([resumeLabel(halted), canRequestResume(halted)], ['Check and resume', false]);
  const before = tradeJob({ endsAt: null, strategy: 'schedule', settings: { v: 1, strategy: 'schedule', amount: near('0.1'), intervalSec: 3600, budget: near('0.2'), end: { kind: 'budget' } },
    ledger: { spent: '0', bought: '0', sold: '0', proceeds: '0', gasBuy: '0', gasSell: '0', wnear: '0' }, avgCost: null, value: null, walletValue: null, pnl: null, dca: null, buys: [],
    schedule: { anchor: null, currentSlot: null, currentSlotTaken: false, fills: 0, postponed: 0, nextDueAt: null, remaining: near('0.2') } }, { state: 'link_confirmed', holdings: null });
  const draft = renderToStaticMarkup(React.createElement(NearTradeDetail, { job: before }));
  assert.match(draft, /Planned end: 6 days after hire \(the exact time is set when the policy is prepared\)\./);
  assert.match(draft, /0 of 2/); assert.match(draft, /No buy yet\./);
  const invalid = renderToStaticMarkup(React.createElement(NearTradeDetail, { job: tradeJob({ settings: 'invalid', dca: null, schedule: null }) }));
  assert.match(invalid, /Trade settings are unreadable\. Stop and withdraw\./); assert.ok(invalid.includes(REFUND_TEXT), 'the journal still shows');
  assert.equal(renderToStaticMarkup(React.createElement(NearTradeDetail, { job: { ...job, trade: null } })), '');
});

test('15.11 formatting and the account row: tokenAmount for 18 and 8 decimals, RHEA / wNEAR, and an interrupted withdrawal counts only the token still held', () => {
  assert.equal(tokenAmount('19585976353097982486', 18), '19.585976353097982486');
  assert.equal(tokenAmount('76726', 8), '0.00076726'); assert.equal(tokenAmount('100000000', 8), '1'); assert.equal(tokenAmount('0', 18), '0');
  assert.equal(asset(RHEA, '19585976353097982486'), '19.585976353097982486 RHEA'); assert.equal(asset(ZEC, '76726'), '0.00076726 ZEC');
  assert.equal(asset(USDC, '56478'), '0.056478 USDC', 'USDC is unchanged');
  const job = tradeJob();
  assert.equal(catalogId(job), 'auto-dca'); assert.equal(catalogName(job), 'Auto DCA');
  assert.equal(catalogName({ ...job, kind: 'schedule' }), 'Schedule buy'); assert.equal(catalogId({ ...job, kind: 'schedule' }), 'recurring-buy');
  assert.match(rowPresentation(job).statusLine, /^Auto DCA · RHEA \/ wNEAR · Live · running$/);
  assert.equal(valuation(job).total, null, 'no USD figure for a trade job');
  const portfolio = toPortfolio([job], 'owner.near', 0);
  assert.equal(portfolio.agents.length, 1, 'the trade row is listed');
  assert.deepEqual([portfolio.wallets.length, portfolio.coverage.total.state], [0, 'empty'], 'and stays out of the USD totals, so no false incomplete warning');
  assert.equal(tradeNearTotal(job), (BigInt(near('0.5')) + BigInt(near('0.1')) + BigInt(near('0.0993'))).toString());
  // The token transfer to the owner went out; the native sweep waits. The ledger and value stay as the strategy recorded them.
  const exiting = tradeJob({ walletValue: '0' }, { state: 'stopping', holdings: { tokens: { [WNEAR]: '0', [RHEA]: '0' }, block: 10 } });
  assert.equal(tradeNearTotal(exiting), near('0.5')); assert.equal(tradeRowValue(exiting), fmt(near('0.5')));
  assert.equal(exiting.trade!.ledger.bought, job.trade!.ledger.bought); assert.equal(exiting.trade!.value, job.trade!.value);
  assert.equal(tradeRowValue(tradeJob({ walletValue: null })), '-');
});

test('15.11 no em dash in the new copy', () => {
  for (const file of ['web/components/near/NearTradeDeployScreen.tsx', 'web/components/near/NearTradeDetail.tsx']) assert.equal(readFileSync(file, 'utf8').includes(EM_DASH), false, file);
});
