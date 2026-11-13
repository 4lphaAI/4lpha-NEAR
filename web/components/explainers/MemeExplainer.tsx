"use client";
/* The paper meme agent's explainer (AI Quant Trader). Same frame as the other
   explainers: an SVG scene, a feed of chips, a step caption and step buttons.
   It walks one auction through the agent's real rules (Trade V0 spec section 3
   and 5): the deterministic screen, the AI gate (join at confidence 70 or more),
   the paper deposit, the launch mark and the three exits (stop -30 %, trailing
   15 points under a peak of +20 % or more, 4 hours after launch). Paper only. */
import React from "react";
import { useCardVisible } from "./useCardVisible";

const SCENES = [
  { t: 0, title: "It watches every new meme.cooking auction", body: "Screens meme.cooking auctions and joins on paper after an AI gate. It only looks in the last 10 minutes before an auction ends." },
  { t: 1700, title: "The screen drops most of them", body: "Fewer than 10 depositors, mostly the creator's own NEAR, under half the soft cap, or already at the hard cap: no entry." },
  { t: 3300, title: "The AI gate has the last word", body: "NEAR AI Cloud sees numbers only and answers join or skip. Under 70 confidence, or no answer, means no entry. It can say no, never resize." },
  { t: 4800, title: "A paper deposit, sized by you", body: "Your fixed amount per auction, inside your capital and open slots. The 0.5 % meme.cooking deposit fee is counted in the result." },
  { t: 6200, title: "The auction launches and the tokens are marked", body: "Each minute the tokens are valued at what they would sell for in the launch pool. An auction that fails comes back as refunded." },
  { t: 8000, title: "It exits on the stop, a trailing drop or the clock", body: "Down 30 %, 15 points under a peak above +20 %, or 4 hours after launch. Whichever comes first goes in the log, on paper." },
];
const TOTAL = 11000;
const PASS_AT = 2900;
const GATE_AT = 3800;
const ENTRY_AT = 4800;
const LAUNCH_AT = 6200;
const PEAK_AT = 7600;
const EXIT_AT = 8900;
const VW = 700;
const VH = 292;
const N = 150;
const X0 = 300;
const X1 = 560;
const yP = (pct: number): number => 250 - (pct + 35) * (180 / 75);
const YELLOW = "var(--cat-yield)";
const CANDS = [
  { t: 250, v: 1900, id: "#2319", meta: "4 DEPOSITORS · 38% OF SOFT CAP", ok: false, why: "few depositors" },
  { t: 550, v: 2200, id: "#2320", meta: "12 DEPOSITORS · CREATOR 94%", ok: false, why: "creator-funded" },
  { t: 850, v: 2500, id: "#2322", meta: "15 DEPOSITORS · 22% OF SOFT CAP", ok: false, why: "far from cap" },
  { t: 1150, v: PASS_AT, id: "#2323", meta: "27 DEPOSITORS · 81% OF SOFT CAP", ok: true, why: "passes" },
];
type Tone = "y" | "ok";
const FILLS: Array<{ t: number; tone: Tone; text: string; sub: string }> = [
  { t: PASS_AT, tone: "y", text: "3 of 4 auctions screened out", sub: "10+ depositors · creator under 90% · half the soft cap" },
  { t: GATE_AT, tone: "y", text: "AI gate: join, confidence 78", sub: "numbers only · needs 70" },
  { t: ENTRY_AT, tone: "y", text: "Paper deposit 10 NEAR", sub: "slot 2 of 2 · 0.5% deposit fee counted" },
  { t: LAUNCH_AT, tone: "ok", text: "Auction launched", sub: "tokens marked at their pool sell value" },
  { t: EXIT_AT, tone: "ok", text: "Closed +22.4% on paper", sub: "trailing exit · logged" },
];

/** The mark the tape is pulled toward at elapsed time `ev`, in percent of the deposit. */
const targetAt = (ev: number): number =>
  ev < LAUNCH_AT ? 0 : ev < PEAK_AT ? 38 : ev < EXIT_AT - 500 ? 29 : 21;

function MemeExplainer({ protocol = "meme.cooking" }: { protocol?: string }) {
  const cardRef = React.useRef<HTMLElement | null>(null);
  /* Re-rendering every frame is only worth it while the card is on screen. */
  const running = useCardVisible(cardRef);
  const [e, setE] = React.useState(0);
  const [playing, setPlaying] = React.useState(true);
  const [pts, setPts] = React.useState<number[]>(() => new Array<number>(N).fill(yP(0)));
  const st = React.useRef({ e: 0, cur: yP(0), last: 0, playing: true, seed: 0 });
  st.current.playing = playing;

  React.useEffect(() => {
    if (!running) return;
    let raf = 0;
    const loop = (ts: number) => {
      const s = st.current;
      const dt = s.last ? Math.min(64, ts - s.last) : 16;
      s.last = ts;
      if (s.playing) {
        const prev = s.e;
        s.e = (s.e + dt) % TOTAL;
        if (s.e < prev) s.cur = yP(0);
      }
      const ev = s.e;
      s.seed += dt / 1000;
      const j = ev < LAUNCH_AT ? 0 : Math.sin(s.seed * 2.5) * 2.2 + Math.sin(s.seed * 6.9) * 1.0 + Math.sin(s.seed * 16.3) * 0.4;
      s.cur += (yP(targetAt(ev) + j) - s.cur) * 0.12;
      setPts((prev) => {
        const nx = prev.slice(1);
        nx.push(s.cur);
        return nx;
      });
      setE(ev);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [running]);

  const sceneIdx = SCENES.reduce((acc, s, i) => (e >= s.t ? i : acc), 0);
  const scene = SCENES[sceneIdx] as (typeof SCENES)[number];
  const jump = (i: number) => {
    const t = (SCENES[i] as (typeof SCENES)[number]).t + 1;
    st.current.e = t;
    st.current.cur = yP(targetAt(t));
    setE(t);
  };

  const gateShown = e >= SCENES[2]!.t;
  const gated = e >= GATE_AT;
  const entered = e >= ENTRY_AT;
  const launched = e >= LAUNCH_AT;
  const peaked = e >= PEAK_AT;
  const closed = e >= EXIT_AT;
  /* the staked share of the soft cap climbs from 81 % to the launch */
  const staked = !entered ? 0.81 : launched ? 1 : 0.81 + (0.19 * (e - ENTRY_AT)) / (LAUNCH_AT - ENTRY_AT);
  const trailPct = peaked ? 23 : 20;
  const path = pts.map((py, i) => `${(X0 + (i * (X1 - X0)) / (N - 1)).toFixed(1)},${py.toFixed(1)}`).join(" ");
  const headY = pts[pts.length - 1] as number;
  const pulse = FILLS.slice(2).find((f) => e >= f.t && e < f.t + 600);
  const feed = FILLS.filter((f) => e >= f.t).slice(-4);
  const tone = (t: Tone) => (t === "ok" ? "var(--profit)" : YELLOW);
  const tint = (t: Tone) => (t === "ok" ? "var(--live-tint)" : "var(--cat-yield-tint)");
  const mono = { font: "var(--type-mono-xs)" };

  return (
    <section ref={cardRef} style={{ border: "1px solid var(--border-card)", borderRadius: "var(--radius-md)", background: "var(--surface-card)", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "16px 20px", borderBottom: "1px solid var(--line-1)" }}>
        <span style={{ font: "var(--type-card-title)" }}>How this agent works</span>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ ...mono, color: "var(--text-subtle)" }}>Paper auctions · {protocol}</span>
          <button onClick={() => setPlaying((p) => !p)} style={{ ...mono, color: "var(--text-muted)", background: "none", border: "1px solid var(--line-2)", borderRadius: 999, padding: "3px 10px", cursor: "pointer" }}>{playing ? "Pause" : "Play"}</button>
        </div>
      </div>

      <div className="fl-explainer-visual" style={{ padding: "8px 12px 0" }}>
        <svg viewBox={`0 0 ${VW} ${VH}`} style={{ display: "block", width: "100%", height: "auto" }}>
          <text x={28} y={24} style={{ ...mono, fill: "var(--text-subtle)" }}>SCREENING</text>
          {CANDS.map((c, i) => {
            const shown = e >= c.t;
            const judged = e >= c.v;
            const col = !judged ? "var(--line-2)" : c.ok ? "var(--profit)" : "var(--ink-4)";
            return (
              <g key={c.id} style={{ opacity: shown ? (judged && !c.ok ? 0.4 : 1) : 0, transition: "opacity .4s ease" }}>
                <rect x={28} y={36 + i * 42} width={244} height={34} rx="4" fill={judged && c.ok ? "var(--live-tint)" : "var(--surface-sunken)"} stroke={col} />
                <text x={40} y={50 + i * 42} style={{ ...mono, fill: judged && c.ok ? "var(--ink-1)" : "var(--text-muted)" }}>{c.id}</text>
                <text x={40} y={64 + i * 42} style={{ ...mono, fill: "var(--text-subtle)" }}>{c.meta}</text>
                {judged && <text x={260} y={50 + i * 42} textAnchor="end" style={{ ...mono, fill: c.ok ? "var(--profit)" : "var(--ink-3)" }}>{c.ok ? "PASS" : "SKIP · " + c.why}</text>}
              </g>
            );
          })}

          <g style={{ opacity: gateShown ? 1 : 0, transition: "opacity .4s ease" }}>
            <rect x={28} y={210} width={244} height={40} rx="4" fill={gated ? "var(--cat-yield-tint)" : "var(--surface-sunken)"} stroke={gated ? YELLOW : "var(--line-2)"} strokeDasharray={gated ? undefined : "4 4"} />
            <text x={40} y={226} style={{ ...mono, fill: "var(--ink-1)" }}>AI GATE · NEAR AI CLOUD</text>
            <text x={40} y={241} style={{ ...mono, fill: gated ? YELLOW : "var(--text-subtle)" }}>{gated ? "JOIN · CONFIDENCE 78 (NEEDS 70)" : "ASKING · NUMBERS ONLY"}</text>
          </g>

          <text x={X0} y={24} style={{ ...mono, fill: "var(--text-subtle)" }}>
            {closed ? "CLOSED ON PAPER · +22.4%" : launched ? "AUCTION #2323 · LAUNCHED · MARKED" : entered ? "AUCTION #2323 · PAPER DEPOSIT 10 NEAR" : "AWAITING A PASS"}
          </text>

          <g style={{ opacity: entered ? 1 : 0.25, transition: "opacity .5s ease" }}>
            <text x={X0} y={42} style={{ ...mono, fill: "var(--text-subtle)" }}>{launched ? "SOFT CAP REACHED" : `STAKED ${Math.round(staked * 100)}% OF SOFT CAP`}</text>
            <rect x={X0} y={48} width={X1 - X0} height={6} rx="3" fill="var(--surface-sunken)" stroke="var(--line-2)" />
            <rect x={X0} y={48} width={(X1 - X0) * staked} height={6} rx="3" fill={launched ? "var(--profit)" : YELLOW} />
          </g>

          <g style={{ opacity: launched ? 1 : 0.25, transition: "opacity .5s ease" }}>
            <g style={{ transform: `translateY(${yP(trailPct) - yP(20)}px)`, transition: "transform .6s var(--ease-out)" }}>
              <line x1={X0} y1={yP(20)} x2={X1} y2={yP(20)} stroke={YELLOW} strokeWidth="1.5" strokeDasharray={peaked ? undefined : "6 5"} />
              <text x={X1 + 10} y={yP(20) + 4} style={{ ...mono, fill: YELLOW }}>{peaked ? "TRAIL · PEAK -15" : "TRAIL ARMS +20%"}</text>
            </g>
            <line x1={X0} y1={yP(0)} x2={X1} y2={yP(0)} stroke="var(--line-3)" strokeWidth="1" />
            <text x={X1 + 10} y={yP(0) + 4} style={{ ...mono, fill: "var(--text-subtle)" }}>DEPOSIT</text>
            <line x1={X0} y1={yP(-30)} x2={X1} y2={yP(-30)} stroke="var(--loss)" strokeWidth="1.5" strokeDasharray="4 4" />
            <text x={X1 + 10} y={yP(-30) + 4} style={{ ...mono, fill: "var(--loss)" }}>STOP -30%</text>
          </g>

          <g style={{ opacity: launched ? 1 : 0, transition: "opacity .4s ease" }}>
            <polyline points={path} fill="none" stroke="var(--brand)" strokeWidth="1.8" strokeLinejoin="round" />
            {pulse && <circle cx={X1} cy={headY} r={9 + ((e - pulse.t) / 600) * 26} fill="none" stroke={tone(pulse.tone)} strokeWidth="1.5" opacity={1 - (e - pulse.t) / 600} />}
            <circle cx={X1} cy={headY} r="4.5" fill="var(--brand)" />
            <circle cx={X1} cy={headY} r="11" fill="none" stroke="var(--brand-line)" />
          </g>

          <g style={{ opacity: entered ? 1 : 0, transition: "opacity .4s ease" }}>
            <text x={X0} y={276} style={{ ...mono, fill: "var(--text-subtle)" }}>PER AUCTION 10 NEAR · SLOTS {closed ? "1" : "2"} / 2 · HELD {closed ? "2H 41M" : launched ? "1H 12M" : "0H"} / 4H</text>
          </g>
        </svg>
      </div>

      <div className="fl-explainer-visual" style={{ display: "flex", gap: 8, padding: "4px 20px 0", flexWrap: "wrap" }}>
        {feed.map((f) => (
          <span key={f.t} style={{ display: "inline-flex", gap: 8, alignItems: "baseline", ...mono, padding: "5px 10px", borderRadius: "var(--radius-sm)", border: `1px solid ${tint(f.tone)}`, background: tint(f.tone), color: "var(--ink-1)" }}>
            {f.text}<span style={{ color: "var(--text-subtle)" }}>{f.sub}</span>
          </span>
        ))}
      </div>

      <div style={{ padding: 20, display: "grid", gap: 6 }}>
        <span style={{ ...mono, color: "var(--text-subtle)" }}>STEP {sceneIdx + 1} / {SCENES.length}</span>
        <span style={{ font: "var(--type-card-title)" }}>{scene.title}</span>
        <p style={{ font: "var(--type-body-md)", color: "var(--text-muted)", maxWidth: "70ch", textWrap: "pretty" }}>{scene.body}</p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: `repeat(${SCENES.length},1fr)`, gap: 6, padding: "0 20px 20px" }}>
        {SCENES.map((s, i) => (
          <button key={s.t} onClick={() => jump(i)} title={s.title}
            style={{ height: 3, borderRadius: 999, border: "none", padding: 0, cursor: "pointer", background: i === sceneIdx ? "var(--brand)" : "var(--line-2)", transition: "background .3s ease" }} />
        ))}
      </div>

      <div style={{ borderTop: "1px solid var(--line-1)", padding: "14px 20px", display: "flex", gap: 24, flexWrap: "wrap", ...mono, color: "var(--text-subtle)" }}>
        <span>MEME.COOKING ONLY</span><span>PAPER ONLY, NOTHING IS SIGNED</span><span>AI GATE 70+</span><span>STOP -30% · TRAIL 15 PTS · 4H</span>
      </div>
    </section>
  );
}

export { MemeExplainer };
