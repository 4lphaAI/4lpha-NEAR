import { NearConnector, type NearWalletBase, type SignedMessage } from '@hot-labs/near-connect';
import { BLIND_CHECKS, BLIND_RESUME, canRequestResume, CHAIN_WAIT, resumeLabel, waitingForChain } from '../../../web/lib/near-format.js';

interface Challenge { message: string; nonce: string; recipient: string; }
type SignedAnswer = SignedMessage & { nonce: string };
interface Call { methodName: string; args: object; gas: string; deposit: string; }
interface Payload extends Call { receiverId: string; caller: string; }
interface Job {
  id: string; owner: string; kind: string; state: string; reason: string | null; depositYocto: string; agentAccount: string | null;
  walletPubkey: string | null; agentBalance: string | null; ownerBalance: string | null; payload: Payload | null;
  canReveal: boolean; linkDelivered: boolean; linkConfirmed: boolean; canFund: boolean; frozen: boolean | null;
  canStopEarly: boolean;
  waitingForChain: boolean; blindHalt: boolean; canResumeBlind: boolean;
  resumeBlockedReason: string | null;
  grid: { available: boolean; enabled: boolean; issued: boolean; registered: boolean; canRegister: boolean; point: number | null; anchor: number | null;
    internal: Record<string, string>; lost: Record<string, string>; positions: number;
    lanes: { generation: number; sell: string; amount: string; native: boolean; orderId: string | null; points: [number, number] | null }[];
    settings?: { step: number; orders: number; stopLossPct: number; takeProfitPct: number } | 'invalid' | null; value?: string | null;
    protect?: { fired?: { kind: string; value: string; basis: string; block: number; at: number } } | null;
    orders: { id: string; sell: string; buy: string; point: number; remain: string; bought: string; unclaimed: string }[] } | null;
  lp: { available: boolean; enabled: boolean; issued: boolean; registered: boolean; canRegister: boolean; point: number | null; internal: Record<string, string>; lost: Record<string, string>;
    settings?: { ai: boolean; compound: { on: boolean; minFeeBps?: number }; stopLossPct: number; takeProfitPct: number } | 'invalid'; recentred?: boolean; initialPosition?: string; positionValue?: string | null; valueLow?: string | null; valueHigh?: string | null;
    lastDecision?: { at: number; verdict: string; code?: string; range: { left: number; right: number } } | null;
    protect?: { fired?: { kind: string; value: string; basis: string; block: number; at: number } } | null;
    positions: number; ledger: { usdc: string; wnear: string; native: string; inUsdc: string; inWnear: string } | null; rotations: number; pending: { kind: string } | null;
    range: { left: number; right: number; leftPrice: number; rightPrice: number; inRange: boolean | null; outSince: number | null } | null;
    position: { id: string; liquidity: string; paidX: string; paidY: string; fees: string[] | null; estimate: string[] | null } | null } | null;
  pendingSubmission: 'submitted' | 'ambiguous' | null;
  holdings: { tokens: Record<string, string>; block: number } | null; extraTokens: { token: string; amount: string }[];
  operations: { kind: string; verdict: string | null; state: string; txHash: string | null; message: string | null }[];
  alerts: { kind: string; severity: string; detail: Record<string, string> }[];
}
interface InjectedNear {
  getAccountId(): Promise<string | null>;
  requestSignIn(): Promise<{ accountId: string } | null>;
  signAndSendTransaction(p: { receiverId: string; actions: Call[] }): Promise<{ code?: number; txHash?: string }>;
}

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const connector = new NearConnector({ network: 'mainnet', footerBranding: null, logger: { log() {} } });
const visibleLinks = new Map<string, string>();
const sentPolicy = new Set<string>();
const pendingFreeze = new Map<string, boolean>();
const WNEAR = 'wrap.near';
const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
let session: string | null = null;
let selectedWallet: NearWalletBase | null = null;
let busy = false;
let shownJobs: Job[] = [];

async function api<T>(path: string, body?: object): Promise<T> {
  const res = await fetch(path, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  const data = await res.json() as { data: T; error?: { message: string } };
  if (!res.ok || data.error) throw new Error(data.error?.message ?? 'Request failed.');
  return data.data;
}

function say(message: string) { element('message').textContent = message; }
function add(parent: HTMLElement, tag: string, text: string, className?: string) {
  const e = document.createElement(tag);
  e.textContent = text;
  if (className) e.className = className;
  parent.append(e);
  return e;
}

function button(parent: HTMLElement, name: string, fn: () => Promise<void>) {
  const b = document.createElement('button'); b.type = 'button'; b.textContent = name; parent.append(b);
  b.onclick = () => { void action(fn); };
  return b;
}

async function action(fn: () => Promise<void>) {
  if (busy) return;
  busy = true;
  say('');
  try { await fn(); await refresh(); }
  catch (e) { say(e instanceof Error && e.message.startsWith('4lpha: ') ? e.message.slice('4lpha: '.length) : 'The action could not be completed. Check your wallet and the job status.'); }
  finally { busy = false; }
}

async function sign(purpose: 'login' | 'reveal' | 'resume', id?: string): Promise<SignedAnswer> {
  const c = await api<Challenge>(`/api/challenge?purpose=${purpose}${id ? `&job=${encodeURIComponent(id)}` : ''}`);
  const nonce = Uint8Array.from(atob(c.nonce.replace(/-/g, '+').replace(/_/g, '/')), s => s.charCodeAt(0));
  await connector.disconnect().catch(() => {});
  let answer: SignedMessage | undefined;
  const onSigned = (event: { accounts: { signedMessage: SignedMessage }[] }) => { answer = event.accounts[0]?.signedMessage; };
  connector.on('wallet:signInAndSignMessage', onSigned);
  try {
    selectedWallet = await connector.connect({ signMessageParams: { message: c.message, recipient: c.recipient, nonce } });
    if (!answer) throw new Error('4lpha: Your wallet did not return a signature.');
    return { ...answer, nonce: c.nonce };
  } finally { connector.off('wallet:signInAndSignMessage', onSigned); }
}

async function sendCall(job: Job, receiverId: string, call: Call) {
  const near = (window as Window & { okxwallet?: { near?: InjectedNear } }).okxwallet?.near;
  const wallet = selectedWallet ?? await connector.wallet().catch(() => null);
  if (wallet?.manifest.id === 'okx-wallet' || (!wallet && near)) {
    if (!near) throw new Error('4lpha: Open this page in a browser with your OKX wallet.');
    const account = await near.getAccountId() || (await near.requestSignIn())?.accountId;
    if (account !== job.owner) throw new Error('4lpha: Connect the wallet that owns this job.');
    const result = await near.signAndSendTransaction({ receiverId, actions: [call] });
    if (!result?.txHash || (result.code !== undefined && result.code !== 0)) throw new Error('4lpha: The wallet did not confirm submission. Check its activity before trying again.');
    return;
  }
  if (!wallet) throw new Error('4lpha: Reconnect your wallet before signing.');
  await wallet.signAndSendTransaction({ signerId: job.owner, receiverId, actions: [{ type: 'FunctionCall', params: call }] });
}

function fmt(raw: string | null) {
  if (raw === null) return 'Unavailable';
  const n = BigInt(raw), unit = 10n ** 24n;
  return `${n / unit}.${(n % unit).toString().padStart(24, '0').slice(0, 6)} NEAR`;
}

function exactNear(n: bigint) {
  const unit = 10n ** 24n, fraction = (n % unit).toString().padStart(24, '0').replace(/0+$/, '');
  return `${n / unit}${fraction ? `.${fraction}` : ''} NEAR`;
}

function asset(token: string, raw: string) {
  if (token === WNEAR) return exactNear(BigInt(raw)).replace(' NEAR', ' wNEAR');
  if (token !== USDC) return `${raw} raw units of ${token}`;
  const n = BigInt(raw);
  return `${n / 1000000n}.${(n % 1000000n).toString().padStart(6, '0')} USDC`;
}

function jobPage(job: Job, parent: HTMLElement) {
  const panel = document.createElement('article'); parent.append(panel);
  const waiting = waitingForChain(job);
  add(panel, 'h3', `${job.kind === 'lp' ? 'LP' : 'Grid'} · USDC / wNEAR · ${waiting ? 'Waiting' : job.state.replaceAll('_', ' ')}`);
  add(panel, 'p', `Owner: ${job.owner}`, 'wrap');
  add(panel, 'p', `Owner balance: ${fmt(job.ownerBalance)}. Keep at least 0.1 NEAR for a freeze.`);
  if (job.ownerBalance !== null && BigInt(job.ownerBalance) < 10n ** 23n) add(panel, 'p', 'Your wallet is below the emergency freeze reserve.', 'warning');
  const checklist = document.createElement('ol'); panel.append(checklist);
  const dcl = job.grid ?? job.lp, extra = dcl ? 1 : 0;
  const step = ['draft', 'registered'].includes(job.state) ? 0 : job.state === 'policy_prepared' ? 1 : job.state === 'armed' ? 2 : job.state === 'link_confirmed' ? 3 + Number(dcl?.registered ?? false)
    : ['funded', 'resuming'].includes(job.state) ? 4 + extra : ['ready', 'running'].includes(job.state) ? 5 + extra : -1;
  ['Prepare the job', 'Store the policy and verify the owner', 'Reveal and save the management link', ...(dcl ? [dcl.available ? 'Register the agent on DCL from your wallet' : 'Verify finalized DCL status'] : []),
    'Fund from your wallet', 'Register tokens', 'Ready'].forEach((label, index) => {
    const item = add(checklist, 'li', `${label}${step > index ? ' (done)' : ''}`);
    if (step === index) item.setAttribute('aria-current', 'step');
  });
  if (job.agentAccount) add(panel, 'p', `Agent wallet: ${job.agentAccount}. Native balance: ${fmt(job.agentBalance)}.`, 'wrap');
  if (job.holdings) {
    add(panel, 'p', `Finalized at block ${job.holdings.block}. The policy bounds native transfers. It does not bound token transfers through calls.`);
    add(panel, 'p', `wNEAR: ${fmt(job.holdings.tokens[WNEAR] ?? null).replace(' NEAR', ' wNEAR')}. USDC: ${((BigInt(job.holdings.tokens[USDC] ?? '0')) / 1000000n).toString()}.${(BigInt(job.holdings.tokens[USDC] ?? '0') % 1000000n).toString().padStart(6, '0')} USDC.`);
  }
  if (job.grid) {
    const grid = job.grid;
    add(panel, 'p', 'The owner pays 0.5 NEAR for DCL registration of the agent wallet shown above. DCL locks that amount separately from the agent deposit.');
    if (grid.available && grid.issued && !grid.registered) add(panel, 'p', 'Registration was issued. Check your wallet activity and wait for finality. If declined or unknown, follow the runbook before any manual retry.', 'warning');
    if (!grid.enabled) add(panel, 'p', 'Grid strategy is disabled. Freeze and Stop and withdraw remain available when eligible.', 'warning');
    if (!grid.available || grid.point === null) add(panel, 'p', 'Finalized DCL status is unavailable.', 'warning');
    else {
      add(panel, 'p', `DCL point ${grid.point}: ${(10 ** 18 / 1.0001 ** grid.point).toPrecision(6)} USDC per NEAR. ${grid.anchor === null ? 'Anchor pending.' : `Anchor ${grid.anchor}.`}`);
      for (const [token, raw] of Object.entries(grid.internal)) if (BigInt(raw) > 0n) add(panel, 'p', `DCL internal balance: ${asset(token, raw)}.`);
      for (const [token, raw] of Object.entries(grid.lost)) if (BigInt(raw) > 0n) add(panel, 'p', `DCL lost-found: ${asset(token, raw)}. Use the saved management link for recovery.`, 'warning');
      if (grid.positions) add(panel, 'p', `DCL holds ${grid.positions} liquidity position(s). Use the saved management link for recovery.`, 'warning');
      for (const o of grid.orders) add(panel, 'p', `DCL order ${o.id}: sells ${o.sell === USDC ? 'USDC' : 'wNEAR'} at ${o.point}; ${asset(o.sell, o.remain)} remaining, ${asset(o.buy, o.bought)} bought, ${asset(o.buy, o.unclaimed)} unclaimed.`, 'wrap');
    }
    if (grid.settings === 'invalid') add(panel, 'p', 'Grid settings are unreadable. Stop and withdraw.', 'warning');
    else if (grid.settings) add(panel, 'p', `Owner settings: ${grid.settings.orders} orders, step ${grid.settings.step} points; stop loss ${grid.settings.stopLossPct ? `${grid.settings.stopLossPct}%` : 'off'}; take profit ${grid.settings.takeProfitPct ? `${grid.settings.takeProfitPct}%` : 'off'}. Job value in NEAR: ${fmt(grid.value ?? null)}.`);
    if (grid.protect?.fired) { const f = grid.protect.fired; add(panel, 'p', `Protection stopped this job: ${f.kind}, value ${fmt(f.value)}, deposit basis ${fmt(f.basis)}, block ${f.block}, at ${new Date(f.at).toISOString()}.`); }
    for (const [i, l] of grid.lanes.entries()) add(panel, 'p', `Lane ${i + 1}: ${l.points ? `initial point ${l.points[0]}, reverse point ${l.points[1]}` : 'points unavailable'}. ${l.orderId ? `Order ${l.orderId}` : `${l.native ? exactNear(BigInt(l.amount)) : asset(l.sell, l.amount)} assigned in wallet`}.`, 'wrap');
    add(panel, 'p', 'Resting DCL orders can still fill while the agent wallet is frozen.', 'warning');
  }
  if (job.lp) {
    const lp = job.lp;
    if (lp.settings) {
      add(panel, 'p', `Initial position: ${fmt(lp.initialPosition ?? null)}. Current position estimate: ${fmt(lp.positionValue ?? null)}. Job value in NEAR: low ${fmt(lp.valueLow ?? null)}, high ${fmt(lp.valueHigh ?? null)}.`);
      if (lp.settings === 'invalid') add(panel, 'p', 'LP settings are unreadable. Stop and withdraw.', 'warning');
      else add(panel, 'p', `Owner settings, bounded by the signed policy: AI ${lp.settings.ai ? 'on' : 'off'}; compound ${lp.settings.compound.on ? `on at ${lp.settings.compound.minFeeBps} basis points` : 'off'}; stop loss ${lp.settings.stopLossPct ? `${lp.settings.stopLossPct}%` : 'off'}; take profit ${lp.settings.takeProfitPct ? `${lp.settings.takeProfitPct}%` : 'off'}.`);
      if (lp.recentred) add(panel, 'p', 'The planned range was re-centred on a fresh finalized price.');
      if (lp.lastDecision) add(panel, 'p', `Last range decision: ${lp.lastDecision.verdict}${lp.lastDecision.code ? ` (${lp.lastDecision.code})` : ''}, points ${lp.lastDecision.range.left} to ${lp.lastDecision.range.right}, at ${new Date(lp.lastDecision.at).toISOString()}.`);
      if (lp.protect?.fired) {
        const f = lp.protect.fired;
        add(panel, 'p', `Protection stopped this job: ${f.kind}, value ${fmt(f.value)}, deposit basis ${fmt(f.basis)}, block ${f.block}, at ${new Date(f.at).toISOString()}.`);
      }
    }
    add(panel, 'p', 'The owner pays 0.5 NEAR for DCL registration of the agent wallet shown above. DCL locks that amount separately from the agent deposit.');
    if (lp.available && lp.issued && !lp.registered) add(panel, 'p', 'Registration was issued. Check your wallet activity and wait for finality. If declined or unknown, follow the runbook before any manual retry.', 'warning');
    if (!lp.enabled) add(panel, 'p', 'LP strategy is disabled. Freeze and Stop and withdraw remain available when eligible.', 'warning');
    if (!lp.available || lp.point === null) add(panel, 'p', 'Finalized DCL status is unavailable.', 'warning');
    else {
      add(panel, 'p', `DCL point ${lp.point}: ${(10 ** 18 / 1.0001 ** lp.point).toPrecision(6)} USDC per NEAR.`);
      for (const [token, raw] of Object.entries(lp.internal)) if (BigInt(raw) > 0n) add(panel, 'p', `DCL internal balance: ${asset(token, raw)}.`);
      for (const [token, raw] of Object.entries(lp.lost)) if (BigInt(raw) > 0n) add(panel, 'p', `DCL lost-found: ${asset(token, raw)}. Use the saved management link for recovery.`, 'warning');
      if (lp.positions > (lp.position ? 1 : 0)) add(panel, 'p', `DCL holds ${lp.positions} liquidity position(s). Use the saved management link for recovery.`, 'warning');
    }
    if (lp.range) {
      const r = lp.range;
      add(panel, 'p', `Range: points ${r.left} to ${r.right}, ${r.rightPrice.toPrecision(6)} to ${r.leftPrice.toPrecision(6)} USDC per NEAR. ${r.inRange === null ? 'Range status unavailable.' : r.inRange ? 'In range.' : `Out of range${r.outSince ? ` since ${new Date(r.outSince).toISOString()}` : ''}.`}`);
    }
    if (lp.position) {
      const p = lp.position;
      add(panel, 'p', `Position ${p.id}: liquidity ${p.liquidity}. Opened with ${asset(USDC, p.paidX)} and ${asset(WNEAR, p.paidY)}. Unclaimed fees: ${p.fees ? `${asset(USDC, p.fees[0])} and ${asset(WNEAR, p.fees[1])}` : 'unavailable'}. Estimate if removed now: ${p.estimate ? `${asset(USDC, p.estimate[0])} and ${asset(WNEAR, p.estimate[1])}` : 'unavailable'}.`, 'wrap');
    }
    if (lp.ledger) add(panel, 'p', `Recorded in the wallet: ${asset(USDC, lp.ledger.usdc)}, ${asset(WNEAR, lp.ledger.wnear)}, ${exactNear(BigInt(lp.ledger.native))}. Recorded inside DCL: ${asset(USDC, lp.ledger.inUsdc)}, ${asset(WNEAR, lp.ledger.inWnear)}.`, 'wrap');
    add(panel, 'p', `Rotations in the last 24 hours: ${lp.rotations} of 2.${lp.pending ? ` Pending step: ${lp.pending.kind.replaceAll('_', ' ')}.` : ''}`);
    add(panel, 'p', 'A resting position keeps converting with the price while the wallet is frozen. Nothing needs a signature.', 'warning');
  }
  for (const t of job.extraTokens) add(panel, 'p', `Outside this job: ${t.token}, ${t.amount} raw units. Left in the agent wallet.`, 'wrap');
  if (job.state === 'policy_prepared') add(panel, 'p', 'This account has no verified policy yet. Do not send NEAR to it.', 'warning');
  else if (job.agentAccount && !job.linkConfirmed) add(panel, 'p', 'Do not send NEAR until the management link is confirmed and the funding step appears.', 'warning');
  if (job.agentBalance && BigInt(job.agentBalance) > 0n && !job.linkConfirmed) add(panel, 'p', 'NEAR arrived early. Save the recovery link; the worker cannot use these funds.', 'warning');
  if (job.canFund) add(panel, 'p', `From your wallet's Send screen, send ${exactNear(BigInt(job.depositYocto) - BigInt(job.agentBalance ?? '0'))} to ${job.agentAccount}. Verify the recipient before sending.`, 'wrap');
  else if (job.state === 'link_confirmed') add(panel, 'p', dcl && !dcl.available ? 'Waiting for finalized DCL data before funding.' :
    `Wait for the wallet policy and watchdog checks${dcl && !dcl.registered ? ' and finalized DCL registration' : ''} before sending NEAR.`, 'warning');
  if (job.state === 'stopping' && job.frozen) add(panel, 'p', 'Unfreeze to withdraw.', 'warning');
  if (job.pendingSubmission === 'ambiguous') add(panel, 'p', 'A submission remains unresolved. No new operation or withdrawal can run. Use the saved management link for recovery.', 'warning');
  if (waiting) add(panel, 'p', CHAIN_WAIT, 'warning');
  if (job.reason && !(waiting && job.reason === 'Finalized chain data is unavailable.')) add(panel, 'p', job.reason);
  for (const a of job.alerts) if (!(waiting && a.kind === 'blind' && a.severity === 'info')) add(panel, 'p', `${a.severity}: ${a.kind}. ${a.detail.message ?? ''}`, 'warning');
  const actions = document.createElement('div'); actions.className = 'actions'; panel.append(actions);
  const path = `/api/jobs/${job.id}`;
  if (dcl?.canRegister) button(actions, 'Register agent on DCL (0.5 NEAR)', async () => {
    const p = await api<Payload>(`${path}/dcl-registration`, {});
    const args = p.args as { account_id?: string; registration_only?: boolean };
    if (p.caller !== job.owner || p.receiverId !== 'dclv2.ref-labs.near' || p.methodName !== 'storage_deposit' || p.deposit !== '500000000000000000000000' ||
      p.gas !== '50000000000000' || args.account_id !== job.agentAccount || args.registration_only !== true) throw new Error();
    await sendCall(job, p.receiverId, { methodName: p.methodName, args: p.args, gas: p.gas, deposit: p.deposit });
    say('Registration submitted. Wait for finalized DCL storage before funding.');
  });
  if (job.payload && !sentPolicy.has(job.id)) button(actions, 'Store policy in wallet', async () => {
    const p = job.payload!;
    if (p.caller !== job.owner || p.receiverId !== 'outlayer.near' || p.methodName !== 'store_wallet_policy') throw new Error();
    await sendCall(job, p.receiverId, { methodName: p.methodName, args: p.args, gas: p.gas, deposit: p.deposit });
    sentPolicy.add(job.id);
    say('Policy submitted. Waiting for finalized owner and rule checks.');
  });
  if (job.canReveal && !visibleLinks.has(job.id)) button(actions, 'Reveal management link', async () => {
    const result = await api<{ link: string }>(`${path}/reveal`, { signed: await sign('reveal', job.id) });
    visibleLinks.set(job.id, result.link);
  });
  const link = visibleLinks.get(job.id);
  if (link) {
    add(panel, 'p', 'Save this link privately. It grants access to the wallet.');
    add(panel, 'code', link);
    button(actions, 'Hide link', async () => { visibleLinks.delete(job.id); });
  }
  if (job.state === 'armed' && job.linkDelivered) {
    const label = document.createElement('label'), checkbox = document.createElement('input');
    checkbox.type = 'checkbox'; label.append(checkbox, ' I saved the management link'); panel.append(label);
    button(actions, 'Confirm saved link', async () => {
      if (!checkbox.checked) throw new Error('4lpha: Save the link and tick the confirmation first.');
      await api(`${path}/link-confirmed`, { saved: true }); visibleLinks.delete(job.id);
    });
  }
  if (!job.canStopEarly && ['draft', 'registered', 'policy_prepared', 'armed', 'link_confirmed'].includes(job.state)) button(actions, 'Cancel hire', async () => { await api(`${path}/cancel`, {}); });
  if (job.walletPubkey && job.frozen !== null && !['cancelled', 'failed', 'stopped', 'retired'].includes(job.state)) {
    const frozen = job.frozen;
    if (pendingFreeze.get(job.id) === frozen) pendingFreeze.delete(job.id);
    if (!pendingFreeze.has(job.id)) button(actions, frozen ? 'Unfreeze' : 'Freeze now', async () => {
      await sendCall(job, 'outlayer.near', { methodName: frozen ? 'unfreeze_wallet' : 'freeze_wallet', args: { wallet_pubkey: job.walletPubkey }, gas: '30000000000000', deposit: '0' });
      pendingFreeze.set(job.id, !frozen);
      say('Transaction submitted. Waiting for the finalized freeze state.');
    });
  }
  const resume = resumeLabel(job);
  if (resume) {
    const enabled = canRequestResume(job);
    const available = () => enabled && shownJobs.some(j => j.id === job.id && j.state === job.state && canRequestResume(j));
    const control = button(actions, resume, async () => {
      if (!available()) return;
      const signed = await sign('resume', job.id);
      if (!available()) return;
      await api(`${path}/resume`, { signed });
    });
    control.disabled = !enabled;
    if (job.state === 'halted') {
      const note = add(actions, 'span', enabled ? BLIND_RESUME : job.resumeBlockedReason ?? BLIND_CHECKS);
      note.id = `resume-note-${job.id}`;
      control.setAttribute('aria-describedby', note.id);
    }
  }
  if (job.linkConfirmed && job.pendingSubmission !== 'ambiguous' && (job.canStopEarly || ['funded', 'ready', 'running', 'paused', 'resuming', 'halted', 'frozen'].includes(job.state))) {
    button(actions, 'Stop and withdraw', async () => { await api(`${path}/stop`, {}); });
  }
  if (!job.blindHalt && ['cancelled', 'failed', 'halted'].includes(job.state)) add(panel, 'p', 'The worker will not use funds before the hire checks pass. If you funded this account early, use the saved management link to recover them.');
  if (job.operations.length) {
    add(panel, 'h4', 'Operations');
    for (const o of job.operations) add(panel, 'p', `${o.kind.replaceAll('_', ' ')}: ${o.verdict ?? o.state}${o.message ? ` · ${o.message}` : ''}${o.txHash ? ` · ${o.txHash}` : ''}`, 'wrap');
  }
}

async function refresh() {
  const nav = element('account'), jobs = element('jobs'), hire = element('hire');
  nav.replaceChildren();
  if (!session) {
    shownJobs = [];
    jobs.replaceChildren(); hire.hidden = true;
    button(nav, 'Connect NEAR wallet', async () => { session = (await api<{ accountId: string }>('/api/login', { signed: await sign('login') })).accountId; });
    return;
  }
  const account = session;
  add(nav, 'span', account, 'wrap');
  button(nav, 'Sign out', async () => { await api('/api/logout', {}); visibleLinks.clear(); sentPolicy.clear(); pendingFreeze.clear(); selectedWallet = null; session = null; });
  const [options, list] = await Promise.all([api<{ liveEnabled: boolean; gridV1: boolean; lpV1: boolean; lp: { point: number | null; ai: boolean } | null }>('/api/hire/options'), api<Job[]>('/api/jobs')]);
  if (session !== account) return;
  shownJobs = list;
  hire.hidden = false; element<HTMLButtonElement>('hire-button').disabled = !options.liveEnabled;
  const lpOption = element<HTMLOptionElement>('lp-option');
  lpOption.hidden = lpOption.disabled = !options.lpV1;
  if (options.lp && !lpAiPrefilled) { element<HTMLInputElement>('lp-ai').checked = options.lp.ai; lpAiPrefilled = true; }
  if (options.lp && !lpPrefilled) {
    if (options.lp.point !== null) {
      element<HTMLInputElement>('lp-min').value = (1e18 / 1.0001 ** (options.lp.point + 100)).toFixed(6);
      element<HTMLInputElement>('lp-max').value = (1e18 / 1.0001 ** (options.lp.point - 100)).toFixed(6);
      lpPrefilled = true;
    }
  }
  if (!options.lpV1 && kind.value === 'lp') kind.value = 'grid';
  if (options.gridV1 && element('grid-cost').hidden && element('lp-cost').hidden && deposit.value === '0.4') { deposit.value = '1'; showCaps(); }
  gridCost = options.gridV1; showKind();
  jobs.replaceChildren();
  if (list.length) add(jobs, 'h2', 'Your jobs');
  for (const j of list) jobPage(j, jobs);
}

const deposit = element<HTMLInputElement>('deposit'), kind = element<HTMLSelectElement>('kind');
let gridCost = false;
let lpPrefilled = false, lpAiPrefilled = false;
function showKind() { element('grid-cost').hidden = !gridCost || kind.value === 'lp'; element('lp-cost').hidden = element('lp-risk').hidden = element('lp-settings').hidden = kind.value !== 'lp'; }
kind.addEventListener('change', () => { deposit.value = kind.value === 'lp' ? '1.2' : '1'; showCaps(); showKind(); });
function depositYocto() {
  const parts = /^(\d+)(?:\.(\d{1,24}))?$/.exec(deposit.value.trim());
  if (!parts) throw new Error('4lpha: Enter a valid NEAR deposit.');
  return BigInt(parts[1] + (parts[2] ?? '').padEnd(24, '0'));
}
function showCaps() {
  let daily = '3 times your deposit';
  try { daily = exactNear(3n * depositYocto()); } catch { /* Keep the formula visible while editing. */ }
  element('native-cap').textContent = `Native limits: 0.25 NEAR per transaction and ${daily} per day.`;
  if (kind.value === 'lp') {
    try { element('native-cap').textContent += ` Initial LP position: ${exactNear(depositYocto() - 8n * 10n ** 23n)}.`; } catch { /* Keep the limits visible while editing. */ }
  }
}
deposit.addEventListener('input', showCaps);
showCaps();
element<HTMLFormElement>('hire-form').onsubmit = e => {
  e.preventDefault(); void action(async () => {
    const number = (id: string) => {
      const value = element<HTMLInputElement>(id).value;
      if (!/^\d+$/.test(value)) throw new Error('4lpha: Enter whole numbers for LP percentages and fee basis points.');
      return Number(value);
    };
    const lp = kind.value === 'lp' ? {
      range: element<HTMLSelectElement>('lp-range').value === 'server' ? { mode: 'server' } : { mode: 'explicit', minPrice: element<HTMLInputElement>('lp-min').value.trim(), maxPrice: element<HTMLInputElement>('lp-max').value.trim() },
      ai: element<HTMLInputElement>('lp-ai').checked,
      compound: element<HTMLInputElement>('lp-compound').checked ? { on: true, minFeeBps: number('lp-fee') } : { on: false },
      stopLossPct: number('lp-sl'), takeProfitPct: number('lp-tp'),
    } : undefined;
    await api('/api/jobs', { kind: kind.value, pair: 'usdc-wnear', mode: 'live', depositYocto: depositYocto().toString(), ...(lp ? { lp } : {}) });
  });
};
void api<{ accountId: string }>('/api/me').then(r => { session = r.accountId; }).catch(() => {}).then(refresh).catch(() => say('The job page is unavailable.'));
setInterval(() => { if (!document.hidden && !busy && session && !document.querySelector('#jobs input:checked')) void refresh().catch(() => say('Job status is temporarily unavailable.')); }, 15000);
