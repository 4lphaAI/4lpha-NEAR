import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../src/core/store.js';
import { agent, owner, stores, testNow } from './helpers.js';
import { armedJob, opRow } from './chain.js';

test('I-8 a stale heartbeat cannot take over a live or ambiguous PID', t => {
  const { worker, path } = stores(t), other = openStore(path, 'worker');
  try {
    assert.equal(worker.acquireWorkerLock(100, testNow), true);
    assert.equal(other.acquireWorkerLock(101, testNow + 31_000, () => { throw Object.assign(new Error(), { code: 'ESRCH' }); }), false);
    assert.equal(other.acquireWorkerLock(101, testNow + 61_000, () => true), false);
    assert.equal(other.acquireWorkerLock(101, testNow + 61_000, () => { throw Object.assign(new Error(), { code: 'EPERM' }); }), false);
    assert.equal(other.acquireWorkerLock(101, testNow + 61_000, () => { throw Object.assign(new Error(), { code: 'ESRCH' }); }), true);
    assert.equal(worker.heartbeat('worker', testNow + 62_000), false);
    worker.releaseWorkerLock();
    assert.equal(other.ownsWorkerLock(), true);
  } finally { other.close(); }
});

test('ops journal rolls 24-hour and 1-hour counts from submission timestamps', t => {
  const { web, worker } = stores(t), { job } = armedJob(web, worker);
  const at = (ms: number, nativeSpend: bigint) => worker.insertOp(opRow(job, { state: 'finished', nativeSpend, submittedAt: testNow - ms }));
  assert.ok(at(100, 5n));
  assert.ok(at(3_600_001, 7n));
  assert.ok(at(86_400_001, 13n));
  assert.deepEqual(worker.budgetView(job.walletId!, testNow), { used24h: 2, used1h: 1, nativeSpent24h: 12n, blockedUntil: null });
});

test('schema, role restrictions and job CAS serialize independent connections', t => {
  const { web, worker, watch, path } = stores(t);
  const raw = new DatabaseSync(path);
  try {
    const names = raw.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(r => r.name);
    assert.deepEqual(names, ['alerts', 'challenges', 'grid_jobs', 'grid_settings', 'job_names', 'jobs', 'lp_jobs', 'lp_settings', 'meme_agents', 'meme_auctions', 'meme_log', 'meme_positions', 'meta', 'ops', 'reveals', 'rpc_groups', 'rpc_tickets', 'sessions', 'trade_jobs', 'wallet_secrets', 'watch_state']);
  } finally { raw.close(); }
  const j = web.createJob({ owner, kind: 'grid', mode: 'live', pair: 'usdc-wnear', depositYocto: 400000000000000000000000n }, testNow);
  assert.throws(() => web.getSecrets('w'));
  assert.throws(() => watch.putSecrets('w', { apiKeyCt: Buffer.alloc(28), linkCt: null }, testNow));
  assert.throws(() => web.casJob(j.id, 'draft', 0, 'ready'));
  assert.ok(worker.attachWallet(j, 'w', agent, { apiKeyCt: Buffer.alloc(28), linkCt: null }, testNow));
  assert.equal(web.casJob(j.id, 'draft', j.version, 'cancelled'), false);
  assert.equal(worker.attachWallet(j, 'new', 'b'.repeat(64), { apiKeyCt: Buffer.alloc(28), linkCt: null }, testNow), false);
});

test('insertOp admits a step only when it is the pending one and has no row yet', t => {
  const { web, worker } = stores(t);
  const j = web.createJob({ owner, kind: 'grid', mode: 'live', pair: 'usdc-wnear', depositYocto: 10n ** 24n, gridV1: true }, testNow);
  worker.acquireWorkerLock(process.pid, testNow);
  assert.ok(worker.attachWallet(j, 'w', agent, { apiKeyCt: Buffer.alloc(28), linkCt: null }, testNow));
  assert.ok(worker.casJob(j.id, 'registered', 1, 'running', {}, testNow));
  const job = worker.getJob(j.id)!;
  assert.ok(worker.saveGrid(job, null, { anchor: 0, bootstrap: 0, lanes: [], sequence: 0, pending: { id: 'step-1', kind: 'wrap', lane: null, amount: '1' } }));
  const withStep = (step: string, patch = {}) => opRow(job, { request: JSON.stringify({ step }), ...patch });
  assert.equal(worker.insertOp(withStep('step-2')), false, 'not the pending step');
  assert.equal(worker.insertOp(withStep('step-1', { state: 'finished' })), true);
  assert.equal(worker.insertOp(withStep('step-1', { state: 'finished' })), false, 'a step that already has a row');
});

// Retire spec 2.1 and 2.2 step 5.
test('Retire: only the web store retires, from halted, paused or frozen, at the read version, with the same unresolved row', t => {
  // armedJob binds one fixed wallet id, so each state gets its own database.
  for (const state of ['running', 'stopping', 'stopped', 'ready', 'link_confirmed'] as const) {
    const s = stores(t), { job: j } = armedJob(s.web, s.worker, state);
    assert.equal(s.web.getJob(j.id)!.state, state);
    assert.equal(s.web.retireJob(s.web.getJob(j.id)!, null, testNow), false, state);
    assert.equal(s.web.getJob(j.id)!.state, state);
  }
  for (const state of ['paused', 'frozen'] as const) {
    const s = stores(t), { job: j } = armedJob(s.web, s.worker, state);
    assert.equal(s.web.retireJob(s.web.getJob(j.id)!, null, testNow), true, state);
    assert.equal(s.web.getJob(j.id)!.state, 'retired');
  }
  const db = stores(t);
  const { job: h } = armedJob(db.web, db.worker, 'halted'), job = () => db.web.getJob(h.id)!;
  assert.throws(() => db.worker.retireJob(job(), null, testNow), { code: 'forbidden' });
  assert.throws(() => db.watch.retireJob(job(), null, testNow), { code: 'forbidden' });
  const stale = job();
  assert.ok(db.worker.casJob(h.id, 'halted', stale.version, 'halted', { reason: 'changed' }));
  assert.equal(db.web.retireJob(stale, null, testNow), false, 'a stale version');
  // insertOp refuses a halted job, so the unresolved row a quarantine leaves is written directly.
  const row = opRow(job(), { kind: 'swap', state: 'ambiguous', verdict: 'unknown' }), raw = new DatabaseSync(db.path);
  try {
    raw.prepare('INSERT INTO ops (id,job_id,wallet_id,kind,purpose,idem_key,request,state,counted,native_spend,verdict,created_at,submitted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(row.id, h.id, job().walletId, 'swap', 'strategy', row.idemKey, '{}', 'ambiguous', 1, '0', 'unknown', testNow, testNow);
  } finally { raw.close(); }
  assert.equal(db.web.retireJob(job(), null, testNow), false, 'an unresolved row that the caller did not name');
  assert.equal(db.web.retireJob(job(), 'other-op', testNow), false, 'another row id');
  assert.ok(db.worker.updateOp(row.id, { state: 'submitted' }));
  assert.equal(db.web.retireJob(job(), row.id, testNow), false, 'a submitted row');
  assert.ok(db.worker.updateOp(row.id, { state: 'ambiguous' }));
  assert.equal(db.web.retireJob(job(), row.id, testNow + 5), true);
  assert.equal(job().state, 'retired');
  assert.equal(job().reason, 'Retired by the owner. The agent wallet held only dust.');
  const closed = db.web.jobOps(h.id).find(o => o.id === row.id)!;
  assert.equal(closed.state, 'finished'); assert.equal(closed.verdict, 'unknown'); assert.equal(closed.finishedAt, testNow + 5);
  assert.equal(db.worker.activeJobs().some(j => j.id === h.id), false);
  assert.equal(db.worker.inFlightOps().length, 0);
  for (const to of ['stopping', 'running', 'halted', 'paused'] as const) assert.equal(db.worker.casJob(h.id, 'retired', job().version, to), false, 'nothing leaves retired: ' + to);
  assert.equal(job().state, 'retired');
});

// Operator ruling 2026-11-12: at most 15 live jobs that are not terminal.
test('Retire: a 15th live job is accepted and a 16th refused; a retired job frees its slot', t => {
  const db = stores(t);
  const hire = (i: number) => db.web.createJob({ owner: `owner-${i}.near`, kind: 'grid', mode: 'live', pair: 'usdc-wnear', depositYocto: 10n ** 24n }, testNow);
  for (let i = 0; i < 15; i++) hire(i);
  assert.equal(db.web.jobCounts('nobody.near').live, 15);
  assert.throws(() => hire(15), { code: 'limit_reached' });
  const dead = db.web.listJobs('owner-0.near')[0]!;
  db.worker.acquireWorkerLock(process.pid, testNow);
  assert.ok(db.worker.casJob(dead.id, 'draft', dead.version, 'halted'));
  assert.ok(db.web.retireJob(db.web.getJob(dead.id)!, null, testNow));
  hire(15);
  assert.equal(db.web.jobCounts('nobody.near').live, 15);
});

// ---------------------------------------------------------------------------------------------------------------------
// AUDIT 2026-11-12 (Retire, 15 live jobs, no hidden agents), probes for the store mutation survivors.
// Each test PASSES on 2b09553 and fails on the named mutants.
// Paste at the end of test/store.test.ts (it uses that file's imports) together with the three import lines below.
// ---------------------------------------------------------------------------------------------------------------------
import { canTransition as auditCanTransition, draftProblems as auditDraftProblems, setJob as auditSetJob, TRANSITIONS as AUDIT_TRANSITIONS, type JobState as AuditJobState } from '../src/core/hire.js';
import { MONEY as AUDIT_MONEY } from '../src/core/pins.js';
import { TRADE_RESERVE as AUDIT_TRADE_RESERVE, tradePlan as auditTradePlan, tradeSettingsFromRequest as auditTradeSettings } from '../src/core/trade-settings.js';

/** The unresolved row a quarantine leaves, written directly (insertOp refuses a halted job). */
function auditUnresolved(path: string, jobId: string, walletId: string, id = 'audit-unresolved'): string {
  const raw = new DatabaseSync(path);
  try {
    raw.prepare('INSERT INTO ops (id,job_id,wallet_id,kind,purpose,idem_key,request,state,counted,native_spend,verdict,created_at,submitted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, jobId, walletId, 'swap', 'strategy', id, '{}', 'ambiguous', 1, '0', 'unknown', testNow, testNow);
  } finally { raw.close(); }
  return id;
}

test('AUDIT S-1 (C03): a retire that does not happen closes nothing: a stale version or a changed state leaves the unresolved row open', t => {
  for (const change of ['version', 'state'] as const) {
    const db = stores(t), { job: h } = armedJob(db.web, db.worker, 'halted'), job = () => db.web.getJob(h.id)!;
    const row = auditUnresolved(db.path, h.id, job().walletId!);
    const stale = job();
    // The job moves on after the route read it: a new reason at the same state, or the owner's stop.
    assert.ok(db.worker.casJob(h.id, 'halted', stale.version, change === 'version' ? 'halted' : 'stopping', { reason: 'changed' }));
    assert.equal(db.web.retireJob(stale, row, testNow), false, change);
    assert.equal(job().state, change === 'version' ? 'halted' : 'stopping', change);
    assert.equal(job().reason, 'changed', change);
    const open = db.web.inFlightOp(job().walletId!);
    assert.equal(open?.id, row, 'the row is still in flight: ' + change);
    assert.equal(open?.state, 'ambiguous', change);
    assert.equal(open?.finishedAt, null, change);
    assert.equal(db.worker.inFlightOps().length, 1, 'the worker still reconciles it: ' + change);
  }
});

test('AUDIT S-2 (C07): a row on this wallet that belongs to another job id is never closed by a retire', t => {
  const db = stores(t), { job: h } = armedJob(db.web, db.worker, 'halted'), job = () => db.web.getJob(h.id)!;
  const row = auditUnresolved(db.path, 'another-job-id', job().walletId!);
  assert.equal(db.web.retireJob(job(), row, testNow), false);
  assert.equal(job().state, 'halted');
  assert.equal(db.web.inFlightOp(job().walletId!)?.state, 'ambiguous');
});

test('AUDIT S-3 (C11, H03, H04): retired is entered only by retireJob and is left by nothing', t => {
  // The transition table: no state leads to retired, and retired leads nowhere.
  assert.deepEqual(AUDIT_TRANSITIONS.retired, []);
  for (const [from, list] of Object.entries(AUDIT_TRANSITIONS)) assert.equal(list.some(x => x.to === 'retired'), false, from);
  for (const to of Object.keys(AUDIT_TRANSITIONS) as AuditJobState[]) for (const by of ['web', 'worker'] as const) assert.equal(auditCanTransition('retired', to, by), false, `${to} by ${by}`);
  // casJob itself (it does not consult the table): the worker cannot move any live state into retired.
  for (const state of ['paused', 'frozen', 'running', 'stopping', 'ready'] as const) {
    const s = stores(t), { job: j } = armedJob(s.web, s.worker, state);
    assert.equal(s.worker.casJob(j.id, state, j.version, 'retired', { reason: 'x' }), false, state);
    assert.equal(auditSetJob(s.worker, s.worker.getJob(j.id)!, 'retired', testNow), false, state);
    assert.equal(s.web.getJob(j.id)!.state, state);
    assert.equal(s.worker.activeJobs().some(a => a.id === j.id), true, state);
  }
  // A retired job keeps its state, reason and version against the worker's same-state reason update and the web's stop and cancel.
  const db = stores(t), { job: h } = armedJob(db.web, db.worker, 'halted');
  assert.ok(db.web.retireJob(db.web.getJob(h.id)!, null, testNow));
  const retired = db.web.getJob(h.id)!;
  assert.equal(auditSetJob(db.worker, retired, 'retired', testNow + 1, { reason: 'worker note' }), false);
  assert.equal(db.worker.casJob(h.id, 'retired', retired.version, 'retired', { reason: 'worker note' }), false);
  for (const to of ['stopping', 'cancelled', 'resuming', 'link_confirmed'] as const) {
    assert.equal(auditSetJob(db.web, retired, to, testNow + 1), false, to);
    assert.equal(db.web.casJob(h.id, 'retired', retired.version, to), false, to);
  }
  assert.deepEqual(db.web.getJob(h.id), retired);
  assert.equal(db.web.retireJob(retired, null, testNow + 2), false, 'a retired job is not retired twice');
  assert.deepEqual(db.web.getJob(h.id), retired);
});

test('AUDIT S-4 (H01, H02): the ceiling of 15 holds in both branches of draftProblems: 14 live jobs pass, 15 are refused', () => {
  const limit = 'A hire is already pending or the live job limit was reached.', near = 10n ** 24n;
  const input = { amountNear: '0.10', intervalSec: 3600, budgetNear: '0.20', end: { kind: 'budget' } }, settings = auditTradeSettings('schedule', input, testNow);
  assert.notEqual(settings, 'invalid');
  const trade = { session: { accountId: owner }, kind: 'schedule', mode: 'live', pair: 'trade-usdc', liveEnabled: true, tradeV1: true, trade: input, now: testNow, ownerPendingLive: 0,
    depositYocto: (auditTradePlan(settings as Exclude<typeof settings, 'invalid'>) + AUDIT_TRADE_RESERVE).toString() };
  const grid = { session: { accountId: owner }, kind: 'grid', mode: 'live', pair: 'usdc-wnear', liveEnabled: true, ownerPendingLive: 0, depositYocto: near.toString() };
  assert.equal(AUDIT_MONEY.maxLiveJobs, 15);
  for (const draft of [trade, grid]) {
    assert.deepEqual(auditDraftProblems({ ...draft, liveJobs: 14 }), [], draft.kind);
    assert.deepEqual(auditDraftProblems({ ...draft, liveJobs: 15 }), [limit], draft.kind);
  }
});
