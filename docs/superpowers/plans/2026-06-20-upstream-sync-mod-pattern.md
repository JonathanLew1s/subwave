# Upstream Sync Mod Pattern Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconcile our fork's logic with upstream's `llm/sdk.ts` split, extract the rest of our fork-specific logic out of upstream-owned files into sibling `-mod`/`-ma` files (dispatch-only upstream files), then rebase `main` onto `upstream/main` cleanly.

**Architecture:** Two passes against `upstream/main` content (not yet rebased) before the rebase itself: (1) port our additions to the now-barrel `llm/{agent,dj,tools,segment-tools}.ts` into their new `llm/internal/**` homes; (2) extract fork logic from the remaining overlap files into sibling files behind one-line dispatch guards, following the existing `music/library.ts` → `music/library-ma.ts` pattern. Then `git rebase upstream/main`.

**Tech Stack:** TypeScript (Node ESM), no test runner — verification is `npm run lint` (eslint + tsc) inside `controller/`, plus a dev-compose dual-backend boot check.

**Reference doc:** `docs/superpowers/specs/2026-06-20-upstream-sync-mod-pattern-design.md`

**Merge base:** `ec145218bb99ed50367b87fe9f803087d2dca423` (use this as `$BASE` in all `git diff $BASE ...` commands below)

---

### Task 0: Create the working branch

**Files:** none

- [ ] **Step 1: Create and check out the branch from current `main`**

```bash
cd /Users/jonathan/code/subwave-fork
git checkout main
git pull origin main
git checkout -b chore/upstream-sync-mod-pattern
```

- [ ] **Step 2: Fetch upstream so the internal/** reference paths below resolve**

```bash
git fetch upstream main
```

Expected: no errors; `upstream/main` is up to date locally.

---

### Task 1: Port `llm/tools.ts` → `llm/internal/tools/picker-tools.ts`

Upstream turned `llm/tools.ts` into a 5-line barrel; the real implementation moved to `llm/internal/tools/picker-tools.ts`, which also picked up its own independent changes (a `resolveReferences`/`identifyRequestedTrack` tool, a `tracksTowardJourney` tool, `subsonic.resolveArtist`/`getRecentSongsByArtist` calls). Our additions — `isRadioPickable`, the `briefPool`/`justPlayedArtists`/`maxDurationSec`/`excludePatterns` params, the `topSongsByArtist` recent-artist refusal, and the MA-backend import swap — need to land in upstream's new file, merged with upstream's own additions, not replace them.

**Files:**
- Create: `controller/src/llm/internal/tools/picker-tools.ts` (does not exist yet on `main` — only on `upstream/main`)
- Modify: `controller/src/llm/tools.ts` (becomes a barrel, matching upstream)

- [ ] **Step 1: Materialize upstream's version of the file as the starting point**

```bash
git show upstream/main:controller/src/llm/internal/tools/picker-tools.ts > controller/src/llm/internal/tools/picker-tools.ts
mkdir -p controller/src/llm/internal/tools
git show upstream/main:controller/src/llm/internal/tools/picker-tools.ts > controller/src/llm/internal/tools/picker-tools.ts
```

- [ ] **Step 2: Apply our additions on top.** Edit `controller/src/llm/internal/tools/picker-tools.ts`:

Change the subsonic import (MA-backend dispatch — our addition) and add `artistKey`/`coreArtistKey`:

```typescript
import * as subsonic from '../../../music/library-backend.js';
import * as library from '../../../music/library.js';
import * as embeddings from '../../../music/embeddings.js';
import { artistKey, coreArtistKey, filterPickerCandidates } from '../../../music/recency.js';
import { searchWeb, searchReady } from '../../../skills/web-search.js';
import { identifyTrackFromText } from '../prompts/request.js';
```

Add the exclude-pattern helpers right after the imports, before `function slim(s: any) {`:

```typescript
// Compile a list of user-supplied exclude patterns into regexes. Each pattern
// is treated as a case-insensitive phrase; word boundaries are added on
// word-char edges (so "live" won't match "alive", but "(live)" matches
// literally). Called at filter time (once per pick) so settings changes take
// effect without restart; the overhead is negligible.
function buildExcludeRegexes(patterns: string[]): RegExp[] {
  return patterns.map(pattern => {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const prefix = /^\w/.test(pattern) ? '\\b' : '';
    const suffix = /\w$/.test(pattern) ? '\\b' : '';
    return new RegExp(prefix + escaped + suffix, 'i');
  });
}

// Returns true if the track passes the current picker exclude filters.
// `patterns` is the effective list from settings.getPickerConfig() — pass it
// explicitly so callers can resolve the correct station/show context once and
// reuse across a whole candidate list rather than hitting settings N times.
// Also matches against `genre` — lets a per-show excludePatterns entry (e.g.
// "Hip-Hop") hard-block a genre regardless of how the LLM interprets the show
// brief, instead of relying entirely on prompt-level enforcement.
export function isRadioPickable(title: string, album: string | null | undefined, patterns: string[], genre: string | null | undefined = null): boolean {
  if (!patterns.length) return true;
  const regexes = buildExcludeRegexes(patterns);
  const t = title ?? '';
  const a = album ?? '';
  const g = genre ?? '';
  return !regexes.some(re => re.test(t) || re.test(a) || re.test(g));
}
```

In `function slim(s: any)`, add `duration`/`source` to the `base` object (after `genre`):

```typescript
  const base = {
    id: s.id,
    title: s.title,
    artist: s.artist,
    album: s.album || null,
    year: s.year || null,
    genre: s.genre || null,
    ...(s.duration != null ? { duration: Math.round(s.duration) } : {}),
    ...(s._source ? { source: s._source } : {}),
  };
```

Replace the `buildPickerTools` parameter destructuring and its type to add our four params, keeping upstream's `audioWaypoint` and `resolveReferences`:

```typescript
const BRIEF_RESERVE = 4;

export function buildPickerTools({
  recentIds = new Set<string>(),
  recentKeys = new Set<string>(),
  recentArtists = new Set<string>(),
  justPlayedArtists = new Set<string>(),
  maxDurationSec = 600,
  excludePatterns = [] as string[],
  briefPool = [] as any[],
  audioWaypoint = null,
  resolveReferences = false,
}: {
  recentIds?: Set<string>;
  recentKeys?: Set<string>;        // lowercased "title|artist" — backfilled entries lack ids
  recentArtists?: Set<string>;
  justPlayedArtists?: Set<string>; // core artist key(s) of the current/previous track — never relaxed
  maxDurationSec?: number;
  excludePatterns?: string[];
  briefPool?: any[];
  audioWaypoint?: number[] | null;
  resolveReferences?: boolean;
} = {}) {
```

Replace the `collect` function (currently calls `filterPickerCandidates` directly) with the brief-pool-aware version — split into `acceptInto` + `collect`:

```typescript
  const acceptInto = (list: any, n: number, { relaxArtists = true }: { relaxArtists?: boolean } = {}) => {
    if (n <= 0) return [];
    const withinLength = (list || []).filter((s: any) =>
      (!s.duration || s.duration <= maxDurationSec) && isRadioPickable(s.title ?? '', s.album, excludePatterns, s.genre));
    const accepted = filterPickerCandidates(shuffle(withinLength as any[]), {
      recentIds,
      recentKeys,
      recentArtists,
      justPlayedArtists,
      seenIds: new Set(seen.keys()),
      artistCounts,
      maxPerArtist: MAX_PER_ARTIST,
      cap: n,
      relaxArtists,
    });
    const out: any[] = [];
    for (const s of accepted) {
      const slimmed = slim(s);
      seen.set(s.id, slimmed);
      out.push(slimmed);
    }
    return out;
  };

  const collect = (list: any, cap = 10) => {
    const out: any[] = [];
    if (briefPool.length) {
      out.push(...acceptInto(shuffle(briefPool), Math.min(BRIEF_RESERVE, cap)));
    }
    // If the brief-pool reserve already added on-brief alternatives to `seen`,
    // don't let this tool's own results fall back to a same-recent-artist
    // candidate via the recency cascade — only relax recentArtists here when
    // this is the only source of candidates so far.
    out.push(...acceptInto(list, cap - out.length, { relaxArtists: seen.size === 0 }));
    return out;
  };
```

In the `topSongsByArtist` tool's `execute`, add the recent-artist refusal before the `subsonic.getTopSongs` call:

```typescript
    topSongsByArtist: tool({
      description: 'Top songs for a named artist — good for staying in an artist\'s orbit without repeating a track. Refuses artists that played too recently — pick a different tool or artist in that case.',
      inputSchema: z.object({ artist: z.string() }),
      execute: async ({ artist }) => {
        try {
          // This tool's results are 100% one artist by construction. If that
          // artist is in recentArtists, filterPickerCandidates' fallback
          // cascade would relax the artist constraint (pass 3) and hand back
          // exactly the artist we're trying to avoid — refuse up front instead
          // so the agent's one discovery shot isn't spent on a dead end.
          const key = artistKey({ artist });
          const core = coreArtistKey({ artist });
          if ((key && recentArtists.has(key)) || (core && recentArtists.has(core))) {
            return { error: `${artist} played too recently — try a different artist or tool` };
          }
          return collect(await subsonic.getTopSongs(artist, { count: 15 }));
        }
        catch (err) { return { error: err.message }; }
      },
    }),
```

Update the `similarSongs` and `tracksLikeThis`/`tracksThatSoundLikeThis` tool descriptions and make `tracksByMood`/`tracksByEnergy`/`tracksLikeThis`/`tracksThatSoundLikeThis` await the now-async `library.*` calls (these become async in Task 6 below — for now just add the `await`, since `library.ts` on `main` already has these as async per the existing MA dispatch):

```typescript
    similarSongs: tool({
      description: 'Find songs similar to a given song id. Use as one source of candidates — verify results fit the active show brief before committing. Do not use this as the only tool when a show genre is specified.',
      inputSchema: z.object({ songId: z.string() }),
      execute: async ({ songId }) => {
        try { return collect(await subsonic.getSimilarSongs(songId, { count: 20 })); }
        catch (err) { return { error: err.message }; }
      },
    }),
```

```typescript
    tracksByMood: tool({
      description: 'Songs tagged with a mood: energetic, calm, reflective, celebratory, romantic, spiritual, focus, workout, driving, cooking, rainy, sunny, night, morning, evening, festival, cultural. Optionally constrain by energy level (low|medium|high).',
      inputSchema: z.object({
        mood: z.string(),
        energy: z.enum(['low', 'medium', 'high']).optional()
          .describe('Optional energy filter — narrows the result to that tempo/intensity band.'),
      }),
      execute: async ({ mood, energy }) => {
        try {
          await library.load();
          let rows = await library.songsByMood(mood);
          if (energy) rows = rows.filter((r: any) => r.energy === energy);
          return collect(rows);
        }
        catch (err) { return { error: err.message }; }
      },
    }),

    tracksByEnergy: tool({
      description: 'Songs tagged with a specific energy level: low (slow / mellow / ambient), medium (mid-tempo / steady), or high (uptempo / driving). Use for time-of-day or activity-based picks the mood vocab alone can\'t express — e.g. high for a workout, low for a wind-down, medium for a commute.',
      inputSchema: z.object({ energy: z.enum(['low', 'medium', 'high']) }),
      execute: async ({ energy }) => {
        try { await library.load(); return collect(await library.songsByEnergy(energy)); }
        catch (err) { return { error: err.message }; }
      },
    }),

    tracksLikeThis: tool({
      description: 'Tracks whose mood + lyrics + metadata embed closest to a seed track — the controller\'s own semantic similarity over the actual library. Prefer this to similarSongs when "more of this vibe" matters more than "more by this artist". Pass the currently-playing song id (best) OR a track title — a title is resolved to the matching track. Returns [] only if neither a song id nor a title match anything embedded. Use as one source of candidates — verify results fit the active show brief before committing.',
      inputSchema: z.object({
        songId: z.string().describe('a song id (preferred) or a track title'),
        k: z.number().int().min(1).max(50).default(20),
      }),
      execute: async ({ songId, k }) => {
        try { await library.load(); return collect(await library.tracksLikeThis(songId, k)); }
        catch (err) { return { error: err.message }; }
      },
    }),

    tracksThatSoundLikeThis: tool({
      description: 'Tracks whose ACTUAL SOUND (timbre, instrumentation, production, energy — a CLAP audio embedding of the waveform) is closest to a seed track. Unlike tracksLikeThis (which compares mood/lyrics/metadata), this is blind to tags and metadata, so it shines for instrumentals, non-English tracks, or anything with thin Last.fm coverage. Pass the currently-playing song id (best) OR a track title. Returns [] only when neither matches anything with an audio embedding (audio analysis not enabled / not yet run).',
      inputSchema: z.object({
        songId: z.string().describe('a song id (preferred) or a track title'),
        k: z.number().int().min(1).max(50).default(20),
      }),
      execute: async ({ songId, k }) => {
        try { await library.load(); return collect(await library.tracksLikeThisAudio(songId, k)); }
        catch (err) { return { error: err.message }; }
      },
    }),
```

And the journey tool (`tracksTowardJourney`) also needs `await`:

```typescript
    ...(audioWaypoint && audioWaypoint.length ? {
      tracksTowardJourney: tool({
        description: 'Tracks nearest the active sonic journey\'s CURRENT waypoint — the station is mid-arc, drifting its sound toward a destination vibe over the next few picks. When the event says a journey is active, call this and strongly prefer one of its tracks: each one moves the sound a step along the arc. Takes no input.',
        inputSchema: z.object({}),
        execute: async () => {
          try { await library.load(); return collect(await library.tracksByAudioVector(audioWaypoint, 20)); }
          catch (err) { return { error: err.message }; }
        },
      }),
    } : {}),
```

- [ ] **Step 3: Replace `controller/src/llm/tools.ts` with upstream's barrel**

```bash
git show upstream/main:controller/src/llm/tools.ts > controller/src/llm/tools.ts
```

Verify it now reads exactly:

```typescript
// Public surface for the picker's music-discovery tools. Implementation in
// internal/tools/picker-tools.ts. Barrel so call sites keep importing from
// `llm/tools.js` unchanged.

export { buildPickerTools } from './internal/tools/picker-tools.js';
```

If `isRadioPickable` is imported anywhere outside `picker-tools.ts` (check with the grep below), add `export { isRadioPickable } from './internal/tools/picker-tools.js';` to the barrel too.

```bash
grep -rn "isRadioPickable" controller/src --include=*.ts | grep -v "llm/internal/tools/picker-tools.ts\|llm/tools.ts"
```

- [ ] **Step 4: Lint**

```bash
cd controller && npm run lint
```

Expected: PASS (eslint + tsc, no errors). Fix any import/type errors surfaced before moving on.

- [ ] **Step 5: Commit**

```bash
cd /Users/jonathan/code/subwave-fork
git add controller/src/llm/tools.ts controller/src/llm/internal/tools/picker-tools.ts
git commit -m "refactor(llm): port picker-tools fork additions onto upstream's internal/ split"
```

---

### Task 2: Port `llm/agent.ts` → `llm/internal/agent-factory.ts`

Our only change here is widening `buildTools` to allow an async return (needed because `picker-tools.ts`'s `buildPickerTools` itself doesn't need to be async, but the call site in `broadcast/dj-agent.ts` — ported in Task 5 — does build tools asynchronously for brief-pool construction).

**Files:**
- Create: `controller/src/llm/internal/agent-factory.ts`
- Modify: `controller/src/llm/agent.ts` (becomes a barrel)

- [ ] **Step 1: Materialize upstream's version**

```bash
git show upstream/main:controller/src/llm/internal/agent-factory.ts > controller/src/llm/internal/agent-factory.ts
```

- [ ] **Step 2: Apply our change.** In `controller/src/llm/internal/agent-factory.ts`, change the `buildTools` field type in `AgentDefinition`:

```typescript
  buildTools?: (args: any) => { tools: any; extras?: any } | Promise<{ tools: any; extras?: any }>;
```

And in `defineAgent`'s `run` method, await it:

```typescript
    async run({ messages, ...toolArgs }) {
      const system = def.buildSystem(toolArgs);
      const built = def.buildTools ? await def.buildTools(toolArgs) : { tools: undefined, extras: undefined };
```

- [ ] **Step 3: Replace `controller/src/llm/agent.ts` with upstream's barrel**

```bash
git show upstream/main:controller/src/llm/agent.ts > controller/src/llm/agent.ts
```

Confirm it re-exports from `./internal/agent-factory.js` (open the file and check).

- [ ] **Step 4: Lint**

```bash
cd controller && npm run lint
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/jonathan/code/subwave-fork
git add controller/src/llm/agent.ts controller/src/llm/internal/agent-factory.ts
git commit -m "refactor(llm): port async buildTools support onto upstream's agent-factory"
```

---

### Task 3: Port `llm/segment-tools.ts` → `llm/internal/tools/segment-tools.ts`

Our only change is the MA-backend import swap.

**Files:**
- Create: `controller/src/llm/internal/tools/segment-tools.ts`
- Modify: `controller/src/llm/segment-tools.ts` (becomes a barrel)

- [ ] **Step 1: Materialize upstream's version**

```bash
git show upstream/main:controller/src/llm/internal/tools/segment-tools.ts > controller/src/llm/internal/tools/segment-tools.ts
```

- [ ] **Step 2: Apply our change.** In `controller/src/llm/internal/tools/segment-tools.ts`, change:

```typescript
import { getArtist, searchArtists } from '../../../music/subsonic.js';
```

to:

```typescript
import { getArtist, searchArtists } from '../../../music/library-backend.js';
```

- [ ] **Step 3: Replace `controller/src/llm/segment-tools.ts` with upstream's barrel**

```bash
git show upstream/main:controller/src/llm/segment-tools.ts > controller/src/llm/segment-tools.ts
```

- [ ] **Step 4: Lint**

```bash
cd controller && npm run lint
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/jonathan/code/subwave-fork
git add controller/src/llm/segment-tools.ts controller/src/llm/internal/tools/segment-tools.ts
git commit -m "refactor(llm): route segment-tools artist lookups through library-backend"
```

---

### Task 4: Port `llm/dj.ts`'s `pickNextTrack`/`PICKER_CRITERIA` → `llm/internal/prompts/picker.ts`

Upstream's `internal/prompts/picker.ts` independently improved `pickNextTrack` (constrains the picked id to a `z.enum` of real candidate ids, falling back to `z.string()` when the pool is empty — closes an "agent returned unknown id" hole). Our changes are the `SHOW BRIEF` criterion reorder, the `recentSimilarity`/`simLine` param, and the reworded `VARIETY` line. Merge both.

**Files:**
- Create: `controller/src/llm/internal/prompts/picker.ts`
- Modify: `controller/src/llm/dj.ts` (loses `PICKER_CRITERIA`/`pickNextTrack`, gains a re-export)

- [ ] **Step 1: Materialize upstream's version**

```bash
mkdir -p controller/src/llm/internal/prompts
git show upstream/main:controller/src/llm/internal/prompts/picker.ts > controller/src/llm/internal/prompts/picker.ts
```

- [ ] **Step 2: Apply our changes.** Replace the full contents of `controller/src/llm/internal/prompts/picker.ts` with:

```typescript
// LLM pool picker — choose the next track from a candidate pool (the stateless
// fallback path; the conversational agent picker lives in broadcast/dj-agent.js).
// PICKER_CRITERIA is shared with that agent so the two strategies can't drift.

import { z } from 'zod';
import * as settings from '../../../settings.js';
import { djObject } from '../strategy/object.js';

export const PICKER_CRITERIA = `Selection criteria, in order:
1. SHOW BRIEF — if a current show brief is given above, its genre and mood are a hard constraint. Only consider tracks that fit it. A perfect flow transition into the wrong genre is still wrong. Use tracksByMood, tracksByEnergy, tracksLikeThis, searchByLyrics, or searchLibrary to find candidates that actually fit the show.
2. CONTEXT — does it fit the time of day, weather, and dominant mood?
3. FLOW — within the show's genre space, does it transition naturally from what just played (energy, tempo)? When a candidate shows a "bpm" and/or Camelot "key", those are MEASURED — prefer a next track whose tempo sits near the current one (or steps it deliberately for the daypart) and whose key is harmonically close. When "pace" (0–1) is present, it is the track's MEASURED perceptual energy decoupled from tempo — use it to shape build/release arcs: avoid stacking two peaks back-to-back, ease down for wind-down dayparts, lift for workout/drive. When "sections" is present, it hints how much the opening develops (higher = busier, evolving intro). Treat all of these as tie-breakers, never hard rules; many tracks won't have them.
4. VARIETY — never pick the same artist consecutively; don't repeat tracks already played today; rotate energy. Mix well-known tracks with deeper cuts — don't cluster obvious global hits back to back. If recent picks have felt very similar to each other (check the recentSimilarity flag), prefer a briefPool candidate from a different genre or energy stratum — even over a strong similarity match. Variety over cleverness — never pick a track because its title literally matches the time of day, the weather, or anything else literal.
5. INTEREST — prefer something that creates a moment, not the most generic option.`;

function pickerSystem(show?: { name: string; topic: string } | null, simLine: string = '') {
  const stationName = settings.get().station;
  const showLine = show?.topic
    ? `\n\nCurrent show brief — follow this for every pick:\n${show.topic}`
    : '';
  return `You are the DJ for ${stationName}, a personal internet radio station.
Pick the single best NEXT track from the candidate pool, given recent plays and the current context.${showLine}${simLine}

${PICKER_CRITERIA}

Each candidate carries a "source" tag — a hint about where it came from:
- similar / similar-artist: flows from what's playing now
- embedding-similar: closest in mood / lyric / metadata space to what's playing
- audio-similar: SOUNDS closest to what's playing (timbre, instrumentation, production)
- audio-journey: SOUNDS like where the set is heading — the next step of a deliberate drift toward a destination vibe, not necessarily the current track
- recent: newly added to the library
- frequent / starred / playlist: an established favourite
- mood-library: matches the room's mood
- random: a wildcard for breaking a predictable run
Use it to balance familiarity against discovery. The two *-similar sources may
carry a "similarity" (0–1, higher = closer) — a high value means a very tight
match you can lean on for a smooth segue.

recentPlays is context for judging flow — every candidate is already guaranteed
unplayed, so you never need to reject one for being recent.

Pick exactly one candidate.`;
}

export async function pickNextTrack({ candidates, recentPlays, context, show = null, recentSimilarity = null }: {
  candidates: any[];
  recentPlays: any;
  context: any;
  show?: { name: string; topic: string } | null;
  recentSimilarity?: string | null;
}) {
  const user = JSON.stringify({
    now: {
      time: context.time?.period,
      vibe: context.time?.vibe,
      mood: context.dominantMood,
      weather: context.weather?.condition,
      festival: context.festival?.name,
    },
    recentPlays,
    candidates,
  }, null, 2);

  const simLine = recentSimilarity && show
    ? `\n\nYour recent picks cluster ${recentSimilarity}-similarity — prefer briefPool diversity.`
    : '';

  // Constrain the pick to the actual candidate ids. On a local model (llama.cpp
  // via openai-compatible / locca) this becomes a grammar so the model can only
  // emit a real id — closing the "agent returned unknown id" hole. On providers
  // that don't enforce the schema at decode time, Zod still rejects an invalid
  // id, so the caller's fallback fires instead of a bogus track. Empty pool →
  // plain string (z.enum needs ≥1 literal); pickViaPool never calls with [].
  const candidateIds = [
    ...new Set(
      (candidates || [])
        .map((c: any) => c?.id)
        .filter((id: any): id is string => typeof id === 'string' && id.length > 0),
    ),
  ];
  const idSchema = candidateIds.length
    ? z.enum(candidateIds as [string, ...string[]]).describe('the exact id of one candidate')
    : z.string().describe('the exact id of one candidate');

  return djObject({
    system: pickerSystem(show, simLine),
    prompt: user,
    schema: z.object({
      id: idSchema,
      reason: z.string().describe('one short sentence on why this one'),
    }),
    temperature: 0.5,
    kind: 'pickNextTrack',
  });
}
```

- [ ] **Step 3: Remove `PICKER_CRITERIA`/`pickerSystem`/`pickNextTrack` from `controller/src/llm/dj.ts` and re-export instead.** Delete the block from the `// LLM PICKER` comment through the end of `pickNextTrack` (the block shown in the spec's diff, roughly lines 433–509 depending on current line numbers — search for `// LLM PICKER` to find it) and add at the end of the file:

```typescript
export { PICKER_CRITERIA, pickNextTrack } from './internal/prompts/picker.js';
```

Confirm this matches `git show upstream/main:controller/src/llm/dj.ts`'s line `export { PICKER_CRITERIA, pickNextTrack } from './internal/prompts/picker.js';` exactly (it does — verified during planning).

- [ ] **Step 4: Check `dj.ts` for now-unused imports.** After removing the block, `z` (from `zod`) and `settings` may still be used elsewhere in `dj.ts` — check before removing any import:

```bash
grep -n "^import\|z\.\|settings\." controller/src/llm/dj.ts | head -30
```

Remove only imports that are no longer referenced anywhere else in the file.

- [ ] **Step 5: Lint**

```bash
cd controller && npm run lint
```

Expected: PASS. If `pickNextTrack`'s caller (`controller/src/music/picker.ts`) errors, check it still imports `dj.pickNextTrack` (via the `dj.js` barrel) — no call-site change needed since the re-export preserves the public path.

- [ ] **Step 6: Commit**

```bash
cd /Users/jonathan/code/subwave-fork
git add controller/src/llm/dj.ts controller/src/llm/internal/prompts/picker.ts
git commit -m "refactor(llm): port pickNextTrack fork additions onto upstream's internal/prompts split"
```

---

### Task 5: Verify the LLM reconciliation end-to-end

**Files:** none (verification only)

- [ ] **Step 1: Full repo-wide search for stale `subsonic.js` imports in ported files**

```bash
grep -rn "from '\.\./\.\./\.\./music/subsonic\.js'\|from '\.\./music/subsonic\.js'" controller/src/llm/
```

Expected: no hits inside `llm/internal/tools/` (they should reference `library-backend.js` per our fork's convention) — `llm/internal/prompts/request.ts` and other upstream files that don't touch MA-sensitive calls can still import `subsonic.js` directly if upstream does; only flag files this plan touched.

- [ ] **Step 2: Full lint**

```bash
cd controller && npm run lint
```

Expected: PASS.

- [ ] **Step 3: Dev boot check, Navidrome backend**

```bash
cd /Users/jonathan/code/subwave-fork
docker compose -f docker-compose.dev.yml up -d
sleep 5
curl -sf http://localhost:7701/health && echo OK
docker compose -f docker-compose.dev.yml logs controller --tail=50
```

Expected: `OK`, no stack traces in the log tail. Look specifically for the controller booting without throwing on `llm/tools.js`, `llm/agent.js`, `llm/dj.js`, or `llm/segment-tools.js` imports.

- [ ] **Step 4: Trigger one DJ pick to exercise `buildPickerTools`/`pickNextTrack`**

```bash
curl -sf -X POST http://localhost:7701/auto-pick -u "$ADMIN_USER:$ADMIN_PASS" && echo OK
```

(Use whatever `ADMIN_USER`/`ADMIN_PASS` are set in your local `controller/.env` or root `.env`.) Expected: `OK`, and `docker compose -f docker-compose.dev.yml logs controller --tail=20` shows a pick completing without error.

- [ ] **Step 5: Tear down dev stack**

```bash
docker compose -f docker-compose.dev.yml down
```

---

### Task 6: Extract `music/library-db.ts` and `music/tag-library.ts` fork logic into sibling `-mod.ts` files

Both files have real, moderate-size fork-specific edits interleaved with upstream's own changes since the merge base. Follow the exact pattern already established by `music/library.ts` → `music/library-ma.ts`: every function with fork-specific behavior gets a one-line dispatch/guard, the sibling file owns the rest.

**Files:**
- Create: `controller/src/music/library-db-mod.ts`
- Create: `controller/src/music/tag-library-mod.ts`
- Modify: `controller/src/music/library-db.ts`
- Modify: `controller/src/music/tag-library.ts`

- [ ] **Step 1: Generate the exact diff to extract for `library-db.ts`**

```bash
git diff ec145218bb99ed50367b87fe9f803087d2dca423 main -- controller/src/music/library-db.ts > /tmp/library-db.diff
cat /tmp/library-db.diff
```

Read the full output. For each hunk, classify it as either (a) a self-contained new function/export (e.g. a new `upsertTrackTags`-style helper, a new column) — move the whole function body into `library-db-mod.ts`, export it there, and call it from a one-line dispatch in `library-db.ts`; or (b) a small inline tweak inside an upstream function (e.g. a new field added to an existing row mapper) — these CANNOT be cleanly extracted without forking the whole function; leave them as direct inline edits in `library-db.ts` (do not manufacture a dispatch wrapper for a single added field, per the spec's guidance on upstream-dominant diffs).

- [ ] **Step 2: Create `controller/src/music/library-db-mod.ts`** with a header comment and the extracted self-contained pieces from Step 1:

```typescript
// Fork-specific extensions to library-db.ts. Functions here are called from
// one-line dispatch points in library-db.ts so upstream merges/rebases only
// ever conflict on those single lines, never on the logic itself.
```

(Populate the body with whatever Step 1 classified as extractable — there is no fixed list here because it depends on reading the live diff; do not skip Step 1's read.)

- [ ] **Step 3: Wire the dispatch points in `library-db.ts`** — for each extracted function, replace the inline implementation with a call into `library-db-mod.ts`, e.g.:

```typescript
import * as mod from './library-db-mod.js';
// ...
export function someExtractedThing(arg: Foo): Bar {
  return mod.someExtractedThing(arg);
}
```

- [ ] **Step 4: Repeat Steps 1–3 for `tag-library.ts` / `tag-library-mod.ts`**

```bash
git diff ec145218bb99ed50367b87fe9f803087d2dca423 main -- controller/src/music/tag-library.ts > /tmp/tag-library.diff
cat /tmp/tag-library.diff
```

Same classification rule: self-contained additions move to `tag-library-mod.ts` behind a dispatch call; small inline tweaks to upstream's existing functions stay inline.

- [ ] **Step 5: Lint**

```bash
cd controller && npm run lint
```

Expected: PASS.

- [ ] **Step 6: Dev boot + tagger smoke check**

```bash
cd /Users/jonathan/code/subwave-fork
docker compose -f docker-compose.dev.yml up -d
sleep 5
docker compose -f docker-compose.dev.yml exec controller npm run tag -- --limit 5
docker compose -f docker-compose.dev.yml down
```

Expected: tagger runs against 5 tracks without throwing.

- [ ] **Step 7: Commit**

```bash
git add controller/src/music/library-db.ts controller/src/music/library-db-mod.ts controller/src/music/tag-library.ts controller/src/music/tag-library-mod.ts
git commit -m "refactor(music): extract fork-specific library-db/tag-library logic into sibling -mod files"
```

---

### Task 7: Extract `settings.ts` fork logic into `settings-mod.ts`

This is the largest non-LLM diff (318 our-side insertions against the merge base) and the highest priority per the design doc after the LLM reconciliation.

**Files:**
- Create: `controller/src/settings-mod.ts`
- Modify: `controller/src/settings.ts`

- [ ] **Step 1: Generate the exact diff**

```bash
git diff ec145218bb99ed50367b87fe9f803087d2dca423 main -- controller/src/settings.ts > /tmp/settings.diff
cat /tmp/settings.diff
```

Read the full output and classify each hunk the same way as Task 6 Step 1: self-contained new settings fields/validators/getters (e.g. `libraryBackend`, `picker.maShortlist.*`, `themeCentroid.*`, `getPickerConfig`'s exclude-patterns resolution, any MA-related schema additions) are strong candidates for extraction; small edits threaded into an existing upstream validator function body are not.

- [ ] **Step 2: Create `controller/src/settings-mod.ts`**:

```typescript
// Fork-specific settings extensions. Schema fields, validators, and getters
// here are wired into settings.ts via one-line dispatch points, so upstream
// changes to settings.ts's own fields never collide with ours.
```

Populate with the extractable pieces identified in Step 1 — likely candidates based on this codebase's documented settings surface (per CLAUDE.md): `libraryBackend`, the MA composite-shortlist toggles (`picker.maShortlist.shadowEnabled`, `picker.maShortlist.autoPlaylistShadowEnabled`, `picker.maShortlist.minPoolSize`, `maxThreshold`), `themeCentroid.minExemplars`/`minPoolSize`/`maxThreshold`, and `dj.souls` exclude-pattern config if added since the base. Confirm the actual field names against the live diff from Step 1 — do not guess names that aren't in the diff.

- [ ] **Step 3: Wire dispatch points in `settings.ts`** for each extracted piece, following the same call-out pattern as Task 6.

- [ ] **Step 4: Lint**

```bash
cd controller && npm run lint
```

Expected: PASS.

- [ ] **Step 5: Dev boot check, both backends**

```bash
cd /Users/jonathan/code/subwave-fork
docker compose -f docker-compose.dev.yml up -d
sleep 5
curl -sf http://localhost:7701/state -u "$ADMIN_USER:$ADMIN_PASS" | head -c 500; echo
docker compose -f docker-compose.dev.yml down
```

Expected: `/state` returns JSON including the settings fields moved in Step 2, unchanged in shape from before this task.

- [ ] **Step 6: Commit**

```bash
git add controller/src/settings.ts controller/src/settings-mod.ts
git commit -m "refactor(settings): extract fork-specific settings fields into settings-mod"
```

---

### Task 8: Extract `broadcast/dj-agent.ts` and `broadcast/tagger.ts` fork logic

`dj-agent.ts` has the largest diff in this group (111 insertions) — likely the brief-pool construction call (`music/pool.js buildBriefPool`, per `llm/tools.ts`'s comment in Task 1) and the `justPlayedArtists`/`maxDurationSec`/`excludePatterns` wiring into `buildPickerTools`. `tagger.ts`'s diff is small (16 insertions) — read it before deciding whether extraction is worth the indirection (per the spec's guidance, a trivial diff may stay inline).

**Files:**
- Create: `controller/src/broadcast/dj-agent-mod.ts`
- Modify: `controller/src/broadcast/dj-agent.ts`
- Modify: `controller/src/broadcast/tagger.ts` (only if Step 1 below shows it's worth extracting)

- [ ] **Step 1: Generate both diffs and read them**

```bash
git diff ec145218bb99ed50367b87fe9f803087d2dca423 main -- controller/src/broadcast/dj-agent.ts > /tmp/dj-agent.diff
git diff ec145218bb99ed50367b87fe9f803087d2dca423 main -- controller/src/broadcast/tagger.ts > /tmp/tagger.diff
cat /tmp/dj-agent.diff /tmp/tagger.diff
```

- [ ] **Step 2: Extract `dj-agent.ts`'s self-contained additions into `dj-agent-mod.ts`** — likely the brief-pool fetch/build call and the new params passed into `buildPickerTools` (which Task 1 already updated to accept `briefPool`/`justPlayedArtists`/`maxDurationSec`/`excludePatterns`). Create the file with a header:

```typescript
// Fork-specific extensions to dj-agent.ts — brief-pool construction and the
// recency/exclude-pattern config resolved before each pick. Wired in via
// dispatch points so upstream changes to the agent loop itself don't collide.
```

Populate from the Step 1 diff; wire the dispatch call(s) into `dj-agent.ts`.

- [ ] **Step 3: Decide on `tagger.ts`.** If the 16-line diff is a small inline tweak (e.g. one new field passed through an existing call), leave it inline — do not create `tagger-mod.ts` for a trivial diff. If it's a self-contained addition (e.g. a whole new helper function), extract it the same way as Step 2.

- [ ] **Step 4: Lint**

```bash
cd controller && npm run lint
```

Expected: PASS.

- [ ] **Step 5: Dev boot + one DJ pick**

```bash
cd /Users/jonathan/code/subwave-fork
docker compose -f docker-compose.dev.yml up -d
sleep 5
curl -sf -X POST http://localhost:7701/auto-pick -u "$ADMIN_USER:$ADMIN_PASS" && echo OK
docker compose -f docker-compose.dev.yml logs controller --tail=30
docker compose -f docker-compose.dev.yml down
```

Expected: `OK`, pick completes, brief-pool/exclude-pattern logic visible in logs (debug-level `llm/log.ts` ring buffer reflects `pickNextTrack`/agent tool calls without errors).

- [ ] **Step 6: Commit**

```bash
git add controller/src/broadcast/dj-agent.ts controller/src/broadcast/dj-agent-mod.ts controller/src/broadcast/tagger.ts
git commit -m "refactor(broadcast): extract fork-specific dj-agent brief-pool wiring into dj-agent-mod"
```

(Drop `tagger.ts` from the `git add` if Step 3 decided to leave it inline.)

---

### Task 9: Review `routes/*.ts` diffs — extract only the non-trivial ones

Per the design doc, route files with trivial diffs (debug.ts, public.ts) stay inline; only `routes/library.ts`, `routes/onboarding.ts`, and `routes/request.ts` have diffs worth checking.

**Files:**
- Create: `controller/src/routes/library-mod.ts` (only if warranted)
- Modify: `controller/src/routes/library.ts`, `controller/src/routes/onboarding.ts`, `controller/src/routes/request.ts` (only where warranted)

- [ ] **Step 1: Read all three diffs**

```bash
git diff ec145218bb99ed50367b87fe9f803087d2dca423 main -- controller/src/routes/library.ts controller/src/routes/onboarding.ts controller/src/routes/request.ts
```

- [ ] **Step 2: Classify each.** `routes/request.ts`'s diff is 3 lines (per the earlier survey) — almost certainly stays inline. `routes/onboarding.ts` (35 lines) and `routes/library.ts` (109 lines) are large enough to warrant a look: if the additions are whole new route handlers (e.g. a new `GET`/`POST` endpoint for MA-related onboarding or library browsing), extract the handler function bodies into a sibling `-mod.ts` and mount them from the route file with a one-line call; if they're small additions to existing upstream handlers (e.g. one new field in a response), leave inline.

- [ ] **Step 3: Apply whatever extractions Step 2 identified**, following the same dispatch pattern as prior tasks.

- [ ] **Step 4: Lint**

```bash
cd controller && npm run lint
```

Expected: PASS.

- [ ] **Step 5: Dev boot + hit the affected routes**

```bash
cd /Users/jonathan/code/subwave-fork
docker compose -f docker-compose.dev.yml up -d
sleep 5
curl -sf http://localhost:7701/state -u "$ADMIN_USER:$ADMIN_PASS" > /dev/null && echo state-OK
curl -sf http://localhost:7700/onboarding > /dev/null && echo onboarding-page-OK
docker compose -f docker-compose.dev.yml down
```

- [ ] **Step 6: Commit** (only the files actually changed)

```bash
git add -A controller/src/routes/
git commit -m "refactor(routes): extract non-trivial fork-specific route logic into sibling -mod files"
```

---

### Task 10: Rebase `main` onto `upstream/main`

**Files:** whatever the rebase conflicts touch — by this point, conflicts should be limited to single dispatch lines.

- [ ] **Step 1: Make sure the working tree is clean and all prior tasks are committed**

```bash
cd /Users/jonathan/code/subwave-fork
git status
```

Expected: clean.

- [ ] **Step 2: Fetch latest upstream**

```bash
git fetch upstream main
```

- [ ] **Step 3: Rebase**

```bash
git rebase upstream/main
```

Expected: some conflicts. For each conflict, inspect which file it's in:
- If it's one of the dispatch-pattern files from Tasks 6–9, the conflict should be confined to the dispatch line(s) — resolve by keeping both upstream's surrounding code and our dispatch call (usually `git diff` will show upstream changed code around our one-line call; keep upstream's version of everything except our dispatch line).
- If it's in `llm/{tools,agent,segment-tools,dj}.ts` or their `internal/**` counterparts and upstream has moved things again since this plan was written, treat it as a fresh instance of Task 1–4's "follow the move" procedure: locate where upstream's latest version put the function, re-apply our diff there.

Resolve each conflicted file, `git add` it, then:

```bash
git rebase --continue
```

Repeat until the rebase completes.

- [ ] **Step 4: Full lint after rebase**

```bash
cd controller && npm run lint
cd ../web && npm run lint
```

Expected: PASS on both.

- [ ] **Step 5: Full dev boot + DJ pick smoke test, both library backends**

```bash
cd /Users/jonathan/code/subwave-fork
docker compose -f docker-compose.dev.yml up -d
sleep 5
curl -sf http://localhost:7701/health && echo health-OK
curl -sf -X POST http://localhost:7701/auto-pick -u "$ADMIN_USER:$ADMIN_PASS" && echo pick-OK
docker compose -f docker-compose.dev.yml logs controller --tail=50
docker compose -f docker-compose.dev.yml down
```

Expected: both `OK`s, no errors in the log tail.

- [ ] **Step 6: Push the rebased branch**

```bash
git push -u origin chore/upstream-sync-mod-pattern --force-with-lease
```

(Use `--force-with-lease`, not `--force` — this branch was rebased so the remote history changed, but `--force-with-lease` still protects against clobbering someone else's push you haven't seen.)

---

### Task 11: Open the PR

**Files:** none

- [ ] **Step 1: Push (if not already done in Task 10 Step 6) and open the PR**

```bash
gh pr create --title "chore: reconcile fork with upstream, extract fork logic into mod files" --body "$(cat <<'EOF'
## Summary
- Ports our llm/{tools,agent,segment-tools,dj}.ts additions onto upstream's llm/internal/** split (PR #414)
- Extracts fork-specific logic from settings.ts, library-db.ts, tag-library.ts, dj-agent.ts, and select routes/*.ts into sibling -mod.ts files behind one-line dispatch points, mirroring the existing library.ts/library-ma.ts pattern
- Rebases main onto current upstream/main

See docs/superpowers/specs/2026-06-20-upstream-sync-mod-pattern-design.md for the full design.

## Test plan
- [ ] `npm run lint` passes in both controller/ and web/
- [ ] Dev stack boots clean on both library.backend=navidrome and library.backend=ma-api
- [ ] One DJ auto-pick cycle completes without error on each backend
EOF
)"
```

- [ ] **Step 2: Report the PR URL back.**

---

## Self-review notes

- **Spec coverage:** Part 1 (LLM reconciliation) → Tasks 1–5. Part 2 (generalize dispatch pattern) → Tasks 6–9, covering settings.ts (highest priority per spec), library-db.ts, tag-library.ts, dj-agent.ts, tagger.ts, and the non-trivial routes — with explicit "leave inline if trivial" guidance matching the spec's open question resolution. Part 3 (rebase) → Task 10. Testing/validation section → lint + dual-backend dev boot checks embedded in every task, not just at the end.
- **Tasks 6–9 are diff-driven, not diff-embedded:** these files' our-side diffs are 53–421 lines each; rather than reproduce all of it inline (which risks drifting from the actual repo state by the time this plan is executed), each task instructs the worker to generate the exact diff via `git diff $BASE main -- <file>` and classify hunks using a fixed, concrete rule (self-contained addition → extract; small inline tweak to upstream code → leave inline). This is the same pointer-based precision the plan template itself uses for line-ranged `Modify:` entries — the diff command is exact and reproducible, not vague.
