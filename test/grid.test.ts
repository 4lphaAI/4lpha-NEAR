import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import test from 'node:test';
import { YOCTO_PER_NEAR as N } from '../src/core/amounts.js';
import { tokenHash, type Challenge } from '../src/core/auth.js';
import { exitReserve } from '../src/core/budget.js';
import { GRID_BOOTSTRAP, GRID_EVAL_MS } from '../src/core/grid.js';
import { advanceJob, processReveals, type WorkerDeps } from '../src/core/hire.js';
import { readHoldings } from '../src/core/holdings.js';
import { RpcUnavailable } from '../src/core/near-rpc.js';
import { AMBIGUOUS_SLOW_AFTER_MS, createLiveOps, exitBudget, reconcileWallet, RESEND_EVERY_MS } from '../src/core/ops.js';
import type { CallRequest, SubmitResult } from '../src/core/outlayer.js';
import { CLASSIC_EXCHANGE, DCL, GAS, MONEY, USDC, WNEAR } from '../src/core/pins.js';
import type { PolicyRules } from '../src/core/policy.js';
import { DCL_POOL, DCL_STORAGE, limitProceeds, readDcl } from '../src/core/rhea-dcl.js';
import { SecretString } from '../src/core/secrets.js';
import { openStore, WALLET_ALERT_HALT, type Job } from '../src/core/store.js';
import { watchOnce } from '../src/core/watchdog.js';
import { createHandler } from '../src/web/server.js';
import { chain } from './chain.js';
import { accepted, agent, dummyOutLayer, fullAccess, identity, owner, stores, testNow } from './helpers.js';

const P = 401_000, quote = 751295n, output = 750001n;
const r = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64');
const fn = (method_name: string, args: object, gas = 30_000_000_000_000n, deposit = 0n) => ({ FunctionCall: { method_name, args: r(args), gas: Number(gas), deposit: String(deposit) } });
const transfer = (n: bigint) => ({ Transfer: { deposit: String(n) } });
const event = (name: string, data: object) => `EVENT_JSON:${JSON.stringify({ standard: 'dcl.ref', version: '1.0.0', event: name, data: [data] })}`;
type Status = { SuccessValue: string } | { SuccessReceiptId: string } | { Failure: object };
const success = (value?: unknown) => ({ SuccessValue: value === undefined ? '' : r(value) });
type Action = ReturnType<typeof fn> | ReturnType<typeof transfer>;
interface Receipt { id: string; from: string; to: string; a: Action; status: Status; children?: string[]; logs?: string[]; }
function tx(root: Receipt, more: Receipt[], status = root.status) {
  const receipts = [root, ...more];
  return { final_execution_status: 'FINAL', status, transaction: { signer_id: agent, receiver_id: root.to, actions: [root.a] },
    transaction_outcome: { outcome: { tokens_burnt: '1', receipt_ids: [root.id] } },
    receipts: receipts.map(x => ({ receipt_id: x.id, predecessor_id: x.from, receiver_id: x.to, receipt: { Action: { actions: [x.a] } } })),
    receipts_outcome: receipts.map(x => ({ id: x.id, outcome: { executor_id: x.to, tokens_burnt: '0', status: x.status, receipt_ids: x.children ?? [], logs: x.logs ?? [] } })) };
}
function order(seq: number, sell: string, amount: bigint, point: number) {
  const n = String(amount);
  return { client_id: '', order_id: `${DCL_POOL}#${seq}`, owner_id: agent, pool_id: DCL_POOL, point, sell_token: sell,
    buy_token: sell === USDC ? WNEAR : USDC, original_deposit_amount: n, swap_earn_amount: '0', original_amount: n, cancel_amount: '0',
    created_at: String(seq), remain_amount: n, bought_amount: '0', unclaimed_amount: '0' as string | null };
}

function setup(t: Parameters<typeof stores>[0]) {
  const db = stores(t), c = chain(), origin = 'https://app.test';
  c.setPolicy(null); c.setHoldings({ native: 0n, wnear: 0n, usdc: 0n });
  c.registration.clear();
  const active = new Map<string, ReturnType<typeof order>>(), history = new Map<string, ReturnType<typeof order>>();
  const assets: Record<string, string> = {};
  let sponsor: string | null = null, current = P, clock = testNow, serial = 0, rules: PolicyRules | null = null, badBlock = false, gridWeb = true, gridWebV2 = true, dclVersion = '2.4.2';
  let mode: 'normal' | 'race' | 'immediate' | 'refund' | 'ambiguous' | 'unpaid' | 'wrapped' | 'quota' = 'normal';
  const submissions: { call: string; idem: string }[] = [];
  const rpc = { ...c.rpc,
    view: async (contract: string, method: string, args: Record<string, unknown>, blockId?: string) => {
      if (contract !== DCL) {
        if (method === 'estimate_wallet_policy_cost') return { height: c.height, blockId: `block-${c.height}`, value: '15000000000000000000000' };
        if (method === 'get_return') return { height: c.height, blockId: `block-${c.height}`, value: String(args.amount_in === N.toString() ? 3756475n : quote) };
        return c.rpc.view(contract, method, args, blockId);
      }
      assert.equal(blockId, `block-${c.height}`);
      let value: unknown;
      if (method === 'get_metadata') value = { version: dclVersion, state: 'Running' };
      else if (method === 'get_pool') value = { pool_id: DCL_POOL, token_x: USDC, token_y: WNEAR, fee: 100, point_delta: 1, state: 'Running', current_point: current };
      else if (method === 'storage_balance_bounds') value = { min: String(DCL_STORAGE), max: null };
      else if (method === 'get_user_storage_detail') value = sponsor === null ? null : { sponsor_id: sponsor, locked_near: String(DCL_STORAGE),
        storage_for_asset: String(N / 10n), slot_price: String(N / 100n), max_slots: 40, cur_order_slots: active.size, cur_liquidity_slots: 0 };
      else if (method === 'list_active_orders') value = [...active.values()].filter(o => o.remain_amount !== '0');
      else if (method === 'list_history_orders') value = [...history.values()];
      else if (method === 'get_order') value = active.get(String(args.order_id)) ?? null;
      else if (method === 'list_user_assets') value = { ...assets };
      else if (method === 'list_lostfound') value = {};
      else if (method === 'list_liquidities') value = [];
      else assert.fail(`Unexpected DCL view ${method}`);
      return { value, height: c.height, blockId: badBlock ? 'wrong-final-block' : blockId };
    } };
  const complete = (root: Receipt, child: Receipt[], move: { native?: bigint; wnear?: bigint; usdc?: bigint }, status?: Status) => {
    const hash = c.addTx(tx(root, child, status), c.height + 1, `grid-tx-${++serial}`);
    c.setHoldings({ ...move, height: c.height + 30 });
    return accepted(hash);
  };
  function payout(token: string, n: bigint, rs: Receipt[], parents: string[], wrapped = false) {
    if (!n) return;
    if (token === WNEAR && !wrapped) {
      parents.push('unwrap', 'near-callback');
      rs.push({ id: 'unwrap', from: DCL, to: WNEAR, a: fn('near_withdraw', { amount: String(n) }, 10n, 1n), status: success(), children: ['back'] },
        { id: 'back', from: WNEAR, to: DCL, a: transfer(n + 1n), status: success() },
        { id: 'near-callback', from: DCL, to: DCL, a: fn('callback_post_withdraw_near', { user_id: agent, amount: String(n) }), status: success(true), children: ['pay-near'] },
        { id: 'pay-near', from: DCL, to: agent, a: transfer(n), status: success() });
    } else {
      parents.push(`pay-${token}`, `callback-${token}`);
      rs.push({ id: `pay-${token}`, from: DCL, to: token, a: fn('ft_transfer', { receiver_id: agent, amount: String(n), memo: null }, 10n, 1n), status: success() },
        { id: `callback-${token}`, from: DCL, to: DCL, a: fn('callback_post_withdraw_asset', { token_id: token, user_id: agent, amount: String(n) }), status: success(true) });
    }
  }
  const liveCall = async (call: CallRequest, idem: string): Promise<SubmitResult> => {
    submissions.push({ call: call.methodName, idem });
    assert.deepEqual(Object.keys(call).sort(), ['args', 'deposit', 'gas', 'methodName', 'receiverId']);
    const root: Receipt = { id: 'root', from: agent, to: call.receiverId, a: fn(call.methodName, call.args, call.gas, call.deposit), status: success() };
    const n = BigInt(String(call.args.amount ?? call.deposit));
    if (call.methodName === 'near_deposit') return complete(root, [], { native: c.native - n - 1n, wnear: c.wnear + n });
    if (call.methodName === 'near_withdraw') {
      root.children = ['agent-near'];
      return complete(root, [{ id: 'agent-near', from: WNEAR, to: agent, a: transfer(n + 1n), status: success() }], { native: c.native + n - 1n, wnear: c.wnear - n });
    }
    if (call.methodName === 'ft_transfer') {
      assert.equal(call.args.receiver_id, owner);
      return complete(root, [], { native: c.native - 2n, usdc: c.usdc - n });
    }
    if (call.methodName === 'ft_transfer_call') {
      const sell = call.receiverId, to = String(call.args.receiver_id);
      if (to === DCL && mode === 'ambiguous') return { kind: 'ambiguous', reason: 'network' };
      if (to === DCL && mode === 'quota') return { kind: 'quota', retryAfterSeconds: 1 };
      const refunded = to === DCL && mode === 'refund';
      const used = refunded ? '0' : String(n);
      root.status = { SuccessReceiptId: 'resolve' }; root.children = ['receive', 'resolve'];
      const receive: Receipt = { id: 'receive', from: sell, to, a: fn('ft_on_transfer', { sender_id: agent, amount: String(n), msg: call.args.msg }), status: refunded ? { Failure: { ActionError: {} } } : success('0') };
      const receipts = [receive, { id: 'resolve', from: sell, to: sell, a: fn('ft_resolve_transfer', { sender_id: agent, receiver_id: to, amount: String(n) }), status: success(used) }];
      if (to === CLASSIC_EXCHANGE) {
        receive.children = ['swap-output'];
        receipts.push({ id: 'swap-output', from: to, to: USDC, a: fn('ft_transfer', { receiver_id: agent, amount: String(output) }, 10n, 1n), status: success() });
        return complete(root, receipts, { native: c.native - 2n, wnear: c.wnear - n, usdc: c.usdc + output }, success(used));
      }
      assert.equal(to, DCL);
      const { LimitOrderWithSwap: o } = JSON.parse(String(call.args.msg)) as { LimitOrderWithSwap: { point: number; buy_token: string } };
      const entry = order(serial + 1, sell, mode === 'immediate' ? n - 1n : n, o.point);
      entry.original_deposit_amount = String(n);
      entry.swap_earn_amount = mode === 'immediate' ? '1' : '0';
      if (!refunded) active.set(entry.order_id, entry);
      receive.logs = [event('swap', { pool_id: DCL_POOL, swapper: agent, token_in: sell, token_out: o.buy_token, amount_in: entry.swap_earn_amount,
        amount_out: entry.swap_earn_amount, total_fee: '0', protocol_fee: '0', referral_fee: '0', referral_id: null }), event('order_added', entry)];
      return complete(root, receipts, { native: c.native - 2n, usdc: c.usdc - (sell === USDC && !refunded ? n : 0n), wnear: c.wnear - (sell === WNEAR && !refunded ? n : 0n) }, success(used));
    }
    if (call.methodName === 'withdraw_asset') {
      const token = String(call.args.token_id), n = BigInt(assets[token]);
      const rs: Receipt[] = []; root.children = [];
      payout(token, n, rs, root.children);
      delete assets[token];
      return complete(root, rs, { native: c.native - 1n + (token === WNEAR ? n : 0n), usdc: c.usdc + (token === USDC ? n : 0n) });
    }
    assert.equal(call.methodName, 'cancel_order');
    const id = String(call.args.order_id), o = active.get(id)!;
    const claim = call.args.amount === '0', race = claim && mode === 'race', wrapped = mode === 'wrapped';
    const cancel = claim ? 0n : BigInt(o.remain_amount), bought = BigInt(o.unclaimed_amount ?? '0');
    const closed = { ...o, remain_amount: race ? '1' : '0', cancel_amount: String(BigInt(o.cancel_amount) + cancel), unclaimed_amount: race ? '0' : null };
    if (race) active.set(id, closed);
    else { active.delete(id); history.set(id, closed); }
    root.status = success([String(cancel), String(bought)]);
    root.logs = [event('order_cancelled', { ...closed, request_cancel_amount: claim ? '0' : null, actual_cancel_amount: String(cancel), cancel_at: '1' }),
      ...(!race ? [event('order_completed', { ...closed, completed_at: '1' })] : [])];
    const rs: Receipt[] = []; root.children = [];
    payout(o.sell_token, cancel, rs, root.children, wrapped);
    if (mode !== 'unpaid') payout(o.buy_token, bought, rs, root.children, wrapped);
    const usdc = o.sell_token === USDC ? cancel : mode === 'unpaid' ? 0n : bought;
    const near = o.sell_token === WNEAR ? cancel : mode === 'unpaid' ? 0n : bought;
    return complete(root, rs, { usdc: c.usdc + usdc, native: c.native + (wrapped ? 0n : near) - 1n, wnear: c.wnear + (wrapped ? near : 0n) });
  };
  const d: WorkerDeps = { store: db.worker, rpc, kek: Buffer.alloc(32, 3), now: () => clock, origin, live: true, gridV1: true, gridV2: true, provider: fullAccess,
    outlayer: dummyOutLayer({
      register: async () => ({ error: null, result: { walletId: 'wallet-grid', nearAccountId: agent, apiKey: new SecretString('wk_mock'), managementLink: new SecretString('https://example.test/mock') } }),
      encryptPolicy: async (_key, _id, r) => { rules = r; return { encryptedBase64: 'QUFBQQ==' }; },
      signPolicy: async (_key, _encrypted, caller) => { assert.equal(caller, owner); return { publicKeyHex: agent, signatureHex: 'b'.repeat(128), version: 1, locked: false, validUntil: 1794912708 }; },
      getPolicy: async () => ({ http: 200, policy: 'stored', rules, frozen: false, approval: null, capabilities: null }),
      call: async (_key, req, idem) => liveCall(req, idem),
      storageDeposit: async (_key, token, to, idem) => {
        submissions.push({ call: 'storage_deposit', idem });
        const account = to ?? agent;
        c.registration.add(`${token}:${account}`);
        return complete({ id: 'root', from: agent, to: token, a: fn('storage_deposit', { account_id: account, registration_only: true }, GAS.simpleCall, MONEY.storageDeposit), status: success() },
          [], { native: c.native - MONEY.storageDeposit - 1n });
      },
      transfer: async (_key, to, n, idem) => {
        submissions.push({ call: 'transfer', idem });
        assert.equal(to, owner);
        return complete({ id: 'root', from: agent, to, a: transfer(n), status: success() }, [], { native: c.native - n - 1n });
      },
    }) };
  d.store.acquireWorkerLock(process.pid, clock);
  db.watch.heartbeat('watchdog', clock);
  const session = 'a'.repeat(43), foreign = 'b'.repeat(43);
  db.web.putSession(tokenHash(session), owner, clock, clock + 600_000);
  db.web.putSession(tokenHash(foreign), 'foreign.near', clock, clock + 600_000);
  const request = async (path: string, input?: object, token = session) => {
    const run = createHandler({ store: db.web, rpc, now: d.now, env: { host: '127.0.0.1', port: 8090, origin, liveHires: true, gridV1: gridWeb, gridV2: gridWeb && gridWebV2 },
      provider: fullAccess, wait: () => processReveals(d) });
    const req = Object.assign(Readable.from(input === undefined ? [] : [Buffer.from(JSON.stringify(input))]), { url: path, method: input ? 'POST' : 'GET',
      headers: { host: 'app.test', origin, cookie: `fourlpha_session=${token}`, 'content-type': 'application/json' } });
    let response = '';
    const res = { statusCode: 200, setHeader() {}, end(text: string) { response = text; } };
    await run(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    return { status: res.statusCode, data: (JSON.parse(response) as { data: unknown }).data, text: response };
  };
  const tick = async (id: string) => { clock += 1000; db.watch.heartbeat('watchdog', clock); return advanceJob(d, id); };
  async function hire(extra: object = {}) {
    const input = { kind: 'grid', mode: 'live', pair: 'usdc-wnear', depositYocto: N.toString(), ...extra };
    assert.equal((await request('/api/jobs', { ...input, depositYocto: (N - 1n).toString() })).status, 400);
    const start = await request('/api/jobs', input);
    assert.equal(start.status, 201);
    const { id } = start.data as { id: string }, path = `/api/jobs/${id}`;
    assert.equal(db.web.getJob(id)?.gridV1, true);
    assert.equal(await advanceJob({ ...d, gridV1: false }, id), 'draft');
    assert.equal(await tick(id), 'registered');
    assert.equal(await tick(id), 'policy_prepared');
    assert.ok(db.web.getJob(id)?.rules?.addresses.list.includes(DCL));
    c.setPolicy({ owner, encrypted_data: 'QUFBQQ==', frozen: false, storage_deposit: '15000000000000000000000' });
    assert.equal(await tick(id), 'armed');
    const ch = (await request(`/api/challenge?purpose=reveal&job=${id}`)).data as Challenge;
    assert.equal((await request(`${path}/reveal`, { signed: identity()(ch) })).status, 200);
    assert.equal((await request(`${path}/link-confirmed`, { saved: true })).status, 200);
    return { id, path };
  }
  async function run(extra: object = {}) {
    const { id, path } = await hire(extra);
    const view = async () => (await request(path)).data as { canFund: boolean; grid: { canRegister: boolean; registered: boolean }; canStopEarly: boolean };
    assert.equal((await view()).canFund, false);
    assert.equal((await view()).grid.canRegister, true);
    // Public agent page (audit M-1): a visitor's answer never offers what the owner may do.
    const pub = async () => (await request(`/api/public/jobs/${id}`)).data as { canFund: boolean; canReveal: boolean; linkDelivered: boolean; payload: unknown; ownerBalance: unknown; grid: { canRegister: boolean } };
    assert.equal((await pub()).grid.canRegister, false);
    assert.equal((await request(`${path}/dcl-registration`, {}, foreign)).status, 404);
    badBlock = true;
    assert.equal((await view()).grid.canRegister, false);
    assert.equal((await request(`${path}/dcl-registration`, {})).status, 409);
    badBlock = false;
    // Any DCL version other than the pinned one blocks the read, so no registration is offered.
    dclVersion = '2.4.1';
    assert.equal((await view()).grid.canRegister, false);
    assert.equal((await request(`${path}/dcl-registration`, {})).status, 409);
    dclVersion = '2.4.2';
    const attempts = await Promise.all([request(`${path}/dcl-registration`, {}), request(`${path}/dcl-registration`, {})]);
    assert.deepEqual(attempts.map(a => a.status).sort(), [200, 409]);
    assert.deepEqual(attempts.find(a => a.status === 200)?.data, { receiverId: DCL, methodName: 'storage_deposit', gas: '50000000000000', deposit: String(DCL_STORAGE),
      args: { account_id: agent, registration_only: true }, caller: owner });
    assert.equal((await view()).canFund, false);
    sponsor = 'foreign.near';
    assert.equal((await view()).canFund, false);
    sponsor = owner;
    assert.equal((await view()).canFund, true);
    const owned = (await request(path)).data as { canReveal: boolean; linkDelivered: boolean; ownerBalance: unknown };
    assert.deepEqual([owned.canReveal, owned.linkDelivered, owned.ownerBalance === null], [true, true, false]);
    const visitor = await pub();
    assert.deepEqual([visitor.canFund, visitor.canReveal, visitor.linkDelivered, visitor.payload, visitor.ownerBalance], [false, false, false, null, null]);
    c.setHoldings({ native: N, height: c.height + 1 });
    assert.equal(await tick(id), 'funded');
    for (let i = 0; i < 3; i++) assert.equal(await tick(id), 'funded');
    assert.equal(await tick(id), 'ready');
    assert.equal(await tick(id), 'running');
    return { id, path };
  }
  function fill(id: string, bought: bigint, remain = 0n) {
    const o = active.get(id)!; o.remain_amount = String(remain); o.bought_amount = o.unclaimed_amount = String(bought);
    c.setHoldings({ height: c.height + 1 });
  }
  return { ...db, c, d, rpc, active, history, assets, tick, hire, run, request, submissions, fill, skip: (ms: number) => { clock += ms; }, setPoint: (v: number) => { current = v; },
    setMode: (v: typeof mode) => { mode = v; }, setSponsor: (v: string) => { sponsor = v; }, setWrongBlock: (v: boolean) => { badBlock = v; }, setWeb: (v: boolean) => { gridWeb = v; }, setWebV2: (v: boolean) => { gridWebV2 = v; }, setDclVersion: (v: string) => { dclVersion = v; } };
}

async function tickUntil(h: ReturnType<typeof setup>, id: string, ready: () => boolean) {
  for (let i = 0; i < 35 && !ready(); i++) await h.tick(id);
  assert.ok(ready(), h.worker.getJob(id)?.reason ?? 'Grid did not reach the expected checkpoint');
}

test('Grid route to four resting orders, restart replay, partial/full fill, native claim and reverse, then frozen exit', async t => {
  let restarted: ReturnType<typeof openStore> | undefined;
  t.after(() => restarted?.close());
  const h = setup(t), { id, path } = await h.run();
  await h.tick(id); await h.tick(id);
  const pending = h.worker.grid(id)!.state!.pending!;
  assert.equal(pending.kind, 'wrap');
  const ops = createLiveOps({ ...h.d, jobId: id });
  assert.equal((await ops.wrap(GRID_BOOTSTRAP)).verdict, 'success');
  assert.equal(h.worker.grid(id)?.state?.bootstrap, 0);
  h.worker.releaseWorkerLock();
  restarted = openStore(h.path, 'worker');
  assert.ok(restarted.acquireWorkerLock(process.pid, testNow)); h.d.store = restarted;
  await Promise.all([h.tick(id), h.tick(id)]);
  assert.equal(h.worker.grid(id)?.state?.bootstrap, 1);
  assert.equal(h.worker.gridStep(id, pending.id)?.verdict, 'success');
  assert.equal(h.submissions.filter(x => x.call === 'near_deposit').length, 1);
  await tickUntil(h, id, () => h.worker.grid(id)?.state?.pending?.kind === 'dcl_place');
  const p = h.worker.grid(id)!.state!.pending!;
  const firstPlace = await createLiveOps({ ...h.d, jobId: id }).placeDcl!(p.sell!, BigInt(p.amount), p.point!);
  assert.equal(firstPlace.verdict, 'success');
  assert.equal(h.worker.grid(id)?.state?.lanes[0].orderId, null);
  await h.tick(id); await h.tick(id);
  assert.ok(h.worker.grid(id)?.state?.lanes[0].orderId);
  assert.equal(h.active.size, 1);
  await tickUntil(h, id, () => h.active.size === 4);
  const s = h.worker.grid(id)!.state!;
  assert.equal(s.anchor, P);
  assert.deepEqual([...h.active.values()].map(o => o.point), [P + 100, P + 200, P - 100, P - 200]);
  assert.equal(h.c.usdc, 1n);
  assert.equal(h.c.wnear, 0n);
  assert.equal(h.submissions.filter(x => x.call === 'near_deposit').length, 2);
  assert.equal(h.submissions.filter(x => x.call === 'ft_transfer_call').length, 5);
  const old = s.lanes[0].orderId!, count = h.submissions.length;
  await watchOnce({ store: h.watch, rpc: h.rpc, now: h.d.now });
  h.fill(old, N / 25n, 1000n);
  await h.tick(id);
  assert.equal(h.submissions.length, count);
  assert.equal((await watchOnce({ store: h.watch, rpc: h.rpc, now: h.d.now })).some(a => a.severity !== 'info'), false);
  const bought = N / 10n + 123n;
  h.fill(old, bought); h.setPoint(P + 110);
  // The partial-fill tick above found nothing to do, so the idle job waits out its one-minute gate.
  h.skip(GRID_EVAL_MS);
  await tickUntil(h, id, () => h.worker.grid(id)?.state?.lanes[0].generation === 1 && !!h.worker.grid(id)?.state?.lanes[0].orderId);
  const reversed = h.worker.grid(id)!.state!.lanes[0];
  assert.equal(reversed.sell, WNEAR); assert.equal(reversed.amount, String(bought));
  assert.equal(h.active.get(reversed.orderId!)?.point, P);
  assert.deepEqual(h.submissions.slice(count).map(r => r.call), ['cancel_order', 'near_deposit', 'ft_transfer_call']);
  assert.equal((await watchOnce({ store: h.watch, rpc: h.rpc, now: h.d.now })).some(a => a.severity !== 'info'), false);
  h.c.freeze(true);
  assert.equal(await h.tick(id), 'frozen');
  h.setWeb(false); h.d.gridV1 = false;
  const lane3 = s.lanes[2].orderId!;
  h.fill(lane3, 380000n);
  const atFreeze = h.submissions.length;
  assert.equal((await h.request(`${path}/stop`, {})).status, 200);
  assert.equal(await h.tick(id), 'stopping');
  assert.equal(h.submissions.length, atFreeze);
  h.c.freeze(false);
  h.assets[USDC] = '20000'; h.assets[WNEAR] = String(N / 100n);
  await tickUntil(h, id, () => h.worker.getJob(id)?.state === 'stopped');
  assert.equal(h.active.size, 0); assert.equal(h.c.usdc, 0n); assert.equal(h.c.wnear, 0n);
  assert.deepEqual(h.assets, {});
  assert.equal(h.submissions.slice(atFreeze).filter(x => x.call === 'cancel_order').length, 4);
  assert.equal(h.submissions.slice(atFreeze).filter(x => x.call === 'withdraw_asset').length, 2);
  assert.equal(h.submissions.slice(atFreeze).filter(x => x.call === 'ft_transfer_call').length, 0);
  assert.equal(new Set(h.submissions.map(x => x.idem)).size, h.submissions.length);
});

test('Grid verifies passive fills across a read wait, then an owner can recover a legacy blind halt', async t => {
  const h = setup(t), { id, path } = await h.run();
  const pass = () => watchOnce({ store: h.watch, rpc: h.rpc, now: h.d.now });
  await tickUntil(h, id, () => h.worker.grid(id)?.state?.lanes.every(l => l.orderId !== null) === true);
  const lanes = h.worker.grid(id)!.state!.lanes, count = h.submissions.length;
  await pass();
  const baseline = h.watch.getWatch(id)!;
  h.c.setReadable(false);
  for (let i = 0; i < 4; i++) await pass();
  h.fill(lanes[0].orderId!, N / 10n);
  assert.equal(await h.tick(id), 'running');
  assert.equal(h.submissions.length, count);
  assert.deepEqual(h.watch.getWatch(id), baseline);
  assert.equal(((await h.request(path)).data as { waitingForChain: boolean }).waitingForChain, true);
  h.c.setReadable(true);
  assert.deepEqual(await pass(), []);
  assert.equal(h.watch.watchWaiting(id), false);
  assert.equal(h.watch.openAlerts(id).some(a => a.kind === 'blind'), false);

  const journal = h.worker.jobOps(id);
  h.watch.insertAlert({ jobId: id, kind: 'blind', severity: 'halt', detail: { message: 'Legacy blind halt.' }, createdAt: h.d.now() });
  assert.equal(await h.tick(id), 'halted');
  assert.equal(h.worker.getJob(id)?.reason, WALLET_ALERT_HALT);
  const challenge = `/api/challenge?purpose=resume&job=${id}`;
  assert.equal((await h.request(challenge)).status, 409);
  h.fill(lanes[1].orderId!, N / 10n);
  await h.tick(id);
  assert.deepEqual(await pass(), []);
  const view = await h.request(path);
  const resumeView = (data: unknown) => data as { canResumeBlind: boolean; resumeBlockedReason: string | null };
  assert.equal(resumeView(view.data).canResumeBlind, true);
  assert.equal(resumeView(view.data).resumeBlockedReason, null);
  assert.doesNotMatch(view.text, /hadBaseline|watch_clean|journal/);
  // Public agent page (audit M-1): the owner's recovery controls are not in a visitor's answer.
  const visitor = async () => (await h.request(`/api/public/jobs/${id}`)).data as { canResumeBlind: boolean; resumeBlockedReason: string | null };
  assert.equal((await visitor()).canResumeBlind, false);
  h.setDclVersion('2.4.1');
  assert.match(resumeView((await h.request(path)).data).resumeBlockedReason!, /Waiting for finalized DCL data/);
  assert.equal((await visitor()).resumeBlockedReason, null);
  h.setDclVersion('2.4.2');
  h.setSponsor('foreign.near');
  assert.match(resumeView((await h.request(path)).data).resumeBlockedReason!, /registration does not match/);
  h.setSponsor(owner);
  assert.equal((await h.request(challenge, undefined, 'b'.repeat(43))).status, 404);
  const c = (await h.request(challenge)).data as Challenge, signed = identity()(c);
  h.setWeb(false);
  const disabled = resumeView((await h.request(path)).data);
  assert.equal(disabled.canResumeBlind, false);
  assert.match(disabled.resumeBlockedReason!, /strategy is disabled/);
  assert.equal((await h.request(`${path}/resume`, { signed })).status, 409);
  assert.ok(h.web.getChallenge(c.nonce));
  h.setWeb(true);
  h.assets[USDC] = '1';
  assert.equal((await h.request(`${path}/resume`, { signed })).status, 409);
  assert.ok(h.web.getChallenge(c.nonce));
  delete h.assets[USDC];
  assert.equal((await h.request(`${path}/resume`, { signed })).status, 200);
  assert.equal(h.worker.getJob(id)?.state, 'resuming');
  assert.equal(h.web.getChallenge(c.nonce), null);
  assert.equal((await h.request(`${path}/resume`, { signed })).status, 409);
  assert.equal(h.watch.openAlerts(id).some(a => a.kind === 'blind'), false);
  assert.equal(await h.tick(id), 'ready');
  assert.equal(await h.tick(id), 'running');
  assert.deepEqual(h.worker.grid(id)?.state?.lanes, lanes);
  assert.deepEqual(h.worker.jobOps(id), journal);
  assert.equal(h.submissions.length, count);
  await tickUntil(h, id, () => h.worker.grid(id)?.state?.lanes.some(l => l.generation === 1) === true);
  assert.equal(h.submissions.slice(count).filter(r => r.call === 'cancel_order').length, 1);
});

test('same-point allocation pays but keeps the original lane and forbids a reverse', async t => {
  const h = setup(t), { id, path } = await h.run();
  await tickUntil(h, id, () => h.active.size === 4);
  const old = h.worker.grid(id)!.state!.lanes[0].orderId!;
  h.fill(old, N / 10n); h.setMode('race');
  const count = h.submissions.length;
  await tickUntil(h, id, () => h.worker.getJob(id)?.state === 'halted');
  const lane = h.worker.grid(id)!.state!.lanes[0];
  assert.equal(lane.orderId, old); assert.equal(lane.generation, 0);
  assert.equal(h.active.get(old)?.remain_amount, '1');
  const op = h.worker.jobOps(id).find(r => r.kind === 'dcl_claim')!;
  assert.equal(op.verdict, 'unclear'); assert.equal(op.nativeIn, N / 10n);
  assert.equal((await watchOnce({ store: h.watch, rpc: h.rpc, now: h.d.now })).some(a => a.kind === 'dcl_outflow'), false);
  assert.equal((await h.request(`${path}/resume`, {})).status, 409);
  await h.tick(id); assert.deepEqual(h.submissions.slice(count).map(r => r.call), ['cancel_order']);
  h.setMode('normal');
  assert.equal((await h.request(`${path}/stop`, {})).status, 200);
  await tickUntil(h, id, () => h.worker.getJob(id)?.state === 'stopped');
});

test('an unjournaled partial cancellation or claim halts Grid while preserving owner exit', async t => {
  for (const change of ['cancelled', 'claimed']) {
    const h = setup(t), { id, path } = await h.run();
    await tickUntil(h, id, () => h.active.size === 4);
    const orderId = h.worker.grid(id)!.state!.lanes[0].orderId!;
    const o = h.active.get(orderId)!;
    const bought = change === 'claimed' ? N / 20n : 0n;
    h.fill(orderId, bought, BigInt(o.original_amount) / 2n);
    if (change === 'claimed') o.unclaimed_amount = '0';
    else o.cancel_amount = String(BigInt(o.original_amount) - BigInt(o.remain_amount));
    const count = h.submissions.length;
    assert.equal(await h.tick(id), 'halted');
    assert.equal(h.submissions.length, count);
    assert.equal(h.worker.grid(id)?.state?.lanes[0].orderId, orderId);
    const alerts = await watchOnce({ store: h.watch, rpc: h.rpc, now: h.d.now });
    assert.equal(alerts.find(a => a.kind === 'dcl_outflow')?.detail.orderId, orderId);
    assert.equal((await h.request(`${path}/stop`, {})).status, 200);
    await tickUntil(h, id, () => h.worker.getJob(id)?.state === 'stopped');
  }
});

test('refund, immediate execution and unresolved placement never retry or authorize another lane', async t => {
  for (const mode of ['refund', 'immediate', 'ambiguous'] as const) await t.test(mode, async st => {
    const h = setup(st), { id, path } = await h.run();
    // Fix 4: an ambiguous placement re-sends under its own key (5, 15, 30 s, skipped here) before it quarantines.
    if (mode === 'ambiguous') Object.assign(h.d, { wait: async () => {} });
    h.setMode(mode);
    await tickUntil(h, id, () => h.worker.getJob(id)?.state === 'halted');
    const row = h.worker.jobOps(id).find(r => r.kind === 'dcl_place')!;
    assert.equal(row.verdict, mode === 'refund' ? 'refunded' : mode === 'immediate' ? 'unclear' : 'unknown');
    const count = h.submissions.length;
    await h.tick(id); await h.tick(id);
    assert.equal(h.submissions.length, count);
    if (mode === 'ambiguous') assert.equal((await h.request(`${path}/stop`, {})).status, 409);
    if (mode === 'immediate') {
      assert.equal(h.active.size, 1);
      h.setMode('normal');
      assert.equal((await h.request(`${path}/stop`, {})).status, 200);
      await tickUntil(h, id, () => h.worker.getJob(id)?.state === 'stopped');
    }
  });
});

test('ruling 2026-11-07: on an unpinned DCL version Stop and withdraw takes no DCL or wallet action', async t => {
  const h = setup(t), { id, path } = await h.run();
  await tickUntil(h, id, () => h.active.size === 4);
  const before = h.submissions.length, native = h.c.native, usdc = h.c.usdc;
  h.setDclVersion('2.4.1');
  assert.equal((await h.request(`${path}/stop`, {})).status, 200);
  for (let i = 0; i < 5; i++) await h.tick(id);
  assert.equal(h.worker.getJob(id)?.state, 'stopping');
  assert.equal(h.submissions.length, before);
  assert.equal(h.active.size, 4); assert.equal(h.c.native, native); assert.equal(h.c.usdc, usdc);
});

test('10.3 a failed DCL read in settlement does not finish the order as unclear', async t => {
  const h = setup(t), { id } = await h.run();
  await tickUntil(h, id, () => h.active.size === 4);
  const old = h.worker.grid(id)!.state!.lanes[0].orderId!, waits: number[] = [];
  Object.assign(h.d, { wait: async (ms: number) => { waits.push(ms); } });
  // Only the first DCL read after the claim is submitted fails, so the preflight reads are untouched.
  const { call } = h.d.outlayer, { view } = h.rpc;
  let failNext = false;
  h.d.outlayer.call = async (key, req, idem) => { const answer = await call(key, req, idem); failNext = req.methodName === 'cancel_order'; return answer; };
  h.rpc.view = async (contract, method, args, blockId) => {
    if (failNext && contract === DCL) { failNext = false; throw new RpcUnavailable(); }
    return view(contract, method, args, blockId);
  };
  h.fill(old, N / 10n + 123n); h.setPoint(P + 110);
  const before = h.submissions.length;
  await tickUntil(h, id, () => h.worker.jobOps(id).some(r => r.kind === 'dcl_claim'));
  const row = h.worker.jobOps(id).find(r => r.kind === 'dcl_claim')!;
  assert.equal(row.state, 'finished');
  assert.equal(row.verdict, 'success');
  assert.equal(h.worker.getJob(id)?.state, 'running');
  assert.deepEqual(waits, [5000]);
  assert.deepEqual(h.submissions.slice(before).map(x => x.call), ['cancel_order']);
});

test('Grid credits only the exact paid denomination; an unpaid claim cannot reverse', async t => {
  for (const mode of ['wrapped', 'unpaid'] as const) await t.test(mode, async st => {
    const h = setup(st), { id } = await h.run();
    await tickUntil(h, id, () => h.active.size === 4);
    const old = h.worker.grid(id)!.state!.lanes[0].orderId!;
    const amount = N / 10n + 1n, before = h.submissions.length;
    h.c.setHoldings({ wnear: N / 20n }); // Unrelated balance must not size the reverse.
    h.fill(old, amount); h.setPoint(P + 110); h.setMode(mode);
    if (mode === 'unpaid') {
      await tickUntil(h, id, () => h.worker.getJob(id)?.state === 'halted');
      assert.equal(h.worker.grid(id)?.state?.lanes[0].orderId, old);
      assert.deepEqual(h.submissions.slice(before).map(x => x.call), ['cancel_order']);
    } else {
      await tickUntil(h, id, () => h.worker.grid(id)?.state?.lanes[0].generation === 1 && !!h.worker.grid(id)?.state?.lanes[0].orderId);
      assert.equal(h.worker.grid(id)?.state?.lanes[0].amount, String(amount));
      assert.equal(h.c.wnear, N / 20n);
      assert.deepEqual(h.submissions.slice(before).map(x => x.call), ['cancel_order', 'ft_transfer_call']);
    }
  });
});

test('Grid preflight preserves the reserve, replans an uncrossed lane and uses a fresh key after quota', async t => {
  const h = setup(t), { id } = await h.run();
  const funded = h.c.native;
  h.c.setHoldings({ native: N * 45n / 100n });
  const setupCalls = h.submissions.length;
  for (let i = 0; i < 3; i++) await h.tick(id);
  assert.equal(h.submissions.length, setupCalls);
  assert.match(h.worker.getJob(id)?.reason ?? '', /preserve the DCL exit reserve/);
  h.c.setHoldings({ native: funded }); h.skip(GRID_EVAL_MS);
  await tickUntil(h, id, () => h.worker.grid(id)?.state?.pending?.kind === 'dcl_place');
  const crossed = h.worker.grid(id)!.state!.pending!, count = h.submissions.length;
  assert.equal(crossed.point, P + 100);
  h.setPoint(P + 100);
  await h.tick(id);
  assert.equal(h.worker.gridStep(id, crossed.id), null);
  assert.equal(h.worker.grid(id)?.state?.pending, null);
  assert.equal(h.submissions.length, count);
  h.skip(GRID_EVAL_MS); h.setMode('quota'); await h.tick(id); await h.tick(id);
  assert.equal(h.active.size, 0);
  const retry = h.worker.jobOps(id).find(r => r.verdict === 'quota')!;
  assert.ok(retry);
  h.setMode('normal');
  await tickUntil(h, id, () => h.active.size === 1);
  assert.equal([...h.active.values()][0].point, P + 200);
  assert.notEqual(h.worker.jobOps(id).find(r => r.kind === 'dcl_place' && r.verdict === 'success')?.idemKey, retry.idemKey);
  await h.tick(id);
  const unknown = order(1000, WNEAR, 123n, P - 10);
  h.active.set(unknown.order_id, unknown);
  const before = h.submissions.length;
  h.skip(GRID_EVAL_MS); await h.tick(id); await h.tick(id);
  assert.equal(h.submissions.length, before);
  assert.equal(h.worker.getJob(id)?.state, 'halted');
});

test('registration/owner/watchdog gates and reserved native and USDC chunks include DCL balances', async t => {
  const h = setup(t), { id, path } = await h.hire();
  h.c.setHoldings({ native: N, height: h.c.height + 1 });
  assert.equal(await h.tick(id), 'link_confirmed');
  assert.equal((await h.request(`${path}/dcl-registration`, {})).status, 409);
  assert.equal((await h.request(`${path}/cancel`, {})).status, 409);
  assert.equal((await h.request(`${path}/stop`, {}, 'b'.repeat(43))).status, 404);
  h.setSponsor(owner);
  const j = h.worker.getJob(id) as Job;
  h.assets[USDC] = '20000000'; h.assets[WNEAR] = String(3n * N);
  const snap = await readHoldings(h.rpc, agent, [USDC, WNEAR]);
  const state = await readDcl(h.rpc, agent, snap);
  const base = await exitBudget(h.rpc, j, snap, 0n, { ...state, assets: {} });
  const full = await exitBudget(h.rpc, j, snap, 0n, state);
  assert.equal(full.native - base.native, 3n * N);
  assert.equal(full.reserve, 6 + exitReserve({ sweepYocto: snap.spendable - MONEY.sweepReserve + 3n * N, nativePerTx: j.caps!.nativePerTx,
    wnear: 3n * N, wnearPerTx: j.caps!.tokenPerTx[WNEAR], tokens: [{ balance: 20_000_000n, perTx: j.caps!.tokenPerTx[USDC] }] }));
  assert.ok(full.reserve > base.reserve + 12);
  const empty = { ...state, assets: {} };
  assert.equal((await exitBudget(h.rpc, j, snap, 0n, empty, { wrap: N / 5n })).native, base.native);
  assert.ok((await exitBudget(h.rpc, j, snap, 0n, empty, { place: { sell: USDC, raw: 375000n, point: P } })).reserve > base.reserve);
  assert.equal(limitProceeds(USDC, 10000n, 1), 10001n);
  assert.equal(limitProceeds(WNEAR, 10001n, 1), 10001n); // Upper rounding includes fixed-point rounding.
  h.setWrongBlock(true);
  await watchOnce({ store: h.watch, rpc: h.rpc, now: h.d.now });
  assert.equal(h.worker.meta(`watch_blind:${id}`), '1');
  h.setWrongBlock(false);
  h.active.set(`${DCL_POOL}#1000`, order(1000, USDC, 123n, P + 10));
  assert.ok((await watchOnce({ store: h.watch, rpc: h.rpc, now: h.d.now })).some(a => a.kind === 'dcl_holding'));
  assert.equal((await h.request(`${path}/stop`, {})).status, 200);
});

test('Grid V2 Tight Scalp: settings and marker at hire, four resting orders at the 45-point offsets, step written in the state', async t => {
  const h = setup(t);
  const { id } = await h.run({ grid: { preset: 'tight', orders: 4, stopLossPct: 0, takeProfitPct: 0 } });
  assert.equal(h.worker.getJob(id)?.gridV2, true);
  assert.equal(h.worker.meta(`grid_v2:${id}`), '45');
  await tickUntil(h, id, () => h.active.size === 4);
  const s = h.worker.grid(id)!.state!;
  assert.equal(s.v2, true);
  assert.equal(s.step, 45);
  assert.deepEqual([...h.active.values()].map(o => o.point), [P + 45, P + 90, P - 45, P - 90]);
});

test('Grid V2 refuses to act when the worker flag is off, and halts when a copy of its identity is lost', async t => {
  const h = setup(t);
  const { id } = await h.run({ grid: { preset: 'balanced', orders: 4, stopLossPct: 0, takeProfitPct: 0 } });
  await h.tick(id);
  const before = h.submissions.length;
  await advanceJob({ ...h.d, gridV2: false }, id);
  assert.equal(h.worker.getJob(id)?.reason, 'Grid V2 is disabled. An owner can still freeze or stop and withdraw.');
  assert.equal(h.submissions.length, before);
  await assert.rejects(createLiveOps({ ...h.d, gridV2: false, jobId: id }).wrap(GRID_BOOTSTRAP), /Grid operations are disabled/);
  h.worker.setMeta(`grid_v2:${id}`, '45');
  await h.tick(id);
  assert.equal(h.worker.getJob(id)?.state, 'halted');
  assert.equal(h.worker.getJob(id)?.reason, 'Grid settings are unreadable. Stop and withdraw.');
  assert.equal(h.submissions.length, before);
});

test('Grid V2 stop loss fires through the protect stop after two observations at least 5 minutes apart', async t => {
  const h = setup(t);
  const { id } = await h.run({ grid: { preset: 'balanced', orders: 4, stopLossPct: 90, takeProfitPct: 0 } });
  await tickUntil(h, id, () => h.worker.grid(id)?.state?.bootstrap === 3);
  // Drop the measured value far below 10 % of the deposit: the agent's NEAR and USDC leave the snapshot.
  h.c.setHoldings({ native: N / 100n, wnear: 0n, usdc: 0n, height: h.c.height + 1 });
  await h.tick(id);
  const first = h.worker.grid(id)?.state?.protect;
  assert.equal(first?.kind, 'stop-loss');
  assert.equal(h.worker.getJob(id)?.state, 'running');
  for (let i = 0; i < 400 && h.worker.getJob(id)?.state === 'running'; i++) { h.c.setHoldings({ height: h.c.height + 1 }); await h.tick(id); }
  const job = h.worker.getJob(id)!;
  assert.equal(job.state, 'stopping');
  assert.equal(job.reason, 'Grid protection confirmed. Stop and withdraw.');
  assert.ok(h.worker.grid(id)?.state?.protect?.fired);
  assert.equal(h.worker.grid(id)?.state?.pending, null, 'a fire clears any unsubmitted step');
  assert.equal(h.worker.openAlerts(id).filter(a => a.kind === 'protect_stop').length, 1);
});

test('Grid V2 with two orders: one lane each side holding the whole bootstrap, points P+step and P-step, never a third order', async t => {
  const h = setup(t);
  const { id } = await h.run({ grid: { preset: 'wide', orders: 2, stopLossPct: 0, takeProfitPct: 0 } });
  await tickUntil(h, id, () => h.active.size === 2);
  for (let i = 0; i < 5; i++) await h.tick(id);
  assert.equal(h.active.size, 2);
  const s = h.worker.grid(id)!.state!;
  assert.equal(s.lanes.length, 2);
  assert.deepEqual(s.lanes.map(l => l.sell), [USDC, WNEAR]);
  assert.equal(s.lanes[0].amount, output.toString(), 'the one USDC lane holds the whole proven output');
  assert.equal(s.lanes[1].amount, GRID_BOOTSTRAP.toString());
  assert.deepEqual([...h.active.values()].map(o => o.point), [P + 150, P - 150]);
  assert.equal(h.worker.getJob(id)?.state, 'running');
});

test('Grid V2 two orders: a NEAR payout at the native per-transaction cap halts the job and submits no wrap', async t => {
  const h = setup(t);
  const { id } = await h.run({ grid: { preset: 'wide', orders: 2, stopLossPct: 0, takeProfitPct: 0 } });
  await tickUntil(h, id, () => h.active.size === 2);
  const usdcOrder = h.worker.grid(id)!.state!.lanes[0].orderId!;
  // Repeated reinvested round trips can grow a lane payout to the 0.25 NEAR cap (spec 2c section 12).
  h.fill(usdcOrder, N / 4n); h.setPoint(P + 160);
  await tickUntil(h, id, () => h.worker.getJob(id)?.state === 'halted' || h.worker.grid(id)?.state?.lanes[0].native === true);
  const wraps = h.submissions.filter(x => x.call === 'near_deposit').length;
  for (let i = 0; i < 5 && h.worker.getJob(id)?.state !== 'halted'; i++) await h.tick(id);
  const job = h.worker.getJob(id)!;
  assert.equal(job.state, 'halted');
  assert.equal(job.reason, 'The lane payout exceeds the signed wrap cap. Stop and withdraw to recover it.');
  assert.equal(h.submissions.filter(x => x.call === 'near_deposit').length, wraps, 'no wrap was submitted for the capped payout');
});


test('Grid V2 runbook branch A offline: V2 freeze with resting orders, unfreeze, Resume, fresh observation, then fire and exit', async t => {
  const h = setup(t);
  const { id, path } = await h.run({ grid: { preset: 'tight', orders: 4, stopLossPct: 5, takeProfitPct: 0 } });
  await tickUntil(h, id, () => h.active.size === 4);
  assert.equal(h.worker.grid(id)?.state?.protect ?? null, null, 'no breach before the value drops');
  // Lower the value by 0.06 NEAR: the 5 % stop loss is breached and readiness keeps its free NEAR.
  h.c.setHoldings({ native: h.c.native - 6n * N / 100n, height: h.c.height + 1 });
  h.skip(GRID_EVAL_MS);
  assert.equal(await h.tick(id), 'running');
  const first = h.worker.grid(id)!.state!.protect!;
  assert.equal(first.kind, 'stop-loss');
  assert.equal(first.fired, undefined);
  // The owner freezes while four orders rest. More than 5 minutes pass frozen.
  h.c.freeze(true);
  h.skip(GRID_EVAL_MS);
  assert.equal(await h.tick(id), 'frozen');
  const atFreeze = h.submissions.length;
  for (let i = 0; i < 320; i++) { h.c.setHoldings({ height: h.c.height + 1 }); assert.equal(await h.tick(id), 'frozen'); }
  assert.equal(h.submissions.length, atFreeze, 'no agent transaction while frozen');
  assert.equal(h.active.size, 4);
  h.c.freeze(false);
  assert.equal(await h.tick(id), 'paused');
  assert.equal(h.worker.getJob(id)?.reason, 'Unfrozen. Sign a resume request to run the readiness checks again.');
  const ch = (await h.request(`/api/challenge?purpose=resume&job=${id}`)).data as Challenge;
  assert.equal((await h.request(`${path}/resume`, { signed: identity()(ch) })).status, 200);
  await tickUntil(h, id, () => h.worker.getJob(id)?.state === 'running');
  const since = Number(h.worker.meta(`grid_running_since:${id}`));
  assert.ok(since > first.since + 300_000, 'running-since is written at Resume, more than 5 minutes after the first breach');
  // First tick after Resume: the old breach must not confirm.
  h.c.setHoldings({ height: h.c.height + 1 });
  assert.equal(await h.tick(id), 'running');
  const fresh = h.worker.grid(id)!.state!.protect!;
  assert.equal(fresh.fired, undefined);
  assert.ok(fresh.since >= since, 'a fresh observation starts after Resume');
  assert.equal(h.submissions.length, atFreeze, 'four orders still rest, nothing new was placed');
  // It fires 5 minutes after the fresh observation, not before.
  let ticks = 0;
  while (h.worker.getJob(id)?.state === 'running' && ticks < 400) { h.c.setHoldings({ height: h.c.height + 1 }); await h.tick(id); ticks++; }
  const job = h.worker.getJob(id)!;
  assert.equal(job.state, 'stopping');
  assert.equal(job.reason, 'Grid protection confirmed. Stop and withdraw.');
  assert.ok(ticks >= 299, `fired after ${ticks} one-second ticks`);
  const fired = h.worker.grid(id)!.state!.protect!.fired!;
  assert.ok(fired.at - fresh.since >= 300_000);
  // The worker's own exit closes the four orders and pays the owner.
  await tickUntil(h, id, () => h.worker.getJob(id)?.state === 'stopped');
  assert.equal(h.active.size, 0);
  assert.equal(h.submissions.slice(atFreeze).filter(x => x.call === 'cancel_order').length, 4);
});

test('Grid V2 two orders: the USDC lane fills and reverses at the anchor', async t => {
  const h = setup(t);
  const { id } = await h.run({ grid: { preset: 'wide', orders: 2, stopLossPct: 0, takeProfitPct: 0 } });
  await tickUntil(h, id, () => h.active.size === 2);
  const usdcOrder = h.worker.grid(id)!.state!.lanes[0].orderId!;
  const bought = N / 5n + 777n;
  h.fill(usdcOrder, bought); h.setPoint(P + 160);
  await tickUntil(h, id, () => h.worker.grid(id)?.state?.lanes[0].generation === 1 && !!h.worker.grid(id)?.state?.lanes[0].orderId);
  const lane = h.worker.grid(id)!.state!.lanes[0];
  assert.equal(lane.sell, WNEAR);
  assert.equal(lane.amount, String(bought));
  assert.equal(h.active.get(lane.orderId!)?.point, P, 'the reverse rests at the anchor');
  assert.equal(h.active.size, 2);
  assert.equal(h.worker.getJob(id)?.state, 'running');
});


test('Grid V2 exit stays available with the worker V2 flag off', async t => {
  const h = setup(t);
  const { id, path } = await h.run({ grid: { preset: 'balanced', orders: 4, stopLossPct: 0, takeProfitPct: 0 } });
  await tickUntil(h, id, () => h.active.size === 4);
  h.d.gridV2 = false;
  const before = h.submissions.length;
  assert.equal(await h.tick(id), 'running');
  assert.equal(h.worker.getJob(id)?.reason, 'Grid V2 is disabled. An owner can still freeze or stop and withdraw.');
  assert.equal(h.submissions.length, before);
  assert.equal((await h.request(`${path}/stop`, {})).status, 200);
  await tickUntil(h, id, () => h.worker.getJob(id)?.state === 'stopped');
  assert.equal(h.active.size, 0);
  assert.equal(h.submissions.slice(before).filter(x => x.call === 'cancel_order').length, 4);
});

test('Grid V2 with the web V2 switch off: no DCL registration or funding is offered for an existing V2 job', async t => {
  const h = setup(t);
  const { path } = await h.hire({ grid: { preset: 'balanced', orders: 4, stopLossPct: 0, takeProfitPct: 0 } });
  const view = async () => (await h.request(path)).data as { canFund: boolean; grid: { canRegister: boolean } };
  assert.equal((await view()).grid.canRegister, true);
  h.setWebV2(false);
  assert.equal((await view()).grid.canRegister, false);
  assert.equal((await h.request(`${path}/dcl-registration`, {})).status, 409);
  h.setWebV2(true); h.setSponsor(owner);
  assert.equal((await view()).canFund, true);
  h.setWebV2(false);
  assert.equal((await view()).canFund, false);
});

test('an idle Grid job reads the chain once a minute; a pending step and a busy tick are never delayed', async t => {
  const h = setup(t), { id } = await h.run();
  await tickUntil(h, id, () => h.active.size === 4);
  let reads = 0;
  const real = h.rpc.view;
  h.rpc.view = async (contract, method, args, blockId) => { reads++; return real(contract, method, args, blockId); };
  // The tick that placed the fourth order was busy, so the next tick reads at once and finds nothing to do.
  reads = 0; assert.equal(await h.tick(id), 'running'); assert.ok(reads > 0);
  assert.equal(h.worker.getJob(id)?.reason, 'Waiting for a full fill or an available resting price and slot.');
  for (let i = 0; i < 5; i++) { reads = 0; h.skip(10_000); assert.equal(await h.tick(id), 'running'); assert.equal(reads, 0); }
  reads = 0; h.skip(GRID_EVAL_MS); await h.tick(id); assert.ok(reads > 0);
  // A pending step is submitted on the very next tick, even with the gate freshly armed.
  const old = h.worker.grid(id)!.state!.lanes[0].orderId!, sent = h.submissions.length;
  h.fill(old, N / 10n + 123n); h.setPoint(P + 110);
  h.skip(GRID_EVAL_MS); await h.tick(id);
  assert.equal(h.worker.grid(id)?.state?.pending?.kind, 'dcl_claim');
  h.worker.setMeta(`grid_eval:${id}`, String(h.d.now()));
  await h.tick(id);
  h.worker.setMeta(`grid_eval:${id}`, '0');
  assert.deepEqual(h.submissions.slice(sent).map(x => x.call), ['cancel_order']);
  // The claim's follow-up steps (wrap, then place the reverse) run tick after tick with no one-minute wait.
  await tickUntil(h, id, () => h.worker.grid(id)?.state?.lanes[0].generation === 1 && !!h.worker.grid(id)?.state?.lanes[0].orderId);
  assert.deepEqual(h.submissions.slice(sent).map(x => x.call), ['cancel_order', 'near_deposit', 'ft_transfer_call']);
  h.rpc.view = real;
});

test('Grid V1 job view carries the job value under the order gate and null when the gate fails', async t => {
  const h = setup(t), { path } = await h.run();
  const value = async () => ((await h.request(path)).data as { grid: { value: string | null } }).grid.value;
  assert.match(String(await value()), /^\d+$/);
  h.setDclVersion('2.4.1');
  assert.equal(await value(), null);
});

// Retire spec 2 and 4: a halted Grid job retires only once its wallet and DCL hold dust, and its old unresolved row is closed with it.
test('Retire: a halted Grid job with an unresolved placement retires only after an hour and only with dust left', async t => {
  const h = setup(t), { id, path } = await h.run();
  h.setMode('ambiguous');
  await tickUntil(h, id, () => h.worker.getJob(id)?.state === 'halted');
  h.setMode('normal');
  const row = h.worker.jobOps(id).find(r => r.kind === 'dcl_place' && r.state === 'ambiguous')!;
  assert.ok(row, 'the unresolved placement is journaled');
  const retire = async () => {
    const r = await h.request(`${path}/retire`, {});
    return { status: r.status, message: (JSON.parse(r.text) as { error?: { message: string } }).error?.message ?? null };
  };
  assert.deepEqual(await retire(), { status: 409, message: 'An operation is still unresolved. Try again later.' });
  const raw = new DatabaseSync(h.path);
  try { raw.prepare('UPDATE ops SET submitted_at=? WHERE id=?').run(row.submittedAt! - AMBIGUOUS_SLOW_AFTER_MS, row.id); } finally { raw.close(); }
  assert.deepEqual(await retire(), { status: 409, message: 'The agent wallet still holds funds. Use Stop and withdraw or the management link first.' });
  h.c.setHoldings({ native: N / 50n, wnear: 0n, usdc: 0n, height: h.c.height + 1 });
  assert.equal((await retire()).status, 409, '0.02 NEAR is not dust');
  h.c.setHoldings({ native: N / 100n, wnear: 0n, usdc: 1n, height: h.c.height + 1 });
  assert.equal((await retire()).status, 409, 'any token is not dust');
  h.c.setHoldings({ native: N / 100n, wnear: 0n, usdc: 0n, height: h.c.height + 1 });
  h.assets[USDC] = '1';
  assert.equal((await retire()).status, 409, 'a DCL asset is not dust');
  delete h.assets[USDC];
  h.active.clear();
  h.setWrongBlock(true);
  assert.deepEqual(await retire(), { status: 503, message: 'Could not verify the agent wallet. Try again.' });
  h.setWrongBlock(false);
  assert.equal(h.worker.getJob(id)?.state, 'halted', 'no refusal changes the job');
  assert.equal(h.worker.inFlightOp(row.walletId)?.id, row.id, 'no refusal closes the row');
  assert.deepEqual(await retire(), { status: 200, message: null });
  const job = h.worker.getJob(id)!, closed = h.worker.jobOps(id).find(r => r.id === row.id)!;
  assert.equal(job.state, 'retired');
  assert.equal(job.reason, 'Retired by the owner. The agent wallet held only dust.');
  assert.equal(closed.state, 'finished'); assert.equal(closed.verdict, 'unknown');
  assert.equal(closed.message, 'Closed at retire. This submission was never resolved; the wallet held only dust.');
  assert.equal(h.worker.activeJobs().some(j => j.id === id), false, 'the worker and the watchdog no longer read it');
  assert.equal(h.worker.inFlightOps().length, 0, 'no reconcile is left for it');
  assert.equal(h.worker.jobCounts(owner).live, 0, 'it no longer holds a live slot');
  assert.deepEqual(await retire(), { status: 409, message: 'Only a halted, paused or frozen job can be retired.' });
});

test('Retire: a running Grid job is refused and stays running', async t => {
  const h = setup(t), { id, path } = await h.run();
  const r = await h.request(`${path}/retire`, {});
  assert.equal(r.status, 409);
  assert.equal((JSON.parse(r.text) as { error: { message: string } }).error.message, 'Only a halted, paused or frozen job can be retired.');
  assert.equal(h.worker.getJob(id)?.state, 'running');
});

// ---------------------------------------------------------------------------------------------------------------------
// AUDIT 2026-11-12 (Retire, 15 live jobs, no hidden agents), probes for the route mutation survivors.
// Each test PASSES on 2b09553 and fails on the named mutants.
// Paste at the end of test/grid.test.ts (it uses that file's harness and imports; no new import is needed).
// ---------------------------------------------------------------------------------------------------------------------
const AUDIT_HELD = 'The agent wallet still holds funds. Use Stop and withdraw or the management link first.';
const AUDIT_UNRESOLVED = 'An operation is still unresolved. Try again later.';

/** A halted Grid job whose placement got no answer, with the row two hours old and the wallet and DCL at dust: retire would be accepted. */
async function auditRetirable(t: Parameters<typeof stores>[0]) {
  const h = setup(t), { id, path } = await h.run();
  h.setMode('ambiguous');
  await tickUntil(h, id, () => h.worker.getJob(id)?.state === 'halted');
  h.setMode('normal');
  const row = h.worker.jobOps(id).find(r => r.state === 'ambiguous')!;
  assert.ok(row, 'the unresolved row is journaled');
  /** Sets the row's age in ms at the harness clock; null clears its submit time. */
  const age = (ms: number | null) => {
    const raw = new DatabaseSync(h.path);
    try { raw.prepare('UPDATE ops SET submitted_at=? WHERE id=?').run(ms === null ? null : h.d.now() - ms, row.id); } finally { raw.close(); }
  };
  age(2 * AMBIGUOUS_SLOW_AFTER_MS);
  h.active.clear();
  for (const token of Object.keys(h.assets)) delete h.assets[token];
  const dust = (over: { wnear?: bigint; usdc?: bigint; native?: bigint } = {}) => h.c.setHoldings({ native: N / 100n, wnear: 0n, usdc: 0n, ...over, height: h.c.height + 1 });
  dust();
  // The DCL lost-found list and the position list of the harness are fixed; these two hooks let a probe fill them.
  const venue: { lost: Record<string, string>; positions: unknown[] } = { lost: {}, positions: [] };
  const view = h.rpc.view;
  h.rpc.view = async (contract, method, args, blockId) => {
    const r = await view(contract, method, args, blockId);
    return contract === DCL && method === 'list_lostfound' ? { ...r, value: { ...venue.lost } } : contract === DCL && method === 'list_liquidities' ? { ...r, value: [...venue.positions] } : r;
  };
  const retire = async (token?: string) => {
    const r = await h.request(`${path}/retire`, {}, token);
    return { status: r.status, message: (JSON.parse(r.text) as { error?: { message: string } }).error?.message ?? null };
  };
  const untouched = (note: string) => {
    assert.equal(h.worker.getJob(id)?.state, 'halted', note);
    assert.equal(h.worker.inFlightOp(row.walletId)?.id, row.id, note);
  };
  return { h, id, path, row, age, dust, venue, retire, untouched };
}

test('AUDIT R-1 (S03, S04, S06, S07): the unresolved row must be ambiguous, carry a submit time and be at least one hour old', async t => {
  const a = await auditRetirable(t);
  // S03: a row that is still `submitted` is refused by the route itself, with the route's own reason, whatever its age.
  assert.ok(a.h.worker.updateOp(a.row.id, { state: 'submitted' }));
  assert.deepEqual(await a.retire(), { status: 409, message: AUDIT_UNRESOLVED });
  assert.equal(a.h.worker.getJob(a.id)?.state, 'halted');
  assert.equal(a.h.worker.inFlightOp(a.row.walletId)?.state, 'submitted');
  assert.ok(a.h.worker.updateOp(a.row.id, { state: 'ambiguous' }));
  // S04: a row with no submit time has no proven age.
  a.age(null);
  assert.deepEqual(await a.retire(), { status: 409, message: AUDIT_UNRESOLVED });
  a.untouched('no submit time');
  // S06: one millisecond short of the hour, and half an hour, are both too young.
  for (const ms of [AMBIGUOUS_SLOW_AFTER_MS / 2, AMBIGUOUS_SLOW_AFTER_MS - 1]) {
    a.age(ms);
    assert.deepEqual(await a.retire(), { status: 409, message: AUDIT_UNRESOLVED }, String(ms));
    a.untouched('a young row');
  }
  // S07: exactly one hour is "at least 1 hour" (spec 2.2 step 3).
  a.age(AMBIGUOUS_SLOW_AFTER_MS);
  assert.deepEqual(await a.retire(), { status: 200, message: null });
  assert.equal(a.h.worker.getJob(a.id)?.state, 'retired');
  assert.equal(a.h.worker.jobOps(a.id).find(r => r.id === a.row.id)?.state, 'finished');
});

test('AUDIT R-2 (S12, S16, S17, S18): wNEAR, a DCL lost-found amount, an open order and a position each refuse the retire on their own', async t => {
  const a = await auditRetirable(t);
  // S12: wNEAR is read and counted although it is not a job token.
  a.dust({ wnear: 1n });
  assert.deepEqual(await a.retire(), { status: 409, message: AUDIT_HELD }, 'wNEAR');
  a.dust();
  // S16: a lost-found amount.
  a.venue.lost = { [USDC]: '1' };
  assert.deepEqual(await a.retire(), { status: 409, message: AUDIT_HELD }, 'lost-found');
  a.venue.lost = {};
  // S17: an open order on the pinned pool, with every balance at zero.
  const open = order(77, WNEAR, N / 10n, P - 100);
  a.h.active.set(open.order_id, open);
  assert.deepEqual(await a.retire(), { status: 409, message: AUDIT_HELD }, 'an open order');
  a.h.active.clear();
  // S18: a liquidity position.
  a.venue.positions = [{ lpt_id: `${DCL_POOL}#9`, owner_id: agent, pool_id: DCL_POOL, left_point: P - 100, right_point: P + 100, amount: '5', mft_id: '', unclaimed_fee_x: '0', unclaimed_fee_y: '0' }];
  assert.deepEqual(await a.retire(), { status: 409, message: AUDIT_HELD }, 'a position');
  a.venue.positions = [];
  a.untouched('no refusal changes the job or the row');
  assert.deepEqual(await a.retire(), { status: 200, message: null });
});

test('AUDIT R-3 (spec 4, untested): another account cannot retire the job, and a job without a wallet is refused with its own reason', async t => {
  const a = await auditRetirable(t);
  assert.equal((await a.retire('b'.repeat(43))).status, 404, 'the session of foreign.near');
  a.untouched('a foreign session');
  // A halted job that never got a wallet (written through the worker store, as in test/store.test.ts).
  const bare = a.h.web.createJob({ owner: 'second.near', kind: 'grid', mode: 'live', pair: 'usdc-wnear', depositYocto: N }, testNow);
  assert.ok(a.h.worker.casJob(bare.id, 'draft', bare.version, 'halted'));
  const token = 'c'.repeat(43);
  a.h.web.putSession(tokenHash(token), 'second.near', a.h.d.now(), a.h.d.now() + 600_000);
  const r = await a.h.request(`/api/jobs/${bare.id}/retire`, {}, token);
  assert.equal(r.status, 409);
  assert.equal((JSON.parse(r.text) as { error: { message: string } }).error.message, 'This job has no agent wallet. Cancel it instead.');
  assert.equal(a.h.worker.getJob(bare.id)?.state, 'halted');
});

test('AUDIT R-4 (checks, no mutant): a retired job cannot be stopped, cancelled, resumed, confirmed or advanced, and its page still answers', async t => {
  const a = await auditRetirable(t);
  assert.deepEqual(await a.retire(), { status: 200, message: null });
  const before = a.h.worker.getJob(a.id)!;
  for (const action of ['stop', 'cancel', 'retire', 'dcl-registration']) assert.equal((await a.h.request(`${a.path}/${action}`, {})).status, 409, action);
  assert.equal((await a.h.request(`${a.path}/link-confirmed`, { saved: true })).status, 409);
  assert.equal((await a.h.request(`${a.path}/resume`, { signed: {} })).status, 409);
  assert.equal((await a.h.request(`/api/challenge?purpose=resume&job=${a.id}`)).status, 409, 'no resume challenge');
  // The worker loop no longer lists it; a pass that still holds its id changes nothing and submits nothing.
  const sent = a.h.submissions.length;
  assert.equal(await a.h.tick(a.id), 'retired');
  assert.equal(a.h.submissions.length, sent);
  assert.deepEqual(a.h.worker.getJob(a.id), before, 'state, reason and version are unchanged');
  const page = await a.h.request(a.path);
  assert.equal(page.status, 200);
  const shown = page.data as { state: string; reason: string; canFund: boolean; canStopEarly: boolean; canResumeBlind: boolean; canReveal: boolean; pendingSubmission: string | null };
  assert.deepEqual({ state: shown.state, reason: shown.reason, canFund: shown.canFund, canStopEarly: shown.canStopEarly, canResumeBlind: shown.canResumeBlind, pendingSubmission: shown.pendingSubmission },
    { state: 'retired', reason: 'Retired by the owner. The agent wallet held only dust.', canFund: false, canStopEarly: false, canResumeBlind: false, pendingSubmission: null });
  assert.equal(shown.canReveal, true, 'the management link stays revealable');
  // The watchdog skips it: no read and no alert.
  let reads = 0;
  const view = a.h.rpc.view;
  a.h.rpc.view = async (...args) => { reads++; return view(...args); };
  assert.deepEqual(await watchOnce({ store: a.h.watch, rpc: a.h.rpc, now: a.h.d.now }), []);
  assert.equal(reads, 0);
});

test('AUDIT R-5 (S24): the hire route answers the limit at 15 live jobs, and a retired job frees its slot there too', async t => {
  const h = setup(t);
  for (let i = 0; i < 15; i++) h.web.createJob({ owner: `owner-${i}.near`, kind: 'grid', mode: 'live', pair: 'usdc-wnear', depositYocto: N }, testNow);
  const input = { kind: 'grid', mode: 'live', pair: 'usdc-wnear', depositYocto: N.toString() };
  const full = await h.request('/api/jobs', input);
  assert.equal(full.status, 409, 'limit_reached, not the 400 of an invalid hire');
  assert.equal((JSON.parse(full.text) as { error: { code: string } }).error.code, 'limit_reached');
  const dead = h.web.listJobs('owner-0.near')[0]!;
  assert.ok(h.worker.casJob(dead.id, 'draft', dead.version, 'halted'));
  assert.ok(h.web.retireJob(h.web.getJob(dead.id)!, null, testNow));
  assert.equal((await h.request('/api/jobs', input)).status, 201);
  assert.equal(h.web.jobCounts(owner).live, 15);
});

test('AUDIT R-6 (S19): a filled order that only the journal still names refuses the retire', async t => {
  const h = setup(t), { id, path } = await h.run();
  await tickUntil(h, id, () => h.active.size === 4);
  const [filled, ...rest] = [...h.active.keys()];
  // Fully filled and not yet claimed: it leaves list_active_orders and is not in the history list, so only get_order by its journaled id shows it.
  h.fill(filled, N / 10n);
  for (const other of rest) h.active.delete(other);
  const job = h.worker.getJob(id)!;
  assert.ok(h.worker.casJob(id, 'running', job.version, 'halted', { reason: 'audit' }));
  assert.equal(h.worker.inFlightOp(job.walletId!), null);
  h.c.setHoldings({ native: N / 100n, wnear: 0n, usdc: 0n, height: h.c.height + 1 });
  const r = await h.request(`${path}/retire`, {});
  assert.equal(r.status, 409);
  assert.equal((JSON.parse(r.text) as { error: { message: string } }).error.message, AUDIT_HELD);
  assert.equal(h.worker.getJob(id)?.state, 'halted');
});

// ---------------------------------------------------------------------------------------------------------------------
// AUDIT 2026-11-12 (Retire, 15 live jobs, no hidden agents), reproductions of findings. These are NOT survivor probes:
// each test FAILS on 2b09553 and passes once the finding it names is fixed.
// Paste at the end of test/grid.test.ts, after retire-grid-probes.ts (it uses auditRetirable from that file).
// ---------------------------------------------------------------------------------------------------------------------

// Finding M-1: src/web/server.ts:135 TERMINAL_STATES has no 'retired', so the job list keeps reading a retired job at the live cadence.
test('AUDIT D-1 (finding M-1): the job list reuses the chain reads of a retired job, as it does for a stopped job', async t => {
  const a = await auditRetirable(t);
  assert.deepEqual(await a.retire(), { status: 200, message: null });
  // One handler for all requests, so its read cache lives across them (the harness builds a new handler per request).
  const origin = 'https://app.test';
  const run = createHandler({ store: a.h.web, rpc: a.h.rpc, now: a.h.d.now, env: { host: '127.0.0.1', port: 8090, origin, liveHires: true, gridV1: true, gridV2: true }, provider: fullAccess });
  const list = async () => {
    const req = Object.assign(Readable.from([]), { url: '/api/jobs', method: 'GET', headers: { host: 'app.test', origin, cookie: `fourlpha_session=${'a'.repeat(43)}` } });
    let text = '';
    const res = { statusCode: 200, setHeader() {}, end(v: string) { text = v; } };
    await run(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    assert.equal(res.statusCode, 200);
    return (JSON.parse(text) as { data: { state: string }[] }).data.map(j => j.state);
  };
  const reads: string[] = [];
  const view = a.h.rpc.view;
  a.h.rpc.view = async (contract, method, args, blockId) => { reads.push(method); return view(contract, method, args, blockId); };
  assert.deepEqual(await list(), ['retired']);
  assert.ok(reads.includes('get_metadata') && reads.includes('get_wallet_policy'), 'the first list reads the wallet, the policy and DCL once');
  reads.length = 0;
  await list();
  assert.deepEqual(reads, [], 'the next list reads nothing about the retired job, its policy included');
  a.h.skip(61_000);
  await list();
  assert.deepEqual(reads, [], 'and nothing a minute later: a terminal job keeps its reads for TERMINAL_CACHE_MS');
});

// Finding L-1: an order the agent wallet holds on another DCL pool is value inside DCL that the dust rule does not see.
test('AUDIT D-2 (finding L-1): an active order on another DCL pool is not "nothing in DCL"', async t => {
  const a = await auditRetirable(t);
  const other = `${USDC}|${WNEAR}|2000`, foreign = { ...order(88, WNEAR, N / 2n, P - 100), pool_id: other, order_id: `${other}#88` };
  a.h.active.set(foreign.order_id, foreign);
  assert.deepEqual(await a.retire(), { status: 409, message: AUDIT_HELD });
  a.untouched('an order on another pool');
});

// Phase 1 fix 4 end to end: a DCL placement loses its reply, the re-send lands it, and the resumed lane adopts the order.
test('fix 4: a lost placement reply is re-sent under its key, proven, paused, resumed by the owner, and all four orders rest', async t => {
  const h = setup(t), { id, path } = await h.run();
  Object.assign(h.d, { wait: async () => {} });
  h.setMode('ambiguous');
  await tickUntil(h, id, () => h.worker.getJob(id)?.state === 'halted');
  const walletId = h.worker.getJob(id)!.walletId!, row = h.worker.inFlightOp(walletId)!;
  assert.equal(row.kind, 'dcl_place');
  const sent = () => h.submissions.filter(s => s.idem === row.idemKey).length;
  assert.equal(sent(), 4, 'the original and three same-key re-sends');
  h.setMode('normal');
  h.skip(RESEND_EVERY_MS); h.watch.heartbeat('watchdog', h.d.now());
  assert.equal(await reconcileWallet({ ...h.d, rpc: h.rpc, wait: async () => {} }, walletId), 'clean');
  assert.equal(sent(), 5);
  assert.equal(h.worker.jobOps(id).find(o => o.id === row.id)?.verdict, 'success');
  assert.equal(h.worker.getJob(id)?.state, 'paused');
  const c = (await h.request(`/api/challenge?purpose=resume&job=${id}`)).data as Challenge;
  assert.equal((await h.request(`${path}/resume`, { signed: identity()(c) })).status, 200);
  await tickUntil(h, id, () => h.worker.grid(id)?.state?.lanes.every(l => l.orderId !== null) === true);
  assert.equal(h.worker.getJob(id)?.state, 'running');
  assert.equal(h.active.size, 4);
  assert.equal(sent(), 5, 'the placement was never sent again');
});

test('a Grid step refused before submission waits out the idle minute instead of re-reading the chain every tick', async t => {
  const h = setup(t), { id } = await h.run();
  await tickUntil(h, id, () => h.active.size === 4);
  const old = h.worker.grid(id)!.state!.lanes[0].orderId!;
  h.fill(old, N / 10n + 123n); h.setPoint(P + 110);
  h.c.setHoldings({ native: N / 10n });
  h.skip(GRID_EVAL_MS); await h.tick(id);
  assert.equal(h.worker.grid(id)?.state?.pending?.kind, 'dcl_claim');
  const sent = h.submissions.length;
  await h.tick(id);
  assert.equal(h.worker.grid(id)?.state?.pending, null);
  assert.match(h.worker.getJob(id)?.reason ?? '', /more free NEAR/);
  let reads = 0;
  const real = h.rpc.view;
  h.rpc.view = async (contract, method, args, blockId) => { reads++; return real(contract, method, args, blockId); };
  for (let i = 0; i < 5; i++) { h.skip(5_000); await h.tick(id); }
  assert.equal(reads, 0);
  h.skip(GRID_EVAL_MS); await h.tick(id);
  assert.ok(reads > 0);
  assert.equal(h.submissions.length, sent);
  h.rpc.view = real;
});

test('an idle Grid tick reads through the idle client; the policy check and guarded operations keep the main client', async t => {
  const h = setup(t), { id } = await h.run();
  await tickUntil(h, id, () => h.active.size === 4);
  const main: string[] = [], idle: string[] = [], real = h.rpc.view;
  h.d.idleRpc = { ...h.rpc, view: async (contract, method, args, blockId) => { idle.push(method); return real(contract, method, args, blockId); } };
  h.rpc.view = async (contract, method, args, blockId) => { main.push(method); return real(contract, method, args, blockId); };
  h.skip(GRID_EVAL_MS); await h.tick(id);
  assert.ok(idle.includes('get_pool') && idle.includes('ft_balance_of'));
  assert.deepEqual(main, ['get_wallet_policy']);
  const old = h.worker.grid(id)!.state!.lanes[0].orderId!, sent = h.submissions.length;
  h.fill(old, N / 10n + 123n); h.setPoint(P + 110);
  h.skip(GRID_EVAL_MS); await h.tick(id);
  assert.equal(h.worker.grid(id)?.state?.pending?.kind, 'dcl_claim');
  main.length = 0; idle.length = 0;
  await h.tick(id);
  assert.deepEqual(h.submissions.slice(sent).map(x => x.call), ['cancel_order']);
  assert.ok(main.some(m => m !== 'get_wallet_policy'));
  assert.deepEqual(idle, []);
  h.rpc.view = real; delete h.d.idleRpc;
});

test('an idle snapshot older than a proven step is retried, never judged, so a lagging public node cannot halt the job', async t => {
  const h = setup(t), { id } = await h.run();
  await tickUntil(h, id, () => h.active.size === 4);
  const proven = Math.max(...h.worker.jobOps(id).map(r => r.finishedBlock ?? 0)), stale = proven - 1, views: string[] = [];
  const at = (v: { height: number; blockId?: string; value: unknown }) => ({ ...v, height: stale, blockId: `block-${stale}` });
  h.d.idleRpc = { ...h.rpc,
    finalBlock: async () => ({ id: `block-${stale}`, height: stale }),
    query: async p => ({ ...(await h.rpc.query({ ...p, block_id: `block-${h.c.height}` }) as object), block_hash: `block-${stale}`, block_height: stale }),
    view: async (contract, method, args) => { views.push(method); return at(await h.rpc.view(contract, method, args, `block-${h.c.height}`)); } };
  h.skip(GRID_EVAL_MS);
  assert.equal(await h.tick(id), 'running');
  assert.ok(!views.includes('get_pool'), 'no DCL read on a stale snapshot');
  assert.equal(h.worker.getJob(id)?.state, 'running');
  delete h.d.idleRpc;
});
