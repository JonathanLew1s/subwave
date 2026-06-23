// Scheduler — drives autonomous behaviour:
//   - refreshes the auto-playlist file Liquidsoap falls back to
//   - hourly time check (top of every hour, in character)
//   - station IDs (every ~45 min, varied by frequency setting)
//   - agentic segment tick (weather, news, traffic, facts, web search) every 5 min

import cron from 'node-cron';
import { writeFile } from 'node:fs/promises';
import { config } from '../config.js';
import * as subsonic from '../music/library-backend.js';
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
import * as picker from '../music/picker.js';
import { refreshPopularity } from '../music/popularity.js';
import { recencyWindowsForLibrary } from '../music/recency.js';
import { buildMaShortlist } from '../music/ma-candidate-pool.js';
import { buildExemplarProfile, type ExemplarProfile } from '../music/theme-centroid.js';
import * as pickerShadowLog from './picker-shadow-log.js';

// Shared by refreshAutoPlaylistInner (drives the real auto.m3u write) and
// maybeRunAutoPlaylistShadow (logs a comparison) so they can never compute
// two different profiles for the same show. null = no/too-few usable
// exemplars — callers fall back to today's flat mood-band behaviour.
async function resolveExemplarProfile(exemplarTrackIds: string[]): Promise<ExemplarProfile | null> {
  if (config.libraryBackend !== 'ma-api' || !exemplarTrackIds.length) return null;
  const pickerSettings = settings.get().picker;
  return buildExemplarProfile(exemplarTrackIds, pickerSettings.maShortlist.themeCentroid);
}

const TARGET_POOL = 50;

// ---------------------------------------------------------------------------
// AUTO-PLAYLIST REFRESH
// Writes an M3U with mood-appropriate tracks for Liquidsoap's fallback source.
// ---------------------------------------------------------------------------

export async function refreshAutoPlaylist() {
  return withTrace({ kind: 'auto-playlist' }, () => refreshAutoPlaylistInner());
}

async function refreshAutoPlaylistInner() {
  const ctx = await getFullContext();

  const activeShow = settings.resolveActiveShow();
  const { maxDurationSec, minDurationSec, excludePatterns } = settings.getPickerConfig(activeShow);

  const showMoods: string[] = activeShow?.moods?.length
    ? activeShow.moods
    : (ctx.dominantMood ? [ctx.dominantMood] : []);
  const showMood = showMoods[0] || null;
  const preferPopularity = showMoods.length === 0;

  await library.load();
  const windows = recencyWindowsForLibrary(library.stats().distinctArtists);
  const recentIds = queue.recentlyPlayedIds(windows.trackHours);
  const recentArtists = queue.recentArtistsSince(windows.artistHours);
  const justPlayedArtists = queue.justPlayedArtistKeys();

  let rawCandidates: any[];
  let sources: Record<string, number>;

  const exemplarProfile = config.libraryBackend === 'ma-api' && showMoods.length > 0
    ? await resolveExemplarProfile(activeShow?.exemplarTrackIds ?? [])
    : null;

  if (exemplarProfile) {
    // MA mode with a usable exemplar profile: the genre-palette + CLAP-
    // similarity shortlist (validated live — see
    // docs/superpowers/specs/2026-06-23-show-redesign-and-genre-aware-picker-design.md)
    // replaces the flat mood+random union below for shows that have set
    // exemplars. Falls through to that flat union for shows without them.
    const pickerSettings = settings.get().picker;
    const shortlist = await buildMaShortlist({
      showMoods,
      currentTrack: queue.current?.track ?? null,
      recentIds,
      recentArtists,
      justPlayedArtists,
      config: pickerSettings.maShortlist,
      exemplarProfile,
    });
    const randomTracks = await subsonic.getRandomSongs({ size: 20 }); // small diversity buffer
    const shortlistPool = shortlist.map((e: any) => ({ ...e.track, _source: e.slot }));
    const randPool = randomTracks.map((t: any) => ({ ...t, _source: 'random' }));
    rawCandidates = [...shortlistPool, ...randPool];
    sources = { ...Object.fromEntries(['theme', 'flow', 'discovery', 'oldie'].map((s) => [s, shortlist.filter((e: any) => e.slot === s).length])), random: randPool.length };
  } else if (config.libraryBackend === 'ma-api' && showMoods.length > 0) {
    // MA mode without exemplars: build the pool directly from all show moods
    // + random diversity. buildCandidates is designed for single-pick
    // (recent/frequent albums, LastFM artist graph) — none of those are
    // mood-aligned. For the fallback playlist we want the full
    // mood-appropriate slice of the library.
    const [moodTracks, randomTracks] = await Promise.all([
      library.songsByMoods(showMoods),   // all show moods, energy-band filtered
      subsonic.getRandomSongs({ size: 50 }), // diversity buffer
    ]);
    const moodPool = moodTracks.map((t: any) => ({ ...t, _source: 'mood-library' }));
    const randPool = randomTracks.map((t: any) => ({ ...t, _source: 'random' }));
    rawCandidates = [...moodPool, ...randPool];
    sources = { 'mood-library': moodPool.length, random: randPool.length };
  } else {
    const currentTrack = queue.current?.track || queue.history[0]?.track || null;
    const result = await picker.buildCandidates(
      showMood, recentIds, recentArtists, currentTrack, null, justPlayedArtists, TARGET_POOL, preferPopularity,
    );
    rawCandidates = result.candidates;
    sources = result.sources;
  }

  const filtered = rawCandidates.filter((c: any) =>
    (!c.duration || (c.duration <= maxDurationSec && c.duration >= minDurationSec)) && isRadioPickable(c.title ?? '', c.album, excludePatterns, c.genre));
  const candidates = filtered.length > 0 ? filtered : rawCandidates;

  const poolArray = pool.buildSequencedPlaylist(candidates, TARGET_POOL, {
    justPlayedArtists,
    recentArtists,
  });

  const fromSource: Record<string, number> = {};
  for (const t of poolArray) fromSource[t._source] = (fromSource[t._source] || 0) + 1;

  const lines = ['#EXTM3U', ...poolArray.map((t: any) => subsonic.getAnnotatedUri(t))];
  await writeFile(config.liquidsoap.autoPlaylist, lines.join('\n'));
  queue.log('scheduler',
    `Auto-playlist refreshed: ${poolArray.length} tracks (` +
    Object.entries(fromSource).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(' ') +
    ` of ${Object.entries(sources).map(([k, v]) => `${k}=${v}`).join(' ')}` +
    `, moods=${showMoods.join('+') || `none/popularity (${ctx.dominantMood || 'n/a'})`})`);

  // Skip the shadow comparison when the live path already used the
  // exemplar shortlist directly — it would just be comparing the shortlist
  // against itself. Shadow logging is only informative for shows that
  // don't have exemplars yet (it shows what adding them would change).
  if (!exemplarProfile) {
    maybeRunAutoPlaylistShadow(
      showMoods, activeShow?.id ?? null, activeShow?.exemplarTrackIds ?? [], fromSource,
      recentIds, recentArtists, justPlayedArtists,
    ).catch(() => {});
  }
}

// Shadow-mode comparison for the auto.m3u path — computes what the
// centroid-gated pool would have produced for this refresh, and logs it
// against what actually got written to auto.m3u. Read-only, fire-and-forget,
// fully isolated: any failure here is swallowed and logged, never thrown,
// because this must never be able to affect the real file write. Mirrors
// dj-agent.ts's maybeRunPickerShadow for the live-pick path.
async function maybeRunAutoPlaylistShadow(
  showMoods: string[],
  activeShowId: string | null,
  exemplarTrackIds: string[],
  liveComposition: Record<string, number>,
  recentIds: Set<string>,
  recentArtists: Set<string>,
  justPlayedArtists: Set<string>,
) {
  // Named pickerSettings, not picker — this file already imports the
  // music/picker.js module as `picker`; shadowing it here would confuse a
  // future reader even though it's scoped to this function only.
  const pickerSettings = settings.get().picker;
  if (!pickerSettings?.maShortlist?.autoPlaylistShadowEnabled || config.libraryBackend !== 'ma-api') return;
  try {
    const exemplarProfile = await resolveExemplarProfile(exemplarTrackIds);
    if (!exemplarProfile) return; // nothing to compare without exemplars — not an error

    const shortlist = await buildMaShortlist({
      showMoods,
      currentTrack: queue.current?.track ?? null,
      recentIds,
      recentArtists,
      justPlayedArtists,
      config: pickerSettings.maShortlist,
      exemplarProfile,
    });

    pickerShadowLog.record({
      kind: 'auto-playlist',
      t: new Date().toISOString(),
      show: activeShowId,
      exemplarCount: exemplarProfile.exemplarCount,
      liveComposition,
      gatedShortlist: shortlist.map((e) => ({
        id: e.track.id, title: e.track.title, artist: e.track.artist, year: e.track.year,
        slot: e.slot, score: Math.round(e.score * 100) / 100,
      })),
    });
  } catch (err: any) {
    queue.log?.('error', `auto-playlist shadow comparison failed (non-fatal): ${err.message}`);
  }
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
