// ---------------------------------------------------------------------------------------------------------------------
// AUDIT 2026-11-12 (Retire, 15 live jobs, no hidden agents), probes for the UI mutation survivors.
// Each test PASSES on 2b09553 and fails on the named mutants. Standalone file: copy to web/test/retire-ui-probes.test.ts.
// ---------------------------------------------------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Job } from '@/lib/near-format';
import { hireRunSteps } from '@/lib/hire-run';
import { listedJob, retirable, rowPresentation } from '@/lib/near-map';

const N = 10n ** 24n, DUST = (N / 100n).toString();
type Dcl = NonNullable<Job['grid']>;
const dcl = (over: Partial<Dcl> = {}): Dcl => ({ available: true, enabled: true, issued: true, registered: true, canRegister: false,
  point: 1, anchor: null, internal: { 'wrap.near': '0' }, lost: {}, positions: 0, lanes: [], orders: [], ...over });
const base = (over: Partial<Job> = {}): Job => ({
  id: '78bae146-0000-4000-8000-000000000001', owner: 'owner.near', kind: 'grid', state: 'halted', reason: null,
  depositYocto: N.toString(), agentAccount: 'a'.repeat(64), walletPubkey: 'ed25519:x', agentBalance: DUST, ownerBalance: '0',
  payload: null, canReveal: true, linkDelivered: true, linkConfirmed: true, canFund: false, frozen: false, canStopEarly: false, waitingForChain: false, blindHalt: false, canResumeBlind: false, resumeBlockedReason: null,
  grid: dcl(), lp: null, pendingSubmission: 'ambiguous', holdings: { tokens: { 'wrap.near': '0', usdc: '0' }, block: 1 }, extraTokens: [], operations: [], alerts: [], ...over,
});

test('AUDIT U-1 (U06, U08a, U08b, U08c, U08d, U09, U10): Retire is offered only when the view shows no token and nothing in DCL', () => {
  assert.equal(retirable(base()), true, 'the dust-only baseline');
  assert.equal(retirable(base({ holdings: { tokens: { 'wrap.near': '0', usdc: '1' }, block: 1 } })), false, 'a job token');
  assert.equal(retirable(base({ grid: dcl({ available: false }) })), false, 'DCL could not be read');
  assert.equal(retirable(base({ grid: dcl({ internal: { 'wrap.near': '5' } }) })), false, 'a DCL internal balance');
  assert.equal(retirable(base({ grid: dcl({ lost: { 'wrap.near': '5' } }) })), false, 'a DCL lost-found amount');
  assert.equal(retirable(base({ grid: dcl({ positions: 1 }) })), false, 'a DCL position count');
  assert.equal(retirable(base({ grid: dcl({ orders: [{ id: '1', sell: 'a', buy: 'b', point: 1, remain: '0', bought: '0', unclaimed: '0' }] as Dcl['orders'] }) })), false, 'an open Grid order');
  const lp = { ...dcl(), ledger: null, rotations: 0, pending: null, range: null, position: { id: 'p', liquidity: '1', paidX: '0', paidY: '0', fees: null, estimate: null } } as unknown as NonNullable<Job['lp']>;
  assert.equal(retirable(base({ kind: 'lp', grid: null, lp })), false, 'an LP position');
  assert.equal(retirable(base({ kind: 'lp', grid: null, lp: { ...lp, position: null } })), true, 'an LP job with nothing left');
});

test('AUDIT U-2 (U11, U12, U12b): the terminal lists of the UI treat retired like stopped', () => {
  assert.equal(listedJob(base({ state: 'retired' })), false);
  // near-map TERMINAL: a frozen policy never relabels a terminal job as Frozen.
  assert.notEqual(rowPresentation(base({ state: 'retired', frozen: true })).statusLabel, 'Frozen');
  assert.equal(rowPresentation(base({ state: 'stopped', frozen: true })).statusLabel, 'Stopped');
  // hire-run STOPPED and TERMINAL: a retired job shows the stopped panel with the terminal sentence, as a stopped job does.
  const none = { policySent: false, linkShown: false, saved: false, transfer: null };
  const retired = hireRunSteps(base({ state: 'retired' }), none), stopped = hireRunSteps(base({ state: 'stopped' }), none);
  assert.ok(retired.stopped, 'a retired job is a stopped hire');
  assert.equal(retired.action, null);
  assert.equal(retired.stopped?.reason, stopped.stopped?.reason);
  assert.equal(retired.stopped?.reason, 'This hire stopped. Open the agent page for recovery.');
});

// near-wallet.ts bundled with a fake @hot-labs/near-connect (the loader of web/test/transfer-wallet.test.ts).
async function loadWallet() {
  const { build } = createRequire(import.meta.url)('esbuild') as typeof import('esbuild');
  const fake = 'export class NearConnector { constructor() {} wallet() { return Promise.reject(new Error("none")); } on() {} off() {} disconnect() { return Promise.resolve(); } }';
  const result = await build({ entryPoints: ['web/lib/near-wallet.ts'], bundle: true, write: false, format: 'esm', platform: 'node', tsconfig: 'web/tsconfig.json', logLevel: 'silent',
    plugins: [{ name: 'fake-connect', setup(b) {
      b.onResolve({ filter: /^@hot-labs\/near-connect$/ }, () => ({ path: 'fake', namespace: 'fake' }));
      b.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ contents: fake, loader: 'js' }));
    } }] });
  return await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0]!.text).toString('base64')) as typeof import('@/lib/near-wallet');
}

test('AUDIT U-3 (U13): api() throws a ServerError carrying the server message, and a plain Error for anything else', async t => {
  const w = await loadWallet(), saved = globalThis.fetch;
  t.after(() => { globalThis.fetch = saved; });
  const answer = (status: number, body: unknown) => { globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as typeof fetch; };
  const thrown = async () => { try { await w.api('/api/jobs/x/retire', {}); } catch (e) { return e as Error; } throw new Error('api() did not throw'); };
  answer(409, { data: null, error: { code: 'conflict', message: 'The job changed. Reload and try again.' } });
  let e = await thrown();
  assert.equal(e.constructor.name, 'ServerError');
  assert.ok(e instanceof Error);
  assert.equal(e.message, 'The job changed. Reload and try again.', 'the text is unchanged, so code that compares it keeps working');
  answer(404, { data: null, error: { code: 'not_found', message: 'Not found.' } });
  e = await thrown();
  assert.equal(e.message, 'Not found.');
  answer(500, { data: null });
  e = await thrown();
  assert.equal(e.constructor.name, 'Error');
  assert.equal(e.message, 'Request failed.');
  answer(200, { data: 7 });
  assert.equal(await w.api('/api/x'), 7);
});

test('AUDIT U-4 (U15, U16, U17, U19): the screens list every job once, gate Retire on retirable and a confirm, and offer no freeze on a retired job', () => {
  const account = readFileSync('web/components/near/NearAccountScreen.tsx', 'utf8'), job = readFileSync('web/components/near/NearJobScreen.tsx', 'utf8');
  // The main list and "Retired agents" are one predicate and its negation over the same array: every job is shown exactly once.
  assert.ok(account.includes('const jobs = actions.state.jobs.filter(listedJob);'));
  assert.ok(account.includes('const retired = actions.state.jobs.filter(job => !listedJob(job));'));
  assert.ok(account.includes('{retired.map(job => {'), 'the Retired tab lists every job outside the main list');
  assert.ok(account.includes('altList={retiredList}') && account.includes('value: "retired", label: "Retired"'), 'the Live / Retired switch');
  assert.equal(/hidden-jobs|hiddenJobs|hideJob|near-hidden-jobs/.test(account + job), false, 'no hide filter is left');
  assert.ok(job.includes('{retirable(job) && !transfer && <Button'), 'Retire is gated on retirable and on no pending funding transfer (audit L-4)');
  assert.ok(job.includes('onClick={() => { if (window.confirm(RETIRE_CONFIRM)) void actions.retire(job); }}'));
  assert.ok(job.includes("!['cancelled', 'failed', 'stopped', 'retired'].includes(job.state) && !actions.pendingFreeze.has(job.id)"));
});
