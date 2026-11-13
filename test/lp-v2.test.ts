import assert from 'node:assert/strict';
import test from 'node:test';
import { YOCTO_PER_NEAR as N } from '../src/core/amounts.js';
import { lpAiEnv } from '../src/core/config.js';
import { draftProblems, jobMaxDeposit } from '../src/core/hire.js';
import { lpCentred, lpIntent, lpRangeOk, lpSettingsFromPrices, parseLpSettings, type LpSettings, type LpState } from '../src/core/lp.js';
import { createLpAi, lpAiRange, type LpAiInput } from '../src/core/lp-ai.js';
import { toNearDown } from '../src/core/rhea-dcl.js';
import { owner } from './helpers.js';

const settings: LpSettings = { v: 2, range: { mode: 'server' }, ai: true, compound: { on: true, minFeeBps: 100 }, stopLossPct: 0, takeProfitPct: 0 };
const input: LpAiInput = { poolId: 'pinned-pool', fee: 100, point: 401982, range: { left: 401882, right: 402082 }, bounds: { minWidth: 100, maxWidth: 400 }, history: [] };

test('V2 settings require exact keys, booleans, integer bounds and valid point ranges', () => {
  assert.deepEqual(parseLpSettings(settings), settings);
  for (const [field, values] of Object.entries({ v: [1, '2'], ai: [0, 'true'], stopLossPct: [-1, 91, 1.5, '1'], takeProfitPct: [-1, 501, 0.5, null],
    compound: [{ on: 1 }, { on: false, minFeeBps: 100 }, { on: true }, { on: true, minFeeBps: 9 }, { on: true, minFeeBps: 1001 }, { on: true, minFeeBps: 10.1 }, { on: true, minFeeBps: 10, extra: 0 }],
    range: [{ mode: 'other' }, { mode: 'server', left: 0 }, { mode: 'explicit', left: 0, right: 19 }, { mode: 'explicit', left: 0, right: 2001 },
      { mode: 'explicit', left: -800001, right: -800000 }, { mode: 'explicit', left: 799980, right: 800000 }, { mode: 'explicit', left: 0.5, right: 20.5 }] })) {
    for (const value of values) assert.equal(parseLpSettings({ ...settings, [field]: value }), 'invalid', `${field}: ${JSON.stringify(value)}`);
  }
  for (const field of Object.keys(settings)) { const copy = { ...settings } as Record<string, unknown>; delete copy[field]; assert.equal(parseLpSettings(copy), 'invalid'); }
  assert.equal(parseLpSettings({ ...settings, extra: true }), 'invalid');
  assert.equal(parseLpSettings(null), 'invalid');
  for (const n of [10, 1000]) assert.notEqual(parseLpSettings({ ...settings, compound: { on: true, minFeeBps: n } }), 'invalid');
  assert.notEqual(parseLpSettings({ ...settings, stopLossPct: 90, takeProfitPct: 500, compound: { on: false } }), 'invalid');
});

test('V2 price strings round into points and hire checks range inclusion and deposit scope', () => {
  const { v: _v, ...lp } = settings;
  const price = (p: number) => (1e18 / 1.0001 ** p).toFixed(6);
  const explicit = { ...lp, range: { mode: 'explicit', minPrice: price(402082), maxPrice: price(401882) } };
  const converted = lpSettingsFromPrices(explicit);
  assert.notEqual(converted, 'invalid');
  assert.deepEqual((converted as LpSettings).range, { mode: 'explicit', left: 401882, right: 402082 });
  const draft = { session: { accountId: owner }, kind: 'lp', pair: 'usdc-wnear', mode: 'live', depositYocto: (3n * N).toString(), liveEnabled: true, lpV1: true, liveJobs: 0, ownerPendingLive: 0 };
  assert.deepEqual(draftProblems({ ...draft, lp: explicit, point: 401882 }), []);
  for (const point of [401881, 402082, null]) assert.ok(draftProblems({ ...draft, lp: explicit, point }).length);
  for (const price of ['0', '-1', '1.0000001', '1e1', 'NaN', ' 3', '', 3]) assert.equal(lpSettingsFromPrices({ ...explicit, range: { ...explicit.range, minPrice: price } }), 'invalid');
  assert.equal(lpSettingsFromPrices({ ...explicit, range: { mode: 'explicit', minPrice: '4', maxPrice: '3' } }), 'invalid');
  assert.equal(lpSettingsFromPrices({ ...explicit, extra: true }), 'invalid');
  assert.equal(lpSettingsFromPrices({ ...explicit, range: { ...explicit.range, extra: true } }), 'invalid');
  assert.ok(draftProblems(draft).length, 'row-less LP remains limited to 2 NEAR');
  assert.ok(draftProblems({ ...draft, kind: 'grid', gridV1: true, lp }).length, 'Grid remains limited to 2 NEAR');
  assert.ok(draftProblems({ ...draft, depositYocto: (3n * N + 1n).toString(), lp }).length);
  assert.equal(jobMaxDeposit({ lpV2: true } as Parameters<typeof jobMaxDeposit>[0]), 3n * N);
  assert.equal(jobMaxDeposit({ lpV2: false } as Parameters<typeof jobMaxDeposit>[0]), 2n * N);
});

test('V2 range margins, odd widths and point limits', () => {
  assert.deepEqual(lpCentred(21, 0), { left: -10, right: 11 });
  assert.equal(lpCentred(200, 799900), null);
  assert.equal(lpCentred(200, -799901), null);
  assert.deepEqual(lpCentred(200, -799900), { left: -800000, right: -799800 });
  for (const p of [-8, 8]) assert.equal(lpRangeOk({ left: -10, right: 10 }, p), p === -8);
  assert.equal(lpRangeOk({ left: -10, right: 11 }, -7), true);
  assert.equal(lpRangeOk({ left: -10, right: 11 }, 8), false);
  for (const r of [{ left: 0, right: 19 }, { left: 0, right: 2001 }, { left: -800001, right: -799800 }]) assert.equal(lpRangeOk(r, r.left + 10), false);
});

test('V2 AI fence accepts only two integers inside width and placement bounds', () => {
  assert.deepEqual(lpAiRange(input, { left: 401900, right: 402100 }), { left: 401900, right: 402100, verdict: 'accepted' });
  for (const [proposal, code] of [[null, 'malformed'], [{ left: 1, right: 2, extra: 3 }, 'malformed'], [{ left: 401900.5, right: 402100 }, 'malformed'],
    [{ left: 401950, right: 402000 }, 'width'], [{ left: 401700, right: 402200 }, 'width'], [{ left: 401982, right: 402182 }, 'misplaced']] as const) {
    assert.deepEqual(lpAiRange(input, proposal), { left: 401882, right: 402082, verdict: 'fallback', code });
  }
});

test('V2 AI client bounds headers and body, extracts JSON, and emits only fixed failure codes', async () => {
  const fakeKey = 'fake-ai-value-for-offline-tests';
  const envelope = (content: unknown) => JSON.stringify({ choices: [{ message: { content } }] });
  let calls = 0;
  const ai = createLpAi(fakeKey, undefined, async (url, init) => {
    calls++;
    assert.equal(url, 'https://cloud-api.near.ai/v1/chat/completions');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'z-ai/glm-5.3-flash'); assert.equal(body.temperature, 0); assert.equal(body.max_tokens, 300); assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false }); assert.match(body.messages[0].content, /at least 10 percent of the width on each side/);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(JSON.stringify(body).includes(fakeKey), false);
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${fakeKey}`);
    return new Response(envelope('{"left":401882,"right":402082}'));
  });
  assert.deepEqual(await ai(input, AbortSignal.timeout(20000)), { left: 401882, right: 402082 }); assert.equal(calls, 1);
  for (const [response, code] of [[new Response('unavailable', { status: 503 }), 'http'], [new Response('{}', { status: 201 }), 'http'], [new Response('x'.repeat(16385)), 'malformed'],
    [new Response('{}'), 'malformed'], [new Response(envelope(3)), 'malformed'], [new Response(envelope('bad json')), 'malformed'], [new Response('bad envelope'), 'malformed']] as const) {
    await assert.rejects(createLpAi(fakeKey, undefined, async () => response)(input, new AbortController().signal), { message: code });
  }
  await assert.rejects(createLpAi(fakeKey, undefined, async () => { throw new Error(fakeKey); })(input, new AbortController().signal), { message: 'unavailable' });
  const headerDeadline = new AbortController(), headerTimer = setTimeout(() => headerDeadline.abort(), 5);
  await assert.rejects(createLpAi(fakeKey, undefined, async (_url, init) => {
    await new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error(fakeKey)), { once: true }));
    return new Response('{}');
  })(input, headerDeadline.signal), { message: 'timeout' }); clearTimeout(headerTimer);
  const bodyDeadline = new AbortController(), bodyTimer = setTimeout(() => bodyDeadline.abort(), 5);
  await assert.rejects(createLpAi(fakeKey, undefined, async () => new Response(new ReadableStream<Uint8Array>()))(input, bodyDeadline.signal), { message: 'timeout' });
  clearTimeout(bodyTimer);
  assert.equal(lpAiEnv({}), undefined);
  assert.equal(typeof lpAiEnv({ NEAR_AI_API_KEY: fakeKey }), 'function');
});

test('V2 downward valuation conversion vectors', () => {
  assert.equal(toNearDown(10000n, 1), 10001n);
  assert.equal(toNearDown(10001n, -1), 10000n);
  assert.equal(toNearDown(10001n ** 2n, -2), 10000n ** 2n);
  assert.equal(toNearDown(123n, 0), 123n);
  const v = toNearDown(1000000n, 401982);
  assert.ok(v > 2864069864n * N / 10000000000n && v < 2864069866n * N / 10000000000n);
});

test('V2 removal intent matches its journal-only reason, with missing historical reasons treated as rotation', () => {
  const state: LpState = { ledger: { usdc: '0', wnear: '0', native: '0', inUsdc: '0', inWnear: '0' }, swap: null, position: null, out: null, failures: 0, sequence: 1,
    pending: { id: 'j:1', kind: 'dcl_remove', amount: '1', lptId: 'position', minX: '0', minY: '0' } };
  const args = { lptId: 'position', minX: '0', minY: '0' };
  assert.equal(lpIntent(state, 'dcl_remove', 1n, { ...args, reason: 'rotation' }).id, 'j:1');
  assert.throws(() => lpIntent(state, 'dcl_remove', 1n, { ...args, reason: 'compound' }), { code: 'conflict' });
});

// ---- Phase 3b audit probe (appended in the audit worktree only) ----
test('AUDIT the 16 KiB body cap rejects a valid oversized envelope and accepts one just under the cap', async () => {
  const pad = (total: number) => {
    const head = '{"choices":[{"message":{"content":"{\\"left\\":401882,\\"right\\":402082}"}}],"pad":"', tail = '"}';
    return head + 'p'.repeat(total - head.length - tail.length) + tail;
  };
  const over = pad(16_385), under = pad(16_384);
  assert.equal(Buffer.byteLength(over), 16_385); assert.equal(Buffer.byteLength(under), 16_384);
  assert.deepEqual(JSON.parse(over).choices[0].message.content, '{"left":401882,"right":402082}');
  await assert.rejects(createLpAi('k', undefined, async () => new Response(over))(input, new AbortController().signal), { message: 'malformed' });
  assert.deepEqual(await createLpAi('k', undefined, async () => new Response(under))(input, new AbortController().signal), { left: 401882, right: 402082 });
});

test('AUDIT price grammar: seven fraction digits are refused on their own, six are accepted', () => {
  const lp = { range: { mode: 'explicit', minPrice: '3.1234567', maxPrice: '3.6' }, ai: false, compound: { on: false }, stopLossPct: 0, takeProfitPct: 0 };
  assert.equal(lpSettingsFromPrices(lp), 'invalid');
  assert.notEqual(lpSettingsFromPrices({ ...lp, range: { mode: 'explicit', minPrice: '3.123456', maxPrice: '3.6' } }), 'invalid');
});
