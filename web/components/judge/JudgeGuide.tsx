import React from 'react';
import { Icon } from '@/design-system';
import { RESOURCES } from '@/lib/design-resources';
import { AGENT_PAGES, ATTACK_CHECKS, ATTACK_LOG, COMMANDS, DOCS, EXECUTION_EVIDENCE, FEATURES, HIRE_STEPS, LIMITS, REPO, TRACKS, TUTORIAL_VIDEOS, VIDEOS, source, type Evidence, type Video } from '@/lib/judge-data';
import { SigmaHero } from './SigmaHero';
import './judge.css';

function EvidenceLinks({ items }: { items: Evidence[] }) {
  return <div className="fl-jg-ev">{items.map(item => <a key={item.href + item.label} href={item.href}
    {...(item.href.startsWith('https://') ? { target: '_blank', rel: 'noreferrer' } : {})}>
    {item.label}{item.href.startsWith('https://') && <Icon name="external" size={11} />}
  </a>)}</div>;
}

function Section({ id, eyebrow, title, sub, children }: { id: string; eyebrow: string; title: string; sub?: string; children: React.ReactNode }) {
  return <section id={id} className="fl-jg-sec" aria-labelledby={`${id}-title`}>
    <div className="fl-jg-heading"><span className="fl-jg-eyebrow">{eyebrow}</span><h2 id={`${id}-title`} className="fl-jg-h2">{title}</h2>{sub && <p className="fl-jg-sub">{sub}</p>}</div>
    {children}
  </section>;
}

function Command({ title, cmd }: { title: string; cmd: string }) {
  const [state, setState] = React.useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  React.useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    let copied = false;
    try { await navigator.clipboard.writeText(cmd); copied = true; } catch {
      const field = document.createElement('textarea');
      field.value = cmd; field.style.position = 'fixed'; field.style.opacity = '0';
      const focused = document.activeElement;
      document.body.appendChild(field); field.select();
      try { copied = document.execCommand('copy'); } catch { /* The command remains selectable. */ }
      field.remove();
      if (focused instanceof HTMLElement) focused.focus();
    }
    setState(copied ? 'copied' : 'failed');
    clearTimeout(timer.current); timer.current = setTimeout(() => setState('idle'), 2400);
  }
  return <div className="fl-jg-cmd">
    <span className="fl-jg-cmdtitle">{title}</span>
    <div className="fl-jg-cmdbox"><pre>{cmd}</pre><button type="button" onClick={() => void copy()} aria-label={`Copy: ${title}`} className={`fl-jg-btn${state === 'copied' ? ' fl-jg-btn--on' : ''}`}>
      <Icon name={state === 'copied' ? 'success' : 'copy'} size={13} /><span aria-live="polite">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Select to copy' : 'Copy'}</span>
    </button></div>
  </div>;
}

function PlayIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4v16l14-8z" /></svg>;
}

function VideoCard({ video }: { video: Video }) {
  const [playing, setPlaying] = React.useState(false);
  let youtubeId: string | null = null;
  if (video.url) {
    try {
      const url = new URL(video.url);
      const candidate = url.hostname === 'youtu.be' ? url.pathname.slice(1) : ['www.youtube.com', 'youtube.com'].includes(url.hostname) ? url.searchParams.get('v') : null;
      if (candidate && /^[A-Za-z0-9_-]{11}$/.test(candidate)) youtubeId = candidate;
    } catch { /* A missing video is never rendered as a player. */ }
  }
  return <article className="fl-jg-video">
    {playing && youtubeId ? <div className="fl-jg-vframe"><iframe title={video.title} src={`https://www.youtube-nocookie.com/embed/${youtubeId}?autoplay=1&rel=0`} referrerPolicy="strict-origin-when-cross-origin" allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen /></div>
      : youtubeId ? <button type="button" className="fl-jg-vframe" aria-label={`Play: ${video.title}`} onClick={() => setPlaying(true)}><img src={`https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`} alt="" loading="lazy" /><span className="fl-jg-vplay"><PlayIcon /></span></button>
        : <div className="fl-jg-vframe"><span className="fl-jg-vplay"><PlayIcon /></span>{video.url ? 'Watch the walkthrough using the link below' : 'Video coming soon'}</div>}
    <h3 className="fl-jg-h3">{video.title}</h3><p className="fl-jg-p">{video.description}</p>
    {video.url && <EvidenceLinks items={[{ label: 'Open video', href: video.url }]} />}
  </article>;
}

export function JudgeGuide() {
  React.useEffect(() => {
    document.title = '4lpha NEAR · Judge guide';
    const robots = document.createElement('meta');
    robots.name = 'robots'; robots.content = 'noindex, nofollow';
    document.head.appendChild(robots);
    document.getElementById(window.location.hash.slice(1))?.scrollIntoView();
    return () => robots.remove();
  }, []);
  return <>
    <nav className="fl-jg-nav" aria-label="Judge guide"><div className="fl-jg-navin">
      <a className="fl-jg-logo" href="/" aria-label="4lpha home"><img className="fl-brand__logo" src={RESOURCES.brandLogo} alt="4lpha" /></a>
      <span className="fl-jg-navtag">Judge guide</span>
      <div className="fl-jg-navlinks"><a href="#videos">Videos</a><a href="#run">Try it</a><a href="#connect">Visual guide</a><a href="#security">Security proof</a><a href="#features">Features</a><a href="#tracks">Tracks</a><a href="#limits">Limits</a></div>
      <a className="fl-jg-pill fl-jg-pill--brand" href="/">Open the app <Icon name="external" size={12} /></a>
    </div></nav>
    <main className="fl-jg">
      <header className="fl-jg-hero"><div className="fl-jg-intro">
        <div className="fl-jg-links"><span className="fl-jg-eyebrow">For judges · NEAR HACKATHON</span><a className="fl-jg-pill" href="/judge.md" target="_blank" rel="noreferrer">Judge brief (Markdown)<Icon name="external" size={12} /></a></div>
        <h1 className="fl-jg-h1">4lpha: hosted DeFi agents marketplace on NEAR.</h1>
        <p className="fl-jg-lead">Deposit NEAR, set the limits and let an agent run your Grid, liquidity position or buying plan on Rhea Finance. One custody wallet per agent, an owner-controlled policy and a no-funds demo to try it yourself.</p>
        <div className="fl-jg-stats">{[['4', 'strategies to simulate'], [String(AGENT_PAGES.filter(agent => !agent.simulated).length), 'real-fund agent pages'], ['7', 'offline attacks stopped'], ['1', 'live attack refused']].map(([value, label]) => <div className="fl-jg-stat" key={label}><b>{value}</b><span>{label}</span></div>)}</div>
        <div className="fl-jg-links"><a className="fl-jg-pill fl-jg-pill--brand" href="#run"><PlayIcon />Try without funds</a><a className="fl-jg-pill" href="#connect">Visual guide</a><a className="fl-jg-pill" href="#security">Security attack proof</a><a className="fl-jg-pill" href="#videos">Watch the demo</a><a className="fl-jg-pill" href={REPO} target="_blank" rel="noreferrer">GitHub <Icon name="external" size={12} /></a></div>
      </div><SigmaHero /></header>

      <Section id="start" eyebrow="Start here" title="Open the agents." sub="Public read-only pages supplied by the operator on 14 Nov 2026. No wallet connection is needed to inspect them. The page shows each agent's current status, which can change over time.">
        <div className="fl-jg-grid fl-jg-grid--two">{AGENT_PAGES.map(agent => <article className="fl-jg-card" key={agent.url}>
          <span className={`fl-jg-badge${agent.simulated ? '' : ' fl-jg-badge--proven'}`}>{agent.simulated ? 'Demo · Simulated funds' : 'NEAR mainnet · Real funds'}</span>
          <h3 className="fl-jg-h3">{agent.title}</h3><p className="fl-jg-p">{agent.description}</p>
          <EvidenceLinks items={[{ label: agent.simulated ? `Open ${agent.title}` : 'Open agent page', href: agent.url }]} />
        </article>)}</div>
        <p className="fl-jg-sub">Or start your own no-funds simulation. Keep Demo selected on the deploy page:</p>
        <EvidenceLinks items={[{ label: 'Try Grid', href: '/deploy/grid' }, { label: 'Try LP', href: '/deploy/lp' }, { label: 'Try Schedule buy', href: '/deploy/trade/schedule' }, { label: 'Try Auto DCA', href: '/deploy/trade/dca' }]} />
      </Section>

      <Section id="videos" eyebrow="Video walkthroughs" title="See it before you try it." sub="Start with the main demo, then watch a tutorial for each strategy. Play here or open the video on YouTube.">
        <div className="fl-jg-grid" style={{ maxWidth: 760, width: '100%', margin: '0 auto' }}>{VIDEOS.map(video => <VideoCard key={video.title} video={video} />)}</div>
        <span className="fl-jg-eyebrow">One tutorial per strategy</span>
        <div className="fl-jg-tutorials">{TUTORIAL_VIDEOS.map(video => <VideoCard key={video.title} video={video} />)}</div>
      </Section>

      <Section id="run" eyebrow="A few minutes, no wallet" title="Try it yourself." sub="Start with a simulation in the app. Then reproduce the security checks locally, without keys or a network connection.">
        <div className="fl-jg-grid">
          {[['Open a deploy page', 'Choose Grid, LP, Schedule buy or Auto DCA. Leave the Demo | Live switch on Demo.'], ['Start a demo agent', 'Set its parameters and press Start demo agent. Its page explicitly says the balances and actions are simulated.'], ['Inspect the result', 'Read the decisions, activity and simulation limits. Find it again under Demo agents on your account page, or stop it when you finish.']].map(([title, text], i) => <article className="fl-jg-card" key={title}><span className="fl-jg-stepn">0{i + 1}</span><h3 className="fl-jg-h3">{title}</h3><p className="fl-jg-p">{text}</p></article>)}
        </div>
        <div className="fl-jg-links"><a className="fl-jg-pill fl-jg-pill--brand" href="/deploy/grid">Open Grid demo</a><a className="fl-jg-pill" href="/account">My demo agents</a></div>
        <p className="fl-jg-note">This is a simulation on live prices, not a replay or proof of profit. It advances with the market; fills are not guaranteed during a short visit. Schedule buy and Auto DCA need about 30 minutes of recorded price history before their first simulated buy.</p>
      </Section>

      <Section id="security" eyebrow="Security proof" title="We attacked our own agent." sub="Two separate checks: an actual mainnet policy refusal using the agent's own key, and reproducible offline attacks against the product's guards.">
        <article className="fl-jg-card fl-jg-proof">
          <span className="fl-jg-badge fl-jg-badge--proven">Mainnet · 13 Nov 2026</span>
          <h3 className="fl-jg-h3">A stolen-key scenario. A direct payment refused.</h3>
          <p className="fl-jg-p">Using the real agent wallet's own custody API key, we asked OutLayer to send 0.001 NEAR to an existing account outside its whitelist. The wallet was not frozen. OutLayer rejected the request, and the balance was unchanged across two finalized blocks.</p>
          <pre className="fl-jg-log" aria-label="Recorded mainnet attack result">{ATTACK_LOG}</pre>
          <p className="fl-jg-p">Condensed from the recorded operator log, with addresses omitted. This page does not run a live attack. There is no transaction hash for the refusal: the policy blocked it before signing.</p>
          <EvidenceLinks items={[{ label: 'Recorded log in README', href: `${REPO}#attack-demo` }, { label: 'Live probe source', href: source('scripts/attack-demo-live.mjs') }, { label: 'Policy builder', href: source('src/core/policy.ts') }]} />
        </article>
        <div className="fl-jg-grid fl-jg-grid--two">{ATTACK_CHECKS.map(check => <article className="fl-jg-card" key={check.title}><span className="fl-jg-badge fl-jg-badge--proven">Offline · {check.count}</span><h3 className="fl-jg-h3">{check.title}</h3><p className="fl-jg-p">{check.text}</p><EvidenceLinks items={[{ label: 'Guard source', href: source(check.path) }]} /></article>)}</div>
        <div className="fl-jg-card">
          <Command title="Reproduce the offline attack demo (after installing dependencies)" cmd="npm run attack-demo" />
          <p className="fl-jg-p">Runs the product's own code with forged inputs. No key, wallet, network request or payment. Expected last line:</p>
          <pre className="fl-jg-log">Summary: 7 attacks, 7 stopped, 2 detected not prevented (tokens, and NEAR through wrapping, with a stolen key).</pre>
          <EvidenceLinks items={[{ label: 'Offline demo source', href: source('scripts/attack-demo.mjs') }, { label: 'Regression tests', href: source('test/attack-demo.test.ts') }, { label: 'Setup commands', href: '#code' }]} />
        </div>
        <aside className="fl-jg-note fl-jg-note--warn"><strong>The limit: detected, not prevented.</strong> A stolen custody key can move tokens through <code>/wallet/v1/call</code>, or wrap NEAR and move the wNEAR. The policy does not inspect those inner recipients or amounts. The offline demo shows the watchdog detecting both outflows after they happen. Its alert and the owner's freeze do not undo a loss. The seven blocked cases do not mean every theft path is blocked.</aside>
      </Section>

      <Section id="connect" eyebrow="Visual guide" title="Hire a NEAR agent, step by step." sub="The live hire flow, screen by screen. These are the app's own screens with sample accounts and balances, not transaction evidence. Click any image to open it full size.">
        <div className="fl-jg-steps">{HIRE_STEPS.map((step, i) => <article className="fl-jg-step" key={step.title}>
          <div className="fl-jg-stepcopy"><span className="fl-jg-stepn">{String(i + 1).padStart(2, '0')}</span><h3 className="fl-jg-h3">{step.title}</h3><p className="fl-jg-sub">{step.text}</p>
            {step.link && <div className="fl-jg-links"><a className="fl-jg-pill fl-jg-pill--brand" href={step.link.href}>{step.link.label}<Icon name="external" size={12} /></a></div>}
            {step.note && <p className="fl-jg-note">{step.note}</p>}
          </div>
          <a className={`fl-jg-shot${step.image.narrow ? ' fl-jg-shot--narrow' : ''}`} href={step.image.src} target="_blank" rel="noreferrer" title="Open full size">
            <img src={step.image.src} alt={step.image.alt} width={step.image.width} height={step.image.height} loading="lazy" decoding="async" />
          </a>
        </article>)}</div>
        <EvidenceLinks items={[{ label: 'Hire state machine', href: source('src/core/hire.ts') }, { label: 'Owner and funding tests', href: source('test/hire.test.ts') }, { label: 'Documentation', href: DOCS }]} />
      </Section>

      <Section id="features" eyebrow="Features and evidence" title="What is built, and what is proven." sub="Open the NEAR mainnet receipts for each recorded action. Strategy snapshots come from the README; earlier verification runs and third-party examples are labelled separately.">
        <EvidenceLinks items={[{ label: 'Full evidence ledger in README', href: `${REPO}#mainnet-evidence` }]} />
        <div className="fl-jg-grid fl-jg-grid--two">{FEATURES.map(feature => <article className="fl-jg-card" key={feature.title}>
          <span className={`fl-jg-badge${feature.proven ? ' fl-jg-badge--proven' : ''}`}>{feature.status}</span><h3 className="fl-jg-h3">{feature.title}</h3><p className="fl-jg-p">{feature.description}</p>
          <div className="fl-jg-heading"><span className="fl-jg-eyebrow">Recorded on mainnet</span><ul className="fl-jg-list">{feature.recorded.map(item => <li key={item}>{item}</li>)}</ul></div>
          {feature.proofs.map(group => <div className="fl-jg-proofgroup" key={group.title}><span className="fl-jg-cmdtitle">{group.title}</span><EvidenceLinks items={group.links} /></div>)}
          <EvidenceLinks items={[{ label: 'Open demo settings', href: feature.route }, ...feature.evidence]} />
        </article>)}</div>
        <div className="fl-jg-heading"><h3 className="fl-jg-h3">Shared execution and recovery</h3><p className="fl-jg-sub">Evidence for the wallet controls, receipt handling and recovery behind the strategies.</p></div>
        <div className="fl-jg-grid">{EXECUTION_EVIDENCE.map(item => <article className="fl-jg-card" key={item.title}>
          <h4 className="fl-jg-h3">{item.title}</h4><p className="fl-jg-p">{item.description}</p>
          {item.proofs.map(group => <div className="fl-jg-proofgroup" key={group.title}><span className="fl-jg-cmdtitle">{group.title}</span><EvidenceLinks items={group.links} /></div>)}
          <p className="fl-jg-note">{item.note}</p><EvidenceLinks items={item.evidence} />
        </article>)}</div>
        <article className="fl-jg-card"><span className="fl-jg-badge">Paper only</span><h3 className="fl-jg-h3">Degen: meme.cooking auctions</h3><p className="fl-jg-p">A separate paper agent watches live meme.cooking auctions, applies deterministic screens and asks NEAR AI whether to join. It never makes a real deposit or swap. A NEAR wallet sign-in is required to create one; its page is public and read-only.</p><EvidenceLinks items={[{ label: 'Open paper agent settings', href: '/deploy/trade/degen' }, { label: 'Decision code', href: source('src/core/meme-cycle.ts') }]} /></article>
      </Section>

      <Section id="tracks" eyebrow="Hackathon tracks" title="Where each track is covered.">
        {TRACKS.map(track => <article className="fl-jg-prize" key={track.id}><div className="fl-jg-items"><span className="fl-jg-eyebrow">{track.id}</span><h3>{track.title}</h3><p className="fl-jg-sub">{track.description}</p><EvidenceLinks items={track.evidence} /></div><ul className="fl-jg-list">{track.items.map(item => <li key={item}>{item}</li>)}</ul></article>)}
      </Section>

      <Section id="code" eyebrow="Source" title="Run the code." sub="Node.js 22.22.2 or newer, npm and git. The commands below work in Windows Command Prompt, PowerShell and POSIX shells. No .env.local is needed for the offline tests.">
        {COMMANDS.map(command => <Command key={command.title} {...command} />)}
        <p className="fl-jg-note">Expected: the build succeeds, both test suites report zero failures, and the attack demo prints the summary shown above. These commands do not start a live worker.</p>
        <EvidenceLinks items={[{ label: 'README', href: REPO }, { label: 'MIT license', href: source('LICENSE') }]} />
      </Section>

      <Section id="limits" eyebrow="Read before judging" title="Known limits, stated plainly."><ul className="fl-jg-list">{LIMITS.map(limit => <li key={limit}>{limit}</li>)}</ul></Section>
      <footer className="fl-jg-footer"><span>4lpha NEAR · Built at NEAR HACKATHON</span><div className="fl-jg-links"><a href="/">Open the app</a><a href={DOCS} target="_blank" rel="noreferrer">Docs</a><a href={REPO} target="_blank" rel="noreferrer">GitHub</a></div></footer>
    </main>
  </>;
}
