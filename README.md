# @profullstack/x402-gateway

Sell crawl access to AI training crawlers, by the day, over [x402](https://x402.org), settled by [CoinPay](https://coinpayportal.com).

People read your site free. So do search engines and the retrieval crawlers behind AI answers, because they send readers back. A crawler that copies pages into a training corpus sends nobody back, so it pays: every page answers `402 Payment Required` with an x402 offer, paying the offer returns a signed pass, and the pass opens the site for a day.

A crawler that wants longer buys more days in one payment. `?days=7` on the sales page quotes seven days at the daily price, and the days a proof buys are read off the value it authorizes, so paying seven times the price — however it was asked for — returns a pass that expires seven days out. `maxDays` caps how many one proof can buy.

One middleware. No database. Runs in Node, Bun and at the edge.

```
npm install @profullstack/x402-gateway
```

## What it does

| Visitor | Gets |
| --- | --- |
| A person, Googlebot, Bingbot, Applebot, OAI-SearchBot, Claude-SearchBot, PerplexityBot… | the site, untouched |
| GPTBot, ClaudeBot, CCBot, meta-externalagent, Bytespider, Applebot-Extended… | `402` with an x402 offer, or the HTML sales page if it asked for HTML |
| Anyone at `/crawl` | the sales page (HTML, or always with `?format=html`) or the offer (JSON), and the place to pay. The 402 prose points at `/crawl?format=html`, so a client that sent no Accept header still reaches the explanation |
| A request with a valid pass | the site |

The sales page explains the price, how to pay with an x402 client, and how to pay with the CoinPay CLI:

```
npm install -g @profullstack/coinpay
coinpay x402 pay https://your-site.com/crawl --output pass.json
curl -H "x-crawl-pass: $(node -p "require('./pass.json').pass")" https://your-site.com/
```

## Hono

```js
import { Hono } from 'hono';
import { createGateway } from '@profullstack/x402-gateway';
import { x402Gateway } from '@profullstack/x402-gateway/hono';

const gateway = createGateway({
  siteUrl: 'https://your-site.com',
  coinpay: { apiKey: process.env.COINPAY_X402_KEY },
  payTo: process.env.CRAWL_PAY_TO,
});

const app = new Hono();
app.use('*', x402Gateway(gateway));
app.get('/robots.txt', (c) => c.text(gateway.robotsTxt({ disallow: ['/login', '/api/'] })));
```

## Next.js

`src/proxy.ts` on Next 16, `middleware.ts` before that. One per app; if you already have one, compose.

```ts
import { createGateway } from '@profullstack/x402-gateway';
import { x402Proxy } from '@profullstack/x402-gateway/next';

export const gateway = createGateway({
  siteUrl: 'https://your-site.com',
  coinpay: { apiKey: process.env.COINPAY_X402_KEY },
  payTo: process.env.CRAWL_PAY_TO,
});

export const proxy = x402Proxy(gateway);
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
```

```ts
// app/robots.txt/route.ts
import { robotsRoute } from '@profullstack/x402-gateway/next';
import { gateway } from '../../proxy';
export const GET = robotsRoute(gateway, { disallow: ['/login', '/api/'] });
```

## Anything else

`gateway.handle(request)` takes a Fetch `Request` and resolves to a `Response` to send, or `null` to carry on. Wrap it in ten lines for whatever you run.

## Options

| Option | Default | |
| --- | --- | --- |
| `siteUrl` | required | canonical origin, no trailing slash |
| `coinpay.apiKey` | | a **scoped** CoinPay key (`cp_live_…`, from the business's API Keys tab) with `payments:create`. The legacy business key is refused by CoinPay's x402 routes. |
| `payTo` | | EVM address that receives the USDC, on Base, Polygon and Ethereum alike |
| `nano` | off | `{ payTo: 'nano_…', rate }`: also offer XNO on network `nano`, paid straight to that address. `rate` is the price of 1 XNO in `currency` (a number, or a function read per offer); the amount is in raw (10^30 per XNO), rounded up. `xrb_` payees are rewritten to `nano_`. The buyer sends the block first and presents its hash, so a rate that moves between quote and proof refuses a payment already sent: keep it steady. CoinPay refuses every Nano proof unless its `NANO_RPC_URL` points at a Nano node |
| `priceCents` | `100` | |
| `passMinutes` | `1440` | a day: the term one price buys |
| `maxDays` | `30` | the most terms one proof may buy at once |
| `header` | `x-crawl-pass` | where the pass goes; `Authorization: Bearer` works too |
| `path` | `/crawl` | the sales page |
| `openPaths` | `[]` | extra paths a refused crawler may read (`robots.txt`, the sales page, `security.txt` and `.well-known/` always are) |
| `isPaidAgent` | training + scraper + headless lists | `(userAgent) => boolean` |
| `scrapers` | `SCRAPER_AGENTS` | SEO resellers (AhrefsBot, SemrushBot, MJ12bot, DataForSeoBot, ...): charged and refused in robots.txt |
| `headless` | `HEADLESS_AGENTS` | headless browsers that name themselves (Lightpanda, HeadlessChrome, PhantomJS): charged |
| `aiIndex` | none | extra agents to charge and refuse in robots.txt. Since 0.10 the AI answer-engine indexers (`AI_INDEX_AGENTS`: meta-webindexer, YouBot, ExaSearchBot, AionBot) are welcome retrieval crawlers; pass `aiIndex: AI_INDEX_AGENTS` to charge them anyway |
| `verifiedRetrieval` | `VERIFIED_RETRIEVAL` | retrieval crawlers believed only from their operator's published addresses (OAI-SearchBot, ChatGPT-User, PerplexityBot, Perplexity-User); from elsewhere they are metered. Other retrieval and AI chat fetchers (Claude-User, Claude-SearchBot, Meta-ExternalFetcher, DuckAssistBot, MistralAI-User, the AI indexers) publish no addresses and are believed by name |
| `chargeImpostors` | `true` | a request wearing a `welcome` crawler's name (Googlebot, bingbot, Applebot, DuckDuckBot, Cloudflare-*) from an address outside that operator's published list is charged. Never judged without a readable address |
| `challenge` | off | `{ paths: ['/i/'], cookie?: 'pf_js', work?: 0, when?: (request, url) => boolean }`: every GET to these paths (that `when` accepts, if given) must run a one-line script (sets a per-address, per-day HMAC cookie and reloads) or gets a 402. Welcome crawlers (address-verified search crawlers, retrieval crawlers, AI chat fetchers) skip it; a client that did not ask for HTML gets the JSON offer instead of the script; sessions and passes never see it. For residential swarms that wear a current browser string and never run the page. Set `work` (bits; `true` = 16, max 24) to make the script also solve a SHA-256 proof of work before it sets the cookie (`<token>.<nonce>`): ~250 ms at 16 bits on a desktop, once per address per day, but per page for a swarm that drives real headless Chrome and rotates its address every page. `navigator.webdriver` browsers are not given the cookie. Set `css: true` (path `cssPath`, default `/__pf/c/`) to also require a second cookie that only fetching a per-address stylesheet linked from the page sets: scrapers that block stylesheets to save bandwidth never pass (nichedb, 2026-10-21: 11 of 5,394 swarm addresses ever loaded CSS). |
| `chargeStaleBrowsers` | `true` | charge a desktop Chrome/Edge/Firefox string about two years behind its auto-updates, **only when it does not ask the way a browser does**. Since 0.15.3 a stale string asking for a page (`Accept: text/html`), a page subresource (`Sec-Fetch-Dest: document/image/style/script/font...`) or a Next.js client navigation (`RSC`) reads it like anyone else, with no challenge: age cannot tell a person on a pinned office build from a rotation pool, and refusing a person is the worse mistake. A script wearing a copied string and asking for `*/*` or JSON is still charged. Phones, Firefox ESRs and the last version an old OS can run are never judged |
| `welcome` | `WELCOME_CRAWLERS` | Googlebot, bingbot and Applebot read unmetered when their address is in the operator's published range. A copied string from anywhere else is metered like everyone; `false` turns this off |
| `training`, `retrieval` | the lists in `./agents` | |
| `secret` | the CoinPay key | pass signing secret |
| `page` | built in | `(ctx) => html` |
| `contact` | | mailto: or URL for bulk deals |
| `onSale` | | `({ payer, ref, token, expiresAt, userAgent, priceCents, days, totalCents, currency, property, resourcePath, ipHash, source, ... }) => …`, for accounting. `source` is `'x402'` or `'checkout'` (which adds `email`, `accountId`, `checkoutSessionId`); a checkout sale can be reported by both the return page and the webhook, so dedupe on `ref` |
| `property` | the siteUrl hostname | the site a sale is recorded for, sent to CoinPay with every settle. A function `(request) => string` reads it per request, e.g. from `Host` |
| `ipSalt` | the pass secret | key for the address hash recorded with a sale (the address itself is never sent) |
| `checkout` | on, with `coinpay.apiKey` | the human "Buy a day pass" button: `{ apiKey?, baseUrl?, account?: (request) => userId, expiresInMinutes? }`. `false` hides it. Shown only while CoinPay answers `/api/checkout/sessions` |
| `passCookie` | `crawl_pass` | cookie a pass is also read from (the checkout return page sets it) |

| `denyCidrs` | `[]` | IPv4 ranges answered with a tiny `403` before anything else. For a VPS fleet that spoofs a browser: hosting ranges serve no readers. |
| `chargeSpoofedBrowsers` | `false` | charge a request that claims `Chrome/…` but sends no `Sec-Fetch-Mode`. Every Chromium since 76, headless included, sends it on every request and no script or extension can remove it, so its absence means an HTTP client with a copied string. Firefox and Safari are not judged. |
| `challengeStaleBrowsers` | | no effect since 0.15.3: a stale browser string asking for a page reads it outright (a person with scripts off could not pass the challenge) |
| `exempt` | | `(request) => boolean`, never charged: e.g. a request carrying your signed-in cookie |
| `appPaths` | `APP_PATHS` | extra paths never charged, added to the default sign-in, account, checkout, pay and webhook paths (plus any `/api/` route with an `auth`, `oauth`, `callback`, `login`, `signup`, `webhook(s)` or `health` segment) (`/login`, `/signup`, `/oauth`, `/dashboard`, `/checkout`, `/pay`, `/webhooks`, `/api/auth`, `/api/health`, ...; see `APP_PATHS`). Matched by whole segment. An app whose whole `/api/` is credentialed adds `'/api'`. `false` charges them like any page |
| `powerKeys` | Profullstack's | Power Keys honoured as a pass, kid to public key. `false` switches it off. See below. |
| `revokedKeys` | | Power Key subjects no longer honoured |

Without `coinpay.apiKey` and `payTo` the gateway still answers training crawlers with 402 and the page says payments are off. Nothing is sold, but nothing is given away either.

## One key for every site

A day pass opens one site for a day. A [Power Key](https://profullstack.com/shop) is bought once and opens every Profullstack property for good: no crawler paywall, no allowance, no per-site pass. It is an Ed25519-signed token from [`@profullstack/keys`](https://www.npmjs.com/package/@profullstack/keys), and the gateway verifies it offline with the public key that package ships, so a site honours it with no configuration and no call to anyone.

A client sends it as `Authorization: Bearer pfs_...`, in `x-power-key`, or as `x-api-key`. `passFrom` reads it and `verifyPass` verifies it, so a throttle built on the gateway skips it the same way it skips a day pass. The 402 body carries `powerKey: { shop, header }` and the sales page says where to buy one.

Running the gateway somewhere that is not a Profullstack property? Pass `powerKeys: false`, or your own `{ kid: publicKey }` map to sell keys of your own with `mintKey` from the same package.

## A free allowance that sells instead of refusing

Named crawlers are one problem. The other is an ordinary client hammering the
site far past what a reader would. The usual answer is `429 Too Many Requests`,
which tells them to go away. That is the right answer when you have nothing to
sell. Here you do.

```js
createGateway({
  siteUrl: 'https://your-site.com',
  coinpay: { apiKey: process.env.COINPAY_X402_KEY },
  payTo: process.env.CRAWL_PAY_TO,

  freeQuota: 100,                    // 100 requests a minute, free, no account
  benefits: [
    'No rate limit',
    'Bulk export endpoint',
    'Every field, not just the summary',
  ],
});
```

Past the allowance the gateway answers `402` with the offer, the RateLimit
headers, and a body that says what ran out, when it comes back, and what a pass
costs. The moment a caller runs out of free requests is the best sales pitch the
site will ever get: it has just demonstrated it wants more than the free tier
and is still holding the request.

`freeQuota` takes `{ requests, windowSeconds, paths, identify, store }`. A pass
is checked before the allowance, so a paying caller is never metered. The sales
page, `robots.txt` and `.well-known/` stay reachable when the allowance is gone,
because being unable to reach the page that sells the fix would be the worst
possible failure of a throttle that exists to sell something.

### On rotating addresses to get around it

The default identity is the caller's address, and a proxy rotation defeats it.
That is not a hole to be patched, because the arithmetic already argues for
paying:

- Residential proxy bandwidth is sold **by the gigabyte**, and a crawl big
  enough to be worth rotating for passes a dollar on the first day.
- A rotation still fetches every page one at a time. It buys no speed.
- A pass is a flat price with nothing to maintain and nothing to keep working.

So the throttled page makes that case in as many words rather than pretending to
be undefeatable. Detection is a race you re-run every time someone changes
tactics. Price is not: the better your free tier and the clearer your paid one,
the less anyone bothers. Set `benefits` to the things a rotation genuinely
cannot get, a bulk endpoint above all, and evasion stops being worth the effort
rather than being blocked.

Where you *can* identify a caller properly, do: pass `identify` and key on an API
key or an account, and the allowance becomes exact.

## Crawlers that do not say who they are

The lists catch crawlers that name themselves. Two do not: a VPS fleet wearing a browser string, and a residential-proxy rotation cycling a few Chrome strings across hundreds of addresses. `denyCidrs` handles the first (`['51.38.0.0/16', '54.38.0.0/16', …]` for one provider's ranges); `chargeSpoofedBrowsers` handles both by asking a question only a browser can answer. A request that answers it is left alone. One that cannot gets the same 402 as GPTBot, which costs the site a hash instead of a render.

## How the money moves

The offer is x402 v2 in CoinPay's dialect (and in the spec's `PAYMENT-REQUIRED` header): USDC under the `exact` scheme on Base, Polygon or Ethereum, EIP-3009 `transferWithAuthorization`. The buyer signs, the gateway sends the proof to CoinPay's `/api/x402/verify` and `/api/x402/settle`, and CoinPay's relayer broadcasts the transfer, paying the gas. The USDC goes straight to `payTo`.

A pass is `cp_<payload>.<hmac>`: its own expiry and the payment's nonce, signed with HMAC-SHA256. Verifying one is a hash, not a query. A proof is single-use; retrying with the same proof returns a pass bounded by the proof's own validity window, so a lost response is not a lost dollar and a replayed header is not a free day.

## The x402 v2 headers

Every 402 that carries an offer also carries it in `PAYMENT-REQUIRED`: the spec's `PaymentRequired` object, base64 JSON, with the resource at the top level. A proof is read from `PAYMENT-SIGNATURE` first and `X-PAYMENT` second, in either CoinPay's shape (`scheme` and `network` at the top) or the spec's (`accepted: { scheme, network, ... }`). A sale answers with `PAYMENT-RESPONSE` (`{ success, transaction, network, payer }`) beside the JSON receipt. Nothing old was removed: the body offer, `X-PAYMENT` and the receipt are unchanged.

## Who paid, and where

Every settle call sends CoinPay `metadata: { property, resource_path, payer, user_agent, ip_hash, source }`, which CoinPay keeps on the `x402_payments` row. `resource_path` is the page actually asked for: the gated URL itself, or `?from=` on the sales page (the buy button carries it). `ip_hash` is an HMAC of the address keyed by `ipSalt`, never the address. `onSale` gets the same fields.

## People: Buy a day pass

The sales page shows a **Buy a day pass** form (email, days) whenever CoinPay serves hosted checkout sessions. It posts to `/crawl/checkout`, which creates a session (`POST {coinpay}/api/checkout/sessions` with `amount`, `currency: 'USD'`, `customer_email`, `account_id`, `property`, `metadata`, `success_url`, `cancel_url`) and redirects to CoinPay, where the buyer pays with any coin the business takes or PayPal. The session id rides back in a signed cookie to `/crawl/checkout/return`, which reads the session from CoinPay, and once it is paid mints the same `cp_...` pass the x402 path mints, valid from when it was paid, and shows it with how to send it (header, bearer, or the `crawl_pass` cookie it also sets). Until CoinPay serves the endpoint (a 404 on the probe, rechecked every few minutes) the form is simply not shown.

`account_id` is the buyer's email unless `checkout.account(request)` returns the signed-in user. CoinPay webhooks for checkout sessions can go to `/crawl/checkout/webhook`, or to a site's own route via `gateway.checkoutWebhook(request)` / `gateway.checkoutPaid(body)`: the body is only a hint, the session is re-read from CoinPay before anything is minted.

## Which coins x402 offers

USDC on Base, Polygon and Ethereum, and nothing else on purpose: CoinPay's v2 settle broadcasts EIP-3009 `transferWithAuthorization` only on chains 1, 137 and 8453, and USDC is the only EIP-3009 dollar token there (USDT has none). An offer for anything else would verify and never settle. Every other coin, and PayPal, is the checkout button's job.

The exception, opt-in, is XNO with `nano` set. CoinPay settles network `nano` without a relayer: the buyer publishes a send block to `nano.payTo`, and CoinPay's verify and settle ask a Nano node that the block is a confirmed send of at least the quoted raw amount to that address. The block hash is the replay key and the pass's `ref`. CoinPay needs `NANO_RPC_URL` for this; without it every Nano proof is refused.

## Who is on which list

`TRAINING_AGENTS` is the documented corpus-crawl token of each operator; `RETRIEVAL_AGENTS` the search half of the same pairs: GPTBot / OAI-SearchBot, ClaudeBot / Claude-SearchBot, meta-externalagent / Meta-ExternalFetcher, Applebot-Extended / Applebot. Google-Extended stays welcome because Google documents it as also gating Gemini app grounding. Matching is a substring of the user agent, which identifies a self-declared crawler and nothing more: a crawler wearing a browser's user agent walks past this, and that one needs blocking at the edge.

## Licence

MIT

## Crawler address lists

`src/ranges.js` is generated from each operator's published list (Google's googlebot.json, Bing, DuckDuckGo, OpenAI's searchbot/chatgpt-user, Perplexity, Cloudflare's ips-v4/ips-v6). Refresh it before every release:

```sh
npm run ranges
```

Behind Cloudflare's proxy the caller is read from `CF-Connecting-IP`, but only when the edge hop is itself a Cloudflare address.
