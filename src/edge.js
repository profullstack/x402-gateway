import * as RANGES from './ranges.js';

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

function ipv6ToBig(ip) {
  let s = String(ip).toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(':')) return null;
  // An IPv4 tail ("::ffff:1.2.3.4") becomes the last two groups.
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const v4 = ipv4ToInt(tail[1]);
    if (v4 === null) return null;
    s = `${s.slice(0, -tail[1].length)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...rest];
  if (groups.length !== 8) return null;
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(Number.parseInt(g, 16));
  }
  return n;
}

const ALL6 = (1n << 128n) - 1n;

/**
 * Parse "a.b.c.d/len" or "2001:db8::/32" (or a bare address) into a matcher.
 * Null if unreadable.
 */
export function parseCidr(cidr) {
  const [ip, lenRaw] = String(cidr).trim().split('/');
  if (ip.includes(':')) {
    const base = ipv6ToBig(ip);
    if (base === null) return null;
    const len = lenRaw === undefined ? 128 : Number(lenRaw);
    if (!Number.isInteger(len) || len < 0 || len > 128) return null;
    const mask = len === 0 ? 0n : (ALL6 << BigInt(128 - len)) & ALL6;
    return { v6: true, base: base & mask, mask, text: `${ip}/${len}` };
  }
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

/** Whether an address (IPv4 or IPv6) falls inside any compiled range. */
export function inCidrs(ip, compiled) {
  const s = String(ip ?? '').trim();
  if (s.includes(':')) {
    const n = ipv6ToBig(s);
    if (n === null) return false;
    // An IPv4-mapped address is the IPv4 address it maps.
    if (n >> 32n === 0xffffn) return inCidrs(int4(Number(n & 0xffffffffn)), compiled);
    return compiled.some((c) => c.v6 && (n & c.mask) === c.base);
  }
  const n = ipv4ToInt(s);
  if (n === null) return false;
  return compiled.some((c) => !c.v6 && ((n & c.mask) >>> 0) === c.base);
}

const int4 = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

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
  const edge = edgeIp(request);
  /*
   * Behind Cloudflare's proxy the edge hop is a Cloudflare address and the
   * caller is in CF-Connecting-IP. That header is only believed when the hop
   * really is Cloudflare's, so a client cannot set it to choose its address.
   */
  if (edge && inCidrs(edge, cloudflare())) {
    const cf = request.headers.get('cf-connecting-ip')?.trim();
    if (cf) return cf;
  }
  return edge;
}

function edgeIp(request) {
  const real = request.headers.get('x-real-ip')?.trim();
  if (real) return real;
  const xff = request.headers.get('x-forwarded-for');
  if (!xff) return '';
  const hops = xff.split(',').map((h) => h.trim()).filter(Boolean);
  return hops[hops.length - 1] ?? '';
}

let CF = null;
const cloudflare = () => (CF ??= compileCidrs(RANGES.cloudflare));

/* -------------------------------------------------------------- spoofing -- */

const CLAIMS_CHROMIUM = /\bChrome\/\d+/;

/**
 * A crawler that says so. Googlebot's evergreen string is
 * "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible;
 * Googlebot/2.1; +http://www.google.com/bot.html) Chrome/W.X.Y.Z Safari/537.36"
 * -- it claims Chrome, it sends no Sec-Fetch-Mode, and it is the last thing
 * on earth to charge. Bingbot is built the same way. Anything that declares
 * itself is judged by the lists, never by this check: the whole point of the
 * check is the client that declares nothing.
 */
const DECLARES_ITSELF = /compatible;|\bbot\b|bot\/|crawler|spider|slurp/i;

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
  if (DECLARES_ITSELF.test(ua)) return false;
  return !request.headers.has('sec-fetch-mode');
}

/* ---------------------------------------------------------- stale strings -- */

/*
 * Where each browser's version stood on a known day, and how fast it moves:
 * both ship a major every four weeks. Computing "current" from the date keeps
 * the check from going stale itself, which a hard-coded number would within a
 * year.
 */
const DAY = 86_400_000;
const CADENCE = 28 * DAY;
/*
 * Anchored on recent releases (Chrome 143 shipped 2025-12-02, Firefox 146 on
 * 2025-12-09). The cadence is four weeks with the odd longer gap, so the
 * estimate runs AHEAD of the real version by about one major a year. The first
 * anchor (Chrome 120, December 2023) had drifted three majors ahead by October
 * 2026, which called Chrome 130-132 "two years old" when it was 20 months old.
 * Re-anchor when this drifts again; erring ahead is the side that charges people.
 */
const CHROME_ANCHOR = { major: 143, at: Date.UTC(2025, 11, 2) };
const FIREFOX_ANCHOR = { major: 146, at: Date.UTC(2025, 11, 9) };

/** The major a browser that auto-updates would be on at `now`. */
export function currentMajor(browser, now = Date.now()) {
  const a = browser === 'firefox' ? FIREFOX_ANCHOR : CHROME_ANCHOR;
  return a.major + Math.max(0, Math.floor((now - a.at) / CADENCE));
}

/*
 * The last version an old operating system can run, and Firefox's extended
 * support releases. A person stuck on one of these is still a person, so these
 * are never called stale, however old.
 */
const TERMINAL_CHROME = [
  { major: 109, os: /Windows NT 6\./ }, // Windows 7, 8, 8.1
  { major: 116, os: /Macintosh/ }, // macOS 10.13, 10.14
  { major: 128, os: /Macintosh/ }, // macOS 10.15
  { major: 138, os: /Macintosh/ }, // macOS 11
];
const FIREFOX_ESR = [115, 128, 140, 153];
const EMBEDDED =
  /Mobile|Android|iPhone|iPad|CrOS|CrKey|SMART-TV|SmartTV|Tizen|Web0S|WebOS|NetCast|BRAVIA|HbbTV|Roku|AFT[A-Z]|PlayStation|Xbox|Nintendo|OculusBrowser|Quest/;

/**
 * A desktop browser string far older than anything that auto-updates.
 *
 * Chrome, Edge and Firefox update themselves every four weeks, so a desktop
 * "Chrome/120" two years after Chrome 120 shipped is a string copied into a
 * scraper's rotation pool, not a browser. That is exactly what the swarms do:
 * on 2026-10-19 one pool of ten strings (Chrome 118-120, Edge 119-120, Firefox
 * 120-121) walked watchnews.now and r4ck.dev from thousands of residential
 * addresses, running the page scripts as it went.
 *
 * Only desktop strings are judged. Phones and embedded webviews legitimately
 * sit years behind, and a declared crawler is judged by the lists instead.
 *
 * @param {string} ua
 * @param {number} [now]
 * @param {number} [maxMajorsBehind=24]  about 22 months of releases
 */
export function isStaleBrowser(ua, now = Date.now(), maxMajorsBehind = 24) {
  const s = String(ua ?? '');
  if (!/Windows NT|Macintosh|X11; (?:Linux|Ubuntu|Fedora) x86_64/.test(s)) return false;
  // Phones, TVs, cast sticks, consoles and headsets: an embedded browser is
  // frozen at whatever its firmware shipped. A Chromecast says "X11; Linux
  // armv7l ... Chrome/80 ... CrKey" for years, and it is somebody's living room.
  if (EMBEDDED.test(s)) return false;
  if (DECLARES_ITSELF.test(s)) return false;

  const ff = /\bFirefox\/(\d+)/.exec(s);
  if (ff) {
    const major = Number(ff[1]);
    if (FIREFOX_ESR.includes(major)) return false;
    return major < currentMajor('firefox', now) - maxMajorsBehind;
  }
  const chrome = /\bChrome\/(\d+)/.exec(s);
  if (chrome) {
    const major = Number(chrome[1]);
    if (TERMINAL_CHROME.some((t) => t.major === major && t.os.test(s))) return false;
    return major < currentMajor('chrome', now) - maxMajorsBehind;
  }
  return false;
}

/* -------------------------------------------------------- welcome crawlers -- */

const COMPILED = new WeakMap();

/**
 * The welcome crawler a request is, judged by name AND address, or null.
 *
 * @param {Request} request
 * @param {{token: string, cidrs: string[]}[]} list  e.g. WELCOME_CRAWLERS
 */
export function welcomeCrawler(request, list) {
  if (!list?.length) return null;
  const ua = (request.headers.get('user-agent') ?? '').toLowerCase();
  if (!ua) return null;
  const ip = clientIp(request);
  for (const c of list) {
    if (!ua.includes(c.token.toLowerCase())) continue;
    let compiled = COMPILED.get(c);
    if (!compiled) COMPILED.set(c, (compiled = compileCidrs(c.cidrs)));
    if (inCidrs(ip, compiled)) return c.token;
  }
  return null;
}

/**
 * The welcome crawler a request claims to be but is not: its user agent names
 * one of `list` and its address is outside that crawler's published ranges.
 * Null when it names none, when it is the real thing, or when there is no
 * readable address to judge (fail safe: never charge on a guess).
 *
 * @param {Request} request
 * @param {{token: string, cidrs: string[]}[]} list
 */
export function impostorCrawler(request, list) {
  if (!list?.length) return null;
  const ua = (request.headers.get('user-agent') ?? '').toLowerCase();
  if (!ua) return null;
  const ip = clientIp(request);
  if (!ip || (!ip.includes(':') && !/^\d+\.\d+\.\d+\.\d+$/.test(ip))) return null;
  let claimed = null;
  for (const c of list) {
    if (!ua.includes(c.token.toLowerCase())) continue;
    let compiled = COMPILED.get(c);
    if (!compiled) COMPILED.set(c, (compiled = compileCidrs(c.cidrs)));
    if (inCidrs(ip, compiled)) return null;
    claimed ??= c.token;
  }
  return claimed;
}
