import { HEADER as POWER_KEY_HEADER, isPowerKey, keyFrom, PROFULLSTACK_KEYS, SHOP_URL, verifyKey } from '@profullstack/keys';
import { HEADLESS_AGENTS, isTrainingAgent, RETRIEVAL_AGENTS, SCRAPER_AGENTS, TRAINING_AGENTS, VERIFIED_RETRIEVAL, WELCOME_CRAWLERS } from './agents.js';
import { clientIp, compileCidrs, impostorCrawler, inCidrs, isSpoofedBrowser, isStaleBrowser, welcomeCrawler } from './edge.js';
import { memoryQuotaStore, meters, normaliseQuota, quotaHeaders, spend } from './quota.js';
import { challengePage, challengeToken, cookieValue, passedChallenge, stylesheetResponse } from './challenge.js';
import { checkoutClient, isEmail, isSessionId, sessionIdFromWebhook, sessionState } from './checkout.js';
import { renderNotice, renderPage, renderPassPage } from './page.js';
import { mintPass, readPass } from './pass.js';
import { robotsTxt } from './robots.js';
import {
  buildOffer,
  decodePayment,
  expectedFor,
  METHODS,
  nanoPayee,
  nonceOf,
  paymentRequiredHeader,
  paymentResponseHeader,
  settleAgain,
  validBeforeOf,
  verifyAndSettle,
  xnoRaw,
} from './x402.js';

export {
  AI_INDEX_AGENTS,
  HEADLESS_AGENTS,
  isTrainingAgent,
  RETRIEVAL_AGENTS,
  SCRAPER_AGENTS,
  TRAINING_AGENTS,
  VERIFIED_RETRIEVAL,
  WELCOME_CRAWLERS,
} from './agents.js';
export {
  clientIp,
  compileCidrs,
  currentMajor,
  impostorCrawler,
  inCidrs,
  isSpoofedBrowser,
  isStaleBrowser,
  parseCidr,
  welcomeCrawler,
} from './edge.js';
export {
  challengePage,
  challengeToken,
  cookieValue,
  leadingZeros,
  passedChallenge,
  solves,
  stylesheetResponse,
  stylesheetToken,
} from './challenge.js';
export { renderNotice, renderPage, renderPassPage } from './page.js';
export { checkoutClient, sessionIdFromWebhook, sessionState } from './checkout.js';
export { mintPass, readPass } from './pass.js';
export { robotsTxt } from './robots.js';
export {
  buildOffer,
  decodeHeader,
  decodePayment,
  encodeHeader,
  expectedFor,
  METHODS,
  nanoPayee,
  paymentRequiredHeader,
  paymentResponseHeader,
  verifyAndSettle,
  xnoRaw,
} from './x402.js';
export { memoryQuotaStore, normaliseQuota, quotaHeaders, spend } from './quota.js';
export { isPowerKey, keyFrom, PROFULLSTACK_KEYS, verifyKey } from '@profullstack/keys';

/**
 * Where people and their agents sign in, pay and run an account. Never charged.
 *
 * The gateway sells reading, and none of these is reading: a 402 on /login is
 * not an offer anybody can take, it is a locked door. Since 0.8 a stale or
 * headless browser string is charged on every path, and every path included
 * these, so an agent whose OAuth token lapsed could not sign back in, a person
 * on a two-year-old Chrome could not reach checkout, and a processor's webhook
 * wearing an old user agent was answered with a price. Each is matched as a
 * whole path segment: `/pay` covers `/pay/abc` and not `/payouts-explained`.
 * Sites add their own with `appPaths` (they are appended) and an app whose
 * whole `/api/` is credentialed adds `/api`.
 */
export const APP_PATHS = Object.freeze([
  '/login',
  '/logout',
  '/signin',
  '/sign-in',
  '/signout',
  '/sign-out',
  '/signup',
  '/sign-up',
  '/register',
  '/auth',
  '/oauth',
  '/sso',
  '/callback',
  '/forgot-password',
  '/reset-password',
  '/verify',
  '/verify-email',
  '/dashboard',
  '/account',
  '/settings',
  '/admin',
  '/onboarding',
  '/checkout',
  '/pay',
  '/billing',
  '/webhook',
  '/webhooks',
  '/api/auth',
  '/api/oauth',
  '/api/health',
  '/api/webhook',
  '/api/webhooks',
  '/api/checkout',
]);

/**
 * Whether `path` is one of `paths` or below it, matched by whole segments.
 *
 * @param {string} path
 * @param {readonly string[]} [paths=APP_PATHS]
 * @returns {boolean}
 */
export function isAppPath(path, paths = APP_PATHS) {
  if (path.startsWith('/api/') && path.split('/').some((segment) => APP_API_SEGMENTS.has(segment.toLowerCase()))) return true;
  return paths.some((p) => {
    const base = p.replace(/\/+$/, '');
    return path === base || path.startsWith(`${base}/`);
  });
}

/**
 * An API route with one of these anywhere in it is sign-in or a delivery, not
 * data: `/api/coinpay/callback`, `/api/callback/oauth`,
 * `/api/v1/x/oauth/callback`, `/api/sp/oauth/linkedin/callback`. Callbacks are
 * named for the provider as often as for the flow, so a prefix list alone
 * missed most of the fleet's.
 */
const APP_API_SEGMENTS = new Set(['auth', 'oauth', 'callback', 'login', 'logout', 'signin', 'signup', 'webhook', 'webhooks', 'health']);

/**
 * A gateway that sells crawl access to training crawlers, by the day, over x402.
 *
 * People and search crawlers pass through untouched. A crawler on the training
 * list is answered with 402 Payment Required carrying an x402 offer -- as JSON,
 * or as an HTML sales page if it asked for HTML -- on every path but the few it
 * needs to read to comply. Paying the offer, at the sales page or on any 402'd
 * URL, returns a signed pass good for `passMinutes`, presented in `header` on
 * every request after that. A crawler that wants longer buys more days at
 * once: `?days=N` on the sales page quotes N terms, and a proof for N times
 * the price — however it was asked for — buys a pass that lasts N terms.
 *
 * Framework-agnostic: `handle(request)` takes a Fetch `Request` and resolves to
 * a `Response` to send, or null to let the request through. The adapters in
 * ./hono and ./next are one line each on top of it.
 *
 * @param {object} options
 * @param {string} options.siteUrl                 canonical origin, no trailing slash
 * @param {string} [options.siteName]              for the page; defaults to the hostname
 * @param {{apiKey: string, baseUrl?: string}} [options.coinpay]  a SCOPED CoinPay key (cp_live_…) with payments:create
 * @param {string} [options.payTo]                 EVM address that receives the USDC
 * @param {{payTo: string, rate: number|(() => number)}} [options.nano]  opt-in XNO on Nano: a nano_ (or xrb_) payee and the price of 1 XNO in `currency`; CoinPay must have NANO_RPC_URL set
 * @param {number} [options.priceCents=100]
 * @param {string} [options.currency='USD']
 * @param {number} [options.passMinutes=1440]          a day: the term one payment buys
 * @param {number} [options.maxDays=30]            the most terms one proof may buy at once
 * @param {string} [options.header='x-crawl-pass']
 * @param {string} [options.path='/crawl']         the sales page
 * @param {string[]} [options.openPaths]           extra paths a refused crawler may read
 * @param {(ua: string) => boolean} [options.isPaidAgent]
 * @param {string[]} [options.denyCidrs]           IPv4 ranges answered 403 before anything else, e.g. a VPS fleet's provider
 * @param {boolean} [options.chargeSpoofedBrowsers=false]  charge a "Chrome/…" request that lacks the Sec-Fetch-Mode header every Chromium sends
 * @param {boolean} [options.chargeStaleBrowsers=true]  charge a desktop browser string two years behind its auto-updates (a rotation pool)
 * @param {boolean} [options.challengeStaleBrowsers]  no effect since 0.15.3: a stale browser asking for a page reads it outright
 * @param {string[]} [options.scrapers]            SEO resellers charged and refused in robots.txt; default SCRAPER_AGENTS
 * @param {string[]} [options.headless]            headless browsers charged; default HEADLESS_AGENTS
 * @param {string[]} [options.aiIndex]             extra agents to charge and refuse in robots.txt, e.g. AI_INDEX_AGENTS; default none (they are welcome retrieval crawlers since 0.10)
 * @param {{token: string, cidrs: string[]}[]|false} [options.verifiedRetrieval]  retrieval crawlers believed only from their published addresses; default VERIFIED_RETRIEVAL
 * @param {boolean} [options.chargeImpostors=true]  charge a request wearing a welcome search crawler's name from outside its published ranges
 * @param {{paths: string[], cookie?: string, work?: number|boolean, css?: boolean, cssPath?: string, when?: (request: Request, url: URL) => boolean}|false} [options.challenge]  requests to these paths (and, with `when`, only those it accepts, e.g. faceted URLs) must run a one-line script (cookie + reload) first; with `work` (bits, `true` = 16) the script must also solve a SHA-256 proof of work, so a swarm that rotates its address every page pays it on every page; with `css` the page links a per-address stylesheet (at `cssPath`, default `/__pf/c/`) whose fetch sets a second cookie, so a scraper that blocks stylesheets never passes; off by default
 * @param {{token: string, cidrs: string[]}[]|false} [options.welcome]  search crawlers never metered when name and address agree; default WELCOME_CRAWLERS
 * @param {(request: Request) => boolean} [options.exempt]  requests never charged, e.g. ones carrying a signed-in cookie
 * @param {string[]|false} [options.appPaths]       extra sign-in, account and payment paths never charged, added to APP_PATHS; `false` charges them like any page
 * @param {string} [options.secret]                pass signing secret; defaults to the CoinPay key
 * @param {Record<string,string>|false} [options.powerKeys]  kid -> public key of the Power Keys honoured as a pass; defaults to Profullstack's, `false` switches it off
 * @param {Iterable<string>} [options.revokedKeys]  Power Key subjects no longer honoured
 * @param {(ctx: object) => string} [options.page] custom sales page renderer
 * @param {string} [options.contact]               mailto: or URL for bulk deals
 * @param {(sale: object) => void|Promise<void>} [options.onSale]   accounting hook; awaited before the receipt goes out, and its errors are swallowed. Carries `property`, `resourcePath`, `payer`, `userAgent`, `ipHash` and `source` ('x402' or 'checkout'); a checkout sale may be reported more than once (return page and webhook), so dedupe on `ref`
 * @param {string|((request: Request) => string)} [options.property]  the site this sale is for, recorded with CoinPay; defaults to the siteUrl hostname
 * @param {string} [options.ipSalt]                key for the address hash recorded with a sale; defaults to the pass secret
 * @param {{apiKey?: string, baseUrl?: string, account?: (request: Request) => string|null|Promise<string|null>, expiresInMinutes?: number}|false} [options.checkout]  the human "Buy a day pass" button (CoinPay hosted checkout, any coin or PayPal); on by default with the CoinPay key, shown only once CoinPay serves checkout sessions
 * @param {string} [options.passCookie='crawl_pass']  cookie a pass is also read from
 * @param {typeof fetch} [options.fetch]           for tests
 */
export function createGateway(options = {}) {
  const o = normalise(options);
  const enabled = Boolean(o.coinpay.apiKey && o.payTo);
  const secret = o.secret || o.coinpay.apiKey || null;

  const openPaths = ['/robots.txt', o.path, '/security.txt', '/.well-known/', ...o.openPaths];
  const denied = compileCidrs(o.denyCidrs);
  const isOpen = (path) => openPaths.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));

  const money = (cents) => `${(cents / 100).toFixed(2)} ${o.currency}`;
  const price = money(o.priceCents);
  const buyUrl = `${o.siteUrl}${o.path}`;
  /*
   * Where the prose points. A bare GET of the sales page answers JSON, because
   * the body is the only place an x402 client reads the offer from, so a
   * pointer to it would loop for the reader who needs the explanation most.
   * `?format=html` is the explainer whatever the Accept header says.
   */
  const howUrl = `${buyUrl}?format=html`;

  /** The site a sale is for: config, or what the host app says per request. */
  const propertyOf = (request) => {
    if (typeof o.property === 'function') {
      try {
        const p = o.property(request);
        if (p) return String(p);
      } catch {}
    } else if (o.property) {
      return o.property;
    }
    return new URL(o.siteUrl).hostname;
  };

  /**
   * The page a sale bought. On a gated URL that is the URL itself; on the
   * sales page it is whatever `?from=` says (the button and the 402 carry it),
   * since "/crawl" names the shop rather than the page anyone wanted.
   */
  const resourcePathOf = (request) => {
    const url = new URL(request.url);
    const from = url.searchParams.get('from');
    if (url.pathname === o.path || url.pathname.startsWith(`${o.path}/`)) {
      if (from && from.startsWith('/') && !from.startsWith('//') && from.length <= 1024) return from;
      return url.pathname;
    }
    const params = new URLSearchParams(url.search);
    for (const k of ['days', 'format', 'from']) params.delete(k);
    const q = params.toString();
    return `${url.pathname}${q ? `?${q}` : ''}`.slice(0, 1024);
  };

  /** A keyed hash of the caller's address: enough to tell repeat buyers apart, never the address. */
  const ipHashOf = async (request) => {
    const ip = clientIp(request);
    const key = o.ipSalt || secret;
    if (!ip || !key) return null;
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(key)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`ip:${ip}`)));
    return Array.from(sig.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
  };

  /** Who paid and where, as CoinPay's ledger and onSale both get it. */
  const saleContext = async (request, source) => ({
    property: propertyOf(request),
    resource_path: resourcePathOf(request),
    user_agent: (request.headers.get('user-agent') ?? '').slice(0, 512),
    ip_hash: await ipHashOf(request),
    source,
  });

  /*
   * The human checkout. On whenever there is a key to create sessions with
   * and a secret to sign the session cookie; shown only once CoinPay answers.
   */
  const checkoutPath = `${o.path}/checkout`;
  const checkoutKey = o.checkout ? o.checkout.apiKey || o.coinpay.apiKey : '';
  const cpCheckout =
    o.checkout && checkoutKey && secret
      ? checkoutClient({ apiKey: checkoutKey, baseUrl: o.checkout.baseUrl || o.coinpay.baseUrl, fetch: o.fetch })
      : null;
  const checkoutCookie = 'x402_checkout';

  /**
   * How many terms a request is asking to buy: `?days=N`, clamped to
   * [1, maxDays]. Anything unparseable is one day, which is what the offer
   * always meant before there was a way to ask for more.
   */
  const daysFrom = (request) => {
    const raw = new URL(request.url).searchParams.get('days');
    const n = Number.parseInt(raw ?? '', 10);
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(n, o.maxDays);
  };

  /**
   * The XNO entry's payee and raw amount for `days` terms, or null. `days`
   * times one term's raw, never the raw of `days` times the price, so a proof
   * for N terms is an exact multiple of the per-term amount, as for USDC.
   */
  const nanoFor = (days) => {
    if (!o.nano) return null;
    let rate;
    try {
      rate = typeof o.nano.rate === 'function' ? o.nano.rate() : o.nano.rate;
    } catch {
      return null;
    }
    const raw = xnoRaw(o.priceCents, rate);
    return raw ? { payTo: o.nano.payTo, amount: String(BigInt(raw) * BigInt(days)) } : null;
  };

  /** The offer for `days` terms: the same entries, `days` times the price. */
  const offer = (days = 1) =>
    enabled
      ? buildOffer({
          payTo: o.payTo,
          priceCents: o.priceCents * days,
          resource: buyUrl,
          description: `${days * o.passMinutes} minutes of crawl access to ${o.siteUrl}${days > 1 ? ` (${days} × ${o.passMinutes})` : ''}`,
          nano: nanoFor(days),
        })
      : { x402Version: 2, accepts: [] };

  const receipt = (days = 1, extra = {}) => ({
    ...offer(days),
    pass: {
      price,
      minutes: o.passMinutes,
      days,
      total: money(o.priceCents * days),
      maxDays: o.maxDays,
      header: o.header,
      buy: days > 1 ? `${buyUrl}?days=${days}` : buyUrl,
      buyDays: `${buyUrl}?days=<n>`,
    },
    /*
     * The other way in. A Power Key from the shop opens this site and every
     * other Profullstack property for good, so the 402 says so: a client that
     * has one but sent it in the wrong place, or that would rather buy once
     * than pay by the day, learns here where and how.
     */
    ...(o.powerKeys ? { powerKey: { shop: SHOP_URL, header: POWER_KEY_HEADER, bearer: true } } : {}),
    ...extra,
  });

  const noStore = {
    'cache-control': 'no-store',
    vary: 'Accept, User-Agent, X-Payment, Payment-Signature',
    'access-control-expose-headers': 'PAYMENT-REQUIRED, PAYMENT-RESPONSE',
  };

  /**
   * The spec's PAYMENT-REQUIRED header for a 402: the same offer as the body,
   * base64 JSON. Absent when payments are off, since an empty offer is no
   * offer.
   */
  const required = (days = 1, error) =>
    enabled
      ? {
          'payment-required': paymentRequiredHeader(offer(days), {
            url: days > 1 ? `${buyUrl}?days=${days}` : buyUrl,
            error,
          }),
        }
      : {};
  const json = (body, status, headers = {}) =>
    new Response(JSON.stringify(body, null, 2), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', ...noStore, ...headers },
    });
  const html = (body, status, headers = {}) =>
    new Response(body, {
      status,
      headers: { 'content-type': 'text/html; charset=utf-8', ...noStore, ...headers },
    });

  const pageCtx = (days = 1, usage = null, quota = o.freeQuota) => ({
    quota: quota
      ? {
          requests: quota.requests,
          windowSeconds: quota.windowSeconds,
          used: usage?.count ?? null,
          resetSeconds: usage?.resetSeconds ?? null,
          exceeded: Boolean(usage?.overLimit),
        }
      : null,
    benefits: o.benefits,
    days,
    total: money(o.priceCents * days),
    siteName: o.siteName,
    siteUrl: o.siteUrl,
    buyUrl,
    price,
    minutes: o.passMinutes,
    maxDays: o.maxDays,
    header: o.header,
    enabled,
    offer: offer(),
    training: o.training,
    retrieval: o.retrieval,
    contact: o.contact,
    powerKey: o.powerKeys ? { shop: SHOP_URL, header: POWER_KEY_HEADER } : null,
    checkout: null,
  });

  /** The page context with the checkout button, when CoinPay serves sessions. */
  const pageCtxFor = async (request, days, usage, quota) => {
    const ctx = pageCtx(days, usage, quota);
    if (cpCheckout && (await cpCheckout.available())) {
      ctx.checkout = { action: checkoutPath, from: resourcePathOf(request), days };
    }
    return ctx;
  };

  /**
   * The pass a request presents: a day pass from the named header or a bearer
   * token, or a Power Key wherever @profullstack/keys reads one.
   */
  const passFrom = (request) => {
    const direct = request.headers.get(o.header);
    if (direct) return direct.trim();
    const m = /^Bearer\s+(cp_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(request.headers.get('authorization') ?? '');
    if (m) return m[1];
    const pk = o.powerKeys ? keyFrom(request) : null;
    if (pk) return pk;
    const cookie = cookieValue(request, o.passCookie);
    return cookie && cookie.startsWith('cp_') ? cookie : null;
  };

  /**
   * Whether a token opens the site: a live day pass this gateway minted, or a
   * Power Key signed by a key in `powerKeys` and not revoked. A Power Key is
   * bought once at the shop and honoured everywhere, which is the point of it:
   * the site never asks anyone whether it is good, it checks the signature.
   */
  const honours = async (token) => {
    if (!token) return false;
    if (isPowerKey(token)) {
      if (!o.powerKeys) return false;
      const result = await verifyKey(token, { publicKeys: o.powerKeys, revoked: o.revokedKeys });
      return result.ok;
    }
    return Boolean(await readPass(token, { secret }));
  };

  /**
   * Whether a request is charged by the lists, as a spoofed or stale browser
   * string, or as an impostor wearing a welcome search crawler's name from an
   * address that crawler's operator does not publish.
   */
  /*
   * A stale browser string is only charged for what a browser never asks for.
   *
   * Until 0.15.3 an old desktop Chrome or Firefox string was charged on every
   * request, and a person on a pinned office build, a VPN browser or a string
   * our version estimate had drifted past was handed a JSON price instead of
   * the page (profullstack.com, 2026-10-28: Chrome 130 and Firefox 130 got 402
   * while bare curl read the page). Age alone cannot tell a person from a
   * rotation pool, and refusing a person is the worse mistake, so a request that
   * asks the way a browser does -- a page (Accept: text/html), a subresource a
   * page loads, or a Next.js client navigation -- reads like anybody else. A
   * script wearing a copied string and asking for anything-but-HTML or JSON is still charged.
   */
  const staleCharged = (request) => {
    if (!o.chargeStaleBrowsers) return false;
    if (asksLikeABrowser(request)) return false;
    return isStaleBrowser(request.headers.get('user-agent') ?? '');
  };

  const isPaid = (request) => {
    const ua = request.headers.get('user-agent') ?? '';
    return Boolean(
      o.isPaidAgent(ua) ||
        (o.chargeSpoofedBrowsers && isSpoofedBrowser(request)) ||
        staleCharged(request) ||
        (o.chargeImpostors && impostorCrawler(request, o.welcome)),
    );
  };

  /**
   * Whether a request reads free and unmetered: a search crawler whose address
   * agrees with its name, a retrieval crawler from its operator's published
   * addresses, or a named retrieval crawler / AI chat fetcher whose operator
   * publishes none. A name that belongs to an address-checked list is never
   * believed on its name alone.
   */
  const isWelcome = (request) => {
    if (welcomeCrawler(request, o.welcome)) return true;
    if (welcomeCrawler(request, o.verifiedRetrieval)) return true;
    const ua = (request.headers.get('user-agent') ?? '').toLowerCase();
    if (!ua) return false;
    // The default lists count even when switched off: switching off address
    // checks must not turn "bingbot" into a name anyone can wear.
    const checked = [...WELCOME_CRAWLERS, ...VERIFIED_RETRIEVAL, ...(o.welcome ?? []), ...(o.verifiedRetrieval ?? [])];
    if (checked.some((c) => ua.includes(c.token.toLowerCase()))) return false;
    return isTrainingAgent(ua, o.retrieval);
  };

  /**
   * Answer one request with the sale.
   *
   * The pass comes back as the BODY of a 200, not as the page that was asked
   * for: the buyer is a program reading stdout, `coinpay x402 pay` prints the
   * body and not the headers, and a crawler that wanted the page can fetch it
   * again a moment later with the pass.
   */
  async function sell(request, context = {}) {
    const ua = request.headers.get('user-agent') ?? '';
    // The spec's header first, then the one CoinPay's payer has always sent.
    const proofHeader = request.headers.get('payment-signature') || request.headers.get('x-payment');
    const asked = daysFrom(request);
    // Present when the free allowance is what stopped this request, rather than
    // the crawler lists. It changes what the 402 says, not what it costs.
    const usage = context.usage ?? null;
    /*
     * The allowance the caller was measured against. Defaults to this
     * gateway's own, but a caller that keeps its own counter -- an app-wide
     * throttle metering every route, not just the crawler lists -- hands its
     * own in, so the 402 quotes the limit that actually stopped the request
     * rather than one the gateway happens to hold.
     */
    const quota = context.quota ?? o.freeQuota;
    const rateHeaders = usage && quota ? quotaHeaders(quota, usage) : {};

    if (proofHeader) {
      if (!enabled) return json(receipt(asked, { error: 'Payments are not switched on here.' }), 402);
      const refuse = (days, error) => json(receipt(days, { error }), 402, required(days, error));
      const payment = decodePayment(proofHeader);
      if (!payment) return refuse(asked, 'The payment proof (PAYMENT-SIGNATURE or X-PAYMENT) is not base64 JSON.');
      const unit = expectedFor(payment, offer(1));
      if (!unit) return refuse(asked, 'Proof does not match an offered network.');

      /*
       * The money decides the term, not the URL. A proof is an authorization
       * for an exact value, and the value the buyer signed is what CoinPay
       * will move -- so the days it buys are read off the proof: a whole
       * number of day-prices, at most maxDays. `?days=` shaped the offer the
       * buyer read; if they then signed for a different multiple, they get
       * what they paid for, and if they signed for something that is not a
       * multiple they get nothing, before anyone is charged.
       */
      const days = daysPaid(paidValueOf(payment), unit.amount, o.maxDays);
      if (!days) {
        return refuse(
          asked,
          `Pay a whole number of days: ${unit.amount} per day in the token's smallest unit, up to ${o.maxDays} days. Add ?days=<n> to ${buyUrl} for the offer.`,
        );
      }
      const expected = expectedFor(payment, offer(days));
      const term = days * o.passMinutes * 60;

      const now = Math.floor(Date.now() / 1000);
      const coinpay = { apiKey: o.coinpay.apiKey, baseUrl: o.coinpay.baseUrl, fetch: o.fetch };
      const sale = await saleContext(request, 'x402');
      const result = await verifyAndSettle(payment, expected, { ...coinpay, metadata: sale });

      let expiresAt = null;
      let replayed = false;
      if (result.ok) {
        expiresAt = now + term;
      } else if (result.replay) {
        /*
         * Paid once, lost the answer, asked again with the same proof. Answered
         * with a pass -- but only if the money really moved, and only within
         * the proof's own validity window plus one term, so the same header
         * cannot be replayed for day after day. validBefore is set by the
         * payer at signing time, typically ten minutes out; nothing else about
         * "when was this bought" survives without a table.
         */
        const paid = await settleAgain(payment, coinpay);
        const validBefore = validBeforeOf(payment);
        if (paid && validBefore) {
          expiresAt = Math.min(now + term, validBefore + term);
          replayed = true;
        }
      }
      if (!expiresAt || expiresAt <= now) {
        return refuse(days, result.reason ?? 'Payment could not be settled.');
      }

      const ref = nonceOf(payment) ?? result.ref ?? null;
      const pass = await mintPass({ secret, ref, expiresAt, now });
      const expires = new Date(pass.expiresAt * 1000).toISOString();
      if (o.onSale && !replayed) {
        try {
          await o.onSale({
            payer: result.payer ?? null,
            ref,
            token: pass.token,
            expiresAt: expires,
            userAgent: ua,
            priceCents: o.priceCents,
            days,
            totalCents: o.priceCents * days,
            currency: o.currency,
            property: sale.property,
            resourcePath: sale.resource_path,
            ipHash: sale.ip_hash,
            source: 'x402',
            network: result.network ?? payment.network ?? null,
            txHash: result.txHash ?? null,
            metadata: { ...sale, ...(result.payer ? { payer: result.payer } : {}) },
          });
        } catch {
          // Accounting must never cost a buyer the pass it paid for.
        }
      }
      return json(
        {
          ok: true,
          pass: pass.token,
          expires_at: expires,
          days,
          minutes: days * o.passMinutes,
          header: o.header,
          replayed,
          use: `curl -H "${o.header}: ${pass.token}" ${o.siteUrl}/`,
        },
        200,
        {
          [o.header]: pass.token,
          [`${o.header}-expires`]: expires,
          'payment-response': paymentResponseHeader({
            transaction: result.txHash ?? ref,
            network: result.network ?? payment.network,
            payer: result.payer,
          }),
        },
      );
    }

    if (wantsHtml(request.headers.get('accept')) || new URL(request.url).searchParams.get('format') === 'html') {
      return html(o.page(await pageCtxFor(request, asked, usage, quota)), 402, { ...rateHeaders, ...required(asked) });
    }

    if (usage && quota) {
      // Say what ran out, when it comes back, and what a pass costs, in that
      // order. A caller reading this is deciding between waiting, rotating
      // addresses, and paying, and the numbers are the argument.
      return json(
        receipt(asked, {
          error:
            `Free allowance used: ${quota.requests} requests per ` +
            `${quota.windowSeconds}s. It resets in ${usage.resetSeconds}s. ` +
            `A pass removes the limit for ${price} a day.`,
          quota: {
            requests: quota.requests,
            windowSeconds: quota.windowSeconds,
            used: usage.count,
            resetSeconds: usage.resetSeconds,
          },
          ...(o.benefits ? { unlocks: o.benefits } : {}),
        }),
        402,
        { ...rateHeaders, ...required(asked) },
      );
    }

    return json(receipt(asked, { error: `Payment required for training crawlers. Read ${howUrl} for how.` }), 402, required(asked));
  }

  /* ------------------------------------------------------------ checkout -- */

  /** Sign and read the cookie that carries a session id to the return page. */
  const signId = async (id) => {
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`checkout:${id}`)));
    return Array.from(sig.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
  };
  const sessionFromCookie = async (request) => {
    const raw = cookieValue(request, checkoutCookie);
    if (!raw) return null;
    const dot = raw.lastIndexOf('.');
    if (dot < 0) return null;
    const id = decodeURIComponent(raw.slice(0, dot));
    if (!isSessionId(id)) return null;
    return (await signId(id)) === raw.slice(dot + 1) ? id : null;
  };

  const notice = (status, title, body, headers = {}) =>
    html(o.renderNotice({ siteName: o.siteName, siteUrl: o.siteUrl, buyUrl: howUrl, title, body }), status, headers);

  /** Read a form or JSON body, whichever the buyer sent. */
  const readForm = async (request) => {
    const type = (request.headers.get('content-type') ?? '').toLowerCase();
    try {
      if (type.includes('application/json')) {
        const j = await request.json();
        return j && typeof j === 'object' ? j : {};
      }
      const text = await request.text();
      return Object.fromEntries(new URLSearchParams(text.slice(0, 8192)));
    } catch {
      return {};
    }
  };

  /** POST /crawl/checkout: create a CoinPay session for a pass and send the buyer to it. */
  async function startCheckout(request) {
    if (!cpCheckout || !enabled) return notice(404, 'Checkout is not available here', 'This site does not sell passes through checkout yet.');
    if (request.method !== 'POST') return notice(405, 'Use the button', `Open <a href="${howUrl}">the pass page</a> and press Buy.`, { allow: 'POST' });
    const form = await readForm(request);
    const email = String(form.email ?? '').trim().toLowerCase();
    if (!isEmail(email)) return notice(400, 'An email address is needed', `CoinPay sends the receipt there. <a href="${howUrl}">Go back</a> and enter one.`);
    const n = Number.parseInt(String(form.days ?? '1'), 10);
    const days = Number.isFinite(n) && n >= 1 ? Math.min(n, o.maxDays) : 1;
    const fromRaw = String(form.from ?? '');
    const from = fromRaw.startsWith('/') && !fromRaw.startsWith('//') ? fromRaw.slice(0, 1024) : o.path;

    let account = null;
    if (o.checkout.account) {
      try {
        account = (await o.checkout.account(request)) || null;
      } catch {}
    }
    const property = propertyOf(request);
    const ctx = await saleContext(request, 'checkout');
    const cents = o.priceCents * days;
    const minutes = o.checkout.expiresInMinutes ?? 60;
    const created = await cpCheckout.create({
      amount: Number((cents / 100).toFixed(2)),
      currency: 'USD',
      description: `${days === 1 ? 'Day pass' : `${days}-day pass`} for ${o.siteName}`,
      customer_email: email,
      account_id: account ? String(account) : email,
      property,
      metadata: {
        kind: 'crawl_pass',
        source: 'x402-gateway',
        property,
        resource_path: from,
        days,
        price_cents: o.priceCents,
        user_agent: ctx.user_agent,
        ip_hash: ctx.ip_hash,
      },
      success_url: `${o.siteUrl}${checkoutPath}/return?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: howUrl,
      expires_in_minutes: minutes,
    });
    if (!created.ok) {
      return created.missing
        ? notice(503, 'Checkout is not open yet', `Card-free checkout is still being switched on. Meanwhile a pass can be bought over x402: see <a href="${howUrl}">the pass page</a>.`)
        : notice(502, 'Checkout could not start', `CoinPay did not create the payment (${esc(created.reason)}). Try again in a minute, or <a href="${howUrl}">go back</a>.`);
    }
    const cookie = `${checkoutCookie}=${encodeURIComponent(created.id)}.${await signId(created.id)}; Path=${checkoutPath}; Max-Age=${(minutes + 60) * 60}; HttpOnly; Secure; SameSite=Lax`;
    if ((request.headers.get('accept') ?? '').includes('application/json')) {
      return json({ id: created.id, url: created.url }, 200, { 'set-cookie': cookie });
    }
    return new Response(null, { status: 303, headers: { location: created.url, 'set-cookie': cookie, ...noStore } });
  }

  /**
   * Mint the pass a paid session bought, from what CoinPay says about it.
   * Resolves to `{ ok: true, token, expiresAt, days, state }`, or
   * `{ ok: false, pending|dead, state }`.
   *
   * The pass runs from when the session was paid, so reloading the return
   * page re-mints the same pass rather than a longer one.
   */
  async function passForSession(id) {
    if (!cpCheckout || !isSessionId(id)) return { ok: false, state: null };
    const session = await cpCheckout.get(id);
    if (!session) return { ok: false, state: null };
    const state = sessionState(session);
    if (state.id && state.id !== id) return { ok: false, state };
    if (!state.paid) return { ok: false, pending: !state.dead, dead: state.dead, state };
    // A session for another property of the same business opens nothing here.
    const property = o.property && typeof o.property === 'string' ? o.property : new URL(o.siteUrl).hostname;
    if (state.property && typeof o.property !== 'function' && String(state.property).toLowerCase() !== property.toLowerCase()) {
      return { ok: false, foreign: true, state };
    }
    if (state.metadata?.kind && state.metadata.kind !== 'crawl_pass') return { ok: false, foreign: true, state };
    if (state.currency !== 'USD' || !Number.isFinite(state.cents) || state.cents < o.priceCents) return { ok: false, state };
    const days = Math.min(o.maxDays, Math.floor(state.cents / o.priceCents));
    const now = Math.floor(Date.now() / 1000);
    const from = state.paidAt && state.paidAt <= now ? state.paidAt : now;
    const expiresAt = from + days * o.passMinutes * 60;
    if (expiresAt <= now) return { ok: false, expired: true, state };
    const pass = await mintPass({ secret, ref: `checkout:${id}`, expiresAt: expiresAt, now: Math.min(from, now) });
    return { ok: true, token: pass.token, expiresAt: pass.expiresAt, days, state };
  }

  /** Tell onSale about a checkout sale. Swallows the hook's errors, like the x402 path. */
  const reportCheckout = async (id, minted, request) => {
    if (!o.onSale) return;
    const st = minted.state;
    try {
      await o.onSale({
        payer: st.email ?? null,
        ref: `checkout:${id}`,
        token: minted.token,
        expiresAt: new Date(minted.expiresAt * 1000).toISOString(),
        userAgent: st.metadata?.user_agent ?? request?.headers.get('user-agent') ?? '',
        priceCents: o.priceCents,
        days: minted.days,
        totalCents: st.cents,
        currency: 'USD',
        property: st.property ?? propertyOf(request ?? new Request(o.siteUrl)),
        resourcePath: st.metadata?.resource_path ?? null,
        ipHash: st.metadata?.ip_hash ?? null,
        source: 'checkout',
        email: st.email ?? null,
        accountId: st.accountId ?? null,
        checkoutSessionId: id,
        metadata: st.metadata,
      });
    } catch {}
  };

  /** GET /crawl/checkout/return: the buyer is back from CoinPay; show the pass. */
  async function checkoutReturn(request) {
    if (!cpCheckout) return notice(404, 'Checkout is not available here', 'This site does not sell passes through checkout yet.');
    const fromCookie = await sessionFromCookie(request);
    const q = new URL(request.url).searchParams;
    const fromQuery = ['session_id', 'checkout_session_id', 'session'].map((k) => q.get(k)).find((v) => isSessionId(v ?? ''));
    const id = fromCookie ?? fromQuery ?? null;
    if (!id) return notice(400, 'No checkout to show', `This page opens after paying at CoinPay. <a href="${howUrl}">Buy a pass</a>.`);
    const minted = await passForSession(id);
    if (!minted.ok) {
      if (minted.pending) {
        return notice(
          202,
          'Waiting for the payment to confirm',
          'CoinPay has not marked this payment paid yet. Crypto payments need a block or two; this page checks again every 15 seconds.',
          { refresh: '15' },
        );
      }
      if (minted.dead) return notice(410, 'This checkout closed unpaid', `Nothing was charged. <a href="${howUrl}">Start again</a>.`);
      if (minted.expired) return notice(410, 'This pass has already run out', `<a href="${howUrl}">Buy another</a>.`);
      return notice(502, 'Could not read this checkout', 'CoinPay did not answer for this payment. Reload in a minute; a paid pass is not lost.');
    }
    // Report the sale once per browser: the cookie is cleared on the way out.
    if (fromCookie) await reportCheckout(id, minted, request);
    const expires = new Date(minted.expiresAt * 1000).toISOString();
    const maxAge = Math.max(0, minted.expiresAt - Math.floor(Date.now() / 1000));
    const headers = new Headers({ 'content-type': 'text/html; charset=utf-8', ...noStore, [o.header]: minted.token, [`${o.header}-expires`]: expires });
    headers.append('set-cookie', `${o.passCookie}=${minted.token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`);
    headers.append('set-cookie', `${checkoutCookie}=; Path=${checkoutPath}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
    const body = o.renderPassPage({
      siteName: o.siteName,
      siteUrl: o.siteUrl,
      buyUrl: howUrl,
      token: minted.token,
      expiresAt: expires,
      days: minted.days,
      header: o.header,
      cookie: o.passCookie,
      email: minted.state.email,
    });
    return new Response(body, { status: 200, headers });
  }

  /**
   * A CoinPay webhook about a checkout session. The body is only a hint: the
   * session is read back from CoinPay with this site's key, so a forged call
   * mints nothing. Resolves to the minted pass (for a site that emails it) or
   * null. Mount it on a site's existing webhook route, or let the gateway
   * answer POST /crawl/checkout/webhook itself.
   */
  async function checkoutPaid(bodyOrId, request) {
    const id = typeof bodyOrId === 'string' ? bodyOrId : sessionIdFromWebhook(bodyOrId);
    if (!id) return null;
    const minted = await passForSession(id);
    if (!minted.ok) return null;
    await reportCheckout(id, minted, request);
    return { token: minted.token, expiresAt: new Date(minted.expiresAt * 1000).toISOString(), days: minted.days, email: minted.state.email, accountId: minted.state.accountId, ref: `checkout:${id}` };
  }

  async function checkoutWebhook(request) {
    if (request.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405, { allow: 'POST' });
    let body = {};
    try {
      body = await request.json();
    } catch {}
    const minted = await checkoutPaid(body, request);
    return json({ ok: true, minted: Boolean(minted) }, 200);
  }

  /** The routes under the sales page. Null for anything else. */
  async function checkoutRoute(request, path) {
    if (path === checkoutPath) return startCheckout(request);
    if (path === `${checkoutPath}/return`) return checkoutReturn(request);
    if (path === `${checkoutPath}/webhook`) return checkoutWebhook(request);
    return null;
  }

  /**
   * The gate. Null means "not for me, carry on".
   *
   * The sales page is answered for EVERYONE, so an operator can read it and a
   * client can pay at it whatever user agent it wears. Every other decision
   * starts from the user agent.
   */
  async function handle(request) {
    /*
     * Addresses that serve no readers are refused before anything else, with
     * a body small enough that refusing costs nothing. Not 402: there is no
     * pass on sale to a hosting range that spoofs a browser, because whoever
     * runs it has already declined to say who they are.
     */
    if (denied.length && inCidrs(clientIp(request), denied)) {
      return new Response('Not available from this network.\n', {
        status: 403,
        headers: { 'content-type': 'text/plain; charset=utf-8', ...noStore },
      });
    }

    const path = new URL(request.url).pathname;
    if (path === o.path) return sell(request);
    if (path.startsWith(`${checkoutPath}`) && (path === checkoutPath || path.startsWith(`${checkoutPath}/`))) {
      const answer = await checkoutRoute(request, path);
      if (answer) return answer;
    }
    // The challenge stylesheet answers everyone: fetching it is the test.
    if (o.challenge?.cssPath && secret && path.startsWith(o.challenge.cssPath)) {
      return stylesheetResponse(request, { secret, cookie: o.challenge.cookie, ip: clientIp(request), cssPath: o.challenge.cssPath });
    }
    if (o.exempt && o.exempt(request)) return null;
    // Signing in, paying and running an account are never sold. See APP_PATHS.
    if (o.appPaths && isAppPath(path, o.appPaths)) return null;

    /*
     * A valid pass is checked before anything else that could refuse, because
     * a pass is the thing being sold: whoever holds one is neither charged as
     * a crawler nor metered against the free allowance. It used to be read
     * only after the crawler lists matched, which was fine while the lists
     * were the only reason to refuse and is not now that a quota exists.
     */
    const token = passFrom(request);
    if (await honours(token)) return null;

    if (isPaid(request) && !isOpen(path)) return sell(request);
    if (isOpen(path)) return null;

    /*
     * A search crawler that is who it says it is reads free and unmetered.
     * Googlebot walking a large site from a handful of addresses outruns any
     * per-address allowance, and answering it 402 is how a site leaves the
     * index. Name and address must agree, so copying the string buys nothing.
     */
    if (isWelcome(request)) return null;

    /*
     * Every caller on a challenged path proves it runs scripts, except the
     * welcome crawlers just above (search crawlers verified by address,
     * retrieval crawlers and AI chat fetchers). Exempting anything that merely
     * calls itself a bot would let the swarm walk in wearing "compatible;".
     * Only GET and HEAD, and only with a secret to sign the answer. A caller
     * that asked for HTML gets the one-line script; anything else gets the
     * JSON offer, since it was never going to run a script.
     */
    if (
      o.challenge &&
      secret &&
      meters(o.challenge, path) &&
      (!o.challenge.when || o.challenge.when(request, new URL(request.url))) &&
      (request.method === 'GET' || request.method === 'HEAD')
    ) {
      const ip = clientIp(request);
      if (ip && !(await passedChallenge(request, { secret, cookie: o.challenge.cookie, ip, work: o.challenge.work, css: Boolean(o.challenge.cssPath) }))) {
        if (!wantsHtml(request.headers.get('accept'))) {
          return json(
            receipt(1, {
              error: `${path} is read in a browser (it sets a cookie with one line of script) or with a pass. Read ${howUrl} for how.`,
            }),
            402,
            required(1),
          );
        }
        const token = await challengeToken(secret, ip);
        return html(challengePage({ token, cookie: o.challenge.cookie, buyUrl, work: o.challenge.work, cssPath: o.challenge.cssPath }), 402, required(1));
      }
    }

    /*
     * Everyone else gets the free allowance. Running out is answered with a
     * price rather than a 429: the caller has just shown it wants more than
     * the free tier and is still holding the request, which is the best moment
     * this site will ever get to sell it a pass.
     */
    if (o.freeQuota && meters(o.freeQuota, path)) {
      const key = o.freeQuota.identify ? o.freeQuota.identify(request) : clientIp(request);
      const usage = await spend(o.freeQuota, key);
      // Under the limit the request carries on untouched. `handle` answers with
      // a Response or nothing at all, and quietly growing that contract to
      // smuggle headers out would break every adapter that checks it for truth.
      // The allowance is advertised on the 402, which is where it is read.
      if (usage?.overLimit) return sell(request, { usage });
    }

    return null;
  }

  return {
    handle,
    sell,
    enabled,
    options: o,
    /**
     * The pass a request presents, and whether it is one this gateway minted
     * and still honours.
     *
     * Exposed because the pass has to be honoured by everything that could
     * refuse a request, not only by `handle`. An app-wide throttle that meters
     * every route has to skip whoever already paid, and recomputing the
     * signing-secret fallback (`secret || coinpay.apiKey`) on its side is
     * exactly the kind of duplicate rule that drifts and starts charging
     * paying crawlers twice.
     */
    passFrom,
    verifyPass: honours,
    /**
     * Whether a request is a charged crawler by this gateway's rules (the
     * lists, a spoofed or a stale browser string), and whether it is a welcome
     * search crawler whose address matches its name. Exposed so a throttle
     * that meters every route charges and spares exactly the same callers.
     */
    isPaid,
    isWelcome,
    /**
     * The x402 offer this gateway would make, and the full receipt body around
     * it, without answering a request.
     *
     * A site with its own refusal -- a tiered limiter whose 429 body says which
     * rung the caller is on and what the next one costs -- wants to keep that
     * body and add a machine-readable offer to it, so an x402 client can pay
     * on the spot instead of being told in prose to go and fetch /crawl. The
     * alternative is every such site rebuilding payTo, price, currency and
     * network from its own copy of the config, which is how two of them end up
     * quoting different numbers.
     */
    offer,
    receipt,
    /** robots.txt with this gateway's lists and sales path. */
    robotsTxt: (extra = {}) =>
      robotsTxt({
        siteUrl: o.siteUrl,
        path: o.path,
        training: [...o.training, ...o.scrapers, ...o.aiIndex],
        retrieval: o.retrieval,
        ...extra,
      }),
    /** The sales page as HTML, for a site that mounts it on a route of its own. */
    page: () => {
      const ctx = pageCtx();
      if (cpCheckout && cpCheckout.known()) ctx.checkout = { action: checkoutPath, from: o.path, days: 1 };
      return o.page(ctx);
    },
    /** The PAYMENT-REQUIRED header value for `days`, for a site that answers its own 402. */
    paymentRequired: (days = 1, error) => required(days, error)['payment-required'] ?? null,
    /** The sale context (property, page, UA, address hash) a request would be recorded with. */
    saleContext,
    /** Whether the checkout button shows: CoinPay serves checkout sessions and a key is set. */
    checkoutAvailable: async () => Boolean(cpCheckout && (await cpCheckout.available())),
    /** A CoinPay webhook handler (Fetch Request -> Response) that mints a paid session's pass. */
    checkoutWebhook,
    /** Mint the pass for a paid checkout session, from a webhook body or a session id. */
    checkoutPaid,
  };
}

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Whether the caller would rather read a page than a JSON offer. */
export const wantsHtml = (accept = '') => String(accept ?? '').toLowerCase().includes('text/html');

/** Fetch destinations a page load produces: the document itself and what it pulls in. */
const PAGE_DESTS = new Set(['document', 'iframe', 'frame', 'image', 'style', 'script', 'font', 'video', 'audio', 'track', 'manifest']);

/**
 * Whether a request asks the way a browser loading a page does: it wants HTML,
 * it is a navigation or a subresource by its fetch metadata, or it is a Next.js
 * client navigation (an RSC payload, sent with Accept: *\/*).
 */
export function asksLikeABrowser(request) {
  const h = request.headers;
  if (wantsHtml(h.get('accept'))) return true;
  if (PAGE_DESTS.has(String(h.get('sec-fetch-dest') ?? '').toLowerCase())) return true;
  return h.has('rsc') || h.has('next-router-state-tree') || h.has('x-nextjs-data');
}

/** The value a proof authorizes, in the token's smallest unit, or null. */
export function paidValueOf(payment) {
  // A Nano proof states its amount in raw; CoinPay then holds the block to the offer.
  const raw = payment?.payload?.authorization?.value ?? (payment?.network === 'nano' ? payment?.payload?.amount : undefined);
  if (raw === undefined || raw === null || raw === '') return null;
  try {
    const value = BigInt(raw);
    return value > 0n ? value : null;
  } catch {
    return null;
  }
}

/**
 * How many terms a paid value buys at `unit` per term: a whole number in
 * [1, maxDays], or 0 when it is not one. Integer arithmetic on the smallest
 * unit, so a price that is not a round number of cents still divides exactly.
 *
 * @param {bigint|null} value
 * @param {string|number|bigint} unit
 * @param {number} maxDays
 * @returns {number}
 */
export function daysPaid(value, unit, maxDays) {
  if (value === null) return 0;
  let per;
  try {
    per = BigInt(unit);
  } catch {
    return 0;
  }
  if (per <= 0n || value % per !== 0n) return 0;
  const days = value / per;
  if (days < 1n || days > BigInt(maxDays)) return 0;
  return Number(days);
}

function normalise(options) {
  const siteUrl = String(options.siteUrl ?? '').replace(/\/+$/, '');
  if (!siteUrl) throw new Error('createGateway needs siteUrl');
  const training = options.training ?? TRAINING_AGENTS;
  const scrapers = options.scrapers ?? SCRAPER_AGENTS;
  const headless = options.headless ?? HEADLESS_AGENTS;
  const aiIndex = options.aiIndex ?? [];
  const paid = [...training, ...scrapers, ...headless, ...aiIndex];
  return {
    siteUrl,
    siteName: options.siteName || new URL(siteUrl).hostname,
    coinpay: {
      apiKey: options.coinpay?.apiKey ?? '',
      baseUrl: (options.coinpay?.baseUrl ?? 'https://coinpayportal.com').replace(/\/+$/, ''),
    },
    payTo: options.payTo ?? '',
    nano: nanoPayee(options.nano?.payTo) ? { payTo: nanoPayee(options.nano.payTo), rate: options.nano.rate } : null,
    priceCents: Number.isFinite(options.priceCents) ? options.priceCents : 100,
    currency: options.currency ?? 'USD',
    passMinutes: Number.isFinite(options.passMinutes) && options.passMinutes > 0 ? options.passMinutes : 1440,
    maxDays: Number.isInteger(options.maxDays) && options.maxDays >= 1 ? options.maxDays : 30,
    header: String(options.header ?? 'x-crawl-pass').toLowerCase(),
    path: options.path ?? '/crawl',
    openPaths: options.openPaths ?? [],
    denyCidrs: options.denyCidrs ?? [],
    chargeSpoofedBrowsers: Boolean(options.chargeSpoofedBrowsers),
    chargeStaleBrowsers: options.chargeStaleBrowsers !== false,
    challengeStaleBrowsers: options.challengeStaleBrowsers !== false,
    chargeImpostors: options.chargeImpostors !== false,
    exempt: options.exempt ?? null,
    appPaths: options.appPaths === false ? null : [...APP_PATHS, ...(options.appPaths ?? [])],
    training,
    scrapers,
    headless,
    aiIndex,
    challenge:
      options.challenge && Array.isArray(options.challenge.paths) && options.challenge.paths.length
        ? {
            paths: options.challenge.paths,
            cookie: options.challenge.cookie ?? 'pf_js',
            work: challengeWork(options.challenge.work),
            cssPath: options.challenge.css ? (options.challenge.cssPath ?? '/__pf/c/') : null,
            when: typeof options.challenge.when === 'function' ? options.challenge.when : null,
          }
        : null,
    welcome: options.welcome === false ? null : (options.welcome ?? WELCOME_CRAWLERS),
    verifiedRetrieval: options.verifiedRetrieval === false ? null : (options.verifiedRetrieval ?? VERIFIED_RETRIEVAL),
    retrieval: options.retrieval ?? RETRIEVAL_AGENTS,
    isPaidAgent: options.isPaidAgent ?? ((ua) => isTrainingAgent(ua, paid)),
    secret: options.secret ?? '',
    page: options.page ?? renderPage,
    contact: options.contact ?? '',
    onSale: options.onSale ?? null,
    property: typeof options.property === 'function' || typeof options.property === 'string' ? options.property : null,
    ipSalt: options.ipSalt ?? '',
    checkout: options.checkout === false ? null : { ...(options.checkout ?? {}) },
    passCookie: String(options.passCookie ?? 'crawl_pass'),
    renderNotice: options.renderNotice ?? renderNotice,
    renderPassPage: options.renderPassPage ?? renderPassPage,
    freeQuota: normaliseQuota(options.freeQuota),
    benefits: Array.isArray(options.benefits) ? options.benefits : null,
    powerKeys: options.powerKeys === false ? null : (options.powerKeys ?? PROFULLSTACK_KEYS),
    revokedKeys: options.revokedKeys ?? null,
    fetch: options.fetch ?? globalThis.fetch,
  };
}

/** `true` means the default 16 bits; a number is clamped to 0-24 (24 is ~16M digests, too slow for a phone). */
function challengeWork(work) {
  if (work === true) return 16;
  return Number.isInteger(work) ? Math.max(0, Math.min(24, work)) : 0;
}

export { METHODS as X402_METHODS };
