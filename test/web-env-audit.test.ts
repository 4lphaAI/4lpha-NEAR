// Audit evidence for finding L-4 of UI-AUDIT-REPORT.md: no wired test calls webEnv, so nothing pins the fail-closed flag defaults
// on the line resolved by hand in merge f5dbef5. Wired into `npm test`.
import assert from 'node:assert/strict';
import test from 'node:test';
import { webEnv } from '../src/core/config.js';

test('audit: every web feature flag is off unless it is exactly 1, and Grid V2 also needs Grid V1', () => {
  const flags = (env: Record<string, string>) => { const { liveHires, gridV1, gridV2, lpV1, memePaper } = webEnv(env); return { liveHires, gridV1, gridV2, lpV1, memePaper }; };
  const off = { liveHires: false, gridV1: false, gridV2: false, lpV1: false, memePaper: false };
  assert.deepEqual(flags({}), off);
  for (const value of ['', '0', 'true', 'yes', ' 1', '1 ', '01']) {
    assert.deepEqual(flags({ FOURLPHA_LIVE_HIRES: value, FOURLPHA_GRID_V1: value, FOURLPHA_GRID_V2: value, FOURLPHA_LP_V1: value, FOURLPHA_MEME_PAPER: value }), off, JSON.stringify(value));
  }
  assert.deepEqual(flags({ FOURLPHA_MEME_PAPER: '1' }), { ...off, memePaper: true });
  assert.deepEqual(flags({ FOURLPHA_GRID_V2: '1' }), off);
  assert.deepEqual(flags({ FOURLPHA_GRID_V1: '1' }), { ...off, gridV1: true });
  assert.deepEqual(flags({ FOURLPHA_GRID_V1: '1', FOURLPHA_GRID_V2: '1' }), { ...off, gridV1: true, gridV2: true });
  assert.deepEqual(flags({ FOURLPHA_LIVE_HIRES: '1', FOURLPHA_LP_V1: '1' }), { ...off, liveHires: true, lpV1: true });
});
