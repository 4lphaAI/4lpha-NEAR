import { parseAmount } from './amounts.js';
import { CoreError, record, redactText } from './errors.js';

type Status = Record<string, unknown>;
type Action = Record<string, unknown> | string;
interface ReceiptOutcome { id: string; blockHash: string | null; executor: string; status: Status; logs: string[]; children: string[]; burnt: bigint; }
interface Receipt { id: string; predecessor: string; receiver: string; actions: Action[]; }
export interface TxStatus {
  final: boolean; status: Status; signer: string; receiver: string; hash: string; actions: Action[];
  root: { burnt: bigint; blockHash: string | null; children: string[] }; outcomes: ReceiptOutcome[]; receipts: Receipt[];
}
export interface OutcomeClass { top: string; verdict: 'success' | 'failure' | 'inner-failure' | 'unknown'; actions: string[];
  receipts: { executor: string; status: string; failure: string | null; logs: string[]; ignoredLogs: number }[]; }
export interface SwapClass { verdict: 'swapped' | 'refunded' | 'unclear'; used: bigint | null; resolves: number; failures: { executor: string; failure: string }[]; nativeIn: bigint; }
export interface SignedAction { receiver: string; kind: 'FunctionCall' | 'Transfer' | 'Other'; method: string | null; args: unknown; deposit: bigint; gas?: bigint; }

const bad = () => new CoreError('bad_request', 'Unexpected finalized transaction shape.');
function obj(v: unknown) { const r = record(v); if (!r) throw bad(); return r; }
function str(v: unknown) { if (typeof v !== 'string' || !v) throw bad(); return v; }
function list(v: unknown) { if (!Array.isArray(v)) throw bad(); return v as unknown[]; }
function strings(v: unknown) { return list(v).map(s => { if (typeof s !== 'string') throw bad(); return s; }); }
function actions(v: unknown) { return list(v).map(a => typeof a === 'string' ? a : obj(a)); }

export function parseTxStatus(raw: unknown): TxStatus {
  const r = obj(raw), t = obj(r.transaction), root = obj(r.transaction_outcome), rootOutcome = obj(root.outcome);
  return { final: r.final_execution_status === 'FINAL', status: obj(r.status), signer: str(t.signer_id), receiver: str(t.receiver_id), hash: str(t.hash), actions: actions(t.actions),
    root: { burnt: parseAmount(rootOutcome.tokens_burnt, 'tokens burnt'), blockHash: typeof root.block_hash === 'string' ? root.block_hash : null, children: rootOutcome.receipt_ids === undefined ? [] : strings(rootOutcome.receipt_ids) },
    outcomes: list(r.receipts_outcome).map(value => {
      const o = obj(value), v = obj(o.outcome);
      return { id: str(o.id), blockHash: typeof o.block_hash === 'string' ? o.block_hash : null, executor: str(v.executor_id), status: obj(v.status),
        logs: strings(v.logs), children: strings(v.receipt_ids), burnt: parseAmount(v.tokens_burnt, 'tokens burnt') };
    }),
    receipts: list(r.receipts).map(value => {
      const o = obj(value), v = obj(o.receipt);
      return { id: str(o.receipt_id), predecessor: str(o.predecessor_id), receiver: str(o.receiver_id), actions: v.Action ? actions(obj(v.Action).actions) : [] };
    }) };
}

function statusKey(s: Status): string { const ks = Object.keys(s); return ks.length === 1 ? ks[0] : 'Unknown'; }
function success(s: Status) { return statusKey(s) === 'SuccessValue' || statusKey(s) === 'SuccessReceiptId'; }
const actionKind = (a: Action) => typeof a === 'string' ? a : Object.keys(a)[0] ?? 'Other';
const failure = (s: Status) => redactText(JSON.stringify(s.Failure ?? 'Execution failed').slice(0, 300));

export function classifyOutcome(tx: TxStatus): OutcomeClass {
  const top = statusKey(tx.status);
  const receipts = tx.outcomes.map(o => ({ executor: o.executor, status: statusKey(o.status), failure: Object.hasOwn(o.status, 'Failure') ? failure(o.status) : null,
    logs: Object.hasOwn(o.status, 'Failure') ? [] : o.logs, ignoredLogs: Object.hasOwn(o.status, 'Failure') ? o.logs.length : 0 }));
  const verdict = top === 'Failure' ? 'failure' : receipts.some(r => r.status === 'Failure') ? 'inner-failure'
    : success(tx.status) && tx.outcomes.length > 0 && tx.outcomes.every(o => success(o.status)) ? 'success' : 'unknown';
  return { top, verdict, actions: tx.actions.map(actionKind), receipts };
}

export function readAction(a: Action, receiver: string): SignedAction | null {
  const o = record(a);
  if (!o || Object.keys(o).length !== 1) return { receiver, kind: 'Other', method: null, args: null, deposit: 0n };
  try {
    const f = record(o.FunctionCall), t = record(o.Transfer);
    if (f) {
      if (typeof f.method_name !== 'string' || typeof f.args !== 'string') return null;
      const args: unknown = JSON.parse(Buffer.from(f.args, 'base64').toString('utf8'));
      const gas = typeof f.gas === 'number' && Number.isSafeInteger(f.gas) && f.gas >= 0 ? BigInt(f.gas) : typeof f.gas === 'string' ? parseAmount(f.gas, 'prepaid gas') : undefined;
      return { receiver, kind: 'FunctionCall', method: f.method_name, args, deposit: parseAmount(f.deposit, 'attached deposit'), gas };
    }
    if (t) return { receiver, kind: 'Transfer', method: null, args: null, deposit: parseAmount(t.deposit, 'transfer amount') };
  } catch { return null; }
  return { receiver, kind: 'Other', method: null, args: null, deposit: 0n };
}

export function signedAction(tx: TxStatus): SignedAction | null { return tx.actions.length === 1 ? readAction(tx.actions[0], tx.receiver) : null; }

export function receiptBranch(tx: TxStatus, root: string): TxStatus['receipts'] {
  const seen = new Set<string>(), queue = [root];
  while (queue.length) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...(tx.outcomes.find(o => o.id === id)?.children ?? []));
  }
  return tx.receipts.filter(r => seen.has(r.id));
}

function actionsTo(tx: TxStatus, receiver: string, from: (id: string) => boolean): bigint {
  const good = new Set(tx.outcomes.filter(o => success(o.status)).map(o => o.id));
  let sum = 0n;
  for (const r of tx.receipts) if (r.receiver === receiver && from(r.predecessor) && good.has(r.id)) {
    for (const a of r.actions) { const s = readAction(a, r.receiver); if (s?.kind === 'Transfer') sum += s.deposit; }
  }
  return sum;
}

export function nativePaidTo(tx: TxStatus, agent: string, from?: string): bigint {
  return actionsTo(tx, agent, id => from === undefined ? id !== 'system' : id === from);
}

export function classifySwap(tx: TxStatus, o: { agent: string; tokenIn: string; exchange: string; amountIn: bigint }): SwapClass {
  const resolves = tx.receipts.filter(r => r.receiver === o.tokenIn && r.predecessor === o.tokenIn &&
    r.actions.length === 1 && record(record(r.actions[0])?.FunctionCall)?.method_name === 'ft_resolve_transfer');
  const failures = tx.outcomes.filter(r => Object.hasOwn(r.status, 'Failure')).map(r => ({ executor: r.executor, failure: failure(r.status) }));
  let used: bigint | null = null;
  if (resolves.length === 1) {
    const s = tx.outcomes.find(r => r.id === resolves[0].id)?.status.SuccessValue;
    if (typeof s === 'string') try { used = parseAmount(JSON.parse(Buffer.from(s, 'base64').toString('utf8')), 'resolved amount'); } catch { /* Unknown. */ }
  }
  const verdict = used === o.amountIn && failures.length === 0 && classifyOutcome(tx).verdict === 'success' ? 'swapped'
    : used === 0n && failures.length > 0 && failures.every(f => f.executor === o.exchange) && success(tx.status) ? 'refunded' : 'unclear';
  return { verdict, used, resolves: resolves.length, failures, nativeIn: nativePaidTo(tx, o.agent) };
}

export function gasAccounting(tx: TxStatus, agent: string): { burnt: bigint; refunded: bigint; held: bigint } {
  const burnt = tx.outcomes.reduce((n, o) => n + o.burnt, tx.root.burnt);
  const refunded = actionsTo(tx, agent, id => id === 'system');
  return { burnt, refunded, held: burnt + refunded };
}

export function finalReceiptBlocks(tx: TxStatus): string[] | null {
  if (!tx.final || !tx.root.blockHash || !tx.root.children.length || tx.outcomes.length !== tx.receipts.length) return null;
  const byId = new Map(tx.outcomes.map(o => [o.id, o]));
  const receipts = new Map(tx.receipts.map(r => [r.id, r]));
  if (byId.size !== tx.outcomes.length || receipts.size !== tx.receipts.length) return null;
  const visited = new Set<string>();
  const blocks = new Set([tx.root.blockHash]);
  const todo = [...tx.root.children];
  while (todo.length) {
    const id = todo.pop()!;
    if (visited.has(id)) continue;
    const o = byId.get(id), r = receipts.get(id);
    if (!o?.blockHash || !r || o.executor !== r.receiver || (!success(o.status) && statusKey(o.status) !== 'Failure')) return null;
    if (typeof o.status.SuccessReceiptId === 'string' && !byId.has(o.status.SuccessReceiptId)) return null;
    visited.add(id); blocks.add(o.blockHash); todo.push(...o.children);
  }
  return visited.size === byId.size ? [...blocks] : null;
}
