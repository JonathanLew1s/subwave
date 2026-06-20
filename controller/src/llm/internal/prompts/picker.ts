// LLM pool picker — choose the next track from a candidate pool (the stateless
// fallback path; the conversational agent picker lives in broadcast/dj-agent.js).
// PICKER_CRITERIA is shared with that agent so the two strategies can't drift.

import { z } from 'zod';
import * as settings from '../../../settings.js';
// NOTE: upstream imports djObject from '../strategy/object.js' (its sdk.ts
// split). That module doesn't exist on this branch yet — sdk.ts hasn't been
// split here. Revisit this import when a future task ports that split.
import { djObject } from '../../sdk.js';

export const PICKER_CRITERIA = `Selection criteria, in order:
1. SHOW BRIEF — if a current show brief is given above, its genre and mood are a hard constraint. Only consider tracks that fit it. A perfect flow transition into the wrong genre is still wrong. Use tracksByMood, tracksByEnergy, tracksLikeThis, searchByLyrics, or searchLibrary to find candidates that actually fit the show.
2. CONTEXT — does it fit the time of day, weather, and dominant mood?
3. FLOW — within the show's genre space, does it transition naturally from what just played (energy, tempo)? When a candidate shows a "bpm" and/or Camelot "key", those are MEASURED — prefer a next track whose tempo sits near the current one (or steps it deliberately for the daypart) and whose key is harmonically close. When "pace" (0–1) is present, it is the track's MEASURED perceptual energy decoupled from tempo — use it to shape build/release arcs: avoid stacking two peaks back-to-back, ease down for wind-down dayparts, lift for workout/drive. When "sections" is present, it hints how much the opening develops (higher = busier, evolving intro). Treat all of these as tie-breakers, never hard rules; many tracks won't have them.
4. VARIETY — never pick the same artist consecutively; don't repeat tracks already played today; rotate energy. Mix well-known tracks with deeper cuts — don't cluster obvious global hits back to back. If recent picks have felt very similar to each other (check the recentSimilarity flag), prefer a briefPool candidate from a different genre or energy stratum — even over a strong similarity match. Variety over cleverness — never pick a track because its title literally matches the time of day, the weather, or anything else literal.
5. INTEREST — prefer something that creates a moment, not the most generic option.`;

// Same type as upstream's ShowMusic, kept under our own name since `genre` is
// NOT treated as a soft lean here — it's a hard constraint enforced via the
// show brief text (SHOW BRIEF criterion above) and the brief-pool tool
// restriction in dj-agent.ts, not via this prompt line.
export type ShowMusic = { name: string; topic: string; genre?: string; fromYear?: number | null; toYear?: number | null; energy?: string };

// Soft lean line for decade/energy only. `genre` is deliberately excluded —
// unlike upstream, our fork treats show genre as a hard constraint (SHOW
// BRIEF criterion #1), so it must never be phrased as a mere preference here.
export function showMusicLean(show?: ShowMusic | null): string {
  if (!show) return '';
  const parts: string[] = [];
  if (show.fromYear != null || show.toYear != null) {
    const from = show.fromYear != null ? String(show.fromYear) : '';
    const to = show.toYear != null ? String(show.toYear) : '';
    parts.push(from && to ? `prefer tracks from ${from}–${to}` : `prefer tracks ${from ? `from ${from} onward` : `up to ${to}`}`);
  }
  if (show.energy) parts.push(`favour ${show.energy}-energy tracks`);
  if (!parts.length) return '';
  return `\n\nMusic steer for this show — ${parts.join('; ')}. These are preferences, not hard filters: break them only when the flow genuinely demands it.`;
}

function pickerSystem(show?: ShowMusic | null, simLine: string = '') {
  const stationName = settings.get().station;
  const showLine = show?.topic
    ? `\n\nCurrent show brief — follow this for every pick:\n${show.topic}`
    : '';
  return `You are the DJ for ${stationName}, a personal internet radio station.
Pick the single best NEXT track from the candidate pool, given recent plays and the current context.${showLine}${showMusicLean(show)}${simLine}

${PICKER_CRITERIA}

Each candidate carries a "source" tag — a hint about where it came from:
- similar / similar-artist: flows from what's playing now
- embedding-similar: closest in mood / lyric / metadata space to what's playing
- audio-similar: SOUNDS closest to what's playing (timbre, instrumentation, production)
- audio-journey: SOUNDS like where the set is heading — the next step of a deliberate drift toward a destination vibe, not necessarily the current track
- recent: newly added to the library
- frequent / starred / playlist: an established favourite
- mood-library: matches the room's mood
- random: a wildcard for breaking a predictable run
Use it to balance familiarity against discovery. The two *-similar sources may
carry a "similarity" (0–1, higher = closer) — a high value means a very tight
match you can lean on for a smooth segue.

recentPlays is context for judging flow — every candidate is already guaranteed
unplayed, so you never need to reject one for being recent.

Pick exactly one candidate.`;
}

export async function pickNextTrack({ candidates, recentPlays, context, show = null, recentSimilarity = null }: {
  candidates: any[];
  recentPlays: any;
  context: any;
  show?: ShowMusic | null;
  recentSimilarity?: string | null;
}) {
  const user = JSON.stringify({
    now: {
      time: context.time?.period,
      vibe: context.time?.vibe,
      mood: context.dominantMood,
      weather: context.weather?.condition,
      festival: context.festival?.name,
    },
    recentPlays,
    candidates,
  }, null, 2);

  const simLine = recentSimilarity && show
    ? `\n\nYour recent picks cluster ${recentSimilarity}-similarity — prefer briefPool diversity.`
    : '';

  // Constrain the pick to the actual candidate ids. On a local model (llama.cpp
  // via openai-compatible / locca) this becomes a grammar so the model can only
  // emit a real id — closing the "agent returned unknown id" hole. On providers
  // that don't enforce the schema at decode time, Zod still rejects an invalid
  // id, so the caller's fallback fires instead of a bogus track. Empty pool →
  // plain string (z.enum needs ≥1 literal); pickViaPool never calls with [].
  const candidateIds = [
    ...new Set(
      (candidates || [])
        .map((c: any) => c?.id)
        .filter((id: any): id is string => typeof id === 'string' && id.length > 0),
    ),
  ];
  const idSchema = candidateIds.length
    ? z.enum(candidateIds as [string, ...string[]]).describe('the exact id of one candidate')
    : z.string().describe('the exact id of one candidate');

  return djObject({
    system: pickerSystem(show, simLine),
    prompt: user,
    schema: z.object({
      id: idSchema,
      reason: z.string().describe('one short sentence on why this one'),
    }),
    temperature: 0.5,
    kind: 'pickNextTrack',
  });
}
