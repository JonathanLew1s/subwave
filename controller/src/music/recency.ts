export const DEFAULT_TRACK_RECENCY_HOURS = 48;
export const DEFAULT_ARTIST_RECENCY_HOURS = 2;
const DIVERSE_LIBRARY_ARTISTS = 48;
const MIN_TRACK_RECENCY_HOURS = 1;
const MIN_ARTIST_RECENCY_HOURS = 0.25;

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

// Case-insensitive substring match in either direction — handles both a
// compound library tag matching a simpler show-genre string ("Hip-Hop"
// candidate vs. "hip hop" show filter) and the reverse. Used to hard-exclude
// candidates that don't match a show's pinned genre — unlike mood/energy,
// which stay soft leans, genre is a hard constraint per this fork's design
// (see llm/internal/prompts/picker.ts's PICKER_CRITERIA comment).
export function genreMatches(candidateGenre: string | null | undefined, wanted: string): boolean {
  if (!candidateGenre || !wanted) return false;
  const a = candidateGenre.toLowerCase();
  const b = wanted.toLowerCase();
  return a.includes(b) || b.includes(a);
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

export function filterPickerCandidates<T extends CandidateLike>(
  list: T[],
  {
    recentIds = new Set<string>(),
    recentKeys = new Set<string>(),
    recentArtists = new Set<string>(),
    justPlayedArtists = new Set<string>(),
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
