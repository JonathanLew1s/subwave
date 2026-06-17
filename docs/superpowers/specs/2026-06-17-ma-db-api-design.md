# music-assistant-db-api — Design Spec

**Date:** 2026-06-17  
**Status:** Draft  
**Repo:** standalone (`music-assistant-db-api`), deployed as sidecar in MA pod

---

## Problem

Music Assistant runs expensive audio analysis (CLAP 1024-dim embeddings, BPM, smart fades, loudness, sonic features) that SUB/WAVE and other tools want to consume. MA's own REST API on port 8095 exposes none of this data. The only access path is the SQLite database at `/data/library.db` inside MA's container.

The current approach — a manual `copy-pod` or `kubectl cp` to snapshot the DB — is a local hack. It doesn't work for docker-compose deployments, requires cluster admin, and copies a potentially hot WAL file.

---

## Solution

A standalone Rust service that runs as a **sidecar container in the MA pod**, opens `library.db` read-only in WAL mode, and exposes the full enriched library — metadata, audio features, CLAP vectors, file paths, cover art — as a proper REST API with an OpenAPI spec.

**No dependency on MA's 8095 API.** The bridge reads the SQLite file directly. MA and the bridge fail together (same pod), which is acceptable: if MA is down, the library is unavailable regardless.

---

## Goals

- General-purpose REST API over the MA SQLite DB — not subwave-specific
- Full audio analysis exposure: CLAP 1024-dim, BPM, key/mode/Camelot, beats, LUFS, valence/energy/danceability/arousal/acousticness/instrumentalness
- Runtime query capability (filter, sort, similarity) — not just bulk export
- KNN similarity search via CLAP vectors built into the bridge
- Cover art served directly from MA's thumbnail cache on disk
- Optional API key auth (`MA_BRIDGE_API_KEY` env var)
- OpenAPI spec generated from code via `utoipa`
- Single static binary; scratch/Alpine image ~5–8MB
- Deployed as sidecar in MA pod (k8s) or separate service (docker-compose)

---

## Non-Goals

- Write operations — the bridge is strictly read-only
- Wrapping MA's own API (WebSocket events, player control, provider management)
- Replacing MA — it continues to run normally alongside the bridge
- Authentication via MA's JWT — a static API key is sufficient

---

## Tech Stack

| Concern | Choice | Reason |
|---|---|---|
| Language | Rust | Static binary, no runtime, fast vector math, no GC |
| HTTP | `axum` | Async, ergonomic, excellent middleware story |
| SQLite | `rusqlite` (bundled) | Mature, WAL-mode concurrent reads, static linking |
| Vector search | `sqlite-vec` extension | KNN over CLAP 1024-dim, loaded at runtime |
| Connection pool | `deadpool-sqlite` | Async-friendly pool over rusqlite |
| JSON | `serde` + `serde_json` | Zero-copy where possible |
| OpenAPI | `utoipa` + `utoipa-axum` | Spec generated from route/model annotations |
| Middleware | `tower-http` | CORS, compression, request tracing |
| Container | Alpine / scratch | ~5–8MB final image |

---

## Architecture

```
k8s Pod: music-assistant
┌─────────────────────────────────────────────────────┐
│  container: music-assistant                         │
│    writes → /data/library.db (WAL mode)             │
│    writes → /data/.storage/thumbnails/              │
│                                                     │
│  container: ma-db-api                               │
│    reads  → /data/library.db (read-only, WAL)       │
│    reads  → /data/.storage/thumbnails/              │
│    serves → :8097                                   │
└─────────────────────────────────────────────────────┘
          │
          │ ClusterIP service: ma-db-api:8097
          │
   ┌──────┴──────┐         ┌────────────┐
   │  subwave    │         │  any other │
   │ controller  │         │  consumer  │
   └─────────────┘         └────────────┘
```

Both containers share the pod's `data` volume. SQLite WAL mode allows concurrent readers while MA writes — no locking issues. The bridge opens with `PRAGMA journal_mode=WAL; PRAGMA query_only=ON;`.

---

## API Design

Base path: `/api/v1`  
All responses: `application/json`  
All list endpoints: cursor-style pagination via `offset` + `limit` (default 100, max 1000)

### Authentication

If `MA_BRIDGE_API_KEY` is set, every request must include:
```
Authorization: Bearer <key>
```
Returns `401` if missing or wrong. If the env var is unset, the API is open.

---

### `GET /api/v1/health`

Liveness + DB stats. No auth required.

**Response:**
```json
{
  "status": "ok",
  "db_schema_version": 12,
  "track_count": 37219,
  "analysis_coverage": {
    "loudness": 37219,
    "bpm": 7047,
    "clap": 7056,
    "sonic": 7056
  }
}
```

---

### `GET /api/v1/tracks`

Paginated track list. The primary sync and discovery endpoint.

**Query parameters:**

| Param | Type | Description |
|---|---|---|
| `offset` | int | Pagination offset (default 0) |
| `limit` | int | Page size (default 100, max 1000) |
| `since` | int | Unix timestamp — only tracks modified after this |
| `include` | string | Comma-separated: `analysis`, `clap`. `analysis` adds all audio features. `clap` adds the 1024-dim embedding (only valid with `analysis`). |
| `favorite` | bool | Only favorited tracks |
| `genre` | string | Exact genre match |
| `artist_id` | int | Filter by MA artist ID |
| `album_id` | int | Filter by MA album ID |
| `bpm_min` | float | BPM lower bound (inclusive) |
| `bpm_max` | float | BPM upper bound (inclusive) |
| `energy_min` | float | Energy lower bound 0–1 |
| `energy_max` | float | Energy upper bound 0–1 |
| `valence_min` | float | Valence lower bound 0–1 |
| `valence_max` | float | Valence upper bound 0–1 |
| `arousal_min` | float | Arousal lower bound 0–1 |
| `arousal_max` | float | Arousal upper bound 0–1 |
| `order` | string | `timestamp_added`, `timestamp_modified`, `play_count`, `random`, `name` (default: `name`) |
| `dir` | string | `asc` or `desc` (default: `asc`) |
| `exclude` | string | Comma-separated MA track IDs to omit |

**Response:**
```json
{
  "total": 37219,
  "offset": 0,
  "limit": 100,
  "items": [ <Track> ]
}
```

---

### `GET /api/v1/tracks/:id`

Single track by MA item_id.

**Query parameters:** `include` (same as above)

---

### Track object

```json
{
  "id": 1234,
  "title": "Blue in Green",
  "artist": "Miles Davis",
  "artists": ["Miles Davis"],
  "album": "Kind of Blue",
  "year": 1959,
  "genre": "Jazz",
  "duration": 327.4,
  "file_path": "Jazz/Miles Davis/Kind of Blue/02 Blue in Green.flac",
  "favorite": false,           // schema verification needed: MA column name TBC
  "play_count": 12,            // schema verification needed: may be in metadata JSON
  "timestamp_added": 1700000000,
  "timestamp_modified": 1700001000,
  "cover_url": "/api/v1/tracks/1234/cover",

  "analysis": {
    "loudness_lufs": -14.2,
    "loudness_album_lufs": -13.8,
    "bpm": 52.3,
    "key": "F",
    "mode": "major",
    "camelot": "7B",
    "beats": [0.0, 1.15, 2.3],
    "valence": 0.28,
    "energy": 0.22,
    "danceability": 0.18,
    "arousal": 0.31,
    "acousticness": 0.91,
    "instrumentalness": 0.88,
    "brightness": 0.35,
    "rms_energy": [0.12, 0.14, 0.11],
    "mbid": "b0a99f5f-...",
    "isrc": "USPR37500002",
    "clap_embedding": [0.021, -0.003, ...]
  }
}
```

`analysis` is `null` when `?include=analysis` is not set.  
`clap_embedding` is `null` within `analysis` unless `?include=analysis,clap` is set — 1024 floats is ~7KB per track and should be opt-in.

**Camelot conversion** is computed by the bridge at query time using the same wheel logic as `sync-from-ma.ts` (moved here, canonical location).

---

### `GET /api/v1/tracks/:id/similar`

KNN similarity search using CLAP 1024-dim vectors via `sqlite-vec`.

**Query parameters:**

| Param | Type | Description |
|---|---|---|
| `limit` | int | Number of results (default 10, max 50) |
| `exclude` | string | Comma-separated IDs to omit (e.g. recently played) |
| `bpm_tolerance` | float | Constrain results to within ±N BPM of source |
| `energy_range` | string | `min,max` — constrain results by energy |

**Response:**
```json
{
  "source_id": 1234,
  "results": [
    { "id": 5678, "score": 0.953, "title": "Flamenco Sketches", "artist": "Miles Davis", "bpm": 50.1 },
    ...
  ]
}
```

`score` is cosine similarity (0–1, higher = more similar).

---

### `GET /api/v1/tracks/:id/cover`

Serves the track's cover art image directly from MA's thumbnail cache on disk (`MA_COVER_DIR`). Returns the image binary with appropriate `Content-Type`. Returns `404` if no thumbnail exists for this track.

**Implementation note:** MA's exact thumbnail naming convention (hash algorithm, path structure within `.storage/thumbnails/`) must be verified by inspecting the live data directory before implementing this route. The `MA_COVER_DIR` env var lets operators point to the right location if MA's internal layout changes between versions.

---

### `GET /api/v1/albums`

**Query parameters:** `offset`, `limit`, `since`, `order` (`timestamp_added`, `play_count`, `name`), `dir`, `artist_id`

**Response:** `{ total, offset, limit, items: [Album] }`

### Album object
```json
{
  "id": 42,
  "name": "Kind of Blue",
  "artist": "Miles Davis",
  "artist_id": 7,
  "year": 1959,
  "genre": "Jazz",
  "track_count": 5,
  "duration": 2786.0,
  "timestamp_added": 1700000000,
  "cover_url": "/api/v1/albums/42/cover"
}
```

### `GET /api/v1/albums/:id`
### `GET /api/v1/albums/:id/tracks`

Same query params as `/tracks`. Returns tracks belonging to this album.

### `GET /api/v1/albums/:id/cover`

---

### `GET /api/v1/artists`

**Query parameters:** `offset`, `limit`, `order` (`name`, `track_count`), `dir`

### Artist object
```json
{
  "id": 7,
  "name": "Miles Davis",
  "track_count": 147,
  "album_count": 23
}
```

### `GET /api/v1/artists/:id`
### `GET /api/v1/artists/:id/tracks`
### `GET /api/v1/artists/:id/albums`

---

### `GET /api/v1/playlists`

MA playlists visible to `filesystem_local` provider.

### Playlist object
```json
{
  "id": 3,
  "name": "Late Night",
  "track_count": 42,
  "timestamp_modified": 1700000000
}
```

### `GET /api/v1/playlists/:id`
### `GET /api/v1/playlists/:id/tracks`

---

### `GET /api/v1/search`

Full-text search across track title, artist name, album name.

**Query parameters:**

| Param | Type | Description |
|---|---|---|
| `q` | string | Search query (required) |
| `type` | string | Comma-separated: `track`, `artist`, `album` (default: all) |
| `limit` | int | Per-type result count (default 10) |
| `include` | string | `analysis`, `clap` — same as `/tracks` |

**Response:**
```json
{
  "tracks": [ <Track> ],
  "artists": [ <Artist> ],
  "albums": [ <Album> ]
}
```

---

## Project Structure

```
music-assistant-db-api/
├── Cargo.toml
├── Dockerfile
├── README.md
├── openapi.yaml              — generated, committed
├── src/
│   ├── main.rs               — startup, config from env, axum router assembly
│   ├── config.rs             — Config struct: MA_DB_PATH, MA_COVER_DIR, PORT, MA_BRIDGE_API_KEY
│   ├── db/
│   │   ├── mod.rs            — deadpool-sqlite pool init, WAL mode setup, sqlite-vec load
│   │   ├── queries.rs        — all SQL: track join, filters, similarity, search
│   │   └── models.rs         — Track, Album, Artist, Playlist — serde + utoipa derives
│   ├── routes/
│   │   ├── mod.rs            — router assembly, OpenAPI merge
│   │   ├── tracks.rs         — /tracks, /tracks/:id, /tracks/:id/similar
│   │   ├── cover.rs          — /tracks/:id/cover, /albums/:id/cover
│   │   ├── albums.rs
│   │   ├── artists.rs
│   │   ├── playlists.rs
│   │   └── search.rs
│   ├── auth.rs               — tower Layer: checks Authorization header if key set
│   ├── camelot.rs            — key + mode → Camelot notation (canonical location)
│   └── openapi.rs            — utoipa OpenAPI assembly, /api/openapi.json route
├── k8s/
│   └── sidecar-patch.yaml    — strategic merge patch for MA deployment
└── docker-compose.yml        — standalone compose for non-k8s deployments
```

---

## Environment Variables

| Var | Required | Default | Description |
|---|---|---|---|
| `MA_DB_PATH` | yes | — | Absolute path to MA's `library.db` |
| `MA_COVER_DIR` | no | `<MA_DB_PATH dir>/.storage/thumbnails` | MA thumbnail cache directory |
| `PORT` | no | `8097` | HTTP listen port |
| `MA_BRIDGE_API_KEY` | no | — | If set, require `Authorization: Bearer <key>` |
| `LOG_LEVEL` | no | `info` | `trace`, `debug`, `info`, `warn`, `error` |
| `DB_POOL_SIZE` | no | `4` | SQLite connection pool size |

---

## Deployment

### k8s — sidecar patch

Applied as a strategic merge patch over the existing MA deployment. Operators add to their GitOps repo alongside `deployment.yaml`:

```yaml
# k8s/sidecar-patch.yaml — strategic merge patch
spec:
  template:
    spec:
      containers:
        - name: ma-db-api
          image: ghcr.io/jonathanlew1s/music-assistant-db-api:latest
          env:
            - name: MA_DB_PATH
              value: /data/library.db
            - name: PORT
              value: "8097"
          ports:
            - name: api
              containerPort: 8097
          readinessProbe:
            httpGet:
              path: /api/v1/health
              port: api
            initialDelaySeconds: 5
            periodSeconds: 10
          volumeMounts:
            - name: data
              mountPath: /data
              readOnly: true
```

Add a service for the bridge port. In the talos repo this means adding a port to the existing `music-assistant-ui` service or creating `ma-db-api` as a separate service.

### docker-compose

```yaml
services:
  ma-db-api:
    image: ghcr.io/jonathanlew1s/music-assistant-db-api:latest
    environment:
      MA_DB_PATH: /data/library.db
      MA_BRIDGE_API_KEY: ${MA_BRIDGE_API_KEY:-}
    volumes:
      - ma-data:/data:ro
    ports:
      - "8097:8097"
    depends_on:
      - music-assistant

volumes:
  ma-data:
    external: true
    name: musicassistant_data    # match whatever MA names its volume
```

---

## Subwave Integration (Phased)

### Phase 1 — Bridge ships, subwave still uses sync+library-db

`sync-from-ma.ts` is rewritten to call `GET /api/v1/tracks?include=analysis,clap&since=<ts>&limit=500` instead of opening SQLite directly. Behaviour is identical; the bridge is the new data source. `MA_DB_PATH` on the controller is replaced by `MA_BRIDGE_URL`.

This phase proves the bridge works end-to-end. library-db still exists.

### Phase 2 — Runtime picker queries bridge directly

`music/backend/ma.ts` calls the bridge at runtime:
- `GET /tracks?energy_min=...&bpm_min=...&exclude=...&order=random&limit=20` replaces pool queries against library-db
- `GET /tracks/:id/similar?limit=10&exclude=...` replaces sqlite-vec KNN in library-db
- `GET /playlists/:id/tracks` replaces Subsonic playlist calls

Mood derivation: `valence + arousal + energy` bucketed at query time by the picker — no stored mood tags, no `npm run tag` LLM pass.

library-db is reduced to: play history, DJ session state. No CLAP vectors, no track mirror.

### Phase 3 — library-db eliminated

If Phase 2 benchmarks well (expected ~10–30ms per picker call vs sub-ms local), library-db is removed. Play history moves to `state/recent-plays.json` (already exists). Session state stays in `state/session.json`. The controller has zero local music state.

---

## Performance Notes

- SQLite WAL mode: concurrent readers don't block MA's writer. Bridge opens with `PRAGMA query_only=ON` as defence-in-depth.
- CLAP KNN via sqlite-vec: 37k × 1024-dim cosine search is ~2–5ms on modern hardware. Acceptable for picker use.
- Connection pool (4 connections default): handles concurrent requests without serialising on a single connection.
- `clap_embedding` opt-in: excluded from default responses to avoid 7KB-per-track overhead on large list calls.
- `rms_energy` (float array, ~200 values per track) included in `?include=analysis` but not in default responses.
- Bulk sync (`?limit=1000&include=analysis`): ~7KB × 1000 = 7MB per page without CLAP; ~14MB with. Within HTTP response norms for sync workloads.

---

## OpenAPI

The spec is generated at build time via `utoipa` and committed to `openapi.yaml`. Also served live at `GET /api/openapi.json`. Swagger UI optionally served at `GET /api/docs` (feature flag, off by default to keep image small).

---

## Out of Scope

- Write operations (mood tags, play counts, favorites) — bridge is read-only
- MA WebSocket event streaming — the bridge polls on demand, no push
- Semantic text-to-music search (text embedding → CLAP query) — future addition if an embedding model is available
- Multi-MA-instance support — one bridge per MA instance
