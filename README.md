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
| Anyone at `/crawl` | the sales page (HTML) or the offer (JSON), and the place to pay |
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
| `priceCents` | `100` | |
| `passMinutes` | `1440` | a day: the term one price buys |
| `maxDays` | `30` | the most terms one proof may buy at once |
| `header` | `x-crawl-pass` | where the pass goes; `Authorization: Bearer` works too |
| `path` | `/crawl` | the sales page |
| `openPaths` | `[]` | extra paths a refused crawler may read (`robots.txt`, the sales page, `security.txt` and `.well-known/` always are) |
| `isPaidAgent` | training list | `(userAgent) => boolean` |
| `training`, `retrieval` | the lists in `./agents` | |
| `secret` | the CoinPay key | pass signing secret |
| `page` | built in | `(ctx) => html` |
| `contact` | | mailto: or URL for bulk deals |
| `onSale` | | `({ payer, ref, token, expiresAt, userAgent, priceCents, currency }) => …`, for accounting |

| `denyCidrs` | `[]` | IPv4 ranges answered with a tiny `403` before anything else. For a VPS fleet that spoofs a browser: hosting ranges serve no readers. |
| `chargeSpoofedBrowsers` | `false` | charge a request that claims `Chrome/…` but sends no `Sec-Fetch-Mode`. Every Chromium since 76, headless included, sends it on every request and no script or extension can remove it, so its absence means an HTTP client with a copied string. Firefox and Safari are not judged. |
| `exempt` | | `(request) => boolean`, never charged: e.g. a request carrying your signed-in cookie |

Without `coinpay.apiKey` and `payTo` the gateway still answers training crawlers with 402 and the page says payments are off. Nothing is sold, but nothing is given away either.

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

The offer is x402 v2 in CoinPay's dialect: USDC under the `exact` scheme on Base, Polygon or Ethereum, EIP-3009 `transferWithAuthorization`. The buyer signs, the gateway sends the proof to CoinPay's `/api/x402/verify` and `/api/x402/settle`, and CoinPay's relayer broadcasts the transfer, paying the gas. The USDC goes straight to `payTo`.

A pass is `cp_<payload>.<hmac>`: its own expiry and the payment's nonce, signed with HMAC-SHA256. Verifying one is a hash, not a query. A proof is single-use; retrying with the same proof returns a pass bounded by the proof's own validity window, so a lost response is not a lost dollar and a replayed header is not a free day.

## Who is on which list

`TRAINING_AGENTS` is the documented corpus-crawl token of each operator; `RETRIEVAL_AGENTS` the search half of the same pairs: GPTBot / OAI-SearchBot, ClaudeBot / Claude-SearchBot, meta-externalagent / Meta-ExternalFetcher, Applebot-Extended / Applebot. Google-Extended stays welcome because Google documents it as also gating Gemini app grounding. Matching is a substring of the user agent, which identifies a self-declared crawler and nothing more: a crawler wearing a browser's user agent walks past this, and that one needs blocking at the edge.

## Licence

MIT
