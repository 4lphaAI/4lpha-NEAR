import React from 'react';
import { fmt } from '@/lib/near-format';
import { api } from '@/lib/near-wallet';

// Demo mode 8.2. Kept apart from NearDemoScreen so the account page (imported by the hire popup) does not load the job page bodies and charts.
export type DemoSummary = ReturnType<typeof import('../../../src/core/demo-view').demoSummary>;

/** The demo agents of this browser's cookie on /account, with or without a wallet session. Renders nothing when there are none. */
export function NearDemoAgents({ go }: { go: (route: string) => void }) {
  const [agents, setAgents] = React.useState<DemoSummary[] | null>(null);
  React.useEffect(() => {
    let active = true;
    api<DemoSummary[]>('/api/demo').then(list => { if (active) setAgents(Array.isArray(list) ? list : null); }, () => { if (active) setAgents(null); });
    return () => { active = false; };
  }, []);
  if (!agents || agents.length === 0) return null;
  const name = (kind: string) => kind === 'lp' ? 'Range Pilot' : kind === 'schedule' ? 'Schedule buy' : kind === 'dca' ? 'Auto DCA' : 'Grid Keeper';
  return <section aria-label="Demo agents" style={{ border: '1px solid var(--line-1)', borderRadius: 'var(--radius-lg)', background: 'var(--raised)', padding: 16, marginTop: 20, display: 'grid', gap: 12 }}>
    <h2 style={{ font: 'var(--type-body-md)' }}>Demo agents (this browser)</h2>
    {agents.map(a => <a key={a.id} href={'/demo/' + a.id} onClick={event => { event.preventDefault(); go('/demo/' + a.id); }} style={{ display: 'grid', gap: 6, padding: '12px 0', borderBottom: '1px solid var(--line-1)' }}>
      <strong>{name(a.kind)} · {a.id.slice(0, 8)} · Simulated</strong>
      <span style={{ font: 'var(--type-body-sm)', color: 'var(--text-subtle)' }}>{a.state} · Value: {a.value === null ? '-' : fmt(a.value)} · Term ends: {new Date(a.endsAt).toLocaleString('en-US')}</span>
    </a>)}
  </section>;
}
