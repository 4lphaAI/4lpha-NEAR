import React from 'react';
import { Button, Icon, SegmentedToggle } from '@/design-system';
import { useNearSession } from '@/lib/near-session';
import { depositYocto, exactNear } from '@/lib/near-format';
import { applyLpPrefill, type GridForm, type HireOptions } from '@/lib/near-actions';
import { applyGridPreset, gridFormFrom } from '@/lib/grid-form';
import { api } from '@/lib/near-wallet';
import { HELP_LINKS } from '@/lib/help-links';
import { DCL_POOL_KEY, tickOf } from '@/lib/near-map';
import { LiquidityChart, type LiquidityGeometry } from '@/components/lp/LiquidityChart';
import { Group, PriceRangeBox, parsePrice } from './deploy-kit';
import { DEPLOY_TABS, LOCKED_TAB } from './deploy-tabs';
import { NearHireRun } from './NearHireRun';

/* The page frame is the BSC DeployAgentScreen render (header, agent tabs,
   form card, execution model presets, groups, hire block). Only the two agents
   this server hires are listed. */
const KINDS = [
  { id: 'grid', label: 'Grid Agent', icon: 'grid-trading', color: 'var(--cat-grid)', tint: 'var(--cat-grid-tint)',
    blurb: 'Automated grid market making that buys low and sells high as market price moves.' },
  { id: 'lp', label: 'LP Agent', icon: 'lp-rebalance', color: 'var(--cat-lp)', tint: 'var(--cat-lp-tint)',
    blurb: 'Provides liquidity in your price range on one pinned pool, with automatic rotation, compound and risk exits.' },
] as const;
const VENUES = [{ label: 'Rhea DCL', asset: '/design/protocols/rhea.png' }, { label: 'OutLayer', asset: '/design/outlayer.png' }];
/* LP asks NEAR AI Cloud for a range at each rotation (fenced by code, deterministic fallback). */
const LP_VENUES = [...VENUES, { label: 'NEAR AI', asset: '/design/protocols/near-white.svg' }];
const POOL = { pair: 'USDC / wNEAR', addr: '17208628…33a1 | wrap.near', fee: '0.01%', c: 'var(--cat-grid)',
  tokens: [{ src: '/design/tokens/usdc.svg', symbol: 'USDC' }, { src: '/design/tokens/near.svg', symbol: 'wNEAR' }] };
/* Spec 2c G2-1: the BNB product's four presets, labels and displayed gaps as in its Deploy page; `set` is its TP/SL prefill. */
const GRID_V2_PRESETS = [
  { id: 'tight', label: 'Tight Scalp', gap: 'up to 0,45%', note: 'Dense levels, highest fill rate.', set: true },
  { id: 'balanced', label: 'Balanced', gap: 'up to 0,90%', note: 'Standard ladder for NEAR pairs.', set: true },
  { id: 'wide', label: 'Wide Band', gap: 'up to 1,50%', note: 'Fewer levels, lower churn.', set: true },
  { id: 'volatile', label: 'High Volatility', gap: 'up to 3,00%', note: 'Wide band for thin pairs.', set: true },
] as const;
const GRID_EXIT = { title: 'Exit', fields: [
  { k: 'gridTpOn', type: 'hidden' },
  { k: 'gridTakeProfit', label: 'Take profit', type: 'numToggle', on: 'gridTpOn', suffix: '%', step: 1, min: 0, max: 500, floor: 0 },
  { k: 'gridSlOn', type: 'hidden' },
  { k: 'gridStopLoss', label: 'Stop loss', type: 'numToggle', on: 'gridSlOn', suffix: '%', step: 1, min: 0, max: 90, floor: 0 },
] };
const PRESETS = {
  grid: [{ id: 'grid-v1', label: 'Grid V1', gap: '100-point step', note: 'Two buys and two sells on USDC / wNEAR.' }],
  // LP has no execution-model cards: the owner always sets the minimum and maximum price.
  lp: [],
} as const;
const MODES = [
  // AI range suggestions follow the server (on when NEAR AI is configured); no checkbox.
  { key: 'rebalanceOn', code: 'AR', label: 'Auto-rebalance', locked: true, fields: [] },
  { key: 'compoundOn', code: 'AC', label: 'Auto-compound', locked: false, fields: [
    { k: 'minFeeBps', label: 'Minimum fees (basis points, 100 = 1%)', type: 'stepper', step: 1, min: 10, max: 1000, floor: 10 },
  ] },
  { key: 'tpOn', code: 'TP', label: 'Take profit', locked: false, fields: [
    { k: 'takeProfitPct', label: 'Take profit at', type: 'stepper', step: 5, min: 0, max: 500, floor: 0, suffix: '%' },
  ] },
  { key: 'slOn', code: 'SL', label: 'Stop loss', locked: false, fields: [
    { k: 'stopLossPct', label: 'Stop loss at', type: 'stepper', step: 5, min: 0, max: 90, floor: 0, suffix: '%' },
  ] },
];

const primaryBtn: React.CSSProperties = { cursor: 'pointer', padding: '14px 22px', borderRadius: 'var(--radius-sm)', background: 'var(--cat-grid)', border: 'none', color: '#08110c', font: 'var(--weight-medium) var(--text-md)/1 var(--font-sans)' };
const busyBtn = (busy: boolean, base: React.CSSProperties): React.CSSProperties => (busy ? { ...base, cursor: 'wait', opacity: 0.6 } : base);
/* DCL price of a point in USDC per NEAR, written as applyLpPrefill writes it
   (6 decimals, the most the server accepts), and the point the server derives. */
const priceAt = (point: number) => (1e18 / 1.0001 ** point).toFixed(6);
const pointOf = (price: number) => Math.round(Math.log(1e18 / price) / Math.log(1.0001));
const isZero = (value: string) => /^\d+$/.test(value.trim()) && Number(value) === 0;
const nearNumber = (yocto: string) => Number(exactNear(BigInt(yocto)).replace(' NEAR', ''));
/* The visitor's Demo | Live choice, remembered per browser; the page renders the same without browser storage. */
const MODE_KEY = 'fourlpha_deploy_mode';
function storedMode(): 'demo' | 'live' | null {
  try { const v = window.localStorage.getItem(MODE_KEY); return v === 'demo' || v === 'live' ? v : null; } catch { return null; }
}

export function NearDeployScreen({ kind: id, go }: { kind: 'grid' | 'lp'; go: (route: string) => void }) {
  const actions = useNearSession();
  const { account, options, optionsError, busy, logoutPending, message, lpDraft } = actions.state;
  const active = KINDS.find(k => k.id === id) ?? KINDS[0];
  const [text, setText] = React.useState(id === 'lp' ? '1.2' : '1');
  const [agentName, setAgentName] = React.useState(id === 'lp' ? 'LP Agent 01' : 'Grid Agent 01');
  const [maxOrders, setMaxOrders] = React.useState('4');
  // Spec UI step 3: the hire popup for the job this page just prepared.
  const [runId, setRunId] = React.useState<string | null>(null);
  React.useEffect(() => setRunId(null), [account]);
  const [gridPreset, setGridPreset] = React.useState<GridForm['preset']>('balanced');
  const [exit, setExit] = React.useState({ gridTpOn: false, gridTakeProfit: '6', gridSlOn: false, gridStopLoss: '10' });
  React.useEffect(() => { if (id === 'lp') void actions.refreshLpOptions(); }, [id, actions.refreshLpOptions]);
  // Demo mode in the main app (DEMO-MODE-COMBINED-PLAN section 2): a Demo | Live switch when this web serves the demo. Signed out the demo
  // options are read; signed in only when the live options report demo: true. Demo takes the form from the demo options' hire block and posts
  // to /api/demo; Live is the live screen. Default Demo without a wallet session, Live with one; the remembered choice wins.
  const [demo, setDemo] = React.useState<{ hire: HireOptions } | null>(null);
  const [demoBusy, setDemoBusy] = React.useState(false);
  const [demoError, setDemoError] = React.useState('');
  const [picked, setPicked] = React.useState(storedMode());
  const liveDemo = options?.demo === true;
  React.useEffect(() => {
    let active = true;
    if (account === null || liveDemo) api<{ hire: HireOptions }>('/api/demo/options').then(o => { if (active) setDemo(o); }, () => { if (active) setDemo(null); });
    return () => { active = false; };
  }, [account, liveDemo]);
  const switchOn = demo !== null && (account === null || liveDemo);
  const demoMode = switchOn && (picked ?? (account === null || options?.liveEnabled === false ? 'demo' : 'live')) === 'demo';
  const pick = (value: string) => {
    const next = value === 'demo' ? 'demo' : 'live';
    setPicked(next);
    try { window.localStorage.setItem(MODE_KEY, next); } catch { /* Browser storage can be unavailable. */ }
  };
  const hireOptions = demoMode && demo ? demo.hire : options;
  // Live mode before sign-in has no pool point: the public demo options carry the same mainnet pool point, so the range still prefills at +/-100 points.
  const priceOptions = demoMode && demo ? demo.hire : options?.lp?.point != null ? options : demo?.hire ?? options;
  const draft = priceOptions ? applyLpPrefill(lpDraft, priceOptions) : lpDraft;
  let daily = '3 times your deposit', amount: bigint | null = null;
  try { amount = depositYocto(text); daily = exactNear(3n * amount); } catch { /* Keep the formula visible while editing. */ }
  const initialPosition = amount === null ? '-' : exactNear(amount - 800000000000000000000000n);
  const bounds = id === 'lp' ? hireOptions?.lpV1 && hireOptions.lp !== null ? hireOptions.lp : null : hireOptions;
  const reason = demoMode || !account ? '' : optionsError ? 'Hire options are unavailable.' : !options ? '' : !options.liveEnabled ? 'Live hires are disabled.'
    : id === 'grid' && !options.gridV1 ? 'Grid hires are not enabled on this server.'
    : id === 'lp' && (!options.lpV1 || options.lp === null) ? 'LP hires are not enabled on this server.'
    : bounds && (amount === null || amount < BigInt(bounds.minDeposit) || amount > BigInt(bounds.maxDeposit))
      ? `Enter a deposit between ${exactNear(BigInt(bounds.minDeposit)).replace(' NEAR', '')} and ${exactNear(BigInt(bounds.maxDeposit)).replace(' NEAR', '')} NEAR.` : '';
  // The server's rule for the display name (store.ts parseJobName); an empty name sends none.
  const nameBad = agentName.trim() !== '' && !/^[\p{L}\p{N} ._-]{1,40}$/u.test(agentName.trim().replace(/\s+/gu, ' '));
  const disabled = demoMode ? demoBusy : busy || logoutPending || runId !== null || (account !== null && (!options || reason !== '' || nameBad || (id === 'grid' && options.gridV2 === true && maxOrders !== '2' && maxOrders !== '4')));
  const point = priceOptions?.lp?.point ?? null;
  const currentPrice = point === null ? null : 1e18 / 1.0001 ** point;
  // The pool's liquidity profile with the typed range painted over it, mapped as the LP detail page maps it (near-map: wNEAR token0,
  // tick = -point, range ticks shifted by one for the half-open DCL range). Display only; the server derives the signed points itself.
  const chartGeometry: LiquidityGeometry | null = point === null ? null : { spacing: 1, currentTick: tickOf(point), currentTickAsOfMs: 0,
    orientation: { quoteIsToken0: false, decimals0: 24, decimals1: 6, symbol0: 'wNEAR', symbol1: 'USDC' }, display: { invert: false } };
  const typedMin = parsePrice(draft.minPrice), typedMax = parsePrice(draft.maxPrice);
  const chartRange: React.ComponentProps<typeof LiquidityChart>['range'] = typedMin !== null && typedMax !== null && typedMin < typedMax
    ? { mode: 'live', tickLower: tickOf(pointOf(typedMin)) + 1, tickUpper: tickOf(pointOf(typedMax)) + 1 } : { mode: 'unavailable', reason: 'Enter a minimum below the maximum.' };
  const minDeposit = bounds ? nearNumber(bounds.minDeposit) : id === 'lp' ? 1.2 : 1;
  const maxDeposit = bounds ? nearNumber(bounds.maxDeposit) : id === 'lp' ? 3 : 2;

  /* The form reads and writes the provider-owned LP draft only; TP and SL are
     on while their value is not zero, and unticking writes 0. */
  // Signed out or still loading: show the V2 form (the button only connects the wallet). Signed in: the server's switch decides.
  const gridV2 = id === 'grid' && (hireOptions ? hireOptions.gridV2 === true : true);
  const values: Record<string, unknown> = {
    ...exit, agentName, maxOrders: gridV2 ? maxOrders : '4', deposit: text, ai: draft.ai, compoundOn: draft.compound, minFeeBps: draft.minFeeBps,
    tpOn: !isZero(draft.takeProfitPct), takeProfitPct: draft.takeProfitPct,
    slOn: !isZero(draft.stopLossPct), stopLossPct: draft.stopLossPct,
  };
  const set = (k: string, v: unknown) => {
    if (k === 'deposit') setText(String(v));
    else if (k === 'agentName') setAgentName(String(v));
    else if (k === 'maxOrders') setMaxOrders(String(v));
    // Grid keys are distinct from the LP mode-row keys (tpOn, slOn), which write the LP draft.
    else if (k === 'gridTpOn' || k === 'gridSlOn') setExit(e => ({ ...e, [k]: v === true }));
    else if (k === 'gridTakeProfit' || k === 'gridStopLoss') setExit(e => ({ ...e, [k]: String(v) }));
    else if (k === 'ai') actions.setLpField('ai', v === true);
    else if (k === 'compoundOn') actions.setLpField('compound', v === true);
    else if (k === 'tpOn') actions.setLpField('takeProfitPct', v === true ? '20' : '0');
    else if (k === 'slOn') actions.setLpField('stopLossPct', v === true ? '15' : '0');
    else if (k === 'minFeeBps' || k === 'takeProfitPct' || k === 'stopLossPct') actions.setLpField(k, String(v));
  };
  const stepPrice = (key: 'minPrice' | 'maxPrice', bins: number) => {
    const typed: number | null = parsePrice(draft[key]);
    const base = typed !== null ? pointOf(typed) : point;
    if (base !== null) actions.setLpField(key, priceAt(base - bins));
  };
  const presets = gridV2 ? GRID_V2_PRESETS : PRESETS[id];
  const selectedPreset = id === 'lp' ? draft.rangeMode : gridV2 ? gridPreset : 'grid-v1';
  const gridForm = gridV2 ? gridFormFrom({ serverGridV2: options?.gridV2 === true, preset: gridPreset, orders: maxOrders, exit }) : undefined;
  // The demo body: the current form values, no name (a public page never shows visitor text). The server validates with the live parsers.
  const tryDemo = async () => {
    if (demoBusy) return;
    setDemoBusy(true); setDemoError('');
    try {
      const deposit = depositYocto(text).toString(), g = gridFormFrom({ serverGridV2: true, preset: gridPreset, orders: maxOrders, exit })!;
      const body = id === 'grid' ? { kind: 'grid', pair: 'usdc-wnear', depositYocto: deposit, grid: { preset: g.preset, orders: Number(g.orders), stopLossPct: Number(g.stopLossPct), takeProfitPct: Number(g.takeProfitPct) } }
        : { kind: 'lp', pair: 'usdc-wnear', depositYocto: deposit, lp: { range: draft.rangeMode === 'server' ? { mode: 'server' } : { mode: 'explicit', minPrice: draft.minPrice.trim(), maxPrice: draft.maxPrice.trim() },
          ai: draft.ai, compound: draft.compound ? { on: true, minFeeBps: Number(draft.minFeeBps) } : { on: false }, stopLossPct: Number(draft.stopLossPct), takeProfitPct: Number(draft.takeProfitPct) } };
      go('/demo/' + (await api<{ id: string }>('/api/demo', body)).id);
    } catch { setDemoError('Could not create the demo agent. Check the settings and the demo limits.'); }
    finally { setDemoBusy(false); }
  };
  const sections = [
    { title: 'Agent', fields: [
      { k: 'agentName', label: 'Agent name', type: 'text', hint: nameBad ? 'Letters, digits, spaces and . _ - only, up to 40 characters.' : undefined },
      { k: 'deposit', label: 'Deposit', type: 'stepper', step: 0.1, min: minDeposit, max: maxDeposit, floor: minDeposit, preciseStep: true, suffix: 'NEAR',
      tooltip: demoMode ? `${minDeposit} to ${maxDeposit} NEAR.` : `${minDeposit} to ${maxDeposit} NEAR. The 0.5 NEAR DCL registration is paid separately from your wallet.` },
      ...(id === 'grid' ? [gridV2
        ? { k: 'maxOrders', label: 'Max orders', type: 'stepper', step: 2, min: 2, max: 4, floor: 2,
          hint: maxOrders !== '2' && maxOrders !== '4' ? 'Choose 2 or 4 orders.' : undefined,
          tooltip: '4: two buys and two sells, about 0.1 NEAR each. 2: one buy and one sell, about 0.2 NEAR each.' }
        : { k: 'maxOrders', label: 'Max orders', type: 'stepper', step: 1, min: 4, max: 4, locked: true,
          tooltip: 'The grid keeps at most four resting orders: two buys and two sells. Fixed in this version.' }] : []),
    ] },
    { title: 'Pool', fields: [{ k: 'pool', type: 'pool', pool: POOL }] },
  ];

  return (
    <div className={`fl-shell fl-deploy-page fl-deploy-polished${id === "grid" ? " fl-grid-deploy" : ""}`} style={{ maxWidth: 1080 }} data-testid={`deploy-${id}-screen`}>
      <Button variant="ghost" size="sm" icon={<span style={{ display: "grid", placeItems: "center", transform: "rotate(180deg)" }}><Icon name="arrow-right" size={13} /></span>} onClick={() => go("/")}>Back to marketplace</Button>

      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 24, flexWrap: "wrap", margin: "20px 0 26px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ width: 52, height: 52, borderRadius: "var(--radius-sm)", background: active.tint, color: active.color, display: "grid", placeItems: "center" }}>
            <Icon name={active.icon} size={35} />
          </span>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <h1 style={{ font: "var(--type-page-title)" }}>Deploy your <span style={{ color: active.color }}>{active.label.replace(" Agent", "")}</span> Agent</h1>
            <p style={{ font: "var(--weight-regular) var(--text-sm)/var(--leading-normal) var(--font-sans)", color: "var(--text-muted)" }}>{active.blurb}</p>
          </div>
        </div>
        {switchOn ? <SegmentedToggle accent value={demoMode ? 'demo' : 'live'} onChange={pick} options={[{ value: 'demo', label: 'Demo' }, { value: 'live', label: 'Live' }]} /> : null}
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 22, flexWrap: "wrap" }}>
        {DEPLOY_TABS.map((k) => (
          <button key={k.id} type="button" onClick={() => go(k.route)}
            style={{ cursor: "pointer", font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: k.id === id ? k.color : "var(--text-subtle)", background: k.id === id ? k.tint : "transparent", border: `1px solid ${k.id === id ? k.color : "var(--line-1)"}`, borderRadius: 999, padding: "8px 14px", display: "flex", alignItems: "center", gap: 7 }}>
            <Icon name={k.icon} size={13} />{k.label}
          </button>
        ))}
        <span aria-disabled="true" title={LOCKED_TAB.title}
          style={{ cursor: "not-allowed", font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--text-disabled)", background: "transparent", border: "1px solid var(--line-1)", borderRadius: 999, padding: "8px 14px", display: "flex", alignItems: "center", gap: 7 }}>
          <Icon name={LOCKED_TAB.icon} size={13} />{LOCKED_TAB.label}
        </span>
      </div>

      <form className="fl-deploy-form" style={{ border: "1px solid var(--border-card)", borderTop: `2px solid ${active.color}`, borderRadius: "var(--radius-md)", background: "var(--surface-card)", padding: 24 }} onSubmit={event => {
        event.preventDefault();
        if (demoMode || !account || disabled) return;
        void actions.prepareHire(id, text, id === 'lp' ? lpDraft : undefined, gridForm, agentName).then(jobId => { if (jobId) setRunId(jobId); });
      }}>
        <div className="fl-deploy-providers" aria-label="Protocols">
          {(id === 'lp' ? LP_VENUES : VENUES).map((venue) => (
            <span className="fl-deploy-provider" key={venue.label} title={venue.label}>
              <img src={venue.asset} alt="" />
              <span>{venue.label}</span>
            </span>
          ))}
        </div>
        <div style={{ display: "grid", gap: 14, marginBottom: presets.length ? 26 : 18 }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: presets.length ? "space-between" : "flex-end", gap: 16, flexWrap: "wrap" }}>
            {presets.length ? <span className="fl-eyebrow">Execution model</span> : null}
            <span className="fl-deploy-form-links">
              <a href={HELP_LINKS[id].guide} target="_blank" rel="noreferrer">Guides</a>
              <a href={HELP_LINKS[id].video} target="_blank" rel="noreferrer">Tutorial Videos</a>
            </span>
          </div>
          {presets.length ? <div style={{ display: "grid", gridTemplateColumns: `repeat(${presets.length === 1 ? "auto-fill" : "auto-fit"}, minmax(200px, 1fr))`, gap: 10 }}>
            {presets.map((p) => {
              const on = p.id === selectedPreset;
              return (
                <button key={p.id} type="button" onClick={() => {
                  // As in the BNB product, a preset overwrites the TP and SL values and leaves both checkboxes as they are.
                  if (gridV2 && 'set' in p) { setGridPreset(p.id as GridForm['preset']); setExit(e => applyGridPreset(e, p.id as GridForm['preset'])); }
                }}
                  style={{ position: "relative", textAlign: "left", cursor: "pointer", display: "grid", gap: 6, padding: "12px 14px", borderRadius: "var(--radius-sm)", background: on ? active.tint : "var(--surface-sunken)", border: `1px solid ${on ? active.color : "var(--line-1)"}` }}>
                  <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: on ? active.color : "var(--ink-1)" }}>{p.label}</span>
                  {p.gap ? <span style={{ font: "var(--weight-medium) var(--text-xs)/1 var(--font-mono)", color: on ? active.color : "var(--text-muted)" }}>{p.gap}</span> : null}
                  <span style={{ font: "var(--weight-regular) var(--text-xs)/var(--leading-normal) var(--font-sans)", color: "var(--text-subtle)" }}>{p.note}</span>
                </button>
              );
            })}
          </div> : null}
        </div>

        <div style={{ display: "grid", gap: 24 }}>
          {sections.map((s) => <Group key={s.title} section={s} values={values} set={set} />)}
          {gridV2 ? <Group section={GRID_EXIT} values={values} set={set} /> : null}
          {id === 'lp' ? <LiquidityChart poolAddress={DCL_POOL_KEY} geometry={chartGeometry} range={chartRange} legend={{ range: 'your range' }} /> : null}
          {id === 'lp' && draft.rangeMode === 'explicit' ? (
            <Group section={{ title: 'Price range', fields: [] }} values={values} set={set}>
              <div style={{ display: "grid", gap: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, alignItems: "center", font: "var(--weight-medium) var(--text-xs)/1.4 var(--font-mono)", color: "var(--text-subtle)" }}>
                  <span>{point === null ? 'Pool price unavailable. Type both prices.' : `Price read at load ${priceAt(point)} USDC per NEAR · point ${point}`}</span>
                  <span>1 point = 0.01%</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 16 }}>
                  <PriceRangeBox label="Minimum price" displayValue={draft.minPrice} onDisplayChange={(v: string) => actions.setLpField('minPrice', v)}
                    onStep={(bins: number) => stepPrice('minPrice', bins)} currentPrice={currentPrice} quoteSymbol="USDC" />
                  <PriceRangeBox label="Maximum price" displayValue={draft.maxPrice} onDisplayChange={(v: string) => actions.setLpField('maxPrice', v)}
                    onStep={(bins: number) => stepPrice('maxPrice', bins)} currentPrice={currentPrice} quoteSymbol="USDC" />
                </div>
              </div>
            </Group>
          ) : null}
          {id === 'lp' ? <Group section={{ title: 'Position management', fields: [{ k: 'modeRowsUI', type: 'modeRows', modes: MODES }] }} values={values} set={set} /> : null}
        </div>

        <div style={{ display: "grid", gap: 14, marginTop: 24, paddingTop: 20, borderTop: "1px solid var(--line-1)" }}>
          {demoMode ? null : <>
            <span className="fl-eyebrow">Hire the agent wallet</span>
            <p style={{ margin: 0, color: "var(--text-muted)", font: "var(--type-body-sm)" }}>Caps 0.25 NEAR per transaction and {daily} per day · DCL registration 0.5 NEAR from your wallet, locked{id === 'lp' && amount !== null ? ` · LP position ${initialPosition}` : ''}</p>
          </>}
          <div style={{ display: "grid", gap: 12 }}>
            <button type={account && !demoMode ? 'submit' : 'button'} style={busyBtn(disabled, { ...primaryBtn, background: active.color })} disabled={disabled}
              onClick={demoMode ? () => { void tryDemo(); } : !account ? () => { void actions.login(); } : undefined}>
              {demoMode ? 'Start demo agent' : !account ? 'Connect wallet to hire' : !options && !optionsError ? 'Loading...' : 'Prepare hire'}
            </button>
            {demoMode ? <p style={{ margin: 0, color: "var(--text-muted)", font: "var(--type-body-sm)" }}>Demo runs on live prices and simulates the fills. No wallet, no deposit, nothing is signed.</p> : null}
            {reason ? <p role="status" style={{ color: "var(--loss)", margin: 0 }}>{reason}</p> : null}
            {demoMode && demoError ? <p role="status" style={{ color: "var(--loss)", margin: 0 }}>{demoError}</p> : null}
          </div>
          {runId ? <NearHireRun jobId={runId} go={go} onClose={() => setRunId(null)} ownMount /> : null}
          {message && !runId && !demoMode ? <p role="status" style={{ font: "var(--type-mono-xs)", color: "var(--text-subtle)" }}>{message}</p> : null}
        </div>
      </form>
    </div>
  );
}
