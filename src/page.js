/**
 * The sales page: what a refused crawler is shown, and what its operator reads.
 *
 * Plain HTML with no script, because the reader is a program that renders
 * nothing, or a person who was sent the link by one. Every number on it comes
 * from the gateway's options; nothing is typed in twice.
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
  } = ctx;
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
<h1>Training crawlers pay for access here.</h1>
<p class="mut">People read <a href="${esc(siteUrl)}">${esc(siteName)}</a> free. So do search engines and the retrieval crawlers behind AI answers, because they send readers back. A crawler that copies pages into a training corpus sends nobody back, so it pays for the time it spends.</p>

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

<h2>How it works</h2>
<ol>
  <li>Any page you fetch answers <code>402 Payment Required</code>. This page, fetched with <code>Accept: application/json</code>, returns the x402 offer: USDC, <code>exact</code> scheme, on ${esc(networks || 'Base, Polygon or Ethereum')}.</li>
  <li>Sign the payment and retry with the proof in an <code>X-PAYMENT</code> header. The response is a JSON receipt carrying a pass.</li>
  <li>Send the pass in <code>${esc(header)}</code> on every request until it expires — ${esc(window)} per day paid, so a proof for three times the price buys three. When it expires, buy another. The sale is the pass, not the page: fetch the page again with the pass.</li>
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
