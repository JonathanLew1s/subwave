# Show redesign + genre-aware picker — design

## Problem

Live picks were jumping between incoherent genres (e.g. Aphex Twin → a 19s
spoken-word "Commentary:" bonus track → André Previn) with no enforced logic.
Investigation traced this to several compounding issues, validated against
the live MA sidecar and production logs, not assumed:

- A non-music bonus track (a liner-note commentary clip) slipped into
  rotation because it scored a plausible energy/valence value despite being
  19 seconds of speech — there's no minimum-duration floor today, only a
  maximum.
- Flow (bpm/key) compatibility is advisory everywhere it's live — the system
  prompt tells the LLM to treat it as "tie-breakers, never hard rules."
  Nothing structurally prevents an incoherent transition.
- The one mechanism that *does* enforce flow well (`ma-candidate-pool.ts`'s
  4-slot shortlist: theme/flow/discovery/oldie) has never run live —
  `shadowEnabled: false` everywhere, zero production data collected.
- All 10 live shows have empty `genre`/`energy`/`exemplarTrackIds` fields.
  The only structural signal is mood tags (coarse energy/valence bands);
  everything else is free-text `topic` prose, advisory to the LLM.
- For 3 shows (Slow Start, Out to Lunch, The Long Stretch), the real genre
  guidance lives in `vibe`, not `topic` — and `vibe` only reaches anything
  via embeddings, which are disabled station-wide. These 3 shows currently
  give the LLM **zero** music guidance at all.

## What we validated live, iteratively, before settling on a design

1. **Raw mood-band pools are too broad.** `songsByMoods(['reflective','night','calm'])`
   returned 597 tracks including Kool & the Gang disco, Cher pop ballads,
   Elvis rock, Bad Bunny — all scored low-energy/low-valence on that specific
   recording, none remotely "overnight ambient." Energy/valence bands alone
   cannot capture genre/character coherence.
2. **The existing 6-axis sonic centroid (`theme-centroid.ts`) doesn't fix
   this**, even with a clean, well-chosen 7-track exemplar set. Averaging
   genre-diverse exemplars (instrumental ambient + vocal folk) into one
   blended centroid produces a vector with no real pull against vocal jazz
   standards, classic rock, etc. — confirmed live: the gated pool still
   admitted Ella Fitzgerald, Elvis, Rush, Pink Floyd, Guns N' Roses.
3. **Raw CLAP-embedding similarity (mean-pooled centroid OR max-similarity-
   to-nearest-exemplar) is also not sufficient on its own.** CLAP captures
   acoustic/production *texture* (timbre, instrumentation, intimacy), not
   cultural genre identity — a quiet vocal+piano arrangement scores similar
   whether it's an Ella Fitzgerald standard or a Bon Iver session cut.
   Confirmed live: top CLAP-similarity matches included Bee Gees, Lady Gaga,
   R.E.M., Elton John.
4. **The combination that worked, validated live across multiple iterations:**
   - Derive a genre palette from the exemplars' own **literal flat genre
     tags** (e.g. `ambient`, `folk`, `downtempo`, `trip-hop`) — explicitly
     *not* expanded through the taxonomy's alias-rollup machinery, which is
     built for fuzzy free-text resolution and pulls in unrelated sibling
     subgenres under broad umbrellas (e.g. one "Downtempo" exemplar
     expanding to admit Dubstep/Deep House/Club via a shared "electronic"
     parent — confirmed live, then fixed).
   - Hard-gate the mood-band pool to that literal palette.
   - Rank within the gate by CLAP similarity to the **nearest individual
     exemplar**, not a blended centroid.
   - Result, verified live: 34/88-track gated pools (depending on exemplar
     breadth) with zero off-genre noise and healthy artist diversity
     (20-41 distinct artists), vs. hundreds of incoherent tracks before.
5. **The "won't this exhaust into repeats" concern is unfounded** — the
   34-track sample was an artifact of one capped random draw
   (`songsByMood`'s `limit=200, order=random`). The true server-side total
   for Small Hours' palette × mood bands is 1,000+ tracks; combined with the
   existing recency-exclusion window and per-call re-randomization, rotation
   is not a real risk at current show lengths.
6. **Exemplar breadth matters.** A palette derived from too few/too-similar
   exemplars under-delivers on eclecticism (7 exemplars → only `{ambient,
   folk}`). Fix: more exemplars spanning more genres, not a separate
   hand-typed palette field — keeps one mechanism (exemplars) driving both
   texture ranking and genre breadth.

## Design

### 1. Data hygiene (independent, ship first)
- Extend the operator-configured `excludePatterns` list with
  commentary/interview/spoken-word/liner-notes terms.
- Add a `minDurationSec` floor next to the existing `maxDurationSec`,
  enforced at the same points duration is already checked (`picker.ts`,
  `scheduler.ts`, `pool.ts`, `ma-candidate-pool.ts`).

### 2. Selection logic — promote the (reworked) shortlist mechanism to live
- Rework `theme-centroid.ts`'s theme-eligibility test: replace the 6-axis
  blended-centroid distance with literal-genre-tag-palette gating (derived
  from exemplars, no alias rollup) + CLAP-similarity-to-nearest-exemplar
  ranking.
- The `flow` slot's existing bpm/key/CLAP `flowFit` (anchored to the single
  current track, not a blend) is unaffected — it didn't have the averaging
  problem.
- Wire the resulting shortlist into the two identified live call sites,
  replacing what they currently call:
  - `dj-agent.ts:290` (`buildBriefPoolForShow` → `pool.buildBriefPool`)
  - `scheduler.ts:69-71` (the MA-mode mood+random union)
- Keep all existing safety nets: `MOOD_NEIGHBOURS_MA` widening,
  `filterPickerCandidates`' recency cascade, graceful no-gating fallback
  when a show has no/too-few exemplars.

### 3. Show definitions — same 10-show skeleton, exemplars become real
- Keep the 10-show daypart skeleton. "The Workday" stays orphaned (never
  scheduled) per explicit decision — not deleted, not wired in.
- Fix two schedule slots so the weekend-party swap lands on the right
  nights: day 0 (Sunday) 00–05 → Electric Picnic; day 5 (Friday) 00–05 →
  Small Hours. (Day 6/Saturday and days 1-4 already correct.)
- Rewrite each of the 9 airing shows' `topic` using the activity-first
  frame ("what are people doing while listening") agreed for Small Hours:
  sonic-character constraints (instrumental/vocal, tempo, energy) move out
  of prose into mood bands + exemplars; only activity context + genre
  identity stay in prose. Fold real genre guidance into `topic` for the 3
  shows that currently only have it in `vibe` (dead, since embeddings are
  off).
- Populate real `exemplarTrackIds` per show, queried from the live library
  (not invented), reviewed with the operator, sized for genuine palette
  breadth (validated: ~7-10 tracks spanning 3-4+ genres works well for
  Small Hours).

### 4. Admin UI — close the maintainability gap
`exemplarTrackIds` and `vibe` exist in the schema/data today with **zero**
UI surface (confirmed: neither appears anywhere in `ShowsPanel.tsx` despite
3 live shows already having real `vibe` content, populated out-of-band).
Add both to `ShowsPanel.tsx` directly alongside `topic`/`moods`:
- A track-search-and-add widget for exemplars (reuse the existing
  library-search pattern from elsewhere in the app).
- Live derived-state feedback in the editor: show the operator the genre
  palette that would be derived from their current exemplar picks, and
  ideally an estimate of the matching pool size — so cause and effect stay
  visible in one screen, not discoverable only by running a script.

## Out of scope / explicitly rejected
- Single-genre or single-energy-band hard pinning per show (`genre`/`energy`
  fields) — rejected as too shallow/single-dimension; superseded by the
  exemplar-driven palette approach.
- A separate hand-typed genre-palette field — rejected in favour of one
  mechanism (exemplars) driving both texture and genre breadth.
- Turning on embeddings to revive the `vibe`-text mechanism — not required;
  the genre-palette + CLAP approach supersedes what `vibe` was trying to do.
