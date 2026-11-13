import { CoreError } from './errors.js';

export const YOCTO_PER_NEAR = 10n ** 24n;
export const TGAS = 10n ** 12n;
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$(?![\s\S])/;

export function parseAmount(v: unknown, field: string): bigint {
  if (typeof v !== 'string' || !v || /\D/.test(v)) throw new CoreError('bad_amount', `Invalid ${field}.`);
  return BigInt(v);
}

export function fmtUnits(raw: bigint, decimals: number, symbol: string): string {
  const unit = 10n ** BigInt(decimals);
  const abs = raw < 0n ? -raw : raw;
  const fraction = (abs % unit).toString().padStart(decimals, '0').slice(0, 6);
  return `${raw < 0n ? '-' : ''}${abs / unit}${decimals ? `.${fraction}` : ''} ${symbol}`;
}

export function fmtNear(yocto: bigint): string { return fmtUnits(yocto, 24, 'NEAR'); }
export function isAccountId(v: unknown): v is string { return typeof v === 'string' && v.length >= 2 && v.length <= 64 && ACCOUNT_RE.test(v); }
