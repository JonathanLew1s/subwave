// Fork-specific extensions to dj-agent.ts — brief-pool construction and the
// recency/exclude-pattern config resolved before each pick. Wired in via
// dispatch points so upstream changes to the agent loop itself don't collide.

import * as settings from '../settings.js';
import * as pool from '../music/pool.js';
import * as library from '../music/library.js';
import { config } from '../config.js';
import { buildMaShortlist } from '../music/ma-candidate-pool.js';
import { buildExemplarProfile } from '../music/theme-centroid.js';
import { recencyWindowsForLibrary } from '../music/recency.js';
import * as pickerShadowLog from './picker-shadow-log.js';

// With a show brief active, the picker gets exactly one discovery call
// (COMMIT_AFTER_STEPS in sdk.js) and PICKER_CRITERIA #1 makes the brief's
// genre/mood a hard constraint — but several discovery tools carry no
// mood/genre signal at all (similarSongs is seed-similarity, topSongsByArtist
// is a discography lookup, recentlyAdded/starredSongs/randomSongs are blind
// library samples). If the model's one shot lands on one of those, the whole
// candidate pool can be off-brief regardless of how well the prompt is
// written — there's nothing on-brief in it to choose. Restrict step-0 tools
// to the mood/genre-aware set whenever a brief is active; the agent always
// has tools that can return brief-fitting candidates. No restriction when no
// show is active (general rotation can use the full toolset).
export const MOOD_AWARE_TOOLS = ['searchLibrary', 'tracksByMood', 'tracksByEnergy', 'tracksLikeThis', 'searchByLyrics'];

// Resolves the show's exemplar profile, when it has one. null = the show has
// no/too-few usable exemplars — every caller treats that as "fall back to
// today's flat mood-band behaviour", never as an error. Shared by
// buildBriefPoolForShow (drives the live pick), the picker agent's
// buildTools (gates every discovery-tool result, not just the brief-pool
// reserve — see picker-tools.ts's exemplarProfile param), and
// maybeRunPickerShadow (logs a comparison) so none of them can ever compute
// a different profile for the same show.
export async function resolveExemplarProfile(activeShow: any) {
  if (config.libraryBackend !== 'ma-api' || !activeShow?.exemplarTrackIds?.length) return null;
  const picker = settings.get().picker;
  return buildExemplarProfile(activeShow.exemplarTrackIds, picker.maShortlist.themeCentroid);
}

// Build the show's reserved brief-pool tracks for this pick — extra on-brief
// candidates beyond whatever the agent's own discovery tool call returns.
// Empty when the active show has no moods configured (general rotation, no
// brief to reserve a pool against).
//
// MA mode with a usable exemplar profile: uses the genre-palette + CLAP-
// similarity shortlist (music/ma-candidate-pool.ts) — validated live (see
// docs/superpowers/specs/2026-06-23-show-redesign-and-genre-aware-picker-design.md)
// to actually exclude cross-genre noise the old flat energy-band pool let
// through. Every other case (Navidrome mode, or MA mode with no/too-few
// exemplars) falls back to the original music/pool.ts buildBriefPool —
// unchanged, fully backward compatible.
export async function buildBriefPoolForShow(
  activeShow: any,
  recentIds: any,
  recentArtists: any = new Set(),
  justPlayedArtists: any = new Set(),
  currentTrack: any = null,
  // Optional — the picker agent's buildTools already resolves this same
  // show's profile to gate its own discovery tools (picker-tools.ts's
  // exemplarProfile param) and passes it through here so it's never computed
  // twice (a real cost: buildExemplarProfile hits the MA sidecar once per
  // exemplar id). undefined (not passed) = resolve it here, same as before —
  // callers that only need the brief pool (none currently) are unaffected.
  precomputedProfile: any = undefined,
): Promise<any[]> {
  if (!activeShow?.moods?.length) return [];

  const profile = precomputedProfile !== undefined ? precomputedProfile : await resolveExemplarProfile(activeShow);
  if (profile) {
    const picker = settings.get().picker;
    const shortlist = await buildMaShortlist({
      showMoods: activeShow.moods,
      currentTrack,
      recentIds,
      recentArtists,
      justPlayedArtists,
      config: picker.maShortlist,
      exemplarProfile: profile,
    });
    // slot (theme/flow/discovery/oldie) becomes _source — picker-tools.ts's
    // acceptInto and the system prompt's "source field" line both just read
    // whatever string is here; see dj-agent.ts's briefPoolLine for the
    // exemplar-aware wording.
    return shortlist.map((e) => ({ ...e.track, _source: e.slot }));
  }

  const built = await pool.buildBriefPool({
    moods: activeShow.moods,
    vibeText: activeShow.vibe,
    showId: activeShow.id,
    recentTrackIds: recentIds,
  });
  return built.tracks;
}

// Filter the agent's step-0 toolset down to the mood/genre-aware set (+ the
// sonic-journey tool, when present) whenever a show brief is active. See
// MOOD_AWARE_TOOLS above for why.
export function filterToolsForShow(tools: Record<string, any>, activeShow: any): Record<string, any> {
  if (!activeShow?.topic) return tools;
  return Object.fromEntries(
    Object.entries(tools).filter(([name]) => MOOD_AWARE_TOOLS.includes(name) || name === 'tracksTowardJourney'),
  );
}

// Shadow-mode comparison — computes what the MA composite shortlist would
// have offered for this track event, and logs it next to whatever the live
// picker actually chose. Read-only, fire-and-forget, and fully isolated:
// any failure here is swallowed and logged, never surfaced to the caller,
// because this must never be able to affect playback. Now that
// buildBriefPoolForShow above can ALSO use this shortlist live (for shows
// with exemplars), this comparison is most informative for shows that don't
// have exemplars yet — it shows what adding them would actually change.
export async function maybeRunPickerShadow(queue: any, eventCurrent: any): Promise<void> {
  const picker = settings.get().picker;
  if (!picker?.maShortlist?.shadowEnabled || config.libraryBackend !== 'ma-api') return;
  try {
    const activeShow = settings.resolveActiveShow();
    const livePick = queue.upcoming?.[0]?.track ?? null;
    const windows = recencyWindowsForLibrary(library.stats().distinctArtists);
    const recentIds = queue.recentlyPlayedIds(windows.trackHours);
    const recentArtists = queue.recentArtistsSince(windows.artistHours);
    const justPlayedArtists = queue.justPlayedArtistKeys();

    const exemplarProfile = await resolveExemplarProfile(activeShow);

    const shortlist = await buildMaShortlist({
      showMoods: activeShow?.moods ?? [],
      currentTrack: eventCurrent,
      recentIds,
      recentArtists,
      justPlayedArtists,
      config: picker.maShortlist,
      exemplarProfile,
    });

    pickerShadowLog.record({
      kind: 'live-pick',
      t: new Date().toISOString(),
      show: activeShow?.id ?? null,
      currentTrackId: eventCurrent?.id ?? null,
      exemplarCount: exemplarProfile?.exemplarCount ?? null,
      livePick: livePick ? { id: livePick.id, title: livePick.title, artist: livePick.artist } : null,
      livePickInShortlist: !!livePick?.id && shortlist.some((e: any) => e.track.id === livePick.id),
      shortlist: shortlist.map((e: any) => ({
        id: e.track.id, title: e.track.title, artist: e.track.artist, year: e.track.year,
        slot: e.slot, score: Math.round(e.score * 100) / 100,
      })),
    });
  } catch (err: any) {
    queue.log?.('error', `picker shadow comparison failed (non-fatal): ${err.message}`);
  }
}
