import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { redact, redactText } from '../src/core/errors.js';
import { SecretString } from '../src/core/secrets.js';

test('I-11 secrets redact in logs, nested objects and JSON', () => {
  const s = new SecretString('wk_test_fake');
  assert.equal(JSON.stringify({ s }), '{"s":"[redacted]"}');
  assert.equal(inspect(s), '[redacted]');
  assert.equal(String(s), '[redacted]');
  assert.deepEqual(redact({ rows: [{ API_KEY: 'abcdef', nested: { link: 'value' } }] }), { rows: [{ API_KEY: '[redacted]', nested: { link: '[redacted]' } }] });
  assert.equal(redactText('wk_test_fake https://example.test/?key=secret&x=1'), 'wk_[redacted] https://example.test/?key=[redacted]&x=1');
});
