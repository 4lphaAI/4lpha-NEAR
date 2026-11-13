// Maps the server's job view (src/web/server.ts view()) onto the data shapes the
// copied 4lpha views read (AgentDetailView, AccountPortfolio). Pure: no window,
// no fetch, no wallet. Every value that the job view does not carry is given the
// type's unavailable form; no number is invented.
//
// Orientation: the BSC views price token1 per token0 at a tick. The DCL pool
// USDC / wNEAR prices wNEAR raw per USDC raw at a point. Using wNEAR as token0
// (24 decimals), USDC as token1 (6 decimals) and tick = -point makes the copied
// price code read USDC per NEAR without inversion: 1.0001^-point * 10^18, the
// same number app.ts shows (10^18 / 1.0001^point).
import { relativeTime, type AgentDetailView, type DetailMetric, type DetailMotion, type DetailPosition, type DetailSequence, type LpDetailView } from "@/lib/exec/agent-detail";
import type { AccountCoverage, AccountCoverageReason, AccountPortfolio } from "@/lib/exec/types";
import { USDC, WNEAR, asset, assetShort, exactNear, fmt, priceUsdcPerNear, waitingForChain, type Job, type JobOperation } from "@/lib/near-format";

export const NOT_TRACKED = "Not tracked yet";
export const PNL_NOTE = "vs initial deposit; later top-ups count as profit";
/** Pool keys of the data plane (the server allowlist in src/web/server.ts): the DCL pool for Grid and LP, the classic pool of each Trade V1 pair. */
export const DCL_POOL_KEY = "rhea-dcl-usdc-wnear";
export const TRADE_POOL_KEY = { "trade-usdc": "rhea-4512", "trade-rhea": "rhea-6458", "trade-zec": "rhea-6065" } as const;
const unavailable = (reason: string): DetailMetric => ({ value: null, reason });
const SETUP = ["draft", "registered", "policy_prepared", "armed", "link_confirmed", "funded"];
const TERMINAL = ["stopped", "failed", "cancelled", "retired"];

/** Display tick for a DCL point (see the orientation note above). */
export const tickOf = (point: number): number => -point;

/**
 * Range membership for negated ticks. The server treats a position as in range
 * for left <= point < right; negating gives -right < tick <= -left, so the copied
 * LP comparisons (lower <= tick < upper) are replaced by this function.
 */
export const nearRangeContains = (tick: number, lower: number, upper: number): boolean => lower < tick && tick <= upper;

// ---- valuation ------------------------------------------------------------

/** USD micros of a token amount at a USDC-per-NEAR price; null when the price is needed and missing or the token is unknown. */
export function usdMicros(token: string, raw: string, price: number | null): bigint | null {
  const n = BigInt(raw);
  if (n === 0n) return 0n;
  if (token === USDC) return n;
  if (token === WNEAR || token === "native") return price === null ? null : BigInt(Math.round(Number(n / 10n ** 12n) * price / 1e6));
  return null;
}

export interface Valuation {
  readonly price: number | null;
  /** Agent wallet: native NEAR + wNEAR + USDC. */
  readonly available: bigint | null;
  /** Inside DCL: internal balances + orders (remain + unclaimed) or the LP position estimate. */
  readonly deployed: bigint | null;
  readonly total: bigint | null;
  /** True when something is held that the totals exclude (lost-found, unexpected positions, unknown tokens). */
  readonly partial: boolean;
}

function sum(parts: readonly (bigint | null)[]): bigint | null {
  let total = 0n;
  for (const p of parts) { if (p === null) return null; total += p; }
  return total;
}

export function valuation(job: Job): Valuation {
  // Trade V1 13.1: a trade job has no DCL point to price NEAR in USD, so it carries no USD figure; the account row shows its NEAR total.
  if (job.trade) return { price: null, available: null, deployed: null, total: null, partial: false };
  const dcl = job.grid ?? job.lp;
  const price = priceUsdcPerNear(dcl?.point ?? null);
  let partial = job.extraTokens.length > 0;
  const available = job.agentBalance === null || job.holdings === null ? null : sum([
    usdMicros("native", job.agentBalance, price),
    usdMicros(WNEAR, job.holdings.tokens[WNEAR] ?? "0", price),
    usdMicros(USDC, job.holdings.tokens[USDC] ?? "0", price),
  ]);
  let deployed: bigint | null = 0n;
  if (dcl) {
    if (!dcl.available || dcl.point === null) deployed = null;
    else {
      const parts: (bigint | null)[] = Object.entries(dcl.internal).map(([t, raw]) => usdMicros(t, raw, price));
      if (Object.values(dcl.lost).some(raw => BigInt(raw) > 0n)) partial = true;
      if (job.grid) {
        for (const o of job.grid.orders) parts.push(usdMicros(o.sell, o.remain, price), usdMicros(o.buy, o.unclaimed, price));
        if (job.grid.positions > 0) partial = true;
      } else if (job.lp) {
        const position = job.lp.position;
        if (position) {
          parts.push(position.estimate ? sum([usdMicros(USDC, position.estimate[0] ?? "0", price), usdMicros(WNEAR, position.estimate[1] ?? "0", price)]) : null);
          // Whether predict_remove_liquidity includes unclaimed fees is not proven, so an LP value is never complete.
          partial = true;
        }
        if (job.lp.positions > (position ? 1 : 0)) partial = true;
      }
      deployed = sum(parts);
    }
  }
  const total = available === null || deployed === null ? null : available + deployed;
  return { price, available, deployed, total, partial };
}

export function usdText(micros: bigint | null): string | null {
  if (micros === null) return null;
  const cents = (micros + 5000n) / 10000n;
  return `$${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** PnL against the initial deposit only (operator, 2026-11-12): the job value in NEAR minus job.depositYocto, so later top-ups count as profit. */
export function pnlMetrics(job: Job, value: string | null | undefined, price: number | null): { pnl: DetailMetric; percent: DetailMetric } {
  const deposit = BigInt(job.depositYocto);
  if (value === null || value === undefined || deposit <= 0n) return { pnl: unavailable("value unavailable"), percent: unavailable("value unavailable") };
  // Gross (operator, 2026-11-13): the network costs the agent wallet paid are added back.
  const cost = job.networkCost && /^\d+$/.test(job.networkCost) ? BigInt(job.networkCost) : 0n;
  const delta = BigInt(value) - deposit + cost, abs = delta < 0n ? -delta : delta, sign = delta < 0n ? "-" : delta > 0n ? "+" : "";
  const near = `${sign}${fmt(abs.toString())}`, usd = price === null ? null : usdText(usdMicros("native", abs.toString(), price)), pct = abs * 10000n / deposit;
  return {
    pnl: { value: usd === null ? near : `${sign}${usd}`, reason: null, rawWei: delta.toString(), bnb: near, ...(usd === null ? {} : { usd: `${sign}${usd}` }), note: PNL_NOTE },
    percent: { value: `${sign}${pct / 100n}.${(pct % 100n).toString().padStart(2, "0")}%`, reason: null, note: PNL_NOTE },
  };
}

// ---- account --------------------------------------------------------------

export interface RowPresentation {
  readonly section: "setup" | "list";
  readonly status: "live" | "paused" | "warning" | "danger";
  readonly statusLabel: string;
  readonly statusLine: string;
}

export const catalogId = (job: Job): string => (job.kind === "lp" ? "range-pilot" : job.kind === "schedule" ? "recurring-buy" : job.kind === "dca" ? "auto-dca" : "grid-keeper");
export const catalogName = (job: Job): string => job.name || (job.kind === "lp" ? "Range Pilot" : job.kind === "schedule" ? "Schedule buy" : job.kind === "dca" ? "Auto DCA" : "Grid Keeper");

/**
 * Trade V1 13.1: the account total of a trade job in yocto NEAR, from the wallet snapshot: native, wNEAR and the token actually held (walletValue),
 * so tokens already paid to the owner during an exit are not counted. Null when any part is unread.
 */
export function tradeNearTotal(job: Job): string | null {
  const wnear = job.holdings?.tokens[WNEAR];
  return job.agentBalance === null || wnear === undefined || !job.trade || job.trade.walletValue === null ? null
    : (BigInt(job.agentBalance) + BigInt(wnear) + BigInt(job.trade.walletValue)).toString();
}
export const stateWords = (state: string): string => state.replaceAll("_", " ");

const LABELS: Record<string, [RowPresentation["status"], string]> = {
  ready: ["live", "Live"], running: ["live", "Live"], resuming: ["paused", "Resuming"], paused: ["paused", "Paused"],
  frozen: ["warning", "Frozen"], halted: ["danger", "Halted"], stopping: ["paused", "Stopping"],
  stopped: ["danger", "Stopped"], failed: ["danger", "Failed"], cancelled: ["danger", "Cancelled"], retired: ["danger", "Retired"],
};

export function rowPresentation(job: Job): RowPresentation {
  const setup = SETUP.includes(job.state);
  const waiting = waitingForChain(job);
  const [status, label] = waiting ? (["warning", "Waiting"] as const) : setup ? (["paused", "Setup"] as const) : LABELS[job.state] ?? (["paused", stateWords(job.state)] as const);
  const frozen = job.frozen === true && !TERMINAL.includes(job.state);
  return {
    section: setup ? "setup" : "list",
    status: frozen ? "warning" : status,
    statusLabel: frozen ? "Frozen" : label,
    statusLine: `${catalogName(job)} · ${job.trade ? `${job.trade.pair.symbol} / wNEAR · Live` : "USDC / wNEAR"} · ${waiting ? "Waiting" : stateWords(job.state)}`,
  };
}

function rowStatus(job: Job): AccountPortfolio["agents"][number]["status"] {
  if (SETUP.includes(job.state)) return "provisioning";
  if (!waitingForChain(job) && (job.state === "ready" || job.state === "running")) return "armed";
  if (TERMINAL.includes(job.state)) return "retired";
  return "paused";
}

function coverage(values: readonly (bigint | null)[], partial: boolean): AccountCoverage {
  if (values.length === 0) return { state: "empty", reasons: [] };
  if (values.every(v => v === null)) return { state: "unavailable", reasons: ["unreadable"] };
  if (values.some(v => v === null)) return { state: "partial", reasons: ["unreadable"] };
  return partial ? { state: "partial", reasons: ["unpriced"] } : { state: "complete", reasons: [] };
}

const sumKnown = (values: readonly (bigint | null)[]): string | null => {
  const known = values.filter((v): v is bigint => v !== null);
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0n).toString();
};

/** The main agent list (operator, 2026-11-11): not stopped or retired; cancelled or failed only while NEAR still sits in the agent wallet.
 *  Every other job is shown under "Retired agents" (Retire spec 3), so no job is hidden. */
export function listedJob(job: Job): boolean {
  if (job.state === "stopped" || job.state === "retired") return false;
  if (job.state !== "cancelled" && job.state !== "failed") return true;
  return job.agentBalance !== null && /^\d+$/u.test(job.agentBalance) && BigInt(job.agentBalance) > 0n;
}

const RETIRE_DUST = 20_000_000_000_000_000_000_000n; // 0.02 NEAR, the server's line (Retire spec 2.2)
const allZero = (values: Record<string, string> | undefined) => Object.values(values ?? {}).every(v => /^\d+$/u.test(v) && BigInt(v) === 0n);

/** Retire spec 3: a halted, paused or frozen job whose view shows only dust. The server checks the chain again before it retires. */
export function retirable(job: Job): boolean {
  if (!["halted", "paused", "frozen"].includes(job.state)) return false;
  if (job.agentBalance === null || !/^\d+$/u.test(job.agentBalance) || BigInt(job.agentBalance) >= RETIRE_DUST) return false;
  if (job.holdings && !allZero(job.holdings.tokens)) return false;
  if (job.extraTokens.length > 0) return false;
  const dcl = job.grid ?? job.lp;
  if (dcl && (!dcl.available || !allZero(dcl.internal) || !allZero(dcl.lost) || dcl.positions > 0)) return false;
  if (job.grid && job.grid.orders.length > 0) return false;
  if (job.lp && job.lp.position) return false;
  return true;
}

export function toPortfolio(jobs: readonly Job[], owner: string, nowMs: number): AccountPortfolio {
  const vals = jobs.map(job => ({ job, v: valuation(job) }));
  // A trade job has no USD figure (Trade V1 13.1): it stays out of the USD wallets, totals and coverage, and its row shows the NEAR total.
  const walleted = vals.filter(({ job }) => job.agentAccount !== null && !job.trade);
  const partial = vals.some(({ v }) => v.partial);
  const reason = (v: Valuation): AccountCoverageReason => (v.deployed === null ? "unreadable" : v.partial ? "unpriced" : "none");
  return {
    generatedAt: nowMs,
    asOf: nowMs,
    ownerAddress: owner,
    wallets: walleted.map(({ job, v }) => ({
      address: job.agentAccount!, custodyModel: "hd-derived" as const, depositable: true as const, source: "agents" as const,
      availableUsdMicros: v.available?.toString() ?? null, deployedUsdMicros: v.deployed?.toString() ?? null, deployedReason: reason(v),
    })),
    // The three totals use the same jobs: those whose wallet and DCL values are both known.
    totals: {
      walletUsdMicros: sumKnown(walleted.filter(({ v }) => v.total !== null).map(({ v }) => v.available)),
      deployedUsdMicros: sumKnown(walleted.filter(({ v }) => v.total !== null).map(({ v }) => v.deployed)),
      totalUsdMicros: sumKnown(walleted.map(({ v }) => v.total)),
      grossLpPnlUsdMicros: null, grossLpPnlBps: null, eligibleLpBasisNativeWei: null,
    },
    agents: vals.map(({ job, v }) => ({
      id: job.id,
      status: rowStatus(job),
      httpRuntimeProfile: "unbound-v1" as const,
      walletAddress: job.agentAccount ?? "",
      attention: SETUP.includes(job.state) ? "provisioning" as const : waitingForChain(job) || ["paused", "halted", "frozen", "stopping"].includes(job.state) ? "paused" as const : "none" as const,
      gas: null,
      holdings: {
        method: "none" as const,
        state: v.total === null ? "unavailable" as const : v.partial ? "partial" as const : v.total === 0n ? "empty" as const : "complete" as const,
        reason: reason(v), valueUsdMicros: v.total?.toString() ?? null, venusReference: null, held: false,
      },
      pnl: {
        method: "none" as const, coverage: "unavailable" as const, reason: "unsupported-profile" as const,
        eligibleBasisNativeWei: null, markNativeWei: null, pnlNativeWei: null, pnlUsdMicros: null, pnlBps: null, basisSources: [], excluded: [],
      },
    })),
    assets: walleted.map(({ job, v }) => {
      const price = v.price === null ? null : BigInt(Math.round(v.price * 1e6));
      const value = job.agentBalance === null ? null : usdMicros("native", job.agentBalance, v.price);
      return {
        kind: "native" as const, walletAddress: job.agentAccount!, tokenAddress: null, symbol: "NEAR", decimals: 24,
        balanceAtomic: job.agentBalance, priceUsdMicros: price?.toString() ?? null, pricedAt: price === null ? null : nowMs,
        valueUsdMicros: value?.toString() ?? null,
        status: job.agentBalance === null ? "unreadable" as const : BigInt(job.agentBalance) === 0n ? "zero" as const : price === null ? "unpriced" as const : "priced" as const,
        method: "wallet-native-v1" as const,
      };
    }),
    venus: null,
    coverage: {
      universe: "known-assets",
      // Same inclusion mask as the totals: a job whose total is unknown counts as unknown in every column.
      wallet: coverage(walleted.map(({ v }) => (v.total === null ? null : v.available)), false),
      deployed: coverage(walleted.map(({ v }) => (v.total === null ? null : v.deployed)), partial),
      total: coverage(walleted.map(({ v }) => v.total), partial),
      pnl: { state: "unavailable", reasons: ["unsupported-profile"] },
      truncated: { agents: false, wallets: false, tokens: false, walletTokenPairs: false, positions: false },
    },
  };
}

// ---- job detail -----------------------------------------------------------

/** Sequence state the copied filters understand: completed (succeeded), active (in flight), held (ambiguous, not terminal), rolled-back (finished without success, terminal). The raw verdict stays in recoveryState for display. */
function opState(op: JobOperation): string {
  if (op.verdict === "success" || op.verdict === "swapped") return "completed";
  if (op.state === "ambiguous") return "held";
  if (op.verdict === null && op.state === "submitted") return "active";
  return "rolled-back";
}

export function toSequences(job: Job, nowMs: number): DetailSequence[] {
  // Operations carry no position id, so none is attached to a position. The one
  // structured link is the LP pending step, shown as an active sequence on the current position.
  const pending: DetailSequence[] = job.lp?.pending && job.lp.position ? [{
    sequenceId: "pending", positionId: job.lp.position.id, kind: stateWords(job.lp.pending.kind), state: "active", recoveryState: "pending",
    note: null, outcomeUnavailable: false, txHashes: [], steps: [], updatedAt: nowMs, createdAt: null, shiftCause: null, targetBuyRange: null, targetSellRange: null,
  }] : [];
  return [...pending, ...job.operations.map(op => ({
    sequenceId: op.id,
    positionId: "",
    kind: stateWords(op.kind),
    state: opState(op),
    recoveryState: op.verdict ?? op.state,
    note: op.message,
    outcomeUnavailable: false,
    txHashes: op.txHash ? [op.txHash] : [],
    steps: [],
    updatedAt: op.finishedAt ?? op.createdAt,
    createdAt: op.createdAt,
    shiftCause: null,
    targetBuyRange: null,
    targetSellRange: null,
  }))];
}

const priceText = (point: number): string => priceUsdcPerNear(point)!.toPrecision(6);

/** The Fill feed: the server lists each completed claim with the order it settled (grid.fills), so the side is known. */
function toMotions(job: Job, nowMs: number): DetailMotion[] {
  return (job.grid?.fills ?? []).map(f => ({
    sequenceId: `fill:${f.at}:${f.point}:${f.txHash ?? ""}`, classification: "settlement", label: f.side === "buy" ? "Buy rung filled" : "Sell rung filled", collected: "",
    price: { value: `${priceText(f.point)} USDC`, reason: null }, time: relativeTime(f.at, nowMs).text, timeTitle: new Date(f.at).toISOString(), txHash: f.txHash,
  }));
}

function orderPositions(job: Job): DetailPosition[] {
  return (job.grid?.available ? job.grid.orders : []).map(o => {
    const p = priceText(o.point), tick = tickOf(o.point), ask = o.sell === WNEAR;
    return {
      positionId: o.id, state: "open", tokenId: o.id, pair: "wNEAR / USDC", role: ask ? "ask" : "bid",
      age: "-", ageTitle: "time unavailable",
      value: { value: assetShort(o.sell, o.remain), reason: null, note: "remaining" },
      unrealised: unavailable(NOT_TRACKED),
      fees: { value: asset(o.buy, o.unclaimed), reason: null, note: "unclaimed" },
      nftUrl: null,
      rung: { tickLower: tick, tickUpper: tick + 1, priceLow: p, priceHigh: p, fillPrice: p },
      sideLabel: ask ? "ASK wNEAR" : "BID USDC",
    };
  });
}

function nearestOrder(job: Job, ask: boolean): number | null {
  if (!job.grid?.available) return null;
  const pts = (job.grid?.orders ?? []).filter(o => (o.sell === WNEAR) === ask).map(o => priceUsdcPerNear(o.point)!);
  if (pts.length === 0) return null;
  const best = ask ? Math.min(...pts) : Math.max(...pts);
  return job.grid!.orders.find(o => priceUsdcPerNear(o.point) === best)!.point;
}

const BASE_POOL = {
  pair: "wNEAR / USDC", base: "wNEAR", quote: "USDC", symbol0: "wNEAR", symbol1: "USDC", decimals0: 24, decimals1: 6,
  token0: "", token1: "", fee: 100, wbnbIsToken0: true, baseAddress: null, quoteAddress: null, quoteUsd: 1,
} as const;

/**
 * Fee APR of the open position (operator, 2026-11-13): its unclaimed fees over its estimated value, annualised from the time
 * its add finished. Rhea's own pool APR needs its private indexer key, so this is computed from the position alone. Under one
 * hour open it is too noisy to show.
 */
export function lpFeeApr(fees: readonly string[] | null, estimate: readonly string[] | null, openedAt: number | null, price: number | null, nowMs: number): DetailMetric {
  if (!fees || !estimate || openedAt === null) return unavailable("fees, value or opening time unavailable");
  const age = nowMs - openedAt;
  if (!(age >= 3_600_000)) return unavailable("open for less than an hour");
  const feesUsd = sum([usdMicros(USDC, fees[0] ?? "0", price), usdMicros(WNEAR, fees[1] ?? "0", price)]);
  const valueUsd = sum([usdMicros(USDC, estimate[0] ?? "0", price), usdMicros(WNEAR, estimate[1] ?? "0", price)]);
  if (feesUsd === null || valueUsd === null || valueUsd <= 0n) return unavailable("price unavailable");
  const apr = Number(feesUsd) / Number(valueUsd) * (365 * 86_400_000 / age) * 100;
  return { value: `${apr < 0.01 && apr > 0 ? "<0.01" : apr.toFixed(2)}%`, reason: null, note: "unclaimed fees over the position value, annualised since it opened" };
}

function lpView(job: Job, v: Valuation, nowMs: number): LpDetailView | null {
  const lp = job.lp;
  if (!lp) return null;
  const range = lp.range ? { tickLower: tickOf(lp.range.right), tickUpper: tickOf(lp.range.left) } : null;
  const v2Settings = lp.settings && lp.settings !== "invalid" ? lp.settings : null;
  const fees = lp.position?.fees ?? null;
  const feesUsd = fees ? sum([usdMicros(USDC, fees[0] ?? "0", v.price), usdMicros(WNEAR, fees[1] ?? "0", v.price)]) : null;
  const { pnl, percent } = pnlMetrics(job, lp.valueHigh, v.price);
  return {
    wbnbUsd: v.price,
    feeApr: lpFeeApr(fees, lp.position?.estimate ?? null, lp.position?.openedAt ?? null, v.price, nowMs),
    feeMetric: fees === null ? unavailable("unclaimed fees unavailable")
      : { value: usdText(feesUsd), reason: feesUsd === null ? "price unavailable" : null, tokenBreakdown: `${asset(USDC, fees[0] ?? "0")} + ${asset(WNEAR, fees[1] ?? "0")}`, note: "unclaimed, collected with the next removal" },
    currentTickFresh: lp.point !== null,
    latestPositionId: lp.position?.id,
    model: null,
    pool: { ...BASE_POOL, quoteIsToken0: false, poolAddress: DCL_POOL_KEY, tickSpacing: 1 },
    openingRange: range ? { source: "explicit", ...range } : null,
    liveRange: range ? { ...range, asOfMs: nowMs } : null,
    liveRangeReason: range ? null : "range unavailable",
    currentTick: lp.point === null ? null : tickOf(lp.point),
    currentTickAsOfMs: lp.point === null ? null : nowMs,
    currentTickSource: lp.point === null ? null : "worker",
    currentTickReason: lp.point === null ? "Finalized DCL status is unavailable." : null,
    settingsTrusted: lp.settings !== "invalid",
    settingsReason: lp.settings === "invalid" ? "LP settings are unreadable. Stop and withdraw." : null,
    // V1 has fixed rules; V2 adds owner settings. The rotation confirmation window is 5 minutes (src/core/lp.ts LP_CONFIRM_MS).
    // Unreadable V2 settings are shown as unavailable, never as a normal settings object.
    settings: lp.settings === "invalid" ? null : {
      autoRotate: true, rotateMode: "swapped", rotateMinHoldMinutes: 5,
      autoHarvest: v2Settings?.compound.on === true, harvestMinFeesWei: "0",
      takeProfitPct: v2Settings && v2Settings.takeProfitPct > 0 ? v2Settings.takeProfitPct : null,
      stopLossPct: v2Settings && v2Settings.stopLossPct > 0 ? v2Settings.stopLossPct : null,
      brain: null,
    },
    valuation: v.deployed === null ? unavailable("valuation unavailable") : { value: usdText(v.deployed), reason: null, note: "LP estimate, fees may be excluded" },
    // The percent rides in the note slot (the tile shows it as its delta); the tile adds PNL_NOTE itself.
    recordedPnl: pnl.value === null ? pnl : { ...pnl, note: percent.value ?? undefined },
    // V2 position is the deposit minus the 0.8 NEAR reserve; V1 is a fixed 0.4 NEAR.
    budgetWei: lp.initialPosition ?? "400000000000000000000000",
    selectPool: null,
    restart: null,
    reason: null,
  };
}

function lpPositions(job: Job, v: Valuation): DetailPosition[] {
  const p = job.lp?.position;
  if (!p) return [];
  const est = p.estimate ? sum([usdMicros(USDC, p.estimate[0] ?? "0", v.price), usdMicros(WNEAR, p.estimate[1] ?? "0", v.price)]) : null;
  const fees = p.fees ? sum([usdMicros(USDC, p.fees[0] ?? "0", v.price), usdMicros(WNEAR, p.fees[1] ?? "0", v.price)]) : null;
  return [{
    positionId: p.id, state: "open", tokenId: p.id, pair: "wNEAR / USDC", role: "lp", age: "-", ageTitle: "time unavailable",
    value: est === null ? unavailable("estimate unavailable")
      : { value: usdText(est), reason: null, note: `LP estimate, fees may be excluded: ${asset(USDC, p.estimate![0] ?? "0")} + ${asset(WNEAR, p.estimate![1] ?? "0")}` },
    unrealised: unavailable(NOT_TRACKED),
    fees: fees === null ? unavailable("unclaimed fees unavailable") : { value: usdText(fees), reason: null, note: "unclaimed" },
    nftUrl: null, rung: null, sideLabel: null,
  }];
}

export function toAgentDetailView(job: Job, nowMs: number): AgentDetailView {
  const v = valuation(job);
  const deposit = BigInt(job.depositYocto);
  const point = (job.grid ?? job.lp)?.point ?? null;
  const ask = nearestOrder(job, true), bid = nearestOrder(job, false);
  const empty = { tickLower: 0, tickUpper: 0 };
  const priceRange = (pt: number | null) => (pt === null ? null : { low: priceText(pt), high: priceText(pt) });
  const { pnl, percent } = pnlMetrics(job, job.grid?.value, v.price);
  const usdOfDeposit = v.price === null ? null : usdText(usdMicros("native", job.depositYocto, v.price));
  return {
    id: job.id,
    status: !waitingForChain(job) && (job.state === "ready" || job.state === "running") ? "armed" : "paused",
    hireSizingName: null,
    armedBudgetWei: null,
    walletAddress: job.agentAccount ?? "",
    sessionPublicKey: null,
    sessionExpiresAt: null,
    provisioning: false,
    actionDisabledReason: null,
    armMs: null,
    hodl: usdOfDeposit === null ? unavailable("price unavailable") : { value: usdOfDeposit, reason: null, note: "deposit kept as NEAR" },
    dailyNativeLimit: { value: exactNear(deposit), reason: null, bnb: exactNear(deposit), ...(v.price === null ? {} : { usd: usdText(usdMicros("native", job.depositYocto, v.price))! }) },
    recordedCycleDelta: unavailable(NOT_TRACKED),
    grossPnl: pnl,
    grossPnlPercent: percent,
    recordedCycles: unavailable(NOT_TRACKED),
    levels: [],
    cycleHistoryAvailable: false,
    cycleNote: "",
    gas: null,
    motions: toMotions(job, nowMs),
    sequences: toSequences(job, nowMs),
    positions: job.lp ? lpPositions(job, v) : orderPositions(job),
    lp: lpView(job, v, nowMs),
    grid: {
      ...BASE_POOL,
      pool: DCL_POOL_KEY,
      sideInverted: false,
      observedPrice: point === null ? null : priceText(point),
      buyPrices: priceRange(bid),
      sellPrices: priceRange(ask),
      tickSpacing: 1,
      mode: "limit-orders",
      gapTicks: 100,
      widthTicks: 0,
      driftPctOfGap: null,
      deployPctBps: null,
      shiftLane: null,
      buyRange: bid === null ? empty : { tickLower: tickOf(bid), tickUpper: tickOf(bid) + 1 },
      sellRange: ask === null ? empty : { tickLower: tickOf(ask), tickUpper: tickOf(ask) + 1 },
      buyRungSource: bid === null ? "none" : "live",
      sellRungSource: ask === null ? "none" : "live",
      buyRungGap: null,
      sellRungGap: null,
      placement: (job.grid?.orders.length ?? 0) > 0 ? "placed" : "unplaced",
      observedTick: point === null ? null : tickOf(point),
      observationAgeMs: point === null ? null : 0,
      observationStale: false,
      tickSource: point === null ? null : "worker",
      rangeUnavailableBecause: null,
      liveRows: job.grid && !job.grid.available ? null : job.grid?.orders.length ?? 0,
    },
  };
}
