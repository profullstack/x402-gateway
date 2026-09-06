/**
 * A free allowance, and what happens when it runs out.
 *
 * The usual answer to "too many requests" is 429, which tells a caller to go
 * away and try later. That is the right answer when you have nothing to sell.
 * Here we do: the moment the allowance runs out is the best sales pitch the
 * site will ever get, because the caller has just demonstrated it wants more
 * than the free tier and is still holding the request. So the gateway answers
 * 402 with a price instead.
 *
 * ON EVADING THIS BY ROTATING ADDRESSES.
 *
 * The default identity is the caller's address, and rotating addresses defeats
 * it. That is not a flaw to be patched, because the arithmetic already argues
 * for paying: residential proxy bandwidth is sold by the gigabyte at prices
 * that pass a dollar inside the first day of any serious crawl, and a rotation
 * still has to fetch every page one at a time. Someone who spends more on
 * proxies than the pass costs, in order to avoid the pass, has not been
 * defeated by cleverness. They have made an arithmetic mistake, and the 402
 * body is where we point it out. Detection is a race. Price is not.
 *
 * The store is pluggable so a fleet can share one counter across sites. The
 * built-in one counts per process, so several instances each grant their own
 * allowance; that errs toward generosity, which is the right direction to be
 * wrong in for a free tier.
 */

/**
 * @typedef {object} QuotaHit
 * @property {number} count        requests in the current window, including this one
 * @property {number} resetSeconds seconds until the window rolls over
 */

/**
 * @typedef {object} QuotaStore
 * @property {(key: string, windowSeconds: number) => QuotaHit | Promise<QuotaHit>} hit
 */

/**
 * A counter in this process's memory.
 *
 * Fixed windows rather than a sliding log: a sliding window is more accurate
 * and has to keep every timestamp, and for deciding whether to show someone a
 * price that accuracy is not worth the memory. Expired entries are swept
 * occasionally on write, so an idle key does not cost anything for long.
 */
export function memoryQuotaStore({ now = () => Date.now(), sweepEvery = 1000 } = {}) {
  /** @type {Map<string, {count: number, expiresAt: number}>} */
  const windows = new Map();
  let writes = 0;

  const sweep = (at) => {
    for (const [key, entry] of windows) {
      if (entry.expiresAt <= at) windows.delete(key);
    }
  };

  return {
    hit(key, windowSeconds) {
      const at = now();
      writes += 1;
      if (writes % sweepEvery === 0) sweep(at);

      const entry = windows.get(key);
      if (!entry || entry.expiresAt <= at) {
        windows.set(key, { count: 1, expiresAt: at + windowSeconds * 1000 });
        return { count: 1, resetSeconds: windowSeconds };
      }
      entry.count += 1;
      return {
        count: entry.count,
        resetSeconds: Math.max(1, Math.ceil((entry.expiresAt - at) / 1000)),
      };
    },
    /** Test seam, and a way for a long-lived process to reclaim memory on demand. */
    sweep() {
      sweep(now());
    },
    get size() {
      return windows.size;
    },
  };
}

/**
 * Normalise what a site passes as `freeQuota`.
 *
 * A bare number means "that many per minute", because per minute is how
 * everyone states a rate limit out loud.
 */
export function normaliseQuota(input) {
  if (!input) return null;
  const config = typeof input === 'number' ? { requests: input } : input;
  const requests = Number(config.requests);
  if (!Number.isFinite(requests) || requests < 1) return null;

  return {
    requests: Math.floor(requests),
    windowSeconds:
      Number.isFinite(config.windowSeconds) && config.windowSeconds > 0
        ? Math.floor(config.windowSeconds)
        : 60,
    identify: typeof config.identify === 'function' ? config.identify : null,
    store:
      config.store && typeof config.store.hit === 'function' ? config.store : memoryQuotaStore(),
    /** Only meter these paths or prefixes. Null meters everything the gate sees. */
    paths: Array.isArray(config.paths) && config.paths.length ? config.paths : null,
  };
}

/** Whether this path is metered at all. */
export function meters(quota, path) {
  if (!quota.paths) return true;
  return quota.paths.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));
}

/**
 * Spend one request against the allowance.
 *
 * Null when the caller cannot be identified, which counts as within the
 * allowance. A caller we cannot count is not evidence of abuse, and charging
 * one because our own edge did not hand us an address would be charging for our
 * own gap.
 */
export async function spend(quota, key) {
  if (!key) return null;
  const hit = await quota.store.hit(key, quota.windowSeconds);
  return {
    count: hit.count,
    remaining: Math.max(0, quota.requests - hit.count),
    resetSeconds: hit.resetSeconds,
    overLimit: hit.count > quota.requests,
  };
}

/**
 * Headers describing the allowance, in the shape the draft IETF RateLimit
 * fields use. Sent whether or not the caller is over, because a client that can
 * see it is approaching a wall can buy a pass before it hits one, which is a
 * better outcome for both sides than a surprise.
 */
export function quotaHeaders(quota, usage) {
  if (!usage) return {};
  return {
    'ratelimit-limit': String(quota.requests),
    'ratelimit-remaining': String(usage.remaining),
    'ratelimit-reset': String(usage.resetSeconds),
  };
}
