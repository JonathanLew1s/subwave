// Routes library calls to the configured backend.
//
// LIBRARY_BACKEND=navidrome (default): Subsonic/OpenSubsonic via subsonic.ts
// LIBRARY_BACKEND=ma-api: music-assistant-db-api REST sidecar via ma-db-api.ts
//
// Both modules are imported eagerly — no async barrier on first use. The
// active backend is fixed at startup from config.libraryBackend (env wins over
// settings.json). Callers never reference a backend directly.

import * as _s from './subsonic.js';
import * as _m from './ma-db-api.js';
import { config } from '../config.js';

type S = typeof _s;

let _b: S | null = null;

// Resolved on first call so server.ts can apply settings.library.backend to
// config.libraryBackend before any library call happens (first pick fires
// after the event loop yields, well after startup completes).
const b = (): S =>
  (_b ??= config.libraryBackend === 'ma-api' ? (_m as unknown as S) : _s);

// Reset for tests or hot-reload scenarios (call after changing config.libraryBackend).
export function resetBackend() { _b = null; }

export const search: S['search'] = (...a) => (b().search as S['search'])(...a);
export const getRandomSongs: S['getRandomSongs'] = (...a) => (b().getRandomSongs as S['getRandomSongs'])(...a);
export const getSongsByGenre: S['getSongsByGenre'] = (...a) => (b().getSongsByGenre as S['getSongsByGenre'])(...a);
export const getGenres: S['getGenres'] = (...a) => (b().getGenres as S['getGenres'])(...a);
export const resolveGenreName: S['resolveGenreName'] = (...a) => (b().resolveGenreName as S['resolveGenreName'])(...a);
export const getSimilarSongs: S['getSimilarSongs'] = (...a) => (b().getSimilarSongs as S['getSimilarSongs'])(...a);
export const supportsSonicSimilarity: S['supportsSonicSimilarity'] = (...a) => (b().supportsSonicSimilarity as S['supportsSonicSimilarity'])(...a);
export const getSonicSimilarTracks: S['getSonicSimilarTracks'] = (...a) => (b().getSonicSimilarTracks as S['getSonicSimilarTracks'])(...a);
export const getStarred: S['getStarred'] = (...a) => (b().getStarred as S['getStarred'])(...a);
export const getAlbumList: S['getAlbumList'] = (...a) => (b().getAlbumList as S['getAlbumList'])(...a);
export const getRecentlyAddedAlbums: S['getRecentlyAddedAlbums'] = (...a) => (b().getRecentlyAddedAlbums as S['getRecentlyAddedAlbums'])(...a);
export const getFrequentAlbums: S['getFrequentAlbums'] = (...a) => (b().getFrequentAlbums as S['getFrequentAlbums'])(...a);
export const getArtistInfo: S['getArtistInfo'] = (...a) => (b().getArtistInfo as S['getArtistInfo'])(...a);
export const getTopSongs: S['getTopSongs'] = (...a) => (b().getTopSongs as S['getTopSongs'])(...a);
export const resolveArtist: S['resolveArtist'] = (...a) => (b().resolveArtist as S['resolveArtist'])(...a);
export const getRecentSongsByArtist: S['getRecentSongsByArtist'] = (...a) => (b().getRecentSongsByArtist as S['getRecentSongsByArtist'])(...a);
export const getAlbum: S['getAlbum'] = (...a) => (b().getAlbum as S['getAlbum'])(...a);
export const getSong: S['getSong'] = (...a) => (b().getSong as S['getSong'])(...a);
export const getArtist: S['getArtist'] = (...a) => (b().getArtist as S['getArtist'])(...a);
export const searchArtists: S['searchArtists'] = (...a) => (b().searchArtists as S['searchArtists'])(...a);
export const getArtistLastfmTags: S['getArtistLastfmTags'] = (...a) => (b().getArtistLastfmTags as S['getArtistLastfmTags'])(...a);
export const getLyrics: S['getLyrics'] = (...a) => (b().getLyrics as S['getLyrics'])(...a);
export const iterateAllSongs: S['iterateAllSongs'] = (...a) => (b().iterateAllSongs as S['iterateAllSongs'])(...a);
export const getPlaylists: S['getPlaylists'] = (...a) => (b().getPlaylists as S['getPlaylists'])(...a);
export const getPlaylist: S['getPlaylist'] = (...a) => (b().getPlaylist as S['getPlaylist'])(...a);
export const getCoverArtUrl: S['getCoverArtUrl'] = (...a) => (b().getCoverArtUrl as S['getCoverArtUrl'])(...a);
export const getStreamUrl: S['getStreamUrl'] = (...a) => (b().getStreamUrl as S['getStreamUrl'])(...a);
export const getRawStreamUrl: S['getRawStreamUrl'] = (...a) => (b().getRawStreamUrl as S['getRawStreamUrl'])(...a);
export const getLocalPath: S['getLocalPath'] = (...a) => (b().getLocalPath as S['getLocalPath'])(...a);
export const getPlayableUri: S['getPlayableUri'] = (...a) => (b().getPlayableUri as S['getPlayableUri'])(...a);
export const getAnnotatedUri: S['getAnnotatedUri'] = (...a) => (b().getAnnotatedUri as S['getAnnotatedUri'])(...a);
export const isStationArchive: S['isStationArchive'] = (...a) => (b().isStationArchive as S['isStationArchive'])(...a);
