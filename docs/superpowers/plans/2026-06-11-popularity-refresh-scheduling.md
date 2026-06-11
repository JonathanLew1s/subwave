# Popularity Refresh Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `popularity_song`/`popularity_album` backfill from Navidrome's custom tags run automatically (on controller boot + weekly), instead of only via a manually-invoked `npm run analyze -- --walk`, and tighten the picker's popularity floor from 15th to 30th percentile.

**Architecture:** Extract the existing per-track popularity backfill loop (currently inline in `analyze-library.ts`'s CLI) into a new shared module `controller/src/music/popularity.ts` exporting `refreshPopularity()`. The CLI (`analyze-library.ts`) and the long-running controller's cron scheduler (`broadcast/scheduler.ts`) both call this function — the CLI keeps its existing `--walk`-gated behaviour, and the scheduler runs it once on boot plus every Sunday at 3am. Also bump `pool.ts`'s `POPULARITY_FLOOR_PERCENTILE` from 15 to 30.

**Tech Stack:** TypeScript (ESM, Node.js), `node-cron`, `better-sqlite3` via `library-db.ts`. No test runner in this project — verification is `npm run lint` (`eslint . && tsc --noEmit`), the repo's actual merge gate (per `controller/CLAUDE.md` / root `CLAUDE.md`).

---

## File Structure

- **Create:** `controller/src/music/popularity.ts` — new shared module, single export `refreshPopularity()`.
- **Modify:** `controller/src/music/analyze-library.ts` — remove local `walkPopularityTags`, call `refreshPopularity()` instead.
- **Modify:** `controller/src/broadcast/scheduler.ts` — add `refreshPopularityScores()` handler, wire into `startScheduler()`.
- **Modify:** `controller/src/music/pool.ts` — `POPULARITY_FLOOR_PERCENTILE` 15 → 30.

---

### Task 1: Create the shared `popularity.ts` module

**Files:**
- Create: `controller/src/music/popularity.ts`

- [ ] **Step 1: Write the module**

```ts
// controller/src/music/popularity.ts
//
// Backfills tracks.popularity_song / tracks.popularity_album from Navidrome's
// native /api/song endpoint (TrackPopularity / AlbumPopularity custom tags,
// sourced from beets). Shared by the analyze-library CLI (npm run analyze
// -- --walk) and the controller's cron scheduler (broadcast/scheduler.ts),
// which runs this on boot and weekly so newly-tagged/added tracks pick up
// popularity scores without an operator running the CLI.

import * as db from './library-db.js';
import * as navidrome from './navidrome-api.js';
import { config } from '../config.js';
import * as library from './library.js';

export async function refreshPopularity(): Promise<number> {
  if (!config.navidrome.user || !config.navidrome.password) {
    throw new Error('Navidrome credentials not configured');
  }
  await library.load();
  let count = 0;
  for await (const pop of navidrome.iteratePopularityTags(config.navidrome.user, config.navidrome.password)) {
    db.setPopularity(pop.id, { song: pop.trackPopularity, album: pop.albumPopularity });
    count++;
  }
  return count;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd controller && npm run lint`
Expected: passes (new file is unused so far, but must compile cleanly — no unresolved imports, no type errors).

- [ ] **Step 3: Commit**

```bash
git add controller/src/music/popularity.ts
git commit -m "feat(picker): add shared popularity refresh module"
```

---

### Task 2: Switch `analyze-library.ts` to the shared module

**Files:**
- Modify: `controller/src/music/analyze-library.ts:31` (import), `:40-50` (function definition), `:133-139` (call site)

- [ ] **Step 1: Remove the now-unused `navidrome-api` import and local function**

In `controller/src/music/analyze-library.ts`, remove line 31:

```ts
import * as navidrome from './navidrome-api.js';
```

and remove lines 40-50 (the entire `walkPopularityTags` function, including its blank-line separator before the `applyWizardOverlay` comment):

```ts
export async function walkPopularityTags(username: string, password: string) {
  let count = 0;
  for await (const pop of navidrome.iteratePopularityTags(username, password)) {
    db.setPopularity(pop.id, { song: pop.trackPopularity, album: pop.albumPopularity });
    count++;
    if (count % 1000 === 0) {
      console.log(`[analyze] popularity backfilled: ${count}`);
    }
  }
  console.log(`[analyze] popularity backfill complete: ${count} tracks`);
}
```

- [ ] **Step 2: Add the new import**

Add alongside the other local imports near the top of `controller/src/music/analyze-library.ts` (e.g. next to the `analyzer` import):

```ts
import { refreshPopularity } from './popularity.js';
```

- [ ] **Step 3: Update the call site**

Replace the existing block (originally lines 131-139):

```ts
    // Popularity pass — fetch track/album popularity from Navidrome custom tags
    // after metadata walk completes.
    if (config.navidrome.user && config.navidrome.password) {
      try {
        await walkPopularityTags(config.navidrome.user, config.navidrome.password);
      } catch (err: any) {
        console.error('[analyze] popularity backfill failed:', err.message);
      }
    }
```

with:

```ts
    // Popularity pass — fetch track/album popularity from Navidrome custom tags
    // after metadata walk completes.
    if (config.navidrome.user && config.navidrome.password) {
      try {
        const count = await refreshPopularity();
        console.log(`[analyze] popularity backfill complete: ${count} tracks`);
      } catch (err: any) {
        console.error('[analyze] popularity backfill failed:', err.message);
      }
    }
```

- [ ] **Step 4: Typecheck**

Run: `cd controller && npm run lint`
Expected: passes — no unresolved `navidrome-api` import, no unused `db` import (still used elsewhere in the file by `upsertTrackMeta`/`pruneMissingTracks`), `refreshPopularity` resolves from `./popularity.js`.

- [ ] **Step 5: Commit**

```bash
git add controller/src/music/analyze-library.ts
git commit -m "refactor(picker): use shared popularity module in analyze CLI"
```

---

### Task 3: Schedule popularity refresh in the controller

**Files:**
- Modify: `controller/src/broadcast/scheduler.ts`

- [ ] **Step 1: Add the import**

In `controller/src/broadcast/scheduler.ts`, add to the import block (near the other `music/*` imports, e.g. after `import * as pool from '../music/pool.js';` on line 23):

```ts
import { refreshPopularity } from '../music/popularity.js';
```

- [ ] **Step 2: Add the handler**

Add a new section before the `START` section (i.e. before the `// START` comment block that currently starts at line 287). Place it after the `CLEAN UP` section:

```ts
// ---------------------------------------------------------------------------
// POPULARITY REFRESH
// Backfills tracks.popularity_song / tracks.popularity_album from Navidrome's
// custom tags (beets-derived). Cheap (~80 paginated /api/song requests for a
// ~40k-track library) — run on every boot (self-heals after restarts/deploys
// that miss the weekly tick) and weekly thereafter.
// ---------------------------------------------------------------------------

async function refreshPopularityScores() {
  if (!config.navidrome.user || !config.navidrome.password) return;
  try {
    const count = await refreshPopularity();
    queue.log('scheduler', `Popularity refresh: updated ${count} tracks`);
  } catch (err: any) {
    queue.log('error', `Popularity refresh failed: ${err.message}`);
  }
}
```

- [ ] **Step 3: Wire it into `startScheduler()`**

In `startScheduler()`, the function currently reads (lines 291-314):

```ts
export function startScheduler() {
  // Initial run
  refreshAutoPlaylist().catch(err => queue.log('error', `Initial playlist failed: ${err.message}`));

  // Auto-playlist refresh every 10 minutes
  cron.schedule(`*/${config.show.autoQueueRefreshMinutes} * * * *`, refreshAutoPlaylist);

  // Top of every hour
  cron.schedule('0 * * * *', hourlyCheck);

  // Segment tick every 5 minutes — the segment-director agent decides whether
  // to air a segment; per-kind cooldowns and the frequency floor live in it.
  cron.schedule('*/5 * * * *', skillsTick);

  // Station ID candidate ticks at :15, :30, :45 — handler gates by frequency.
  // Deliberately NOT :00: the hourly check owns the top of the hour, and firing
  // both there stacked two voice segments on each other (issue #310).
  cron.schedule('15,30,45 * * * *', stationId);

  // Cleanup every hour
  cron.schedule('0 * * * *', cleanup);

  queue.log('scheduler', `Scheduler started · skills: ${skillCatalog().map((s: any) => s.name).join(', ')}`);
}
```

Replace it with:

```ts
export function startScheduler() {
  // Initial run
  refreshAutoPlaylist().catch(err => queue.log('error', `Initial playlist failed: ${err.message}`));

  // Popularity refresh on boot — self-heals if a pod restart missed the
  // weekly cron tick below.
  refreshPopularityScores().catch(err => queue.log('error', `Initial popularity refresh failed: ${err.message}`));

  // Auto-playlist refresh every 10 minutes
  cron.schedule(`*/${config.show.autoQueueRefreshMinutes} * * * *`, refreshAutoPlaylist);

  // Top of every hour
  cron.schedule('0 * * * *', hourlyCheck);

  // Segment tick every 5 minutes — the segment-director agent decides whether
  // to air a segment; per-kind cooldowns and the frequency floor live in it.
  cron.schedule('*/5 * * * *', skillsTick);

  // Station ID candidate ticks at :15, :30, :45 — handler gates by frequency.
  // Deliberately NOT :00: the hourly check owns the top of the hour, and firing
  // both there stacked two voice segments on each other (issue #310).
  cron.schedule('15,30,45 * * * *', stationId);

  // Cleanup every hour
  cron.schedule('0 * * * *', cleanup);

  // Popularity refresh weekly — Sunday 3am, picks up new beets tags / library additions.
  cron.schedule('0 3 * * 0', refreshPopularityScores);

  queue.log('scheduler', `Scheduler started · skills: ${skillCatalog().map((s: any) => s.name).join(', ')}`);
}
```

Note the `refreshPopularityScores` handler already no-ops (returns early) when Navidrome credentials aren't configured, so this is safe in setups without Navidrome popularity tagging.

- [ ] **Step 4: Typecheck**

Run: `cd controller && npm run lint`
Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add controller/src/broadcast/scheduler.ts
git commit -m "feat(picker): refresh popularity scores on boot and weekly"
```

---

### Task 4: Raise the popularity floor percentile

**Files:**
- Modify: `controller/src/music/pool.ts:40`

- [ ] **Step 1: Change the constant**

In `controller/src/music/pool.ts`, change:

```ts
const POPULARITY_FLOOR_PERCENTILE = 15;
```

to:

```ts
const POPULARITY_FLOOR_PERCENTILE = 30;
```

- [ ] **Step 2: Typecheck**

Run: `cd controller && npm run lint`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add controller/src/music/pool.ts
git commit -m "fix(picker): raise popularity floor to 30th percentile"
```

---

## Self-Review Notes

- **Spec coverage:** shared module (Task 1) ✅, CLI switch (Task 2) ✅, weekly cron + boot run (Task 3) ✅, floor bump (Task 4) ✅. "Out of scope" items (settings/UI toggle, staleness tracking) deliberately not implemented.
- **Type consistency:** `refreshPopularity()` returns `Promise<number>` everywhere it's used (CLI logs the count, scheduler logs the count). `db.setPopularity`'s signature (`{ song, album }`) matches `iteratePopularityTags`'s yielded shape (`{ id, trackPopularity, albumPopularity }`) — unchanged from the existing working code, just relocated.
- **No placeholders:** every step has full code.
