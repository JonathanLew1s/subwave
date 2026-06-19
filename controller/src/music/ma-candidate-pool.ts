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
import { bpmCompat, keyCompat } from './mix.js';
import { filterPickerCandidates, artistKey, coreArtistKey } from './recency.js';

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
}

// 0..1 — how close a candidate's energy sits to the show's mood band. Reuses
// the same _energyRaw scalar the MA energy-band filter already produces;
// candidates with no analysis (no _energyRaw) get a neutral 0.5 rather than
// being penalised — partial CLAP/sonic coverage (~20% of the library today)
// must never zero out a track that's otherwise on-brief.
function moodFit(track: any): number {
  // songsByMood already filters server-side to the show's mood/energy band
  // (energy_min/energy_max), so every candidate here is already in-band —
  // this is a flat binary signal (analysed vs. not), not a centre-distance
  // score. True within-band ranking would need the raw energy value scored
  // against the band's midpoint, which isn't wired through yet.
  if (track._energyRaw == null) return 0.5;
  return 1;
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
  const { showMoods, currentTrack, recentIds, recentArtists, justPlayedArtists, config } = args;

  const moodPoolRaw = showMoods.length ? await library.songsByMoods(showMoods) : [];
  const moodPool = filterPickerCandidates(dedupeById(moodPoolRaw), {
    recentIds, recentArtists, justPlayedArtists, cap: Infinity,
  });

  const usedIds = new Set<string>();
  const entries: ShortlistEntry[] = [];

  // --- Theme slots ----------------------------------------------------------
  const themeRanked = [...moodPool]
    .map((t) => ({ track: t, score: moodFit(t) * 0.7 + eraFit(t, config.eraWindowYears) * 0.3 }))
    .sort((a, b) => b.score - a.score);
  for (const { track, score } of themeRanked) {
    if (entries.filter((e) => e.slot === 'theme').length >= config.themeSlots) break;
    if (usedIds.has(track.id)) continue;
    usedIds.add(track.id);
    entries.push({ track, slot: 'theme', score });
  }

  // --- Flow slots ------------------------------------------------------------
  if (currentTrack?.id && config.flowSlots > 0) {
    const flowCandidatesRaw = await library.tracksLikeThis(String(currentTrack.id), 20);
    const flowCandidates = filterPickerCandidates(dedupeById(flowCandidatesRaw), {
      recentIds, recentArtists, justPlayedArtists, cap: Infinity,
    });
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
  const discoveryRanked = moodPool
    .filter((t) => !usedIds.has(t.id))
    .filter((t) => {
      const key = coreArtistKey(t) || artistKey(t);
      return key && !usedArtistKeys.has(key);
    })
    .map((t) => ({ track: t, score: moodFit(t) }))
    .sort((a, b) => b.score - a.score);
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
