// Music Assistant library backend.
// Implements the same interface as subsonic.ts so library-backend.ts can
// route to either without callers knowing the difference.
//
// Transport: Music Assistant WebSocket API at ws://{MA_URL}/ws
// Auth: MA_API_TOKEN (long-lived JWT from MA Profile → Long-lived tokens)
//   or MA_USERNAME + MA_PASSWORD (auto-login via auth/login command)
//
// Streams: local file paths via MA_MUSIC_ROOT — no HTTP, no transcoding.
// Discovery: MA WebSocket API commands (music/tracks/library_items, etc.)

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// WebSocket client
// ---------------------------------------------------------------------------

interface PendingCall {
  chunks: any[];
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

type WSState = 'disconnected' | 'connecting' | 'ready';

class MAWebSocketClient {
  private ws: WebSocket | null = null;
  private state: WSState = 'disconnected';
  private pending = new Map<string, PendingCall>();
  private token: string | null = null;
  private connectPromise: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 2000;

  // Returns a ready connection, creating one if needed.
  async connect(): Promise<void> {
    if (this.state === 'ready') return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this._connect().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async _connect(): Promise<void> {
    // Resolve auth token once
    if (!this.token) {
      this.token = await this._resolveToken();
    }

    const wsUrl = config.musicAssistant.url.replace(/^https?/, (m) =>
      m === 'https' ? 'wss' : 'ws',
    ) + '/ws';

    return new Promise<void>((resolve, reject) => {
      this.state = 'connecting';
      const ws = new WebSocket(wsUrl);
      let greeted = false;
      // auth message_id so we can match the auth response
      const authMsgId = randomUUID();

      ws.addEventListener('open', () => {
        // WS connected, wait for server greeting before sending auth
      });

      ws.addEventListener('message', (event) => {
        let msg: any;
        try {
          msg = JSON.parse(event.data as string);
        } catch {
          return;
        }

        // First message with no message_id = server greeting
        if (!greeted && !('message_id' in msg)) {
          greeted = true;
          ws.send(JSON.stringify({
            message_id: authMsgId,
            command: 'auth',
            args: { token: this.token },
          }));
          return;
        }

        const { message_id, result, error_code, details, partial } = msg;

        // Route auth response
        if (message_id === authMsgId) {
          if (error_code) {
            this.state = 'disconnected';
            ws.close();
            reject(new Error(`MA auth failed (${error_code}): ${details}`));
          } else {
            this.ws = ws;
            this.state = 'ready';
            this.reconnectDelay = 2000;
            resolve();
          }
          return;
        }

        // Route to pending call
        const call = this.pending.get(message_id);
        if (!call) return; // event message or already cleaned up

        if (error_code) {
          this.pending.delete(message_id);
          call.reject(new Error(`MA error (${error_code}): ${details}`));
          return;
        }

        // MA sends partial=true for large array results, final has partial=false
        if (Array.isArray(result)) {
          call.chunks.push(...result);
        }

        if (!partial) {
          this.pending.delete(message_id);
          // If result was built up from partials, use accumulated chunks;
          // otherwise use the single result directly
          const finalResult = call.chunks.length > 0 ? call.chunks : result;
          call.resolve(finalResult);
        }
      });

      ws.addEventListener('error', (err) => {
        console.error('[ma-api] WebSocket error:', (err as any).message ?? err);
      });

      ws.addEventListener('close', () => {
        this.ws = null;
        this.state = 'disconnected';
        if (this.connectPromise) {
          // Reject the in-progress auth if not yet resolved
          reject(new Error('MA WebSocket closed before auth'));
        }
        // Reject any outstanding calls
        for (const [, call] of this.pending) {
          call.reject(new Error('MA WebSocket disconnected'));
        }
        this.pending.clear();
        this._scheduleReconnect();
      });
    });
  }

  private _scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Reconnection happens lazily on next call() — state is already 'disconnected'
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
  }

  private async _resolveToken(): Promise<string> {
    if (config.musicAssistant.apiToken) {
      return config.musicAssistant.apiToken;
    }
    if (config.musicAssistant.username && config.musicAssistant.password) {
      return this._login();
    }
    throw new Error(
      'MA auth not configured. Set MA_API_TOKEN, or MA_USERNAME + MA_PASSWORD.',
    );
  }

  // auth/login via HTTP JSON-RPC (no auth required for this command).
  // The HTTP /api endpoint returns the handler's return value directly (no envelope).
  private async _login(): Promise<string> {
    const resp = await fetch(`${config.musicAssistant.url}/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message_id: randomUUID(),
        command: 'auth/login',
        args: {
          username: config.musicAssistant.username,
          password: config.musicAssistant.password,
          device_name: 'subwave',
        },
      }),
    });
    if (!resp.ok) throw new Error(`MA auth/login failed: HTTP ${resp.status}`);
    const data = await resp.json() as any;
    // HTTP /api returns the raw handler result; auth/login returns {success, access_token, error}
    if (!data.success || !data.access_token) {
      throw new Error(`MA login failed: ${data.error ?? 'invalid credentials'}`);
    }
    return data.access_token as string;
  }

  // Send a command and wait for the response.
  async call<T = any>(command: string, args: Record<string, any> = {}): Promise<T> {
    await this.connect();

    const messageId = randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(messageId, { chunks: [], resolve, reject });
      this.ws!.send(JSON.stringify({ message_id: messageId, command, args }));
    });
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.state = 'disconnected';
    this.token = null;
  }
}

// Module-level singleton
const maClient = new MAWebSocketClient();

// ---------------------------------------------------------------------------
// Song normalisation — MA track shape → SUB/WAVE song shape
// ---------------------------------------------------------------------------

function getFilesystemPath(t: any): string {
  const mappings: any[] = t.provider_mappings ?? [];
  const fsMap = mappings.find((m: any) => m.provider_domain === 'filesystem_local');
  return fsMap?.item_id ?? '';
}

function normaliseSong(t: any): any {
  if (!t) return null;
  const artistName: string =
    Array.isArray(t.artists) && t.artists.length
      ? t.artists.map((a: any) => a.name ?? '').filter(Boolean).join(', ')
      : (t.artist_str ?? '');
  const albumObj = t.track_album ?? t.album ?? null;
  const albumName: string = albumObj?.name ?? '';
  const year: number | undefined = albumObj?.year ?? undefined;
  const filePath = getFilesystemPath(t);

  // Genre: MA stores genres in metadata as [{name: "Rock"}, ...] objects
  let genre: string | undefined;
  const genreList = t.metadata?.genres ?? t.genres ?? [];
  if (Array.isArray(genreList) && genreList.length) {
    const g = genreList[0];
    genre = typeof g === 'string' ? g : (g?.name ?? undefined);
  }

  return {
    id: String(t.item_id),
    title: t.name ?? '',
    artist: artistName,
    album: albumName,
    year,
    genre,
    duration: t.duration,
    path: filePath,
    albumId: albumObj?.item_id ? String(albumObj.item_id) : undefined,
    artistId: Array.isArray(t.artists) && t.artists[0] ? String(t.artists[0].item_id) : undefined,
    coverArt: String(t.item_id),
    _maRaw: t,
  };
}

function normaliseSongs(arr: any[]): any[] {
  return (arr || []).map(normaliseSong).filter(Boolean);
}

function normaliseAlbum(a: any): any {
  if (!a) return null;
  const artistName = Array.isArray(a.artists)
    ? a.artists.map((x: any) => x.name ?? '').join(', ')
    : '';
  return {
    id: String(a.item_id),
    name: a.name ?? '',
    artist: artistName,
    year: a.year ?? undefined,
    coverArt: String(a.item_id),
  };
}

// ---------------------------------------------------------------------------
// isStationArchive — always false (MA doesn't scan archive/)
// ---------------------------------------------------------------------------
export function isStationArchive(_song: any): boolean {
  return false;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export async function search(query: string, { songCount = 20, songOffset: _songOffset = 0 } = {}): Promise<any[]> {
  try {
    const r = await maClient.call('music/search', {
      search_query: query,
      media_types: ['track'],
      limit: songCount,
      library_only: true,
    });
    const tracks = r?.tracks ?? r ?? [];
    return normaliseSongs(Array.isArray(tracks) ? tracks : []);
  } catch (e) {
    console.warn('[ma-api] search failed:', (e as Error).message);
    return [];
  }
}

export async function getRandomSongs({ size = 20, genre }: {
  size?: number; genre?: string; fromYear?: number; toYear?: number
} = {}): Promise<any[]> {
  try {
    const args: Record<string, any> = { order_by: 'random', limit: size };
    if (genre) args.genre = genre;
    const items = await maClient.call<any[]>('music/tracks/library_items', args);
    return normaliseSongs(Array.isArray(items) ? items : []);
  } catch (e) {
    console.warn('[ma-api] getRandomSongs failed:', (e as Error).message);
    return [];
  }
}

export async function getSongsByGenre(genre: string, { count = 20 } = {}): Promise<any[]> {
  try {
    const items = await maClient.call<any[]>('music/tracks/library_items', {
      genre,
      order_by: 'random',
      limit: count,
    });
    return normaliseSongs(Array.isArray(items) ? items : []);
  } catch (e) {
    console.warn('[ma-api] getSongsByGenre failed:', (e as Error).message);
    return [];
  }
}

export async function getGenres(): Promise<any[]> {
  try {
    const items = await maClient.call<any[]>('music/genres/library_items', {
      media_type: 'track',
      hide_empty: true,
      limit: 500,
    });
    return (Array.isArray(items) ? items : []).map((g: any) => ({
      value: g.name ?? '',
      songCount: 0,
      albumCount: 0,
    }));
  } catch (e) {
    console.warn('[ma-api] getGenres failed:', (e as Error).message);
    return [];
  }
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
  return hit?.value ?? null;
}

export async function getSimilarSongs(id: string, { count = 20 } = {}): Promise<any[]> {
  try {
    // MA similar_tracks requires a provider domain; for library tracks use "library"
    const items = await maClient.call<any[]>('music/tracks/similar_tracks', {
      item_id: id,
      provider_instance_id_or_domain: 'library',
      limit: count,
    });
    return normaliseSongs(Array.isArray(items) ? items : []);
  } catch (e) {
    console.warn('[ma-api] getSimilarSongs failed (no similar-tracks provider?):', (e as Error).message);
    return [];
  }
}

// MA has no sonicSimilarity extension concept
export async function supportsSonicSimilarity(): Promise<boolean> {
  return false;
}

export async function getSonicSimilarTracks(id: string, { count = 20 } = {}): Promise<any[]> {
  return getSimilarSongs(id, { count });
}

export async function getStarred(): Promise<any[]> {
  try {
    const items = await maClient.call<any[]>('music/tracks/library_items', {
      favorite: true,
      order_by: 'random',
      limit: 50,
    });
    return normaliseSongs(Array.isArray(items) ? items : []);
  } catch (e) {
    console.warn('[ma-api] getStarred failed:', (e as Error).message);
    return [];
  }
}

export async function getAlbumList(offset = 0, size = 500): Promise<any[]> {
  try {
    const items = await maClient.call<any[]>('music/albums/library_items', {
      order_by: 'sort_name',
      limit: size,
      offset,
    });
    return (Array.isArray(items) ? items : []).map(normaliseAlbum).filter(Boolean);
  } catch (e) {
    console.warn('[ma-api] getAlbumList failed:', (e as Error).message);
    return [];
  }
}

export async function getRecentlyAddedAlbums({ size = 20 } = {}): Promise<any[]> {
  try {
    const items = await maClient.call<any[]>('music/albums/library_items', {
      order_by: 'timestamp_added_desc',
      limit: size,
    });
    return (Array.isArray(items) ? items : []).map(normaliseAlbum).filter(Boolean);
  } catch (e) {
    console.warn('[ma-api] getRecentlyAddedAlbums failed:', (e as Error).message);
    return [];
  }
}

export async function getFrequentAlbums({ size = 20 } = {}): Promise<any[]> {
  try {
    const items = await maClient.call<any[]>('music/albums/library_items', {
      order_by: 'play_count_desc',
      limit: size,
    });
    return (Array.isArray(items) ? items : []).map(normaliseAlbum).filter(Boolean);
  } catch (e) {
    console.warn('[ma-api] getFrequentAlbums failed:', (e as Error).message);
    return [];
  }
}

export async function getArtistInfo(id: string, { count: _count = 10 } = {}): Promise<any | null> {
  try {
    const r = await maClient.call('music/artists/get', {
      item_id: id,
      provider_instance_id_or_domain: 'library',
    });
    if (!r) return null;
    return { name: r.name, similarArtist: [] };
  } catch (e) {
    console.warn('[ma-api] getArtistInfo failed:', (e as Error).message);
    return null;
  }
}

export async function getTopSongs(artistName: string, { count = 10 } = {}): Promise<any[]> {
  try {
    const artists = await maClient.call<any[]>('music/artists/library_items', {
      search: artistName,
      limit: 1,
    });
    if (!Array.isArray(artists) || !artists.length) return [];
    const artistId = String(artists[0].item_id);
    const tracks = await maClient.call<any[]>('music/artists/top_tracks', {
      item_id: artistId,
      provider_instance_id_or_domain: 'library',
    });
    return normaliseSongs((Array.isArray(tracks) ? tracks : []).slice(0, count));
  } catch (e) {
    console.warn('[ma-api] getTopSongs failed:', (e as Error).message);
    return [];
  }
}

export async function getAlbum(id: string): Promise<any[]> {
  try {
    const tracks = await maClient.call<any[]>('music/albums/album_tracks', {
      item_id: id,
      provider_instance_id_or_domain: 'library',
    });
    return normaliseSongs(Array.isArray(tracks) ? tracks : []);
  } catch (e) {
    console.warn('[ma-api] getAlbum failed:', (e as Error).message);
    return [];
  }
}

export async function getSong(id: string): Promise<any | null> {
  try {
    const r = await maClient.call('music/tracks/get', {
      item_id: id,
      provider_instance_id_or_domain: 'library',
    });
    return r ? normaliseSong(r) : null;
  } catch (e) {
    console.warn('[ma-api] getSong failed:', (e as Error).message);
    return null;
  }
}

export async function getArtist(id: string): Promise<any | null> {
  try {
    const [r, albums] = await Promise.all([
      maClient.call('music/artists/get', {
        item_id: id,
        provider_instance_id_or_domain: 'library',
      }),
      maClient.call<any[]>('music/artists/artist_albums', {
        item_id: id,
        provider_instance_id_or_domain: 'library',
      }),
    ]);
    if (!r) return null;
    const albumList = Array.isArray(albums) ? albums : [];
    return {
      id: String(r.item_id),
      name: r.name ?? '',
      albumCount: albumList.length,
      album: albumList.map(normaliseAlbum).filter(Boolean),
    };
  } catch (e) {
    console.warn('[ma-api] getArtist failed:', (e as Error).message);
    return null;
  }
}

export async function searchArtists(query: string, { artistCount = 5 } = {}): Promise<any[]> {
  try {
    const r = await maClient.call('music/search', {
      search_query: query,
      media_types: ['artist'],
      limit: artistCount,
      library_only: true,
    });
    const artists = r?.artists ?? (Array.isArray(r) ? r : []);
    return (Array.isArray(artists) ? artists : []).map((a: any) => ({
      id: String(a.item_id),
      name: a.name ?? '',
    }));
  } catch (e) {
    console.warn('[ma-api] searchArtists failed:', (e as Error).message);
    return [];
  }
}

export async function getArtistLastfmTags(_id: string, { count: _count = 20 } = {}): Promise<string[]> {
  return [];
}

export async function getLyrics(songId: string): Promise<string> {
  try {
    const r = await maClient.call('metadata/get_track_lyrics', { item_id: songId });
    if (!r) return '';
    if (Array.isArray(r)) {
      return r.map((l: any) => l.text ?? l.value ?? '').filter(Boolean).join(' ');
    }
    return typeof r === 'string' ? r : '';
  } catch (e) {
    console.warn('[ma-api] getLyrics failed:', (e as Error).message);
    return '';
  }
}

// Async iterator over all tracks (paginated via library_items).
// Used by the tagger and analyzer for the library walk phase.
export async function* iterateAllSongs(): AsyncGenerator<any> {
  const PAGE = 200;
  let offset = 0;
  while (true) {
    let items: any[];
    try {
      items = await maClient.call<any[]>('music/tracks/library_items', {
        limit: PAGE,
        offset,
        order_by: 'sort_name',
      });
    } catch (e) {
      console.warn('[ma-api] iterateAllSongs page failed:', (e as Error).message);
      break;
    }
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
    const items = await maClient.call<any[]>('music/playlists/library_items', { limit: 500 });
    return (Array.isArray(items) ? items : []).map((p: any) => ({
      id: String(p.item_id),
      name: p.name ?? '',
      songCount: p.metadata?.track_count ?? 0,
    }));
  } catch (e) {
    console.warn('[ma-api] getPlaylists failed:', (e as Error).message);
    return [];
  }
}

export async function getPlaylist(id: string): Promise<any[]> {
  try {
    const tracks = await maClient.call<any[]>('music/playlists/playlist_tracks', {
      item_id: id,
      provider_instance_id_or_domain: 'library',
    });
    return normaliseSongs(Array.isArray(tracks) ? tracks : []);
  } catch (e) {
    console.warn('[ma-api] getPlaylist failed:', (e as Error).message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// URI / cover art
// ---------------------------------------------------------------------------

// Cover art URL — MA image proxy endpoint via the controller's /cover/:id proxy.
export function getCoverArtUrl(id: string, _size = 512): string {
  return `${config.musicAssistant.url}/imageproxy/thumb/${id}`;
}

// Local file path for a normalised song (requires MA_MUSIC_ROOT).
export function getLocalPath(song: any): string | null {
  const musicRoot = config.musicAssistant.musicRoot;
  if (!musicRoot || !song.path) return null;
  return path.join(musicRoot, song.path);
}

// Stream URI for Liquidsoap.
// Prefers file:// (direct, no transcoding) when MA_MUSIC_ROOT is set.
// No HTTP fallback — MA has no stable unauthenticated stream endpoint.
export function getStreamUrl(song: any): string {
  const local = getLocalPath(song);
  if (local) return `file://${local}`;
  console.warn(`[ma-api] no stream URI for song ${song.id} — MA_MUSIC_ROOT not set or track has no filesystem path`);
  return '';
}

export function getRawStreamUrl(song: any): string {
  return getLocalPath(song) ?? '';
}

export function getPlayableUri(song: any): string {
  return getStreamUrl(song);
}

function escAnnotate(s: any): string {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Annotated URI for Liquidsoap — same pattern as subsonic.ts but uses
// ma_id instead of subsonic_id so radio.liq can route cover art to MA.
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
  const uri = getPlayableUri(song);
  if (!uri) return '';
  return `annotate:${fields.join(',')}:${uri}`;
}
