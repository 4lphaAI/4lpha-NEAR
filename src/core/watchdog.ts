import { parseAmount } from './amounts.js';
import { provenEffects, receiptInterval, recipientProblems, type Intent, type OpKind } from './evidence.js';
import { readDclBefore } from './dcl-evidence.js';
import { record } from './errors.js';
import { gridKnownOrders } from './grid.js';
import { lpKnownPositions } from './lp.js';
import { boundWallet, jobTokens } from './hire.js';
import { holdingsDelta, parseHoldings, readHoldings, unexplained } from './holdings.js';
import { RpcUnavailable, type NearRpc } from './near-rpc.js';
import { USDC, WNEAR } from './pins.js';
import { policyHash, readChainPolicy } from './policy.js';
import { parseTxStatus, signedAction } from './receipts.js';
import { dclBlocked, dclOpen, DCL_POOL, jobDclKinds, LP_DCL_KINDS, lpBlocked, readDcl, type DclKind } from './rhea-dcl.js';
import { json, RPC_WAIT, type OpRow, type Store } from './store.js';

export { holdingsDelta, unexplained, recipientProblems };
export type AlertKind = 'token_outflow' | 'native_outflow' | 'bad_recipient' | 'policy_changed' | 'policy_missing'
  | 'owner_mismatch' | 'frozen' | 'unfrozen' | 'blind' | 'verification_error' | 'native_inflow' | 'token_inflow' | 'dcl_holding' | 'dcl_outflow';
export interface AlertDraft { jobId: string; severity: 'info' | 'halt' | 'critical'; kind: AlertKind; detail: Record<string, string>; }

export async function watchOnce(d: { store: Store; rpc: NearRpc; now: () => number }): Promise<AlertDraft[]> {
  const { store, rpc, now } = d;
  const emitted: AlertDraft[] = [];
  for (const job of store.activeJobs()) {
    if (!job.walletId || job.state === 'draft') continue;
    const emit = (kind: AlertKind, severity: AlertDraft['severity'], message: string, detail: Record<string, string> = {}) => {
      const a = { kind, severity, jobId: job.id, detail: { message, ...detail } };
      if (store.insertAlert({ ...a, createdAt: now() })) emitted.push(a);
    };
    const frozenKey = `watch_frozen:${job.id}`;
    try {
      const b = boundWallet(job);
      const tokens = jobTokens(job);
      const armed = job.armedHash !== null;
      const pubkey = `ed25519:${b.agentAccount}`;
      if (armed && job.walletPubkey !== pubkey) throw new Error();
      const old = store.getWatch(job.id), journal = store.watchJournal(job.id), blind = store.meta(`watch_blind:${job.id}`);
      const snapshot = await readHoldings(rpc, b.agentAccount, armed ? [WNEAR, ...tokens] : []);
      const policy = await readChainPolicy(rpc, pubkey, snapshot);
      if (policy.entry && policy.entry.owner !== job.owner) emit('owner_mismatch', 'critical', 'The finalized wallet policy has a different owner.');
      if (armed && !policy.entry) emit('policy_missing', 'critical', 'The wallet has no policy. The worker cannot use it. Use your saved management link.');
      if (armed && policy.entry && policyHash(policy.entry) !== job.armedHash) emit('policy_changed', 'halt', 'The finalized wallet policy changed.');
      if (policy.entry) {
        const was = store.meta(frozenKey), value = String(policy.entry.frozen);
        if (armed && was !== null && was !== value) emit(policy.entry.frozen ? 'frozen' : 'unfrozen', 'info', policy.entry.frozen ? 'The owner froze the wallet.' : 'The owner unfroze the wallet.');
        store.setMeta(frozenKey, value);
      }
      const venue = armed && (job.gridV1 || job.lpV1) ? await readDcl(rpc, b.agentAccount, snapshot, job.gridV1 ? gridKnownOrders(store, job.id) : []) : null;
      // Read the marker after the snapshot so a newly reserved submission cannot move the baseline over its effects.
      const op = store.inFlightOp(b.walletId), heartbeat = store.readHeartbeat('worker');
      const n = now();
      // Halt review M-1: a trade operation may take 95 s to answer, 60 s of polling and 40 s of proof before it is finished.
      if (op?.state === 'submitted' && op.submittedAt !== null && n - op.submittedAt <= (job.trade ? 240_000 : 60_000) && heartbeat !== null && n - heartbeat <= 60_000) {
        store.invalidateWatch(job.id); continue;
      }
      // Fix 4 F4-6: a same-key re-send is treated like a fresh submission for 240 s from its start (95 s answer, 60 s poll, 40 s proof),
      // only while it waits for its answer or after an answer the worker proves (audit M-1); an inconclusive answer ends the skip.
      const resent = op ? store.noReply(op.id) : null, proving = resent?.pending === true || resent?.last?.kind === 'accepted' || resent?.last?.kind === 'reverted';
      if (resent && resent.resends > 0 && proving && resent.at <= n && n - resent.at <= 240_000 && heartbeat !== null && n - heartbeat <= 60_000) {
        store.invalidateWatch(job.id); continue;
      }
      if (old && snapshot.block < old.block) throw new RpcUnavailable();
      const rows = store.jobOps(job.id);
      if (old?.block === snapshot.block || rows.some(r => r.finishedBlock !== null && r.finishedBlock > snapshot.block)) {
        store.invalidateWatch(job.id); continue;
      }
      const currentOrders = venue && job.gridV1 ? dclOpen(venue) : [];
      if (venue && job.lpV1) {
        // An operation that is not finished, or finished after this snapshot, may or may not be visible yet. Either state is accepted for it.
        const lpRows = rows.filter(r => LP_DCL_KINDS.includes(r.kind as DclKind));
        const settled = (r: OpRow) => r.state === 'finished' && r.finishedBlock !== null && r.finishedBlock <= snapshot.block;
        const pending = lpRows.filter(r => r.state !== 'finished');
        const known = lpKnownPositions(store, job.id, snapshot.block);
        const expected: Record<string, bigint> = { [USDC]: 0n, [WNEAR]: 0n }, liquidity = new Map<string, bigint>();
        for (const r of lpRows.filter(settled)) {
          const intent = JSON.parse(r.request) as Intent, args = record(intent.args), proof = record(record(JSON.parse(r.after ?? 'null'))?.dclProof);
          if (r.kind === 'dcl_deposit' && r.verdict === 'success') expected[intent.receiver] += r.used ?? 0n;
          if (r.kind === 'dcl_add' && typeof proof?.lptId === 'string') {
            expected[USDC] -= parseAmount(args?.amount_x, 'offered x'); expected[WNEAR] -= parseAmount(args?.amount_y, 'offered y');
            liquidity.set(proof.lptId, parseAmount(proof.liquidity, 'proven liquidity'));
          }
          if (r.kind === 'dcl_withdraw' && r.verdict === 'success') {
            const token = String(args?.token_id), paid = record(proof?.payouts);
            expected[token] -= parseAmount(paid?.[token] ?? paid?.native ?? '0', 'proven payout');
          }
        }
        const lower = { ...expected }, upper = { ...expected }, adds: { left: unknown; right: unknown }[] = [], removing = new Set<string>();
        for (const r of pending) {
          const intent = JSON.parse(r.request) as Intent, args = record(intent.args);
          if (r.kind === 'dcl_deposit') upper[intent.receiver] += parseAmount(args?.amount, 'signed deposit');
          else if (r.kind === 'dcl_add') {
            lower[USDC] -= parseAmount(args?.amount_x, 'offered x'); lower[WNEAR] -= parseAmount(args?.amount_y, 'offered y');
            adds.push({ left: args?.left_point, right: args?.right_point });
          } else if (r.kind === 'dcl_withdraw') lower[String(args?.token_id)] -= expected[String(args?.token_id)];
          else if (r.kind === 'dcl_remove') removing.add(String(args?.lpt_id));
        }
        const unknown = venue.liquidities.filter(p => !known.includes(p.id));
        const adopted = unknown.length === 1 && unknown[0].pool === DCL_POOL && unknown[0].mft === '' && adds.some(a => a.left === unknown[0].left && a.right === unknown[0].right);
        const internal = (t: string) => venue.assets[t] ?? 0n;
        if (lpBlocked(venue, adopted ? [...known, unknown[0].id] : known) || [USDC, WNEAR].some(t => internal(t) > upper[t])) {
          emit('dcl_holding', 'halt', 'DCL has an unknown position, order, internal balance, lost-found or a farmed position. Review the job and the saved management link.');
        }
        // A discovered-only position has no proven liquidity, so its size is not compared.
        if (known.some(id => !venue.liquidities.some(p => p.id === id) && !removing.has(id)) || venue.liquidities.some(p => p.amount < (liquidity.get(p.id) ?? 0n)) ||
          [USDC, WNEAR].some(t => internal(t) < lower[t])) {
          emit('dcl_outflow', 'halt', 'A tracked DCL position or internal balance decreased without matching proof.');
        }
      }
      if (venue && job.gridV1) {
        const expected = new Set<string>(), completed = new Set<string>(), claimed = new Map<string, bigint>();
        const seenClaims = new Set<string>();
        for (const row of rows) {
          if (!row.txHash || row.finishedBlock === null || row.finishedBlock > snapshot.block) continue;
          const proof = record(record(JSON.parse(row.after ?? 'null'))?.dclProof);
          if (typeof proof?.orderId !== 'string') continue;
          const id = proof.orderId;
          if (row.kind === 'dcl_place' && row.verdict === 'success') expected.add(id);
          if ((row.kind === 'dcl_claim' || row.kind === 'dcl_cancel') && typeof proof.claimed === 'string' && !seenClaims.has(row.txHash)) {
            // Settlement keeps receipt-proven payouts even when a same-point claim leaves the order open.
            claimed.set(id, (claimed.get(id) ?? 0n) + BigInt(proof.claimed));
            seenClaims.add(row.txHash);
            if (proof.completed === true && row.verdict === 'success') completed.add(id);
          }
        }
        if (dclBlocked(venue) || currentOrders.some(o => !expected.has(o.id)) || Object.values(venue.assets).some(n => n > 0n)) {
          emit('dcl_holding', 'halt', 'DCL has an unknown order, internal balance, lost-found or position. Review the job and the saved management link.');
        }
        const changed = currentOrders.find(o => expected.has(o.id) && (o.cancelled > 0n || o.bought - o.unclaimed > (claimed.get(o.id) ?? 0n)));
        if (changed) emit('dcl_outflow', 'halt', 'A tracked DCL order has an unexpected cancellation or an unproven claim.', { orderId: changed.id });
        if (!op && [...expected].some(id => !completed.has(id) && !currentOrders.some(o => o.id === id))) {
          emit('dcl_outflow', 'halt', 'A tracked DCL order disappeared without a proven close.');
        }
      }
      if (old) {
        const prior = parseHoldings(old.holdings), delta = holdingsDelta(prior, snapshot);
        const allowed = { agent: b.agentAccount, owner: job.owner, tokens, dclKinds: jobDclKinds(job) };
        const effects: Record<string, bigint>[] = [];
        const closed = new Set<string>();
        const drained: Record<string, bigint> = {};
        const seen = new Set<string>();
        for (const op of store.opsSince(b.walletId, prior.block)) {
          if (!op.txHash || op.jobId !== job.id || op.finishedBlock === null || op.finishedBlock > snapshot.block || seen.has(op.txHash)) continue;
          seen.add(op.txHash);
          const tx = parseTxStatus(await rpc.txStatus(op.txHash, b.agentAccount));
          if (tx.hash !== op.txHash || tx.signer !== b.agentAccount) throw new RpcUnavailable();
          const interval = await receiptInterval(rpc, tx);
          if (!interval || interval.last > snapshot.block) throw new RpcUnavailable();
          const a = signedAction(tx);
          if (!a || recipientProblems(a, allowed).length) { emit('bad_recipient', 'critical', 'A finalized action had an unexpected destination.', { operation: op.id }); continue; }
          const intent = JSON.parse(op.request) as Intent;
          const proven = provenEffects(tx, op.kind as OpKind, intent, allowed, readDclBefore(op.before));
          if (!proven || interval.first <= prior.block) {
            emit('verification_error', 'halt', 'The watchdog could not verify a finalized operation.');
            continue;
          }
          effects.push(proven.effects);
          if (proven.dcl?.completed && proven.dcl.orderId && op.verdict === 'success') closed.add(proven.dcl.orderId);
          if (op.kind === 'dcl_withdraw' && proven.dcl && typeof intent.args?.token_id === 'string') {
            const token = intent.args.token_id;
            drained[token] = (drained[token] ?? 0n) + (proven.dcl.payouts[token] ?? proven.dcl.payouts.native ?? 0n);
          }
        }
        for (const [token, shortfall] of Object.entries(unexplained(delta, effects))) {
          emit(token === 'native' ? 'native_outflow' : 'token_outflow', !armed && token === 'native' ? 'critical' : 'halt',
            'Finalized holdings decreased without matching receipt evidence.', { asset: token, amount: shortfall.toString() });
        }
        for (const [token, amount] of Object.entries(delta)) if (amount > 0n && amount > effects.reduce((n, e) => n + (e[token] ?? 0n), 0n)) {
          emit(token === 'native' ? 'native_inflow' : 'token_inflow', 'info', 'Finalized holdings increased.', { asset: token, amount: amount.toString() });
        }
        if (venue && job.gridV1) {
          const previous = record(record(JSON.parse(old.holdings))?.dcl);
          const ids = new Set(currentOrders.map(o => o.id));
          // Resting amounts can change as swaps fill an order. Check its identity separately from committed payouts.
          if (Array.isArray(previous?.orders) && previous.orders.some(id => typeof id === 'string' && !ids.has(id) && !closed.has(id))) {
            emit('dcl_outflow', 'halt', 'A tracked DCL order disappeared without a proven close.');
          }
          if (Object.entries(record(previous?.assets) ?? {}).some(([t, raw]) => typeof raw === 'string' && BigInt(raw) > (venue.assets[t] ?? 0n) + (drained[t] ?? 0n))) {
            emit('dcl_outflow', 'halt', 'DCL internal holdings decreased without matching withdrawal proof.');
          }
        }
      }
      store.finishWatch(job, old, { block: snapshot.block, holdings: json({ block: snapshot.block, native: snapshot.native, tokens: snapshot.tokens,
        ...(venue ? { dcl: job.lpV1 ? { positions: venue.liquidities.map(p => p.id), assets: venue.assets } : { orders: currentOrders.map(o => o.id), assets: venue.assets } } : {}) }), updatedAt: now() }, journal, blind,
      policy.entry ? policy.entry.owner === job.owner && !policy.entry.frozen && (!armed || policyHash(policy.entry) === job.armedHash) : !armed);
    } catch (e) {
      if (e instanceof RpcUnavailable) {
        if (store.invalidateWatch(job.id, true) >= 3) emit('blind', 'info', RPC_WAIT);
      } else {
        emit('verification_error', 'halt', 'The watchdog encountered an unexpected verification error.');
        store.invalidateWatch(job.id);
      }
    }
  }
  store.heartbeat('watchdog', now());
  return emitted;
}
