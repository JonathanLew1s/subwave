// Music Assistant library backend.
// Implements the same interface as subsonic.ts so library-backend.ts can
// route to either without callers knowing the difference.
//
// Streams: local file paths via MA_MUSIC_ROOT — no HTTP, no transcoding.
// Discovery: Music Assistant REST API (MA_URL / MA_API_KEY).
//
// Functions that have no MA equivalent return sensible empty values so the
// picker / tagger degrade gracefully. Where MA has a different but useful
// equivalent (e.g. similar tracks) we use it.
//
// NOTE: MA REST endpoints verified against MA 2.x. The /api/music/* paths
// below are stable public API; the /api/music/search shape may vary by version.

import path from 'node:path';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

async function maCall<T = any>(endpoint: string, params: Record<string, string | number> = {}): Promise<T> {
  const url = new URL(`${config.musicAssistant.url}${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (config.musicAssistant.apiKey) headers['Authorization'] = config.musicAssistant.apiKey;
  const res = await fetch(url.toString(), { headers });
  if (!res.ok) {
    let body = '';
    try { body = (await res.text()).slice(0, 200); } catch {}
    throw new Error(`MA ${endpoint} failed: ${res.status}${body ? ` — ${body}` : ''}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Song normalisation — MA track shape → SUB/WAVE song shape
// ---------------------------------------------------------------------------
// MA returns `artists` as an array; callers expect a single `artist` string.
// `id` in the returned object is what callers pass back into other functions.

function normaliseSong(t: any): any {
  if (!t) return null;
  const artistName: string =
    Array.isArray(t.artists) && t.artists.length
      ? t.artists.map((a: any) => a.name ?? a).filter(Boolean).join(', ')
      : (t.artist_str ?? t.artist ?? '');
  const albumName: string = t.album?.name ?? t.album_str ?? '';
  const year: number | undefined = t.year ?? t.album?.year ?? undefined;
  // provider_mappings supplies the relative file path; MA track objects carry
  // it as `provider_mappings[filesystem_local]` or flatten it on some endpoints.
  const filePath: string = t.provider_mappings?.filesystem_local
    ?? t.uri
    ?? t.path
    ?? '';
  return {
    id: String(t.item_id ?? t.id),
    title: t.name ?? '',
    artist: artistName,
    album: albumName,
    year,
    genre: Array.isArray(t.metadata?.genres) ? t.metadata.genres[0] : undefined,
    duration: t.duration,
    path: filePath,
    albumId: t.album?.item_id ? String(t.album.item_id) : undefined,
    artistId: Array.isArray(t.artists) && t.artists[0] ? String(t.artists[0].item_id) : undefined,
    coverArt: String(t.item_id ?? t.id),
    // Pass through for iterateAllSongs → tagger/sync
    _maRaw: t,
  };
}

function normaliseSongs(arr: any[]): any[] {
  return (arr || []).map(normaliseSong).filter(Boolean);
}

function normaliseAlbum(a: any): any {
  if (!a) return null;
  return {
    id: String(a.item_id ?? a.id),
    name: a.name ?? '',
    artist: Array.isArray(a.artists) ? a.artists.map((x: any) => x.name ?? x).join(', ') : '',
    year: a.year ?? undefined,
    coverArt: String(a.item_id ?? a.id),
  };
}

// ---------------------------------------------------------------------------
// isStationArchive — always false for MA backend (MA doesn't scan archive/)
// ---------------------------------------------------------------------------
export function isStationArchive(_song: any): boolean {
  return false;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export async function search(query: string, { songCount = 20, songOffset = 0 } = {}): Promise<any[]> {
  try {
    const r = await maCall('/api/music/search', { query, media_type: 'track', limit: songCount, offset: songOffset });
    const tracks = r.tracks ?? r.items ?? r ?? [];
    return normaliseSongs(Array.isArray(tracks) ? tracks : []);
  } catch { return []; }
}

export async function getRandomSongs({ size = 20, genre, fromYear, toYear }: {
  size?: number; genre?: string; fromYear?: number; toYear?: number
} = {}): Promise<any[]> {
  try {
    const params: Record<string, string | number> = { order: 'random', limit: size };
    if (genre) params.genre = genre;
    if (fromYear) params.year_start = fromYear;
    if (toYear) params.year_end = toYear;
    const r = await maCall('/api/music/tracks', params);
    const items = r.items ?? r ?? [];
    return normaliseSongs(Array.isArray(items) ? items : []);
  } catch { return []; }
}

export async function getSongsByGenre(genre: string, { count = 20 } = {}): Promise<any[]> {
  try {
    const r = await maCall('/api/music/tracks', { genre, limit: count });
    const items = r.items ?? r ?? [];
    return normaliseSongs(Array.isArray(items) ? items : []);
  } catch { return []; }
}

export async function getGenres(): Promise<any[]> {
  try {
    const r = await maCall('/api/music/genres');
    const items = r.items ?? r ?? [];
    return (Array.isArray(items) ? items : []).map((g: any) => ({
      value: g.name ?? g,
      songCount: g.track_count ?? 0,
      albumCount: g.album_count ?? 0,
    }));
  } catch { return []; }
}

export async function resolveGenreName(name: string): Promise<string | null> {
  if (!name) return null;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = norm(name);
  if (!target) return null;
  const genres = await getGenres();
  let hit = genres.find(g => norm(g.value) === target);
  if (!hit) {
    hit = genres.find(g => {
      const gv = norm(g.value);
      return gv && (gv.includes(target) || target.includes(gv));
    });
  }
  return hit?.value || null;
}

export async function getSimilarSongs(id: string, { count = 20 } = {}): Promise<any[]> {
  try {
    const r = await maCall(`/api/music/tracks/${id}/similar`, { limit: count });
    const items = r.items ?? r ?? [];
    return normaliseSongs(Array.isArray(items) ? items : []);
  } catch { return []; }
}

// MA has no sonicSimilarity extension concept
export async function supportsSonicSimilarity(): Promise<boolean> {
  return false;
}

export async function getSonicSimilarTracks(id: string, { count = 20 } = {}): Promise<any[]> {
  // Delegate to getSimilarSongs — MA's similarity uses acoustic analysis
  return getSimilarSongs(id, { count });
}

export async function getStarred(): Promise<any[]> {
  try {
    const r = await maCall('/api/music/tracks', { in_library: 'true', order: 'random', limit: 50 });
    const items = r.items ?? r ?? [];
    return normaliseSongs(Array.isArray(items) ? items : []);
  } catch { return []; }
}

export async function getAlbumList(offset = 0, size = 500): Promise<any[]> {
  try {
    const r = await maCall('/api/music/albums', { order: 'name', limit: size, offset });
    const items = r.items ?? r ?? [];
    return (Array.isArray(items) ? items : []).map(normaliseAlbum).filter(Boolean);
  } catch { return []; }
}

export async function getRecentlyAddedAlbums({ size = 20 } = {}): Promise<any[]> {
  try {
    const r = await maCall('/api/music/albums', { order: 'timestamp_added', sort_dir: 'desc', limit: size });
    const items = r.items ?? r ?? [];
    return (Array.isArray(items) ? items : []).map(normaliseAlbum).filter(Boolean);
  } catch { return []; }
}

export async function getFrequentAlbums({ size = 20 } = {}): Promise<any[]> {
  try {
    const r = await maCall('/api/music/albums', { order: 'play_count', sort_dir: 'desc', limit: size });
    const items = r.items ?? r ?? [];
    return (Array.isArray(items) ? items : []).map(normaliseAlbum).filter(Boolean);
  } catch { return []; }
}

// MA has artist info but no Last.fm similar-artist chain
export async function getArtistInfo(id: string, { count: _count = 10 } = {}): Promise<any | null> {
  try {
    const r = await maCall(`/api/music/artists/${id}`);
    return r ? { name: r.name, similarArtist: [] } : null;
  } catch { return null; }
}

export async function getTopSongs(artistName: string, { count = 10 } = {}): Promise<any[]> {
  try {
    const artists = await searchArtists(artistName, { artistCount: 1 });
    if (!artists.length) return [];
    const r = await maCall(`/api/music/artists/${artists[0].id}/tracks`, { limit: count, order: 'play_count', sort_dir: 'desc' });
    const items = r.items ?? r ?? [];
    return normaliseSongs(Array.isArray(items) ? items : []);
  } catch { return []; }
}

export async function getAlbum(id: string): Promise<any[]> {
  try {
    const r = await maCall(`/api/music/albums/${id}/tracks`);
    const items = r.items ?? r ?? [];
    return normaliseSongs(Array.isArray(items) ? items : []);
  } catch { return []; }
}

export async function getSong(id: string): Promise<any | null> {
  try {
    const r = await maCall(`/api/music/tracks/${id}`);
    return r ? normaliseSong(r) : null;
  } catch { return null; }
}

export async function getArtist(id: string): Promise<any | null> {
  try {
    const r = await maCall(`/api/music/artists/${id}`);
    if (!r) return null;
    const albums = await maCall(`/api/music/artists/${id}/albums`);
    return {
      id: String(r.item_id ?? r.id),
      name: r.name ?? '',
      albumCount: albums?.total ?? 0,
      album: (albums?.items ?? []).map(normaliseAlbum),
    };
  } catch { return null; }
}

export async function searchArtists(query: string, { artistCount = 5 } = {}): Promise<any[]> {
  try {
    const r = await maCall('/api/music/search', { query, media_type: 'artist', limit: artistCount });
    const artists = r.artists ?? r.items ?? r ?? [];
    return (Array.isArray(artists) ? artists : []).map((a: any) => ({
      id: String(a.item_id ?? a.id),
      name: a.name ?? '',
    }));
  } catch { return []; }
}

// MA doesn't expose per-artist Last.fm tags via REST
export async function getArtistLastfmTags(_id: string, { count: _count = 20 } = {}): Promise<string[]> {
  return [];
}

// MA stores lyrics in track metadata — try the REST endpoint
export async function getLyrics(songId: string): Promise<string> {
  try {
    const r = await maCall(`/api/music/tracks/${songId}`);
    const lyrics = r?.metadata?.lyrics;
    if (!lyrics) return '';
    // MA lyrics are an array of {time_offset, text} objects
    if (Array.isArray(lyrics)) {
      return lyrics.map((l: any) => l.text ?? l.value ?? l).filter((s: any) => typeof s === 'string').join(' ');
    }
    if (typeof lyrics === 'string') return lyrics;
    return '';
  } catch { return ''; }
}

// Async iterator over all tracks in the MA library (paginated REST calls).
// Callers (tagger, analyzer) use this for the library walk phase.
export async function* iterateAllSongs(): AsyncGenerator<any> {
  const PAGE = 200;
  let offset = 0;
  while (true) {
    const r = await maCall('/api/music/tracks', { limit: PAGE, offset, in_library: 'true' });
    const items: any[] = r.items ?? r ?? [];
    if (!Array.isArray(items) || items.length === 0) break;
    for (const t of items) {
      const s = normaliseSong(t);
      if (s) yield s;
    }
    if (items.length < PAGE) break;
    offset += items.length;
  }
}

export async function getPlaylists(): Promise<any[]> {
  try {
    const r = await maCall('/api/music/playlists');
    const items = r.items ?? r ?? [];
    return (Array.isArray(items) ? items : []).map((p: any) => ({
      id: String(p.item_id ?? p.id),
      name: p.name ?? '',
      songCount: p.track_count ?? 0,
    }));
  } catch { return []; }
}

export async function getPlaylist(id: string): Promise<any[]> {
  try {
    const r = await maCall(`/api/music/playlists/${id}/tracks`);
    const items = r.items ?? r ?? [];
    return normaliseSongs(Array.isArray(items) ? items : []);
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// URI / cover art
// ---------------------------------------------------------------------------

// Cover art URL — MA thumbnail endpoint. The controller proxies this through
// /cover/:id so listener browsers never see MA credentials.
export function getCoverArtUrl(id: string, _size = 512): string {
  return `${config.musicAssistant.url}/api/music/tracks/${id}/thumb`;
}

// Local file path for a normalised song object (requires MA_MUSIC_ROOT to be set).
export function getLocalPath(song: any): string | null {
  const musicRoot = config.musicAssistant.musicRoot;
  if (!musicRoot || !song.path) return null;
  return path.join(musicRoot, song.path);
}

// For MA backend, streaming is always local file access — no HTTP stream needed.
// Returns a file:// URI for Liquidsoap, or empty string if music root isn't set.
export function getStreamUrl(song: any): string {
  const local = getLocalPath(song);
  if (!local) {
    console.warn(`[ma-api] MA_MUSIC_ROOT not set or song has no path: ${song.id}`);
    return '';
  }
  return `file://${local}`;
}

// Used by analyze-library.ts for raw audio access. For MA backend, this is
// the local file path (much better than HTTP streaming for analysis).
export function getRawStreamUrl(song: any): string {
  return getLocalPath(song) ?? '';
}

// Best URI for Liquidsoap — always local file for MA backend
export function getPlayableUri(song: any): string {
  return getStreamUrl(song);
}

function escAnnotate(s: any): string {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Annotated URI for Liquidsoap — same pattern as subsonic.ts but uses
// `ma_id` instead of `subsonic_id` so radio.liq can route cover art requests
// to the MA thumbnail endpoint.
export function getAnnotatedUri(song: any): string {
  const fields = [
    `title="${escAnnotate(song.title)}"`,
    `artist="${escAnnotate(song.artist)}"`,
    `album="${escAnnotate(song.album)}"`,
    `ma_id="${escAnnotate(song.id)}"`,
  ];
  if (song.year) fields.push(`year="${escAnnotate(song.year)}"`);
  if (song.genre) fields.push(`genre="${escAnnotate(song.genre)}"`);
  if (song.crossSec != null) fields.push(`liq_cross_duration="${escAnnotate(song.crossSec)}"`);
  if (song.gainDb != null) fields.push(`liq_amplify="${escAnnotate(song.gainDb)} dB"`);
  return `annotate:${fields.join(',')}:${getPlayableUri(song)}`;
}
