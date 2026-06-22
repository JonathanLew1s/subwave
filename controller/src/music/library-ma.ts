// MA DB API implementation of the library.ts async interface.
// Called by library.ts when config.libraryBackend === 'ma-api'.
// All data comes from the music-assistant-db-api sidecar over HTTP — no local SQLite.

import { apiGet, toSong, resolveGenreRow, tracksByGenreId } from './ma-db-api.js';
import type { FilterOpts, FilteredRow } from './library.js';

// ---------------------------------------------------------------------------
// In-memory cache — refreshed on load(). Tracks are never cached in full;
// only aggregate stats and genre list are kept to answer stats() synchronously.
// ---------------------------------------------------------------------------
let _stats = {
  total: 0,
  distinctArtists: 0,
  byGenre: {} as Record<string, number>,
  updatedAt: null as string | null,
};

// ---------------------------------------------------------------------------
// Mood matching strategy — three different kinds of mood, three different
// data sources. Verified live against the actual sidecar before picking any
// of this (see docs/superpowers/specs — analysis coverage, real percentile
// distributions, real genre taxonomy contents):
//
// 1. SONIC_MOODS — affect/energy concepts genuinely representable by audio
//    features. Energy bands as before, PLUS valence (positive/negative
//    affect) where it's the actual distinguishing axis — e.g. calm/
//    reflective/rainy previously had near-identical energy bands and were
//    barely distinguishable; valence is what actually separates "peaceful",
//    "introspective", and "melancholic". Bands anchored to the real
//    distribution from a 1000-track random sample (valence p25=0.11,
//    p50=0.235, p75=0.41; energy p25=0.11, p50=0.15, p75=0.21 — consistent
//    with the energy calibration already in place). Valence coverage is
//    ~64% vs ~99% for energy, so these bands lean wide rather than tight —
//    see MOOD_NEIGHBOURS_MA below for the thin-result safety net.
// 2. GENRE_MOODS (cultural, spiritual) — not affect concepts at all; matched
//    against the real /genres taxonomy (name + alias rollups) instead of any
//    audio feature. cultural's genre list has real tracks today (reggae 145,
//    gospel-adjacent etc.); spiritual's pool is thin (gospel=57, the only
//    non-empty spiritual-adjacent genre) but real.
// 3. festival/cooking/morning/evening are NOT in either map below:
//    - festival/cooking: verified live there is no genre AND no clean
//      affect/energy signature for these — they're activity/context labels
//      with zero representable signal in this API. Left exactly as the
//      original energy-only guess (see FESTIVAL_COOKING_ENERGY) rather than
//      pretending a fix exists.
//    - morning/evening: context.js already derives these from time-of-day,
//      not track content — songsByMood returns [] for them rather than
//      faking a per-track signal (see songsByMood below).
// ---------------------------------------------------------------------------

type Band = [number | null, number | null];

const SONIC_MOODS: Record<string, { energy: Band; valence?: Band }> = {
  energetic:   { energy: [0.28, null] },
  workout:     { energy: [0.28, null] },
  driving:     { energy: [0.24, null] },
  celebratory: { energy: [0.26, null], valence: [0.30, null] },
  sunny:       { energy: [0.20, null], valence: [0.25, null] },
  romantic:    { energy: [null, 0.22], valence: [0.20, null] },
  calm:        { energy: [null, 0.17], valence: [0.15, 0.40] },
  focus:       { energy: [0.11, 0.24] },
  reflective:  { energy: [null, 0.20], valence: [null, 0.25] },
  rainy:       { energy: [null, 0.17], valence: [null, 0.15] },
  night:       { energy: [null, 0.20] },
};

// festival/cooking — no genre, no clean affect signal (verified live).
// Unchanged from the original flat guess; not part of the valence rework.
const FESTIVAL_COOKING_ENERGY: Record<string, Band> = {
  festival: [0.26, null],
  cooking:  [0.13, 0.26],
};

// cultural/spiritual — genre-taxonomy matches, verified against the real
// /genres list + track counts (not invented): reggae/brazilian-music/cumbia/
// flamenco/JùJú have real tracks; world-ethnic/afrobeats/middle-eastern/
// indian-classical/raï/gnawa/klezmer exist in the taxonomy but are
// currently empty (kept for when the library grows — matching costs nothing
// extra, they just contribute 0 tracks today). spiritual's only non-empty
// genre today is gospel.
const GENRE_MOODS: Record<string, string[]> = {
  cultural: [
    'Reggae', 'Brazilian Music', 'Cumbia', 'Flamenco', 'JùJú',
    'World/Ethnic', 'Afrobeats (West African urban/pop music)',
    'Middle Eastern Music', 'Indian Classical', 'Raï', 'Gnawa', 'Klezmer',
  ],
  spiritual: ['Gospel', 'Church Music', 'Religion/Spirituality'],
};

// Moods with no per-track signal in MA mode — context.js already derives
// these from time-of-day, not track content (see comment block above).
const NO_TRACK_FILTER_MOODS = new Set(['morning', 'evening']);

// Adjacent-mood widening, ported from library.ts's MOOD_NEIGHBOURS (the
// Navidrome-mode mechanism) — MA mode never had this, so a tight energy+
// valence box could starve a sparsely-analysed mood with zero fallback.
// Only sonic moods need it (genre moods' real gap, if any, is a genre
// problem, not solvable by widening to an unrelated mood).
const MOOD_NEIGHBOURS_MA: Record<string, string[]> = {
  driving:     ['energetic', 'focus'],
  focus:       ['calm', 'reflective'],
  energetic:   ['workout', 'celebratory'],
  reflective:  ['calm', 'night'],
  celebratory: ['energetic'],
  romantic:    ['calm', 'reflective'],
  sunny:       ['energetic', 'calm'],
  rainy:       ['calm', 'reflective'],
  night:       ['reflective', 'calm'],
};
const MOOD_MIN_EXACT_MA = 12;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function toLibraryTrack(t: any): any {
  const s = toSong(t);
  return {
    id: s.id,
    title: s.title,
    artist: s.artist,
    album: s.album,
    year: s.year,
    genre: s.genre,
    path: s.path,         // relative file path — required by getAnnotatedUri for file:// URIs
    moods: [],            // MA has no LLM mood tags
    energy: t.analysis?.energy != null ? energyLabel(t.analysis.energy) : null,
    // popularitySong/popularityAlbum: the Navidrome/Subsonic play-count fields — a different concept from MA's own metadata.popularity surfaced below.
    popularitySong: null,
    popularityAlbum: null,
    bpm: s.bpm,
    musicalKey: s.musicalKey,
    loudnessLufs: s.loudnessLufs,
    favorite: s.favorite ?? false,
    paceMean: null,       // pace curves not in the sidecar response
    _energyRaw: t.analysis?.energy ?? null,
    // Richer sonic-analysis axes — null-safe, only present once MA's analysis pass has reached a given track (~20% CLAP/BPM/sonic coverage today).
    valence: t.analysis?.valence ?? null,
    arousal: t.analysis?.arousal ?? null,
    danceability: t.analysis?.danceability ?? null,
    acousticness: t.analysis?.acousticness ?? null,
    instrumentalness: t.analysis?.instrumentalness ?? null,
    brightness: t.analysis?.brightness ?? null,
    speechiness: t.analysis?.speechiness ?? null,
    roughness: t.analysis?.roughness ?? null,
    popularity: t.popularity ?? null,
  };
}

function toFilteredRow(t: any): FilteredRow {
  const lt = toLibraryTrack(t);
  return {
    id: lt.id,
    title: lt.title,
    artist: lt.artist,
    album: lt.album,
    year: lt.year,
    genre: lt.genre,
    duration: t.duration ?? null,
    moods: [],
    energy: lt.energy,
    source: 'ma-api',
    taggedAt: null,
    bpm: lt.bpm,
    musicalKey: lt.musicalKey,
    loudnessLufs: lt.loudnessLufs,
    paceMean: null,
    instrumental: null,
    valence: lt.valence,
    arousal: lt.arousal,
    danceability: lt.danceability,
    acousticness: lt.acousticness,
    instrumentalness: lt.instrumentalness,
    popularity: lt.popularity,
  };
}

function energyLabel(e: number): string {
  if (e >= 0.22) return 'high';
  if (e >= 0.11) return 'medium';
  return 'low';
}

// ---------------------------------------------------------------------------
// Interface implementation
// ---------------------------------------------------------------------------

export async function load(): Promise<void> {
  try {
    const [h, a, g] = await Promise.all([
      apiGet('/health/detailed'),
      apiGet('/artists', { limit: 1 }),
      // health/detailed has never carried a genre breakdown (only track_count
      // + analysis_coverage) — byGenre was silently always {} before the real
      // /genres taxonomy endpoint existed to source it from.
      apiGet('/genres', { limit: 1000 }).catch(() => ({ items: [] })),
    ]);
    // health/detailed returns { track_count, analysis_coverage: { bpm, clap, sonic, loudness } }
    // /artists?limit=1 returns { total } — the full artist count for recency-window scaling.
    _stats = {
      total: h.track_count ?? h.total_tracks ?? h.total ?? 0,
      distinctArtists: h.total_artists ?? a.total ?? 0,
      byGenre: Object.fromEntries((g.items ?? []).map((x: any) => [x.name, x.track_count ?? 0])),
      updatedAt: new Date().toISOString(),
    };
  } catch {
    // Not fatal — controller boots fine; stats return zero until next load().
  }
}

export function stats() {
  // byMood: every mood key MA mode can serve via SOME path — sonic
  // energy(+valence) bands, the festival/cooking legacy energy guess, or
  // genre-taxonomy matching. morning/evening are deliberately excluded —
  // they have no per-track filter in MA mode (see NO_TRACK_FILTER_MOODS).
  const byMood = Object.fromEntries(
    [...Object.keys(SONIC_MOODS), ...Object.keys(FESTIVAL_COOKING_ENERGY), ...Object.keys(GENRE_MOODS)]
      .map(k => [k, 1]),
  );
  return {
    total: _stats.total,
    distinctArtists: _stats.distinctArtists,
    byMood,
    byEnergy: {},
    byGenre: _stats.byGenre,
    bySource: { 'ma-api': _stats.total },
    withEmbedding: 0,
    withAudioEmbedding: _stats.total,  // CLAP coverage approximated as 100%
    updatedAt: _stats.updatedAt,
  };
}

// Energy(+valence) band query against /tracks, random order, capped at 200 —
// same shape the original energy-only version used.
async function tracksByBand(energy: Band, valence?: Band): Promise<any[]> {
  const [energyMin, energyMax] = energy;
  if (energyMin == null && energyMax == null && !valence) return [];
  try {
    const params: Record<string, any> = { order: 'random', limit: 200, include: 'analysis' };
    if (energyMin != null) params.energy_min = energyMin;
    if (energyMax != null) params.energy_max = energyMax;
    if (valence) {
      const [valenceMin, valenceMax] = valence;
      if (valenceMin != null) params.valence_min = valenceMin;
      if (valenceMax != null) params.valence_max = valenceMax;
    }
    const data = await apiGet<{ total: number; items: any[] }>('/tracks', params);
    return (data.items ?? []).map(toLibraryTrack);
  } catch {
    return [];
  }
}

// Genre-taxonomy match for cultural/spiritual — union of each mood's real
// genre list via the /genres/:id/tracks join (resolveGenreRow + tracksByGenreId,
// same path getSongsByGenre uses). Genres that don't resolve (e.g. not yet
// used in this library) or error out simply contribute nothing.
async function tracksByGenreList(genreNames: string[]): Promise<any[]> {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const name of genreNames) {
    const hit = await resolveGenreRow(name);
    if (!hit) continue;
    for (const t of await tracksByGenreId(hit.id, 200)) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(toLibraryTrack(t));
    }
  }
  return out;
}

export async function songsByMood(mood: string | null | undefined): Promise<any[]> {
  if (!mood) return [];
  if (NO_TRACK_FILTER_MOODS.has(mood)) return [];

  if (GENRE_MOODS[mood]) return tracksByGenreList(GENRE_MOODS[mood]);

  const festivalCooking = FESTIVAL_COOKING_ENERGY[mood];
  if (festivalCooking) return tracksByBand(festivalCooking);

  const sonic = SONIC_MOODS[mood];
  if (!sonic) return [];

  const exact = await tracksByBand(sonic.energy, sonic.valence);
  if (exact.length >= MOOD_MIN_EXACT_MA) return exact;

  const seen = new Set(exact.map((t) => t.id));
  const widened = [...exact];
  for (const neighbour of MOOD_NEIGHBOURS_MA[mood] || []) {
    const nSonic = SONIC_MOODS[neighbour];
    if (!nSonic) continue;
    for (const t of await tracksByBand(nSonic.energy, nSonic.valence)) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      widened.push(t);
    }
  }
  return widened;
}

export async function songsByMoods(moods: string[] | null | undefined): Promise<any[]> {
  if (!moods?.length) return [];
  const seen = new Set<string>();
  const out: any[] = [];
  for (const mood of moods) {
    for (const t of await songsByMood(mood)) {
      if (!seen.has(t.id)) { out.push(t); seen.add(t.id); }
    }
  }
  return out;
}

export async function songsByEnergy(energy: string | null | undefined): Promise<any[]> {
  if (!energy) return [];
  const params: Record<string, any> = { order: 'random', limit: 200, include: 'analysis' };
  if (energy === 'low') params.energy_max = 0.11;
  else if (energy === 'medium') { params.energy_min = 0.11; params.energy_max = 0.22; }
  else if (energy === 'high') params.energy_min = 0.22;
  else return [];
  try {
    const data = await apiGet<{ total: number; items: any[] }>('/tracks', params);
    return (data.items ?? []).map(toLibraryTrack);
  } catch {
    return [];
  }
}

export async function tracksLikeThis(id: string, k: number): Promise<any[]> {
  // In MA mode, CLAP-based audio similarity is the best we have.
  if (!id) return [];
  try {
    const data = await apiGet<{ results: Array<{ id: number; score: number }> }>(
      `/tracks/${id}/similar`,
      { limit: k },
    );
    // include: 'analysis' is required here — without it bpm/musicalKey/the
    // sonic axes all come back null regardless of real analysis coverage,
    // silently zeroing flowFit's bpm/key-compat terms (discovered via live
    // validation; this fetch shipped without it originally).
    const results = data.results ?? [];
    const tracks = await Promise.all(
      results.slice(0, k).map(async (r) => {
        try {
          const t = await apiGet(`/tracks/${r.id}`, { include: 'analysis' });
          return { ...toLibraryTrack(t), _similarity: r.score };
        } catch { return null; }
      }),
    );
    return tracks.filter(Boolean);
  } catch {
    return [];
  }
}

// Audio and text similarity both use CLAP in MA mode.
export const tracksLikeThisAudio = tracksLikeThis;

// Fetches one track's raw sonic-analysis axes by id, for centroid
// computation (see music/theme-centroid.ts). Returns null on any failure or
// when the track has no analysis at all — callers must treat that as "this
// exemplar doesn't count", never as an error.
export async function getAnalysisAxes(id: string): Promise<Record<string, number | null> | null> {
  if (!id) return null;
  try {
    const t = await apiGet<any>(`/tracks/${id}`, { include: 'analysis' });
    if (!t?.analysis) return null;
    return {
      valence: typeof t.analysis.valence === 'number' ? t.analysis.valence : null,
      arousal: typeof t.analysis.arousal === 'number' ? t.analysis.arousal : null,
      danceability: typeof t.analysis.danceability === 'number' ? t.analysis.danceability : null,
      acousticness: typeof t.analysis.acousticness === 'number' ? t.analysis.acousticness : null,
      instrumentalness: typeof t.analysis.instrumentalness === 'number' ? t.analysis.instrumentalness : null,
      brightness: typeof t.analysis.brightness === 'number' ? t.analysis.brightness : null,
    };
  } catch {
    return null;
  }
}

// Light-weight per-track metadata for the player's now-playing metadata strip
// (genre · BPM · key · mood/energy) — a single sidecar call, not the heavy
// dossier shape observatoryTrackMa builds (no mixNext/embeddings here, this
// runs on every track change, not on an admin click). MA mode has no mood-tag
// index, so `moods` is always []; the player only ever needed energy + the
// acoustic strip in practice. Returns null on any failure or missing analysis
// — the caller (routes/public.ts) already treats null as "omit these fields",
// same as a not-yet-tagged Navidrome track.
export async function getNowPlayingMeta(id: string): Promise<{
  genre: string | null;
  bpm: number | null;
  musicalKey: string | null;
  energy: string | null;
  moods: string[];
  year: number | null;
} | null> {
  if (!id) return null;
  try {
    const t = await apiGet<any>(`/tracks/${id}`, { include: 'analysis' });
    if (!t) return null;
    return {
      genre: t.genres?.[0] ?? null,
      bpm: t.analysis?.bpm != null ? Math.round(t.analysis.bpm * 10) / 10 : null,
      musicalKey: t.analysis?.camelot ?? t.analysis?.key ?? null,
      energy: t.analysis?.energy != null ? energyLabel(t.analysis.energy) : null,
      moods: [],
      year: t.year ?? null,
    };
  } catch {
    return null;
  }
}

export async function filter(opts: FilterOpts = {}): Promise<{ total: number; rows: FilteredRow[] }> {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const params: Record<string, any> = { limit: Math.min(limit * 8, 500), offset: 0 };

  if (opts.energy === 'low') params.energy_max = 0.11;
  else if (opts.energy === 'medium') { params.energy_min = 0.11; params.energy_max = 0.22; }
  else if (opts.energy === 'high') params.energy_min = 0.22;

  let rows: FilteredRow[];
  try {
    if (opts.q) {
      const data = await apiGet('/search', { q: opts.q, limit: limit * 4 });
      rows = (data.tracks ?? data.items ?? []).map(toFilteredRow);
    } else {
      const data = await apiGet('/tracks', params);
      rows = (data.items ?? data.tracks ?? []).map(toFilteredRow);
    }
  } catch {
    return { total: 0, rows: [] };
  }

  // Client-side filters for fields not supported as API query params yet.
  if (opts.genre) {
    const g = opts.genre.toLowerCase();
    rows = rows.filter(r => r.genre?.toLowerCase().includes(g));
  }
  if (opts.yearFrom != null) rows = rows.filter(r => r.year != null && Number(r.year) >= opts.yearFrom!);
  if (opts.yearTo != null)   rows = rows.filter(r => r.year != null && Number(r.year) <= opts.yearTo!);
  if (opts.q && opts.genre == null && opts.yearFrom == null) {
    // text search already targeted — no further filtering needed
  }

  // Sort
  const sort = opts.sort ?? 'artist';
  rows.sort((a, b) => {
    if (sort === 'title') return (a.title ?? '').localeCompare(b.title ?? '');
    if (sort === 'year') return (Number(b.year) || 0) - (Number(a.year) || 0);
    if (sort === 'bpm') return (b.bpm ?? 0) - (a.bpm ?? 0);
    if (sort === 'loudness') return (b.loudnessLufs ?? -99) - (a.loudnessLufs ?? -99);
    return (a.artist ?? '').localeCompare(b.artist ?? '');
  });

  const total = rows.length; // approximate — client-filtered
  return { total, rows: rows.slice(offset, offset + limit) };
}

function shapeObservatoryTrack(t: any): any {
  return {
    id: String(t.id),
    title: t.title ?? null,
    artist: t.artist ?? (t.artists?.[0] ?? null),
    album: t.album ?? null,
    year: t.year ?? null,
    genre: t.genres?.[0] ?? null,
    durationSec: t.duration ?? null,
    moods: [],
    energy: t.analysis?.energy != null ? energyLabel(t.analysis.energy) : null,
    source: 'ma-api',
    confidence: null,
    bpm: t.analysis?.bpm != null ? Math.round(t.analysis.bpm * 10) / 10 : null,
    musicalKey: t.analysis?.camelot ?? t.analysis?.key ?? null,
    analysisConfidence: null,
    loudnessLufs: t.analysis?.loudness_lufs ?? null,
    paceMean: null,
    vocal: t.analysis?.instrumentalness != null
      ? (t.analysis.instrumentalness > 0.5 ? 'instrumental' : 'vocal')
      : null,
  };
}

// Observatory data — returns all analysed tracks shaped for the constellation view.
// Uses the dedicated /tracks/observatory endpoint which is server-side cached
// and drives the JOIN from audio_analysis (~7K rows) rather than all tracks (37K+).
export async function tracksForObservatory(max: number): Promise<any[]> {
  try {
    const data = await apiGet<{ total: number; items: any[] }>('/tracks/observatory', {}, 30_000);
    const items: any[] = data.items ?? [];
    return items.slice(0, max).map(shapeObservatoryTrack);
  } catch {
    return [];
  }
}

// coverage endpoint shape
export async function getCoverage(): Promise<any> {
  try {
    const h = await apiGet('/health/detailed');
    const total = h.track_count ?? h.total_tracks ?? h.total ?? 0;
    const withClap = h.analysis_coverage?.clap ?? h.with_clap ?? h.with_analysis ?? total;
    const pct = total > 0 ? Math.round((withClap / total) * 100) : null;
    return {
      tagged: withClap,      // "tagged" in local-DB terms ≈ "has CLAP analysis"
      analysed: withClap,
      total,
      percent: pct,
      analysedPercent: pct,
      scannedAt: _stats.updatedAt,
      scanning: false,
      source: 'ma-api',
    };
  } catch {
    return { tagged: null, analysed: null, total: null, percent: null, analysedPercent: null, scannedAt: null, scanning: false, source: 'ma-api' };
  }
}
