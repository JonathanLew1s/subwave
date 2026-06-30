export const DEFAULT_TRACK_RECENCY_HOURS = 48;
export const DEFAULT_ARTIST_RECENCY_HOURS = 2;
const DIVERSE_LIBRARY_ARTISTS = 48;
const MIN_TRACK_RECENCY_HOURS = 1;
const MIN_ARTIST_RECENCY_HOURS = 0.25;

// Count-based hard no-repeat guard tuning (effectiveNoRepeatWindow below).
// Never hard-block more than this fraction of the tagged library, so even a
// configured window larger than the catalogue can support still leaves a fresh
// pool to pick from. And below MIN_EFFECTIVE distinct tracks the guard is both
// too weak to matter and too likely to starve a tiny library — so it switches
// off entirely and the relaxable time-window guard (recentIds/recentKeys)
// carries on alone. Ported from upstream's #638 live-repeats fix.
const NO_REPEAT_MAX_LIBRARY_FRACTION = 0.375;
const NO_REPEAT_MIN_EFFECTIVE = 15;

export interface RecencyWindows {
  trackHours: number;
  artistHours: number;
}

export interface CandidateLike {
  id?: string | null;
  title?: string | null;
  artist?: string | null;
}

export interface CandidateFilterState {
  recentIds?: Set<string>;
  recentKeys?: Set<string>;
  recentArtists?: Set<string>;
  justPlayedArtists?: Set<string>;
  // Count-based hard no-repeat guard (live-repeats fix, ported from upstream
  // #638). Checked unconditionally in every relaxation mode below — like
  // justPlayedArtists, a track in here is never an acceptable pick, so it
  // survives every starvation stage. This is what guarantees the last N
  // distinct plays can't re-air even when the relaxable recentIds/recentKeys
  // guard has been dropped to keep the pool from emptying. Populated from
  // queue.recentlyPlayedByCount(effectiveNoRepeatWindow(...)); empty = off.
  hardRecentIds?: Set<string>;
  hardRecentKeys?: Set<string>;
  seenIds?: Set<string>;
  artistCounts?: Map<string, number>;
  maxPerArtist?: number;
  cap?: number;
  relaxArtists?: boolean;
}

export function artistKey(song: CandidateLike): string {
  return (song.artist || '').toLowerCase().trim();
}

// Splits off a collaborator/backing-band suffix so "Prince" and "Prince and
// The Revolution" (or "John Lennon" / "John Lennon / Yoko Ono") resolve to the
// same key. Without this, alternating between credit variants of the same
// headline artist defeats the consecutive-artist check entirely — each pick
// looks "new" relative to the immediately-previous track's exact credit string.
const COLLAB_SPLIT_RE = /\s+(?:and the|&|feat\.?|ft\.?|featuring|with|\/|vs\.?)\s+/i;

export function coreArtistKey(song: CandidateLike): string {
  const full = artistKey(song);
  const m = full.match(COLLAB_SPLIT_RE);
  if (!m || m.index == null) return full;
  return full.slice(0, m.index).trim();
}

export function trackKey(song: CandidateLike): string {
  return `${(song.title || '').toLowerCase().trim()}|${artistKey(song)}`;
}

// Normalize for genre comparison: lowercase, hyphens/punctuation to spaces,
// collapse whitespace. Makes "Hip-Hop" and "hip hop" equal without making
// unrelated compound genres equal to their substrings.
function normGenre(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Exact match after normalization — deliberately NOT substring containment.
// Used to hard-exclude candidates that don't match a show's pinned genre —
// unlike mood/energy, which stay soft leans, genre is a hard constraint per
// this fork's design (see llm/internal/prompts/picker.ts's PICKER_CRITERIA
// comment). Substring containment ("pop" matching "k-pop"/"synthpop") was
// tried first and rejected: short genre tokens are exactly what shows pin
// AND exactly what collides with unrelated compound genres, which would
// silently let wrong-genre tracks through — the one failure mode a hard
// constraint can't afford. Excluding a legitimately-related but differently-
// tagged track (e.g. "Jazz Fusion" under a "Jazz" show) is the safer failure
// mode here: it only shrinks the pool, which the existing fallback-to-
// unfiltered logic at each call site already has to tolerate.
export function genreMatches(candidateGenre: string | null | undefined, wanted: string): boolean {
  if (!candidateGenre || !wanted) return false;
  return normGenre(candidateGenre) === normGenre(wanted);
}

export function recencyWindowsForLibrary(distinctArtists: number | null | undefined): RecencyWindows {
  if (!distinctArtists || distinctArtists <= 0) {
    return {
      trackHours: DEFAULT_TRACK_RECENCY_HOURS,
      artistHours: DEFAULT_ARTIST_RECENCY_HOURS,
    };
  }

  const scale = Math.min(1, Math.max(distinctArtists / DIVERSE_LIBRARY_ARTISTS, 1 / 12));
  const roundToQuarterHour = (hours: number) => Math.round(hours * 4) / 4;

  return {
    trackHours: Math.max(
      MIN_TRACK_RECENCY_HOURS,
      roundToQuarterHour(DEFAULT_TRACK_RECENCY_HOURS * scale),
    ),
    artistHours: Math.max(
      MIN_ARTIST_RECENCY_HOURS,
      roundToQuarterHour(DEFAULT_ARTIST_RECENCY_HOURS * scale),
    ),
  };
}

// Clamp a configured count-based no-repeat window to what the tagged library
// can safely support. Pure + unit-pinned (scripts/picker-recency-regression.ts).
//   - configuredN <= 0, or an unknown/empty library  → 0 (guard self-disables)
//   - never block more than NO_REPEAT_MAX_LIBRARY_FRACTION of the library
//   - if the result would be below NO_REPEAT_MIN_EFFECTIVE              → 0
// Examples: (100,1000)→100, (100,40)→15, (100,20)→0, (0,*)→0, (100,null)→0.
export function effectiveNoRepeatWindow(
  configuredN: number | null | undefined,
  libraryTotal: number | null | undefined,
): number {
  const n = Math.floor(Number(configuredN) || 0);
  const total = Math.floor(Number(libraryTotal) || 0);
  if (n <= 0 || total <= 0) return 0;
  const ceiling = Math.floor(total * NO_REPEAT_MAX_LIBRARY_FRACTION);
  const eff = Math.min(n, ceiling);
  return eff < NO_REPEAT_MIN_EFFECTIVE ? 0 : eff;
}

export function filterPickerCandidates<T extends CandidateLike>(
  list: T[],
  {
    recentIds = new Set<string>(),
    recentKeys = new Set<string>(),
    recentArtists = new Set<string>(),
    justPlayedArtists = new Set<string>(),
    hardRecentIds = new Set<string>(),
    hardRecentKeys = new Set<string>(),
    seenIds = new Set<string>(),
    artistCounts = new Map<string, number>(),
    maxPerArtist = Infinity,
    cap = Infinity,
    relaxArtists = true,
  }: CandidateFilterState = {},
): T[] {
  // Hard floor: never re-admit the artist that's currently (or just) playing,
  // in any cascade mode below — unlike `recentArtists`, this is never relaxed
  // under scarcity. An artist-homogeneous input list (e.g. tracksLikeThis
  // seeded on the just-played track) legitimately contributes zero candidates
  // here; other tools / the mood-pool reserve cover the pick instead.
  let candidates = list || [];
  if (justPlayedArtists.size) {
    candidates = candidates.filter((song) => {
      if (!song?.id) return true;
      const key = artistKey(song);
      const coreKey = coreArtistKey(song);
      return !(
        (key && justPlayedArtists.has(key)) ||
        (coreKey && coreKey !== key && justPlayedArtists.has(coreKey))
      );
    });
  }

  // Count-based hard no-repeat guard — same unconditional-floor treatment as
  // justPlayedArtists above: filtered out of the candidate list up front, so
  // it survives every mode in the cascade below rather than being subject to
  // relaxation. effectiveNoRepeatWindow() already keeps the configured count
  // well under the library size, so this can't starve the pool to nothing.
  if (hardRecentIds.size || hardRecentKeys.size) {
    candidates = candidates.filter((song) => {
      if (!song?.id) return true;
      if (hardRecentIds.has(song.id)) return false;
      if (hardRecentKeys.has(trackKey(song))) return false;
      return true;
    });
  }

  const allModes = [
    { recentTracks: true, recentArtists: true },
    { recentTracks: false, recentArtists: true },  // relax track recency before artist constraint
    { recentTracks: false, recentArtists: false },
  ];
  // When relaxArtists is false, never fall through to a mode that drops the
  // recentArtists exclusion — used when on-brief alternatives are already
  // available so a same-artist candidate shouldn't be reintroduced.
  const modes = relaxArtists ? allModes : allModes.filter((m) => m.recentArtists);

  // Accumulate candidates across all modes — freshest first (mode 1), then
  // progressively relaxed to fill the pool to `cap`. Modes are additive: each
  // subsequent mode only contributes tracks not already admitted by earlier
  // modes. This ensures the pool is full enough for the auto-playlist while
  // still preferring the freshest tracks.
  const out: T[] = [];
  const nextSeen = new Set(seenIds);
  const nextArtistCounts = new Map(artistCounts);

  for (const mode of modes) {
    if (out.length >= cap) break;

    for (const song of candidates) {
      if (out.length >= cap) break;
      if (!song?.id || nextSeen.has(song.id)) continue;
      if (mode.recentTracks && recentIds.has(song.id)) continue;
      if (mode.recentTracks && recentKeys.has(trackKey(song))) continue;

      const key = artistKey(song);
      const coreKey = coreArtistKey(song);
      if (mode.recentArtists && (
        (key && recentArtists.has(key)) ||
        (coreKey && coreKey !== key && recentArtists.has(coreKey))
      )) continue;
      const countKey = coreKey || key;
      if (countKey) {
        const count = nextArtistCounts.get(countKey) || 0;
        if (count >= maxPerArtist) continue;
        nextArtistCounts.set(countKey, count + 1);
      }

      nextSeen.add(song.id);
      out.push(song);
    }
  }

  if (out.length > 0) {
    for (const id of nextSeen) seenIds.add(id);
    artistCounts.clear();
    for (const [key, count] of nextArtistCounts) artistCounts.set(key, count);
  }
  return out;
}
