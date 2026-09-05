# @profullstack/x402-gateway

Sell crawl access to AI training crawlers, by the day, over [x402](https://x402.org), settled by [CoinPay](https://coinpayportal.com).

People read your site free. So do search engines and the retrieval crawlers behind AI answers, because they send readers back. A crawler that copies pages into a training corpus sends nobody back, so it pays: every page answers `402 Payment Required` with an x402 offer, paying the offer returns a signed pass, and the pass opens the site for a day.

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
| `passMinutes` | `1440` | a day |
| `header` | `x-crawl-pass` | where the pass goes; `Authorization: Bearer` works too |
| `path` | `/crawl` | the sales page |
| `openPaths` | `[]` | extra paths a refused crawler may read (`robots.txt`, the sales page, `security.txt` and `.well-known/` always are) |
| `isPaidAgent` | training list | `(userAgent) => boolean` |
| `training`, `retrieval` | the lists in `./agents` | |
| `secret` | the CoinPay key | pass signing secret |
| `page` | built in | `(ctx) => html` |
| `contact` | | mailto: or URL for bulk deals |
| `onSale` | | `({ payer, ref, token, expiresAt, userAgent, priceCents, currency }) => …`, for accounting |

Without `coinpay.apiKey` and `payTo` the gateway still answers training crawlers with 402 and the page says payments are off. Nothing is sold, but nothing is given away either.

## How the money moves

The offer is x402 v2 in CoinPay's dialect: USDC under the `exact` scheme on Base, Polygon or Ethereum, EIP-3009 `transferWithAuthorization`. The buyer signs, the gateway sends the proof to CoinPay's `/api/x402/verify` and `/api/x402/settle`, and CoinPay's relayer broadcasts the transfer, paying the gas. The USDC goes straight to `payTo`.

A pass is `cp_<payload>.<hmac>`: its own expiry and the payment's nonce, signed with HMAC-SHA256. Verifying one is a hash, not a query. A proof is single-use; retrying with the same proof returns a pass bounded by the proof's own validity window, so a lost response is not a lost dollar and a replayed header is not a free day.

## Who is on which list

`TRAINING_AGENTS` is the documented corpus-crawl token of each operator; `RETRIEVAL_AGENTS` the search half of the same pairs: GPTBot / OAI-SearchBot, ClaudeBot / Claude-SearchBot, meta-externalagent / Meta-ExternalFetcher, Applebot-Extended / Applebot. Google-Extended stays welcome because Google documents it as also gating Gemini app grounding. Matching is a substring of the user agent, which identifies a self-declared crawler and nothing more: a crawler wearing a browser's user agent walks past this, and that one needs blocking at the edge.

## Licence

MIT
