import test from 'node:test';
import assert from 'node:assert/strict';
import { baseEncode } from 'near-api-js';
import { decodeSignature, newChallenge, verifySigned } from '../src/core/auth.js';
import { openStore } from '../src/core/store.js';
import { fullAccess, identity, testNow } from './helpers.js';

const origin = 'https://app.test';

test('NEP-413 signed answers require FullAccess and canonical purpose, job and timestamp', async () => {
  const c = newChallenge('reveal', 'job-id', testNow), sign = identity(), s = sign(c);
  assert.ok((await verifySigned(c, s, origin, fullAccess, testNow)).ok);
  assert.equal((await verifySigned(c, s, origin, { viewAccessKey: async () => ({ permission: { FunctionCall: {} } }) }, testNow)).ok, false);
  for (const x of [{ ...c, message: 'Changed' }, { ...c, issuedAt: testNow + 1 }, { ...c, purpose: 'resume' as const }, { ...c, jobId: 'elsewhere' }]) {
    assert.equal((await verifySigned(x, s, origin, fullAccess, testNow + 1)).ok, false);
  }
  assert.equal((await verifySigned(c, s, origin, fullAccess, testNow + 300_000)).ok, false);
  for (const callback of [origin, `${origin}/`]) assert.ok((await verifySigned(c, sign(c, callback), origin, fullAccess, testNow)).ok);
});

test('only one use of a nonce; decode base64 and both base58 spellings', () => {
  const c = newChallenge('login', null, testNow);
  const store = openStore(':memory:', 'web');
  try {
    store.putChallenge(c);
    assert.equal(store.useChallenge({ ...c, purpose: 'resume' }, testNow), false);
    assert.equal(store.useChallenge(c, testNow), true);
    assert.equal(store.useChallenge(c, testNow), false);
    const sig = Buffer.alloc(64, 17), b58 = baseEncode(sig);
    for (const s of [sig.toString('base64'), b58, `ed25519:${b58}`]) assert.deepEqual(Buffer.from(decodeSignature(s)), sig);
  } finally { store.close(); }
});
