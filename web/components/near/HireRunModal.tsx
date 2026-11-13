"use client";
import * as React from "react";
import { createPortal } from "react-dom";
import type { HireStep, HireStepState } from "@/lib/hire-run";

/* Port of the BSC deploy popup (D:\4lpha-execution\web\components\deploy\DeployRunModal.tsx): same marks,
   progress bar, chip and dialog. NEAR changes (spec UI step 3, section 3): string step keys from
   hireRunSteps, and an action panel (children) under the step list, because four NEAR steps need the owner's wallet. */

/** How long "Agent deployed" stays up before the page moves to the agent. */
export const DEPLOYED_HOLD_MS = 1_500;

export function StepMark({ state, index, color }: { readonly state: HireStepState; readonly index: number; readonly color: string }) {
  const size = 22;
  const base: React.CSSProperties = { width: size, height: size, flex: "0 0 auto", display: "grid", placeItems: "center", position: "relative" };
  if (state === "active") return (
    <span className="fl-dp-anim fl-dp-ring-in" style={base}>
      <svg width={size} height={size} viewBox="0 0 22 22" style={{ position: "absolute", inset: 0 }}>
        <circle cx="11" cy="11" r="9" fill="none" stroke="var(--line-1)" strokeWidth="2" />
      </svg>
      <span className="fl-dp-anim fl-dp-spin" style={{ position: "absolute", inset: 0 }}>
        <svg width={size} height={size} viewBox="0 0 22 22" style={{ display: "block", transform: "rotate(-90deg)" }}>
          <circle className="fl-dp-anim fl-dp-dash" cx="11" cy="11" r="9" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" />
        </svg>
      </span>
      <span style={{ font: "var(--weight-medium) 10px/1 var(--font-mono)", color }}>{index + 1}</span>
    </span>
  );
  if (state === "done") return (
    <span className="fl-dp-anim fl-dp-pop" style={{ ...base, borderRadius: 999, background: "var(--profit)", color: "var(--surface-card)" }}>
      <svg width="12" height="12" viewBox="0 0 12 12"><path className="fl-dp-anim fl-dp-draw" d="M2.5 6.2 5 8.6 9.6 3.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="12" /></svg>
    </span>
  );
  if (state === "failed") return (
    <span style={{ ...base, borderRadius: 999, border: "1.5px solid var(--loss)", color: "var(--loss)", font: "var(--weight-medium) 11px/1 var(--font-mono)" }}>✕</span>
  );
  return (
    <span style={{ ...base, borderRadius: 999, border: "1.5px solid var(--line-1)", color: "var(--text-subtle)", font: "var(--weight-medium) 10px/1 var(--font-mono)" }}>{index + 1}</span>
  );
}

/** BSC LinearProgress, unchanged: the bar creeps toward ~90 % of the step in flight and eases every frame. */
export function LinearProgress({ base, span, color, running, failed }: {
  readonly base: number; readonly span: number; readonly color: string; readonly running: boolean; readonly failed: boolean;
}) {
  const bar = React.useRef<HTMLDivElement | null>(null);
  const sheen = React.useRef<HTMLDivElement | null>(null);
  const state = React.useRef({ shown: 0, stepStart: 0, base, span, running });
  const st = state.current;
  if (st.base !== base || st.span !== span) {
    if (base < st.base) st.shown = base;
    st.base = base; st.span = span; st.stepStart = Date.now();
  }
  st.running = running;
  React.useEffect(() => {
    const paint = (value: number) => {
      if (bar.current) bar.current.style.transform = `scaleX(${value})`;
      if (sheen.current) sheen.current.style.width = `${value * 100}%`;
    };
    if (typeof requestAnimationFrame !== "function") { paint(Math.min(1, state.current.base)); return; }
    let frame = 0;
    let last = Date.now();
    const tick = () => {
      const now = Date.now();
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      const s = state.current;
      const creep = s.running && s.span > 0 ? s.span * 0.9 * (1 - Math.exp(-(now - s.stepStart) / 1400)) : 0;
      const goal = Math.min(1, s.base + creep);
      const next = s.shown + (goal - s.shown) * (1 - Math.exp(-dt * 7));
      s.shown = Math.abs(goal - next) < 0.0005 ? goal : Math.max(s.shown, next);
      paint(s.shown);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  const complete = !running && !failed && base >= 1;
  return (
    <div style={{ position: "relative", height: 4, borderRadius: 999, background: "var(--line-1)", overflow: "hidden" }}>
      <div ref={bar} style={{ position: "absolute", inset: 0, transformOrigin: "left center", transform: "scaleX(0)", willChange: "transform", background: failed ? "var(--loss)" : complete ? "var(--profit)" : color, borderRadius: 999, transition: "background 300ms ease" }} />
      {running ? (
        <div ref={sheen} style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: 0, overflow: "hidden", borderRadius: 999 }}>
          <span className="fl-dp-anim fl-dp-shimmer" style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: "30%", minWidth: 40, background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.32), transparent)" }} />
        </div>
      ) : null}
    </div>
  );
}

export function HireStepList({ steps, color }: { readonly steps: readonly HireStep[]; readonly color: string }) {
  return (
    <div style={{ display: "grid", gap: 2, padding: "6px 8px", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", border: "1px solid var(--line-1)" }}>
      {steps.map((step, index) => {
        const quiet = step.state === "pending";
        return (
          <div key={step.key} data-step={step.key} data-state={step.state} style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "9px 6px" }}>
            <StepMark state={step.state} index={index} color={color} />
            <span style={{ display: "grid", gap: 3, minWidth: 0, paddingTop: 2 }}>
              <span style={{ font: "var(--weight-medium) var(--text-sm)/1.2 var(--font-sans)", color: quiet ? "var(--text-subtle)" : "var(--ink-1)" }}>{step.title}</span>
              <span style={{ font: "var(--weight-regular) var(--text-xs)/1.4 var(--font-sans)", color: step.state === "failed" ? "var(--loss)" : "var(--text-subtle)", overflowWrap: "anywhere" }}>
                {step.detail ?? step.hint}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

export const outlineBtn = (color: string): React.CSSProperties => ({ cursor: "pointer", flex: 1, padding: "12px 16px", borderRadius: "var(--radius-sm)", background: "transparent", border: `1px solid ${color}`, color, font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)" });
export const neutralBtn: React.CSSProperties = { ...outlineBtn("var(--line-1)"), color: "var(--ink-1)" };
export const solidBtn = (color: string): React.CSSProperties => ({ ...outlineBtn(color), background: color, color: "#08110c" });

export function HireRunModal(props: {
  /** "Grid Agent" or "LP Agent": the title reads "Deploying <label>". */
  readonly label: string;
  readonly color: string;
  readonly agentId: string;
  readonly steps: readonly HireStep[];
  readonly phase: "running" | "deployed" | "stopped";
  /** The active step's action panel. */
  readonly children?: React.ReactNode;
  readonly onCancel?: (() => void) | null;
  readonly cancelDisabled?: boolean;
  readonly onClose: () => void;
  readonly onOpenAgent: () => void;
}) {
  const { steps, phase } = props;
  const [hidden, setHidden] = React.useState(false);
  const dialogRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.contains(document.activeElement)) dialog.focus();
  });
  const finished = steps.filter(step => step.state === "done").length;
  const inFlight = steps.some(step => step.state === "active") ? 1 : 0;
  const total = steps.length;
  const title = phase === "deployed" ? "Agent deployed" : phase === "stopped" ? "Deploy stopped" : `Deploying ${props.label}`;

  if (hidden) {
    return (
      <div data-testid="deploy-run-chip" style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", border: "1px solid var(--line-1)" }}>
        {phase === "running" ? <StepMark state="active" index={Math.min(finished, total - 1)} color={props.color} /> : null}
        <span style={{ font: "var(--weight-medium) var(--text-sm)/1.2 var(--font-sans)", color: "var(--ink-1)" }}>{title}</span>
        <span style={{ font: "var(--weight-medium) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)" }}>{finished}/{total}</span>
        <button type="button" onClick={() => setHidden(false)} style={{ marginLeft: "auto", cursor: "pointer", padding: "8px 12px", borderRadius: "var(--radius-sm)", background: "transparent", border: `1px solid ${props.color}`, color: props.color, font: "var(--weight-medium) var(--text-xs)/1 var(--font-sans)" }}>Show progress</button>
      </div>
    );
  }
  if (typeof document === "undefined") return null;

  const hide = () => setHidden(true);
  return createPortal(
    <div className="fl-dp-anim fl-dp-fade" data-testid="deploy-run-modal"
      onClick={(event) => { if (event.target === event.currentTarget && phase !== "running") props.onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 58, display: "grid", placeItems: "center", padding: 16, background: "rgba(6,8,10,0.62)", backdropFilter: "blur(3px)" }}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className="fl-dp-anim fl-dp-in"
        onKeyDown={(event) => { if (event.key === "Escape") { if (phase === "running") hide(); else props.onClose(); } }}
        style={{ width: "100%", maxWidth: 440, maxHeight: "calc(100vh - 32px)", overflowY: "auto", display: "grid", gap: 16, padding: 20, borderRadius: "var(--radius-md)", background: "var(--surface-card)", border: "1px solid var(--border-card)", boxShadow: "0 24px 60px rgba(0,0,0,0.45)" }}>
        <div style={{ display: "grid", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
            <span style={{ font: "var(--weight-semibold) var(--text-md)/1.2 var(--font-sans)", color: "var(--ink-1)" }}>{title}</span>
            <span style={{ font: "var(--weight-medium) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)" }}>{finished}/{total}</span>
          </div>
          <LinearProgress base={finished / total} span={inFlight / total} color={props.color} running={phase === "running"} failed={phase === "stopped"} />
          <span style={{ font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)", overflowWrap: "anywhere" }}>{props.agentId}</span>
        </div>
        <HireStepList steps={steps} color={props.color} />
        {props.children}
        {phase === "running" ? <p style={{ margin: 0, font: "var(--weight-regular) var(--text-xs)/1.4 var(--font-sans)", color: "var(--text-subtle)" }}>This can take 30 seconds to a minute. If a step without a wallet button spins for several minutes, check that the Worker window is still running.</p> : null}
        {phase === "deployed" ? <p style={{ margin: 0, font: "var(--weight-regular) var(--text-sm)/var(--leading-normal) var(--font-sans)", color: "var(--text-muted)" }}>Opening the agent page...</p> : null}
        <div style={{ display: "flex", gap: 10 }}>
          {phase === "running" ? <>
            <button type="button" style={neutralBtn} onClick={hide}>Hide</button>
            {props.onCancel ? <button type="button" style={{ ...outlineBtn(props.color), ...(props.cancelDisabled ? { cursor: "wait", opacity: 0.6 } : {}) }} disabled={props.cancelDisabled === true} onClick={props.onCancel}>Cancel hire</button> : null}
          </> : null}
          {phase === "stopped" ? <>
            <button type="button" style={neutralBtn} onClick={props.onClose}>Close</button>
            <button type="button" style={outlineBtn(props.color)} onClick={props.onOpenAgent}>Open the agent page</button>
          </> : null}
          {phase === "deployed" ? <button type="button" style={solidBtn(props.color)} onClick={props.onOpenAgent}>Open the agent page</button> : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
