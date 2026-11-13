import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import test from 'node:test';
import { YOCTO_PER_NEAR as N } from '../src/core/amounts.js';
import { tokenHash } from '../src/core/auth.js';
import { GRID_STEPS, gridProtectStep, gridSettingsFromRequest, gridStep, gridValue, lanePoints, parseGridSettings, type GridLane, type GridSettings, type GridState } from '../src/core/grid.js';
import { draftProblems } from '../src/core/hire.js';
import { USDC, WNEAR } from '../src/core/pins.js';
import { DCL_POOL, toNearDown, type DclOrder, type DclState } from '../src/core/rhea-dcl.js';
import { createHandler } from '../src/web/server.js';
import { agent, dummyRpc, fullAccess, owner, stores, testNow } from './helpers.js';
import { opRow } from './chain.js';

const settings: GridSettings = { v: 2, step: 90, orders: 4, stopLossPct: 10, takeProfitPct: 0 };
const lane: GridLane = { generation: 0, sell: USDC, amount: '0', orderId: null, native: false };
const lanes = (n: number) => Array.from({ length: n }, () => ({ ...lane }));
const v2State = (step = 90, extra: Partial<GridState> = {}): GridState => ({ anchor: 401_000, bootstrap: 3, lanes: lanes(4), sequence: 0, pending: null, v2: true, step, ...extra });
const v1State: GridState = { anchor: 401_000, bootstrap: 3, lanes: lanes(4), sequence: 0, pending: null };

test('Grid V2 settings: exact keys, the four presets and integer bounds', () => {
  assert.deepEqual(parseGridSettings(settings), settings);
  for (const step of Object.values(GRID_STEPS)) assert.notEqual(parseGridSettings({ ...settings, step }), 'invalid');
  assert.notEqual(parseGridSettings({ ...settings, orders: 2 }), 'invalid');
  for (const [field, values] of Object.entries({ v: [1, '2'], step: [100, 0, 46, '90'], orders: [3, 1, 0, 6, '4', null], stopLossPct: [-1, 91, 1.5, '1'], takeProfitPct: [-1, 501, 0.5, null] })) {
    for (const value of values) assert.equal(parseGridSettings({ ...settings, [field]: value }), 'invalid', `${field}: ${JSON.stringify(value)}`);
  }
  for (const field of Object.keys(settings)) { const copy = { ...settings } as Record<string, unknown>; delete copy[field]; assert.equal(parseGridSettings(copy), 'invalid'); }
  assert.equal(parseGridSettings({ ...settings, extra: 1 }), 'invalid');
  assert.deepEqual(gridSettingsFromRequest({ preset: 'tight', orders: 4, stopLossPct: 5, takeProfitPct: 3 }), { v: 2, step: 45, orders: 4, stopLossPct: 5, takeProfitPct: 3 });
  assert.deepEqual(gridSettingsFromRequest({ preset: 'volatile', orders: 2, stopLossPct: 0, takeProfitPct: 500 }), { v: 2, step: 300, orders: 2, stopLossPct: 0, takeProfitPct: 500 });
  for (const bad of [{ preset: 'other', orders: 4, stopLossPct: 0, takeProfitPct: 0 }, { preset: 'toString', orders: 4, stopLossPct: 0, takeProfitPct: 0 }, { preset: 'wide', orders: 4, stopLossPct: 0 },
    { preset: 'wide', orders: 4, stopLossPct: 0, takeProfitPct: 0, step: 45 }, { preset: 'wide', orders: 4, stopLossPct: '1', takeProfitPct: 0 }, { preset: 'wide', orders: 3, stopLossPct: 0, takeProfitPct: 0 },
    { preset: 'wide', stopLossPct: 0, takeProfitPct: 0 }, null, 'balanced']) {
    assert.equal(gridSettingsFromRequest(bad), 'invalid', JSON.stringify(bad));
  }
});

test('Grid step: one truth table over settings, the hire marker and the state', () => {
  assert.equal(gridStep(null, null, null), 100);
  assert.equal(gridStep(null, null, v1State), 100);
  assert.equal(gridStep(settings, '90', null), 90);
  assert.equal(gridStep(settings, '90', v2State(90)), 90);
  assert.equal(gridStep({ ...settings, orders: 2 }, '90', v2State(90, { lanes: lanes(2) })), 90);
  // Any copy missing or invalid while another says V2, or a mismatch.
  for (const [s, m, st] of [[null, '90', null], [settings, null, null], [null, null, v2State(90)], [null, null, { ...v1State, step: 100 }],
    ['invalid', '90', null], [settings, '45', null], [settings, '90', v1State], [settings, '90', v2State(45)], [settings, '90', { ...v2State(90), v2: undefined }], [settings, '90', v2State(90, { lanes: lanes(2) })], [{ ...settings, orders: 2 }, '90', v2State(90)],
    [null, null, { ...v1State, lanes: lanes(2) }]] as const) {
    assert.equal(gridStep(s, m, st as GridState | null), 'invalid', JSON.stringify([s, m, st]));
  }
});

test('Grid lane points follow the stored step and number of orders', () => {
  for (const step of [100, ...Object.values(GRID_STEPS)]) {
    assert.deepEqual([0, 1, 2, 3].map(i => lanePoints(1000, i, step, 4)), [[1000 + step, 1000], [1000 + 2 * step, 1000 + step], [1000 - step, 1000], [1000 - 2 * step, 1000 - step]]);
    assert.deepEqual([0, 1].map(i => lanePoints(1000, i, step, 2)), [[1000 + step, 1000], [1000 - step, 1000]]);
  }
});

function order(id: number, sell: string, original: bigint, remain: bigint, unclaimed: bigint): DclOrder {
  return { id: `${DCL_POOL}#${id}`, owner: agent, pool: DCL_POOL, sell, buy: sell === USDC ? WNEAR : USDC, point: 401_000, original,
    deposit: original, instant: 0n, remain, bought: unclaimed, unclaimed, cancelled: 0n, created: 1n };
}
function venue(orders: DclOrder[], assets: Record<string, bigint> = {}): DclState {
  return { point: 401_000, storage: { sponsor: owner, locked: N / 2n, slots: 40, orders: orders.length, positions: 0 }, active: orders, history: [],
    orders: Object.fromEntries(orders.map(o => [o.id, o])), assets, lost: {}, positions: 0, liquidities: [] };
}

test('Grid value counts wallet, DCL assets, remain and unclaimed on the right side once', () => {
  const snap = { spendable: 5n * N / 10n, tokens: { [WNEAR]: N / 10n, [USDC]: 1_000_000n } };
  const v = venue([order(1, USDC, 2_000_000n, 500_000n, N / 20n), order(2, WNEAR, N / 10n, N / 40n, 700_000n)], { [WNEAR]: N / 100n, [USDC]: 300_000n });
  const near = 5n * N / 10n + N / 10n + N / 100n + N / 40n + N / 20n;
  const usdc = 1_000_000n + 300_000n + 500_000n + 700_000n;
  assert.equal(gridValue(snap, v), near + toNearDown(usdc, 401_000));
  assert.equal(gridValue({ spendable: 0n, tokens: {} }, venue([])), 0n);
});

test('Grid protection confirms two breaches 5 to 30 minutes apart at later blocks', () => {
  const base = { deposit: N, settings, now: testNow, block: 100, runningSince: 0 };
  const low = N * 89n / 100n, ok = N * 95n / 100n;
  const first = gridProtectStep(null, { ...base, value: low });
  assert.equal(first.fire, false);
  assert.deepEqual(first.protect, { kind: 'stop-loss', since: testNow, block: 100 });
  assert.equal(gridProtectStep(first.protect, { ...base, value: low, now: testNow + 299_999, block: 101 }).fire, false);
  assert.equal(gridProtectStep(first.protect, { ...base, value: low, now: testNow + 300_000, block: 100 }).fire, false, 'same block never confirms');
  const fired = gridProtectStep(first.protect, { ...base, value: low, now: testNow + 300_000, block: 101 });
  assert.equal(fired.fire, true);
  assert.deepEqual(fired.protect?.fired, { kind: 'stop-loss', value: low.toString(), basis: N.toString(), block: 101, at: testNow + 300_000 });
  const late = gridProtectStep(first.protect, { ...base, value: low, now: testNow + 1_800_001, block: 200 });
  assert.equal(late.fire, false);
  assert.equal(late.protect?.since, testNow + 1_800_001, 'an observation older than 30 minutes restarts');
  assert.deepEqual(gridProtectStep(first.protect, { ...base, value: ok, now: testNow + 400_000, block: 150 }), { protect: null, fire: false });
  const resumed = gridProtectStep(first.protect, { ...base, value: low, now: testNow + 400_000, block: 150, runningSince: testNow + 1 });
  assert.equal(resumed.fire, false, 'a breach seen before Resume never confirms');
  assert.equal(resumed.protect?.since, testNow + 400_000);
  const tp = { ...settings, stopLossPct: 0, takeProfitPct: 5 };
  assert.equal(gridProtectStep(null, { ...base, settings: tp, value: N * 105n / 100n }).protect?.kind, 'take-profit');
  assert.equal(gridProtectStep(null, { ...base, settings: tp, value: N * 104n / 100n }).protect, null);
  const kindChange = gridProtectStep(first.protect, { ...base, settings: { ...settings, takeProfitPct: 5 }, value: N * 106n / 100n, now: testNow + 400_000, block: 150 });
  assert.equal(kindChange.fire, false);
  assert.equal(kindChange.protect?.kind, 'take-profit');
  assert.equal(gridProtectStep(null, { ...base, settings: { ...settings, stopLossPct: 0 }, value: 0n }).protect, null, 'both thresholds off');
  assert.equal(gridProtectStep(null, { ...base, value: N * 90n / 100n }).protect?.kind, 'stop-loss', 'the boundary is a breach');
});

test('Grid V2 hire: draft check, store row, marker and refusals', t => {
  const draft = { session: { accountId: owner }, kind: 'grid', pair: 'usdc-wnear', mode: 'live', depositYocto: N.toString(), liveEnabled: true, gridV1: true, liveJobs: 0, ownerPendingLive: 0 };
  const grid = { preset: 'balanced', orders: 4, stopLossPct: 10, takeProfitPct: 0 };
  assert.deepEqual(draftProblems({ ...draft, gridV2: true, grid }), []);
  assert.ok(draftProblems({ ...draft, gridV2: false, grid }).length, 'V2 flag off');
  assert.ok(draftProblems({ ...draft, gridV1: false, gridV2: true, grid }).length, 'V1 flag off');
  assert.ok(draftProblems({ ...draft, gridV2: true, grid: { ...grid, preset: 'x' } }).length);
  assert.deepEqual(draftProblems({ ...draft, kind: 'lp', lpV1: true, depositYocto: (12n * N / 10n).toString() }), [], 'a valid LP draft');
  assert.deepEqual(draftProblems({ ...draft, kind: 'lp', lpV1: true, depositYocto: (12n * N / 10n).toString(), gridV2: true, grid }), ['Choose valid Grid settings.']);
  assert.deepEqual(draftProblems(draft), [], 'no grid key is a V1 hire');

  const { web } = stores(t);
  const job = web.createJob({ owner, kind: 'grid', mode: 'live', pair: 'usdc-wnear', depositYocto: N, gridV1: true, gridSettings: settings }, testNow);
  assert.equal(job.gridV2, true);
  assert.deepEqual(web.gridSettings(job.id), settings);
  assert.equal(web.meta(`grid_v2:${job.id}`), '90');
  for (const bad of [{ kind: 'lp' as const, lpV1: true, gridV1: false }, { kind: 'grid' as const, gridV1: false }, { kind: 'grid' as const, gridV1: true, gridSettings: { ...settings, step: 100 } }]) {
    const { web: other } = stores(t);
    assert.throws(() => other.createJob({ owner, mode: 'live', pair: 'usdc-wnear', depositYocto: N, gridSettings: settings, ...bad }, testNow), /Invalid Grid settings/);
  }
  const { web: v1 } = stores(t);
  const plain = v1.createJob({ owner, kind: 'grid', mode: 'live', pair: 'usdc-wnear', depositYocto: N, gridV1: true }, testNow);
  assert.equal(plain.gridV2, false);
  assert.equal(v1.meta(`grid_v2:${plain.id}`), null);
});

test('Grid protect stop: worker only, lock, recorded state, enabled kind, then stopping with one alert', t => {
  const { web, worker } = stores(t);
  const created = web.createJob({ owner, kind: 'grid', mode: 'live', pair: 'usdc-wnear', depositYocto: N, gridV1: true, gridSettings: settings }, testNow);
  assert.ok(worker.casJob(created.id, 'draft', created.version, 'running'));
  assert.ok(worker.acquireWorkerLock(process.pid, testNow));
  const job = worker.getJob(created.id)!, from = v2State(90);
  assert.ok(worker.saveGrid(job, null, from));
  const fired = { kind: 'stop-loss' as const, value: '1', basis: N.toString(), block: 101, at: testNow + 300_000 };
  const to = { ...from, protect: { kind: 'stop-loss' as const, since: testNow, block: 100, fired } };
  assert.throws(() => web.gridProtectStop(job, from, to), /cannot perform/);
  // An operation in flight on the wallet, a journaled pending step, and no worker lock each refuse.
  const busy = opRow({ id: job.id, walletId: '' });
  assert.ok(worker.insertOp(busy));
  assert.equal(worker.gridProtectStop(job, from, to), false, 'operation in flight');
  assert.ok(worker.updateOp(busy.id, { state: 'finished' }));
  const pendingFrom: GridState = { ...from, pending: { id: `${job.id}:0`, kind: 'wrap', lane: null, amount: '1' } };
  assert.ok(worker.saveGrid(job, from, pendingFrom));
  assert.ok(worker.insertOp(opRow({ id: job.id, walletId: '' }, { state: 'finished', request: JSON.stringify({ step: `${job.id}:0` }) })));
  assert.equal(worker.gridProtectStop(job, pendingFrom, { ...to, pending: null, sequence: 1 }), false, 'journaled pending step');
  assert.ok(worker.saveGrid(job, pendingFrom, from));
  worker.releaseWorkerLock();
  assert.equal(worker.gridProtectStop(job, from, to), false, 'no worker lock');
  assert.ok(worker.acquireWorkerLock(process.pid, testNow));
  assert.equal(worker.gridProtectStop(job, from, { ...from, protect: { ...to.protect, fired: { ...fired, kind: 'take-profit' } } }), false, 'take profit is off');
  assert.equal(worker.gridProtectStop(job, { ...from, sequence: 9 }, to), false, 'state differs from the record');
  assert.equal(worker.gridProtectStop(job, from, { ...from, protect: { kind: 'stop-loss', since: testNow, block: 100 } }), false, 'not fired');
  assert.equal(worker.casJob(job.id, 'running', job.version, 'stopping'), false, 'the worker still cannot stop a job by itself');
  assert.equal(worker.gridProtectStop(job, from, to), true);
  const after = worker.getJob(job.id)!;
  assert.equal(after.state, 'stopping');
  assert.equal(after.reason, 'Grid protection confirmed. Stop and withdraw.');
  assert.deepEqual(worker.grid(job.id)?.state, to);
  assert.equal(worker.openAlerts(job.id).filter(a => a.kind === 'protect_stop').length, 1);
});

test('Grid V2 web: options need both flags and the hire stores settings only with them', async t => {
  async function setup(gridV2: boolean) {
    const { web } = stores(t);
    const run = createHandler({ store: web, rpc: dummyRpc(), now: () => testNow, provider: fullAccess,
      env: { host: '127.0.0.1', port: 8090, origin: 'https://app.test', liveHires: true, gridV1: true, gridV2 } });
    const token = 'c'.repeat(43);
    web.putSession(tokenHash(token), owner, testNow, testNow + 600_000);
    const request = async (path: string, method = 'GET', input?: unknown) => {
      const req = Object.assign(Readable.from(input === undefined ? [] : [Buffer.from(JSON.stringify(input))]), { url: path, method,
        headers: { host: 'app.test', origin: 'https://app.test', cookie: `fourlpha_session=${token}`, 'content-type': 'application/json' } }) as unknown as IncomingMessage;
      let out = '';
      const res = { statusCode: 200, setHeader: () => undefined, end: (text: string) => { out = text; } };
      await run(req, res as unknown as ServerResponse);
      return { status: res.statusCode, body: JSON.parse(String(out)) as { data: Record<string, unknown>; error?: { code: string } } };
    };
    return { web, request };
  }
  const hire = { kind: 'grid', mode: 'live', pair: 'usdc-wnear', depositYocto: N.toString(), grid: { preset: 'wide', orders: 2, stopLossPct: 15, takeProfitPct: 12 } };
  const on = await setup(true);
  assert.equal((await on.request('/api/hire/options')).body.data.gridV2, true);
  const r = await on.request('/api/jobs', 'POST', hire);
  assert.equal(r.status, 201);
  assert.deepEqual(on.web.gridSettings(String(r.body.data.id)), { v: 2, step: 150, orders: 2, stopLossPct: 15, takeProfitPct: 12 });
  const off = await setup(false);
  assert.equal((await off.request('/api/hire/options')).body.data.gridV2, false);
  assert.equal((await off.request('/api/jobs', 'POST', hire)).status, 400);
  for (const name of ['', 'x'.repeat(41), '<b>', 'a/b', 7]) assert.equal((await off.request('/api/jobs', 'POST', { ...hire, grid: undefined, name })).status, 400, JSON.stringify(name));
  const plain = await off.request('/api/jobs', 'POST', { ...hire, grid: undefined, name: '  My   Grid_01 ' });
  assert.equal(plain.status, 201);
  const saved = off.web.getJob(String(plain.body.data.id));
  assert.equal(saved?.gridV2, false);
  assert.equal(saved?.name, 'My Grid_01');
  assert.equal(on.web.getJob(String(r.body.data.id))?.name, null, 'no name sent, no name stored');
});
