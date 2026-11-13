// Prints the Trade paper start id (read on every launch): one below the lowest meme.cooking auction still open,
// or the highest id when none is open. Read-only, public API. Prints nothing and exits 1 on any failure.
const res = await fetch('https://api.meme.cooking/meme', { signal: AbortSignal.timeout(30_000) }).catch(() => null);
const list = res?.ok ? await res.json().catch(() => null) : null;
if (!Array.isArray(list) || list.length === 0) process.exit(1);
const now = Date.now();
const ids = list.map(m => Number(m?.meme_id)).filter(Number.isSafeInteger);
const open = list.filter(m => !m?.is_finalized && Number(m?.end_timestamp_ms) > now).map(m => Number(m.meme_id)).filter(Number.isSafeInteger);
if (ids.length === 0) process.exit(1);
console.log(String(open.length ? Math.max(0, Math.min(...open) - 1) : Math.max(...ids)));
