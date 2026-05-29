# DJ capabilities — plan

Three upgrades that close the widest gaps between SUB/WAVE's AI DJ and a
human one. They're ordered the way they should ship — by effort-to-payoff,
not by how interesting they sound:

1. **Daypart vocal energy** — *cheapest.* The DJ already knows it's a
   late-night graveyard slot vs. a Friday drivetime; right now that only
   changes *what it says and plays*, never *how it sounds*. Make delivery
   (speech rate, and where engines allow it, pitch/style) track the daypart.
2. **Cross-hour memory** — *most valuable.* The session rolls — and the chat
   history with it — every time the auto daypart/mood key flips, so the DJ
   can't run a thread across an hour or call back to a track it played
   forty minutes ago. Carry real continuity across the roll.
3. **Talking up to the post** — *hardest.* The signature DJ skill: land the
   voice exactly as the vocals enter. Requires per-track intro-length data
   we don't currently have, plus tighter playback-time coordination than the
   file-poll IPC gives. Scoped here as a precompute-once feature.

Each is independent — ship them in this order, or cherry-pick. None of them
touches the broadcast audio bus topology (the limiter, the two `smooth_add`
ducking layers, the parallel MP3/Opus outputs) — those stay exactly as they
are.

## TL;DR

| Feature | Effort | Risk | Touches |
|---|---|---|---|
| Daypart vocal energy | ~½ day | Low | `context.ts`, `audio/tts.ts`, the engine modules' existing `speed` knob, `settings.ts` (one persona field) |
| Cross-hour memory | ~1–2 days | Medium | `broadcast/session.ts` (`maybeRoll`/handoff/`windowMessages`), no new files |
| Talking up to the post | ~3–5 days | High | new intro-length analysis at tag time (`music/`), `broadcast/queue.ts` air timing, `liquidsoap/radio.liq` poll cadence |

---

## 1. Daypart vocal energy — *cheapest*

### Why it's cheap

The plumbing already exists. Every local + cloud engine already takes a
**single global `speed` multiplier**:

- `audio/piper.ts` — `config.piper.speed` → `--length_scale (1/speed)`.
- `audio/kokoro.ts` — `config.kokoro.speed` passed to the worker.
- `llm/speech.ts` (cloud) — `config.tts.cloudSpeed`, `clampSpeed`-ed per provider.

The only reason it doesn't already vary by time of day is that the value is
read from static config, never from the moment. And the moment is already
computed: `context.getTimeContext()` returns nine dayparts
(`early-morning` → `after-hours`) each with a `vibe`, and
`getClockContext()` adds `isLateNight` / `isCommute` / `isWeekend`.

So the whole feature is: **thread a per-call `speed` (and optional `style`)
down through `tts.speak()`, resolved from the daypart.**

### Shape

1. **Energy map in `context.ts`.** Add `energyForDaypart(date)` returning a
   small descriptor, e.g.

   ```
   midday / drive-time → { speed: 1.06, register: 'up'   }  // punchy
   morning / afternoon → { speed: 1.00, register: 'even' }  // neutral
   evening             → { speed: 0.97, register: 'warm' }
   late-evening / after-hours / isLateNight → { speed: 0.92, register: 'intimate' }
   ```

   Keep it a pure function of the existing daypart so it has one source of
   truth and is unit-testable.

2. **Thread `speed` through `tts.speak()`.** `speak(text, { kind, outPath })`
   gains an optional `speed` (and later `register`/`style`). It already
   resolves the engine per kind; resolving an effective speed alongside it is
   the same shape. Each engine module already accepts a speed — pass the
   per-call value instead of only the config default (config stays the
   fallback when no per-call speed is given, so nothing regresses).

3. **Callers pass the daypart energy.** `broadcast/queue.js` (intros/links)
   and `broadcast/scheduler.js` (station IDs, hourly, weather) call
   `energyForDaypart(new Date())` and pass `.speed` into `speak()`. Spoken
   *content* already gets the daypart via `buildContextLines`; this just makes
   the *delivery* agree with it.

4. **Per-persona override (optional, one field).** Add an optional
   `tts.energy` / `tts.baseSpeed` to the persona shape in `settings.ts`
   (`SEED_PERSONAS` get sensible defaults — Wren slower and quieter, a
   drivetime persona faster). The daypart multiplier composes on top of the
   persona's base, so a naturally laid-back DJ at 2am is *very* laid-back,
   not jarringly perked up.

### What it can and can't do

- **Can:** make breakfast genuinely brisker than 2am, cheaply, with zero new
  dependencies and no audio-graph changes. Rate is the single biggest lever
  on perceived energy and every engine supports it today.
- **Can (engine-dependent):** richer expression — OpenAI/ElevenLabs cloud
  voices and Chatterbox can take a style/emotion hint; piper/kokoro can't, so
  for them `register` degrades gracefully to rate-only.
- **Can't:** true acoustic energy (mic compression, EQ tilt, brighter
  presence at breakfast). The `mic_chain` in `radio.liq` is static and shared;
  changing it per-segment is a separate, larger job and explicitly **out of
  scope** here. Don't touch the bus.

### Done when

A late-night line and a drivetime line, same persona, same engine, are
audibly different in pace; config-only deployments with no per-call speed
behave exactly as before.

---

## 2. Cross-hour memory — *most valuable*

### The actual problem

It is *not* a strict hourly wipe. `broadcast/session.ts` rolls the session —
and resets the chat history — whenever `sessionKeyFor(ctx)` changes or the
session ages past `MAX_SESSION_MS` (4h). For an autonomous block the key is
`auto:<period>:<mood>`, so it flips every time the **daypart** turns over
(`afternoon` → `drive-time`) or the **dominant mood** changes (a weather
shift, a festival starting). In practice that's roughly hourly, and each flip
throws away the running `messages` history. Only a **one-line text handoff**
survives (`start(ctx, handoff)`).

So the DJ can't say "like I was playing earlier," can't build a bit across
two songs that straddle 5pm, can't reference the track from forty minutes
ago. `windowMessages()` already coalesces the last ~40 turns into the agent's
context — but those turns vanish at the roll.

### Shape

Three changes, all inside `broadcast/session.ts`, no new files:

1. **Richer handoff than one line.** On roll, instead of a single string,
   carry a compact structured handoff forward: last N spoken-segment gists,
   last few tracks played, any open thread the DJ flagged, and the previous
   persona/mood. Generate it the way the existing handoff is generated, just
   with more structure. The new session seeds its `messages` with a single
   synthetic "previously on this station…" turn built from it — so the agent
   *starts* with continuity instead of a blank slate.

2. **Decouple roll from daypart churn.** A daypart turning over
   (`afternoon`→`drive-time`) shouldn't nuke continuity the way a *show*
   change legitimately should. Options, cheapest first:
   - Treat consecutive `auto:*` keys as the **same** session for history
     purposes — roll the *identity/key* but **keep the `messages` window**,
     trimming by age, not by key change. The 4h `MAX_SESSION_MS` cap and any
     `show:<id>` → `show:<id>` or `auto` → `show` boundary still hard-roll
     (a scheduled show genuinely is a new program).
   - This is the highest-leverage single change and is mostly a guard in
     `maybeRoll` plus carrying `messages` into `start`.

3. **Longer effective window across the boundary.** `windowMessages()` keeps
   ~40 turns; ensure the carried-over turns count toward that window (oldest
   trimmed by age) so a callback to "the track at the top of the hour" is
   actually still in context.

### What it can and can't do

- **Can:** real narrative continuity within a sitting — callbacks, running
  bits, "earlier I played…", a thread that survives the 5pm daypart turnover.
  This is the biggest perceived-humanity jump per unit of effort: it makes the
  DJ feel like *a person doing a shift* rather than a fresh prompt each hour.
- **Can't (and shouldn't):** persist a persona's memory across *days* or across
  a genuine show change — a scheduled show is a different program and should
  start clean (with a handoff, not a transcript). Long-term per-listener
  memory is a different feature (and bumps into the single-shared-stream
  reality — see below).
- **Watch:** prompt growth. Carrying more history costs tokens on every pick.
  Keep the structured handoff *compact* (gists, not transcripts) and lean on
  `windowMessages()`'s existing age-trim so the agent context stays bounded —
  the homelab Ollama default is the slow path and must not balloon.

### Done when

After a daypart turnover with no scheduled-show change, the DJ can correctly
reference a track or topic from before the boundary; a scheduled show still
starts on a clean slate with only a handoff line.

---

## 3. Talking up to the post — *hardest*

### Why it's hard

This is the signature human-DJ skill: talk over a song's instrumental intro
and land the last word exactly as the vocals enter — without stepping on them.
SUB/WAVE today does the *texture* of it well (the `#189` fix defers the intro
WAV to `onTrackStarted` → `airIntro`, and a silent `leadin.wav` lets the
`smooth_add` light-duck complete before the first word) — but it has **zero
knowledge of where the vocals start**. The voice begins cleanly *with the
track* and ducks correctly; it just can't aim for the post, because nothing in
the system knows the post exists.

Two hard limits sit underneath:

- **No song-structure data.** The picker tools and `now-playing` carry only
  `title/artist/album/year/genre/duration` — never intro length or
  vocal-onset time.
- **File-poll IPC granularity.** Controller↔Liquidsoap is "write a file, poll
  for it" at 0.5–1.0s. Even with a target time, you can't reliably hit it to
  sub-second precision through that channel as-is.

### Shape (precompute-once, not real-time DSP)

Don't try to analyse audio live on the broadcast box. Precompute a
**vocal-onset / intro-length** number per track, once, and store it — the same
pattern as the mood tagger (`music/tag-library.ts`, resumable, saves in
batches).

1. **Intro-length analysis pass.** A new resumable job (mirror
   `tag-library.ts`: `npm run tag-intros [-- --limit N]`) that, per track,
   estimates seconds-until-vocals. Approaches in increasing cost/accuracy:
   - **Energy/onset heuristic** — first sustained RMS/onset rise after the
     count-in. Cheap, rough, no vocal/instrument distinction.
   - **Source-separation or VAD on a downmix** — run a vocal-detection /
     stem-split model over the first ~30s, take the first vocal frame. Much
     better, much heavier — belongs in the **optional `tts-heavy` sidecar**,
     not the controller image (same reasoning as Chatterbox/PocketTTS).
   - Store `introMs` (and a confidence) in the moods/library store keyed by
     `subsonic_id`, alongside the existing mood tags.

2. **Carry `introMs` to air time.** `subsonic.getAnnotatedUri` / the queue
   item gains the precomputed `introMs`; `queue.js` knows, when it fires
   `airIntro`, how long the talk-over runway is.

3. **Fit the talk to the runway (two levers, combine them):**
   - **Pick/trim the line to length.** The DJ layer already controls verbosity
     (`LENGTH_PHRASES`, `lengthPhrase`). Feed the runway in so a 6-second intro
     gets a one-breath line and a 20-second intro gets room — generate to a
     *time budget*, not just a sentence count. Cheapest, no Liquidsoap change.
   - **Nudge the air moment.** For finer landing, the controller can delay the
     `airIntro` write so the line *ends* near `introMs` (start ≈
     `introMs − estimatedSpeechDuration`, where speech duration is derivable
     from the rendered WAV length). This needs a tighter poll on `intro.txt`
     (drop from 0.5s toward ~0.1s) or a small scheduled-write mechanism — the
     IPC-granularity work.

4. **Always degrade safely.** No `introMs` (untagged track, low confidence) →
   behave exactly as today: talk cleanly from track start, duck, done. The
   post is a *bonus* when the data exists, never a precondition for speaking.

### What it can and can't do

- **Can (phase 1, cheap):** "talk *within* the intro" — never run the voice
  past the known vocal-onset, by budgeting the line to the runway. That alone
  removes the worst failure (DJ still talking when the singer comes in) and is
  achievable with no Liquidsoap change.
- **Can (phase 2, harder):** actually *land on* the post by timing the air
  moment — needs tighter IPC and per-track `introMs` you trust.
- **Can't:** beatmatching, harmonic/key mixing, or any real-time reactive
  timing. There's no live audio analysis on the bus and adding one is a
  different project. Onset accuracy is also bounded by the analysis method —
  the cheap heuristic will misfire on ambient/atonal intros, which is exactly
  why phase 1 only *constrains* the line and never *depends* on the number.

### Done when

Phase 1: on tracks with a known intro length, the DJ reliably stops talking
before the vocals enter; untagged tracks are unaffected. Phase 2 (stretch):
the line lands within ~0.5s of the vocal onset on high-confidence tracks.

---

## Sequencing & non-goals

Ship **1 → 2 → 3**. Each stands alone and each degrades to today's behaviour
when its data/inputs are absent, so a half-done rollout is never worse than
the status quo.

**Explicit non-goals** (out of scope for all three):
- No changes to the broadcast audio bus — the limiter, the two `smooth_add`
  ducking layers, the crossfade `dj_transition`, the parallel MP3/Opus
  outputs all stay byte-for-byte.
- No per-listener profiling or memory. One Icecast stream means every listener
  hears the same broadcast; true 1:1 intimacy beyond request shout-outs is a
  product boundary, not a backlog item.
- No real-time audio analysis on the broadcast container. Anything heavy
  (vocal-onset separation) is a precompute job and, if it needs PyTorch, lives
  in the optional `tts-heavy` sidecar — never in the controller image.
