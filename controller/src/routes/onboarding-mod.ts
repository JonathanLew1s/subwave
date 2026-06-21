// Fork-specific MA DB API wizard steps for routes/onboarding.ts — the
// non-mutating connectivity probe and the /onboarding/save persistence block
// for the optional ma-db-api sidecar backend. Wired in via one-line dispatch
// points so upstream changes to the rest of the wizard never collide here.
import { config } from '../config.js';
import * as settings from '../settings.js';

// POST /onboarding/test-ma — body: { url, apiKey? }. Hits the ma-db-api
// sidecar's /health endpoint. Non-mutating. Caller (routes/onboarding.ts)
// guards the missing-url case with a 400 before reaching here.
export async function testMaDbApi(url: string, apiKey: string) {
  const cleanUrl = String(url || '').trim().replace(/\/$/, '');
  const cleanKey = String(apiKey || '').trim();

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const headers: Record<string, string> = {};
    if (cleanKey) headers['X-API-Key'] = cleanKey;
    const r = await fetch(`${cleanUrl}/health`, { headers, signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) return { ok: false, error: `MA DB API returned HTTP ${r.status}` };
    const body: any = await r.json().catch(() => ({}));
    return { ok: true, version: body?.version || 'ok' };
  } catch (err: any) {
    return { ok: false, error: err.message || 'MA DB API unreachable' };
  }
}

// POST /onboarding/save's maDbApi block — applies URL + key to the live
// config and persists via settings.update() so the controller picks them up
// on restart. Only runs when the wizard actually sent a `maDbApi` object.
export async function saveMaDbApi(maDbApi: { url?: string; apiKey?: string }) {
  const maUrl = String(maDbApi.url || '').trim().replace(/\/$/, '');
  const maKey = String(maDbApi.apiKey || '').trim();
  if (maUrl) config.maDbApi.url = maUrl;
  if (maKey) config.maDbApi.apiKey = maKey;
  await settings.update({ library: { backend: 'ma-api', maDbApi: { url: maUrl, apiKey: maKey, musicRoot: config.maDbApi.musicRoot } } });
  config.libraryBackend = 'ma-api';
}
