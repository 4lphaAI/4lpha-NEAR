import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import test from 'node:test';
import { YOCTO_PER_NEAR as N } from '../src/core/amounts.js';
import { tokenHash, type Challenge } from '../src/core/auth.js';
import { readDclBefore, discoveredDclPositions } from '../src/core/dcl-evidence.js';
import { seal, walletAad } from '../src/core/secrets.js';
import { provenEffects, recipientProblems, type Intent } from '../src/core/evidence.js';
import { advanceJob, draftProblems, processReveals, type WorkerDeps } from '../src/core/hire.js';
import { readHoldings } from '../src/core/holdings.js';
import { LP_CENTRE_TOLERANCE, LP_MAX_FAILURES, LP_MIN_DEPOSIT, LP_COMPOUND_FLOOR, lpGate, lpIntent, lpKnownPositions, lpRotations, type LpState } from '../src/core/lp.js';
import { nativeSpendProblems, opsProblems } from '../src/core/budget.js';
import { createLiveOps, exitBudget, reconcileWallet, RESEND_EVERY_MS } from '../src/core/ops.js';
import { parseTxStatus } from '../src/core/receipts.js';
import type { CallRequest, SubmitResult } from '../src/core/outlayer.js';
import { CLASSIC_EXCHANGE, DCL, GAS, MONEY, USDC, WNEAR } from '../src/core/pins.js';
import { buildRules, defaultCaps, policyHash, type PolicyRules } from '../src/core/policy.js';
import { DCL_STORAGE, DCL_POOL, dclAction, dclDeposit, GRID_DCL_KINDS, jobDclKinds, LP_DCL_KINDS, lpAdd, lpBlocked, lpRemove, predictRemove, readDcl, readPoolPoint, toNearDown, limitProceeds, type DclToken } from '../src/core/rhea-dcl.js';
import { SecretString } from '../src/core/secrets.js';
import { json, openStore, type Job, type OpRow } from '../src/core/store.js';
import { watchOnce } from '../src/core/watchdog.js';
import { createHandler } from '../src/web/server.js';
import { chain } from './chain.js';
import { accepted, agent, dummyOutLayer, fullAccess, identity, owner, stores, testNow } from './helpers.js';

const P = 401_000, LIQ = 752342968226n, REFUND_X = 1797n, REFUND_Y = 6008864895n, ALL_X = 1_400_000n, ALL_Y = 4n * N / 10n, MID_X = 700_000n, MID_Y = N / 5n;
const r = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64');
const fn = (method_name: string, args: object, gas = 30_000_000_000_000n, deposit = 0n) => ({ FunctionCall: { method_name, args: r(args), gas: Number(gas), deposit: String(deposit) } });
const transfer = (n: bigint) => ({ Transfer: { deposit: String(n) } });
const event = (name: string, data: object) => `EVENT_JSON:${JSON.stringify({ standard: 'dcl.ref', version: '1.0.0', event: name, data: [data] })}`;
type Status = { SuccessValue: string } | { SuccessReceiptId: string } | { Failure: object };
const success = (value?: unknown) => ({ SuccessValue: value === undefined ? '' : r(value) });
const failure = { Failure: { ActionError: { kind: 'FunctionCallError' } } };
type Action = ReturnType<typeof fn> | ReturnType<typeof transfer>;
interface Receipt { id: string; from: string; to: string; a: Action; status: Status; children?: string[]; logs?: string[]; }
interface Built { root: Receipt; rs: Receipt[]; status: Status; call: CallRequest; }
function tx(b: Pick<Built, 'root' | 'rs'> & { status?: Status }) {
  const receipts = [b.root, ...b.rs], status = b.status ?? b.root.status;
  return { final_execution_status: 'FINAL', status, transaction: { signer_id: agent, receiver_id: b.root.to, hash: 'lp-tx', actions: [b.root.a] },
    transaction_outcome: { outcome: { tokens_burnt: '1', receipt_ids: [b.root.id] } },
    receipts: receipts.map(x => ({ receipt_id: x.id, predecessor_id: x.from, receiver_id: x.to, receipt: { Action: { actions: [x.a] } } })),
    receipts_outcome: receipts.map(x => ({ id: x.id, outcome: { executor_id: x.to, tokens_burnt: '0', status: x.status, receipt_ids: x.children ?? [], logs: x.logs ?? [] } })) };
}
const lptOf = (n: number) => `${DCL_POOL}#${n}`;
const intentOf = (call: CallRequest): Intent => ({ receiver: call.receiverId, method: call.methodName, args: call.args, deposit: call.deposit.toString(), gas: call.gas.toString() });
const rootOf = (call: CallRequest, status: Status, logs?: string[]): Receipt => ({ id: 'root', from: agent, to: call.receiverId, a: fn(call.methodName, call.args, call.gas, call.deposit), status, ...(logs ? { logs } : {}) });

/** The payout receipts of a DCL withdrawal to the wallet. A zero side has no receipt at all (FINDINGS 1.38). */
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

function depositBuilt(token: DclToken, n: bigint, refund = false): Built {
  const call = dclDeposit(token, n), used = refund ? '0' : String(n);
  const root = rootOf(call, { SuccessReceiptId: 'resolve' });
  root.children = ['receive', 'resolve'];
  return { call, root, status: success(used), rs: [
    { id: 'receive', from: token, to: DCL, a: fn('ft_on_transfer', { sender_id: agent, amount: String(n), msg: '"Deposit"' }), status: refund ? failure : success('0') },
    { id: 'resolve', from: token, to: token, a: fn('ft_resolve_transfer', { sender_id: agent, receiver_id: DCL, amount: String(n) }), status: success(used) }] };
}
interface AddShape { lptId: string; left: number; right: number; x: bigint; y: bigint; refundX: bigint; refundY: bigint; wrapped?: boolean; }
function addBuilt(a: AddShape): Built {
  const call = lpAdd(a.left, a.right, a.x, a.y), rs: Receipt[] = [];
  const root = rootOf(call, success(a.lptId), [event('liquidity_added', { lpt_id: a.lptId, owner_id: agent, pool_id: DCL_POOL, left_point: a.left, right_point: a.right,
    added_amount: String(LIQ), cur_amount: String(LIQ), paid_token_x: String(a.x - a.refundX), paid_token_y: String(a.y - a.refundY) })]);
  root.children = [];
  payout(USDC, a.refundX, rs, root.children); payout(WNEAR, a.refundY, rs, root.children, a.wrapped);
  return { call, root, rs, status: root.status };
}
interface RemoveShape { lptId: string; left: number; right: number; amount: bigint; remaining: bigint; x: bigint; y: bigint; wrapped?: boolean; minX?: string; minY?: string; }
function removeBuilt(a: RemoveShape): Built {
  const call = lpRemove(a.lptId, a.amount, a.minX ?? '0', a.minY ?? '0'), rs: Receipt[] = [];
  const root = rootOf(call, success([String(a.x), String(a.y)]), [event('liquidity_removed', { lpt_id: a.lptId, owner_id: agent, pool_id: DCL_POOL, left_point: a.left, right_point: a.right,
    removed_amount: String(a.amount), cur_amount: String(a.remaining), claim_fee_token_x: '0', claim_fee_token_y: '0', refund_token_x: String(a.x), refund_token_y: String(a.y) })]);
  root.children = [];
  payout(USDC, a.x, rs, root.children); payout(WNEAR, a.y, rs, root.children, a.wrapped);
  return { call, root, rs, status: root.status };
}
const allowed = { agent, owner, tokens: [USDC], dclKinds: LP_DCL_KINDS };
const prove = (b: Built, kind: 'dcl_deposit' | 'dcl_add' | 'dcl_remove', before?: object) =>
  provenEffects(parseTxStatus(tx(b)), kind, intentOf(b.call), allowed, before ? readDclBefore(json({ dcl: before })) : undefined);
function beforeOf(lptId = lptOf(1), left = P - 100, right = P + 100, amount = LIQ) {
  return { position: { id: lptId, owner: agent, pool: DCL_POOL, left, right, amount, mft: '', feeX: 0n, feeY: 0n }, assets: {} };
}
const ADD: AddShape = { lptId: lptOf(24422), left: P - 100, right: P + 100, x: 30000n, y: 8n * N / 1000n, refundX: REFUND_X, refundY: REFUND_Y };
const REMOVE: RemoveShape = { lptId: lptOf(1), left: P - 100, right: P + 100, amount: LIQ, remaining: 0n, x: 25337n, y: 3903474322982244558933n };

function event0(b: Built, i = 0) { return JSON.parse(b.root.logs![i].slice(11)) as { data: Record<string, unknown>[] }; }
function setEvent(b: Built, patch: Record<string, unknown>) {
  const e = event0(b); Object.assign(e.data[0], patch);
  b.root.logs = [`EVENT_JSON:${JSON.stringify(e)}`];
}

test('dclAction accepts the three exact shapes and refuses near misses', () => {
  const act = (c: CallRequest, patch: Partial<{ args: Record<string, unknown>; deposit: bigint; receiver: string; method: string }> = {}) =>
    dclAction({ receiver: patch.receiver ?? c.receiverId, kind: 'FunctionCall', method: patch.method ?? c.methodName, args: patch.args ?? c.args, deposit: patch.deposit ?? c.deposit, gas: c.gas });
  const dep = dclDeposit(USDC, 30000n), add = lpAdd(P - 100, P + 100, 30000n, 8n * N / 1000n), rem = lpRemove(lptOf(7), 9n, '1', '2');
  assert.deepEqual(act(dep), { kind: 'dcl_deposit', token: USDC, raw: 30000n });
  assert.deepEqual(act(add), { kind: 'dcl_add', left: P - 100, right: P + 100, x: 30000n, y: 8n * N / 1000n });
  assert.deepEqual(act(rem), { kind: 'dcl_remove', lptId: lptOf(7), amount: 9n, minX: '1', minY: '2' });
  const other = `${USDC}|other.near|100`;
  assert.equal(act(dep, { args: { ...dep.args, msg: '"Other"' } }), null);
  assert.equal(act(dep, { args: { ...dep.args, extra: 1 } }), null);
  assert.equal(act(dep, { args: { ...dep.args, amount: '0' } }), null);
  assert.equal(act(add, { args: { ...add.args, extra: 1 } }), null);
  assert.equal(act(add, { args: { ...add.args, min_amount_x: '1' } }), null);
  assert.equal(act(add, { args: { ...add.args, pool_id: other } }), null);
  assert.equal(act(add, { args: { ...add.args, left_point: P + 100, right_point: P - 100 } }), null);
  assert.equal(act(add, { args: { ...add.args, amount_y: '0' } }), null);
  assert.equal(act(rem, { args: { ...rem.args, extra: 1 } }), null);
  assert.equal(act(rem, { args: { ...rem.args, lpt_id: `${other}#7` } }), null); // An id of another pool is not a pinned lpt id.
  assert.equal(act(rem, { args: { ...rem.args, amount: '0' } }), null);
  assert.equal(act(rem, { args: { ...rem.args, min_amount_x: '-1' } }), null);
  assert.equal(act(add, { deposit: 1n }), null);
  // The signed gas is held by recipientProblems.
  const signed = { receiver: add.receiverId, kind: 'FunctionCall' as const, method: add.methodName, args: add.args, deposit: 0n };
  assert.deepEqual(recipientProblems({ ...signed, gas: add.gas }, allowed), []);
  assert.equal(recipientProblems({ ...signed, gas: add.gas + 1n }, allowed).length, 1);
  assert.equal(recipientProblems({ ...signed, gas: add.gas }, { ...allowed, dclKinds: GRID_DCL_KINDS }).length, 1);
  assert.equal(recipientProblems({ ...signed, gas: add.gas }, { ...allowed, dclKinds: [] }).length, 1);
  for (const c of [dep, add, rem]) {
    const a = { receiver: c.receiverId, kind: 'FunctionCall' as const, method: c.methodName, args: c.args, deposit: c.deposit, gas: c.gas };
    assert.deepEqual(recipientProblems(a, allowed), []);
  }
});

test('lpReceipt proves the deposit, add and remove vectors and refuses every deviation', () => {
  for (const [token, n] of [[USDC, 30000n], [WNEAR, 8n * N / 1000n]] as const) {
    const ok = prove(depositBuilt(token, n), 'dcl_deposit');
    assert.equal(ok?.verdict, 'success'); assert.equal(ok.used, n); assert.equal(ok.effects[token], -n);
  }
  const refund = prove(depositBuilt(USDC, 30000n, true), 'dcl_deposit');
  assert.equal(refund?.verdict, 'refunded'); assert.equal(refund.used, 0n);
  const partial = depositBuilt(USDC, 30000n);
  partial.rs[1].status = success('29999'); partial.status = success('29999');
  assert.equal(prove(partial, 'dcl_deposit'), null);
  const loud = depositBuilt(USDC, 30000n);
  loud.rs[0].logs = [event('swap', {})];
  assert.equal(prove(loud, 'dcl_deposit'), null);

  const add = prove(addBuilt(ADD), 'dcl_add', { assets: {} });
  assert.equal(add?.verdict, 'success'); assert.equal(add.used, null);
  assert.deepEqual(add.dcl?.payouts, { [USDC]: REFUND_X, native: REFUND_Y });
  assert.equal(add.dcl?.lptId, ADD.lptId); assert.equal(add.dcl?.liquidity, LIQ);
  assert.equal(add.dcl?.paidX, 30000n - REFUND_X); assert.equal(add.dcl?.paidY, 8n * N / 1000n - REFUND_Y);
  assert.equal(add.effects[USDC], REFUND_X);
  const wrapped = prove(addBuilt({ ...ADD, wrapped: true }), 'dcl_add', { assets: {} });
  assert.equal(wrapped?.effects[WNEAR], REFUND_Y);
  // A reverted add: the whole transaction fails and nothing moves. The product signs zero minimums, so this is not the E204 slippage panic of the probe; it stands for any other panic.
  const revertedAdd = { ...addBuilt(ADD), rs: [] as Receipt[] };
  revertedAdd.root = { ...revertedAdd.root, status: failure, logs: [], children: [] };
  assert.equal(provenEffects(parseTxStatus(tx({ root: revertedAdd.root, rs: [], status: failure })), 'dcl_add', intentOf(revertedAdd.call), allowed)?.verdict, 'reverted');

  const unclear = (mutate: (b: Built) => void, shape = ADD) => { const b = addBuilt(shape); mutate(b); return prove(b, 'dcl_add', { assets: {} }); };
  assert.equal(unclear(b => { b.root.logs = [...b.root.logs!, ...b.root.logs!]; }), null, 'a second event');
  assert.equal(unclear(b => setEvent(b, { cur_amount: String(LIQ + 1n) })), null, 'cur_amount drift');
  assert.equal(unclear(b => setEvent(b, { lpt_id: lptOf(1) })), null, 'a mismatched lpt id');
  assert.equal(unclear(b => setEvent(b, { paid_token_x: '30001' })), null, 'paid above offered');
  assert.equal(unclear(b => { b.rs.find(x => x.id === 'callback-' + USDC)!.status = failure; }), null, 'a failed callback');
  assert.equal(unclear(b => { b.rs.find(x => x.id === 'pay-' + USDC)!.a = fn('ft_transfer', { receiver_id: agent, amount: '0', memo: null }, 10n, 1n); }), null, 'a zero-amount payout');
  assert.equal(unclear(b => { b.rs = b.rs.filter(x => x.id !== 'pay-near'); b.root.children = b.root.children!.filter(x => x !== 'pay-near'); }), null, 'a missing native leg');
  assert.equal(unclear(() => {}, { ...ADD, refundX: 0n, refundY: 0n }) !== null, true, 'no refunds at all is a valid add');

  // Removals: both sides, then the two one-sided removals derived by removing one payout path.
  const both = prove(removeBuilt(REMOVE), 'dcl_remove', beforeOf());
  assert.equal(both?.verdict, 'success'); assert.deepEqual(both.dcl?.payouts, { [USDC]: 25337n, native: 3903474322982244558933n });
  assert.equal(both.dcl?.x, 25337n); assert.equal(both.dcl?.removed, LIQ);
  const usdcOnly = prove(removeBuilt({ ...REMOVE, y: 0n }), 'dcl_remove', beforeOf());
  assert.deepEqual(usdcOnly?.dcl?.payouts, { [USDC]: 25337n });
  const nativeOnly = prove(removeBuilt({ ...REMOVE, x: 0n }), 'dcl_remove', beforeOf());
  assert.deepEqual(nativeOnly?.dcl?.payouts, { native: 3903474322982244558933n });
  const wnearOnly = prove(removeBuilt({ ...REMOVE, x: 0n, wrapped: true }), 'dcl_remove', beforeOf());
  assert.deepEqual(wnearOnly?.dcl?.payouts, { [WNEAR]: 3903474322982244558933n });
  const bad = (mutate: (b: Built) => void, shape = REMOVE, before = beforeOf()) => { const b = removeBuilt(shape); mutate(b); return prove(b, 'dcl_remove', before); };
  assert.equal(bad(b => setEvent(b, { cur_amount: '1' })), null, 'cur_amount drift');
  assert.equal(bad(() => {}, { ...REMOVE, minX: '25338' }), null, 'a payout below the minimum');
  // The zero rule decides alone: the wanted USDC is 0 and a zero-amount transfer still arrives.
  assert.equal(bad(b => {
    b.root.children!.push('pay-' + USDC, 'callback-' + USDC);
    b.rs.push({ id: 'pay-' + USDC, from: DCL, to: USDC, a: fn('ft_transfer', { receiver_id: agent, amount: '0', memo: null }, 10n, 1n), status: success() },
      { id: 'callback-' + USDC, from: DCL, to: DCL, a: fn('callback_post_withdraw_asset', { token_id: USDC, user_id: agent, amount: '0' }), status: success(true) });
  }, { ...REMOVE, x: 0n }), null, 'a zero-amount payout receipt');
  assert.equal(bad(b => { b.rs.find(x => x.id === 'callback-' + USDC)!.status = success(false); }), null, 'a callback that returns false');
  assert.equal(bad(() => {}, REMOVE, beforeOf(lptOf(2))), null, 'another position');
  assert.equal(bad(b => { b.root.logs = [...b.root.logs!, ...b.root.logs!]; }), null, 'a second event');
  assert.equal(bad(b => { b.rs.find(x => x.id === 'near-callback')!.status = failure; }), null, 'a failed callback');
  assert.equal(prove(removeBuilt(REMOVE), 'dcl_remove'), null, 'no prior position');

  // The 2.4.2 zero-side rule, proven for claims: one side only, no receipt for the zero side.
  for (const [token, claimed] of [[USDC, 352662n], [WNEAR, 101004860681183545981788n]] as const) {
    const id = lptOf(9), rs: Receipt[] = [], call = { receiverId: DCL, methodName: 'cancel_order', args: { order_id: id, amount: '0' }, gas: 180n * 10n ** 12n, deposit: 0n };
    const o = { client_id: '', order_id: id, owner_id: agent, pool_id: DCL_POOL, point: P, sell_token: token === USDC ? WNEAR : USDC, buy_token: token, original_deposit_amount: '9', swap_earn_amount: '0',
      original_amount: '9', cancel_amount: '0', created_at: '1', remain_amount: '0', bought_amount: String(claimed), unclaimed_amount: String(claimed) };
    const root = rootOf(call, success(['0', String(claimed)]), [event('order_cancelled', { ...o, request_cancel_amount: '0', actual_cancel_amount: '0', cancel_at: '1' }),
      event('order_completed', { ...o, unclaimed_amount: null, completed_at: '1' })]);
    root.children = []; payout(token, claimed, rs, root.children);
    const order = { id, owner: agent, pool: DCL_POOL, sell: o.sell_token, buy: token, point: P, original: 9n, deposit: 9n, instant: 0n, remain: 0n, bought: claimed, unclaimed: claimed, cancelled: 0n, created: 1n };
    const claim = provenEffects(parseTxStatus(tx({ root, rs })), 'dcl_claim', intentOf(call), { ...allowed, dclKinds: GRID_DCL_KINDS }, readDclBefore(json({ dcl: { order } })));
    assert.equal(claim?.verdict, 'success'); assert.equal(claim.dcl?.claimed, claimed);
  }
  // A job that is not an LP job may not use the LP kinds.
  assert.equal(provenEffects(parseTxStatus(tx(addBuilt(ADD))), 'dcl_add', intentOf(addBuilt(ADD).call), { ...allowed, dclKinds: GRID_DCL_KINDS }, { assets: {} }), null);
  assert.deepEqual(discoveredDclPositions(parseTxStatus(tx(addBuilt(ADD))), 'root', agent), [ADD.lptId]);
});

test('discoveredDclPositions finds a position whose strict proof fails', () => {
  const b = addBuilt(ADD);
  b.root.logs = [...b.root.logs!, ...b.root.logs!];
  assert.equal(prove(b, 'dcl_add', { assets: {} }), null);
  assert.deepEqual(discoveredDclPositions(parseTxStatus(tx(b)), 'root', agent), [ADD.lptId]);
  setEvent(b, { owner_id: 'someone.near' });
  assert.deepEqual(discoveredDclPositions(parseTxStatus(tx(b)), 'root', agent), []);
  b.root.logs = ['EVENT_JSON:{broken', ...b.root.logs!];
  assert.deepEqual(discoveredDclPositions(parseTxStatus(tx(b)), 'root', agent), [], 'an unreadable event is swallowed, as for orders');
});

function setup(t: Parameters<typeof stores>[0], deposit = 12n * N / 10n, lp?: object) {
  const db = stores(t), c = chain(), origin = 'https://app.test';
  c.setPolicy(null); c.setHoldings({ native: 0n, wnear: 0n, usdc: 0n });
  c.registration.clear();
  const positions = new Map<string, { left: number; right: number; amount: bigint; paidX: bigint; paidY: bigint; mft?: string }>();
  const extraRows: Record<string, unknown>[] = [];
  const assets: Record<string, string> = {}, lost: Record<string, string> = {};
  let sponsor: string | null = null, current = P, clock = testNow, serial = 0, lptSeq = 24000, rules: PolicyRules | null = null, dclVersion = '2.4.2', lpWeb = true;
  let mode: 'normal' | 'refund' | 'revert' | 'unpaid' | 'wrapped' | 'ambiguous' | 'quota' | 'frozen' = 'normal';
  let feeX = 0n, feeY = 0n, predictionFees = false;
  const submissions: { call: string; idem: string }[] = [];
  const swapOut = (token: string, n: bigint) => token === WNEAR ? n * 3_500_000n / N : n * N / 3_500_000n;
  const valueOf = (p: { left: number; right: number; paidX: bigint; paidY: bigint }): [bigint, bigint] => current < p.left ? [lp ? ALL_X * (deposit - 8n * N / 10n) / (4n * N / 10n) : ALL_X, 0n] : current >= p.right ? [0n, lp ? deposit - 8n * N / 10n : ALL_Y] : [p.paidX, p.paidY];
  const row = (id: string, p: { left: number; right: number; amount: bigint; mft?: string }) => ({ lpt_id: id, owner_id: agent, pool_id: DCL_POOL, left_point: p.left, right_point: p.right, amount: String(p.amount),
    mft_id: p.mft ?? '', v_liquidity: '0', unclaimed_fee_x: String(feeX), unclaimed_fee_y: String(feeY) });
  const rpc = { ...c.rpc,
    view: async (contract: string, method: string, args: Record<string, unknown>, blockId?: string) => {
      if (contract !== DCL) {
        if (method === 'estimate_wallet_policy_cost') return { height: c.height, blockId: `block-${c.height}`, value: '15000000000000000000000' };
        if (method === 'get_return') return { height: c.height, blockId: `block-${c.height}`, value: String(args.amount_in === N.toString() ? 3756475n : swapOut(String(args.token_in), BigInt(String(args.amount_in)))) };
        return c.rpc.view(contract, method, args, blockId);
      }
      assert.equal(blockId, `block-${c.height}`);
      let value: unknown;
      if (method === 'get_metadata') value = { version: dclVersion, state: 'Running' };
      else if (method === 'get_pool') value = { pool_id: DCL_POOL, token_x: USDC, token_y: WNEAR, fee: 100, point_delta: 1, state: 'Running', current_point: current };
      else if (method === 'storage_balance_bounds') value = { min: String(DCL_STORAGE), max: null };
      else if (method === 'get_user_storage_detail') value = sponsor === null ? null : { sponsor_id: sponsor, locked_near: String(DCL_STORAGE),
        storage_for_asset: String(N / 10n), slot_price: String(N / 100n), max_slots: 40, cur_order_slots: 0, cur_liquidity_slots: positions.size + extraRows.length };
      else if (method === 'list_active_orders' || method === 'list_history_orders') value = [];
      else if (method === 'list_user_assets') value = { ...assets };
      else if (method === 'list_lostfound') value = { ...lost };
      else if (method === 'list_liquidities') value = [...[...positions].map(([id, p]) => row(id, p)), ...extraRows];
      else if (method === 'predict_remove_liquidity') {
        const p = positions.get(String(args.lpt_id));
        if (!p) throw new Error('E207: liquidity not found');
        const [x, y] = valueOf(p);
        value = [x + (predictionFees ? feeX : 0n), y + (predictionFees ? feeY : 0n)].map(String);
      } else assert.fail(`Unexpected DCL view ${method}`);
      return { value, height: c.height, blockId };
    } };
  const complete = (b: Pick<Built, 'root' | 'rs'> & { status?: Status }, move: { native?: bigint; wnear?: bigint; usdc?: bigint }) => {
    const hash = c.addTx(tx(b), c.height + 1, `lp-tx-${++serial}`);
    c.setHoldings({ ...move, height: c.height + 30 });
    return accepted(hash);
  };
  const liveCall = async (call: CallRequest, idem: string): Promise<SubmitResult> => {
    submissions.push({ call: call.methodName, idem });
    if (mode === 'quota') return { kind: 'quota', retryAfterSeconds: 1 };
    if (mode === 'frozen') return { kind: 'denied', code: 'wallet_frozen', message: 'Frozen.' };
    assert.deepEqual(Object.keys(call).sort(), ['args', 'deposit', 'gas', 'methodName', 'receiverId']);
    const root = rootOf(call, success());
    const n = BigInt(String(call.args.amount ?? call.deposit));
    if (call.methodName === 'near_deposit') return complete({ root, rs: [] }, { native: c.native - n - 1n, wnear: c.wnear + n });
    if (call.methodName === 'near_withdraw') {
      root.children = ['agent-near'];
      return complete({ root, rs: [{ id: 'agent-near', from: WNEAR, to: agent, a: transfer(n + 1n), status: success() }] }, { native: c.native + n - 1n, wnear: c.wnear - n });
    }
    if (call.methodName === 'ft_transfer') {
      assert.equal(call.args.receiver_id, owner);
      return complete({ root, rs: [] }, { native: c.native - 2n, usdc: c.usdc - n });
    }
    if (call.methodName === 'ft_transfer_call') {
      const token = call.receiverId, to = String(call.args.receiver_id);
      if (to === DCL) {
        const refund = mode === 'refund', built = depositBuilt(token as DclToken, n, refund);
        if (mode === 'ambiguous') return { kind: 'ambiguous', reason: 'network' };
        if (!refund) assets[token] = String(BigInt(assets[token] ?? 0) + n);
        return complete(built, { native: c.native - 2n, usdc: c.usdc - (token === USDC && !refund ? n : 0n), wnear: c.wnear - (token === WNEAR && !refund ? n : 0n) });
      }
      assert.equal(to, CLASSIC_EXCHANGE);
      const out = swapOut(token, n), toNative = token === USDC;
      root.status = { SuccessReceiptId: 'resolve' }; root.children = ['receive', 'resolve'];
      const rs: Receipt[] = [{ id: 'receive', from: token, to, a: fn('ft_on_transfer', { sender_id: agent, amount: String(n), msg: call.args.msg }), status: success('0'), children: ['swap-output'] },
        { id: 'resolve', from: token, to: token, a: fn('ft_resolve_transfer', { sender_id: agent, receiver_id: to, amount: String(n) }), status: success(String(n)) },
        toNative ? { id: 'swap-output', from: to, to: agent, a: transfer(out), status: success() }
          : { id: 'swap-output', from: to, to: USDC, a: fn('ft_transfer', { receiver_id: agent, amount: String(out) }, 10n, 1n), status: success() }];
      return complete({ root, rs, status: success(String(n)) }, toNative ? { native: c.native + out - 2n, usdc: c.usdc - n } : { native: c.native - 2n, wnear: c.wnear - n, usdc: c.usdc + out });
    }
    if (call.methodName === 'add_liquidity') {
      const x = BigInt(String(call.args.amount_x)), y = BigInt(String(call.args.amount_y)), unpaid = mode === 'unpaid';
      if (mode === 'revert') return complete({ root: { ...root, status: failure }, rs: [], status: failure }, { native: c.native - 1n });
      const id = lptOf(++lptSeq), left = Number(call.args.left_point), right = Number(call.args.right_point);
      const refundX = lp && current >= right ? x : REFUND_X, refundY = lp && current < left ? y : REFUND_Y;
      const built = addBuilt({ lptId: id, left, right, x, y, refundX, refundY });
      if (unpaid) { built.rs = []; built.root.children = []; }
      delete assets[USDC]; delete assets[WNEAR];
      positions.set(id, { left, right, amount: LIQ, paidX: x - refundX, paidY: y - refundY });
      return complete(built, { native: c.native - 1n + (unpaid ? 0n : refundY), usdc: c.usdc + (unpaid ? 0n : refundX) });
    }
    if (call.methodName === 'remove_liquidity') {
      const id = String(call.args.lpt_id), p = positions.get(id)!;
      if (mode === 'revert') return complete({ root: { ...root, status: failure }, rs: [], status: failure }, { native: c.native - 1n });
      const [principalX, principalY] = valueOf(p), x = principalX + feeX, y = principalY + feeY, wrapped = mode === 'wrapped';
      positions.delete(id);
      const built = removeBuilt({ lptId: id, left: p.left, right: p.right, amount: p.amount, remaining: 0n, x, y, wrapped, minX: String(call.args.min_amount_x), minY: String(call.args.min_amount_y) });
      setEvent(built, { claim_fee_token_x: String(feeX), claim_fee_token_y: String(feeY) });
      feeX = feeY = 0n;
      return complete(built,
        { native: c.native - 1n + (wrapped ? 0n : y), wnear: c.wnear + (wrapped ? y : 0n), usdc: c.usdc + x });
    }
    assert.equal(call.methodName, 'withdraw_asset');
    const token = String(call.args.token_id), amount = BigInt(assets[token]);
    const rs: Receipt[] = []; root.children = [];
    payout(token, amount, rs, root.children);
    delete assets[token];
    return complete({ root, rs }, { native: c.native - 1n + (token === WNEAR ? amount : 0n), usdc: c.usdc + (token === USDC ? amount : 0n) });
  };
  const d: WorkerDeps = { store: db.worker, rpc, kek: Buffer.alloc(32, 3), now: () => clock, origin, live: true, lpV1: true, provider: fullAccess,
    outlayer: dummyOutLayer({
      register: async () => ({ error: null, result: { walletId: 'wallet-lp', nearAccountId: agent, apiKey: new SecretString('wk_mock'), managementLink: new SecretString('https://example.test/mock') } }),
      encryptPolicy: async (_key, _id, rr) => { rules = rr; return { encryptedBase64: 'QUFBQQ==' }; },
      signPolicy: async (_key, _encrypted, caller) => { assert.equal(caller, owner); return { publicKeyHex: agent, signatureHex: 'b'.repeat(128), version: 1, locked: false, validUntil: 1794912708 }; },
      getPolicy: async () => ({ http: 200, policy: 'stored', rules, frozen: false, approval: null, capabilities: null }),
      call: async (_key, req, idem) => liveCall(req, idem),
      storageDeposit: async (_key, token, to, idem) => {
        submissions.push({ call: 'storage_deposit', idem });
        const account = to ?? agent;
        c.registration.add(`${token}:${account}`);
        return complete({ root: rootOf({ receiverId: token, methodName: 'storage_deposit', args: { account_id: account, registration_only: true }, gas: GAS.simpleCall, deposit: MONEY.storageDeposit }, success()), rs: [] },
          { native: c.native - MONEY.storageDeposit - 1n });
      },
      transfer: async (_key, to, n, idem) => {
        submissions.push({ call: 'transfer', idem });
        assert.equal(to, owner);
        return complete({ root: { id: 'root', from: agent, to, a: transfer(n), status: success() }, rs: [] }, { native: c.native - n - 1n });
      },
    }) };
  d.store.acquireWorkerLock(process.pid, clock);
  db.watch.heartbeat('watchdog', clock);
  const session = 'a'.repeat(43), foreign = 'b'.repeat(43);
  db.web.putSession(tokenHash(session), owner, clock, clock + 7 * 86_400_000);
  db.web.putSession(tokenHash(foreign), 'foreign.near', clock, clock + 7 * 86_400_000);
  const request = async (path: string, input?: object, token = session) => {
    const run = createHandler({ store: db.web, rpc, now: d.now, ai: !!d.ai, env: { host: '127.0.0.1', port: 8090, origin, liveHires: true, lpV1: lpWeb }, provider: fullAccess, wait: () => processReveals(d) });
    const req = Object.assign(Readable.from(input === undefined ? [] : [Buffer.from(JSON.stringify(input))]), { url: path, method: input ? 'POST' : 'GET',
      headers: { host: 'app.test', origin, cookie: `fourlpha_session=${token}`, 'content-type': 'application/json' } });
    let response = '';
    const res = { statusCode: 200, setHeader() {}, end(text: string) { response = text; } };
    await run(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    return { status: res.statusCode, data: (JSON.parse(response) as { data: unknown }).data, text: response };
  };
  // A pending step is evaluated at once. An idle job moves on past the one-minute evaluation gate.
  const skip = (ms: number) => { clock += ms; db.watch.heartbeat('watchdog', clock); };
  const tick = async (id: string) => { skip(d.store.lp(id)?.state?.pending ? 1000 : 200_000); return advanceJob(d, id); };
  async function hire() {
    const input = { kind: 'lp', mode: 'live', pair: 'usdc-wnear', depositYocto: deposit.toString(), ...(lp ? { lp } : {}) };
    assert.equal((await request('/api/jobs', { ...input, depositYocto: (LP_MIN_DEPOSIT - 1n).toString() })).status, 400);
    assert.equal((await request('/api/jobs', { ...input, depositYocto: ((lp ? 3n * N : MONEY.maxDeposit) + 1n).toString() })).status, 400);
    const start = await request('/api/jobs', input);
    assert.equal(start.status, 201);
    const { id } = start.data as { id: string }, path = `/api/jobs/${id}`;
    assert.equal(db.web.getJob(id)?.lpV1, true); assert.equal(db.web.getJob(id)?.gridV1, false); assert.equal(db.web.getJob(id)?.kind, 'lp');
    assert.equal(await advanceJob({ ...d, lpV1: false }, id), 'draft');
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
  async function run() {
    const { id, path } = await hire();
    const view = async () => (await request(path)).data as { canFund: boolean; lp: { canRegister: boolean; registered: boolean }; grid: unknown; canStopEarly: boolean };
    assert.equal((await view()).canFund, false);
    assert.equal((await view()).lp.canRegister, true);
    // Public agent page (audit M-1): a visitor's answer never offers the owner-paid registration.
    assert.equal(((await request(`/api/public/jobs/${id}`)).data as { lp: { canRegister: boolean } }).lp.canRegister, false);
    assert.equal((await view()).grid, null);
    assert.equal((await request(`${path}/dcl-registration`, {}, foreign)).status, 404);
    const attempts = await Promise.all([request(`${path}/dcl-registration`, {}), request(`${path}/dcl-registration`, {})]);
    assert.deepEqual(attempts.map(a => a.status).sort(), [200, 409]);
    assert.deepEqual(attempts.find(a => a.status === 200)?.data, { receiverId: DCL, methodName: 'storage_deposit', gas: '50000000000000', deposit: String(DCL_STORAGE),
      args: { account_id: agent, registration_only: true }, caller: owner });
    assert.equal((await view()).canFund, false);
    sponsor = 'foreign.near';
    assert.equal((await view()).canFund, false);
    sponsor = owner;
    assert.equal((await view()).canFund, true);
    c.setHoldings({ native: deposit, height: c.height + 1 });
    for (let i = 0; i < 12 && d.store.getJob(id)?.state !== 'running'; i++) await tick(id);
    assert.equal(d.store.getJob(id)?.state, 'running');
    return { id, path };
  }
  return { ...db, c, d, rpc, positions, extraRows, assets, lost, tick, skip, hire, run, request, submissions, deposit,
    setPoint: (v: number) => { current = v; }, setSponsor: (v: string) => { sponsor = v; }, setMode: (v: typeof mode) => { mode = v; }, setLpWeb: (v: boolean) => { lpWeb = v; }, setVersion: (v: string) => { dclVersion = v; },
    setFees: (x: bigint, y: bigint, included = false) => { feeX = x; feeY = y; predictionFees = included; },
    now: () => clock, state: (id: string) => db.worker.lp(id)?.state as LpState };
}
type Harness = ReturnType<typeof setup>;

async function tickUntil(h: Harness, id: string, ready: () => boolean, limit = 60) {
  for (let i = 0; i < limit && !ready(); i++) await h.tick(id);
  assert.ok(ready(), h.worker.getJob(id)?.reason ?? 'LP did not reach the expected checkpoint');
}
const opened = (h: Harness, id: string) => async () => { await tickUntil(h, id, () => !!h.state(id)?.position); };
const calls = (h: Harness, from = 0) => h.submissions.slice(from).map(s => s.call);
/** Out of range on the given side, confirmed after the five-minute window (with margin). */
async function leave(h: Harness, id: string, point: number) {
  h.setPoint(point);
  await h.tick(id);
  assert.equal(h.state(id).out?.side, point < P ? 'below' : 'above');
  h.skip(600_000);
  h.c.setHoldings({ height: h.c.height + 1 });
}

test('a fresh LP hire runs registration, setup, bootstrap and open, with the watchdog silent throughout', async t => {
  const h = setup(t), { id } = await h.run();
  const seen: string[] = [];
  await h.tick(id);
  assert.equal(h.state(id).ledger.native, String(4n * N / 10n));
  assert.deepEqual(h.state(id).swap, { tokenIn: WNEAR, amount: String(N / 5n) });
  for (let i = 0; i < 40 && !h.state(id).position; i++) {
    await h.tick(id);
    seen.push(...(await watchOnce({ store: h.watch, rpc: h.rpc, now: h.d.now })).filter(a => a.severity !== 'info').map(a => a.kind));
  }
  assert.ok(h.state(id).position, 'the position opened');
  assert.deepEqual(h.submissions.filter(s => s.call !== 'storage_deposit').map(s => s.call), ['near_deposit', 'ft_transfer_call', 'near_deposit', 'ft_transfer_call', 'ft_transfer_call', 'add_liquidity']);
  assert.deepEqual(seen, []);
  const s = h.state(id);
  assert.equal(s.position!.left, P - 100); assert.equal(s.position!.right, P + 100);
  assert.deepEqual(s.ledger, { usdc: String(REFUND_X), wnear: '0', native: '0', inUsdc: '0', inWnear: '0' });
  assert.equal(s.swap, null); assert.equal(s.failures, 0);
  assert.equal(h.c.wnear, 0n); assert.equal(h.c.usdc, REFUND_X);
  assert.deepEqual(h.assets, {});
  // The page view reports where the amounts sit and the estimate read, and the job stays quiet while in range.
  const view = (await h.request(`/api/jobs/${id}`)).data as { lp: { range: { inRange: boolean }; position: { estimate: string[] | null; id: string }; rotations: number; ledger: object } };
  assert.equal(view.lp.range.inRange, true); assert.deepEqual(view.lp.position.estimate, [String(MID_X - REFUND_X), String(MID_Y - REFUND_Y)]); assert.equal(view.lp.rotations, 0);
  const count = h.submissions.length;
  await h.tick(id); await h.tick(id);
  assert.equal(h.submissions.length, count);
  assert.equal(h.worker.getJob(id)?.reason, 'In range.');
  // The estimate read is caught: a failed read labels the estimate unavailable and the rest of the view renders.
  const real = h.rpc.view;
  h.rpc.view = async (contract, method, args, block) => { if (method === 'predict_remove_liquidity') throw new Error('E207'); return real(contract, method, args, block); };
  const noEstimate = (await h.request(`/api/jobs/${id}`)).data as typeof view;
  assert.equal(noEstimate.lp.position.estimate, null); assert.equal(noEstimate.lp.range.inRange, true);
  h.rpc.view = real;
});

test('an out-of-range event that returns within five minutes does not rotate, and a bad deposit is refused at the form', async t => {
  const h = setup(t), { id } = await h.run();
  await opened(h, id)();
  const count = h.submissions.length;
  h.setPoint(P + 150);
  await h.tick(id);
  assert.equal(h.state(id).out?.side, 'above');
  h.skip(120_000);
  h.setPoint(P);
  await h.tick(id);
  assert.equal(h.state(id).out, null);
  h.setPoint(P + 150);
  await h.tick(id);
  assert.ok(h.state(id).out);
  h.skip(61_000); h.c.setHoldings({ height: h.c.height + 1 });
  await advanceJob(h.d, id);
  assert.match(h.worker.getJob(id)?.reason ?? '', /confirming/);
  assert.equal(h.state(id).pending, null, 'nothing is scheduled one minute in');
  assert.equal(h.submissions.length, count);
  // With the LP flag off, the options say so and the route refuses an LP hire.
  assert.equal(((await h.request('/api/hire/options')).data as { lpV1: boolean; lp: { minDeposit: bigint } }).lpV1, true);
  h.setLpWeb(false);
  assert.equal(((await h.request('/api/hire/options')).data as { lpV1: boolean; lp: unknown }).lp, null);
  assert.equal((await h.request('/api/jobs', { kind: 'lp', mode: 'live', pair: 'usdc-wnear', depositYocto: LP_MIN_DEPOSIT.toString() })).status, 400);
  h.setLpWeb(true);
  assert.equal(draftProblems({ session: { accountId: owner }, kind: 'lp', mode: 'live', pair: 'usdc-wnear', depositYocto: N.toString(), liveEnabled: true, lpV1: true, liveJobs: 0, ownerPendingLive: 0 }).length, 1);
  assert.deepEqual(draftProblems({ session: { accountId: owner }, kind: 'lp', mode: 'live', pair: 'usdc-wnear', depositYocto: LP_MIN_DEPOSIT.toString(), liveEnabled: true, lpV1: true, liveJobs: 0, ownerPendingLive: 0 }), []);
  assert.equal(draftProblems({ session: { accountId: owner }, kind: 'lp', mode: 'live', pair: 'usdc-wnear', depositYocto: LP_MIN_DEPOSIT.toString(), liveEnabled: true, liveJobs: 0, ownerPendingLive: 0 }).length, 1);
});

test('confirmed rotations from below and above, a native payout wrapped in two steps, and the third blocked by the cap', async t => {
  const h = setup(t), { id } = await h.run();
  await opened(h, id)();
  const first = h.state(id).position!.id;
  // Below the range: all USDC. The planner swaps half of it to NEAR, wraps, deposits both and reopens.
  await leave(h, id, P - 150);
  let from = h.submissions.length;
  await tickUntil(h, id, () => !!h.state(id).position && h.state(id).position!.id !== first);
  assert.deepEqual(calls(h, from), ['remove_liquidity', 'ft_transfer_call', 'near_deposit', 'ft_transfer_call', 'ft_transfer_call', 'add_liquidity']);
  assert.equal(h.state(id).position!.left, P - 150 - 100);
  const removeRow = h.worker.jobOps(id).find(o => o.kind === 'dcl_remove')!;
  assert.equal(removeRow.verdict, 'success');
  assert.equal(JSON.parse(removeRow.request).args.min_amount_x, String(ALL_X * 9_900n / 10_000n));
  assert.equal(JSON.parse(removeRow.request).args.min_amount_y, '0');
  assert.equal(lpRotations(h.worker.jobOps(id), h.now()), 1);
  assert.equal((await watchOnce({ store: h.watch, rpc: h.rpc, now: h.d.now })).some(a => a.severity !== 'info'), false);
  // Above the range: all NEAR, paid natively, about 0.4 NEAR, wrapped in two steps around the swap.
  const second = h.state(id).position!.id;
  h.setPoint(P + 300);
  await h.tick(id); h.skip(600_000); h.c.setHoldings({ height: h.c.height + 1 });
  from = h.submissions.length;
  await tickUntil(h, id, () => !!h.state(id).position && h.state(id).position!.id !== second);
  assert.deepEqual(calls(h, from), ['remove_liquidity', 'near_deposit', 'ft_transfer_call', 'near_deposit', 'ft_transfer_call', 'ft_transfer_call', 'add_liquidity']);
  assert.equal(lpRotations(h.worker.jobOps(id), h.now()), 2);
  assert.equal((await watchOnce({ store: h.watch, rpc: h.rpc, now: h.d.now })).some(a => a.severity !== 'info'), false);
  // A third confirmed departure is blocked by the cap, which reads the journal.
  const third = h.state(id).position!;
  const count = h.submissions.length;
  h.setPoint(third.left - 50);
  await h.tick(id); h.skip(600_000); h.c.setHoldings({ height: h.c.height + 1 });
  await h.tick(id);
  assert.match(h.worker.getJob(id)?.reason ?? '', /rotation limit of 2 per 24 hours/);
  assert.equal(h.submissions.length, count);
  h.skip(86_400_000); h.c.setHoldings({ height: h.c.height + 1 });
  await h.tick(id);
  assert.equal(h.state(id).pending?.kind, 'dcl_remove');
});

test('a removal that reverts (its minimum can fail on slippage) clears the confirmation and counts a failure, and three failures halt', async t => {
  const h = setup(t), { id } = await h.run();
  await opened(h, id)();
  await leave(h, id, P + 150);
  h.setMode('revert');
  const count = h.submissions.length;
  await tickUntil(h, id, () => h.state(id).failures === 1);
  assert.deepEqual(calls(h, count), ['remove_liquidity']);
  assert.ok(h.state(id).position); assert.equal(h.state(id).out, null);
  assert.equal(h.worker.jobOps(id).find(o => o.kind === 'dcl_remove')?.verdict, 'reverted');
  assert.equal(h.worker.getJob(id)?.state, 'running');
  // Deposit refusals: three in a row halt the job.
  const g = setup(t), { id: gid } = await g.run();
  g.setMode('refund');
  await tickUntil(g, gid, () => g.worker.getJob(gid)?.state === 'halted', 80);
  assert.equal(g.state(gid).failures, LP_MAX_FAILURES);
  assert.match(g.worker.getJob(gid)?.reason ?? '', /failed 3 times/);
  assert.equal(g.worker.jobOps(gid).filter(o => o.kind === 'dcl_deposit').length, 3);
});

test('a crash after submission is replayed once from the journal', async t => {
  let restarted: ReturnType<typeof openStore> | undefined;
  t.after(() => restarted?.close());
  const h = setup(t), { id } = await h.run();
  await h.tick(id); await h.tick(id);
  const pending = h.state(id).pending!;
  assert.equal(pending.kind, 'wrap');
  assert.equal((await createLiveOps({ ...h.d, jobId: id }).wrap(BigInt(pending.amount))).verdict, 'success');
  assert.equal(h.state(id).ledger.native, String(4n * N / 10n));
  h.worker.releaseWorkerLock();
  restarted = openStore(h.path, 'worker');
  assert.ok(restarted.acquireWorkerLock(process.pid, testNow)); h.d.store = restarted;
  await Promise.all([h.tick(id), h.tick(id)]);
  assert.equal(h.state(id).ledger.native, String(N / 5n));
  assert.equal(h.worker.gridStep(id, pending.id)?.verdict, 'success');
  assert.equal(h.submissions.filter(x => x.call === 'near_deposit').length, 1);
});

test('a threw-before-submission step replans, and the add range is re-centred when the point drifts', async t => {
  const h = setup(t), { id } = await h.run();
  await tickUntil(h, id, () => h.state(id)?.pending?.kind === 'dcl_add');
  const stale = h.state(id).pending!, count = h.submissions.length, sequence = h.state(id).sequence;
  assert.equal(stale.left, P - 100);
  h.setPoint(P + LP_CENTRE_TOLERANCE + 1);
  await h.tick(id);
  assert.equal(h.worker.gridStep(id, stale.id), null);
  assert.equal(h.state(id).pending, null); assert.equal(h.state(id).sequence, sequence + 1);
  assert.equal(h.submissions.length, count);
  await h.tick(id);
  assert.equal(h.state(id).pending?.left, P + LP_CENTRE_TOLERANCE + 1 - 100);
  await h.tick(id);
  assert.equal(h.state(id).position?.left, P + LP_CENTRE_TOLERANCE + 1 - 100);
  // A point within the tolerance still opens.
  const g = setup(t), { id: gid } = await g.run();
  await tickUntil(g, gid, () => g.state(gid)?.pending?.kind === 'dcl_add');
  g.setPoint(P + LP_CENTRE_TOLERANCE);
  await g.tick(gid);
  assert.equal(g.state(gid).position?.left, P - 100);
});

test('the evaluation cadence gates an idle job to once a minute and never delays a pending step', async t => {
  const h = setup(t), { id } = await h.run();
  await opened(h, id)();
  let reads = 0;
  const real = h.rpc.view;
  h.rpc.view = async (contract, method, args, block) => { reads++; return real(contract, method, args, block); };
  const evaluate = async () => { reads = 0; h.skip(61_000); await advanceJob(h.d, id); return reads; };
  assert.ok(await evaluate() > 0);
  for (let i = 0; i < 5; i++) { reads = 0; h.skip(5_000); await advanceJob(h.d, id); assert.equal(reads, 0); }
  assert.ok(await evaluate() > 0);
  // A pending step is evaluated on the very next tick, far inside the gate. This one is refused before submission because the price is in range.
  const s = h.state(id), position = s.position!, sent = h.submissions.length, resting = h.positions.size;
  assert.ok(h.worker.saveLp(h.worker.getJob(id)!, s, { ...s, pending: { id: `${id}:${s.sequence}`, kind: 'dcl_remove', amount: position.liquidity, lptId: position.id, minX: '0', minY: '0', side: 'below' } }));
  reads = 0; h.skip(1_000);
  await advanceJob(h.d, id);
  assert.ok(reads > 0);
  assert.equal(h.state(id).pending, null); assert.equal(h.state(id).sequence, s.sequence + 1);
  assert.equal(h.submissions.length, sent); assert.equal(h.positions.size, resting);
  h.rpc.view = real;
});

test('the 1 NEAR job cannot afford the swap after a rotation from below and a 1.2 NEAR job can', async t => {
  const h = setup(t), { id } = await h.run();
  await opened(h, id)();
  await leave(h, id, P - 150);
  await tickUntil(h, id, () => h.state(id).pending?.kind === 'swap');
  const before = h.submissions.length;
  // About 0.589 NEAR free (a 1 NEAR job) against the 0.62 NEAR the 300 Tgas swap needs, then 0.789 (1.2 NEAR).
  h.c.setHoldings({ native: 589_000_000_000_000_000_000_000n + 1_820_000_000_000_000_000_000n });
  await h.tick(id);
  assert.equal(calls(h, before).length, 0);
  assert.match(h.worker.getJob(id)?.reason ?? '', /more free NEAR/);
  h.c.setHoldings({ native: 789_000_000_000_000_000_000_000n + 1_820_000_000_000_000_000_000n });
  await tickUntil(h, id, () => calls(h, before).includes('ft_transfer_call'));
});

test('internal balances, lost-found value or a drifted position that the ledger does not hold halt the strategy', async t => {
  const cases: [string, (h: Harness) => void][] = [
    ['an internal balance', h => { h.assets[USDC] = '3267'; }],
    ['a lost-found balance', h => { h.lost[USDC] = '1'; }],
    ['a position whose liquidity drifted', h => { h.positions.get([...h.positions.keys()][0])!.amount = LIQ - 1n; }],
  ];
  for (const [label, change] of cases) {
    const h = setup(t), { id } = await h.run();
    await opened(h, id)();
    change(h);
    const count = h.submissions.length;
    assert.equal(await h.tick(id), 'halted', label);
    assert.equal(h.submissions.length, count, label);
  }
});

test('a freeze keeps the resting position, and a signed resume returns to running with it', async t => {
  const h = setup(t), { id, path } = await h.run();
  await opened(h, id)();
  const position = h.state(id).position!.id;
  h.c.freeze(true);
  assert.equal(await h.tick(id), 'frozen');
  assert.equal(h.positions.size, 1);
  h.c.freeze(false);
  assert.equal(await h.tick(id), 'paused');
  const ch = (await h.request(`/api/challenge?purpose=resume&job=${id}`)).data as Challenge;
  assert.equal((await h.request(`${path}/resume`, { signed: identity()(ch) })).status, 200);
  assert.equal(await h.tick(id), 'ready');
  assert.equal(await h.tick(id), 'running');
  assert.equal(h.state(id).position!.id, position);
  const count = h.submissions.length;
  await h.tick(id);
  assert.equal(h.submissions.length, count);
});

test('a legacy LP blind halt can be checked with its existing position and obeys the LP web flag', async t => {
  const h = setup(t), { id, path } = await h.run();
  await opened(h, id)();
  const pass = () => watchOnce({ store: h.watch, rpc: h.rpc, now: h.now });
  await pass();
  h.watch.insertAlert({ jobId: id, kind: 'blind', severity: 'halt', detail: { message: 'Legacy blind halt.' }, createdAt: h.now() });
  assert.equal(await h.tick(id), 'halted');
  h.skip(1000);
  h.c.setHoldings({ height: h.c.height + 1 });
  assert.deepEqual(await pass(), []);
  const view = async () => (await h.request(path)).data as { canResumeBlind: boolean };
  assert.equal((await view()).canResumeBlind, true);
  h.setLpWeb(false);
  assert.equal((await view()).canResumeBlind, false);
  assert.equal((await h.request(`/api/challenge?purpose=resume&job=${id}`)).status, 409);
});

test('Stop and withdraw while frozen waits for the unfreeze, then exits through remove, withdraw and the sweep', async t => {
  const h = setup(t), { id, path } = await h.run();
  await opened(h, id)();
  h.c.freeze(true);
  assert.equal(await h.tick(id), 'frozen');
  assert.equal((await h.request(`${path}/stop`, {})).status, 200);
  assert.equal(await h.tick(id), 'stopping');
  const atFreeze = h.submissions.length;
  await h.tick(id); await h.tick(id);
  assert.equal(h.submissions.length, atFreeze);
  assert.equal(h.worker.getJob(id)?.reason, 'Unfreeze to withdraw.');
  assert.equal(h.positions.size, 1);
  // The exit does not need the LP switch, only the live worker.
  h.setLpWeb(false); h.d.lpV1 = false;
  h.c.freeze(false);
  await tickUntil(h, id, () => h.worker.getJob(id)?.state === 'stopped');
  const exit = calls(h, atFreeze);
  assert.equal(exit[0], 'remove_liquidity');
  assert.ok(!exit.includes('add_liquidity') && !exit.includes('ft_transfer_call'));
  assert.equal(h.positions.size, 0); assert.deepEqual(h.assets, {});
  assert.equal(h.c.usdc, 0n); assert.equal(h.c.wnear, 0n);
  assert.equal(new Set(h.submissions.map(x => x.idem)).size, h.submissions.length);
});

test('an exit works when only an unstated amount of internal balance is left behind the removal', async t => {
  const h = setup(t), { id, path } = await h.run();
  await opened(h, id)();
  h.setMode('wrapped');
  // Internal leftovers like the P0.3 account's: the removal leaves them, and the exit withdraws them.
  assert.equal((await h.request(`${path}/stop`, {})).status, 200);
  await h.tick(id);
  h.assets[USDC] = '3267'; h.assets[WNEAR] = '685751675847075191309';
  await tickUntil(h, id, () => h.worker.getJob(id)?.state === 'stopped');
  assert.deepEqual(h.assets, {});
  assert.deepEqual(calls(h).filter(c => c === 'withdraw_asset').length, 2);
  assert.equal(h.c.usdc, 0n); assert.equal(h.c.wnear, 0n);
});

test('an add whose strict proof fails is still drained through the discovered position', async t => {
  const h = setup(t), { id, path } = await h.run();
  h.setMode('unpaid');
  await tickUntil(h, id, () => h.worker.getJob(id)?.state === 'halted');
  const add = h.worker.jobOps(id).find(o => o.kind === 'dcl_add')!;
  assert.equal(add.verdict, 'unclear');
  assert.equal(h.state(id).position, null);
  assert.deepEqual(lpKnownPositions(h.worker, id), [...h.positions.keys()]);
  h.setMode('normal');
  assert.equal((await h.request(`${path}/stop`, {})).status, 200);
  await tickUntil(h, id, () => h.worker.getJob(id)?.state === 'stopped');
  assert.equal(h.positions.size, 0);
});

test('an unknown, farmed or foreign-pool position blocks both strategy and exit', async t => {
  const cases: [string, (h: Harness) => void][] = [
    ['unknown', h => { h.extraRows.push({ lpt_id: lptOf(77), owner_id: agent, pool_id: DCL_POOL, left_point: P - 5, right_point: P + 5, amount: '5', mft_id: '', unclaimed_fee_x: '0', unclaimed_fee_y: '0' }); }],
    ['farmed', h => { h.positions.get([...h.positions.keys()][0])!.mft = ':78'; }],
    ['another pool', h => { h.extraRows.push({ lpt_id: `${USDC}|other.near|100#79`, owner_id: agent, pool_id: `${USDC}|other.near|100`, left_point: 1, right_point: 2, amount: '5', mft_id: '',
      unclaimed_fee_x: '0', unclaimed_fee_y: '0' }); }],
  ];
  for (const [label, change] of cases) await t.test(label, async st => {
    const h = setup(st), { id, path } = await h.run();
    await opened(h, id)();
    change(h);
    const count = h.submissions.length;
    assert.equal(await h.tick(id), 'halted');
    assert.equal(h.submissions.length, count);
    assert.equal((await h.request(`${path}/stop`, {})).status, 200);
    for (let i = 0; i < 4; i++) await h.tick(id);
    assert.equal(h.worker.getJob(id)?.state, 'stopping');
    assert.equal(h.submissions.length, count);
    assert.match(h.worker.getJob(id)?.reason ?? '', /DCL exit is blocked/);
    assert.equal(h.positions.size, 1);
  });
});

test('readDcl parses list_liquidities rows strictly, predictRemove maps every failure, and the gates read the rows', async t => {
  const h = setup(t), { id } = await h.run();
  await opened(h, id)();
  const snap = await readHoldings(h.rpc, agent, [WNEAR, USDC]);
  const state = await readDcl(h.rpc, agent, snap, []);
  assert.equal(state.liquidities.length, 1); assert.equal(state.positions, 1);
  assert.equal(state.liquidities[0].mft, ''); assert.equal(state.liquidities[0].feeX, 0n);
  const bad = async (patch: Record<string, unknown>, drop?: string) => {
    const row = { lpt_id: lptOf(5), owner_id: agent, pool_id: DCL_POOL, left_point: 1, right_point: 2, amount: '1', mft_id: '', unclaimed_fee_x: '0', unclaimed_fee_y: '0', ...patch };
    if (drop) delete (row as Record<string, unknown>)[drop];
    h.extraRows.splice(0, h.extraRows.length, row);
    return readDcl(h.rpc, agent, snap, []);
  };
  await assert.doesNotReject(bad({})); // v_liquidity is absent and not required.
  await assert.rejects(bad({}, 'mft_id'));
  await assert.rejects(bad({ owner_id: 'someone.near' }));
  await assert.rejects(bad({ left_point: 5, right_point: 5 }));
  await assert.rejects(bad({ lpt_id: 'bad' }));
  h.extraRows.splice(0);
  const [x, y] = await predictRemove(h.rpc, state.liquidities[0].id, state.liquidities[0].amount, snap);
  assert.deepEqual([x, y], [MID_X - REFUND_X, MID_Y - REFUND_Y]);
  await assert.rejects(predictRemove(h.rpc, lptOf(404), 1n, snap), { code: 'rpc_unavailable' });
  await assert.rejects(predictRemove(h.rpc, 'bad', 1n, snap), { code: 'rpc_unavailable' });
  // lpBlocked and lpGate.
  const known = [state.liquidities[0].id], lp = h.state(id);
  assert.equal(lpBlocked(state, known), false);
  assert.equal(lpBlocked(state, []), true);
  assert.equal(lpBlocked({ ...state, liquidities: [{ ...state.liquidities[0], mft: ':1' }] }, known), true);
  assert.equal(lpBlocked({ ...state, liquidities: [{ ...state.liquidities[0], pool: 'other' }] }, known), true);
  assert.equal(lpBlocked({ ...state, storage: { ...state.storage!, positions: 2 } }, known), true);
  assert.equal(lpBlocked({ ...state, storage: { ...state.storage!, orders: 1 } }, known), true);
  assert.equal(lpBlocked({ ...state, lost: { [USDC]: 1n } }, known), true);
  assert.equal(lpBlocked({ ...state, assets: { 'other.near': 1n } }, known), true);
  assert.equal(lpBlocked({ ...state, liquidities: [], storage: { ...state.storage!, positions: 0 } }, known), false, 'a known position that is not listed does not block');
  assert.equal(lpGate(lp, state, known), true);
  assert.equal(lpGate(lp, state, known, snap), true);
  assert.equal(lpGate(lp, state, known, { ...snap, tokens: { ...snap.tokens, [USDC]: 0n } }), false);
  assert.equal(lpGate({ ...lp, ledger: { ...lp.ledger, native: '1' } }, state, known, { ...snap, spendable: 0n }), false);
  assert.equal(lpGate(lp, { ...state, assets: { [USDC]: 1n } }, known), false);
  assert.equal(lpGate(lp, { ...state, liquidities: [] }, known), false);
  assert.equal(lpGate(null, state, known), false);
  assert.equal(lpGate(null, { ...state, liquidities: [], storage: { ...state.storage!, positions: 0 } }, []), true);
  assert.equal(lpGate({ ...lp, position: null }, { ...state, liquidities: [], storage: { ...state.storage!, positions: 0 } }, []), true);
});

test('exitBudget bounds an LP position from the recorded amounts, and refuses without them', async t => {
  const h = setup(t, 12n * N / 10n), { id } = await h.run();
  await opened(h, id)();
  const j = h.worker.getJob(id) as Job, snap = await readHoldings(h.rpc, agent, [WNEAR, USDC]), venue = await readDcl(h.rpc, agent, snap, []);
  const lp = { known: lpKnownPositions(h.worker, id), positions: [h.state(id).position!] };
  const empty = { ...venue, liquidities: [], storage: { ...venue.storage!, positions: 0 } };
  const base = await exitBudget(h.rpc, j, snap, 0n, empty, undefined, { known: [], positions: [] });
  const full = await exitBudget(h.rpc, j, snap, 0n, venue, undefined, lp);
  const p = venue.liquidities[0], paid = lp.positions[0];
  const { limitProceeds } = await import('../src/core/rhea-dcl.js');
  const wnearBound = BigInt(paid.paidY) + limitProceeds(USDC, BigInt(paid.paidX), p.right) + p.feeY;
  assert.equal(full.native - base.native, wnearBound);
  assert.ok(wnearBound > BigInt(paid.paidY));
  assert.ok(full.reserve > base.reserve);
  await assert.rejects(exitBudget(h.rpc, j, snap, 0n, venue, undefined, { known: lp.known, positions: [] }), { code: 'conflict' });
  await assert.rejects(exitBudget(h.rpc, j, snap, 0n, venue), { code: 'conflict' });
  await assert.rejects(exitBudget(h.rpc, j, snap, 0n, venue, undefined, { known: [], positions: lp.positions }), { code: 'conflict' });
  await assert.rejects(exitBudget(h.rpc, j, snap, 0n, undefined, undefined, lp), { code: 'conflict' });
});


/** A DCL job of the given kind with a sealed key, written straight into the database. */
function dclJob(h: Harness, kind: 'grid' | 'lp', state: 'running' | 'stopping' = 'running', deposit = 12n * N / 10n) {
  const j = h.web.createJob({ owner, kind, mode: 'live', pair: 'usdc-wnear', depositYocto: deposit, ...(kind === 'lp' ? { lpV1: true } : { gridV1: true }) }, testNow);
  const caps = defaultCaps(deposit, { [USDC]: 3756475n }), binding = { id: j.id, owner, walletId: 'wallet-test', agentAccount: agent };
  h.worker.acquireWorkerLock(process.pid, testNow);
  h.worker.attachWallet(j, 'wallet-test', agent, { apiKeyCt: seal(h.d.kek, new SecretString('wk_test_fake'), walletAad(binding, 'api_key')), linkCt: null }, testNow);
  h.worker.casJob(j.id, 'registered', 1, state, { caps, walletPubkey: `ed25519:${agent}`, rules: buildRules({ owner, depositYocto: deposit, maxDeposit: MONEY.maxDeposit, usesDcl: true, tokens: [USDC], caps }),
    armedHash: policyHash({ encrypted: 'QUFBQQ==', owner, frozen: false, storageDeposit: 0n }), linkConfirmedAt: testNow }, testNow);
  return h.worker.getJob(j.id)!;
}

/** A running LP job with a baseline watchdog pass, and journal rows written by hand. Each scenario has its own database, so alerts never mask each other. */
async function watched(t: Parameters<typeof stores>[0]) {
  const h = setup(t);
  h.c.setPolicy({ owner, encrypted_data: 'QUFBQQ==', frozen: false, storage_deposit: '15000000000000000000000' });
  h.c.setHoldings({ native: N, usdc: 0n, wnear: 0n, height: 100 });
  h.setSponsor(owner);
  const job = dclJob(h, 'lp');
  let height = 100, serial = 0;
  const pass = async (to = ++height) => {
    height = to; h.c.setHoldings({ height });
    return (await watchOnce({ store: h.watch, rpc: h.rpc, now: () => testNow + 600_000 })).filter(a => a.severity !== 'info').map(a => a.kind);
  };
  const insert = (patch: Partial<OpRow>) => {
    const id = `op-${++serial}`;
    const o: OpRow = { id, jobId: job.id, walletId: job.walletId!, kind: 'dcl_deposit', purpose: 'strategy', idemKey: id, request: '{}', state: 'submitted', counted: 1, nativeSpend: 0n,
      http: null, code: null, requestId: null, txHash: null, verdict: null, used: null, nativeIn: null, gasBurnt: null, before: null, after: null, message: null,
      createdAt: testNow, submittedAt: testNow, finishedAt: null, finishedBlock: null, ...patch };
    assert.ok(h.worker.insertOp(o));
    return o;
  };
  const deposit = (token: DclToken, n: bigint, patch: Partial<OpRow> = {}) => insert({ kind: 'dcl_deposit', request: json(intentOf(dclDeposit(token, n))), ...patch });
  const provenDeposit = (token: DclToken, n: bigint, block: number) => deposit(token, n, { state: 'finished', verdict: 'success', used: n, finishedBlock: block, after: json({ dclProof: { payouts: {} } }) });
  const add = (patch: Partial<OpRow> = {}) => insert({ kind: 'dcl_add', request: json(intentOf(lpAdd(P - 100, P + 100, MID_X, MID_Y))), ...patch });
  const open = (id = lptOf(500)) => h.positions.set(id, { left: P - 100, right: P + 100, amount: LIQ, paidX: MID_X, paidY: MID_Y });
  const provenAdd = (id: string, block: number) => add({ state: 'finished', verdict: 'success', finishedBlock: block, after: json({ dclProof: { lptId: id, liquidity: LIQ, payouts: {} } }) });
  assert.deepEqual(await pass(), []);
  return { h, job, pass, insert, deposit, provenDeposit, add, open, provenAdd };
}

test('LP watchdog stays quiet through the pending windows of a whole open and rotation', async t => {
  const w = await watched(t), { h } = w;
  // A deposit in flight may or may not show in the internal balance yet.
  const dep = w.deposit(USDC, MID_X);
  assert.deepEqual(await w.pass(), []);
  h.assets[USDC] = String(MID_X);
  assert.deepEqual(await w.pass(), [], 'visible while the row is still submitted');
  // An ambiguous row keeps its window.
  h.worker.updateOp(dep.id, { state: 'ambiguous' });
  assert.deepEqual(await w.pass(), []);
  // Finished after the snapshot is still pending, then settled.
  h.worker.updateOp(dep.id, { state: 'finished', verdict: 'success', used: MID_X, finishedBlock: 120, after: json({ dclProof: { payouts: {} } }) });
  assert.deepEqual(await w.pass(110), [], 'between the root receipt and finishedBlock');
  assert.deepEqual(await w.pass(121), []);
  w.provenDeposit(WNEAR, MID_Y, 122); h.assets[WNEAR] = String(MID_Y);
  assert.deepEqual(await w.pass(123), []);
  // A pending add takes both balances and a position appears on its points.
  const add = w.add();
  delete h.assets[USDC]; delete h.assets[WNEAR]; w.open();
  assert.deepEqual(await w.pass(), []);
  h.worker.updateOp(add.id, { state: 'finished', verdict: 'success', finishedBlock: 140, after: json({ dclProof: { lptId: lptOf(500), liquidity: LIQ, payouts: {} } }) });
  assert.deepEqual(await w.pass(130), [], 'the add is finished after this snapshot');
  assert.deepEqual(await w.pass(141), []);
  // A pending removal may already have taken the position.
  const rem = w.insert({ kind: 'dcl_remove', request: json(intentOf(lpRemove(lptOf(500), LIQ, '0', '0'))) });
  h.positions.delete(lptOf(500));
  assert.deepEqual(await w.pass(), []);
  h.worker.updateOp(rem.id, { state: 'finished', verdict: 'success', finishedBlock: 160, after: json({ dclProof: { lptId: lptOf(500), payouts: {} } }) });
  assert.deepEqual(await w.pass(161), []);
  // The LP state shape keeps Grid's order key out of the baseline.
  const dcl = JSON.parse(h.watch.getWatch(w.job.id)!.holdings).dcl as Record<string, unknown>;
  assert.deepEqual(Object.keys(dcl).sort(), ['assets', 'positions']);
});

test('LP watchdog raises dcl_holding and dcl_outflow on each rule, and an ambiguous row does not blind it', async t => {
  const holding = async (label: string, prepare: (w: Awaited<ReturnType<typeof watched>>) => void | Promise<void>) => {
    const w = await watched(t); await prepare(w);
    assert.deepEqual(await w.pass(), ['dcl_holding'], label);
  };
  const outflow = async (label: string, prepare: (w: Awaited<ReturnType<typeof watched>>) => void | Promise<void>) => {
    const w = await watched(t); await prepare(w);
    assert.deepEqual(await w.pass(), ['dcl_outflow'], label);
  };
  await holding('an internal balance nothing explains', w => { w.h.assets[USDC] = '5'; });
  await holding('an internal balance above a pending deposit', w => { w.deposit(USDC, 10n); w.h.assets[USDC] = '11'; });
  await holding('an internal balance above a settled deposit', w => { w.provenDeposit(USDC, 10n, 100); w.h.assets[USDC] = '11'; });
  await holding('an ambiguous row does not hide it', w => { w.deposit(USDC, 10n, { state: 'ambiguous' }); w.h.assets[USDC] = '11'; });
  await holding('an unknown position', w => { w.open(lptOf(600)); });
  await holding('an unknown position on other points than a pending add', w => { w.add(); w.h.positions.set(lptOf(600), { left: 1, right: 2, amount: 1n, paidX: 1n, paidY: 1n }); });
  await holding('two unknown positions', w => { w.add(); w.open(lptOf(600)); w.open(lptOf(601)); });
  await holding('a position outside the pinned pool', w => { w.h.extraRows.push({ lpt_id: `${USDC}|other.near|100#1`, owner_id: agent, pool_id: `${USDC}|other.near|100`, left_point: 1, right_point: 2, amount: '1', mft_id: '',
    unclaimed_fee_x: '0', unclaimed_fee_y: '0' }); });
  const opened = (w: Awaited<ReturnType<typeof watched>>) => { w.provenDeposit(USDC, MID_X, 80); w.provenDeposit(WNEAR, MID_Y, 81); w.provenAdd(lptOf(500), 90); };
  await holding('a farmed position', w => { opened(w); w.h.positions.set(lptOf(500), { left: P - 100, right: P + 100, amount: LIQ, paidX: 1n, paidY: 1n, mft: ':1' }); });
  await outflow('a known position that vanished', w => { opened(w); });
  await outflow('a known position that shrank', w => { opened(w); w.h.positions.set(lptOf(500), { left: P - 100, right: P + 100, amount: LIQ - 1n, paidX: 1n, paidY: 1n }); });
  await outflow('an internal balance below a settled deposit', w => { w.provenDeposit(USDC, 10n, 90); w.h.assets[USDC] = '9'; });
  // A refunded deposit adds nothing to what DCL is expected to hold.
  const w = await watched(t);
  w.deposit(USDC, 10n, { state: 'finished', verdict: 'refunded', used: 0n, finishedBlock: 90, after: json({ dclProof: { payouts: {} } }) });
  assert.deepEqual(await w.pass(), []);
  w.h.assets[USDC] = '1';
  assert.deepEqual(await w.pass(), ['dcl_holding']);
});

test('the confirmation window is five minutes: nothing is scheduled before it, the removal is scheduled at it', async t => {
  const h = setup(t), { id } = await h.run();
  await opened(h, id)();
  const poll = async (ms: number) => { h.skip(ms); h.c.setHoldings({ height: h.c.height + 1 }); await advanceJob(h.d, id); };
  h.setPoint(P + 150);
  await h.tick(id);
  assert.equal(h.state(id).out?.side, 'above');
  await poll(120_000);
  assert.equal(h.state(id).pending, null, 'two minutes in');
  await poll(119_000);
  assert.equal(h.state(id).pending, null, 'one minute before the end of the window');
  await poll(61_000);
  assert.equal(h.state(id).pending?.kind, 'dcl_remove', 'five minutes after the first check');
  assert.equal(h.state(id).pending?.side, 'above');
});

test('a change of side restarts the confirmation', async t => {
  const h = setup(t), { id } = await h.run();
  await opened(h, id)();
  const poll = async (ms: number) => { h.skip(ms); h.c.setHoldings({ height: h.c.height + 1 }); await advanceJob(h.d, id); };
  h.setPoint(P - 150);
  await h.tick(id);
  assert.equal(h.state(id).out?.side, 'below');
  h.setPoint(P + 150);
  await poll(120_000);
  const flipped = h.state(id).out!;
  assert.equal(flipped.side, 'above'); assert.equal(flipped.since, h.now());
  assert.equal(h.state(id).pending, null);
  await poll(180_000);
  assert.equal(h.state(id).pending, null, 'five minutes after the first side, but three after the flip');
  assert.equal(h.state(id).out?.since, flipped.since);
  await poll(120_000);
  assert.equal(h.state(id).pending?.kind, 'dcl_remove', 'five minutes after the flip');
});

test('jobDclKinds scopes the DCL kinds to the job kind', () => {
  assert.deepEqual(jobDclKinds({ gridV1: true, lpV1: false }), GRID_DCL_KINDS);
  assert.deepEqual(jobDclKinds({ gridV1: false, lpV1: true }), LP_DCL_KINDS);
  assert.deepEqual(jobDclKinds({ gridV1: false, lpV1: false }), []);
  assert.deepEqual([...GRID_DCL_KINDS].sort(), ['dcl_cancel', 'dcl_claim', 'dcl_place', 'dcl_withdraw']);
  assert.deepEqual([...LP_DCL_KINDS].sort(), ['dcl_add', 'dcl_deposit', 'dcl_remove', 'dcl_withdraw']);
});

test('a Grid job cannot sign LP calls and an LP job cannot place orders', async t => {
  const g = setup(t), l = setup(t);
  const grid = dclJob(g, 'grid'), lp = dclJob(l, 'lp');
  const gridOps = createLiveOps({ ...g.d, gridV1: true, jobId: grid.id }), lpOps = createLiveOps({ ...l.d, jobId: lp.id });
  await assert.rejects(gridOps.depositDcl!(USDC, 1n), { code: 'forbidden' });
  await assert.rejects(gridOps.addLp!(P - 100, P + 100, 1n, 1n), { code: 'forbidden' });
  await assert.rejects(gridOps.removeLp!(lptOf(1), 1n, '0', '0', 'strategy'), { code: 'forbidden' });
  await assert.rejects(lpOps.placeDcl!(USDC, 1n, P + 100), { code: 'forbidden' });
  assert.equal(g.submissions.length + l.submissions.length, 0);
});

test('the operations layer refuses LP strategy calls when the LP switch is off, and exits only with the live worker', async t => {
  const h = setup(t), job = dclJob(h, 'lp');
  await assert.rejects(createLiveOps({ ...h.d, lpV1: false, jobId: job.id }).wrap(1n), { code: 'live_disabled' });
  const stopping = setup(t), exiting = dclJob(stopping, 'lp', 'stopping');
  await assert.rejects(createLiveOps({ ...stopping.d, live: false, jobId: exiting.id }).removeLp!(lptOf(1), 1n, '0', '0', 'exit'), { code: 'live_disabled' });
  // The LP switch alone does not stop an exit: it fails later, on the missing position, and not as a disabled switch.
  await assert.rejects(createLiveOps({ ...stopping.d, lpV1: false, jobId: exiting.id }).removeLp!(lptOf(1), 1n, '0', '0', 'exit'), (e: unknown) => (e as { code?: string }).code !== 'live_disabled');
  assert.equal(h.submissions.length + stopping.submissions.length, 0);
});

test('the worker stops a running LP job with the LP switch off before any read, plan or state', async t => {
  const h = setup(t), { id } = await h.run();
  const count = h.submissions.length;
  h.d.lpV1 = false;
  await h.tick(id);
  assert.match(h.worker.getJob(id)?.reason ?? '', /LP is disabled/);
  assert.equal(h.worker.lp(id)?.state, null);
  assert.equal(h.submissions.length, count);
});

test('lpIntent holds a step to its kind, amount and range', () => {
  const state = { ledger: { usdc: '0', wnear: '0', native: '0', inUsdc: '1', inWnear: '1' }, swap: null, position: null, out: null, failures: 0, sequence: 1,
    pending: { id: 'job:1', kind: 'dcl_add', amount: '0', left: P - 100, right: P + 100 } } satisfies LpState;
  assert.equal(lpIntent(state, 'dcl_add', 0n, { left: P - 100, right: P + 100 }).id, 'job:1');
  assert.throws(() => lpIntent(state, 'dcl_add', 1n, { left: P - 100, right: P + 100 }), { code: 'conflict' });
  assert.throws(() => lpIntent(state, 'dcl_add', 0n, { left: P - 99, right: P + 100 }), { code: 'conflict' });
  assert.throws(() => lpIntent(state, 'dcl_add', 0n, { left: P - 100, right: P + 101 }), { code: 'conflict' });
  assert.throws(() => lpIntent(state, 'dcl_remove', 0n, { left: P - 100, right: P + 100 }), { code: 'conflict' });
  assert.throws(() => lpIntent({ ...state, pending: null }, 'dcl_add', 0n, { left: P - 100, right: P + 100 }), { code: 'conflict' });
});

test('LP watchdog: a snapshot from before the add is not a vanished position', async t => {
  const w = await watched(t), { h } = w;
  w.provenDeposit(USDC, MID_X, 80); w.provenDeposit(WNEAR, MID_Y, 81);
  h.assets[USDC] = String(MID_X); h.assets[WNEAR] = String(MID_Y);
  // The add finished at block 140. A snapshot at 130 predates its receipts: the position is not listed yet and the balances are not consumed yet.
  w.provenAdd(lptOf(500), 140);
  assert.deepEqual(await w.pass(130), []);
  delete h.assets[USDC]; delete h.assets[WNEAR]; w.open();
  assert.deepEqual(await w.pass(141), []);
});

const V2 = { range: { mode: 'server' }, ai: false, compound: { on: false }, stopLossPct: 0, takeProfitPct: 0 };

test('V2 3 NEAR hire prepares and arms, wraps 2.2 NEAR under the cap, and reserves the exit after every step', async t => {
  const h = setup(t, 3n * N, V2), { id } = await h.run();
  assert.equal(h.worker.getJob(id)?.lpV2, true);
  assert.deepEqual(h.worker.lpSettings(id), { ...V2, v: 2 });
  assert.deepEqual(h.watch.lpSettings(id), h.worker.lpSettings(id));
  assert.equal((await h.request(`/api/jobs/${id}/settings`, V2)).status, 404);
  assert.deepEqual(h.worker.lpSettings(id), { ...V2, v: 2 });
  const start = h.submissions.length;
  for (let i = 0; i < 50 && !h.state(id)?.position; i++) {
    await h.tick(id);
    const job = h.worker.getJob(id)!, s = await readHoldings(h.rpc, agent, [WNEAR, USDC]), venue = await readDcl(h.rpc, agent, s);
    const reserve = await exitBudget(h.rpc, job, s, 0n, venue, undefined, { known: lpKnownPositions(h.worker, id), positions: h.state(id)?.position ? [h.state(id).position!] : [] });
    assert.ok(h.worker.budgetView(job.walletId!, h.now()).nativeSpent24h + reserve.native <= job.caps!.nativeDaily);
  }
  assert.ok(h.state(id).position);
  const rows = h.worker.jobOps(id).filter(o => o.kind === 'wrap');
  assert.equal(rows.length, 10);
  assert.equal(rows.reduce((n, o) => n + BigInt((JSON.parse(o.request) as Intent).deposit), 0n), 22n * N / 10n);
  assert.ok(rows.every(o => BigInt((JSON.parse(o.request) as Intent).deposit) <= MONEY.nativePerTxCeiling - 1n));
  assert.equal(h.submissions.length - start, 14);
  assert.equal(await readPoolPoint(h.rpc), P);
  const options = (await h.request('/api/hire/options')).data as { lp: { maxDeposit: string; point: number; ai: boolean } };
  assert.deepEqual(options.lp, { minDeposit: String(LP_MIN_DEPOSIT), maxDeposit: String(3n * N), point: P, ai: false });
  h.setVersion('other'); await assert.rejects(readPoolPoint(h.rpc), { code: 'rpc_unavailable' });
});

test('V2 malformed settings halt strategy but a 3 NEAR job still exits with the LP flag off', async t => {
  const h = setup(t, 3n * N, V2), { id, path } = await h.run(); await opened(h, id)();
  const db = new DatabaseSync(h.path);
  try { db.prepare('UPDATE lp_settings SET settings=? WHERE job_id=?').run('{bad', id); } finally { db.close(); }
  assert.equal(h.worker.lpSettings(id), 'invalid'); assert.equal(h.worker.getJob(id)?.lpV2, true);
  const n = h.submissions.length; await h.tick(id);
  assert.equal(h.worker.getJob(id)?.state, 'halted'); assert.equal(h.submissions.length, n);
  assert.match(h.worker.getJob(id)?.reason ?? '', /settings are unreadable/);
  assert.equal((await h.request(`${path}/stop`, {})).status, 200); h.d.lpV1 = false;
  await tickUntil(h, id, () => h.worker.getJob(id)?.state === 'stopped');
  assert.equal(h.positions.size, 0); assert.deepEqual(h.assets, {});
});

test('V2 owner range opens, a drift re-centres it, and rotation ranges persist until their add settles', async t => {
  const price = (p: number) => (1e18 / 1.0001 ** p).toFixed(6);
  for (const drift of [false, true]) {
    const h = setup(t, LP_MIN_DEPOSIT, { ...V2, range: { mode: 'explicit', minPrice: price(P + 200), maxPrice: price(P - 200) } }), { id } = await h.run();
    if (drift) h.setPoint(P + 190);
    await opened(h, id)();
    assert.equal(h.state(id).position?.left, drift ? P - 10 : P - 200);
    assert.equal(h.state(id).recentred ?? false, drift);
    const pos = h.state(id).position!;
    await leave(h, id, pos.right + 50); await h.tick(id);
    assert.equal(h.state(id).nextRange?.verdict, 'fallback'); assert.equal(h.state(id).nextRange?.code, 'off');
    await tickUntil(h, id, () => h.state(id).pending?.kind === 'dcl_remove');
    h.setMode('revert'); await h.tick(id);
    assert.equal(h.state(id).nextRange, null); assert.equal(h.state(id).attempt, null); assert.equal(h.state(id).out, null);
    h.setMode('normal'); await h.tick(id); h.skip(600000); h.c.setHoldings({ height: h.c.height + 1 });
    await tickUntil(h, id, () => !!h.state(id).position && h.state(id).position!.id !== pos.id);
    assert.equal(h.state(id).nextRange, null); assert.equal(h.state(id).attempt, null);
    assert.equal(h.state(id).lastDecision?.verdict, 'fallback');
    assert.equal(h.state(id).position!.right - h.state(id).position!.left, 400);
  }
});

test('V2 AI attempts survive each crash boundary without a second call', async t => {
  for (const boundary of ['before-call', 'before-save', 'after-save']) await t.test(boundary, async t => {
    const h = setup(t, LP_MIN_DEPOSIT, { ...V2, ai: true }), { id } = await h.run(); await opened(h, id)();
    await leave(h, id, P + 150);
    let calls = 0;
    h.d.ai = async input => { calls++; assert.equal(input.history.length <= 60, true); assert.equal(JSON.stringify(input).includes(agent), false); return { left: input.point - 60, right: input.point + 60 }; };
    const save = h.worker.saveLp.bind(h.worker);
    h.worker.saveLp = (job, from, to) => {
      if (boundary === 'before-save' && to.nextRange?.verdict === 'accepted') throw new Error('crash');
      const result = save(job, from, to);
      if (boundary === 'before-call' && to.nextRange?.verdict === 'pending') throw new Error('crash');
      return result;
    };
    if (boundary === 'after-save') await h.tick(id); else await assert.rejects(h.tick(id), /crash/);
    h.worker.saveLp = save;
    assert.equal(calls, boundary === 'before-call' ? 0 : 1);
    await h.tick(id); await h.tick(id);
    assert.equal(calls, boundary === 'before-call' ? 0 : 1);
    assert.equal(h.state(id).lastDecision?.verdict, boundary === 'after-save' ? 'accepted' : 'fallback');
    assert.equal(h.state(id).attempt, null);
    const wanted = boundary === 'after-save' ? 120 : 200;
    await tickUntil(h, id, () => !!h.state(id).position);
    assert.equal(h.state(id).position!.right - h.state(id).position!.left, wanted);
    assert.equal(h.state(id).nextRange, null);
  });
});

test('V2 drops late AI replies after Stop or watchdog freeze and abandons an attempt when price returns', async t => {
  for (const action of ['stop', 'freeze', 'return']) await t.test(action, async t => {
    const h = setup(t, LP_MIN_DEPOSIT, { ...V2, ai: true }), { id, path } = await h.run(); await opened(h, id)(); await leave(h, id, P + 150);
    let finish!: (value: unknown) => void, started!: () => void, calls = 0;
    const begin = new Promise<void>(resolve => { started = resolve; });
    h.d.ai = async () => { calls++; started(); return new Promise(resolve => { finish = resolve; }); };
    const tick = h.tick(id); await begin;
    if (action === 'stop') assert.equal((await h.request(`${path}/stop`, {})).status, 200);
    if (action === 'freeze') { h.c.freeze(true); await watchOnce({ store: h.watch, rpc: h.rpc, now: h.d.now }); }
    finish({ left: P + 100, right: P + 220 }); await tick;
    assert.equal(calls, 1);
    if (action !== 'return') assert.equal(h.state(id).nextRange?.verdict, 'pending');
    else { h.setPoint(P); await h.tick(id); assert.equal(h.state(id).attempt, null); assert.equal(h.state(id).nextRange, null); assert.equal(h.state(id).out, null); }
    assert.equal(h.submissions.filter(s => s.call === 'remove_liquidity').length, 0);
  });
});

test('V2 AI off and secret-bearing failure both fall back without retaining provider data', async t => {
  const logs: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => { logs.push(json(args)); });
  t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(json(args)); });
  for (const enabled of [false, true]) {
    const h = setup(t, LP_MIN_DEPOSIT, { ...V2, ai: enabled }), { id } = await h.run(); await opened(h, id)(); await leave(h, id, P + 150);
    let calls = 0; const fake = 'fake-provider-sensitive-value';
    h.d.ai = async () => { calls++; throw new Error(fake); };
    await h.tick(id);
    assert.equal(calls, enabled ? 1 : 0); assert.equal(h.state(id).nextRange?.code, enabled ? 'unavailable' : 'off');
    assert.equal(json({ state: h.state(id), alerts: h.worker.openAlerts(id), response: (await h.request(`/api/jobs/${id}`)).data }).includes(fake), false);
    assert.equal(logs.join('').includes(fake), false);
  }
});

test('V2 second above-range rotation waits at its prospective add and window rollover releases it', async t => {
  const h = setup(t, 3n * N, V2), { id, path } = await h.run(); await opened(h, id)();
  // Keep each rotation in a fresh hourly window, but within the same native daily window.
  h.skip(3600001);
  let pos = h.state(id).position!;
  await leave(h, id, pos.right + 50);
  await tickUntil(h, id, () => !!h.state(id).position && h.state(id).position!.id !== pos.id);
  h.skip(3600001); pos = h.state(id).position!;
  await leave(h, id, pos.right + 50);
  for (let i = 0; i < 60 && h.state(id).pending?.kind !== 'dcl_add'; i++) {
    await h.tick(id);
    const job = h.worker.getJob(id)!, snap = await readHoldings(h.rpc, agent, [WNEAR, USDC]), venue = await readDcl(h.rpc, agent, snap);
    const budget = await exitBudget(h.rpc, job, snap, 0n, venue, undefined, { known: lpKnownPositions(h.worker, id), positions: h.state(id).position ? [h.state(id).position!] : [] });
    assert.ok(h.worker.budgetView(job.walletId!, h.now()).nativeSpent24h + budget.native <= job.caps!.nativeDaily);
  }
  assert.equal(h.state(id).pending?.kind, 'dcl_add');
  const count = h.submissions.length;
  await h.tick(id);
  assert.equal(h.submissions.length, count); assert.match(h.worker.getJob(id)?.reason ?? '', /native exit reservation/);
  const job = h.worker.getJob(id)!, state = h.state(id), snap = await readHoldings(h.rpc, agent, [WNEAR, USDC]), venue = await readDcl(h.rpc, agent, snap);
  const p = state.range!, x = BigInt(state.ledger.inUsdc), y = BigInt(state.ledger.inWnear), lp = { known: lpKnownPositions(h.worker, id), positions: [] };
  const current = await exitBudget(h.rpc, job, snap, 0n, venue, undefined, lp);
  const prospective = await exitBudget(h.rpc, job, snap, 0n, venue, { lpOpen: { ...p, x, y } }, lp);
  assert.equal(prospective.native - current.native, limitProceeds(USDC, x, p.right));
  assert.ok(nativeSpendProblems(h.worker.budgetView(job.walletId!, h.now()), 0n, job.caps!.nativeDaily, 'strategy', prospective.native).length);
  assert.deepEqual(nativeSpendProblems(h.worker.budgetView(job.walletId!, h.now()), 0n, job.caps!.nativeDaily, 'strategy', current.native), []);
  assert.ok(opsProblems({ used1h: 29, used24h: 29, nativeSpent24h: 0n, blockedUntil: null }, 'exit', 0, h.now()).length);
  // An immediate exit from the waiting add remains affordable, before the daily rollover.
  assert.equal((await h.request(`${path}/stop`, {})).status, 200);
  await tickUntil(h, id, () => h.worker.getJob(id)?.state === 'stopped');
  h.skip(86400001);
  assert.deepEqual(h.worker.budgetView(job.walletId!, h.now()), { used24h: 0, used1h: 0, blockedUntil: null, nativeSpent24h: 0n });
  assert.deepEqual(nativeSpendProblems(h.worker.budgetView(job.walletId!, h.now()), 0n, job.caps!.nativeDaily, 'strategy', prospective.native), []);
});

test('V2 protection bounds count nonzero fees at most once for profit and conservatively for loss', async t => {
  for (const included of [false, true]) {
    const h = setup(t, LP_MIN_DEPOSIT, { ...V2, stopLossPct: 20, takeProfitPct: 10 }), { id, path } = await h.run(); await opened(h, id)();
    h.setFees(10000n, N / 50n, included);
    const view = (await h.request(path)).data as { lp: { valueLow: string; valueHigh: string; positionValue: string } };
    const snap = await readHoldings(h.rpc, agent, [WNEAR, USDC]), state = h.state(id), [x, y] = await predictRemove(h.rpc, state.position!.id, BigInt(state.position!.liquidity), snap);
    const low = snap.spendable + snap.tokens[WNEAR] + y + toNearDown(snap.tokens[USDC] + x, P);
    assert.equal(BigInt(view.lp.valueLow), low);
    assert.equal(BigInt(view.lp.valueHigh), low + N / 50n + toNearDown(10000n, P));
    const threshold = LP_MIN_DEPOSIT * 80n / 100n, fee = BigInt(view.lp.valueHigh) - low;
    h.c.setHoldings({ native: h.c.native + threshold - low - fee / 2n });
    await h.tick(id); assert.equal(h.state(id).protect, null, 'low breaches but high does not, so loss stays off');
    // Exact high-value threshold is a breach; a non-breach clears it.
    h.c.setHoldings({ native: h.c.native - (fee - fee / 2n) }); await h.tick(id);
    assert.equal(h.state(id).protect?.kind, 'stop-loss');
    h.c.setHoldings({ native: h.c.native + 1n }); await h.tick(id); assert.equal(h.state(id).protect, null);
  }
});

test('V2 valuation covers all USDC, all wNEAR, no position and unsolicited credits without changing the ledger', async t => {
  const h = setup(t, LP_MIN_DEPOSIT, { ...V2, takeProfitPct: 500 }), { id, path } = await h.run();
  await h.tick(id);
  const j = h.worker.getJob(id)!, old = h.state(id), empty: LpState = { ...old, ledger: { usdc: '0', wnear: '0', native: '0', inUsdc: '0', inWnear: '0' }, swap: null };
  assert.ok(h.worker.saveLp(j, old, empty));
  for (const asset of ['usdc', 'wnear'] as const) {
    h.c.setHoldings({ native: N / 10n, usdc: asset === 'usdc' ? 1000000n : 0n, wnear: asset === 'wnear' ? N : 0n });
    const view = (await h.request(path)).data as { lp: { valueLow: string; valueHigh: string } }, snap = await readHoldings(h.rpc, agent, [WNEAR, USDC]);
    const expected = snap.spendable + h.c.wnear + toNearDown(h.c.usdc, P);
    assert.equal(BigInt(view.lp.valueLow), expected); assert.equal(BigInt(view.lp.valueHigh), expected);
    assert.deepEqual(h.state(id).ledger, empty.ledger);
  }
});

test('V2 independently disabled protection thresholds and both off never fire', async t => {
  for (const [stopLossPct, takeProfitPct, target] of [[0, 10, N], [20, 0, 2n * N], [0, 0, N / 2n]] as const) {
    const h = setup(t, LP_MIN_DEPOSIT, { ...V2, stopLossPct, takeProfitPct }), { id, path } = await h.run(); await opened(h, id)();
    const view = (await h.request(path)).data as { lp: { valueLow: string } };
    h.c.setHoldings({ native: h.c.native + target - BigInt(view.lp.valueLow) });
    await h.tick(id); h.skip(300000); h.c.setHoldings({ height: h.c.height + 1 }); await h.tick(id);
    assert.equal(h.state(id).protect, null); assert.equal(h.worker.getJob(id)?.state, 'running');
  }
});

test('V2 protection confirms exact thresholds in later blocks, preserves failed reads and resets long gaps', async t => {
  const h = setup(t, LP_MIN_DEPOSIT, { ...V2, takeProfitPct: 10 }), { id, path } = await h.run(); await opened(h, id)();
  const view = (await h.request(path)).data as { lp: { valueLow: string } };
  const threshold = LP_MIN_DEPOSIT * 110n / 100n;
  h.c.setHoldings({ native: h.c.native + threshold - BigInt(view.lp.valueLow) });
  await h.tick(id); const first = h.state(id).protect!;
  h.skip(300000); await h.tick(id); assert.equal(h.worker.getJob(id)?.state, 'running', 'same block cannot confirm');
  h.c.setReadable(false); await h.tick(id); assert.deepEqual(h.state(id).protect, first);
  h.c.setReadable(true); h.skip(1800001); h.c.setHoldings({ height: h.c.height + 1 }); await h.tick(id);
  assert.ok(h.state(id).protect!.since > first.since, 'long gap starts again');
  h.skip(300000); h.c.setHoldings({ height: h.c.height + 1 }); await h.tick(id);
  assert.equal(h.worker.getJob(id)?.state, 'stopping');
  assert.equal(h.state(id).protect?.fired?.value, threshold.toString());
});

test('V2 protection drops an unsubmitted step, applies a journaled step first, and stops atomically once', async t => {
  const h = setup(t, LP_MIN_DEPOSIT, { ...V2, takeProfitPct: 10 }), { id } = await h.run();
  h.c.setHoldings({ native: 2n * N });
  await h.tick(id); await h.tick(id);
  const pending = h.state(id).pending!; assert.equal(pending.kind, 'wrap');
  const n = h.submissions.length;
  h.skip(300000); h.c.setHoldings({ height: h.c.height + 1 }); await h.tick(id);
  assert.equal(h.worker.getJob(id)?.state, 'stopping'); assert.equal(h.state(id).pending, null);
  assert.equal(h.state(id).sequence, 1); assert.equal(h.worker.gridStep(id, pending.id), null); assert.equal(h.submissions.length, n);
  assert.equal(h.worker.openAlerts(id).filter(a => a.kind === 'protect_stop').length, 1);
  const stoppedState = h.state(id), stale = h.worker.getJob(id)!;
  assert.equal(h.worker.protectStop({ ...stale, version: stale.version - 1 }, stoppedState, stoppedState), false);
  assert.deepEqual(h.state(id), stoppedState); assert.equal(h.worker.getJob(id)?.version, stale.version);
  assert.equal(h.worker.openAlerts(id).filter(a => a.kind === 'protect_stop').length, 1);
  // A separate job has an already finished wrap. Its old position/ledger is not valued before settlement.
  const g = setup(t, LP_MIN_DEPOSIT, { ...V2, takeProfitPct: 10 }), { id: gid } = await g.run();
  await g.tick(gid); await g.tick(gid); const step = g.state(gid).pending!;
  await createLiveOps({ ...g.d, jobId: gid }).wrap(BigInt(step.amount)); g.c.setHoldings({ native: 2n * N });
  const beforeApply = g.state(gid);
  assert.equal(g.worker.protectStop(g.worker.getJob(gid)!, beforeApply, { ...beforeApply, pending: null, protect: { kind: 'take-profit', since: g.now(), block: g.c.height,
    fired: { kind: 'take-profit', value: (2n * N).toString(), basis: LP_MIN_DEPOSIT.toString(), block: g.c.height, at: g.now() } } }), false);
  assert.deepEqual(g.state(gid), beforeApply); assert.deepEqual(g.worker.openAlerts(gid), []);
  await g.tick(gid); assert.equal(g.state(gid).pending, null); assert.equal(g.state(gid).protect, null);
  assert.equal(g.state(gid).ledger.wnear, step.amount);
});

test('V2 protectStop failed state or job comparison leaves the job, state and alert unchanged', async t => {
  const h = setup(t, LP_MIN_DEPOSIT, { ...V2, stopLossPct: 20 }), { id } = await h.run(); await h.tick(id);
  const j = h.worker.getJob(id)!, from = h.state(id), to: LpState = { ...from, pending: null, protect: { kind: 'stop-loss', since: h.now(), block: h.c.height,
    fired: { kind: 'stop-loss', value: '1', basis: j.depositYocto.toString(), block: h.c.height, at: h.now() } } };
  for (const [job, state] of [[{ ...j, version: j.version - 1 }, from], [j, { ...from, sequence: 99 }]] as const) {
    assert.equal(h.worker.protectStop(job, state, to), false); assert.deepEqual(h.worker.getJob(id), j); assert.deepEqual(h.state(id), from); assert.deepEqual(h.worker.openAlerts(id), []);
  }
  h.worker.releaseWorkerLock(); assert.equal(h.worker.protectStop(j, from, to), false);
  assert.deepEqual(h.state(id), from); assert.deepEqual(h.worker.openAlerts(id), []);
});

test('V2 take profit exits to stopped without AI or the LP flag and retains its fired details', async t => {
  const h = setup(t, LP_MIN_DEPOSIT, { ...V2, ai: true, takeProfitPct: 10 }), { id, path } = await h.run(); await opened(h, id)();
  h.c.setHoldings({ native: h.c.native + N }); await h.tick(id);
  h.skip(300000); h.c.setHoldings({ height: h.c.height + 1 }); await h.tick(id);
  assert.equal(h.worker.getJob(id)?.state, 'stopping'); const fired = h.state(id).protect!.fired!;
  h.c.freeze(true); await h.tick(id); assert.match(h.worker.getJob(id)?.reason ?? '', /Unfreeze/);
  h.c.freeze(false); h.d.lpV1 = false;
  await tickUntil(h, id, () => h.worker.getJob(id)?.state === 'stopped');
  assert.equal(h.worker.getJob(id)?.reason, null); assert.deepEqual(h.state(id).protect!.fired, fired);
  assert.equal(((await h.request(path)).data as { lp: { protect: { fired: { kind: string } } } }).lp.protect.fired.kind, 'take-profit');
});

test('V2 compound respects the floor, percentage, range margin and 6 hour spacing', async t => {
  const h = setup(t, LP_MIN_DEPOSIT, { ...V2, compound: { on: true, minFeeBps: 1000 } }), { id } = await h.run(); await opened(h, id)();
  h.setFees(0n, LP_COMPOUND_FLOOR - 1n); await h.tick(id); assert.equal(h.state(id).pending, null);
  h.setPoint(P - 95); h.setFees(0n, LP_COMPOUND_FLOOR); await h.tick(id); assert.equal(h.state(id).pending, null, 'in range but outside its interior margin');
  h.setPoint(P + 150); await h.tick(id); assert.notEqual(h.state(id).out, null); assert.equal(h.state(id).pending, null);
  h.setPoint(P); await h.tick(id); await h.tick(id);
  assert.equal(h.state(id).pending?.reason, 'compound');
  await h.tick(id); assert.equal(h.state(id).swap, null); assert.equal(h.state(id).nextRange?.verdict, 'rebuild');
  await tickUntil(h, id, () => !!h.state(id).position);
  h.setFees(0n, N); await h.tick(id); assert.equal(h.state(id).pending, null, 'recent removal starts the cooldown');
  h.skip(21600000); await h.tick(id); assert.equal(h.state(id).pending?.reason, 'compound');
  const big = setup(t, 3n * N, { ...V2, compound: { on: true, minFeeBps: 1000 } }), { id: bid } = await big.run(); await opened(big, bid)();
  big.setFees(0n, LP_COMPOUND_FLOOR); await big.tick(bid); assert.equal(big.state(bid).pending, null, 'percentage exceeds the floor');
});

test('V2 rebuild preserves its range after price leaves, has no swap, and keeps the watchdog silent', async t => {
  const h = setup(t, LP_MIN_DEPOSIT, { ...V2, compound: { on: true, minFeeBps: 100 } }), { id } = await h.run(); await opened(h, id)();
  const pos = h.state(id).position!, from = h.submissions.length;
  h.setFees(0n, LP_COMPOUND_FLOOR);
  await h.tick(id); await h.tick(id);
  assert.equal(h.state(id).swap, null); assert.equal(h.state(id).position, null); assert.equal(lpRotations(h.worker.jobOps(id), h.now()), 0);
  assert.equal(h.state(id).nextRange?.left, pos.left); h.setPoint(pos.right + 50);
  for (let i = 0; i < 30 && !h.state(id).position; i++) {
    await h.tick(id); assert.deepEqual((await watchOnce({ store: h.watch, rpc: h.rpc, now: h.d.now })).filter(a => a.severity !== 'info'), []);
  }
  assert.ok(h.state(id).position); assert.equal(h.state(id).position!.left, pos.left); assert.equal(h.state(id).position!.right, pos.right);
  assert.equal(h.state(id).position!.paidX, '0', 'one-sided add refunded USDC');
  assert.equal(h.state(id).lastDecision?.verdict, 'rebuild');
  assert.equal(calls(h, from).filter(c => c === 'ft_transfer_call').length, 2, 'only deposits, no swap');
  await h.tick(id); assert.equal(h.state(id).out?.side, 'above');
});

test('V2 Stop and freeze between every rebuild step preserve owner recovery', async t => {
  for (const boundary of ['dcl_remove', 'wrap', 'deposit-usdc', 'deposit-wnear', 'dcl_add'] as const) for (const action of ['stop', 'freeze']) await t.test(`${boundary} ${action}`, async t => {
    const h = setup(t, LP_MIN_DEPOSIT, { ...V2, compound: { on: true, minFeeBps: 100 } }), { id, path } = await h.run(); await opened(h, id)();
    const original = h.state(id).position!.id;
    h.setFees(0n, LP_COMPOUND_FLOOR); await h.tick(id);
    if (boundary !== 'dcl_remove') await h.tick(id);
    await tickUntil(h, id, () => boundary.startsWith('deposit-') ? h.state(id).pending?.kind === 'dcl_deposit' && h.state(id).pending?.token === (boundary === 'deposit-usdc' ? USDC : WNEAR) : h.state(id).pending?.kind === boundary);
    const n = h.submissions.length;
    if (action === 'stop') {
      assert.equal((await h.request(`${path}/stop`, {})).status, 200);
      await tickUntil(h, id, () => h.worker.getJob(id)?.state === 'stopped');
      assert.equal(h.positions.size, 0); assert.deepEqual(h.assets, {});
    } else {
      h.c.freeze(true); await h.tick(id); assert.equal(h.worker.getJob(id)?.state, 'frozen'); assert.equal(h.submissions.length, n);
      h.c.freeze(false); await h.tick(id); assert.equal(h.worker.getJob(id)?.state, 'paused');
      const j = h.worker.getJob(id)!; h.web.casJob(id, 'paused', j.version, 'resuming', {}, h.now());
      await tickUntil(h, id, () => !!h.state(id).position && h.state(id).position!.id !== original); assert.equal(h.state(id).lastDecision?.verdict, 'rebuild');
    }
  });
});

test('V2 quota and frozen removals retain their decision and retry without another AI call', async t => {
  for (const mode of ['quota', 'frozen'] as const) {
    const h = setup(t, LP_MIN_DEPOSIT, { ...V2, ai: true }), { id } = await h.run(); await opened(h, id)(); await leave(h, id, P + 150);
    let calls = 0; h.d.ai = async input => { calls++; return { left: input.point - 100, right: input.point + 100 }; };
    await tickUntil(h, id, () => h.state(id).pending?.kind === 'dcl_remove'); const range = h.state(id).nextRange;
    h.setMode(mode); await h.tick(id); h.setMode('normal');
    if (mode === 'frozen') {
      await h.tick(id); const paused = h.worker.getJob(id)!; assert.equal(paused.state, 'paused');
      h.web.casJob(id, 'paused', paused.version, 'resuming', {}, h.now());
    }
    await tickUntil(h, id, () => h.state(id).position === null);
    assert.equal(calls, 1); assert.deepEqual(h.state(id).nextRange, range);
  }
});

test('V2 additions do not normalize or change an already-running row-less V1 job', async t => {
  const h = setup(t), { id } = await h.run(); await opened(h, id)();
  assert.equal(h.worker.getJob(id)?.lpV2, false); assert.equal(h.worker.lpSettings(id), null);
  const before = h.state(id); assert.equal(Object.hasOwn(before, 'history'), false);
  await h.tick(id); assert.deepEqual(h.state(id), before);
  const p = before.position!; await leave(h, id, p.right + 50);
  await tickUntil(h, id, () => !!h.state(id).position && h.state(id).position!.id !== p.id);
  assert.equal(Object.hasOwn(h.state(id), 'range'), false);
});

// ---- Phase 3b audit probes (appended in the audit worktree only; not part of the build) ----

test('AUDIT V2 add gate refuses a planned add whose point drifted past the interior margin before submission', async t => {
  const h = setup(t, LP_MIN_DEPOSIT, V2), { id } = await h.run();
  await tickUntil(h, id, () => h.state(id)?.pending?.kind === 'dcl_add');
  const planned = h.state(id).pending!;
  h.setPoint(planned.right! - 5);
  const n = h.submissions.length;
  await h.tick(id);
  assert.equal(h.submissions.length, n, 'no add_liquidity was submitted');
  assert.equal(h.state(id).pending, null);
  assert.equal(h.positions.size, 0);
  await tickUntil(h, id, () => h.state(id)?.pending?.kind === 'dcl_add');
  assert.equal(h.state(id).pending!.left, planned.right! - 5 - 100, 're-centred on the fresh point');
  assert.equal(h.state(id).recentred, true);
});

test('AUDIT V2 compound removal is refused when the price leaves the range before submission', async t => {
  const h = setup(t, LP_MIN_DEPOSIT, { ...V2, compound: { on: true, minFeeBps: 100 } }), { id } = await h.run(); await opened(h, id)();
  const pos = h.state(id).position!;
  h.setFees(0n, LP_COMPOUND_FLOOR); await h.tick(id);
  assert.equal(h.state(id).pending?.reason, 'compound');
  const row = h.state(id).pending!;
  assert.equal(BigInt(row.minX!) > 0n && BigInt(row.minY!) > 0n, true, 'both minimums are 99 percent of the prediction');
  h.setPoint(pos.right + 5);
  const n = h.submissions.length;
  await h.tick(id);
  assert.equal(h.submissions.length, n, 'no remove_liquidity was submitted');
  assert.equal(h.state(id).pending, null); assert.equal(h.state(id).nextRange, null); assert.equal(h.state(id).attempt, null);
  assert.equal(h.positions.size, 1);
});

test('AUDIT compound removal signs 99 percent minimums on both sides', async t => {
  const h = setup(t, LP_MIN_DEPOSIT, { ...V2, compound: { on: true, minFeeBps: 100 } }), { id } = await h.run(); await opened(h, id)();
  const state = h.state(id), snap = await readHoldings(h.rpc, agent, [WNEAR, USDC]);
  const [x, y] = await predictRemove(h.rpc, state.position!.id, BigInt(state.position!.liquidity), snap);
  h.setFees(0n, LP_COMPOUND_FLOOR); await h.tick(id); await h.tick(id);
  const row = h.worker.jobOps(id).find(o => o.kind === 'dcl_remove')!;
  const args = (JSON.parse(row.request) as Intent).args!;
  assert.equal(args.min_amount_x, (x * 9900n / 10000n).toString());
  assert.equal(args.min_amount_y, (y * 9900n / 10000n).toString());
});

test('AUDIT the worker cannot move running to stopping through casJob; only protectStop may', async t => {
  const h = setup(t, LP_MIN_DEPOSIT, V2), { id } = await h.run();
  const j = h.worker.getJob(id)!;
  assert.equal(j.state, 'running');
  assert.equal(h.worker.casJob(id, 'running', j.version, 'stopping', {}, h.now()), false);
  assert.equal(h.worker.getJob(id)?.state, 'running');
  assert.equal(h.worker.getJob(id)?.version, j.version);
});

test('AUDIT protectStop refuses a fired kind whose threshold is off, and createJob refuses malformed settings', async t => {
  const h = setup(t, LP_MIN_DEPOSIT, { ...V2, takeProfitPct: 10 }), { id } = await h.run(); await h.tick(id);
  const j = h.worker.getJob(id)!, from = h.state(id);
  const to: LpState = { ...from, protect: { kind: 'stop-loss', since: h.now(), block: h.c.height, fired: { kind: 'stop-loss', value: '1', basis: j.depositYocto.toString(), block: h.c.height, at: h.now() } } };
  assert.equal(h.worker.protectStop(j, from, to), false);
  assert.equal(h.worker.getJob(id)?.state, 'running'); assert.deepEqual(h.worker.openAlerts(id), []);
  assert.throws(() => h.web.createJob({ owner: 'other.near', kind: 'lp', mode: 'live', pair: 'usdc-wnear', depositYocto: LP_MIN_DEPOSIT, lpV1: true,
    lpSettings: { ...V2, v: 2, stopLossPct: 91 } as unknown as Parameters<typeof h.web.createJob>[0]['lpSettings'] }, h.now()), { code: 'bad_request' });
});

test('AUDIT history is capped at 60 evaluations', async t => {
  const h = setup(t, LP_MIN_DEPOSIT, V2), { id } = await h.run(); await opened(h, id)();
  for (let i = 0; i < 70; i++) await h.tick(id);
  assert.equal(h.state(id).history!.length, 60);
});

test('AUDIT a second breach in a later block but under five minutes does not confirm', async t => {
  const h = setup(t, LP_MIN_DEPOSIT, { ...V2, takeProfitPct: 10 }), { id, path } = await h.run(); await opened(h, id)();
  const view = (await h.request(path)).data as { lp: { valueLow: string } };
  h.c.setHoldings({ native: h.c.native + LP_MIN_DEPOSIT * 110n / 100n - BigInt(view.lp.valueLow) });
  await h.tick(id); const first = h.state(id).protect!;
  assert.equal(first.kind, 'take-profit');
  h.skip(299_000 - 200_000); h.c.setHoldings({ height: h.c.height + 1 }); await h.tick(id);
  assert.equal(h.worker.getJob(id)?.state, 'running', 'a later block under five minutes after the first breach must not confirm');
  assert.deepEqual(h.state(id).protect, first);
  h.skip(2_000); h.c.setHoldings({ height: h.c.height + 1 }); await h.tick(id);
  assert.equal(h.worker.getJob(id)?.state, 'stopping');
});

test('AUDIT a row-less V1 job at 2 NEAR still opens the fixed 0.4 NEAR position', async t => {
  const h = setup(t, 2n * N), { id } = await h.run();
  await h.tick(id);
  assert.equal(h.worker.getJob(id)?.lpV2, false);
  assert.equal(h.state(id).ledger.native, (4n * N / 10n).toString());
  assert.equal(h.state(id).swap?.amount, (2n * N / 10n).toString());
});

test('AUDIT a rotation removal refused before submission clears attempt, nextRange and out in the same evaluation', async t => {
  const h = setup(t, LP_MIN_DEPOSIT, V2), { id } = await h.run(); await opened(h, id)();
  await leave(h, id, P + 150); await h.tick(id);
  await tickUntil(h, id, () => h.state(id).pending?.kind === 'dcl_remove');
  assert.ok(h.state(id).attempt); assert.ok(h.state(id).nextRange); assert.ok(h.state(id).out);
  h.setPoint(P);
  const n = h.submissions.length;
  await h.tick(id);
  assert.equal(h.submissions.length, n, 'the in-range removal was refused before submission');
  assert.equal(h.state(id).pending, null); assert.equal(h.state(id).attempt, null); assert.equal(h.state(id).nextRange, null); assert.equal(h.state(id).out, null);
  assert.equal(h.positions.size, 1);
});

test('AUDIT a side flip while an attempt is saved restarts confirmation and drops the attempt', async t => {
  const h = setup(t, LP_MIN_DEPOSIT, V2), { id } = await h.run(); await opened(h, id)();
  await leave(h, id, P + 150); await h.tick(id);
  assert.ok(h.state(id).attempt); assert.equal(h.state(id).out?.side, 'above');
  h.setPoint(P - 150); await h.tick(id);
  assert.equal(h.state(id).out?.side, 'below'); assert.equal(h.state(id).attempt, null); assert.equal(h.state(id).nextRange, null);
  assert.equal(h.state(id).pending, null);
});

test('AUDIT buildRules enforces the caller-supplied maxDeposit, so Grid and row-less LP stay at 2 NEAR at the rules layer', () => {
  const deposit = 25n * N / 10n, caps = defaultCaps(deposit, { [USDC]: 3756475n });
  assert.throws(() => buildRules({ owner, depositYocto: deposit, maxDeposit: MONEY.maxDeposit, usesDcl: true, tokens: [USDC], caps }), { code: 'policy_invalid' });
  assert.ok(buildRules({ owner, depositYocto: deposit, maxDeposit: 3n * N, usesDcl: true, tokens: [USDC], caps }));
  assert.throws(() => buildRules({ owner, depositYocto: 3n * N + 1n, maxDeposit: 3n * N, usesDcl: true, tokens: [USDC], caps: defaultCaps(3n * N + 1n, { [USDC]: 3756475n }) }), { code: 'policy_invalid' });
});

// ---------------------------------------------------------------------------------------------------------------------
// AUDIT 2026-11-12 (Retire, 15 live jobs, no hidden agents), probe for the LP side of the route (no LP retire test exists).
// It PASSES on 2b09553 and fails on mutant S14b (the DCL read skipped for an LP job).
// Paste at the end of test/lp.test.ts (it uses that file's harness and imports; no new import is needed).
// ---------------------------------------------------------------------------------------------------------------------
test('AUDIT P-1 (S14b): a halted LP job retires only when DCL holds nothing: no internal balance, lost-found amount or position', async t => {
  const h = setup(t);
  h.c.setPolicy({ owner, encrypted_data: 'QUFBQQ==', frozen: false, storage_deposit: '15000000000000000000000' });
  h.setSponsor(owner);
  const job = dclJob(h, 'lp');
  assert.ok(h.worker.casJob(job.id, 'running', job.version, 'halted', { reason: 'audit' }));
  h.c.setHoldings({ native: N / 100n, usdc: 0n, wnear: 0n, height: 100 });
  const held = 'The agent wallet still holds funds. Use Stop and withdraw or the management link first.';
  const retire = async () => {
    const r = await h.request(`/api/jobs/${job.id}/retire`, {});
    return { status: r.status, message: (JSON.parse(r.text) as { error?: { message: string } }).error?.message ?? null };
  };
  h.assets[USDC] = '1';
  assert.deepEqual(await retire(), { status: 409, message: held }, 'a DCL internal balance');
  delete h.assets[USDC];
  h.lost[WNEAR] = '1';
  assert.deepEqual(await retire(), { status: 409, message: held }, 'a DCL lost-found amount');
  delete h.lost[WNEAR];
  h.positions.set(lptOf(1), { left: P - 100, right: P + 100, amount: LIQ, paidX: MID_X, paidY: MID_Y });
  assert.deepEqual(await retire(), { status: 409, message: held }, 'a position');
  h.positions.clear();
  // Any DCL version other than the pinned one blocks the read (ruling 2026-11-07), so the retire fails closed.
  h.setVersion('2.4.3');
  assert.deepEqual(await retire(), { status: 503, message: 'Could not verify the agent wallet. Try again.' });
  h.setVersion('2.4.2');
  assert.equal(h.worker.getJob(job.id)?.state, 'halted', 'no refusal changes the job');
  assert.deepEqual(await retire(), { status: 200, message: null });
  assert.equal(h.worker.getJob(job.id)?.state, 'retired');
  assert.equal(h.worker.activeJobs().length, 0);
});

// Phase 1 fix 4 end to end on the shape of the 2026-11-12 halt: the opening swap through classic pool 4512 loses its reply.
test('fix 4: a lost opening swap reply is re-sent under its key, proven, paused, resumed by the owner, and the LP opens (V1 and V2)', async t => {
  for (const settings of [undefined, V2]) {
    const h = setup(t, 12n * N / 10n, settings), { id, path } = await h.run();
    Object.assign(h.d, { wait: async () => {} });
    const real = h.d.outlayer.call, keys: string[] = [];
    let lose = true;
    h.d.outlayer.call = async (key, req, idem) => {
      if (req.methodName === 'ft_transfer_call' && req.args.receiver_id === CLASSIC_EXCHANGE) { keys.push(idem); if (lose) return { kind: 'ambiguous', reason: 'server', http: 502 }; }
      return real(key, req, idem);
    };
    await tickUntil(h, id, () => h.worker.getJob(id)?.state === 'halted');
    const walletId = h.worker.getJob(id)!.walletId!, row = h.worker.inFlightOp(walletId)!;
    assert.equal(row.kind, 'swap'); assert.equal(keys.length, 4, 'the original and three same-key re-sends');
    assert.equal(h.state(id).pending?.kind, 'swap');
    const usdc = h.c.usdc;
    // OutLayer answers again: the background re-send runs the swap once under the same key.
    lose = false;
    h.skip(RESEND_EVERY_MS);
    assert.equal(await reconcileWallet({ ...h.d, rpc: h.rpc, now: h.now, wait: async () => {} }, walletId), 'clean');
    assert.equal(keys.length, 5); assert.ok(keys.every(k => k === row.idemKey));
    assert.ok(h.c.usdc > usdc, 'the swap landed');
    assert.equal(h.worker.jobOps(id).find(o => o.id === row.id)?.verdict, 'swapped');
    assert.equal(h.worker.getJob(id)?.state, 'paused');
    // The owner signs the existing Resume; readiness accepts the finished step and the first tick applies it.
    const c = (await h.request(`/api/challenge?purpose=resume&job=${id}`)).data as Challenge;
    assert.equal((await h.request(`${path}/resume`, { signed: identity()(c) })).status, 200);
    assert.equal(h.worker.getJob(id)?.state, 'resuming');
    // Audit H4: with the finished step still to apply, readiness still refuses an unknown DCL position.
    h.extraRows.push({ lpt_id: lptOf(77), owner_id: agent, pool_id: DCL_POOL, left_point: P - 5, right_point: P + 5, amount: '5', mft_id: '', unclaimed_fee_x: '0', unclaimed_fee_y: '0' });
    await h.tick(id); await h.tick(id);
    assert.equal(h.worker.getJob(id)?.state, 'resuming'); assert.match(h.worker.getJob(id)?.reason ?? '', /LP readiness is waiting/);
    h.extraRows.length = 0;
    await tickUntil(h, id, () => !!h.state(id)?.position);
    assert.equal(h.worker.getJob(id)?.state, 'running');
    assert.equal(keys.length, 5, 'the swap was never sent again');
  }
});

test('LP: an idle tick reads through the idle client, and a snapshot older than a proven step is retried, never judged', async t => {
  const h = setup(t), { id } = await h.run();
  await opened(h, id)();
  const proven = Math.max(...h.worker.jobOps(id).map(r => r.finishedBlock ?? 0)), main: string[] = [], idle: string[] = [], real = h.rpc.view;
  let stale = false;
  const block = () => stale ? proven - 1 : h.c.height;
  h.d.idleRpc = { ...h.rpc,
    finalBlock: async () => ({ id: `block-${block()}`, height: block() }),
    query: async p => ({ ...(await h.rpc.query({ ...p, block_id: `block-${h.c.height}` }) as object), block_hash: `block-${block()}`, block_height: block() }),
    view: async (contract, method, args) => { idle.push(method); return { ...(await real(contract, method, args, `block-${h.c.height}`)), height: block(), blockId: `block-${block()}` }; } };
  h.rpc.view = async (contract, method, args, blockId) => { main.push(method); return real(contract, method, args, blockId); };
  h.skip(60_000); await h.tick(id);
  assert.ok(idle.includes('get_pool'));
  assert.deepEqual(main, ['get_wallet_policy']);
  stale = true; idle.length = 0;
  h.skip(60_000);
  assert.equal(await h.tick(id), 'running');
  assert.ok(!idle.includes('get_pool'), 'no DCL read on a stale snapshot');
  h.rpc.view = real; delete h.d.idleRpc;
});
