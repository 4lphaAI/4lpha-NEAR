import { createHash, randomBytes } from 'node:crypto';
import { baseDecode, JsonRpcProvider } from 'near-api-js';
import { verifyMessage } from 'near-api-js/nep413';
import { isAccountId } from './amounts.js';
import { CoreError, record } from './errors.js';
import type { NearRpc } from './near-rpc.js';

export const RECIPIENT = '4lpha-near';
export const CHALLENGE_TTL = 5 * 60_000;
export const SESSION_TTL = 12 * 60 * 60_000;
export interface Challenge { nonce: string; message: string; purpose: 'login' | 'reveal' | 'resume'; jobId: string | null; issuedAt: number; }
export interface SignedMessage { accountId: string; publicKey: string; signature: string; }
export type SignedAnswer = SignedMessage & { nonce: string };
type Provider = Parameters<typeof verifyMessage>[0]['provider'];

function challengeMessage(purpose: Challenge['purpose'], jobId: string | null, issuedAt: number, origin?: string): string {
  return `4lpha NEAR: ${purpose}${jobId === null ? '' : ` job ${jobId}`}\nIssued at ${new Date(issuedAt).toISOString()}${purpose === 'resume' ? `\nOrigin ${origin}` : ''}`;
}

export function newChallenge(purpose: Challenge['purpose'], jobId: string | null, now: number, origin?: string): Challenge {
  if (purpose === 'resume' && !origin) throw new CoreError('bad_request', 'The resume challenge needs an origin.');
  return { nonce: randomBytes(32).toString('base64url'), purpose, jobId, issuedAt: now, message: challengeMessage(purpose, jobId, now, origin) };
}

export function decodeSignature(sig: string): Uint8Array {
  function b58(text: string) { try { const b = baseDecode(text); return b.length === 64 ? b : null; } catch { return null; } }
  function b64() { const b = Buffer.from(sig, 'base64'); return /^[A-Za-z0-9+/]+={0,2}$/.test(sig) && b.length === 64 ? b : null; }
  const decoded = sig.startsWith('ed25519:') ? b58(sig.slice(8)) : sig.endsWith('=') ? b64() ?? b58(sig) : b58(sig) ?? b64();
  if (!decoded) throw new CoreError('unauthorized', 'Invalid signature.');
  return decoded;
}

export function signedAnswer(input: unknown): SignedAnswer {
  const s = record(input);
  if (!isAccountId(s?.accountId) || typeof s.publicKey !== 'string' || s.publicKey.length > 64 || typeof s.signature !== 'string' ||
    s.signature.length > 100 || typeof s.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(s.nonce)) throw new CoreError('unauthorized', 'A signed challenge is required.');
  return { accountId: s.accountId, publicKey: s.publicKey, signature: s.signature, nonce: s.nonce };
}

export function accessKeyProvider(endpoint: string, rpc: NearRpc): Provider {
  const provider = new JsonRpcProvider({ url: endpoint }, { retries: 1 });
  provider.viewAccessKey = async ({ accountId, publicKey }) => {
    const key = await rpc.viewAccessKey(accountId, publicKey.toString());
    if (!key?.fullAccess) throw new CoreError('unauthorized', 'A full-access key is required.');
    return { permission: 'FullAccess', nonce: 0n, block_hash: '', block_height: 0 };
  };
  return provider;
}

export async function verifySigned(c: Challenge, s: SignedMessage, origin: string, provider: unknown, now = Date.now()): Promise<{ ok: true } | { ok: false; reason: string }> {
  const invalid = { ok: false, reason: 'Invalid or expired signature.' } as const;
  try {
    if (!isAccountId(s.accountId) || !Number.isSafeInteger(c.issuedAt) || c.issuedAt > now || now - c.issuedAt >= CHALLENGE_TTL ||
      c.message !== challengeMessage(c.purpose, c.jobId, c.issuedAt, origin)) return invalid;
    const nonce = Buffer.from(c.nonce, 'base64url');
    if (nonce.length !== 32 || nonce.toString('base64url') !== c.nonce) return invalid;
    const signerPublicKey = s.publicKey.startsWith('ed25519:') ? s.publicKey : `ed25519:${s.publicKey}`;
    if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(signerPublicKey)) return invalid;
    const signature = decodeSignature(s.signature);
    for (const callbackUrl of [undefined, origin, `${origin}/`]) {
      try {
        await verifyMessage({ signerAccountId: s.accountId, signerPublicKey, payload: { message: c.message, recipient: RECIPIENT, nonce, callbackUrl }, signature, provider: provider as Provider });
        return { ok: true };
      } catch { /* The wallet may have signed one of the other callback forms. */ }
    }
  } catch { /* Invalid input is never a signature. */ }
  return invalid;
}

export function tokenHash(token: string): string { return createHash('sha256').update(token).digest('hex'); }
export function newSessionToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: tokenHash(token) };
}
