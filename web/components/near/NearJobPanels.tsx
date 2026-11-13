"use client";
import React from "react";
import { TokenIcon } from "@/components/TokenIcon";
import { fmt, priceUsdcPerNear, tokenAmount, tokenLogo, USDC, WNEAR, type Job } from "@/lib/near-format";

/* The agent page's "Where your funds are" cards and its Details tab (operator, 2026-11-11: the details move out of
   the header into a readable tab; the funds table becomes cards). Display only: every value comes from the job view. */

const short = (s: string | null) => (s === null ? "Unavailable" : s.length <= 16 ? s : `${s.slice(0, 8)}…${s.slice(-6)}`);
const near = (raw: string | null) => (raw === null ? null : fmt(raw).replace(" NEAR", ""));
const usdc = (raw: string | null) => {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const n = BigInt(raw);
  return `${n / 1000000n}.${(n % 1000000n).toString().padStart(6, "0")}`;
};
const amountOf = (token: string, raw: string | null) => (token === USDC ? usdc(raw) : near(raw));
const symbolOf = (token: string) => (token === USDC ? "USDC" : token === WNEAR ? "wNEAR" : token);
const sum = (values: string[]) => values.reduce((n, v) => n + (/^\d+$/.test(v) ? BigInt(v) : 0n), 0n).toString();
const price = (point: number | null) => { const p = priceUsdcPerNear(point); return p === null ? "Unavailable" : `${p.toFixed(4)} USDC per NEAR`; };

const CARD: React.CSSProperties = { display: "grid", gap: 12, alignContent: "start", padding: 16, borderRadius: "var(--radius-md)", border: "1px solid var(--line-1)", background: "var(--surface-sunken)", minWidth: 0 };
const EYEBROW: React.CSSProperties = { font: "var(--weight-medium) var(--text-xs)/1 var(--font-mono)", letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-subtle)" };
const SUB: React.CSSProperties = { font: "var(--weight-regular) var(--text-xs)/1.3 var(--font-mono)", color: "var(--text-subtle)", overflowWrap: "anywhere" };

function TokenRow({ symbol, amount, warn = false }: { readonly symbol: string; readonly amount: string | null; readonly warn?: boolean }) {
  const zero = amount !== null && /^0(\.0+)?$/.test(amount);
  return <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
    <TokenIcon src={tokenLogo(symbol)} symbol={symbol} size={20} />
    <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)" }}>{symbol}</span>
    <span style={{ marginLeft: "auto", font: "var(--weight-medium) var(--text-sm)/1 var(--font-mono)", color: warn ? "var(--warning)" : zero ? "var(--text-subtle)" : "var(--ink-1)" }}>{amount ?? "Unavailable"}</span>
  </div>;
}

function Card({ title, sub, children }: { readonly title: string; readonly sub?: React.ReactNode; readonly children: React.ReactNode }) {
  return <div style={CARD}>
    <div style={{ display: "grid", gap: 6 }}><span style={EYEBROW}>{title}</span>{sub ? <span style={SUB}>{sub}</span> : null}</div>
    {children}
  </div>;
}

export function FundsCards({ job, readOnly = false }: { readonly job: Job; readonly readOnly?: boolean }) {
  const dcl = job.grid ?? job.lp, tokens = job.holdings?.tokens;
  const orders = job.grid?.available ? job.grid.orders : null;
  const internal = dcl?.available ? Object.entries(dcl.internal).filter(([, raw]) => /^\d+$/.test(raw) && BigInt(raw) > 0n) : [];
  const lost = dcl?.available ? Object.entries(dcl.lost).filter(([, raw]) => /^\d+$/.test(raw) && BigInt(raw) > 0n) : [];
  const unclaimed = orders ? [USDC, WNEAR].map(t => [t, sum(orders.filter(o => o.buy === t).map(o => o.unclaimed))] as const).filter(([, v]) => BigInt(v) > 0n) : [];
  const position = job.lp?.position ?? null;
  return <section aria-label="Where your funds are" style={{ display: "grid", gap: 12, marginTop: 20 }}>
    <h2 style={{ font: "var(--weight-semibold) var(--text-md)/1.2 var(--font-sans)", color: "var(--ink-1)" }}>Where your funds are</h2>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
      <Card title="Agent wallet" sub={<span title={job.agentAccount ?? undefined}>{short(job.agentAccount)}</span>}>
        <TokenRow symbol="NEAR" amount={near(job.agentBalance)} />
        <TokenRow symbol="wNEAR" amount={tokens ? near(tokens[WNEAR] ?? "0") : null} />
        {/* Trade V1: a trade wallet holds its own pinned token (USDC, RHEA or ZEC). */}
        {job.trade ? <TokenRow symbol={job.trade.pair.symbol} amount={tokens ? tokenAmount(tokens[job.trade.pair.token] ?? "0", job.trade.pair.decimals) : null} />
          : <TokenRow symbol="USDC" amount={tokens ? usdc(tokens[USDC] ?? "0") : null} />}
      </Card>
      {job.grid ? <Card title="In open orders" sub={orders ? `${orders.length} order${orders.length === 1 ? "" : "s"} on Rhea DCL` : "Order data unavailable"}>
        <TokenRow symbol="wNEAR" amount={orders ? near(sum(orders.filter(o => o.sell === WNEAR).map(o => o.remain))) : null} />
        <TokenRow symbol="USDC" amount={orders ? usdc(sum(orders.filter(o => o.sell === USDC).map(o => o.remain))) : null} />
        {unclaimed.map(([t, v]) => <TokenRow key={t} symbol={`${symbolOf(t)} filled`} amount={amountOf(t, v)} />)}
      </Card> : null}
      {job.lp ? <Card title="LP position" sub={!job.lp.available ? "Position data unavailable" : position ? "Estimate; unclaimed fees may be excluded" : "No open position"}>
        <TokenRow symbol="wNEAR" amount={!job.lp.available ? null : position?.estimate ? near(position.estimate[1] ?? "0") : position ? null : "0"} />
        <TokenRow symbol="USDC" amount={!job.lp.available ? null : position?.estimate ? usdc(position.estimate[0] ?? "0") : position ? null : "0"} />
      </Card> : null}
      {dcl && (internal.length > 0 || lost.length > 0 || !dcl.available) ? <Card title="Inside DCL" sub={dcl.available ? (lost.length ? "Lost-found: recover with the saved management link." : "Held by the exchange for this agent") : "DCL status is unavailable"}>
        {internal.map(([t, raw]) => <TokenRow key={"i" + t} symbol={symbolOf(t)} amount={amountOf(t, raw)} />)}
        {lost.map(([t, raw]) => <TokenRow key={"l" + t} symbol={`${symbolOf(t)} lost-found`} amount={amountOf(t, raw)} warn />)}
      </Card> : null}
      {/* Public agent page (audit M-2): a visitor never sees the owner's wallet card. */}
      {readOnly ? null : <Card title="Your wallet" sub={<span title={job.owner}>{short(job.owner)}</span>}>
        <TokenRow symbol="NEAR" amount={near(job.ownerBalance)} />
        <span style={SUB}>Keep at least 0.1 NEAR here for a freeze.</span>
      </Card>}
    </div>
  </section>;
}

function Section({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return <section style={{ display: "grid", gap: 4 }}>
    <span style={{ ...EYEBROW, padding: "0 0 6px" }}>{title}</span>
    <div style={{ display: "grid" }}>{children}</div>
  </section>;
}
function Item({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return <div style={{ display: "grid", gridTemplateColumns: "minmax(140px, 0.45fr) 1fr", gap: 16, padding: "9px 0", borderTop: "1px solid var(--line-1)", alignItems: "baseline" }}>
    <span style={{ font: "var(--weight-regular) var(--text-sm)/1.3 var(--font-sans)", color: "var(--text-muted)" }}>{label}</span>
    <span style={{ font: "var(--weight-medium) var(--text-sm)/1.4 var(--font-sans)", color: "var(--ink-1)", overflowWrap: "anywhere" }}>{children}</span>
  </div>;
}

const PRESET: Record<number, string> = { 45: "Tight Scalp", 90: "Balanced", 150: "Wide Band", 300: "High Volatility" };
const pct = (v: number) => (v ? `${v}%` : "Off");

export function JobDetails({ job }: { readonly job: Job }) {
  const grid = job.grid, lp = job.lp, s = grid?.settings && grid.settings !== "invalid" ? grid.settings : null;
  const lps = lp?.settings && lp.settings !== "invalid" ? lp.settings : null;
  return <div style={{ display: "grid", gap: 24, padding: 20, border: "1px solid var(--border-card)", borderRadius: "var(--radius-md)", background: "var(--surface-card)" }}>
    <Section title="Wallets">
      <Item label="Owner"><span title={job.owner}>{short(job.owner)}</span></Item>
      <Item label="Agent wallet"><span title={job.agentAccount ?? undefined}>{short(job.agentAccount)}</span></Item>
      {job.grid || job.lp ? <Item label="DCL registration">0.5 NEAR paid from your wallet, locked by DCL</Item> : null}
    </Section>
    {grid ? <Section title="Grid">
      {grid.settings === "invalid" ? <Item label="Settings">Unreadable. Stop and withdraw.</Item> : s ? <>
        <Item label="Preset">{PRESET[s.step] ?? "Custom"} · step {s.step} points ({(s.step / 100).toFixed(2)}%)</Item>
        <Item label="Orders">{s.orders}</Item>
        <Item label="Stop loss / take profit">{pct(s.stopLossPct)} / {pct(s.takeProfitPct)}</Item>
        <Item label="Job value">{grid.value ? `${fmt(grid.value)}` : "Unavailable"}</Item>
      </> : <Item label="Model">Grid V1 · 4 lanes, 100-point step</Item>}
      <Item label="Pool price">{price(grid.point)}</Item>
      <Item label="Anchor">{grid.anchor === null ? "Pending" : price(grid.anchor)}</Item>
      {grid.protect?.fired ? <Item label="Protection">Stopped by {grid.protect.fired.kind} at {fmt(grid.protect.fired.value)} (deposit basis {fmt(grid.protect.fired.basis)})</Item> : null}
      {grid.lanes.map((l, i) => <Item key={i} label={`Lane ${i + 1} · sells ${symbolOf(l.sell)}`}>
        {l.points ? `${priceUsdcPerNear(l.points[0])?.toFixed(4)} then ${priceUsdcPerNear(l.points[1])?.toFixed(4)} USDC per NEAR` : "Points unavailable"} · {l.orderId ? `order #${l.orderId.split("#").pop()}` : "in wallet"}
      </Item>)}
    </Section> : null}
    {lp ? <Section title="LP">
      {lp.settings === "invalid" ? <Item label="Settings">Unreadable. Stop and withdraw.</Item> : lps ? <>
        <Item label="AI suggestions">{lps.ai ? "On" : "Off"}</Item>
        <Item label="Auto-compound">{lps.compound.on ? `On, from ${lps.compound.minFeeBps} basis points of fees` : "Off"}</Item>
        <Item label="Stop loss / take profit">{pct(lps.stopLossPct)} / {pct(lps.takeProfitPct)}</Item>
      </> : null}
      <Item label="Pool price">{price(lp.point)}</Item>
      {lp.range ? <Item label="Range">{lp.range.rightPrice.toFixed(4)} to {lp.range.leftPrice.toFixed(4)} USDC per NEAR · {lp.range.inRange === null ? "status unavailable" : lp.range.inRange ? "in range" : "out of range"}</Item> : null}
      <Item label="Rotations (24 h)">{lp.rotations} of 2</Item>
      {lp.lastDecision ? <Item label="Last range decision">{lp.lastDecision.verdict}{lp.lastDecision.code ? ` (${lp.lastDecision.code})` : ""}</Item> : null}
      {lp.protect?.fired ? <Item label="Protection">Stopped by {lp.protect.fired.kind} at {fmt(lp.protect.fired.value)}</Item> : null}
    </Section> : null}
    <Section title="Chain and safety">
      <Item label="Finalized block">{job.holdings ? job.holdings.block : "Unavailable"}</Item>
      <Item label="Wallet policy">Caps native NEAR per transaction and per day. Token transfers through contract calls are not capped; key custody, the watchdog and your freeze protect them.</Item>
      {job.alerts.length ? job.alerts.map((a, i) => <Item key={i} label={`Alert · ${a.severity}`}>{a.kind.replaceAll("_", " ")}{a.detail.message ? `: ${a.detail.message}` : ""}</Item>) : <Item label="Alerts">None</Item>}
    </Section>
  </div>;
}
