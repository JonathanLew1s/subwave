// Backfills tracks.popularity_song / tracks.popularity_album from Navidrome's
// native /api/song endpoint (TrackPopularity / AlbumPopularity custom tags,
// sourced from beets). Shared by the analyze-library CLI (npm run analyze
// -- --walk) and the controller's cron scheduler (broadcast/scheduler.ts),
// which runs this on boot and weekly so newly-tagged/added tracks pick up
// popularity scores without an operator running the CLI.

import * as db from './library-db.js';
import * as navidrome from './navidrome-api.js';
import { config } from '../config.js';
import * as library from './library.js';

export async function refreshPopularity(): Promise<number> {
  if (!config.navidrome.user || !config.navidrome.password) {
    throw new Error('Navidrome credentials not configured');
  }
  await library.load();
  let count = 0;
  for await (const pop of navidrome.iteratePopularityTags(config.navidrome.user, config.navidrome.password)) {
    db.setPopularity(pop.id, { song: pop.trackPopularity, album: pop.albumPopularity });
    count++;
  }
  return count;
}
