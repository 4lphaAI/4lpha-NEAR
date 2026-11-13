import './app/globals.css';
import { createRoot } from 'react-dom/client';
import { KitApp } from './components/KitApp';
import { NearSessionProvider } from './lib/near-session';

createRoot(document.getElementById('root')!).render(<NearSessionProvider><KitApp /></NearSessionProvider>);
