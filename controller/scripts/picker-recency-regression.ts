import assert from 'node:assert/strict';
import {
  DEFAULT_ARTIST_RECENCY_HOURS,
  DEFAULT_TRACK_RECENCY_HOURS,
  coreArtistKey,
  filterPickerCandidates,
  recencyWindowsForLibrary,
} from '../src/music/recency.js';
import { buildSequencedPlaylist } from '../src/music/pool.js';
import { pickFallback } from '../src/music/picker.js';

const smallLibraryWindows = recencyWindowsForLibrary(10);
assert(
  smallLibraryWindows.trackHours < DEFAULT_TRACK_RECENCY_HOURS,
  `expected small-library track window to shrink below ${DEFAULT_TRACK_RECENCY_HOURS}h, got ${smallLibraryWindows.trackHours}h`,
);
assert(
  smallLibraryWindows.artistHours < DEFAULT_ARTIST_RECENCY_HOURS,
  `expected small-library artist window to shrink below ${DEFAULT_ARTIST_RECENCY_HOURS}h, got ${smallLibraryWindows.artistHours}h`,
);

const largeLibraryWindows = recencyWindowsForLibrary(80);
assert.equal(largeLibraryWindows.trackHours, DEFAULT_TRACK_RECENCY_HOURS);
assert.equal(largeLibraryWindows.artistHours, DEFAULT_ARTIST_RECENCY_HOURS);

const songs = [
  { id: 'song-1', title: 'One', artist: 'A' },
  { id: 'song-2', title: 'Two', artist: 'B' },
  { id: 'song-3', title: 'Three', artist: 'C' },
];

const recentArtists = new Set(songs.map((song) => song.artist.toLowerCase()));
const relaxed = filterPickerCandidates(songs, { recentArtists, cap: 2 });
assert(
  relaxed.length > 0,
  'expected picker filtering to relax recent artists instead of returning an empty candidate set',
);
assert.equal(relaxed.length, 2);

const strictWhenPossible = filterPickerCandidates(songs, {
  recentArtists: new Set(['a']),
  cap: 2,
});
assert.deepEqual(
  strictWhenPossible.map((song) => song.id),
  ['song-2', 'song-3'],
  'expected picker filtering to keep strict recency exclusions when candidates remain',
);

const recentlyPlayedSongs = filterPickerCandidates(songs, {
  recentIds: new Set(songs.map((song) => song.id)),
  recentKeys: new Set(songs.map((song) => `${song.title.toLowerCase()}|${song.artist.toLowerCase()}`)),
});
assert(
  recentlyPlayedSongs.length > 0,
  'expected picker filtering to relax recent tracks when every candidate is otherwise excluded',
);

// Collab-credit collisions: "Prince" vs "Prince and The Revolution", and
// "John Lennon" vs "John Lennon / Yoko Ono" must resolve to the same core key
// so alternating between credit variants doesn't defeat the artist block.
assert.equal(coreArtistKey({ artist: 'Prince and The Revolution' }), 'prince');
assert.equal(coreArtistKey({ artist: 'Prince' }), 'prince');
assert.equal(coreArtistKey({ artist: 'John Lennon / Yoko Ono' }), 'john lennon');
assert.equal(coreArtistKey({ artist: 'John Lennon' }), 'john lennon');

const collabSongs = [
  { id: 'c-1', title: 'Purple Rain', artist: 'Prince and The Revolution' },
  { id: 'c-2', title: 'Kiss', artist: 'Prince' },
  { id: 'c-3', title: 'Pulled Apart By Horses', artist: 'Tricky' },
];

// recentArtistsSince() now adds both the exact credit string and its core
// form for the just-played track, so a "Prince and The Revolution" play
// should block a follow-up "Prince" candidate via the shared core key.
const collabBlocked = filterPickerCandidates(collabSongs, {
  recentArtists: new Set(['prince and the revolution', 'prince']),
  cap: 5,
});
assert.deepEqual(
  collabBlocked.map((song) => song.id),
  ['c-3'],
  'expected "Prince" to be blocked when "Prince and The Revolution" was just played (core-artist match)',
);

// Per-artist cap counting should also key off the core artist, so "Prince"
// and "Prince and The Revolution" credits count toward the same cap.
const capSongs = [
  { id: 'p-1', title: 'Purple Rain', artist: 'Prince and The Revolution' },
  { id: 'p-2', title: 'Kiss', artist: 'Prince' },
  { id: 'p-3', title: '1999', artist: 'Prince' },
  { id: 'p-4', title: 'Pulled Apart By Horses', artist: 'Tricky' },
];
const capped = filterPickerCandidates(capSongs, { maxPerArtist: 1, cap: 5 });
assert.deepEqual(
  capped.map((song) => song.id),
  ['p-1', 'p-4'],
  'expected maxPerArtist to count "Prince" and "Prince and The Revolution" credits together',
);

// --- justPlayedArtists hard floor (Aphex Twin back-to-back regression) -----
// An artist-homogeneous candidate list (e.g. tracksLikeThis seeded on the
// just-played track) must never re-admit that artist, even when the cascade
// would otherwise relax recentArtists to avoid an empty result.
const homogeneousSongs = [
  { id: 'aphex-1', title: 'Track A', artist: 'Aphex Twin' },
  { id: 'aphex-2', title: 'Track B', artist: 'Aphex Twin' },
  { id: 'aphex-3', title: 'Track C', artist: 'Aphex Twin' },
];
const justPlayedBlocked = filterPickerCandidates(homogeneousSongs, {
  recentArtists: new Set(['aphex twin']),
  justPlayedArtists: new Set(['aphex twin']),
  cap: 5,
});
assert.deepEqual(
  justPlayedBlocked,
  [],
  'expected justPlayedArtists to block an artist-homogeneous list entirely, even via the relaxation cascade',
);

// Pathological case: an entirely single-artist input list, all by the
// just-played artist — legitimately yields zero candidates from this list.
// (Other tools / the mood-pool reserve are expected to cover the pick.)
const singleArtistLibrary = [
  { id: 'solo-1', title: 'Only Track', artist: 'Solo Artist' },
];
const singleArtistBlocked = filterPickerCandidates(singleArtistLibrary, {
  recentArtists: new Set(['solo artist']),
  justPlayedArtists: new Set(['solo artist']),
  cap: 5,
});
assert.deepEqual(
  singleArtistBlocked,
  [],
  'expected justPlayedArtists to block a single-artist input list entirely, with no relaxation',
);

// --- relaxArtists:false (mood-pool-already-supplied alternatives) ----------
// When relaxArtists is false, the cascade must not fall through to the mode
// that drops the recentArtists exclusion — a same-recent-artist candidate
// should be dropped entirely rather than reintroduced.
const relaxArtistsOff = filterPickerCandidates(homogeneousSongs, {
  recentArtists: new Set(['aphex twin']),
  relaxArtists: false,
  cap: 5,
});
assert.deepEqual(
  relaxArtistsOff,
  [],
  'expected relaxArtists:false to suppress the recentArtists-dropping cascade mode',
);

// Sanity: relaxArtists:true (default) still relaxes recentArtists when
// candidates would otherwise be empty (existing "never empty" behaviour).
const relaxArtistsOn = filterPickerCandidates(homogeneousSongs, {
  recentArtists: new Set(['aphex twin']),
  relaxArtists: true,
  cap: 5,
});
assert(
  relaxArtistsOn.length > 0,
  'expected relaxArtists:true (default) to preserve the existing never-empty relaxation',
);

// --- buildSequencedPlaylist (auto-playlist recency parity) -----------------
// A pool with two artists alternated, plus a duplicate-artist run, must
// sequence so no two adjacent slots share a coreArtistKey.
const sequencingPool = [
  { id: 'seq-1', title: 'A1', artist: 'Adele' },
  { id: 'seq-2', title: 'A2', artist: 'Adele' },
  { id: 'seq-3', title: 'A3', artist: 'Adele' },
  { id: 'seq-4', title: 'B1', artist: 'Bonobo' },
  { id: 'seq-5', title: 'B2', artist: 'Bonobo' },
  { id: 'seq-6', title: 'C1', artist: 'Tricky' },
];
const sequenced = buildSequencedPlaylist(sequencingPool, 6);
for (let i = 1; i < sequenced.length; i++) {
  assert.notEqual(
    coreArtistKey(sequenced[i]),
    coreArtistKey(sequenced[i - 1]),
    `expected no back-to-back same-artist tracks in sequenced playlist, got ${sequenced[i - 1].artist} -> ${sequenced[i].artist} at index ${i}`,
  );
}

// Seeding justPlayedArtists from the live queue must keep slot 0 from
// repeating whatever just played, even though nothing in this playlist has
// played yet.
const seededSequence = buildSequencedPlaylist(sequencingPool, 6, {
  justPlayedArtists: new Set(['adele']),
});
assert.notEqual(
  coreArtistKey(seededSequence[0]),
  'adele',
  'expected seeded justPlayedArtists to keep slot 0 from repeating the live queue\'s just-played artist',
);

// --- pickFallback (pickViaPool fallback paths) ------------------------------
// candidates[0] must be skipped when it matches justPlayedArtists, falling
// through to the next candidate by a different artist.
const fallbackCandidates = [
  { id: 'fb-1', title: 'Just Played Again', artist: 'Aphex Twin' },
  { id: 'fb-2', title: 'Something Else', artist: 'Bonobo' },
];
assert.equal(
  pickFallback(fallbackCandidates, new Set(['aphex twin'])).id,
  'fb-2',
  'expected pickFallback to skip candidates[0] when it matches justPlayedArtists',
);

// When every candidate matches justPlayedArtists, fall back to candidates[0]
// rather than returning nothing.
assert.equal(
  pickFallback(fallbackCandidates, new Set(['aphex twin', 'bonobo'])).id,
  'fb-1',
  'expected pickFallback to fall back to candidates[0] when every candidate matches justPlayedArtists',
);

// No justPlayedArtists at all — candidates[0] as before.
assert.equal(
  pickFallback(fallbackCandidates, new Set()).id,
  'fb-1',
  'expected pickFallback to return candidates[0] when justPlayedArtists is empty',
);

console.log('picker-recency regression checks passed');
