import { createHash } from 'node:crypto';
import { isAccountId, parseAmount, YOCTO_PER_NEAR as N } from './amounts.js';
import { CoreError, record } from './errors.js';
import { RpcUnavailable, type NearRpc } from './near-rpc.js';
import type { ApiPolicyView } from './outlayer.js';
import { DCL, GAS, GRID_LP_TOKENS, MONEY, OUTLAYER_CONTRACT, WNEAR } from './pins.js';

export interface Caps { nativePerTx: bigint; nativeDaily: bigint; tokenPerTx: Readonly<Record<string, bigint>>; tokenDaily: Readonly<Record<string, bigint>>; }
export interface PolicyInput { owner: string; depositYocto: bigint; maxDeposit: bigint; tokens: readonly string[]; usesDcl: boolean; caps: Caps; }
export interface PolicyRules {
  transaction_types: ['transfer', 'call']; allowed_tokens: string[];
  addresses: { mode: 'whitelist'; list: string[] };
  limits: { per_transaction: Record<string, string>; daily: Record<string, string> };
  rate_limit: { max_per_hour: 30 };
}

export function defaultCaps(depositYocto: bigint, tokenPerNear: Readonly<Record<string, bigint>>): Caps {
  const tokenPerTx = Object.fromEntries(Object.entries(tokenPerNear).map(([id, price]) => [id, 2n * (depositYocto * price / N)]));
  tokenPerTx[WNEAR] = 2n * depositYocto;
  return { nativePerTx: MONEY.nativePerTxCeiling, nativeDaily: 3n * depositYocto,
    tokenPerTx, tokenDaily: Object.fromEntries(Object.entries(tokenPerTx).map(([id, cap]) => [id, 10n * cap])) };
}

export function buildRules(i: PolicyInput): PolicyRules {
  const { owner, tokens, caps } = i;
  const all = [WNEAR, ...tokens];
  const allowedKeys = (map: Readonly<Record<string, bigint>>) => Object.keys(map).length === all.length && all.every(t => Object.hasOwn(map, t));
  if (!isAccountId(owner) || i.depositYocto < MONEY.minDeposit || i.depositYocto > i.maxDeposit ||
    new Set(all).size !== all.length || tokens.some(t => !GRID_LP_TOKENS.includes(t)) || caps.nativePerTx < N / 500n ||
    caps.nativePerTx > MONEY.nativePerTxCeiling || caps.nativeDaily < caps.nativePerTx || caps.nativeDaily > 3n * i.depositYocto ||
    !allowedKeys(caps.tokenPerTx) || !allowedKeys(caps.tokenDaily) || all.some(t => caps.tokenPerTx[t] <= 0n || caps.tokenDaily[t] < caps.tokenPerTx[t])) {
    throw new CoreError('policy_invalid', 'Wallet policy limits or destinations are invalid.');
  }
  const limits = (native: bigint, map: Readonly<Record<string, bigint>>) => ({ native: native.toString(), ...Object.fromEntries(all.map(t => [`nep141:${t}`, map[t].toString()])) });
  return { transaction_types: ['transfer', 'call'], allowed_tokens: ['native', ...all.map(t => `nep141:${t}`)],
    addresses: { mode: 'whitelist', list: [...new Set([owner, ...all, ...(i.usesDcl ? [DCL] : [])])] },
    limits: { per_transaction: limits(caps.nativePerTx, caps.tokenPerTx), daily: limits(caps.nativeDaily, caps.tokenDaily) },
    rate_limit: { max_per_hour: 30 } };
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).sort().join(',')}]`;
  const r = record(v);
  if (r) return `{${Object.keys(r).sort().map(k => `${JSON.stringify(k)}:${canonical(r[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'undefined';
}

export function rulesMismatches(expected: PolicyRules, actual: unknown): string[] {
  const a = record(actual);
  if (!a) return ['Rules are missing.'];
  return Object.keys({ ...a, ...expected }).filter(k => canonical(a[k]) !== canonical(expected[k as keyof PolicyRules]));
}

export function policyExtrasProblems(api: ApiPolicyView): string[] {
  const caps = record(api.capabilities);
  const approval = record(api.approval);
  const p: string[] = [];
  if (api.capabilities != null && (!caps || Object.values(caps).some(v => record(v)?.allowed !== false))) p.push('An enabled or unknown capability is set.');
  if (api.approval != null && (!approval || Object.entries(approval).some(([k, v]) => k === 'locked' ? v !== false : k !== 'approvers' || !Array.isArray(v) || v.length !== 0))) p.push('An approval is set.');
  return p;
}

export function walletPubkeyFrom(publicKeyHex: unknown, nearAccountId: string): string {
  if (typeof publicKeyHex !== 'string' || !/^[0-9a-f]{64}$/.test(publicKeyHex) || publicKeyHex !== nearAccountId) throw new CoreError('policy_invalid', 'The policy signing key does not match the wallet.');
  return `ed25519:${publicKeyHex}`;
}

export interface ChainPolicyEntry { owner: string; frozen: boolean; storageDeposit: bigint; encrypted: string; }
export async function readChainPolicy(rpc: NearRpc, walletPubkey: string, snapshot?: { block: number; blockId: string }): Promise<{ height: number; entry: ChainPolicyEntry | null }> {
  const { height, value, blockId } = await rpc.view(OUTLAYER_CONTRACT, 'get_wallet_policy', { wallet_pubkey: walletPubkey }, snapshot?.blockId);
  if (snapshot && (height !== snapshot.block || blockId !== snapshot.blockId)) throw new RpcUnavailable();
  if (value === null) return { height, entry: null };
  const v = record(value);
  if (!isAccountId(v?.owner) || typeof v.frozen !== 'boolean' || typeof v.encrypted_data !== 'string' || !v.encrypted_data) throw new RpcUnavailable();
  try { return { height, entry: { owner: v.owner, frozen: v.frozen, encrypted: v.encrypted_data, storageDeposit: parseAmount(v.storage_deposit, 'policy storage deposit') } }; }
  catch { throw new RpcUnavailable(); }
}

export function policyHash(entry: ChainPolicyEntry): string { return createHash('sha256').update(entry.encrypted).digest('hex'); }
export function chainGateProblems(entry: ChainPolicyEntry | null, owner: string, expectFrozen: boolean, armedHash: string | null): string[] {
  if (!entry) return ['policy_missing'];
  const p: string[] = [];
  if (entry.owner !== owner) p.push('owner_mismatch');
  if (entry.frozen !== expectFrozen) p.push(entry.frozen ? 'frozen' : 'unfrozen');
  if (armedHash !== null && policyHash(entry) !== armedHash) p.push('policy_changed');
  return p;
}

export function apiGateProblems(api: ApiPolicyView, expected: PolicyRules, expectFrozen: boolean): string[] {
  return [...(api.http !== 200 || api.policy !== 'stored' ? ['Policy is not stored in OutLayer.'] : []),
    ...(api.frozen !== expectFrozen ? ['OutLayer freeze state differs.'] : []), ...rulesMismatches(expected, api.rules), ...policyExtrasProblems(api)];
}

export interface StorePolicyPayload {
  receiverId: 'outlayer.near'; methodName: 'store_wallet_policy'; caller: string; gas: string; deposit: string;
  args: { wallet_pubkey: string; encrypted_data: string; wallet_signature: string; version: number; locked: false; valid_until: number };
}
export function storePayload(walletPubkey: string, encrypted: string, signed: { signatureHex: string; version: number; locked: boolean; validUntil: number }, caller: string, estimate: bigint): StorePolicyPayload {
  const { signatureHex, version, locked, validUntil } = signed;
  // The product never sets an approval quorum, so a locked policy is refused rather than stored.
  if (estimate <= 0n || estimate > MONEY.policyCostCeiling || !/^ed25519:[0-9a-f]{64}$/.test(walletPubkey) ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encrypted) || !/^[0-9a-f]{128}$/.test(signatureHex) || !isAccountId(caller) ||
    !Number.isSafeInteger(version) || version < 1 || locked !== false || !Number.isSafeInteger(validUntil) || validUntil < 1) {
    throw new CoreError('policy_invalid', 'Wallet policy payload or storage estimate is invalid.');
  }
  return { receiverId: OUTLAYER_CONTRACT, methodName: 'store_wallet_policy', caller, gas: GAS.storePolicy.toString(),
    deposit: (estimate + estimate / 10n + 1n).toString(), args: { wallet_pubkey: walletPubkey, encrypted_data: encrypted, wallet_signature: signatureHex, version, locked, valid_until: validUntil } };
}
