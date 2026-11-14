// @ts-nocheck -- Ported design JSX, kept byte-identical on purpose. The export is
// untyped and its ~20 inline sub-components would each need a hand-written prop
// interface; annotating them would mean editing the very markup this port exists
// to preserve. Type safety stops at this boundary: KitApp, KitHeader, the design
// system declarations and lib/ are all fully checked.
"use client";
/* Ported from the Claude Design export (ui_kits/marketplace/AgentDetailScreen.jsx).
   The JSX body is unchanged; only the IIFE wrapper, the design-system
   namespace proxies and the window globals became real imports/exports. */
import React from "react";
import { ActivityRow, Button, Category, ChartFrame, Icon, MetricTile, Num, PermissionItem, PROTOCOL_LOGOS, SegmentedToggle, TierBadge } from "@/design-system";
import { RESOURCES } from "@/lib/design-resources";
import { GridLadderExplainer } from "@/components/explainers/GridLadderExplainer";
import { TradeExplainer } from "@/components/explainers/TradeExplainer";
import { MemeExplainer } from "@/components/explainers/MemeExplainer";
import { RangeExplainer } from "@/components/explainers/RangeExplainer";
import { CompoundExplainer } from "@/components/explainers/CompoundExplainer";
import { LendingExplainer } from "@/components/explainers/LendingExplainer";
import { ScheduleExplainer } from "@/components/explainers/ScheduleExplainer";
import { DcaExplainer } from "@/components/explainers/DcaExplainer";
import { SmartExplainer } from "@/components/explainers/SmartExplainer";
import { agentDeployKind, agentHasDemo, openDemo, openLive } from "@/lib/design-data";

/** A protocol/venue name renders as its logo when the design ships one. */
function ProtocolMark({ name }) {
  return PROTOCOL_LOGOS[name]
    ? <img src={PROTOCOL_LOGOS[name]} alt={name} title={name} className="fl-card__protocol-logo" />
    : <span>{name}</span>;
}

function Panel({ title, action, children, pad = true }) {
  return (
    <section style={{ border: "1px solid var(--border-card)", borderRadius: "var(--radius-md)", background: "var(--surface-card)" }}>
      {title && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "16px 20px", borderBottom: "1px solid var(--line-1)" }}>
          <span style={{ font: "var(--type-card-title)" }}>{title}</span>{action}
        </div>
      )}
      <div style={pad ? { padding: 20 } : undefined}>{children}</div>
    </section>
  );
}

function AgentDetailScreen({ agent, go }) {
  const cat = Category(agent.categoryId);
  const isAegisLP = agent.id === "aegis-lp";
  const isPaperTrade = agent.id === "ai-token-trader";
  const [range, setRange] = React.useState("30d");
  // Try demo now opens the deploy page in Demo mode; Hire Now opens it in Live mode (real funds on mainnet).
  const hasDemo = agentHasDemo(agent);
  const deployRoute = `/deploy/${agentDeployKind(agent)}`;
  const metrics = agent.metrics || [
    { label: isPaperTrade ? "Paper P&L" : cat.metricLabel, value: agent.metricValue, tone: agent.metricTone === "flat" ? "flat" : "profit", note: isPaperTrade ? "paper only" : "on-chain" },
    { label: "Users hiring", value: String(agent.hiredCount), note: "right now" },
    { label: "Fee", value: agent.price, note: agent.priceUnit },
    { label: "Protocol", value: agent.protocol, note: "NEAR" },
  ];
  return (
    <div className="fl-shell fl-agent-detail-page">
      <Button variant="ghost" size="sm" icon={<Icon name="chevron-right" size={14} style={{ transform: "rotate(180deg)" }} />} onClick={() => go("/")}>Marketplace</Button>

      <div className="fl-detail-hero" style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 32, flexWrap: "wrap", margin: "16px 0 28px" }}>
        <div style={{ display: "flex", gap: 16, minWidth: 0 }}>
          <span className="fl-card__glyph" style={{ width: 44, height: 44, color: cat.color, borderColor: cat.color, background: cat.tint }}>
            <Icon name={cat.icon} size={22} />
          </span>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <h1 style={{ font: "var(--type-page-title)" }}>{agent.name}</h1>
              {hasDemo ? <span className="fl-tier fl-tier--demo">Demo</span> : null}
              {agent.demoOnly ? null : <TierBadge tier={isAegisLP ? "verified" : agent.tier} />}
            </div>
            <p style={{ font: "var(--type-body-md)", color: "var(--text-muted)", maxWidth: "62ch" }}>{agent.tagline}</p>
            <div className="fl-card__meta" style={{ padding: 0 }}>
              <ProtocolMark name={agent.protocol} />
              {(agent.relatedProtocols || []).map((n) => <ProtocolMark key={n} name={n} />)}
              <span>{cat.label}</span>
            </div>
          </div>
        </div>
        <div className="fl-detail-cta" style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 10 }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
            {hasDemo ? <Button variant={agent.demoOnly ? "primary" : "secondary"} size="lg" onClick={() => openDemo(go, deployRoute)}>Try demo now</Button> : null}
            {agent.demoOnly ? null : <Button variant="primary" size="lg" onClick={() => openLive(go, deployRoute)} disabled={agent.disabled}>{agent.disabled ? "Coming soon" : "Hire Now"}</Button>}
          </div>
          <span style={{ font: "var(--weight-regular) var(--text-sm)/1 var(--font-sans)", color: "var(--text-subtle)" }}>{isPaperTrade ? "Paper only. No deposit or agent wallet." : "Takes 3 steps. You can revoke anytime."}</span>
        </div>
      </div>

      <div className="fl-metrics-grid" style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16 }}>
        {metrics.map((m) => <MetricTile key={m.label} {...m} />)}
      </div>

      <div className="fl-detail-grid" style={{ display: "grid", gridTemplateColumns: "minmax(0,1.55fr) minmax(0,1fr)", gap: 16, marginTop: 16, alignItems: "start" }}>
        <div className="fl-detail-main" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {isPaperTrade ? <MemeExplainer protocol={agent.protocol} /> : agent.categoryId === "grid"
            ? <GridLadderExplainer pair={agent.pair || "USDC / wNEAR"} protocol={agent.protocol} budget={agent.dailyCap || "500 USDT"} />
            : agent.explainer === "compound" ? <CompoundExplainer pair={agent.pair || "USDC / wNEAR"} protocol={agent.protocol} />
            : agent.explainer === "smart" ? <SmartExplainer protocol={agent.protocol} />
            : agent.explainer === "dca" ? <DcaExplainer protocol={agent.protocol} />
            : agent.explainer === "schedule" ? <ScheduleExplainer protocol={agent.protocol} />
            : agent.explainer === "trade" ? <TradeExplainer pair={agent.pair || "USDC / wNEAR"} protocol={agent.protocol} />
            : agent.explainer === "lending" ? <LendingExplainer protocol={agent.protocol} />
            : agent.categoryId === "lp" ? <RangeExplainer pair={agent.pair || "USDC / wNEAR"} protocol={agent.protocol} />
            : <>
          <ChartFrame title="Cumulative PnL" value={agent.metricValue} valueTone="profit" height={180}
            right={<SegmentedToggle value={range} onChange={setRange} options={["7d", "30d", "90d"]} />}
            series={agent.series || [0, 12, 9, 30, 26, 48, 62, 58, 84, 96, 92, 118]}
            axis={["12 Jun", "27 Jun", "Today"]} />

          <Panel title="On-chain activity" pad={false}
            action={<a href="https://nearblocks.io" target="_blank" rel="noreferrer" style={{ font: "var(--type-mono-xs)", display: "flex", gap: 5, alignItems: "center" }}>NearBlocks<Icon name="external" size={12} /></a>}>
            <div>
              {(agent.activity || []).map((r, i) => <ActivityRow key={i} {...r} href="https://nearblocks.io" />)}
              {!agent.activity && <div style={{ padding: 20, font: "var(--type-body-md)", color: "var(--text-subtle)" }}>No public activity in the last 24 hours.</div>}
            </div>
          </Panel>
            </>}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Operator, 2026-11-14: every line fits one line in the side panel (about 45 characters at most), and the deposit is not quoted in NEAR. */}
          <Panel title="What this agent is allowed to do">
            {hasDemo ? <PermissionItem kind="info">Try the demo: no wallet or funds needed.</PermissionItem> : null}
            {isPaperTrade ? (
              <>
                <PermissionItem>Join screened meme.cooking auctions on paper.</PermissionItem>
                <PermissionItem>Pass an AI check before each paper join.</PermissionItem>
                <PermissionItem>Track paper positions and exits.</PermissionItem>
                <PermissionItem kind="deny">Place real orders or create a wallet.</PermissionItem>
              </>
            ) : agent.explainer === "lending" ? (
              <>
                <PermissionItem>Watch your health factor on {agent.protocol}.</PermissionItem>
                <PermissionItem>Repay when it crosses your trigger line.</PermissionItem>
                <PermissionItem>Use only the balance set aside for it.</PermissionItem>
                <PermissionItem>Re-check and stop once it clears target.</PermissionItem>
                <PermissionItem kind="deny">Withdraw to any account but yours.</PermissionItem>
                <PermissionItem kind="deny">Borrow or add collateral on its own.</PermissionItem>
              </>
            ) : agent.explainer === "trade" ? (
              <>
                <PermissionItem>Trade only Rhea-listed tokens.</PermissionItem>
                <PermissionItem>Size entries within your capital.</PermissionItem>
                <PermissionItem>Exit at your take profit or stop loss.</PermissionItem>
                <PermissionItem kind="deny">Withdraw to any account but yours.</PermissionItem>
                <PermissionItem kind="deny">Spend past the capital you set.</PermissionItem>
              </>
            ) : agent.explainer === "schedule" ? (
              <>
                <PermissionItem>Deposit NEAR; it buys one token on schedule.</PermissionItem>
                <PermissionItem>Spend the same amount on every buy.</PermissionItem>
                <PermissionItem>Swap only on Rhea pools.</PermissionItem>
                <PermissionItem>Hold what it buys; never sells on its own.</PermissionItem>
                <PermissionItem kind="deny">Withdraw to any account but yours.</PermissionItem>
                <PermissionItem kind="deny">Spend past the budget you set.</PermissionItem>
              </>
            ) : agent.explainer === "dca" ? (
              <>
                <PermissionItem>Deposit NEAR; it opens with a base buy.</PermissionItem>
                <PermissionItem>Buy more at each price-drop step.</PermissionItem>
                <PermissionItem>Sell at your take profit over average cost.</PermissionItem>
                <PermissionItem>On stop loss, end the job without selling.</PermissionItem>
                <PermissionItem kind="deny">Withdraw to any account but yours.</PermissionItem>
                <PermissionItem kind="deny">Spend past the capital you set.</PermissionItem>
              </>
            ) : agent.explainer === "smart" ? (
              <>
                <PermissionItem>Hold 2 to 5 tokens at your target weights.</PermissionItem>
                <PermissionItem>Check the basket at your interval.</PermissionItem>
                <PermissionItem>Rebalance only past your drift threshold.</PermissionItem>
                <PermissionItem>Keep the tokens when you stop it.</PermissionItem>
                <PermissionItem kind="deny">Withdraw to any account but yours.</PermissionItem>
                <PermissionItem kind="deny">Invest more than the capital you set.</PermissionItem>
              </>
            ) : agent.explainer === "compound" ? (
              <>
                <PermissionItem>Manage only the position you delegate.</PermissionItem>
                <PermissionItem>Collect the fees the position earned.</PermissionItem>
                <PermissionItem>Add the fees back into the position.</PermissionItem>
                <PermissionItem>Compound only when fees beat gas.</PermissionItem>
                <PermissionItem kind="deny">Withdraw to any account but yours.</PermissionItem>
                <PermissionItem kind="deny">Move your range or add more capital.</PermissionItem>
              </>
            ) : agent.categoryId === "lp" ? (
              <>
                <PermissionItem>Deposit NEAR; it swaps what it needs itself.</PermissionItem>
                <PermissionItem>Provide liquidity only on USDC / wNEAR.</PermissionItem>
                <PermissionItem>Re-center the range when price leaves it.</PermissionItem>
                <PermissionItem>Compound fees back while in range.</PermissionItem>
                <PermissionItem>Exit at your stop loss or take profit.</PermissionItem>
                <PermissionItem kind="deny">Send NEAR to any account but yours or Rhea.</PermissionItem>
                <PermissionItem kind="deny">Change its own limits or policy.</PermissionItem>
              </>
            ) : (
              <>
                <PermissionItem>Deposit NEAR; it swaps what it needs itself.</PermissionItem>
                <PermissionItem>Trade only USDC / wNEAR on Rhea DCL.</PermissionItem>
                <PermissionItem>Keep at most four limit orders open.</PermissionItem>
                <PermissionItem>After a fill, place the reverse order.</PermissionItem>
                <PermissionItem>Spend only within your signed wallet policy.</PermissionItem>
                <PermissionItem kind="deny">Send NEAR to any account but yours or Rhea.</PermissionItem>
                <PermissionItem kind="deny">Change its own limits or policy.</PermissionItem>
              </>
            )}
            {isPaperTrade ? <PermissionItem kind="info">Only the owner can stop it.</PermissionItem> : <PermissionItem kind="info" note="Owner-only, on-chain.">You can freeze the agent wallet anytime.</PermissionItem>}
          </Panel>

          <Panel title="Pricing">
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span style={{ font: "var(--weight-semibold) var(--text-3xl)/1 var(--font-mono)" }}>0%</span>
              <span style={{ font: "var(--type-body)", color: "var(--text-muted)" }}>{isPaperTrade ? "paper agent fee" : "performance fee"}</span>
            </div>
            <div style={{ marginTop: 14 }}>
              <PermissionItem kind="info">No fees during the beta.</PermissionItem>
              <PermissionItem kind="info">{isPaperTrade ? "No deposit, agent wallet or real orders." : "Gas is paid from the agent wallet's NEAR."}</PermissionItem>
            </div>
          </Panel>

        </div>
      </div>
    </div>
  );
}

export { AgentDetailScreen, Panel };
