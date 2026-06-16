// Routes library calls to the configured backend.
// Default: subsonic (Navidrome) — the upstream-tracked path.
// Set LIBRARY_BACKEND=music-assistant to use Music Assistant instead.
//
// All callers import from here; the underlying module is a runtime detail.
// Upstream changes to subsonic.ts continue to flow into the Navidrome path
// without touching this file or the MA implementation.

type API = typeof import('./subsonic.js');

const api: API =
  process.env.LIBRARY_BACKEND === 'music-assistant'
    ? ((await import('./ma-api.js')) as unknown as API)
    : await import('./subsonic.js');

export const search = api.search;
export const getRandomSongs = api.getRandomSongs;
export const getSongsByGenre = api.getSongsByGenre;
export const getGenres = api.getGenres;
export const resolveGenreName = api.resolveGenreName;
export const getSimilarSongs = api.getSimilarSongs;
export const supportsSonicSimilarity = api.supportsSonicSimilarity;
export const getSonicSimilarTracks = api.getSonicSimilarTracks;
export const getStarred = api.getStarred;
export const getAlbumList = api.getAlbumList;
export const getRecentlyAddedAlbums = api.getRecentlyAddedAlbums;
export const getFrequentAlbums = api.getFrequentAlbums;
export const getArtistInfo = api.getArtistInfo;
export const getTopSongs = api.getTopSongs;
export const getAlbum = api.getAlbum;
export const getSong = api.getSong;
export const getArtist = api.getArtist;
export const searchArtists = api.searchArtists;
export const getArtistLastfmTags = api.getArtistLastfmTags;
export const getLyrics = api.getLyrics;
export const iterateAllSongs = api.iterateAllSongs;
export const getPlaylists = api.getPlaylists;
export const getPlaylist = api.getPlaylist;
export const getCoverArtUrl = api.getCoverArtUrl;
export const getStreamUrl = api.getStreamUrl;
export const getRawStreamUrl = api.getRawStreamUrl;
export const getLocalPath = api.getLocalPath;
export const getPlayableUri = api.getPlayableUri;
export const getAnnotatedUri = api.getAnnotatedUri;
export const isStationArchive = api.isStationArchive;
