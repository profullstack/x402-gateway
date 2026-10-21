/**
 * The sales page: what a refused crawler is shown, and what its operator reads.
 *
 * Plain HTML with no script, because the reader is a program that renders
 * nothing, or a person who was sent the link by one. Every number on it comes
 * from the gateway's options; nothing is typed in twice. The one form on it,
 * the checkout button, is a plain POST and works with scripts off.
 */

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const CSS = `
:root{color-scheme:light dark;--fg:#1a1a1a;--bg:#fff;--mut:#666;--line:#e5e5e5;--code:#f4f4f4;--acc:#0a5}
@media(prefers-color-scheme:dark){:root{--fg:#eee;--bg:#111;--mut:#aaa;--line:#333;--code:#1c1c1c;--acc:#3c9}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:44rem;margin:0 auto;padding:2.5rem 1.25rem 4rem}
h1{font-size:1.8rem;line-height:1.2;margin:0 0 .5rem}h2{font-size:1.15rem;margin:2rem 0 .5rem}
p{margin:.5rem 0}.mut{color:var(--mut)}
pre{background:var(--code);border:1px solid var(--line);border-radius:6px;padding:.9rem 1rem;overflow-x:auto;font-size:.88rem;line-height:1.45}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em}
ol,ul{padding-left:1.3rem}li{margin:.3rem 0}
.price{font-size:2.2rem;font-weight:700;color:var(--acc);margin:.25rem 0}
.buy{border:1px solid var(--line);border-radius:8px;padding:1rem 1.1rem;margin:1.25rem 0}
.buy h2{margin-top:0}.buy form{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin:.6rem 0 .2rem}
.buy input{font:inherit;padding:.5rem .6rem;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);min-width:0}
.buy input[type=email]{flex:1 1 14rem}.buy input[type=number]{width:5rem}
.buy button{font:inherit;font-weight:600;padding:.55rem 1rem;border:0;border-radius:6px;background:var(--acc);color:#fff;cursor:pointer}
.token{word-break:break-all}
table{border-collapse:collapse;margin:.5rem 0;font-size:.95rem}td,th{border-bottom:1px solid var(--line);padding:.35rem .6rem;text-align:left}
footer{margin-top:3rem;color:var(--mut);font-size:.85rem}
`;

/**
 * @param {object} ctx
 * @param {string} ctx.siteName
 * @param {string} ctx.siteUrl
 * @param {string} ctx.buyUrl           the URL to pay at (the sales page itself)
 * @param {string} ctx.price            e.g. "1.00 USD"
 * @param {number} ctx.minutes
 * @param {string} ctx.header           request header the pass goes in
 * @param {boolean} ctx.enabled         whether a payment can be taken right now
 * @param {object} ctx.offer            the x402 body, for the curious
 * @param {string[]} ctx.training       agents charged
 * @param {string[]} ctx.retrieval      agents welcome free
 * @param {string} [ctx.contact]        mailto or URL for bulk deals
 */
export function renderPage(ctx) {
  const {
    siteName,
    siteUrl,
    buyUrl,
    price,
    minutes,
    header,
    enabled,
    offer,
    training = [],
    retrieval = [],
    contact,
    days = 1,
    total = price,
    maxDays = 30,
    quota = null,
    benefits = null,
    powerKey = null,
    checkout = null,
  } = ctx;

  /*
   * Two audiences reach this page and they need different first sentences. A
   * training crawler is here because it is on a list. A heavy reader is here
   * because it ran out of the free allowance, and telling that one it is a
   * training crawler is both wrong and insulting. The price is the same; the
   * argument is not.
   */
  const throttled = Boolean(quota?.exceeded);
  const headline = throttled
    ? 'You have used up the free allowance.'
    : 'Training crawlers pay for access here.';
  const opening = throttled
    ? `<p class="mut">${esc(String(quota.requests))} requests every ${esc(String(quota.windowSeconds))} seconds are free, no key and no account, and that is not changing. ` +
      `You have gone past it${quota.resetSeconds ? `, and it resets in ${esc(String(quota.resetSeconds))} seconds` : ''}. ` +
      `A pass lifts the limit rather than waiting it out.</p>`
    : `<p class="mut">People read <a href="${esc(siteUrl)}">${esc(siteName)}</a> free. So do search engines and the retrieval crawlers behind AI answers, because they send readers back. A crawler that copies pages into a training corpus sends nobody back, so it pays for the time it spends.</p>`;

  /*
   * Said plainly because it is the honest argument and the one that actually
   * lands. Rotating addresses to dodge a free-tier limit is not free: the
   * bandwidth is metered and billed by the gigabyte, and a crawl big enough to
   * be worth rotating for costs more in proxies than the pass does. Anyone
   * weighing the two should be able to see that from here.
   */
  const arithmetic = throttled
    ? `<h2>Before you reach for a proxy pool</h2>
<p class="mut">Spreading the same crawl over rotating addresses works, and it is the expensive way to do this. Residential bandwidth is sold by the gigabyte, you still fetch every page one at a time, and the bill starts on the first day. A pass is ${esc(price)} a day, flat, with no rotation to maintain and nothing to keep working. We would rather sell you access than play that game, which is why the limit answers with a price instead of a refusal.</p>`
    : '';

  const unlocks =
    benefits && benefits.length
      ? `<h2>What a pass gets you</h2>\n<ul>\n${benefits.map((b) => `  <li>${esc(b)}</li>`).join('\n')}\n</ul>`
      : '';
  const powerKeyNote = powerKey
    ? `<h2>Or buy one key for every Profullstack site</h2>
<p>A <a href="${esc(powerKey.shop)}">Power Key</a> is bought once and opens this site and every other Profullstack property, with no day passes and no limits. Send it as <code>Authorization: Bearer pfs_...</code> or in <code>${esc(powerKey.header)}</code> and this page never answers 402 again.</p>`
    : '';
  const window =
    minutes === 1440
      ? 'one day'
      : minutes % 1440 === 0
        ? `${minutes / 1440} days`
        : minutes === 60
          ? 'one hour'
          : minutes % 60 === 0
            ? `${minutes / 60} hours`
            : `${minutes} minutes`;
  const networks = (offer?.accepts ?? []).map((a) => a.network).join(', ');

  /*
   * The button for people. Shown only when CoinPay serves hosted checkout, so
   * a site never offers a payment it cannot take.
   */
  const buyBox = checkout
    ? `<section class="buy">
<h2>Buy a day pass</h2>
<p>Pay ${esc(price)} a day with any coin CoinPay takes or with PayPal. The pass appears on the next page and works with any HTTP client.</p>
<form method="post" action="${esc(checkout.action)}">
<input type="hidden" name="from" value="${esc(checkout.from ?? '')}">
<label class="mut" for="pass-email">Email for the receipt</label>
<input id="pass-email" type="email" name="email" required autocomplete="email" placeholder="you@example.com">
<label class="mut" for="pass-days">Days</label>
<input id="pass-days" type="number" name="days" min="1" max="${esc(String(maxDays))}" value="${esc(String(checkout.days ?? days ?? 1))}">
<button type="submit">Buy a day pass</button>
</form>
<p class="mut">Checkout is hosted by CoinPay. Up to ${esc(String(maxDays))} days at once.</p>
</section>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Crawl access · ${esc(siteName)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<h1>${esc(headline)}</h1>
${opening}

<div class="price">${esc(days > 1 ? total : price)} <span class="mut" style="font-size:1rem;font-weight:400">for ${esc(days > 1 ? `${days} × ${window}` : window)} of requests</span></div>
${
  days > 1
    ? `<p class="mut">This offer is for ${days} days at ${esc(price)} a day. The plain page at <code>${esc(buyUrl)}</code> quotes one.</p>`
    : `<p class="mut">Want longer? Add <code>?days=&lt;n&gt;</code> to this URL for an offer of up to ${maxDays} days at ${esc(price)} a day, or simply pay a whole multiple of the price: the pass lasts as many days as you paid for.</p>`
}
${
  enabled
    ? ''
    : '<p><strong>Payments are not switched on here yet.</strong> The offer below is empty until the operator configures a payout address, so for now this crawler is simply refused.</p>'
}
${enabled ? buyBox : ''}

${unlocks}
${powerKeyNote}
${arithmetic}

<h2>How it works</h2>
<ol>
  <li>Any page you fetch answers <code>402 Payment Required</code> with the x402 offer in a <code>PAYMENT-REQUIRED</code> header (base64 JSON). This page, fetched with <code>Accept: application/json</code>, also returns it as the body: USDC, <code>exact</code> scheme, on ${esc(networks || 'Base, Polygon or Ethereum')}.</li>
  <li>Sign the payment and retry with the proof in a <code>PAYMENT-SIGNATURE</code> (or <code>X-PAYMENT</code>) header. The response is a JSON receipt carrying a pass, with the settlement in <code>PAYMENT-RESPONSE</code>.</li>
  <li>Send the pass in <code>${esc(header)}</code> (or <code>Authorization: Bearer</code>) on every request until it expires: ${esc(window)} per day paid, so a proof for three times the price buys three. When it expires, buy another. The sale is the pass, not the page: fetch the page again with the pass.</li>
</ol>

<h2>Pay with the CoinPay CLI</h2>
<p>Settlement is by CoinPay: the buyer's USDC goes straight to the site's wallet and CoinPay's relayer pays the gas, so you need USDC and nothing else.</p>
<pre><code>npm install -g @profullstack/coinpay
coinpay x402 pay ${esc(buyUrl)} --output pass.json
# or a week at once:
coinpay x402 pay "${esc(buyUrl)}?days=7" --output pass.json</code></pre>
<p>The command fetches this page, reads the offer, opens a browser tab to approve the payment with the CoinPay Wallet extension or any EIP-6963 wallet (MetaMask, Rabby, Coinbase Wallet), and writes the receipt to <code>pass.json</code>. Then:</p>
<pre><code>PASS=$(node -p "require('./pass.json').pass")
curl -H "${esc(header)}: $PASS" ${esc(siteUrl)}/</code></pre>

<h2>Pay from your own x402 client</h2>
<pre><code>curl -sS -H "Accept: application/json" ${esc(buyUrl)}
# 402 with { "x402Version": 2, "accepts": [ ... ] }
# sign an EIP-3009 transferWithAuthorization for one entry, then:
curl -sS -H "X-PAYMENT: &lt;base64 proof&gt;" ${esc(buyUrl)}
# 200 with { "ok": true, "pass": "cp_...", "expires_at": "...", "days": 1, "header": "${esc(header)}" }</code></pre>
<p class="mut">The days a proof buys are read off the value it authorizes: a whole multiple of the one-day amount, up to ${maxDays}. <code>?days=&lt;n&gt;</code> only changes what the offer quotes, so a standard client that pays exactly what is asked gets <em>n</em> days.</p>
<p class="mut">The proof is x402 v2 in CoinPay's dialect: <code>{ x402Version: 2, scheme: "exact", network: "&lt;CAIP-2&gt;", payload: { signature, authorization } }</code>, base64-encoded. A proof is single-use; retrying with the same one returns the same pass, not a second charge.</p>

<h2>Who pays and who does not</h2>
<table>
<tr><th>Charged</th><td>${training.map(esc).join(', ')}</td></tr>
<tr><th>Free, named in robots.txt</th><td>${retrieval.map(esc).join(', ')}</td></tr>
<tr><th>Free</th><td>Everyone else: people, Googlebot, Applebot, Bingbot and any crawler not on the first line.</td></tr>
</table>
<p class="mut">If your crawler is on the first line and you believe it should not be, or you want more than an hour at a time${
    contact ? `, <a href="${esc(contact)}">get in touch</a>` : ', contact the site'
  }.</p>

<h2>The offer, verbatim</h2>
<pre><code>${esc(JSON.stringify(offer, null, 2))}</code></pre>

<footer>Served by @profullstack/x402-gateway. This page is <code>noindex</code> and is the one URL a refused crawler may read.</footer>
</main>
</body>
</html>
`;
}

const shell = (siteName, title, inner) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} · ${esc(siteName)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
${inner}
<footer>Served by @profullstack/x402-gateway.</footer>
</main>
</body>
</html>
`;

/**
 * A short status page for the checkout routes: waiting, closed, refused.
 * `body` is HTML the gateway wrote; nothing in it comes from the request.
 *
 * @param {{siteName: string, siteUrl: string, buyUrl: string, title: string, body: string}} ctx
 */
export function renderNotice({ siteName, title, body }) {
  return shell(siteName, title, `<h1>${esc(title)}</h1>\n<p>${body}</p>`);
}

/**
 * The page a buyer lands on after paying at CoinPay: the pass, and the three
 * ways to send it.
 *
 * @param {object} ctx
 * @param {string} ctx.siteName
 * @param {string} ctx.siteUrl
 * @param {string} ctx.buyUrl
 * @param {string} ctx.token
 * @param {string} ctx.expiresAt   ISO time
 * @param {number} ctx.days
 * @param {string} ctx.header      request header the pass goes in
 * @param {string} ctx.cookie      cookie the pass is also read from
 * @param {string|null} [ctx.email]
 */
export function renderPassPage({ siteName, siteUrl, token, expiresAt, days, header, cookie, email }) {
  const term = days === 1 ? 'one day' : `${days} days`;
  return shell(
    siteName,
    'Your pass',
    `<h1>Paid. Here is your pass.</h1>
<p class="mut">Good for ${esc(term)} on <a href="${esc(siteUrl)}">${esc(siteName)}</a>, until <strong>${esc(expiresAt)}</strong>.${email ? ` The receipt went to ${esc(email)}.` : ''} Copy it now: this page is the only place it is shown, and the pass is all a crawler needs.</p>
<pre class="token"><code>${esc(token)}</code></pre>

<h2>How to use it</h2>
<p>Send it on every request, in whichever of these your client supports:</p>
<pre><code># a header
curl -H "${esc(header)}: ${esc(token)}" ${esc(siteUrl)}/

# a bearer token
curl -H "Authorization: Bearer ${esc(token)}" ${esc(siteUrl)}/

# a cookie (this browser already has it)
curl --cookie "${esc(cookie)}=${esc(token)}" ${esc(siteUrl)}/</code></pre>
<p class="mut">When it runs out, buy another at the same page. Every Profullstack site sells its own pass; a Power Key opens them all.</p>`,
  );
}
