import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { baseEncode } from 'near-api-js';
import { RECIPIENT, type Challenge, type SignedAnswer } from '../src/core/auth.js';
import { RpcUnavailable, type NearRpc } from '../src/core/near-rpc.js';
import type { OutLayerClient, SubmitResult } from '../src/core/outlayer.js';
import { openStore } from '../src/core/store.js';

export const agent = 'a'.repeat(64), owner = 'owner.near';
export const testNow = 1_800_000_000_000;
export const fixture = (name: string): unknown => JSON.parse(readFileSync(`test/fixtures/${name}.json`, 'utf8'));
export const dummyRpc = (p: Partial<NearRpc> = {}): NearRpc => ({
  query: async () => { throw new RpcUnavailable(); }, view: async () => { throw new RpcUnavailable(); }, viewAccount: async () => null,
  viewAccessKey: async () => ({ fullAccess: true }), txStatus: async () => { throw new RpcUnavailable(); }, holdGasPrice: async () => 1_000_000_000n, ...p,
});
const unavailable = async (): Promise<never> => { throw new Error('Unexpected OutLayer call'); };
export const dummyOutLayer = (p: Partial<OutLayerClient> = {}): OutLayerClient => ({ register: unavailable, encryptPolicy: unavailable, signPolicy: unavailable,
  getPolicy: unavailable, invalidateCache: unavailable, call: unavailable, transfer: unavailable, storageDeposit: unavailable, request: unavailable, ...p });
export const accepted = (txHash: string): SubmitResult => ({ kind: 'accepted', requestId: 'request-test', status: 'success', terminal: true, txHash });
export function identity(accountId = owner) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pk = `ed25519:${baseEncode(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32))}`;
  return (c: Challenge, callbackUrl?: string): SignedAnswer => {
    const u32 = (n: number) => { const out = Buffer.alloc(4); out.writeUInt32LE(n); return out; };
    const str = (s: string) => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s)]);
    const payload = Buffer.concat([u32(2 ** 31 + 413), str(c.message), Buffer.from(c.nonce, 'base64url'), str(RECIPIENT),
      ...(callbackUrl === undefined ? [Buffer.from([0])] : [Buffer.from([1]), str(callbackUrl)])]);
    const digest = createHash('sha256').update(payload).digest();
    return { accountId, nonce: c.nonce, publicKey: pk, signature: sign(null, digest, privateKey).toString('base64') };
  };
}
export const fullAccess = { viewAccessKey: async () => ({ permission: 'FullAccess' }) };

export function stores(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), '4lpha-near-test-')), path = join(dir, 'test.db');
  const web = openStore(path, 'web'), worker = openStore(path, 'worker'), watch = openStore(path, 'watchdog');
  t.after(() => { web.close(); worker.close(); watch.close(); rmSync(dir, { recursive: true }); });
  return { path, web, worker, watch };
}
