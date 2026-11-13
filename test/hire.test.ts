import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceJob, canTransition, draftProblems, processReveals, readWalletSecret, setJob, TRANSITIONS, type JobState, type WorkerDeps } from '../src/core/hire.js';
import { newChallenge } from '../src/core/auth.js';
import { SecretString, newRelayKey, openRelay } from '../src/core/secrets.js';
import { USDC, WNEAR } from '../src/core/pins.js';
import { CoreError, record } from '../src/core/errors.js';
import type { PolicyRules } from '../src/core/policy.js';
import { agent, dummyOutLayer, dummyRpc, fixture, fullAccess, identity, owner, stores, testNow } from './helpers.js';
import { armedJob, chain } from './chain.js';
import { YOCTO_PER_NEAR as N } from '../src/core/amounts.js';
import { gasAccounting, parseTxStatus } from '../src/core/receipts.js';
import { MONEY } from '../src/core/pins.js';

function build(t: Parameters<typeof stores>[0]) {
  const { web, worker } = stores(t);
  worker.acquireWorkerLock(process.pid, testNow);
  const job = web.createJob({ owner, kind: 'grid', mode: 'live', pair: 'usdc-wnear', depositYocto: 1000000000000000000000000n }, testNow);
  let clock = testNow;
  let entry: unknown = null, afterEcho: unknown = undefined, rules: PolicyRules | undefined;
  const calls: string[] = [];
  const d: WorkerDeps = { store: worker, live: true, origin: 'https://app.test', provider: fullAccess, now: () => clock, kek: Buffer.alloc(32, 3),
    rpc: dummyRpc({ view: async (_contract, method) => ({ height: 5, value: method === 'get_wallet_policy' ? entry : method === 'metadata' ? { state: 'Running', version: '1.9.21' }
      : method === 'get_pool' ? { pool_kind: 'SIMPLE_POOL', token_account_ids: [USDC, WNEAR], amounts: ['123', '456'] }
      : method === 'get_return' ? '3756475' : '15210000000000000000000' }) }),
    outlayer: dummyOutLayer({
      register: async () => { calls.push('register'); return { result: { walletId: 'wallet-test', nearAccountId: agent, apiKey: new SecretString('wk_test_fake'), managementLink: new SecretString('https://example.test/?key=wk_test_fake') }, error: null }; },
      encryptPolicy: async (_k, _id, r) => { rules = r; calls.push('encrypt'); return { encryptedBase64: 'QUFBQQ==' }; },
      signPolicy: async (_k, _cipher, caller) => { calls.push(`sign:${caller}`); return { publicKeyHex: agent, signatureHex: 'b'.repeat(128), version: 1, locked: false, validUntil: 1794912708 }; },
      getPolicy: async () => { calls.push('echo'); if (afterEcho !== undefined) entry = afterEcho; return { http: 200, policy: 'stored', rules, frozen: false, approval: null, capabilities: null }; },
    }) };
  return { d, job, web, worker, calls, setEntry: (v: unknown) => { entry = v; }, setAfterEcho: (v: unknown) => { afterEcho = v; }, next: () => { clock += 16_000; } };
}

test('F-1 and F-2 no hire and zero calls unless the respective live flags are enabled', async t => {
  const { d, job, calls } = build(t);
  assert.equal(await advanceJob({ ...d, live: false }, job.id), 'draft');
  assert.deepEqual(calls, []);
  const valid = { session: { accountId: owner }, kind: 'grid', pair: 'usdc-wnear', mode: 'live', depositYocto: job.depositYocto.toString(), liveEnabled: true, liveJobs: 0, ownerPendingLive: 0 };
  assert.deepEqual(draftProblems(valid), []);
  for (const p of [{ liveEnabled: false }, { kind: 'lp' }, { mode: 'dry-run' }, { depositYocto: '12' }, { liveJobs: 15 }, { ownerPendingLive: 1 }, { session: null }]) {
    assert.ok(draftProblems({ ...valid, ...p }).length);
  }
});

test('I-1 through I-6: register, prepare for session owner, exact finalized chain echo, then link confirmation', async t => {
  const { d, job, web, worker, calls, setEntry, next } = build(t);
  assert.equal(await advanceJob(d, job.id), 'registered');
  assert.equal(await advanceJob(d, job.id), 'policy_prepared');
  assert.equal(await advanceJob(d, job.id), 'policy_prepared');
  assert.deepEqual(calls, ['register', 'encrypt', `sign:${owner}`]);
  setEntry(fixture('chain-policy-entry')); next();
  assert.equal(await advanceJob(d, job.id), 'armed');
  const armed = worker.getJob(job.id)!;
  assert.ok(armed.armedHash);
  const c = newChallenge('reveal', job.id, d.now()), key = newRelayKey(), id = 'reveal-1';
  web.putChallenge(c);
  web.insertReveal({ id, jobId: job.id, nonce: c.nonce, webPub: key.publicDer, signed: identity()(c), sealed: null, createdAt: d.now() });
  await processReveals(d);
  const result = web.getReveal(id)!;
  assert.ok(result.sealed);
  assert.equal(web.meta(`reveal_delivered:${job.id}`), null);
  assert.equal(openRelay(result.sealed, key, id).reveal(), 'https://example.test/?key=wk_test_fake');
  assert.equal(web.takeReveal(result, d.now()), true);
  assert.equal(web.getReveal(id), null);
  assert.equal(web.getChallenge(c.nonce), null);
  assert.ok(web.meta(`reveal_delivered:${job.id}`));
  assert.ok(setJob(web, armed, 'link_confirmed', d.now(), { linkConfirmedAt: d.now() }));
});

test('I-6 a matching ciphertext before the echo is insufficient if it changes during the echo', async t => {
  const { d, job, worker, setEntry, setAfterEcho } = build(t);
  await advanceJob(d, job.id); await advanceJob(d, job.id);
  setEntry(fixture('chain-policy-entry'));
  setAfterEcho({ ...record(fixture('chain-policy-entry')), encrypted_data: 'different' });
  assert.equal(await advanceJob(d, job.id), 'halted');
  assert.equal(worker.getJob(job.id)?.armedHash, null);
  assert.equal(worker.openAlerts(job.id)[0]?.kind, 'policy_changed');
});

test('I-7 and I-11 a non-200 key is saved and a forged owner cannot open it', async t => {
  const { d, job, worker } = build(t);
  const reg = d.outlayer.register;
  d.outlayer.register = async () => ({ ...(await reg()), error: new CoreError('outlayer_error', 'Registration refused') });
  assert.equal(await advanceJob(d, job.id), 'failed');
  const registered = worker.getJob(job.id)!;
  assert.equal(readWalletSecret(worker, d.kek, registered, 'api_key').reveal(), 'wk_test_fake');
  assert.throws(() => readWalletSecret(worker, d.kek, { ...registered, owner: 'user.near' }, 'api_key'));
  assert.throws(() => readWalletSecret(worker, d.kek, { ...registered, owner: 'user.near' }, 'link'));
});

test('hire transition table has no web entrance into ready or running', () => {
  for (const from of Object.keys(TRANSITIONS) as JobState[]) for (const to of Object.keys(TRANSITIONS) as JobState[]) {
    if (to === 'ready' || to === 'running') assert.equal(canTransition(from, to, 'web'), false);
  }
  assert.equal(canTransition('draft', 'armed', 'worker'), false);
  assert.equal(canTransition('policy_prepared', 'armed', 'worker'), true);
  assert.equal(canTransition('policy_prepared', 'armed', 'web'), false);
  assert.equal(canTransition('armed', 'link_confirmed', 'web'), true);
});

test('I-1 early funds cannot skip management confirmation; F-5 blocks setup until the watchdog is fresh', async t => {
  const { web, worker, watch } = stores(t), { job, kek } = armedJob(web, worker, 'armed', 4n * N / 10n), c = chain();
  let calls = 0;
  const d: WorkerDeps = { store: worker, rpc: c.rpc, outlayer: dummyOutLayer({ storageDeposit: async () => { calls++; throw new Error(); } }),
    kek, live: true, origin: 'https://app.test', provider: fullAccess, now: () => testNow };
  assert.equal(await advanceJob(d, job.id), 'armed');
  assert.ok(setJob(web, job, 'link_confirmed', testNow, { linkConfirmedAt: testNow }));
  assert.equal(await advanceJob(d, job.id), 'funded');
  assert.equal(await advanceJob(d, job.id), 'funded');
  assert.equal(calls, 0);
  watch.heartbeat('watchdog', testNow);
  assert.equal(await advanceJob(d, job.id), 'ready');
  assert.equal(await advanceJob(d, job.id), 'ready');
});

test('ready checks require the agent and owner storage and the 0.320 free NEAR floor', async t => {
  const { web, worker, watch } = stores(t), { job, kek } = armedJob(web, worker, 'funded', 4n * N / 10n), c = chain();
  watch.heartbeat('watchdog', testNow);
  c.registration.delete(`${USDC}:${owner}`);
  let calls = 0;
  const d: WorkerDeps = { store: worker, rpc: c.rpc, outlayer: dummyOutLayer({ storageDeposit: async (_key, token, to) => {
    calls++; assert.equal(token, USDC); assert.equal(to, owner);
    return { kind: 'denied', code: 'policy_denied', message: 'Test registration denial.' };
  } }), kek, live: true, origin: 'https://app.test', provider: fullAccess, now: () => testNow };
  assert.equal(await advanceJob(d, job.id), 'funded');
  assert.equal(calls, 1);
  c.registration.add(`${USDC}:${owner}`);
  c.setHoldings({ native: MONEY.readyFloor });
  assert.equal(await advanceJob(d, job.id), 'funded');
  assert.equal(calls, 1);
  c.setHoldings({ native: N / 2n });
  assert.equal(await advanceJob(d, job.id), 'ready');
});

test('I-15 freeze, owner unfreeze, paused, and only signed resuming can return to ready', async t => {
  const { web, worker, watch } = stores(t), { job, kek } = armedJob(web, worker, 'ready'), c = chain();
  const d: WorkerDeps = { store: worker, rpc: c.rpc, outlayer: dummyOutLayer(), kek, live: true, origin: 'https://app.test', provider: fullAccess, now: () => testNow };
  c.freeze(true);
  assert.equal(await advanceJob(d, job.id), 'frozen');
  c.freeze(false);
  assert.equal(await advanceJob(d, job.id), 'paused');
  assert.equal(await advanceJob(d, job.id), 'paused');
  const j = worker.getJob(job.id)!;
  assert.equal(setJob(web, j, 'ready', testNow), false);
  assert.ok(setJob(web, j, 'resuming', testNow));
  assert.equal(await advanceJob(d, job.id), 'resuming');
  watch.heartbeat('watchdog', testNow);
  assert.equal(await advanceJob(d, job.id), 'ready');
});

test('stop while frozen persists; after unfreeze, owner-only finalized transfer ends at stopped', async t => {
  const { web, worker } = stores(t), { job, kek } = armedJob(web, worker, 'stopping'), c = chain();
  let calls = 0;
  c.setHoldings({ native: 2n * N / 100n + 182n * MONEY.storageYoctoPerByte, wnear: 0n, usdc: 0n });
  const d: WorkerDeps = { store: worker, rpc: c.rpc, outlayer: dummyOutLayer({ transfer: async (_key, to, a) => {
    calls++; assert.equal(to, owner); assert.equal(a, N / 100n);
    const raw = fixture('tx-1.18-native-transfer'), burnt = gasAccounting(parseTxStatus(raw), agent).burnt;
    const hash = c.addTx(raw);
    c.setHoldings({ native: c.native - a - burnt, height: 30 });
    return { kind: 'accepted', terminal: true, requestId: 'req', status: 'success', txHash: hash };
  } }), kek, live: true, origin: 'https://app.test', provider: fullAccess, now: () => testNow };
  c.freeze(true);
  assert.equal(await advanceJob(d, job.id), 'stopping');
  assert.equal(worker.getJob(job.id)?.reason, 'Unfreeze to withdraw.');
  assert.equal(calls, 0);
  c.freeze(false);
  assert.equal(await advanceJob(d, job.id), 'stopped');
  assert.equal(calls, 1);
});
