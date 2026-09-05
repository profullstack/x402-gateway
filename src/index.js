import { isTrainingAgent, RETRIEVAL_AGENTS, TRAINING_AGENTS } from './agents.js';
import { clientIp, compileCidrs, inCidrs, isSpoofedBrowser } from './edge.js';
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

/**
 * A gateway that sells crawl access to training crawlers, by the day, over x402.
 *
 * People and search crawlers pass through untouched. A crawler on the training
 * list is answered with 402 Payment Required carrying an x402 offer -- as JSON,
 * or as an HTML sales page if it asked for HTML -- on every path but the few it
 * needs to read to comply. Paying the offer, at the sales page or on any 402'd
 * URL, returns a signed pass good for `passMinutes`, presented in `header` on
 * every request after that.
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
 * @param {number} [options.passMinutes=1440]          a day
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
 * @param {(sale: object) => void|Promise<void>} [options.onSale]   accounting hook, never awaited for the answer
 * @param {typeof fetch} [options.fetch]           for tests
 */
export function createGateway(options = {}) {
  const o = normalise(options);
  const enabled = Boolean(o.coinpay.apiKey && o.payTo);
  const secret = o.secret || o.coinpay.apiKey || null;

  const openPaths = ['/robots.txt', o.path, '/security.txt', '/.well-known/', ...o.openPaths];
  const denied = compileCidrs(o.denyCidrs);
  const isOpen = (path) => openPaths.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));

  const price = `${(o.priceCents / 100).toFixed(2)} ${o.currency}`;
  const buyUrl = `${o.siteUrl}${o.path}`;

  const offer = () =>
    enabled
      ? buildOffer({
          payTo: o.payTo,
          priceCents: o.priceCents,
          resource: buyUrl,
          description: `${o.passMinutes} minutes of crawl access to ${o.siteUrl}`,
        })
      : { x402Version: 2, accepts: [] };

  const receipt = (extra = {}) => ({
    ...offer(),
    pass: { price, minutes: o.passMinutes, header: o.header, buy: buyUrl },
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
  const html = (body, status) =>
    new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...noStore } });

  const pageCtx = () => ({
    siteName: o.siteName,
    siteUrl: o.siteUrl,
    buyUrl,
    price,
    minutes: o.passMinutes,
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
  async function sell(request) {
    const ua = request.headers.get('user-agent') ?? '';
    const proofHeader = request.headers.get('x-payment');

    if (proofHeader) {
      if (!enabled) return json(receipt({ error: 'Payments are not switched on here.' }), 402);
      const payment = decodePayment(proofHeader);
      if (!payment) return json(receipt({ error: 'X-PAYMENT is not base64 JSON.' }), 402);
      const current = offer();
      const expected = expectedFor(payment, current);
      if (!expected) return json(receipt({ error: 'Proof does not match an offered network.' }), 402);

      const now = Math.floor(Date.now() / 1000);
      const coinpay = { apiKey: o.coinpay.apiKey, baseUrl: o.coinpay.baseUrl, fetch: o.fetch };
      const result = await verifyAndSettle(payment, expected, coinpay);

      let expiresAt = null;
      let replayed = false;
      if (result.ok) {
        expiresAt = now + o.passMinutes * 60;
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
          expiresAt = Math.min(now + o.passMinutes * 60, validBefore + o.passMinutes * 60);
          replayed = true;
        }
      }
      if (!expiresAt || expiresAt <= now) {
        return json(receipt({ error: result.reason ?? 'Payment could not be settled.' }), 402);
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
          header: o.header,
          replayed,
          use: `curl -H "${o.header}: ${pass.token}" ${o.siteUrl}/`,
        },
        200,
        { [o.header]: pass.token, [`${o.header}-expires`]: expires },
      );
    }

    if (wantsHtml(request.headers.get('accept'))) return html(o.page(pageCtx()), 402);
    return json(receipt({ error: `Payment required for training crawlers. Read ${buyUrl} for how.` }), 402);
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
    const pays =
      o.isPaidAgent(request.headers.get('user-agent') ?? '') ||
      (o.chargeSpoofedBrowsers && isSpoofedBrowser(request));
    if (!pays) return null;
    if (isOpen(path)) return null;

    const token = passFrom(request);
    if (token && (await readPass(token, { secret }))) return null;
    return sell(request);
  }

  return {
    handle,
    sell,
    enabled,
    options: o,
    /** robots.txt with this gateway's lists and sales path. */
    robotsTxt: (extra = {}) =>
      robotsTxt({ siteUrl: o.siteUrl, path: o.path, training: o.training, retrieval: o.retrieval, ...extra }),
    /** The sales page as HTML, for a site that mounts it on a route of its own. */
    page: () => o.page(pageCtx()),
  };
}

/** Whether the caller would rather read a page than a JSON offer. */
export const wantsHtml = (accept = '') => String(accept ?? '').toLowerCase().includes('text/html');

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
    fetch: options.fetch ?? globalThis.fetch,
  };
}

export { METHODS as X402_METHODS };
