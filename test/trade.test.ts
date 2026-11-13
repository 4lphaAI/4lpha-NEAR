import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { YOCTO_PER_NEAR as N } from '../src/core/amounts.js';
import { tokenHash, type Challenge } from '../src/core/auth.js';
import { nativeSpendProblems } from '../src/core/budget.js';
import { record } from '../src/core/errors.js';
import { provenEffects } from '../src/core/evidence.js';
import { advanceJob, draftProblems, jobTokens, processReveals, type WorkerDeps } from '../src/core/hire.js';
import { readHoldings } from '../src/core/holdings.js';
import { RpcUnavailable, type NearRpc } from '../src/core/near-rpc.js';
import { createLiveOps, exitBudget, reconcileWallet, REGISTRATION_RELEASED } from '../src/core/ops.js';
import { createOutLayerClient, type CallRequest, type SubmitResult } from '../src/core/outlayer.js';
import { CLASSIC_EXCHANGE, CLASSIC_POOLS, DCL, MONEY, PAIRS, RHEA, USDC, WNEAR, ZEC } from '../src/core/pins.js';
import { defaultCaps, type PolicyRules } from '../src/core/policy.js';
import { parseTxStatus } from '../src/core/receipts.js';
import { minOut, readTradePool, swapCall } from '../src/core/rhea-classic.js';
import { SecretString } from '../src/core/secrets.js';
import { json, type Job, type OpRow as AuditOpRow } from '../src/core/store.js';
import { levelNeed, medianWait, outGivenIn, sampleTradePools as auditSampleTradePools, tickTrade, tpLine, tradeEndsAt as auditTradeEndsAt, tradeView, type TradeState, type TradeStep } from '../src/core/trade.js';
import { tradePair, TRADE_PAIRS } from '../src/core/trade-pairs.js';
import { ladderFactor, maxStepBps, parseTradeSettings, TRADE_RESERVE, tradePlan, tradeSettingsFromRequest, type TradeSettings } from '../src/core/trade-settings.js';
import { watchOnce } from '../src/core/watchdog.js';
import { createHandler } from '../src/web/server.js';
import { armedJob, chain, opRow } from './chain.js';
import { accepted, agent, dummyOutLayer, dummyRpc, fixture, fullAccess, identity, owner, stores, testNow } from './helpers.js';

const EX = CLASSIC_EXCHANGE;
// Measured gas burnt (spec 6.1, FINDINGS 1.27): a buy is 0.001812 NEAR, a refund 0.000828, a sale 0.002518.
const WRAP_GAS = 196n * 10n ** 18n, SWAP_GAS = 1616n * 10n ** 18n, REFUND_GAS = 828n * 10n ** 18n, SALE_GAS = 2518n * 10n ** 18n, OP_GAS = 10n ** 18n;
const STORAGE = 182n * 10n ** 19n;
const near = (s: string) => { const [i, f = ''] = s.split('.'); return BigInt(i!) * N + BigInt(f.padEnd(24, '0')); };
const SCHEDULE = { amountNear: '0.10', intervalSec: 3600, budgetNear: '0.20', end: { kind: 'budget' } };
const DCA = { baseNear: '0.10', orderNear: '0.10', levels: 1, stepBps: 100, tpBps: 150, slBps: 0 };
const HOUR = 3_600_000, MIN = 60_000;

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64');
const fn = (method_name: string, args: object, gas = 30_000_000_000_000n, deposit = 0n) => ({ FunctionCall: { method_name, args: b64(args), gas: Number(gas), deposit: String(deposit) } });
const transferAction = (n: bigint) => ({ Transfer: { deposit: String(n) } });
type Status = { SuccessValue: string } | { SuccessReceiptId: string } | { Failure: object };
const ok = (v?: unknown): Status => ({ SuccessValue: v === undefined ? '' : b64(v) });
const e68: Status = { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: E68: slippage error' } } } } };
interface R { id: string; from: string; to: string; a: object; status: Status; children?: string[]; }
function txOf(root: R, rs: R[], status: Status, burnt: bigint): Record<string, unknown> {
  const all = [root, ...rs];
  return { final_execution_status: 'FINAL', status, transaction: { signer_id: agent, receiver_id: root.to, hash: 'x', actions: [root.a] },
    transaction_outcome: { outcome: { tokens_burnt: String(burnt), receipt_ids: [root.id] } },
    receipts: all.map(x => ({ receipt_id: x.id, predecessor_id: x.from, receiver_id: x.to, receipt: { Action: { actions: [x.a] } } })),
    receipts_outcome: all.map(x => ({ id: x.id, outcome: { executor_id: x.to, tokens_burnt: '0', status: x.status, receipt_ids: x.children ?? [], logs: [] } })) };
}
const rootOf = (c: CallRequest, status: Status = ok(), children: string[] = []): R => ({ id: 'root', from: agent, to: c.receiverId, a: fn(c.methodName, c.args, c.gas, c.deposit), status, children });
/**
 * Synthetic swap receipts in the FINDINGS 1.27 shapes (tx-1.27-swap-in, -swap-out-native, -swap-refund-e68) with the token and amounts replaced,
 * because no RHEA or ZEC swap has run yet (U-1, U-2). `used` below the input is the partial resolve; `payer` reroutes the payout (an omft shape).
 */
function syntheticSwap(c: CallRequest, o: { out: bigint; refund?: boolean; used?: bigint; native?: boolean; payer?: string; burnt: bigint }) {
  const token = c.receiverId, n = BigInt(String(c.args.amount)), msg = String(c.args.msg), used = o.refund ? 0n : o.used ?? n;
  const tokenOut = String((JSON.parse(msg) as { actions: { token_out: string }[] }).actions[0]!.token_out);
  const pay: R = o.native ? { id: 'pay', from: EX, to: agent, a: transferAction(o.out), status: ok() }
    : { id: 'pay', from: o.payer ?? EX, to: tokenOut, a: fn('ft_transfer', { receiver_id: agent, amount: String(o.out) }, 10n, 1n), status: ok() };
  return txOf(rootOf(c, { SuccessReceiptId: 'resolve' }, ['receive', 'resolve']), [
    { id: 'receive', from: token, to: EX, a: fn('ft_on_transfer', { sender_id: agent, amount: String(n), msg }), status: o.refund ? e68 : ok(String(n - used)), children: o.refund ? [] : ['pay'] },
    ...(o.refund ? [] : [pay]),
    { id: 'resolve', from: token, to: token, a: fn('ft_resolve_transfer', { sender_id: agent, receiver_id: EX, amount: String(n) }), status: ok(String(used)) }], ok(String(used)), o.burnt);
}

type Mode = 'normal' | 'refund' | 'partial' | 'omft' | 'ambiguous' | 'quota' | 'frozen';
interface Opts { pair?: string; kind?: 'schedule' | 'dca'; trade?: object; webTrade?: boolean; workerTrade?: boolean; }

function setup(t: Parameters<typeof stores>[0], o: Opts = {}) {
  const db = stores(t), origin = 'https://app.test', kind = o.kind ?? 'schedule', pair = tradePair(o.pair ?? 'trade-usdc'), pool = pair.pin.poolId;
  const body = o.trade ?? (kind === 'schedule' ? SCHEDULE : DCA), settings = tradeSettingsFromRequest(kind, body, testNow) as TradeSettings;
  assert.notEqual(settings, 'invalid');
  const deposit = tradePlan(settings) + TRADE_RESERVE;
  let clock = testNow, height = 10, native = 0n, serial = 0, rules: PolicyRules | null = null, readable = true, poolReadable = true, reads = 0, webTrade = o.webTrade ?? true;
  let policy: Record<string, unknown> | null = null, mode: Mode = 'normal', forcedQuote: bigint | null = null;
  const bal: Record<string, bigint> = { [WNEAR]: 0n, [pair.token]: 0n }, ownerBal: Record<string, bigint> = { native: 0n, [pair.token]: 0n };
  const registration = new Set<string>();
  const pools = new Map<number, { kind: string; tokens: string[]; amounts: bigint[]; fee: number }>([
    [4512, { kind: 'SIMPLE_POOL', tokens: [USDC, WNEAR], amounts: [977_325n * 10n ** 6n, 261_368n * N], fee: 30 }],
    [6458, { kind: 'SIMPLE_POOL', tokens: [RHEA, WNEAR], amounts: [11038192113637089006712523n, 112376915111888666470198909136n], fee: 30 }],
    [6065, { kind: 'SIMPLE_POOL', tokens: [WNEAR, ZEC], amounts: [30027621100680611870775004061n, 11519712462n], fee: 0 }]]);
  const txs = new Map<string, unknown>(), blocks = new Map<string, number>();
  const calls: { method: string; receiver: string; args: Record<string, unknown> }[] = [];
  const reserve = (token: string) => { const p = pools.get(pool)!; return p.amounts[p.tokens.indexOf(token)]!; };
  const setReserve = (token: string, n: bigint) => { const p = pools.get(pool)!; p.amounts[p.tokens.indexOf(token)] = n; };
  const ret = (id: number, tokenIn: string, amountIn: bigint, tokenOut: string) => {
    const p = pools.get(id)!, rIn = p.amounts[p.tokens.indexOf(tokenIn)]!, rOut = p.amounts[p.tokens.indexOf(tokenOut)]!, x = amountIn * BigInt(10_000 - p.fee);
    return x * rOut / (rIn * 10_000n + x);
  };
  const rpc: NearRpc = {
    finalBlock: async () => { reads++; if (!readable) throw new RpcUnavailable(); return { id: `block-${height}`, height }; },
    blockHeight: async id => { const n = blocks.get(id) ?? (/^block-\d+$/.test(id) ? Number(id.slice(6)) : undefined); if (n === undefined) throw new RpcUnavailable(); return n; },
    query: async p => {
      reads++;
      if (!readable || p.block_id !== `block-${height}`) throw new RpcUnavailable();
      return { amount: native.toString(), locked: '0', storage_usage: 182, block_hash: `block-${height}`, block_height: height };
    },
    viewAccount: async id => { reads++; if (!readable) throw new RpcUnavailable(); return { amount: id === agent ? native : 5n * N, locked: 0n, storageUsage: 182 }; },
    viewAccessKey: async () => ({ fullAccess: true }),
    txStatus: async h => { const tx = txs.get(h); if (!tx) throw new RpcUnavailable(); return tx; },
    holdGasPrice: async () => 1_000_000_000n,
    view: async (contract, method, args, block) => {
      reads++;
      if (!readable || (block && block !== `block-${height}`)) throw new RpcUnavailable();
      let value: unknown;
      if (method === 'get_wallet_policy') value = policy;
      else if (method === 'ft_balance_of') value = String((args.account_id === agent ? bal[contract] : args.account_id === owner ? ownerBal[contract] : 0n) ?? 0n);
      else if (method === 'storage_balance_of') value = registration.has(`${contract}:${String(args.account_id)}`) ? { total: '1250000000000000000000', available: '0' } : null;
      else if (method === 'metadata') value = { version: '1.9.21', state: 'Running' };
      else if (method === 'get_pool') {
        if (!poolReadable) throw new RpcUnavailable();
        const p = pools.get(Number(args.pool_id))!;
        value = { pool_kind: p.kind, token_account_ids: p.tokens, amounts: p.amounts.map(String), total_fee: p.fee };
      } else if (method === 'get_return') value = String(forcedQuote ?? ret(Number(args.pool_id), String(args.token_in), BigInt(String(args.amount_in)), String(args.token_out)));
      else if (method === 'estimate_wallet_policy_cost') value = '15000000000000000000000';
      else throw new RpcUnavailable();
      return { height, blockId: `block-${height}`, value };
    },
  };
  function land(raw: Record<string, unknown>, move: () => void): string {
    const hash = `trade-tx-${++serial}`, tx = structuredClone(raw), first = height + 1;
    record(tx.transaction)!.hash = hash;
    for (const [i, outcome] of [tx.transaction_outcome, ...(tx.receipts_outcome as unknown[])].entries()) {
      const r = record(outcome)!; r.block_hash = `${hash}-block-${i}`; blocks.set(String(r.block_hash), first + i);
    }
    txs.set(hash, tx); move(); height += 30;
    return hash;
  }
  async function call(req: CallRequest): Promise<SubmitResult> {
    calls.push({ method: req.methodName, receiver: req.receiverId, args: req.args });
    if (mode === 'quota') return { kind: 'quota', retryAfterSeconds: 1 };
    if (mode === 'frozen') return { kind: 'denied', code: 'wallet_frozen', message: 'Frozen.' };
    if (mode === 'ambiguous') throw new Error('network');
    if (req.methodName === 'near_deposit') {
      const n = req.deposit;
      return accepted(land(txOf(rootOf(req), [], ok(), WRAP_GAS), () => { native -= n + WRAP_GAS; bal[WNEAR] = bal[WNEAR]! + n; }));
    }
    if (req.methodName === 'near_withdraw') {
      const n = BigInt(String(req.args.amount));
      return accepted(land(txOf(rootOf(req, ok(), ['back']), [{ id: 'back', from: WNEAR, to: agent, a: transferAction(n + 1n), status: ok() }], ok(), OP_GAS),
        () => { native += n - OP_GAS; bal[WNEAR] = bal[WNEAR]! - n; }));
    }
    if (req.methodName === 'ft_transfer') {
      const n = BigInt(String(req.args.amount)), to = String(req.args.receiver_id);
      return accepted(land(txOf(rootOf(req), [], ok(), OP_GAS), () => { native -= 1n + OP_GAS; bal[req.receiverId] = bal[req.receiverId]! - n; if (to === owner) ownerBal[req.receiverId] = (ownerBal[req.receiverId] ?? 0n) + n; }));
    }
    assert.equal(req.methodName, 'ft_transfer_call');
    const tokenIn = req.receiverId, n = BigInt(String(req.args.amount)), action = (JSON.parse(String(req.args.msg)) as { actions: Record<string, string>[] }).actions[0]!;
    const tokenOut = action.token_out!, sell = tokenOut === WNEAR, out = ret(Number(action.pool_id), tokenIn, n, tokenOut), gas = sell ? SALE_GAS : SWAP_GAS;
    if (mode === 'refund' || out < BigInt(action.min_amount_out!)) {
      const hash = land(syntheticSwap(req, { out: 0n, refund: true, burnt: REFUND_GAS }), () => { native -= 1n + REFUND_GAS; });
      // The 422 onchain_tx_failed answer, parsed by the real adapter (FINDINGS 1.27).
      return createOutLayerClient('https://outlayer.test', async () => ({ status: 422, text: async () => JSON.stringify({ ...record(fixture('outlayer-422-e68')), tx_hash: hash }) }))
        .call(new SecretString('wk_test'), req, 'idem');
    }
    if (mode === 'partial') return accepted(land(syntheticSwap(req, { out, used: n / 2n, burnt: gas }), () => { native -= 1n + gas; bal[tokenIn] = bal[tokenIn]! - n / 2n; }));
    if (mode === 'omft') return accepted(land(syntheticSwap(req, { out, payer: tokenOut, burnt: gas }), () => { native -= 1n + gas; bal[tokenIn] = bal[tokenIn]! - n; bal[tokenOut] = bal[tokenOut]! + out; }));
    return accepted(land(syntheticSwap(req, { out, native: sell, burnt: gas }), () => {
      const p = pools.get(Number(action.pool_id))!;
      p.amounts[p.tokens.indexOf(tokenIn)] = p.amounts[p.tokens.indexOf(tokenIn)]! + n; p.amounts[p.tokens.indexOf(tokenOut)] = p.amounts[p.tokens.indexOf(tokenOut)]! - out;
      bal[tokenIn] = bal[tokenIn]! - n;
      if (sell) native += out - 1n - gas; else { native -= 1n + gas; bal[tokenOut] = bal[tokenOut]! + out; }
    }));
  }
  const d: WorkerDeps = { store: db.worker, rpc, kek: Buffer.alloc(32, 4), now: () => clock, origin, live: true, tradeV1: o.workerTrade ?? true, provider: fullAccess,
    outlayer: dummyOutLayer({
      register: async () => ({ error: null, result: { walletId: 'wallet-trade', nearAccountId: agent, apiKey: new SecretString('wk_mock'), managementLink: new SecretString('https://example.test/mock') } }),
      encryptPolicy: async (_key, _id, r) => { rules = r; return { encryptedBase64: 'QUFBQQ==' }; },
      signPolicy: async () => ({ publicKeyHex: agent, signatureHex: 'b'.repeat(128), version: 1, locked: false, validUntil: Math.floor(testNow / 1000) + 7 * 86_400 }),
      getPolicy: async () => ({ http: 200, policy: 'stored', rules, frozen: false, approval: null, capabilities: null }),
      call: async (_key, req) => call(req),
      storageDeposit: async (_key, token, to) => {
        const account = to ?? agent;
        return accepted(land(txOf({ id: 'root', from: agent, to: token, a: fn('storage_deposit', { account_id: account, registration_only: true }, 30_000_000_000_000n, MONEY.storageDeposit), status: ok() }, [], ok(), OP_GAS),
          () => { registration.add(`${token}:${account}`); native -= MONEY.storageDeposit + OP_GAS; }));
      },
      transfer: async (_key, to, n) => {
        assert.equal(to, owner);
        return accepted(land(txOf({ id: 'root', from: agent, to, a: transferAction(n), status: ok() }, [], ok(), OP_GAS), () => { native -= n + OP_GAS; ownerBal.native = ownerBal.native! + n; }));
      },
    }) };
  d.store.acquireWorkerLock(process.pid, clock);
  db.watch.heartbeat('watchdog', clock);
  const session = 'a'.repeat(43);
  db.web.putSession(tokenHash(session), owner, clock, clock + 30 * 86_400_000);
  const request = async (path: string, input?: object) => {
    const run = createHandler({ store: db.web, rpc, now: d.now, env: { host: '127.0.0.1', port: 8090, origin, liveHires: true, tradeV1: webTrade }, provider: fullAccess, wait: () => processReveals(d) });
    const req = Object.assign(Readable.from(input === undefined ? [] : [Buffer.from(JSON.stringify(input))]), { url: path, method: input ? 'POST' : 'GET',
      headers: { host: 'app.test', origin, cookie: `fourlpha_session=${session}`, 'content-type': 'application/json' } });
    let response = '';
    const res = { statusCode: 200, setHeader() {}, end(text: string) { response = text; } };
    await run(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    return { status: res.statusCode, data: (JSON.parse(response) as { data: unknown }).data, text: response };
  };
  const at = (ms: number) => { clock = ms; db.watch.heartbeat('watchdog', clock); };
  const skip = (ms: number) => at(clock + ms);
  const state = (id: string) => db.worker.trade(id)!.state!;
  const job = (id: string) => db.worker.getJob(id)!;
  const tick = async (id: string) => { skip(db.worker.trade(id)?.state?.pending ? 1_000 : 61_000); return advanceJob(d, id); };
  /** Ten shared samples of the current reserves, aged 31 s to 10 min (the median guard's history). */
  const history = (n = 10, w = reserve(WNEAR), k = reserve(pair.token)) => db.worker.setMeta(`trade_px:${pool}`, JSON.stringify(Array.from({ length: n }, (_, i) =>
    ({ at: clock - 31_000 - (n - 1 - i) * 60_000, block: height - n + i, wnear: String(w), token: String(k) }))));
  const freezePolicy = (frozen: boolean) => { policy = { owner, encrypted_data: 'QUFBQQ==', frozen, storage_deposit: '15000000000000000000000' }; };
  async function hire() {
    const start = await request('/api/jobs', { kind, mode: 'live', pair: pair.id, depositYocto: deposit.toString(), trade: body });
    assert.equal(start.status, 201, start.text);
    const { id } = start.data as { id: string }, path = `/api/jobs/${id}`;
    assert.equal(job(id).trade, true); assert.equal(job(id).gridV1, false); assert.equal(job(id).lpV1, false);
    assert.equal(await tick(id), 'registered');
    assert.equal(await tick(id), 'policy_prepared');
    freezePolicy(false);
    assert.equal(await tick(id), 'armed');
    const ch = (await request(`/api/challenge?purpose=reveal&job=${id}`)).data as Challenge;
    assert.equal((await request(`${path}/reveal`, { signed: identity()(ch) })).status, 200);
    assert.equal((await request(`${path}/link-confirmed`, { saved: true })).status, 200);
    return { id, path };
  }
  async function run() {
    const { id, path } = await hire();
    native = deposit; height++;
    for (let i = 0; i < 12 && job(id).state !== 'running'; i++) await tick(id);
    assert.equal(job(id).state, 'running', job(id).reason ?? '');
    assert.equal(await tick(id), 'running');
    assert.ok(state(id), 'the first running evaluation stores the state');
    return { id, path };
  }
  async function resume(id: string) {
    freezePolicy(true); await tick(id); assert.equal(job(id).state, 'frozen');
    freezePolicy(false); await tick(id); assert.equal(job(id).state, 'paused');
    const ch = (await request(`/api/challenge?purpose=resume&job=${id}`)).data as Challenge;
    assert.equal((await request(`/api/jobs/${id}/resume`, { signed: identity()(ch) })).status, 200);
    for (let i = 0; i < 4 && job(id).state !== 'running'; i++) await tick(id);
    assert.equal(job(id).state, 'running');
  }
  /** Writes a pending step into the stored state, as a planner would. */
  const inject = (id: string, patch: Partial<TradeState>) => { const cur = state(id); assert.ok(db.worker.saveTrade(job(id), cur, { ...cur, ...patch })); };
  const step = (id: string, p: Omit<TradeStep, 'id' | 'plannedAt'>): TradeStep => ({ id: `${id}:${state(id).sequence}`, plannedAt: clock, ...p });
  return { ...db, d, rpc, pair, pool, deposit, settings, calls, bal, ownerBal, registration, request, tick, at, skip, state, job, history, hire, run, resume, inject, step, freezePolicy,
    reserve, setReserve, ret: (amountIn: bigint, tokenIn = WNEAR, tokenOut = pair.token) => ret(pool, tokenIn, amountIn, tokenOut),
    now: () => clock, reads: () => reads, get native() { return native; }, setNative: (v: bigint) => { native = v; }, height: () => height, bump: () => { height++; },
    setMode: (m: Mode) => { mode = m; }, setReadable: (v: boolean) => { readable = v; }, setPoolReadable: (v: boolean) => { poolReadable = v; },
    setFee: (fee: number) => { pools.get(pool)!.fee = fee; }, forceQuote: (v: bigint | null) => { forcedQuote = v; }, setWebTrade: (v: boolean) => { webTrade = v; } };
}
type Harness = ReturnType<typeof setup>;
async function until(h: Harness, id: string, done: () => boolean, limit = 40) {
  for (let i = 0; i < limit && !done(); i++) await h.tick(id);
  assert.ok(done(), h.job(id).reason ?? 'the expected checkpoint was not reached');
}
const swaps = (h: Harness) => h.calls.filter(c => c.method === 'ft_transfer_call');
const rows = (h: Harness, id: string, kind?: string) => h.worker.jobOps(id).filter(o => (o.kind === 'wrap' || o.kind === 'swap') && (!kind || o.kind === kind));
const minOfCall = (c: { args: Record<string, unknown> }) => BigInt((JSON.parse(String(c.args.msg)) as { actions: { min_amount_out: string }[] }).actions[0]!.min_amount_out);
/** One full buy: plan, wrap, swap. */
async function buy(h: Harness, id: string) {
  const before = h.state(id).fills;
  await until(h, id, () => h.state(id).fills > before || h.job(id).state !== 'running');
}
function decoded(name: string): Record<string, unknown> {
  const r = record(record(fixture(name))?.result)!;
  return JSON.parse(Buffer.from(r.result as number[]).toString('utf8')) as Record<string, unknown>;
}

test('15.1 pairs and pins: three exact pairs, 4512 stays first, PAIRS unchanged, readTradePool pins kind, tokens and fee', async () => {
  assert.deepEqual(TRADE_PAIRS.map(p => [p.id, p.token, p.symbol, p.decimals, p.pin.poolId, p.pin.kind, p.pin.feeBps, p.minWnearReserve]), [
    ['trade-usdc', USDC, 'USDC', 6, 4512, 'SIMPLE_POOL', 30, 10_000n * N],
    ['trade-rhea', 'token.rhealab.near', 'RHEA', 18, 6458, 'SIMPLE_POOL', 30, 10_000n * N],
    ['trade-zec', 'zec.omft.near', 'ZEC', 8, 6065, 'SIMPLE_POOL', 0, 10_000n * N]]);
  assert.equal(CLASSIC_POOLS[0]!.poolId, 4512);
  assert.deepEqual(PAIRS, [{ id: 'usdc-wnear', classicPool: 4512 }]);
  assert.throws(() => tradePair('usdc-wnear'), { code: 'policy_invalid' });
  assert.throws(() => tradePair('trade-btc'), { code: 'policy_invalid' });
  // T-10: Grid and LP jobs keep USDC as their only token.
  assert.deepEqual(jobTokens({ trade: false, pair: 'usdc-wnear' } as Job), [USDC]);
  assert.deepEqual(jobTokens({ trade: true, pair: 'trade-zec' } as Job), [ZEC]);
  const at = (value: unknown) => dummyRpc({ view: async () => ({ height: 224070858, value }) });
  const rhea = decoded('ref-get_pool-6458-at-224070858'), zec = decoded('ref-get_pool-6065-at-224070858');
  assert.deepEqual(await readTradePool(at(rhea), tradePair('trade-rhea')), { height: 224070858, wnear: 112376915111888666470198909136n, token: 11038192113637089006712523n, fee: 30 });
  assert.deepEqual(await readTradePool(at(zec), tradePair('trade-zec')), { height: 224070858, wnear: 30027621100680611870775004061n, token: 11519712462n, fee: 0 });
  const zp = tradePair('trade-zec');
  await assert.rejects(readTradePool(at({ ...zec, total_fee: 30 }), zp), { code: 'policy_invalid' }, '6065 with fee 30 is refused');
  await assert.rejects(readTradePool(at({ ...zec, pool_kind: 'STABLE_SWAP' }), zp), { code: 'policy_invalid' });
  await assert.rejects(readTradePool(at({ ...zec, token_account_ids: [WNEAR, USDC] }), zp), { code: 'policy_invalid' });
  await assert.rejects(readTradePool(at({ ...zec, token_account_ids: [WNEAR, ZEC, USDC] }), zp), { code: 'policy_invalid' });
  await assert.rejects(readTradePool(at({ ...zec, total_fee: undefined }), zp), { code: 'rpc_unavailable' });
  await assert.rejects(readTradePool(at({ ...zec, amounts: ['1', 'x'] }), zp), { code: 'rpc_unavailable' });
});

test('15.2 settings: every bound on both sides, exact keys, the step table, the exact deposit, pair and flag refusals', () => {
  const now = testNow, s = (patch: object) => tradeSettingsFromRequest('schedule', { ...SCHEDULE, ...patch }, now), dca = (patch: object) => tradeSettingsFromRequest('dca', { ...DCA, ...patch }, now);
  const good = (v: unknown) => assert.notEqual(v, 'invalid'), bad = (v: unknown) => assert.equal(v, 'invalid');
  good(s({ amountNear: '0.10' })); bad(s({ amountNear: '0.09' })); good(s({ amountNear: '0.20' })); bad(s({ amountNear: '0.25', budgetNear: '1.60' })); good(s({ amountNear: '0.24', budgetNear: '0.24' }));
  good(s({ budgetNear: '0.20' })); bad(s({ budgetNear: '0.19' })); good(s({ budgetNear: '1.60' })); bad(s({ budgetNear: '1.61' })); bad(s({ amountNear: '0.24', budgetNear: '0.23' }));
  for (const intervalSec of [3600, 14400, 28800, 43200, 86400]) good(s({ intervalSec }));
  for (const intervalSec of [1800, 604800, '3600']) bad(s({ intervalSec }));
  good(s({ end: { kind: 'runs', runs: 1 } })); good(s({ end: { kind: 'runs', runs: 16 } })); bad(s({ end: { kind: 'runs', runs: 0 } })); bad(s({ end: { kind: 'runs', runs: 17 } })); bad(s({ end: { kind: 'runs', runs: 1.5 } }));
  good(s({ end: { kind: 'date', atMs: now + HOUR } })); bad(s({ end: { kind: 'date', atMs: now + HOUR - 1 } }));
  good(s({ end: { kind: 'date', atMs: now + 6 * 86_400_000 } })); bad(s({ end: { kind: 'date', atMs: now + 6 * 86_400_000 + 1 } }));
  bad(s({ end: { kind: 'budget', extra: 1 } })); bad(s({ end: { kind: 'runs', runs: 2, atMs: 1 } })); bad(s({ amountNear: '0.105' })); bad(s({ amountNear: 0.1 })); bad(s({ amountNear: '.10' }));
  bad(tradeSettingsFromRequest('schedule', { ...SCHEDULE, extra: true }, now)); bad(tradeSettingsFromRequest('schedule', { amountNear: '0.10', intervalSec: 3600, budgetNear: '0.20' }, now));
  bad(tradeSettingsFromRequest('dca', SCHEDULE, now)); bad(tradeSettingsFromRequest('grid', SCHEDULE, now));
  good(dca({ baseNear: '0.24', orderNear: '0.24' })); bad(dca({ baseNear: '0.09' })); bad(dca({ orderNear: '0.25' })); bad(dca({ baseNear: '0.25' })); bad(dca({ orderNear: '0.09' }));
  good(dca({ levels: 8, orderNear: '0.10' })); bad(dca({ levels: 0 })); bad(dca({ levels: 9 }));
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map(maxStepBps), [3000, 3000, 2450, 1650, 1200, 900, 650, 500]);
  for (let levels = 1; levels <= 8; levels++) {
    good(dca({ levels, stepBps: maxStepBps(levels) })); bad(dca({ levels, stepBps: maxStepBps(levels) + 50 }));
  }
  good(dca({ stepBps: 50 })); bad(dca({ stepBps: 0 })); bad(dca({ stepBps: 125 }));
  good(dca({ tpBps: 50 })); bad(dca({ tpBps: 40 })); good(dca({ tpBps: 5000 })); bad(dca({ tpBps: 5010 })); bad(dca({ tpBps: 155 }));
  good(dca({ slBps: 0 })); good(dca({ slBps: 100 })); good(dca({ slBps: 9000 })); bad(dca({ slBps: 50 })); bad(dca({ slBps: 9100 })); bad(dca({ slBps: 150 }));
  good(dca({ baseNear: '0.16', orderNear: '0.24', levels: 6, stepBps: 900 })); bad(dca({ baseNear: '0.24', orderNear: '0.24', levels: 6, stepBps: 900 })); // the plan cap of 1.60 NEAR
  bad(tradeSettingsFromRequest('dca', { ...DCA, extra: 1 }, now));
  // The stored form checks the same bounds except the clock rule of a date end.
  const stored = s({ end: { kind: 'date', atMs: now + HOUR } }) as TradeSettings;
  assert.deepEqual(parseTradeSettings(stored), stored);
  assert.notEqual(parseTradeSettings({ ...stored, end: { kind: 'date', atMs: 5 } }), 'invalid');
  assert.equal(parseTradeSettings({ ...stored, amount: '1' }), 'invalid');
  assert.equal(parseTradeSettings({ ...stored, v: 2 }), 'invalid');
  assert.equal(parseTradeSettings({ ...stored, extra: 1 }), 'invalid');
  // The exact deposit, the trade pair, the flag and the limits (draftProblems).
  const plan = tradePlan(stored), draft = { session: { accountId: owner }, kind: 'schedule', mode: 'live', pair: 'trade-usdc', depositYocto: (plan + TRADE_RESERVE).toString(),
    liveEnabled: true, tradeV1: true, trade: { ...SCHEDULE, end: { kind: 'date', atMs: now + HOUR } }, now, liveJobs: 0, ownerPendingLive: 0 };
  assert.deepEqual(draftProblems(draft), []);
  assert.equal(draftProblems({ ...draft, depositYocto: (plan + TRADE_RESERVE + 1n).toString() }).length, 1);
  assert.equal(draftProblems({ ...draft, depositYocto: (plan + TRADE_RESERVE - 1n).toString() }).length, 1);
  assert.equal(draftProblems({ ...draft, pair: 'usdc-wnear' }).length, 1, 'a trade hire with the Grid pair is refused');
  assert.equal(draftProblems({ ...draft, tradeV1: false }).length, 1, 'flag off');
  assert.equal(draftProblems({ ...draft, mode: 'dry-run' }).length, 1);
  assert.equal(draftProblems({ ...draft, liveEnabled: false }).length, 1);
  assert.equal(draftProblems({ ...draft, ownerPendingLive: 1 }).length, 1);
  assert.ok(draftProblems({ ...draft, kind: 'grid', gridV1: true, depositYocto: N.toString() }).length, 'a Grid hire with a trade pair is refused');
  assert.deepEqual(draftProblems({ ...draft, kind: 'grid', gridV1: true, pair: 'usdc-wnear', depositYocto: N.toString() }), [], 'Grid is unchanged');
});

test('15.2 web flag off refuses the hire; unreadable stored settings halt the strategy and exit still runs', async t => {
  const off = setup(t, { webTrade: false });
  const refused = await off.request('/api/jobs', { kind: 'schedule', mode: 'live', pair: 'trade-usdc', depositYocto: off.deposit.toString(), trade: SCHEDULE });
  assert.equal(refused.status, 400);
  assert.equal(((await off.request('/api/hire/options')).data as { trade: { enabled: boolean } }).trade.enabled, false);
  const h = setup(t), { id, path } = await h.run();
  const raw = new DatabaseSync(h.path);
  try { raw.prepare('UPDATE trade_jobs SET settings=? WHERE job_id=?').run('{"v":1,"strategy":"schedule"}', id); } finally { raw.close(); }
  assert.equal(h.worker.trade(id)?.settings, 'invalid');
  await h.tick(id);
  assert.equal(h.job(id).state, 'halted'); assert.equal(h.job(id).reason, 'Trade settings are unreadable. Stop and withdraw.');
  assert.equal(rows(h, id).length, 0, 'no strategy step');
  const view = (await h.request(path)).data as { trade: { settings: string; schedule: unknown; dca: unknown; ledger: { spent: string } } };
  assert.equal(view.trade.settings, 'invalid'); assert.equal(view.trade.schedule, null); assert.equal(view.trade.dca, null); assert.equal(view.trade.ledger.spent, '0');
  assert.equal((await h.request(`${path}/stop`, {})).status, 200);
  await until(h, id, () => h.job(id).state === 'stopped');
  assert.ok(h.ownerBal.native! > h.deposit - near('0.02'), 'the owner got the NEAR back');
});

test('15.3 arithmetic: measured quotes, ladder factors and need, exact TP and SL lines, I-17 room and the x10 caps', async t => {
  const rhea = decoded('ref-get_pool-6458-at-224070858'), zec = decoded('ref-get_pool-6065-at-224070858');
  const amounts = (p: Record<string, unknown>) => (p.amounts as string[]).map(BigInt);
  const [rRhea, rWnear] = amounts(rhea), [zWnear, zZec] = amounts(zec);
  assert.equal(outGivenIn(N / 5n, rWnear!, rRhea!, 30), 19585976353097982486n);
  assert.equal(outGivenIn(N / 5n, zWnear!, zZec!, 0), 76726n);
  const f = (k: number) => ladderFactor(k, 100);
  assert.deepEqual([1, 2, 3, 4].map(k => [f(k).num, f(k).den]), [[9900n, 10000n], [48900n, 50000n], [240900n, 250000n], [1182900n, 1250000n]]);
  // P0 = 700 yocto per raw: L_k = 693, 684.6, 674.52, 662.424; need is the token amount at which the price is at most L_k.
  const p0 = { num: 700n, den: 1n };
  assert.deepEqual([1, 2, 3, 4].map(k => levelNeed(69300n, p0, k, 100)), [100n, 102n, 103n, 105n]);
  assert.equal(levelNeed(69300n, p0, 1, 100) * 693n >= 69300n, true);
  assert.equal(tpLine(near('0.101812'), 150), 106384180000000000000000n);
  assert.equal(tpLine(near('0.241812'), 150), 248484180000000000000000n);
  const k = near('0.101812'), slLine = k * 9000n / 10_000n;
  assert.equal(slLine, near('0.0916308'));
  // I-17: the wraps of a whole job never meet the strategy limit before a sale, for every allowed deposit.
  for (let d = near('0.6'); d <= near('2'); d += near('0.01')) {
    const plan = d - TRADE_RESERVE;
    assert.deepEqual(nativeSpendProblems({ used24h: 0, used1h: 0, blockedUntil: null, nativeSpent24h: plan - near('0.1') }, near('0.1'), 3n * d, 'strategy', d), []);
  }
  // The token cap uses 10 times the hire quote of the job's own pool (AD-8).
  const h = setup(t, { pair: 'trade-rhea' }), { id } = await h.run(), price = h.ret(N), job = h.job(id);
  assert.deepEqual(job.caps, defaultCaps(h.deposit, { [RHEA]: 10n * price }));
  assert.equal(job.caps!.tokenPerTx[RHEA], 2n * (h.deposit * 10n * price / N));
  assert.ok(job.rules!.addresses.list.includes(RHEA) && !job.rules!.addresses.list.includes(EX), 'whitelist is the owner, wrap.near and the token, no exchange');
});

test('15.3 the reserve walk: the 16th wrap passes T-7 at 0.466587 NEAR free and a 17th at 0.364775 NEAR does not', async t => {
  const h = setup(t, { trade: { ...SCHEDULE, budgetNear: '1.60', end: { kind: 'budget' } } }), { id } = await h.run();
  assert.equal(h.deposit, near('2'));
  const wrapAt = async (free: bigint) => {
    h.setNative(free + STORAGE); h.bump();
    h.inject(id, { pending: h.step(id, { kind: 'wrap', side: 'buy', amount: near('0.1').toString() }), buy: { amount: near('0.1').toString(), floor: '1' } });
    const ops = createLiveOps({ ...h.d, jobId: id });
    try { return (await ops.wrap(near('0.1'))).verdict; }
    catch (e) { if (!h.worker.gridStep(id, h.state(id).pending!.id)) h.inject(id, { pending: null, buy: null, sequence: h.state(id).sequence + 1 }); throw e; }
  };
  assert.equal(await wrapAt(near('0.466587')), 'success');
  h.inject(id, { pending: null, buy: null, sequence: h.state(id).sequence + 1 });
  await assert.rejects(wrapAt(near('0.364775')), /0\.321 NEAR free/);
  await assert.rejects(wrapAt(near('0.421') - 1n), /0\.321 NEAR free/);
  assert.equal(await wrapAt(near('0.421')), 'success', 'the gate is inclusive at the wrap plus 0.321 NEAR');
});

test('15.3 TP-fit: the ops.run guard with zero prior spend, 1 yocto attached and the missing-registration reservation, and the real guard agrees', async t => {
  const h = setup(t, { kind: 'dca' }), { id } = await h.run();
  assert.equal(h.deposit, near('0.6'));
  h.skip(25 * HOUR); // no operation in the rolling window
  const empty = { used24h: 0, used1h: 0, blockedUntil: null, nativeSpent24h: 0n };
  const H = 10_000_000n;
  const fit = async (quote: bigint, missing: boolean, spent = 0n) => {
    h.setNative(near('0.39') + STORAGE); h.bal[WNEAR] = 0n; h.bal[USDC] = H; h.bump();
    if (missing) h.registration.delete(`${USDC}:${owner}`); else h.registration.add(`${USDC}:${owner}`);
    const snap = await readHoldings(h.rpc, agent, [WNEAR, USDC]);
    assert.equal(snap.spendable, near('0.39'));
    const { native } = await exitBudget(h.rpc, h.job(id), snap, quote);
    return nativeSpendProblems({ ...empty, nativeSpent24h: spent }, 1n, h.job(id).caps!.nativeDaily, 'strategy', native).length === 0;
  };
  assert.equal(await fit(near('1.30'), false), true, 'fits an empty window');
  assert.equal(await fit(near('1.30'), false, near('0.21')), false, 'the current window makes it wait');
  assert.equal(await fit(near('2.0'), false), false);
  assert.equal(await fit(near('1.41'), false), false, 'equality ends');
  assert.equal(await fit(near('1.41') - 1n, false), true);
  assert.equal(await fit(near('1.40875'), true), false, 'the missing owner registration is reserved');
  assert.equal(await fit(near('1.40875') - 1n, true), true);
  // The real guard: a pending sale of H at the forced quote, submitted through ops.run.
  const sell = async (quote: bigint, missing: boolean) => {
    await fit(quote, missing);
    h.forceQuote(quote);
    h.inject(id, { pending: h.step(id, { kind: 'swap', side: 'sell', amount: H.toString(), floor: quote.toString() }) });
    const before = swaps(h).length;
    try { await createLiveOps({ ...h.d, jobId: id }).swap({ pin: h.pair.pin, tokenIn: USDC, tokenOut: WNEAR, amountIn: H, slippageBps: 50, unwrapNear: true, floor: quote }); }
    catch (e) { assert.match(String(e), /native daily window/); return false; }
    finally { h.forceQuote(null); if (h.state(id).pending && !h.worker.gridStep(id, h.state(id).pending!.id)) h.inject(id, { pending: null, sequence: h.state(id).sequence + 1 }); }
    return swaps(h).length === before + 1;
  };
  assert.equal(await sell(near('1.41'), false), false);
  assert.equal(await sell(near('1.40875'), true), false);
  assert.equal(await sell(near('2.0'), false), false);
  assert.equal(await sell(near('1.41') - 1n, false), true, 'the real guard admits exactly what TP-fit admits');
});

test('15.4 swap guards: the two shapes on the own pool, floor before any row, minOut = max(slipped, floor), depth floor, Grid and LP requests unchanged', async t => {
  const h = setup(t, { pair: 'trade-rhea' }), { id } = await h.run(), ops = createLiveOps({ ...h.d, jobId: id }), amount = near('0.1');
  h.bal[WNEAR] = amount; h.bump();
  const pin = h.pair.pin, fresh = () => h.ret(amount);
  const buyStep = (floor: bigint) => h.inject(id, { pending: h.step(id, { kind: 'swap', side: 'buy', amount: amount.toString(), floor: floor.toString() }), buy: { amount: amount.toString(), floor: floor.toString() } });
  const clear = () => { if (!h.worker.gridStep(id, h.state(id).pending!.id)) h.inject(id, { pending: null, buy: null, sequence: h.state(id).sequence + 1 }); };
  buyStep(1n);
  for (const o of [{ pin: CLASSIC_POOLS[0]!, tokenIn: WNEAR, tokenOut: USDC }, { pin, tokenIn: WNEAR, tokenOut: RHEA, unwrapNear: true }, { pin, tokenIn: WNEAR, tokenOut: RHEA, slippageBps: 100 },
    { pin, tokenIn: WNEAR, tokenOut: RHEA, floor: undefined }, { pin: CLASSIC_POOLS[2]!, tokenIn: WNEAR, tokenOut: ZEC }]) {
    await assert.rejects(ops.swap({ amountIn: amount, slippageBps: 50, unwrapNear: false, floor: 1n, ...o }), { code: 'forbidden' }, JSON.stringify(o, (_k, v: unknown) => typeof v === 'bigint' ? v.toString() : v));
  }
  clear();
  // A floor above the fresh quote is refused before any journal row (T-3).
  buyStep(fresh() + 1n);
  await assert.rejects(ops.swap({ pin, tokenIn: WNEAR, tokenOut: RHEA, amountIn: amount, slippageBps: 50, unwrapNear: false, floor: fresh() + 1n }), /below the agent's limit/);
  assert.equal(rows(h, id).length, 0); clear();
  // Depth floor (TF-4): 9,999 wNEAR is refused, 10,000 passes.
  const depth = h.reserve(WNEAR), tokens = h.reserve(RHEA);
  h.setReserve(WNEAR, 9_999n * N); buyStep(1n);
  await assert.rejects(ops.swap({ pin, tokenIn: WNEAR, tokenOut: RHEA, amountIn: amount, slippageBps: 50, unwrapNear: false, floor: 1n }), /10,000 wNEAR/); clear();
  h.setReserve(WNEAR, 10_000n * N); h.setReserve(RHEA, tokens * 10_000n * N / depth); // the same price at the floor depth
  const slipped = minOut(fresh(), 50), floor = fresh(); // a floor equal to the fresh quote is still accepted
  buyStep(floor);
  assert.equal((await ops.swap({ pin, tokenIn: WNEAR, tokenOut: RHEA, amountIn: amount, slippageBps: 50, unwrapNear: false, floor })).verdict, 'swapped');
  assert.equal(minOfCall(swaps(h).at(-1)!), floor, 'a floor above the slipped quote is the signed minimum');
  h.setReserve(WNEAR, depth); h.setReserve(RHEA, tokens);
  h.inject(id, { pending: null, buy: null, sequence: h.state(id).sequence + 1 });
  h.bal[WNEAR] = amount; h.bump();
  buyStep(1n);
  const expected = minOut(fresh(), 50);
  assert.equal((await ops.swap({ pin, tokenIn: WNEAR, tokenOut: RHEA, amountIn: amount, slippageBps: 50, unwrapNear: false, floor: 1n })).verdict, 'swapped');
  assert.equal(minOfCall(swaps(h).at(-1)!), expected, 'below the slipped quote the floor changes nothing');
  assert.ok(slipped < floor, 'the first case had its floor above the slipped quote');
  // The sale shape: the token to native NEAR with unwrap on.
  const held = h.bal[RHEA]!;
  h.inject(id, { pending: null, buy: null, sequence: h.state(id).sequence + 1 });
  h.inject(id, { pending: h.step(id, { kind: 'swap', side: 'sell', amount: held.toString(), floor: '1' }) });
  assert.equal((await ops.swap({ pin, tokenIn: RHEA, tokenOut: WNEAR, amountIn: held, slippageBps: 50, unwrapNear: true, floor: 1n })).verdict, 'swapped');
  assert.equal(JSON.parse(String(swaps(h).at(-1)!.args.msg)).skip_unwrap_near, false);
  // A Grid or LP style call without a floor signs the request it signed before Trade V1.
  const db = stores(t), { job, kek } = armedJob(db.web, db.worker, 'running'), c = chain();
  db.watch.heartbeat('watchdog', testNow);
  const seen: CallRequest[] = [];
  const plain = createLiveOps({ store: db.worker, rpc: c.rpc, kek, jobId: job.id, now: () => testNow, wait: async () => {},
    outlayer: dummyOutLayer({ call: async (_k, req) => { seen.push(req); return { kind: 'rejected', http: 400, code: null, message: 'x' }; } }) });
  const input = { pin: CLASSIC_POOLS[0]!, tokenIn: WNEAR, tokenOut: USDC, amountIn: 15n * N / 1000n, slippageBps: 100, unwrapNear: false };
  await plain.swap(input);
  assert.deepEqual(seen, [swapCall({ ...input, minOut: minOut(56478n, 100) })]);
});

test('15.5 median guard: 9 samples wait, 10 within 200 bps pass, 201 bps wait, old samples ignored, a 6 of 10 majority moves it', () => {
  const now = testNow, w = 1_000_000n, k = 1_000n;
  const list = (n: number, age = 31_000, ww = w) => Array.from({ length: n }, (_, i) => ({ at: now - age - i * 60_000, block: i, wnear: String(ww), token: String(k) }));
  const spot = (bps: number) => ({ at: now, block: 99, wnear: String(w * BigInt(10_000 + bps) / 10_000n), token: String(k) });
  assert.match(medianWait(list(9), now, spot(0))!, /collecting/);
  assert.equal(medianWait(list(10), now, spot(0)), null);
  assert.equal(medianWait(list(10), now, spot(200)), null);
  assert.equal(medianWait(list(10), now, spot(-200)), null);
  assert.match(medianWait(list(10), now, spot(201))!, /more than 2 %/);
  assert.match(medianWait(list(10), now, spot(-201))!, /more than 2 %/);
  assert.match(medianWait([...list(9), { at: now - 1_800_000, block: 0, wnear: String(w), token: String(k) }], now, spot(0))!, /collecting/, 'a 30-minute-old sample is outside the window');
  assert.match(medianWait([...list(9), { at: now - 29_000, block: 0, wnear: String(w), token: String(k) }], now, spot(0))!, /collecting/, 'a sample under 30 s old is outside the window');
  const pushed = (n: number) => [...list(10 - n), ...list(n, 31_500, w * 2n)];
  assert.match(medianWait(pushed(5), now, spot(10_000))!, /more than 2 %/, 'five pushed samples do not move the median');
  assert.equal(medianWait(pushed(6), now, spot(10_000)), null, 'RR-4: six pushed samples of ten move the median and the buy passes');
});

test('15.5 planning floor: a push between planning and the wrap, or between the wrap and the swap, refuses the swap with no row and keeps the wNEAR', async t => {
  for (const when of ['before-wrap', 'after-wrap'] as const) {
    const h = setup(t), { id } = await h.run();
    h.history(); await h.tick(id);
    const planned = h.state(id).buy!;
    assert.equal(BigInt(planned.floor!), h.ret(near('0.1')) * 9950n / 10_000n, 'the floor is 99.5 % of the median-approved planning quote');
    const push = () => h.setReserve(USDC, h.reserve(USDC) * 96n / 100n); // the token 4 % dearer
    if (when === 'before-wrap') push();
    await h.tick(id); // the wrap goes out: it carries no price
    assert.equal(h.state(id).pending?.kind, 'swap'); assert.equal(h.state(id).wnear, near('0.1').toString());
    if (when === 'after-wrap') push();
    await h.tick(id);
    assert.equal(h.job(id).reason, "The fresh quote is below the agent's limit.");
    assert.equal(rows(h, id, 'swap').length, 0, when);
    assert.equal(h.state(id).pending, null); assert.equal(h.state(id).buy, null); assert.equal(h.state(id).wnear, near('0.1').toString(), 'the wNEAR stays');
    await h.tick(id);
    assert.match(h.job(id).reason!, /more than 2 %/, 'the next plan runs the median guard again');
  }
});

test('15.6 Schedule: two buys an hour apart, the idle gate reads nothing while the slot is taken, then budget ends and the exit pays NEAR plus the token', async t => {
  const h = setup(t), { id, path } = await h.run(), a = h.state(id).anchor!;
  assert.equal(a, h.now(), 'the anchor is the first running evaluation');
  h.history(); await buy(h, id);
  assert.equal(h.state(id).lastSlot, 0); assert.equal(h.state(id).fills, 1);
  assert.deepEqual(rows(h, id).map(r => r.kind).reverse(), ['wrap', 'swap']);
  await watchOnce({ store: h.watch, rpc: h.rpc, now: h.now });
  const reads = h.reads();
  h.at(a + HOUR - 1); await advanceJob(h.d, id);
  assert.equal(h.reads(), reads, 'no chain read while the slot is taken');
  let view = (await h.request(path)).data as { trade: { schedule: { currentSlot: number; currentSlotTaken: boolean; nextDueAt: number; postponed: number; remaining: string } } };
  assert.deepEqual([view.trade.schedule.currentSlot, view.trade.schedule.currentSlotTaken, view.trade.schedule.nextDueAt], [0, true, a + HOUR]);
  h.at(a + HOUR); h.history();
  await advanceJob(h.d, id);
  assert.equal(h.state(id).pending?.slot, 1, 'slot 1 opens at A + I');
  await buy(h, id);
  assert.equal(h.state(id).spent, near('0.2').toString());
  view = (await h.request(path)).data as typeof view;
  assert.equal(view.trade.schedule.remaining, '0'); assert.equal(view.trade.schedule.postponed, 0);
  await h.tick(id);
  assert.equal(h.job(id).state, 'stopping'); assert.equal(h.state(id).done?.kind, 'budget');
  assert.equal(h.job(id).reason, 'Schedule finished: budget spent. Paying the owner.');
  assert.equal(h.worker.openAlerts(id).filter(x => x.kind === 'trade_done').length, 1);
  const swapsAtEnd = swaps(h).length, bought = BigInt(h.state(id).bought);
  await until(h, id, () => h.job(id).state === 'stopped');
  assert.equal(swaps(h).length, swapsAtEnd, 'the exit makes no swap');
  assert.equal(h.ownerBal[USDC], bought, 'the owner receives the bought token');
  assert.equal(h.bal[USDC], 0n); assert.ok(h.native - STORAGE <= MONEY.sweepReserve);
});

test('15.6 a freeze in the idle hour is still recorded: the job goes frozen, the unfreeze pauses it, and the next slot buys nothing without a signed resume', async t => {
  const h = setup(t), { id } = await h.run(), a = h.state(id).anchor!;
  h.history(); await buy(h, id);
  const watch = () => watchOnce({ store: h.watch, rpc: h.rpc, now: h.now });
  await watch();
  h.freezePolicy(true); h.bump(); await watch();
  assert.equal(h.watch.meta(`watch_frozen:${id}`), 'true');
  h.skip(2 * MIN); await advanceJob(h.d, id);
  assert.equal(h.job(id).state, 'frozen', 'the idle gate opens while the watchdog sees the wallet frozen');
  h.freezePolicy(false); h.bump(); await watch();
  h.skip(2 * MIN); await advanceJob(h.d, id);
  assert.equal(h.job(id).state, 'paused');
  h.at(a + HOUR + MIN); h.history(); await advanceJob(h.d, id);
  assert.equal(h.job(id).state, 'paused'); assert.equal(h.state(id).fills, 1); assert.equal(h.state(id).pending, null, 'an unfreeze never resumes the job');
});

test('15.6 Schedule: a postponed slot is never filled, a buy settling in the next slot marks its own slot', async t => {
  const h = setup(t, { trade: { ...SCHEDULE, budgetNear: '0.30' } }), { id, path } = await h.run(), a = h.state(id).anchor!;
  h.at(a + HOUR - 3_000); h.history(); await advanceJob(h.d, id);
  assert.equal(h.state(id).pending?.slot, 0);
  h.at(a + HOUR - 2_000); await advanceJob(h.d, id); // the wrap
  h.at(a + HOUR + 500); await advanceJob(h.d, id); // the swap settles in slot 1
  assert.equal(h.state(id).lastSlot, 0, 'slot 0 is taken although the buy settled in slot 1');
  h.at(a + HOUR + 61_000); h.history(); await advanceJob(h.d, id);
  assert.equal(h.state(id).pending?.slot, 1, 'the next evaluation attempts slot 1');
  await buy(h, id);
  // Slot 2 passes with no evaluation that can buy (the guard waits); slot 3 buys.
  h.at(a + 3 * HOUR + 61_000); h.history(); await advanceJob(h.d, id);
  assert.equal(h.state(id).pending?.slot, 3);
  await buy(h, id);
  const view = (await h.request(path)).data as { trade: { schedule: { postponed: number; fills: number } } };
  assert.deepEqual([view.trade.schedule.fills, view.trade.schedule.postponed], [3, 1]);
  assert.equal(rows(h, id, 'swap').length, 3, 'slots 0, 1 and 3 bought; slot 2 was never filled');
});

test('15.6 Schedule ends: runs and date at equality, budget first under runs and a far date, and the lifetime end', async t => {
  const runs = setup(t, { trade: { ...SCHEDULE, end: { kind: 'runs', runs: 1 } } }), r = await runs.run();
  runs.history(); await buy(runs, r.id); await runs.tick(r.id);
  assert.equal(runs.state(r.id).done?.kind, 'runs', 'fills equal to runs ends the job although budget remains');
  for (const end of [{ kind: 'runs', runs: 16 }, { kind: 'date', atMs: testNow + 5 * 86_400_000 }]) {
    const h = setup(t, { trade: { ...SCHEDULE, end } }), { id } = await h.run(), a = h.state(id).anchor!;
    h.history(); await buy(h, id);
    assert.equal(h.job(id).state, 'running', 'plan minus spent equal to the amount does not end');
    h.at(a + HOUR); h.history(); await buy(h, id); await h.tick(id);
    assert.equal(h.state(id).done?.kind, 'budget', `budget ends a ${end.kind} job and is reported first`);
  }
  const date = setup(t, { trade: { ...SCHEDULE, end: { kind: 'date', atMs: testNow + 2 * HOUR } } }), dt = await date.run();
  date.history(); await buy(date, dt.id);
  // The once-a-minute gate is reset between the two instants so that both are evaluated.
  const gate = (h: Harness, id: string) => h.worker.setMeta(`trade_eval:${id}`, '0');
  date.at(testNow + 2 * HOUR - 1); await advanceJob(date.d, dt.id);
  assert.equal(date.job(dt.id).state, 'running');
  date.at(testNow + 2 * HOUR); gate(date, dt.id); await advanceJob(date.d, dt.id);
  assert.equal(date.state(dt.id).done?.kind, 'date');
  const life = setup(t), lf = await life.run(), endsAt = testNow + 6 * 86_400_000;
  life.history(); await buy(life, lf.id);
  assert.equal(((await life.request(`/api/jobs/${lf.id}`)).data as { trade: { endsAt: number } }).trade.endsAt, endsAt);
  life.at(endsAt - 1); await advanceJob(life.d, lf.id);
  assert.equal(life.job(lf.id).state, 'running');
  life.at(endsAt); gate(life, lf.id); await advanceJob(life.d, lf.id);
  assert.equal(life.state(lf.id).done?.kind, 'life');
});

test('15.6 a row-less step older than 120 s is dropped and the guard runs again, also after freeze, unfreeze and resume; a refund backs off 5 minutes', async t => {
  const h = setup(t), { id } = await h.run();
  h.history(); await h.tick(id);
  const stale = h.state(id).pending!;
  h.worker.setMeta(`trade_px:${h.pool}`, '[]');
  h.skip(121_000); await advanceJob(h.d, id);
  assert.equal(h.state(id).pending, null); assert.match(h.job(id).reason!, /collecting/);
  assert.equal(h.worker.gridStep(id, stale.id), null, 'the stale step never got a row');
  h.history(); await h.tick(id);
  const before = h.state(id).pending!;
  await h.resume(id);
  h.history(); await advanceJob(h.d, id);
  assert.notEqual(h.state(id).pending?.id, before.id, 'a step planned before the resume is dropped and planned again');
  assert.ok(h.state(id).pending!.plannedAt >= Number(h.worker.meta(`trade_running_since:${id}`)));
  assert.equal(h.worker.gridStep(id, before.id), null);
  // An E68 refund (the receipt and the 422 answer) keeps the wNEAR and backs off five minutes.
  await h.tick(id); // the wrap
  h.setMode('refund'); await h.tick(id); h.setMode('normal');
  const s = h.state(id);
  assert.equal(rows(h, id, 'swap')[0]!.verdict, 'refunded'); assert.equal(s.failures, 1); assert.equal(s.wnear, near('0.1').toString());
  assert.equal(s.gasBuy, (WRAP_GAS + REFUND_GAS).toString(), 'the refunded buy gas enters K');
  h.history(); await h.tick(id);
  assert.equal(h.state(id).pending, null); assert.match(h.job(id).reason!, /five minutes/);
  h.skip(5 * MIN); h.history(); await h.tick(id);
  assert.equal(h.state(id).pending?.kind, 'swap', 'the held wNEAR is swapped without a new wrap');
  await h.tick(id);
  assert.equal(h.state(id).fills, 1); assert.equal(h.state(id).failures, 0);
  assert.equal(h.state(id).gasBuy, (WRAP_GAS + REFUND_GAS + SWAP_GAS).toString());
});

test('15.7 DCA: base buy and P0, TP line from the measured gas, TP sale with the full line as floor ends tp and pays the owner', async t => {
  const h = setup(t, { kind: 'dca' }), { id, path } = await h.run();
  h.history(); await buy(h, id);
  const s = h.state(id);
  assert.deepEqual(s.p0, { num: near('0.1').toString(), den: s.bought });
  assert.equal(BigInt(s.spent) + BigInt(s.gasBuy), near('0.101812'), 'K is the base plus the measured wrap and swap gas');
  await h.tick(id);
  assert.deepEqual(h.state(id).levels, ['armed'], 'one level armed for N <= 3');
  h.setReserve(USDC, h.reserve(USDC) * 100n / 110n); // the token 10 % dearer
  await h.tick(id);
  const sale = h.state(id).pending!;
  assert.equal(sale.side, 'sell'); assert.equal(sale.floor, '106384180000000000000000', 'the sale floor is the full TP line'); assert.equal(sale.amount, s.bought);
  await h.tick(id);
  assert.ok(minOfCall(swaps(h).at(-1)!) >= 106384180000000000000000n);
  assert.equal(h.job(id).state, 'stopping'); assert.equal(h.state(id).done?.kind, 'tp');
  assert.equal(h.state(id).gasSell, SALE_GAS.toString()); assert.equal(BigInt(h.state(id).spent) + BigInt(h.state(id).gasBuy), near('0.101812'), 'sale gas stays outside K');
  const view = (await h.request(path)).data as { trade: { done: { kind: string }; buys: { side: string; verdict: string }[] } };
  assert.equal(view.trade.done.kind, 'tp'); assert.deepEqual(view.trade.buys.map(b => `${b.side}:${b.verdict}`), ['sell:swapped', 'buy:swapped', 'buy:success']);
  assert.ok(BigInt(h.state(id).proceeds) > BigInt(h.state(id).spent), 'the sale returned more NEAR than the buy spent');
  await until(h, id, () => h.job(id).state === 'stopped');
  assert.ok(h.ownerBal.native! > h.deposit - near('0.02'), 'the owner received the NEAR');
  assert.equal(h.bal[USDC], 0n);
});

test('15.7 DCA arming: one level for N <= 3, two for N >= 4', async t => {
  for (const [levels, armed] of [[3, 1], [4, 2]] as const) {
    const h = setup(t, { kind: 'dca', trade: { ...DCA, levels } }), { id } = await h.run();
    h.history(); await buy(h, id); await h.tick(id);
    assert.equal(h.state(id).levels.filter(l => l === 'armed').length, armed, `N = ${levels}`);
    assert.deepEqual(h.state(id).levels.slice(0, armed), Array(armed).fill('armed'), 'the shallowest levels first');
  }
});

test('15.7 DCA gap vector: N = 8 arms two levels, a 10.5 % gap fills L1 and L2 one per evaluation, skips L3 to L6, arms L7 then L8', async t => {
  const h = setup(t, { kind: 'dca', trade: { ...DCA, levels: 8 } }), { id } = await h.run();
  h.history(); await buy(h, id); await h.tick(id);
  assert.deepEqual(h.state(id).levels, ['armed', 'armed', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting']);
  h.setReserve(USDC, h.reserve(USDC) * 1000n / 895n);
  await h.tick(id);
  assert.equal(h.state(id).pending?.level, 1, 'one fire per evaluation, the shallowest');
  await until(h, id, () => h.state(id).levels[0] === 'filled');
  await h.tick(id);
  assert.deepEqual(h.state(id).levels, ['filled', 'armed', 'skipped', 'skipped', 'skipped', 'skipped', 'armed', 'waiting']);
  assert.equal(h.state(id).pending?.level, 2);
  await until(h, id, () => h.state(id).levels[1] === 'filled');
  await h.tick(id);
  assert.deepEqual(h.state(id).levels, ['filled', 'filled', 'skipped', 'skipped', 'skipped', 'skipped', 'armed', 'armed']);
  assert.equal(h.state(id).pending, null); assert.equal(h.state(id).fills, 3, 'the gap bought 2 levels, not 6');
});

test('15.7 DCA TP refusals: wallet below H ends tp-short, a position at the sale cap ends tp-cap after hire drift and after a gap fill, TP comes before levels', async t => {
  const short = setup(t, { kind: 'dca' }), s = await short.run();
  short.history(); await buy(short, s.id);
  const H = BigInt(short.state(s.id).bought);
  short.bal[USDC] = H / 2n; short.bump();
  short.setReserve(USDC, short.reserve(USDC) * 100n / 110n);
  const before = swaps(short).length, ended = (h: Harness, id: string) => h.worker.openAlerts(id).find(a => a.kind === 'trade_done')?.detail.message ?? '';
  await short.tick(s.id);
  assert.equal(short.state(s.id).done?.kind, 'tp-short'); assert.equal(swaps(short).length, before, 'no swap and no rebased floor');
  assert.match(short.job(s.id).reason!, /holds less of the token/);
  await until(short, s.id, () => short.job(s.id).state === 'stopped');
  assert.equal(swaps(short).length, before); assert.equal(short.ownerBal[USDC], H / 2n, 'the token left goes to the owner');
  // Hire-to-base drift: the token is 1000 times cheaper at the base fill than at the hire quote.
  const drift = setup(t, { kind: 'dca' }), dr = await drift.run();
  drift.setReserve(USDC, drift.reserve(USDC) * 1000n); drift.history(); await buy(drift, dr.id);
  assert.ok(BigInt(drift.state(dr.id).bought) >= drift.job(dr.id).caps!.tokenPerTx[USDC]! - 1n);
  drift.setReserve(USDC, drift.reserve(USDC) * 100n / 110n);
  const n = swaps(drift).length;
  await drift.tick(dr.id);
  assert.equal(drift.state(dr.id).done?.kind, 'tp-cap'); assert.equal(swaps(drift).length, n);
  assert.match(ended(drift, dr.id), /larger than one sale may carry/);
  // A favourable gap fill far below the deepest level, then a partial recovery.
  const gap = setup(t, { kind: 'dca' }), g = await gap.run();
  gap.history(); await buy(gap, g.id); await gap.tick(g.id);
  gap.setReserve(USDC, gap.reserve(USDC) * 1000n);
  await until(gap, g.id, () => gap.state(g.id).levels[0] === 'filled');
  gap.setReserve(USDC, gap.reserve(USDC) / 10n);
  const m = swaps(gap).length;
  await gap.tick(g.id);
  assert.equal(gap.state(g.id).done?.kind, 'tp-cap'); assert.equal(swaps(gap).length, m);
  assert.ok(BigInt(gap.state(g.id).bought) >= gap.job(g.id).caps!.tokenPerTx[USDC]! - 1n, 'the gap fill alone exceeded the sale cap');
  // TP before levels: a crossed armed level and a reached take profit plan the sale.
  const order = setup(t, { kind: 'dca' }), o = await order.run();
  order.history(); await buy(order, o.id); await order.tick(o.id);
  const held = BigInt(order.state(o.id).bought) * 3n;
  order.bal[USDC] = held; order.bump();
  order.inject(o.id, { bought: held.toString(), p0: { num: near('1').toString(), den: '1' } });
  await order.tick(o.id);
  assert.equal(order.state(o.id).pending?.side, 'sell', 'the take profit is planned before the crossed level');
});

test('15.7 DCA TP-fit end: proceeds that could never fit the signed daily limit end tp-cap without a swap', async t => {
  const h = setup(t, { kind: 'dca' }), { id } = await h.run();
  h.history(); await buy(h, id);
  h.setReserve(USDC, h.reserve(USDC) / 25n); // the position is now worth about 2.5 NEAR against a 1.8 NEAR daily cap
  const n = swaps(h).length;
  await h.tick(id);
  assert.equal(h.state(id).done?.kind, 'tp-cap'); assert.equal(swaps(h).length, n);
  assert.match(h.job(id).reason!, /exceed the signed daily limit/);
  assert.ok(BigInt(h.state(id).done!.value!) > near('1.8') - near('0.6'), 'the quote could never fit an empty window');
});

test('15.7 DCA stop loss: entry guard, confirmation after 5 minutes at a later block, reset, failed read, 30-minute gap, discard after resume', async t => {
  const sl = { ...DCA, slBps: 1000 };
  const g = setup(t, { kind: 'dca', trade: sl }), gi = await g.run();
  for (let i = 0; i < 7; i++) { await g.tick(gi.id); assert.equal(g.state(gi.id).protect, null, 'collecting history'); }
  g.history(); await g.tick(gi.id);
  assert.equal(g.state(gi.id).pending?.kind, 'wrap');
  await g.tick(gi.id); assert.equal(g.state(gi.id).protect, null, 'a pending base wrap holds wNEAR, nothing bought');
  g.setMode('refund'); await g.tick(gi.id); g.setMode('normal');
  for (let i = 0; i < 7; i++) { await g.tick(gi.id); assert.equal(g.state(gi.id).protect, null, 'after a refunded base swap'); }
  assert.equal(g.job(gi.id).state, 'running');

  const h = setup(t, { kind: 'dca', trade: sl }), { id } = await h.run();
  h.history(); await buy(h, id); await h.tick(id);
  const fall = () => h.setReserve(USDC, h.reserve(USDC) * 100n / 85n), rise = () => h.setReserve(USDC, h.reserve(USDC) * 85n / 100n);
  fall(); await h.tick(id);
  const first = h.state(id).protect!;
  assert.ok(first); assert.equal(h.job(id).state, 'running');
  h.setPoolReadable(false); h.skip(4 * MIN); await advanceJob(h.d, id);
  assert.equal(h.job(id).reason, 'Finalized chain data is unavailable.');
  assert.deepEqual(h.state(id).protect, first, 'a failed read neither confirms nor resets');
  h.setPoolReadable(true);
  rise(); await h.tick(id); assert.equal(h.state(id).protect, null, 'a non-breach resets');
  fall(); await h.tick(id);
  const again = h.state(id).protect!;
  h.skip(31 * MIN); await advanceJob(h.d, id);
  assert.ok(h.state(id).protect!.since > again.since, 'more than 30 minutes resets to a new first breach');
  await h.resume(id);
  h.skip(5 * MIN); h.bump(); await advanceJob(h.d, id);
  assert.equal(h.job(id).state, 'running', 'an observation from before the resume never confirms');
  assert.ok(h.state(id).protect!.since >= Number(h.worker.meta(`trade_running_since:${id}`)));
  const swapsBefore = swaps(h).length;
  h.skip(5 * MIN); await advanceJob(h.d, id);
  assert.equal(h.job(id).state, 'running', 'a breach five minutes later at the same block does not confirm');
  h.skip(MIN); h.bump(); await advanceJob(h.d, id);
  assert.equal(h.job(id).state, 'stopping'); assert.equal(h.state(id).done?.kind, 'sl');
  assert.equal(swaps(h).length, swapsBefore, 'a stop loss does not sell');
  await until(h, id, () => h.job(id).state === 'stopped');
  assert.ok(h.ownerBal[USDC]! > 0n, 'the owner receives the token');
});

test('15.7 DCA all levels filled, then take profit on the whole position', async t => {
  const h = setup(t, { kind: 'dca' }), { id } = await h.run();
  h.history(); await buy(h, id); await h.tick(id);
  h.setReserve(USDC, h.reserve(USDC) * 100n / 98n);
  await until(h, id, () => h.state(id).levels[0] === 'filled');
  await h.tick(id);
  assert.match(h.job(id).reason!, /take profit, stop loss or the planned end/);
  h.setReserve(USDC, h.reserve(USDC) * 100n / 112n);
  await h.tick(id);
  assert.equal(h.state(id).pending?.amount, h.state(id).bought);
  await h.tick(id);
  assert.equal(h.state(id).done?.kind, 'tp');
});

test('15.7b tick order: a wrap settled 1 s before the end never journals its swap; stop loss drops a row-less swap; the life end needs no pool', async t => {
  const h = setup(t), { id } = await h.run(), endsAt = testNow + 6 * 86_400_000;
  h.at(endsAt - 3_000); h.history(); await advanceJob(h.d, id);
  h.at(endsAt - 1_000); await advanceJob(h.d, id);
  assert.equal(h.state(id).pending?.kind, 'swap');
  h.at(endsAt);
  await assert.rejects(createLiveOps({ ...h.d, jobId: id }).swap({ pin: h.pair.pin, tokenIn: WNEAR, tokenOut: USDC, amountIn: near('0.1'), slippageBps: 50, unwrapNear: false, floor: BigInt(h.state(id).pending!.floor!) }), /planned end/);
  assert.equal(rows(h, id, 'swap').length, 0, 'the T-9 re-check refused it before any row');
  h.setPoolReadable(false);
  await advanceJob(h.d, id);
  assert.equal(h.state(id).done?.kind, 'life'); assert.equal(h.state(id).pending, null);
  await until(h, id, () => h.job(id).state === 'stopped');
  assert.equal(h.bal[WNEAR], 0n, 'the wNEAR went out at exit');

  const dca = setup(t, { kind: 'dca', trade: { ...DCA, slBps: 1000 } }), d = await dca.run();
  dca.history(); await buy(dca, d.id); await dca.tick(d.id);
  dca.setReserve(USDC, dca.reserve(USDC) * 100n / 85n);
  await dca.tick(d.id); // first breach; the crossed level is planned
  await dca.tick(d.id); // its wrap
  assert.equal(dca.state(d.id).pending?.kind, 'swap');
  dca.skip(5 * MIN); dca.bump(); await advanceJob(dca.d, d.id);
  assert.equal(dca.state(d.id).done?.kind, 'sl'); assert.equal(dca.state(d.id).pending, null);
  assert.equal(rows(dca, d.id, 'swap').length, 1, 'only the base swap was journaled');
  await until(dca, d.id, () => dca.job(d.id).state === 'stopped');
  assert.equal(dca.bal[WNEAR], 0n);

  const fee = setup(t, { kind: 'dca' }), f = await fee.run();
  fee.setFee(25);
  await fee.tick(f.id);
  assert.match(fee.job(f.id).reason!, /does not match its pin\. Pool fee changed\./);
  fee.at(testNow + 6 * 86_400_000); await advanceJob(fee.d, f.id);
  assert.equal(fee.state(f.id).done?.kind, 'life', 'a changed pool never keeps an expired job running');
  await until(fee, f.id, () => fee.job(f.id).state === 'stopped');
});

test('15.7b crashes: after insertOp the row is waited for and never re-planned; after settlement the finished row is applied once', async t => {
  const h = setup(t), { id } = await h.run();
  h.history(); await h.tick(id);
  const p = h.state(id).pending!;
  assert.ok(h.worker.insertOp(opRow(h.job(id), { kind: 'wrap', request: json({ receiver: WNEAR, method: 'near_deposit', args: {}, deposit: p.amount, step: p.id }) })));
  const calls = h.calls.length;
  h.skip(200_000); await advanceJob(h.d, id); await advanceJob(h.d, id);
  // Step 1 itself, below the worker's in-flight gate: an unfinished row is waited for, even past the 120 s stale age.
  await tickTrade(h.d, h.job(id), createLiveOps({ ...h.d, jobId: id }));
  assert.equal(h.calls.length, calls); assert.deepEqual(h.state(id).pending, p, 'the step waits for its row and is never planned again');
  const r = setup(t), rr = await r.run();
  r.history(); await r.tick(rr.id);
  // The worker submitted and settled the wrap, then stopped before applying it.
  assert.equal((await createLiveOps({ ...r.d, jobId: rr.id }).wrap(near('0.1'))).verdict, 'success');
  assert.equal(r.state(rr.id).wnear, '0');
  await advanceJob(r.d, rr.id); await advanceJob(r.d, rr.id);
  assert.equal(r.state(rr.id).fills, 1); assert.equal(r.state(rr.id).wnear, '0'); assert.equal(r.state(rr.id).spent, near('0.1').toString());
  assert.equal(rows(r, rr.id, 'wrap').length, 1, 'the finished wrap was applied once');
  // A failed DCA pool read: no submission that tick.
  const d = setup(t, { kind: 'dca' }), dd = await d.run();
  d.history(); await d.tick(dd.id);
  d.setPoolReadable(false);
  const n = d.calls.length;
  d.skip(60_000); await advanceJob(d.d, dd.id); // past the 60 s sample, so the tick needs a read
  assert.equal(d.job(dd.id).reason, 'Finalized chain data is unavailable.');
  assert.equal(d.calls.length, n); assert.equal(d.state(dd.id).pending?.kind, 'wrap');
});

test('15.8 receipts: partial resolve and a rerouted omft payout are unclear and halt; three failures halt; a lost reply quarantines after its same-key re-sends and the tick never re-sends', async t => {
  assert.equal(provenEffects(parseTxStatus(fixture('tx-1.27-swap-out-native')), 'swap', { receiver: USDC, method: 'ft_transfer_call',
    args: { receiver_id: EX, amount: '56478', msg: JSON.stringify({ force: 0, skip_unwrap_near: false, actions: [{ token_in: USDC, token_out: WNEAR, amount_in: '56478', min_amount_out: '14745359004404509269622', pool_id: 4512 }] }) },
    deposit: '1', swap: { tokenOut: WNEAR, amountIn: '56478', minOut: '14745359004404509269622', unwrapNear: true } }, { agent, owner, tokens: [USDC], dclKinds: [] })?.nativeIn, 14894302024651019464265n);
  for (const [pair, mode] of [['trade-rhea', 'partial'], ['trade-zec', 'omft']] as const) {
    const h = setup(t, { pair }), { id } = await h.run();
    h.history(); await h.tick(id); await h.tick(id);
    h.setMode(mode); await h.tick(id);
    assert.equal(rows(h, id, 'swap')[0]!.verdict, 'unclear', mode); assert.equal(h.job(id).state, 'halted', mode);
    assert.ok(h.worker.openAlerts(id).some(a => a.kind === 'op_unclear'));
  }
  const f = setup(t, { pair: 'trade-zec' }), fi = await f.run();
  f.history(); await f.tick(fi.id); await f.tick(fi.id);
  f.setMode('refund');
  for (let i = 0; i < 3; i++) { await f.tick(fi.id); f.skip(5 * MIN); f.history(); if (i < 2) await f.tick(fi.id); }
  assert.equal(f.state(fi.id).failures, 3); assert.equal(f.job(fi.id).state, 'halted'); assert.equal(f.job(fi.id).reason, 'Three trade steps in a row failed. Stop and withdraw.');
  const l = setup(t, { pair: 'trade-rhea' }), li = await l.run();
  l.history(); await l.tick(li.id); await l.tick(li.id);
  // Fix 4: the submission re-sends under its own key (5, 15, 30 s, skipped here) before it quarantines.
  Object.assign(l.d, { wait: async () => {} });
  l.setMode('ambiguous'); await l.tick(li.id); l.setMode('normal');
  const p = l.state(li.id).pending!, row = l.worker.gridStep(li.id, p.id)!;
  assert.equal(row.state, 'ambiguous'); assert.equal(l.job(li.id).state, 'halted');
  const n = l.calls.length;
  await l.tick(li.id); await l.tick(li.id);
  assert.equal(l.calls.length, n, 'no re-send from the strategy tick');
  // Even once the row is closed, the same step id is never journaled again.
  assert.ok(l.worker.updateOp(row.id, { state: 'finished', verdict: 'unknown' }));
  assert.equal(l.worker.insertOp(opRow(l.job(li.id), { kind: 'swap', state: 'finished', request: json({ step: p.id }) })), false, 'the same step id is never journaled twice');
});

test('15.8 quota and frozen re-issue the same step with a new id; a wallet inflow never changes the ledger; the owner token is never sold', async t => {
  const h = setup(t, { kind: 'dca' }), { id } = await h.run();
  h.history(); await h.tick(id);
  const p = h.state(id).pending!;
  h.setMode('quota'); await h.tick(id); h.setMode('normal');
  const q = h.state(id).pending!;
  assert.notEqual(q.id, p.id); assert.deepEqual({ ...q, id: p.id }, p, 'quota re-issues the same step');
  h.skip(2_000); await h.tick(id);
  assert.equal(h.state(id).pending?.kind, 'swap');
  h.setMode('frozen'); await h.tick(id); h.setMode('normal');
  assert.equal(h.job(id).state, 'frozen');
  const frozenRow = rows(h, id, 'swap')[0]!;
  assert.equal(frozenRow.verdict, 'frozen');
  h.freezePolicy(true); await h.tick(id); h.freezePolicy(false); await h.tick(id);
  const ch = (await h.request(`/api/challenge?purpose=resume&job=${id}`)).data as Challenge;
  assert.equal((await h.request(`/api/jobs/${id}/resume`, { signed: identity()(ch) })).status, 200);
  await until(h, id, () => h.job(id).state === 'running');
  await advanceJob(h.d, id);
  assert.notEqual(h.state(id).pending?.id, JSON.parse(frozenRow.request).step, 'the frozen step is re-issued with a new id');
  h.history(); await buy(h, id);
  const bought = h.state(id).bought;
  h.bal[USDC] = h.bal[USDC]! + 777n; h.bump();
  await h.tick(id); await h.tick(id);
  assert.equal(h.state(id).bought, bought, 'a wallet inflow does not change bought');
  h.setReserve(USDC, h.reserve(USDC) * 100n / 110n);
  await h.tick(id);
  assert.equal(h.state(id).pending?.amount, bought, 'the sale is of H only');
  await h.tick(id);
  await until(h, id, () => h.job(id).state === 'stopped');
  assert.equal(h.ownerBal[USDC], 777n, 'the token the owner added goes back at exit');
});

test('15.9 ends are atomic with one trade_done alert; a frozen wallet waits; tradeStop refuses a stale or journaled state', async t => {
  const h = setup(t), { id } = await h.run();
  h.history(); await h.tick(id); await h.tick(id);
  const s = h.state(id), job = h.job(id);
  assert.equal(h.worker.tradeStop(job, { ...s, fills: 9 }, { ...s, pending: null, done: { kind: 'life', at: h.now() } }, 'x'), false, 'a state that changed');
  assert.equal(h.worker.tradeStop(job, s, { ...s, done: { kind: 'life', at: h.now() } }, 'x'), false, 'a pending step must be dropped');
  assert.equal(h.worker.tradeStop(job, s, { ...s, pending: null, done: null }, 'x'), false);
  h.inject(id, { pending: { ...s.pending!, id: JSON.parse(rows(h, id, 'wrap')[0]!.request).step } });
  const journaled = h.state(id);
  assert.equal(h.worker.tradeStop(job, journaled, { ...journaled, pending: null, done: { kind: 'life', at: h.now() } }, 'x'), false, 'a journaled step is never dropped');
  h.inject(id, { pending: s.pending });
  // A settled buy swap is journaled too: neither a clock end nor a take profit may drop it (only a settled sale ends as tp).
  const other = setup(t), o = await other.run();
  other.history(); await buy(other, o.id);
  const swapRow = rows(other, o.id, 'swap')[0]!;
  other.inject(o.id, { pending: { id: JSON.parse(swapRow.request).step, kind: 'swap', side: 'buy', amount: near('0.1').toString(), floor: '1', plannedAt: other.now() } });
  const withRow = other.state(o.id);
  for (const kind of ['life', 'tp'] as const) assert.equal(other.worker.tradeStop(other.job(o.id), withRow, { ...withRow, pending: null, done: { kind, at: other.now() } }, 'x'), false, kind);
  assert.equal(h.worker.tradeStop(job, s, { ...s, pending: null, sequence: s.sequence + 1, done: { kind: 'life', at: h.now() } }, 'Ends.'), true);
  assert.equal(h.worker.tradeStop(h.job(id), h.state(id), { ...h.state(id), done: { kind: 'life', at: h.now() } }, 'Again.'), false);
  assert.equal(h.job(id).state, 'stopping'); assert.equal(h.worker.openAlerts(id).filter(a => a.kind === 'trade_done').length, 1);
  h.freezePolicy(true); await h.tick(id);
  assert.equal(h.job(id).reason, 'Unfreeze to withdraw.');
  h.freezePolicy(false);
  await until(h, id, () => h.job(id).state === 'stopped');
  assert.equal(h.bal[WNEAR], 0n, 'the wrapped NEAR of the dropped buy was unwrapped and paid out');
  assert.ok(h.native - STORAGE <= MONEY.sweepReserve);
});

test('15.9b funding and cancellation: a funded trade job cannot cancel, early stop pays the owner, and both flags gate only new work', async t => {
  for (const amount of ['partial', 'full'] as const) {
    const h = setup(t), { id, path } = await h.hire();
    h.setNative(amount === 'partial' ? h.deposit / 2n : h.deposit); h.bump();
    assert.equal((await h.request(`${path}/cancel`, {})).status, 409, `${amount} funding cannot cancel`);
    assert.equal(((await h.request(path)).data as { canStopEarly: boolean }).canStopEarly, true);
    assert.equal((await h.request(`${path}/stop`, {})).status, 200);
    await until(h, id, () => h.job(id).state === 'stopped');
    assert.ok(h.ownerBal.native! > 0n);
  }
  const web = setup(t), w = await web.hire();
  assert.equal(((await web.request(w.path)).data as { canFund: boolean }).canFund, true);
  web.setWebTrade(false);
  assert.equal(((await web.request(w.path)).data as { canFund: boolean }).canFund, false, 'web flag off: no funding');
  const worker = setup(t), wk = await worker.hire();
  worker.d.tradeV1 = false;
  worker.setNative(worker.deposit); worker.bump();
  await worker.tick(wk.id); await worker.tick(wk.id);
  assert.equal(worker.job(wk.id).state, 'link_confirmed'); assert.equal(worker.job(wk.id).reason, 'Trade is disabled. Do not fund this job.');
  assert.equal((await worker.request(`${wk.path}/stop`, {})).status, 200);
  await until(worker, wk.id, () => worker.job(wk.id).state === 'stopped');
  const both = setup(t), b = await both.run();
  both.history(); await buy(both, b.id);
  both.setWebTrade(false); both.d.tradeV1 = false;
  both.at(both.state(b.id).anchor! + HOUR); await advanceJob(both.d, b.id);
  assert.equal(both.job(b.id).reason, 'Trade is disabled. An owner can still freeze or stop and withdraw.');
  assert.equal((await both.request(`${b.path}/stop`, {})).status, 200);
  await until(both, b.id, () => both.job(b.id).state === 'stopped');
  assert.equal(both.ownerBal[USDC], BigInt(both.state(b.id).bought));
});

test('15.10 isolation: the store, config and pure trade modules never reach the strategy, ops or OutLayer; trade.ts imports no AI module', () => {
  const graph = (root: string) => {
    const seen = new Set<string>();
    const walk = (path: string) => {
      if (seen.has(path)) return; seen.add(path);
      for (const m of readFileSync(path, 'utf8').matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const spec = m[1] ?? m[2] ?? m[3]!;
        if (spec.startsWith('.')) walk(resolve(dirname(path), spec));
      }
    };
    walk(resolve('dist/src/core', root));
    return [...seen].map(p => p.split(sep).at(-1)!);
  };
  for (const root of ['store.js', 'config.js', 'trade-settings.js', 'trade-pairs.js']) {
    assert.deepEqual(graph(root).filter(n => ['trade.js', 'ops.js', 'outlayer.js'].includes(n)), [], root);
  }
  assert.ok(graph('store.js').includes('trade-settings.js'), 'the walk followed the graph');
  for (const root of ['trade-settings.js', 'trade-pairs.js']) assert.deepEqual(graph(root).filter(n => !['amounts.js', 'errors.js', 'pins.js', root].includes(n)), [], root);
  const direct = [...readFileSync('src/core/trade.ts', 'utf8').matchAll(/from\s*'([^']+)'/g)].map(m => m[1]);
  assert.ok(direct.includes('./ops.js'));
  assert.deepEqual(direct.filter(s => s === './near-ai.js' || s === './lp-ai.js'), []);
  assert.ok(readdirSync('dist/src/core').includes('trade.js'));
});

test('15.10 watchdog: reads the job token, stays quiet through a RHEA buy and flags an ft_transfer of the token to a third account', async t => {
  const h = setup(t, { pair: 'trade-rhea' }), { id } = await h.run();
  const pass = async () => { h.bump(); return (await watchOnce({ store: h.watch, rpc: h.rpc, now: h.now })).filter(a => a.severity !== 'info').map(a => a.kind); };
  assert.deepEqual(await pass(), []);
  h.history(); await buy(h, id);
  assert.deepEqual(await pass(), [], 'the wrap and the swap on 6458 are trade actions the watchdog accepts');
  const watched = JSON.parse(h.watch.getWatch(id)!.holdings) as { tokens: Record<string, string> };
  assert.deepEqual(Object.keys(watched.tokens).sort(), [RHEA, WNEAR].sort());
  const theft: CallRequest = { receiverId: RHEA, methodName: 'ft_transfer', args: { receiver_id: 'thief.near', amount: '5' }, gas: 30_000_000_000_000n, deposit: 1n };
  const hash = `theft-${h.height()}`;
  const tx = txOf(rootOf(theft), [], ok(), OP_GAS);
  record(tx.transaction)!.hash = hash;
  const blockFirst = h.height() + 1;
  const outcomes = [tx.transaction_outcome, ...(tx.receipts_outcome as unknown[])];
  for (const [i, o] of outcomes.entries()) record(o)!.block_hash = `${hash}-${i}`;
  const realBlock = h.rpc.blockHeight!, realTx = h.rpc.txStatus;
  h.rpc.blockHeight = async b => b.startsWith(hash) ? blockFirst + Number(b.split('-').at(-1)) : realBlock(b);
  h.rpc.txStatus = async x => x === hash ? tx : realTx(x, agent);
  h.bal[RHEA] = h.bal[RHEA]! - 5n;
  for (let i = 0; i < 5; i++) h.bump();
  assert.ok(h.worker.insertOp(opRow(h.job(id), { kind: 'transfer_token_owner', purpose: 'exit', state: 'finished', verdict: 'success', txHash: hash, finishedBlock: blockFirst + 1,
    request: json({ receiver: RHEA, method: 'ft_transfer', args: theft.args, deposit: '1' }) })));
  const alerts = await pass();
  assert.ok(alerts.includes('bad_recipient'), alerts.join());
});

test('15.10 view: before the policy is prepared endsAt is null and the ledger is zero; the job page shows the trade block for a RHEA job', async t => {
  const h = setup(t, { pair: 'trade-rhea' });
  const start = await h.request('/api/jobs', { kind: 'schedule', mode: 'live', pair: 'trade-rhea', depositYocto: h.deposit.toString(), trade: SCHEDULE });
  const { id } = start.data as { id: string };
  const v = (await h.request(`/api/jobs/${id}`)).data as { trade: ReturnType<typeof tradeView> };
  assert.equal(v.trade!.endsAt, null); assert.deepEqual(v.trade!.ledger, { spent: '0', bought: '0', sold: '0', proceeds: '0', gasBuy: '0', gasSell: '0', wnear: '0' });
  assert.deepEqual(v.trade!.schedule, { anchor: null, currentSlot: null, currentSlotTaken: false, fills: 0, postponed: 0, nextDueAt: null, remaining: near('0.2').toString() });
  assert.deepEqual(v.trade!.pair, { id: 'trade-rhea', symbol: 'RHEA', token: RHEA, decimals: 18, poolId: 6458, feeBps: 30 });
  assert.equal(v.trade!.avgCost, null); assert.equal(v.trade!.value, null); assert.equal(v.trade!.pnl, null); assert.deepEqual(v.trade!.buys, []);
  const options = (await h.request('/api/hire/options')).data as { trade: { enabled: boolean; pairs: { id: string; spot: { num: string; den: string } | null }[]; bounds: { dca: { maxStepBps: number[] } } } };
  assert.equal(options.trade.enabled, true);
  assert.deepEqual(options.trade.pairs.map(p => [p.id, p.spot?.num]), [['trade-usdc', String(261_368n * N)], ['trade-rhea', '112376915111888666470198909136'], ['trade-zec', '30027621100680611870775004061']]);
  assert.deepEqual(options.trade.bounds.dca.maxStepBps, [3000, 3000, 2450, 1650, 1200, 900, 650, 500]);
});

// ---------------------------------------------------------------------------------------------------------------------
// AUDIT 2026-11-11, probes for mutation survivors. Each test PASSES on the audited build and fails on the named mutants.
// Paste at the end of test/trade.test.ts (it uses that file's harness) together with the two import lines below.
// ---------------------------------------------------------------------------------------------------------------------

test('AUDIT S-1 (M03): endsAt is one hour before valid_until when that binds first, else created + 6 days, else null', () => {
  const at = (validUntil: number | null) => auditTradeEndsAt({ createdAt: testNow, payload: validUntil === null ? null : { args: { valid_until: validUntil } } } as unknown as Pick<Job, 'createdAt' | 'payload'>);
  const soon = Math.floor(testNow / 1000) + 3 * 86_400;
  assert.equal(at(soon), soon * 1000 - 3_600_000, 'AD-4: valid_until x 1000 - 1 hour');
  assert.equal(at(Math.floor(testNow / 1000) + 30 * 86_400), testNow + 6 * 86_400_000);
  assert.equal(at(null), null);
});

test('AUDIT S-2 (M05): the take-profit line rounds up', () => {
  // (1 + 3e21) x 10150 / 10000 = 3.045e21 + 1.015, so the ceiling is + 2.
  assert.equal(tpLine(1n, 150), 3_045_000_000_000_000_000_002n);
});

test('AUDIT S-3 (M20, M21, M22): ops.run holds a trade submission to the pending step: amount, floor and direction', async t => {
  const h = setup(t), { id } = await h.run();
  const ops = () => createLiveOps({ ...h.d, jobId: id });
  h.history(); await h.tick(id);
  assert.equal(h.state(id).pending?.kind, 'wrap');
  await assert.rejects(ops().wrap(near('0.09')), /trade step changed/, 'a wrap of another amount');
  assert.equal(rows(h, id).length, 0);
  await h.tick(id);
  const p = h.state(id).pending!;
  assert.equal(p.kind, 'swap');
  const swap = { pin: h.pair.pin, tokenIn: WNEAR, tokenOut: USDC, amountIn: near('0.1'), slippageBps: 50, unwrapNear: false, floor: BigInt(p.floor!) };
  await assert.rejects(ops().swap({ ...swap, amountIn: near('0.15') }), /trade step changed/, 'a swap of another amount');
  await assert.rejects(ops().swap({ ...swap, floor: 1n }), /trade step changed/, 'a swap with a weaker floor than the planned one');
  await assert.rejects(ops().swap({ pin: h.pair.pin, tokenIn: USDC, tokenOut: WNEAR, amountIn: near('0.1'), slippageBps: 50, unwrapNear: true, floor: BigInt(p.floor!) }), /trade step changed/, 'a sale while the pending step is a buy');
  assert.equal(rows(h, id, 'swap').length, 0, 'none of them reached the journal');
  assert.deepEqual(h.state(id).pending, p);
  await h.tick(id);
  assert.equal(h.state(id).fills, 1, 'the planned swap itself still goes out');
});

test('AUDIT S-4 (M23, M24, M25, M27, M27b): a finished row whose proof does not match its step halts the job and changes no ledger entry', async t => {
  const finish = (h: Harness, id: string, patch: Partial<AuditOpRow>, request: object) =>
    assert.ok(h.worker.insertOp(opRow(h.job(id), { state: 'finished', finishedAt: h.now(), ...patch, request: json({ ...request, step: h.state(id).pending!.id }) })));
  const halted = async (h: Harness, id: string, what: string) => {
    const before = h.state(id);
    await h.tick(id);
    assert.equal(h.job(id).state, 'halted', what); assert.match(h.job(id).reason!, /did not settle as expected/, what);
    const { spent, bought, sold, proceeds, wnear, fills, done } = h.state(id);
    assert.deepEqual({ spent, bought, sold, proceeds, wnear, fills, done }, { spent: before.spent, bought: before.bought, sold: before.sold, proceeds: before.proceeds, wnear: before.wnear, fills: before.fills, done: null }, what);
  };
  const wrapRequest = { receiver: WNEAR, method: 'near_deposit', args: {}, deposit: near('0.1').toString() };
  const buyRequest = { receiver: WNEAR, method: 'ft_transfer_call', args: { receiver_id: EX, amount: near('0.1').toString() }, deposit: '1', swap: { tokenOut: USDC, amountIn: near('0.1').toString(), minOut: '1', unwrapNear: false } };

  const w = setup(t), wi = await w.run();
  w.history(); await w.tick(wi.id);
  finish(w, wi.id, { kind: 'wrap', verdict: 'success', after: json({ effects: {} }) }, wrapRequest);
  await halted(w, wi.id, 'a wrap without the proven wNEAR effect');

  for (const [what, patch] of [
    ['a buy whose used amount is not the whole input', { used: near('0.05'), after: json({ effects: { [USDC]: '1000' } }) }],
    ['a buy with no proven token output', { used: near('0.1'), after: json({ effects: {} }) }]] as const) {
    const b = setup(t), bi = await b.run();
    b.history(); await b.tick(bi.id); await b.tick(bi.id);
    assert.equal(b.state(bi.id).pending?.kind, 'swap');
    finish(b, bi.id, { kind: 'swap', verdict: 'swapped', ...patch }, buyRequest);
    await halted(b, bi.id, what);
  }

  for (const [what, patch] of [
    ['a sale with no native proceeds', (amount: bigint) => ({ used: amount, nativeIn: 0n })],
    ['a sale whose used amount is not the whole position', (amount: bigint) => ({ used: amount / 2n, nativeIn: near('0.2') })]] as const) {
    const s = setup(t, { kind: 'dca' }), si = await s.run();
    s.history(); await buy(s, si.id); await s.tick(si.id);
    s.setReserve(USDC, s.reserve(USDC) * 100n / 110n);
    await s.tick(si.id);
    const p = s.state(si.id).pending!;
    assert.equal(p.side, 'sell');
    finish(s, si.id, { kind: 'swap', verdict: 'swapped', ...patch(BigInt(p.amount)) },
      { receiver: USDC, method: 'ft_transfer_call', args: { receiver_id: EX, amount: p.amount }, deposit: '1', swap: { tokenOut: WNEAR, amountIn: p.amount, minOut: p.floor, unwrapNear: true } });
    await halted(s, si.id, what);
  }
});

test('AUDIT S-5 (M34, M36): a stop-loss breach confirms only from 5 minutes on, and one older than 30 minutes starts again', async t => {
  const start = async () => {
    const h = setup(t, { kind: 'dca', trade: { ...DCA, slBps: 1000 } }), { id } = await h.run();
    h.history(); await buy(h, id); await h.tick(id);
    h.inject(id, { levels: ['skipped'] }); // no level buy, so only the stop loss acts
    h.setReserve(USDC, h.reserve(USDC) * 100n / 85n);
    h.bump(); await h.tick(id);
    assert.ok(h.state(id).protect, 'first breach');
    return { h, id, first: h.state(id).protect! };
  };
  const a = await start();
  for (let i = 0; i < 4; i++) {
    a.h.bump(); await a.h.tick(a.id);
    assert.equal(a.h.job(a.id).state, 'running', `a breach ${a.h.now() - a.first.since} ms after the first, at a later block, does not confirm`);
    assert.deepEqual(a.h.state(a.id).protect, a.first);
  }
  assert.ok(a.h.now() - a.first.since < 5 * MIN);
  a.h.bump(); await a.h.tick(a.id);
  assert.ok(a.h.now() - a.first.since >= 5 * MIN);
  assert.equal(a.h.state(a.id).done?.kind, 'sl', 'it confirms once 5 minutes have passed');

  const b = await start();
  b.h.skip(31 * MIN); b.h.bump(); await advanceJob(b.h.d, b.id);
  assert.equal(b.h.job(b.id).state, 'running', 'a breach more than 30 minutes after the first, at a later block, does not confirm');
  assert.ok(b.h.state(b.id).protect!.since > b.first.since, 'it starts a new first breach');
});

test('AUDIT S-6 (M39): with the stop loss off a position below its cost never starts a stop-loss observation and never ends the job', async t => {
  const h = setup(t, { kind: 'dca' }), { id } = await h.run(); // slBps 0
  h.history(); await buy(h, id); await h.tick(id);
  h.inject(id, { levels: ['skipped'] });
  h.setReserve(USDC, h.reserve(USDC) * 100n / 60n); // the token 40 % cheaper: far below any stop-loss line
  for (let i = 0; i < 8; i++) {
    h.bump(); await h.tick(id);
    assert.equal(h.state(id).protect, null); assert.equal(h.job(id).state, 'running');
  }
  assert.equal(h.state(id).done, null);
});

test('AUDIT S-7 (M44): a take profit on a position of exactly the sale cap, or one unit below it, ends tp-cap; two units below it is sold', async t => {
  for (const [under, kind] of [[0n, 'tp-cap'], [1n, 'tp-cap'], [2n, null]] as const) {
    const h = setup(t, { kind: 'dca' }), { id } = await h.run();
    h.history(); await buy(h, id); await h.tick(id);
    const size = h.job(id).caps!.tokenPerTx[USDC]! - under;
    // The token is 1000 times cheaper than at hire, so a cap-sized position is worth about 0.012 NEAR and passes TP-fit; the basis is tiny, so the line is reached.
    h.setReserve(USDC, h.reserve(USDC) * 1000n);
    h.bal[USDC] = size; h.bump();
    h.inject(id, { levels: ['skipped'], bought: size.toString(), spent: '1', gasBuy: '0' });
    const before = swaps(h).length;
    await h.tick(id);
    if (kind) {
      assert.equal(h.state(id).done?.kind, kind, `cap - ${under}`); assert.match(h.job(id).reason!, /larger than one sale may carry/);
      assert.equal(swaps(h).length, before); assert.equal(h.state(id).pending, null);
    } else {
      assert.equal(h.state(id).done, null); assert.equal(h.state(id).pending?.side, 'sell'); assert.equal(h.state(id).pending?.amount, size.toString());
    }
  }
});

test('AUDIT S-8 (M47, M48): a level buy carries the level need as its floor, and no level fires beyond the plan', async t => {
  const h = setup(t, { kind: 'dca' }), { id } = await h.run();
  h.history(); await buy(h, id); await h.tick(id);
  assert.deepEqual(h.state(id).levels, ['armed']);
  const p0 = { num: BigInt(h.state(id).p0!.num), den: BigInt(h.state(id).p0!.den) }, need = levelNeed(near('0.1'), p0, 1, 100);
  h.setReserve(USDC, h.reserve(USDC) * 1000n / 988n); // about 1.2 % cheaper: level 1 (1 % below P0) is just crossed
  await h.tick(id);
  const p = h.state(id).pending!;
  assert.equal(p.level, 1);
  assert.ok(h.ret(near('0.1')) * 9950n / 10_000n !== need, 'the two candidate floors differ in this vector');
  assert.equal(h.state(id).buy?.floor, need.toString(), 'T-3: the floor of a ladder buy is the level need, not 99.5 % of the quote');
  await h.tick(id); // the wrap
  assert.equal(h.state(id).pending?.kind, 'swap'); assert.equal(h.state(id).pending?.floor, need.toString());
  // A push back above the level between the wrap and the swap: the fresh quote is below the level need, although still within 0.5 % of the planning quote.
  const planned = h.ret(near('0.1'));
  h.setReserve(USDC, h.reserve(USDC) * 996n / 1000n);
  assert.ok(h.ret(near('0.1')) < need && h.ret(near('0.1')) >= planned * 9950n / 10_000n);
  await h.tick(id);
  assert.equal(h.job(id).reason, "The fresh quote is below the agent's limit.");
  assert.equal(rows(h, id, 'swap').length, 1, 'only the base swap was journaled');
  assert.deepEqual(h.state(id).levels, ['armed'], 'the level stays armed');

  // T-6: a ledger that already holds the whole plan plans no further level buy, even with an armed and crossed level.
  const g = setup(t, { kind: 'dca' }), gi = await g.run();
  g.history(); await buy(g, gi.id); await g.tick(gi.id);
  g.inject(gi.id, { spent: tradePlan(g.settings).toString() });
  g.setReserve(USDC, g.reserve(USDC) * 100n / 98n);
  await g.tick(gi.id);
  assert.equal(g.state(gi.id).pending, null, 'spent + order would exceed the plan');
});

test('AUDIT S-9 (O01, O02, O03, O04, S01, S02b): ops.run and insertOp each refuse a trade strategy operation on their own: flags, a blind watchdog, unreadable settings, a foreign step', async t => {
  const h = setup(t), { id } = await h.run(), amount = near('0.1');
  h.history(); await h.tick(id);
  const p = h.state(id).pending!;
  assert.equal(p.kind, 'wrap');
  // TF-1 at the operation itself, below the gate in afterArm.
  await assert.rejects(createLiveOps({ ...h.d, tradeV1: false, jobId: id }).wrap(amount), { code: 'live_disabled' }, 'worker trade flag off');
  await assert.rejects(createLiveOps({ ...h.d, live: false, jobId: id }).wrap(amount), { code: 'live_disabled' }, 'live worker off');
  // A blind watchdog: ops.run names it, and insertOp refuses the row by itself.
  const request = json({ receiver: WNEAR, method: 'near_deposit', args: {}, deposit: amount.toString(), step: p.id });
  h.watch.setMeta(`watch_blind:${id}`, '1');
  // Since the merge with master the shared read-wait gate (store.watchWaiting) refuses it, as for Grid and LP.
  await assert.rejects(createLiveOps({ ...h.d, jobId: id }).wrap(amount), /The watchdog has halted this job or is unavailable/);
  assert.equal(h.worker.insertOp(opRow(h.job(id), { kind: 'wrap', request }), { version: h.job(id).version, state: 'running', now: h.now() }), false, 'insertOp while blind');
  h.watch.setMeta(`watch_blind:${id}`, '0');
  // A step id that is not the pending one never gets a row.
  assert.equal(h.worker.insertOp(opRow(h.job(id), { kind: 'wrap', request: json({ receiver: WNEAR, method: 'near_deposit', args: {}, deposit: amount.toString(), step: `${p.id}x` }) })), false, 'a foreign step id');
  assert.equal(rows(h, id).length, 0, 'nothing reached the journal');
  assert.equal(h.worker.insertOp(opRow(h.job(id), { kind: 'wrap', request }), { version: h.job(id).version, state: 'running', now: h.now() }), true, 'the same row is accepted once the watchdog sees again');

  // TF-2 at the operation itself.
  const u = setup(t), ui = await u.run();
  u.history(); await u.tick(ui.id);
  const raw = new DatabaseSync(u.path);
  try { raw.prepare('UPDATE trade_jobs SET settings=? WHERE job_id=?').run('{"v":1,"strategy":"schedule"}', ui.id); } finally { raw.close(); }
  await assert.rejects(createLiveOps({ ...u.d, jobId: ui.id }).wrap(amount), /settings are unreadable/);
  assert.equal(rows(u, ui.id).length, 0);
});

test('AUDIT S-10 (O12, S04b): a sale must unwrap to native NEAR, and only a sale that settled swapped may end the job as tp', async t => {
  const h = setup(t, { kind: 'dca' }), { id } = await h.run();
  h.history(); await buy(h, id); await h.tick(id);
  h.setReserve(USDC, h.reserve(USDC) * 100n / 110n);
  await h.tick(id);
  const p = h.state(id).pending!;
  assert.equal(p.side, 'sell');
  // T-2: the token to wNEAR without the unwrap is not a trade shape.
  await assert.rejects(createLiveOps({ ...h.d, jobId: id }).swap({ pin: h.pair.pin, tokenIn: USDC, tokenOut: WNEAR, amountIn: BigInt(p.amount), slippageBps: 50, unwrapNear: false, floor: BigInt(p.floor!) }), { code: 'forbidden' });
  assert.equal(rows(h, id, 'swap').length, 1, 'only the base swap');
  // A journaled sale that was refunded is never dropped by a tp end.
  assert.ok(h.worker.insertOp(opRow(h.job(id), { kind: 'swap', state: 'finished', verdict: 'refunded', used: 0n, finishedAt: h.now(),
    request: json({ receiver: USDC, method: 'ft_transfer_call', args: { receiver_id: EX, amount: p.amount }, deposit: '1', step: p.id, swap: { tokenOut: WNEAR, amountIn: p.amount, minOut: p.floor, unwrapNear: true } }) })));
  const s = h.state(id);
  assert.equal(h.worker.tradeStop(h.job(id), s, { ...s, pending: null, sequence: s.sequence + 1, done: { kind: 'tp', at: h.now() } }, 'x'), false);
  assert.equal(h.job(id).state, 'running');
});

test('AUDIT S-11 (S05, S08, S09, S10, S11, H11): store and hire gates on their own: tradeStop with an operation in flight, saveTrade off running, createJob refusals, unreadable settings before funding', async t => {
  // tradeStop never runs over an operation in flight, even one that is not the pending step.
  const h = setup(t), { id } = await h.run();
  const s = h.state(id);
  assert.ok(h.worker.insertOp(opRow(h.job(id), { kind: 'wrap' })));
  assert.equal(h.worker.tradeStop(h.job(id), s, { ...s, done: { kind: 'life', at: h.now() } }, 'x'), false, 'an operation is in flight');
  assert.equal(h.job(id).state, 'running');
  // saveTrade is a compare-and-set on running: a job the owner moved to stopping keeps its stored state.
  const g = setup(t), gi = await g.run();
  assert.equal((await g.request(`${gi.path}/stop`, {})).status, 200);
  assert.equal(g.job(gi.id).state, 'stopping');
  assert.equal(g.worker.saveTrade(g.job(gi.id), g.state(gi.id), { ...g.state(gi.id), fills: 9 }), false);
  assert.equal(g.state(gi.id).fills, 0);

  // createJob (build report departure 13): a trade kind never exists without matching settings on a pinned trade pair.
  const db = stores(t), deposit = near('0.6');
  const schedule = tradeSettingsFromRequest('schedule', SCHEDULE, testNow) as TradeSettings;
  const base = { owner, mode: 'live' as const, depositYocto: deposit };
  assert.throws(() => db.web.createJob({ ...base, kind: 'dca', pair: 'trade-usdc', tradeSettings: schedule }, testNow), /Invalid trade settings/, 'a strategy that differs from the kind');
  assert.throws(() => db.web.createJob({ ...base, kind: 'schedule', pair: 'usdc-wnear', tradeSettings: schedule }, testNow), /Invalid trade settings/, 'a pair outside TRADE_PAIRS');
  assert.throws(() => db.web.createJob({ ...base, kind: 'schedule', pair: 'trade-usdc' }, testNow), /Invalid trade settings/, 'a trade kind without settings');
  assert.throws(() => db.web.createJob({ ...base, kind: 'grid', pair: 'usdc-wnear', tradeSettings: schedule }, testNow), /Invalid trade settings/, 'trade settings on a Grid job');
  assert.equal(db.web.listJobs(owner).length, 0, 'nothing was created');
  assert.equal(db.web.createJob({ ...base, kind: 'schedule', pair: 'trade-usdc', tradeSettings: schedule }, testNow).trade, true);

  // TF-2 before funding: unreadable settings keep a linked job from moving to funded.
  const u = setup(t), ui = await u.hire();
  const raw = new DatabaseSync(u.path);
  try { raw.prepare('UPDATE trade_jobs SET settings=? WHERE job_id=?').run('{"v":1}', ui.id); } finally { raw.close(); }
  u.setNative(u.deposit); u.bump();
  await u.tick(ui.id); await u.tick(ui.id);
  assert.equal(u.job(ui.id).state, 'link_confirmed'); assert.equal(u.job(ui.id).reason, 'Trade settings are unreadable. Stop and withdraw.');
});

test('AUDIT S-12 (M76, H10c, W04): an idle DCA job evaluates once a minute; the worker flag off prepares no wallet; an unfunded linked job cannot use early stop', async t => {
  // Spec 10.1 and 6.6: without a pending step a DCA job evaluates at most once per 60 s (the QuickNode quota, FINDINGS 1.40).
  const h = setup(t, { kind: 'dca' }), { id } = await h.run();
  h.history(); await buy(h, id); await h.tick(id);
  assert.equal(h.state(id).pending, null);
  await h.tick(id); // one full evaluation, to measure it
  const one = h.reads();
  await h.tick(id);
  const perEvaluation = h.reads() - one, before = h.reads();
  for (let i = 0; i < 29; i++) { h.skip(2_000); await advanceJob(h.d, id); } // 58 s of worker passes
  assert.ok(h.reads() - before <= perEvaluation, `58 s of passes made ${h.reads() - before} reads; one evaluation makes ${perEvaluation}`);

  // TF-1 before the wallet exists: the worker flag off registers nothing and says not to fund.
  const off = setup(t, { workerTrade: false });
  const made = await off.request('/api/jobs', { kind: 'schedule', mode: 'live', pair: 'trade-usdc', depositYocto: off.deposit.toString(), trade: SCHEDULE });
  assert.equal(made.status, 201);
  const draft = (made.data as { id: string }).id;
  await off.tick(draft); await off.tick(draft);
  assert.equal(off.job(draft).state, 'draft'); assert.equal(off.job(draft).walletId, null);
  assert.equal(off.job(draft).reason, 'Trade is disabled. Do not fund this job.');

  // TF-9: early Stop and withdraw from link_confirmed needs something to withdraw; an unfunded job is cancelled instead.
  const u = setup(t), ui = await u.hire();
  assert.equal(u.job(ui.id).state, 'link_confirmed');
  assert.equal((await u.request(`${ui.path}/stop`, {})).status, 409);
  assert.equal(u.job(ui.id).state, 'link_confirmed');
  assert.equal((await u.request(`${ui.path}/cancel`, {})).status, 200);
});

test('AUDIT S-13 (M81, M83): a denied wrap and a refunded sale each count one failed step and start the 5 minute back-off', async t => {
  const w = setup(t), wi = await w.run();
  w.history(); await w.tick(wi.id);
  const p = w.state(wi.id).pending!;
  assert.equal(p.kind, 'wrap');
  assert.ok(w.worker.insertOp(opRow(w.job(wi.id), { kind: 'wrap', state: 'finished', verdict: 'denied', finishedAt: w.now(),
    request: json({ receiver: WNEAR, method: 'near_deposit', args: {}, deposit: p.amount, step: p.id }) })));
  await w.tick(wi.id);
  assert.equal(w.job(wi.id).state, 'running', 'a denied wrap is a failed step, not a halt');
  assert.deepEqual([w.state(wi.id).failures, w.state(wi.id).pending, w.state(wi.id).buy, w.state(wi.id).wnear], [1, null, null, '0']);
  assert.ok(w.state(wi.id).failedAt !== null);

  const s = setup(t, { kind: 'dca' }), si = await s.run();
  s.history(); await buy(s, si.id); await s.tick(si.id);
  s.setReserve(USDC, s.reserve(USDC) * 100n / 110n);
  await s.tick(si.id);
  assert.equal(s.state(si.id).pending?.side, 'sell');
  const held = s.bal[USDC];
  s.setMode('refund'); await s.tick(si.id); s.setMode('normal');
  const st = s.state(si.id);
  assert.equal(rows(s, si.id, 'swap')[0]!.verdict, 'refunded');
  assert.deepEqual([st.failures, st.pending, st.sold, st.proceeds, st.gasSell], [1, null, '0', '0', REFUND_GAS.toString()], 'the refunded sale is one failed step and its gas is sale gas');
  assert.ok(st.failedAt !== null); assert.equal(s.bal[USDC], held, 'the token stays in the agent wallet');
  assert.equal(BigInt(st.spent) + BigInt(st.gasBuy), near('0.101812'), 'K is unchanged by the refunded sale');
  await s.tick(si.id);
  assert.match(s.job(si.id).reason!, /five minutes/); assert.equal(s.state(si.id).pending, null, 'no new sale during the back-off');
  assert.equal(s.job(si.id).state, 'running');
});

test('AUDIT S-14 (M45): TP-fit at the equality of spec 6.3 inside the planner: zero headroom ends tp-cap, one yocto of headroom plans the sale', async t => {
  for (const [headroom, ends] of [[0n, true], [1n, false]] as const) {
    const h = setup(t, { kind: 'dca' }), { id } = await h.run();
    h.history(); await buy(h, id); await h.tick(id);
    h.inject(id, { levels: ['skipped'], spent: '1', gasBuy: '0' }); // a tiny basis, so the take profit is reached
    const H = BigInt(h.state(id).bought), quote = h.ret(H, USDC, WNEAR);
    // The guard: 1 yocto <= 3D - 0.01 - exitNative, with exitNative = (spendable - 0.01) + wNEAR + quote. Spendable is the balance less the storage lock.
    h.setNative(3n * h.deposit - quote - headroom + STORAGE); h.bump();
    const before = swaps(h).length;
    await h.tick(id);
    if (ends) {
      assert.equal(h.state(id).done?.kind, 'tp-cap', 'zero headroom cannot cover the attached yocto'); assert.match(h.job(id).reason!, /exceed the signed daily limit/);
      assert.equal(swaps(h).length, before);
    } else {
      assert.equal(h.state(id).done, null); assert.equal(h.state(id).pending?.side, 'sell', 'one yocto of headroom fits an empty window');
    }
  }
});

test('AUDIT S-15 (M38, M42b): the stop-loss and take-profit lines include equality', async t => {
  // Stop loss: breach when value x 10000 <= K x (10000 - slBps). At 10 % that is value x 10 == K x 9.
  const sl = setup(t, { kind: 'dca', trade: { ...DCA, slBps: 1000 } }), s = await sl.run();
  sl.history(); await buy(sl, s.id); await sl.tick(s.id);
  const H = BigInt(sl.state(s.id).bought);
  let value = sl.ret(H, USDC, WNEAR);
  for (let i = 0; i < 200 && value % 9n !== 0n; i++) { sl.setReserve(WNEAR, sl.reserve(WNEAR) + 1n); value = sl.ret(H, USDC, WNEAR); }
  assert.equal(value % 9n, 0n);
  sl.inject(s.id, { levels: ['skipped'], spent: (value * 10n / 9n - 1n).toString(), gasBuy: '0' }); // K one yocto below the line: value is above it
  sl.bump(); await sl.tick(s.id);
  assert.equal(sl.state(s.id).protect, null, 'one yocto above the line is no breach');
  sl.inject(s.id, { spent: (value * 10n / 9n).toString() }); // equality
  sl.bump(); await sl.tick(s.id);
  assert.ok(sl.state(s.id).protect, 'value x 10000 == K x (10000 - slBps) is a breach');

  // Take profit: fires when the quote of H is at least the line.
  const tp = setup(t, { kind: 'dca' }), p = await tp.run();
  tp.history(); await buy(tp, p.id); await tp.tick(p.id);
  const held = BigInt(tp.state(p.id).bought), gas = 3n * N / 1000n;
  const found: bigint[] = []; let quote = 0n;
  for (let i = 0; i < 200 && !found.length; i++) {
    quote = tp.ret(held, USDC, WNEAR);
    const x = quote * 10_000n / 10_150n;
    for (const d of [-2n, -1n, 0n, 1n, 2n]) if (x + d > gas && tpLine(x + d - gas, 150) === quote) found.push(x + d - gas);
    if (!found.length) tp.setReserve(WNEAR, tp.reserve(WNEAR) + 1n);
  }
  const k = found[0]!;
  assert.equal(tpLine(k, 150), quote);
  tp.inject(p.id, { levels: ['skipped'], spent: (k + 1n).toString(), gasBuy: '0' }); // the line is above the quote
  assert.ok(tpLine(k + 1n, 150) > quote);
  await tp.tick(p.id);
  assert.equal(tp.state(p.id).pending, null, 'below the line nothing is sold');
  tp.inject(p.id, { spent: k.toString() });
  await tp.tick(p.id);
  assert.equal(tp.state(p.id).pending?.side, 'sell', 'a quote equal to the line fires');
  assert.equal(tp.state(p.id).pending?.floor, quote.toString());
});

test('AUDIT S-16 (O14, M85): a pool with none of the token is refused by the depth guard, and a stale step is dropped together with its buy', async t => {
  const h = setup(t, { pair: 'trade-rhea' }), { id } = await h.run(), amount = near('0.1');
  h.history(); await h.tick(id); await h.tick(id);
  const p = h.state(id).pending!;
  assert.equal(p.kind, 'swap');
  const tokens = h.reserve(RHEA);
  h.setReserve(RHEA, 0n); // TF-4: a token reserve of 0, with the wNEAR reserve still above 10,000
  await assert.rejects(createLiveOps({ ...h.d, jobId: id }).swap({ pin: h.pair.pin, tokenIn: WNEAR, tokenOut: RHEA, amountIn: amount, slippageBps: 50, unwrapNear: false, floor: BigInt(p.floor!) }), /none of the token/);
  h.setReserve(RHEA, tokens);
  assert.equal(rows(h, id, 'swap').length, 0);
  // 10.3: a row-less step older than 120 s is dropped with its buy; the wNEAR is kept.
  h.worker.setMeta(`trade_px:${h.pool}`, '[]');
  h.skip(121_000); await advanceJob(h.d, id);
  assert.deepEqual([h.state(id).pending, h.state(id).buy, h.state(id).wnear], [null, null, amount.toString()]);
});

// ---------------------------------------------------------------------------------------------------------------------
// AUDIT 2026-11-11, defect repros. Each test states the wanted behaviour and FAILS on the audited build.
// Paste at the end of test/trade.test.ts (it uses that file's harness) together with the import line below.
// ---------------------------------------------------------------------------------------------------------------------

test('AUDIT M-1 (fails on the audited build): a pool sample that fails is tried again after a minute, not on every 2 s worker pass', async t => {
  const h = setup(t, { pair: 'trade-zec' });
  await h.run();
  h.setFee(30); // the fee of pool 6065 changes: readTradePool refuses the pin on every read
  const before = h.reads();
  for (let i = 0; i < 30; i++) { h.skip(2_000); await auditSampleTradePools(h.d); } // one minute of worker passes
  assert.ok(h.reads() - before <= 2, `one minute of worker passes made ${h.reads() - before} get_pool reads for one pool`);
});

test('AUDIT M-1 (fails on the audited build): a DCA job with a row-less step and a pool that fails its pin does not read on every pass, and drops the step', async t => {
  const h = setup(t, { kind: 'dca' }), { id } = await h.run();
  h.history(); await h.tick(id);
  assert.equal(h.state(id).pending?.kind, 'wrap');
  h.worker.setMeta(`trade_px:${h.pool}`, '[]'); // the shared sample has aged out, so the next pass needs a read
  h.setFee(25);
  for (let i = 0; i < 65; i++) { h.skip(2_000); await advanceJob(h.d, id); } // 130 s of worker passes: the step is now older than 120 s
  assert.equal(h.state(id).pending, null, 'a row-less step older than 120 s is dropped even when the pool cannot be read');
  const before = h.reads();
  for (let i = 0; i < 60; i++) { h.skip(2_000); await advanceJob(h.d, id); } // two more minutes
  assert.ok(h.reads() - before <= 6, `two minutes of worker passes made ${h.reads() - before} chain reads for one idle job`);
});

test('AUDIT M-2 (fails on the audited build): a freeze made while the watchdog is down still stops a Schedule job in its idle window', async t => {
  const h = setup(t), { id } = await h.run(), a = h.state(id).anchor!;
  h.history(); await buy(h, id);
  await watchOnce({ store: h.watch, rpc: h.rpc, now: h.now }); // watch_frozen = false
  h.freezePolicy(true); h.bump(); // the owner freezes while the watchdog is down: no pass runs and its heartbeat goes stale
  h.skip(10 * MIN); h.watch.heartbeat('watchdog', h.now() - 10 * MIN); await advanceJob(h.d, id);
  assert.equal(h.job(id).state, 'frozen', 'the worker reads the policy itself when the watchdog does not vouch for it');
  h.freezePolicy(false); h.bump();
  h.at(a + HOUR + MIN); h.history();
  for (let i = 0; i < 4; i++) await h.tick(id);
  assert.equal(h.state(id).fills, 1, 'an unfreeze never resumes the job');
});

// Merge with master (RPC wait and verified recovery, Phase 1 fix 3): the trade paths through master's new code.
const blocking = (alerts: { severity: string; kind: string }[]) => alerts.filter(a => a.severity !== 'info').map(a => a.kind);

test('MERGE a: a watchdog read outage pauses a trade step without halting, and a complete verification releases it', async t => {
  const h = setup(t, { kind: 'dca' }), { id } = await h.run();
  const pass = async () => { h.bump(); return blocking(await watchOnce({ store: h.watch, rpc: h.rpc, now: h.now })); };
  assert.deepEqual(await pass(), []);
  h.history(); await h.tick(id);
  assert.equal(h.state(id).pending?.kind, 'wrap');
  h.setReadable(false); assert.deepEqual(await pass(), []); h.setReadable(true);
  assert.equal(h.watch.watchWaiting(id), true, 'the first blind pass starts the wait');
  const calls = h.calls.length;
  await h.tick(id); await h.tick(id);
  assert.equal(h.calls.length, calls, 'no trade step is sent during the wait');
  assert.equal(h.job(id).state, 'running', 'the wait does not halt the job');
  assert.deepEqual(await pass(), [], 'a complete verification');
  assert.equal(h.watch.watchWaiting(id), false, 'releases the wait');
  await h.tick(id);
  assert.equal(h.calls.at(-1)?.method, 'near_deposit', 'the pending wrap goes out after the release');
});

test('MERGE b: the watchdog verifies the trade wrap, swap in and take-profit sale with unwrap on 4512, 6458 and 6065, reads no DCL and tracks the job token', async t => {
  for (const pair of ['trade-usdc', 'trade-rhea', 'trade-zec'] as const) {
    const h = setup(t, { kind: 'dca', pair }), { id } = await h.run(), token = h.pair.token;
    let dcl = 0;
    const view = h.rpc.view;
    h.rpc.view = async (contract, method, args, block) => { if (contract === DCL) dcl++; return view(contract, method, args, block); };
    const pass = async () => { h.bump(); return blocking(await watchOnce({ store: h.watch, rpc: h.rpc, now: h.now })); };
    assert.deepEqual(await pass(), [], pair);
    h.history(); await h.tick(id); await h.tick(id);
    assert.equal(rows(h, id, 'wrap')[0]?.verdict, 'success');
    assert.deepEqual(await pass(), [], `${pair} wrap`);
    await h.tick(id);
    assert.equal(h.state(id).fills, 1);
    assert.deepEqual(await pass(), [], `${pair} swap in`);
    h.setReserve(token, h.reserve(token) * 100n / 110n);
    await h.tick(id); await h.tick(id);
    assert.equal(h.state(id).done?.kind, 'tp'); assert.equal(h.job(id).state, 'stopping');
    assert.deepEqual(await pass(), [], `${pair} take-profit sale with unwrap: no verification_error`);
    assert.equal(h.watch.watchWaiting(id), false);
    assert.equal(dcl, 0, `${pair}: no DCL read for a trade wallet`);
    assert.deepEqual(Object.keys((JSON.parse(h.watch.getWatch(id)!.holdings) as { tokens: Record<string, string> }).tokens).sort(), [token, WNEAR].sort());
  }
});

test('MERGE c: a halted trade job reports Check and resume as disabled with a factual reason and cannot resume', async t => {
  const h = setup(t), { id, path } = await h.run();
  const raw = new DatabaseSync(h.path);
  try { raw.prepare('UPDATE trade_jobs SET settings=? WHERE job_id=?').run('{"v":1,"strategy":"schedule"}', id); } finally { raw.close(); }
  await h.tick(id);
  assert.equal(h.job(id).state, 'halted');
  const v = (await h.request(path)).data as { blindHalt: boolean; canResumeBlind: boolean; resumeBlockedReason: string | null; waitingForChain: boolean };
  assert.deepEqual([v.blindHalt, v.canResumeBlind, v.waitingForChain], [false, false, false]);
  assert.equal(v.resumeBlockedReason, 'This halt requires review. Check the job alerts or use Stop and withdraw.');
  assert.equal((await h.request(`/api/challenge?purpose=resume&job=${id}`)).status, 409);
  assert.equal((await h.request(`${path}/resume`, { signed: {} })).status, 409);
  assert.equal(h.job(id).state, 'halted');
});

test('MERGE e: an unanswered setup registration on RHEA (agent and owner) is released for exit after 10 minutes', async t => {
  for (const who of ['agent', 'owner'] as const) {
    const h = setup(t, { pair: 'trade-rhea' }), { id } = await h.hire();
    h.setNative(h.deposit); h.bump();
    await h.tick(id);
    assert.equal(h.job(id).state, 'funded');
    let sent = 0;
    const lost = dummyOutLayer({ storageDeposit: async () => { sent++; return { kind: 'ambiguous', reason: 'network' }; } });
    assert.equal((await createLiveOps({ ...h.d, outlayer: lost, jobId: id, wait: async () => {} }).registerStorage(RHEA, who, 'setup')).verdict, 'unknown');
    assert.equal(sent, 4, 'fix 4: the original and three same-key re-sends');
    const row = h.worker.inFlightOp(h.job(id).walletId!)!;
    assert.equal(row.state, 'ambiguous'); assert.equal(h.job(id).state, 'halted');
    h.bump();
    const released = await reconcileWallet({ store: h.worker, rpc: h.rpc, outlayer: lost, kek: h.d.kek, now: () => row.submittedAt! + 600_000, wait: async () => {} }, h.job(id).walletId!);
    assert.equal(released, 'clean', who);
    const done = h.worker.jobOps(id).find(o => o.id === row.id)!;
    assert.deepEqual([done.state, done.verdict, done.message], ['finished', 'unclear', REGISTRATION_RELEASED]);
    assert.equal(h.worker.inFlightOp(h.job(id).walletId!), null);
    assert.equal(sent, 4, 'no reconcile re-send: the watchdog heartbeat is stale 10 minutes later');
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// HALT REVIEW 2026-11-12 (merge 2d21b94). Paste at the end of test/trade.test.ts (it uses that file's harness).
// The three HALT H-1 / M-1 / M-2 tests state the wanted behaviour and FAIL at 2d21b94.
// The two HALT Q3 / Q4 tests describe what happens today and PASS at 2d21b94.
// ---------------------------------------------------------------------------------------------------------------------

/** Proof retries wait 5 s each in real time unless the worker deps carry a wait: the tests skip that sleep. */
const haltNoSleep = (h: Harness) => { Object.assign(h.d, { wait: async () => {} }); };
const haltPass = async (h: Harness) => { h.bump(); return blocking(await watchOnce({ store: h.watch, rpc: h.rpc, now: h.now })); };
/** The receipt route (transaction status and block-by-hash, the archival route of near-rpc.ts) down or up. Up also answers snapshot block ids. */
function haltReceiptRoute(h: Harness) {
  const tx = h.rpc.txStatus, block = h.rpc.blockHeight!;
  const up = () => { h.rpc.txStatus = tx; h.rpc.blockHeight = async id => /^block-\d+$/.test(id) ? Number(id.slice(6)) : block(id); };
  const down = () => { h.rpc.txStatus = async () => { throw new RpcUnavailable(); }; h.rpc.blockHeight = async () => { throw new RpcUnavailable(); }; };
  /** The route fails right after a submission: receipts are unreadable, the block read made before the submission still answered. */
  const lost = () => { down(); h.rpc.blockHeight = async id => { if (/^block-\d+$/.test(id)) return Number(id.slice(6)); throw new RpcUnavailable(); }; };
  up();
  return { up, down, lost };
}

test('HALT H-1 (fails at 2d21b94): with the receipt route unreadable no trade operation is submitted, and the job is not halted', async t => {
  const h = setup(t), { id } = await h.run(), route = haltReceiptRoute(h);
  haltNoSleep(h);
  assert.deepEqual(await haltPass(h), []);
  h.history(); await h.tick(id);
  assert.equal(h.state(id).pending?.kind, 'wrap');
  route.down(); // QuickNode out, public archival throttled; ordinary reads still answer (dRPC)
  const calls = h.calls.length;
  await h.tick(id);
  assert.equal(h.calls.length, calls, 'nothing is sent to OutLayer while its receipt could not be read');
  assert.equal(h.job(id).state, 'running', 'RPC trouble alone does not halt the job');
  assert.equal(h.worker.inFlightOp(h.job(id).walletId!), null, 'the wallet is not blocked');
  route.up();
  h.skip(61_000); h.history(); await h.tick(id); await h.tick(id);
  assert.equal(rows(h, id, 'wrap')[0]?.verdict, 'success', 'the buy goes on once receipts can be read again');
});

test('HALT M-1 (fails at 2d21b94): an operation that settles more than 60 s after its submission raises no outflow alert and does not halt the job', async t => {
  const h = setup(t), { id } = await h.run();
  haltNoSleep(h);
  assert.deepEqual(await haltPass(h), []);
  h.history(); await h.tick(id);
  assert.equal(h.state(id).pending?.kind, 'wrap');
  // OutLayer has answered and the wrap is final on chain, but the worker's receipt read is slow: 61 s after the submission
  // a watchdog pass completes its own reads while the journal row is still `submitted`.
  const tx = h.rpc.txStatus, seen: string[] = [];
  let slow = true;
  h.rpc.txStatus = async (hash, sender) => {
    if (slow) {
      slow = false;
      h.skip(61_000); h.worker.heartbeat('worker', h.now());
      seen.push(...blocking(await watchOnce({ store: h.watch, rpc: h.rpc, now: h.now })));
    }
    return tx(hash, sender);
  };
  await h.tick(id);
  assert.equal(rows(h, id, 'wrap')[0]?.verdict, 'success', 'the worker then proves the wrap');
  assert.deepEqual(seen, [], 'the watchdog raises no money alert for the wallet change of an operation that is still being settled');
  await h.tick(id);
  assert.equal(h.job(id).state, 'running', 'a slow settlement alone does not halt the job');
});

test('HALT M-2 (fails at 2d21b94): a read wait is released by a complete verification although the journal holds a denied wrap', async t => {
  const h = setup(t), { id } = await h.run();
  assert.deepEqual(await haltPass(h), []);
  h.history(); await h.tick(id);
  const p = h.state(id).pending!;
  assert.equal(p.kind, 'wrap');
  // OutLayer denies the wrap once (403): Trade counts one failed step and goes on (spec TF-8).
  assert.ok(h.worker.insertOp(opRow(h.job(id), { kind: 'wrap', state: 'finished', verdict: 'denied', finishedAt: h.now(),
    request: json({ receiver: WNEAR, method: 'near_deposit', args: {}, deposit: p.amount, step: p.id }) })));
  await h.tick(id);
  assert.equal(h.job(id).state, 'running'); assert.equal(h.state(id).failures, 1);
  h.setReadable(false); assert.deepEqual(await haltPass(h), []); h.setReadable(true);
  assert.equal(h.watch.watchWaiting(id), true, 'one unreadable pass starts a wait');
  for (let i = 0; i < 4; i++) { h.skip(15_000); assert.deepEqual(await haltPass(h), []); }
  assert.equal(h.watch.watchWaiting(id), false, 'complete verifications release the wait');
  h.skip(5 * MIN); h.history(); await h.tick(id);
  assert.equal(h.state(id).pending?.kind, 'wrap', 'and the job buys again');
});

test('HALT Q3 (passes at 2d21b94): a submission with a known hash and an unreadable receipt is quarantined and halts the job; the wallet is released by itself once the receipt is readable, the job stays halted and only Stop and withdraw remains', async t => {
  const h = setup(t), { id, path } = await h.run(), route = haltReceiptRoute(h);
  haltNoSleep(h);
  assert.deepEqual(await haltPass(h), []);
  h.history(); await h.tick(id);
  route.lost();
  await h.tick(id);
  const row = rows(h, id, 'wrap')[0]!;
  assert.equal(row.state, 'ambiguous'); assert.ok(row.txHash, 'the hash is known');
  assert.equal(h.job(id).state, 'halted');
  assert.equal((await h.request(`${path}/stop`, {})).status, 409, 'Stop and withdraw is refused while the submission is unresolved');
  // The watchdog can still read balances: it reports the wrap as an outflow, because the journal row is not finished.
  assert.deepEqual(await haltPass(h), ['native_outflow']);
  const sent = h.calls.length;
  for (let i = 0; i < 3; i++) assert.equal(await reconcileWallet({ store: h.worker, rpc: h.rpc, outlayer: h.d.outlayer, kek: h.d.kek, now: h.now, wait: async () => {} }, h.job(id).walletId!), 'halted');
  route.up();
  assert.equal(await reconcileWallet({ store: h.worker, rpc: h.rpc, outlayer: h.d.outlayer, kek: h.d.kek, now: h.now, wait: async () => {} }, h.job(id).walletId!), 'clean');
  assert.equal(h.calls.length, sent, 'nothing was sent again');
  assert.equal(rows(h, id, 'wrap')[0]!.verdict, 'success');
  assert.equal(h.job(id).state, 'halted'); assert.equal(h.job(id).reason, 'Submission reconciled. Use Stop and withdraw to return funds to the owner.');
  const v = (await h.request(path)).data as { canResumeBlind: boolean; resumeBlockedReason: string | null };
  assert.equal(v.canResumeBlind, false);
  assert.equal((await h.request(`/api/challenge?purpose=resume&job=${id}`)).status, 409, 'no resume of any kind');
  assert.equal((await h.request(`${path}/stop`, {})).status, 200);
  await until(h, id, () => h.job(id).state === 'stopped');
  assert.equal(h.bal[WNEAR], 0n, 'the wrapped NEAR went back to the owner');
});

test('HALT Q4 (passes at 2d21b94): a ZEC receipt of an unknown shape halts through the worker; the watchdog adds verification_error and two outflow alerts; Stop and withdraw still pays the owner', async t => {
  const h = setup(t, { pair: 'trade-zec' }), { id, path } = await h.run();
  haltNoSleep(h);
  assert.deepEqual(await haltPass(h), []);
  h.history(); await h.tick(id); await h.tick(id);
  assert.deepEqual(await haltPass(h), [], 'the wrap is verified');
  h.setMode('omft'); await h.tick(id); h.setMode('normal');
  assert.equal(rows(h, id, 'swap')[0]!.verdict, 'unclear'); assert.equal(h.job(id).state, 'halted');
  assert.deepEqual((await haltPass(h)).sort(), ['native_outflow', 'token_outflow', 'verification_error']);
  assert.deepEqual(await haltPass(h), [], 'the baseline moved on: later passes are quiet');
  const v = (await h.request(path)).data as { blindHalt: boolean; canResumeBlind: boolean; resumeBlockedReason: string | null };
  assert.deepEqual([v.blindHalt, v.canResumeBlind], [false, false]);
  assert.equal(v.resumeBlockedReason, 'A pending or uncertain transaction must be reconciled before this job can resume.');
  assert.equal((await h.request(`${path}/stop`, {})).status, 200);
  await until(h, id, () => h.job(id).state === 'stopped');
  assert.ok(h.ownerBal[ZEC]! > 0n, 'the owner receives the ZEC');
  assert.equal(h.bal[ZEC], 0n); assert.equal(h.bal[WNEAR], 0n);
});

// ---------------------------------------------------------------------------------------------------------------------
// HALT REVIEW, re-check of fix round 2 (b4afa82). Paste at the end of test/trade.test.ts, after the HALT repros
// (it uses their helpers). Passes at b4afa82; fails when the receipt-route check also gates the exit (mutant R2).
// ---------------------------------------------------------------------------------------------------------------------
test('HALT R2: the receipt-route check of H-1 gates trade setup and strategy steps only, never the exit', async t => {
  const h = setup(t), { id, path } = await h.run(), route = haltReceiptRoute(h);
  haltNoSleep(h);
  h.history(); await h.tick(id); await h.tick(id);
  assert.equal(h.state(id).wnear, near('0.1').toString(), 'the job holds wrapped NEAR');
  assert.equal((await h.request(`${path}/stop`, {})).status, 200);
  route.down();
  const calls = h.calls.length;
  await h.tick(id);
  assert.equal(h.calls.length, calls + 1); assert.equal(h.calls.at(-1)?.method, 'near_withdraw', 'the exit still submits its unwrap, as before the fix');
});
