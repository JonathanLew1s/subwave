// MA-mode composite candidate shortlist — builds a labelled, ranked shortlist
// of tracks for the show currently on air, blending theme fit, sonic flow
// from the current track, artist-diversity discovery, and an occasional
// thematically-apt "oldie" — the 6Music-style touch of throwing in a classic
// without ever genre-gating the whole library.
//
// Shadow-mode only today (see broadcast/picker-shadow-log.ts): this module is
// never on the path that actually drives playback. It is read-only and must
// never throw past its own boundary — callers wrap it, but every internal
// step is defensive so a partial-data library degrades the shortlist size,
// never the process.

import * as library from './library.js';
import { getClapEmbedding } from './library-ma.js';
import { bpmCompat, keyCompat } from './mix.js';
import { filterPickerCandidates, artistKey, coreArtistKey } from './recency.js';
import { gateByExemplarProfile, exemplarSimilarity, type ExemplarProfile } from './theme-centroid.js';

export interface ShortlistSlotConfig {
  targetSize: number;
  themeSlots: number;
  flowSlots: number;
  discoverySlots: number;
  oldieSlots: number;
  eraWindowYears: number;
}

export interface ShortlistEntry {
  track: any;
  slot: 'theme' | 'flow' | 'discovery' | 'oldie';
  score: number;
}

export interface BuildShortlistArgs {
  showMoods: string[];
  currentTrack: { id?: string | null; bpm?: number | null; musicalKey?: string | null; year?: number | null } | null;
  recentIds: Set<string>;
  recentArtists: Set<string>;
  justPlayedArtists: Set<string>;
  config: ShortlistSlotConfig;
  // Computed once per call by the caller (it needs settings/show context this
  // module doesn't otherwise touch) via theme-centroid.ts's buildExemplarProfile.
  // null/absent = today's flat energy-band behaviour, fully backward compatible.
  exemplarProfile?: ExemplarProfile | null;
}

// 0..1 — how close a candidate sits to the show's exemplar-derived sound,
// once it's already inside the genre-gated moodPool (see gateByExemplarProfile
// below — genre eligibility is a precondition, this only ranks WITHIN it).
// CLAP similarity to the nearest individual exemplar when both the track and
// the profile have vectors to compare; a track with no CLAP coverage (~20%
// of the library is fully analysed today) gets a neutral 0.5 rather than
// being penalised — partial coverage must never zero out a track that
// already passed the genre gate. Falls back to the old flat energy-band
// signal when there's no exemplar profile at all (show has no/too-few
// exemplars) — fully backward compatible.
async function themeFit(track: any, profile: ExemplarProfile | null): Promise<number> {
  if (!profile) return track._energyRaw == null ? 0.5 : 1;
  const clap = track.id ? await getClapEmbedding(track.id) : null;
  const sim = exemplarSimilarity(clap, profile);
  return sim ?? 0.5;
}

// 0..1 composite of CLAP similarity (when present) and bpm/key compatibility
// to the currently-playing track — the "does this flow from what's on air"
// signal.
function flowFit(candidate: any, current: BuildShortlistArgs['currentTrack']): number {
  const clap = typeof candidate._similarity === 'number' ? candidate._similarity : null;
  const bpm = bpmCompat(current?.bpm ?? null, candidate.bpm ?? null);
  const key = keyCompat(current?.musicalKey ?? null, candidate.musicalKey ?? null);
  if (clap != null) return clap * 0.6 + bpm * 0.25 + key * 0.15;
  return bpm * 0.6 + key * 0.4;
}

function eraFit(track: any, eraWindowYears: number): number {
  if (track.year == null) return 0.5;
  const age = new Date().getFullYear() - track.year;
  return age <= eraWindowYears ? 1 : Math.max(0, 1 - (age - eraWindowYears) / 25);
}

function isOldEnough(track: any, eraWindowYears: number): boolean {
  if (track.year == null) return false;
  return new Date().getFullYear() - track.year > eraWindowYears;
}

// popularity is null-safe by construction (see music/library-ma.ts) — always
// null today since no MA metadata provider populates it yet. Falls back to
// the `favorite` flag, then a stable pseudo-random tiebreak so the oldie slot
// doesn't always pick the same track when nothing differentiates candidates.
function oldieRank(track: any): number {
  if (typeof track.popularity === 'number') return track.popularity;
  if (track.favorite) return 0.5;
  return 0;
}

function dedupeById(tracks: any[]): any[] {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const t of tracks) {
    if (!t?.id || seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

export async function buildMaShortlist(args: BuildShortlistArgs): Promise<ShortlistEntry[]> {
  const { showMoods, currentTrack, recentIds, recentArtists, justPlayedArtists, config, exemplarProfile } = args;

  const moodPoolRaw = showMoods.length ? await library.songsByMoods(showMoods) : [];
  const recencyFiltered = filterPickerCandidates(dedupeById(moodPoolRaw), {
    recentIds, recentArtists, justPlayedArtists, cap: Infinity,
  });
  // Genre-palette gate (theme-centroid.ts) — when the show has enough
  // usable exemplars, narrow the recency-filtered pool down to the subset
  // that shares a literal genre tag with at least one exemplar. Absent a
  // profile, this is a no-op: moodPool is exactly what it was before.
  const moodPool = exemplarProfile
    ? gateByExemplarProfile(recencyFiltered, exemplarProfile).eligible
    : recencyFiltered;

  const usedIds = new Set<string>();
  const entries: ShortlistEntry[] = [];

  // --- Theme slots ----------------------------------------------------------
  const themeScored = await Promise.all(
    moodPool.map(async (t) => ({ track: t, score: (await themeFit(t, exemplarProfile ?? null)) * 0.7 + eraFit(t, config.eraWindowYears) * 0.3 })),
  );
  const themeRanked = themeScored.sort((a, b) => b.score - a.score);
  for (const { track, score } of themeRanked) {
    if (entries.filter((e) => e.slot === 'theme').length >= config.themeSlots) break;
    if (usedIds.has(track.id)) continue;
    usedIds.add(track.id);
    entries.push({ track, slot: 'theme', score });
  }

  // --- Flow slots ------------------------------------------------------------
  if (currentTrack?.id && config.flowSlots > 0) {
    const flowCandidatesRaw = await library.tracksLikeThis(String(currentTrack.id), 20);
    const flowCandidatesAll = filterPickerCandidates(dedupeById(flowCandidatesRaw), {
      recentIds, recentArtists, justPlayedArtists, cap: Infinity,
    });
    // Prefer on-palette neighbours, same trade-off picker-tools.ts's
    // collectPreferGated settled on for the agent's own tracksLikeThis tool
    // call: this is a raw similarity/CLAP search across the WHOLE library
    // with no mood/genre pre-scoping (unlike moodPool above, which IS
    // gated), so real neighbours routinely carry a different literal genre
    // tag than the seed even when texturally on-brief — a flat hard gate
    // zeroed nearly everything in testing. Confirmed live this exact slot
    // was the unguarded path letting off-palette tracks (Cream/Blues,
    // Traveling Wilburys/Roots Rock, Big Star/Power Pop) into a First Light
    // (Indie/Alt Rock palette) brief pool and shortlist as ordinary, clean
    // picks — moodPool's gate covers theme/discovery but never touched flow.
    const flowCandidates = exemplarProfile
      ? (() => {
          const gated = gateByExemplarProfile(flowCandidatesAll, exemplarProfile).eligible;
          return gated.length ? gated : flowCandidatesAll;
        })()
      : flowCandidatesAll;
    const flowRanked = flowCandidates
      .filter((t) => !usedIds.has(t.id))
      .map((t) => ({ track: t, score: flowFit(t, currentTrack) }))
      .sort((a, b) => b.score - a.score);
    for (const { track, score } of flowRanked) {
      if (entries.filter((e) => e.slot === 'flow').length >= config.flowSlots) break;
      if (usedIds.has(track.id)) continue;
      usedIds.add(track.id);
      entries.push({ track, slot: 'flow', score });
    }
  }

  // --- Discovery slots ---------------------------------------------------
  // Same mood pool as theme, but explicitly biased toward artists not already
  // represented in entries so far — this is what keeps a flow-anchored chain
  // from drifting into a narrow sonic rut over many transitions.
  const usedArtistKeys = new Set(entries.map((e) => coreArtistKey(e.track) || artistKey(e.track)));
  const discoveryCandidates = moodPool
    .filter((t) => !usedIds.has(t.id))
    .filter((t) => {
      const key = coreArtistKey(t) || artistKey(t);
      return key && !usedArtistKeys.has(key);
    });
  const discoveryScored = await Promise.all(
    discoveryCandidates.map(async (t) => ({ track: t, score: await themeFit(t, exemplarProfile ?? null) })),
  );
  const discoveryRanked = discoveryScored.sort((a, b) => b.score - a.score);
  for (const { track, score } of discoveryRanked) {
    if (entries.filter((e) => e.slot === 'discovery').length >= config.discoverySlots) break;
    if (usedIds.has(track.id)) continue;
    usedIds.add(track.id);
    usedArtistKeys.add(coreArtistKey(track) || artistKey(track));
    entries.push({ track, slot: 'discovery', score });
  }

  // --- Oldie slot -------------------------------------------------------
  const oldieRanked = moodPool
    .filter((t) => !usedIds.has(t.id))
    .filter((t) => isOldEnough(t, config.eraWindowYears))
    .map((t) => ({ track: t, score: oldieRank(t) }))
    .sort((a, b) => b.score - a.score);
  for (const { track, score } of oldieRanked) {
    if (entries.filter((e) => e.slot === 'oldie').length >= config.oldieSlots) break;
    if (usedIds.has(track.id)) continue;
    usedIds.add(track.id);
    entries.push({ track, slot: 'oldie', score });
  }
  // No eligible oldie found (e.g. eraWindowYears wider than the mood pool's
  // spread) — the slot is simply omitted. Never force a wrong-fit pick.

  return entries.slice(0, config.targetSize);
}
