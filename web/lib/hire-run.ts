import { CHAIN_WAIT, isPolicyPayload, type Job } from './near-format';

/* Spec UI step 3, section 2: the hire popup's steps and the one action each step may offer. Pure: the server
   job view plus local facts in, step states out. Every action follows the server flag that allows it. */

export type HireStepKey = 'prepare' | 'policy' | 'link' | 'dcl' | 'fund' | 'ready';
export type HireStepState = 'pending' | 'active' | 'done' | 'failed';
export type HireAction = 'wait' | 'sign-policy' | 'expired' | 'reveal' | 'confirm-link' | 'register-dcl' | 'fund';

export interface PendingTransfer { account: string; jobId: string; amount: string; baseBalance: string; at: number; }
export interface HireLocal { policySent: boolean; linkShown: boolean; saved: boolean; transfer: PendingTransfer | null; }
export interface HireStep { key: HireStepKey; title: string; hint: string; state: HireStepState; detail?: string; }
export interface HireRun {
  steps: HireStep[];
  action: HireAction | null;
  waitText: string;
  /** Set when the hire stopped during setup (terminal, held or frozen). */
  stopped: { reason: string } | null;
  deployed: boolean;
}

const DEFS: Record<HireStepKey, { title: string; hint: string }> = {
  prepare: { title: 'Prepare the agent wallet', hint: 'The server registers an OutLayer wallet for this agent.' },
  policy: { title: 'Sign the wallet policy', hint: 'Your wallet stores the policy that caps what the agent can do.' },
  link: { title: 'Save the management link', hint: 'Direct access to the agent wallet. Sign once to reveal it.' },
  dcl: { title: 'Register the agent on DCL', hint: '0.5 NEAR from your wallet, locked by DCL.' },
  fund: { title: 'Fund the agent wallet', hint: 'Send the declared deposit from your wallet.' },
  ready: { title: 'Register tokens and start', hint: 'The agent registers on wNEAR and USDC, then starts.' },
};

const STOPPED = ['failed', 'cancelled', 'halted', 'stopped', 'stopping', 'paused', 'frozen', 'retired'];
const TERMINAL = ['failed', 'cancelled', 'stopped', 'retired'];
const SETUP = ['draft', 'registered', 'policy_prepared', 'armed', 'link_confirmed', 'funded', 'resuming'];
const PREPARE_DONE = ['policy_prepared', 'armed', 'link_confirmed', 'funded', 'resuming', 'ready', 'running'];
const POLICY_DONE = ['armed', 'link_confirmed', 'funded', 'resuming', 'ready', 'running'];
const FUND_DONE = ['funded', 'resuming', 'ready', 'running'];

export const HIRE_CANCEL_STATES = ['draft', 'registered', 'policy_prepared', 'armed', 'link_confirmed'];

/** The setup states (spec UI step 3, section 4: the pending-transfer wait text applies only here). */
export function inSetup(job: Job): boolean { return SETUP.includes(job.state); }

export function hireRunSteps(job: Job, local: HireLocal): HireRun {
  const dcl = job.grid ?? job.lp;
  const keys: HireStepKey[] = dcl ? ['prepare', 'policy', 'link', 'dcl', 'fund', 'ready'] : ['prepare', 'policy', 'link', 'fund', 'ready'];
  // A stopped job has lost its setup state, so a step counts as done there only on evidence: an agent account for
  // the wallet, a delivered or confirmed link for the verified policy.
  const halted = STOPPED.includes(job.state);
  const done: Record<HireStepKey, boolean> = {
    prepare: PREPARE_DONE.includes(job.state) || (halted && job.agentAccount !== null),
    policy: POLICY_DONE.includes(job.state) || (halted && (job.linkDelivered || job.linkConfirmed)),
    link: job.linkConfirmed,
    // A failed DCL read returns registered: false; a funded or later job must not rewind to this step.
    dcl: dcl?.registered === true || FUND_DONE.includes(job.state),
    fund: FUND_DONE.includes(job.state),
    ready: job.state === 'ready' || job.state === 'running',
  };
  const activeKey = keys.find(key => !done[key]) ?? null;
  const deployed = activeKey === null;

  let action: HireAction | null = null, waitText = '';
  let stopped: HireRun['stopped'] = null;
  const frozenWallet = job.frozen === true && SETUP.includes(job.state);
  if (STOPPED.includes(job.state) || frozenWallet) {
    stopped = { reason: job.reason ?? (TERMINAL.includes(job.state) ? 'This hire stopped. Open the agent page for recovery.'
      : job.state === 'frozen' || frozenWallet ? 'The agent wallet is frozen. Unfreeze it on the agent page.' : 'This hire is on hold. Open the agent page for details.') };
  } else if (activeKey === 'prepare') {
    action = 'wait'; // The step's own hint already says what happens.
  } else if (activeKey === 'policy' && job.state === 'policy_prepared') {
    if (local.policySent) { action = 'wait'; waitText = 'Policy submitted. Waiting for the finalized owner check.'; }
    else if (job.waitingForChain) { action = 'wait'; waitText = CHAIN_WAIT; }
    else if (job.payload && isPolicyPayload(job.payload, job)) action = 'sign-policy';
    else { action = 'expired'; waitText = 'The policy request expired. Cancel this hire and start again.' + (job.reason ? ' ' + job.reason : ''); }
  } else if (activeKey === 'link' && job.state === 'armed') {
    if (local.linkShown) action = 'confirm-link';
    else if (job.canReveal) action = 'reveal';
    else action = 'wait';
  } else if (activeKey === 'dcl' && job.state === 'link_confirmed') {
    if (dcl?.canRegister === true) action = 'register-dcl';
    else { action = 'wait'; waitText = !dcl?.available ? 'Waiting for finalized DCL data.' :
      dcl.issued ? 'Waiting for the finalized DCL registration.' : 'Waiting for the DCL checks.'; }
  } else if (activeKey === 'fund' && job.state === 'link_confirmed') {
    if (local.transfer) { action = 'wait'; waitText = 'Transfer submitted. Waiting for the finalized balance.'; }
    else if (job.canFund === true) action = 'fund';
    else { action = 'wait'; waitText = 'Waiting for the wallet policy and watchdog checks.'; }
  } else if (activeKey === 'ready' && (job.state === 'funded' || job.state === 'resuming')) {
    action = 'wait'; waitText = 'Registering tokens and running the readiness checks.';
  } else if (activeKey !== null) action = 'wait';

  const steps = keys.map((key): HireStep => {
    const state: HireStepState = done[key] ? 'done' : key !== activeKey ? 'pending' : stopped ? 'failed' : 'active';
    // Trade V1: the token registration names the job's own token.
    const hint = key === 'ready' && job.trade ? `The agent registers on wNEAR and ${job.trade.pair.symbol}, then starts.` : DEFS[key].hint;
    return { key, ...DEFS[key], hint, state, ...(state === 'failed' ? { detail: stopped!.reason } : {}) };
  });
  return { steps, action, waitText, stopped, deployed: deployed && !stopped };
}
