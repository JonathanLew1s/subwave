// Scheduler — drives autonomous behaviour:
//   - refreshes the auto-playlist file Liquidsoap falls back to
//   - hourly time check (top of every hour, in character)
//   - station IDs (every ~45 min, varied by frequency setting)
//   - agentic segment tick (weather, news, traffic, facts, web search) every 5 min

import cron from 'node-cron';
import { writeFile } from 'node:fs/promises';
import { config } from '../config.js';
import * as subsonic from '../music/subsonic.js';
import * as dj from '../llm/dj.js';
import * as library from '../music/library.js';
import { getFullContext } from '../context.js';
import { queue } from './queue.js';
import * as session from './session.js';
import { cleanupOldVoices } from '../audio/tts.js';
import { shouldFire } from './dj-gate.js';
import { djCallsAllowed } from './listeners.js';
import { agenticTick, skillCatalog } from '../skills/_agent.js';
import { withTrace } from '../observability/events.js';
import { isRadioPickable } from '../llm/tools.js';
import * as settings from '../settings.js';
import * as pool from '../music/pool.js';
import { refreshPopularity } from '../music/popularity.js';
import { recencyWindowsForLibrary } from '../music/recency.js';

const TARGET_POOL = 30;
const MOOD_WEIGHT = 12;          // up to this many mood-tagged tracks per pool
const PLAYLIST_WEIGHT = 6;       // mood-matched Navidrome playlists
const RECENT_WEIGHT = 4;         // recently-added albums
const FREQUENT_WEIGHT = 4;       // frequent / scrobble-favourite albums
const STARRED_WEIGHT = 6;        // hand-starred tracks

function shuffle<T>(arr: T[]): T[] {
  return [...arr].sort(() => Math.random() - 0.5);
}

async function tracksFromAlbums(albums: any[], perAlbum: number, max: number) {
  const out: any[] = [];
  for (const a of albums) {
    if (out.length >= max) break;
    try {
      const songs = await subsonic.getAlbum(a.id);
      out.push(...shuffle(songs).slice(0, perAlbum));
    } catch {}
  }
  return out;
}

// ---------------------------------------------------------------------------
// AUTO-PLAYLIST REFRESH
// Writes an M3U with mood-appropriate tracks for Liquidsoap's fallback source.
// ---------------------------------------------------------------------------

export async function refreshAutoPlaylist() {
  return withTrace({ kind: 'auto-playlist' }, () => refreshAutoPlaylistInner());
}

async function refreshAutoPlaylistInner() {
  const ctx = await getFullContext();
  const mood = ctx.dominantMood;
  // Match the auto-DJ picker's window (dj-agent.pickViaAgent) — 12h.
  const recent = queue.recentlyPlayedIds(12);

  // Auto-playlist is Liquidsoap's fallback source — it plays directly from
  // this file (no picker/LLM in the loop) whenever the queue runs dry, so it
  // must honour the same exclude patterns / duration cap as every other pick
  // path. Without this, station-wide excludes (e.g. "demo", "live", holiday
  // tracks) only applied to LLM-driven picks and a previously-built auto.m3u
  // could keep airing excluded tracks indefinitely on underrun.
  const activeShow = settings.resolveActiveShow();
  const { maxDurationSec, excludePatterns } = settings.getPickerConfig(activeShow);

  // When a mood is active, every source — not just the dedicated 'mood' and
  // 'playlist' sources — must fit it. Without this, the auto-playlist's
  // top-up sources (recent/frequent/starred/random, typically ~18/30 tracks)
  // can hand Liquidsoap something completely off-brief on cold start /
  // underrun (e.g. a "Country"-tagged track during a "focus" show).
  await library.load();
  const moods = activeShow?.moods || (mood ? [mood] : null);
  const briefPoolResult = await pool.buildBriefPool({ moods, recentTrackIds: new Set() });
  // moodIds gates the requireMood sources below — it must be the full
  // mood-tagged universe (songsByMoods), not the small stratified sample in
  // briefPoolResult.tracks. Checking membership against that ~50-track sample
  // rejected nearly everything from recent/frequent/starred/random, leaving
  // the auto-playlist pool dominated by the brief-pool tracks alone.
  const moodUniverse = moods ? library.songsByMoods(moods) : [];
  const moodIds = moodUniverse.length > 0 ? new Set(moodUniverse.map((t: any) => t.id)) : null;

  // Gather a deduped candidate pool ~2x TARGET_POOL — same per-source weights
  // (doubled) and filters as before, but no artist-level decisions are made
  // here. buildSequencedPlaylist below picks the final TARGET_POOL tracks,
  // ordering them so no two adjacent tracks share a coreArtistKey, using the
  // same recency rules as the live picker (recency.ts).
  const CANDIDATE_TARGET = TARGET_POOL * 2;
  const candidates: any[] = [];
  const seen = new Set<string>();
  const add = (label: string, items: any[], cap: number, { requireMood = false }: { requireMood?: boolean } = {}) => {
    let n = 0;
    for (const t of items) {
      if (n >= cap || candidates.length >= CANDIDATE_TARGET) break;
      if (!t?.id || recent.has(t.id) || seen.has(t.id)) continue;
      if (t.duration && t.duration > maxDurationSec) continue;
      if (!isRadioPickable(t.title ?? '', t.album, excludePatterns, t.genre)) continue;
      if (requireMood && moodIds && !moodIds.has(t.id)) continue;
      seen.add(t.id);
      candidates.push({ ...t, _source: label });
      n++;
    }
  };

  // 1. Stratified brief-pool from the LLM-built library.
  if (moods) {
    add('brief-pool', shuffle(briefPoolResult.tracks), MOOD_WEIGHT * 2);
  }

  // 2. Navidrome playlists whose name matches the mood — operator's hand curation.
  if (mood) {
    try {
      const playlists = await subsonic.getPlaylists();
      const matched = playlists.filter((p: any) => p.name?.toLowerCase().includes(mood.toLowerCase()));
      const tracks: any[] = [];
      for (const pl of matched.slice(0, 2)) {
        try {
          const songs = await subsonic.getPlaylist(pl.id);
          tracks.push(...songs);
        } catch {}
      }
      add('playlist', shuffle(tracks), PLAYLIST_WEIGHT * 2);
    } catch (err) {
      queue.log('error', `Playlist fetch failed: ${err.message}`);
    }
  }

  // 3. Recently-added albums — surfaces new music without any tagging.
  try {
    const recentAlbums = await subsonic.getRecentlyAddedAlbums({ size: 8 });
    const tracks = await tracksFromAlbums(shuffle(recentAlbums).slice(0, 4), 2, RECENT_WEIGHT * 4);
    add('recent', tracks, RECENT_WEIGHT * 2, { requireMood: true });
  } catch (err) {
    queue.log('error', `Recent-albums fetch failed: ${err.message}`);
  }

  // 4. Frequent albums — Navidrome's scrobble-backed favourites.
  try {
    const freqAlbums = await subsonic.getFrequentAlbums({ size: 8 });
    const tracks = await tracksFromAlbums(shuffle(freqAlbums).slice(0, 4), 2, FREQUENT_WEIGHT * 4);
    add('frequent', tracks, FREQUENT_WEIGHT * 2, { requireMood: true });
  } catch (err) {
    queue.log('error', `Frequent-albums fetch failed: ${err.message}`);
  }

  // 5. Starred — hand-curated.
  try {
    const starred = shuffle(await subsonic.getStarred());
    add('starred', starred, STARRED_WEIGHT * 2, { requireMood: true });
  } catch (err) {
    queue.log('error', `Starred fetch failed: ${err.message}`);
  }

  // 6. Top up with random to CANDIDATE_TARGET.
  if (candidates.length < CANDIDATE_TARGET) {
    try {
      const random = await subsonic.getRandomSongs({ size: CANDIDATE_TARGET });
      add('random', random, CANDIDATE_TARGET, { requireMood: true });
    } catch (err) {
      queue.log('error', `Random fetch failed: ${err.message}`);
    }
  }

  // Sequence the final playlist using the same recency rules as the live
  // picker — no two adjacent tracks share an artist, seeded from whatever the
  // live queue just played so the auto-playlist's first track doesn't repeat
  // it either.
  const windows = recencyWindowsForLibrary(library.stats().distinctArtists);
  const poolArray = pool.buildSequencedPlaylist(candidates, TARGET_POOL, {
    justPlayedArtists: queue.justPlayedArtistKeys(),
    recentArtists: queue.recentArtistsSince(windows.artistHours),
  });

  const fromSource: Record<string, number> = {};
  for (const t of poolArray) fromSource[t._source] = (fromSource[t._source] || 0) + 1;

  const lines = ['#EXTM3U', ...poolArray.map((t: any) => subsonic.getAnnotatedUri(t))];
  await writeFile(config.liquidsoap.autoPlaylist, lines.join('\n'));
  queue.log('scheduler',
    `Auto-playlist refreshed: ${poolArray.length} tracks (` +
    Object.entries(fromSource).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(' ') +
    `, mood=${mood || 'none'})`);
}

// ---------------------------------------------------------------------------
// HOURLY TIME CHECK
// At the top of every hour, the DJ checks in.
// ---------------------------------------------------------------------------

// Gate-free runner — also called directly by the /dj/segment command route as
// an operator override. The cron wrapper below adds the frequency gate.
export async function runHourlyCheck() {
  return withTrace({ kind: 'hourly' }, async () => {
    const ctx = await getFullContext();
    const script = await dj.generateHourlyTime(ctx.time, ctx.weather, {
      recap: queue.getDjRecap(),
      context: ctx,
      recentOpeners: queue.getRecentOpeners(),
    });
    await queue.announce(script, 'hourly-check');
    return script;
  });
}

async function hourlyCheck() {
  // The top of the hour is the natural show boundary — roll the session here
  // so a scheduled show starting/ending opens a fresh chat history even if no
  // track happens to start right on the hour.
  try {
    await session.maybeRoll(await getFullContext());
  } catch (err) {
    queue.log('error', `Session roll failed: ${err.message}`);
  }
  if (!shouldFire('hourly')) return;
  if (!djCallsAllowed()) return;  // nobody listening — stay on the auto playlist
  try {
    await runHourlyCheck();
  } catch (err) {
    queue.log('error', `Hourly check failed: ${err.message}`);
  }
}

// Generate and air a between-track DJ link for whatever is playing now.
// Gate-free; used by the /dj/segment command route.
export async function runLink() {
  return withTrace({ kind: 'link' }, async () => {
    const current = queue.current?.track;
    if (!current) throw new Error('nothing is playing — no track to link from');
    const previous = queue.history[0]?.track || null;
    const ctx = await getFullContext();
    const script = await dj.generateLink({
      previous,
      current,
      context: ctx,
      recap: queue.getDjRecap(),
      recentTracks: queue.getRecentTracks(),
      recentOpeners: queue.getRecentOpeners(),
    });
    await queue.announce(script, 'link');
    return script;
  });
}

// ---------------------------------------------------------------------------
// SEGMENT TICK
// Hands a snapshot of the moment and a set of real-world data tools to the
// segment-director agent (skills/_agent.js), which decides whether to air one
// between-track segment (weather / news / traffic / fact / artist news) or to
// stay silent. The same agent also backs the /dj/skill manual-override route
// (runCapability), forced to one capability.
// ---------------------------------------------------------------------------

async function skillsTick() {
  if (!djCallsAllowed()) return;  // nobody listening — skip the segment director
  try {
    await withTrace({ kind: 'segment' }, async () => {
      const ctx = await getFullContext();
      await agenticTick(ctx);
    });
  } catch (err) {
    queue.log('error', `Segment tick failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// STATION ID
// Random ident every ~45 mins
// ---------------------------------------------------------------------------

// Gate-free runner — also called directly by the /dj/segment command route.
export async function runStationId() {
  return withTrace({ kind: 'station-id' }, async () => {
    const ctx = await getFullContext();
    const script = await dj.generateStationId({
      recap: queue.getDjRecap(),
      context: ctx,
      recentOpeners: queue.getRecentOpeners(),
    });
    await queue.announce(script, 'station-id');
    return script;
  });
}

async function stationId() {
  if (!shouldFire('stationId')) return;
  if (!djCallsAllowed()) return;  // nobody listening — skip the ident
  try {
    await runStationId();
  } catch (err) {
    queue.log('error', `Station ID failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// CLEAN UP — old voice WAVs
// ---------------------------------------------------------------------------

async function cleanup() {
  try {
    await cleanupOldVoices();
  } catch (err) {
    queue.log('error', `Cleanup failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// POPULARITY REFRESH
// Backfills tracks.popularity_song / tracks.popularity_album from Navidrome's
// custom tags (beets-derived). Cheap (~80 paginated /api/song requests for a
// ~40k-track library) — run on every boot (self-heals after restarts/deploys
// that miss the weekly tick) and weekly thereafter.
// ---------------------------------------------------------------------------

async function refreshPopularityScores() {
  if (!config.navidrome.user || !config.navidrome.password) return;
  try {
    const count = await refreshPopularity();
    queue.log('scheduler', `Popularity refresh: updated ${count} tracks`);
  } catch (err: any) {
    queue.log('error', `Popularity refresh failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// START
// ---------------------------------------------------------------------------

export function startScheduler() {
  // Initial run
  refreshAutoPlaylist().catch(err => queue.log('error', `Initial playlist failed: ${err.message}`));

  // Popularity refresh on boot — self-heals if a pod restart missed the
  // weekly cron tick below.
  refreshPopularityScores().catch(err => queue.log('error', `Initial popularity refresh failed: ${err.message}`));

  // Auto-playlist refresh every 10 minutes
  cron.schedule(`*/${config.show.autoQueueRefreshMinutes} * * * *`, refreshAutoPlaylist);

  // Top of every hour
  cron.schedule('0 * * * *', hourlyCheck);

  // Segment tick every 5 minutes — the segment-director agent decides whether
  // to air a segment; per-kind cooldowns and the frequency floor live in it.
  cron.schedule('*/5 * * * *', skillsTick);

  // Station ID candidate ticks at :15, :30, :45 — handler gates by frequency.
  // Deliberately NOT :00: the hourly check owns the top of the hour, and firing
  // both there stacked two voice segments on each other (issue #310).
  cron.schedule('15,30,45 * * * *', stationId);

  // Cleanup every hour
  cron.schedule('0 * * * *', cleanup);

  // Popularity refresh weekly — Sunday 3am, picks up new beets tags / library additions.
  cron.schedule('0 3 * * 0', refreshPopularityScores);

  queue.log('scheduler', `Scheduler started · skills: ${skillCatalog().map((s: any) => s.name).join(', ')}`);
}
