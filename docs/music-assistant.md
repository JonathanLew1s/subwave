# Music Assistant backend

SUB/WAVE supports two library backends: **Navidrome** (default, upstream-tracked) and **MA DB API** (Music Assistant, fork addition). Both can coexist in your deployment — the active backend is a runtime switch.

## How the switch works

The backend is controlled by a single setting: `LIBRARY_BACKEND` (`navidrome` | `ma-api`, default `navidrome`).

**Precedence — env vars always win:**

```
LIBRARY_BACKEND in .env / manifest env
    ↓  if set, locks the UI to read-only
controller reads it at boot — immutable at runtime

    ↓  if NOT set
settings.json (managed by admin Settings UI)
    ↓  set via Settings → Library backend
```

The admin Settings panel shows a **Locked by env** notice when `LIBRARY_BACKEND` is set in the environment. The selector is disabled; only the MA DB API URL, key, and music root path can still be saved. Remove the env var and restart the controller to hand control back to the UI.

---

## Prerequisites

1. **Music Assistant** running with the `filesystem_local` provider indexing your music library.
2. **music-assistant-db-api** sidecar running alongside MA. It reads MA's SQLite database (read-only) and exposes a REST API that the controller queries for track discovery, similarity, and metadata.
3. **Shared music volume**: both the controller and the broadcast (Liquidsoap) container must have the music library mounted at the same path inside their containers. The controller constructs `file:///music/...` URIs; Liquidsoap must resolve them.

---

## Docker Compose setup

### 1. Mount the music library

In your root `.env`, add:

```env
MUSIC_DIR=/absolute/path/to/your/music/library
```

Then in your compose file (`docker-compose.yml` or `docker-compose.byo.yml`), uncomment the music volume lines in **both** the `broadcast` and `controller` services:

```yaml
# broadcast:
volumes:
  - ${MUSIC_DIR}:/music:ro   # ← uncomment

# controller:
volumes:
  - ${MUSIC_DIR}:/music:ro   # ← uncomment
```

Both mounts must use the same container path (`/music`).

### 2. Point at the MA DB API sidecar

Add to your root `.env`:

```env
MA_DB_API_URL=http://your-music-assistant-host:8096
```

This is picked up automatically by the controller via `env_file`. You can also set it in the admin Settings UI instead — whichever is more convenient. If both are set, the env var wins.

### 3. Switch the backend

**Option A — via the Settings UI (recommended):**

1. Go to **Admin → Settings → Library backend**
2. Select **MA DB API**
3. Fill in the MA DB API URL and Music library root path (`/music`)
4. Save, then restart the controller:
   ```bash
   docker compose restart controller
   ```

**Option B — via `.env` (locks the UI):**

```env
LIBRARY_BACKEND=ma-api
MA_MUSIC_ROOT=/music
```

Restart after changing:

```bash
docker compose up -d controller
```

---

## Kubernetes / k8s setup

### Storage

The cluster needs a PersistentVolume and PVC for the music NFS export. Both are defined in `subwave/storage.yaml`:

```yaml
# PersistentVolume — NFS export of your music library (ReadOnlyMany)
# PersistentVolumeClaim — bound to the PV, used by controller + broadcast
```

Update the NFS server address and path in `storage.yaml` to match your NAS/NFS server, then apply:

```bash
kubectl apply -f kubernetes/apps/subwave/storage.yaml
```

### Deployments

Both `controller-deployment.yaml` and `broadcast-deployment.yaml` already include the `/music` volume mount referencing the `subwave-music` PVC. No extra steps — the mounts are active once the PVC is bound.

### Switching the backend

Use the Settings UI after the pods are running:

1. Go to **Admin → Settings → Library backend**
2. Select **MA DB API** — the MA DB API URL is pre-filled from the `MA_DB_API_URL` env var in the manifest
3. Set **Music library root path** to `/music`
4. Save
5. Restart the controller pod:
   ```bash
   kubectl rollout restart deployment/subwave-controller -n subwave
   ```

> **Do not** add `LIBRARY_BACKEND` to the controller deployment manifest unless you want to lock the UI. The `MA_DB_API_URL` env var is intentionally set in the manifest (it's a cluster networking constant); `LIBRARY_BACKEND` and `MA_MUSIC_ROOT` are not (they're operator preferences managed via the UI).

---

## Switching back to Navidrome

**Via UI:** Settings → Library backend → select Navidrome → Save → restart controller.

**Via env (if you locked it):** Remove `LIBRARY_BACKEND` from `.env` or manifest → restart controller → then use the UI, or add `LIBRARY_BACKEND=navidrome` to env.

Navidrome integration is unaffected by running the MA backend — `NAVIDROME_URL` stays in the manifest/env for whenever you switch back.

---

## What the MA backend does differently

| | Navidrome | MA DB API |
|---|---|---|
| Track discovery | Subsonic API | music-assistant-db-api REST |
| Stream URI | `subhttp://navidrome/...` | `file:///music/...` |
| Cover art | Navidrome proxy | MA DB API proxy |
| Similar songs | Navidrome API | MA similarity endpoint |
| Requires NFS mount | No | Yes (both controller + broadcast) |
| Requires Navidrome | Yes | No |

The DJ agent, pool picker, mood tagger, request handling, and all LLM/TTS logic are identical regardless of which backend is active.
