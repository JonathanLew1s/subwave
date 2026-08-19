// ---------------------------------------------------------------------------
// Request endpoint throttling. The /request path triggers an LLM call,
// Subsonic searches, TTS, and a booth-log write — cheap individually but
// trivially weaponisable by anyone with curl. Defence in depth:
//   - hard size caps on text + name
//   - operator kill switch (REQUESTS_DISABLED env)
//   - per-IP cooldown (no more than 1 request per COOLDOWN_MS)
//   - per-IP hourly ceiling
//   - station-wide hourly ceiling (per-IP buckets are useless against a
//     distributed raid — many IPs, each under the per-IP cap)
// State is in-memory; a controller restart resets counters. Good enough for a
// homelab station; if you need durable enforcement, put a real ratelimit at
// the Caddy edge.
// ---------------------------------------------------------------------------
export const REQUEST_TEXT_MAX = 280;
export const REQUEST_NAME_MAX = 40;
const REQUEST_COOLDOWN_MS = 20_000;
const REQUEST_HOURLY_CAP = 8;
const REQUEST_GLOBAL_HOURLY_CAP = 30;
export const REQUESTS_DISABLED = process.env.REQUESTS_DISABLED === '1' || process.env.REQUESTS_DISABLED === 'true';

const requestHistory = new Map(); // ip → { last: ts, hits: [ts,...] }

// OPT-IN: trust `CF-Connecting-IP` as the client identity. Off by default, and
// the default is the safe one — read clientIp() below before flipping it.
export const TRUST_CF_CONNECTING_IP =
  process.env.TRUST_CF_CONNECTING_IP === '1' || process.env.TRUST_CF_CONNECTING_IP === 'true';

// The identity EVERY per-IP gate keys on — the /request cooldown + per-IP
// hourly cap, and requireAdmin's brute-force lockout (middleware/auth.ts). A
// wrong answer here weakens both at once, so the resolution order is a
// security decision, not plumbing:
//
//   1. `cf-connecting-ip` — ONLY when TRUST_CF_CONNECTING_IP is set.
//   2. left-most `x-forwarded-for`.
//   3. the socket peer.
//
// Why the header is gated rather than simply preferred: on the shipped stack
// the only peer is Caddy, and `docker/Caddyfile` lists Cloudflare's ranges as
// `trusted_proxies` — so Caddy DISCARDS a client-supplied X-Forwarded-For
// unless the connection really came from a Cloudflare edge, and `xff[0]` is
// the true peer. `CF-Connecting-IP` gets no such treatment: it is an ordinary
// header Caddy passes straight through. Trusting it unconditionally would
// therefore hand every attacker a one-header bypass of all of the above on
// exactly the deployments that were previously sound — an honest client never
// sends it, so "absent by default" is not a defence.
//
// With the flag ON (proxied-DNS Cloudflare in front) the header is the right
// answer and XFF is the wrong one, because Cloudflare APPENDS the real client
// IP to the chain rather than replacing it — a client-supplied left-most entry
// survives the edge intact.
//
// Still true either way: this is only as good as the guarantee that the origin
// is reachable ONLY through that edge. Anyone who can hit it directly can
// forge whichever header is being trusted (docker-compose.byo.yml binds the
// controller on a host port by design). Durable enforcement belongs at the
// edge — see the header comment.
export function clientIp(req) {
  if (TRUST_CF_CONNECTING_IP) {
    const cf = String(req.headers['cf-connecting-ip'] || '').trim();
    if (cf) return cf;
  }
  const xff = (req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  return xff[0] || req.socket.remoteAddress || 'unknown';
}

// The per-IP cooldown and hourly caps are spent at DIFFERENT times, and
// conflating them is a live-fire foot-gun: if a caller ever adds a gate AFTER
// checkRateLimit that can still reject (a queue-depth cap, a duplicate-pending
// hold), charging the hourly budget at check time means rejected retries burn
// it too — with the queue full, enough rejected retries can close the request
// line (per-IP or station-wide) for an hour with almost nothing actually
// accepted. So:
//   * the cooldown (`rec.last`) IS spent on every attempt — it's the
//     anti-hammer, per-IP, and self-clears in COOLDOWN_MS. Not spending it on
//     rejections would leave any later gate with no backpressure at all.
//   * the hourly caps (`rec.hits` / `globalHits`) are budgets of ACCEPTED
//     requests and are only spent by commitRateLimit()/commitGlobalRateLimit(),
//     called once a request is actually being accepted.
export function checkRateLimit(ip) {
  const now = Date.now();
  const oneHourAgo = now - 3_600_000;
  const rec = requestHistory.get(ip) || { last: 0, hits: [] };
  rec.hits = rec.hits.filter(t => t > oneHourAgo);
  if (rec.last && now - rec.last < REQUEST_COOLDOWN_MS) {
    return { ok: false, retryAfter: Math.ceil((REQUEST_COOLDOWN_MS - (now - rec.last)) / 1000) };
  }
  if (rec.hits.length >= REQUEST_HOURLY_CAP) {
    const oldest = rec.hits[0];
    return { ok: false, retryAfter: Math.ceil((oldest + 3_600_000 - now) / 1000) };
  }
  rec.last = now;
  requestHistory.set(ip, rec);
  // Opportunistic cleanup so the map doesn't grow unbounded over weeks.
  if (requestHistory.size > 2000) {
    for (const [k, v] of requestHistory) {
      if (!v.hits.length && now - v.last > 3_600_000) requestHistory.delete(k);
    }
  }
  return { ok: true };
}

// Spend the per-IP hourly budget. Call only once the request is being
// accepted (after any later gate has passed).
export function commitRateLimit(ip) {
  const rec = requestHistory.get(ip) || { last: 0, hits: [] };
  rec.hits.push(Date.now());
  requestHistory.set(ip, rec);
}

// All-IP combined ceiling — per-IP buckets are useless against a distributed
// raid (many addresses, each staying under the per-IP cap).
const globalHits: number[] = [];

// Peek only — see the note above checkRateLimit for why this must not spend
// the budget. Pair every ok:true with commitGlobalRateLimit() at the accept
// point.
export function checkGlobalRateLimit() {
  const now = Date.now();
  const cutoff = now - 3_600_000;
  while (globalHits.length && globalHits[0] <= cutoff) globalHits.shift();
  if (globalHits.length >= REQUEST_GLOBAL_HOURLY_CAP) {
    return { ok: false, retryAfter: Math.ceil((globalHits[0] + 3_600_000 - now) / 1000) };
  }
  return { ok: true };
}

export function commitGlobalRateLimit() {
  globalHits.push(Date.now());
}
