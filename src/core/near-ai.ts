import { record } from './errors.js';

export type AiFailure = 'unavailable' | 'timeout' | 'http' | 'malformed';
export type AiResult = { data: unknown; error?: undefined } | { data: null; error: AiFailure };
export type NearAi = (system: string, user: string) => Promise<AiResult>;

export function createNearAi(key: string, model = 'z-ai/glm-5.3-flash', send: typeof fetch = fetch): NearAi {
  return async (system, user) => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<AiResult>(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ data: null, error: 'timeout' }); }, 15_000); });
    const request = async (): Promise<AiResult> => {
      try {
        const response = await send('https://cloud-api.near.ai/v1/chat/completions', { method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
            temperature: 0, max_tokens: 200, response_format: { type: 'json_object' } }) });
        if (!response.ok) { void response.body?.cancel().catch(() => {}); return { data: null, error: 'http' }; }
        const reader = response.body?.getReader();
        if (!reader) return { data: null, error: 'malformed' };
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 16_384) { void reader.cancel().catch(() => {}); return { data: null, error: 'malformed' }; }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        try {
          const r = record(JSON.parse(Buffer.concat(chunks).toString('utf8'))), choices = r?.choices;
          const content = Array.isArray(choices) ? record(record(choices[0])?.message)?.content : null;
          if (typeof content !== 'string') return { data: null, error: 'malformed' };
          return { data: JSON.parse(content) as unknown };
        } catch { return { data: null, error: 'malformed' }; }
      } catch { return { data: null, error: controller.signal.aborted ? 'timeout' : 'unavailable' }; }
    };
    try { return await Promise.race([request(), timeout]); }
    finally { clearTimeout(timer); }
  };
}
