// @ts-nocheck -- Ported design JSX, kept byte-identical on purpose. The export is
// untyped and its ~20 inline sub-components would each need a hand-written prop
// interface; annotating them would mean editing the very markup this port exists
// to preserve. Type safety stops at this boundary: KitApp, KitHeader, the design
// system declarations and lib/ are all fully checked.
"use client";
/* Ported from the Claude Design export (ui_kits/marketplace/DeployAgentScreen.jsx).
   The JSX body is unchanged; only the IIFE wrapper, the design-system
   namespace proxies and the window globals became real imports/exports. */
import React from "react";
import { Button, Checkbox, Icon, Input, SegmentedToggle, Select, TierBadge } from "@/design-system";
import { agenticDcaEnabled, agenticEnabled } from "@/lib/agentic";
const WORDS = [
  { word: "Trading", color: "var(--cat-yield)" },
  { word: "LPing", color: "var(--cat-lp)" },
  { word: "Lending", color: "var(--cat-health)" },
];

const KINDS = [
  { id: "grid", label: "Grid Agent", icon: "grid-trading", color: "var(--cat-grid)", tint: "var(--cat-grid-tint)",
    venues: { demo: [{ label: "Rhea DCL", asset: "/design/protocols/rhea.png" }], live: [{ label: "Rhea DCL", asset: "/design/protocols/rhea.png" }] },
    blurb: "Automated grid market making that buys low and sells high as market price moves.",
    simLabel: "Backtest window", simNote: "Replays the ladder against historical pair data before any capital moves." },
  { id: "trading", label: "Trading Agent", icon: "yield", color: "var(--cat-yield)", tint: "var(--cat-yield-tint)",
    venues: { demo: [{ label: "Rhea", asset: "/design/protocols/rhea.png" }], live: [{ label: "Rhea", asset: "/design/protocols/rhea.png" }] },
    blurb: "Paper-trades meme.cooking auctions with an AI gate. No real orders, deposit or agent wallet.",
    simLabel: "Backtest window", simNote: "Replays the model against historical pair data before any capital moves." },
  { id: "lp", label: "LP Agent", icon: "lp-rebalance", color: "var(--cat-lp)", tint: "var(--cat-lp-tint)",
    venues: { demo: [{ label: "Rhea DCL", asset: "/design/protocols/rhea.png" }], live: [{ label: "Rhea DCL", asset: "/design/protocols/rhea.png" }] },
    blurb: "Routes liquidity to the best APR or fees with auto rebalance, compound & risk exits.",
    simLabel: "Backtest window", simNote: "Replays range, rebalance and fee behaviour over the selected pool history." },
  { id: "health", label: "Lending Agent", soon: true, icon: "health-shield", color: "var(--cat-health)", tint: "var(--cat-health-tint)",
    venues: { demo: [{ label: "Rhea Lend", asset: "/design/protocols/rhea.png" }], live: [{ label: "Rhea Lend", asset: "/design/protocols/rhea.png" }] },
    blurb: "Monitors lending positions loan health and automatically repays before liquidation.",
    simLabel: "Stress window", simNote: "Replays the collateral drawdown of the window against your triggers." },
];
const LONGEST = WORDS.reduce((a, b) => (b.word.length > a.length ? b.word : a), "");

const GLITCH_CHARS = "▚▓█/\\<>_=$#@%&*+ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const CRT_CSS = `
@keyframes crt-flicker{0%,100%{opacity:1}42%{opacity:.92}44%{opacity:.62}46%{opacity:.97}72%{opacity:.85}74%{opacity:1}}
.crt-word{animation:crt-flicker 3.4s steps(1,end) infinite}
@media (prefers-reduced-motion:reduce){.crt-word{animation:none}}`;

function scramble(word) {
  let out = "";
  for (let i = 0; i < word.length; i++) {
    out += Math.random() < 0.55 ? GLITCH_CHARS[Math.floor(Math.random() * GLITCH_CHARS.length)] : word[i];
  }
  return out;
}

function RotatingWord() {
  const [idx, setIdx] = React.useState(0);
  const [text, setText] = React.useState(WORDS[0].word);
  const [shift, setShift] = React.useState(0);

  React.useEffect(() => {
    let frame = 0, raf = null, alive = true;
    const glitch = (next) => {
      frame = 0;
      const step = () => {
        if (!alive) return;
        frame += 1;
        if (frame <= 7) {
          setText(scramble(next));
          setShift((Math.random() - 0.5) * 6);
          raf = setTimeout(step, 55);
        } else {
          setText(next);
          setShift(0);
        }
      };
      step();
    };
    const cycle = setInterval(() => {
      setIdx((n) => {
        const next = (n + 1) % WORDS.length;
        glitch(WORDS[next].word);
        return next;
      });
    }, 2600);
    return () => { alive = false; clearInterval(cycle); clearTimeout(raf); };
  }, []);

  const color = WORDS[idx].color;
  return (
    <span style={{ position: "relative", display: "inline-block", whiteSpace: "nowrap", color: color, fontFamily: "var(--font-mono)" }}>
      <style>{CRT_CSS}</style>
      <span aria-hidden="true" style={{ visibility: "hidden" }}>{LONGEST}&nbsp;</span>
      <span className="crt-word" style={{ position: "absolute", left: 0, top: 0, textShadow: "0 0 10px currentColor", transform: `translateX(${shift}px)` }}>{text}</span>
      <span aria-hidden="true" style={{ position: "absolute", left: 0, top: 0, color: "#22d3ee", opacity: 0.35, mixBlendMode: "screen", transform: `translateX(${shift * -0.9 - 1}px)` }}>{text}</span>
      <span aria-hidden="true" style={{ position: "absolute", left: 0, top: 0, color: "#e5484d", opacity: 0.24, mixBlendMode: "screen", transform: `translateX(${shift * 0.9 + 1}px)` }}>{text}</span>
    </span>
  );
}
function DeployAgentSection({ go }) {
  return (
    <section className="fl-deploy-landing" style={{ marginBottom: 44, paddingBottom: 40, borderBottom: "1px solid var(--line-1)" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 26 }}>
        <h2 style={{ font: "var(--weight-semibold) var(--text-3xl)/var(--leading-tight) var(--font-sans)", display: "flex", gap: "0.34em", flexWrap: "wrap", alignItems: "flex-end" }}>
          <span>Deploy Your Agent to</span><RotatingWord />
        </h2>
        <p style={{ font: "var(--type-body-md)", color: "var(--text-muted)", maxWidth: "62ch" }}>
          {/* Operator, 2026-11-14: the phrase in the 4lpha brand green, bold. */}
          The era of <span style={{ color: "var(--brand)", fontWeight: 700 }}>programmable money</span> starts here. Agents live 24/7.
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14 }}>
        {KINDS.map((k) => (
          <button key={k.id} className="fl-deploy-kind-card" onClick={() => go(`/deploy/${k.id}`)}
            style={{ "--fl-deploy-accent": k.color, textAlign: "left", cursor: "pointer", background: "var(--surface-card)", border: `1px solid ${k.color}`, borderRadius: "var(--radius-md)", padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ width: 37, height: 37, borderRadius: "var(--radius-sm)", background: k.tint, color: k.color, display: "grid", placeItems: "center" }}>
                  <Icon name={k.icon} size={22} />
                </span>
                <span style={{ font: "var(--type-card-title)", color: "var(--ink-1)", fontSize: 18, whiteSpace: "nowrap" }}>{k.label}</span>
              </span>
              {k.soon ? <TierBadge tier="coming-soon" /> : <span style={{ color: k.color, display: "grid", placeItems: "center" }}><Icon name="chevron-right" size={14} /></span>}
            </div>
            <p style={{ font: "var(--weight-regular) var(--text-sm)/var(--leading-normal) var(--font-sans)", color: "var(--text-muted)" }}>{k.blurb}</p>
            <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: "auto" }}>
              <span style={{ font: "var(--weight-regular) var(--text-sm)/var(--leading-normal) var(--font-sans)", color: k.color }}>Customise</span>
              {agenticEnabled && k.id === "trading" ? <img src="/design/protocols/binance-agentic-wallet.png" alt="Agentic Wallet" style={{ height: 11, width: "auto", display: "block" }} /> : null}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
export { DeployAgentSection };
