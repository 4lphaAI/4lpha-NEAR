"use client";
import React from "react";
import { Icon } from "@/design-system";
import { useNearSession } from "@/lib/near-session";
import { exactNear, fundingLine } from "@/lib/near-format";
import { HIRE_CANCEL_STATES, hireRunSteps } from "@/lib/hire-run";
import { DEPLOY_TABS } from "./deploy-tabs";
import { DEPLOYED_HOLD_MS, HireRunModal, outlineBtn, solidBtn } from "./HireRunModal";
import { truncateAddress } from "./NearAccountScreen";

/* Spec UI step 3, sections 3 to 5: the hire popup driven by the session. Each button calls an existing session
   action (or the new fund and resetTransfer); every action is offered only when hireRunSteps allows it. */

const TEXT: React.CSSProperties = { margin: 0, font: "var(--weight-regular) var(--text-sm)/var(--leading-normal) var(--font-sans)", color: "var(--text-muted)", overflowWrap: "anywhere" };
const SMALL: React.CSSProperties = { margin: 0, font: "var(--weight-regular) var(--text-xs)/1.4 var(--font-sans)", color: "var(--text-subtle)", overflowWrap: "anywhere" };
const MONO: React.CSSProperties = { display: "block", padding: "10px 12px", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", border: "1px solid var(--line-1)", font: "var(--type-mono-xs)", color: "var(--ink-1)", overflowWrap: "anywhere" };
const PANEL: React.CSSProperties = { display: "grid", gap: 10 };
const RESET_AFTER_MS = 120_000;

export const TRANSFER_STOPPED_WARNING = "A funding transfer may still arrive. If NEAR reaches this agent after the hire stopped, recover it with the saved management link.";

function useCopy() {
  const [failed, setFailed] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const copy = (text: string) => {
    setFailed(false); setCopied(false);
    try {
      void navigator.clipboard.writeText(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 2000); }, () => setFailed(true));
    } catch { setFailed(true); }
  };
  return { copy, failed, copied };
}

/** The management link with its key hidden: everything after "key=" (or the whole link) becomes dots. */
export function maskLink(link: string): string {
  return /key=/.test(link) ? link.replace(/(key=).*/, (_m, k: string) => k + '\u2022'.repeat(24)) : '\u2022'.repeat(32);
}

const TOAST: React.CSSProperties = { position: "fixed", left: "50%", bottom: 28, transform: "translateX(-50%)", zIndex: 60, padding: "8px 14px", borderRadius: 999,
  background: "var(--surface-card)", border: "1px solid var(--profit)", color: "var(--profit)", font: "var(--weight-medium) var(--text-xs)/1 var(--font-sans)", boxShadow: "0 8px 24px rgba(0,0,0,0.4)" };

export function NearHireRun({ jobId, go, onClose, ownMount }: {
  readonly jobId: string;
  readonly go: (route: string) => void;
  readonly onClose: () => void;
  /** The deploy page owns the job mount; the job page already mounts the job and passes false. */
  readonly ownMount: boolean;
}) {
  const actions = useNearSession();
  const { account, jobs, busy, message } = actions.state;
  const { mountJob } = actions;
  React.useEffect(() => (ownMount ? mountJob(jobId) : undefined), [ownMount, mountJob, jobId, account]);
  const [ack, setAck] = React.useState(false);
  const [showLink, setShowLink] = React.useState(false);
  const linkCopy = useCopy(), accountCopy = useCopy();
  const job = jobs.find(j => j.id === jobId && j.owner === account) ?? null;
  const transfer = actions.transfer(jobId);
  const link = actions.link(jobId);
  const saved = actions.isSaved(jobId);
  const run = job ? hireRunSteps(job, { policySent: actions.sentPolicy.has(jobId), linkShown: link !== undefined, saved, transfer }) : null;
  const deployed = run?.deployed === true;
  React.useEffect(() => {
    if (!deployed) return;
    const timer = window.setTimeout(() => go("/account/" + jobId), DEPLOYED_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [deployed, go, jobId]);
  if (!job || !run) return null;

  const tab = DEPLOY_TABS.find(t => t.id === (job.kind === "lp" ? "lp" : job.trade ? "trade" : "grid"))!;
  const phase = run.deployed ? "deployed" : run.stopped ? "stopped" : "running";
  const canCancel = phase === "running" && !job.canStopEarly && HIRE_CANCEL_STATES.includes(job.state) && transfer === null;
  const openAgent = () => go("/account/" + jobId);
  const confirmBtn = (label: string, onClick: () => void, disabled = false) =>
    <button type="button" style={{ ...solidBtn(tab.color), ...(busy || disabled ? { cursor: "wait", opacity: 0.6 } : {}) }} disabled={busy || disabled} onClick={onClick}>{label}</button>;
  const age = transfer ? Date.now() - transfer.at : 0;

  let panel: React.ReactNode = null;
  if (phase === "running") {
    if (run.action === "sign-policy") panel = <div style={PANEL}>
      {confirmBtn("Confirm in your wallet", () => void actions.storePolicy(job))}
    </div>;
    else if (run.action === "reveal") panel = <div style={PANEL}>
      <p style={TEXT}>Sign once in your wallet to reveal the management link. Keep it private.</p>
      {confirmBtn("Reveal the link", () => void actions.reveal(job))}
    </div>;
    else if (run.action === "confirm-link" && link !== undefined) panel = <div style={PANEL}>
      <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
        <code style={{ ...MONO, flex: 1 }}>{showLink ? link : maskLink(link)}</code>
        <button type="button" aria-label={showLink ? "Hide link" : "Show link"} title={showLink ? "Hide link" : "Show link"} onClick={() => setShowLink(!showLink)}
          style={{ cursor: "pointer", flex: "0 0 auto", width: 40, display: "grid", placeItems: "center", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", border: "1px solid var(--line-1)", color: showLink ? tab.color : "var(--text-subtle)" }}>
          <Icon name="eye" size={16} />
        </button>
      </div>
      <div style={{ display: "flex", gap: 10 }}><button type="button" style={outlineBtn(tab.color)} onClick={() => linkCopy.copy(link)}>{linkCopy.copied ? "Copied" : "Copy"}</button></div>
      {linkCopy.copied ? <span role="status" className="fl-dp-anim fl-dp-in" style={TOAST}>Link copied</span> : null}
      {linkCopy.failed ? <p style={{ ...SMALL, color: "var(--loss)" }}>Copy failed. Select the link and copy it by hand.</p> : null}
      <p style={SMALL}>Save this link privately. It grants access to the wallet.</p>
      <label style={{ display: "flex", gap: 8, alignItems: "center", ...TEXT }}><input type="checkbox" checked={saved} onChange={event => actions.setSaved(job.id, event.target.checked)} /> I saved the management link</label>
      {confirmBtn("Confirm", () => void actions.confirmLink(job), !saved || !job.linkDelivered)}
    </div>;
    else if (run.action === "register-dcl") panel = <div style={PANEL}>
      {confirmBtn("Confirm in your wallet", () => void actions.registerDcl(job))}
    </div>;
    else if (run.action === "fund" && job.agentAccount) panel = <div style={PANEL}>
      <p style={TEXT}>From your wallet {truncateAddress(job.owner)} to agent wallet {truncateAddress(job.agentAccount)}.</p>
      <code style={{ ...MONO, font: "var(--weight-medium) var(--text-md)/1.2 var(--font-mono)" }}>{exactNear(BigInt(job.depositYocto) - BigInt(job.agentBalance ?? "0"))}</code>
      <p style={SMALL}>This is the declared deposit. It is not editable here.</p>
      {confirmBtn("Confirm in your wallet", () => void actions.fund(job))}
      <p style={SMALL}>Or send it by hand: {fundingLine(job)}</p>
      <div style={{ display: "flex", gap: 10 }}><button type="button" style={outlineBtn("var(--line-1)")} onClick={() => accountCopy.copy(job.agentAccount!)}>{accountCopy.copied ? "Copied" : "Copy agent wallet address"}</button></div>
      {accountCopy.failed ? <p style={{ ...SMALL, color: "var(--loss)" }}>Copy failed. Select the address and copy it by hand.</p> : null}
    </div>;
    else if (run.action === "expired") panel = <p style={{ ...TEXT, color: "var(--warning)" }}>{run.waitText}</p>;
    else if (run.action === "wait" && run.waitText) panel = <p style={SMALL}>{run.waitText}</p>;
    if (transfer && run.action === "wait" && run.steps.some(s => s.key === "fund" && s.state === "active")) panel = <div style={PANEL}>
      <p style={SMALL}>{run.waitText}</p>
      {age >= RESET_AFTER_MS && !busy ? <>
        <label style={{ display: "flex", gap: 8, alignItems: "flex-start", ...SMALL }}><input type="checkbox" checked={ack} onChange={event => setAck(event.target.checked)} /> My wallet activity shows no transfer to this agent, and no wallet prompt is still open.</label>
        <div style={{ display: "flex", gap: 10 }}><button type="button" style={{ ...outlineBtn(tab.color), ...(!ack ? { opacity: 0.6 } : {}) }} disabled={!ack} onClick={() => void actions.resetTransfer(job, ack)}>I did not send it</button></div>
      </> : null}
    </div>;
  }
  if (phase === "stopped" && transfer) panel = <p style={{ ...TEXT, color: "var(--warning)" }}>{TRANSFER_STOPPED_WARNING}</p>;

  return <HireRunModal label={tab.label} color={tab.color} agentId={job.id} steps={run.steps} phase={phase}
    onCancel={canCancel ? () => void actions.cancel(job) : null} cancelDisabled={busy} onClose={onClose} onOpenAgent={openAgent}>
    {panel}
    {message ? <p role="status" style={{ ...SMALL, color: "var(--text-muted)" }}>{message}</p> : null}
  </HireRunModal>;
}
