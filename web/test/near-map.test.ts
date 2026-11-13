import { test } from "node:test";
import assert from "node:assert/strict";
import { priceAtTick } from "@/lib/exec/pairs";
import { priceFromTick } from "@/lib/lp/range";
import { sequenceOutcome } from "@/lib/exec/agent-detail";
import {
  USDC, WNEAR, DCL, asset, depositYocto, exactNear, fmt, freezeCall, fundingLine, isDclRegistrationPayload, isPolicyPayload,
  priceUsdcPerNear, setupStep, type Job, type Payload,
} from "@/lib/near-format";
import { parseMarketDataResponse, snapMarkers, type Candle } from "@/lib/market-data";
import { listedJob, nearRangeContains, retirable, rowPresentation, tickOf, TRADE_POOL_KEY, toAgentDetailView, toPortfolio, usdMicros, valuation } from "@/lib/near-map";

const NEAR = (n: string) => (BigInt(Math.round(Number(n) * 1e6)) * 10n ** 18n).toString();
const POINT = 401982; // about 3.4915 USDC per NEAR
const AGENT = "3f9c0d7be21a4c6f8b5d2e7a9c1f0b3d6e8a2c4f7b9d1e3a5c7f9b2d4e6a8c0e";

function base(over: Partial<Job> = {}): Job {
  return {
    id: "78bae146-0000-4000-8000-000000000001", owner: "owner.near", kind: "grid", state: "running", reason: null,
    depositYocto: NEAR("1"), agentAccount: AGENT, walletPubkey: "ed25519:abc", agentBalance: NEAR("0.5"), ownerBalance: NEAR("4"),
    payload: null, canReveal: true, linkDelivered: true, linkConfirmed: true, canFund: false, frozen: false, canStopEarly: true, waitingForChain: false, blindHalt: false, canResumeBlind: false, resumeBlockedReason: null,
    grid: null, lp: null, pendingSubmission: null, holdings: { tokens: { [WNEAR]: "0", [USDC]: "0" }, block: 1 }, extraTokens: [],
    operations: [], alerts: [], ...over,
  };
}

const grid = (over: Partial<NonNullable<Job["grid"]>> = {}): NonNullable<Job["grid"]> => ({
  available: true, enabled: true, issued: true, registered: true, canRegister: false, point: POINT, anchor: POINT,
  internal: { [WNEAR]: NEAR("0.1") }, lost: {}, positions: 0, lanes: [],
  orders: [
    { id: "17384", sell: USDC, buy: WNEAR, point: POINT + 100, remain: "347330", bought: NEAR("9"), unclaimed: "0" },
    { id: "17387", sell: WNEAR, buy: USDC, point: POINT - 100, remain: NEAR("0.1"), bought: "999999", unclaimed: "1000" },
  ], ...over,
});

const lp = (over: Partial<NonNullable<Job["lp"]>> = {}): NonNullable<Job["lp"]> => ({
  available: true, enabled: true, issued: true, registered: true, canRegister: false, point: POINT, internal: {}, lost: {}, positions: 1,
  ledger: { usdc: "0", wnear: "0", native: "0", inUsdc: "0", inWnear: "0" }, rotations: 1, pending: null,
  range: { left: POINT - 100, right: POINT + 100, leftPrice: 3.53, rightPrice: 3.45, inRange: true, outSince: null },
  position: { id: "usdc|wrap.near|100#26228", liquidity: "123", paidX: "700000", paidY: NEAR("0.2"), fees: ["1000", NEAR("0.001")], estimate: ["698000", NEAR("0.2")] },
  ...over,
});

test("orientation: the copied price code reads USDC per NEAR at tick = -point", () => {
  const expected = priceUsdcPerNear(POINT)!;
  const pair = { chainId: 56 as const, token0: "", token1: "", symbol0: "wNEAR", symbol1: "USDC", decimals0: 24, decimals1: 6, wbnbIsToken0: true };
  assert.ok(Math.abs(Number(priceAtTick(tickOf(POINT), pair)) / expected - 1) < 1e-6);
  const lpPrice = priceFromTick(tickOf(POINT), { quoteIsToken0: false, decimals0: 24, decimals1: 6 } as never);
  assert.ok(Math.abs(lpPrice / expected - 1) < 1e-6);
  assert.ok(expected > 3 && expected < 4);
});

test("valuation: grid counts internal, remain and unclaimed, never bought", () => {
  const price = priceUsdcPerNear(POINT)!;
  const v = valuation(base({ grid: grid() }));
  const near = (n: number) => BigInt(Math.round(n * price * 1e6));
  assert.equal(v.available, near(0.5));
  // internal 0.1 wNEAR + 0.347330 USDC + 0.1 wNEAR + 0.001 USDC unclaimed
  assert.equal(v.deployed, near(0.1) + 347330n + near(0.1) + 1000n);
  assert.equal(v.total, v.available! + v.deployed!);
  assert.equal(v.partial, false);
});

test("valuation: unreadable DCL, lost-found and unknown tokens are not complete", () => {
  assert.equal(valuation(base({ grid: grid({ available: false }) })).deployed, null);
  assert.equal(valuation(base({ grid: grid({ point: null }) })).total, null);
  assert.equal(valuation(base({ grid: grid({ lost: { [USDC]: "5" } }) })).partial, true);
  assert.equal(valuation(base({ grid: grid({ positions: 1 }) })).partial, true);
  assert.equal(valuation(base({ grid: grid({ internal: { "other.near": "5" } }) })).deployed, null);
  assert.equal(valuation(base({ agentBalance: null, grid: grid() })).available, null);
});

test("valuation: LP adds the estimate, not the fees; a known position without estimate is unavailable", () => {
  const price = priceUsdcPerNear(POINT)!;
  const v = valuation(base({ kind: "lp", lp: lp() }));
  assert.equal(v.deployed, 698000n + BigInt(Math.round(0.2 * price * 1e6)));
  const missing = lp();
  assert.equal(valuation(base({ kind: "lp", lp: { ...missing, position: { ...missing.position!, estimate: null } } })).deployed, null);
  assert.equal(valuation(base({ kind: "lp", lp: lp({ positions: 2 }) })).partial, true);
  // fee inclusion of the estimate is unproven: an LP value is never complete
  assert.equal(v.partial, true);
  assert.equal(valuation(base({ kind: "lp", lp: lp({ position: null, positions: 0 }) })).partial, false);
});

test("usdMicros", () => {
  assert.equal(usdMicros(USDC, "1500000", null), 1500000n);
  assert.equal(usdMicros(WNEAR, NEAR("2"), 3.5), 7000000n);
  assert.equal(usdMicros(WNEAR, NEAR("2"), null), null);
  assert.equal(usdMicros(WNEAR, "0", null), 0n);
  assert.equal(usdMicros("x.near", "5", 3), null);
});

const STATES = ["draft", "registered", "policy_prepared", "armed", "link_confirmed", "funded", "ready", "running", "frozen", "paused", "resuming", "halted", "stopping", "stopped", "failed", "cancelled"];

test("account rows: every job state has a section, label and status", () => {
  for (const state of STATES) {
    const r = rowPresentation(base({ state, grid: grid() }));
    assert.ok(r.statusLabel.length > 0 && !r.statusLabel.includes("_"), state);
    assert.equal(r.section === "setup", ["draft", "registered", "policy_prepared", "armed", "link_confirmed", "funded"].includes(state), state);
  }
  assert.equal(rowPresentation(base({ state: "halted" })).statusLabel, "Halted");
  assert.equal(rowPresentation(base({ state: "running", waitingForChain: true })).statusLabel, "Waiting");
  assert.equal(rowPresentation(base({ state: "running", frozen: true })).statusLabel, "Frozen");
  assert.equal(rowPresentation(base({ state: "stopped", frozen: true })).statusLabel, "Stopped");
  const p = toPortfolio(STATES.map(state => base({ state, grid: grid() })), "owner.near", 0);
  assert.equal(p.agents.length, STATES.length);
  assert.equal(p.agents.filter(a => a.status === "retired").length, 3);
});

test("portfolio totals use the same jobs for wallet, deployed and total", () => {
  const known = valuation(base({ grid: grid() }));
  const p = toPortfolio([base({ grid: grid() }), base({ grid: grid({ available: false }) })], "owner.near", 0);
  assert.equal(p.coverage.deployed.state, "partial");
  assert.equal(p.totals.deployedUsdMicros, known.deployed!.toString());
  assert.equal(p.totals.walletUsdMicros, known.available!.toString());
  assert.equal(p.totals.totalUsdMicros, known.total!.toString());
  assert.equal(BigInt(p.totals.walletUsdMicros!) + BigInt(p.totals.deployedUsdMicros!), BigInt(p.totals.totalUsdMicros!));
  // known wallet, unknown DCL: the wallet column is not complete either
  assert.equal(p.coverage.wallet.state, "partial");
  // unknown wallet, known DCL
  const q = toPortfolio([base({ grid: grid() }), base({ agentBalance: null, grid: grid() })], "owner.near", 0);
  assert.equal(q.coverage.deployed.state, "partial");
  assert.equal(q.coverage.wallet.state, "partial");
  assert.equal(q.totals.deployedUsdMicros, known.deployed!.toString());
  assert.equal(toPortfolio([], "owner.near", 0).coverage.total.state, "empty");
});

test("operations map to sequences the copied filters understand", () => {
  const ops = [
    { id: "a", kind: "dcl_claim", verdict: "success", state: "finished", txHash: "h1", message: "order 17387", createdAt: 1000, finishedAt: 2000 },
    { id: "b", kind: "swap", verdict: null, state: "submitted", txHash: null, message: null, createdAt: 3000, finishedAt: null },
    { id: "c", kind: "dcl_place", verdict: "refunded", state: "finished", txHash: "h3", message: "slippage", createdAt: 4000, finishedAt: 5000 },
  ];
  const view = toAgentDetailView(base({ grid: grid(), operations: ops }), 10_000);
  assert.deepEqual(view.sequences.map(s => sequenceOutcome(s)), ["succeeded", "in-flight", "failed"]);
  assert.equal(view.sequences[2]!.recoveryState, "refunded");
  assert.equal(view.sequences[2]!.note, "slippage");
  assert.equal(view.sequences[0]!.updatedAt, 2000);
  assert.equal(view.sequences[2]!.state, "rolled-back");
  assert.ok(view.sequences.every(s => s.positionId === ""));
  assert.equal(view.motions.length, 0);
  const amb = toAgentDetailView(base({ grid: grid(), operations: [{ ...ops[1]!, state: "ambiguous" }] }), 0);
  assert.equal(amb.sequences[0]!.state, "held");
  assert.equal(sequenceOutcome(amb.sequences[0]!), "failed");
  assert.equal(view.grid.pool, "rhea-dcl-usdc-wnear");
  assert.equal(toAgentDetailView(base({ kind: "lp", lp: lp() }), 0).lp!.pool!.poolAddress, "rhea-dcl-usdc-wnear");
  assert.equal(view.grid.token0, "");
});

test("lp pending step is the only sequence tied to the position", () => {
  const view = toAgentDetailView(base({ kind: "lp", lp: lp({ pending: { kind: "dcl_remove" } }), operations: [{ id: "x", kind: "swap", verdict: "refunded", state: "finished", txHash: null, message: null, createdAt: 1, finishedAt: 2 }] }), 0);
  assert.equal(view.sequences[0]!.positionId, "usdc|wrap.near|100#26228");
  assert.equal(view.sequences[0]!.state, "active");
  assert.equal(view.sequences[1]!.positionId, "");
  assert.equal(view.sequences[0]!.sequenceId, "pending");
  assert.equal(view.sequences[0]!.updatedAt, 0); // nowMs passed as 0 here: the pending step is dated at the last poll, never earlier
  const later = toAgentDetailView(base({ kind: "lp", lp: lp({ pending: { kind: "dcl_remove" } }) }), 5_000);
  assert.equal(later.sequences[0]!.updatedAt, 5_000);
});

test("range membership keeps the server rule left <= point < right after negation", () => {
  const left = POINT - 100, right = POINT + 100;
  const view = toAgentDetailView(base({ kind: "lp", lp: lp({ range: { left, right, leftPrice: 0, rightPrice: 0, inRange: null, outSince: null } }) }), 0);
  const r = view.lp!.liveRange!;
  const inside = (point: number) => nearRangeContains(tickOf(point), r.tickLower, r.tickUpper);
  assert.equal(inside(left), true);
  assert.equal(inside(left - 1), false);
  assert.equal(inside(right - 1), true);
  assert.equal(inside(right), false);
  assert.ok(Math.abs(priceFromTick(r.tickLower, { quoteIsToken0: false, decimals0: 24, decimals1: 6 } as never) / priceUsdcPerNear(right)! - 1) < 1e-9);
});

test("lp v2 settings, invalid settings and the V2 position size reach the copied view", () => {
  const v2 = toAgentDetailView(base({ kind: "lp", lp: lp({ settings: { ai: true, compound: { on: true, minFeeBps: 100 }, stopLossPct: 20, takeProfitPct: 0 }, initialPosition: NEAR("1.2") }) }), 0);
  assert.equal(v2.lp!.settings!.autoHarvest, true);
  assert.equal(v2.lp!.settings!.stopLossPct, 20);
  assert.equal(v2.lp!.settings!.takeProfitPct, null);
  assert.equal(v2.lp!.settings!.rotateMinHoldMinutes, 5);
  assert.equal(v2.lp!.budgetWei, NEAR("1.2"));
  assert.equal(v2.lp!.settingsTrusted, true);
  const bad = toAgentDetailView(base({ kind: "lp", lp: lp({ settings: "invalid" }) }), 0);
  assert.equal(bad.lp!.settingsTrusted, false);
  assert.equal(bad.lp!.settingsReason, "LP settings are unreadable. Stop and withdraw.");
  assert.equal(bad.lp!.settings, null);
  const off = toAgentDetailView(base({ kind: "lp", depositYocto: NEAR("2"), lp: lp({ settings: { ai: false, compound: { on: false }, stopLossPct: 0, takeProfitPct: 25 }, initialPosition: NEAR("1.2") }) }), 0);
  assert.equal(off.lp!.settings!.autoHarvest, false);
  assert.equal(off.lp!.settings!.takeProfitPct, 25);
  assert.equal(off.lp!.settings!.stopLossPct, null);
  // a 2 NEAR V2 deposit gives a 1.2 NEAR position (deposit minus the 0.8 NEAR reserve, set by the server)
  assert.equal(off.lp!.budgetWei, NEAR("1.2"));
  assert.equal(toAgentDetailView(base({ kind: "lp", lp: lp({ settings: "invalid", initialPosition: NEAR("0.4") }) }), 0).lp!.budgetWei, NEAR("0.4"));
  assert.equal(toAgentDetailView(base({ kind: "lp", lp: lp() }), 0).lp!.budgetWei, "400000000000000000000000");
});

test("lp view ranges are ordered and prices match", () => {
  const view = toAgentDetailView(base({ kind: "lp", lp: lp() }), 0);
  const r = view.lp!.liveRange!;
  assert.ok(r.tickLower < r.tickUpper);
  assert.equal(view.lp!.pool!.fee, 100);
  assert.equal(view.positions.length, 1);
  assert.match(view.positions[0]!.value.value!, /^\$\d+\.\d\d$/);
});

test("format helpers moved from app.ts", () => {
  assert.equal(fmt(null), "Unavailable");
  assert.equal(fmt(NEAR("1.5")), "1.500000 NEAR");
  assert.equal(exactNear(10n ** 24n + 5n), "1.000000000000000000000005 NEAR");
  assert.equal(asset(USDC, "1500000"), "1.500000 USDC");
  assert.equal(asset(WNEAR, NEAR("0.1")), "0.1 wNEAR");
  assert.equal(depositYocto(" 1.2 "), 12n * 10n ** 23n);
  for (const bad of ["", "-1", "1.0000000000000000000000001", "abc", "1e3"]) assert.throws(() => depositYocto(bad));
  const job = base({ canFund: true, agentBalance: NEAR("0.25") });
  assert.equal(fundingLine(job), `From your wallet's Send screen, send 0.75 NEAR to ${AGENT}. Verify the recipient before sending.`);
  assert.match(fundingLine(base({ agentBalance: null })), /send 1 NEAR to/);
  assert.deepEqual(freezeCall(job, false), { receiverId: "outlayer.near", call: { methodName: "freeze_wallet", args: { wallet_pubkey: "ed25519:abc" }, gas: "30000000000000", deposit: "0" } });
  assert.equal(freezeCall(job, true).call.methodName, "unfreeze_wallet");
});

test("setupStep matches app.ts for every state, with and without DCL", () => {
  const expectWith: Record<string, number> = { draft: 0, registered: 0, policy_prepared: 1, armed: 2, link_confirmed: 3, funded: 5, resuming: 5, ready: 6, running: 6 };
  const expectWithout: Record<string, number> = { draft: 0, registered: 0, policy_prepared: 1, armed: 2, link_confirmed: 3, funded: 4, resuming: 4, ready: 5, running: 5 };
  for (const state of STATES) {
    assert.equal(setupStep(base({ state, grid: grid({ registered: false }) })).step, expectWith[state] ?? -1, state);
    assert.equal(setupStep(base({ state })).step, expectWithout[state] ?? -1, state);
  }
  assert.equal(setupStep(base({ state: "link_confirmed", grid: grid({ registered: true }) })).step, 4);
  assert.equal(setupStep(base({ grid: grid() })).labels.length, 7);
  assert.equal(setupStep(base()).labels.length, 6);
});

test("payload checks accept the server payload and reject any single change", () => {
  const job = base({ grid: grid() });
  const dcl: Payload = { caller: job.owner, receiverId: DCL, methodName: "storage_deposit", deposit: "500000000000000000000000", gas: "50000000000000", args: { account_id: AGENT, registration_only: true } };
  assert.equal(isDclRegistrationPayload(dcl, job), true);
  for (const bad of [{ caller: "x.near" }, { receiverId: "x.near" }, { methodName: "x" }, { deposit: "1" }, { gas: "1" }, { args: { account_id: "x", registration_only: true } }, { args: { account_id: AGENT, registration_only: false } }]) {
    assert.equal(isDclRegistrationPayload({ ...dcl, ...bad }, job), false, JSON.stringify(bad));
  }
  const policy: Payload = { caller: job.owner, receiverId: "outlayer.near", methodName: "store_wallet_policy", deposit: "1", gas: "2", args: {} };
  assert.equal(isPolicyPayload(policy, job), true);
  for (const bad of [{ caller: "x.near" }, { receiverId: "x.near" }, { methodName: "x" }]) assert.equal(isPolicyPayload({ ...policy, ...bad }, job), false);
});

test("listedJob hides stopped jobs, and cancelled or failed ones unless NEAR still sits in the agent wallet", () => {
  assert.equal(listedJob(base()), true);
  for (const state of ["draft", "paused", "halted", "frozen", "stopping"]) assert.equal(listedJob(base({ state: state as Job["state"] })), true, state);
  assert.equal(listedJob(base({ state: "stopped" })), false);
  for (const state of ["cancelled", "failed"] as const) {
    assert.equal(listedJob(base({ state, agentBalance: "0" })), false, state);
    assert.equal(listedJob(base({ state, agentBalance: null })), false, state);
    assert.equal(listedJob(base({ state, agentBalance: "1" })), true, state + " with NEAR left");
  }
});

test("the trade pairs map to their classic pools and a null volume keeps the candle", () => {
  assert.deepEqual(TRADE_POOL_KEY, { "trade-usdc": "rhea-4512", "trade-rhea": "rhea-6458", "trade-zec": "rhea-6065" });
  const parsed = parseMarketDataResponse({ data: [{ timestamp: 60000, open: 3.5, high: 3.6, low: 3.4, close: 3.55, volume: null }], meta: { source: "near-chain", asOf: 1, staleness: "fresh" } });
  assert.equal(parsed.candles.length, 1);
  assert.equal(parsed.candles[0]!.volume, 0);
});

test("fills: the Fill feed lists each completed claim with its side, price, time and transaction", () => {
  const fills = [
    { at: 9000, side: "sell" as const, point: POINT + 100, sold: NEAR("0.1"), bought: "350000", txHash: "h2" },
    { at: 2000, side: "buy" as const, point: POINT - 100, sold: "350000", bought: NEAR("0.1"), txHash: null },
  ];
  const motions = toAgentDetailView(base({ grid: grid({ fills }) }), 3_609_000).motions;
  assert.deepEqual(motions.map(m => [m.classification, m.label, m.price.value, m.time, m.timeTitle, m.txHash]), [
    ["settlement", "Sell rung filled", `${priceUsdcPerNear(POINT + 100)!.toPrecision(6)} USDC`, "1h ago", new Date(9000).toISOString(), "h2"],
    ["settlement", "Buy rung filled", `${priceUsdcPerNear(POINT - 100)!.toPrecision(6)} USDC`, "1h ago", new Date(2000).toISOString(), null],
  ]);
  assert.equal(new Set(motions.map(m => m.sequenceId)).size, 2);
});

test("markers: each snaps to the last loaded candle at or before it; outside the window it is dropped", () => {
  const candles: Candle[] = [10, 11, 12, 13, 14].map(k => ({ timestamp: k * 60_000, open: 1, high: 1, low: 1, close: 1, volume: 0 }));
  const at = (timestamp: number, side: "buy" | "sell" = "buy") => ({ timestamp, side, text: "x" });
  assert.deepEqual(snapMarkers(candles, [at(899_999, "sell"), at(900_000), at(599_999), at(650_000), at(600_000)]),
    [at(600_000), at(600_000), at(840_000, "sell")]);
  assert.deepEqual(snapMarkers([], [at(600_000)]), []);
});

test("pnl: Grid and LP value against the initial deposit only, with percent, HODL and an unavailable state", () => {
  const price = priceUsdcPerNear(POINT)!;
  const usd = (n: number) => `$${(Math.round(n * price * 100) / 100).toFixed(2)}`;
  const gain = toAgentDetailView(base({ grid: grid({ value: NEAR("1.1") }) }), 0);
  assert.deepEqual([gain.grossPnl.value, gain.grossPnl.usd, gain.grossPnl.bnb, gain.grossPnl.note], [`+${usd(0.1)}`, `+${usd(0.1)}`, "+0.100000 NEAR", "vs initial deposit; later top-ups count as profit"]);
  assert.equal(gain.grossPnlPercent.value, "+10.00%");
  assert.equal(gain.hodl?.value, usd(1));
  const loss = toAgentDetailView(base({ grid: grid({ value: NEAR("0.75") }) }), 0);
  assert.deepEqual([loss.grossPnl.value, loss.grossPnl.bnb, loss.grossPnlPercent.value], [`-${usd(0.25)}`, "-0.250000 NEAR", "-25.00%"]);
  const none = toAgentDetailView(base({ grid: grid({ value: null }) }), 0);
  assert.deepEqual([none.grossPnl.value, none.grossPnl.reason, none.grossPnlPercent.value, none.grossPnlPercent.reason], [null, "value unavailable", null, "value unavailable"]);
  // LP: valueHigh is the value and the percent rides in the note. V1 jobs carry no value, so PnL stays unavailable.
  const lpGain = toAgentDetailView(base({ kind: "lp", lp: lp({ valueHigh: NEAR("1.2") }) }), 0).lp!.recordedPnl;
  assert.deepEqual([lpGain.value, lpGain.rawWei, lpGain.note], [`+${usd(0.2)}`, NEAR("0.2"), "+20.00%"]);
  const lpLoss = toAgentDetailView(base({ kind: "lp", lp: lp({ valueHigh: NEAR("0.9") }) }), 0).lp!.recordedPnl;
  assert.deepEqual([lpLoss.value, lpLoss.note], [`-${usd(0.1)}`, "-10.00%"]);
  assert.equal(toAgentDetailView(base({ kind: "lp", lp: lp() }), 0).lp!.recordedPnl.value, null);
});

// Retire spec 3: a retired job leaves the main list (it is shown under "Retired agents"), and Retire is offered only for a dead job with dust.
test("Retire: a retired job is not in the main list, and retirable needs a halted, paused or frozen job with only dust", () => {
  assert.equal(listedJob(base({ state: "retired" })), false);
  for (const state of ["halted", "paused", "frozen"]) assert.equal(retirable(base({ state, agentBalance: NEAR("0.01") })), true, state);
  for (const state of ["running", "ready", "stopping", "stopped", "retired", "cancelled", "failed", "link_confirmed"]) assert.equal(retirable(base({ state, agentBalance: NEAR("0.01") })), false, state);
  assert.equal(retirable(base({ state: "halted", agentBalance: NEAR("0.02") })), false, "0.02 NEAR is not dust");
  assert.equal(retirable(base({ state: "halted", agentBalance: null })), false, "an unread balance");
  assert.equal(retirable(base({ state: "halted", agentBalance: NEAR("0.01"), extraTokens: [{ token: "x.near", amount: "1" }] as unknown as Job["extraTokens"] })), false, "a token outside the job");
});
