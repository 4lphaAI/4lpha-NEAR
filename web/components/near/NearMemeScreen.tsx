import React from 'react';
import { Button, MetricTile, SegmentedToggle } from '@/design-system';
import { useNearSession } from '@/lib/near-session';
import { api } from '@/lib/near-wallet';

// Type-only: keep the UI aligned with the public API without bundling server code.
export type MemeView = ReturnType<typeof import('../../../src/core/meme-view').memePublicView>;
type MemeRun = MemeView['runs'][number];
type MemeRow = MemeView['log'][number];

const TABS = ['Open', 'Closed', 'Auctions', 'Run log', 'Decision log'];
const RUN_FILTERS = ['All cycles', 'Activity', 'Failed'];
const SCREEN: Record<string, string> = { pass: 'passed the checks', 'deposit-token': 'not a wNEAR auction', 'too-long': 'runs longer than one day',
  'few-depositors': 'fewer than 10 depositors', 'creator-funded': 'the creator holds 90% or more of the stake', 'far-from-soft-cap': 'under half of the soft cap',
  'hard-cap': 'already at the hard cap' };
const at = (ms: number) => new Date(ms).toLocaleString('en-US');
const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const screenText = (code: unknown) => typeof code === 'string' ? SCREEN[code] ?? code : 'unknown';
function ago(ms: number, now: number) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
}
function near(raw: unknown) {
  if (typeof raw !== 'string' || !/^-?\d+$/.test(raw)) return '-';
  const n = BigInt(raw), abs = n < 0n ? -n : n, unit = 10n ** 24n, frac = (abs % unit).toString().padStart(24, '0').slice(0, 4).replace(/0+$/, '');
  return `${n < 0n ? '-' : ''}${abs / unit}${frac ? '.' + frac : ''}`;
}
const pct = (bps: unknown) => typeof bps === 'number' && Number.isFinite(bps) ? `${(bps / 100).toFixed(2)}%` : '-';
const runFailed = (r: MemeRun) => (r.unreadable ?? 0) > 0 || (r.invalid ?? 0) > 0 || r.overrun;
const runActive = (r: MemeRun) => r.entries + r.exits + r.screened + r.asked + (r.discovered?.length ?? 0) > 0;
function runHeadline(r: MemeRun) {
  if (r.entries > 0) return 'Paper entry';
  if (r.exits > 0) return 'Paper exit';
  if (r.screened > 0 || r.asked > 0) return 'Decided on an auction in its last minutes';
  if ((r.unreadable ?? 0) > 0 || (r.invalid ?? 0) > 0) return 'Some chain reads failed; the next minute retries';
  if (r.overrun) return 'The cycle ran out of time; the next minute continues';
  if ((r.budget ?? 0) > 0) return 'Read limit reached; the rest waits for the next minute';
  if (r.discovered?.length) return `Found new auction${r.discovered.length === 1 ? '' : 's'} ${r.discovered.join(', ')}`;
  if (r.tracked === null) return 'Scanned for new auctions';
  if (r.tracked === 0) return 'No open auction to watch';
  return r.inWindow ? 'An auction is in its decision window' : `Watching ${r.tracked} auction${r.tracked === 1 ? '' : 's'}; none in its decision window`;
}
function runSummary(r: MemeRun) {
  const parts = [r.probed ? `checked ids ${r.probed[0]} to ${r.probed[1]}` : `${r.reads ?? 0} reads`];
  if (r.tracked !== null) parts.push(`${r.tracked} tracked`);
  if (r.nextWindowAt !== null) parts.push(`next decision window ${clock(r.nextWindowAt)}`);
  parts.push(`${r.screened} screened`, `${r.entries} paper entries`, `${r.exits} paper exits`);
  return parts.join(' · ');
}
function decision(row: MemeRow) {
  const d = row.data as Record<string, unknown>;
  switch (row.kind) {
    case 'cycle': return `Checked: ${screenText(d.screen)}`;
    case 'screen': return `Screen: ${screenText(d.code)}`;
    case 'ask': return d.code === 'join' ? `AI: join (${String(d.confidence)}%)`
      : d.code === 'ai-skip' ? d.action === 'join' ? `AI: join at ${String(d.confidence)}%, below the 70% bar, so no entry` : `AI: skip (${String(d.confidence)}%)`
      : d.code === 'ai-off' ? 'AI is off, so no entry' : `AI unavailable (${String(d.code)}), so no entry`;
    case 'entry': return `Paper entry: ${near(d.deposit)} NEAR (${near(d.net)} NEAR after the 0.5% fee)`;
    case 'resolve': return d.failure ? 'Auction result unreadable; retrying' : `Auction result: ${String(d.code)}${d.poolId !== undefined ? ` · Rhea pool ${String(d.poolId)}` : ''}`;
    case 'mark': return d.failure ? 'Price check failed' : `Mark: ${near(d.value)} NEAR · P&L ${pct(d.pnlBps)} · Peak ${pct(d.peakBps)}`;
    case 'exit': return `Paper exit (${String(d.code)}): ${near(d.value)} NEAR · P&L ${near(d.pnl)} NEAR`;
    default: return row.kind;
  }
}

export function NearMemeScreen({ agentId, go }: { agentId: string; go: (route: string) => void }) {
  const actions = useNearSession();
  const { account, logoutPending } = actions.state;
  const [response, setView] = React.useState<MemeView | null>(null);
  const [error, setError] = React.useState('');
  const [tab, setTab] = React.useState('Open');
  const [runFilter, setRunFilter] = React.useState('All cycles');
  const [confirm, setConfirm] = React.useState(false);
  const [stopping, setStopping] = React.useState(false);
  const pending = React.useRef(false);
  const revision = React.useRef(0);
  const validId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(agentId);
  const view = response?.agent?.id === agentId && typeof response.agent.owner === 'string'
    && ['running', 'ending', 'ended'].includes(response.agent.state) && typeof response.agent.isOwner === 'boolean'
    && Number.isFinite(response.agent.endsAt) && Number.isFinite(response.agent.settings?.capitalNear)
    && response.summary && Array.isArray(response.positions) && Array.isArray(response.auctions) && Array.isArray(response.log) && Array.isArray(response.runs) && response.meta
    ? response : null;
  const notFound = !validId || response !== null && view === null;
  React.useEffect(() => {
    let active = true, loading = false;
    setView(null); setConfirm(false); setError('');
    if (!validId) return;
    const refresh = async () => {
      if (document.visibilityState !== 'visible' || loading || pending.current) return;
      loading = true;
      const version = revision.current;
      try {
        const result = await api<MemeView>('/api/meme/' + encodeURIComponent(agentId));
        if (active && version === revision.current) { setView(result); setError(''); }
      } catch { if (active && version === revision.current) setError('Paper agent unavailable. Check the link or try again shortly.'); }
      finally { loading = false; }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 15000);
    document.addEventListener('visibilitychange', refresh);
    return () => { active = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [agentId, account]);
  const owner = view?.agent.isOwner === true && view.agent.owner === account && !logoutPending;
  const now = Date.now();
  const decisions = view?.log.filter(row => row.meme_id !== null) ?? [];
  const runs = view?.runs.filter(run => runFilter === 'Activity' ? runActive(run) : runFilter === 'Failed' ? runFailed(run) : true) ?? [];
  const nextAuction = view?.auctions.filter(auction => auction.windowClosesAt > now).sort((a, b) => a.windowOpensAt - b.windowOpensAt)[0];
  const positions = view?.positions.filter(position => tab === 'Closed' ? position.status === 'closed' : position.status !== 'closed') ?? [];

  return <div className="fl-shell" style={{ display: 'grid', gap: 20 }}>
    <div><Button variant="ghost" size="sm" onClick={() => go('/account')}>Back to Account</Button></div>
    <p style={{ padding: 16, border: '1px solid var(--line-1)', borderRadius: 'var(--radius-sm)', background: 'var(--surface-sunken)', font: 'var(--type-body-md)' }}>Paper trading (no real orders)</p>
    {error && <p role="status" style={{ color: 'var(--loss)' }}>{error}</p>}
    {!view ? <p>{notFound ? 'Paper agent not found.' : error ? 'The paper agent could not be loaded.' : 'Loading paper agent...'}</p> : <>
      <header style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 0 }}><h1 style={{ font: 'var(--type-page-title)' }}>Trading Agent</h1><p style={{ font: 'var(--type-mono-xs)', color: 'var(--text-muted)', overflowWrap: 'anywhere', marginTop: 8 }}>Owner: {view.agent.owner} · {view.agent.id}</p></div>
        {!owner && <span style={{ font: 'var(--type-mono-xs)', border: '1px solid var(--line-1)', borderRadius: 999, padding: '8px 12px' }}>Read-only</span>}
        {owner && view.agent.state === 'running' && (confirm ? <div style={{ display: 'grid', gap: 10 }}>
          <p>Stop new entries? Deposited positions still wait for settlement.</p>
          <Button variant="danger" disabled={stopping} onClick={async () => {
            if (pending.current || !owner) return;
            pending.current = true; revision.current++; setStopping(true); setError('');
            try {
              await api('/api/meme/' + encodeURIComponent(agentId) + '/stop', {});
              const result = await api<MemeView>('/api/meme/' + encodeURIComponent(agentId));
              if (actions.state.account === account && !actions.state.logoutPending) { setView(result); setConfirm(false); }
            } catch { setError('Could not stop the paper agent. Check your session and its current state.'); }
            finally { pending.current = false; setStopping(false); }
          }}>{stopping ? 'Stopping...' : 'Confirm stop'}</Button>
          <Button variant="secondary" disabled={stopping} onClick={() => setConfirm(false)}>Cancel</Button>
        </div> : <Button variant="danger" onClick={() => setConfirm(true)}>Stop</Button>)}
      </header>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
        <MetricTile label="Paper capital" value={`${view.agent.settings.capitalNear} NEAR`} />
        <MetricTile label="Paper P&L (closed)" value={`${view.summary.pnlNear} NEAR`} />
        <MetricTile label="Win rate" value={`${(view.summary.winRateBps / 100).toFixed(2)}%`} />
        <MetricTile label="State" value={view.agent.state} note={view.agent.endReason ?? undefined} />
      </div>
      <p style={{ font: 'var(--type-mono-xs)', color: 'var(--text-muted)' }}>Term ends: {new Date(view.agent.endsAt).toLocaleString('en-US')} · Last tick: {view.meta.lastTickAt === null ? '-' : at(view.meta.lastTickAt)}</p>
      {view.agent.state !== 'ended' && (view.meta.lastTickAt === null || now - view.meta.lastTickAt > 180_000) && <p role="status" style={{ font: 'var(--type-body-sm)', color: 'var(--warning)' }}>No cycle in the last 3 minutes: is the meme paper process running?</p>}
      <div><SegmentedToggle options={TABS} value={tab} onChange={setTab} /></div>
      <section style={{ border: '1px solid var(--border-card)', borderRadius: 'var(--radius-md)', background: 'var(--surface-card)', padding: 16, display: 'grid', gap: 16, overflowWrap: 'anywhere' }}>
        {(tab === 'Open' || tab === 'Closed') && <>
          {positions.length === 0 && <p>No {tab.toLowerCase()} positions.</p>}
          {positions.map(position => <article key={position.meme_id} style={{ borderBottom: '1px solid var(--line-1)', paddingBottom: 12, display: 'grid', gap: 8 }}>
            <a href={`https://meme.cooking/meme/${position.meme_id}`} target="_blank" rel="noreferrer">{position.symbol} · {position.meme_id}</a>
            <p>{position.status}{position.closeCode ? ` · ${position.closeCode}` : ''} · Deposit: {position.depositNear} NEAR</p>
            <p>Mark: {position.markNear ?? '-'} NEAR · P&L: {position.pnlBps === null ? '-' : `${(position.pnlBps / 100).toFixed(2)}%`} · Peak: {position.peakBps === null ? '-' : `${(position.peakBps / 100).toFixed(2)}%`}</p>
            {position.status === 'closed' && <p>Exit: {position.exitNear ?? '-'} NEAR · Closed P&L: {position.pnlNear ?? '-'} NEAR</p>}
            {position.poolId !== null && <p>Rhea pool: {position.poolId}</p>}
          </article>)}
        </>}
        {tab === 'Auctions' && <>
          {view.auctions.length === 0 && <p>No open auctions.</p>}
          {view.auctions.map(auction => <article key={auction.meme_id} style={{ borderBottom: '1px solid var(--line-1)', paddingBottom: 12, display: 'grid', gap: 8 }}>
            <a href={`https://meme.cooking/meme/${auction.meme_id}`} target="_blank" rel="noreferrer">{auction.symbol} · {auction.meme_id}</a>
            <p>Ends: {new Date(auction.endMs).toLocaleString('en-US')} · Depositors: {auction.depositors}</p>
            <p>Staked: {auction.totalStakedNear} NEAR · Soft cap: {auction.softCapNear} NEAR</p>
            <p>Last checked: {at(auction.checkedAt)} · Decision window: {at(auction.windowOpensAt)} to {clock(auction.windowClosesAt)}</p>
            <p>Screen: {auction.screen}{auction.screen === 'pass' ? '' : ' (' + screenText(auction.screen) + ')'} · AI: {auction.ask === null ? 'pending' : 'failure' in auction.ask ? auction.ask.failure : `${auction.ask.action} (${auction.ask.confidence}%)`}</p>
          </article>)}
        </>}
        {tab === 'Run log' && <>
          <div><SegmentedToggle options={RUN_FILTERS} value={runFilter} onChange={setRunFilter} /></div>
          {runs.length === 0 && <p>{view.runs.length === 0 ? view.agent.state === 'ended' ? "No cycles recorded during this agent's life." : 'No cycles recorded since this agent was created.' : 'No cycles match this filter.'}</p>}
          {runs.map(run => <details key={run.at} style={{ borderBottom: '1px solid var(--line-1)', paddingBottom: 12 }}>
            <summary style={{ display: 'flex', gap: 12, alignItems: 'baseline', cursor: 'pointer' }}>
              <span style={{ flex: 1, minWidth: 0 }}><strong style={{ color: runFailed(run) ? 'var(--warning)' : runActive(run) ? 'var(--gain)' : undefined }}>{runHeadline(run)}</strong>
                <span style={{ display: 'block', font: 'var(--type-body-sm)', color: 'var(--text-muted)', marginTop: 4 }}>{runSummary(run)}</span></span>
              <time title={new Date(run.at).toISOString()} style={{ font: 'var(--type-mono-xs)', color: 'var(--text-muted)' }}>{ago(run.at, now)}</time>
            </summary>
            <p style={{ font: 'var(--type-mono-xs)', color: 'var(--text-muted)', marginTop: 8 }}>{at(run.at)} · Reads: {run.reads ?? '-'} · Read limit hits: {run.budget ?? '-'} · Failed reads: {run.unreadable ?? '-'} · Invalid answers: {run.invalid ?? '-'} · Over time: {run.overrun ? 'yes' : 'no'}{run.refreshed !== null ? ` · Auctions refreshed: ${run.refreshed}` : ''}{run.inWindow !== null ? ` · In decision window: ${run.inWindow}` : ''}{run.asked ? ` · AI asks: ${run.asked}` : ''}</p>
          </details>)}
        </>}
        {tab === 'Decision log' && <>
          {decisions.length === 0 && <p>No decisions yet. The agent decides on an auction only in its last minutes before the close{nextAuction ? ` (next: ${nextAuction.symbol}, ${at(nextAuction.windowOpensAt)} to ${clock(nextAuction.windowClosesAt)})` : ''}.</p>}
          {decisions.map(row => <article key={`${row.at}:${row.kind}:${row.meme_id}`}style={{ borderBottom: '1px solid var(--line-1)', paddingBottom: 12, display: 'grid', gap: 6 }}>
            <p style={{ font: 'var(--type-mono-xs)', color: 'var(--text-muted)' }}>{at(row.at)} · <a href={`https://meme.cooking/meme/${row.meme_id}`} target="_blank" rel="noreferrer">{row.meme_id}</a></p>
            <p>{decision(row)}</p>
            <details><summary style={{ font: 'var(--type-mono-xs)', color: 'var(--text-subtle)', cursor: 'pointer' }}>Details</summary>
              <pre style={{ whiteSpace: 'pre-wrap', font: 'var(--type-mono-xs)', marginTop: 8 }}>{row.kind} {JSON.stringify(row.data)}</pre></details>
          </article>)}
        </>}
      </section>
    </>}
    <p style={{ font: 'var(--type-body-sm)', color: 'var(--text-muted)' }}>Paper limits: a paper deposit does not change the auction outcome or depositors' shares; a real deposit could push it over the soft cap or change the share. The 0.5% refund fee is not counted. Marks assume the whole position sells at that minute's pool reserves without other traders' reactions. Only one auction launched in the 30 days before November 10, 2026, so days with only refunds are possible.</p>
  </div>;
}
