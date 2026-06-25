# Picker pipeline reference — verified state, not asserted state

This doc exists because CLAUDE.md's note on library analysis coverage
("~20%, skewed alphabetically") was written 2026-06-19 against a background
tagger job that was still running, then never re-checked. It went stale
silently and got repeated as current fact during a live debugging session on
2026-06-25. Everything below was checked directly against the running system
on that date — the query/command used is included so it can be re-run rather
than re-trusted. **If you're reading this more than a few weeks after
2026-06-25, re-run the verification queries before believing any number in
here** — anything that depends on a background job's progress (most of all,
analysis/CLAP coverage) is a moving target until someone confirms the job has
actually stopped moving.

## Library analysis coverage (verified 2026-06-25)

```
curl http://ma-db-api.../api/v1/tracks?limit=1                      → total: 37093
curl http://ma-db-api.../api/v1/tracks?limit=1&has_analysis=true    → total: 37093
curl http://ma-db-api.../api/v1/tracks?limit=1&has_clap=true        → total: 37093
```

**Full coverage — every track has analysis (bpm/key/loudness/sonic axes) and
a CLAP embedding.** This supersedes CLAUDE.md's "~20%, skewed alphabetically"
note, which described the tagger mid-run on 2026-06-19. The tagger evidently
finished sometime in the following week; nothing flagged that completion.

Practical consequence: nothing in the picker pipeline below is currently
degraded by missing analysis. The "neutral 0.5 score when un-analysed"
fallbacks described in `music/theme-centroid.ts` and `music/ma-candidate-
pool.ts` are real code paths but should not be firing on this corpus today —
if you see a 0.5-neutral score in shadow logs or `/debug` on a track that
should be analysed, that's a regression worth investigating, not expected
behaviour.

## Three pick paths, what each one actually does

There are three independent ways a track gets queued. They don't share logic
beyond reading the same `schedule.json` show config.

### 1. LLM agent (`broadcast/dj-agent.ts`'s `pickViaAgent`)

Runs when a listener is present (`djCallsAllowed()`) and the queue is empty.
A `ToolLoopAgent` gets the session chat window + discovery tools
(`llm/internal/tools/picker-tools.ts`) and either calls a tool then commits
via a `done` tool, or (native-capable providers) emits structured output
directly after at least one tool call.

- **Brief pool reserve**: `dj-agent-mod.ts`'s `buildBriefPoolForShow` —
  for a show with `moods` configured, either the exemplar-driven shortlist
  (`buildMaShortlist`, when the show has a usable exemplar profile) or the
  old flat mood+vibe pool (`pool.buildBriefPool`, when it doesn't). Always
  fully gated. Injected into every tool's results as up to 4 reserve
  candidates (`BRIEF_RESERVE`).
- **Exemplar genre gate** (`music/theme-centroid.ts`): a show's
  `exemplarTrackIds` (2-8 real library tracks) get their literal genre tags
  pooled into a palette and their CLAP vectors pooled for similarity
  ranking. `tracksByMood`/`tracksByEnergy`/`searchLibrary`/`searchByLyrics`
  hard-filter every candidate against that palette. `tracksLikeThis`/
  `tracksThatSoundLikeThis` use `collectPreferGated`: try the gate first,
  only widen to ungated when the gated pass returns nothing — confirmed live
  that a flat gate zeroes ~84% of calls (CLAP-similarity neighbours of a
  genuinely on-palette seed routinely carry a different literal tag — e.g.
  real neighbours of a "Breaks"-tagged seed came back `Ambient`/`Electronic`/
  `IDM`/`Dance`, none literally `Breaks`/`Downtempo`), and a flat exemption
  drifts genre over a chain of "flow" hops (confirmed live: Disco/Downtempo/
  Dance exemplars drifting into pure classic rock over ~8 successive picks).
- **Hallucination recovery**: if the model commits an id not in the
  accumulated candidate set (`seen`), it's a model error, not an empty pool
  — recorded via `pick.rejected` and recovered by picking from `seen`,
  preferring candidates that passed the gate cleanly over ones admitted only
  through `collectPreferGated`'s widened pass (`_exemplarGateBypassed`).
  Only throws (triggering the 3-strikes circuit breaker → `music/picker.js`
  fallback) when `seen` is genuinely empty. The model's own `reason`/`say`
  text is discarded on this path — it describes the track the model THOUGHT
  it picked, not the substitute, so airing it would have the DJ describe a
  different song than the one playing.
- **Soft leans**: `fromYear`/`toYear`/`energy`/`genre` reach the system
  prompt via `dj.showMusicLean` — text hints, not filters, on this path.

### 2. auto.m3u refresh (`broadcast/scheduler.ts`'s `refreshAutoPlaylistInner`)

Runs on a timer (`AUTO_QUEUE_REFRESH_MINUTES`, default 60), no LLM involved.
Liquidsoap falls back to this file whenever the agent queue is empty (no
listener, agent disabled, etc.) — for a personal station this is plausibly
the majority-of-the-time path, not a rare fallback.

- Same exemplar gate + CLAP ranking as the agent's brief pool
  (`buildMaShortlist`), producing theme/flow/discovery/oldie slots.
- A random "diversity buffer" gets unconditionally appended — scaled to 25%
  of the gated shortlist's own size (floor 2), **not** a fixed count.
  Confirmed live the diversity buffer at a fixed 20 was the literal majority
  of what aired (19 of 28 tracks for a 9-track gated shortlist) with zero
  relation to the show's genre — that's the Ella Fitzgerald-during-an-
  electronic-show incident.
- **`fromYear`/`toYear`/`energy` are dead on this path** — `scheduler.ts`
  and `ma-candidate-pool.ts` never reference them. They only apply via the
  agent's system prompt (path 1), so any show running mostly on auto.m3u
  effectively never has them enforced.

### 3. Stateless pool fallback (`music/picker.js`'s `pickViaPool`)

Runs when the agent fails 3 times in a row (the circuit breaker) or
`settings.llm.pickerAgent` is off. Builds a balanced pool from flat
mood/energy/era filters — **no exemplar awareness at all**. This is the
path every exemplar-gate fix this session was ultimately trying to keep the
system OFF of, since it silently drops all the genre-gating work for
whatever its 10-minute disable window lasts.
- `fromYear`/`toYear`/`energy`/`genre` ARE hard filters here (the one path
  where they're unconditionally enforced).

## Show-config field liveness (verified 2026-06-25, by reading every call
site, not by reading field descriptions)

| Field | Agent picks | auto.m3u | Pool fallback |
|---|---|---|---|
| `topic` | live (system prompt) | n/a | n/a |
| `vibe` | **dead** | **dead** | dead unless text embeddings enabled — and `embedding.enabled: false` station-wide as of 2026-06-25, so dead everywhere, period |
| `exemplarTrackIds` | live | live | n/a (path predates exemplars) |
| `moods` | live | live | live |
| `genre` | live (hard filter) — by design convention left blank once exemplars are set | **dead** | live (hard filter) |
| `fromYear`/`toYear` | live (soft lean) | **dead** | live (hard filter) |
| `energy` | live (soft lean) | **dead** | live (hard filter) |
| `excludePatterns` | live | live | live |
| `themeId` | n/a — cosmetic web-player palette, unrelated to picking | n/a | n/a |

`vibe`'s deadness is two independent facts, not one: the exemplar branch
bypasses its only consumer (`pool.buildBriefPool`'s `vibeText` param) for
every currently-configured show, AND that consumer is itself a no-op because
text embeddings are disabled. Either fact alone would kill it; both are true.

## What this doc is not

This is a snapshot of mechanism and verified state, not a running log of
every fix made this session — see the actual commits (`8bad461` through
`ff3b221` on `main`, 2026-06-24/25) for that history. Don't extend this doc
with new "confirmed live" anecdotes every time something is fixed; update
the relevant section in place when the mechanism itself changes, and re-run
the verification commands above before trusting any number in it.
