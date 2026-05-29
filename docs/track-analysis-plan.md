# Track analysis → selection-side DJ skills — plan

The club/turntablist skill set (beatmatching, phrasing, EQ bass-swaps,
harmonic mixing, energy arc) mostly does **not** fit SUB/WAVE: it's a radio
playout server with a fixed-width amplitude crossfade and a preserve-the-master
audio bus, not a two-deck beat-sync engine. Real-time beatmatching, EQ kills,
and key-shifting are out of reach *and out of philosophy* — and for an eclectic
personal library played to a living-room audience, mostly undesirable anyway.

But there is a clean, in-architecture subset worth taking: the **analytical
inputs** behind those skills — a track's tempo, musical key, and intro length —
feed *better track selection*, not real-time mixing. Tempo-aware and
harmonic-aware **selection** are realistic, fit the existing picker, and
degrade safely. This document scopes that.

The line in the sand: **analyse once, offline; let it shape what plays next.
Never try to sync, stretch, EQ, or key-shift two decks in real time.**

This is a superset of the intro-length section in
[dj-capabilities-plan.md](dj-capabilities-plan.md#3-talking-up-to-the-post--hardest)
— the same precompute-once pass produces all three numbers.

## TL;DR

| Capability | Addable? | Vehicle |
|---|---|---|
| BPM / key / intro-length per track | ✅ Yes | One offline analysis pass → new `library-db` columns |
| Tempo-aware selection (smoother energy curve) | ✅ Yes | Picker filter/re-rank in `music/picker.ts` |
| Harmonic-aware selection (Camelot-adjacent) | ✅ Yes | Picker re-rank + surface key to the LLM |
| Talk-within-the-intro (don't step on vocals) | ✅ Yes | `introMs` → line budget (see sibling doc) |
| Real-time beatmatching / time-stretch sync | ❌ No | Wrong engine; not a goal |
| EQ bassline swap during transitions | ❌ No | Bus is preserve-the-master; IIR wall on `request.queue` |
| Harmonic key-shifting, scratch, beat-juggle | ❌ No | Performance/real-time DSP; not a goal |

---

## The shared vehicle: one offline analysis pass

Everything addable rides on the same idea already used for mood tags: compute
a number per track **once, offline**, store it, and read it cheaply at pick
time. The mood tagger (`music/tag-library.ts`) is the template — a resumable,
phased, `--limit N` job writing to the SQLite `tracks` table
(`music/library-db.ts`).

### What it computes

Per track, keyed by `subsonic_id`:

- **`bpm`** (REAL) — tempo. Standard beat-tracking (librosa `beat_track`,
  essentia, or aubio).
- **`musical_key`** (TEXT) — key + mode, stored as a **Camelot code**
  (e.g. `8A`, `5B`) so adjacency is trivial integer math. Key detection
  (essentia `KeyExtractor`, libKeyFinder).
- **`intro_ms`** (INTEGER) — seconds-to-vocals / intro length (the sibling
  doc's feature; folds in here for free).
- **`analysis_confidence`** (REAL, optional) — so the picker can ignore
  low-confidence values rather than act on noise.

These are *acoustic* facts about the audio, distinct from the existing
`energy` column, which is an **LLM-inferred** low/medium/high tag (the tagger
even guesses it partly from genre — see `music/tagger-core.ts`). Real BPM
*upgrades* that coarse bucket; keep `energy` as the human-legible label and let
`bpm` be the precise lever.

### Where it runs

Beat/key analysis pulls in heavy native deps (librosa→numpy/scipy, or
essentia, or a small torch model). That **does not belong in the controller
image** — same reasoning as Chatterbox/PocketTTS. Two options:

1. **`tts-heavy` sidecar (preferred).** It already exists as the home for heavy
   Python audio work, already mounts the shared `/var/sub-wave` volume, and is
   off by default behind `profiles: ["tts-heavy"]`. Add an analysis endpoint
   (or a one-shot CLI in the same image) that reads a track and returns
   `{bpm, key, intro_ms, confidence}`. The controller's analysis job calls it
   over HTTP, exactly like `ttsHeavyClient.ts` does for speech.
2. **Pure-offline CLI.** A standalone script run on the operator's machine
   against the library, writing straight to the DB. No runtime dependency at
   all, but the operator has to run it.

Either way the controller image stays lean and the station runs untouched if
the analysis never happens.

### Where it's stored

`music/library-db.ts` already owns the `tracks` table with `moods`/`energy`
and a `tagger_version`. Add nullable columns via the same idempotent
`CREATE TABLE`/`ALTER` path:

```sql
ALTER TABLE tracks ADD COLUMN bpm                  REAL;
ALTER TABLE tracks ADD COLUMN musical_key          TEXT;   -- Camelot, e.g. '8A'
ALTER TABLE tracks ADD COLUMN intro_ms             INTEGER;
ALTER TABLE tracks ADD COLUMN analysis_confidence  REAL;
ALTER TABLE tracks ADD COLUMN analysis_version     INTEGER;
```

Nullable throughout: an un-analysed track reads `NULL` and every consumer
treats `NULL` as "no signal, behave as today."

### How it's driven

A new phase in the `tag-library` pipeline (or a sibling `npm run analyze
[-- --limit N]`), resumable and batched like the tagger, skipping any track
whose `analysis_version` is current. Analysis and mood-tagging are independent
— either can run first.

---

## Feature 1 — Tempo-aware selection

**Goal:** smoother energy curves and fewer jarring tempo jumps, by letting the
picker *prefer* a next track whose BPM sits near the current one (or
deliberately steps it, per the daypart arc).

**Where it hooks:** `music/picker.ts` `buildCandidates()` already assembles a
balanced pool from 7 sources, caps it at `CANDIDATE_CAP = 18`, tags each with
`_source`, and filters `notRecent`. Add a **soft tempo re-rank** *after* the
pool is built, *before* the slice to 18 — bias toward candidates within a BPM
window of the current track (or toward the daypart's target tempo band), never
a hard filter, so the pool stays diverse and a `NULL`-BPM track is never
excluded.

The conversational agent picker (`dj.ts` `pickNextTrack` / the dj-agent) should
also **see** `bpm` on each candidate, and `PICKER_CRITERIA`'s FLOW clause
("energy, mood, tempo") can finally mean *measured* tempo instead of a guess.
Optionally surface a `tracksByTempo` discovery tool alongside the existing
`tracksByEnergy` in `llm/tools.ts`.

**Can:** smoother sets, intentional energy build/release across a daypart
(morning mellow → midday lift → evening wind-down) expressed in real BPM.
**Can't:** make two tracks *play in time*. The crossfade is still amplitude-only
— selecting compatible tempos reduces the *audible clash* during the overlap,
it does not beat-lock them.

---

## Feature 2 — Harmonic-aware selection

**Goal:** during the (configurable, ~10s default) crossfade overlap, reduce
melodic key clashes by biasing toward harmonically compatible next tracks.

**Where it hooks:** same place as tempo — a soft re-rank in `buildCandidates()`.
With keys stored as Camelot codes, "compatible" is cheap: same code, ±1 on the
wheel, or relative major/minor (same number, flip A/B). Score candidates by
Camelot distance to the current track and nudge compatible ones up the pool.
Surface `musical_key` to the LLM picker too, so it can reason about it.

**Matters most** exactly where the user noted — when two tracks overlap
melodically for a while, i.e. a long crossfade. Pair this with a per-transition
**crossfade-length** choice: harmonically-compatible + similar-BPM pairs can
take the longer blend; mismatched pairs get a *shorter* cross buffer (vary the
buffer via `override_duration` as `radio.liq`'s comments already prescribe —
**never** shrink the fade inside a fixed buffer, that sums to +6 dB).

**Can:** fewer dissonant overlaps, longer confident blends between compatible
tracks. **Can't:** key-shift a track to *force* compatibility (that's real-time
DSP and out of scope) — it only *chooses* better, and falls back to a short
cross when nothing compatible is in the pool.

---

## Feature 3 — Talk-within-the-intro

Covered in [dj-capabilities-plan.md](dj-capabilities-plan.md#3-talking-up-to-the-post--hardest).
`intro_ms` comes from this same pass; phase 1 there (budget the spoken line to
the runway so the DJ never talks over the vocals) needs only the number this
pass already produces. Listed here so the analysis pass is scoped to deliver
all three values in one sweep.

---

## How it plugs together

```
[ offline analysis pass ]  →  bpm / musical_key / intro_ms / confidence
        (tts-heavy sidecar or CLI)        ↓  stored in library-db.tracks
                                          │
   music/picker.ts buildCandidates() ─────┤  soft tempo + Camelot re-rank
                                          │  (NULL → no-op, never excluded)
   llm/dj.ts pickNextTrack / dj-agent ────┤  bpm + key surfaced per candidate;
                                          │  PICKER_CRITERIA FLOW now measured
   liquidsoap/radio.liq ──────────────────┘  per-transition crossfade length
                                             via override_duration only
```

Single source of truth, one offline pass, three selection-side payoffs, and a
clean `NULL` story so a freshly-installed or partially-analysed library plays
exactly as it does today.

---

## Sequencing

1. **Analysis pass + schema** — land the columns and the job first; it's inert
   until a consumer reads it, so it can ship and back-fill safely.
2. **Tempo-aware selection** — highest payoff, simplest hook (one re-rank).
3. **Harmonic-aware selection** — builds on the same re-rank; add the Camelot
   scoring and the optional per-transition crossfade-length tie-in.
4. **(intro budget)** — already tracked in the sibling doc.

## Non-goals (hard boundaries)

- **No real-time beatmatching / tempo sync / time-stretch.** Liquidsoap is a
  playout server; the file-poll IPC and the `cross` operator don't model two
  independently-nudged decks. Tempo data informs *selection only*.
- **No EQ bassline swaps / multiband per-deck mixing.** The broadcast bus is
  deliberately preserve-the-master (normaliser, widener, bus compressor all
  removed on purpose), and IIR filters hit the "Early computation of source
  content-type" wall on `request.queue`. Don't reopen that.
- **No key-shifting, scratching, backspins, or beat juggling.** Real-time
  performance DSP; meaningless for an unattended 24/7 station.
- **No heavy audio deps in the controller image.** Analysis lives in the
  `tts-heavy` sidecar or an offline CLI, never baked into the controller.
- **No behaviour change for un-analysed libraries.** Every new field is
  nullable and every consumer treats `NULL` as today's behaviour.
