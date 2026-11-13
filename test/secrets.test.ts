import test from 'node:test';
import assert from 'node:assert/strict';
import { loadKek, newRelayKey, open, openRelay, seal, sealForRelay, SecretString, walletAad } from '../src/core/secrets.js';
import { agent, owner } from './helpers.js';

test('I-11 and F-3 wallet key and link cannot move across job bindings or purposes', () => {
  const b = { id: 'job-1', owner, walletId: 'wallet-1', agentAccount: agent }, kek = Buffer.alloc(32, 9);
  assert.deepEqual(loadKek(kek.toString('base64')), kek);
  for (const v of [undefined, '', Buffer.alloc(31).toString('base64'), kek.toString('base64') + '!']) assert.throws(() => loadKek(v));
  const value = new SecretString('wk_test_fake');
  for (const purpose of ['api_key', 'link'] as const) {
    const aad = walletAad(b, purpose), blob = seal(kek, value, aad);
    assert.equal(open(kek, blob, aad).reveal(), value.reveal());
    assert.throws(() => open(Buffer.alloc(32), blob, aad));
    for (const wrong of [{ ...b, owner: 'user.near' }, { ...b, id: 'job-2' }, { ...b, walletId: 'wallet-2' }, { ...b, agentAccount: 'b'.repeat(64) }]) {
      assert.throws(() => open(kek, blob, walletAad(wrong, purpose)));
    }
    assert.throws(() => open(kek, blob, walletAad(b, purpose === 'api_key' ? 'link' : 'api_key')));
  }
});

test('I-11 relay is readable only by the request key and reveal id', () => {
  const key = newRelayKey(), result = sealForRelay(new SecretString('https://example.test/?key=wk_test_fake'), key.publicDer, 'r1');
  assert.equal(openRelay(result, key, 'r1').reveal(), 'https://example.test/?key=wk_test_fake');
  assert.throws(() => openRelay(result, key, 'r2'));
  assert.throws(() => openRelay(result, newRelayKey(), 'r1'));
});
