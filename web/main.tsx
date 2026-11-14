import './app/globals.css';
import { createRoot } from 'react-dom/client';
import { JudgeGuide } from './components/judge/JudgeGuide';

const judge = window.location.pathname === '/judge' || window.location.pathname === '/judge/';
const root = createRoot(document.getElementById('root')!);
if (judge) root.render(<JudgeGuide />);
else {
  // Reading the judge guide must not initialize a wallet connector or session.
  void Promise.all([import('./components/KitApp'), import('./lib/near-session')]).then(([{ KitApp }, { NearSessionProvider }]) => {
    root.render(<NearSessionProvider><KitApp /></NearSessionProvider>);
  });
}
