/* The agent tabs of the BSC DeployAgentScreen, in its order, limited to the agents this server offers. */
export const DEPLOY_TABS = [
  { id: 'grid', route: '/deploy/grid', label: 'Grid Agent', icon: 'grid-trading', color: 'var(--cat-grid)', tint: 'var(--cat-grid-tint)' },
  { id: 'trade', route: '/deploy/trade', label: 'Trading Agent', icon: 'yield', color: 'var(--cat-yield)', tint: 'var(--cat-yield-tint)' },
  { id: 'lp', route: '/deploy/lp', label: 'LP Agent', icon: 'lp-rebalance', color: 'var(--cat-lp)', tint: 'var(--cat-lp-tint)' },
] as const;
/* Shown after the tabs, locked: Lending is not offered on NEAR yet. Kept out of DEPLOY_TABS so nothing routes to it. */
export const LOCKED_TAB = { id: 'health', label: 'Lending Agent', icon: 'health-shield', title: 'Available after the hackathon' } as const;
