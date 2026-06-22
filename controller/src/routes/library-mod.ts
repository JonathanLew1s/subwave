// Fork-specific MA-backend response builders for routes/library.ts. Each
// export here corresponds to one `if (config.libraryBackend === 'ma-api')`
// dispatch point in library.ts, so upstream changes to the Navidrome-mode
// handlers never collide with the MA-mode branch logic.
import * as library from '../music/library.js';
import * as settings from '../settings.js';
import * as maDbApi from '../music/ma-db-api.js';

// GET /library/observatory, ma-api branch — the sidecar already returns one
// row per CLAP-analysed track, so there's no local-DB sampling/truncation to
// do; `withAudioEmbedding` is reported as the full total since every row here
// is, by construction, audio-analysed.
export async function observatoryMa(max: number, hardMax: number) {
  const stats = library.stats();
  const tracks = await library.allTaggedForObservatory(max);
  return {
    tracks,
    truncated: false,
    sampled: false,
    max,
    hardMax,
    moodVocab: settings.SHOW_MOODS,
    stats: {
      ...stats,
      withAudioEmbedding: stats.total,
    },
  };
}

// Downsamples the sidecar's raw rms_energy time series (~1800 evenly-spaced
// samples spanning the track, values already 0..1) into a bounded number of
// PaceSpan buckets for the dossier's SONG SHAPE curve. Chunk-averages rather
// than dropping samples, so a quiet passage with a brief loud transient still
// shows up rather than being skipped by a stride. Returns null below
// MIN_RMS_SAMPLES — too few points to draw a meaningful curve.
const PACE_BUCKETS = 90;
const MIN_RMS_SAMPLES = 8;
function paceFromRmsEnergy(rms: number[] | null | undefined, durationMs: number): { startMs: number; endMs: number; value: number }[] | null {
  if (!Array.isArray(rms) || rms.length < MIN_RMS_SAMPLES || durationMs <= 0) return null;
  const buckets = Math.min(PACE_BUCKETS, rms.length);
  const spans: { startMs: number; endMs: number; value: number }[] = [];
  for (let i = 0; i < buckets; i++) {
    const lo = Math.floor((i / buckets) * rms.length);
    const hi = Math.max(lo + 1, Math.floor(((i + 1) / buckets) * rms.length));
    const slice = rms.slice(lo, hi);
    const avg = slice.reduce((s, v) => s + v, 0) / slice.length;
    spans.push({
      startMs: Math.round((i / buckets) * durationMs),
      endMs: Math.round(((i + 1) / buckets) * durationMs),
      value: Math.max(0, Math.min(1, avg)),
    });
  }
  return spans;
}

// GET /library/observatory/track/:id, ma-api branch — tracks live in the
// sidecar's SQLite library, not the local library-db. Pulls full analysis
// (?include=analysis is required by the sidecar — omitting it silently nulls
// every analysis field) plus a CLAP-similarity mixNext via tracksLikeThis.
// structure/vocalRanges/keyRanges have no MA-sidecar equivalent (no section,
// vocal-activity, or key-modulation detection there) and stay null — but
// rms_energy gives us a real pace curve, so SONG SHAPE isn't unconditionally
// empty for every MA-backend track (see paceFromRmsEnergy above).
export async function observatoryTrackMa(id: string) {
  // clap_embedding is gated behind its own include flag — `analysis` alone
  // always comes back null for it (verified live: a track with a confirmed
  // real 1024-dim CLAP vector under ?include=analysis,clap returns none
  // under ?include=analysis), so the dossier's AUDIO fingerprint had never
  // actually rendered for any MA track until this was added.
  const t = await maDbApi.apiGet(`/tracks/${id}`, { include: 'analysis,clap' });
  const clap: number[] | null = t.analysis?.clap_embedding ?? null;
  const instrm: number | null = t.analysis?.instrumentalness ?? null;
  const energy: number | null = t.analysis?.energy ?? null;
  const energyLabel = energy == null ? null : energy >= 0.22 ? 'high' : energy >= 0.11 ? 'medium' : 'low';
  const durationMs = (t.duration ?? 0) * 1000;
  const pace = paceFromRmsEnergy(t.analysis?.rms_energy, durationMs);
  const mixNext = (await library.tracksLikeThis(id, 8)).map((n: any) => ({
    id: n.id,
    title: n.title,
    artist: n.artist,
    bpm: n.bpm ?? null,
    musicalKey: n.musicalKey ?? null,
    energy: n.energy ?? null,
    similarity: n._similarity ?? null,
  }));
  return {
    track: {
      id: String(t.id),
      title: t.title ?? null,
      artist: t.artist ?? null,
      album: t.album ?? null,
      year: t.year ?? null,
      genre: t.genres?.[0] ?? null,
      durationSec: t.duration ?? null,
      bpm: t.analysis?.bpm != null ? Math.round(t.analysis.bpm * 10) / 10 : null,
      musicalKey: t.analysis?.camelot ?? t.analysis?.key ?? null,
      loudnessLufs: t.analysis?.loudness_lufs ?? null,
      energy: energyLabel,
      source: 'ma-api',
      moods: [],
      confidence: null,
      taggerVersion: null,
      model: null,
      taggedAt: null,
      lastfmTags: null,
      lyricExcerpt: null,
      introMs: null,
      analysisConfidence: null,
      analysisVersion: null,
      peakDb: null,
      structure: null,
      // null = not analysed (no section/vocal/key-modulation detection on the
      // MA sidecar). pace IS available — derived from rms_energy above.
      vocalRanges: null,
      // Coarse fallback for the SONG SHAPE VOICE lane when vocalRanges is null
      // — same instrumentalness threshold as shapeObservatoryTrack's `vocal`
      // field (library-ma.ts), so the dossier stops contradicting the bulk
      // list's own vocal/instrumental badge for the same track.
      vocalCoarse: instrm == null ? null : instrm > 0.5 ? 'instrumental' : 'vocal',
      pace,
      keyRanges: null,
    },
    textEmbedding: null,
    audioEmbedding: clap,
    mixNext,
    _maAnalysis: {
      valence: t.analysis?.valence ?? null,
      arousal: t.analysis?.arousal ?? null,
      danceability: t.analysis?.danceability ?? null,
      acousticness: t.analysis?.acousticness ?? null,
      instrumentalness: instrm,
      brightness: t.analysis?.brightness ?? null,
    },
  };
}

// GET /library/untagged, ma-api branch — there's no local mood-tag index to
// page through in MA mode, so this reports coverage instead of an untagged
// row walk; the admin UI uses `maMode` to switch its untagged-queue view to
// a coverage summary.
export async function untaggedMa() {
  const cov = await library.getCoverage();
  return { rows: [], nextCursor: null, maMode: true, coverage: cov };
}
