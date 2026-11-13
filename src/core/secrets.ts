import { createCipheriv, createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from 'node:crypto';
import { inspect } from 'node:util';
import { CoreError, record } from './errors.js';

export class SecretString {
  #value: string;
  constructor(v: string) { this.#value = v; }
  reveal(): string { return this.#value; }
  toJSON(): string { return '[redacted]'; }
  toString(): string { return '[redacted]'; }
  [inspect.custom](): string { return '[redacted]'; }
}

export function loadKek(b64: string | undefined): Buffer {
  const bytes = Buffer.from(b64 ?? '', 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== b64) throw new CoreError('internal', 'Worker KEK must be 32 bytes in base64.');
  return bytes;
}

export function walletAad(b: { id: string; owner: string; walletId: string; agentAccount: string }, purpose: 'api_key' | 'link'): string {
  return JSON.stringify(['4lpha-near wallet v1', b.id, b.owner, b.walletId, b.agentAccount, purpose]);
}

export function seal(kek: Buffer, s: SecretString, aad: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', kek, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(s.reveal(), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function open(kek: Buffer, blob: Buffer, aad: string): SecretString {
  try {
    const decipher = createDecipheriv('aes-256-gcm', kek, blob.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(blob.subarray(12, 28));
    return new SecretString(Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString('utf8'));
  } catch { throw new CoreError('forbidden', 'Wallet secret authentication failed.'); }
}

export interface RelayKey { publicDer: string; privateKey: KeyObject; }
export function newRelayKey(): RelayKey {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return { publicDer: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), privateKey };
}

function relayKey(other: string, own: KeyObject, id: string): Buffer {
  const publicKey = createPublicKey({ key: Buffer.from(other, 'base64'), type: 'spki', format: 'der' });
  if (publicKey.asymmetricKeyType !== 'x25519') throw new CoreError('bad_request', 'Invalid relay key.');
  return Buffer.from(hkdfSync('sha256', diffieHellman({ publicKey, privateKey: own }), '', `4lpha-near reveal v1 ${id}`, 32));
}

export function sealForRelay(link: SecretString, webPublicDer: string, revealId: string): string {
  try {
    const ephemeral = newRelayKey();
    const blob = seal(relayKey(webPublicDer, ephemeral.privateKey, revealId), link, revealId);
    return Buffer.from(JSON.stringify({ epk: ephemeral.publicDer, iv: blob.subarray(0, 12).toString('base64'), ct: blob.subarray(12).toString('base64') })).toString('base64');
  } catch { throw new CoreError('bad_request', 'Invalid relay key.'); }
}

export function openRelay(sealed: string, key: RelayKey, revealId: string): SecretString {
  try {
    const r = record(JSON.parse(Buffer.from(sealed, 'base64').toString('utf8')));
    if (typeof r?.epk !== 'string' || typeof r.iv !== 'string' || typeof r.ct !== 'string') throw new Error();
    return open(relayKey(r.epk, key.privateKey, revealId), Buffer.concat([Buffer.from(r.iv, 'base64'), Buffer.from(r.ct, 'base64')]), revealId);
  } catch { throw new CoreError('forbidden', 'Management link authentication failed.'); }
}
