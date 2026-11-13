"use client";
import React from "react";
import { Button, DenseRow, DenseRowHeader, EmptyState, Icon, IconButton, MetricTile, SegmentedToggle, Skeleton } from "@/design-system";
import { AGENTS } from "@/lib/design-data";
import type { AccountPortfolio } from "@/lib/exec/types";
import { displayablePnlUsdMicros } from "@/lib/exec/account-view";
import { useNearSession } from "@/lib/near-session";
import { catalogId, catalogName, listedJob, rowPresentation, toPortfolio, tradeNearTotal } from "@/lib/near-map";
import { fmt, type Job } from "@/lib/near-format";
import { api } from "@/lib/near-wallet";
import type { MemeView } from "./NearMemeScreen";
import { NearDemoAgents } from "./NearDemoAgents";

type Props = { readonly go: (route: string) => void };
const ENDED_LABEL: Readonly<Record<string, string>> = { retired: "Retired", stopped: "Stopped", cancelled: "Cancelled", failed: "Failed" };
type Unit = "USD" | "NEAR";
type Wallet = AccountPortfolio["wallets"][number];

function micros(value: string | null): number | null {
  if (value === null || !/^-?\d+$/u.test(value)) return null;
  const number = Number(value) / 1_000_000;
  return Number.isFinite(number) ? number : null;
}

function money(value: number | null, unit: Unit, bnbUsd: number | null, signed = false): string {
  if (value === null || (unit === "NEAR" && (!bnbUsd || bnbUsd <= 0))) return "-";
  const shown = unit === "USD" ? value : value / bnbUsd!;
  const sign = shown < 0 ? "-" : signed && shown > 0 ? "+" : "";
  const amount = Math.abs(shown);
  return unit === "USD"
    ? `${sign}$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `${sign}${amount.toFixed(4)} NEAR`;
}

/** Trade V1: a trade row shows its NEAR total from the wallet snapshot, or "-" when part of it is unread (no USD figure). */
export function tradeRowValue(job: Job): string {
  const total = tradeNearTotal(job);
  return total === null ? "-" : fmt(total);
}

export function truncateAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function PortfolioPanel({ portfolio, wallet, wallets, index, setIndex, connectedAddress, ownerAddress, unit, setUnit, refresh, loading }: {
  readonly portfolio: AccountPortfolio;
  readonly wallet: Wallet | null;
  readonly wallets: readonly Wallet[];
  readonly index: number;
  readonly setIndex: (index: number) => void;
  readonly connectedAddress?: string;
  /** The passkey identity the portfolio is scoped to. Identity only, never payable. */
  readonly ownerAddress?: string;
  readonly unit: Unit;
  readonly setUnit: (unit: Unit) => void;
  readonly refresh: () => void;
  readonly loading: boolean;
}) {
  const available = micros(wallet ? wallet.availableUsdMicros : portfolio.totals.walletUsdMicros);
  const deployed = micros(wallet ? wallet.deployedUsdMicros : portfolio.totals.deployedUsdMicros);
  const total = available === null || deployed === null ? null : available + deployed;
  const ownerTotal = micros(portfolio.totals.totalUsdMicros);
  const ownerWallet = micros(portfolio.totals.walletUsdMicros);
  const ownerDeployed = micros(portfolio.totals.deployedUsdMicros);
  const pnl = micros(portfolio.totals.grossLpPnlUsdMicros);
  const bnbUsd = micros(portfolio.assets.find((asset) => asset.kind === "native" && asset.priceUsdMicros !== null)?.priceUsdMicros ?? null);
  const allocation = ownerWallet !== null && ownerDeployed !== null && ownerTotal !== null && ownerWallet >= 0 && ownerDeployed >= 0 && ownerTotal > 0 && ownerDeployed <= ownerTotal
    ? Math.floor(ownerDeployed * 10_000 / ownerTotal) / 100
    : null;
  const pnlPercent = portfolio.totals.grossLpPnlBps === null ? null : Number(portfolio.totals.grossLpPnlBps) / 100;
  const active = portfolio.agents.filter((agent) => agent.status === "armed").length;
  // Funding and withdrawal happen on each agent's page: each NEAR agent has its own policy-bound wallet.
  return <section className="fl-portfolio" style={{ border: "1px solid var(--line-1)", borderRadius: "var(--radius-lg)", background: "var(--raised)", overflow: "hidden", marginBottom: 20 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid var(--line-1)", flexWrap: "wrap" }}>
      <Icon name="wallet" size={16} />
      <div style={{ display: "flex", flexDirection: "column", gap: 5, marginRight: "auto", minWidth: 0 }}>
        <h2 style={{ font: "var(--weight-semibold) var(--text-lg)/1 var(--font-sans)", color: "var(--ink-1)" }}>Agent portfolio</h2>
        <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, font: "var(--type-mono-xs)", color: "var(--text-muted)" }}>
          {wallet === null
            ? <span>No agent wallet yet</span>
            : <>
              <a href={`https://nearblocks.io/address/${encodeURIComponent(wallet.address)}`} target="_blank" rel="noopener noreferrer" title={`Open ${wallet.address} on NearBlocks`} style={{ color: "inherit", textDecoration: "underline", textUnderlineOffset: 3 }}>{truncateAddress(wallet.address)}</a>
              <IconButton label="Copy agent wallet address" onClick={() => { void navigator.clipboard?.writeText(wallet.address); }}><Icon name="copy" size={13} /></IconButton>
            </>}
          {wallets.length > 1 && <select aria-label="Agent wallet" value={String(index)} onChange={event => setIndex(Number(event.target.value))}
            style={{ font: "var(--type-mono-xs)", color: "var(--ink-1)", background: "var(--surface-card)", border: "1px solid var(--line-1)", borderRadius: "var(--radius-sm)", padding: "2px 6px", marginLeft: 4 }}>
            {wallets.map((entry, position) => <option key={entry.address} value={String(position)}>{truncateAddress(entry.address)}</option>)}
          </select>}
        </span>
        {/* WHOSE account this is, and what funds it — because the passkey is the
            identity and the connected wallet is only a funding source, so
            disconnecting or switching wallets does NOT change the portfolio.
            Without this line that behaviour reads as a bug, and the Withdraw
            destination prefills from a wallet the screen never named. */}
        <span style={{ font: "var(--type-mono-xs)", color: "var(--text-subtle)" }}>
          {ownerAddress === undefined ? "Not signed in" : `Signed in as ${truncateAddress(ownerAddress)}`}
          {" · "}
          {connectedAddress === undefined ? "no wallet connected" : `funds from ${truncateAddress(connectedAddress)}`}
        </span>
      </div>
      <SegmentedToggle options={[{ value: "USD", label: "USD" }, { value: "NEAR", label: "NEAR" }]} value={unit} onChange={(value: string) => setUnit(value as Unit)} />
      <IconButton label="Refresh balances" onClick={refresh} disabled={loading}><Icon name="activity" size={15} /></IconButton>
    </div>
    <div className="fl-account-metrics-scroll">
      <div className="fl-account-metrics">
        <MetricTile size="sm" label="Total" value={money(total, unit, bnbUsd)} note="Available plus deployed." />
        <MetricTile size="sm" label="Available" value={money(available, unit, bnbUsd)} note="Liquid in the agent wallet." />
        <MetricTile size="sm" label="Deployed" value={money(deployed, unit, bnbUsd)} note={portfolio.coverage.total.state !== "complete" || allocation === null ? "Allocation unavailable" : `${allocation.toFixed(2)}% allocated`} />
        <MetricTile size="sm" label="PNL" value={money(pnl, unit, bnbUsd, true)} tone={pnl !== null && pnl > 0 ? "profit" : pnl !== null && pnl < 0 ? "loss" : "flat"} note={pnlPercent === null ? "No eligible LP basis" : `${pnlPercent >= 0 ? "+" : ""}${pnlPercent.toFixed(2)}%`} />
        <MetricTile size="sm" label="Active agents" value={String(active)} note="Live now" />
      </div>
    </div>
  </section>;
}

/**
 * The loading state, drawn as the CARD that is coming.
 *
 * It used to be an `EmptyState` reading "Loading portfolio" — a blank panel of
 * a different height, so the whole screen jumped the moment data arrived. This
 * is the same frame, the same header row, the same three-tile grid and the same
 * stats/rows blocks as {@link PortfolioPanel}, with the design system's own
 * `Skeleton` primitives standing in for the values. It invents no copy: the
 * only literal text is the tile and column LABELS, which are fixed and are the
 * same words the loaded card shows.
 *
 */
function PortfolioSkeleton() {
  return <div aria-busy="true" aria-live="polite">
    <section className="fl-portfolio" style={{ border: "1px solid var(--line-1)", borderRadius: "var(--radius-lg)", background: "var(--raised)", overflow: "hidden", marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid var(--line-1)", flexWrap: "wrap" }}>
        <Icon name="wallet" size={16} />
        <div style={{ display: "flex", flexDirection: "column", gap: 5, marginRight: "auto", minWidth: 0 }}>
          <h2 style={{ font: "var(--weight-semibold) var(--text-lg)/1 var(--font-sans)", color: "var(--ink-1)" }}>Agent portfolio</h2>
          <Skeleton w={132} h={11} />
        </div>
        <Skeleton w={96} h={30} radius="var(--radius-sm)" />
        <Skeleton w={84} h={30} radius="var(--radius-sm)" />
        <Skeleton w={92} h={30} radius="var(--radius-sm)" />
      </div>
      <div className="fl-account-metrics-scroll">
        <div className="fl-account-metrics">
          {["Total", "Available", "Deployed", "PNL", "Active agents"].map((label) => <div className="fl-metric fl-metric--sm" key={label}>
            <span className="fl-metric__label">{label}</span>
            <Skeleton w="70%" h={22} />
            <Skeleton w="55%" h={10} />
          </div>)}
        </div>
      </div>
    </section>
    <div className="fl-rows">
      <DenseRowHeader columns={["Agent", "Value", ""]} />
      {[0, 1, 2].map((row) => <div key={row} style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", borderBottom: "1px solid var(--line-1)" }}>
        <Skeleton w={32} h={32} radius="var(--radius-sm)" />
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginRight: "auto", minWidth: 0, flex: 1 }}>
          <Skeleton w="34%" h={13} />
          <Skeleton w="52%" h={10} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
          <Skeleton w={84} h={13} />
          <Skeleton w={112} h={10} />
        </div>
      </div>)}
    </div>
  </div>;
}
function localWalletRow(address: string): Wallet {
  return { address, custodyModel: "passkey", depositable: true, source: "declared", availableUsdMicros: null, deployedUsdMicros: "0", deployedReason: "declared", passkeyVerified: "unreadable" };
}

/**
 * `passkeyVerified` is DELIBERATELY not rendered.
 *
 * `"not-registered"` is the ordinary state of a funded passkey wallet whose
 * first admin action has not landed, and `"unreadable"` is an RPC hiccup —
 * neither is news, and rendering them made the normal case look like a fault.
 * The field still rides the DTO and the plane still refuses the one verdict it
 * can PROVE is an impostor (`"no-matching-key"`, 400) before this screen ever
 * sees the payload.
 *
 * ---
 *
 * Every wallet the screen can act on, agent wallet B first.
 *
 * B is what the user deposits into and withdraws from, so it leads regardless
 * of how the plane happened to order its entries.
 */
export function accountWallets(portfolio: AccountPortfolio, passkeyWallet: string | undefined): readonly Wallet[] {
  const known = [...portfolio.wallets];
  if (passkeyWallet !== undefined && !known.some((entry) => entry.address.toLowerCase() === passkeyWallet.toLowerCase())) {
    known.unshift(localWalletRow(passkeyWallet.toLowerCase()));
  }
  return passkeyWallet === undefined
    ? known
    : [...known].sort((a, b) => Number(b.address.toLowerCase() === passkeyWallet.toLowerCase()) - Number(a.address.toLowerCase() === passkeyWallet.toLowerCase()));
}

const CARD = { border: "1px solid var(--line-1)", borderRadius: "var(--radius-lg)", background: "var(--raised)", padding: 16, marginBottom: 20, display: "grid", gap: 12 } as const;
const SUBTLE = { font: "var(--type-body-sm)", color: "var(--text-subtle)" } as const;

export function AccountScreenContent(props: {
  readonly jobs: ReadonlyMap<string, Job>;
  readonly isConnected: boolean;
  readonly portfolio: AccountPortfolio | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly needsSignature: boolean;
  readonly narrow: boolean;
  readonly unit: Unit;
  readonly setUnit: (unit: Unit) => void;
  readonly refresh: () => void;
  readonly authorize: () => void;
  readonly go: (route: string) => void;
  readonly connectedAddress?: string;
  readonly ownerAddress?: string;
  /** Live agent wallets outside the USD portfolio (trade jobs), added to the wallet picker. */
  readonly extraWallets?: readonly string[];
  /** Shown above the agent list (the Live / Retired switch). */
  readonly listHeader?: React.ReactNode;
  /** When set, shown in place of the live agent list (the Retired tab). */
  readonly altList?: React.ReactNode;
  readonly children?: React.ReactNode;
}) {
  // Owner effects run after paint; never paint the prior account during that gap.
  if (props.portfolio && props.ownerAddress && props.portfolio.ownerAddress.toLowerCase() !== props.ownerAddress.toLowerCase()) {
    props = { ...props, portfolio: null };
  }
  const allRows = props.portfolio?.agents ?? [];
  // Incomplete hires need recovery actions without being counted as live agents.
  const [cancelledHires, setCancelledHires] = React.useState<ReadonlySet<string>>(() => new Set());
  const recoveryOwner = props.portfolio?.ownerAddress.toLowerCase() ?? "";
  const hideCancelledHire = React.useCallback((agentId: string) => {
    const key = recoveryOwner + ":" + agentId;
    setCancelledHires(previous => previous.has(key) ? previous : new Set([...previous, key]));
  }, [recoveryOwner]);
  const pendingRows = allRows.filter((row) => row.status === "provisioning" && !cancelledHires.has(recoveryOwner + ":" + row.id));
  const rows = allRows.filter((row) => row.status !== "provisioning");
  const [index, setIndex] = React.useState(0);
  // A passkey owner needs no wallet connection: the credential IS the identity.
  const hasOwner = props.isConnected;
  // Every live agent wallet is selectable. Trade wallets carry no USD figure (Trade V1 13.1), so they join as rows without values.
  const valued = props.portfolio === null ? [] : accountWallets(props.portfolio, undefined);
  const wallets = [...valued, ...(props.extraWallets ?? []).filter(address => !valued.some(entry => entry.address === address)).map(localWalletRow)];
  const wallet = wallets.length === 0 ? null : wallets[Math.min(index, wallets.length - 1)]!;
  const nearUsd = micros(props.portfolio?.assets.find(asset => asset.priceUsdMicros !== null)?.priceUsdMicros ?? null);
  return <div className="fl-shell fl-account-page">
    <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 24, marginBottom: 20, flexWrap: "wrap" }}><div style={{ display: "flex", flexDirection: "column", gap: 8 }}><h1 style={{ font: "var(--type-page-title)" }}>Account</h1><p style={{ font: "var(--type-body-md)", color: "var(--text-muted)" }}>Your NEAR agents, their wallets and where the funds sit.</p></div></div>
    {!hasOwner ? <EmptyState icon="wallet" title="Connect your owner wallet" action={<Button variant="primary" onClick={props.authorize}>Connect wallet</Button>}>Connect the NEAR account that owns your agents.</EmptyState>
      : props.needsSignature && !props.portfolio ? <EmptyState icon="wallet" title="Authorize Account access" action={<Button variant="primary" onClick={props.authorize} disabled={props.loading}>{props.loading ? "Authorizing…" : "Sign once to load portfolio"}</Button>}>Sign in once for this browser session, up to 24 hours. It cannot trade, pause, or revoke agents.</EmptyState>
      : props.error && !props.portfolio ? <EmptyState icon="wallet" title="Portfolio unavailable" action={<Button variant="secondary" onClick={props.refresh}>Try again</Button>}>{props.error}</EmptyState>
      : props.portfolio ? <>
        <PortfolioPanel portfolio={props.portfolio} wallet={wallet} wallets={wallets} index={Math.min(index, Math.max(wallets.length - 1, 0))} setIndex={setIndex}
          {...(props.connectedAddress ? { connectedAddress: props.connectedAddress } : {})}
          {...(props.ownerAddress ? { ownerAddress: props.ownerAddress } : {})}
          unit={props.unit} setUnit={props.setUnit} refresh={props.refresh} loading={props.loading} />
        {props.portfolio.coverage.total.state !== "complete" && props.portfolio.coverage.total.state !== "empty" && <p style={{ color: "var(--warning)", marginBottom: 14 }}>Some values are incomplete: an agent could not be read or holds assets outside its job.</p>}
        {pendingRows.length > 0 && <section aria-label="Incomplete agent setups" style={{ ...CARD, marginBottom: 20 }}>
          <h2 style={{ font: "var(--type-body-md)" }}>Setup incomplete</h2>
          {pendingRows.map((row) => {
            const trade = row.httpRuntimeProfile === "trade-v1";
            const lp = row.httpRuntimeProfile === "lp-v1";
            return <div key={row.id} style={{ display: "grid", gap: 8 }}>
              <strong>{catalogName(props.jobs.get(row.id)!)} · {row.id.slice(0, 8)}</strong>
              <Button variant="secondary" onClick={() => props.go("/account/" + row.id)}>Continue setup</Button>
            </div>;
          })}
        </section>}
        {props.listHeader}
        {props.altList ? props.altList : rows.length === 0 && pendingRows.length > 0 ? null : rows.length === 0 ? <EmptyState icon="wallet" title={allRows.length === 0 ? "No agents found" : "No agents in service"} action={<Button variant="primary" onClick={() => props.go("/")}>Browse the marketplace</Button>}>{allRows.length === 0 ? "No owner-controlled agents are recorded for this wallet." : "No live or paused agents are currently in service."}</EmptyState> : <div className="fl-rows"><DenseRowHeader columns={["Agent", "Value", ""]} />
          {rows.map((row) => { const job = props.jobs.get(row.id)!; const design = AGENTS.find((agent) => agent.id === catalogId(job)); const presentation = rowPresentation(job); const expiredSession = row.session?.expiresAt !== null && row.session?.expiresAt !== undefined && Math.floor(Date.now() / 1_000) >= row.session.expiresAt; const attention = row.attention === "gas-blocked" || row.attention === "gas-low"; const renewalKind = row.httpRuntimeProfile === "trade-v1" ? "trade" : design?.categoryId === "grid" ? "grid" : "lp"; return <div key={row.id} role="button" tabIndex={0} style={{ cursor: "pointer" }} title={`Open ${row.id}`} onClick={() => props.go(`/account/${row.id}`)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); props.go(`/account/${row.id}`); } }}><DenseRow name={catalogName(job) + " · " + job.id.slice(0, 8)} categoryId={design?.categoryId ?? "defi"} status={presentation.status} statusLabel={presentation.statusLabel} statusLine={presentation.statusLine} value={job.trade ? tradeRowValue(job) : money(micros(row.holdings.valueUsdMicros), props.unit, nearUsd)} valueSub={job.trade ? "agent wallet, in NEAR" : "agent wallet and orders"} /></div>; })}
        </div>}
      </> : <PortfolioSkeleton />}
    {props.children}
  </div>;
}

export function NearAccountScreen({ go }: Props) {
  const [unit, setUnit] = React.useState<Unit>("USD");
  const actions = useNearSession();
  const { account, lastPollMs, message, busy } = actions.state;
  // Retire spec 3: no job is hidden. The main list keeps its rule; every other job is listed under "Retired agents".
  const jobs = actions.state.jobs.filter(listedJob);
  const retired = actions.state.jobs.filter(job => !listedJob(job));
  const [tab, setTab] = React.useState<"live" | "retired">("live");
  const [paper, setPaper] = React.useState<{ owner: string; agents: MemeView['agent'][] } | null>(null);
  const [paperError, setPaperError] = React.useState('');
  React.useEffect(() => {
    let active = true, loading = false, unavailable = false;
    setPaper(null); setPaperError('');
    const refresh = async () => {
      if (!active || !account || unavailable || document.visibilityState !== 'visible' || loading) return;
      loading = true;
      try {
        const agents = await api<MemeView['agent'][]>('/api/meme');
        if (active) { setPaper({ owner: account, agents }); setPaperError(''); }
      } catch (error) {
        if (!active) return;
        if (error instanceof Error && error.message === 'Not found.') {
          unavailable = true; setPaper(null); setPaperError('');
          window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh);
        } else setPaperError('Paper agents are unavailable on this server or your session has expired.');
      }
      finally { loading = false; }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 15000);
    document.addEventListener('visibilitychange', refresh);
    return () => { active = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [account]);
  // Live / Retired switch above the agent list: every job is in exactly one tab, nothing is hidden.
  const listHeader = account ? <div style={{ display: "flex", justifyContent: "flex-start", marginBottom: 12 }}>
    <SegmentedToggle options={[{ value: "live", label: `Live (${jobs.length})` }, { value: "retired", label: "Retired" }]} value={tab} onChange={(value: string) => setTab(value === "retired" ? "retired" : "live")} />
  </div> : null;
  const retiredList = tab !== "retired" ? null : retired.length === 0
    ? <EmptyState icon="wallet" title="No retired agents">Stopped, retired and cancelled agents appear here.</EmptyState>
    : <div className="fl-rows" aria-label="Retired agents">
      <DenseRowHeader columns={["Agent", "Status", ""]} />
      {retired.map(job => { const design = AGENTS.find(agent => agent.id === catalogId(job)); return <div key={job.id} role="button" tabIndex={0} style={{ cursor: "pointer" }} title={`Open ${job.id}`} onClick={() => go(`/account/${job.id}`)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); go(`/account/${job.id}`); } }}>
        <DenseRow name={catalogName(job) + " · " + job.id.slice(0, 8)} categoryId={design?.categoryId ?? "defi"} status="retired" statusLabel={ENDED_LABEL[job.state] ?? job.state} statusLine={job.reason ?? (ENDED_LABEL[job.state] ?? job.state)} value="" valueSub="" />
      </div>; })}
    </div>;
  return <AccountScreenContent jobs={new Map(jobs.map(job => [job.id, job]))} isConnected={account !== null} portfolio={account ? toPortfolio(jobs, account, lastPollMs) : null} loading={busy} error={null} needsSignature={false} narrow={false} unit={unit} setUnit={setUnit} refresh={() => { void actions.refresh(); }} authorize={() => { void actions.login(); }} go={go} connectedAddress={account ?? undefined} ownerAddress={account ?? undefined} extraWallets={jobs.filter(job => job.trade && job.agentAccount !== null).map(job => job.agentAccount!)} listHeader={listHeader} altList={retiredList}>
    {account && paperError && <p role="status" style={{ ...SUBTLE, marginTop: 20 }}>{paperError}</p>}
    {account && paper?.owner === account && paper.agents.length > 0 && <section aria-label="Paper agents" style={{ ...CARD, marginTop: 20 }}>
      <h2 style={{ font: 'var(--type-body-md)' }}>Paper agents</h2>
      {paper.agents.map(agent => <a key={agent.id} href={'/meme/' + agent.id} onClick={event => { event.preventDefault(); go('/meme/' + agent.id); }} style={{ display: 'grid', gap: 6, padding: '12px 0', borderBottom: '1px solid var(--line-1)' }}>
        <strong>Trading Agent · {agent.id.slice(0, 8)}</strong>
        <span style={SUBTLE}>{agent.state} · Paper capital: {agent.settings.capitalNear} NEAR · Term ends: {new Date(agent.endsAt).toLocaleString('en-US')}</span>
      </a>)}
    </section>}
    {message && <p role="status" style={{ font: "var(--type-mono-xs)", color: "var(--text-subtle)", marginTop: 12 }}>{message}</p>}
    <NearDemoAgents go={go} />
  </AccountScreenContent>;
}
