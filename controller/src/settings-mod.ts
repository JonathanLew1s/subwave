// Fork-specific settings extensions. Schema fields, validators, and getters
// here are wired into settings.ts via one-line dispatch points, so upstream
// changes to settings.ts's own fields never collide with ours.
//
// Scope: only the wholly fork-added `picker` and `library` settings blocks,
// which are self-contained — they don't share a validator/getter with any
// upstream field. Fork edits threaded INTO upstream functions that handle
// many fields at once (show moods/vibe/excludePatterns/exemplarTrackIds in
// normalizeShows/validateShowsStrict/resolveActiveShow) stay inline in
// settings.ts — splitting those out would mean passing most of the
// surrounding function's state across the module boundary for no real
// isolation benefit. See the Task 7 commit message for the full reasoning.

// ---------------------------------------------------------------------------
// DEFAULTS
// ---------------------------------------------------------------------------

// Track picker constraints. These are editorial decisions, not technical
// ones — hardcoding them prevents valid programming choices like a live-sets
// show or a film-scores hour. The defaults reflect sensible radio behaviour
// but the operator can clear or replace them per-station and per-show.
//
// maxDurationSec: hard cap on track length before the LLM sees a candidate.
// excludePatterns: case-insensitive word/phrase patterns matched against
//   track title and album name. Any match removes the candidate from the
//   pool. Word-boundary matching applied on word-char edges (so "live" won't
//   match "alive", but "(live)" will match literally).
export const PICKER_DEFAULTS = {
  maxDurationSec: 600,
  // minDurationSec: floor on track length — catches non-music bonus tracks
  // (spoken liner-note commentary, interview snippets) that score a
  // plausible energy/valence value despite being pure speech. Confirmed live:
  // a 19s "Commentary: Greg Tate" clip from a deluxe reissue slipped into an
  // overnight show's rotation this way, with no floor to catch it.
  minDurationSec: 60,
  excludePatterns: [
    'live at', 'live from', 'live in', '(live)',
    'acoustic version', 'demo version', 'rehearsal', 'bootleg', 'unplugged',
    'soundtrack', 'original score', 'original motion picture', 'motion picture', 'ost',
    'from the film', 'from the movie', 'from the series', 'from the show',
    'commentary', 'interview', 'audio commentary', 'liner notes', 'spoken word',
    'dialogue', 'narration', 'q&a', 'q & a',
  ],
  // MA-mode composite shortlist (see music/ma-candidate-pool.ts). For a show
  // with a usable exemplar profile (>= themeCentroid.minExemplars exemplars
  // with real genre/CLAP data), this shortlist now drives the live pick AND
  // auto.m3u directly — see broadcast/dj-agent-mod.ts's buildBriefPoolForShow
  // and broadcast/scheduler.ts's refreshAutoPlaylistInner. shadowEnabled /
  // autoPlaylistShadowEnabled below are a separate, lower-cost comparison
  // tool for shows that DON'T have exemplars yet — they log what the
  // shortlist would have produced without it driving anything, so an
  // operator can see what adding exemplars would change before doing it.
  maShortlist: {
    shadowEnabled: false,
    // autoPlaylistShadowEnabled gates a SEPARATE shadow comparison for the
    // auto.m3u fallback path (scheduler.ts) — independent from
    // shadowEnabled above, which only covers the live agent-pick path.
    autoPlaylistShadowEnabled: false,
    targetSize: 12,
    themeSlots: 5,
    flowSlots: 4,
    discoverySlots: 2,
    oldieSlots: 1,
    eraWindowYears: 25,
    // Exemplar-profile gate config (music/theme-centroid.ts). Only takes
    // effect for shows with >= minExemplars usable exemplar tracks —
    // otherwise theme fit stays the existing flat energy-band behaviour.
    themeCentroid: {
      minExemplars: 2,
    },
  },
};

// Library backend: which system supplies track discovery + streaming URIs.
// 'navidrome' (default): Subsonic/OpenSubsonic API — the upstream-tracked path.
// 'ma-api': music-assistant-db-api REST sidecar (MA_DB_API_URL).
// Env vars (LIBRARY_BACKEND / MA_DB_API_URL / MA_DB_API_KEY / MA_MUSIC_ROOT) override these when set.
export const LIBRARY_DEFAULTS = {
  backend: 'navidrome' as 'navidrome' | 'ma-api',
  maDbApi: {
    // music-assistant-db-api URL. '' = use MA_DB_API_URL env var.
    url: '',
    // Optional API key matching the sidecar's MA_API_KEY. '' = no auth.
    apiKey: '',
    // Absolute path to the music library root inside the controller container.
    // Must match the volume mount so file:// URIs reach Liquidsoap.
    // '' = use MA_MUSIC_ROOT env var.
    musicRoot: '',
  },
};

// ---------------------------------------------------------------------------
// load() resolution — called from within settings.ts's `cache = {...}` object
// literal. Lenient: drops/clamps invalid stored values rather than failing
// the whole boot, matching every other field's normalization style in load().
// ---------------------------------------------------------------------------

export function loadPicker(stored: any) {
  return {
    maxDurationSec: (() => {
      const v = stored.picker?.maxDurationSec;
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
        return PICKER_DEFAULTS.maxDurationSec;
      }
      return Math.max(60, Math.min(3600, Math.floor(v)));
    })(),
    minDurationSec: (() => {
      const v = stored.picker?.minDurationSec;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        return PICKER_DEFAULTS.minDurationSec;
      }
      return Math.max(0, Math.min(300, Math.floor(v)));
    })(),
    excludePatterns: Array.isArray(stored.picker?.excludePatterns)
      ? stored.picker.excludePatterns
          .filter((p: any) => typeof p === 'string' && p.trim().length > 0)
          .map((p: any) => (p as string).trim().slice(0, 100))
          .slice(0, 50)
      : [...PICKER_DEFAULTS.excludePatterns],
    maShortlist: {
      shadowEnabled: typeof stored.picker?.maShortlist?.shadowEnabled === 'boolean'
        ? stored.picker.maShortlist.shadowEnabled
        : PICKER_DEFAULTS.maShortlist.shadowEnabled,
      autoPlaylistShadowEnabled: typeof stored.picker?.maShortlist?.autoPlaylistShadowEnabled === 'boolean'
        ? stored.picker.maShortlist.autoPlaylistShadowEnabled
        : PICKER_DEFAULTS.maShortlist.autoPlaylistShadowEnabled,
      targetSize: (() => {
        const v = stored.picker?.maShortlist?.targetSize;
        return typeof v === 'number' && Number.isFinite(v) && v >= 4 && v <= 30
          ? Math.floor(v) : PICKER_DEFAULTS.maShortlist.targetSize;
      })(),
      themeSlots: (() => {
        const v = stored.picker?.maShortlist?.themeSlots;
        return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : PICKER_DEFAULTS.maShortlist.themeSlots;
      })(),
      flowSlots: (() => {
        const v = stored.picker?.maShortlist?.flowSlots;
        return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : PICKER_DEFAULTS.maShortlist.flowSlots;
      })(),
      discoverySlots: (() => {
        const v = stored.picker?.maShortlist?.discoverySlots;
        return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : PICKER_DEFAULTS.maShortlist.discoverySlots;
      })(),
      oldieSlots: (() => {
        const v = stored.picker?.maShortlist?.oldieSlots;
        return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : PICKER_DEFAULTS.maShortlist.oldieSlots;
      })(),
      eraWindowYears: (() => {
        const v = stored.picker?.maShortlist?.eraWindowYears;
        return typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 100
          ? Math.floor(v) : PICKER_DEFAULTS.maShortlist.eraWindowYears;
      })(),
      themeCentroid: {
        minExemplars: (() => {
          const v = stored.picker?.maShortlist?.themeCentroid?.minExemplars;
          return typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 8
            ? Math.floor(v) : PICKER_DEFAULTS.maShortlist.themeCentroid.minExemplars;
        })(),
      },
    },
  };
}

export function loadLibrary(stored: any) {
  return {
    backend: (['navidrome', 'ma-api'] as const).includes(stored.library?.backend)
      ? stored.library.backend
      : LIBRARY_DEFAULTS.backend,
    maDbApi: {
      url: typeof stored.library?.maDbApi?.url === 'string'
        ? stored.library.maDbApi.url.trim()
        : LIBRARY_DEFAULTS.maDbApi.url,
      apiKey: typeof stored.library?.maDbApi?.apiKey === 'string'
        ? stored.library.maDbApi.apiKey.trim()
        : LIBRARY_DEFAULTS.maDbApi.apiKey,
      musicRoot: typeof stored.library?.maDbApi?.musicRoot === 'string'
        ? stored.library.maDbApi.musicRoot.trim()
        : LIBRARY_DEFAULTS.maDbApi.musicRoot,
    },
  };
}

// ---------------------------------------------------------------------------
// update() patch handlers — called from within settings.ts's update(), which
// mutates `next` (a deep clone of the loaded settings, already shaped by
// loadPicker/loadLibrary above) in place per top-level patch key.
// ---------------------------------------------------------------------------

export function applyPickerPatch(next: any, patch: any) {
  if (!('picker' in patch)) return;
  const p = patch.picker || {};
  if (!next.picker) next.picker = { ...PICKER_DEFAULTS, excludePatterns: [...PICKER_DEFAULTS.excludePatterns] };
  if (p.maxDurationSec !== undefined) {
    const v = parseInt(p.maxDurationSec, 10);
    if (!Number.isFinite(v) || v < 60 || v > 3600) {
      throw new Error('picker.maxDurationSec must be an integer between 60 and 3600');
    }
    next.picker.maxDurationSec = v;
  }
  if (p.minDurationSec !== undefined) {
    const v = parseInt(p.minDurationSec, 10);
    if (!Number.isFinite(v) || v < 0 || v > 300) {
      throw new Error('picker.minDurationSec must be an integer between 0 and 300');
    }
    next.picker.minDurationSec = v;
  }
  if (p.excludePatterns !== undefined) {
    if (!Array.isArray(p.excludePatterns)) {
      throw new Error('picker.excludePatterns must be an array of strings');
    }
    if (p.excludePatterns.length > 50) {
      throw new Error('picker.excludePatterns must be at most 50 entries');
    }
    next.picker.excludePatterns = p.excludePatterns.map((item: any, i: number) => {
      const v = String(item ?? '').trim();
      if (v.length === 0 || v.length > 100) {
        throw new Error(`picker.excludePatterns[${i}] must be 1-100 chars`);
      }
      return v;
    });
  }
}

export function applyLibraryPatch(next: any, patch: any) {
  if (!('library' in patch)) return;
  const lib = patch.library || {};
  if (lib.backend !== undefined) {
    if (!['navidrome', 'ma-api'].includes(lib.backend)) {
      throw new Error('library.backend must be "navidrome" or "ma-api"');
    }
    next.library.backend = lib.backend;
  }
  if (lib.maDbApi !== undefined) {
    const ma = lib.maDbApi || {};
    if (ma.url !== undefined) {
      next.library.maDbApi.url = String(ma.url).trim().slice(0, 500);
    }
    if (ma.apiKey !== undefined) {
      next.library.maDbApi.apiKey = String(ma.apiKey).trim().slice(0, 500);
    }
    if (ma.musicRoot !== undefined) {
      next.library.maDbApi.musicRoot = String(ma.musicRoot).trim().slice(0, 500);
    }
  }
}

// ---------------------------------------------------------------------------
// getPickerConfig — wholly fork-added exported getter, no upstream sibling.
// ---------------------------------------------------------------------------

// Effective picker config for the current show (or station-wide when no show
// is active, or when the show has no override). Call at pick time — reads from
// the in-memory cache so no await needed.
//
// show.excludePatterns is the resolved value from resolveActiveShow():
//   null   → show has no override; use station-wide list
//   []     → show explicitly has no excludes (e.g. a live-sets show)
//   [...]  → show-specific list that REPLACES station-wide
export function resolvePickerConfig(
  s: any,
  show?: { excludePatterns?: string[] | null } | null,
): { maxDurationSec: number; minDurationSec: number; excludePatterns: string[] } {
  const stationWide = s.picker ?? PICKER_DEFAULTS;
  const patterns =
    show?.excludePatterns !== null && show?.excludePatterns !== undefined
      ? show.excludePatterns       // show overrides (incl. [] to clear all)
      : stationWide.excludePatterns ?? [...PICKER_DEFAULTS.excludePatterns];
  return {
    maxDurationSec: stationWide.maxDurationSec ?? PICKER_DEFAULTS.maxDurationSec,
    minDurationSec: stationWide.minDurationSec ?? PICKER_DEFAULTS.minDurationSec,
    excludePatterns: patterns,
  };
}
