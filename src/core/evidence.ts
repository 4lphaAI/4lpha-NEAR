import { parseAmount } from './amounts.js';
import { dclReceipt, discoveredDclOrders, discoveredDclPositions, type DclBefore, type DclProof } from './dcl-evidence.js';
import { record } from './errors.js';
import { RpcUnavailable, type NearRpc } from './near-rpc.js';
import { CLASSIC_EXCHANGE, MONEY, WNEAR } from './pins.js';
import { dclAction, DCL_GAS, type DclKind } from './rhea-dcl.js';
import { classifyOutcome, classifySwap, finalReceiptBlocks, gasAccounting, nativePaidTo, readAction, signedAction, type SignedAction, type TxStatus } from './receipts.js';

export type OpKind = 'storage' | 'storage_owner' | 'wrap' | 'unwrap' | 'swap' | 'transfer_near_owner' | 'transfer_token_owner' | DclKind;
export type OpVerdict = 'success' | 'swapped' | 'refunded' | 'denied' | 'frozen' | 'reverted' | 'quota' | 'busy' | 'unclear' | 'unknown';
export interface Intent {
  receiver: string; method: string | null; args: Record<string, unknown> | null; deposit: string;
  gas?: string;
  step?: string;
  lpReason?: 'rotation' | 'compound';
  swap?: { tokenOut: string; amountIn: string; minOut: string; unwrapNear: boolean };
}
export interface ReceiptProof { verdict: 'success' | 'reverted' | 'swapped' | 'refunded'; used: bigint | null; nativeIn: bigint; burnt: bigint; effects: Record<string, bigint>; dcl?: DclProof; }
export interface Allowed { agent: string; owner: string; tokens: readonly string[]; dclKinds: readonly DclKind[]; }

export function recipientProblems(a: SignedAction, allowed: Allowed): string[] {
  const { agent, owner, tokens } = allowed;
  const asset = a.receiver === WNEAR || tokens.includes(a.receiver);
  const args = record(a.args);
  const dcl = dclAction(a);
  if (dcl && allowed.dclKinds.includes(dcl.kind) && a.gas === DCL_GAS[dcl.kind]) return [];
  if ((a.kind === 'Transfer' && a.receiver === owner) || (a.kind === 'FunctionCall' && (
    (asset && a.method === 'ft_transfer' && args?.receiver_id === owner) ||
    (asset && a.method === 'ft_transfer_call' && args?.receiver_id === CLASSIC_EXCHANGE) ||
    (a.receiver === WNEAR && (a.method === 'near_deposit' || a.method === 'near_withdraw')) ||
    (asset && a.method === 'storage_deposit' && (args?.account_id === owner || args?.account_id === agent))))) return [];
  return ['The finalized signed action has an unexpected method or recipient.'];
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const r = record(v);
  if (!r) return JSON.stringify(v);
  return `{${Object.keys(r).sort().map(k => `${JSON.stringify(k)}:${canonical(k === 'msg' && typeof r[k] === 'string' ? JSON.parse(r[k]) as unknown : r[k])}`).join(',')}}`;
}

function actionMatches(a: SignedAction, i: Intent): boolean {
  return a.receiver === i.receiver && a.method === i.method && a.deposit === parseAmount(i.deposit, 'signed deposit') &&
    (i.gas === undefined || a.gas === parseAmount(i.gas, 'prepaid gas')) &&
    a.kind === (i.method === null ? 'Transfer' : 'FunctionCall') && canonical(a.args) === canonical(i.args);
}

export async function receiptInterval(rpc: NearRpc, tx: TxStatus): Promise<{ first: number; last: number } | null> {
  const hashes = finalReceiptBlocks(tx);
  if (!hashes) return null;
  if (!rpc.blockHeight) throw new RpcUnavailable();
  const blocks = await Promise.all(hashes.map(h => rpc.blockHeight!(h)));
  return { first: Math.min(...blocks), last: Math.max(...blocks) };
}

function matchingRoot(tx: TxStatus, i: Intent, allowed: Allowed) {
  const a = signedAction(tx);
  if (!a || tx.signer !== allowed.agent || recipientProblems(a, allowed).length || !actionMatches(a, i)) return null;
  const roots = tx.receipts.filter(r => tx.root.children.includes(r.id) && r.predecessor === tx.signer && r.receiver === tx.receiver);
  const root = roots.length === 1 ? roots[0] : null;
  const ra = root?.actions.length === 1 ? readAction(root.actions[0], root.receiver) : null;
  return root && ra && actionMatches(ra, i) ? { root, a } : null;
}

export function matchesIntent(tx: TxStatus, i: Intent, allowed: Allowed): boolean {
  try { return matchingRoot(tx, i, allowed) !== null; } catch { return false; }
}

export function intentOrderIds(tx: TxStatus, i: Intent, allowed: Allowed): string[] {
  const m = matchingRoot(tx, i, allowed);
  return m && dclAction(m.a)?.kind === 'dcl_place' ? discoveredDclOrders(tx, m.root.id, allowed.agent) : [];
}

export function intentPositionIds(tx: TxStatus, i: Intent, allowed: Allowed): string[] {
  const m = matchingRoot(tx, i, allowed);
  return m && dclAction(m.a)?.kind === 'dcl_add' ? discoveredDclPositions(tx, m.root.id, allowed.agent) : [];
}

export function provenEffects(tx: TxStatus, kind: OpKind, i: Intent, allowed: Allowed, before?: DclBefore): ReceiptProof | null {
  try {
    const matched = matchingRoot(tx, i, allowed);
    if (!matched) return null;
    const { root, a } = matched;
    const rootStatus = tx.outcomes.find(o => o.id === root.id)?.status;
    const { burnt } = gasAccounting(tx, allowed.agent);
    const outcome = classifyOutcome(tx).verdict;
    if (outcome === 'unknown') return null;
    let nativeIn = nativePaidTo(tx, allowed.agent);
    let used: bigint | null = null;
    let verdict: ReceiptProof['verdict'] = 'success';
    const effects: Record<string, bigint> = {};
    let attached = a.deposit;
    let dcl: DclProof | undefined;
    if (Object.hasOwn(DCL_GAS, kind) && outcome !== 'failure') {
      if (!allowed.dclKinds.includes(kind as DclKind) || dclAction(a)?.kind !== kind) return null;
      const p = dclReceipt(tx, root, a, allowed.agent, before);
      if (!p) return null;
      ({ verdict, used, dcl } = p);
      nativeIn = dcl.payouts.native ?? 0n;
      for (const [token, amount] of Object.entries(dcl.payouts)) if (token !== 'native') effects[token] = amount;
      if (used) effects[a.receiver] = -used;
    } else if (kind === 'swap') {
      if (!i.swap || a.method !== 'ft_transfer_call') return null;
      const { tokenOut, amountIn, minOut, unwrapNear } = i.swap;
      const swap = classifySwap(tx, { agent: allowed.agent, tokenIn: a.receiver, exchange: CLASSIC_EXCHANGE, amountIn: parseAmount(amountIn, 'swap input') });
      if (swap.verdict === 'unclear' || swap.used === null) return null;
      verdict = swap.verdict; used = swap.used;
      if (used > 0n) effects[a.receiver] = -used;
      if (swap.verdict === 'swapped') {
        if (unwrapNear) {
          if (tokenOut !== WNEAR) return null;
          nativeIn = nativePaidTo(tx, allowed.agent, CLASSIC_EXCHANGE);
          if (nativeIn < parseAmount(minOut, 'minimum output')) return null;
        } else {
          const outputs = tx.receipts.filter(r => r.receiver === tokenOut && r.predecessor === CLASSIC_EXCHANGE &&
            tx.outcomes.some(o => o.id === r.id && !Object.hasOwn(o.status, 'Failure'))).flatMap(r => r.actions.map(x => readAction(x, r.receiver)))
            .filter(x => x?.method === 'ft_transfer' && record(x.args)?.receiver_id === allowed.agent);
          if (outputs.length !== 1) return null;
          const amount = parseAmount(record(outputs[0]?.args)?.amount, 'output amount');
          if (amount < parseAmount(minOut, 'minimum output')) return null;
          effects[tokenOut] = amount;
          nativeIn = 0n;
        }
      } else nativeIn = 0n;
    } else if (outcome !== 'success') {
      // Only a failed original action proves that its attached deposit was not retained.
      if (!rootStatus || !Object.hasOwn(rootStatus, 'Failure') || (a.deposit > 0n && !tx.receipts.some(r => r.predecessor === 'system' && r.receiver === allowed.agent &&
        tx.outcomes.some(o => o.id === r.id && !Object.hasOwn(o.status, 'Failure')) && r.actions.some(x => readAction(x, r.receiver)?.deposit === a.deposit)))) return null;
      verdict = 'reverted'; attached = 0n; nativeIn = 0n;
    } else if (kind === 'wrap' && a.method === 'near_deposit') {
      effects[WNEAR] = a.deposit;
    } else if (kind === 'unwrap' && a.method === 'near_withdraw') {
      const amount = parseAmount(record(a.args)?.amount, 'unwrap amount');
      if (nativePaidTo(tx, allowed.agent, WNEAR) !== amount + a.deposit) return null;
      effects[WNEAR] = -amount;
    } else if (kind === 'transfer_token_owner' && a.method === 'ft_transfer') {
      effects[a.receiver] = -parseAmount(record(a.args)?.amount, 'token transfer amount');
    } else if (kind === 'transfer_near_owner' && a.kind === 'Transfer') {
      // The successful root Transfer is the signed amount.
    } else if ((kind === 'storage' || kind === 'storage_owner') && a.method === 'storage_deposit' && a.deposit === MONEY.storageDeposit) {
      // Registration existence is checked against the finalized post-snapshot.
    } else return null;
    effects.native = nativeIn - attached - burnt;
    return { verdict, used, nativeIn, burnt, effects, dcl };
  } catch { return null; }
}
