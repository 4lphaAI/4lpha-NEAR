export type ErrorCode = 'bad_request' | 'bad_amount' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict'
  | 'live_disabled' | 'limit_reached' | 'policy_invalid' | 'rpc_unavailable' | 'outlayer_error' | 'market_data_unconfigured' | 'market_data_unavailable' | 'internal';

export class CoreError extends Error {
  constructor(readonly code: ErrorCode, message: string) { super(redactText(message)); }
}

export interface Envelope<T> {
  data: T | null;
  error?: { code: ErrorCode; message: string };
  meta?: Record<string, string | number | boolean>;
}

export function ok<T>(data: T, meta?: Envelope<T>['meta']): Envelope<T> { return meta ? { data, meta } : { data }; }
export function fail(code: ErrorCode, message: string): Envelope<never> { return { data: null, error: { code, message: redactText(message) } }; }

export function redactText(s: string): string {
  return s.replace(/wk_[A-Za-z0-9_-]+/g, 'wk_[redacted]').replace(/([?&]key=|\bkey=)[^&#\s"']+/gi, '$1[redacted]');
}

const SECRET_FIELDS = new Set(['api_key', 'handoff_url', 'key', 'authorization', 'link']);
export function redact(v: unknown): unknown {
  if (typeof v === 'string') return redactText(v);
  if (Array.isArray(v)) return v.map(redact);
  if (v instanceof Error) return redactText(v.message);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, value]) => [k, SECRET_FIELDS.has(k.toLowerCase()) ? '[redacted]' : redact(value)]));
  return v;
}

export function record(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
}
