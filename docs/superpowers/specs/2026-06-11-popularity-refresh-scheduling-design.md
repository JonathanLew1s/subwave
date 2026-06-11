# Popularity refresh scheduling

## Context

`controller/src/music/pool.ts` uses per-track `popularitySong`/`popularityAlbum`
scores (sourced from beets-written `TrackPopularity`/`AlbumPopularity` tags,
exposed by Navidrome's native `/api/song` API and stored in
`tracks.popularity_song` / `tracks.popularity_album`) for two things:

- a **floor** that drops the bottom N% of the mood-curated universe by
  `popularitySong` (tracks with `null` popularity are neutral — never
  excluded by the floor)
- a **popularity-weighted slice** of the brief pool, ranking by
  `popularitySong * 0.8 + popularityAlbum * 0.2` (`null` scores as `0`, so
  un-scored tracks sort to the bottom of this slice but remain eligible via
  the genre/energy/vibe/eclectic slices)

Today, populating these columns (`walkPopularityTags`, defined in
`analyze-library.ts`) only happens as part of `npm run analyze -- --walk`,
itself gated to "catalogue empty OR `--walk` passed" — i.e. it requires an
operator to remember to run a specific CLI command after every beets re-tag +
Navidrome rescan. This spec makes that refresh automatic.

## Changes

### 1. Extract `controller/src/music/popularity.ts`

`analyze-library.ts` runs its CLI `main()` unconditionally at module load, so
the scheduler can't import from it directly. Extract the existing backfill
loop into a new shared module:

```ts
// controller/src/music/popularity.ts
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

### 2. `analyze-library.ts`

Replace the local `walkPopularityTags` definition with an import of
`refreshPopularity` from `./popularity.js`. The existing call site (inside
the `if (shouldWalk)` block, wrapped in try/catch with
`[analyze] popularity backfill ...` logging) is unchanged — it just calls the
relocated function. CLI behavior (`--walk`-gated) is otherwise unchanged.

### 3. `scheduler.ts`

Add a handler:

```ts
async function refreshPopularityScores() {
  if (!config.navidrome.user || !config.navidrome.password) return;
  try {
    const count = await popularity.refreshPopularity();
    queue.log('scheduler', `Popularity refresh: updated ${count} tracks`);
  } catch (err: any) {
    queue.log('scheduler', `Popularity refresh failed: ${err.message}`);
  }
}
```

Wire it in `start()` two ways, alongside the existing `cron.schedule(...)`
calls:

- `cron.schedule('0 3 * * 0', refreshPopularityScores)` — 3am every Sunday.
- Fire-and-forget once on controller boot (e.g. via `setTimeout` a short
  delay after `start()` runs, matching the style of other init-time kicks).
  This matters because controller pods in this deployment restart fairly
  often — relying on the weekly cron alone risks the Sunday tick landing
  while the pod is down for an unrelated reason, leaving popularity stale for
  another week. Running on every boot makes this self-healing at near-zero
  cost (~79 paginated `/api/song` requests + UPDATEs for ~39k tracks, well
  under a minute).

### 4. `pool.ts`

`POPULARITY_FLOOR_PERCENTILE`: `15` → `30`.

## Out of scope

- No new settings/UI toggle — this mirrors other always-on scheduler tasks
  (`hourlyCheck`, `stationId`, etc.) which aren't independently configurable.
- No persisted "last refresh" timestamp / staleness tracking — boot + weekly
  cron is considered sufficient given the cost is negligible.
