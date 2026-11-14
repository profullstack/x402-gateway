/**
 * Mass-scrape detection: a site-wide counter of anonymous reads on the paths a
 * site cares about. A swarm that rotates its address every page never trips a
 * per-address limit, and it does not have to: what gives it away is the
 * aggregate. A site whose people read 200 item pages a day is not reading 100
 * a minute. Once the aggregate passes `requests` in `windowSeconds`, every
 * anonymous read on those paths is sold (402 with the x402 offer, and a
 * sign-in link for people) until it has stayed below for `holdSeconds`.
 *
 * Process-local on purpose: each site runs one gateway process per host, and
 * a counter that needs a network round trip on every page is a cost the swarm
 * would be imposing on us.
 */

/**
 * @param {{requests: number, windowSeconds: number, holdSeconds: number}} config
 * @param {() => number} [now]  ms clock, for tests
 */
export function massCounter(config, now = Date.now) {
  const bucketMs = 1000;
  const size = Math.max(1, Math.ceil(config.windowSeconds));
  const buckets = new Array(size).fill(0);
  const stamps = new Array(size).fill(-1);
  let trippedUntil = 0;
  let trippedAt = 0;
  let peak = 0;

  const count = (t) => {
    const second = Math.floor(t / bucketMs);
    let total = 0;
    for (let i = 0; i < size; i++) if (stamps[i] > second - size) total += buckets[i];
    return total;
  };

  return {
    /** Record one anonymous read; returns whether the gate is on after it. */
    hit() {
      const t = now();
      const second = Math.floor(t / bucketMs);
      const i = second % size;
      if (stamps[i] !== second) {
        stamps[i] = second;
        buckets[i] = 0;
      }
      buckets[i] += 1;
      const total = count(t);
      if (total > peak) peak = total;
      let tripped = false;
      if (total > config.requests) {
        if (trippedUntil <= t) {
          trippedAt = t;
          tripped = true;
        }
        trippedUntil = t + config.holdSeconds * 1000;
      }
      return { on: trippedUntil > t, tripped, count: total };
    },
    /** Whether the gate is on right now, without counting a read. */
    on() {
      return trippedUntil > now();
    },
    state() {
      const t = now();
      return {
        on: trippedUntil > t,
        count: count(t),
        threshold: config.requests,
        windowSeconds: config.windowSeconds,
        since: trippedUntil > t && trippedAt ? new Date(trippedAt).toISOString() : null,
        until: trippedUntil > t ? new Date(trippedUntil).toISOString() : null,
        peak,
      };
    },
  };
}

/**
 * Counts refused requests by path and posts them to CrawlProof's
 * /api/tracker/v1/bot-hits once every `everySeconds`, so a swarm the gateway
 * refuses still shows on the stats page as bot traffic. A 402 page carries no
 * beacon, so without this the refusals are invisible and only the slice that
 * got through is counted, as human. Best-effort: a failed post keeps nothing,
 * since an analytics counter must never hold memory against a swarm.
 *
 * @param {{url?: string, token?: string, site: string, bucket?: string, everySeconds?: number}} report
 * @param {typeof fetch} fetchImpl
 */
export function botHitReporter(report, fetchImpl = globalThis.fetch) {
  const url = report.url || 'https://crawlproof.com/api/tracker/v1/bot-hits';
  const bucket = report.bucket || 'bot:swarm';
  const every = Math.max(5, Number(report.everySeconds) || 60) * 1000;
  const maxPaths = 199;
  let pending = new Map();
  let overflow = 0;
  let total = 0;
  let timer = null;

  const flush = async () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!pending.size && !overflow) return null;
    const hits = [...pending].map(([path, count]) => ({ bucket, path, count }));
    if (overflow) hits.push({ bucket, path: '/', count: overflow });
    pending = new Map();
    overflow = 0;
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(report.token ? { authorization: `Bearer ${report.token}` } : {}) },
        body: JSON.stringify({ site: report.site, hits }),
      });
      if (res.ok) total += hits.reduce((a, h) => a + h.count, 0);
      return res.ok;
    } catch {
      return false;
    }
  };

  return {
    count(path) {
      // Item pages are unbounded; keep the busiest prefixes, fold the rest into '/'.
      const key = path.split('/').slice(0, 2).join('/') + (path.split('/').length > 2 ? '/' : '');
      if (pending.has(key) || pending.size < maxPaths) pending.set(key, (pending.get(key) ?? 0) + 1);
      else overflow += 1;
      if (!timer) {
        timer = setTimeout(flush, every);
        timer.unref?.();
      }
    },
    flush,
    sent: () => total,
  };
}
