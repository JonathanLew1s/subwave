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

export async function apiGet<T = any>(path: string, params: Record<string, any> = {}, timeoutMs = 10_000): Promise<T> {
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
    genre: t.genre ?? null,
    duration: t.duration ?? null,
    path: t.file_path ?? null,   // relative path — used by getLocalPath / getAnnotatedUri
    coverArt: String(t.id),      // getCoverArtUrl / /cover/:id use this
    favorite: t.favorite ?? false,
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

export async function getSongsByGenre(genre: string, { count = 20 } = {}): Promise<any[]> {
  const data = await apiGet('/tracks', { genre, order: 'random', limit: count });
  return (data.items ?? []).map(toSong);
}

export async function getGenres(): Promise<any[]> {
  try {
    const data = await apiGet('/health/detailed');
    const genres: Record<string, number> = data.genres ?? {};
    return Object.entries(genres)
      .sort((a, b) => b[1] - a[1])
      .map(([value, songCount]) => ({ value, songCount }));
  } catch {
    return [];
  }
}

export async function resolveGenreName(name: string): Promise<string | null> {
  return name; // MA genre names are already normalised
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

export async function getLyrics(_songId: string): Promise<string> {
  return '';
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
    `subsonic_id="${escAnnotate(song.id)}"`,  // radio.liq reads this key for /cover/:id
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
