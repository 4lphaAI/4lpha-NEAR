"use client";
import React from "react";
import { MarketChart } from "@/components/MarketChart";
import { Button, Icon, MetricTile, SegmentedToggle } from "@/design-system";
import { CHART_INTERVALS, type ChartInterval } from "@/lib/exec/agent-detail";
import { TRADE_POOL_KEY, usdMicros, usdText } from "@/lib/near-map";
import { asset, exactNear, fmt, ratioPrice, tokenAmount, tokenLogo, WNEAR, type Job, type Ratio, type TradeView } from "@/lib/near-format";

/* Trade V1 section 14: the Schedule buy progress card and the Auto DCA page (metric row, current round card, and the Orders, Ongoing, Order history and Holdings tabs).
   Every number is the server's exact string; this file only formats it (section 12 display rounding). */

const INTERVALS: Readonly<Record<number, string>> = { 3600: "1 hour", 14400: "4 hours", 28800: "8 hours", 43200: "12 hours", 86400: "Daily" };
export const REFUND_TEXT = "Price moved beyond 0.5 %. The wNEAR stays in the agent wallet and is used by the next buy.";
const DONE: Readonly<Record<NonNullable<TradeView["done"]>["kind"], string>> = {
  budget: "Schedule finished: budget spent.", runs: "Schedule finished: all buys done.", date: "Schedule finished: end date reached.",
  life: "The planned end was reached.", tp: "Take profit sold the position to NEAR.",
  "tp-cap": "Take profit was reached, but one sale could not carry the position within its limits. The job ended without selling and returns the token.",
  "tp-short": "Take profit was reached, but the wallet held less of the token than the agent bought. The job ended without selling and returns the token.",
  sl: "Stop loss confirmed. Nothing was sold; the job returns NEAR and the token.",
};
const FAILED = ["denied", "unclear", "unknown", "reverted"];
export const DCA_TABS = ["Orders", "Ongoing", "Rounds", "Order history", "Holdings"] as const;
export type DcaTab = typeof DCA_TABS[number];
const CARD: React.CSSProperties = { marginBottom: 16 };
const HEAD: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", padding: "12px 16px", borderBottom: "1px solid var(--line-1)" };
const TITLE: React.CSSProperties = { font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)" };
const MONO: React.CSSProperties = { font: "var(--weight-regular) var(--text-xs)/1.3 var(--font-mono)", color: "var(--text-subtle)", letterSpacing: "0.04em", textTransform: "uppercase" };
const KICKER: React.CSSProperties = { font: "var(--weight-medium) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)", letterSpacing: "0.08em", textTransform: "uppercase" };
const CELL: React.CSSProperties = { font: "var(--weight-medium) var(--text-sm)/1.2 var(--font-mono)", color: "var(--ink-1)" };
const SUB: React.CSSProperties = { font: "var(--weight-regular) var(--text-xs)/1.3 var(--font-mono)", color: "var(--text-subtle)" };
const NOTICE: React.CSSProperties = { margin: "0 0 16px" };
const ORDER_COLS = "minmax(140px,1.2fr) minmax(90px,.8fr) minmax(130px,1.1fr) minmax(100px,.9fr) minmax(130px,1fr) minmax(90px,.7fr)";
const CYCLE_COLS = "68px minmax(0,1.15fr) minmax(0,1.15fr) minmax(0,1.05fr) minmax(0,1fr) 92px";
const FILL_COLS = "minmax(0,1.3fr) 70px minmax(0,1fr) 64px minmax(0,1fr) minmax(0,1.2fr) minmax(0,1fr) 72px";
function duration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000)), days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60);
  return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}
const STATE_TONE: Readonly<Record<string, string>> = { filled: "var(--profit)", skipped: "var(--warning)", waiting: "var(--text-subtle)" };
const NEAR_COLOR = "var(--profit)", TOKEN_COLOR = "#f0b90b";

/** A token badge with no hooks (this file renders without them): the bundled logo, or the symbol's first letter. */
function Logo({ symbol, size }: { readonly symbol: string; readonly size: number }) {
  const src = tokenLogo(symbol);
  const style: React.CSSProperties = { width: size, height: size, borderRadius: 999, flex: "0 0 auto", border: "1px solid rgba(255,255,255,0.16)", background: "var(--surface-sunken)", display: "grid", placeItems: "center", overflow: "hidden" };
  // eslint-disable-next-line @next/next/no-img-element
  return src ? <img src={src} alt={symbol} style={style} /> : <span style={{ ...style, color: "var(--text-subtle)", font: `600 ${Math.floor(size / 2.2)}px/1 var(--font-sans)` }}>{symbol.slice(0, 1)}</span>;
}

/** The pair badge: the bought token with the NEAR logo overlapping it, as the pool rows draw a pair. */
function PairLogo({ symbol, size }: { readonly symbol: string; readonly size: number }) {
  return <span style={{ display: "flex", alignItems: "center", flex: "0 0 auto" }}>
    <Logo symbol={symbol} size={size} />
    <span style={{ marginLeft: -Math.round(size / 2.9), display: "flex" }}><Logo symbol="wNEAR" size={size} /></span>
  </span>;
}

function signed(yocto: string | null): string {
  if (yocto === null) return "-";
  const n = BigInt(yocto);
  return `${n < 0n ? "-" : "+"}${fmt((n < 0n ? -n : n).toString())}`;
}
/** A price as its NEAR figure. The small line under it was removed (operator, 2026-11-13). */
function price(r: Ratio | null, t: TradeView): { value: string; note?: string } {
  if (r === null) return { value: "-" };
  return { value: `${ratioPrice(r, t.pair.decimals)} NEAR` };
}
/** "in 5m 30s", "in 2h 05m 30s", "in 1d 03h 12m": seconds show under a day so the tick is visible. */
function due(at: number | null, now: number): string {
  if (at === null) return "-";
  if (at <= now) return "due now";
  const total = Math.floor((at - now) / 1000), hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60), pad = (n: number) => String(n).padStart(2, "0");
  return `in ${hours >= 24 ? `${Math.floor(hours / 24)}d ${pad(hours % 24)}h ${pad(minutes)}m` : hours > 0 ? `${hours}h ${pad(minutes)}m ${pad(total % 60)}s` : `${minutes}m ${pad(total % 60)}s`}`;
}
/** The price at which the held token is worth `line` yocto NEAR: the take profit and stop loss lines as prices. */
function linePrice(line: string | null, held: string): Ratio | null {
  return line === null || BigInt(held) <= 0n ? null : { num: line, den: held };
}
const numeric = (r: Ratio, decimals: number): number => Number(ratioPrice(r, decimals));

/** The chart lines of an Auto DCA round: entry, take profit and every level still to come. */
function dcaPriceLines(t: TradeView): { price: number; color: string; title: string }[] {
  if (!t.dca) return [];
  const dec = t.pair.decimals, held = (BigInt(t.ledger.bought) - BigInt(t.ledger.sold)).toString(), lines: { price: number; color: string; title: string }[] = [];
  const push = (r: Ratio | null, title: string) => { if (r === null) return; const p = numeric(r, dec); if (Number.isFinite(p) && p > 0) lines.push({ price: p, color: "#2fd48c", title }); };
  push(t.avgCost, "ENTRY"); push(linePrice(t.dca.tpLine, held), "TP");
  for (const v of t.dca.levels) if (v.state === "armed" || v.state === "waiting") push(v.price, `DCA #${v.k}`);
  return lines;
}

/** The pool price of the job pair, from the data plane (classic pool, priced in wNEAR). Kept apart from NearTradeDetail, which has no hooks. */
export function NearTradeChart({ job }: { readonly job: Job }) {
  const [interval, setInterval] = React.useState<ChartInterval>("1m");
  const t = job.trade;
  if (!t) return null;
  const sym = t.pair.symbol;
  return <section className="fl-trade-table" style={CARD}>
    <div style={HEAD}>
      <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <PairLogo symbol={sym} size={22} />
        <span style={TITLE}>{sym} price in wNEAR</span>
        <span style={MONO}>Pool {t.pair.poolId}</span>
      </span>
      <SegmentedToggle options={CHART_INTERVALS.map((value) => ({ value, label: value }))} value={interval} onChange={(next: string) => setInterval(next as ChartInterval)} />
    </div>
    <div style={{ padding: "14px 16px 12px" }}>
      <MarketChart kind="pool" address={TRADE_POOL_KEY[t.pair.id]} title={`${sym} / wNEAR`} embedded height={230} defaultInterval={interval} currency="token" priceLines={dcaPriceLines(t)} />
    </div>
  </section>;
}

/** The trade page body: the tab and the chart toggle live here, so NearTradeDetail stays free of hooks. */
export function NearTradeBody({ job, simulated = false }: { readonly job: Job; readonly simulated?: boolean }) {
  const [tab, setTab] = React.useState<DcaTab>("Orders");
  const [showChart, setShowChart] = React.useState(false);
  const [unit, setUnit] = React.useState("USD");
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  return <NearTradeDetail job={job} simulated={simulated} tab={tab} onTab={setTab} unit={unit} onUnit={setUnit} now={now} showChart={showChart} onChart={() => setShowChart(v => !v)} chart={showChart ? <NearTradeChart job={job} /> : null} />;
}

function Metric({ label, value, note, tone = "normal", model = false }: { readonly label: string; readonly value: string; readonly note?: string; readonly tone?: "normal" | "profit" | "loss"; readonly model?: boolean }) {
  return <div className="fl-trade-metric">
    <span className="fl-trade-kicker">{label}</span>
    <strong className={`fl-trade-metric__value fl-trade-metric__value--${tone}${model ? " fl-trade-metric__value--execution-model" : ""}`} style={{ fontSize: model ? 20 : 22, textTransform: "none", overflowWrap: "anywhere" }}>{value}</strong>
    {note ? <span className="fl-trade-metric__note" style={tone === "normal" ? undefined : { color: tone === "profit" ? "var(--profit)" : "var(--loss)" }}>{note}</span> : null}
  </div>;
}

function Stat({ label, value, note, end = false }: { readonly label: string; readonly value: string; readonly note?: string; readonly end?: boolean }) {
  return <div style={{ display: "grid", gap: 8, alignContent: "start", justifyItems: end ? "end" : "start", textAlign: end ? "right" : "left", minWidth: 0 }}>
    <span style={{ font: "var(--weight-regular) var(--text-xs)/1 var(--font-sans)", color: "var(--text-subtle)" }}>{label}</span>
    <span style={CELL}>{value}</span>
    {note ? <small style={{ font: "var(--weight-regular) var(--text-xs)/1.3 var(--font-sans)", color: "var(--text-subtle)" }}>{note}</small> : null}
  </div>;
}

function Segments({ filled, total, color, height = 10 }: { readonly filled: number; readonly total: number; readonly color: string; readonly height?: number }) {
  if (total <= 0 || total > 40) {
    const pct = total <= 0 ? 0 : Math.max(0, Math.min(100, (filled / total) * 100));
    return <div style={{ height, borderRadius: 2, background: "var(--raised-3)", overflow: "hidden" }}><div style={{ width: `${pct}%`, height: "100%", background: color }} /></div>;
  }
  return <div style={{ display: "flex", gap: 3, height }}>
    {Array.from({ length: total }, (_, i) => <i key={i} style={{ flex: 1, borderRadius: 2, background: i < filled ? color : "var(--raised-3)" }} />)}
  </div>;
}

function LadderDot({ kind }: { readonly kind: "tp" | "done" | "pending" }) {
  return <span style={{ width: 18, height: 18, borderRadius: 999, flex: "0 0 auto", display: "grid", placeItems: "center", background: "var(--surface-card)", position: "relative",
    border: "1.5px solid " + (kind === "tp" ? "var(--profit)" : kind === "done" ? "var(--text-subtle)" : "var(--line-1)"),
    color: kind === "tp" ? "var(--profit)" : "var(--text-subtle)", font: "var(--weight-medium) 10px/1 var(--font-sans)" }}>
    {kind === "done" ? "✓" : kind === "tp" ? "▲" : ""}
  </span>;
}

function LadderCallout({ label, value, accent }: { readonly label: string; readonly value: string; readonly accent: boolean }) {
  return <div style={{ display: "grid", gridTemplateColumns: "18px minmax(0,1fr)", gap: 12, alignItems: "center", paddingBottom: 18 }}>
    <span style={{ borderTop: `1px dotted ${accent ? "var(--cat-yield)" : "var(--text-subtle)"}`, marginLeft: 9 }} />
    <span style={{ justifySelf: "start", display: "grid", gap: 4, padding: "8px 12px", borderRadius: "var(--radius-sm)",
      background: accent ? "color-mix(in oklab, var(--cat-yield) 14%, var(--surface-card))" : "var(--raised-3)", border: `1px solid ${accent ? "var(--cat-yield)" : "var(--line-1)"}` }}>
      <span style={{ font: "var(--weight-medium) var(--text-xs)/1 var(--font-sans)", color: "var(--ink-1)" }}>{label}</span>
      <span style={CELL}>{value}</span>
    </span>
  </div>;
}

function Donut({ share, label, value }: { readonly share: number; readonly label: string; readonly value: string }) {
  const r = 38, c = 2 * Math.PI * r, len = Math.max(0, Math.min(1, share)) * c;
  return <svg width="96" height="96" viewBox="0 0 96 96" role="img" aria-label={`${label} ${value}`}>
    <circle cx="48" cy="48" r={r} fill="none" stroke={NEAR_COLOR} strokeWidth="8" />
    {len > 0 ? <circle cx="48" cy="48" r={r} fill="none" stroke={TOKEN_COLOR} strokeWidth="8" strokeDasharray={`${len} ${c - len}`} transform="rotate(-90 48 48)" /> : null}
    <text x="48" y="44" textAnchor="middle" style={{ font: "var(--weight-regular) 10px/1 var(--font-sans)", fill: "var(--text-subtle)" }}>{label}</text>
    <text x="48" y="60" textAnchor="middle" style={{ font: "var(--weight-medium) 12px/1 var(--font-mono)", fill: "var(--ink-1)" }}>{value}</text>
  </svg>;
}

const txLink = (hash: string | null | undefined) => hash
  ? <a href={`https://nearblocks.io/txns/${hash}`} target="_blank" rel="noreferrer" title={hash} style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--text-muted)", font: "var(--type-body-xs)", textDecoration: "none" }}>Tx <Icon name="external" size={11} /></a>
  : <span style={{ color: "var(--text-subtle)" }}>-</span>;

/** `simulated` (demo mode 8.1): the header says Simulated. `tab`, `onTab`, `onChart` and `chart` come from NearTradeBody; without them the page is static on its first tab. */
export function NearTradeDetail({ job, simulated = false, tab = "Orders", onTab, showChart = false, onChart, chart = null, unit = "USD", onUnit, now = Date.now() }: {
  readonly job: Job; readonly simulated?: boolean; readonly tab?: DcaTab; readonly onTab?: (tab: DcaTab) => void;
  readonly showChart?: boolean; readonly onChart?: () => void; readonly chart?: React.ReactNode;
  readonly unit?: string; readonly onUnit?: (unit: string) => void; readonly now?: number;
}) {
  // Gross PnL (operator, 2026-11-13): proceeds plus value against the NEAR spent, before the buy and sell gas.
  const t = job.trade && { ...job.trade, pnl: job.trade.value === null ? null : (BigInt(job.trade.ledger.proceeds) + BigInt(job.trade.value) - BigInt(job.trade.ledger.spent)).toString() };
  if (!t) return null;
  const s = t.settings, l = t.ledger, sym = t.pair.symbol, dec = t.pair.decimals, held = (BigInt(l.bought) - BigInt(l.sold)).toString();
  const name = t.strategy === "schedule" ? "Schedule buy" : "Auto DCA";
  const avg = price(t.avgCost, t), spot = price(t.spot, t);
  const valueNow = t.value === null ? "-" : fmt(t.value);
  const pnlTone = t.pnl === null || BigInt(t.pnl) === 0n ? "normal" : BigInt(t.pnl) > 0n ? "profit" : "loss";
  const planned = t.endsAt === null ? t.strategy === "dca" ? "Planned end: 30 days after hire." : "Planned end: 6 days after hire (the exact time is set when the policy is prepared)." : `Planned end: ${new Date(t.endsAt).toLocaleString("en-US")}.`;
  const chartButton = onChart ? <Button variant={showChart ? "secondary" : "ghost"} size="sm" icon={<Icon name="yield" size={14} />} onClick={onChart} style={{ marginLeft: "auto" }}>{showChart ? "Hide chart" : "Show chart"}</Button> : null;

  // The five tiles, as on the Grid and LP pages. The USDC pair's own pool price is the USD price of NEAR; the other pairs have none, so they stay in NEAR.
  const usdPrice = sym === "USDC" && t.spot ? Number(ratioPrice(t.spot, dec, true)) : null;
  const inUsd = unit === "USD" && usdPrice !== null && Number.isFinite(usdPrice) && usdPrice > 0;
  const money = (yocto: string | null, plus = false): string => {
    if (yocto === null) return "-";
    const n = BigInt(yocto), abs = (n < 0n ? -n : n).toString();
    return `${n < 0n ? "-" : plus && n > 0n ? "+" : ""}${(inUsd ? usdText(usdMicros("native", abs, usdPrice)) : null) ?? fmt(abs)}`;
  };
  const deposit = BigInt(job.depositYocto);
  const tileTone = pnlTone === "normal" ? "flat" : pnlTone;
  const pnlPercent = t.pnl === null || deposit <= 0n ? "-" : `${BigInt(t.pnl) > 0n ? "+" : ""}${(Number(BigInt(t.pnl) * 1_000_000n / deposit) / 10_000).toFixed(2)}%`;
  const TILES: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(175px,1fr))", gap: 12, marginBottom: 24 };
  const delegatedTile = <span style={{ position: "relative", display: "grid" }}>
    <MetricTile label="Delegated" value={money(job.depositYocto)} style={{ height: "100%" }} />
    {usdPrice !== null && onUnit ? <span style={{ position: "absolute", top: 14, right: 14 }}>
      <SegmentedToggle className="fl-seg fl-seg--mini" options={[{ value: "USD", label: "USD" }, { value: "NEAR", label: "NEAR" }]} value={unit} onChange={onUnit} />
    </span> : null}
  </span>;
  const holdingsTile = <MetricTile label="Holdings" value={asset(t.pair.token, held)} note={t.value === null ? undefined : `≈ ${money(t.value)}`} />;

  // An Auto DCA round's fills in time order: the first successful buy is the base order, each later one a filled level in level order.
  const fills = t.buys.filter(b => b.kind === "swap" && b.side === "buy" && b.out !== null).sort((a, b) => a.at - b.at);
  // Auto DCA rounds (rounds spec 4): the current round's fills; every buy when an older server sends no round.
  const round = t.dca?.round ?? 1, inRound = (b: TradeView["buys"][number]) => b.round === undefined || b.round === round;
  const roundFills = fills.filter(inRound);
  const filledKs = (t.dca?.levels ?? []).filter(v => v.state === "filled").map(v => v.k);
  const orderLabel = (b: TradeView["buys"][number]): string => {
    if (b.kind === "wrap") return "Wrap";
    if (b.side === "sell") return "Take profit";
    const i = fills.filter(f => f.round === b.round).indexOf(b);
    return i === 0 ? "Base" : i > 0 ? (!inRound(b) || filledKs[i - 1] === undefined ? "DCA" : `DCA #${filledKs[i - 1]}`) : "Buy";
  };
  // A successful wrap is only the step before its swap, so it is not a row of its own; a failed one is.
  const shown = t.buys.filter(b => b.kind !== "wrap" || b.verdict !== "success");
  const plannedBuys = s === "invalid" || s.strategy !== "schedule" ? null : s.end.kind === "runs" ? s.end.runs : Number(BigInt(s.budget) / BigInt(s.amount));
  const history = t.strategy === "dca" ? <section className="fl-trade-table" style={CARD} data-testid="trade-buys-table">
    <div className="fl-row__head" style={{ gridTemplateColumns: FILL_COLS }}><span>Time</span><span>Round</span><span>Order</span><span>Side</span><span>Price</span><span>Amount</span><span>Value</span><span style={{ justifySelf: "end" }}>Tx</span></div>
    {shown.length === 0 ? <div className="fl-trade-empty">No orders yet.</div> : shown.map(b => {
      const refunded = b.verdict === "refunded", failed = b.verdict !== null && FAILED.includes(b.verdict);
      const bought = b.side === "buy" && b.out !== null, sold = b.side === "sell" && b.nativeIn !== null;
      const near = bought ? b.used ?? b.amount : sold ? b.nativeIn! : b.side === "buy" ? b.amount : null, token = bought ? b.out! : b.side === "sell" && b.kind === "swap" ? b.amount : null;
      const fillPrice: Ratio | null = (bought || sold) && near !== null && token !== null && BigInt(token) > 0n ? { num: near, den: token } : null;
      const tone = refunded ? "var(--warning)" : failed ? "var(--loss)" : "var(--text-subtle)";
      return <div key={b.opId} data-verdict={b.verdict ?? "pending"} style={refunded ? { border: "1px solid var(--warning)" } : failed ? { border: "1px solid var(--loss)" } : { borderTop: "1px solid var(--line-1)" }}>
        <div className="fl-row" style={{ gridTemplateColumns: FILL_COLS, alignItems: "center", cursor: "default", font: "var(--weight-medium) var(--text-sm)/1.2 var(--font-sans)", color: "var(--ink-1)" }}>
          <span>{new Date(b.at).toLocaleString("en-US")}</span>
          <span>{b.round === undefined ? 1 : b.round ?? "-"}</span>
          <span>{orderLabel(b)}</span>
          <span style={{ color: b.side === "buy" ? "var(--profit)" : "var(--loss)" }}>{b.kind === "wrap" ? "-" : b.side}</span>
          <span>{fillPrice ? `${ratioPrice(fillPrice, dec)} NEAR` : <span style={{ padding: "3px 9px", borderRadius: 999, border: `1px solid ${tone}`, color: tone, font: "var(--weight-medium) var(--text-xs)/1.4 var(--font-mono)" }}>{b.verdict ?? "pending"}</span>}</span>
          <span>{token === null ? "-" : asset(t.pair.token, token)}</span>
          <span>{near === null ? "-" : fmt(near)}</span>
          <span style={{ justifySelf: "end" }}>{txLink(b.txHash)}</span>
        </div>
        {refunded || b.message ? <div style={{ padding: "0 16px 12px", font: "var(--type-body-sm)", color: refunded ? "var(--warning)" : failed ? "var(--loss)" : "var(--text-muted)" }}>
          {refunded ? (b.side === "sell" ? "The price fell below the take profit line. The token stays in the agent wallet." : REFUND_TEXT) : b.message}
        </div> : null}
      </div>;
    })}
  </section> : <section className="fl-trade-table" style={CARD} data-testid="trade-buys-table">
    <div className="fl-row__head" style={{ gridTemplateColumns: CYCLE_COLS, alignItems: "center" }}><span>Cycle</span><span>Token</span><span>Time</span><span>Size</span><span>Fill price</span><span style={{ justifySelf: "end" }}>Tx</span></div>
    {shown.length === 0 ? <div className="fl-trade-empty">No buy yet.</div> : shown.map(b => {
      const refunded = b.verdict === "refunded", failed = b.verdict !== null && FAILED.includes(b.verdict);
      const cycle = fills.indexOf(b) + 1, bought = b.out !== null, sold = b.side === "sell" && b.nativeIn !== null;
      const near = bought ? b.used ?? b.amount : sold ? b.nativeIn! : b.side === "buy" ? b.amount : null, token = bought ? b.out! : b.side === "sell" && b.kind === "swap" ? b.amount : null;
      const fillPrice: Ratio | null = (bought || sold) && near !== null && token !== null && BigInt(token) > 0n ? { num: near, den: token } : null;
      const tone = refunded ? "var(--warning)" : failed ? "var(--loss)" : "var(--text-subtle)", when = new Date(b.at);
      return <div key={b.opId} data-verdict={b.verdict ?? "pending"} style={refunded ? { border: "1px solid var(--warning)" } : failed ? { border: "1px solid var(--loss)" } : { borderTop: "1px solid var(--line-1)" }}>
        <div className="fl-row" style={{ gridTemplateColumns: CYCLE_COLS, alignItems: "center", cursor: "default" }}>
          <span style={CELL}>{cycle > 0 ? cycle : "-"}{cycle > 0 && plannedBuys !== null ? <span style={{ color: "var(--text-subtle)" }}>{` / ${plannedBuys}`}</span> : null}</span>
          <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            {b.kind === "wrap" ? <Logo symbol="wNEAR" size={26} /> : <PairLogo symbol={sym} size={26} />}
            <span style={{ display: "grid", gap: 4 }}>
              <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)" }}>{b.kind === "wrap" ? "Wrap NEAR" : `${sym} / wNEAR`}</span>
              <span style={{ ...SUB, textTransform: "uppercase" }}>{b.kind === "wrap" ? "wrap.near" : `${b.side} · pool ${t.pair.poolId}`}</span>
            </span>
          </span>
          <span style={{ display: "grid", gap: 4 }}>
            <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)" }}>{`${when.toLocaleDateString("en-US", { day: "2-digit", month: "short" })} · ${when.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}`}</span>
            <span style={{ ...SUB, textTransform: "uppercase" }}>{`${duration(now - b.at)} ago`}</span>
          </span>
          <span style={{ display: "grid", gap: 4, minWidth: 0 }}>
            <span style={{ ...CELL, overflowWrap: "anywhere" }}>{token === null ? "-" : asset(t.pair.token, token)}</span>
            <span style={SUB}>{near === null ? "-" : fmt(near)}</span>
          </span>
          <span style={{ display: "grid", gap: 4, justifyItems: "start" }}>
            {fillPrice ? <><span style={CELL}>{`${ratioPrice(fillPrice, dec)} NEAR`}</span>{sym === "USDC" ? <span style={SUB}>{`${ratioPrice(fillPrice, dec, true)} USDC per NEAR`}</span> : null}</>
              : <span style={{ padding: "3px 9px", borderRadius: 999, border: `1px solid ${tone}`, color: tone, font: "var(--weight-medium) var(--text-xs)/1.4 var(--font-mono)" }}>{b.verdict ?? "pending"}</span>}
          </span>
          <span style={{ justifySelf: "end" }}>{txLink(b.txHash)}</span>
        </div>
        {refunded || b.message ? <div style={{ padding: "0 16px 12px", font: "var(--type-body-sm)", color: refunded ? "var(--warning)" : failed ? "var(--loss)" : "var(--text-muted)" }}>
          {refunded ? (b.side === "sell" ? "The price fell below the take profit line. The token stays in the agent wallet." : REFUND_TEXT) : b.message}
        </div> : null}
      </div>;
    })}
  </section>;

  let body: React.ReactNode = history;
  if (s !== "invalid" && s.strategy === "schedule" && t.schedule) {
    const sc = t.schedule, total = s.end.kind === "runs" ? s.end.runs : Number(BigInt(s.budget) / BigInt(s.amount));
    const endRule = s.end.kind === "budget" ? "Until budget is spent" : s.end.kind === "runs" ? `${s.end.runs} buys` : `Until ${new Date(s.end.atMs).toLocaleString("en-US")}`;
    body = <>
      <section className="fl-trade-table fl-mobile-1col" style={{ ...CARD, display: "grid", gridTemplateColumns: "minmax(0,1.9fr) minmax(240px,0.9fr)" }} data-testid="schedule-progress-card">
        <div style={{ padding: "20px 24px 22px", display: "grid", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            <span style={{ font: "var(--weight-semibold) var(--text-3xl)/1 var(--font-mono)", color: "var(--ink-1)" }}>{exactNear(BigInt(l.spent)).replace(" NEAR", "")}</span>
            <span style={{ font: "var(--weight-regular) var(--text-lg)/1 var(--font-mono)", color: "var(--text-subtle)" }}>{`/ ${exactNear(BigInt(s.budget))} spent`}</span>
            <span style={{ ...MONO, marginLeft: "auto" }}>{`${exactNear(BigInt(s.amount))} per buy · ${INTERVALS[s.intervalSec] ?? `${s.intervalSec} s`} · ${endRule}`}</span>
          </div>
          <div style={{ display: "grid", gap: 10 }}>
            <Segments filled={sc.fills} total={total} color="var(--brand)" />
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, ...MONO }}>
              <span>{`${sc.fills} of ${total} buys done`}</span>
              <span>{`${sc.postponed} postponed`}</span>
            </div>
          </div>
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap", paddingTop: 14, borderTop: "1px solid var(--line-1)" }}>
            <span style={MONO}>{`Schedule buy · ${sym}`}</span>
            <span style={{ ...MONO, marginLeft: "auto" }}>{`Remaining ${fmt(sc.remaining)}`}</span>
          </div>
        </div>
        <div style={{ borderLeft: "1px solid var(--line-1)", background: "var(--surface-sunken)", display: "grid", alignContent: "start" }}>
          <div style={{ padding: "20px 24px 16px", display: "grid", gap: 8 }}>
            <span style={KICKER}>Next buy</span>
            <strong style={{ font: "var(--weight-semibold) var(--text-2xl)/1 var(--font-mono)", color: "var(--ink-1)" }}>{t.done ? "Finished" : due(sc.nextDueAt, now)}</strong>
          </div>
          <div style={{ padding: "14px 24px 18px", borderTop: "1px solid var(--line-1)", display: "grid", gap: 7 }}>
            <span style={KICKER}>Execution model</span>
            <strong style={{ font: "var(--weight-medium) var(--text-lg)/1.2 var(--font-mono)", color: "var(--ink-1)" }}>Trade · Schedule Buy</strong>
          </div>
        </div>
      </section>
      <div style={TILES}>
        {delegatedTile}
        {holdingsTile}
        <MetricTile label="PnL since hire" value={money(t.pnl, true)} tone={tileTone} delta={t.pnl === null ? undefined : pnlPercent} deltaTone={tileTone} />
        <MetricTile label="Average price" value={avg.value} note={avg.note} />
        <MetricTile label="Market price" value={spot.value} note={spot.note} />
      </div>
      {chartButton ? <div style={{ display: "flex", marginBottom: 12 }}><span>{chartButton}</span></div> : null}
      {chart}
      {history}
    </>;
  }
  if (s !== "invalid" && s.strategy === "dca" && t.dca) {
    const d = t.dca, filled = d.levels.filter(v => v.state === "filled").length;
    const tpPrice = linePrice(d.tpLine, held), slPrice = s.slBps === 0 ? null : linePrice(d.slLine, held);
    const px = (r: Ratio | null) => r === null ? "-" : `${ratioPrice(r, dec)} NEAR`;
    const inverse = (r: Ratio | null) => r !== null && sym === "USDC" ? `${ratioPrice(r, dec, true)} USDC per NEAR` : undefined;
    const sale = t.buys.find(b => b.kind === "swap" && b.side === "sell" && b.nativeIn !== null && inRound(b));
    const cooling = !t.done && d.cooldownUntil != null && d.cooldownUntil > now && BigInt(held) === 0n;
    const past = d.rounds ?? [], gross = (r: { proceeds: string; spent: string }) => BigInt(r.proceeds) - BigInt(r.spent);
    // Exact beyond the 20 kept rounds: every completed round sold all it bought, so their gross is the job's proceeds against the spend before this round.
    const completed = d.roundSpent === undefined ? 0 : round - 1;
    const realised = completed > 0 ? signed((BigInt(l.proceeds) - BigInt(l.spent) + BigInt(d.roundSpent!)).toString()) : t.done?.kind === "tp" ? signed(t.pnl) : "-";
    // The open round's gross result at the pool price; a job that ended at take profit before rounds keeps the job figure.
    const roundPnl = d.roundSpent === undefined || t.done?.kind === "tp" ? t.pnl : t.value === null ? null : (BigInt(t.value) - BigInt(d.roundSpent)).toString();
    const toneOf = (v: string | null) => v === null || BigInt(v) === 0n ? "normal" : BigInt(v) > 0n ? "profit" : "loss";
    let nextFill = 1;
    const orders: { key: string; label: string; state: string; price: Ratio | null; near: string; token: string; tx: string | null | undefined }[] = [
      { key: "tp", label: "Take profit", state: t.done?.kind === "tp" ? "filled" : BigInt(held) > 0n && !t.done ? "armed" : "waiting", price: tpPrice,
        near: sale?.nativeIn ? fmt(sale.nativeIn) : d.tpLine === null ? "-" : fmt(d.tpLine), token: sale ? asset(t.pair.token, sale.amount) : BigInt(held) > 0n ? asset(t.pair.token, held) : "-", tx: sale?.txHash },
      { key: "base", label: "Base order", state: d.p0 === null ? "waiting" : "filled", price: d.p0, near: exactNear(BigInt(s.base)), token: d.p0 !== null && roundFills[0]?.out ? asset(t.pair.token, roundFills[0].out) : "-", tx: d.p0 === null ? null : roundFills[0]?.txHash },
      ...d.levels.map(v => {
        const fill = v.state === "filled" ? roundFills[nextFill++] : undefined;
        return { key: `l${v.k}`, label: `DCA #${v.k}`, state: v.state, price: v.price, near: exactNear(BigInt(s.order)),
          token: fill?.out ? asset(t.pair.token, fill.out) : v.need === null ? "-" : `≥ ${tokenAmount(v.need, dec)} ${sym}`, tx: fill?.txHash };
      }),
    ];
    const mark = t.spot === null ? null : numeric(t.spot, dec);
    const versus = (r: Ratio) => { if (mark === null || !(mark > 0)) return ""; const pct = (numeric(r, dec) - mark) / mark * 100; return ` (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`; };
    const ladder: { kind: "entry" | "tp" | "level"; price: Ratio; k?: number; state?: string; need?: string | null }[] = [
      ...(t.avgCost ? [{ kind: "entry" as const, price: t.avgCost }] : []), ...(tpPrice ? [{ kind: "tp" as const, price: tpPrice }] : []),
      ...d.levels.flatMap(v => v.price ? [{ kind: "level" as const, price: v.price, k: v.k, state: v.state, need: v.need }] : []),
    ].sort((a, b) => numeric(b.price, dec) - numeric(a.price, dec));
    const below = mark === null ? -1 : ladder.findIndex(row => numeric(row.price, dec) < mark), nowIndex = mark === null ? -1 : below === -1 ? ladder.length : below;
    const current = <LadderCallout label="Current price" value={px(t.spot)} accent={false} />;
    const tokens = job.holdings?.tokens;
    const nearSide = job.agentBalance === null ? null : BigInt(job.agentBalance) + BigInt(tokens?.[WNEAR] ?? "0");
    const tokenSide = t.walletValue ?? t.value, tokenRaw = tokens?.[t.pair.token] ?? null;
    const total = nearSide !== null && tokenSide !== null ? nearSide + BigInt(tokenSide) : null;
    const share = total !== null && total > 0n ? Number(BigInt(tokenSide!) * 10_000n / total) / 10_000 : null;
    const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
    const legend = (color: string, label: string, x: number | null) => <div style={{ display: "flex", alignItems: "center", gap: 10, font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)" }}>
      <i style={{ width: 8, height: 8, borderRadius: 999, background: color }} /><Logo symbol={label} size={18} /><span style={{ minWidth: 56 }}>{label}</span><span style={CELL}>{x === null ? "-" : pct(x)}</span>
    </div>;
    const panel = tab === "Ongoing" ? <section className="fl-trade-table" style={CARD}>
      <div style={HEAD}><span style={TITLE}>Ongoing</span><span style={MONO}>{`Round ${round} · Step ${s.stepBps / 100}% · TP ${s.tpBps / 100}%`}</span></div>
      <div style={{ position: "relative", padding: "18px 20px 2px" }}>
        <span aria-hidden="true" style={{ position: "absolute", left: 28, top: 28, bottom: 30, borderLeft: "1px dashed var(--line-1)" }} />
        {ladder.length === 0 ? <div style={{ ...SUB, paddingBottom: 18 }}>{cooling ? `Next round ${due(d.cooldownUntil!, now)}.` : "Setting up: buying the base order."}</div> : null}
        {ladder.map((row, i) => {
          const kind = row.kind === "tp" ? "tp" : row.state === "filled" ? "done" : "pending";
          return <React.Fragment key={`${row.kind}${row.k ?? ""}`}>
            {i === nowIndex ? current : null}
            {row.kind === "entry" ? <LadderCallout label="Entry price" value={px(row.price)} accent /> : <div style={{ display: "grid", gridTemplateColumns: "18px minmax(0,1fr)", gap: 12, paddingBottom: 18 }}>
              <LadderDot kind={kind} />
              <div style={{ display: "grid", gap: 5 }}>
                <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: kind === "tp" ? "var(--profit)" : kind === "pending" ? "var(--text-muted)" : "var(--ink-1)" }}>
                  {row.kind === "tp" ? "Take-profit order" : `DCA order #${row.k}`}{row.kind === "level" && row.state !== "armed" && row.state !== "waiting" ? <span style={{ ...MONO, marginLeft: 8 }}>{row.state}</span> : null}
                </span>
                <span style={{ ...SUB, color: kind === "tp" ? "var(--profit)" : "var(--text-subtle)" }}>
                  {row.kind === "tp" ? `Sell ${asset(t.pair.token, held)} at ${px(row.price)}${versus(row.price)}`
                    : `Buy ${row.need ? `at least ${tokenAmount(row.need, dec)} ${sym}` : sym} with ${exactNear(BigInt(s.order))} at ${px(row.price)}${versus(row.price)}`}
                </span>
              </div>
            </div>}
          </React.Fragment>;
        })}
        {nowIndex === ladder.length && ladder.length > 0 ? current : null}
      </div>
    </section> : tab === "Rounds" ? <section className="fl-trade-table" style={CARD} data-testid="dca-rounds">
      <div style={{ ...HEAD, justifyContent: "flex-end" }}><span style={MONO}>{`${completed + (t.done ? 1 : 0)} completed · realised ${realised}`}</span></div>
      <div style={{ padding: "14px 16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <span style={{ font: "var(--weight-semibold) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)" }}>{`Round ${round}`}</span>
          <span style={{ font: "var(--weight-medium) var(--text-xs)/1 var(--font-mono)", color: "var(--ink-1)", padding: "3px 7px", borderRadius: 999, border: "1px solid var(--line-1)" }}>{!t.done ? "ONGOING" : t.done.kind === "tp" ? "TAKE PROFIT" : t.done.kind === "sl" ? "STOP LOSS" : "ENDED"}</span>
          <span style={{ ...SUB, marginLeft: "auto" }}>{t.done ? new Date(t.done.at).toLocaleString("en-US") : roundFills[0] ? `since ${new Date(roundFills[0].at).toLocaleString("en-US")}` : cooling ? `starts ${due(d.cooldownUntil!, now)}` : "-"}</span>
        </div>
        <div className="fl-mobile-2col" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 16 }}>
          <Metric label="Duration" value={roundFills[0] ? duration((t.done?.at ?? now) - roundFills[0].at) : "-"} />
          <Metric label="Filled DCA orders" value={String(filled)} />
          <Metric label="Max DCA orders" value={String(d.levels.length)} />
          <Metric label="Round PnL" value={signed(roundPnl)} tone={toneOf(roundPnl)} note={t.done ? undefined : "open round, at the pool price"} />
        </div>
        {past.map(r => {
          const start = r.from ?? fills.find(f => f.round === r.n)?.at ?? null;
          return <div key={r.n} style={{ borderTop: "1px solid var(--line-1)", marginTop: 16, paddingTop: 14 }} data-testid="dca-past-round">
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <span style={{ font: "var(--weight-semibold) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)" }}>{`Round ${r.n}`}</span>
              <span style={{ font: "var(--weight-medium) var(--text-xs)/1 var(--font-mono)", color: "var(--ink-1)", padding: "3px 7px", borderRadius: 999, border: "1px solid var(--line-1)" }}>TAKE PROFIT</span>
              <span style={{ ...SUB, marginLeft: "auto" }}>{new Date(r.at).toLocaleString("en-US")}</span>
            </div>
            <div className="fl-mobile-2col" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 16 }}>
              <Metric label="Duration" value={start === null ? "-" : duration(r.at - start)} />
              <Metric label="Filled DCA orders" value={String(r.filled)} />
              <Metric label="Max DCA orders" value={String(d.levels.length)} />
              <Metric label="Round PnL" value={signed(gross(r).toString())} tone={toneOf(gross(r).toString())} />
            </div>
          </div>;
        })}
      </div>
    </section> : tab === "Order history" ? history : tab === "Holdings" ? <section className="fl-trade-table" style={CARD} data-testid="dca-wallet">
      <div style={HEAD}><span style={TITLE}>Holdings</span></div>
      <div className="fl-mobile-2col" style={{ padding: "18px 22px", display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) auto auto", gap: 28, alignItems: "center" }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", minWidth: 0 }}><Logo symbol={sym} size={28} />
          <Stat label={`${sym} holdings`} value={tokenRaw === null ? "-" : asset(t.pair.token, tokenRaw)} note={tokenSide === null ? undefined : `≈ ${fmt(tokenSide)} · in the agent wallet`} /></div>
        <div style={{ display: "flex", gap: 12, alignItems: "center", minWidth: 0 }}><Logo symbol="NEAR" size={28} />
          <Stat label="NEAR holdings" value={nearSide === null ? "-" : fmt(nearSide.toString())} note="NEAR and wNEAR in the agent wallet" /></div>
        {share === null ? <span style={{ font: "var(--type-body-xs)", color: "var(--text-subtle)" }}>No value to chart.</span>
          : <Donut share={share} label={share >= 0.5 ? sym : "NEAR"} value={pct(share >= 0.5 ? share : 1 - share)} />}
        <div style={{ display: "grid", gap: 12 }}>{legend(TOKEN_COLOR, sym, share)}{legend(NEAR_COLOR, "NEAR", share === null ? null : 1 - share)}</div>
      </div>
    </section> : <section className="fl-trade-table" style={CARD} data-testid="dca-orders">
      <div className="fl-trade-position fl-trade-position--head fl-trade-position--closed" style={{ gridTemplateColumns: ORDER_COLS }}>
        <span>Order</span><span>State</span><span>{`Price (NEAR per ${sym})`}</span><span>NEAR</span><span>{sym}</span><span className="fl-trade-heading-end">Actions</span>
      </div>
      {orders.map(o => <div key={o.key} className="fl-trade-position fl-trade-position--closed" style={{ gridTemplateColumns: ORDER_COLS }} data-testid="dca-order">
        <div><strong style={{ color: "var(--ink-1)" }}>{o.label}</strong></div>
        <div style={{ color: STATE_TONE[o.state] ?? "var(--ink-1)", fontWeight: o.state === "filled" ? 500 : undefined }}><span>{o.state}</span></div>
        <div>{o.price === null ? "-" : ratioPrice(o.price, dec)}{inverse(o.price) ? <small style={{ display: "block", marginTop: 4, color: "var(--text-subtle)" }}>{inverse(o.price)}</small> : null}</div>
        <div>{o.near}</div>
        <div>{o.token}</div>
        <div className="fl-trade-position__actions">{txLink(o.tx)}</div>
      </div>)}
    </section>;
    body = <>
      <div style={TILES}>
        {delegatedTile}
        <MetricTile label="Execution model" value={`Auto DCA · ${d.levels.length} orders`} />
        <MetricTile label="PnL since hire" value={money(t.pnl, true)} tone={tileTone} />
        <MetricTile label="PnL by percent" value={pnlPercent} tone={tileTone} />
        {holdingsTile}
      </div>
      <section className="fl-trade-table" style={{ padding: "18px 22px 20px", display: "grid", gap: 18, marginBottom: 18 }} data-testid="dca-round-card">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ font: "var(--weight-semibold) 15px/1 var(--font-sans)", color: "var(--ink-1)" }}>Current round</span>
          <span style={{ font: "var(--weight-medium) var(--text-xs)/1 var(--font-mono)", color: "var(--ink-1)", padding: "4px 8px", borderRadius: 999, border: "1px solid var(--line-1)" }}>{`ROUND ${round}`}</span>
          <button type="button" onClick={() => onTab?.("Ongoing")} style={{ marginLeft: "auto", cursor: "pointer", background: "none", border: "none", padding: 0, font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--cat-yield)" }}>{t.done ? "Ended" : cooling ? `Next round ${due(d.cooldownUntil!, now)}` : "Ongoing"}</button>
        </div>
        <button type="button" onClick={() => onTab?.("Ongoing")} style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 10, background: "none", border: "none", padding: 0, textAlign: "left" }}>
          <PairLogo symbol={sym} size={22} />
          <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)" }}>{`${sym} / wNEAR`}</span>
          <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, color: "var(--ink-1)" }}>
            <span style={CELL}>{t.spot === null ? "-" : ratioPrice(t.spot, dec)}</span><Icon name="chevron-right" size={13} />
          </span>
        </button>
        <div className="fl-mobile-2col" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 16 }}>
          <Stat label="Average entry price" value={avg.value} note={inverse(t.avgCost)} />
          <Stat label="Take profit price" value={px(tpPrice)} note={d.tpLine === null ? `${s.tpBps / 100} % over cost and gas` : `position worth ${fmt(d.tpLine)} · ${s.tpBps / 100} % over cost and gas`} />
          <Stat label="Stop loss price" value={s.slBps === 0 ? "Off" : px(slPrice)} note={s.slBps === 0 || d.slLine === null ? undefined : `position worth ${fmt(d.slLine)} · ${s.slBps / 100} % under cost`} />
          <Stat label="Volume" end value={`${asset(t.pair.token, held)}${t.value === null ? "" : ` (≈ ${valueNow})`}`} />
        </div>
        <div style={{ display: "grid", gap: 8, paddingTop: 14, borderTop: "1px solid var(--line-1)" }}>
          <Segments filled={(d.p0 === null ? 0 : 1) + filled} total={1 + d.levels.length} color="var(--cat-yield)" height={8} />
          <span style={{ font: "var(--weight-medium) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)", textTransform: "uppercase" }}>{`Base + ${filled} of ${d.levels.length} DCA orders filled`}</span>
        </div>
      </section>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div className="fl-trade-tabs">{DCA_TABS.map(item => <button key={item} type="button" className={tab === item ? "is-active" : ""} onClick={() => onTab?.(item)}>{item}</button>)}</div>
        {chartButton}
      </div>
      {chart}
      {panel}
    </>;
  }

  return <div data-testid="trade-detail">
    <div style={{ display: "flex", gap: 16, flexWrap: "wrap", justifyContent: "space-between", margin: "0 2px 12px", ...MONO }}>
      <span>{`${name} · ${sym} / wNEAR · ${simulated ? "Simulated" : "Mainnet"}`}</span>
      <span>{planned}</span>
    </div>
    {s === "invalid" ? <div className="fl-trade-message fl-trade-message--warning" role="status" style={NOTICE}><span>Trade settings are unreadable. Stop and withdraw.</span></div> : null}
    {t.done ? <div className="fl-trade-message" role="status" style={{ ...NOTICE, color: "var(--ink-1)" }}><span>{DONE[t.done.kind]}</span></div> : null}
    {t.dca?.protect ? <div className="fl-trade-message fl-trade-message--warning" role="status" style={NOTICE}><span>{`Stop loss breach seen at ${new Date(t.dca.protect.since).toLocaleTimeString("en-US")}. It confirms after 5 minutes at a later block.`}</span></div> : null}
    {body}
  </div>;
}
