import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { applyLpPrefill, createNearActions, type HireOptions, type LpForm } from '@/lib/near-actions';
import { ServerError, type Job, type Payload } from '@/lib/near-format';
import type { api, sign, sendCall } from '@/lib/near-wallet';

const job: Job = {
  id: '78bae146-0000-4000-8000-000000000001', owner: 'owner.near', kind: 'grid', state: 'armed', reason: null,
  depositYocto: '1000000000000000000000000', agentAccount: 'agent.near', walletPubkey: 'ed25519:fake', agentBalance: '0', ownerBalance: '1000000000000000000000000',
  payload: { caller: 'owner.near', receiverId: 'outlayer.near', methodName: 'store_wallet_policy', args: {}, gas: '1', deposit: '0' },
  canReveal: true, linkDelivered: true, linkConfirmed: false, canFund: false, frozen: false, canStopEarly: false, waitingForChain: false, blindHalt: false, canResumeBlind: false, resumeBlockedReason: null,
  grid: null, lp: null, pendingSubmission: null, holdings: null, extraTokens: [], operations: [], alerts: [],
};
const payload: Payload = { caller: job.owner, receiverId: 'dclv2.ref-labs.near', methodName: 'storage_deposit', args: { account_id: job.agentAccount, registration_only: true }, gas: '50000000000000', deposit: '500000000000000000000000' };
const options: HireOptions = { liveEnabled: true, gridV1: true, lpV1: true, minDeposit: job.depositYocto, maxDeposit: '2000000000000000000000000', lp: { minDeposit: '1200000000000000000000000', maxDeposit: '3000000000000000000000000', point: 400000, ai: true } };
const lpForm: LpForm = { rangeMode: 'explicit', minPrice: ' 3.5 ', maxPrice: ' 4.5 ', ai: true, compound: true, minFeeBps: '100', stopLossPct: '5', takeProfitPct: '20' };
const signed = { accountId: job.owner, publicKey: 'fake', signature: 'fake', nonce: 'fake' };
const generic = 'The action could not be completed. Check your wallet and the job status.';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function fixture(over: { api?: (path: string, body?: object) => Promise<unknown>; sign?: typeof sign; sendCall?: typeof sendCall; clearWallet?: () => void } = {}) {
  let now = 10000, account = job.owner;
  const calls: string[] = [];
  const actions = createNearActions({
    api: (async (path: string, body?: object) => {
      calls.push(path);
      if (over.api) { const value = await over.api(path, body); if (value !== undefined) return value; }
      if (path === '/api/me' || path === '/api/login') return { accountId: account };
      if (path === '/api/hire/options') return options;
      if (path === '/api/jobs') return body ? { id: job.id } : [job];
      if (path.endsWith('/dcl-registration')) return payload;
      if (path.endsWith('/reveal')) return { link: 'https://example.test/fake-link' };
      return true;
    }) as typeof api,
    sign: over.sign ?? (async () => signed),
    sendCall: over.sendCall ?? (async () => { calls.push('sendCall'); }),
    clearWallet: over.clearWallet ?? (() => {}), now: () => now, changed: () => {},
  });
  await actions.mount();
  return { actions, calls, advance: () => { now += 15000; }, account: (value: string) => { account = value; } };
}

test('double invocation acquires the shared lock synchronously and runs once', async () => {
  const pending = deferred<Payload>();
  const { actions, calls } = await fixture({ api: async p => p.endsWith('/dcl-registration') ? pending.promise : undefined });
  const first = actions.registerDcl(job), second = actions.registerDcl(job);
  assert.equal(calls.filter(p => p.endsWith('/dcl-registration')).length, 1);
  pending.resolve(payload); await Promise.all([first, second]);
  assert.equal(calls.filter(p => p === 'sendCall').length, 1);
});

test('logout clears secrets immediately and discards a pending reveal', async () => {
  let pending: ReturnType<typeof deferred<{ link: string }>> | undefined;
  const { actions } = await fixture({ api: async p => p.endsWith('/reveal') ? pending?.promise : undefined });
  actions.mountJob(job.id); await actions.reveal(job);
  assert.ok(actions.link(job.id)); actions.setSaved(job.id, true); actions.sentPolicy.add(job.id); actions.pendingFreeze.set(job.id, true);
  pending = deferred(); const reveal = actions.reveal(job); await tick();
  const logout = actions.logout();
  assert.equal(actions.link(job.id), undefined); assert.equal(actions.isSaved(job.id), false); assert.equal(actions.sentPolicy.size, 0); assert.equal(actions.pendingFreeze.size, 0); assert.equal(actions.state.account, null);
  pending.resolve({ link: 'LATE SECRET' }); await Promise.all([reveal, logout]);
  assert.equal(actions.link(job.id), undefined); assert.equal(actions.state.message, '');
});

for (const returning of [false, true]) test(returning ? 'leaving and returning to the same job discards the old reveal' : 'unmount during reveal discards its answer', async () => {
  const pending = deferred<{ link: string }>();
  const { actions } = await fixture({ api: async p => p.endsWith('/reveal') ? pending.promise : undefined });
  const unmount = actions.mountJob(job.id); const reveal = actions.reveal(job); await tick();
  unmount(); if (returning) actions.mountJob(job.id);
  pending.resolve({ link: 'LATE SECRET' }); await reveal;
  assert.equal(actions.link(job.id), undefined);
});

test('logout during a DCL payload request prevents the wallet call and refuses queued login', async () => {
  const pending = deferred<Payload>(), logoutReply = deferred<boolean>(); let signs = 0;
  const { actions, calls } = await fixture({ api: async p => p.endsWith('/dcl-registration') ? pending.promise : p === '/api/logout' ? logoutReply.promise : undefined, sign: async () => { signs++; return signed; } });
  const registration = actions.registerDcl(job); const logout = actions.logout();
  await actions.login(); assert.equal(signs, 0); assert.equal(actions.state.logoutPending, true);
  pending.resolve(payload); await registration; await tick();
  assert.equal(calls.includes('sendCall'), false); assert.ok(calls.includes('/api/logout'));
  await actions.login(); assert.equal(signs, 0);
  logoutReply.resolve(true); await logout;
});

for (const changeAccount of [false, true]) test(changeAccount ? 'a jobs answer requested for the old account is discarded' : 'a jobs answer after logout is discarded', async () => {
  let pending: ReturnType<typeof deferred<Job[]>> | undefined;
  const { actions, advance, account } = await fixture({ api: async (p, body) => p === '/api/jobs' && !body ? pending?.promise : undefined });
  advance(); pending = deferred(); const old = actions.refresh(); const reply = pending;
  let changed: Promise<unknown>;
  if (changeAccount) { account('other.near'); changed = actions.mount(); await tick(); }
  else changed = actions.logout();
  pending = undefined; reply.resolve([{ ...job, reason: 'STALE SNAPSHOT' }]); await Promise.all([old, changed]);
  assert.equal(actions.state.jobs.some(j => j.reason === 'STALE SNAPSHOT'), false);
  assert.equal(actions.state.account, changeAccount ? 'other.near' : null);
});

test('post-action refresh waits for an existing poll then starts a new request', async () => {
  let pending: ReturnType<typeof deferred<Job[]>> | undefined;
  const { actions, calls, advance } = await fixture({ api: async (p, body) => p === '/api/jobs' && !body ? pending?.promise : undefined });
  advance(); pending = deferred(); const polling = actions.refresh();
  const action = actions.cancel(job); await tick();
  assert.equal(calls.filter(p => p === '/api/jobs').length, 2);
  const reply = pending; pending = undefined; reply.resolve([job]);
  await Promise.all([polling, action]); assert.equal(calls.filter(p => p === '/api/jobs').length, 3);
});

test('manual refreshes within fifteen seconds start only one jobs request', async () => {
  const { actions, calls, advance } = await fixture();
  advance(); await Promise.all([actions.refresh(), actions.refresh(), actions.refresh()]); await actions.refresh();
  assert.equal(calls.filter(p => p === '/api/jobs').length, 2);
});

test('wallet rejection shows only the generic error and does not mark policy sent', async () => {
  const { actions } = await fixture({ sendCall: async () => { throw new Error('wallet rejection with private detail'); } });
  await actions.storePolicy(job); assert.equal(actions.state.message, generic); assert.equal(actions.sentPolicy.has(job.id), false);
});

test('resume uses the latest eligibility, avoids a POST on wallet cancellation and still supports paused jobs', async () => {
  const halted = { ...job, state: 'halted', blindHalt: true, canResumeBlind: true };
  let current = halted, cancelled = true, signedCount = 0;
  let pendingPoll: ReturnType<typeof deferred<Job[]>> | undefined;
  let pendingSign: ReturnType<typeof deferred<typeof signed>> | undefined;
  const { actions, calls, advance } = await fixture({
    api: async (path, body) => path === '/api/jobs' && !body ? pendingPoll?.promise ?? [current] : undefined,
    sign: async (purpose, id) => {
      signedCount++;
      assert.equal(purpose, 'resume'); assert.equal(id, job.id);
      if (cancelled) throw new Error('Wallet cancelled.');
      return pendingSign?.promise ?? signed;
    },
  });
  const posts = () => calls.filter(path => path.endsWith('/resume')).length;
  await actions.resume({ ...halted, canResumeBlind: false, resumeBlockedReason: 'Waiting for verified reads.' });
  assert.equal(signedCount, 0);
  await actions.resume(halted);
  assert.equal(posts(), 0);
  cancelled = false;
  pendingPoll = deferred(); pendingSign = deferred();
  advance();
  const refresh = actions.refresh(), resume = actions.resume(halted);
  const pollReply = pendingPoll; pendingPoll = undefined;
  current = { ...halted, canResumeBlind: false };
  pollReply.resolve([current]); await refresh;
  pendingSign.resolve(signed); pendingSign = undefined;
  await resume;
  assert.equal(posts(), 0);
  current = { ...job, state: 'paused' };
  advance(); await actions.refresh(); await actions.resume(current);
  assert.equal(posts(), 1);
});

test('failed DCL and policy payload checks never call sendCall', async () => {
  const { actions, calls } = await fixture({ api: async p => p.endsWith('/dcl-registration') ? { ...payload, deposit: '0' } : undefined });
  await actions.registerDcl(job); await actions.storePolicy({ ...job, payload: { ...job.payload!, caller: 'other.near' } });
  assert.equal(calls.includes('sendCall'), false); assert.equal(actions.state.message, generic);
});

test('the link-saved box pauses polling and resets after Confirm', async () => {
  const { actions, calls, advance } = await fixture(); actions.mountJob(job.id);
  await actions.reveal(job); assert.ok(actions.link(job.id)); actions.setSaved(job.id, true);
  advance(); const before = calls.length; await actions.refresh(); assert.equal(calls.length, before);
  await actions.confirmLink(job); assert.equal(actions.isSaved(job.id), false); assert.equal(actions.link(job.id), undefined);
});

test('LP server range and compound on send the exact legacy hire body', async () => {
  let body: object | undefined;
  const { actions } = await fixture({ api: async (p, b) => { if (p === '/api/jobs' && b) body = b; } });
  assert.equal(await actions.prepareHire('lp', '1.2', { ...lpForm, rangeMode: 'server' }), job.id);
  assert.deepEqual(body, {
    kind: 'lp', pair: 'usdc-wnear', mode: 'live', depositYocto: '1200000000000000000000000',
    lp: { range: { mode: 'server' }, ai: true, compound: { on: true, minFeeBps: 100 }, stopLossPct: 5, takeProfitPct: 20 },
  });
});

test('LP explicit range trims prices and compound off omits minFeeBps', async () => {
  let body: object | undefined;
  const { actions } = await fixture({ api: async (p, b) => { if (p === '/api/jobs' && b) body = b; } });
  await actions.prepareHire('lp', '1.2', { ...lpForm, ai: false, compound: false, minFeeBps: 'unused', stopLossPct: '0', takeProfitPct: '0' });
  assert.deepEqual(body, {
    kind: 'lp', pair: 'usdc-wnear', mode: 'live', depositYocto: '1200000000000000000000000',
    lp: { range: { mode: 'explicit', minPrice: '3.5', maxPrice: '4.5' }, ai: false, compound: { on: false }, stopLossPct: 0, takeProfitPct: 0 },
  });
});

test('LP percentages and enabled compound fees require whole numbers and send nothing on failure', async () => {
  const { actions, calls } = await fixture();
  const before = calls.length;
  for (const field of ['minFeeBps', 'stopLossPct', 'takeProfitPct']) {
    for (const value of ['1.5', '-1', '1e2', '', ' 10 ']) {
      assert.equal(await actions.prepareHire('lp', '1.2', { ...lpForm, [field]: value }), undefined);
      assert.equal(actions.state.message, 'Enter whole numbers for LP percentages and fee basis points.');
    }
  }
  assert.equal(calls.length, before);
});

test('Grid hire body stays unchanged and has no lp key', async () => {
  let body: object | undefined;
  const { actions } = await fixture({ api: async (p, b) => { if (p === '/api/jobs' && b) body = b; } });
  await actions.prepareHire('grid', '1', lpForm);
  assert.deepEqual(body, { kind: 'grid', pair: 'usdc-wnear', mode: 'live', depositYocto: job.depositYocto });
});

test('Grid V2 hire body carries the preset and whole-number thresholds, never for LP', async () => {
  const bodies: object[] = [];
  const { actions } = await fixture({ api: async (p, b) => { if (p === '/api/jobs' && b) bodies.push(b); } });
  await actions.prepareHire('grid', '1', undefined, { preset: 'tight', orders: '2', stopLossPct: '5', takeProfitPct: '0' });
  assert.deepEqual(bodies[0], { kind: 'grid', pair: 'usdc-wnear', mode: 'live', depositYocto: job.depositYocto, grid: { preset: 'tight', orders: 2, stopLossPct: 5, takeProfitPct: 0 } });
  assert.equal(await actions.prepareHire('grid', '1', undefined, { preset: 'tight', orders: '3', stopLossPct: '5', takeProfitPct: '0' }), undefined);
  assert.equal(actions.state.message, 'Choose 2 or 4 orders.');
  assert.equal(await actions.prepareHire('grid', '1', undefined, { preset: 'wide', orders: '4', stopLossPct: '1.5', takeProfitPct: '0' }), undefined);
  assert.equal(actions.state.message, 'Enter whole numbers for LP percentages and fee basis points.');
  assert.equal(bodies.length, 1);
  await actions.prepareHire('lp', '1.2', lpForm, { preset: 'tight', orders: '4', stopLossPct: '5', takeProfitPct: '0' });
  assert.equal('grid' in bodies[1], false);
  await actions.prepareHire('grid', '1', undefined, undefined, '  Grid Agent 01 ');
  assert.equal((bodies[2] as { name?: string }).name, 'Grid Agent 01');
  await actions.prepareHire('grid', '1', undefined, undefined, '   ');
  assert.equal('name' in bodies[3], false);
});

test('double LP hire runs once and logout discards its late answer without refreshing', async () => {
  const pending = deferred<{ id: string }>();
  const { actions, calls } = await fixture({ api: async (p, b) => p === '/api/jobs' && b ? pending.promise : undefined });
  const first = actions.prepareHire('lp', '1.2', lpForm), second = actions.prepareHire('lp', '1.2', lpForm);
  assert.equal(calls.filter(p => p === '/api/jobs').length, 2);
  const logout = actions.logout(); pending.resolve({ id: job.id });
  assert.deepEqual(await Promise.all([first, second]), [undefined, undefined]); await logout;
  assert.equal(calls.filter(p => p === '/api/jobs').length, 2);
});

test('late LP options never overwrite edited minimum, maximum or AI fields', async () => {
  for (const field of ['minPrice', 'maxPrice', 'ai'] as const) {
    let signedIn = false;
    const pending = deferred<HireOptions>();
    const { actions } = await fixture({ api: async p => p === '/api/me' ? { accountId: signedIn ? job.owner : null } : p === '/api/hire/options' ? pending.promise : undefined });
    signedIn = true; const mount = actions.mount(); await tick();
    if (field === 'ai') actions.setLpField(field, false); else actions.setLpField(field, '3.1');
    const edited = actions.state.lpDraft;
    pending.resolve(options); await mount;
    assert.equal(actions.state.lpDraft.minPrice, field === 'minPrice' ? '3.1' : (1e18 / 1.0001 ** (400000 + 100)).toFixed(6));
    assert.equal(actions.state.lpDraft.maxPrice, field === 'maxPrice' ? '3.1' : (1e18 / 1.0001 ** (400000 - 100)).toFixed(6));
    assert.equal(actions.state.lpDraft.ai, field !== 'ai');
    assert.deepEqual(actions.state.lpDraft, applyLpPrefill(edited, options)); assert.deepEqual(edited.prefilled, {});
  }
});

test('LP prefill uses the legacy formulas once and ignores a second options answer', async () => {
  let reply = options;
  const { actions } = await fixture({ api: async p => p === '/api/hire/options' ? reply : undefined });
  const first = actions.state.lpDraft;
  assert.equal(first.minPrice, (1e18 / 1.0001 ** (400000 + 100)).toFixed(6));
  assert.equal(first.maxPrice, (1e18 / 1.0001 ** (400000 - 100)).toFixed(6));
  assert.equal(first.ai, true); assert.deepEqual(first.prefilled, { ai: true, minPrice: true, maxPrice: true });
  reply = { ...options, lp: { ...options.lp!, point: 401000, ai: false } }; await actions.mount();
  assert.deepEqual(actions.state.lpDraft, first);
  assert.deepEqual(first.prefilled, { ai: true, minPrice: true, maxPrice: true });
});

test('a null LP point keeps prices empty and a later mount request fills them', async () => {
  let reply: HireOptions = { ...options, lp: { ...options.lp!, point: null } };
  const { actions, calls } = await fixture({ api: async p => p === '/api/hire/options' ? reply : undefined });
  assert.equal(actions.state.lpDraft.minPrice, ''); assert.equal(actions.state.lpDraft.maxPrice, '');
  assert.deepEqual(actions.state.lpDraft.prefilled, { ai: true });
  reply = options; await actions.refreshLpOptions();
  assert.equal(actions.state.lpDraft.minPrice, (1e18 / 1.0001 ** (400000 + 100)).toFixed(6));
  assert.equal(actions.state.lpDraft.maxPrice, (1e18 / 1.0001 ** (400000 - 100)).toFixed(6));
  await actions.refreshLpOptions(); assert.equal(calls.filter(p => p === '/api/hire/options').length, 2);
});

test('LP draft survives leave and return and Grid use, then clears on account change and logout', async () => {
  const { actions, account } = await fixture();
  actions.setLpField('minPrice', '3.2'); actions.setLpField('maxPrice', '4.8'); actions.setLpField('ai', false);
  actions.setLpField('rangeMode', 'server'); actions.setLpField('compound', false); actions.setLpField('minFeeBps', '200');
  actions.setLpField('stopLossPct', '10'); actions.setLpField('takeProfitPct', '30');
  const draft = actions.state.lpDraft;
  const leave = actions.mountJob(job.id); leave(); actions.mountJob(job.id)();
  await actions.prepareHire('grid', '1');
  assert.deepEqual(actions.state.lpDraft, draft);
  account('other.near'); await actions.mount();
  assert.deepEqual(actions.state.lpDraft.edited, {}); assert.equal(actions.state.lpDraft.rangeMode, 'explicit');
  assert.equal(actions.state.lpDraft.minPrice, (1e18 / 1.0001 ** (400000 + 100)).toFixed(6)); assert.equal(actions.state.lpDraft.ai, true);
  await actions.logout();
  assert.deepEqual(actions.state.lpDraft, { rangeMode: 'explicit', minPrice: '', maxPrice: '', ai: false, compound: true, minFeeBps: '100', stopLossPct: '0', takeProfitPct: '0', edited: {}, prefilled: {} });
});

// Bundle the actual wallet functions against a fake connector, never its SDK.
async function walletFixture() {
  const require = createRequire(process.cwd() + '/package.json');
  const { build } = require('esbuild') as typeof import('esbuild');
  let opens = 0;
  const listeners = new Map<string, (event: { accounts: { signedMessage: typeof signed }[] }) => void>();
  const wallet = { manifest: { id: 'fake-wallet' }, signAndSendTransaction: async () => { opens++; } };
  const fake = {
    disconnect: async () => {}, wallet: async () => wallet,
    on: (name: string, fn: (event: { accounts: { signedMessage: typeof signed }[] }) => void) => { listeners.set(name, fn); },
    off: (name: string) => { listeners.delete(name); },
    connect: async () => { opens++; listeners.get('wallet:signInAndSignMessage')?.({ accounts: [{ signedMessage: signed }] }); return wallet; },
  };
  Object.defineProperty(globalThis, '__fakeConnector', { configurable: true, value: class { constructor() { return fake; } } });
  const result = await build({ stdin: { contents: await readFile('web/lib/near-wallet.ts', 'utf8'), resolveDir: process.cwd() + '/web/lib', loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'browser', plugins: [{ name: 'fake-connector', setup(build) {
    build.onResolve({ filter: /^@hot-labs\/near-connect$/ }, () => ({ path: 'fake', namespace: 'fake' }));
    build.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ contents: 'export const NearConnector = globalThis.__fakeConnector;' }));
  } }] });
  const module = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0]!.text + '\n//' + Math.random()).toString('base64')) as typeof import('@/lib/near-wallet');
  return { module, fake, wallet, opens: () => opens };
}

test('logout during sign challenge opens no wallet and never assigns selectedWallet', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; Reflect.deleteProperty(globalThis, '__fakeConnector'); });
  const { module, opens } = await walletFixture();
  const challenge = deferred<Response>(); globalThis.fetch = async () => challenge.promise;
  const { actions } = await fixture({ sign: module.sign, clearWallet: module.clearSelectedWallet });
  actions.mountJob(job.id); const reveal = actions.reveal(job); const logout = actions.logout();
  challenge.resolve(new Response(JSON.stringify({ data: { message: 'test', nonce: 'AA==', recipient: 'test' } })));
  await Promise.all([reveal, logout]); assert.equal(opens(), 0); assert.equal(module.selectedWallet, null); assert.equal(actions.state.message, '');
});

for (const accountLookup of [false, true]) test(accountLookup ? 'logout during sendCall account lookup opens no transaction' : 'logout during sendCall wallet lookup opens no transaction', async t => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  t.after(() => { if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window'); Reflect.deleteProperty(globalThis, '__fakeConnector'); });
  const { module, fake, wallet, opens } = await walletFixture();
  const walletReply = deferred<typeof wallet>(), accountReply = deferred<string>();
  let transactions = 0;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { okxwallet: { near: {
    getAccountId: () => accountReply.promise, requestSignIn: async () => { transactions++; return { accountId: job.owner }; }, signAndSendTransaction: async () => { transactions++; return { txHash: 'fake' }; },
  } } } });
  if (accountLookup) wallet.manifest.id = 'okx-wallet';
  else fake.wallet = () => walletReply.promise;
  const { actions } = await fixture({ sendCall: module.sendCall, clearWallet: module.clearSelectedWallet });
  const action = actions.storePolicy(job); await tick(); const logout = actions.logout();
  walletReply.resolve(wallet); accountReply.resolve(job.owner); await Promise.all([action, logout]);
  assert.equal(opens(), 0); assert.equal(transactions, 0); assert.equal(module.selectedWallet, null); assert.equal(actions.sentPolicy.has(job.id), false); assert.equal(actions.state.message, '');
});

// Retire spec 3: a message the server sent is shown as it is; any other failure keeps the generic sentence.
test('Retire: a server error message reaches the page; retire posts the route', async () => {
  const { actions, calls } = await fixture({ api: async p => {
    if (p.endsWith('/retire')) throw new ServerError('The agent wallet still holds funds. Use Stop and withdraw or the management link first.');
    if (p.endsWith('/stop')) throw new Error('fetch failed');
    return undefined;
  } });
  await actions.retire(job);
  assert.ok(calls.includes(`/api/jobs/${job.id}/retire`));
  assert.equal(actions.state.message, 'The agent wallet still holds funds. Use Stop and withdraw or the management link first.');
  await actions.stop(job);
  assert.equal(actions.state.message, generic);
});
