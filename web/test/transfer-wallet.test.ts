import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { Job } from '@/lib/near-format';

// near-wallet.ts bundled with a fake @hot-labs/near-connect: the connector's wallet() returns globalThis.__fakeWallet.
async function load() {
  const { build } = createRequire(import.meta.url)('esbuild') as typeof import('esbuild');
  const fake = `export class NearConnector { constructor() {} wallet() { return globalThis.__fakeWallet ? Promise.resolve(globalThis.__fakeWallet) : Promise.reject(new Error('none')); } on() {} off() {} disconnect() { return Promise.resolve(); } }`;
  const result = await build({ entryPoints: ['web/lib/near-wallet.ts'], bundle: true, write: false, format: 'esm', platform: 'node', tsconfig: 'web/tsconfig.json', logLevel: 'silent',
    plugins: [{ name: 'fake-connect', setup(b) {
      b.onResolve({ filter: /^@hot-labs\/near-connect$/ }, () => ({ path: 'fake', namespace: 'fake' }));
      b.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ contents: fake, loader: 'js' }));
    } }] });
  return await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0]!.text).toString('base64')) as typeof import('@/lib/near-wallet');
}

const job = { id: 'j', owner: 'owner.near' } as Job;
const g = globalThis as unknown as { window?: unknown; __fakeWallet?: unknown };

test('transferWallet: owner check before signing, then exactly one Transfer action on mainnet signed by the owner', async t => {
  const w = await load();
  const signed: unknown[] = [];
  let accounts = [{ accountId: 'someone.near' }];
  g.window = {}; g.__fakeWallet = { manifest: { id: 'meteor-wallet' }, getAccounts: async () => accounts, signAndSendTransaction: async (p: unknown) => { signed.push(p); } };
  t.after(() => { delete g.window; delete g.__fakeWallet; });
  await assert.rejects(w.transferWallet(job, () => true), /Connect the wallet that owns this job/);
  assert.equal(signed.length, 0);
  accounts = [{ accountId: 'someone.near' }, { accountId: 'owner.near' }];
  const send = await w.transferWallet(job, () => true);
  assert.equal(signed.length, 0, 'preflight signs nothing');
  await send('a'.repeat(64), '700000000000000000000000');
  assert.deepEqual(signed, [{ network: 'mainnet', signerId: 'owner.near', receiverId: 'a'.repeat(64), actions: [{ type: 'Transfer', params: { deposit: '700000000000000000000000' } }] }]);
});

test('transferWallet: a selected OKX wallet and the injected-only OKX branch refuse before any signature', async t => {
  const w = await load();
  t.after(() => { delete g.window; delete g.__fakeWallet; });
  g.window = {}; g.__fakeWallet = { manifest: { id: 'okx-wallet' }, getAccounts: async () => [{ accountId: 'owner.near' }], signAndSendTransaction: async () => { throw new Error('should not sign'); } };
  await assert.rejects(w.transferWallet(job, () => true), /cannot send a transfer from the page/);
  g.__fakeWallet = undefined; g.window = { okxwallet: { near: {} } };
  await assert.rejects(w.transferWallet(job, () => true), /cannot send a transfer from the page/);
});
