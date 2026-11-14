import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVITY_URL, createActivity } from '../src/core/activity.js';

const flush = () => new Promise(r => setTimeout(r, 0));
function fake(statuses: (number | 'throw')[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const s = statuses.shift() ?? 200;
    if (s === 'throw') throw new Error('network');
    return new Response('{}', { status: s });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const event = { eventType: 'agent.hired', actor: 'alice.near', idempotencyKey: 'job:1:hired', payload: { agent: 'grid' } };

test('activity is off without a key', () => {
  assert.equal(createActivity(undefined), undefined);
  assert.equal(createActivity(''), undefined);
});

test('activity posts the event with the bearer key and returns without waiting', async () => {
  const { f, calls } = fake([200]);
  const report = createActivity('act_test_fake', f, async () => {})!;
  assert.equal(report(event), undefined);
  await flush(); await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ACTIVITY_URL);
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer act_test_fake');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { payload: { agent: 'grid' }, eventType: 'agent.hired', actor: 'alice.near', idempotencyKey: 'job:1:hired' });
});

test('activity retries 503 and network errors with the same body, at most three tries, and never throws', async () => {
  const errors: string[] = [], orig = console.error;
  console.error = (m: string) => { errors.push(m); };
  try {
    const a = fake([503, 'throw', 200]);
    createActivity('k', a.f, async () => {})!(event);
    for (let i = 0; i < 10; i++) await flush();
    assert.equal(a.calls.length, 3);
    assert.equal(new Set(a.calls.map(c => c.init.body)).size, 1);
    const b = fake(['throw', 'throw', 'throw', 200]);
    createActivity('k', b.f, async () => {})!(event);
    for (let i = 0; i < 10; i++) await flush();
    assert.equal(b.calls.length, 3);
    assert.deepEqual(errors, ['Activity report agent.hired failed: unavailable']);
  } finally { console.error = orig; }
});

test('activity does not retry a final refusal and logs no key', async () => {
  const errors: string[] = [], orig = console.error;
  console.error = (m: string) => { errors.push(m); };
  try {
    const a = fake([409]);
    createActivity('act_secret_value', a.f, async () => {})!(event);
    for (let i = 0; i < 5; i++) await flush();
    assert.equal(a.calls.length, 1);
    assert.deepEqual(errors, ['Activity report agent.hired refused: HTTP 409']);
  } finally { console.error = orig; }
});
