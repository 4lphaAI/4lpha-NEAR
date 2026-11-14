/** Reports user actions to activity.nearbuilders.org (public, permanent events, actor = the user's NEAR account).
 * Fire and forget: a report never throws, never blocks or changes the action, and logs only the event type and HTTP status. */
export const ACTIVITY_URL = 'https://activity.nearbuilders.org/api/v1/events';

export interface ActivityEvent { eventType: string; actor: string; idempotencyKey: string; payload?: Record<string, string> }
export type ReportActivity = (event: ActivityEvent) => void;

export function createActivity(apiKey: string | undefined, fetchImpl: typeof fetch = fetch, wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))): ReportActivity | undefined {
  if (!apiKey) return undefined;
  async function send(event: ActivityEvent) {
    const body = JSON.stringify({ payload: {}, ...event });
    for (let attempt = 0; attempt < 3; attempt++) {
      let status = 0;
      try {
        const res = await fetchImpl(ACTIVITY_URL, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(10_000) });
        status = res.status;
        if (res.ok) return;
      } catch { /* Network error: retried below with the same body. */ }
      // Retry only 503 and network errors, with the exact same body; any other status is final (409 = same key, different content).
      if (status !== 0 && status !== 503) { console.error(`Activity report ${event.eventType} refused: HTTP ${status}`); return; }
      if (attempt < 2) await wait(2_000 * 2 ** attempt);
    }
    console.error(`Activity report ${event.eventType} failed: unavailable`);
  }
  return event => { void send(event).catch(() => { /* Never reaches the caller. */ }); };
}

export function activityEnv(local: Record<string, string | undefined>): ReportActivity | undefined {
  return createActivity(process.env.ACTIVITY_API_KEY || local.ACTIVITY_API_KEY);
}
