import test from 'node:test';
import assert from 'node:assert/strict';
import { apiGateProblems, buildRules, chainGateProblems, defaultCaps, policyExtrasProblems, policyHash, readChainPolicy, rulesMismatches, storePayload, walletPubkeyFrom } from '../src/core/policy.js';
import { YOCTO_PER_NEAR as N } from '../src/core/amounts.js';
import { CLASSIC_EXCHANGE, DCL, USDC } from '../src/core/pins.js';
import { agent, dummyRpc, fixture, owner } from './helpers.js';
import { record } from '../src/core/errors.js';

const caps = defaultCaps(N, { [USDC]: 3756475n });
const input = { owner, tokens: [USDC], usesDcl: false, caps, depositYocto: N, maxDeposit: 2n * N };
const api = { http: 200, policy: 'stored', frozen: false, rules: record(fixture('outlayer-policy-stored'))?.rules, capabilities: null, approval: null };

test('D-1 exact rules and quote vector for USDC/wNEAR', () => {
  const rules = buildRules(input);
  assert.deepEqual(rules, api.rules);
  assert.ok(!rules.addresses.list.includes(CLASSIC_EXCHANGE) && !rules.addresses.list.includes(DCL));
  assert.ok(buildRules({ ...input, usesDcl: true }).addresses.list.includes(DCL));
  for (const i of [{ ...input, caps: { ...caps, nativePerTx: 26n * N / 100n } }, { ...input, caps: { ...caps, nativeDaily: 3n * N + 1n } },
    { ...input, tokens: ['fake.near'] }, { ...input, owner: 'x' }]) assert.throws(() => buildRules(i));
  assert.ok(rulesMismatches(rules, { ...rules, transaction_types: ['transfer', 'call', 'delete'] }).length);
  assert.ok(rulesMismatches(rules, { ...rules, limits: { ...rules.limits, hourly: {} } }).length);
});

test('1.13 policy key, exact chain owner, freeze and ciphertext hash; controller is ignored', async () => {
  const r = await readChainPolicy(dummyRpc({ view: async () => ({ height: 12, value: fixture('chain-policy-entry') }) }), `ed25519:${agent}`);
  assert.ok(r.entry);
  const h = policyHash(r.entry);
  assert.deepEqual(chainGateProblems(r.entry, owner, false, h), []);
  assert.deepEqual(chainGateProblems({ ...r.entry, owner: 'user.near', frozen: true, encrypted: 'BBBB' }, owner, false, h), ['owner_mismatch', 'frozen', 'policy_changed']);
  assert.deepEqual(chainGateProblems(null, owner, false, h), ['policy_missing']);
  assert.deepEqual(apiGateProblems(api, buildRules(input), false), []);
  assert.equal(policyExtrasProblems({ ...api, capabilities: { raw_sign: { allowed: true } }, approval: { approvers: [owner] } }).length, 2);
  assert.equal(walletPubkeyFrom(agent, agent), `ed25519:${agent}`);
  assert.throws(() => walletPubkeyFrom('b'.repeat(64), agent));
  const estimate = 15210000000000000000000n;
  assert.equal(storePayload(`ed25519:${agent}`, 'QUFBQQ==', { signatureHex: 'b'.repeat(128), version: 1, locked: false, validUntil: 1794912708 }, owner, estimate).deposit, (estimate + estimate / 10n + 1n).toString());
  await assert.rejects(readChainPolicy(dummyRpc({ view: async () => ({ height: 12, value: { owner } }) }), `ed25519:${agent}`));
});

test('store_wallet_policy payload carries the signed version, locked and valid_until (contract change seen 2026-11-10)', () => {
  const signed = { signatureHex: 'b'.repeat(128), version: 3, locked: false, validUntil: 1794912708 };
  const p = storePayload(`ed25519:${agent}`, 'QUFBQQ==', signed, owner, 15210000000000000000000n);
  assert.deepEqual(Object.keys(p.args).sort(), ['encrypted_data', 'locked', 'valid_until', 'version', 'wallet_pubkey', 'wallet_signature']);
  assert.deepEqual([p.args.version, p.args.locked, p.args.valid_until], [3, false, 1794912708]);
  for (const bad of [{ ...signed, locked: true }, { ...signed, version: 0 }, { ...signed, version: 1.5 }, { ...signed, validUntil: 0 }]) {
    assert.throws(() => storePayload(`ed25519:${agent}`, 'QUFBQQ==', bad, owner, 15210000000000000000000n));
  }
});

test('an approval echo with locked false and no approvers is accepted; a locked or approver-carrying one is not', () => {
  const base = { http: 200, policy: 'stored', frozen: false, rules: {}, capabilities: null } as const;
  assert.deepEqual(policyExtrasProblems({ ...base, approval: { approvers: [], locked: false } }), []);
  assert.equal(policyExtrasProblems({ ...base, approval: { approvers: [], locked: true } }).length, 1);
  assert.equal(policyExtrasProblems({ ...base, approval: { approvers: [owner], locked: false } }).length, 1);
});
