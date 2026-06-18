// MA DB API implementation of the library.ts async interface.
// Called by library.ts when config.libraryBackend === 'ma-api'.
// All data comes from the music-assistant-db-api sidecar over HTTP — no local SQLite.

import { apiGet, toSong } from './ma-db-api.js';
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
// Mood → audio-feature energy range approximation.
// MA's sonic_analysis energy tops out around 0.46 (vs Spotify's 0-1 scale).
// Thresholds calibrated from actual distribution (p25=0.11, p50=0.16, p75=0.22).
// ---------------------------------------------------------------------------
const MOOD_ENERGY: Record<string, [number | null, number | null]> = {
  energetic:   [0.28, null],
  workout:     [0.28, null],
  driving:     [0.24, null],
  festival:    [0.26, null],
  celebratory: [0.26, null],
  sunny:       [0.20, null],
  morning:     [0.15, 0.28],
  cooking:     [0.13, 0.26],
  evening:     [null, 0.24],
  romantic:    [null, 0.22],
  cultural:    [0.15, 0.32],
  spiritual:   [null, 0.22],
  calm:        [null, 0.17],
  focus:       [0.11, 0.24],
  reflective:  [null, 0.20],
  rainy:       [null, 0.17],
  night:       [null, 0.20],
};

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
    popularitySong: null,
    popularityAlbum: null,
    bpm: s.bpm,
    musicalKey: s.musicalKey,
    loudnessLufs: s.loudnessLufs,
    paceMean: null,       // pace curves not in the sidecar response
    _energyRaw: t.analysis?.energy ?? null,
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
    const [h, a] = await Promise.all([
      apiGet('/health/detailed'),
      apiGet('/artists', { limit: 1 }),
    ]);
    // health/detailed returns { track_count, analysis_coverage: { bpm, clap, sonic, loudness } }
    // /artists?limit=1 returns { total } — the full artist count for recency-window scaling.
    _stats = {
      total: h.track_count ?? h.total_tracks ?? h.total ?? 0,
      distinctArtists: h.total_artists ?? a.total ?? 0,
      byGenre: h.genres ?? {},
      updatedAt: new Date().toISOString(),
    };
  } catch {
    // Not fatal — controller boots fine; stats return zero until next load().
  }
}

export function stats() {
  // byMood: the MOOD_ENERGY keys are the moods MA can serve via energy-band
  // filtering — this gives the UI an accurate "N moods in use" count.
  const byMood = Object.fromEntries(Object.keys(MOOD_ENERGY).map(k => [k, 1]));
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

export async function songsByMood(mood: string | null | undefined): Promise<any[]> {
  if (!mood) return [];
  const [energyMin, energyMax] = MOOD_ENERGY[mood] ?? [null, null];
  const params: Record<string, any> = { limit: 200, order: 'random' };
  if (energyMin != null) params.energy_min = energyMin;
  if (energyMax != null) params.energy_max = energyMax;
  try {
    const data = await apiGet('/tracks', params, 30_000);
    return (data.items ?? data.tracks ?? []).map(toLibraryTrack);
  } catch {
    return [];
  }
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
  const params: Record<string, any> = { limit: 50, order: 'random' };
  if (energy === 'low') params.energy_max = 0.11;
  else if (energy === 'medium') { params.energy_min = 0.11; params.energy_max = 0.22; }
  else if (energy === 'high') params.energy_min = 0.22;
  else return [];
  try {
    const data = await apiGet('/tracks', params, 30_000);
    return (data.items ?? data.tracks ?? []).map(toLibraryTrack);
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
    const results = data.results ?? [];
    const tracks = await Promise.all(
      results.slice(0, k).map(async (r) => {
        try {
          const t = await apiGet(`/tracks/${r.id}`);
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
    genre: t.genre ?? null,
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
