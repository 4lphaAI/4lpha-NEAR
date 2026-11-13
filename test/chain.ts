import { YOCTO_PER_NEAR as N } from '../src/core/amounts.js';
import { record } from '../src/core/errors.js';
import { RpcUnavailable } from '../src/core/near-rpc.js';
import { USDC, WNEAR } from '../src/core/pins.js';
import { buildRules, defaultCaps, policyHash } from '../src/core/policy.js';
import { seal, SecretString, walletAad } from '../src/core/secrets.js';
import type { JobState } from '../src/core/hire.js';
import type { OpRow, Store } from '../src/core/store.js';
import { agent, dummyRpc, owner, testNow } from './helpers.js';

export function chain() {
  let height = 10;
  let native = 5n * N / 10n, wnear = 6n * N / 100n, usdc = 100_000n;
  let policy: Record<string, unknown> | null = { owner, encrypted_data: 'QUFBQQ==', frozen: false, storage_deposit: '15210000000000000000000' };
  let readable = true, version = '1.9.21', outputQuote = '56478';
  const registration = new Set([`${WNEAR}:${agent}`, `${USDC}:${agent}`, `${USDC}:${owner}`]);
  const txs = new Map<string, unknown>();
  const blocks = new Map<string, number>();
  const rpc = dummyRpc({
    finalBlock: async () => { if (!readable) throw new RpcUnavailable(); return { id: `block-${height}`, height }; },
    blockHeight: async id => { const n = blocks.get(id); if (n === undefined) throw new RpcUnavailable(); return n; },
    query: async p => {
      if (!readable || p.block_id !== `block-${height}`) throw new RpcUnavailable();
      return { amount: native.toString(), locked: '0', storage_usage: 182, block_hash: `block-${height}`, block_height: height };
    },
    viewAccount: async () => { if (!readable) throw new RpcUnavailable(); return { amount: native, locked: 0n, storageUsage: 182 }; },
    txStatus: async h => { const tx = txs.get(h); if (!tx) throw new RpcUnavailable(); return tx; },
    view: async (token, method, args, block) => {
      if (!readable || (block && block !== `block-${height}`)) throw new RpcUnavailable();
      let value: unknown;
      if (method === 'get_wallet_policy') value = policy;
      else if (method === 'ft_balance_of') value = (token === WNEAR ? wnear : usdc).toString();
      else if (method === 'storage_balance_of') value = registration.has(`${token}:${args.account_id}`) ? { total: '1250000000000000000000', available: '0' } : null;
      else if (method === 'metadata') value = { version, state: 'Running' };
      else if (method === 'get_pool') value = { pool_kind: 'SIMPLE_POOL', token_account_ids: [USDC, WNEAR], amounts: ['123', '456'] };
      else if (method === 'get_return') value = outputQuote;
      else throw new RpcUnavailable();
      return { height, blockId: `block-${height}`, value };
    },
  });
  return { rpc, registration, get native() { return native; }, get wnear() { return wnear; }, get usdc() { return usdc; }, get height() { return height; },
    setHoldings(v: { native?: bigint; wnear?: bigint; usdc?: bigint; height?: number }) {
      native = v.native ?? native; wnear = v.wnear ?? wnear; usdc = v.usdc ?? usdc; height = v.height ?? height;
    },
    setPolicy(v: Record<string, unknown> | null) { policy = v; },
    freeze(frozen: boolean) { if (policy) policy = { ...policy, frozen }; },
    setReadable(v: boolean) { readable = v; }, setVenue(v: string) { version = v; }, setQuote(v: string) { outputQuote = v; },
    addTx(raw: unknown, first = 11, hash = 'tx-test') {
      const tx = structuredClone(record(raw)!);
      const t = record(tx.transaction)!;
      t.hash = hash;
      const outcomes = [tx.transaction_outcome, ...(tx.receipts_outcome as unknown[])];
      for (const [i, outcome] of outcomes.entries()) {
        const o = record(outcome)!;
        o.block_hash = `${hash}-block-${i}`;
        blocks.set(String(o.block_hash), first + i);
      }
      txs.set(hash, tx);
      return hash;
    },
  };
}

export function armedJob(web: Store, worker: Store, state: JobState = 'running', deposit = N, extra: { gridV1?: boolean } = {}) {
  const j = web.createJob({ owner, kind: 'grid', mode: 'live', pair: 'usdc-wnear', depositYocto: deposit, ...extra }, testNow);
  const binding = { id: j.id, owner, walletId: 'wallet-test', agentAccount: agent }, kek = Buffer.alloc(32, 5);
  const sealAt = (purpose: 'api_key' | 'link', s: string) => seal(kek, new SecretString(s), walletAad(binding, purpose));
  worker.acquireWorkerLock(process.pid, testNow);
  worker.attachWallet(j, binding.walletId, agent, { apiKeyCt: sealAt('api_key', 'wk_test_fake'), linkCt: sealAt('link', 'https://example.test/?key=wk_test_fake') }, testNow);
  const caps = defaultCaps(deposit, { [USDC]: 3756475n });
  worker.casJob(j.id, 'registered', 1, state, { caps, walletPubkey: `ed25519:${agent}`, rules: buildRules({ owner, depositYocto: deposit, maxDeposit: 2n * N, usesDcl: extra.gridV1 === true, tokens: [USDC], caps }),
    armedHash: state === 'registered' ? null : policyHash({ encrypted: 'QUFBQQ==', owner, frozen: false, storageDeposit: 0n }), linkConfirmedAt: state === 'armed' || state === 'registered' ? null : testNow }, testNow);
  return { job: worker.getJob(j.id)!, kek };
}

let nextId = 0;
export function opRow(j: { id: string; walletId: string | null }, patch: Partial<OpRow> = {}): OpRow {
  const id = `op-${++nextId}`;
  return { id, jobId: j.id, walletId: j.walletId!, kind: 'wrap', purpose: 'strategy', idemKey: id, request: '{}', state: 'submitted', counted: 1,
    nativeSpend: 0n, http: null, code: null, requestId: null, txHash: null, verdict: null, used: null, nativeIn: null, gasBurnt: null,
    before: null, after: null, message: null, createdAt: testNow, submittedAt: testNow, finishedAt: null, finishedBlock: null, ...patch };
}
