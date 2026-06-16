#!/usr/bin/env tsx
// Sync Music Assistant library.db → SUB/WAVE library-db.
//
// Usage:
//   npm run sync-ma                      # incremental sync (new/updated tracks)
//   npm run sync-ma -- --full            # full re-sync (re-reads all tracks)
//   npm run sync-ma -- --reseed          # full + reset CLAP vectors (dim change)
//   npm run sync-ma -- --ma-db /path     # explicit MA db path (default: MA_DB_PATH env)
//
// The MA DB can be supplied in two ways:
//   1. Set MA_DB_PATH to a local file (e.g. after `kubectl cp`)
//   2. Set MA_DB_PATH to a path reachable from this container on a shared volume
//
// Popularity (trackpopularity / albumpopularity) is read from the audio files
// themselves via `music-metadata` — the ListenBrainz values baked in as custom
// tags. MA_MUSIC_ROOT must be set for this to work; without it popularity is
// left null and the existing values in library-db are preserved.

import Database from 'better-sqlite3';
import { parseFile } from 'music-metadata';
import path from 'node:path';
import fs from 'node:fs';
import process from 'node:process';

import { STATE_DIR } from '../src/config.js';
import { open as openDb, upsertFromMASync, pruneMissingTracks, AUDIO_EMBEDDING_DIM } from '../src/music/library-db.js';

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const flags = {
  full: args.includes('--full') || args.includes('--reseed'),
  reseed: args.includes('--reseed'),
  maDbPath: (() => {
    const i = args.indexOf('--ma-db');
    return i >= 0 ? args[i + 1] : (process.env.MA_DB_PATH ?? '');
  })(),
};

if (!flags.maDbPath) {
  console.error('[sync-ma] No MA DB path. Set MA_DB_PATH env var or pass --ma-db /path/to/library.db');
  process.exit(1);
}
if (!fs.existsSync(flags.maDbPath)) {
  console.error(`[sync-ma] MA DB not found: ${flags.maDbPath}`);
  process.exit(1);
}

const MUSIC_ROOT = process.env.MA_MUSIC_ROOT ?? '';

// ---------------------------------------------------------------------------
// Open both databases
// ---------------------------------------------------------------------------
const maDb = new Database(flags.maDbPath, { readonly: true });

// open() is called inside main() so it can be awaited.

// ---------------------------------------------------------------------------
// Schema safety check
// ---------------------------------------------------------------------------
const maVersion = maDb.pragma('user_version', { simple: true }) as number;
console.log(`[sync-ma] MA DB schema user_version = ${maVersion}`);

// Store the version we ran against so future sync runs can warn on mismatch.
const SETTINGS_PATH = path.join(STATE_DIR, 'settings.json');
let settings: any = {};
try { settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); } catch {}
if (settings.sync?.maSchemaVersion && settings.sync.maSchemaVersion !== maVersion) {
  console.warn(
    `[sync-ma] MA DB schema changed: was ${settings.sync.maSchemaVersion}, now ${maVersion}. ` +
    `Review MA release notes and re-run with --full if the track table changed.`,
  );
}

// ---------------------------------------------------------------------------
// Camelot key mapping
// ---------------------------------------------------------------------------
// Converts MA's "D# minor" style into Camelot notation ("2A").
const NOTE_ORDER = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const ENHARMONIC: Record<string, string> = {
  'Db':'C#','Eb':'D#','Gb':'F#','Ab':'G#','Bb':'A#',
};
function toCamelot(key: string, mode: string): string | null {
  if (!key) return null;
  const tonic = ENHARMONIC[key] ?? key;
  const idx = NOTE_ORDER.indexOf(tonic);
  if (idx < 0) return null;
  if (mode === 'major') {
    const n = ((idx * 7) % 12) + 1;
    return `${n}B`;
  }
  // minor: offset by -3 semitones (= +9) from major wheel
  const n = (((idx + 9) * 7) % 12) + 1;
  return `${n}A`;
}

// ---------------------------------------------------------------------------
// Popularity from file tags (ListenBrainz custom tags)
// ---------------------------------------------------------------------------
async function readPopularityFromFile(filePath: string): Promise<{ song: number | null; album: number | null }> {
  if (!MUSIC_ROOT || !filePath) return { song: null, album: null };
  const abs = path.join(MUSIC_ROOT, filePath);
  try {
    const meta = await parseFile(abs, { duration: false, skipCovers: true });
    const native = meta.native;
    // Custom tags differ by format — check common containers
    let song: number | null = null;
    let album: number | null = null;
    for (const tags of Object.values(native)) {
      for (const tag of tags as any[]) {
        const k = (tag.id ?? '').toLowerCase();
        if (k === 'trackpopularity' || k === 'txxx:trackpopularity') {
          const v = parseFloat(tag.value);
          if (Number.isFinite(v)) song = v;
        }
        if (k === 'albumpopularity' || k === 'txxx:albumpopularity') {
          const v = parseFloat(tag.value);
          if (Number.isFinite(v)) album = v;
        }
      }
    }
    return { song, album };
  } catch {
    return { song: null, album: null };
  }
}

// ---------------------------------------------------------------------------
// Core sync query
// ---------------------------------------------------------------------------
const SYNC_QUERY = `
SELECT
  t.item_id,
  t.name,
  t.duration,
  t.metadata,
  t.timestamp_modified,
  GROUP_CONCAT(DISTINCT a.name) AS artists,
  alb.name AS album,
  alb.year,
  pm.provider_item_id AS file_path,
  aa_loud.analysis_data AS loudness_json,
  aa_fades.analysis_data AS fades_json,
  aa_sonic.analysis_data AS sonic_json
FROM tracks t
LEFT JOIN track_artists ta ON ta.track_id = t.item_id
LEFT JOIN artists a ON a.item_id = ta.artist_id
LEFT JOIN album_tracks at2 ON at2.track_id = t.item_id
LEFT JOIN albums alb ON alb.item_id = at2.album_id
LEFT JOIN provider_mappings pm
  ON pm.item_id = t.item_id AND pm.media_type = 'track' AND pm.provider_domain = 'filesystem_local'
LEFT JOIN audio_analysis aa_loud
  ON aa_loud.item_id = pm.provider_item_id AND aa_loud.aa_provider_domain = 'loudness_analysis'
LEFT JOIN audio_analysis aa_fades
  ON aa_fades.item_id = pm.provider_item_id AND aa_fades.aa_provider_domain = 'smart_fades'
LEFT JOIN audio_analysis aa_sonic
  ON aa_sonic.item_id = pm.provider_item_id AND aa_sonic.aa_provider_domain = 'sonic_analysis'
WHERE pm.provider_item_id IS NOT NULL
GROUP BY t.item_id
`;

// Incremental: only rows modified since last sync.
const INCREMENTAL_QUERY = SYNC_QUERY.replace(
  'WHERE pm.provider_item_id IS NOT NULL',
  'WHERE pm.provider_item_id IS NOT NULL AND t.timestamp_modified > ?',
);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  await openDb({ embeddingDim: AUDIO_EMBEDDING_DIM, adoptStoredDim: true, reseed: flags.reseed });

  const lastSyncAt: number = flags.full ? 0 : (settings.sync?.maLastSyncAt ?? 0);
  const isIncremental = !flags.full && lastSyncAt > 0;

  // Use .iterate() not .all() — rows contain large JSON blobs (CLAP 1024-dim,
  // RMS arrays) that exhaust the heap when loaded all at once for 37k+ tracks.
  const rowIter: Iterable<any> = isIncremental
    ? maDb.prepare(INCREMENTAL_QUERY).iterate(lastSyncAt)
    : maDb.prepare(SYNC_QUERY).iterate();

  // Count separately (cheap — no JSON cols) so we can log progress without .all().
  const totalCount = (maDb.prepare(
    isIncremental
      ? `SELECT COUNT(*) AS n FROM tracks t
         JOIN provider_mappings pm ON pm.item_id = t.item_id
           AND pm.media_type='track' AND pm.provider_domain='filesystem_local'
         WHERE t.timestamp_modified > ?`
      : `SELECT COUNT(*) AS n FROM tracks t
         JOIN provider_mappings pm ON pm.item_id = t.item_id
           AND pm.media_type='track' AND pm.provider_domain='filesystem_local'`,
  ).get(...(isIncremental ? [lastSyncAt] : [])) as any).n as number;

  console.log(`[sync-ma] ${isIncremental ? 'incremental' : 'full'} sync: ${totalCount} tracks to process`);

  const nowTs = Math.floor(Date.now() / 1000);
  const liveIds = new Set<string>();
  let synced = 0;
  let withAnalysis = 0;
  let withPopularity = 0;

  for (const row of rowIter) {
    const id = `ma-${row.item_id}`;
    liveIds.add(id);

    const loud = row.loudness_json ? JSON.parse(row.loudness_json) : null;
    const fades = row.fades_json ? JSON.parse(row.fades_json) : null;
    const sonic = row.sonic_json ? JSON.parse(row.sonic_json) : null;

    const loudnessLufs: number | null =
      loud?.loudness_integrated ?? sonic?.loudness_integrated ?? null;
    const bpm: number | null = fades?.bpm ?? null;
    const camelot = fades?.key && fades?.mode ? toCamelot(fades.key, fades.mode) : null;
    const beatsJson = fades?.beats ? JSON.stringify(fades.beats) : null;

    // pace_json: resample MA's rms_energy float[] to SUB/WAVE's span format
    let paceJson: string | null = null;
    if (sonic?.rms_energy && Array.isArray(sonic.rms_energy) && sonic.rms_energy.length > 0) {
      const rms: number[] = sonic.rms_energy;
      const dur = row.duration ?? 1;
      const spanMs = (dur * 1000) / rms.length;
      const spans = rms.map((v: number, i: number) => ({
        startMs: Math.round(i * spanMs),
        endMs: Math.round((i + 1) * spanMs),
        value: Math.min(1, Math.max(0, v)),
      }));
      paceJson = JSON.stringify(spans);
    }

    const metadata = row.metadata ? JSON.parse(row.metadata) : null;
    const genre: string | null = Array.isArray(metadata?.genres) && metadata.genres.length
      ? metadata.genres[0]
      : null;
    const artists: string = row.artists ?? '';
    const artist = artists.split(',')[0]?.trim() || null;

    // Popularity from file tags
    const pop = await readPopularityFromFile(row.file_path);
    if (pop.song !== null || pop.album !== null) withPopularity++;

    upsertFromMASync(id, {
      maItemId: row.item_id,
      title: row.name ?? null,
      artist,
      album: row.album ?? null,
      year: row.year ?? null,
      genre,
      duration: row.duration ?? null,
      loudnessLufs,
      bpm,
      musicalKey: camelot,
      beatsJson,
      paceJson,
      popularitySong: pop.song,
      popularityAlbum: pop.album,
    });

    if (loud || fades || sonic) withAnalysis++;
    synced++;
    if (synced % 500 === 0) console.log(`[sync-ma] synced ${synced}/${totalCount}...`);
  }

  // Prune orphaned rows (full sync only — incremental doesn't see the full catalogue).
  if (!isIncremental && liveIds.size > 0) {
    // Build the full live-id set from what MA reports (all rows from MA, not just
    // the chunk we processed). For an incremental run this would be incomplete.
    const allMaIds = (maDb.prepare(
      `SELECT t.item_id FROM tracks t
       JOIN provider_mappings pm ON pm.item_id = t.item_id
         AND pm.media_type='track' AND pm.provider_domain='filesystem_local'`,
    ).all() as any[]).map(r => `ma-${r.item_id}`);
    const fullLive = new Set(allMaIds);
    const pruned = pruneMissingTracks(fullLive);
    if (pruned > 0) console.log(`[sync-ma] pruned ${pruned} tracks no longer in MA`);
  }

  // Persist sync watermark
  settings.sync = {
    ...settings.sync,
    maSchemaVersion: maVersion,
    maLastSyncAt: nowTs,
    maLastSyncCount: synced,
  };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));

  console.log(`[sync-ma] done: ${synced} synced, ${withAnalysis} with acoustic data, ${withPopularity} with popularity`);
}

main().catch(e => { console.error('[sync-ma]', e); process.exit(1); });
