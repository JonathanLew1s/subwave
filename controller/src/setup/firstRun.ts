// First-run detection — is the station set up enough to broadcast?
//
// The threshold is "Navidrome reachable" (URL + user + pass present somewhere),
// because without a music source the station can't play anything useful. LLM
// and TTS are pre-configured with sensible defaults (Ollama, Piper) so we
// don't gate on them — the wizard collects them for a complete walkthrough
// but a stack that boots with only Navidrome configured is broadcastable.

import { config } from '../config.js';
import { loadSetupConfig } from './config.js';

export type LibraryBackend = 'navidrome' | 'ma-api';

export interface SetupStatus {
  needsSetup: boolean;
  setupCompletedAt: string | null;
  libraryBackend: LibraryBackend;
  // Useful for the wizard's "I see you already have NAVIDROME_URL in env" UX.
  navidromeSource: 'env' | 'setup-config' | 'unset';
}

export async function getSetupStatus(): Promise<SetupStatus> {
  const backend = (process.env.LIBRARY_BACKEND || config.libraryBackend || 'navidrome') as LibraryBackend;

  if (backend === 'ma-api') {
    // MA DB API backend: setup is satisfied when the sidecar URL is configured.
    const maReady = Boolean(config.maDbApi.url);
    const sc = await loadSetupConfig();
    return {
      needsSetup: !maReady && !sc.setupCompletedAt,
      setupCompletedAt: sc.setupCompletedAt || null,
      libraryBackend: 'ma-api',
      navidromeSource: 'unset',
    };
  }

  // Navidrome path (default) — unchanged.
  const envHasNavidrome = Boolean(
    process.env.NAVIDROME_URL &&
      process.env.NAVIDROME_USER &&
      process.env.NAVIDROME_PASS,
  );

  if (envHasNavidrome) {
    return {
      needsSetup: false,
      setupCompletedAt: null,
      libraryBackend: 'navidrome',
      navidromeSource: 'env',
    };
  }

  const sc = await loadSetupConfig();
  const nv = sc.navidrome || {};
  const setupConfigHasNavidrome = Boolean(nv.url && nv.user && nv.pass);

  return {
    needsSetup: !setupConfigHasNavidrome,
    setupCompletedAt: sc.setupCompletedAt || null,
    libraryBackend: 'navidrome',
    navidromeSource: setupConfigHasNavidrome ? 'setup-config' : 'unset',
  };
}

// Synchronous variant used by /state — relies on the cache populated at boot.
export function getSetupStatusSync(): SetupStatus {
  const backend = (process.env.LIBRARY_BACKEND || config.libraryBackend || 'navidrome') as LibraryBackend;

  if (backend === 'ma-api') {
    const maReady = Boolean(config.maDbApi.url);
    return {
      needsSetup: !maReady,
      setupCompletedAt: null,
      libraryBackend: 'ma-api',
      navidromeSource: 'unset',
    };
  }

  const envHasNavidrome = Boolean(
    process.env.NAVIDROME_URL &&
      process.env.NAVIDROME_USER &&
      process.env.NAVIDROME_PASS,
  );
  if (envHasNavidrome) {
    return { needsSetup: false, setupCompletedAt: null, libraryBackend: 'navidrome', navidromeSource: 'env' };
  }
  const url = config.navidrome.url;
  const user = config.navidrome.user;
  const pass = config.navidrome.password;
  const filled = Boolean(url && user && pass && url !== 'http://navidrome:4533');
  return {
    needsSetup: !filled,
    setupCompletedAt: null,
    libraryBackend: 'navidrome',
    navidromeSource: filled ? 'setup-config' : 'unset',
  };
}
