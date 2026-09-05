/**
 * The two checks that do not need a user agent to be honest.
 *
 * A crawler that names itself is charged by the lists in ./agents. The ones
 * that do not -- a VPS fleet wearing "Chrome/148", a residential-proxy
 * rotation cycling three Chrome strings across five hundred addresses -- need
 * something the request cannot help giving away. Two things qualify:
 *
 *   1. Where it came from. A hosting provider's address range serves no
 *      readers, only machines. A CIDR denylist answers those with a tiny 403
 *      before anything else runs.
 *
 *   2. Whether it is the browser it claims to be. Every Chromium since 76,
 *      headless included, sends `Sec-Fetch-Mode` on every request; it is a
 *      forbidden header, so no page script and no extension can remove it.
 *      A request that says "Chrome/145" and does not send it is an HTTP client
 *      with a copied string. That is not a person, and it is charged like any
 *      other crawler.
 */

/* ------------------------------------------------------------------ CIDRs -- */

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** Parse "a.b.c.d/len" (or a bare address) into a matcher. Null if unreadable. */
export function parseCidr(cidr) {
  const [ip, lenRaw] = String(cidr).trim().split('/');
  const base = ipv4ToInt(ip);
  if (base === null) return null;
  const len = lenRaw === undefined ? 32 : Number(lenRaw);
  if (!Number.isInteger(len) || len < 0 || len > 32) return null;
  const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
  return { base: (base & mask) >>> 0, mask, text: `${ip}/${len}` };
}

/** Compile a denylist once. Unreadable entries are dropped, not guessed at. */
export function compileCidrs(list = []) {
  return list.map(parseCidr).filter(Boolean);
}

/** Whether an IPv4 address falls inside any compiled range. */
export function inCidrs(ip, compiled) {
  const n = ipv4ToInt(String(ip ?? '').trim());
  if (n === null) return false;
  return compiled.some((c) => ((n & c.mask) >>> 0) === c.base);
}

/**
 * The caller's address, as the edge reported it.
 *
 * `x-forwarded-for` is a list the client can seed, and a denylist read from
 * its first entry is a denylist any client can step around by sending one.
 * The entry our own edge appends is the LAST, on every platform in front of
 * these sites (Railway's proxy, nginx with `$proxy_add_x_forwarded_for`), so
 * last is what is used. `x-real-ip` is nginx's spelling of the same hop and
 * is preferred when present, because nginx sets it from the socket and
 * nothing a client sends survives into it.
 *
 * A CDN in front of the edge would make the last hop the CDN's; put its
 * ranges nowhere near `denyCidrs` and this still fails safe: nothing is
 * refused, nothing is charged, by this check.
 */
export function clientIp(request) {
  const real = request.headers.get('x-real-ip')?.trim();
  if (real) return real;
  const xff = request.headers.get('x-forwarded-for');
  if (!xff) return '';
  const hops = xff.split(',').map((h) => h.trim()).filter(Boolean);
  return hops[hops.length - 1] ?? '';
}

/* -------------------------------------------------------------- spoofing -- */

const CLAIMS_CHROMIUM = /\bChrome\/\d+/;

/**
 * A request that claims a Chromium user agent but carries none of the
 * fetch-metadata headers Chromium cannot omit.
 *
 * Only Chromium is judged: Firefox and Safari added Sec-Fetch later and
 * older builds of both are still out there, so their absence proves nothing.
 * `sec-fetch-mode` is the one checked because it is present on every request
 * kind -- navigation, subresource, fetch -- unlike `sec-ch-ua`, which a
 * privacy proxy may strip.
 */
export function isSpoofedBrowser(request) {
  const ua = request.headers.get('user-agent') ?? '';
  if (!CLAIMS_CHROMIUM.test(ua)) return false;
  return !request.headers.has('sec-fetch-mode');
}
