// Spec UI step 3, test 4: the popup's action panels, Cancel hire, the reset panel and the deployed redirect.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { ReactElement, ReactNode } from 'react';
import type { Job } from '@/lib/near-format';
import type { PendingTransfer } from '@/lib/hire-run';

const require = createRequire(process.cwd() + '/package.json');
const React = require('react') as typeof import('react');
const { renderToStaticMarkup } = require('react-dom/server') as typeof import('react-dom/server');
type Node = ReactElement<Record<string, unknown>>;

const N = 10n ** 24n, AGENT = 'a'.repeat(64);
const dcl = (over: Partial<NonNullable<Job['grid']>> = {}): NonNullable<Job['grid']> => ({ available: true, enabled: true, issued: false, registered: true, canRegister: false,
  point: 1, anchor: null, internal: {}, lost: {}, positions: 0, lanes: [], orders: [], ...over });
const base = (over: Partial<Job> = {}): Job => ({
  id: '78bae146-0000-4000-8000-000000000001', owner: 'owner.near', kind: 'grid', state: 'link_confirmed', reason: null,
  depositYocto: N.toString(), agentAccount: AGENT, walletPubkey: 'ed25519:fake', agentBalance: '0', ownerBalance: (5n * N).toString(),
  payload: null, canReveal: true, linkDelivered: true, linkConfirmed: true, canFund: true, frozen: false, canStopEarly: false, waitingForChain: false, blindHalt: false, canResumeBlind: false, resumeBlockedReason: null,
  grid: dcl(), lp: null, pendingSubmission: null, holdings: null, extraTokens: [], operations: [], alerts: [], ...over,
});
const policy = { caller: 'owner.near', receiverId: 'outlayer.near', methodName: 'store_wallet_policy', args: {}, gas: '1', deposit: '0' };

async function mount(job: Job, local: { link?: string; saved?: boolean; transfer?: PendingTransfer | null; busy?: boolean; ownMount?: boolean } = {}) {
  const effects: (() => void | (() => void))[] = [];
  const slots: unknown[] = []; let cursor = 0, first = true;
  const hooks = { ...React,
    useState: (initial: unknown) => { const i = cursor++; if (first) slots[i] = initial; return [slots[i], (v: unknown) => { slots[i] = v; }]; },
    useEffect: (fn: () => void | (() => void)) => { if (first) effects.push(fn); } };
  const mounts: string[] = [];
  const calls: string[] = [];
  const action = (name: string) => () => { calls.push(name); return Promise.resolve(); };
  const session = {
    state: { account: 'owner.near', jobs: [job], busy: local.busy ?? false, message: '' },
    mountJob: (id: string) => { mounts.push(id); return () => {}; }, transfer: () => local.transfer ?? null, link: () => local.link, isSaved: () => local.saved ?? false, sentPolicy: new Set<string>(),
    storePolicy: action('storePolicy'), reveal: action('reveal'), confirmLink: action('confirmLink'), registerDcl: action('registerDcl'), fund: action('fund'),
    cancel: action('cancel'), setSaved: action('setSaved'), resetTransfer: action('resetTransfer'),
  };
  Object.defineProperty(globalThis, '__hirePopup', { configurable: true, value: { hooks, session } });
  const { build } = require('esbuild') as typeof import('esbuild');
  const result = await build({ entryPoints: ['web/components/near/NearHireRun.tsx'], bundle: true, write: false, format: 'esm', platform: 'node', tsconfig: 'web/tsconfig.json', logLevel: 'silent', plugins: [{ name: 'hire-popup', setup(b) {
    b.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, args => args.path === 'react' && args.importer.endsWith('NearHireRun.tsx')
      ? { path: 'hooks', namespace: 'hp' } : { path: pathToFileURL(require.resolve(args.path)).href, external: true });
    b.onResolve({ filter: /^@\/lib\/near-session$/ }, () => ({ path: 'session', namespace: 'hp' }));
    b.onResolve({ filter: /NearAccountScreen$/ }, () => ({ path: 'account', namespace: 'hp' }));
    b.onLoad({ filter: /.*/, namespace: 'hp' }, args => ({ contents: args.path === 'hooks' ? 'export default globalThis.__hirePopup.hooks;'
      : args.path === 'session' ? 'export const useNearSession = () => globalThis.__hirePopup.session;'
        : 'export const truncateAddress = a => a.length <= 12 ? a : a.slice(0, 6) + "..." + a.slice(-4);' }));
  } }] });
  const module = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0]!.text + `\n// ${Math.random()}`).toString('base64')) as Record<string, (p: object) => Node | null>;
  const routes: string[] = [];
  const render = () => { cursor = 0; const t = module.NearHireRun!({ jobId: job.id, go: (r: string) => { routes.push(r); }, onClose: () => {}, ownMount: local.ownMount ?? true })!; first = false; return t; };
  const tree = render();
  return { tree, render, calls, routes, effects, mounts, html: () => renderToStaticMarkup(React.createElement(React.Fragment, null, tree.props.children as ReactNode)) };
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
const button = (tree: Node, label: string) => find(tree.props.children as ReactNode, n => n.type === 'button' && n.props.children === label);

test('popup: each active step shows its panel and its button calls the matching session action', async () => {
  const cases: [Job, string, string, { link?: string; saved?: boolean }?][] = [
    [base({ state: 'policy_prepared', linkConfirmed: false, payload: policy, grid: dcl({ registered: false }) }), 'Confirm in your wallet', 'storePolicy'],
    [base({ state: 'armed', linkConfirmed: false, grid: dcl({ registered: false }) }), 'Reveal the link', 'reveal'],
    [base({ grid: dcl({ registered: false, canRegister: true }), canFund: false }), 'Confirm in your wallet', 'registerDcl'],
    [base(), 'Confirm in your wallet', 'fund'],
  ];
  for (const [job, label, call] of cases) {
    const f = await mount(job);
    assert.equal(f.tree.props.phase, 'running');
    const b = button(f.tree, label)!;
    assert.ok(b, call); (b.props.onClick as () => void)();
    assert.deepEqual(f.calls, [call]);
  }
  const fund = await mount(base({ agentBalance: (2n * N / 10n).toString() }));
  assert.match(fund.html(), /0\.800000 NEAR|0\.8 NEAR/); assert.match(fund.html(), /It is not editable here/); assert.match(fund.html(), /send it by hand/);
});

test('popup: the link panel has Copy, and Confirm stays disabled until the link is saved', async () => {
  const armed = base({ state: 'armed', linkConfirmed: false, grid: dcl({ registered: false }) });
  const unsaved = await mount(armed, { link: 'https://example.test/link' });
  assert.ok(button(unsaved.tree, 'Copy'));
  assert.equal(button(unsaved.tree, 'Confirm')!.props.disabled, true);
  const ready = await mount(armed, { link: 'https://example.test/link', saved: true });
  assert.equal(button(ready.tree, 'Confirm')!.props.disabled, false);
  const notDelivered = await mount({ ...armed, linkDelivered: false }, { link: 'https://example.test/link', saved: true });
  assert.equal(button(notDelivered.tree, 'Confirm')!.props.disabled, true);
});

test('popup: Cancel hire follows the job page rule and is hidden while a transfer is pending; the reset panel waits two minutes', async () => {
  const open = await mount(base({ grid: dcl({ registered: false, canRegister: true }), canFund: false }));
  assert.equal(typeof open.tree.props.onCancel, 'function');
  const stoppable = await mount(base({ canStopEarly: true }));
  assert.equal(stoppable.tree.props.onCancel, null);
  const fresh = { account: 'owner.near', jobId: base().id, amount: N.toString(), baseBalance: '0', at: Date.now() };
  const pending = await mount(base(), { transfer: fresh });
  assert.equal(pending.tree.props.onCancel, null);
  assert.equal(button(pending.tree, 'Confirm in your wallet'), undefined, 'no second fund button');
  assert.equal(button(pending.tree, 'I did not send it'), undefined, 'no reset before two minutes');
  assert.doesNotMatch(pending.html(), /send it by hand/);
  const old = await mount(base(), { transfer: { ...fresh, at: Date.now() - 121_000 } });
  assert.ok(button(old.tree, 'I did not send it'));
  const busy = await mount(base(), { transfer: { ...fresh, at: Date.now() - 121_000 }, busy: true });
  assert.equal(button(busy.tree, 'I did not send it'), undefined, 'no reset while a wallet call is in flight');
});

test('popup: a stopped job shows the reason, and a pending transfer adds the recovery warning; running deploys and navigates after the hold', async () => {
  const stopped = await mount(base({ state: 'cancelled', reason: null }), { transfer: { account: 'owner.near', jobId: base().id, amount: N.toString(), baseBalance: '0', at: 0 } });
  assert.equal(stopped.tree.props.phase, 'stopped');
  assert.match(stopped.html(), /recover it with the saved management link/);
  const done = await mount(base({ state: 'running' }));
  assert.equal(done.tree.props.phase, 'deployed');
  const timers: [() => void, number][] = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { setTimeout: (fn: () => void, ms: number) => { timers.push([fn, ms]); return 1; }, clearTimeout() {} } });
  try { for (const e of done.effects) e(); } finally { Reflect.deleteProperty(globalThis, 'window'); }
  const hold = timers.find(([, ms]) => ms === 1500)!;
  assert.ok(hold); hold[0]();
  assert.deepEqual(done.routes, ['/account/' + base().id]);
});

test('account page: no Deposit or Withdraw button (each NEAR agent is funded and withdrawn on its own page)', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile('web/components/near/NearAccountScreen.tsx', 'utf8');
  assert.doesNotMatch(source, />Deposit<|>Withdraw</);
});

test('popup: only the deploy page mounts the job; the job page popup reuses its mount', async () => {
  const deploy = await mount(base(), { ownMount: true });
  for (const e of deploy.effects) e();
  assert.deepEqual(deploy.mounts, [base().id]);
  const page = await mount(base(), { ownMount: false });
  for (const e of page.effects) e();
  assert.deepEqual(page.mounts, []);
});

test('popup: a failed copy of the link says so and logs nothing', async t => {
  const armed = base({ state: 'armed', linkConfirmed: false, grid: dcl({ registered: false }) });
  const f = await mount(armed, { link: 'https://example.test/link' });
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: () => Promise.reject(new Error('denied')) } } });
  t.after(() => { if (saved) Object.defineProperty(globalThis, 'navigator', saved); else Reflect.deleteProperty(globalThis, 'navigator'); });
  const logged: unknown[] = [], log = console.log, error = console.error;
  console.log = (...a: unknown[]) => { logged.push(a); }; console.error = (...a: unknown[]) => { logged.push(a); };
  try {
    (button(f.tree, 'Copy')!.props.onClick as () => void)();
    await new Promise(r => setImmediate(r));
  } finally { console.log = log; console.error = error; }
  const after = f.render();
  assert.match(renderToStaticMarkup(React.createElement(React.Fragment, null, after.props.children as ReactNode)), /Copy failed\. Select the link and copy it by hand\./);
  assert.deepEqual(logged, []);
});

test('popup: the link is hidden until the eye is pressed; a successful copy shows Copied and a toast', async t => {
  const armed = base({ state: 'armed', linkConfirmed: false, grid: dcl({ registered: false }) });
  const link = 'https://example.test/wallet?key=wk_secret123';
  const f = await mount(armed, { link });
  const html = (tree: Node) => renderToStaticMarkup(React.createElement(React.Fragment, null, tree.props.children as ReactNode));
  assert.doesNotMatch(html(f.tree), /wk_secret123/);
  assert.match(html(f.tree), /key=•{24}/);
  (find(f.tree.props.children as ReactNode, n => n.props['aria-label'] === 'Show link')!.props.onClick as () => void)();
  const shown = f.render();
  assert.match(html(shown), /wk_secret123/);
  assert.ok(find(shown.props.children as ReactNode, n => n.props['aria-label'] === 'Hide link'));
  const saved = ['navigator', 'window'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const);
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: () => Promise.resolve() } } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { setTimeout: () => 1, clearTimeout() {} } });
  t.after(() => { for (const [k, v] of saved) { if (v) Object.defineProperty(globalThis, k, v); else Reflect.deleteProperty(globalThis, k); } });
  (button(shown, 'Copy')!.props.onClick as () => void)();
  await new Promise(r => setImmediate(r));
  const after = f.render();
  assert.ok(button(after, 'Copied'));
  assert.match(html(after), /Link copied/);
});
