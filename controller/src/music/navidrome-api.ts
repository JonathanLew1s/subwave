// Navidrome native API client — popularity tag fetcher.
// Navidrome's custom tags (TrackPopularity, AlbumPopularity) are exposed via
// the native /api/song endpoint but NOT via Subsonic /rest/getSong.
// Separate walk from the Subsonic metadata pipeline.

let sessionJwt: string | null = null;

export async function login(username: string, password: string): Promise<string> {
  const url = process.env.NAVIDROME_URL || 'http://navidrome-ui:4533';
  const res = await fetch(`${url}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`Navidrome login failed: ${res.status}`);
  const data = await res.json() as any;
  const token = data.token;
  if (!token) throw new Error('Navidrome login response missing token');
  sessionJwt = token;
  return token;
}

export async function* iteratePopularityTags(
  username: string,
  password: string,
  batchSize: number = 500,
): AsyncGenerator<{ id: string; trackPopularity: number | null; albumPopularity: number | null }> {
  const token = sessionJwt || (await login(username, password));
  const url = process.env.NAVIDROME_URL || 'http://navidrome-ui:4533';

  let start = 0;
  let hasMore = true;

  while (hasMore) {
    const res = await fetch(
      `${url}/api/song?_start=${start}&_end=${start + batchSize}&_sort=id`,
      { headers: { 'x-nd-authorization': `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(`Navidrome pagination failed at offset ${start}: ${res.status}`);

    const songs = await res.json();
    if (!Array.isArray(songs) || songs.length === 0) {
      hasMore = false;
      break;
    }

    for (const song of songs) {
      const trackPopStr = song.tags?.trackpopularity?.[0];
      const albumPopStr = song.tags?.albumpopularity?.[0];
      yield {
        id: song.id,
        trackPopularity: trackPopStr ? parseFloat(trackPopStr) : null,
        albumPopularity: albumPopStr ? parseFloat(albumPopStr) : null,
      };
    }

    if (songs.length < batchSize) {
      hasMore = false;
    } else {
      start += batchSize;
    }
  }
}
