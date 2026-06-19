// Theme centroid + eligibility gate — turns a show's exemplar tracks into a
// target point in 6-axis sonic space, and gates a mood-band candidate pool
// down to the subset close enough to that point to count as "on brief".
//
// Validated live against the real cluster (see
// docs/superpowers/plans/2026-06-19-ma-theme-centroid-gate.md background):
// a real exemplar set produced a genuine, wide separation between on-brief
// and off-brief candidates (~0.05 to ~0.50 distance), versus the flat
// energy-band-only scoring this replaces, which ties every candidate at the
// same score.
//
// Deliberately a GATE (admit/reject into an auto-sized pool), not a ranking.
// Ranking by raw closeness was tried first and rejected: for a multi-hour
// show, always serving the single closest match means the same handful of
// tracks repeat constantly. Gating into a large-enough pool and letting the
// existing recency/randomization machinery pick within it is what gives
// real variety across a long show.

import * as libraryMa from './library-ma.js';

export const CENTROID_AXES = [
  'valence', 'arousal', 'danceability', 'acousticness', 'instrumentalness', 'brightness',
] as const;

export interface ThemeCentroid {
  vector: (number | null)[];
  exemplarCount: number;
}

export interface ThemeCentroidConfig {
  minExemplars: number;
  minPoolSize: number;
  maxThreshold: number;
}

// Averages each axis across exemplars that have it (component-wise — an
// exemplar missing one axis still contributes its other axes, rather than
// being dropped wholesale, since ~80% of the library lacks full coverage and
// even "well-analysed" tracks sometimes miss one axis). An exemplar with NO
// usable axis at all is skipped entirely. Returns null when fewer than
// `minExemplars` exemplars survive — callers must treat null as "no
// centroid available, fall back to today's flat behaviour", never as an
// error to surface.
export async function computeThemeCentroid(
  exemplarTrackIds: string[],
  config: Pick<ThemeCentroidConfig, 'minExemplars'>,
): Promise<ThemeCentroid | null> {
  if (!exemplarTrackIds?.length) return null;
  const vectors: (number | null)[][] = [];
  for (const id of exemplarTrackIds) {
    const axes = await libraryMa.getAnalysisAxes(id);
    if (!axes) continue;
    const vec = CENTROID_AXES.map((ax) => axes[ax] ?? null);
    if (vec.every((v) => v == null)) continue;
    vectors.push(vec);
  }
  if (vectors.length < config.minExemplars) return null;
  const vector = CENTROID_AXES.map((_, i) => {
    const vals = vectors.map((v) => v[i]).filter((v): v is number => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  });
  return { vector, exemplarCount: vectors.length };
}

// RMS distance across whichever axes both the centroid and the candidate
// have — null-safe on both sides. Returns null (not a default distance)
// when there are zero usable axes in common, so callers can exclude rather
// than mis-score tracks with no overlapping data.
export function centroidDistance(track: any, centroid: ThemeCentroid): number | null {
  let sumSq = 0;
  let n = 0;
  for (let i = 0; i < CENTROID_AXES.length; i++) {
    const c = centroid.vector[i];
    const v = track[CENTROID_AXES[i]];
    if (c == null || typeof v !== 'number') continue;
    sumSq += (c - v) ** 2;
    n++;
  }
  return n > 0 ? Math.sqrt(sumSq / n) : null;
}

export interface GateResult {
  eligible: any[];
  threshold: number;
}

// Auto-sizes the eligibility threshold to admit at least `minPoolSize`
// candidates (or as many as exist, if fewer), capped at `maxThreshold` so a
// sparse/mismatched mood pool doesn't silently widen until everything is
// "eligible". Tracks with no usable distance (centroidDistance returned
// null) are excluded entirely, not admitted by default — a candidate this
// module can't score must never count toward "this is on-brief".
export function gateByCentroid(
  tracks: any[],
  centroid: ThemeCentroid,
  config: Pick<ThemeCentroidConfig, 'minPoolSize' | 'maxThreshold'>,
): GateResult {
  const withDist = tracks
    .map((track) => ({ track, dist: centroidDistance(track, centroid) }))
    .filter((x): x is { track: any; dist: number } => x.dist != null);
  if (!withDist.length) return { eligible: [], threshold: config.maxThreshold };
  const sorted = [...withDist].sort((a, b) => a.dist - b.dist);
  const idx = Math.min(config.minPoolSize, sorted.length) - 1;
  const threshold = Math.min(config.maxThreshold, sorted[Math.max(0, idx)].dist);
  const eligible = withDist.filter((x) => x.dist <= threshold).map((x) => x.track);
  return { eligible, threshold };
}
