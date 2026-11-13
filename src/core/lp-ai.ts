import { record } from './errors.js';
import type { LpRange } from './lp.js';
import { lpCentred, lpRangeOk } from './lp-settings.js';

export interface LpAiInput {
  poolId: string; fee: number; point: number; range: LpRange;
  bounds: { minWidth: number; maxWidth: number };
  history: { at: number; point: number }[];
}
export type LpAi = (input: LpAiInput, signal: AbortSignal) => Promise<unknown>;

// Measured on mainnet 2026-11-10 (FINDINGS 1.43): with reasoning on, the default model spent the whole token budget thinking and returned no content
// after 19 to 29 s. With thinking off and the rules spelled out it answers a fence-passing range in about 2 s.
const SYSTEM = 'You choose the next concentrated-liquidity range for a Rhea DCL pool. Points are integers; a higher point means a lower NEAR price. ' +
  '"point" is the current pool point, "range" is the previous range, "history" is recent points (oldest first). ' +
  'Return only a JSON object {"left": integer, "right": integer} with left < right, right - left between bounds.minWidth and bounds.maxWidth, ' +
  'and point inside the range with at least 10 percent of the width on each side. Keep it near centred on point; lean slightly toward the recent trend only if history shows one.';

export function lpAiRange(input: LpAiInput, proposal: unknown): LpRange & { verdict: 'accepted' | 'fallback'; code?: string } {
  let code = 'malformed';
  try {
    const r = record(proposal);
    if (r && Object.keys(r).length === 2 && Object.hasOwn(r, 'left') && Object.hasOwn(r, 'right') && Number.isSafeInteger(r.left) && Number.isSafeInteger(r.right)) {
      const range = r as unknown as LpRange, width = range.right - range.left;
      code = width < input.bounds.minWidth || width > input.bounds.maxWidth ? 'width' : !lpRangeOk(range, input.point) ? 'misplaced' : '';
      if (!code) return { ...range, verdict: 'accepted' };
    }
  } catch { /* Only fixed verdicts leave the fence. */ }
  return { ...(lpCentred(input.range.right - input.range.left, input.point) ?? input.range), verdict: 'fallback', code };
}

export function createLpAi(key: string, model = 'z-ai/glm-5.3-flash', fetcher: typeof fetch = fetch): LpAi {
  return async (input, signal) => {
    try {
      signal.throwIfAborted();
      const response = await fetcher('https://cloud-api.near.ai/v1/chat/completions', {
        method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, temperature: 0, max_tokens: 300, response_format: { type: 'json_object' }, chat_template_kwargs: { enable_thinking: false },
          messages: [{ role: 'system', content: SYSTEM },
            { role: 'user', content: JSON.stringify(input) }] }),
      });
      if (response.status !== 200) { void response.body?.cancel().catch(() => {}); throw new Error('http'); }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('malformed');
      const chunks: Uint8Array[] = [];
      let length = 0;
      const abort = () => { void reader.cancel().catch(() => {}); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 16_384) throw new Error('malformed');
          chunks.push(value);
        }
      } finally { signal.removeEventListener('abort', abort); void reader.cancel().catch(() => {}); }
      signal.throwIfAborted();
      const envelope = record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const content = record(record(Array.isArray(envelope?.choices) ? envelope.choices[0] : null)?.message)?.content;
      if (typeof content !== 'string') throw new Error('malformed');
      try { return JSON.parse(content) as unknown; } catch { throw new Error('malformed'); }
    } catch (e) {
      const code = signal.aborted ? 'timeout' : e instanceof Error && ['http', 'malformed'].includes(e.message) ? e.message : e instanceof SyntaxError ? 'malformed' : 'unavailable';
      throw new Error(code);
    }
  };
}
