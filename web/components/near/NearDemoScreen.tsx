import React from 'react';
import { Button, MetricTile } from '@/design-system';
import type { ChartInterval } from '@/lib/exec/agent-detail';
import { catalogName, toAgentDetailView } from '@/lib/near-map';
import { asset, fmt, USDC, type Job } from '@/lib/near-format';
import { api } from '@/lib/near-wallet';
import { gridModel, NearGridBody, type UseAgentDetailResult } from './NearJobScreen';
import { NearLpDetail } from './NearLpDetail';
import { NearTradeBody } from './NearTradeDetail';

// Demo mode section 8 (docs/specs/DEMO-MODE-SPEC.md). Type-only: the page follows the public API without bundling server code.
type DemoMeta = ReturnType<typeof import('../../../src/core/demo-view').demoPublicView>['demo'];
export type DemoView = { job: Job; demo: DemoMeta };

export const DEMO_BANNER = 'Simulated agent. No wallet, no deposit, nothing is signed. Prices and pool data are read live from NEAR mainnet; the agent applies the live strategy rules to simulated balances.';
const ENDS: Readonly<Record<string, string>> = { 'owner-stopped': 'stopped by its owner', 'operator-stopped': 'stopped by the operator', 'term-ended': 'term ended',
  'stop-loss': 'stop loss', 'take-profit': 'take profit', budget: 'budget spent', runs: 'all buys done', date: 'end date reached', tp: 'take profit', sl: 'stop loss',
  reserve: 'the simulated gas reserve ran out' };
const BOX: React.CSSProperties = { padding: 16, border: '1px solid var(--line-1)', borderRadius: 'var(--radius-sm)', background: 'var(--surface-sunken)', font: 'var(--type-body-md)' };
const signed = (n: bigint) => `${n < 0n ? '-' : '+'}${fmt((n < 0n ? -n : n).toString())}`;

export function NearDemoScreen({ agentId, go }: { agentId: string; go: (route: string) => void }) {
  const [response, setView] = React.useState<DemoView | null>(null);
  const [error, setError] = React.useState('');
  const [confirm, setConfirm] = React.useState(false);
  const [stopping, setStopping] = React.useState(false);
  const [chartInterval, setChartInterval] = React.useState<ChartInterval>('1m');
  const [chartUnit, setChartUnit] = React.useState<'usd' | 'quote'>('usd');
  const validId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(agentId);
  const view = response?.job?.id === agentId && response.demo?.simulated === true && Array.isArray(response.demo.omits) ? response : null;
  const load = React.useCallback(() => api<DemoView>('/api/demo/' + encodeURIComponent(agentId)), [agentId]);
  React.useEffect(() => {
    let active = true, loading = false;
    setView(null); setConfirm(false); setError('');
    if (!validId) return;
    const refresh = async () => {
      if (document.visibilityState !== 'visible' || loading) return;
      loading = true;
      try { const result = await load(); if (active) { setView(result); setError(''); } }
      catch { if (active) setError('Demo agent unavailable. Check the link or try again shortly.'); }
      finally { loading = false; }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 15000);
    document.addEventListener('visibilitychange', refresh);
    return () => { active = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [agentId, validId, load]);

  const banner = <p role="note" style={BOX}>{DEMO_BANNER}</p>;
  if (!view) return <div className="fl-shell" style={{ display: 'grid', gap: 20 }}>
    <div><Button variant="ghost" size="sm" onClick={() => go('/account')}>Back to Account</Button></div>
    {banner}
    {error && <p role="status" style={{ color: 'var(--loss)' }}>{error}</p>}
    <p>{!validId || response !== null ? 'Demo agent not found.' : error ? 'The demo agent could not be loaded.' : 'Loading demo agent...'}</p>
  </div>;

  const { job: raw, demo } = view, now = Date.now();
  const mapped = toAgentDetailView(raw, now), fees = mapped.lp?.feeMetric;
  // LP fees in a simulation are an estimate (spec U-1): the fee tile says so.
  const detailView = mapped.lp && fees && fees.value !== null ? { ...mapped, lp: { ...mapped.lp, feeMetric: { ...fees, tokenBreakdown: `estimated: ${fees.tokenBreakdown ?? ''}` } } } : mapped;
  const detail: UseAgentDetailResult = { state: 'ready', view: detailView, market: null, chartCandles: null, chartBanner: null, chartInterval, setChartInterval, chartUnit, setChartUnit,
    asOfMs: now, message: '', marketReason: 'Price history is not recorded yet.', readHeaders: {}, refresh: async () => {} };
  // The server's value for every kind: the simulated holdings plus what the exit already paid (an ended trade agent shows its result, not 0).
  const value = demo.value, deposit = BigInt(raw.depositYocto), running = raw.state === 'running';
  const token = raw.trade?.pair.token ?? USDC;
  return <div className="fl-shell fl-hired-agent-page" style={{ display: 'grid', gap: 20 }}>
    <div><Button variant="ghost" size="sm" onClick={() => go('/account')}>Back to Account</Button></div>
    {banner}
    {error && <p role="status" style={{ color: 'var(--loss)' }}>{error}</p>}
    <header style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <h1 style={{ font: 'var(--type-page-title)' }}>{catalogName(raw)} · {raw.id.slice(0, 8)} · Simulated</h1>
        <p style={{ font: 'var(--type-mono-xs)', color: 'var(--text-muted)', marginTop: 8 }}>{raw.reason ?? ''}</p>
      </div>
      {!demo.isOwner && <span style={{ font: 'var(--type-mono-xs)', border: '1px solid var(--line-1)', borderRadius: 999, padding: '8px 12px' }}>Read-only</span>}
      {demo.isOwner && running && (confirm ? <div style={{ display: 'grid', gap: 10 }}>
        <p>Stop this simulated agent? It settles its simulated balances, one step a minute.</p>
        <Button variant="danger" disabled={stopping} onClick={async () => {
          setStopping(true); setError('');
          try { await api('/api/demo/' + encodeURIComponent(agentId) + '/stop', {}); setView(await load()); setConfirm(false); }
          catch { setError('Could not stop the demo agent. It may have changed; reload the page.'); }
          finally { setStopping(false); }
        }}>{stopping ? 'Stopping...' : 'Confirm stop'}</Button>
        <Button variant="secondary" disabled={stopping} onClick={() => setConfirm(false)}>Cancel</Button>
      </div> : <Button variant="danger" onClick={() => setConfirm(true)}>Stop</Button>)}
    </header>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
      <MetricTile label="Simulated deposit" value={fmt(raw.depositYocto)} />
      <MetricTile label="Value" value={value === null ? '-' : fmt(value)} />
      <MetricTile label="P&L vs deposit" value={value === null ? '-' : signed(BigInt(value) - deposit)} />
      <MetricTile label="State" value={raw.state} note={demo.endReason ? ENDS[demo.endReason] ?? demo.endReason : undefined} />
      <MetricTile label="Term ends" value={new Date(demo.endsAt).toLocaleString('en-US')} />
      {demo.result && <MetricTile label="Final result" value={fmt(demo.result.near)} note={`plus ${asset(token, demo.result.token)}`} />}
    </div>
    <section style={{ ...BOX, display: 'grid', gap: 8 }}>
      <strong>What the simulation leaves out</strong>
      <ol style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>{demo.omits.map(line => <li key={line}>{line}</li>)}</ol>
    </section>
    {raw.kind === 'lp' ? <NearLpDetail view={detailView} detail={detail} liquidity={raw.lp?.position?.liquidity ?? null} executionModel="LP V2"
      compound={raw.lp?.settings && raw.lp.settings !== 'invalid' ? { on: raw.lp.settings.compound.on, count: raw.lp.compounds?.count ?? 0, lastAt: raw.lp.compounds?.lastAt ?? null } : null} />
      : raw.trade ? <NearTradeBody job={raw} simulated />
        : <NearGridBody detail={detail} model={gridModel(raw)} details={null} />}
    <p style={{ font: 'var(--type-mono-xs)', color: 'var(--text-subtle)' }}>Last simulation tick: {demo.lastTickAt === null ? '-' : new Date(demo.lastTickAt).toLocaleString('en-US')} · AI range calls today: {demo.ai.usedToday} of {demo.ai.cap}</p>
  </div>;
}
