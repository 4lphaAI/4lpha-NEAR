// Judge guide content. Video and agent URLs supplied by the operator, 2026-11-14.
// Evidence is taken from the README and the recorded mainnet runs, not from demo balances.
export const REPO = 'https://github.com/4lphaAI/4lpha-NEAR';
export const DOCS = 'https://docs.4lpha.tech/NEAR';
export const source = (path: string) => `${REPO}/blob/main/${path}`;

export interface Evidence { label: string; href: string }
export interface Video { title: string; description: string; url: string | null }
export interface Feature {
  title: string;
  status: string;
  proven: boolean;
  description: string;
  note: string;
  route: string;
  evidence: Evidence[];
  transactions: Evidence[];
}

export const VIDEOS: Video[] = [
  { title: 'Main demo', description: 'The 4lpha NEAR product walkthrough: from choosing a strategy to following an agent on Rhea Finance.', url: 'https://youtu.be/LiskEYE7MjE' },
];

export const TUTORIAL_VIDEOS: Video[] = [
  { title: 'Grid Agent', description: 'Set up a Grid agent and follow its orders on Rhea DCL.', url: 'https://youtu.be/oqsXoihV0O8' },
  { title: 'LP Agent', description: 'Set up a liquidity position and follow the LP agent.', url: 'https://youtu.be/1V9U_7v7kc4' },
  { title: 'Schedule buy', description: 'Set the amount and interval for a recurring buying plan.', url: 'https://youtu.be/DCbxlC-sVyQ' },
  { title: 'Auto DCA', description: 'Configure the DCA ladder and its take-profit and stop-loss settings.', url: 'https://youtu.be/PIz6a1rvetw' },
];

export const AGENT_LINKS = {
  grid: 'https://near.4lpha.tech/account/ae5fa959-8148-485f-be55-29ea0c6ed157',
  lp: 'https://near.4lpha.tech/account/5c0fefa2-d820-4591-a625-be77dca4e61e',
  schedule: 'https://near.4lpha.tech/account/d43b9df5-e919-411f-a44a-9940b98e3a26',
  dca: 'https://near.4lpha.tech/account/5c51e35b-586d-44d6-b96b-c810ef7677ea',
  gridDemo: 'https://near.4lpha.tech/demo/33a15c85-acee-46fe-8054-2ebb5031a54d',
  lpDemo: 'https://near.4lpha.tech/demo/6ef9ea5b-a192-4d8c-bbdd-6a5682bf626d',
} as const;

export const AGENT_PAGES = [
  { title: 'Grid Agent', url: AGENT_LINKS.grid, simulated: false, description: 'A real-fund Grid agent on Rhea DCL. Open its page to inspect current status, orders, balances and activity.' },
  { title: 'LP Agent', url: AGENT_LINKS.lp, simulated: false, description: 'A real-fund LP agent on Rhea DCL. Inspect its current liquidity position, range, balances and activity.' },
  { title: 'Schedule buy', url: AGENT_LINKS.schedule, simulated: false, description: 'A recorded real-fund Schedule buy run. Inspect its buying plan and purchases. Stopped when checked on 14 Nov 2026.' },
  { title: 'Auto DCA', url: AGENT_LINKS.dca, simulated: false, description: 'A real-fund Auto DCA agent. Inspect its entry, DCA levels, holdings and activity on the current agent page.' },
  { title: 'Grid demo', url: AGENT_LINKS.gridDemo, simulated: true, description: 'An existing simulation on live market reads. Balances and fills are simulated; no real funds are used.' },
  { title: 'LP demo', url: AGENT_LINKS.lpDemo, simulated: true, description: 'An existing LP simulation on live market reads. Inspect its range, simulated liquidity and activity; no real funds are used.' },
];

export const FEATURES: Feature[] = [
  {
    title: 'Grid Agent', status: 'Mainnet order cycle proven', proven: true,
    description: 'Native limit orders on Rhea DCL, USDC/wNEAR 0.01%. A fully filled order is claimed, its payout verified from receipts, then reversed one grid step away.',
    note: 'Recorded run: four orders, a full fill, claim, reverse and reverse fill. That run was withdrawn with owner recovery tooling. The worker\'s Grid exit is not yet recorded live.',
    route: '/deploy/grid', evidence: [{ label: 'Real-fund agent', href: AGENT_LINKS.grid }, { label: 'Strategy code', href: source('src/core/grid.ts') }], transactions: [],
  },
  {
    title: 'LP Agent', status: 'Mainnet lifecycle proven', proven: true,
    description: 'Concentrated liquidity on Rhea DCL. It recenters after two confirmed out-of-range checks, with at most two rotations per day. Optional compound, stop loss and take profit.',
    note: 'Recorded run: open, automatic rotation, freeze, unfreeze and the worker\'s exit to the owner. Compound, stop loss, take profit and an accepted AI range are not yet recorded live.',
    route: '/deploy/lp', evidence: [{ label: 'Real-fund agent', href: AGENT_LINKS.lp }, { label: 'Strategy code', href: source('src/core/lp.ts') }, { label: 'AI range fence', href: source('src/core/lp-ai.ts') }], transactions: [],
  },
  {
    title: 'Schedule buy', status: 'Mainnet agent linked', proven: true,
    description: 'Buys a fixed amount in NEAR on a schedule through a pinned Rhea classic pool. Bought tokens stay in the agent wallet until the plan ends.',
    note: 'A real-fund agent is linked for inspection, alongside the no-funds demo. Its page shows the current run; full lifecycle verification remains separate.',
    route: '/deploy/trade/schedule', evidence: [{ label: 'Real-fund agent', href: AGENT_LINKS.schedule }, { label: 'Strategy code', href: source('src/core/trade.ts') }], transactions: [],
  },
  {
    title: 'Auto DCA', status: 'Mainnet agent linked', proven: true,
    description: 'One base order and a ladder of buys below the entry price. Take profit sells back to NEAR. Stop loss ends the job and returns NEAR plus the token without selling it.',
    note: 'A real-fund agent, strategy tutorial and no-funds demo are linked. The next-round restart is built, with up to eight DCA levels per round; a second round has not yet been recorded on mainnet.',
    route: '/deploy/trade/dca', evidence: [{ label: 'Real-fund agent', href: AGENT_LINKS.dca }, { label: 'Strategy code', href: source('src/core/trade.ts') }], transactions: [],
  },
];

export interface GuideStep {
  title: string;
  text: string;
  image: { src: string; alt: string; width: number; height: number; narrow?: boolean };
  link?: Evidence;
  note?: string;
}

export const HIRE_STEPS: GuideStep[] = [
  {
    title: 'Pick a strategy and connect',
    text: 'Open Deploy and choose Grid, LP, Schedule buy or Auto DCA. Set the deposit and limits. For a real hire, connect your NEAR wallet, sign the free login message and press Prepare hire. Grid is shown here.',
    image: { src: '/judge/deploy-grid.jpg', alt: 'NEAR Grid deploy screen with strategy presets, deposit, pool, exit settings and Connect wallet to hire', width: 1280, height: 1040 },
    link: { label: 'Open Deploy', href: '/deploy/grid' },
    note: 'Just exploring? Keep Demo selected to try a strategy without a wallet or funds.',
  },
  {
    title: 'Sign the wallet policy',
    text: 'The progress popup follows each step. 4lpha prepares a separate OutLayer wallet for this agent. Press Confirm in your wallet to store its spending policy. The app checks the owner and rules on chain before allowing funding.',
    image: { src: '/judge/sign-policy.jpg', alt: 'Hire popup at Sign the wallet policy, with Confirm in your wallet and the later steps still pending', width: 512, height: 689, narrow: true },
    note: 'Your wallet pays the policy storage cost, about 0.016 NEAR, plus gas. The agent deposit has not been sent yet.',
  },
  {
    title: 'Save the management link',
    text: 'Press Reveal the link and sign the message in your wallet. Copy the link to a private place, check I saved the management link, then press Confirm. You must complete this before funding.',
    image: { src: '/judge/save-link.jpg', alt: 'Save the management link step with the key hidden, Copy, the saved-link checkbox and Confirm', width: 512, height: 866, narrow: true },
    note: 'The link carries the custody API key. Keep it private: it is also your recovery access through OutLayer if 4lpha stops running.',
  },
  {
    title: 'Register the agent on DCL',
    text: 'For Grid and LP, press Confirm in your wallet to register the agent account on Rhea DCL. Wait for the registration to be confirmed before moving to funding. Schedule buy and Auto DCA skip this step.',
    image: { src: '/judge/register-dcl.jpg', alt: 'Hire popup at Register the agent on DCL, after the policy and management-link steps are complete', width: 512, height: 689, narrow: true },
    note: 'The 0.5 NEAR registration is paid by your wallet, outside the agent deposit. DCL locks this amount.',
  },
  {
    title: 'Fund with NEAR',
    text: 'The popup shows the remaining deposit and the receiving agent wallet. Press Confirm in your wallet, or use the manual-send instructions shown below it. After confirmation, the agent handles token registration, wrapping and its initial swap.',
    image: { src: '/judge/fund-near.jpg', alt: 'Funding step showing the 1 NEAR example deposit, owner and agent wallets, wallet confirmation and manual transfer instructions', width: 512, height: 886, narrow: true },
    note: 'Send only the amount shown to your own agent address. The account and amount in this illustration are examples.',
  },
  {
    title: 'Watch it work',
    text: 'When setup finishes, the app opens the agent page. Follow its status, balances, grid orders or LP position and run log. Grid and LP assets sit in DCL under the agent account; trading holdings stay in its custody wallet. A visitor with the page link can read, but only the owner can act.',
    image: { src: '/judge/agent-page.jpg', alt: 'NEAR Grid agent page with running status, owner controls, funds and open orders', width: 1440, height: 1040 },
  },
  {
    title: 'Freeze, resume or withdraw',
    text: 'Use Freeze now for an immediate stop to custody operations. The page shows Frozen and offers Unfreeze. Unfreezing leaves the agent paused until you sign Resume. To end the job, unfreeze if needed and choose Stop and withdraw: NEAR plus the other token goes back to you.',
    image: { src: '/judge/frozen-agent.jpg', alt: 'Frozen NEAR Grid agent with the Unfreeze and Stop and withdraw controls, and the resting-order warning', width: 1440, height: 1040 },
    note: 'Freeze also blocks withdrawals. It does not cancel resting DCL orders or remove liquidity already on Rhea.',
  },
];

export const ATTACK_LOG = `2026-11-13 06:52:58 UTC | NEAR mainnet
Attack: request 0.001 NEAR to a non-whitelisted account
Credential: the agent's own custody API key
Policy: stored, not frozen; target outside the whitelist

Before | finalized block 224328453 | 0.010985 NEAR
Result | HTTP 403 policy_denied
Reason | "Address '...' is not in whitelist"
After  | finalized block 224328473 | 0.010985 NEAR

PASS: nothing moved. No transaction was created.`;

export const ATTACK_CHECKS = [
  { title: 'Compromised model', count: '3 stopped', text: 'A valid range with an extra transfer instruction, a plain-text prompt injection and a range away from the current price. The range fence rejects each answer and uses a deterministic fallback.', path: 'src/core/lp-ai.ts' },
  { title: 'Forged destinations', count: '4 stopped', text: 'A native payment, ft_transfer, ft_transfer_call and storage_deposit aimed at attacker.near. The worker\'s destination guard refuses all four; a control payment to the owner passes.', path: 'src/core/evidence.ts' },
];

export const TRACKS = [
  { id: 'defi', title: 'DeFi', description: 'Autonomous strategies on NEAR-native venues, with a no-funds path for judges.', items: ['Rhea DCL limit-order Grid and concentrated-liquidity LP.', 'NEAR-only funding; the agent prepares the tokens it needs.', 'Receipt-verified outcomes and recovery after uncertain replies.', 'Demo balances on live pool reads, clearly marked as simulated.'], evidence: [{ label: 'Strategy code', href: `${REPO}/tree/main/src/core` }, { label: 'Try the demo', href: '/deploy/grid' }] },
  { id: 'security', title: 'Security', description: 'A policy boundary tested with the agent\'s own key, plus reproducible attacks against the application guards.', items: ['Owner-owned policy, native spending caps, destination whitelist and freeze.', 'No funding before the on-chain owner and policy checks pass.', 'Seven offline attacks stopped; a direct mainnet payment refused.', 'Token and wrapped-NEAR gaps disclosed alongside watchdog detection.'], evidence: [{ label: 'Attack proof', href: '#security' }, { label: 'Security tests', href: source('test/attack-demo.test.ts') }] },
  { id: 'agents', title: 'Agents', description: 'Hosted execution with a separate custody wallet and explicit limits for each agent.', items: ['One wallet per agent; the user never gives 4lpha a key to their personal account.', 'The agent cannot raise its policy limits or unfreeze itself.', 'LP AI suggestions are fenced by code; a bad answer uses a fixed fallback.', 'Paper meme.cooking agent with deterministic screens and a NEAR AI join gate.'], evidence: [{ label: 'Custody and limits', href: `${REPO}#security-what-the-agents-key-can-and-cannot-do` }, { label: 'Paper agent', href: '/deploy/trade/degen' }] },
];

export const COMMANDS = [
  { title: 'Clone the NEAR repository', cmd: `git clone ${REPO}.git\ncd 4lpha-NEAR` },
  { title: 'Install, build and run the offline suites', cmd: 'npm ci --ignore-scripts\nnpm run build\nnpm test' },
  { title: 'Run the attack demo without a wallet or funds', cmd: 'npm run attack-demo' },
];

export const LIMITS = [
  'OutLayer is hosted custody. 4lpha holds the wallet\'s custody API key while the agent runs. The product does not independently verify OutLayer\'s TEE attestation.',
  'The policy checks direct native NEAR payments and called contracts. It does not inspect token amounts or recipients inside contract calls. A stolen key can move tokens, including NEAR wrapped first. Detection cannot recover money already moved.',
  'Watchdog alerts appear on the job page and in the operator log. There is no push notification. A freeze blocks new custody operations, not orders or liquidity already resting on Rhea.',
  'Grid and LP use one pinned USDC/wNEAR DCL pool and DCL version 2.4.2. On a version mismatch, automated DCL actions stop, including exit.',
  'Grid and LP each need 0.5 NEAR of DCL registration outside the deposit; it cannot be withdrawn on the pinned version. Small live runs test mechanics, not profitability.',
  'Demo fills and balances are simulated. They omit queue priority and exact execution costs; LP fees are estimates. Schedule buy and Auto DCA may wait for about 30 minutes of price history.',
  'The meme.cooking agent is paper only and needs a NEAR wallet sign-in. Lending is locked and outside this submission. No privacy or verified-inference claim is made.',
];

export const SIGMA_LINES = [
  'Hi judges! I am Sigma. Start with a demo: no wallet, no deposit, nothing signed.',
  'We attacked our own agent with its own key. The direct NEAR payment was refused.',
  'Seven offline attacks stopped. Two stolen-key paths are detected, not prevented. The proof explains both.',
  'Grid and LP have recorded mainnet runs. Demo balances are simulations, not returns.',
];
