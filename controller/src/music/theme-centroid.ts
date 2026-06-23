// Exemplar-driven show identity — turns a show's exemplar tracks into (a) a
// genre palette (their own literal flat tags, NOT expanded through the
// taxonomy's alias rollup) used as a hard gate, and (b) a set of CLAP
// vectors used to rank survivors by similarity to the nearest individual
// exemplar.
//
// Validated live against the real cluster (see
// docs/superpowers/specs/2026-06-23-show-redesign-and-genre-aware-picker-design.md
// for the full investigation and exact numbers). Two approaches were tried
// and rejected before this one:
//   - A 6-axis blended centroid (valence/arousal/danceability/acousticness/
//     instrumentalness/brightness, averaged across exemplars) — even with a
//     clean exemplar set, the gated pool still admitted Ella Fitzgerald,
//     Elvis, Rush, Pink Floyd. Averaging genre-diverse exemplars washes out
//     any real discriminating signal.
//   - Raw CLAP-embedding similarity (mean-pooled centroid OR max similarity
//     to the nearest exemplar) on its own — CLAP measures acoustic/
//     production texture, not cultural genre identity, so a quiet vocal jazz
//     standard and a quiet indie-folk song can sit at nearly the same point
//     in that space. Top matches by raw CLAP similarity included Bee Gees,
//     Lady Gaga, R.E.M., Elton John.
// The combination that worked: literal-tag genre gating excludes the
// cross-genre noise neither sonic signal could catch on its own; CLAP
// similarity then refines texture *within* that genre scope, which is
// otherwise too broad on its own (e.g. "Folk" spans sparse Nick Drake to
// stomping Mumford & Sons). Critically, the palette is taken from each
// exemplar's literal tags only — expanding through the taxonomy's alias
// rollup pulls in unrelated sibling subgenres under broad umbrellas
// (confirmed live: one "Downtempo" exemplar expanding to admit Dubstep/
// Deep House/Club via a shared "electronic" parent).

import { getExemplarProfileData } from './library-ma.js';

export interface ExemplarProfile {
  // Normalised (lowercase, punctuation-stripped) literal genre tags carried
  // by the exemplars — no taxonomy alias expansion.
  paletteKeys: Set<string>;
  // One CLAP vector per exemplar that has one.
  clapVectors: number[][];
  // Exemplars that contributed ANY usable data (a genre tag or a CLAP
  // vector) — not exemplarTrackIds.length, which may include ids that
  // resolved to nothing.
  exemplarCount: number;
}

export interface ExemplarProfileConfig {
  minExemplars: number;
}

function norm(s: string): string {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Fetches each exemplar's literal genre tags + CLAP vector and folds them
// into one profile. An exemplar missing CLAP coverage still contributes its
// genre tags (and vice versa) — partial data is never dropped wholesale.
// Returns null when fewer than `minExemplars` exemplars contributed
// anything usable — callers must treat null as "no profile available, fall
// back to today's flat mood-band behaviour", never as an error.
export async function buildExemplarProfile(
  exemplarTrackIds: string[],
  config: Pick<ExemplarProfileConfig, 'minExemplars'>,
): Promise<ExemplarProfile | null> {
  if (!exemplarTrackIds?.length) return null;
  const paletteKeys = new Set<string>();
  const clapVectors: number[][] = [];
  let exemplarCount = 0;
  for (const id of exemplarTrackIds) {
    const data = await getExemplarProfileData(id);
    if (!data) continue;
    let usable = false;
    for (const g of data.genres) {
      const key = norm(g);
      if (key) { paletteKeys.add(key); usable = true; }
    }
    if (data.clapEmbedding) { clapVectors.push(data.clapEmbedding); usable = true; }
    if (usable) exemplarCount++;
  }
  if (exemplarCount < config.minExemplars) return null;
  return { paletteKeys, clapVectors, exemplarCount };
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function cosine(a: number[], b: number[]): number {
  const norm = Math.sqrt(dot(a, a)) * Math.sqrt(dot(b, b));
  return norm === 0 ? 0 : dot(a, b) / norm;
}

// Max CLAP cosine similarity to any INDIVIDUAL exemplar — never a mean-
// pooled centroid (averaging genre-diverse exemplars was the original
// failure mode this module replaces). null when the track or the profile
// has no CLAP vector to compare — callers must treat that as "can't score",
// not as a low score.
export function exemplarSimilarity(clapEmbedding: number[] | null | undefined, profile: ExemplarProfile): number | null {
  if (!clapEmbedding || !profile.clapVectors.length) return null;
  let best = -Infinity;
  for (const e of profile.clapVectors) best = Math.max(best, cosine(clapEmbedding, e));
  return best === -Infinity ? null : best;
}

export interface GateResult {
  eligible: any[];
}

// Hard-gates `tracks` to the exemplar-derived genre palette — a track
// qualifies if ANY of its own literal genre tags (the full `genres` array,
// not just the first) matches the palette, normalised for case/punctuation
// but never expanded through the taxonomy alias rollup (see module comment).
// Tracks with no genre tag at all are excluded, not admitted by default —
// same "can't score it, don't count it" stance as exemplarSimilarity above.
export function gateByExemplarProfile(tracks: any[], profile: ExemplarProfile): GateResult {
  if (!profile.paletteKeys.size) return { eligible: [] };
  const eligible = tracks.filter((t) => {
    const genres: string[] = Array.isArray(t.genres) ? t.genres : (t.genre ? [t.genre] : []);
    return genres.some((g) => profile.paletteKeys.has(norm(g)));
  });
  return { eligible };
}
