'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAdminAuth } from '@/lib/adminAuth';

// Shape of every wizard step in one place — easier to pass around than
// individual setState callbacks. Each step component reads/writes via the
// `set` updater rather than its own state, so the Review step can show the
// whole picture without prop-drilling.
export type LibraryBackend = 'navidrome' | 'ma-api';

export interface WizardData {
  libraryBackend: LibraryBackend;

  ma: { url: string; apiKey: string };
  maTest: { ok: boolean | null; msg?: string };

  navidrome: { url: string; user: string; pass: string };
  // Connection-test result so the step can show a green check across renders.
  navidromeTest: { ok: boolean | null; msg?: string };

  llm: {
    provider: string;
    model: string;
    apiKey: string;
    baseUrl: string;
    ollamaUrl: string;
  };
  llmTest: { ok: boolean | null; msg?: string };

  tts: {
    defaultEngine: 'piper' | 'kokoro' | 'cloud' | 'chatterbox' | 'pocket-tts';
    // Advisory toggle — does the operator intend to run the optional
    // tts-heavy sidecar (Chatterbox + PocketTTS)? Persisted via
    // /onboarding/save into settings.tts.heavyEnabled. The web wizard can't
    // start the sidecar itself; this just captures the intent and shows the
    // copy-paste docker commands. The CLI setup writes COMPOSE_PROFILES into
    // .env when its equivalent prompt is answered yes.
    heavyEnabled: boolean;
    cloud: { enabled: boolean; provider: string; apiKey: string };
  };

  dj: {
    stationName: string;
    locationName: string;
    frequency: 'quiet' | 'moderate' | 'aggressive';
  };

  // The wizard's "API keys" bucket — anything destined for state/secrets.env.
  // Keyed by env-var name to match the controller's allow list.
  apiKeys: Record<string, string>;
}

export const DEFAULT_DATA: WizardData = {
  libraryBackend: 'navidrome',
  ma: { url: '', apiKey: '' },
  maTest: { ok: null },
  navidrome: { url: '', user: '', pass: '' },
  navidromeTest: { ok: null },
  llm: {
    provider: 'ollama',
    // Default to Ollama's hosted "cloud" model — works out of the box with
    // a stock Ollama install (no local pull needed) and matches the model
    // shipped in the terminal wizard's defaults.
    model: 'glm-5.1:cloud',
    apiKey: '',
    baseUrl: '',
    ollamaUrl: 'http://host.docker.internal:11434',
  },
  llmTest: { ok: null },
  tts: {
    defaultEngine: 'piper',
    heavyEnabled: false,
    cloud: { enabled: false, provider: 'openai', apiKey: '' },
  },
  dj: {
    stationName: 'SUB/WAVE',
    locationName: 'Wolverhampton',
    frequency: 'moderate',
  },
  apiKeys: {},
};

export type StepId = 'ma' | 'navidrome' | 'llm' | 'tts' | 'dj' | 'jingles' | 'review';

export function getStepOrder(backend: LibraryBackend): StepId[] {
  const libraryStep: StepId = backend === 'ma-api' ? 'ma' : 'navidrome';
  return [libraryStep, 'llm', 'tts', 'dj', 'jingles', 'review'];
}

export const STEP_LABELS: Record<StepId, string> = {
  ma: 'Music Assistant',
  navidrome: 'Navidrome',
  llm: 'LLM',
  tts: 'TTS',
  dj: 'DJ persona',
  jingles: 'Jingles',
  review: 'Review',
};

export function useWizard() {
  const auth = useAdminAuth();
  const [data, setData] = useState<WizardData>(DEFAULT_DATA);
  const [stepIdx, setStepIdx] = useState(0);

  const patch = useCallback((p: Partial<WizardData> | ((d: WizardData) => Partial<WizardData>)) => {
    setData(d => {
      const incoming = typeof p === 'function' ? p(d) : p;
      return { ...d, ...incoming };
    });
  }, []);

  // Fetch backend from controller on mount so the wizard renders the right step 1.
  useEffect(() => {
    fetch('/api/onboarding/status')
      .then(r => r.json())
      .then((s: any) => {
        if (s.libraryBackend) {
          patch({ libraryBackend: s.libraryBackend as LibraryBackend });
        }
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stepOrder = getStepOrder(data.libraryBackend);

  const step = stepOrder[stepIdx];
  const next = useCallback(() => setStepIdx(i => Math.min(i + 1, stepOrder.length - 1)), [stepOrder.length]);
  const back = useCallback(() => setStepIdx(i => Math.max(i - 1, 0)), []);
  const goto = useCallback((id: StepId) => {
    const i = stepOrder.indexOf(id);
    if (i >= 0) setStepIdx(i);
  }, [stepOrder]);

  // POST helpers — every wizard write goes through adminFetch so the same
  // 401-handling that the admin shell uses applies here.
  const testMa = useCallback(async () => {
    const r = await auth.adminFetch('/onboarding/test-ma', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: data.ma.url, apiKey: data.ma.apiKey }),
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; version?: string; error?: string };
    const result = { ok: !!j.ok, msg: j.ok ? `Music Assistant ${j.version}` : j.error };
    patch({ maTest: result });
    return result;
  }, [auth, data.ma, patch]);

  const testNavidrome = useCallback(async () => {
    const r = await auth.adminFetch('/onboarding/test-navidrome', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data.navidrome),
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; serverType?: string; serverVersion?: string; error?: string };
    const result = { ok: !!j.ok, msg: j.ok ? `${j.serverType || 'Subsonic'} v${j.serverVersion || ''}` : j.error };
    patch({ navidromeTest: result });
    return result;
  }, [auth, data.navidrome, patch]);

  const testLlm = useCallback(async () => {
    const r = await auth.adminFetch('/onboarding/test-llm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data.llm),
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; sample?: string; error?: string };
    const result = { ok: !!j.ok, msg: j.ok ? `responded: "${j.sample}"` : j.error };
    patch({ llmTest: result });
    return result;
  }, [auth, data.llm, patch]);

  const save = useCallback(async () => {
    // Stitch the apiKeys into the right env-var keys before sending.
    const apiKeys: Record<string, string> = { ...data.apiKeys };
    if (data.llm.apiKey) {
      const k =
        data.llm.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' :
        data.llm.provider === 'openai' ? 'OPENAI_API_KEY' :
        data.llm.provider === 'google' ? 'GOOGLE_GENERATIVE_AI_API_KEY' :
        data.llm.provider === 'deepseek' ? 'DEEPSEEK_API_KEY' :
        data.llm.provider === 'openrouter' ? 'OPENROUTER_API_KEY' :
        data.llm.provider === 'gateway' ? 'AI_GATEWAY_API_KEY' : '';
      if (k) apiKeys[k] = data.llm.apiKey;
    }
    if (data.tts.cloud.enabled && data.tts.cloud.apiKey) {
      const k =
        data.tts.cloud.provider === 'openai' ? 'OPENAI_API_KEY' :
        data.tts.cloud.provider === 'elevenlabs' ? 'ELEVENLABS_API_KEY' : '';
      if (k) apiKeys[k] = data.tts.cloud.apiKey;
    }

    const body: any = {
      ...(data.libraryBackend === 'ma-api'
        ? { maDbApi: { url: data.ma.url, apiKey: data.ma.apiKey }, libraryBackend: 'ma-api' }
        : { navidrome: data.navidrome }),
      llm: {
        provider: data.llm.provider,
        model: data.llm.model,
        // Cloud keys go to apiKeys (state/secrets.env). settings.json keeps
        // only the provider/model/url; never the key.
        apiKey: '',
        baseUrl: data.llm.baseUrl,
        ollamaUrl: data.llm.ollamaUrl,
      },
      tts: {
        defaultEngine: data.tts.defaultEngine,
        heavyEnabled: data.tts.heavyEnabled,
        cloud: data.tts.cloud.enabled
          ? { enabled: true, provider: data.tts.cloud.provider }
          : { enabled: false },
      },
      weather: { locationName: data.dj.locationName },
      station: data.dj.stationName,
      apiKeys,
    };
    const r = await auth.adminFetch('/onboarding/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    return { ok: !!j.ok, error: j.error };
  }, [auth, data]);

  const generateJingles = useCallback(async () => {
    const r = await auth.adminFetch('/onboarding/generate-jingles', { method: 'POST' });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; created?: number; total?: number; error?: string };
    return { ok: !!j.ok, created: j.created, total: j.total, error: j.error };
  }, [auth]);

  return {
    auth,
    data,
    patch,
    step,
    stepIdx,
    stepOrder,
    next,
    back,
    goto,
    testMa,
    testNavidrome,
    testLlm,
    save,
    generateJingles,
  };
}

export type WizardController = ReturnType<typeof useWizard>;
