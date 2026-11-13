import { DatabaseSync } from 'node:sqlite';

export interface RpcGroup { key: string; spacing: 250 | 500; }
export type RpcGrant = { token: string; timeout: number };
export interface RpcCoordinator {
  enqueue(group: RpcGroup, ticket: string, deadline: number, receipt: boolean, now: () => number): boolean;
  take(group: RpcGroup, ticket: string, timeout: number, now: () => number, deadline?: number): RpcGrant | number | null;
  cancel(group: RpcGroup, ticket: string, lockBudget?: number): void;
  finish(group: RpcGroup, token: string, cooldownUntil: number, lockBudget?: number): void;
}

export const RPC_QUEUE_LIMIT = 128;
export const rpcSchema = `
CREATE TABLE IF NOT EXISTS rpc_groups (id TEXT PRIMARY KEY CHECK(length(id)=64), started_at INTEGER, cooldown_until INTEGER NOT NULL DEFAULT 0,
  CHECK(started_at >= 0), CHECK(cooldown_until >= 0)) STRICT;
CREATE TABLE IF NOT EXISTS rpc_tickets (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE CHECK(length(id)=36),
  provider TEXT NOT NULL REFERENCES rpc_groups(id), priority INTEGER NOT NULL CHECK(priority IN (0,1)),
  queued_at INTEGER NOT NULL CHECK(queued_at >= 0), deadline INTEGER NOT NULL CHECK(deadline > queued_at), lease INTEGER CHECK(lease > queued_at)) STRICT;
CREATE INDEX IF NOT EXISTS rpc_ticket_provider ON rpc_tickets(provider);
`;

function timestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid RPC pacing state.');
  return value;
}

export function sqliteRpcCoordinator(db: DatabaseSync, role: 'web' | 'worker' | 'watchdog' | 'meme' | 'demo',
  tx: <T>(fn: () => T, lockBudget?: number) => T): RpcCoordinator {
  const prune = db.prepare('DELETE FROM rpc_tickets WHERE provider=? AND coalesce(lease,deadline)<=?');
  const groupRow = db.prepare('SELECT started_at,cooldown_until FROM rpc_groups WHERE id=?');
  const ensure = db.prepare('INSERT OR IGNORE INTO rpc_groups (id) VALUES (?)');
  const waiting = db.prepare('SELECT count(*) AS n FROM rpc_tickets WHERE provider=? AND lease IS NULL');
  const add = db.prepare('INSERT INTO rpc_tickets (id,provider,priority,queued_at,deadline) VALUES (?,?,?,?,?)');
  const ticketRow = db.prepare('SELECT deadline,lease FROM rpc_tickets WHERE provider=? AND id=?');
  const head = db.prepare('SELECT id FROM rpc_tickets WHERE provider=? AND lease IS NULL ORDER BY CASE WHEN queued_at<=? THEN 0 ELSE 2-priority END, seq LIMIT 1');
  const capacity = db.prepare('SELECT count(*) AS n, min(lease) AS first FROM rpc_tickets WHERE provider=? AND lease IS NOT NULL');
  const start = db.prepare('UPDATE rpc_groups SET started_at=? WHERE id=?');
  const grant = db.prepare('UPDATE rpc_tickets SET lease=? WHERE provider=? AND id=? AND lease IS NULL');
  const dropWaiting = db.prepare('DELETE FROM rpc_tickets WHERE provider=? AND id=? AND lease IS NULL');
  const dropGrant = db.prepare('DELETE FROM rpc_tickets WHERE provider=? AND id=? AND lease IS NOT NULL');
  const cool = db.prepare('UPDATE rpc_groups SET cooldown_until=max(cooldown_until,?) WHERE id=?');
  function groupState(group: RpcGroup) {
    const state = groupRow.get(group.key);
    if (!state || (group.spacing !== 250 && group.spacing !== 500)) throw new Error('Invalid RPC pacing state.');
    return { started: state.started_at === null ? null : timestamp(state.started_at), cooldown: timestamp(state.cooldown_until) };
  }
  return {
    enqueue(group, ticket, deadline, receipt, now) {
      return tx(() => {
        const at = timestamp(now());
        if (timestamp(deadline) <= at) return false;
        ensure.run(group.key);
        const state = groupState(group);
        prune.run(group.key, at);
        if (state.cooldown > at || timestamp(waiting.get(group.key)?.n) >= RPC_QUEUE_LIMIT) return false;
        const priority = role === 'watchdog' || (role === 'worker' && receipt);
        add.run(ticket, group.key, Number(priority), at, deadline);
        return true;
      }, Math.max(0, deadline - now()));
    },
    take(group, ticket, timeout, now, deadline) {
      return tx(() => {
        const at = timestamp(now()), state = groupState(group);
        prune.run(group.key, at);
        const queued = ticketRow.get(group.key, ticket);
        if (!queued || queued.lease !== null || state.cooldown > at) return null;
        const remaining = timestamp(queued.deadline) - at;
        if (remaining <= 0) return null;
        if (head.get(group.key, at - 3000)?.id !== ticket) return Math.min(remaining, 100);
        const active = capacity.get(group.key);
        const n = timestamp(active?.n);
        if (n > 2) throw new Error('Invalid RPC pacing state.');
        const earliest = Math.max(state.started === null ? at : state.started + group.spacing, n === 2 ? timestamp(active?.first) : at);
        if (earliest > at) return Math.min(remaining, earliest - at, 100);
        const bounded = Math.min(timestamp(timeout), remaining);
        if (bounded < 1) return null;
        start.run(at, group.key);
        if (grant.run(at + bounded + 1000, group.key, ticket).changes !== 1) throw new Error('Invalid RPC pacing state.');
        return { token: ticket, timeout: bounded };
      }, deadline === undefined ? undefined : Math.max(0, deadline - now()));
    },
    cancel(group, ticket, lockBudget) { tx(() => dropWaiting.run(group.key, ticket), lockBudget); },
    finish(group, token, cooldownUntil, lockBudget) {
      tx(() => {
        if (timestamp(cooldownUntil) > 0) cool.run(cooldownUntil, group.key);
        dropGrant.run(group.key, token);
      }, lockBudget);
    },
  };
}

export function memoryRpcCoordinator(): RpcCoordinator {
  const db = new DatabaseSync(':memory:');
  db.exec(rpcSchema);
  return sqliteRpcCoordinator(db, 'web', fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  });
}
