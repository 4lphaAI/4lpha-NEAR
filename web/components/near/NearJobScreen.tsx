"use client";
import React, { useMemo, useState } from "react";
import { ActivityRow, Button, Category, EmptyState, Icon, MetricTile, Num, SegmentedToggle, Skeleton, StatusBadge } from "@/design-system";
import { MarketChart, type MarketChartMarker, type MarketChartPriceLine } from "@/components/MarketChart";
import { CHART_INTERVALS, displaySide, emptyRungPairs, gridSideLabel, relativeTime, rungFillTick, rungHoldsWbnb, sequenceOutcome, shiftFills, type AgentDetailView, type ChartInterval, type DetailMetric, type DetailMotion, type OhlcvResult, type LiveRungGap } from "@/lib/exec/agent-detail";
import { formatAtomic, pairQuoting, type ReviewedPair, priceAtTick } from "@/lib/exec/pairs";
import { LiquidityChart, type LiquidityGeometry } from "@/components/lp/LiquidityChart";
import { gridModelLabel } from "@/lib/grid/economics";
import { type OnChainPosition } from "@/lib/altana/position-reader";
import { PairIcons, TokenIcon } from "@/components/TokenIcon";
import { useNearSession } from "@/lib/near-session";
import { api } from "@/lib/near-wallet";
import { catalogName, retirable, rowPresentation, toAgentDetailView, toSequences } from "@/lib/near-map";
import { asset, assetShort, BLIND_CHECKS, BLIND_RESUME, canRequestResume, CHAIN_WAIT, exactNear, fmt, fundingLine, resumeLabel, STOPPING_WAIT, tokenLogo, USDC, waitingForChain, WNEAR, type Job } from "@/lib/near-format";
import { hireRunSteps, inSetup } from "@/lib/hire-run";
import { HireStepList } from "./HireRunModal";
import { NearHireRun, TRANSFER_STOPPED_WARNING } from "./NearHireRun";
import { FundsCards, JobDetails } from "./NearJobPanels";
import { NearLpDetail } from "./NearLpDetail";
import { NearTradeBody } from "./NearTradeDetail";
import type { ChartCandle } from "@/lib/exec/agent-detail";

const RETIRE_CONFIRM = "Retire this job for good? The agent wallet holds only dust, so nothing is moved. The agent stops being watched. Your management link still works.";

type ChartUnit = "usd" | "quote";
export interface UseAgentDetailResult {
  state: string; view: AgentDetailView; market: OhlcvResult | null; chartCandles: readonly ChartCandle[] | null; chartBanner: string | null;
  chartInterval: ChartInterval; setChartInterval: (value: ChartInterval) => void; chartUnit: ChartUnit; setChartUnit: (value: ChartUnit) => void;
  asOfMs: number; message: string; marketReason: string; readHeaders: Record<string, string>; refresh: () => Promise<void>;
}

type Props = { readonly jobId: string; readonly go: (route: string) => void };
type Tab = "Overview" | "Run log" | "Details";
/** `side` is the DISPLAY side (`displaySide`): "buy" bought the display base, "sell" sold it. */
type Fill = { readonly motion: DetailMotion; readonly side: "buy" | "sell" };
const TICK_ASK = "var(--warn)", TICK_BID = "var(--cat-grid)";
const RUNG_LINE = "#2cd391";
// The chart canvas cannot read CSS variables: the same two tones as the B/S markers (MarketChart).
const TICK_BID_HEX = "oklch(0.72 0.09 205)", TICK_ASK_HEX = "#f0913a";

function Panel({ title, right, children, pad = 0, className = "", fill = false }: { readonly title?: React.ReactNode; readonly right?: React.ReactNode; readonly children: React.ReactNode; readonly pad?: number; readonly className?: string; readonly fill?: boolean }) {
  return (
    <section className={className} style={{ border: "1px solid var(--border-card)", borderRadius: "var(--radius-md)", background: "var(--surface-card)", overflow: "hidden", ...(fill ? { display: "flex", flexDirection: "column" } : {}) }}>
      {title ? (
        <header style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: "1px solid var(--line-1)" }}>
          <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)" }}>{title}</span>
          <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 14 }}>{right}</span>
        </header>
      ) : null}
      <div style={{ padding: pad, ...(fill ? { flex: 1, minHeight: 0, position: "relative" } : {}) }}>{children}</div>
    </section>
  );
}

function metricValue(metric: DetailMetric | null | undefined): string {
  return metric?.value ?? "-";
}

/**
 * GRID-BENCHMARK-LATENCY — a tile whose dash is TRANSIENT (`loading`: the arm
 * receipt or the page's first tick, seconds away) shows a skeleton and no
 * reason; every other dash keeps its reason (operator, 2026-09-11).
 */
function tileValue(metric: DetailMetric | null | undefined): React.ReactNode {
  return metric?.loading === true ? <Skeleton w={88} h={22} style={{ display: "inline-block", verticalAlign: "middle" }} /> : metricValue(metric);
}

/**
 * The reason a metric is empty, as tile footnote text — without the leading em
 * dash the mapper puts there for inline use, since the tile already shows one.
 */
function emptyNote(metric: DetailMetric | null | undefined): string | undefined {
  if (metric === null || metric === undefined || metric.value !== null) return undefined;
  const reason = metric.reason;
  if (reason === null || reason === undefined || reason.length === 0) return undefined;
  // Internal wording the owner cannot act on, and which the operator asked not
  // to see: the level rows are on the same screen already.
  if (reason.includes("no agent-wide total")) return undefined;
  return reason.replace(/^—\s*/u, "");
}

/**
 * What the grid DOES, for the tile label. The plane's mode word is the
 * machinery (`shift` = PHASE3.22/3.25 atomic pair); with the drift lane signed
 * off (`driftPctOfGap: 0`) the only motion left is the cross a fill causes —
 * the flip. `shift` is shown exactly when drift is on, because then it is true.
 */
export function modeLabel(view: AgentDetailView | null | undefined): string {
  const grid = view?.grid;
  if (grid === undefined || grid.mode === "fixed") return grid === undefined ? "" : " · flip";
  if (grid.mode === "shift") return grid.driftPctOfGap === 0 ? " · flip" : grid.driftPctOfGap === null ? " · shift" : " · shift + drift";
  return ` · ${grid.mode}`;
}

/** The signed deployment fraction, for the Execution model tile's second line. */
export function utilizationNote(view: AgentDetailView | null | undefined): string | undefined {
  const bps = view?.grid.deployPctBps;
  return typeof bps === "number" ? `Capital utilization ${bps / 100}%` : undefined;
}

/** The cross lane's daily count as the plane reports it: `used/perDay`, a dash for `used` until it does. */
export function requotesLabel(view: AgentDetailView | null | undefined): string | null {
  const lane = view?.grid.shiftLane;
  if (lane === null || lane === undefined) return null;
  return `REQUOTES ${lane.used ?? "-"}/${lane.perDay} TODAY`;
}

function metricTone(value: string): "profit" | "loss" | "flat" {
  if (value.startsWith("-")) return "loss";
  if (value === "-" || /^0(?:\.0+)?(?:\s|%|$)/u.test(value)) return "flat";
  return "profit";
}
/**
 * The pair comes from the VIEW, which already resolved it — from the majors
 * table or from data-plane metadata. Re-deriving it here through the majors
 * table alone is what dashed every price on a four.meme pair whose legs the
 * mapper had resolved perfectly well.
 */
function pairContext(view: AgentDetailView | null | undefined): { readonly pair: ReviewedPair; readonly quote: string; readonly base: string } | null {
  if (view === null || view === undefined || view.grid.base === null || view.grid.quote === null) return null;
  const { symbol0, symbol1, decimals0, decimals1 } = view.grid;
  if (symbol0 === null || symbol1 === null || decimals0 === null || decimals1 === null) return null;
  return {
    pair: {
      chainId: 56,
      token0: view.grid.token0,
      token1: view.grid.token1,
      symbol0,
      symbol1,
      decimals0,
      decimals1,
      wbnbIsToken0: view.grid.wbnbIsToken0,
    },
    quote: view.grid.quote,
    base: view.grid.base,
  };
}

/**
 * The price a rung fills at: an ask completes at the TOP of its range, a bid at
 * the BOTTOM — the two numbers PancakeSwap shows for the same position.
 */
function displayRungSource(view: AgentDetailView, role: "bid" | "ask"): "live" | "signed" | "none" {
  const planeBuyIsBid = !view.grid.sideInverted;
  const planeRole = (role === "bid") === planeBuyIsBid ? "buy" : "sell";
  return planeRole === "buy" ? view.grid.buyRungSource : view.grid.sellRungSource;
}

function rangePrice(view: AgentDetailView | null, role: "bid" | "ask"): string | null {
  if (view === null) return null;
  // `buyPrices` is the PLANE's buy rung; on a grid whose display base is
  // WBNB that rung is the reader's ASK (`sideInverted`).
  const planeBuyIsBid = !view.grid.sideInverted;
  const planeRole = (role === "bid") === planeBuyIsBid ? "buy" : "sell";
  if (displayRungSource(view, role) === "none") return null;
  const prices = planeRole === "buy" ? view.grid.buyPrices : view.grid.sellPrices;
  if (prices === null) return null;
  return role === "bid" ? prices.low : prices.high;
}

/** The live or signed range for a DISPLAY side, through the same seam. */
function displayRange(view: AgentDetailView, role: "bid" | "ask"): { readonly tickLower: number; readonly tickUpper: number } | null {
  const planeBuyIsBid = !view.grid.sideInverted;
  const planeRole = (role === "bid") === planeBuyIsBid ? "buy" : "sell";
  if (displayRungSource(view, role) === "none") return null;
  return (role === "bid") === planeBuyIsBid ? view.grid.buyRange : view.grid.sellRange;
}

function rungQuote(view: AgentDetailView | null, role: "bid" | "ask"): string {
  if (view === null) return "-";
  const price = rangePrice(view, role);
  if (price !== null) return price;
  const planeBuyIsBid = !view.grid.sideInverted;
  const planeRole = (role === "bid") === planeBuyIsBid ? "buy" : "sell";
  const source = displayRungSource(view, role);
  if (source === "live" || source === "signed") return "- price metadata unavailable";
  const gap: LiveRungGap | null = planeRole === "buy" ? view.grid.buyRungGap : view.grid.sellRungGap;
  switch (gap) {
    case "reading": return `- reading the ${role} rung from chain`;
    case "unreadable": return `- ${role} rung unreadable on chain`;
    case "emptied": return `- ${role} rung emptied, awaiting the shift`;
    case "no-token": return "- rung not minted";
    case "role-unavailable": return "- live rung role unavailable";
    case "closed": return `- ${role} rung closed`;
    case "no-row": return `- no live ${role} rung (one-sided)`;
    default: return "-";
  }
}

/**
 * The leg a rung holds, in its own asset: "191.1 mubarak" for a rung holding
 * mubarak, "0.0105 WBNB" for one holding WBNB, "13.735 USDT" on USDT/WBNB.
 * The non-WBNB leg is named by ITS OWN symbol — not by the display base, which
 * on USDT/WBNB is WBNB and printed "13.735 WBNB" for 13.735 USDT. Decimals
 * from the resolved pair; a pair the page cannot resolve still shows the WBNB
 * leg, which is always 18-decimal.
 */
function heldLegText(nft: OnChainPosition, holdsWbnb: boolean, wbnbIsToken0: boolean, context: ReturnType<typeof pairContext>): string | null {
  const wbnbLeg = wbnbIsToken0 ? nft.amounts.amount0 : nft.amounts.amount1;
  const otherLeg = wbnbIsToken0 ? nft.amounts.amount1 : nft.amounts.amount0;
  if (holdsWbnb) {
    const text = formatAtomic(wbnbLeg.toString(10), 18, 6);
    return text === null ? null : `${text} WBNB`;
  }
  if (context === null) return null;
  const decimals = wbnbIsToken0 ? context.pair.decimals1 : context.pair.decimals0;
  const symbol = wbnbIsToken0 ? context.pair.symbol1 : context.pair.symbol0;
  const text = formatAtomic(otherLeg.toString(10), decimals, 3);
  return text === null ? null : `${text} ${symbol}`;
}

/**
 * The pool OHLCV feed prices the BASE token in USD — measured: BTCB/WBNB closes
 * near 77,100, not near 112 — so this chart is a USD chart and says so. A rung
 * quoted in WBNB is converted before it is drawn on the same axis.
 */
function chartPrice(candles: OhlcvResult["candles"]): string {
  const close = candles.at(-1)?.close;
  if (close === undefined) return "-";
  return `${close.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 8 })}`;
}

function rungUsd(view: AgentDetailView | null, role: "bid" | "ask"): number | null {
  const price = rangePrice(view, role);
  const quoteUsd = view?.grid.quoteUsd ?? null;
  if (price === null || quoteUsd === null) return null;
  const value = Number(price) * quoteUsd;
  return Number.isFinite(value) && value > 0 ? value : null;
}

// The rungs are signed in the quote asset, so the quote view draws them exactly
// and only the USD view has to convert.
function rungOnChart(view: AgentDetailView | null, role: "bid" | "ask", unit: ChartUnit): number | null {
  if (unit === "usd") return rungUsd(view, role);
  const price = rangePrice(view, role);
  if (price === null) return null;
  const value = Number(price);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Every open order the page shows, so the chart and the liquidity panel draw all four lanes, not only the nearest pair. */
function openOrderRungs(view: AgentDetailView | null): readonly { readonly role: "bid" | "ask"; readonly price: number; readonly tickLower: number; readonly tickUpper: number }[] {
  return (view?.positions ?? []).flatMap((p) => {
    const price = p.rung === null ? NaN : Number(p.rung.fillPrice);
    return p.state === "open" && p.rung !== null && (p.role === "bid" || p.role === "ask") && Number.isFinite(price) && price > 0
      ? [{ role: p.role, price, tickLower: p.rung.tickLower, tickUpper: p.rung.tickUpper }] : [];
  });
}

/** Chart lines: one per open order; before any order rests, the signed nearest pair as before. */
function chartPriceLines(view: AgentDetailView | null, unit: ChartUnit): readonly MarketChartPriceLine[] {
  const orders = openOrderRungs(view), quoteUsd = view?.grid.quoteUsd ?? null;
  if (orders.length > 0) return orders.flatMap((o) => {
    const price = unit === "usd" ? (quoteUsd === null ? NaN : o.price * quoteUsd) : o.price;
    return Number.isFinite(price) && price > 0 ? [{ price, color: o.role === "bid" ? TICK_BID_HEX : TICK_ASK_HEX, title: o.role === "bid" ? "BID" : "ASK" }] : [];
  });
  if (view === null) return [];
  return [{ price: rungOnChart(view, "bid", unit), title: displayRungSource(view, "bid") === "signed" ? "BID · SIGNED" : "BID" }, { price: rungOnChart(view, "ask", unit), title: displayRungSource(view, "ask") === "signed" ? "ASK · SIGNED" : "ASK" }]
    .flatMap((line) => line.price === null ? [] : [{ price: line.price, color: RUNG_LINE, title: line.title }]);
}

function chartAxis(candles: OhlcvResult["candles"]): readonly string[] {
  if (candles.length === 0) return ["-", "-", "-", "-"];
  const indexes = [0, Math.floor((candles.length - 1) / 3), Math.floor(((candles.length - 1) * 2) / 3), candles.length - 1];
  return indexes.map((index) => new Date(candles[index]?.timestamp ?? 0).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }));
}

function short(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function fills(view: AgentDetailView | null): readonly Fill[] {
  // The mapper already labels a motion by its DISPLAY side (`displaySide`).
  return view?.motions.flatMap((motion) => motion.classification !== "settlement" ? [] : [{
    motion,
    side: motion.label === "Buy rung filled" ? "buy" as const : "sell" as const,
  }]) ?? [];
}

function fillPrice(fill: Fill, view: AgentDetailView | null): string {
  const context = pairContext(view);
  const price = fill.motion.price.value?.split(" ")[0] ?? "-";
  return `${price} ${context?.quote ?? "-"}`;
}

// MarketChart snaps each marker onto its own loaded candles.
function chartMarkers(rowsWithFills: readonly Fill[]): readonly MarketChartMarker[] {
  return rowsWithFills.flatMap((fill) => {
    const completedAt = Date.parse(fill.motion.timeTitle);
    return Number.isSafeInteger(completedAt) ? [{ timestamp: completedAt, side: fill.side }] : [];
  });
}
function positionStateLabel(state: string): string {
  if (state === "open") return "Open order";
  if (state === "closing") return "Closing";
  if (state === "closed") return "Closed";
  return state;
}
function GridLiquidity({ view }: { readonly view: AgentDetailView | null }) {
  const [invert, setInvert] = React.useState(false);
  React.useEffect(() => { setInvert(false); }, [view?.grid.pool]);
  const context = pairContext(view);
  const observedTick = view?.grid.observedTick ?? null;
  const geometry: LiquidityGeometry | null = view !== null && context !== null && observedTick !== null && view.grid.tickSpacing > 0
    ? {
      spacing: view.grid.tickSpacing,
      currentTick: observedTick,
      currentTickAsOfMs: view.grid.observationAgeMs === null ? 0 : Date.now() - view.grid.observationAgeMs,
      orientation: { quoteIsToken0: pairQuoting(context.pair).invert, decimals0: context.pair.decimals0, decimals1: context.pair.decimals1, symbol0: context.pair.symbol0, symbol1: context.pair.symbol1 },
      display: { invert },
    }
    : null;
  // The rungs drawn are the ones the page KNOWS: `liveView` replaces the
  // plane's recorded ranges with the wallet's live NFTs the moment they are
  // read, so a shift grid paints its floating rungs rather than the arm
  // geometry. The plane's `rangeUnavailableBecause` prose is not shown here
  // (operator, 2026-09-11) — the QUOTES line below already names the rungs.
  const range: React.ComponentProps<typeof LiquidityChart>["range"] = view === null
    ? { mode: "unavailable", reason: "- no owner view yet" }
    : {
        mode: "rungs",
        rungs: openOrderRungs(view).length > 0
          ? openOrderRungs(view).map((o) => ({ tickLower: o.tickLower, tickUpper: o.tickUpper, tone: o.role }))
          : (["bid", "ask"] as const).flatMap((side) => {
            const rung = displayRange(view, side);
            return rung === null ? [] : [{ ...rung, tone: side }];
          }),
      };
  const signed = view !== null && view.grid.buyRungSource === "signed" && view.grid.sellRungSource === "signed";
  return (
    <div style={{ display: "grid", gap: 12, padding: 16 }}>
      <LiquidityChart
        showSnapshot={false}
        poolAddress={view?.grid.pool ?? ""}
        geometry={geometry}
        range={range}
        legend={{ bid: `BIDS · BUY ${context?.base ?? "-"}`, ask: `ASKS · SELL ${context?.base ?? "-"}` }}
        onFlipUnits={() => setInvert((value) => !value)}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", paddingTop: 10, borderTop: "1px solid var(--line-1)", font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)", letterSpacing: "0.04em" }}>
        <span style={{ marginLeft: "auto", display: "flex", gap: 18, flexWrap: "wrap" }}>
          <span title={view?.grid.tickSource === "live" ? "Read straight from the pool by this page, independent of the worker" : view?.grid.tickSource === "worker" ? "The worker's last finalized observation" : undefined}>ACTIVE TICK {observedTick ?? "-"}{view?.grid.tickSource === "live" ? " · LIVE" : ""}</span><span>TICK SPACING {view?.grid.tickSpacing || "-"}</span><span>QUOTES {rungQuote(view, "bid")} – {rungQuote(view, "ask")} {context?.quote ?? "-"}{signed ? " · SIGNED, not yet armed" : ""}</span><span>-</span><span>{view?.grid.liveRows ?? "-"} LIVE ORDERS</span>{requotesLabel(view) === null ? null : <span title="Re-placements of the ladder after a fill, counted by the plane against the signed daily allowance">{requotesLabel(view)}</span>}
        </span>
      </div>
    </div>
  );
}

function GridDetail({ detail, view, onChain, discovered, emptyRungs, busy, closePositionNow }: {
  readonly detail: UseAgentDetailResult;
  readonly view: AgentDetailView | null;
  /** What the chain says each NFT holds, so a row can contradict the plane. */
  readonly onChain: ReadonlyMap<string, OnChainPosition>;
  /** NFTs on this pool the wallet holds that the plane has not recorded yet. */
  readonly discovered: readonly OnChainPosition[];
  /** Emptied rungs the wallet still holds on this pool (prior pairs). */
  readonly emptyRungs: readonly OnChainPosition[];
  readonly busy: boolean;
  readonly closePositionNow: (position: OnChainPosition) => void;
}) {
  const [showCharts, setShowCharts] = React.useState(false);
  const candles = detail.market?.candles ?? [];
  // The tiles stay on the 1m USD series; the chart follows its own controls.
  const chartSeries = detail.chartCandles ?? candles;
  const context = pairContext(view);
  const icons = usePairIcons(view?.grid.token0, view?.grid.token1);
  const feed = React.useMemo<readonly Fill[]>(() => {
    const context = pairContext(view);
    const crosses = view === null ? [] : shiftFills({
      sequences: view.sequences,
      priorPairs: emptyRungPairs(emptyRungs, view.grid.wbnbIsToken0),
      wbnbIsToken0: view.grid.wbnbIsToken0,
      pair: context?.pair ?? null,
    }).map((fill): Fill => {
      // `shiftFills` answers in the PLANE's sides; the feed shows the display side.
      const side = displaySide(fill.side, view.grid.sideInverted);
      return {
      side,
      motion: {
        sequenceId: fill.sequenceId,
        classification: "settlement",
        label: side === "buy" ? "Buy level filled" : "Sell level filled",
        collected: "",
        price: { value: fill.price === null ? null : `${fill.price} ${context?.quote ?? ""}`, reason: fill.price === null ? "- price unavailable" : null },
        time: relativeTime(fill.atMs, Date.now()).text,
        timeTitle: new Date(fill.atMs).toISOString(),
        txHash: fill.txHash,
      },
      };
    });
    const known = new Set(crosses.map((fill) => fill.motion.sequenceId));
    return [...crosses, ...fills(view).filter((fill) => !known.has(fill.motion.sequenceId))]
      .sort((a, b) => b.motion.timeTitle.localeCompare(a.motion.timeTitle));
  }, [emptyRungs, view]);
  const markers = useMemo(() => chartMarkers(feed), [feed]);
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex" }}>
        <Button variant={showCharts ? "secondary" : "ghost"} size="sm" onClick={() => setShowCharts(!showCharts)} icon={<Icon name="grid-trading" size={14} />}>{showCharts ? "Hide charts" : "Show charts"}</Button>
      </div>
      {showCharts ? (<>
      <div className="fl-grid-detail-charts" style={{ display: "grid", gridTemplateColumns: "minmax(0,2fr) minmax(280px,1fr)", gap: 16, alignItems: "stretch" }}>
        <Panel title={`${view?.grid.pair ?? "-"} pool price`} right={<>
          <span style={{ display: "flex", alignItems: "center", gap: 6, font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)", letterSpacing: "0.04em" }}><i style={{ width: 8, height: 8, borderRadius: 999, background: TICK_BID }} />B</span>
          <span style={{ display: "flex", alignItems: "center", gap: 6, font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)", letterSpacing: "0.04em" }}><i style={{ width: 8, height: 8, borderRadius: 999, background: TICK_ASK }} />S</span>
          <SegmentedToggle options={CHART_INTERVALS.map((value) => ({ value, label: value }))} value={detail.chartInterval} onChange={(next: string) => detail.setChartInterval(next as ChartInterval)} />
          <SegmentedToggle options={[{ value: "usd", label: "USD" }, { value: "quote", label: view?.grid.quote ?? "QUOTE" }]} value={detail.chartUnit} onChange={(next: string) => detail.setChartUnit(next === "quote" ? "quote" : "usd")} />
        </>}>
          <div style={{ padding: "14px 16px 10px", display: "block" }}>
            {view?.grid.pool == null ? (
              <div style={{ height: 200, display: "grid", placeItems: "center", font: "var(--type-body-sm)", color: "var(--text-subtle)" }}>
                {detail.marketReason ?? "-"}
              </div>
            ) : (
            <MarketChart kind="pool" address={view.grid.pool} title={view.grid.pair} candles={detail.market === null && detail.chartCandles === null ? undefined : chartSeries} markers={markers} priceLines={chartPriceLines(view, detail.chartUnit)} embedded height={200} defaultInterval={detail.chartInterval} currency={detail.chartUnit === "usd" ? "usd" : "token"} />
            )}
            {chartSeries.length === 0 ? null : <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)" }}>
              {chartAxis(chartSeries).map((time, index) => <span key={index}>{time}</span>)}
            </div>}
          </div>
        </Panel>
        <Panel fill title="Fill feed" right={<span style={{ font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)" }}>{view === null ? "-" : feed.length} FILLS</span>}>
          {/* Same height as the chart body beside it (14 + 200 + 8 + axis + 10); a
              longer feed scrolls inside rather than growing the row. */}
          <div style={{ display: "grid", alignContent: "start", position: "absolute", inset: 0, overflowY: "auto" }}>
            {feed.length === 0 ? (
              <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 4, padding: "11px 16px" }}>-</div>
            ) : feed.map((fill, i) => (
              <div key={fill.motion.sequenceId} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 4, padding: "11px 16px", borderBottom: i < feed.length - 1 ? "1px solid var(--line-1)" : "none" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 8, font: "var(--weight-medium) var(--text-sm)/1 var(--font-mono)", color: fill.side === "buy" ? TICK_BID : TICK_ASK, letterSpacing: "0.04em" }}>
                  <i style={{ width: 7, height: 7, borderRadius: 999, background: fill.side === "buy" ? TICK_BID : TICK_ASK }} />
                  {fill.side === "buy" ? "BID BUY" : "ASK SELL"} @ {fillPrice(fill, view)}
                </span>
                <span style={{ font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)", textAlign: "right" }} title={fill.motion.timeTitle}>{fill.motion.time}</span>
                <span style={{ font: "var(--weight-regular) var(--text-xs)/1 var(--font-sans)", color: "var(--text-subtle)" }}>{fill.side === "buy" ? `Bought ${context?.base ?? "base"} with ${context?.quote ?? "quote"}` : `Sold ${context?.base ?? "base"} for ${context?.quote ?? "quote"}`}</span>
                {fill.motion.txHash ? <a href={`https://nearblocks.io/txns/${fill.motion.txHash}`} target="_blank" rel="noreferrer" style={{ display: "flex", gap: 4, alignItems: "center", font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)" }}>{short(fill.motion.txHash)}<Icon name="external" size={11} /></a> : <span style={{ font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)" }}>-</span>}
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <Panel title="Liquidity" right={<><span style={{ font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)" }}>{view?.grid.pair ?? "-"} · RHEA DCL</span></>}>
        {view?.grid.pool === null ? <div style={{ height: 200, display: "grid", placeItems: "center", font: "var(--type-body-sm)", color: "var(--text-subtle)" }}>Liquidity profile is not recorded yet.</div> : <GridLiquidity view={view} />}
      </Panel>
      </>) : null}

      <Panel className="fl-position-table">
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: "1px solid var(--line-1)", height: 28 }}>
          {/* HOW OLD THE ROWS ARE. The view polls every 30s, but polling stops
              the moment the read session expires — and a frozen page that looks
              live is worse than no page. The age is stated, and a stopped poll
              says so in the loss colour instead of quietly aging. */}
          <span style={{ font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: detail.state === "ready" ? "var(--text-subtle)" : "var(--loss)" }}>
            {detail.state === "auth-expired" || detail.state === "signed-out"
              ? "NOT UPDATING · read session expired"
              : detail.asOfMs === null
                ? "-"
                : `Updated ${relativeTime(detail.asOfMs, Date.now()).text}`}
          </span>
          <Button variant="ghost" size="sm" style={{ marginLeft: "auto" }} icon={<Icon name="refresh" size={14} />} onClick={() => void detail.refresh()}>Refresh</Button>
        </div>
        <div className="fl-row__head" style={{ gridTemplateColumns: "1.3fr 1fr 1.2fr 1fr 0.9fr 0.9fr auto" }}>
          <span>Position</span><span>Age</span><span>Size</span><span>Side</span><span>Fees</span><span>Unrealised</span><span>Actions</span>
        </div>
        {(view?.positions ?? []).map((position) => {
          const liveOnChain = position.tokenId === null ? undefined : onChain.get(position.tokenId);
          // Price @ from the NFT's OWN range (the chain), not the plane's recorded
          // range for the role: after a re-quote the plane's range lags for
          // minutes. The filled edge is the range's far edge from the tick.
          const rowContext = pairContext(view);
          const liveRange = liveOnChain !== undefined && liveOnChain.liquidity > 0n && rowContext !== null && view?.grid.observedTick !== null && view !== null
            ? { fillTick: rungFillTick({ tickLower: liveOnChain.tickLower, tickUpper: liveOnChain.tickUpper, wbnbIsToken0: view.grid.wbnbIsToken0, holdsWbnb: rungHoldsWbnb({ tickLower: liveOnChain.tickLower, tickUpper: liveOnChain.tickUpper, amount0: liveOnChain.amounts.amount0, amount1: liveOnChain.amounts.amount1, tick: view.grid.observedTick, wbnbIsToken0: view.grid.wbnbIsToken0 }) }), lower: liveOnChain.tickLower, upper: liveOnChain.tickUpper }
            : null;
          const price = liveRange === null || rowContext === null
            ? position.rung?.fillPrice ?? null
            : priceAtTick(liveRange.fillTick, rowContext.pair);
          const band = liveRange !== null && rowContext !== null
            ? `${priceAtTick(liveRange.lower, rowContext.pair)} – ${priceAtTick(liveRange.upper, rowContext.pair)}`
            : position.rung === null ? null : `${position.rung.priceLow} – ${position.rung.priceHigh}`;
          // Size LIVE from the NFT itself: the two legs a full withdrawal would
          // return at the tick just read, priced in WBNB at the page's current
          // tick. The plane's valuation (worker, finalized) is the fallback, so
          // the cell is never a dash while the NFT is readable.
          // Size in the asset the rung HOLDS — an ask is so many base tokens
          // waiting to be sold, a bid so much WBNB waiting to buy — read from
          // the NFT's own legs. The plane's WBNB valuation is the fallback.
          const liveSize = liveOnChain !== undefined && liveOnChain.liquidity > 0n && position.state !== "closed" && view !== null
            ? heldLegText(liveOnChain, position.role !== "sell", view.grid.wbnbIsToken0, pairContext(view))
            : null;
          return (
            <div key={position.positionId} className="fl-row" style={{ gridTemplateColumns: "1.3fr 1fr 1.2fr 1fr 0.9fr 0.9fr auto", cursor: "default", alignItems: "center", ...(position.state === "closed" ? { opacity: 0.55 } : {}) }}>
              <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <PairIcons
                  size={22}
                  token0={{ src: icons[view?.grid.token0?.toLowerCase() ?? ""] ?? tokenLogo(context?.pair.symbol0), symbol: context?.pair.symbol0 ?? null }}
                  token1={{ src: icons[view?.grid.token1?.toLowerCase() ?? ""] ?? tokenLogo(context?.pair.symbol1), symbol: context?.pair.symbol1 ?? null }}
                />
                <span style={{ display: "grid", gap: 4 }}>
                <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)" }}>{position.pair}</span>
                <span style={{ font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)" }}>{position.tokenId === null ? "-" : short(position.tokenId)} · GRID ORDER</span>
                </span>
              </span>
              <span style={{ font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-muted)" }} title={position.ageTitle}>{position.age}</span>
              <span style={{ display: "grid", gap: 6 }}>
                <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-mono)", color: "var(--ink-1)" }} title={liveSize === null ? position.value.note : `Live from chain: NFT ${liveOnChain?.tokenId.toString(10) ?? ""} at tick ${view?.grid.observedTick ?? ""}`}>{liveSize ?? metricValue(position.value)}</span>
                <span style={{ font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)" }} title={band === null ? undefined : `rung ${band} ${context?.quote ?? ""}`}>Price @ {price ?? "-"} {context?.quote ?? "-"}</span>
              </span>
              <span style={{ display: "grid", gap: 4 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 7, font: "var(--weight-medium) var(--text-xs)/1 var(--font-mono)", color: position.role === "bid" ? TICK_BID : position.role === "ask" ? TICK_ASK : "var(--ink-1)", letterSpacing: "0.04em" }}>{sideIcon(view, icons, position.role)}{position.sideLabel ?? "-"}</span>
                <span style={{ font: "var(--weight-regular) var(--text-xs)/1 var(--font-sans)", color: liveOnChain !== undefined && liveOnChain.liquidity > 0n && position.state === "closed" ? "var(--warning)" : "var(--text-subtle)" }}>{liveOnChain !== undefined && liveOnChain.liquidity > 0n && position.state === "closed" ? "Closed here, live on chain" : liveOnChain !== undefined && liveOnChain.liquidity === 0n && position.state !== "closed" ? "Filled · re-quoting" : positionStateLabel(position.state)}</span>
              </span>
              <Num value="-" tone="flat" size="sm" />
              <Num value={metricValue(position.unrealised)} tone={metricTone(metricValue(position.unrealised))} size="sm" />
              <span style={{ display: "flex", gap: 8 }}>
                <span>-</span>
                {liveOnChain !== undefined && liveOnChain.liquidity > 0n
                  ? <Button variant="danger" size="sm" disabled={busy} title={`This NFT still holds liquidity on chain${position.state === "closed" ? ", though the agent recorded it closed" : ""}. Closing it sends both legs to your wallet.`} onClick={() => { if (window.confirm(`Close NFT ${liveOnChain.tokenId.toString(10)} on chain with your passkey? Both legs go to your wallet; you can withdraw them from the Account page.`)) closePositionNow(liveOnChain); }}>Close on chain</Button>
                  : null}
              </span>
            </div>
          );
        })}
        {discovered.map((nft) => {
          // A rung the chain holds and the plane has not recorded yet. Side and
          // fill edge from the range against the page's current tick: a range
          // above the tick holds token0 and completes at its far edge.
          const tick = view?.grid.observedTick ?? null;
          const context = pairContext(view);
          const holdsWbnb = view === null || tick === null ? null : rungHoldsWbnb({ tickLower: nft.tickLower, tickUpper: nft.tickUpper, amount0: nft.amounts.amount0, amount1: nft.amounts.amount1, tick, wbnbIsToken0: view.grid.wbnbIsToken0 });
          const fillTick = holdsWbnb === null || view === null ? nft.tickUpper : rungFillTick({ tickLower: nft.tickLower, tickUpper: nft.tickUpper, holdsWbnb, wbnbIsToken0: view.grid.wbnbIsToken0 });
          const fillPrice = context === null ? null : priceAtTick(fillTick, context.pair);
          const size = holdsWbnb === null || view === null ? null : heldLegText(nft, holdsWbnb, view.grid.wbnbIsToken0, context);
          const id = nft.tokenId.toString(10);
          return (
            <div key={`discovered-${id}`} className="fl-row" style={{ gridTemplateColumns: "1.3fr 1fr 1.2fr 1fr 0.9fr 0.9fr auto", cursor: "default", alignItems: "center" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ display: "grid", gap: 3 }}>
                  <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)" }}>{view?.grid.pair ?? "-"}</span>
                  <span style={{ font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--warning)" }} title="On chain in the agent wallet now; the plane records it once the relay confirms the batch.">{id} · NEW RUNG · NOT RECORDED YET</span>
                </span>
              </span>
              <span style={{ font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-muted)" }}>just now</span>
              <span style={{ display: "grid", gap: 6 }}>
                <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-mono)", color: "var(--ink-1)" }} title={`Live from chain: NFT ${id} at tick ${tick ?? ""}`}>{size ?? "-"}</span>
                <span style={{ font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)" }}>Price @ {fillPrice ?? "-"} {context?.quote ?? "-"}</span>
              </span>
              <span style={{ display: "grid", gap: 4 }}>
                <span style={{ font: "var(--weight-medium) var(--text-xs)/1 var(--font-mono)", color: "var(--ink-1)", letterSpacing: "0.04em" }}>{holdsWbnb === null || context === null ? "-" : gridSideLabel(holdsWbnb ? "buy" : "sell", context.pair)}</span>
                <span style={{ font: "var(--weight-regular) var(--text-xs)/1 var(--font-sans)", color: "var(--text-subtle)" }}>Open order</span>
              </span>
              <Num value="-" tone="flat" size="sm" />
              <Num value="-" tone="flat" size="sm" />
              <span style={{ display: "flex", gap: 8 }}>
              </span>
            </div>
          );
        })}
        {(view?.positions.length ?? 0) === 0 ? <div className="fl-row" style={{ gridTemplateColumns: "1.3fr 1fr 1.2fr 1fr 0.9fr 0.9fr auto", cursor: "default", alignItems: "center" }}>{view?.grid.liveRows === null ? "Unavailable" : "-"}</div> : null}
      </Panel>
    </div>
  );
}

function sideIcon(
  view: AgentDetailView | null | undefined,
  icons: Record<string, string | null>,
  role: string,
): React.ReactNode {
  if (view == null) return null;
  // The icon is the asset the rung HOLDS, read through the display seam.
  const side = role === "buy" || role === "sell" ? displaySide(role, view.grid.sideInverted) : null;
  const address = side === "sell" ? view.grid.baseAddress : side === "buy" ? view.grid.quoteAddress : null;
  const symbol = side === "sell" ? view.grid.base : side === "buy" ? view.grid.quote : null;
  if (address === null && symbol === null) return null;
  return <TokenIcon src={icons[address?.toLowerCase() ?? ""] ?? tokenLogo(symbol)} symbol={symbol} size={16} />;
}

function usePairIcons(token0: string | undefined, token1: string | undefined): Record<string, string | null> {
  const [icons, setIcons] = React.useState<Record<string, string | null>>({});
  return icons;
}

export function NearGridBody({ detail, model, details }: { detail: UseAgentDetailResult; model: string; details: React.ReactNode }) {
  const [now, setNow] = useState(Date.now());
  React.useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const [runFilter, setRunFilter] = useState("All");
  const [tab, setTab] = useState<Tab>("Overview");
  const [delegatedUnit, setDelegatedUnit] = useState<"USD" | "NEAR">("USD");
  const view = detail.view;
  const liveView = view;
  const onChain: ReadonlyMap<string, OnChainPosition> = new Map();
  const discovered: readonly OnChainPosition[] = [];
  const emptyRungs: readonly OnChainPosition[] = [];
  const busy = false;
  const closePositionNow = () => undefined;
  const actionsDisabled = false;
  const cat = Category("grid");
  const status = (view?.status === "armed" ? "live" : "paused");
  const statusLabel = view === null ? "-" : (["provisioning", "revoked", "retired"].includes(view.status) ? view.status : undefined);
  const limit = view?.dailyNativeLimit;
  const delegatedUsd = limit?.usd ?? null;
  const delegatedBnb = limit?.bnb ?? null;
  const delegated = limit === undefined || limit.value === null
    ? metricValue(limit)
    // A metric that carries no split units still renders its own text.
    : (delegatedUnit === "USD" ? delegatedUsd ?? delegatedBnb : delegatedBnb ?? delegatedUsd) ?? limit.value;
  // Gross first: it is defined from the moment the grid is armed, while the
  // realised figure waits for a completed round trip and dashes until then.
  const delta = metricValue(view?.grossPnl);
  const percent = metricValue(view?.grossPnlPercent);
  // PnL follows the Delegated unit toggle; the percent and the basis note come from the metrics.
  const pnl = view?.grossPnl;
  const pnlShown = pnl?.value == null ? tileValue(pnl) : (delegatedUnit === "USD" ? pnl.usd ?? pnl.bnb : pnl.bnb ?? pnl.usd) ?? pnl.value;
  // Read back from the SIGNED geometry: the preset name is never signed, so the
  // only honest label is the one this gap/width reproduces at this spacing.
  const sequences = view?.sequences ?? [];
  // AGENT-GAS-ATTENTION §5 — the run-log bucket filter.
  const shownSequences = sequences.filter((sequence) =>
    runFilter === "All"
    || (runFilter === "Succeeded" ? sequenceOutcome(sequence) === "succeeded" : sequenceOutcome(sequence) === "failed"));
  return (
    <>
      {/* One row, equal columns, equal heights: each tile is its own grid item
          and stretches, and the Delegated wrapper stretches WITH it (a plain
          span left its tile short). No footnotes here — the operator reads
          these as four numbers, not as four numbers and an essay. */}
      <div className="fl-metrics-grid" style={{ display: "grid", gridTemplateColumns: "repeat(5,minmax(0,1fr))", gap: 16, marginBottom: 20, alignItems: "stretch" }}>
        <span style={{ position: "relative", display: "grid" }}>
          <MetricTile label="Delegated" value={delegated} style={{ height: "100%" }} />
          <span style={{ position: "absolute", top: 14, right: 14 }}>
            <SegmentedToggle className="fl-seg fl-seg--mini" options={[{ value: "USD", label: "USD" }, { value: "NEAR", label: "NEAR" }]} value={delegatedUnit} onChange={(next: string) => setDelegatedUnit(next === "NEAR" ? "NEAR" : "USD")} />
          </span>
        </span>
        <MetricTile size="sm" label="Execution model" value={model} note={utilizationNote(view)} style={{ height: "100%", whiteSpace: "nowrap" }} />
        {/* A dash still needs its reason — "why is this empty" is the question
            an empty tile provokes — but a tile that HAS a number says it with
            the number alone. */}
        <MetricTile label="PnL since hire" value={pnlShown} tone={metricTone(delta)} note={view?.grossPnl?.loading === true ? undefined : emptyNote(view?.grossPnl)} style={{ height: "100%" }} />
        <MetricTile label="PNL by percent" value={tileValue(view?.grossPnlPercent)} tone={metricTone(percent)} note={view?.grossPnlPercent?.loading === true ? undefined : emptyNote(view?.grossPnlPercent)} style={{ height: "100%" }} />
        <MetricTile label="HODL benchmark" value={tileValue(view?.hodl)} tone="flat" style={{ height: "100%" }} />
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16 }}>
        <SegmentedToggle value={tab} onChange={(value: string) => setTab(value as Tab)} options={["Overview", "Run log", "Details"]} />
      </div>

      {tab === "Details" && details}
      {tab === "Overview" && <GridDetail detail={detail} view={liveView} onChain={onChain} discovered={discovered} emptyRungs={emptyRungs} busy={busy} closePositionNow={closePositionNow} />}

      {/* The design export put a "Health factor" chart in the GRID column. It
          was always empty here — a grid agent has no health factor — and the
          lending guard now renders its own on `LendingAgentDetail`, so the
          placeholder is gone rather than dashed (MARKETPLACE-LENDING-AGENT §9). */}
      {tab === "Run log" && (
        <div className="fl-detail-grid" style={{ display: "grid", gap: 16, alignItems: "start" }}>
          <section style={{ border: "1px solid var(--border-card)", borderRadius: "var(--radius-md)", background: "var(--surface-card)", padding: "8px 20px 16px" }}>
            {/* AGENT-GAS-ATTENTION §5 — the same three buckets the LP page uses. */}
            <div style={{ padding: "8px 0 12px" }}>
              <SegmentedToggle options={["All", "Succeeded", "Failed"]} value={runFilter} onChange={setRunFilter} />
            </div>
            {/* Bounded height. This list had NONE, so a grid that shifts every
                few minutes turned the page into an endless footer — the defect
                `LpAgentDetail` fixed for itself on 2026-09-06 and this screen
                inherited nothing from. */}
            <div data-testid="grid-run-log" style={{ maxHeight: 520, overflowY: "auto" }}>
              {shownSequences.map((sequence) => {
                const time = relativeTime(sequence.updatedAt, now);
                const txHash = sequence.txHashes.at(-1);
                return <ActivityRow key={sequence.sequenceId} timeline title={sequence.kind} detail={sequence.recoveryState + (sequence.note ? " · " + sequence.note : "")} time={time.text} {...(txHash === undefined ? {} : { txHash: short(txHash), href: `https://nearblocks.io/txns/${txHash}` })} />;
              })}
              {shownSequences.length === 0
                ? <p style={{ font: "var(--type-mono-xs)", color: "var(--text-subtle)" }}>
                    {sequences.length === 0 ? "No runs recorded yet." : `No ${runFilter.toLowerCase()} runs in this history.`}
                  </p>
                : null}
            </div>
          </section>
        </div>
      )}
    </>
  );
}

const JOBS_UNAVAILABLE = "Job status is temporarily unavailable.";
// Public agent page 4.2: a visitor (signed out, or another account) loads the public view of a link-confirmed job.
type PublicLoad = { status: "loading" | "ready" | "missing" | "error"; job: Job | null; at: number };
const PUBLIC_LOADING: PublicLoad = { status: "loading", job: null, at: 0 };
const READ_ONLY_LINE = "Read-only view. Only the owner wallet can freeze, stop or resume this agent.";
const publicJobOk = (v: unknown, id: string): v is Job => !!v && typeof v === "object" && (v as Job).id === id && typeof (v as Job).owner === "string" && typeof (v as Job).state === "string";
const tokenName = (token: string) => token === WNEAR ? "wNEAR" : token === USDC ? "USDC" : token;
const GRID_PRESET: Record<number, string> = { 45: "Tight", 90: "Balanced", 150: "Wide", 300: "Volatile" };
/** The Execution model tile: Grid V2 names the preset and orders from the owner settings; a V1 job keeps its fixed geometry. */
export function gridModel(job: Job): string {
  const s = job.grid?.settings;
  return s && s !== "invalid" ? `${GRID_PRESET[s.step] ?? `${s.step} pts`} · ${s.orders} orders` : "Grid V1 · 4 lanes";
}

export function NearJobScreen({ jobId, go }: Props) {
  const actions = useNearSession();
  const { account, jobs, lastPollMs, message, busy } = actions.state;
  const { mountJob } = actions;
  React.useEffect(() => mountJob(jobId), [mountJob, jobId, account]);
  const [chartInterval, setChartInterval] = useState<ChartInterval>("1m");
  const [chartUnit, setChartUnit] = useState<ChartUnit>("usd");
  const [tab, setTab] = useState<Tab>("Overview");
  const [runFilter, setRunFilter] = useState("All");
  // Spec UI step 3, section 5: the hire popup, opened from the setup section; it reuses this page's job mount.
  const [runOpen, setRunOpen] = useState(false);
  const ownerJob = jobs.find(job => job.id === jobId && job.owner === account);
  // After a reload the session and the first job list load after the first render: wait for them before deciding owner or visitor.
  const settled = !!actions.state.mounted && (!account || lastPollMs > 0 || message === JOBS_UNAVAILABLE);
  const wantPublic = settled && !ownerJob;
  const [pub, setPub] = useState<PublicLoad>(PUBLIC_LOADING);
  const loadPublic = React.useRef<() => Promise<void>>(async () => {});
  React.useEffect(() => {
    setPub(PUBLIC_LOADING);
    if (!wantPublic) return;
    let active = true, loading = false;
    const refresh = async () => {
      if (document.visibilityState !== "visible" || loading) return;
      loading = true;
      try {
        const result = await api<unknown>("/api/public/jobs/" + encodeURIComponent(jobId));
        if (active) setPub(publicJobOk(result, jobId) ? { status: "ready", job: result, at: Date.now() } : { status: "missing", job: null, at: 0 });
      } catch (e) {
        if (active) setPub(prev => e instanceof Error && e.message === "Not found." ? { status: "missing", job: null, at: 0 } : prev.job ? prev : { status: "error", job: null, at: 0 });
      } finally { loading = false; }
    };
    loadPublic.current = refresh;
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 15000);
    document.addEventListener("visibilitychange", refresh);
    return () => { active = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [jobId, account, wantPublic]);
  const job = ownerJob ?? pub.job ?? undefined, readOnly = !ownerJob;
  if (!job) {
    if (!settled || pub.status === "loading") return <EmptyState icon="wallet" title="Loading agent" />;
    if (pub.status === "error") return <EmptyState icon="wallet" title={JOBS_UNAVAILABLE} />;
    return <EmptyState icon="wallet" title="Agent not found"
      action={account ? <Button variant="secondary" onClick={() => go("/account")}>Back to Account</Button> : undefined}>
      {account ? null : "If this is your agent, sign in with the owner wallet."}
    </EmptyState>;
  }
  const asOf = readOnly ? pub.at : lastPollMs;
  const presentation = rowPresentation(job), cat = Category(job.kind === "lp" ? "lp" : job.trade ? "trading" : "grid");
  // Trade V1: a trade job holds its own pinned token instead of USDC.
  const token = job.trade?.pair.token ?? USDC, symbol = job.trade?.pair.symbol ?? "USDC";
  const link = readOnly ? undefined : actions.link(job.id), saved = !readOnly && actions.isSaved(job.id), transfer = readOnly ? null : actions.transfer(job.id);
  // The header shows warnings and the few lines the owner must act on (top); the rest sits under "Show details".
  const messages: { text: string; warning: boolean; top?: boolean }[] = [];
  if (readOnly) messages.push({ text: READ_ONLY_LINE, warning: false, top: true });
  messages.push({ text: `Owner: ${job.owner}`, warning: false });
  if (!readOnly) {
    messages.push({ text: `Owner balance: ${fmt(job.ownerBalance)}. Keep at least 0.1 NEAR for a freeze.`, warning: false });
    if (job.ownerBalance !== null && BigInt(job.ownerBalance) < 10n ** 23n) messages.push({ text: 'Your wallet is below the emergency freeze reserve.', warning: true });
  }
  const dcl = job.grid ?? job.lp;
  if (job.agentAccount) messages.push({ text: `Agent wallet: ${job.agentAccount}. Native balance: ${fmt(job.agentBalance)}.`, warning: false });
  if (job.holdings) {
    messages.push({ text: `Finalized at block ${job.holdings.block}. The policy bounds native transfers. It does not bound token transfers through calls.`, warning: false });
    messages.push({ text: job.trade ? `wNEAR: ${fmt(job.holdings.tokens[WNEAR] ?? null).replace(' NEAR', ' wNEAR')}. ${symbol}: ${asset(token, job.holdings.tokens[token] ?? '0')}.`
      : `wNEAR: ${fmt(job.holdings.tokens[WNEAR] ?? null).replace(' NEAR', ' wNEAR')}. USDC: ${((BigInt(job.holdings.tokens[USDC] ?? '0')) / 1000000n).toString()}.${(BigInt(job.holdings.tokens[USDC] ?? '0') % 1000000n).toString().padStart(6, '0')} USDC.`, warning: false });
  }
  if (job.grid) {
    const grid = job.grid;
    messages.push({ text: 'The owner pays 0.5 NEAR for DCL registration of the agent wallet shown above. DCL locks that amount separately from the agent deposit.', warning: false });
    if (!readOnly && grid.available && grid.issued && !grid.registered) messages.push({ text: 'Registration was issued. Check your wallet activity and wait for finality. If declined or unknown, follow the runbook before any manual retry.', warning: true });
    if (!grid.enabled) messages.push({ text: 'Grid strategy is disabled. Freeze and Stop and withdraw remain available when eligible.', warning: true });
    if (!grid.available || grid.point === null) messages.push({ text: 'Finalized DCL status is unavailable.', warning: true });
    else {
      messages.push({ text: `DCL point ${grid.point}: ${(10 ** 18 / 1.0001 ** grid.point).toPrecision(6)} USDC per NEAR. ${grid.anchor === null ? 'Anchor pending.' : `Anchor ${grid.anchor}.`}`, warning: false });
      for (const [token, raw] of Object.entries(grid.internal)) if (BigInt(raw) > 0n) messages.push({ text: `DCL internal balance: ${asset(token, raw)}.`, warning: false });
      for (const [token, raw] of Object.entries(grid.lost)) if (BigInt(raw) > 0n) messages.push({ text: `DCL lost-found: ${asset(token, raw)}. Use the saved management link for recovery.`, warning: true });
      if (grid.positions) messages.push({ text: `DCL holds ${grid.positions} liquidity position(s). Use the saved management link for recovery.`, warning: true });
      for (const o of grid.orders) messages.push({ text: `DCL order ${o.id}: sells ${o.sell === USDC ? 'USDC' : 'wNEAR'} at ${o.point}; ${asset(o.sell, o.remain)} remaining, ${asset(o.buy, o.bought)} bought, ${asset(o.buy, o.unclaimed)} unclaimed.`, warning: false });
    }
    if (grid.settings === 'invalid') messages.push({ text: 'Grid settings are unreadable. Stop and withdraw.', warning: true });
    else if (grid.settings) messages.push({ text: `Owner settings: ${grid.settings.orders} orders, step ${grid.settings.step} points; stop loss ${grid.settings.stopLossPct ? `${grid.settings.stopLossPct}%` : 'off'}; take profit ${grid.settings.takeProfitPct ? `${grid.settings.takeProfitPct}%` : 'off'}. Job value in NEAR: ${fmt(grid.value ?? null)}.`, warning: false });
    if (grid.protect?.fired) {
      const f = grid.protect.fired;
      messages.push({ text: `Protection stopped this job: ${f.kind}, value ${fmt(f.value)}, deposit basis ${fmt(f.basis)}, block ${f.block}, at ${new Date(f.at).toISOString()}.`, warning: false });
    }
    for (const [i, l] of grid.lanes.entries()) messages.push({ text: `Lane ${i + 1}: ${l.points ? `initial point ${l.points[0]}, reverse point ${l.points[1]}` : 'points unavailable'}. ${l.orderId ? `Order ${l.orderId}` : `${l.native ? exactNear(BigInt(l.amount)) : asset(l.sell, l.amount)} assigned in wallet`}.`, warning: false });
    if (job.frozen === true) messages.push({ text: 'Resting DCL orders can still fill while the agent wallet is frozen.', warning: true });
  }
  if (job.lp) {
    const lp = job.lp;
    if (lp.settings) {
      messages.push({ text: `Initial position: ${fmt(lp.initialPosition ?? null)}. Current position estimate: ${fmt(lp.positionValue ?? null)}. Job value in NEAR: low ${fmt(lp.valueLow ?? null)}, high ${fmt(lp.valueHigh ?? null)}.`, warning: false });
      if (lp.settings === 'invalid') messages.push({ text: 'LP settings are unreadable. Stop and withdraw.', warning: true });
      else messages.push({ text: `Owner settings, bounded by the signed policy: AI ${lp.settings.ai ? 'on' : 'off'}; compound ${lp.settings.compound.on ? `on at ${lp.settings.compound.minFeeBps} basis points` : 'off'}; stop loss ${lp.settings.stopLossPct ? `${lp.settings.stopLossPct}%` : 'off'}; take profit ${lp.settings.takeProfitPct ? `${lp.settings.takeProfitPct}%` : 'off'}.`, warning: false });
      if (lp.recentred) messages.push({ text: 'The planned range was re-centred on a fresh finalized price.', warning: false });
      if (lp.lastDecision) messages.push({ text: `Last range decision: ${lp.lastDecision.verdict}${lp.lastDecision.code ? ` (${lp.lastDecision.code})` : ''}, points ${lp.lastDecision.range.left} to ${lp.lastDecision.range.right}, at ${new Date(lp.lastDecision.at).toISOString()}.`, warning: false });
      if (lp.protect?.fired) {
        const f = lp.protect.fired;
        messages.push({ text: `Protection stopped this job: ${f.kind}, value ${fmt(f.value)}, deposit basis ${fmt(f.basis)}, block ${f.block}, at ${new Date(f.at).toISOString()}.`, warning: false });
      }
    }
    messages.push({ text: 'The owner pays 0.5 NEAR for DCL registration of the agent wallet shown above. DCL locks that amount separately from the agent deposit.', warning: false });
    if (!readOnly && lp.available && lp.issued && !lp.registered) messages.push({ text: 'Registration was issued. Check your wallet activity and wait for finality. If declined or unknown, follow the runbook before any manual retry.', warning: true });
    if (!lp.enabled) messages.push({ text: 'LP strategy is disabled. Freeze and Stop and withdraw remain available when eligible.', warning: true });
    if (!lp.available || lp.point === null) messages.push({ text: 'Finalized DCL status is unavailable.', warning: true });
    else {
      messages.push({ text: `DCL point ${lp.point}: ${(10 ** 18 / 1.0001 ** lp.point).toPrecision(6)} USDC per NEAR.`, warning: false });
      for (const [token, raw] of Object.entries(lp.internal)) if (BigInt(raw) > 0n) messages.push({ text: `DCL internal balance: ${asset(token, raw)}.`, warning: false });
      for (const [token, raw] of Object.entries(lp.lost)) if (BigInt(raw) > 0n) messages.push({ text: `DCL lost-found: ${asset(token, raw)}. Use the saved management link for recovery.`, warning: true });
      if (lp.positions > (lp.position ? 1 : 0)) messages.push({ text: `DCL holds ${lp.positions} liquidity position(s). Use the saved management link for recovery.`, warning: true });
    }
    if (lp.range) {
      const r = lp.range;
      messages.push({ text: `Range: points ${r.left} to ${r.right}, ${r.rightPrice.toPrecision(6)} to ${r.leftPrice.toPrecision(6)} USDC per NEAR. ${r.inRange === null ? 'Range status unavailable.' : r.inRange ? 'In range.' : `Out of range${r.outSince ? ` since ${new Date(r.outSince).toISOString()}` : ''}.`}`, warning: false });
    }
    if (lp.position) {
      const p = lp.position;
      messages.push({ text: `Position ${p.id}: liquidity ${p.liquidity}. Opened with ${asset(USDC, p.paidX)} and ${asset(WNEAR, p.paidY)}. Unclaimed fees: ${p.fees ? `${asset(USDC, p.fees[0])} and ${asset(WNEAR, p.fees[1])}` : 'unavailable'}. Estimate if removed now: ${p.estimate ? `${asset(USDC, p.estimate[0])} and ${asset(WNEAR, p.estimate[1])}` : 'unavailable'}.`, warning: false });
    }
    if (lp.ledger) messages.push({ text: `Recorded in the wallet: ${asset(USDC, lp.ledger.usdc)}, ${asset(WNEAR, lp.ledger.wnear)}, ${exactNear(BigInt(lp.ledger.native))}. Recorded inside DCL: ${asset(USDC, lp.ledger.inUsdc)}, ${asset(WNEAR, lp.ledger.inWnear)}.`, warning: false });
    messages.push({ text: `Rotations in the last 24 hours: ${lp.rotations} of 2.${lp.pending ? ` Pending step: ${lp.pending.kind.replaceAll('_', ' ')}.` : ''}`, warning: false });
    if (job.frozen === true) messages.push({ text: 'A resting position keeps converting with the price while the wallet is frozen. Nothing needs a signature.', warning: true });
  }
  for (const t of job.extraTokens) messages.push({ text: `Outside this job: ${t.token}, ${t.amount} raw units. Left in the agent wallet.`, warning: false });
  if (job.state === 'policy_prepared') messages.push({ text: 'This account has no verified policy yet. Do not send NEAR to it.', warning: true });
  else if (job.agentAccount && !job.linkConfirmed) messages.push({ text: 'Do not send NEAR until the management link is confirmed and the funding step appears.', warning: true });
  if (job.agentBalance && BigInt(job.agentBalance) > 0n && !job.linkConfirmed) messages.push({ text: 'NEAR arrived early. Save the recovery link; the worker cannot use these funds.', warning: true });
  // While a funding transfer is unresolved, no second funding instruction (spec UI step 3, section 4).
  if (transfer) {
    if (inSetup(job)) messages.push({ text: 'Transfer submitted. Waiting for the finalized balance.', warning: false, top: true });
    else if (!['ready', 'running'].includes(job.state)) messages.push({ text: TRANSFER_STOPPED_WARNING, warning: true });
  } else if (job.canFund) messages.push({ text: fundingLine(job), warning: false, top: true });
  else if (job.state === 'link_confirmed' && !readOnly) messages.push({ text: dcl && !dcl.available ? 'Waiting for finalized DCL data before funding.' :
    `Wait for the wallet policy and watchdog checks${dcl && !dcl.registered ? ' and finalized DCL registration' : ''} before sending NEAR.`, warning: true });
  if (job.state === 'stopping' && job.frozen) messages.push({ text: 'Unfreeze to withdraw.', warning: true });
  else if (job.state === 'stopping' && job.pendingSubmission !== 'ambiguous') messages.push({ text: STOPPING_WAIT, warning: false, top: true });
  if (job.pendingSubmission === 'ambiguous') messages.push({ text: 'A submission remains unresolved. No new operation or withdrawal can run. Use the saved management link for recovery.', warning: true });
  const waiting = waitingForChain(job);
  const resume = resumeLabel(job);
  const resumeEnabled = canRequestResume(job);
  const resumeNote = job.state === 'halted' ? (resumeEnabled ? BLIND_RESUME : job.resumeBlockedReason ?? BLIND_CHECKS) : null;
  const resumeNoteId = `resume-note-${job.id}`;
  if (waiting) messages.push({ text: CHAIN_WAIT, warning: true });
  if (job.reason && !(waiting && job.reason === 'Finalized chain data is unavailable.')) messages.push({ text: job.reason, warning: false, top: true });
  for (const a of job.alerts) if (!(waiting && a.kind === 'blind' && a.severity === 'info')) {
    messages.push({ text: `${a.severity}: ${a.kind}. ${a.detail.message ?? ''}`, warning: a.severity !== 'info' });
  }
  const topLines = messages.filter(line => line.warning || line.top);
  if (!job.blindHalt && ['cancelled', 'failed', 'halted'].includes(job.state)) messages.push({ text: 'The worker will not use funds before the hire checks pass. If you funded this account early, use the saved management link to recover them.', warning: false });
  const setupRun = hireRunSteps(job, { policySent: actions.sentPolicy.has(job.id), linkShown: link !== undefined, saved, transfer });
  const view = toAgentDetailView(job, asOf);
  const detail: UseAgentDetailResult = { state: "ready", view, market: null, chartCandles: null, chartBanner: null, chartInterval, setChartInterval, chartUnit, setChartUnit, asOfMs: asOf, message: "", marketReason: "Price history is not recorded yet.", readHeaders: {}, refresh: readOnly ? () => loadPublic.current() : actions.refresh };
  const sequences = toSequences(job, asOf).filter(sequence => sequence.sequenceId !== 'pending');
  const shownSequences = sequences.filter(sequence => runFilter === "All" || (runFilter === "Succeeded" ? sequenceOutcome(sequence) === "succeeded" : sequenceOutcome(sequence) === "failed"));
  return <div className="fl-shell fl-hired-agent-page">
    {!readOnly && runOpen && <NearHireRun jobId={job.id} go={route => { setRunOpen(false); go(route); }} onClose={() => setRunOpen(false)} ownMount={false} />}
    <Button variant="ghost" size="sm" icon={<Icon name="chevron-right" size={14} style={{ transform: "rotate(180deg)" }} />} onClick={() => go(readOnly ? "/" : "/account")}>{readOnly ? "Marketplace" : "My agents"}</Button>
    <div className="fl-hired-hero" style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 24, flexWrap: "wrap", margin: "16px 0 24px" }}>
      <div style={{ display: "flex", gap: 16 }}>
        <span className="fl-card__glyph" style={{ width: 44, height: 44, color: cat.color, borderColor: cat.color, background: cat.tint }}><Icon name={cat.icon} size={22} /></span>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <h1 style={{ font: "var(--type-page-title)" }}>{catalogName(job) + " · " + job.id.slice(0, 8)}</h1>
            <StatusBadge status={presentation.status} pill label={presentation.statusLabel} />
            {job.frozen === true && presentation.statusLabel !== "Frozen" && <StatusBadge status="warning" pill label="Frozen" />}
            {readOnly && <StatusBadge status="paused" pill label="Read-only" />}
          </div>
          {topLines.map((line, index) => <span key={index} role="status" style={{ font: "var(--type-body-sm)", color: line.warning ? "var(--warning)" : "var(--text-muted)", overflowWrap: "anywhere" }}>{line.text}</span>)}
          {!readOnly && message && <span role="status" style={{ font: "var(--type-mono-xs)", color: "var(--text-subtle)" }}>{message}</span>}
          {link && <>
            <span style={{ font: "var(--type-mono-xs)", color: "var(--text-subtle)" }}>Save this link privately. It grants access to the wallet.</span>
            <code style={{ overflowWrap: "anywhere" }}>{link}</code>
          </>}
        </div>
      </div>
      {!readOnly && <div className="fl-hired-actions" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {dcl?.canRegister && <Button variant="secondary" disabled={busy} onClick={() => void actions.registerDcl(job)}>Register agent on DCL (0.5 NEAR)</Button>}
        {job.payload && !actions.sentPolicy.has(job.id) && <Button variant="secondary" disabled={busy} onClick={() => void actions.storePolicy(job)}>Store policy in wallet</Button>}
        {job.canReveal && !link && <Button variant="secondary" icon={<Icon name="settings" size={15} />} disabled={busy} onClick={() => void actions.reveal(job)}>Reveal management link</Button>}
        {link && <Button variant="secondary" disabled={busy} onClick={() => void actions.hideLink(job)}>Hide link</Button>}
        {job.state === 'armed' && job.linkDelivered && <>
          <label><input type="checkbox" checked={saved} onChange={event => actions.setSaved(job.id, event.target.checked)} /> I saved the management link</label>
          <Button variant="secondary" disabled={busy} onClick={() => void actions.confirmLink(job)}>Confirm saved link</Button>
        </>}
        {presentation.section === 'setup' && <Button variant="primary" disabled={busy} onClick={() => setRunOpen(true)}>Continue setup</Button>}
        {retirable(job) && !transfer && <Button variant="secondary" disabled={busy} title="Close this job for good. The agent wallet holds only dust; nothing is moved." onClick={() => { if (window.confirm(RETIRE_CONFIRM)) void actions.retire(job); }}>Retire</Button>}
        {!job.canStopEarly && !transfer && ['draft', 'registered', 'policy_prepared', 'armed', 'link_confirmed'].includes(job.state) && <Button variant="secondary" disabled={busy} onClick={() => void actions.cancel(job)}>Cancel hire</Button>}
        {job.walletPubkey && job.frozen !== null && !['cancelled', 'failed', 'stopped', 'retired'].includes(job.state) && !actions.pendingFreeze.has(job.id) && <Button variant="secondary" icon={<Icon name="pause" size={15} />} disabled={busy} onClick={() => void actions.toggleFreeze(job)}>{job.frozen ? 'Unfreeze' : 'Freeze now'}</Button>}
        {resume && <div style={{ display: 'grid', gap: 6 }}>
          <Button variant="secondary" disabled={busy || !resumeEnabled} aria-describedby={resumeNote ? resumeNoteId : undefined}
            onClick={resumeEnabled ? () => void actions.resume(job) : undefined}>{resume}</Button>
          {resumeNote && <span id={resumeNoteId} role="status" style={{ font: 'var(--type-body-sm)', color: 'var(--text-muted)' }}>{resumeNote}</span>}
        </div>}
        {job.linkConfirmed && job.pendingSubmission !== 'ambiguous' && (job.canStopEarly || ['funded', 'ready', 'running', 'paused', 'resuming', 'halted', 'frozen'].includes(job.state)) && <Button variant="danger" icon={<Icon name="revoke" size={15} />} disabled={busy} onClick={() => void actions.stop(job)}>Stop and withdraw</Button>}
      </div>}
    </div>
    {presentation.section === 'setup' ? <>
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16 }}>
        <SegmentedToggle value={tab} onChange={(value: string) => setTab(value as Tab)} options={["Overview", "Run log", "Details"]} />
      </div>
      {tab === "Details" && <JobDetails job={job} />}
      {tab === "Overview" && <Panel title="Setup" pad={16}>
        <HireStepList steps={setupRun.steps} color={cat.color} />
      </Panel>}
      {tab === "Run log" && <Panel pad={16}>
        <SegmentedToggle options={["All", "Succeeded", "Failed"]} value={runFilter} onChange={setRunFilter} />
        <div style={{ maxHeight: 520, overflowY: "auto" }}>
          {shownSequences.map(sequence => <ActivityRow key={sequence.sequenceId} timeline title={sequence.kind} detail={sequence.recoveryState + (sequence.note ? " · " + sequence.note : "")} time={relativeTime(sequence.updatedAt, Date.now()).text} {...(sequence.txHashes[0] ? { txHash: short(sequence.txHashes[0]), href: `https://nearblocks.io/txns/${sequence.txHashes[0]}` } : {})} />)}
          {shownSequences.length === 0 && <p style={{ font: "var(--type-mono-xs)", color: "var(--text-subtle)" }}>{sequences.length === 0 ? "No runs recorded yet." : `No ${runFilter.toLowerCase()} runs in this history.`}</p>}
        </div>
      </Panel>}
    </> : job.kind === 'lp' ? <NearLpDetail view={view} detail={detail} liquidity={job.lp?.position?.liquidity ?? null} executionModel={job.lp?.settings ? 'LP V2' : 'LP V1 · 0.4 NEAR'} rebalances={job.lp ? { count: job.lp.rotations, cap: 2 } : null} compound={job.lp?.settings && job.lp.settings !== 'invalid' ? { on: job.lp.settings.compound.on, count: job.lp.compounds?.count ?? 0, lastAt: job.lp.compounds?.lastAt ?? null } : null} details={<JobDetails job={job} />} />
      : job.trade ? <>
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16 }}>
          <SegmentedToggle value={tab === "Details" ? "Details" : "Overview"} onChange={(value: string) => setTab(value as Tab)} options={["Overview", "Details"]} />
        </div>
        {tab === "Details" ? <JobDetails job={job} /> : <NearTradeBody job={job} />}
      </> : <NearGridBody detail={detail} model={gridModel(job)} details={<JobDetails job={job} />} />}
    <FundsCards job={job} readOnly={readOnly} />
  </div>;
}
