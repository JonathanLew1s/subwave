// Shared outbound-fetch helper. A bare fetch() has no deadline — undici's
// default is ~300s — so a stalled upstream parks the caller (and, on an
// autonomous path like a skill or context lookup, burns a chunk of that
// path's own wall-clock budget) far longer than any of these calls need.
export async function fetchWithTimeout(
  url: string | URL,
  opts: RequestInit = {},
  timeoutMs = 30_000,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}
