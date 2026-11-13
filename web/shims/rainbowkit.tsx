import type { ReactNode } from 'react';
import { useNearSession } from '@/lib/near-session';

function Custom({ children }: { children: (state: {
  mounted: boolean;
  account: { displayName: string } | undefined;
  chain: { unsupported: false } | undefined;
  openConnectModal: () => void;
  openAccountModal: () => void;
  openChainModal: () => void;
}) => ReactNode }) {
  const actions = useNearSession();
  const { mounted, account: accountId } = actions.state;

  return children({
    mounted,
    account: accountId ? { displayName: accountId.length <= 16 ? accountId : `${accountId.slice(0, 6)}...${accountId.slice(-4)}` } : undefined,
    chain: accountId ? { unsupported: false } : undefined,
    openConnectModal: () => { void actions.login(); },
    openAccountModal: () => {
      if (accountId && window.confirm(`Sign out of ${accountId}?`)) void actions.logout();
    },
    openChainModal: () => {},
  });
}

export const ConnectButton = { Custom };
