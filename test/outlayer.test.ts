import test from 'node:test';
import assert from 'node:assert/strict';
import { createOutLayerClient } from '../src/core/outlayer.js';
import { SecretString } from '../src/core/secrets.js';
import { USDC } from '../src/core/pins.js';
import { agent, fixture, owner } from './helpers.js';

const key = new SecretString('wk_test_fake');
const base = 'https://outlayer.test';
const client = (file: string, status: number) => createOutLayerClient(base, async () => ({ status, text: async () => JSON.stringify(fixture(file)) }));

test('1.13 registration retains the one-time key even on a non-200 response', async () => {
  for (const [file, status] of [['outlayer-register', 200], ['outlayer-register-non200-with-key', 500]] as const) {
    const { result, error } = await client(file, status).register();
    assert.equal(result?.nearAccountId, agent);
    assert.equal(result?.apiKey.reveal(), 'wk_test_fake');
    assert.equal(Boolean(error), status !== 200);
  }
  assert.equal((await client('outlayer-sign-policy', 200).signPolicy(key, 'QUFBQQ==', owner)).publicKeyHex, agent);
  assert.equal((await client('outlayer-policy-stored', 200).getPolicy(key)).policy, 'stored');
  assert.equal((await client('outlayer-policy-none', 200).getPolicy(key)).policy, 'none');
});

test('10.1 status mapping and redaction of adapter errors', async () => {
  for (const [file, status, kind] of [['outlayer-denied-cap', 403, 'denied'], ['outlayer-denied-whitelist', 403, 'denied'],
    ['outlayer-frozen', 403, 'denied'], ['outlayer-422-e68', 422, 'reverted'], ['outlayer-429', 429, 'quota'], ['outlayer-409', 409, 'busy'],
    ['outlayer-denied-cap', 401, 'rejected'], ['outlayer-422-e68', 503, 'ambiguous']] as const) {
    assert.equal((await client(file, status).transfer(key, owner, 1n, 'idem-test')).kind, kind);
  }
  const bad = createOutLayerClient(base, async () => { throw new Error('wk_test_fake'); });
  await assert.rejects(bad.signPolicy(key, 'QUFBQQ==', owner), e => e instanceof Error && !e.message.includes('wk_test_fake'));
});

test('10.1 a reported wait is honoured from the body first, then Retry-After', async () => {
  const answer = (body: object, retryAfter?: string) => createOutLayerClient(base, async () => ({ status: 429, text: async () => JSON.stringify(body),
    headers: new Headers(retryAfter === undefined ? {} : { 'Retry-After': retryAfter }) })).transfer(key, owner, 1n, 'idem-test');
  assert.deepEqual(await answer({ error: 'rate_limited', retry_after_seconds: 42 }, '7'), { kind: 'quota', retryAfterSeconds: 42 });
  assert.deepEqual(await answer({ error: 'rate_limited' }, '7'), { kind: 'quota', retryAfterSeconds: 7 });
  assert.deepEqual(await answer({ error: 'rate_limited', retry_after_seconds: 0 }, '7'), { kind: 'quota', retryAfterSeconds: 7 });
  for (const absent of ['Wed, 21 Oct 2026 07:28:00 GMT', '0', '-5', '1.5', '1e3', '0x10', '99999999999999999999']) {
    assert.deepEqual(await answer({ error: 'rate_limited' }, absent), { kind: 'quota', retryAfterSeconds: null });
  }
  assert.deepEqual(await answer({ error: 'operation_limit_reached', retry_after_seconds: 42 }), { kind: 'quota', retryAfterSeconds: 42, limitReached: true });
  assert.deepEqual(await answer({ error: 'operation_limit_reached', retry_after_seconds: null }), { kind: 'quota', retryAfterSeconds: null, limitReached: true });
});

test('A5 adapter sets bearer and idempotency and serializes exactly one call or registration', async () => {
  const seen: { path: string; headers: Headers; body: unknown }[] = [];
  const o = createOutLayerClient(base, async (url, init) => {
    seen.push({ path: new URL(url).pathname, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    return { status: 200, text: async () => '{"error":"duplicate_idempotency_key","status":"completed","result":{"tx_hash":"tx-test"}}' };
  });
  assert.deepEqual(await o.call(key, { receiverId: USDC, methodName: 'ft_transfer', args: { amount: '1' }, gas: 30n, deposit: 1n }, 'idem-test'),
    { kind: 'accepted', requestId: null, status: 'completed', terminal: true, txHash: 'tx-test' });
  await o.storageDeposit(key, USDC, owner, 'idem-next');
  assert.equal(seen[0].headers.get('authorization'), 'Bearer wk_test_fake');
  assert.equal(seen[0].headers.get('x-idempotency-key'), 'idem-test');
  assert.deepEqual(seen[0].body, { receiver_id: USDC, method_name: 'ft_transfer', args: { amount: '1' }, gas: '30', deposit: '1' });
  assert.deepEqual(seen[1].body, { token: USDC, account_id: owner });
});

test('sign-policy returns the signed version, locked and valid_until, and refuses an answer without them', async () => {
  const s = await client('outlayer-sign-policy', 200).signPolicy(key, 'QUFBQQ==', owner);
  assert.deepEqual([s.version, s.locked, s.validUntil], [1, false, 1794912708]);
  const answer = (body: object) => createOutLayerClient(base, async () => ({ status: 200, text: async () => JSON.stringify(body) }));
  const good = fixture('outlayer-sign-policy') as Record<string, unknown>;
  for (const body of [{ ...good, version: undefined }, { ...good, locked: 'false' }, { ...good, valid_until: undefined }, { ...good, status: 'pending_approval' }]) {
    await assert.rejects(answer(body).signPolicy(key, 'QUFBQQ==', owner));
  }
});

test('fix 4 F4-4: an ambiguous answer keeps its HTTP status; a failed fetch has none', async () => {
  const reply = (status: number, text: string) => createOutLayerClient(base, async () => ({ status, text: async () => text })).call(key,
    { receiverId: USDC, methodName: 'ft_transfer', args: {}, gas: 30n, deposit: 1n }, 'idem-test');
  assert.deepEqual(await reply(502, '<html>bad gateway</html>'), { kind: 'ambiguous', reason: 'server', http: 502 });
  assert.deepEqual(await reply(408, '{}'), { kind: 'ambiguous', reason: 'server', http: 408 });
  assert.deepEqual(await reply(200, 'not json'), { kind: 'ambiguous', reason: 'unparseable', http: 200 });
  assert.deepEqual(await reply(302, '{}'), { kind: 'ambiguous', reason: 'unparseable', http: 302 });
  const dropped = createOutLayerClient(base, async () => { throw new Error('socket hang up'); });
  assert.deepEqual(await dropped.transfer(key, owner, 1n, 'idem-test'), { kind: 'ambiguous', reason: 'network' });
});
