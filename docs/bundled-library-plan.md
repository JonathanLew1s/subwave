# Plan — Optional bundled Subsonic library for operators without one

## Goal

Today SUB/WAVE assumes the operator already runs a Subsonic-compatible music
server (typically Navidrome) somewhere on their network. That assumption is
fine for homelabbers but is the single largest "I want to try this" friction
point for new operators — they have to stand up a music server, point it at a
library, create a user, and only then can they boot the radio.

Make a music-library server an **optional, opt-in profile** in the production
compose so a brand-new operator can go from `docker compose up -d` to a
broadcasting station without provisioning anything external — while existing
operators with their own Navidrome / Airsonic / Gonic install pay zero cost
(no extra container, no extra image pull).

## Why not just swap engines

The obvious alternative is "replace Navidrome with something leaner". After
looking at the field, that's the wrong move:

| Server      | Lang | Image  | Web UI | API coverage    | Notes |
|-------------|------|--------|--------|-----------------|-------|
| Navidrome   | Go   | ~30 MB | yes    | very high       | Battle-tested, best metadata/tag handling, smart playlists, scrobbling. |
| Gonic       | Go   | ~15 MB | minimal| high (API-only) | Headless-first, lighter, fewer extras. Decent Subsonic dialect. |
| LMS         | C++  | ~40 MB | yes    | medium          | Lean runtime, less Subsonic dialect coverage; primary API is its own. |
| Airsonic-A. | Java | ~250 MB| yes    | high            | Heavy JVM; not worth it. |
| Supysonic   | Py   | ~80 MB | minimal| medium          | Less maintained. |

The gap between Navidrome (~30 MB) and gonic (~15 MB) is real but small in
absolute terms, and Navidrome's metadata quality directly affects picker
quality — the pool picker leans on artist / album / genre tags from
`getSimilarSongs`, `getArtistInfo`, `getTopSongs`, mood-tagged playlists, and
recently-added albums. Swapping to gonic to save ~15 MB of disk while losing
metadata fidelity would degrade the on-air experience.

**Decision: bundle Navidrome as an optional profile, don't replace it.** Keep
gonic in our back pocket as a future drop-in if image size or memory ever
becomes the actual pain point — the controller only ever speaks Subsonic API,
so a future swap is a compose change, not a code change.

## Operator flow after this lands

```bash
# Has their own music server (existing flow, unchanged)
docker compose up -d
# then /onboarding asks for Subsonic URL/user/pass as it does today

# Wants the bundled library
SUBWAVE_BUNDLE_LIBRARY=1 docker compose --profile with-library up -d
# /onboarding sees the bundled library is running, skips the creds step,
# and instead prompts: "where is your music folder on this host?"
# Defaults to ./music; the operator drops files in and Navidrome scans.
```

`--profile with-library` is a native Compose feature — services tagged
`profiles: [with-library]` only start when that profile is named, so existing
operators see zero extra containers when they do plain `docker compose up -d`.

## Architecture changes

### 1. `docker-compose.yml` — add a profiled `library` service

```yaml
  library:
    image: deluan/navidrome:latest
    profiles: [with-library]
    restart: unless-stopped
    networks: [subwave]
    volumes:
      - ${MUSIC_DIR:-./music}:/music:ro
      - ${STATE_DIR:-./state}/navidrome:/data
    environment:
      ND_LOGLEVEL: warn
      ND_SCANSCHEDULE: 1h
      ND_SESSIONTIMEOUT: 24h
      # Auto-provision a single user on first boot via env (avoids needing
      # to open Navidrome's web UI for setup).
      ND_DEFAULTADMINNAME: ${LIBRARY_USER:-subwave}
      ND_DEFAULTADMINPASSWORD: ${LIBRARY_PASS:?required when SUBWAVE_BUNDLE_LIBRARY=1}
    # Internal-only — Caddy doesn't route to it; only the controller talks to it.
```

Mirror this block (minus the `caddy`-fronting bits) into
`docker-compose.byo.yml` so BYO-proxy users get the same opt-in.

Notes:

- **No host port binding.** The controller reaches it as `http://library:4533`
  on the internal `subwave` network. The operator's reverse proxy doesn't
  expose it — if they want to administer Navidrome's web UI, they can `docker
  compose exec library …` or bind a port locally.
- **`./music` is read-only** to Navidrome. Operator drops MP3/FLAC into it
  from the host (`scp`, `rsync`, file manager); Navidrome scans on a 1h
  schedule and on file-change notify.
- **`state/navidrome/`** holds Navidrome's SQLite DB and cache, so a `state/`
  wipe also clears the library DB (intentional — keeps the "state is
  everything mutable" invariant).

### 2. Root `.env` — two new optional vars

```dotenv
# Required (existing)
ADMIN_USER=
ADMIN_PASS=
SITE_URL=

# Optional — only used when running with --profile with-library
LIBRARY_USER=subwave
LIBRARY_PASS=                      # required iff profile is enabled
MUSIC_DIR=./music                  # host path that Navidrome scans
```

Update `.env.example` and `cli/src/commands/setup.ts` to surface these as
"Skip unless you want the bundled library" prompts.

### 3. Controller — detect bundled library, skip the creds wizard step

Two small touch-ups, both isolated to setup code:

- **`controller/src/setup/firstRun.ts`**: when
  `process.env.SUBWAVE_BUNDLE_LIBRARY === '1'`, treat
  `config.navidrome.url = http://library:4533` plus the auto-provisioned
  user/pass (read from `LIBRARY_USER` / `LIBRARY_PASS`) as the implicit
  Subsonic source. `needsSetup` stays driven by "does the operator still need
  to choose LLM/TTS/persona", not by Navidrome creds.
- **`controller/src/setup/onboardingState.ts`** (or wherever the wizard
  bootstraps): expose a `bundledLibrary: boolean` flag in `/state` so the
  wizard knows whether to show the creds step or the music-folder step.

### 4. Onboarding wizard — branch the Navidrome step

In `web/components/onboarding/steps.tsx`:

- If `bundledLibrary === true`, replace the URL/user/pass form with a
  read-only summary ("Using bundled library at `http://library:4533` as
  `subwave`") plus a one-liner: "Drop music files into the `music/` folder
  next to your `docker-compose.yml`. Navidrome scans hourly."
- Reuse the existing `TestPill` against `/api/onboarding/test-navidrome` —
  that endpoint already works against any Subsonic URL, so no controller
  changes are needed to validate the bundled instance.
- Add a "Switch to external library" escape hatch that flips back to the
  current URL/user/pass form, in case the operator changes their mind.

### 5. Docs

- New section in `README.md` under "Quick start": "With a music library
  bundled" vs "Bring your own Navidrome".
- Update `docs/single-compose-plan.md` cross-link.
- Note in `docs/deployment.md` that `MUSIC_DIR` is the only new host-path
  surface and `--profile with-library` is the on-switch.

## Open questions for the operator

1. **Auto-provisioning vs first-launch wizard.** Navidrome supports
   `ND_DEFAULTADMINNAME` / `ND_DEFAULTADMINPASSWORD` to seed the initial
   admin from env. Confirm this is acceptable security-wise (the password
   lives in the root `.env` alongside `ADMIN_PASS`).
2. **Default scan interval.** Navidrome scans on file-change (inotify) and on
   `ND_SCANSCHEDULE`. The plan defaults to `1h` to keep the picker's view of
   the library fresh without thrashing. Tune as needed.
3. **Library volume layout.** `./music` next to `docker-compose.yml` is the
   simplest mental model. If we want to support pointing at an existing
   library path elsewhere on the host, that's already covered by `MUSIC_DIR`.
4. **Future swap to gonic.** If we later want to replace Navidrome with a
   leaner engine, the only changes are (a) the `library` block in the compose
   files, (b) the bundled-library URL in `firstRun.ts`. Controller code is
   API-agnostic.

## Out of scope

- Importing music *into* the bundled library from inside the wizard. The
  operator owns the `music/` folder; we don't try to upload through the
  controller.
- Bundling Ollama or any other LLM provider. That's a separate, much larger
  conversation (GPU vs CPU, model size, licence).
- Migrating existing operators with their own Navidrome onto the bundled
  one. The two flows are independent.

## Effort estimate

Small. The plan is ~80% YAML and docs. Real code changes are limited to:

- `controller/src/setup/firstRun.ts` — ~15 lines.
- `controller/src/setup/onboardingState.ts` — ~5 lines for the new flag.
- `web/components/onboarding/steps.tsx` — one new branch in the Navidrome
  step (~40 lines).
- `cli/src/commands/setup.ts` — surface the new env vars (~20 lines).

No new dependencies, no new controller routes, no Liquidsoap changes.
