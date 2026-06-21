// Fork-specific extensions to library-db.ts. Functions here are called from
// one-line dispatch points in library-db.ts so upstream merges/rebases only
// ever conflict on those single lines, never on the logic itself.

import { requireDb, normaliseYear } from './library-db.js';

export interface MASyncData {
  maItemId: number;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  year?: number | null;
  genre?: string | null;
  duration?: number | null;
  loudnessLufs?: number | null;
  bpm?: number | null;
  musicalKey?: string | null;
  beatsJson?: string | null;
  paceJson?: string | null;
  popularitySong?: number | null;
  popularityAlbum?: number | null;
}

// Upsert a track row that came from the Music Assistant sync script.
// The `id` key is "ma-{ma_item_id}" for MA-backend installs so it is stable
// across MA rescans (MA reuses item_ids for delta sync).
// Acoustic fields are written on first encounter and updated only when the
// MA row has newer data (identified by non-null values from the sync query).
export function upsertFromMASync(id: string, data: MASyncData): void {
  requireDb()
    .prepare(
      `
      INSERT INTO tracks (
        id, ma_item_id, title, artist, album, year, genre, duration_sec,
        loudness_lufs, bpm, musical_key, beats_json, pace_json,
        popularity_song, popularity_album
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        ma_item_id      = excluded.ma_item_id,
        title           = COALESCE(excluded.title, tracks.title),
        artist          = COALESCE(excluded.artist, tracks.artist),
        album           = COALESCE(excluded.album, tracks.album),
        year            = COALESCE(excluded.year, tracks.year),
        genre           = COALESCE(excluded.genre, tracks.genre),
        duration_sec    = COALESCE(excluded.duration_sec, tracks.duration_sec),
        loudness_lufs   = COALESCE(excluded.loudness_lufs, tracks.loudness_lufs),
        bpm             = COALESCE(excluded.bpm, tracks.bpm),
        musical_key     = COALESCE(excluded.musical_key, tracks.musical_key),
        beats_json      = COALESCE(excluded.beats_json, tracks.beats_json),
        pace_json       = COALESCE(excluded.pace_json, tracks.pace_json),
        popularity_song  = COALESCE(excluded.popularity_song, tracks.popularity_song),
        popularity_album = COALESCE(excluded.popularity_album, tracks.popularity_album)
      `,
    )
    .run(
      id,
      data.maItemId,
      data.title ?? null,
      data.artist ?? null,
      data.album ?? null,
      normaliseYear(data.year),
      data.genre ?? null,
      Number.isFinite(data.duration as number) ? data.duration : null,
      Number.isFinite(data.loudnessLufs as number) ? data.loudnessLufs : null,
      Number.isFinite(data.bpm as number) ? data.bpm : null,
      data.musicalKey ?? null,
      data.beatsJson ?? null,
      data.paceJson ?? null,
      Number.isFinite(data.popularitySong as number) ? data.popularitySong : null,
      Number.isFinite(data.popularityAlbum as number) ? data.popularityAlbum : null,
    );
}

// Popularity scores from Navidrome custom tags (music/navidrome-api.ts).
export function setPopularity(id: string, popularity: { song: number | null; album: number | null }): void {
  const stmt = requireDb().prepare(
    'UPDATE tracks SET popularity_song = ?, popularity_album = ? WHERE id = ?'
  );
  stmt.run(popularity.song, popularity.album, id);
}

// Cosine similarity of two float vectors. Returns [−1, 1]; higher = more similar.
export function cosineSimilarity(a: Float32Array | number[] | null, b: Float32Array | number[] | null): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom > 0 ? dot / denom : 0;
}
