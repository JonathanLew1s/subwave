// Multi-axis "brief pool" builder — given a show's moods (and optional vibe
// text), assembles a stratified candidate pool: genre-diverse, energy-diverse,
// vibe-vector-matched, and eclectic/random slices, all drawn from the curated
// mood universe (library.songsByMoods). Used by the picker agent (dj-agent.ts)
// to seed the `briefPool` reserve slots in llm/tools.ts, replacing the old
// single-mood moodPool.
//
// Genre/energy stratification is applied WITHIN the mood-curated universe —
// it diversifies the curated set, never pulls in tracks that aren't already
// mood-tagged. The vibe slice reuses the same embedding KNN as searchByLyrics,
// intersected with the universe. The eclectic slice is a genuine random sample
// of the universe — the wildcard that keeps picks from feeling formulaic.

import * as library from './library.js';
import * as embeddings from './embeddings.js';

export interface BriefPoolTrack {
  id: string;
  title: string;
  artist: string;
  album: string | null | undefined;
  year: number | string | null | undefined;
  genre: string | null | undefined;
  moods: string[];
  energy: string | null | undefined;
  _source: string;
}

export interface BriefPoolResult {
  tracks: BriefPoolTrack[];
  bySource: Record<string, number>;
}

const GENRE_SLICE_SIZE = 12;
const ENERGY_SLICE_SIZE = 12;
const VIBE_SLICE_SIZE = 10;
const VIBE_K = 60;
const ECLECTIC_SLICE_SIZE = 10;
const POPULARITY_SLICE_SIZE = 12;
const POPULARITY_FLOOR_PERCENTILE = 30;

function shuffle<T>(arr: T[]): T[] {
  return [...arr].sort(() => Math.random() - 0.5);
}

// Per-show vibe-embedding cache, keyed by show id — recomputed if the vibe
// text changes (e.g. the operator edits it in the admin UI).
const vibeCache = new Map<string, { text: string; vec: number[] }>();

async function vibeVector(showId: string | undefined, vibeText: string | undefined): Promise<number[] | null> {
  const text = (vibeText || '').trim();
  if (!text || !embeddings.isAvailable()) return null;
  const key = showId || text;
  const cached = vibeCache.get(key);
  if (cached && cached.text === text) return cached.vec;
  const [vec] = await embeddings.embedTexts([text]);
  if (!vec) return null;
  vibeCache.set(key, { text, vec });
  return vec;
}

// Bucket `universe` by `keyFn`, then round-robin sample across buckets so one
// dominant bucket (e.g. one genre) doesn't crowd out the rest. Mutates copies
// of the bucket arrays only (universe itself is untouched).
function stratifiedSample(universe: any[], keyFn: (t: any) => string, n: number): any[] {
  const buckets = new Map<string, any[]>();
  for (const t of universe) {
    const k = keyFn(t) || 'unknown';
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push(t);
  }
  for (const bucket of buckets.values()) shuffle(bucket);
  const keys = shuffle([...buckets.keys()]);
  const out: any[] = [];
  let i = 0;
  let exhausted = 0;
  while (out.length < n && exhausted < keys.length) {
    const k = keys[i % keys.length];
    const bucket = buckets.get(k)!;
    if (bucket.length) {
      out.push(bucket.pop());
      if (bucket.length === 0) exhausted++;
    }
    i++;
  }
  return out;
}

// Builds a stratified "brief pool" from the union of songsByMood() across
// `moods`. `recentTrackIds` (recently-played ids) are excluded from the
// universe up front — same recency floor the picker tools apply elsewhere,
// kept here too so every slice draws from genuinely-fresh candidates.
export async function buildBriefPool({
  moods,
  vibeText,
  showId,
  recentTrackIds = new Set<string>(),
}: {
  moods: string[] | null | undefined;
  vibeText?: string;
  showId?: string;
  recentTrackIds?: Set<string>;
}): Promise<BriefPoolResult> {
  await library.load();
  const universe = library.songsByMoods(moods).filter((t: any) => !recentTrackIds.has(t.id));

  // Popularity floor — drop bottom N% of tracks by trackPopularity.
  // Tracks with null popularity are neutral (not excluded). Thresholds are
  // rough: ~10-15% floor means keeping 85-90% of the library.
  const withPopularity = universe.filter((t: any) => t.popularitySong != null);
  let floorThreshold = 0;
  if (withPopularity.length > 0) {
    const sorted = [...withPopularity].sort((a: any, b: any) => (a.popularitySong || 0) - (b.popularitySong || 0));
    const idx = Math.floor(sorted.length * (POPULARITY_FLOOR_PERCENTILE / 100));
    floorThreshold = sorted[idx]?.popularitySong || 0;
  }
  const universeFiltered = universe.filter((t: any) =>
    t.popularitySong == null || t.popularitySong >= floorThreshold
  );

  const bySource: Record<string, number> = {};
  const seen = new Set<string>();
  const out: BriefPoolTrack[] = [];

  const add = (tracks: any[], source: string) => {
    for (const t of tracks) {
      if (!t?.id || seen.has(t.id)) continue;
      seen.add(t.id);
      out.push({ ...t, _source: source });
      bySource[source] = (bySource[source] || 0) + 1;
    }
  };

  add(stratifiedSample(universeFiltered, (t) => t.genre, GENRE_SLICE_SIZE), 'genre');
  add(stratifiedSample(universeFiltered, (t) => t.energy, ENERGY_SLICE_SIZE), 'energy');

  const vec = await vibeVector(showId, vibeText);
  if (vec) {
    const universeFilteredIds = new Set(universeFiltered.map((t: any) => t.id));
    const vibeHits = library.tracksByVector(vec, VIBE_K)
      .filter((t: any) => universeFilteredIds.has(t.id))
      .slice(0, VIBE_SLICE_SIZE);
    add(vibeHits, 'vibe');
  }

  add(shuffle([...universeFiltered]).slice(0, ECLECTIC_SLICE_SIZE), 'eclectic');

  // Popularity-weighted slice — within universe, prefer higher-popularity tracks.
  // Weight by both trackPopularity and albumPopularity (album as secondary).
  const popularityWeighted = universeFiltered
    .map((t: any) => ({
      ...t,
      _popularityScore: ((t.popularitySong || 0) * 0.8 + (t.popularityAlbum || 0) * 0.2),
    }))
    .sort((a: any, b: any) => (b._popularityScore || 0) - (a._popularityScore || 0))
    .slice(0, POPULARITY_SLICE_SIZE)
    .map((t: any) => ({ ...t, _source: 'popularity' }));
  add(popularityWeighted, 'popularity');

  return { tracks: out, bySource };
}
