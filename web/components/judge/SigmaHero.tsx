import React from 'react';
import { SIGMA_LINES } from '@/lib/judge-data';
import { SIGMA_ANIMATIONS, sigmaSpriteOffset } from '@/lib/sigma-pet';

export function SigmaHero() {
  const [line, setLine] = React.useState(0);
  const [frame, setFrame] = React.useState(0);
  React.useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    let timer: ReturnType<typeof setInterval> | undefined;
    const animate = () => {
      clearInterval(timer);
      if (!media.matches) timer = setInterval(() => setFrame(f => f + 1), SIGMA_ANIMATIONS.waving.intervalMs);
      else setFrame(0);
    };
    animate();
    media.addEventListener('change', animate);
    return () => { clearInterval(timer); media.removeEventListener('change', animate); };
  }, []);
  const offset = sigmaSpriteOffset('waving', frame);
  return <div className="fl-jg-sigma">
    <div className="fl-jg-bubble">
      <p aria-live="polite">{SIGMA_LINES[line]}</p>
      <div className="fl-jg-bubbledots" aria-hidden="true">{SIGMA_LINES.map((_, i) => <span key={i} className={i === line ? 'on' : ''} />)}</div>
    </div>
    <button type="button" className="fl-jg-sigmabtn" onClick={() => setLine(i => (i + 1) % SIGMA_LINES.length)} aria-label="Sigma, next line" title="Click me">
      <span className="fl-sigma__sprite" aria-hidden="true" style={{ width: 220, backgroundPosition: `${offset.x}% ${offset.y}%`, backgroundSize: '800% 900%' }} />
    </button>
  </div>;
}
