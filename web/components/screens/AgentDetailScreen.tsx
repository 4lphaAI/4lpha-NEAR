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
import { agentDeployKind } from "@/lib/design-data";

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
              <TierBadge tier={isAegisLP ? "verified" : agent.tier} />
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
          <Button variant="primary" size="lg" onClick={() => go(`/deploy/${agentDeployKind(agent)}`)} disabled={agent.disabled}>{agent.disabled ? "Coming soon" : "Hire Now"}</Button>
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
          <Panel title="What this agent is allowed to do">
            {isPaperTrade ? (
              <>
                <PermissionItem>Join screened meme.cooking auctions on paper after an AI gate.</PermissionItem>
                <PermissionItem>Track paper positions and exits within your settings.</PermissionItem>
                <PermissionItem kind="deny">Place real orders or create an agent wallet.</PermissionItem>
              </>
            ) : agent.explainer === "lending" ? (
              <>
                <PermissionItem>Watch the health factor on your {agent.protocol} account, no other protocol, no other wallet.</PermissionItem>
                <PermissionItem>Repay your largest debt market first when your health factor crosses your trigger line.</PermissionItem>
                <PermissionItem>Use only the wallet balance held for this, never a new borrow, never your other assets.</PermissionItem>
                <PermissionItem>Re-read the health factor on-chain after repaying, and stop once it clears your target.</PermissionItem>
                <PermissionItem>Log every repay, with the transaction and the before/after health factor.</PermissionItem>
                <PermissionItem kind="deny">Withdraw funds to any account but yours.</PermissionItem>
                <PermissionItem kind="deny">Supply new collateral or open new borrows on its own.</PermissionItem>
              </>
            ) : agent.explainer === "trade" ? (
              <>
                <PermissionItem>Trade only tokens on the Rhea token list, paired with USDC.</PermissionItem>
                <PermissionItem>Size entries within your capital and max open positions.</PermissionItem>
                <PermissionItem>Swap on Rhea.</PermissionItem>
                <PermissionItem>Exit at your take profit, stop loss or max hold time.</PermissionItem>
                <PermissionItem>Let the LLM decide any exit you leave blank.</PermissionItem>
                <PermissionItem kind="deny">Withdraw funds to any account but yours.</PermissionItem>
                <PermissionItem kind="deny">Spend past the capital you set, or raise its own limits.</PermissionItem>
              </>
            ) : agent.explainer === "schedule" ? (
              <>
                <PermissionItem>Buy one token with USDC on your schedule.</PermissionItem>
                <PermissionItem>Spend the same amount on every buy.</PermissionItem>
                <PermissionItem>Swap on Rhea.</PermissionItem>
                <PermissionItem>Hold what it buys; it never sells on its own.</PermissionItem>
                <PermissionItem kind="deny">Withdraw funds to any account but yours.</PermissionItem>
                <PermissionItem kind="deny">Spend past the total budget you set.</PermissionItem>
              </>
            ) : agent.explainer === "dca" ? (
              <>
                <PermissionItem>Open each round with a base buy of one token.</PermissionItem>
                <PermissionItem>Buy more at each price-drop step, up to your max.</PermissionItem>
                <PermissionItem>Sell the round at your take profit over average cost.</PermissionItem>
                <PermissionItem>Start a new round after each take profit.</PermissionItem>
                <PermissionItem>On stop loss, stop the agent without selling.</PermissionItem>
                <PermissionItem kind="deny">Withdraw funds to any account but yours.</PermissionItem>
                <PermissionItem kind="deny">Spend past the capital you set.</PermissionItem>
              </>
            ) : agent.explainer === "smart" ? (
              <>
                <PermissionItem>Hold 2 to 5 tokens at your target weights.</PermissionItem>
                <PermissionItem>Check the basket at your interval (4h to daily).</PermissionItem>
                <PermissionItem>Rebalance only when a token drifts past your threshold.</PermissionItem>
                <PermissionItem>Swap on Rhea.</PermissionItem>
                <PermissionItem>Keep the tokens when you stop it; no sell-off.</PermissionItem>
                <PermissionItem kind="deny">Withdraw funds to any account but yours.</PermissionItem>
                <PermissionItem kind="deny">Invest more than the total capital you set.</PermissionItem>
              </>
            ) : agent.explainer === "compound" ? (
              <>
                <PermissionItem>Manage only the liquidity you delegate on {agent.protocol}.</PermissionItem>
                <PermissionItem>Collect the swap fees that position has earned.</PermissionItem>
                <PermissionItem>Swap the part of those fees needed to match the pool ratio.</PermissionItem>
                <PermissionItem>Add the fees back into the same position.</PermissionItem>
                <PermissionItem>Wait until unclaimed fees are worth more than gas to compound.</PermissionItem>
                <PermissionItem kind="deny">Withdraw funds to any account but yours.</PermissionItem>
                <PermissionItem kind="deny">Move your range, or add capital beyond what you delegate.</PermissionItem>
              </>
            ) : agent.categoryId === "lp" ? (
              <>
                <PermissionItem>Manage only the liquidity you delegate on {agent.protocol}.</PermissionItem>
                <PermissionItem>Move position to a new price range when price drifts outside band.</PermissionItem>
                <PermissionItem>Collect the fees earns and put them back in your positions.</PermissionItem>
                <PermissionItem>Swap between the two tokens only as much as re-ranging needs.</PermissionItem>
                <PermissionItem>Wait out your drift trigger and cooldown before it moves anything.</PermissionItem>
                <PermissionItem kind="deny">Withdraw funds to any account but yours.</PermissionItem>
                <PermissionItem kind="deny">Add liquidity beyond what you delegate.</PermissionItem>
              </>
            ) : (
              <>
                <PermissionItem>Deposit 1 to 2 NEAR. The agent swaps what it needs into USDC itself.</PermissionItem>
                <PermissionItem>Trade only USDC / wNEAR on Rhea DCL, with at most four open limit orders.</PermissionItem>
                <PermissionItem>After a full fill, place the reverse order one step away.</PermissionItem>
                <PermissionItem>Spend at most 0.25 NEAR per transaction and 3 times your deposit per day, as your wallet policy sets.</PermissionItem>
                <PermissionItem>Pay out only to your own NEAR account when you stop it.</PermissionItem>
                <PermissionItem kind="deny">Send NEAR to any account but yours or the Rhea contracts.</PermissionItem>
                <PermissionItem kind="deny">Change its own limits. Only you can update or freeze the policy.</PermissionItem>
              </>
            )}
            {isPaperTrade ? <PermissionItem kind="info">Only the owner can stop the paper agent.</PermissionItem> : <PermissionItem kind="info" note="Owner-only, on-chain.">You can freeze the agent wallet at any time.</PermissionItem>}
          </Panel>

          <Panel title="Pricing">
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span style={{ font: "var(--weight-semibold) var(--text-3xl)/1 var(--font-mono)" }}>0%</span>
              <span style={{ font: "var(--type-body)", color: "var(--text-muted)" }}>{isPaperTrade ? "paper agent fee" : "performance fee"}</span>
            </div>
            <div style={{ marginTop: 14 }}>
              <PermissionItem kind="info">No fees during the beta.</PermissionItem>
              <PermissionItem kind="info">{isPaperTrade ? "No deposit, agent wallet or real orders." : "Network gas is paid from the NEAR in the agent wallet."}</PermissionItem>
            </div>
          </Panel>

        </div>
      </div>
    </div>
  );
}

export { AgentDetailScreen, Panel };
