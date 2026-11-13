import React from 'react';
import { createNearActions, TRANSFER_PREFIX, type TransferStore } from './near-actions';
import { api, sign, sendCall, clearSelectedWallet, transferWallet } from './near-wallet';

const Session = React.createContext<ReturnType<typeof createNearActions> | null>(null);

/** Spec UI step 3, section 4: the pending-transfer markers live in localStorage, one key per job. Each call can throw;
    the actions treat a throw as storage unavailable. */
export const transferStore: TransferStore = {
  get: key => window.localStorage.getItem(key),
  set: (key, value) => window.localStorage.setItem(key, value),
  remove: key => window.localStorage.removeItem(key),
  keys: () => Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i)).filter((k): k is string => k !== null && k.startsWith(TRANSFER_PREFIX)),
};

/** A cross-tab lock when the browser has the Web Locks API, else none. */
export function lock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' && 'locks' in navigator ? navigator.locks : undefined;
  // The lock is held until fn's promise settles; the request resolves with fn's value.
  return locks ? locks.request(name, fn) as unknown as Promise<T> : fn();
}

export function NearSessionProvider({ children }: { children: React.ReactNode }) {
  const [, render] = React.useReducer(n => n + 1, 0);
  const [actions] = React.useState(() => createNearActions({ api, sign, sendCall, now: Date.now, clearWallet: clearSelectedWallet, changed: render, transferWallet, transferStore, lock }));
  React.useEffect(() => {
    void actions.mount();
    const refresh = () => { if (document.visibilityState === 'visible') void actions.refresh(); };
    const onStorage = (event: StorageEvent) => actions.syncTransfer(event.key, event.newValue);
    const timer = window.setInterval(refresh, 15000);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('storage', onStorage);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh); window.removeEventListener('storage', onStorage); };
  }, [actions]);
  return <Session.Provider value={{ ...actions }}>{children}</Session.Provider>;
}

export function useNearSession() {
  const session = React.useContext(Session);
  if (!session) throw new Error('Missing NEAR session provider.');
  return session;
}
