import React from 'react';
import { Button, Checkbox, Icon, SegmentedToggle } from '@/design-system';
import { useNearSession } from '@/lib/near-session';
import { api } from '@/lib/near-wallet';
import { depositYocto, exactNear } from '@/lib/near-format';
import type { TradeOptions } from '@/lib/near-actions';
import { Group } from './deploy-kit';
import { DEPLOY_TABS, LOCKED_TAB } from './deploy-tabs';
import type { NearHireRun } from './NearHireRun';

// Every venue of the Trading agent on every tab (operator, 2026-11-12): Rhea pools and OutLayer wallets for the live models, meme.cooking and NEAR AI for Degen.
const VENUES = [{ label: 'Rhea', asset: '/design/protocols/rhea.png' }, { label: 'OutLayer', asset: '/design/outlayer.png' },
  { label: 'meme.cooking', asset: '/design/protocols/memecooking.png' }, { label: 'NEAR AI', asset: '/design/protocols/near-white.svg' }];
const primaryBtn: React.CSSProperties = { cursor: 'pointer', padding: '14px 22px', borderRadius: 'var(--radius-sm)', border: 'none', color: '#08110c', font: 'var(--weight-medium) var(--text-md)/1 var(--font-sans)' };
const busyBtn = (busy: boolean, base: React.CSSProperties): React.CSSProperties => (busy ? { ...base, cursor: 'wait', opacity: 0.6 } : base);

type Settings = { perAuctionNear: number; maxOpen: number; capitalNear: number; termDays: number };
type Options = { enabled: boolean; ai: boolean; bounds: { perAuctionNear: [number, number]; maxOpen: [number, number]; capitalMax: number; termDays: number[] }; defaults: Settings };

/* Trade V1 section 14: the route picks the model; Degen stays the paper agent. One row of models in the BSC mode-tile
   style (icon, tooltip, corner tag), as the operator asked on 2026-11-12. */
export type TradeModel = 'degen' | 'schedule' | 'dca';
const MODES: readonly { id: string; label: string; icon: string; note: string; tag: string; tone: string; route?: string; live?: boolean }[] = [
  { id: 'degen', label: 'Degen', icon: '/design/mode-ai.png', note: 'Paper trades meme.cooking auctions. Nothing is signed.', tag: 'Paper', tone: 'var(--text-muted)', route: '/deploy/trade' },
  { id: 'schedule', label: 'Schedule buy', icon: '/design/mode-sched.png', note: 'Buys a fixed amount of a token on a timer.', tag: 'Mainnet', tone: 'var(--warning)', route: '/deploy/trade/schedule', live: true },
  { id: 'dca', label: 'Auto DCA', icon: '/design/mode-dca.png', note: 'Buys a base order, then more on dips, and sells at your target.', tag: 'Mainnet', tone: 'var(--warning)', route: '/deploy/trade/dca', live: true },
  { id: 'smart', label: 'Smart Portfolio', icon: '/design/mode-smart.png', note: 'Holds a weighted basket and rebalances back to target.', tag: 'Coming soon', tone: 'var(--text-subtle)' },
];
const FREQUENCIES: readonly [number, string][] = [[3600, '1h'], [14400, '4h'], [28800, '8h'], [43200, '12h'], [86400, 'Daily']];
const ENDS: readonly [string, string][] = [['budget', 'Budget spent'], ['date', 'End date'], ['runs', 'Number of buys']];
export const USDC_NOTE = 'NEAR is the unit. This agent sells NEAR into USDC. Its dips are NEAR rises, and its take profit buys NEAR back.';
export const DCA_NOTE = 'Gas counts in the take profit. At 0.1 NEAR and 1.5 %, the token must rise about 7 % in NEAR (about 4 % at 0.24 NEAR).';
export const TRADE_DISABLED = 'Live trading agents are disabled on this server.';
const NEAR_TEXT = /^\d+(?:\.\d{1,2})?$/;
const near = (text: string) => NEAR_TEXT.test(text.trim()) ? depositYocto(text.trim()) : null;
const bps = (pct: string) => { const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(pct.trim()); return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : null; };
const nearText = (yocto: bigint) => exactNear(yocto).replace(' NEAR', '');
/* The visitor's Demo | Live choice, remembered per browser; the page renders the same without browser storage. */
const MODE_KEY = 'fourlpha_deploy_mode';
function storedMode(): 'demo' | 'live' | null {
  try { const v = window.localStorage.getItem(MODE_KEY); return v === 'demo' || v === 'live' ? v : null; } catch { return null; }
}

/** The hire text, in plain words (section 14). Take profit and stop loss lines are for Auto DCA only. */
export function hireText(model: 'schedule' | 'dca'): string[] {
  return [
    'Real funds. Your deposit is the plan plus a 0.4 NEAR reserve, which pays gas and comes back minus gas.',
    'The bought token waits in the agent wallet. It is protected by key custody only, and the watchdog only alerts on this page.',
    ...(model === 'dca' ? ['Take profit sells the position to NEAR, except when the position is too large for one sale, when its NEAR would exceed the signed daily limit, or when the wallet holds less than the agent bought: then the job ends without selling and returns the token.',
      'Stop loss does not sell.'] : []),
    'Every end pays you NEAR plus the token.',
    'You choose these settings; the policy is signed.',
    'The planned operating duration is 6 days. A recovery (a freeze, a halt, a disabled server, an unresolved transaction) can keep the funds in the agent wallet longer.',
    'RHEA and ZEC swaps have not been run by this product before. The ZEC pool charges no fee, so its liquidity can leave at any time.',
  ];
}

/** Section 5.2 bounds from the server's TradeOptions: the request body and its plan, or the first problem. */
export function liveHire(model: 'schedule' | 'dca', f: Record<string, unknown>, trade: TradeOptions, now: number): { settings: object; plan: bigint } | string {
  const s = (k: string) => String(f[k] ?? '');
  const inRange = (v: bigint | null, [lo, hi]: [string, string]) => v !== null && v >= depositYocto(lo) && v <= depositYocto(hi);
  if (model === 'schedule') {
    const b = trade.bounds.schedule, amount = near(s('amountNear')), budget = near(s('budgetNear')), interval = Number(s('intervalSec'));
    if (!inRange(amount, b.amountNear)) return `Enter ${b.amountNear[0]} to ${b.amountNear[1]} NEAR per buy.`;
    if (!inRange(budget, b.budgetNear) || budget! < amount!) return `Enter a total budget of ${b.budgetNear[0]} to ${b.budgetNear[1]} NEAR, at least the amount per buy.`;
    if (!b.intervalSec.includes(interval)) return 'Choose a frequency.';
    let end: object = { kind: 'budget' };
    if (s('endRule') === 'runs') {
      const runs = Number(s('runs'));
      if (!/^\d+$/.test(s('runs')) || runs < b.runs[0] || runs > b.runs[1]) return `Enter ${b.runs[0]} to ${b.runs[1]} buys.`;
      end = { kind: 'runs', runs };
    } else if (s('endRule') === 'date') {
      const atMs = Date.parse(s('date'));
      if (!Number.isSafeInteger(atMs) || atMs < now + interval * 1000 || atMs > b.dateMaxMs) return 'Choose an end date from one interval to 6 days ahead.';
      end = { kind: 'date', atMs };
    }
    return { settings: { amountNear: s('amountNear').trim(), intervalSec: interval, budgetNear: s('budgetNear').trim(), end }, plan: budget! };
  }
  const b = trade.bounds.dca, base = near(s('baseNear')), order = near(s('orderNear')), levels = Number(s('levels'));
  const step = bps(s('stepPct')), tp = bps(s('tpPct')), sl = f.slOn === true ? bps(s('slPct')) : 0;
  if (!inRange(base, b.orderNear) || !inRange(order, b.orderNear)) return `Enter ${b.orderNear[0]} to ${b.orderNear[1]} NEAR for the base and DCA orders.`;
  if (!/^\d+$/.test(s('levels')) || levels < b.levels[0] || levels > b.levels[1]) return `Choose ${b.levels[0]} to ${b.levels[1]} DCA orders.`;
  const maxStep = b.maxStepBps[levels - 1]!;
  if (step === null || step < 50 || step > maxStep || step % 50 !== 0) return `Choose a price drop step of 0.5 to ${maxStep / 100} % in steps of 0.5 %.`;
  if (tp === null || tp < b.tpBps[0] || tp > b.tpBps[1] || tp % 10 !== 0) return `Choose a take profit of ${b.tpBps[0] / 100} to ${b.tpBps[1] / 100} % in steps of 0.1 %.`;
  if (sl === null || (sl !== 0 && (sl < b.slBps[0] || sl > b.slBps[1] || sl % 100 !== 0))) return `Choose a stop loss of ${b.slBps[0] / 100} to ${b.slBps[1] / 100} % in whole percent.`;
  const plan = base! + BigInt(levels) * order!;
  if (plan > depositYocto(b.planMaxNear)) return `The total delegated may be at most ${b.planMaxNear} NEAR.`;
  return { settings: { baseNear: s('baseNear').trim(), orderNear: s('orderNear').trim(), levels, stepBps: step, tpBps: tp, slBps: sl }, plan };
}

export function NearTradeDeployScreen({ go, model = 'degen' }: { go: (route: string) => void; model?: TradeModel }) {
  const actions = useNearSession();
  const { account, busy, logoutPending, message } = actions.state;
  const [options, setOptions] = React.useState<Options | null>(null);
  const [values, setValues] = React.useState({ perAuctionNear: '10', maxOpen: '2', capitalNear: '20', termDays: '7' });
  const [error, setError] = React.useState('');
  const [creating, setCreating] = React.useState(false);
  const pending = React.useRef(false);
  // Trade V1: the owner's edits of a live form (defaults come from the server's TradeOptions) and the hire popup of the job just prepared.
  const [edits, setEdits] = React.useState<Record<string, unknown>>({});
  const [runId, setRunId] = React.useState<string | null>(null);
  // The hire popup is loaded when a live hire is prepared, so its portal (react-dom) stays out of the Degen screen's module graph.
  const [HireRun, setHireRun] = React.useState<typeof NearHireRun | null>(null);
  React.useEffect(() => {
    let active = true;
    void api<Options>('/api/meme/options').then(result => {
      if (!active) return;
      setOptions(result);
      setValues({ perAuctionNear: String(result.defaults.perAuctionNear), maxOpen: String(result.defaults.maxOpen), capitalNear: String(result.defaults.capitalNear), termDays: String(result.defaults.termDays) });
    }).catch(() => { if (active) setError('Paper trading is unavailable on this server.'); });
    return () => { active = false; };
  }, []);
  const settings: Settings = { perAuctionNear: Number(values.perAuctionNear), maxOpen: Number(values.maxOpen), capitalNear: Number(values.capitalNear), termDays: Number(values.termDays) };
  const bounds = options?.bounds;
  const reason = !bounds ? '' : Object.values(values).some(value => !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    ? 'Enter whole numbers for all four settings.'
    : settings.perAuctionNear < bounds.perAuctionNear[0] || settings.perAuctionNear > bounds.perAuctionNear[1]
      ? `Enter ${bounds.perAuctionNear[0]} to ${bounds.perAuctionNear[1]} NEAR per auction.`
      : settings.maxOpen < bounds.maxOpen[0] || settings.maxOpen > bounds.maxOpen[1]
        ? `Choose ${bounds.maxOpen[0]} to ${bounds.maxOpen[1]} open positions.`
        : settings.capitalNear < settings.maxOpen * settings.perAuctionNear || settings.capitalNear > bounds.capitalMax
          ? `Paper capital must be at least max open times NEAR per auction, up to ${bounds.capitalMax} NEAR.`
          : !bounds.termDays.includes(settings.termDays) ? `Choose ${bounds.termDays.join(' or ')} days.` : '';
  const disabled = busy || logoutPending || creating || (account !== null && (!options?.enabled || reason !== ''));

  const active = DEPLOY_TABS.find(k => k.id === 'trade')!;
  const ai = options ? options.ai ? 'on' : 'off on this server: the agent will not enter' : 'unavailable';

  // Demo mode in the main app (DEMO-MODE-COMBINED-PLAN section 2): a Demo | Live switch on the live models when this web serves the demo. Signed
  // out the demo options are read; signed in only when the live options report demo: true. Demo takes the form from the demo options' hire block
  // and posts to /api/demo; Live is the live screen. Default Demo without a wallet session, Live with one; the remembered choice wins. Degen never switches.
  const [demo, setDemo] = React.useState<{ hire: { trade: TradeOptions } } | null>(null);
  const [demoBusy, setDemoBusy] = React.useState(false);
  const [demoError, setDemoError] = React.useState('');
  const [picked, setPicked] = React.useState(storedMode());
  const liveDemo = actions.state.options?.demo === true;
  React.useEffect(() => {
    let active = true;
    if ((account === null || liveDemo) && model !== 'degen') api<{ hire: { trade: TradeOptions } }>('/api/demo/options').then(o => { if (active) setDemo(o); }, () => { if (active) setDemo(null); });
    return () => { active = false; };
  }, [account, liveDemo, model]);
  const switchOn = model !== 'degen' && demo !== null && (account === null || liveDemo);
  const demoMode = switchOn && (picked ?? (account === null || actions.state.options?.liveEnabled === false ? 'demo' : 'live')) === 'demo';
  const pick = (value: string) => {
    const next = value === 'demo' ? 'demo' : 'live';
    setPicked(next);
    try { window.localStorage.setItem(MODE_KEY, next); } catch { /* Browser storage can be unavailable. */ }
  };
  // Trade V1 live forms. The live cards show on a live route, or on /deploy/trade when the server enables them.
  const hireOptions = actions.state.options, trade = demoMode && demo ? demo.hire.trade : hireOptions?.trade ?? null;
  // As Grid V2: a visitor (no options yet) sees every model; only a server that reports Trade disabled hides the live ones on /deploy/trade.
  const modes = MODES.filter(m => !m.live || model !== 'degen' || !hireOptions || trade?.enabled === true);
  const [hover, setHover] = React.useState<string | null>(null);
  const d = trade?.defaults, pct = (n: number) => String(n / 100);
  const form: Record<string, unknown> = {
    agentName: model === 'dca' ? 'Auto DCA 01' : 'Schedule buy 01', pair: (model === 'dca' ? d?.dca.pair : d?.schedule.pair) ?? 'trade-usdc',
    budgetNear: d?.schedule.budgetNear ?? '0.20', amountNear: d?.schedule.amountNear ?? '0.10', intervalSec: String(d?.schedule.intervalSec ?? 3600), endRule: d?.schedule.end.kind ?? 'budget',
    runs: '2', date: '', baseNear: d?.dca.baseNear ?? '0.10', orderNear: d?.dca.orderNear ?? '0.10', levels: String(d?.dca.levels ?? 3), stepPct: pct(d?.dca.stepBps ?? 100),
    tpPct: pct(d?.dca.tpBps ?? 150), slOn: (d?.dca.slBps ?? 0) > 0, slPct: (d?.dca.slBps ?? 0) > 0 ? pct(d!.dca.slBps) : '10', ...edits,
  };
  const set = (key: string, value: unknown) => setEdits(previous => ({ ...previous, [key]: value }));
  const live = model !== 'degen' && trade ? liveHire(model, form, trade, Date.now()) : null;
  const plan = live && typeof live !== 'string' ? live.plan : null, deposit = plan === null ? null : plan + depositYocto(trade?.reserveNear ?? '0.4');
  const nameBad = String(form.agentName).trim() !== '' && !/^[\p{L}\p{N} ._-]{1,40}$/u.test(String(form.agentName).trim().replace(/\s+/gu, ' '));
  const liveReason = demoMode || !account ? '' : hireOptions === undefined || hireOptions === null ? '' : !trade || !trade.enabled ? TRADE_DISABLED
    : typeof live === 'string' ? live : nameBad ? 'Letters, digits, spaces and . _ - only, up to 40 characters.' : '';
  const liveDisabled = demoMode ? demoBusy : busy || logoutPending || runId !== null || (account !== null && (!hireOptions || liveReason !== '' || deposit === null));
  const pairs = trade?.pairs ?? [{ id: 'trade-usdc', symbol: 'USDC' }, { id: 'trade-rhea', symbol: 'RHEA' }, { id: 'trade-zec', symbol: 'ZEC' }];
  const pairField = { k: 'pair', label: 'Token', type: 'select', options: pairs.map(p => ({ value: p.id, label: `${p.symbol} / wNEAR` })) };
  const levels = Number(form.levels), maxStep = trade?.bounds.dca.maxStepBps[levels - 1] ?? 3000;
  const chip = (on: boolean): React.CSSProperties => ({ cursor: 'pointer', padding: '8px 14px', borderRadius: 999, font: 'var(--weight-medium) var(--text-sm)/1 var(--font-sans)',
    color: on ? active.color : 'var(--text-subtle)', background: on ? active.tint : 'transparent', border: `1px solid ${on ? active.color : 'var(--line-1)'}` });
  const note: React.CSSProperties = { margin: 0, font: 'var(--weight-regular) var(--text-xs)/var(--leading-normal) var(--font-sans)', color: 'var(--text-subtle)' };
  // The demo body: the current form values and the exact deposit, no name (a public page never shows visitor text).
  const tryDemo = async () => {
    if (demoBusy || model === 'degen') return;
    if (!live || typeof live === 'string' || deposit === null) { setDemoError(typeof live === 'string' ? live : 'Trade options are unavailable.'); return; }
    setDemoBusy(true); setDemoError('');
    try { go('/demo/' + (await api<{ id: string }>('/api/demo', { kind: model, pair: String(form.pair), depositYocto: deposit.toString(), trade: live.settings })).id); }
    catch { setDemoError('Could not create the demo agent. Check the settings and the demo limits.'); }
    finally { setDemoBusy(false); }
  };

  const modelRow = <div style={{ display: 'grid', gap: 14, marginBottom: 26 }}>
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
      <span className="fl-eyebrow">Execution model</span>
      <span className="fl-deploy-form-links">
        <a href="#" onClick={e => e.preventDefault()}>Guides</a>
        <a href="#" onClick={e => e.preventDefault()}>Tutorial Videos</a>
      </span>
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10, marginTop: 6 }}>
      {modes.map(m => {
        const on = m.id === model, soon = !m.route;
        return <div key={m.id} style={{ position: 'relative' }} onMouseEnter={() => setHover(m.id)} onMouseLeave={() => setHover(h => (h === m.id ? null : h))}>
          <button type="button" disabled={soon} aria-disabled={soon} onClick={() => { if (m.route && !on) go(m.route); }}
            style={{ width: '100%', textAlign: 'center', cursor: soon ? 'not-allowed' : 'pointer', opacity: soon ? 0.55 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, padding: '14px 14px', borderRadius: 'var(--radius-sm)',
              background: on ? active.tint : 'var(--surface-sunken)', border: `1px solid ${on ? active.color : 'var(--line-1)'}` }}>
            <span aria-hidden="true" style={{ width: 32, height: 32, flex: '0 0 auto', display: 'block', background: on ? active.color : 'var(--ink-1)', opacity: on ? 1 : 0.65,
              WebkitMaskImage: `url("${m.icon}")`, maskImage: `url("${m.icon}")`, WebkitMaskSize: 'contain', maskSize: 'contain', WebkitMaskRepeat: 'no-repeat', maskRepeat: 'no-repeat', WebkitMaskPosition: 'center', maskPosition: 'center' }} />
            <span style={{ font: 'var(--weight-medium) var(--text-sm)/1 var(--font-sans)', color: on ? active.color : 'var(--ink-1)' }}>{m.label}</span>
          </button>
          <span style={{ position: 'absolute', top: -8, right: 10, padding: '1px 8px', borderRadius: 999, background: 'var(--surface-card)', border: `1px solid ${m.tone}`, color: m.tone, font: 'var(--weight-medium) 10px/1.6 var(--font-mono)', pointerEvents: 'none' }}>{m.tag}</span>
          {hover === m.id ? <span role="tooltip" style={{ position: 'absolute', left: 0, right: 0, bottom: 'calc(100% + 8px)', zIndex: 20, padding: '8px 10px', borderRadius: 'var(--radius-sm)', background: 'var(--surface-raised, #1a1d21)', border: '1px solid var(--line-1)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)', font: 'var(--weight-regular) var(--text-xs)/1.45 var(--font-sans)', color: 'var(--text-muted)' }}>{m.note}</span> : null}
        </div>;
      })}
    </div>
    <span style={{ font: 'var(--weight-regular) var(--text-xs)/var(--leading-normal) var(--font-sans)', color: 'var(--text-subtle)' }}>{MODES.find(m => m.id === model)?.note}</span>
  </div>;

  /* The frame is the BSC DeployAgentScreen render (header, agent tabs, form card, execution model, groups, hire block). */
  return <div className="fl-shell fl-deploy-page fl-deploy-polished" style={{ maxWidth: 1080 }} data-testid="deploy-trade-screen">
    <Button variant="ghost" size="sm" icon={<span style={{ display: 'grid', placeItems: 'center', transform: 'rotate(180deg)' }}><Icon name="arrow-right" size={13} /></span>} onClick={() => go('/')}>Back to marketplace</Button>

    <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 24, flexWrap: 'wrap', margin: '20px 0 26px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <span style={{ width: 52, height: 52, borderRadius: 'var(--radius-sm)', background: active.tint, color: active.color, display: 'grid', placeItems: 'center' }}>
          <Icon name={active.icon} size={35} />
        </span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <h1 style={{ font: 'var(--type-page-title)' }}>Deploy your <span style={{ color: active.color }}>Trading</span> Agent</h1>
          <p style={{ font: 'var(--weight-regular) var(--text-sm)/var(--leading-normal) var(--font-sans)', color: 'var(--text-muted)' }}>{model === 'degen' ? 'Screens new meme.cooking auctions, sizes entries, and manages paper buys and exits 24/7.' : 'Buys on a schedule or on dips, and automatically manages buys and exits 24/7.'}</p>
        </div>
      </div>
      {switchOn ? <SegmentedToggle accent value={demoMode ? 'demo' : 'live'} onChange={pick} options={[{ value: 'demo', label: 'Demo' }, { value: 'live', label: 'Live' }]} /> : null}
    </div>

    <div style={{ display: 'flex', gap: 8, marginBottom: 22, flexWrap: 'wrap' }}>
      {DEPLOY_TABS.map(k => (
        <button key={k.id} type="button" onClick={() => go(k.route)}
          style={{ cursor: 'pointer', font: 'var(--weight-medium) var(--text-sm)/1 var(--font-sans)', color: k.id === active.id ? k.color : 'var(--text-subtle)', background: k.id === active.id ? k.tint : 'transparent', border: `1px solid ${k.id === active.id ? k.color : 'var(--line-1)'}`, borderRadius: 999, padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 7 }}>
          <Icon name={k.icon} size={13} />{k.label}
        </button>
      ))}
      <span aria-disabled="true" title={LOCKED_TAB.title}
        style={{ cursor: 'not-allowed', font: 'var(--weight-medium) var(--text-sm)/1 var(--font-sans)', color: 'var(--text-disabled)', background: 'transparent', border: '1px solid var(--line-1)', borderRadius: 999, padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 7 }}>
        <Icon name={LOCKED_TAB.icon} size={13} />{LOCKED_TAB.label}
      </span>
    </div>

    {model === 'degen' ? <form className="fl-deploy-form" style={{ border: '1px solid var(--border-card)', borderTop: `2px solid ${active.color}`, borderRadius: 'var(--radius-md)', background: 'var(--surface-card)', padding: 24 }} onSubmit={async event => {
      event.preventDefault();
      if (!account || disabled || pending.current) return;
      pending.current = true; setCreating(true); setError('');
      try {
        const result = await api<{ id: string }>('/api/meme', settings);
        if (actions.state.account === account && !actions.state.logoutPending) go('/meme/' + result.id);
      } catch { setError('Could not create the paper agent. Check your session and running-agent limits.'); }
      finally { pending.current = false; setCreating(false); }
    }}>
      <div className="fl-deploy-providers" aria-label="Protocols">
        {VENUES.map(venue => (
          <span className="fl-deploy-provider" key={venue.label} title={venue.label}>
            <img src={venue.asset} alt="" />
            <span>{venue.label}</span>
          </span>
        ))}
      </div>
      {modelRow}

      <div style={{ display: 'grid', gap: 24 }}>
        <Group section={{ title: 'Agent', fields: [
          { k: 'perAuctionNear', label: 'NEAR per auction', type: 'stepper', step: 1, min: bounds?.perAuctionNear[0] ?? 1, max: bounds?.perAuctionNear[1] ?? 50, suffix: 'NEAR' },
          { k: 'capitalNear', label: 'Paper capital', type: 'stepper', step: 1, min: settings.maxOpen * settings.perAuctionNear, max: bounds?.capitalMax ?? 500, suffix: 'NEAR' },
          { k: 'maxOpen', label: 'Max open positions', type: 'stepper', step: 1, min: bounds?.maxOpen[0] ?? 1, max: bounds?.maxOpen[1] ?? 3 },
          { k: 'termDays', label: 'Term', type: 'select', options: (bounds?.termDays ?? [7, 30]).map(days => ({ value: String(days), label: `${days} days` })) },
        ] }} values={values} set={(key: string, value: unknown) => setValues(previous => ({ ...previous, [key]: String(value) }))} />
      </div>

      <div style={{ display: 'grid', gap: 14, marginTop: 24, paddingTop: 20, borderTop: '1px solid var(--line-1)' }}>
        <span className="fl-eyebrow">Create the paper agent</span>
        <p style={{ margin: 0, color: 'var(--text-muted)', font: 'var(--type-body-sm)' }}>No deposit, nothing is signed · AI gate: {ai}</p>
        <div style={{ display: 'grid', gap: 12 }}>
          <button type={account ? 'submit' : 'button'} style={busyBtn(disabled, { ...primaryBtn, background: active.color })} disabled={disabled} onClick={!account ? () => { void actions.login(); } : undefined}>
            {!account ? 'Connect wallet to create' : creating ? 'Creating...' : 'Create'}
          </button>
          {reason ? <p role="status" style={{ color: 'var(--loss)', margin: 0 }}>{reason}</p> : null}
          {error ? <p role="status" style={{ color: 'var(--loss)', margin: 0 }}>{error}</p> : null}
        </div>
        {message ? <p role="status" style={{ font: 'var(--type-mono-xs)', color: 'var(--text-subtle)' }}>{message}</p> : null}
      </div>
    </form> : <form className="fl-deploy-form" style={{ border: '1px solid var(--border-card)', borderTop: `2px solid ${active.color}`, borderRadius: 'var(--radius-md)', background: 'var(--surface-card)', padding: 24 }} onSubmit={event => {
      event.preventDefault();
      if (demoMode || !account || liveDisabled || !live || typeof live === 'string' || deposit === null) return;
      // The same hire as Grid and LP: prepareHire, then the hire popup (UI step 3), with the trade kind, pair and settings.
      void Promise.all([actions.prepareHire(model, nearText(deposit), undefined, undefined, String(form.agentName), { pair: String(form.pair), settings: live.settings }), import('./NearHireRun')])
        .then(([jobId, popup]) => { setHireRun(() => popup.NearHireRun); if (jobId) setRunId(jobId); });
    }}>
      <div className="fl-deploy-providers" aria-label="Protocols">
        {VENUES.map(venue => (
          <span className="fl-deploy-provider" key={venue.label} title={venue.label}>
            <img src={venue.asset} alt="" />
            <span>{venue.label}</span>
          </span>
        ))}
      </div>
      {modelRow}

      {model === 'schedule' ? <div style={{ display: 'grid', gap: 24 }}>
        <Group section={{ title: 'Agent', fields: [
          { k: 'agentName', label: 'Agent name', type: 'text', hint: nameBad ? 'Letters, digits, spaces and . _ - only, up to 40 characters.' : undefined },
          pairField,
          { k: 'budgetNear', label: 'Total budget', type: 'stepper', step: 0.1, min: 0.2, max: 1.6, preciseStep: true, suffix: 'NEAR' },
          { k: 'amountNear', label: 'Amount per buy', type: 'stepper', step: 0.01, min: 0.1, max: 0.24, preciseStep: true, suffix: 'NEAR' },
        ] }} values={form} set={set} />
        <Group section={{ title: 'Schedule', fields: [] }} values={form} set={set}>
          <div style={{ display: 'grid', gap: 8 }}>
            <span style={{ font: 'var(--weight-medium) var(--text-sm)/1 var(--font-sans)', color: 'var(--ink-1)' }}>Frequency</span>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(118px, 1fr))', gap: 8 }}>
              {FREQUENCIES.map(([sec, label]) => { const on = String(form.intervalSec) === String(sec);
                return <button key={sec} type="button" onClick={() => set('intervalSec', String(sec))}
                  style={{ cursor: 'pointer', padding: '12px 10px', borderRadius: 'var(--radius-sm)', background: on ? active.tint : 'var(--surface-sunken)', border: `1px solid ${on ? active.color : 'var(--line-1)'}`,
                    color: on ? active.color : 'var(--ink-1)', font: 'var(--weight-medium) var(--text-sm)/1 var(--font-sans)' }}>{label}</button>; })}
            </div>
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            <span style={{ font: 'var(--weight-medium) var(--text-sm)/1 var(--font-sans)', color: 'var(--ink-1)' }}>First buy time</span>
            <span style={{ ...note, color: 'var(--text-subtle)' }}>Now, after 10 minutes of price history.</span>
          </div>
        </Group>
        <Group section={{ title: 'Finish', fields: [] }} values={form} set={set}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8, alignItems: 'start' }}>
            {ENDS.map(([rule, label]) => { const on = form.endRule === rule;
              return <div key={rule} style={{ display: 'grid', gap: 10, padding: '12px 14px', borderRadius: 'var(--radius-sm)', background: 'var(--surface-sunken)', border: `1px solid ${on ? active.color : 'var(--line-1)'}` }}>
                <Checkbox checked={on} onChange={() => set('endRule', rule)}>{label}</Checkbox>
                {rule === 'date' && on ? <input type="datetime-local" value={String(form.date)} onChange={event => set('date', event.target.value)}
                  style={{ width: '100%', padding: '10px 12px', borderRadius: 'var(--radius-sm)', background: 'var(--surface-input)', border: '1px solid var(--line-1)', color: 'var(--ink-1)', font: 'var(--weight-medium) var(--text-sm)/1 var(--font-sans)' }} /> : null}
                {rule === 'runs' && on ? <Group section={{ title: '', fields: [{ k: 'runs', label: 'Number of buys', type: 'stepper', step: 1, min: 1, max: 16 }] }} values={form} set={set} /> : null}
              </div>; })}
          </div>
          <p style={{ ...note, color: 'var(--text-subtle)', font: 'var(--weight-regular) var(--text-xs)/var(--leading-normal) var(--font-sans)' }}>Pick one. The job also ends when the budget is spent, and after its planned 6 days.</p>
        </Group>
      </div> : <div style={{ display: 'grid', gap: 24 }}>
        <Group section={{ title: 'Agent', cols: 4, fields: [
          { k: 'agentName', label: 'Agent name', type: 'text', hint: nameBad ? 'Letters, digits, spaces and . _ - only, up to 40 characters.' : undefined },
          pairField,
          { k: 'stepPct', label: 'Price drop steps', type: 'stepper', step: 0.5, min: 0.5, max: maxStep / 100, preciseStep: true, suffix: '%' },
          { k: 'tpPct', label: 'Take profit', type: 'stepper', step: 0.1, min: 0.5, max: 50, preciseStep: true, suffix: '%' },
          { k: 'baseNear', label: 'Base order size', type: 'stepper', step: 0.01, min: 0.1, max: 0.24, preciseStep: true, suffix: 'NEAR' },
          { k: 'orderNear', label: 'DCA order size', type: 'stepper', step: 0.01, min: 0.1, max: 0.24, preciseStep: true, suffix: 'NEAR' },
          { k: 'levels', label: 'Max DCA orders', type: 'stepper', step: 1, min: 1, max: 8 },
          { k: 'total', label: 'Total delegated', type: 'stepper', step: 0.01, locked: true, suffix: 'NEAR' },
        ] }} values={{ ...form, total: plan === null ? '-' : nearText(plan) }} set={set} />
        <Group section={{ title: 'Exit', fields: [
          { k: 'slOn', type: 'hidden' },
          { k: 'slPct', label: 'Stop loss', type: 'numToggle', on: 'slOn', suffix: '%', step: 1, min: 1, max: 90 },
        ] }} values={form} set={set} />
        <p style={note}>{DCA_NOTE}</p>
        <p style={note}>Gas and the pool fee count: at 0.1 NEAR a stop loss of 1 or 2 % is already reached right after the first buy.</p>
      </div>}
      {form.pair === 'trade-usdc' ? <p style={{ ...note, marginTop: 16, color: 'var(--warning)' }}>{USDC_NOTE}</p> : null}

      <div style={{ display: 'grid', gap: 14, marginTop: 24, paddingTop: 20, borderTop: '1px solid var(--line-1)' }}>
        {demoMode ? null : <>
          <span className="fl-eyebrow">Hire the agent wallet</span>
          <p style={{ margin: 0, color: 'var(--text-muted)', font: 'var(--type-body-sm)' }}>
            Deposit {deposit === null ? '-' : exactNear(deposit)} (the plan plus the 0.4 NEAR reserve) · Caps 0.25 NEAR per transaction and {deposit === null ? '3 times your deposit' : exactNear(3n * deposit)} per day
          </p>
          <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4, color: 'var(--text-subtle)', font: 'var(--weight-regular) var(--text-xs)/var(--leading-normal) var(--font-sans)' }}>
            {hireText(model).map(line => <li key={line}>{line}</li>)}
          </ul>
        </>}
        <div style={{ display: 'grid', gap: 12 }}>
          <button type={account && !demoMode ? 'submit' : 'button'} style={busyBtn(liveDisabled, { ...primaryBtn, background: active.color })} disabled={liveDisabled}
            onClick={demoMode ? () => { void tryDemo(); } : !account ? () => { void actions.login(); } : undefined}>
            {demoMode ? 'Start demo agent' : !account ? 'Connect wallet to hire' : !hireOptions ? 'Loading...' : 'Prepare hire'}
          </button>
          {demoMode ? <p style={{ margin: 0, color: 'var(--text-muted)', font: 'var(--type-body-sm)' }}>Demo runs on live prices and simulates the fills. No wallet, no deposit, nothing is signed.</p> : null}
          {liveReason ? <p role="status" style={{ color: 'var(--loss)', margin: 0 }}>{liveReason}</p> : null}
          {demoMode && demoError ? <p role="status" style={{ color: 'var(--loss)', margin: 0 }}>{demoError}</p> : null}
        </div>
        {runId && HireRun ? <HireRun jobId={runId} go={go} onClose={() => setRunId(null)} ownMount /> : null}
        {message && !runId && !demoMode ? <p role="status" style={{ font: 'var(--type-mono-xs)', color: 'var(--text-subtle)' }}>{message}</p> : null}
      </div>
    </form>}
  </div>;
}
