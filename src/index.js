import { isTrainingAgent, RETRIEVAL_AGENTS, TRAINING_AGENTS } from './agents.js';
import { clientIp, compileCidrs, inCidrs, isSpoofedBrowser } from './edge.js';
import { memoryQuotaStore, meters, normaliseQuota, quotaHeaders, spend } from './quota.js';
import { renderPage } from './page.js';
import { mintPass, readPass } from './pass.js';
import { robotsTxt } from './robots.js';
import {
  buildOffer,
  decodePayment,
  expectedFor,
  METHODS,
  nonceOf,
  settleAgain,
  validBeforeOf,
  verifyAndSettle,
} from './x402.js';

export { isTrainingAgent, RETRIEVAL_AGENTS, TRAINING_AGENTS } from './agents.js';
export { clientIp, compileCidrs, inCidrs, isSpoofedBrowser, parseCidr } from './edge.js';
export { renderPage } from './page.js';
export { mintPass, readPass } from './pass.js';
export { robotsTxt } from './robots.js';
export { buildOffer, decodePayment, expectedFor, METHODS, verifyAndSettle } from './x402.js';
export { memoryQuotaStore, normaliseQuota, quotaHeaders, spend } from './quota.js';

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
 * @param {(request: Request) => boolean} [options.exempt]  requests never charged, e.g. ones carrying a signed-in cookie
 * @param {string} [options.secret]                pass signing secret; defaults to the CoinPay key
 * @param {(ctx: object) => string} [options.page] custom sales page renderer
 * @param {string} [options.contact]               mailto: or URL for bulk deals
 * @param {(sale: object) => void|Promise<void>} [options.onSale]   accounting hook; awaited before the receipt goes out, and its errors are swallowed
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

  /** The offer for `days` terms: the same entries, `days` times the price. */
  const offer = (days = 1) =>
    enabled
      ? buildOffer({
          payTo: o.payTo,
          priceCents: o.priceCents * days,
          resource: buyUrl,
          description: `${days * o.passMinutes} minutes of crawl access to ${o.siteUrl}${days > 1 ? ` (${days} × ${o.passMinutes})` : ''}`,
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
    ...extra,
  });

  const noStore = {
    'cache-control': 'no-store',
    vary: 'Accept, User-Agent, X-Payment',
  };
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
  });

  /** The pass a request presents, from the named header or a bearer token. */
  const passFrom = (request) => {
    const direct = request.headers.get(o.header);
    if (direct) return direct.trim();
    const m = /^Bearer\s+(cp_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(request.headers.get('authorization') ?? '');
    return m ? m[1] : null;
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
    const proofHeader = request.headers.get('x-payment');
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
      const payment = decodePayment(proofHeader);
      if (!payment) return json(receipt(asked, { error: 'X-PAYMENT is not base64 JSON.' }), 402);
      const unit = expectedFor(payment, offer(1));
      if (!unit) return json(receipt(asked, { error: 'Proof does not match an offered network.' }), 402);

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
        return json(
          receipt(asked, {
            error: `Pay a whole number of days: ${unit.amount} per day in the token's smallest unit, up to ${o.maxDays} days. Add ?days=<n> to ${buyUrl} for the offer.`,
          }),
          402,
        );
      }
      const expected = expectedFor(payment, offer(days));
      const term = days * o.passMinutes * 60;

      const now = Math.floor(Date.now() / 1000);
      const coinpay = { apiKey: o.coinpay.apiKey, baseUrl: o.coinpay.baseUrl, fetch: o.fetch };
      const result = await verifyAndSettle(payment, expected, coinpay);

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
        return json(receipt(days, { error: result.reason ?? 'Payment could not be settled.' }), 402);
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
        { [o.header]: pass.token, [`${o.header}-expires`]: expires },
      );
    }

    if (wantsHtml(request.headers.get('accept'))) {
      return html(o.page(pageCtx(asked, usage, quota)), 402, rateHeaders);
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
        rateHeaders,
      );
    }

    return json(receipt(asked, { error: `Payment required for training crawlers. Read ${buyUrl} for how.` }), 402);
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
    if (o.exempt && o.exempt(request)) return null;

    /*
     * A valid pass is checked before anything else that could refuse, because
     * a pass is the thing being sold: whoever holds one is neither charged as
     * a crawler nor metered against the free allowance. It used to be read
     * only after the crawler lists matched, which was fine while the lists
     * were the only reason to refuse and is not now that a quota exists.
     */
    const token = passFrom(request);
    const paid = Boolean(token && (await readPass(token, { secret })));
    if (paid) return null;

    const pays =
      o.isPaidAgent(request.headers.get('user-agent') ?? '') ||
      (o.chargeSpoofedBrowsers && isSpoofedBrowser(request));
    if (pays && !isOpen(path)) return sell(request);
    if (isOpen(path)) return null;

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
    verifyPass: async (token) => Boolean(token && (await readPass(token, { secret }))),
    /** robots.txt with this gateway's lists and sales path. */
    robotsTxt: (extra = {}) =>
      robotsTxt({ siteUrl: o.siteUrl, path: o.path, training: o.training, retrieval: o.retrieval, ...extra }),
    /** The sales page as HTML, for a site that mounts it on a route of its own. */
    page: () => o.page(pageCtx()),
  };
}

/** Whether the caller would rather read a page than a JSON offer. */
export const wantsHtml = (accept = '') => String(accept ?? '').toLowerCase().includes('text/html');

/** The value a proof authorizes, in the token's smallest unit, or null. */
export function paidValueOf(payment) {
  const raw = payment?.payload?.authorization?.value;
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
  return {
    siteUrl,
    siteName: options.siteName || new URL(siteUrl).hostname,
    coinpay: {
      apiKey: options.coinpay?.apiKey ?? '',
      baseUrl: (options.coinpay?.baseUrl ?? 'https://coinpayportal.com').replace(/\/+$/, ''),
    },
    payTo: options.payTo ?? '',
    priceCents: Number.isFinite(options.priceCents) ? options.priceCents : 100,
    currency: options.currency ?? 'USD',
    passMinutes: Number.isFinite(options.passMinutes) && options.passMinutes > 0 ? options.passMinutes : 1440,
    maxDays: Number.isInteger(options.maxDays) && options.maxDays >= 1 ? options.maxDays : 30,
    header: String(options.header ?? 'x-crawl-pass').toLowerCase(),
    path: options.path ?? '/crawl',
    openPaths: options.openPaths ?? [],
    denyCidrs: options.denyCidrs ?? [],
    chargeSpoofedBrowsers: Boolean(options.chargeSpoofedBrowsers),
    exempt: options.exempt ?? null,
    training,
    retrieval: options.retrieval ?? RETRIEVAL_AGENTS,
    isPaidAgent: options.isPaidAgent ?? ((ua) => isTrainingAgent(ua, training)),
    secret: options.secret ?? '',
    page: options.page ?? renderPage,
    contact: options.contact ?? '',
    onSale: options.onSale ?? null,
    freeQuota: normaliseQuota(options.freeQuota),
    benefits: Array.isArray(options.benefits) ? options.benefits : null,
    fetch: options.fetch ?? globalThis.fetch,
  };
}

export { METHODS as X402_METHODS };
