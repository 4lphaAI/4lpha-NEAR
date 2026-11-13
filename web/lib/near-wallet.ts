import { NearConnector, type NearWalletBase, type SignedMessage } from '@hot-labs/near-connect';
import { ServerError, type Call, type Challenge, type Job } from './near-format';

export type SignedAnswer = SignedMessage & { nonce: string };
interface InjectedNear {
  getAccountId(): Promise<string | null>;
  requestSignIn(): Promise<{ accountId: string } | null>;
  signAndSendTransaction(p: { receiverId: string; actions: Call[] }): Promise<{ code?: number; txHash?: string }>;
}

const connector = new NearConnector({ network: 'mainnet', footerBranding: null, logger: { log() {} } });
export let selectedWallet: NearWalletBase | null = null;
export function clearSelectedWallet() { selectedWallet = null; }

export async function api<T>(path: string, body?: object): Promise<T> {
  const res = await fetch(path, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  const data = await res.json() as { data: T; error?: { message: string } };
  if (!res.ok || data.error) throw data.error?.message ? new ServerError(data.error.message) : new Error('Request failed.');
  return data.data;
}

export async function sign(purpose: 'login' | 'reveal' | 'resume', id: string | undefined, guard: () => boolean): Promise<SignedAnswer> {
  if (!guard()) throw undefined;
  const c = await api<Challenge>(`/api/challenge?purpose=${purpose}${id ? `&job=${encodeURIComponent(id)}` : ''}`);
  if (!guard()) throw undefined;
  const nonce = Uint8Array.from(atob(c.nonce.replace(/-/g, '+').replace(/_/g, '/')), s => s.charCodeAt(0));
  await connector.disconnect().catch(() => {});
  if (!guard()) throw undefined;
  let answer: SignedMessage | undefined;
  const onSigned = (event: { accounts: { signedMessage: SignedMessage }[] }) => { answer = event.accounts[0]?.signedMessage; };
  connector.on('wallet:signInAndSignMessage', onSigned);
  try {
    if (!guard()) throw undefined;
    const wallet = await connector.connect({ signMessageParams: { message: c.message, recipient: c.recipient, nonce } });
    if (!guard()) throw undefined;
    selectedWallet = wallet;
    if (!answer) throw new Error('4lpha: Your wallet did not return a signature.');
    return { ...answer, nonce: c.nonce };
  } finally { connector.off('wallet:signInAndSignMessage', onSigned); }
}

/** Spec UI step 3, section 4: wallet preflight for the funding Transfer. Refuses OKX (FunctionCall only, FINDINGS C2)
    and a wallet whose current accounts do not include the owner, before any marker is written; then `send` signs on
    that same wallet. */
export async function transferWallet(job: Job, guard: () => boolean): Promise<(receiverId: string, amountYocto: string) => Promise<void>> {
  if (!guard()) throw undefined;
  const near = (window as Window & { okxwallet?: { near?: InjectedNear } }).okxwallet?.near;
  const wallet = selectedWallet ?? await connector.wallet().catch(() => null);
  if (!guard()) throw undefined;
  if (wallet?.manifest.id === 'okx-wallet' || (!wallet && near)) throw new Error('4lpha: This wallet cannot send a transfer from the page. Use the manual line on the agent page.');
  if (!wallet) throw new Error('4lpha: Reconnect your wallet before signing.');
  const accounts = await wallet.getAccounts({ network: 'mainnet' });
  if (!guard()) throw undefined;
  if (!accounts.some(a => a.accountId === job.owner)) throw new Error('4lpha: Connect the wallet that owns this job.');
  return async (receiverId, amountYocto) => {
    if (!guard()) throw undefined;
    await wallet.signAndSendTransaction({ network: 'mainnet', signerId: job.owner, receiverId, actions: [{ type: 'Transfer', params: { deposit: amountYocto } }] });
    if (!guard()) throw undefined;
  };
}

export async function sendCall(job: Job, receiverId: string, call: Call, guard: () => boolean) {
  if (!guard()) throw undefined;
  const near = (window as Window & { okxwallet?: { near?: InjectedNear } }).okxwallet?.near;
  const wallet = selectedWallet ?? await connector.wallet().catch(() => null);
  if (!guard()) throw undefined;
  if (wallet?.manifest.id === 'okx-wallet' || (!wallet && near)) {
    if (!near) throw new Error('4lpha: Open this page in a browser with your OKX wallet.');
    let account = await near.getAccountId();
    if (!guard()) throw undefined;
    if (!account) {
      account = (await near.requestSignIn())?.accountId ?? null;
      if (!guard()) throw undefined;
    }
    if (account !== job.owner) throw new Error('4lpha: Connect the wallet that owns this job.');
    if (!guard()) throw undefined;
    const result = await near.signAndSendTransaction({ receiverId, actions: [call] });
    if (!guard()) throw undefined;
    if (!result?.txHash || (result.code !== undefined && result.code !== 0)) throw new Error('4lpha: The wallet did not confirm submission. Check its activity before trying again.');
    return;
  }
  if (!wallet) throw new Error('4lpha: Reconnect your wallet before signing.');
  if (!guard()) throw undefined;
  await wallet.signAndSendTransaction({ signerId: job.owner, receiverId, actions: [{ type: 'FunctionCall', params: call }] });
  if (!guard()) throw undefined;
}
