// DJ prompt layer — builds the system/user prompts for every LLM task and
// hands them to the AI SDK wrapper (sdk.js). The actual provider is resolved
// by provider.js, so this file is provider-agnostic.
//
// Two task shapes:
//   1. Request matching / track picking: structured output (Zod-validated)
//   2. DJ script generation: free text under a persona system prompt

import * as settings from '../settings.js';
import * as library from '../music/library.js';
import { djText } from './sdk.js';
import { recentCalls } from './log.js';

// Re-exported so routes/debug.js can read the LLM call ring buffer through the
// same module that produces the calls. record() is internal — sdk.js writes,
// nothing else should.
export { recentCalls };

// Paralinguistic tags Chatterbox renders as actual non-verbal sounds. Every
// other engine (piper, kokoro, cloud) reads `[laugh]` aloud as the word
// "laugh", so we only mention this when the on-air persona will actually be
// voiced by Chatterbox.
const CHATTERBOX_TAG_HINT =
  '\n\nYou may sparingly insert non-verbal cues in square brackets: [laugh], [chuckle], [sigh], [cough]. Use them only where genuinely natural — at most one per segment, and never as filler.';

// Resolve the DJ system prompt for the persona on air right now. The effective
// persona is the current show's owner if a show is scheduled for this hour,
// otherwise the admin-selected active persona — see settings.getEffectivePersona.
export function djSystem() {
  const persona = settings.getEffectivePersona();
  const s = settings.get();
  const base = settings.renderDjPrompt(persona, {
    station: s.station,
    location: s.weather?.locationName,
  });
  if (persona?.tts?.engine === 'chatterbox') return base + CHATTERBOX_TAG_HINT;
  return base;
}

// Persona-driven verbosity. 'concise' reproduces the historical one-liner
// segment lengths; 'extended' roughly doubles every segment so a storytelling
// persona can stretch out. Resolved from the on-air persona, the same way
// djSystem() resolves it — see settings.getEffectivePersona / SCRIPT_LENGTHS.
const LENGTH_PHRASES = {
  concise: {
    intro:     'Keep it brief — 2 to 4 sentences.',
    link:      '1-2 sentences',
    stationId: 'a 1-sentence station ident',
    hourly:    '1 sentence',
    adlib:     '1-2 sentences',
    segment:   'one sentence',
  },
  extended: {
    intro:     'Take your time — 5 to 8 sentences. Set a scene, tell a small story around the track.',
    link:      '4-6 sentences',
    stationId: 'a 2-3 sentence station ident',
    hourly:    '2-3 sentences',
    adlib:     '4-6 sentences',
    segment:   'three to five sentences',
  },
};

export function lengthMode(persona: any = settings.getEffectivePersona()) {
  return persona?.scriptLength === 'extended' ? 'extended' : 'concise';
}

// The length directive for one segment kind, for the on-air (or given) persona.
export function lengthPhrase(kind: string, persona?: any) {
  const m = (LENGTH_PHRASES as any)[lengthMode(persona)];
  return m[kind] || m.link;
}

// Intro runway (ms to where the track 'comes in') for a track, from the track
// object or a library lookup. Null when un-analysed.
function introMsFor(track: any): number | null {
  if (track?.introMs != null) return track.introMs;
  const rec = track?.id ? library.get(track.id) : null;
  return rec?.introMs ?? null;
}

function bpmKeyFor(track: any): { bpm: number | null; key: string | null } {
  if (track && (track.bpm != null || track.musicalKey != null)) {
    return { bpm: track.bpm ?? null, key: track.musicalKey ?? null };
  }
  const rec = track?.id ? library.get(track.id) : null;
  return { bpm: rec?.bpm ?? null, key: rec?.musicalKey ?? null };
}

// Turn a known intro runway into an advisory spoken-line budget so the DJ
// lands before the vocals enter (Stage A.3 phase 1 — "talk within the intro").
// Returns '' when there's no usable runway, so un-analysed tracks are never
// constrained: the post is a bonus when the data exists, never a precondition.
export function introBudgetPhrase(introMs: number | null | undefined): string {
  if (!introMs || introMs < 2500) return '';
  if (introMs >= 18000) return '';
  const sec = Math.floor(introMs / 1000);
  if (introMs < 6000) {
    return `The track's vocals come in around ${sec}s — keep this to a single short phrase that finishes before then; never run past it.`;
  }
  return `The track's vocals come in around ${sec}s — you have room for a sentence or two; use it, but land your last word before then rather than talking over the vocals.`;
}

// Hard backstop for talk-within-the-intro (Stage A.3 phase 2): the budget
// PHRASE above is advisory — a small model will still occasionally overrun the
// runway. This enforces it deterministically. Speaking pace is ~2.5 words/sec,
// so a known intro runway maps to a word ceiling; over-long lines are trimmed
// to the last sentence that fits, and only hard-cut mid-sentence if even one
// sentence won't fit. Returns the text unchanged when there's no usable runway
// (null, very short, or a long ≥18s intro), so un-analysed tracks are never
// touched — symmetric with introBudgetPhrase's guards.
export function enforceIntroBudget(text: string, introMs: number | null | undefined): string {
  const t = (text || '').trim();
  if (!t || !introMs || introMs < 2500 || introMs >= 18000) return t;
  const WORDS_PER_SEC = 2.5;
  const maxWords = Math.max(3, Math.floor((introMs / 1000) * WORDS_PER_SEC));
  const words = t.split(/\s+/);
  if (words.length <= maxWords) return t;

  // Trim to the last sentence boundary that fits the budget.
  const capped = words.slice(0, maxWords).join(' ');
  const lastStop = Math.max(capped.lastIndexOf('.'), capped.lastIndexOf('!'), capped.lastIndexOf('?'));
  if (lastStop >= Math.floor(capped.length * 0.4)) {
    return capped.slice(0, lastStop + 1).trim();
  }
  // No sentence boundary worth keeping — hard cut and punctuate cleanly.
  return capped.replace(/[,;:\-—\s]+$/, '') + '…';
}

// Narrative angles per call type. One is picked at random and injected into
// the user prompt as "Tone for this segment:" so consecutive generations
// don't fall back to the same shape. Only the generate* callers in this file
// consume these — the segment director (skills/_agent.js) gets its variety
// from its CAPABILITIES descriptions and from picking a different capability
// each tick, so it doesn't go through pickAngle. Add freely — the more
// variety here, the less the DJ repeats itself.
export const ANGLES = {
  intro: [
    'Open with one specific image from right now (weather, time, day, season) and slide into the track.',
    'Mention the artist in passing — one detail (era, scene, mood) — not a full title-and-artist back-announce.',
    'Skip the introduction entirely and start mid-thought, as if continuing a conversation.',
    'React to the request itself — what kind of request it is, what mood it suggests — before mentioning the track.',
    'Use a short personal observation about the moment (Tuesday energy, the rain holding off, etc.) as the doorway.',
    'Lean into contrast: how this track sits against what came before, or against the time of day.',
    'Just say one true sentence and let the music start.',
  ],
  link: [
    'Comment on a contrast or similarity between the two tracks (era, mood, instrumentation, tempo).',
    'Tie the next track to the time of day, weather, or season — specifically, not generically.',
    'Mention something small and tactile about right now (the rain, the dark, the smell of coffee, the day of the week).',
    'Reference the previous artist or song obliquely — one detail, no full back-announce.',
    'Skip the back-announce entirely and just open a small thought about what is next.',
    'Acknowledge a listener-shaped moment (commute, late shift, weekend, midweek lull) without naming any listener.',
    'Make one quiet observation that has nothing to do with either track and let the next song answer it.',
  ],
  station_id: [
    'Plain ident — say the station name and the DJ name, nothing else.',
    'Anchor the ident to the current moment (a Tuesday afternoon, a foggy evening, the slow part of Sunday).',
    'Make it a near-aside: like someone reminding themselves where they are.',
    'Open with the time or weather, then drop the station name in the middle of the sentence.',
    'A single observation about broadcasting from a homelab, with the station name woven in.',
  ],
  hourly: [
    'State the time as a small fact, then anchor it with one observation about the day.',
    'Treat the hour mark like a quiet check-in, not a bulletin.',
    'Open with where in the day we are (mid-afternoon lull, evening getting started, etc.) before the actual time.',
    'Just one short sentence that happens to mention the time.',
    'Acknowledge what kind of listener might be tuning in at this exact hour, without naming them.',
  ],
};

export function pickAngle(kind: string) {
  const list = (ANGLES as any)[kind];
  if (!list || list.length === 0) return null;
  return list[Math.floor(Math.random() * list.length)];
}

export function randomSeed() {
  return Math.floor(Math.random() * 1_000_000_000);
}

// Build the shared "right now" context block. Used by every generate* function
// in this file, by matchRequest, and by the segment director (skills/_agent.js)
// — so they all show the model the same picture of the current moment.
export function buildContextLines(context: any, { recentTracks }: { recentTracks?: any[] } = {}) {
  const lines: string[] = [];
  if (context?.date) {
    lines.push(`Day: ${context.date.dayLabel}, ${context.date.dayOfMonth} ${context.date.monthLabel} (${context.date.season})`);
  }
  if (context?.clock) {
    const tags: string[] = [];
    if (context.clock.isWeekend) tags.push('weekend');
    if (context.clock.isLateNight) tags.push('late night');
    if (context.clock.isCommute) tags.push('commute hour');
    lines.push(`Local time: ${context.clock.hhmm}${tags.length ? ' · ' + tags.join(' · ') : ''}`);
  }
  if (context?.time) lines.push(`Period: ${context.time.period} (${context.time.vibe})`);
  if (context?.weather && context.weather.condition && context.weather.condition !== 'unknown') {
    lines.push(`Weather in ${context.weather.location}: ${context.weather.condition}${context.weather.temp != null ? `, ${context.weather.temp}°${context.weather.tempUnit || 'C'}` : ''}`);
  }
  if (context?.festival) lines.push(`Festival: ${context.festival.name}`);
  if (context?.activeShow) {
    const topic = context.activeShow.topic ? ` — ${context.activeShow.topic}` : '';
    lines.push(`On now: the show "${context.activeShow.name}"${topic}. Stay loosely on its theme.`);
  }
  if (context?.listeners?.count != null) {
    const n = context.listeners.count;
    lines.push(n === 0
      ? `No one is tuned in right now.`
      : `Listeners tuned in right now: ${n}.`);
  }
  if (recentTracks && recentTracks.length) {
    const list = recentTracks.slice(0, 5).map((t: any) => `"${t.title}" by ${t.artist || 'unknown'}`).join('; ');
    lines.push(`Recently played (do not mention these artists or titles): ${list}`);
  }
  return lines;
}

// Append rotating angle + recap + opener blocklist to the user prompt.
export function decoratePrompt(
  prompt: string,
  { kind, recap, recentOpeners }: { kind: string; recap?: string | null; recentOpeners?: string[] | null },
) {
  const out: string[] = [prompt];
  const angle = pickAngle(kind);
  if (angle) out.push(`\nTone for this segment: ${angle}`);
  if (recap) out.push(`\nYou said these things on-air recently (do not repeat phrasing or topics):\n${recap}`);
  if (recentOpeners && recentOpeners.length) {
    const list = recentOpeners.slice(0, 6).map((o: string) => `"${o}…"`).join(', ');
    out.push(`\nDo not start your line with any of these openers (vary the first words): ${list}`);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// DJ SCRIPTS — creative spoken segments
// ---------------------------------------------------------------------------

export async function generateIntro({ track, context, requestedBy = null, requestText = null, recap = null, recentTracks = null, recentOpeners = null }: any) {
  const ctxLines = buildContextLines(context, { recentTracks });
  if (requestedBy) ctxLines.push(`Requested by: ${requestedBy}`);
  if (requestText) {
    // Clip and sanitise so a long request can't dominate the prompt or break formatting.
    const clipped = String(requestText).replace(/\s+/g, ' ').trim().slice(0, 200);
    if (clipped) ctxLines.push(`Listener asked: "${clipped}"`);
  }
  ctxLines.push(`Coming up: "${track.title}" by ${track.artist}${track.album ? ` from ${track.album}` : ''}${track.year ? ` (${track.year})` : ''}`);

  // Talk-within-the-intro (A.3 phase 1): when the track's intro runway is
  // known, budget the line to land before the vocals. Advisory + additive —
  // empty for un-analysed tracks, so behaviour is unchanged there.
  const budget = introBudgetPhrase(introMsFor(track));
  const prompt = `Write an intro for this track. ${lengthPhrase('intro')}${budget ? ' ' + budget : ''} If the listener said something specific, acknowledge their words naturally — don't quote them verbatim, but weave the gist in. Never read the request out loud as-is.\n\n${ctxLines.join('\n')}`;

  return djText({
    system: djSystem(),
    prompt: decoratePrompt(prompt, { kind: 'intro', recap, recentOpeners }),
    temperature: 0.95, topP: 0.92, repeatPenalty: 1.2, seed: randomSeed(),
    kind: 'generateIntro',
  });
}

export async function generateStationId({ recap = null, context = null, recentOpeners = null }: any = {}) {
  const djName = settings.getEffectivePersona()?.name || 'your host';
  const stationName = settings.get().station;
  const ctxLines = buildContextLines(context);
  ctxLines.push(`Task: ${lengthPhrase('stationId')} for ${stationName} with ${djName}. A little understated.`);
  return djText({
    system: djSystem(),
    prompt: decoratePrompt(ctxLines.join('\n'), { kind: 'station_id', recap, recentOpeners }),
    temperature: 1.0, topP: 0.9, repeatPenalty: 1.25, seed: randomSeed(),
    kind: 'generateStationId',
  });
}

// Operator ad-lib — the command-center "manual voice DJ" in styled mode.
// Takes a free-text instruction/topic and performs it in character, rather
// than reading it verbatim (that's what raw mode is for).
export async function generateAdLib({ instruction, context = null, recap = null, recentOpeners = null }: any) {
  const ctxLines = buildContextLines(context);
  const clipped = String(instruction || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  ctxLines.push(`Task: the station operator wants you to say something on-air. Their instruction: "${clipped}". Deliver it in character as a natural spoken line — don't read the instruction back verbatim, perform it. ${lengthPhrase('adlib')}.`);
  return djText({
    system: djSystem(),
    prompt: decoratePrompt(ctxLines.join('\n'), { kind: 'adlib', recap, recentOpeners }),
    temperature: 0.95, topP: 0.92, repeatPenalty: 1.2, seed: randomSeed(),
    kind: 'generateAdLib',
  });
}

export async function generateLink({ previous, current, context, recap = null, recentTracks = null, recentOpeners = null }: any) {
  const ctxLines = buildContextLines(context, { recentTracks });
  if (previous?.title) ctxLines.push(`Just played: "${previous.title}" by ${previous.artist || 'unknown'}`);
  if (current?.title) ctxLines.push(`Now playing: "${current.title}" by ${current.artist || 'unknown'}`);

  // DJ-mode personas tease what's coming, not just back-announce — mirrors the
  // agent path in broadcast/dj-agent.ts so both pickers feel like the same DJ.
  const djMode = !!settings.getEffectivePersona()?.djMode;
  const teaseClause = djMode
    ? ` Tease what's coming — name the artist or capture the feel so listeners know what's next.`
    : '';
  // DJ-mode mix patter: only when BOTH tracks carry measured tempo/key, and
  // only as a natural option — never forced, never robotic numbers on air.
  const prevAK = bpmKeyFor(previous);
  const curAK = bpmKeyFor(current);
  const patterClause = (djMode && (prevAK.bpm || prevAK.key) && (curAK.bpm || curAK.key))
    ? ` You may nod to the mix if it feels natural — e.g. easing into something a touch faster or slower, or how it sits in key — but never say raw numbers.`
    : '';
  // Talk-within-the-intro budget for the track now starting (current = the pick).
  const budget = introBudgetPhrase(introMsFor(current));
  const prompt = `Write a DJ link between tracks. Back-announce what just played and ease into what's playing now.${teaseClause}${patterClause}${budget ? ' ' + budget : ''} ${lengthPhrase('link')}, conversational, don't list both titles like a robot — pick one to mention specifically and treat the other lightly.\n\n${ctxLines.join('\n')}`;

  return djText({
    system: djSystem(),
    prompt: decoratePrompt(prompt, { kind: 'link', recap, recentOpeners }),
    temperature: 0.95, topP: 0.92, repeatPenalty: 1.2, seed: randomSeed(),
    kind: 'generateLink',
  });
}

export async function generateHourlyTime(time: any, weather: any, { recap = null, context = null, recentOpeners = null }: any = {}) {
  const ctx = context || { time, weather };
  const ctxLines = buildContextLines(ctx);
  ctxLines.push(`Task: a brief top-of-the-hour time check, in character. ${lengthPhrase('hourly')}.`);
  return djText({
    system: djSystem(),
    prompt: decoratePrompt(ctxLines.join('\n'), { kind: 'hourly', recap, recentOpeners }),
    temperature: 0.9, topP: 0.95, repeatPenalty: 1.15, seed: randomSeed(),
    kind: 'generateHourlyTime',
  });
}

export { matchRequest, identifyTrackFromText } from './internal/prompts/request.js';
export { PICKER_CRITERIA, pickNextTrack, showMusicLean } from './internal/prompts/picker.js';
