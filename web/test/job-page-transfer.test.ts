// Spec UI step 3, section 4 on the agent page: no manual funding line and no Cancel hire while a transfer is pending,
// the funding line alone (no wait line) when funding is open (audit M-1), and the stopped warning.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
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
const pending: PendingTransfer = { account: 'owner.near', jobId: base().id, amount: N.toString(), baseBalance: '0', at: 0 };

// Public agent page: `pub` replaces the page's public load state (the object whose status starts as 'loading'); with `apiCalls` the effects run once
// against stub browser globals and every public request path is recorded.
type Extra = { pub?: { status: string; job: Job | null; at: number }; apiCalls?: string[] };
async function screen(job: Job, transfer: PendingTransfer | null, state: Record<string, unknown> = {}, extra: Extra = {}) {
  let inPage = false;
  const isPublicLoad = (v: unknown) => !!v && typeof v === 'object' && (v as { status?: unknown }).status === 'loading' && 'job' in v;
  const hooks = { useState: (initial: unknown) => [isPublicLoad(initial) && extra.pub ? extra.pub : initial, () => {}], useMemo: (fn: () => unknown) => fn(),
    // Only the page's own effects run, never those of child components rendered later (a timer there would keep the process alive).
    useEffect: (fn: () => unknown) => { if (extra.apiCalls && inPage) fn(); }, useRef: (v: unknown) => ({ current: v }), useCallback: (fn: unknown) => fn };
  const session = {
    state: { mounted: true, account: 'owner.near', jobs: [job], lastPollMs: 1, message: '', busy: false, ...state },
    mountJob: () => () => {}, link: () => undefined, isSaved: () => false, transfer: () => transfer, sentPolicy: new Set<string>(), pendingFreeze: new Map<string, boolean>(),
  };
  Object.defineProperty(globalThis, '__jobPage', { configurable: true, value: { hooks, session, apiCalls: extra.apiCalls ?? [] } });
  const { build } = require('esbuild') as typeof import('esbuild');
  const result = await build({ entryPoints: ['web/components/near/NearJobScreen.tsx'], bundle: true, write: false, format: 'esm', platform: 'node', tsconfig: 'web/tsconfig.json', logLevel: 'silent', plugins: [{ name: 'job-page', setup(b) {
    b.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, args => args.path === 'react' && args.importer.endsWith('NearJobScreen.tsx')
      ? { path: 'hooks', namespace: 'jp' } : { path: pathToFileURL(require.resolve(args.path)).href, external: true });
    b.onResolve({ filter: /^@\/lib\/near-session$/ }, () => ({ path: 'session', namespace: 'jp' }));
    b.onResolve({ filter: /^@\/lib\/near-wallet$/ }, () => ({ path: 'wallet', namespace: 'jp' }));
    b.onLoad({ filter: /.*/, namespace: 'jp' }, args => ({ contents: args.path === 'hooks'
      ? 'const h = globalThis.__jobPage.hooks; export default h; export const useState = h.useState; export const useMemo = h.useMemo; export const useEffect = h.useEffect; export const useRef = h.useRef; export const useCallback = h.useCallback;'
      : args.path === 'wallet' ? 'export const api = path => { globalThis.__jobPage.apiCalls.push(path); return new Promise(() => {}); };'
      : 'export const useNearSession = () => globalThis.__jobPage.session;' }));
  } }] });
  const module = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0]!.text + `\n// ${Math.random()}`).toString('base64')) as Record<string, (p: object) => Node>;
  const g = globalThis as Record<string, unknown>, saved = { document: g.document, window: g.window };
  if (extra.apiCalls) {
    g.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
    g.window = { setInterval: () => 0, clearInterval() {} };
  }
  try { inPage = true; return module.NearJobScreen!({ jobId: job.id, go: () => {} }); }
  finally { inPage = false; if (extra.apiCalls) for (const k of ['document', 'window'] as const) { if (saved[k] === undefined) delete g[k]; else g[k] = saved[k]; } }
}
function texts(tree: ReactNode, out: string[] = []): string[] {
  for (const child of React.Children.toArray(tree)) {
    if (typeof child === 'string') out.push(child);
    else if (React.isValidElement<Record<string, unknown>>(child)) texts(child.props.children as ReactNode, out);
  }
  return out;
}

test('agent page: funding open shows the manual line alone; a pending transfer hides it and Cancel hire', async () => {
  const open = texts(await screen(base(), null)).join('\n');
  assert.match(open, /Send screen, send 1\.000000 NEAR|Send screen, send 1 NEAR/);
  assert.doesNotMatch(open, /before sending NEAR/, 'no wait line next to the funding line (audit M-1)');
  assert.match(open, /Continue setup/);
  const busy = texts(await screen(base(), pending)).join('\n');
  assert.doesNotMatch(busy, /Send screen/);
  assert.doesNotMatch(busy, /Cancel hire/);
  assert.match(busy, /Transfer submitted\. Waiting for the finalized balance\./);
  assert.doesNotMatch(busy, /before sending NEAR/);
  const closed = texts(await screen(base({ canFund: false }), null)).join('\n');
  assert.match(closed, /before sending NEAR/);
  assert.match(closed, /Cancel hire/);
});

test('agent page after a reload: loading until the session, the first job list and the public answer arrive', async () => {
  const show = async (state: Record<string, unknown>, pub?: Extra['pub']) => renderToStaticMarkup(await screen(base(), null, state, { pub }));
  assert.match(await show({ mounted: false, account: null, jobs: [], lastPollMs: 0 }), /Loading agent/);
  assert.match(await show({ account: 'owner.near', jobs: [], lastPollMs: 0 }), /Loading agent/);
  assert.match(await show({ account: 'owner.near', jobs: [], lastPollMs: 1 }), /Loading agent/);
  assert.match(await show({ account: null, jobs: [], lastPollMs: 0 }), /Loading agent/);
  assert.match(await show({ account: 'owner.near', jobs: [], lastPollMs: 0, message: 'Job status is temporarily unavailable.' }, { status: 'error', job: null, at: 0 }), /Job status is temporarily unavailable\./);
  assert.doesNotMatch(await show({}), /Loading agent|Agent not found/);
});

const PUBLIC_JOB = base({ state: 'running', canReveal: false, linkDelivered: false, canFund: false, ownerBalance: null });
const OWNER_ONLY = /Freeze now|Unfreeze|Stop and withdraw|>Resume<|Check and resume|>Retire<|Cancel hire|Reveal management link|Continue setup|Store policy in wallet|Register agent on DCL|Owner balance|Your wallet|Keep at least 0\.1 NEAR|Session note for the owner/;

test('T-6 and T-7 a visitor sees the public view read-only, signed out or signed in as another account', async () => {
  for (const state of [{ account: null, jobs: [], lastPollMs: 0, message: 'Session note for the owner' }, { account: 'other.near', jobs: [], lastPollMs: 1, message: 'Session note for the owner' }]) {
    const markup = renderToStaticMarkup(await screen(PUBLIC_JOB, null, state, { pub: { status: 'ready', job: PUBLIC_JOB, at: 1 } }));
    assert.match(markup, /Read-only view\. Only the owner wallet can freeze, stop or resume this agent\./, String(state.account));
    assert.match(markup, />Read-only</, String(state.account));
    assert.match(markup, />Marketplace</);
    assert.doesNotMatch(markup, OWNER_ONLY, String(state.account));
    assert.doesNotMatch(markup, /My agents/);
  }
  // Audit L-1: a link-confirmed job in setup shows a visitor no owner-voiced funding or registration line.
  const setup = base({ state: 'link_confirmed', canFund: false, canReveal: false, linkDelivered: false, ownerBalance: null, grid: dcl({ issued: true, registered: false }) });
  const setupMarkup = renderToStaticMarkup(await screen(setup, null, { account: null, jobs: [], lastPollMs: 0 }, { pub: { status: 'ready', job: setup, at: 1 } }));
  assert.doesNotMatch(setupMarkup, /before sending NEAR|Registration was issued/);
  const ownerSetup = renderToStaticMarkup(await screen(base({ state: 'link_confirmed', canFund: false, grid: dcl({ issued: true, registered: false }) }), null));
  assert.match(ownerSetup, /before sending NEAR/);
  assert.match(ownerSetup, /Your wallet/);
});

test('T-8 a missing or unusable public answer shows not found, with a sign-in hint when signed out', async () => {
  const missing = { status: 'missing', job: null, at: 0 };
  const out = renderToStaticMarkup(await screen(base(), null, { account: null, jobs: [], lastPollMs: 0 }, { pub: missing }));
  assert.match(out, /Agent not found/);
  assert.match(out, /If this is your agent, sign in with the owner wallet\./);
  assert.doesNotMatch(out, /Back to Account/);
  const other = renderToStaticMarkup(await screen(base(), null, { account: 'other.near', jobs: [], lastPollMs: 1 }, { pub: missing }));
  assert.match(other, /Agent not found/);
  assert.match(other, /Back to Account/);
  assert.doesNotMatch(other, /sign in with the owner wallet/);
});

test('T-9 the owner keeps the actions, sees no read-only badge and makes no public request; a visitor makes one', async () => {
  const ownerCalls: string[] = [];
  const own = renderToStaticMarkup(await screen(base({ state: 'running', canFund: false }), null, {}, { apiCalls: ownerCalls }));
  assert.match(own, /Freeze now/);
  assert.match(own, /Stop and withdraw/);
  assert.doesNotMatch(own, /Read-only/);
  assert.deepEqual(ownerCalls, []);
  const visitorCalls: string[] = [];
  await screen(base(), null, { account: null, jobs: [], lastPollMs: 0 }, { apiCalls: visitorCalls });
  assert.deepEqual(visitorCalls, [`/api/public/jobs/${base().id}`]);
  const early: string[] = [];
  await screen(base(), null, { mounted: false, account: null, jobs: [], lastPollMs: 0 }, { apiCalls: early });
  assert.deepEqual(early, [], 'no public request before the session is known');
});

test('agent page: a stopped hire with a pending transfer shows the recovery warning', async () => {
  const stopped = texts(await screen(base({ state: 'cancelled', canFund: false }), pending)).join('\n');
  assert.match(stopped, /recover it with the saved management link/);
});

test('agent page displays read waits, blind resume eligibility and ordinary paused resume', async () => {
  const show = async (over: Partial<Job>) => texts(await screen(base({ canFund: false, ...over }), null)).join('\n');
  const waiting = await show({ state: 'running', waitingForChain: true });
  assert.match(waiting, /Waiting for verified chain data\. No new trades will be sent; checks retry automatically\./);
  assert.match(waiting, /Freeze now/);
  assert.match(waiting, /Stop and withdraw/);
  assert.doesNotMatch(waiting, /Check and resume/);
  const reason = 'Waiting for finalized DCL data. Checks retry automatically.';
  const blockedJob = base({ state: 'halted', blindHalt: true, resumeBlockedReason: reason, canFund: false,
    agentBalance: null, grid: dcl({ available: false, registered: false, issued: true, point: null }) });
  const blocked = renderToStaticMarkup(await screen(blockedJob, null));
  assert.match(blocked, /<button[^>]+disabled=""[^>]+aria-describedby="resume-note-[^"]+"[^>]*>Check and resume<\/button>/);
  assert.match(blocked, new RegExp(`id="resume-note-${blockedJob.id}"[^>]*>${reason}`));
  assert.match(blocked, /Order data unavailable/);
  assert.doesNotMatch(blocked, /0 orders on Rhea DCL|0\.000000|Registration was issued/);
  const eligible = await show({ state: 'halted', blindHalt: true, canResumeBlind: true });
  assert.match(eligible, /Check and resume/);
  assert.match(eligible, /worker repeats its safety checks/);
  const eligibleMarkup = renderToStaticMarkup(await screen(base({ state: 'halted', canResumeBlind: true }), null));
  assert.doesNotMatch(eligibleMarkup, /<button[^>]+disabled=""[^>]*>Check and resume/);
  assert.match(await show({ state: 'halted' }), /Check and resume/);
  assert.match(await show({ state: 'paused' }), /(?:^|\n)Resume(?:\n|$)/);
});

test('legacy job page keeps Check and resume visible and disabled until the server allows it', async () => {
  class Element {
    children: (Element | string)[] = [];
    readonly attrs = new Map<string, string>();
    textContent = '';
    value = '';
    disabled = false;
    onclick?: () => void;
    constructor(readonly tag = '') {}
    append(...children: (Element | string)[]) { this.children.push(...children); }
    replaceChildren() { this.children = []; }
    setAttribute(key: string, value: string) { this.attrs.set(key, value); }
    addEventListener() {}
    all(): Element[] { return [this, ...this.children.flatMap(c => typeof c === 'string' ? [] : c.all())]; }
  }
  const elements = new Map<string, Element>();
  const document = { getElementById(id: string) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; },
    createElement(tag: string) { return new Element(tag); } };
  const reason = 'Waiting for finalized DCL data.';
  const jobs = [base({ state: 'halted', canFund: false, blindHalt: true, resumeBlockedReason: reason,
    grid: dcl({ available: false, registered: false, issued: true, point: null }) }),
    base({ id: 'second-job', state: 'halted', canResumeBlind: true, canFund: false }),
    base({ id: 'paused-job', state: 'paused', canFund: false })];
  const requests: string[] = [];
  const { build } = require('esbuild') as typeof import('esbuild');
  const result = await build({ entryPoints: ['src/web/page/app.ts'], bundle: true, write: false, format: 'iife', logLevel: 'silent',
    plugins: [{ name: 'offline-legacy-wallet', setup(b) {
      b.onResolve({ filter: /^@hot-labs\/near-connect$/ }, () => ({ path: 'wallet', namespace: 'offline' }));
      b.onLoad({ filter: /.*/, namespace: 'offline' }, () => ({ contents: 'export class NearConnector {}' }));
    } }] });
  runInNewContext(result.outputFiles[0].text, { document, setInterval: () => {}, fetch: async (path: string) => {
    requests.push(path);
    const data = path === '/api/me' ? { accountId: jobs[0].owner } : path === '/api/jobs' ? jobs : { liveEnabled: true };
    return { ok: true, json: async () => ({ data }) };
  } });
  await new Promise<void>(resolve => setImmediate(resolve));
  const nodes = document.getElementById('jobs').all();
  const controls = nodes.filter(n => n.tag === 'button' && n.textContent === 'Check and resume');
  assert.equal(controls.length, 2);
  assert.equal(controls[0].disabled, true);
  assert.equal(controls[0].attrs.get('aria-describedby'), `resume-note-${jobs[0].id}`);
  assert.ok(nodes.some(n => n.textContent === reason));
  assert.equal(controls[1].disabled, false);
  assert.ok(nodes.some(n => n.tag === 'button' && n.textContent === 'Resume' && !n.disabled));
  assert.equal(nodes.some(n => /Registration was issued/.test(n.textContent)), false);
  controls[0].onclick?.();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(requests.some(path => path.includes('resume')), false);
});

test('agent page: a stopping job tells the owner to wait for the funds; a frozen or unresolved one does not', async () => {
  const wait = /Please wait a few minutes\. Your funds are on their way back to your wallet/;
  const stopping = base({ state: 'stopping', canFund: false, reason: 'A DCL order closed. Checking remaining orders and balances.' });
  assert.match(texts(await screen(stopping, null)).join('\n'), wait);
  const frozen = texts(await screen({ ...stopping, frozen: true }, null)).join('\n');
  assert.doesNotMatch(frozen, wait);
  assert.match(frozen, /Unfreeze to withdraw\./);
  assert.doesNotMatch(texts(await screen({ ...stopping, pendingSubmission: 'ambiguous' }, null)).join('\n'), wait);
  assert.doesNotMatch(texts(await screen(base({ state: 'stopped', canFund: false }), null)).join('\n'), wait);
});
