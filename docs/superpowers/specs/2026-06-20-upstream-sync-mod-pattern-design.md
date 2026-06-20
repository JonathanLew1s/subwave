# Upstream sync: a "mod" pattern for the fork

## Problem

`main` has diverged from `upstream/main` in both directions: 97 commits ahead, 48 behind. The overlap — files both sides have modified since the merge base (`ec14521`) — is 19 files across `music/`, `llm/`, `broadcast/`, `routes/`, and `settings.ts`. Two shapes of risk show up in that overlap:

1. **Logic entanglement.** Where our changes are interleaved into upstream's function bodies (rather than living in new files), every upstream edit to that function is a potential conflict, and the conflict gets harder to resolve correctly the more our logic and upstream's logic share the same lines.
2. **Structural refactors.** Upstream's PR #414 split `llm/sdk.ts` into `llm/internal/**` and turned `llm/agent.ts`, `llm/tools.ts`, `llm/segment-tools.ts`, and `llm/dj.ts` into 5-line barrel re-exports. Our edits to those files (brief-pool reservation in `buildPickerTools`, `justPlayedArtists`, async `buildTools`, etc.) are sitting in the now-orphaned old location and need to be ported to wherever upstream moved the function.

`music/library.ts` already shows the pattern that avoids #1 going forward: every MA-specific function is a one-line dispatch (`if (config.libraryBackend === 'ma-api') return _ma.fn(...)`) into a sibling file (`library-ma.ts`) that holds all the real logic. This design generalizes that pattern to the rest of the overlap set, fixes the one outstanding structural break (#2), and adopts a rebase-based sync workflow that the pattern is built to support.

## Goals

- Every upstream-owned file in the 19-file overlap set ends up containing only thin dispatch lines for fork-specific behavior — no inlined fork logic.
- The one known structural break (the `llm/sdk.ts` split) is reconciled: our additions exist in upstream's new `internal/**` locations, and the old barrel files are untouched by us.
- `main` is rebased onto current `upstream/main`, cleanly, with the above two steps done first so the rebase has minimal conflicts.
- Ongoing syncs are periodic rebases (not merges) of `main` onto `upstream/main`.

## Non-goals

- Changing any runtime behavior of the MA backend, picker, or DJ agent. This is a pure code-organization + sync-mechanics change.
- Covering files outside the identified 19-file overlap set (no overlap = no entanglement risk = nothing to do).
- Automating the rebase or building CI tooling around it. Out of scope for this pass; revisit later if rebases keep being painful.

## Part 1 — Reconcile the `llm/sdk.ts` split

Upstream's refactor (PR #414) relocated logic as follows:

| Old file (still exists, now a barrel) | New home |
|---|---|
| `llm/tools.ts` | `llm/internal/tools/picker-tools.ts` (`buildPickerTools`) |
| `llm/segment-tools.ts` | `llm/internal/tools/segment-tools.ts` (`buildSegmentTools`) |
| `llm/agent.ts` | `llm/internal/agent-factory.ts` (`defineAgent`) |
| `llm/dj.ts` | spread across `llm/internal/prompts/*.ts` |

Our diff against the old files (computed against merge-base `ec14521`) is the full list of what needs porting:

- **`llm/tools.ts` → `internal/tools/picker-tools.ts`**: `isRadioPickable` + `buildExcludeRegexes`, the `duration`/`source` fields in `slim()`, the `justPlayedArtists`/`maxDurationSec`/`excludePatterns`/`briefPool` params and `BRIEF_RESERVE` reservation logic in `buildPickerTools`, the `topSongsByArtist` recent-artist refusal, and the `library.ts` calls that need to become `await` (since `library.songsByMood` etc. are now async — see Part 2).
- **`llm/agent.ts` → `internal/agent-factory.ts`**: the `buildTools` signature widened to allow `Promise<{tools, extras}>`, and the `await` at the call site.
- **`llm/segment-tools.ts` → `internal/tools/segment-tools.ts`**: re-check our 1-line diff still applies; port if so.
- **`llm/dj.ts` → `internal/prompts/*.ts`**: re-check our diff (13 insertions / 7 deletions) against the new prompt modules; the content likely now lives in `internal/prompts/picker.ts` or `internal/prompts/system.ts` — locate by following the prompt text, not the old file structure.

This is a manual, read-the-diff-then-find-the-new-home porting pass — there's no mechanical shortcut, since the relocation isn't 1:1 per file. Do this *before* the Part 3 rebase, working directly against `upstream/main` (not yet rebased `main`), so the ported code is reviewable on its own before it's mixed into the rebase.

## Part 2 — Generalize the dispatch pattern

Apply the `library.ts`/`library-ma.ts` shape to the rest of the overlap set. Convention (per your choices): flat, suffix-based, same directory as the file it extends — `<name>-mod.ts` for general fork logic, keep `-ma.ts` specifically for the MA-backend branch (already established, don't rename).

For each of the remaining overlap files, extract our current diff (against merge-base) into a sibling file, leaving a single dispatch call where the logic used to be inline:

- `music/tag-library.ts` → `tag-library-mod.ts`
- `music/library-db.ts` → `library-db-mod.ts`
- `music/subsonic.ts` → small diff (stream URL format change); evaluate whether a dispatch is even warranted (see Open Question below) or whether this one stays a direct edit
- `broadcast/dj-agent.ts` → `dj-agent-mod.ts`
- `broadcast/tagger.ts` → `tagger-mod.ts`
- `routes/{debug,dj,library,onboarding,public,request,settings}.ts` → one shared `routes/mod.ts` is likely overkill; prefer per-route `*-mod.ts` only where the diff is non-trivial (library.ts, onboarding.ts, request.ts); trivial one-liners (debug.ts, public.ts, server.ts) stay inline — a dispatch wrapper for a 3-line diff adds indirection without reducing conflict risk.
- `settings.ts` → `settings-mod.ts` (this one has the largest our-side diff at 318 lines — highest priority after the LLM reconciliation)

Each extraction follows the same shape as `library.ts`'s existing functions: the upstream-owned function signature is preserved exactly; the body becomes a guard clause or dispatch call; the sibling file owns 100% of our logic, including any new types/constants it needs.

**Where the diff is upstream-dominant, not ours** (e.g. `subsonic.ts`: 135 lines upstream added, 7 lines ours), no extraction is needed — there's no fork logic to isolate, just a normal upstream feature we'll pick up on rebase, plus a one-line independent edit. Don't manufacture a dispatch wrapper for content that isn't ours.

## Part 3 — Rebase

Once Parts 1–2 land on `main` (against current `upstream/main`, not yet rebased), do `git rebase upstream/main`. With the dispatch pattern in place, replaying our 97 commits should only conflict at dispatch lines (small, mechanical) rather than inside shared function bodies.

Going forward: rebase `main` onto `upstream/main` periodically — recommended cadence is **before/after each upstream tagged release**, or monthly, whichever is more frequent. When a future upstream change is itself a structural refactor (like the `sdk.ts` split), repeat the Part 1 treatment scoped to just the relocated files before resuming routine rebases.

## Testing / validation

- After Parts 1–2, before the rebase: `cd controller && npm run lint` (eslint + tsc) must pass, and the controller should boot in dev mode (`docker compose -f docker-compose.dev.yml up -d`) with both `library.backend=navidrome` and `library.backend=ma-api` to confirm the dispatch points still route correctly.
- After the Part 3 rebase: same lint + dual-backend boot check, plus a manual smoke test of one DJ pick cycle in each backend mode (confirms `internal/tools/picker-tools.ts` ported logic — brief pool, exclude patterns — actually executes).

## Open questions

- For files where the diff is small but genuinely ours (e.g. `subsonic.ts`'s stream URL format change, `routes/debug.ts`'s 15-line addition), is a dispatch wrapper worth the indirection, or do these stay as direct edits and accept the (small, occasional) conflict cost? Current recommendation: direct edit, revisit only if a specific file starts conflicting repeatedly.
