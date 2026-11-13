// @ts-nocheck -- Ported design JSX, kept as close to the source as possible on
// purpose, like the other ported screens. Type safety stops at this boundary:
// NearDeployScreen.tsx, which binds NEAR data and calls the session actions, is
// fully checked.
"use client";
/* Copied from the 4lpha web UI (web/components/screens/DeployAgentScreen.tsx,
   pre-hackathon code): PoolDot, the selected-pool box of PoolPicker, NumStepper,
   PriceRangeBox, ModeRow / ModeRows, Field and Group. Only whole branches the
   NEAR form never reaches were removed (pool search, tick geometry, price flip,
   trading and lending field types, swapless preview, AI model credits). The
   NEAR-only changes are marked "NEAR:". */
import React from "react";
import { Checkbox, Input, Select } from "@/design-system";
import { RangeExplainer } from "@/components/explainers/RangeExplainer";
import { CompoundExplainer } from "@/components/explainers/CompoundExplainer";
import { PairIcons } from "@/components/TokenIcon";

function PoolDot({ color }) {
  return <span style={{ width: 26, height: 26, borderRadius: 999, background: color, opacity: 0.9, flex: "0 0 auto", border: "1px solid rgba(255,255,255,0.16)" }} />;
}

/* NEAR: one pinned pool, so only the SELECTED box of PoolPicker is kept (no
   search field, no suggested list, no pasted contract). The two token logos
   replace the dot, as the BNB product's live pool box shows them. */
function PoolPicker({ selected }) {
  return (
    <div style={{ display: "grid", gap: 10, position: "relative" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", border: "1px solid var(--cat-grid)" }}>
        {selected.tokens ? <PairIcons token0={selected.tokens[0]} token1={selected.tokens[1]} /> : <PoolDot color={selected.c} />}
        <span style={{ display: "grid", gap: 3, minWidth: 0 }}>
          <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)" }}>{selected.pair}</span>
          <span style={{ font: "var(--weight-regular) var(--text-xs)/1.3 var(--font-mono)", color: "var(--text-subtle)" }}>{selected.addr} · {selected.fee}</span>
        </span>
        <span style={{ marginLeft: "auto", font: "var(--weight-medium) var(--text-xs)/1 var(--font-mono)", color: "var(--cat-grid)", letterSpacing: "0.06em" }}>SELECTED</span>
      </div>
    </div>
  );
}

function NumStepper({ value, onChange, step = 1, min, max, prefix, suffix, noLimitAtMin, disabled, noClamp, preciseStep }) {
  const raw = value === "" || value == null ? null : parseFloat(String(value).replace(/,/g, ""));
  const round = (n) => Math.round(n / step) * step;
  const fmt = (n) => {
    if (n == null) return "No limit";
    const dp = String(step).includes(".") ? String(step).split(".")[1].length : 0;
    return dp ? n.toFixed(dp) : String(n);
  };
  const dec = () => {
    if (disabled || raw == null) return;
    const next = preciseStep ? Number((raw - step).toFixed(6)) : round(raw - step);
    if (preciseStep && min != null && next < min) return;
    if (noLimitAtMin && next < (min != null ? min : step)) { onChange(""); return; }
    onChange(String(min != null && next < min ? min : next));
  };
  const inc = () => {
    if (disabled) return;
    if (raw == null) { onChange(String(preciseStep ? step : min != null ? min : step)); return; }
    const next = preciseStep ? Number((raw + step).toFixed(6)) : round(raw + step);
    onChange(String(max != null && next > max ? max : next));
  };
  // `noClamp`: the caller shows the violation in red instead of silently
  // rewriting what the owner typed. The − button still stops AT the minimum, so
  // a floor cannot be stepped below, only typed below, and then it is refused.
  const below = !noClamp ? false : min != null && raw != null && raw < min;
  return (
    <div style={{ display: "flex", alignItems: "stretch", border: `1px solid ${below ? "var(--loss)" : "var(--line-1)"}`, borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", opacity: disabled ? 0.45 : 1, pointerEvents: disabled ? "none" : "auto" }}>
      <button type="button" onClick={dec} aria-label="Decrease" disabled={disabled || (preciseStep && (raw == null || raw - step < (min ?? 0)))} style={{ cursor: "pointer", width: 40, flex: "0 0 auto", display: "grid", placeItems: "center", background: "transparent", border: "none", borderRight: "1px solid var(--line-1)", color: "var(--text-subtle)", fontSize: 16, lineHeight: 1 }}>−</button>
      {prefix ? <span style={{ alignSelf: "center", paddingLeft: 12, color: "var(--text-subtle)" }}>{prefix}</span> : null}
      <input value={value == null ? "" : value} placeholder={noLimitAtMin ? "No limit" : undefined} onChange={(e) => onChange(e.target.value)}
        onBlur={() => { if (raw != null && !noClamp) { const clamped = min != null && raw < min ? min : max != null && raw > max ? max : raw; onChange(String(clamped)); } }}
        style={{ flex: 1, minWidth: 0, textAlign: "right", padding: "11px 12px", background: "transparent", border: "none", outline: "none", font: "var(--weight-medium) var(--text-sm)/1 var(--font-mono)", color: raw == null ? "var(--text-subtle)" : "var(--ink-1)" }} />
      {suffix && raw != null ? <span style={{ display: "flex", alignItems: "center", paddingRight: 12, font: "var(--weight-medium) var(--text-sm)/1 var(--font-mono)", color: "var(--text-subtle)" }}>{suffix}</span> : null}
      <button type="button" onClick={inc} aria-label="Increase" style={{ cursor: "pointer", width: 40, flex: "0 0 auto", display: "grid", placeItems: "center", background: "transparent", border: "none", borderLeft: "1px solid var(--line-1)", color: "var(--text-subtle)", fontSize: 16, lineHeight: 1 }}>+</button>
    </div>
  );
}

/* NEAR: one price bound in USDC per NEAR. The −/+ buttons move one DCL point
   (0.01 %) from the typed price, or from the current point while the box is
   empty, and write the price with 6 decimals, the most the server accepts. */
function PriceRangeBox({ label, displayValue, onDisplayChange, onStep, currentPrice, quoteSymbol }) {
  const num = parsePrice(displayValue);
  // NEAR: an empty box (no pool price read yet) is not shown as an error.
  // NEAR: valid only in the form the server accepts (src/core/lp.ts: up to 6 decimals).
  const valid = displayValue === "" || (num !== null && /^\d+(?:\.\d{1,6})?$/.test(String(displayValue)));
  const pct = num !== null && currentPrice ? ((num - currentPrice) / currentPrice) * 100 : 0;
  const pctStr = (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%";
  const stepBy = (bins) => onStep(bins);
  return (
    <div style={{ display: "grid", gap: 8 }} data-price-box={label}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span className="fl-eyebrow">{label}</span>
      </div>
      <div style={{ display: "flex", alignItems: "stretch", border: `1px solid ${valid ? "var(--line-1)" : "var(--loss)"}`, borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)" }}>
        <button type="button" onClick={() => stepBy(-1)} aria-label={`Decrease ${label}`} style={{ cursor: "pointer", width: 40, flex: "0 0 auto", display: "grid", placeItems: "center", background: "transparent", border: "none", borderRight: "1px solid var(--line-1)", color: "var(--text-subtle)", fontSize: 16, lineHeight: 1 }}>−</button>
        <input value={displayValue == null ? "" : displayValue} onChange={(e) => onDisplayChange(e.target.value)} inputMode="decimal"
          style={{ flex: 1, minWidth: 0, textAlign: "right", padding: "11px 12px", background: "transparent", border: "none", outline: "none", font: "var(--weight-medium) var(--text-sm)/1 var(--font-mono)", color: "var(--ink-1)" }} />
        <span style={{ display: "flex", alignItems: "center", paddingRight: 12, font: "var(--weight-medium) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)" }}>{quoteSymbol}</span>
        <button type="button" onClick={() => stepBy(1)} aria-label={`Increase ${label}`} style={{ cursor: "pointer", width: 40, flex: "0 0 auto", display: "grid", placeItems: "center", background: "transparent", border: "none", borderLeft: "1px solid var(--line-1)", color: "var(--text-subtle)", fontSize: 16, lineHeight: 1 }}>+</button>
      </div>
      <span style={{ font: "var(--weight-medium) var(--text-xs)/1 var(--font-mono)", color: !valid ? "var(--loss)" : pct >= 0 ? "var(--profit, #4ade80)" : "var(--loss)" }}>{valid ? (num !== null && currentPrice ? pctStr : "") : "Enter a positive price"}</span>
    </div>
  );
}

function parsePrice(value) {
  const num = parseFloat(String(value).replace(/,/g, ""));
  return Number.isFinite(num) && num > 0 ? num : null;
}

function ModeRow({ m, values, set, exp, setExp }) {
  const on = m.locked ? true : !!values[m.key];
  const isExp = exp === m.key;
  return (
    <div style={{ borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", border: "1px solid var(--line-1)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px" }}>
        <span style={{ flex: "0 0 auto", pointerEvents: m.locked ? "none" : "auto", opacity: m.locked ? 0.7 : 1 }}>
          {/* Ticking a mode opens its settings right away (and unticking folds
              them), so Take profit / Stop loss never need the "+" to show
              their percentage. The "+" still toggles the panel on its own. */}
          <Checkbox checked={on} onChange={(v) => { if (m.locked) return; set(m.key, v); setExp(v ? m.key : (isExp ? null : exp)); }} />
        </span>
        <span style={{ font: "var(--weight-medium) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)", flex: "0 0 auto" }}>{m.code}</span>
        <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)", flex: 1 }}>{m.label}</span>
        <button type="button" onClick={() => setExp(isExp ? null : m.key)} aria-label="Expand"
          style={{ cursor: "pointer", width: 26, height: 26, borderRadius: 6, border: "1px solid var(--line-1)", background: "transparent", display: "grid", placeItems: "center", color: "var(--text-subtle)", fontSize: 15, lineHeight: 1, transform: isExp ? "rotate(45deg)" : "none", transition: "transform 120ms", flex: "0 0 auto" }}>+</button>
      </div>
      {isExp ? (
        <div style={{ padding: "0 14px 14px", display: "grid", gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
            {(typeof m.fields === "function" ? m.fields(values) : m.fields).map((f) => (
              <Field key={f.k} f={f} value={values[f.k]} onChange={(v) => set(f.k, v)} values={values} set={set} />
            ))}
          </div>
          {/* NEAR: the rotation re-centres on the price (the "Both ways"
              explainer); there is no swapless mode. */}
          {m.key === "rebalanceOn" ? <RangeExplainer compact /> : null}
          {m.key === "compoundOn" ? <CompoundExplainer compact /> : null}
        </div>
      ) : null}
    </div>
  );
}

function ModeRows({ values, set, modes }) {
  const [exp, setExp] = React.useState("rebalanceOn");
  const main = modes.filter((m) => m.key === "rebalanceOn" || m.key === "compoundOn");
  const pair = modes.filter((m) => m.key === "tpOn" || m.key === "slOn");
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {main.map((m) => <ModeRow key={m.key} m={m} values={values} set={set} exp={exp} setExp={setExp} />)}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {pair.map((m) => <ModeRow key={m.key} m={m} values={values} set={set} exp={exp} setExp={setExp} />)}
      </div>
    </div>
  );
}

function Field({ f, value, onChange, values, set, preset }) {
  if (f.type === "hidden") return null;
  if (f.type === "numToggle") {
    const on = !!values[f.on];
    return (
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 8 }}>
        <Checkbox checked={on} onChange={(v) => set(f.on, v)}>{f.label}</Checkbox>
        {!on && f.offNote ? (
          <div style={{ display: "flex", alignItems: "center", minHeight: 42, padding: "0 12px", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", border: "1px solid var(--line-1)", font: "var(--weight-regular) var(--text-xs)/1.3 var(--font-sans)", color: "var(--text-subtle)" }}>{f.offNote}</div>
        ) : (
          <div style={{ opacity: on ? 1 : 0.4, pointerEvents: on ? "auto" : "none" }}>
            {/* NEAR: `noClamp` with a floor, as the LP steppers (audit M-1), so a typed value is never rewritten on blur. */}
            <NumStepper value={value} onChange={onChange} step={f.step || 1} min={f.min} max={f.max} suffix={f.suffix} noClamp={f.floor != null} />
          </div>
        )}
        {on && f.hint ? <span className="fl-field__hint">{f.hint}</span> : null}
      </div>
    );
  }
  if (f.type === "stepper") {
    const label = f.label;
    const suffix = f.suffix;
    const min = f.min;
    const step = f.step;
    const typed = value === "" || value == null ? null : parseFloat(String(value).replace(/,/gu, ""));
    const below = f.floor != null && typed != null && typed < f.min;
    return (
      <div className="fl-field">
        <label className="fl-field__label">{label}{typeof f.tooltip === "string" ? <span aria-label={f.tooltip} title={f.tooltip} tabIndex={0} style={{ display: "inline-grid", placeItems: "center", width: 13, height: 13, marginLeft: 6, border: "1px solid var(--line-1)", borderRadius: "50%", color: "var(--text-subtle)", cursor: "help", font: "var(--weight-medium) 9px/1 var(--font-mono)" }}>i</span> : null}</label>
        <NumStepper value={value} onChange={onChange} step={step || 1} min={min} max={f.max} prefix={f.prefix} suffix={suffix} noClamp={f.floor != null} preciseStep={f.preciseStep} disabled={f.locked || (f.lockedByPreset && f.lockedByPreset.includes(preset))} />
        {below ? <span role="alert" style={{ font: "var(--weight-regular) var(--text-xs)/var(--leading-normal) var(--font-sans)", color: "var(--loss)" }}>Minimum {f.floor} {suffix ?? ""}</span>
          : f.hint ? <span className="fl-field__hint">{f.hint}</span> : null}
      </div>
    );
  }
  if (f.type === "pool") return <PoolPicker selected={f.pool} />;
  if (f.type === "modeRows") return <ModeRows values={values} set={set} modes={f.modes} />;
  if (f.type === "check") return <Checkbox checked={!!value} locked={!!f.disabled} title={f.tooltip} onChange={onChange}>{f.text}</Checkbox>;
  if (f.type === "select") {
    const options = f.options;
    return <Select label={f.label} value={value} options={options} hint={f.hint} disabled={!!f.disabled} onChange={(e) => onChange(e.target.value)} />;
  }
  const locked = f.lockedByPreset && f.lockedByPreset.includes(preset);
  return (
    <div style={locked ? { opacity: 0.45, pointerEvents: "none" } : undefined}>
      <Input label={f.label} mono={f.type !== "text"} value={value} prefix={f.prefix} suffix={f.suffix} hint={f.hint} disabled={locked} style={f.type !== "text" ? { textAlign: "right" } : undefined} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function Group(props) {
  const { section, values, set, preset, children } = props;
  return (
    <div style={{ display: "grid", gap: 14 }}>
      {section.title ? <span className="fl-eyebrow">{section.title}{section.titleSuffix ? <span style={{ letterSpacing: "0.9px" }}> {section.titleSuffix}</span> : null}</span> : null}
      {section.note ? <p style={{ font: "var(--weight-regular) var(--text-sm)/var(--leading-normal) var(--font-sans)", color: "var(--text-subtle)", marginTop: -6 }}>{section.note}</p> : null}
      <div className={section.cols ? "fl-deploy-cols" : undefined} style={{ display: "grid", gridTemplateColumns: section.cols ? `repeat(${section.cols}, minmax(0, 1fr))` : "repeat(auto-fit, minmax(190px, 1fr))", gap: 16, alignItems: "start" }}>
      {section.fields.filter((f) => !"check codeToggle radioCheck pool textarea skillFile liquidityChart priceRangeGroup scheduleGroup navGuard endRule modeRows tradfiModes weights".split(" ").includes(f.type)).map((f) => (
          <Field key={f.k} f={f} value={values[f.k]} onChange={(v) => set(f.k, v)} values={values} set={set} preset={preset} />
        ))}
      </div>
      {section.fields.filter((f) => f.type === "pool" || f.type === "modeRows").map((f) => (
        <Field key={f.k} f={f} value={values[f.k]} onChange={(v) => set(f.k, v)} values={values} set={set} preset={preset} />
      ))}
      {/* NEAR: the price range is passed as children (PriceRangeBox pair). */}
      {children}
      {section.fields.filter((f) => f.type === "check").map((f, i) => (
        <Field key={f.k + i} f={f} value={values[f.k]} onChange={(v) => set(f.k, v)} values={values} set={set} preset={preset} />
      ))}
    </div>
  );
}

export { Group, PriceRangeBox, parsePrice };
