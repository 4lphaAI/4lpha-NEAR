import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNearActions, TRANSFER_PREFIX, type TransferStore } from '@/lib/near-actions';
import { hireRunSteps, type HireLocal, type PendingTransfer } from '@/lib/hire-run';
import type { Job } from '@/lib/near-format';
import type { api, sign, sendCall, transferWallet } from '@/lib/near-wallet';

const N = 10n ** 24n;
const AGENT = 'a'.repeat(64);
const dclView = (over: Partial<NonNullable<Job['grid']>> = {}): NonNullable<Job['grid']> => ({ available: true, enabled: true, issued: false, registered: false, canRegister: false,
  point: 1, anchor: null, internal: {}, lost: {}, positions: 0, lanes: [], orders: [], ...over });
const base = (over: Partial<Job> = {}): Job => ({
  id: '78bae146-0000-4000-8000-000000000001', owner: 'owner.near', kind: 'grid', state: 'link_confirmed', reason: null,
  depositYocto: N.toString(), agentAccount: AGENT, walletPubkey: 'ed25519:fake', agentBalance: '0', ownerBalance: (5n * N).toString(),
  payload: null, canReveal: true, linkDelivered: true, linkConfirmed: true, canFund: true, frozen: false, canStopEarly: false, waitingForChain: false, blindHalt: false, canResumeBlind: false, resumeBlockedReason: null,
  grid: dclView({ registered: true }), lp: null, pendingSubmission: null, holdings: null, extraTokens: [], operations: [], alerts: [], ...over,
});
const policy = { caller: 'owner.near', receiverId: 'outlayer.near', methodName: 'store_wallet_policy', args: {}, gas: '1', deposit: '0' };
const none: HireLocal = { policySent: false, linkShown: false, saved: false, transfer: null };
const active = (job: Job, local: HireLocal = none) => { const r = hireRunSteps(job, local); return { key: r.steps.find(s => s.state === 'active' || s.state === 'failed')?.key ?? null, ...r }; };
const marker = (over: Partial<PendingTransfer> = {}): PendingTransfer => ({ account: 'owner.near', jobId: base().id, amount: N.toString(), baseBalance: '0', at: 0, ...over });

test('hireRunSteps: each step becomes active only when its server flag allows the action', () => {
  assert.deepEqual([active(base({ state: 'draft', linkConfirmed: false, grid: dclView() })).key, active(base({ state: 'draft', linkConfirmed: false, grid: dclView() })).action], ['prepare', 'wait']);
  const pp = base({ state: 'policy_prepared', linkConfirmed: false, grid: dclView(), payload: policy });
  assert.deepEqual([active(pp).key, active(pp).action], ['policy', 'sign-policy']);
  assert.equal(active(pp, { ...none, policySent: true }).action, 'wait');
  // Expired payload, with and without a prior submission: never sign-policy.
  assert.equal(active({ ...pp, payload: null }).action, 'expired');
  assert.equal(active({ ...pp, payload: null }, { ...none, policySent: true }).action, 'wait');
  assert.equal(active({ ...pp, payload: { ...policy, caller: 'x.near' } }).action, 'expired');
  const armed = base({ state: 'armed', linkConfirmed: false, grid: dclView() });
  assert.deepEqual([active(armed).key, active(armed).action], ['link', 'reveal']);
  assert.equal(active({ ...armed, canReveal: false }).action, 'wait');
  assert.equal(active(armed, { ...none, linkShown: true }).action, 'confirm-link');
  const linked = base({ canFund: false, grid: dclView() });
  assert.deepEqual([active(linked).key, active(linked).action, active(linked).waitText], ['dcl', 'wait', 'Waiting for the DCL checks.']);
  assert.equal(active({ ...linked, grid: dclView({ canRegister: true }) }).action, 'register-dcl');
  assert.equal(active({ ...linked, grid: dclView({ issued: true }) }).waitText, 'Waiting for the finalized DCL registration.');
  assert.equal(active({ ...linked, grid: dclView({ issued: true, available: false }) }).waitText, 'Waiting for finalized DCL data.');
  const registered = base({ canFund: false });
  assert.deepEqual([active(registered).key, active(registered).action], ['fund', 'wait']);
  assert.deepEqual([active(base()).key, active(base()).action], ['fund', 'fund']);
  assert.equal(active(base(), { ...none, transfer: marker() }).action, 'wait');
  assert.deepEqual([active(base({ state: 'funded' })).key, active(base({ state: 'funded' })).action], ['ready', 'wait']);
  assert.equal(hireRunSteps(base({ state: 'running' }), none).deployed, true);
  assert.equal(hireRunSteps(base({ state: 'ready' }), none).deployed, true);
});

test('hireRunSteps: resuming and a failed DCL read never rewind setup; Grid and LP; a job without a DCL view has five steps', () => {
  for (const state of ['funded', 'resuming', 'ready', 'running']) {
    for (const view of [{ grid: dclView({ registered: false, available: false }), lp: null }, { grid: null, lp: { ...dclView({ registered: false, available: false }), ledger: null, rotations: 0, pending: null, range: null, position: null } }]) {
      const r = active(base({ state, ...view } as Partial<Job>));
      assert.notEqual(r.key, 'dcl', state);
      assert.notEqual(r.key, 'fund', state);
    }
  }
  assert.equal(active(base({ state: 'resuming' })).key, 'ready');
  const legacy = hireRunSteps(base({ grid: null, lp: null }), none);
  assert.deepEqual(legacy.steps.map(s => s.key), ['prepare', 'policy', 'link', 'fund', 'ready']);
});

test('hireRunSteps: stopped states take precedence, including a frozen wallet while still link_confirmed', () => {
  for (const state of ['failed', 'cancelled', 'halted', 'stopped', 'stopping', 'paused', 'frozen']) {
    const r = hireRunSteps(base({ state }), none);
    assert.ok(r.stopped, state); assert.equal(r.action, null, state); assert.equal(r.deployed, false, state);
  }
  const halted = hireRunSteps(base({ state: 'halted', linkConfirmed: false, payload: policy, reason: 'Owner mismatch.' }), none);
  assert.equal(halted.stopped?.reason, 'Owner mismatch.');
  // A hire cancelled while still preparing shows the first step failed, not done.
  const early = hireRunSteps(base({ state: 'cancelled', agentAccount: null, linkDelivered: false, linkConfirmed: false, grid: dclView() }), none);
  assert.deepEqual(early.steps.slice(0, 2).map(s => s.state), ['failed', 'pending']);
  const later = hireRunSteps(base({ state: 'cancelled', linkDelivered: true, linkConfirmed: false, grid: dclView() }), none);
  assert.deepEqual(later.steps.slice(0, 3).map(s => s.state), ['done', 'done', 'failed']);
  const frozen = hireRunSteps(base({ frozen: true }), none);
  assert.match(frozen.stopped!.reason, /frozen/); assert.equal(frozen.action, null);
  assert.equal(frozen.steps.find(s => s.key === 'fund')!.state, 'failed');
});

function memoryStore(fail = false) {
  const map = new Map<string, string>();
  const store: TransferStore = {
    get: k => map.get(k) ?? null,
    set: (k, v) => { if (fail) throw new Error('quota'); map.set(k, v); },
    remove: k => { map.delete(k); },
    keys: () => [...map.keys()],
  };
  return { map, store };
}

async function fixture(o: { fresh?: () => unknown; list?: () => Job[]; store?: TransferStore | null; wallet?: typeof transferWallet; now?: () => number;
  lock?: <T>(name: string, fn: () => Promise<T>) => Promise<T> } = {}) {
  const sent: { receiver: string; amount: string }[] = [], calls: string[] = [];
  let listed: Job[] = o.list ? o.list() : [base()];
  const actions = createNearActions({
    api: (async (path: string) => {
      calls.push(path);
      if (path === '/api/me') return { accountId: 'owner.near' };
      if (path === '/api/hire/options') return { liveEnabled: true, gridV1: true, lpV1: true, minDeposit: '1', maxDeposit: '1', lp: null };
      if (path === '/api/jobs') return o.list ? o.list() : listed;
      if (path === `/api/jobs/${base().id}`) { const v = o.fresh ? await o.fresh() : base(); if (v instanceof Error) throw v; return v; }
      return true;
    }) as typeof api,
    sign: (async () => ({})) as unknown as typeof sign, sendCall: (async () => {}) as typeof sendCall,
    now: o.now ?? (() => 1_000_000), clearWallet: () => {}, changed: () => {},
    transferWallet: o.wallet ?? (async () => async (receiver: string, amount: string) => { sent.push({ receiver, amount }); }),
    transferStore: o.store === undefined ? memoryStore().store : o.store,
    ...(o.lock ? { lock: o.lock } : {}),
  });
  await actions.mount();
  return { actions, sent, calls, setList: (jobs: Job[]) => { listed = jobs; } };
}

test('fund refuses on a failed or unfit fresh read with zero wallet calls', async () => {
  const cases: (() => unknown)[] = [
    () => new Error('down'), () => ({ ...base(), id: 'other' }), () => base({ owner: 'x.near' }), () => base({ canFund: false }),
    () => base({ agentBalance: null }), () => base({ agentAccount: 'agent.near' }), () => base({ grid: dclView({ registered: false }) }),
    () => base({ agentBalance: N.toString() }), () => base({ agentBalance: (2n * N).toString() }), () => base({ state: 'armed' }),
    () => base({ frozen: true }), () => base({ linkConfirmed: false }), () => base({ depositYocto: '1e24' }),
  ];
  for (const fresh of cases) {
    const f = await fixture({ fresh });
    await f.actions.fund(base());
    assert.equal(f.sent.length, 0, String(fresh));
    assert.equal(f.actions.transfer(base().id), null);
    assert.ok(f.actions.state.message.length > 0);
  }
});

test('fund uses only the fresh view: the amount follows the fresh balance, and a cached eligible job never funds', async () => {
  const f = await fixture({ fresh: () => base({ agentBalance: (3n * N / 10n).toString() }) });
  await f.actions.fund(base({ agentBalance: '0' }));
  assert.deepEqual(f.sent, [{ receiver: AGENT, amount: (7n * N / 10n).toString() }]);
  assert.match(f.actions.state.message, /Transfer submitted/);
});

test('fund writes the marker before signing, refuses a second send, and two simultaneous calls send once', async () => {
  const { map, store } = memoryStore();
  let seenMarker = false;
  const f = await fixture({ store, wallet: async () => async () => { seenMarker = map.size === 1; } });
  await Promise.all([f.actions.fund(base()), f.actions.fund(base())]);
  assert.equal(seenMarker, true, 'marker persisted before the wallet call');
  const k = TRANSFER_PREFIX + 'owner.near:' + base().id;
  assert.ok(map.has(k));
  await f.actions.fund(base());
  assert.match(f.actions.state.message, /already submitted/);
  // A second controller (another tab) sharing the storage refuses too.
  let sent = 0;
  const g = await fixture({ store, wallet: async () => async () => { sent++; } });
  await g.actions.fund(base());
  assert.equal(sent, 0); assert.match(g.actions.state.message, /already submitted/);
});

test('fund: a wallet error after signing keeps the marker; preflight errors and storage failure write none', async () => {
  const kept = await fixture({ wallet: async () => async () => { throw new Error('rejected'); } });
  await kept.actions.fund(base());
  assert.ok(kept.actions.transfer(base().id));
  assert.match(kept.actions.state.message, /did not confirm/);
  const pre = await fixture({ wallet: async () => { throw new Error('4lpha: Connect the wallet that owns this job.'); } });
  await pre.actions.fund(base());
  assert.equal(pre.actions.transfer(base().id), null); assert.equal(pre.actions.state.message, 'Connect the wallet that owns this job.');
  const okx = await fixture({ wallet: async () => { throw new Error('4lpha: This wallet cannot send a transfer from the page. Use the manual line on the agent page.'); } });
  await okx.actions.fund(base());
  assert.equal(okx.actions.transfer(base().id), null); assert.match(okx.actions.state.message, /cannot send a transfer/);
  const broken = await fixture({ store: memoryStore(true).store });
  await broken.actions.fund(base());
  assert.equal(broken.sent.length, 0); assert.match(broken.actions.state.message, /cannot record the transfer/);
  const missing = await fixture({ store: null });
  await missing.actions.fund(base());
  assert.equal(missing.sent.length, 0);
});

test('the marker survives canFund false, a smaller balance change and a stopped job; it clears when funded or the expected balance is reached', async () => {
  const { store } = memoryStore();
  let list = [base()], now = 1_000_000;
  const f = await fixture({ store, list: () => list, now: () => now });
  await f.actions.fund(base());
  const refresh = async (jobs: Job[]) => { list = jobs; now += 16_000; await f.actions.refresh(); };
  await refresh([base({ canFund: false })]);
  assert.ok(f.actions.transfer(base().id), 'canFund false keeps it');
  await refresh([base({ agentBalance: (N / 2n).toString() })]);
  assert.ok(f.actions.transfer(base().id), 'a smaller balance keeps it');
  await refresh([base({ state: 'cancelled' })]);
  assert.ok(f.actions.transfer(base().id), 'a cancelled job keeps it');
  await refresh([base({ agentBalance: N.toString(), canFund: false })]);
  assert.equal(f.actions.transfer(base().id), null, 'expected balance reached');
  const g = await fixture({ store: memoryStore().store, list: () => list, now: () => now });
  list = [base()]; await g.actions.fund(base());
  list = [base({ state: 'funded' })]; now += 16_000; await g.actions.refresh();
  assert.equal(g.actions.transfer(base().id), null, 'funded clears it');
});

test('a stored marker is restored for the same account only and synced from another tab', async () => {
  const { map, store } = memoryStore();
  map.set(TRANSFER_PREFIX + 'owner.near:' + base().id, JSON.stringify(marker()));
  map.set(TRANSFER_PREFIX + 'other.near:' + base().id, JSON.stringify(marker({ account: 'other.near' })));
  const f = await fixture({ store, list: () => [base({ canFund: false })] });
  assert.ok(f.actions.transfer(base().id));
  const g = await fixture({ store: memoryStore().store, list: () => [base({ canFund: false })] });
  assert.equal(g.actions.transfer(base().id), null);
  g.actions.syncTransfer(TRANSFER_PREFIX + 'owner.near:' + base().id, JSON.stringify(marker()));
  assert.ok(g.actions.transfer(base().id));
  g.actions.syncTransfer(TRANSFER_PREFIX + 'other.near:' + base().id, JSON.stringify(marker({ account: 'other.near' })));
  g.actions.syncTransfer(TRANSFER_PREFIX + 'owner.near:' + base().id, null);
  assert.equal(g.actions.transfer(base().id), null);
});

test('reset needs the acknowledgement, two minutes and a successful fresh read', async () => {
  let now = 1_000_000, fresh: () => unknown = () => base();
  const f = await fixture({ now: () => now, fresh: () => fresh(), list: () => [base({ canFund: false })] });
  await f.actions.fund(base());
  assert.ok(f.actions.transfer(base().id));
  await f.actions.resetTransfer(base(), false);
  assert.ok(f.actions.transfer(base().id)); assert.match(f.actions.state.message, /Tick the confirmation/);
  await f.actions.resetTransfer(base(), true);
  assert.ok(f.actions.transfer(base().id)); assert.match(f.actions.state.message, /two minutes/);
  now += 120_000;
  fresh = () => new Error('down');
  await f.actions.resetTransfer(base(), true);
  assert.ok(f.actions.transfer(base().id), 'a failed read keeps it');
  fresh = () => base({ agentBalance: null });
  await f.actions.resetTransfer(base(), true);
  assert.ok(f.actions.transfer(base().id), 'a null balance keeps it');
  fresh = () => base();
  await f.actions.resetTransfer(base(), true);
  assert.equal(f.actions.transfer(base().id), null);
});

test('fund: a second tab already open refuses through the storage re-read, without a storage event', async () => {
  const { store } = memoryStore();
  let sent = 0;
  const b = await fixture({ store, wallet: async () => async () => { sent++; } });
  const a = await fixture({ store });
  await a.actions.fund(base());
  assert.equal(a.sent.length, 1);
  assert.equal(b.actions.transfer(base().id), null, 'B has not seen the marker in memory');
  await b.actions.fund(base());
  assert.equal(sent, 0); assert.match(b.actions.state.message, /already submitted/);
});

test('fund: a logout during the fresh read or right before signing sends nothing and leaves no marker', async () => {
  const holder: { logout?: () => Promise<void> } = {};
  const f = await fixture({ fresh: async () => { void holder.logout!(); return base(); } });
  holder.logout = () => f.actions.logout();
  await f.actions.fund(base());
  assert.equal(f.sent.length, 0);
  const { map, store } = memoryStore();
  const h2: { logout?: () => Promise<void> } = {};
  const g = await fixture({ store, lock: async (_n, fn) => { const r = await fn(); void h2.logout!(); return r; } });
  h2.logout = () => g.actions.logout();
  await g.actions.fund(base());
  assert.equal(g.sent.length, 0);
  assert.equal(map.size, 0, 'the marker written under the lock is dropped when the session changed before signing');
});

test('fund: the stored marker carries the fresh balance; settle and reset remove the stored copy', async () => {
  const { map, store } = memoryStore();
  let list = [base()], now = 1_000_000;
  const f = await fixture({ store, list: () => list, now: () => now, fresh: () => base({ agentBalance: (N / 4n).toString() }) });
  await f.actions.fund(base());
  const k = TRANSFER_PREFIX + 'owner.near:' + base().id;
  const saved = JSON.parse(map.get(k)!) as PendingTransfer;
  assert.equal(saved.baseBalance, (N / 4n).toString()); assert.equal(saved.amount, (3n * N / 4n).toString());
  list = [base({ state: 'funded' })]; now += 16_000; await f.actions.refresh();
  assert.equal(map.has(k), false, 'settle removes the stored copy');
  const g = await fixture({ store, list: () => [base({ canFund: false })], now: () => now });
  await g.actions.fund(base());
  assert.ok(map.has(k));
  now += 121_000;
  await g.actions.resetTransfer(base(), true);
  assert.equal(map.has(k), false, 'reset removes the stored copy');
});

test('a stopped job whose worker already operated settles its marker', async () => {
  const { map, store } = memoryStore();
  map.set(TRANSFER_PREFIX + 'owner.near:' + base().id, JSON.stringify(marker()));
  const op = { id: 'o', kind: 'wrap', verdict: null, state: 'finished', txHash: null, message: null, createdAt: 1, finishedAt: 2 };
  const f = await fixture({ store, list: () => [base({ state: 'stopped', agentBalance: '0', operations: [op] })] });
  assert.equal(f.actions.transfer(base().id), null);
  const g = await fixture({ store: memoryStore().store, list: () => [base({ state: 'cancelled' })] });
  g.actions.syncTransfer(TRANSFER_PREFIX + 'owner.near:' + base().id, JSON.stringify(marker()));
  assert.ok(g.actions.transfer(base().id), 'a cancelled job with no operations keeps it');
});
