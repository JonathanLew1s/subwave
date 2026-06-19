// Ring buffer + durable log for MA composite-shortlist shadow comparisons —
// modelled directly on broadcast/request-log.ts. Every entry records what the
// live picker actually chose alongside what the new composite shortlist
// would have offered, for review before any production cutover. Computing
// and recording an entry must never affect playback — see the try/catch
// wrapping in dj-agent.ts's runTrackEvent, which is the only caller of
// `record`.

import { appendFile } from 'node:fs/promises';
import { statSync, renameSync, readFileSync } from 'node:fs';
import { STATE_DIR } from '../config.js';

const MAX_ENTRIES = 150;
export const recentShadowPicks: any[] = [];

const SHADOW_LOG = `${STATE_DIR}/logs/picker-shadow.log`;
const SHADOW_LOG_MAX_BYTES = 10 * 1024 * 1024;

function maybeRotateLog() {
  try {
    if (statSync(SHADOW_LOG).size > SHADOW_LOG_MAX_BYTES) {
      renameSync(SHADOW_LOG, `${SHADOW_LOG}.old`);
    }
  } catch {}
}

function hydrateFromDisk() {
  try {
    const text = readFileSync(SHADOW_LOG, 'utf8');
    const lines = text.split('\n').filter(Boolean).slice(-MAX_ENTRIES);
    for (const line of lines) {
      try {
        recentShadowPicks.unshift(JSON.parse(line));
      } catch {}
    }
    if (recentShadowPicks.length > MAX_ENTRIES) recentShadowPicks.length = MAX_ENTRIES;
  } catch {}
}

maybeRotateLog();
hydrateFromDisk();
let _appendsSinceRotateCheck = 0;

export function record(entry: any) {
  recentShadowPicks.unshift(entry);
  if (recentShadowPicks.length > MAX_ENTRIES) recentShadowPicks.length = MAX_ENTRIES;

  let line: string;
  try {
    line = JSON.stringify(entry) + '\n';
  } catch {
    return;
  }
  if (++_appendsSinceRotateCheck >= 1000) {
    _appendsSinceRotateCheck = 0;
    maybeRotateLog();
  }
  appendFile(SHADOW_LOG, line).catch(() => {});
}

export function snapshot(limit = 50) {
  return recentShadowPicks.slice(0, limit);
}
