// READ ONLY. Shows what an agent wallet holds inside Rhea DCL and in the wallet itself, and prints the recovery
// command from the Grid runbook that fits the next step. It never signs or sends anything and prints chain data only.
// It deliberately does not require the DCL version the product pins, because it is meant for the moment the
// product refuses to act (runbook "Recovery of value inside DCL", ruling 2026-11-07). Like the product, it fails
// closed: any failed or malformed read aborts the whole status instead of being shown as "nothing".
// Usage, from the repository root after `npm run build`:  node scripts\dcl-status.mjs AGENT_ACCOUNT
import { createHash } from 'node:crypto';
const core = file => import(new URL(`../dist/src/core/${file}`, import.meta.url).href);
const { rpcEnv, rpcLabel } = await core('config.js');
const { createNearRpc, spendableNear } = await core('near-rpc.js');

const DCL = 'dclv2.ref-labs.near', WNEAR = 'wrap.near', USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const PINNED_VERSION = '2.4.2', PINNED_POOL = `${USDC}|${WNEAR}|100`;
const DECIMALS = { [WNEAR]: 24, [USDC]: 6 };
const NAMES = { [WNEAR]: 'wNEAR', [USDC]: 'USDC' };

const account = process.argv[2];
if (!account || !/^(?=.{2,64}$)([a-z0-9]+[-_.])*[a-z0-9]+$/.test(account)) {
  console.error('Usage: node scripts\\dcl-status.mjs AGENT_ACCOUNT   (the agent wallet shown on the job page)');
  process.exit(1);
}

function fail(what) {
  console.error(`\nA read failed (${what}). Nothing printed above can be trusted as complete: run the status again, and do not act on a partial status.`);
  process.exit(2);
}
const amount = (v, what) => { if (typeof v === 'string' && /^\d{1,39}$/.test(v)) return BigInt(v); return fail(`unreadable ${what}`); };
const human = (raw, token) => {
  const d = DECIMALS[token];
  if (d === undefined) return `${raw} raw`;
  const s = raw.toString().padStart(d + 1, '0');
  return `${s.slice(0, -d)}.${s.slice(-d).slice(0, 6)} ${NAMES[token]}`;
};
const name = token => NAMES[token] ?? token;

const endpoints = rpcEnv(), rpc = createNearRpc(endpoints);
let final;
try { final = await rpc.finalBlock(); } catch { fail('final block'); }
const view = async (contract, method, args) => { try { return (await rpc.view(contract, method, args, final.id)).value; } catch { return fail(method); } };
// get_order returns null, or may panic, for an id DCL no longer knows; both mean "gone" and lead to a STOP below. Any other failure aborts.
const getOrder = async id => { try { return (await rpc.view(DCL, 'get_order', { order_id: id }, final.id)).value; } catch (e) { return e?.code === 'bad_request' ? null : fail('get_order'); } };
const list = async (method, kind) => { const v = await view(DCL, method, { account_id: account }); if (kind === 'array' ? !Array.isArray(v) : (v === null || typeof v !== 'object' || Array.isArray(v))) fail(method); return v; };

// A ready-to-paste Command Prompt line. Inside this JSON every value sits outside cmd's quotes (each \" toggles them),
// so the | in an order id must be written ^| or cmd treats it as a pipe. Checked through real cmd.exe and curl.exe.
// The key is new on every run (final block height), so a re-run never collides with an earlier answer.
const key = (kind, id) => `recovery-dcl-${kind}-${createHash('sha256').update(id).digest('hex').slice(0, 8)}-${final.height}`;
const command = (k, method, args, gas) => {
  const json = JSON.stringify({ receiver_id: DCL, method_name: method, args, gas, deposit: '0' }).replaceAll('"', '\\"').replaceAll('|', '^|');
  return `curl.exe -s -X POST https://api.outlayer.ai/wallet/v1/call -H "authorization: Bearer %WK%" -H "content-type: application/json" -H "x-idempotency-key: ${k}" -d "${json}"`;
};

const stops = [], positionCommands = [], orderCommands = [], withdrawCommands = [];
console.log(`RPC: ${rpcLabel(endpoints)}   final block ${final.height}   account ${account}`);

const meta = await view(DCL, 'get_metadata', {});
console.log(`\nDCL version ${meta?.version}, state ${meta?.state}`);
if (meta?.version !== PINNED_VERSION) console.log(`  The product only acts on DCL ${PINNED_VERSION}. Use the runbook's recovery commands, not the worker.`);

const storage = await view(DCL, 'get_user_storage_detail', { user_id: account });
console.log(storage ? `DCL registration: sponsor ${storage.sponsor_id}, ${storage.cur_order_slots} order slots and ${storage.cur_liquidity_slots} position slots used of ${storage.max_slots}`
  : 'DCL registration: none');

// Liquidity positions come first: remove_liquidity pays the position out to the wallet, with its fees. Internal balances are withdrawn last.
const positions = await list('list_liquidities', 'array');
console.log(`\nLiquidity positions: ${positions.length}`);
for (const p of positions) {
  const left = p.left_point, right = p.right_point, liquidity = amount(p.amount, 'position liquidity');
  console.log(`- ${p.lpt_id}`);
  console.log(`    points ${left} to ${right}, liquidity ${liquidity}, unclaimed fees ${human(amount(p.unclaimed_fee_x, 'position fee x'), USDC)} and ${human(amount(p.unclaimed_fee_y, 'position fee y'), WNEAR)}`);
  if (p.pool_id !== PINNED_POOL) { stops.push(`position ${p.lpt_id} is on another pool`); continue; }
  if (typeof p.mft_id !== 'string' || p.mft_id !== '') { stops.push(`position ${p.lpt_id} is farmed or has no readable mft_id`); continue; }
  if (liquidity === 0n) { console.log('    next: nothing to remove'); continue; }
  console.log('    next: REMOVE the whole position: pays both sides and the fees to the wallet');
  positionCommands.push(command(key('remove', p.lpt_id), 'remove_liquidity', { lpt_id: p.lpt_id, amount: liquidity.toString(), min_amount_x: '0', min_amount_y: '0' }, '150000000000000'));
}

const active = await list('list_active_orders', 'array');
const history = await list('list_history_orders', 'array');
const withValue = history.filter(o => amount(o.remain_amount, 'history remainder') > 0n || (o.unclaimed_amount !== null && amount(o.unclaimed_amount, 'history unclaimed') > 0n));
const ids = [...new Set([...active.map(o => o.order_id), ...withValue.map(o => o.order_id)])];
console.log(`\nOrders that may hold value: ${ids.length}`);
for (const id of ids) {
  const o = await getOrder(id);
  if (o === null) { stops.push(`order ${id} is listed with value but DCL no longer returns it`); continue; }
  const remain = amount(o.remain_amount, 'remaining amount'), unclaimed = amount(o.unclaimed_amount, 'unclaimed amount');
  console.log(`- ${id}`);
  console.log(`    sells ${name(o.sell_token)} at point ${o.point}: remaining ${human(remain, o.sell_token)}, bought ${human(amount(o.bought_amount, 'bought amount'), o.buy_token)}, unclaimed ${human(unclaimed, o.buy_token)}`);
  if (o.pool_id !== PINNED_POOL) { stops.push(`order ${id} is on another pool`); continue; }
  if (remain > 0n) { console.log('    next: CANCEL (no amount): returns the rest and what was bought'); orderCommands.push(command(key('cancel', id), 'cancel_order', { order_id: id }, '180000000000000')); }
  else if (unclaimed > 0n) { console.log('    next: CLAIM (amount "0"): collects what was bought'); orderCommands.push(command(key('claim', id), 'cancel_order', { order_id: id, amount: '0' }, '180000000000000')); }
  else console.log('    next: nothing to do');
}

const assets = await list('list_user_assets', 'object');
if (!storage && positions.length) stops.push('liquidity positions without a DCL registration');
const positive = Object.entries(assets).filter(([, v]) => amount(v, 'internal balance') > 0n);
console.log(`\nInternal DCL balances: ${positive.length ? '' : 'none'}`);
for (const [token, v] of positive) {
  console.log(`- ${name(token)}: ${human(amount(v, 'internal balance'), token)}`);
  if (DECIMALS[token] === undefined) stops.push(`internal balance of ${token}, which the wallet recovery does not cover`);
  else withdrawCommands.push(command(key('withdraw', token), 'withdraw_asset', { token_id: token }, '250000000000000'));
}

const lost = await list('list_lostfound', 'object');
if (Object.values(lost).some(v => amount(v, 'lost-found balance') > 0n)) stops.push('lost-found balances');
if (storage) {
  // Positions are listed above, with their commands. Hidden positions would be slots that no listed row accounts for.
  if (storage.cur_liquidity_slots !== positions.length) stops.push(`DCL counts ${storage.cur_liquidity_slots} position slots but lists ${positions.length} positions`);
  // A filled order can stay listed after DCL frees its slot (FINDINGS 1.38), so only more slots than listed orders means hidden orders.
  if (storage.cur_order_slots > active.length) stops.push(`DCL counts ${storage.cur_order_slots} order slots but lists ${active.length} active orders`);
}

let acct;
try { acct = await rpc.viewAccount(account); } catch { fail('wallet account'); }
const wnear = amount(await view(WNEAR, 'ft_balance_of', { account_id: account }), 'wNEAR balance');
const usdc = amount(await view(USDC, 'ft_balance_of', { account_id: account }), 'USDC balance');
console.log(`\nWallet: ${acct ? `${human(acct.amount, WNEAR).replace('wNEAR', 'NEAR')} total, ${human(spendableNear(acct, 0n), WNEAR).replace('wNEAR', 'NEAR')} free` : 'account does not exist'}, ${human(wnear, WNEAR)}, ${human(usdc, USDC)}`);

if (stops.length) {
  console.log('\nSTOP. The runbook commands do not cover this state:');
  stops.forEach(s => console.log(`  - ${s}`));
  console.log('Do not run any recovery command. Keep the link, the database and the KEK, and ask for help.');
} else if (positionCommands.length) {
  console.log('\nNext, one command at a time, after setting WK as the runbook says. Run this status again after each one. Positions come first; orders and internal balances only after they are gone:');
  positionCommands.forEach(c => console.log(c));
} else if (orderCommands.length) {
  console.log('\nNext, one command at a time, after setting WK as the runbook says. Run this status again before each one, and withdraw internal balances only after the orders are gone:');
  orderCommands.forEach(c => console.log(c));
} else if (withdrawCommands.length) {
  console.log('\nNext, one command at a time, after setting WK as the runbook says. Run this status again after each one:');
  withdrawCommands.forEach(c => console.log(c));
} else {
  console.log('\nDCL holds nothing of this account. Next: the Phase 1 "Recovery without the worker" for wallet wNEAR, USDC and NEAR.');
}
