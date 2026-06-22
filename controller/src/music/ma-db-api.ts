// Music Assistant DB API backend.
// Routes all library calls to the music-assistant-db-api sidecar over HTTP.
// Implements the same export surface as subsonic.ts so library-backend.ts
// can route to either without any caller knowing the difference.
//
// Config: MA_DB_API_URL (default http://music-assistant:8096), MA_DB_API_KEY

import { config } from '../config.js';

// ---------------------------------------------------------------------------
// HTTP primitives
// ---------------------------------------------------------------------------

function baseUrl(): string {
  return (config.maDbApi.url || '').replace(/\/$/, '');
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'Accept': 'application/json' };
  if (config.maDbApi.apiKey) h['X-API-Key'] = config.maDbApi.apiKey;
  return h;
}

// Default bumped 10s -> 25s as an immediate stopgap: the sidecar's
// energy/valence/arousal-filtered queries (songsByMood/songsByMoods, the
// mood pool backing auto.m3u and the picker) currently measure ~16s against
// the live cluster as MA's analysis coverage has grown — every call was
// silently aborting before the server even responded. The real fix is a set
// of expression indexes added on the sidecar side (music-assistant-db-api);
// this timeout bump is the immediate unblock while that rolls out, not a
// replacement for it — leave it generous even after the index fix lands,
// since this call still crosses two services and a 25s ceiling costs
// nothing when the common case is sub-second.
export async function apiGet<T = any>(path: string, params: Record<string, any> = {}, timeoutMs = 25_000): Promise<T> {
  const url = new URL(`${baseUrl()}/api/v1${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url.toString(), { headers: headers(), signal: ctrl.signal });
    if (!r.ok) throw new Error(`ma-db-api ${path} → HTTP ${r.status}`);
    return r.json() as Promise<T>;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Shape mappers
// ---------------------------------------------------------------------------

// Map an API track object to the shape subsonic.ts callers expect.
export function toSong(t: any): any {
  return {
    id: String(t.id),
    title: t.title ?? '',
    artist: t.artist ?? '',
    album: t.album ?? '',
    year: t.year ?? null,
    // The API moved from a singular `genre` string to a `genres` array (full
    // tag list, not just the first) — take the first tag here to keep the
    // singular `genre` contract every other backend/caller expects.
    genre: t.genres?.[0] ?? null,
    duration: t.duration ?? null,
    path: t.file_path ?? null,   // relative path — used by getLocalPath / getAnnotatedUri
    coverArt: String(t.id),      // getCoverArtUrl / /cover/:id use this
    favorite: t.favorite ?? false,
    popularity: t.popularity ?? null,
    // Analysis fields forwarded so queue.ts can compute loudness gain / crossfade
    loudnessLufs: t.analysis?.loudness_lufs ?? null,
    bpm: t.analysis?.bpm != null ? Math.round(t.analysis.bpm * 10) / 10 : null,
    musicalKey: t.analysis?.camelot ?? null,
  };
}

function toAlbum(a: any): any {
  return {
    id: String(a.id),
    name: a.name ?? '',
    artist: a.artist ?? '',
    year: a.year ?? null,
  };
}

// ---------------------------------------------------------------------------
// Exports matching subsonic.ts interface
// ---------------------------------------------------------------------------

export function isStationArchive(_song: any): boolean {
  return false; // MA doesn't scan the SUB/WAVE archive dir
}

export async function search(query: string, { songCount = 20 } = {}): Promise<any[]> {
  const data = await apiGet('/search', { q: query, limit: songCount });
  return (data.tracks ?? []).map(toSong);
}

export async function getRandomSongs({ size = 20, genre }: { size?: number; genre?: string; fromYear?: number; toYear?: number } = {}): Promise<any[]> {
  const data = await apiGet('/tracks', { order: 'random', limit: size, genre });
  return (data.items ?? []).map(toSong);
}

// The sidecar's real genre taxonomy (/genres) — canonical name + alias
// rollups (e.g. "ambient" aliases "Ambient Dub", "Kankyō Ongaku") backed by a
// real track-membership join, distinct from the flat tag array on Track.genre.
// ~147 genres today, well under the endpoint's max limit=1000, so one request
// covers the whole taxonomy. Cached briefly — the sidecar's own data only
// changes on the hourly DB-clone refresh, and this list backs every genre
// lookup the picker/agent make per pick.
const GENRES_CACHE_TTL_MS = 10 * 60 * 1000;
let genresCache: { at: number; rows: any[] } | null = null;

async function allGenres(): Promise<any[]> {
  if (genresCache && Date.now() - genresCache.at < GENRES_CACHE_TTL_MS) return genresCache.rows;
  const data = await apiGet('/genres', { limit: 1000 });
  const rows = data.items ?? [];
  genresCache = { at: Date.now(), rows };
  return rows;
}

export async function getGenres(): Promise<any[]> {
  try {
    const genres = await allGenres();
    return genres
      .map((g: any) => ({ value: g.name, songCount: g.track_count ?? 0 }))
      .sort((a, b) => b.songCount - a.songCount);
  } catch {
    return [];
  }
}

// Fuzzy-match free text ("hip hop", "ambient") against the real genre
// taxonomy's name + alias rollups. Exact normalised match (against name or
// any alias) wins, then substring either way. Returns the matching genre row
// ({id, name}) or null. Shared by resolveGenreName (which only needs the
// name), getSongsByGenre, and library-ma.ts's genre-based mood matching
// (cultural/spiritual) — all need the id for /genres/:id/tracks, the real
// membership join.
export async function resolveGenreRow(name: string): Promise<{ id: number; name: string } | null> {
  if (!name) return null;
  const norm = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = norm(name);
  if (!target) return null;
  try {
    const genres = await allGenres();
    const candidates = genres.map((g: any) => ({
      id: g.id as number,
      name: g.name as string,
      nameKey: norm(g.name),
      aliasKeys: (g.aliases ?? []).map(norm),
    }));
    // Priority matters: the taxonomy's alias lists overlap messily (verified
    // live — "gospel" the genre has 57 tracks and lists "Church Music" as an
    // alias, while "church music" the genre has 0 tracks and separately
    // lists "Gospel" as one of ITS aliases). A canonical-name match is an
    // unambiguous identity match and must win over a same-text alias hit on
    // a different genre, or matching depends on array order, not intent.
    let hit = candidates.find((g) => g.nameKey === target);
    if (!hit) hit = candidates.find((g) => g.aliasKeys.includes(target));
    if (!hit) {
      hit = candidates.find((g) =>
        (g.nameKey && (g.nameKey.includes(target) || target.includes(g.nameKey)))
        || g.aliasKeys.some((k: string) => k && (k.includes(target) || target.includes(k))));
    }
    return hit ? { id: hit.id, name: hit.name } : null;
  } catch {
    return null;
  }
}

// Returns the canonical genre name or null — mirrors subsonic.ts's
// resolveGenreName contract exactly (previously this always returned the
// input unchanged, never validating it against the library at all).
export async function resolveGenreName(name: string): Promise<string | null> {
  const hit = await resolveGenreRow(name);
  return hit?.name ?? null;
}

// /tracks?genre= matches only the literal, case-sensitive tag string in a
// track's flat genres array — verified live it undercounts badly (77 vs the
// real 145 for "reggae", because of casing variants the flat tag never
// normalises and alias rollups it never applies). The taxonomy join
// (/genres/:id/tracks) is the real, complete membership list — go through
// genre-id resolution and use that instead.
//
// /genres/:id/tracks only accepts offset/limit (verified against the
// handler — no order/dir param exists), so it always returns the same
// media_id-ordered slice. Fetch a wide-enough batch and shuffle client-side
// so repeat calls (every pick) don't hand back the identical first N tracks.
const GENRE_TRACKS_FETCH_CAP = 200;

export async function tracksByGenreId(id: number, count = 20): Promise<any[]> {
  try {
    const data = await apiGet(`/genres/${id}/tracks`, { limit: GENRE_TRACKS_FETCH_CAP });
    const items: any[] = data.items ?? [];
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items.slice(0, count).map(toSong);
  } catch {
    return [];
  }
}

export async function getSongsByGenre(genre: string, { count = 20 } = {}): Promise<any[]> {
  const hit = await resolveGenreRow(genre);
  if (!hit) return [];
  return tracksByGenreId(hit.id, count);
}

export async function getSimilarSongs(id: string, { count = 20 } = {}): Promise<any[]> {
  try {
    const data = await apiGet<{ results: Array<{ id: number; score: number }> }>(
      `/tracks/${id}/similar`,
      { limit: count },
    );
    const ids = (data.results ?? []).map((r) => r.id);
    if (ids.length === 0) return [];
    const songs = await Promise.all(ids.map((tid) => getTrackById(tid)));
    return songs.filter(Boolean);
  } catch {
    return [];
  }
}

export async function supportsSonicSimilarity(): Promise<boolean> {
  // The sidecar loads CLAP vectors on startup. If the index is populated,
  // /tracks/:id/similar returns results; otherwise it returns an empty list.
  // Always return true so the picker tries — an empty response is handled.
  return true;
}

export async function getSonicSimilarTracks(id: string, { count = 20 } = {}): Promise<any[]> {
  return getSimilarSongs(id, { count });
}

export async function getStarred(): Promise<any[]> {
  const data = await apiGet('/tracks', { favorite: 'true', limit: 200, order: 'random' });
  return (data.items ?? []).map(toSong);
}

export async function getAlbumList(offset = 0, size = 500): Promise<any[]> {
  const data = await apiGet('/albums', { limit: size, offset });
  return (data.items ?? []).map(toAlbum);
}

export async function getRecentlyAddedAlbums({ size = 20 } = {}): Promise<any[]> {
  const data = await apiGet('/albums', { order: 'timestamp_added', dir: 'desc', limit: size });
  return (data.items ?? []).map(toAlbum);
}

export async function getFrequentAlbums({ size = 20 } = {}): Promise<any[]> {
  const data = await apiGet('/albums', { order: 'play_count', dir: 'desc', limit: size });
  return (data.items ?? []).map(toAlbum);
}

export async function getArtistInfo(_id: string, _opts = {}): Promise<any | null> {
  // MA DB has no similar-artist data. Returning null makes the picker skip
  // the similar-artist source gracefully (it guards with info?.similarArtist).
  return null;
}

export async function getTopSongs(artistName: string, { count = 10 } = {}): Promise<any[]> {
  try {
    const artists = await searchArtists(artistName, { artistCount: 1 });
    if (artists.length === 0) return [];
    const data = await apiGet(`/artists/${artists[0].id}/tracks`, {
      order: 'random',
      limit: count,
    });
    return (data.items ?? []).map(toSong);
  } catch {
    return [];
  }
}

export async function getAlbum(id: string): Promise<any[]> {
  const data = await apiGet(`/albums/${id}/tracks`);
  return (data.items ?? []).map(toSong);
}

export async function getSong(id: string): Promise<any | null> {
  const t = await getTrackById(Number(id));
  return t ?? null;
}

export async function getArtist(id: string): Promise<any | null> {
  try {
    return await apiGet(`/artists/${id}`);
  } catch {
    return null;
  }
}

export async function searchArtists(query: string, { artistCount = 5 } = {}): Promise<any[]> {
  const data = await apiGet('/search', { q: query, limit: artistCount });
  return (data.artists ?? []).map((a: any) => ({
    id: String(a.id),
    name: a.name ?? '',
  }));
}

export async function getArtistLastfmTags(_id: string, _opts = {}): Promise<string[]> {
  return [];
}

// ---------------------------------------------------------------------------
// Fuzzy artist resolution (MA mode)
// ---------------------------------------------------------------------------
// Mirrors subsonic.ts's resolveArtist: the sidecar's /search is exact/substring
// matching only, so a transliteration variance or dropped accent returns zero
// hits. Reuse the same normalise → exact-match → fuzzy-rank approach against
// searchArtists, the one artist-lookup endpoint the sidecar actually exposes.

function normArtistName(s: string): string {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')                       // punctuation → space
    .replace(/\s+/g, ' ')
    .trim();
}

function artistEditDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

function artistSimilarity(a: string, b: string): number {
  const longer = Math.max(a.length, b.length);
  if (longer === 0) return 1;
  return 1 - artistEditDistance(a, b) / longer;
}

const MA_ARTIST_MATCH_THRESHOLD = 0.82; // same tuning as subsonic.ts

export async function resolveArtist(name: string, { artistCount = 10 } = {}): Promise<any | null> {
  const query = normArtistName(name);
  if (!query) return null;

  // 1. Exact hit — fast path for correctly-spelled names.
  const exact = await searchArtists(name, { artistCount });
  const direct = exact.find((a: any) => normArtistName(a.name) === query);
  if (direct) return direct;

  // 2. Relax — the sidecar's /search has no per-token artist index endpoint,
  //    so retry the same search with each token of the query (still hits the
  //    same /search route, just with a narrower string).
  const tokens = query.split(' ').filter((t) => t.length >= 2);
  const candidates = new Map<string, any>();
  for (const a of exact) candidates.set(a.id, a);
  for (const token of tokens) {
    try {
      for (const a of await searchArtists(token, { artistCount })) {
        candidates.set(a.id, a);
      }
    } catch {}
  }
  if (candidates.size === 0) return null;

  // 3. Fuzzy-rank against the full request, same shared-token guard as subsonic.ts.
  const queryTokens = new Set(tokens);
  const requireShared = queryTokens.size >= 2;
  let best: any = null;
  let bestScore = 0;
  for (const a of candidates.values()) {
    const cand = normArtistName(a.name);
    if (requireShared && !cand.split(' ').some((t) => queryTokens.has(t))) continue;
    const score = artistSimilarity(query, cand);
    if (score > bestScore) { bestScore = score; best = a; }
  }
  return bestScore >= MA_ARTIST_MATCH_THRESHOLD ? best : null;
}

// An artist's most recent releases, newest first. Mirrors subsonic.ts's
// getRecentSongsByArtist but ranks by `year` only — the sidecar's artist/album
// payload doesn't carry the precise originalReleaseDate/releaseDate fields
// Navidrome's OpenSubsonic extension provides, so this is a coarser
// (year-only) recency signal. Falls back to [] if the artist can't be
// resolved or has no track listing.
export async function getRecentSongsByArtist(
  artistName: string,
  { albums = 3, count = 20 }: { albums?: number; count?: number } = {},
): Promise<any[]> {
  const artist = await resolveArtist(artistName);
  if (!artist?.id) return [];
  try {
    const data = await apiGet(`/artists/${artist.id}/tracks`, {
      order: 'year',
      dir: 'desc',
      limit: Math.max(count, albums * 10), // tracks, not albums — sidecar has no per-artist album listing
    });
    return ((data.items ?? []).map(toSong)).slice(0, count);
  } catch {
    return [];
  }
}

export async function getLyrics(songId: string): Promise<string> {
  try {
    const t = await apiGet(`/tracks/${songId}`, { include: 'lyrics' });
    return t.lyrics ?? '';
  } catch {
    return '';
  }
}

export async function* iterateAllSongs(): AsyncGenerator<any> {
  const pageSize = 500;
  let offset = 0;
  while (true) {
    const data = await apiGet('/tracks', { limit: pageSize, offset });
    const items: any[] = data.items ?? [];
    for (const t of items) yield toSong(t);
    if (offset + items.length >= (data.total ?? 0) || items.length === 0) break;
    offset += items.length;
  }
}

export async function getPlaylists(): Promise<any[]> {
  const data = await apiGet('/playlists');
  return (data.items ?? []).map((p: any) => ({
    id: String(p.id),
    name: p.name ?? '',
  }));
}

export async function getPlaylist(_id: string): Promise<any[]> {
  // MA playlists are virtual — the DB has no track-list junction table.
  return [];
}

// ---------------------------------------------------------------------------
// URI / cover helpers — match subsonic.ts signatures exactly
// ---------------------------------------------------------------------------

export function getCoverArtUrl(id: string, _size = 512): string {
  return `${baseUrl()}/api/v1/tracks/${id}/cover`;
}

export function getStreamUrl(_songId: string): string {
  // In MA API mode all playback is via local file paths — this should never
  // be called. Return empty string so callers that fall back to getPlayableUri
  // can detect the missing path and skip the track.
  return '';
}

export function getRawStreamUrl(_songId: string): string {
  return '';
}

export function getLocalPath(song: any): string | null {
  const root = config.maDbApi.musicRoot || '';
  if (!root || !song.path) return null;
  return `${root}/${song.path}`;
}

export function getPlayableUri(song: any): string {
  return getLocalPath(song) || '';
}

function escAnnotate(s: any): string {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function getAnnotatedUri(song: any): string {
  const fields = [
    `title="${escAnnotate(song.title)}"`,
    `artist="${escAnnotate(song.artist)}"`,
    `album="${escAnnotate(song.album)}"`,
    // radio.liq's on_meta reads this exact key for MA-mode tracks and forwards
    // it into now-playing.json as ma_id — NOT subsonic_id (that key is for the
    // Navidrome backend's own getAnnotatedUri in subsonic.ts). Using the wrong
    // key here meant every MA-mode now-playing payload had a real id sitting
    // under subsonic_id and an always-empty ma_id, breaking the web player's
    // cover art lookup (keyed by ma_id) and the controller's queue-matching
    // (queue.ts reads np.ma_id) for the entire MA backend.
    `ma_id="${escAnnotate(song.id)}"`,
  ];
  if (song.year) fields.push(`year="${escAnnotate(song.year)}"`);
  if (song.genre) fields.push(`genre="${escAnnotate(song.genre)}"`);
  if (song.crossSec != null) fields.push(`liq_cross_duration="${escAnnotate(song.crossSec)}"`);
  if (song.gainDb != null) fields.push(`liq_amplify="${escAnnotate(song.gainDb)} dB"`);
  const uri = getPlayableUri(song);
  return `annotate:${fields.join(',')}:${uri}`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function getTrackById(id: number): Promise<any | null> {
  try {
    const t = await apiGet(`/tracks/${id}`, { include: 'analysis' });
    return toSong(t);
  } catch {
    return null;
  }
}
