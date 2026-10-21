import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGateway } from '../src/index.js';
import { sessionIdFromWebhook, sessionState } from '../src/checkout.js';
import { decodeHeader, decodePayment, paymentRequiredHeader } from '../src/x402.js';

const GPTBOT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)';
const KEY = 'cp_live_0123456789abcdef0123456789abcdef';
const PAY_TO = '0xCC3b072391AE7A8d10cF00DdC5F61DB2cA5541E5';
const toBase64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');

const authorization = (nonce) => ({
  from: '0xPAYER',
  to: PAY_TO,
  value: '1000000',
  validAfter: '0',
  validBefore: String(Math.floor(Date.now() / 1000) + 600),
  nonce,
});

/** CoinPay's own shape: scheme and network at the top. */
const coinpayProof = (nonce = '0xc1') =>
  toBase64({ x402Version: 2, scheme: 'exact', network: 'eip155:8453', payload: { signature: '0xsig', authorization: authorization(nonce) } });

/** The spec's shape: the chosen requirement nested in `accepted`. */
const specProof = (nonce = '0xs1') =>
  toBase64({
    x402Version: 2,
    resource: { url: 'https://example.test/crawl' },
    accepted: { scheme: 'exact', network: 'eip155:8453', amount: '1000000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: PAY_TO },
    payload: { signature: '0xsig', authorization: authorization(nonce) },
  });

let seq = 0;
/**
 * A CoinPay that settles everything and serves checkout sessions from a
 * table the test controls. Each fake gets its own base URL, because the
 * gateway caches the sessions probe per CoinPay.
 */
function fakeCoinpay({ sessionsStatus = 405, sessions = {} } = {}) {
  const baseUrl = `https://coinpay${++seq}.test`;
  const calls = [];
  const fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers, body });
    const path = new URL(url).pathname;
    const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status });
    if (path === '/api/x402/verify') return reply({ valid: true, payment: { from: '0xPAYER' } });
    if (path === '/api/x402/settle') return reply({ settled: true, txHash: '0xtx', network: 'eip155:8453' });
    if (path === '/api/checkout/sessions') {
      if (sessionsStatus === 404) return reply({ error: 'not found' }, 404);
      if ((init.method ?? 'GET') === 'GET') return reply({ error: 'method' }, sessionsStatus);
      const id = `cs_${Object.keys(sessions).length + 1}abcdef`;
      sessions[id] = { id, status: 'open', amount: body.amount, currency: body.currency, property: body.property, customer_email: body.customer_email, account_id: body.account_id, metadata: body.metadata, created_at: new Date().toISOString() };
      return reply({ id, url: `${baseUrl}/checkout/${id}` }, 201);
    }
    const m = /^\/api\/checkout\/sessions\/(.+)$/.exec(path);
    if (m) return sessions[m[1]] ? reply({ session: sessions[m[1]] }) : reply({ error: 'nope' }, 404);
    return reply({}, 404);
  };
  return { fetch, calls, baseUrl, sessions };
}

const make = (extra = {}, cpOpts) => {
  const cp = fakeCoinpay(cpOpts);
  const gateway = createGateway({
    siteUrl: 'https://example.test',
    coinpay: { apiKey: KEY, baseUrl: cp.baseUrl },
    payTo: PAY_TO,
    fetch: cp.fetch,
    ...extra,
  });
  return { gateway, cp };
};

const req = (path, { headers = {}, ...init } = {}) =>
  new Request(`https://example.test${path}`, { headers: { 'user-agent': GPTBOT, 'x-real-ip': '203.0.113.9', ...headers }, ...init });

describe('x402 v2 transport headers', () => {
  it('sends the offer in PAYMENT-REQUIRED as well as the body', async () => {
    const { gateway } = make();
    const res = await gateway.handle(req('/some/page'));
    assert.equal(res.status, 402);
    const header = decodeHeader(res.headers.get('payment-required'));
    const body = await res.json();
    assert.equal(header.x402Version, 2);
    assert.equal(header.resource.url, 'https://example.test/crawl');
    assert.equal(header.accepts.length, body.accepts.length);
    assert.deepEqual(
      header.accepts.map((a) => [a.network, a.amount, a.payTo, a.asset]),
      body.accepts.map((a) => [a.network, a.amount, a.payTo, a.asset]),
    );
    assert.match(res.headers.get('access-control-expose-headers'), /PAYMENT-REQUIRED/);
  });

  it('puts it on the HTML page and the multi-day offer too', async () => {
    const { gateway } = make();
    const page = await gateway.handle(req('/crawl?days=3', { headers: { accept: 'text/html' } }));
    assert.equal(page.status, 402);
    const header = decodeHeader(page.headers.get('payment-required'));
    assert.equal(header.accepts[0].amount, '3000000');
    assert.equal(header.resource.url, 'https://example.test/crawl?days=3');
  });

  it('sends no PAYMENT-REQUIRED when payments are off', async () => {
    const gateway = createGateway({ siteUrl: 'https://example.test' });
    const res = await gateway.handle(req('/x'));
    assert.equal(res.status, 402);
    assert.equal(res.headers.get('payment-required'), null);
  });

  it('accepts a spec proof from PAYMENT-SIGNATURE and answers PAYMENT-RESPONSE', async () => {
    const { gateway, cp } = make();
    const res = await gateway.handle(req('/crawl', { headers: { 'payment-signature': specProof() } }));
    assert.equal(res.status, 200);
    const settled = decodeHeader(res.headers.get('payment-response'));
    assert.deepEqual(settled, { success: true, transaction: '0xtx', network: 'eip155:8453', payer: '0xPAYER' });
    // CoinPay is handed its own dialect: network lifted out of `accepted`.
    const verify = cp.calls.find((c) => c.url.endsWith('/api/x402/verify'));
    assert.equal(verify.body.payment.network, 'eip155:8453');
    assert.equal(verify.body.payment.scheme, 'exact');
    const body = await res.json();
    assert.ok(await gateway.verifyPass(body.pass));
  });

  it('still takes X-PAYMENT', async () => {
    const { gateway } = make();
    const res = await gateway.handle(req('/crawl', { headers: { 'x-payment': coinpayProof() } }));
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('payment-response'));
  });

  it('a refused proof carries the offer header again', async () => {
    const { gateway } = make();
    const res = await gateway.handle(req('/crawl', { headers: { 'payment-signature': '%%%' } }));
    assert.equal(res.status, 402);
    assert.match(decodeHeader(res.headers.get('payment-required')).error, /not base64 JSON/);
  });

  it('decodePayment leaves CoinPay-shaped proofs alone', () => {
    const p = decodePayment(coinpayProof('0xz'));
    assert.equal(p.network, 'eip155:8453');
    assert.equal(p.accepted, undefined);
  });

  it('paymentRequiredHeader keeps only the spec fields per requirement', () => {
    const h = decodeHeader(
      paymentRequiredHeader({ accepts: [{ scheme: 'exact', network: 'n', amount: '1', asset: 'a', payTo: 'p', resource: 'r', description: 'd', mimeType: 'm', maxTimeoutSeconds: 5, extra: {} }] }),
    );
    assert.deepEqual(Object.keys(h.accepts[0]).sort(), ['amount', 'asset', 'extra', 'maxTimeoutSeconds', 'network', 'payTo', 'scheme']);
    assert.equal(h.resource.url, 'r');
  });
});

describe('who paid and where', () => {
  it('passes property, page, payer, user agent and an address hash to settle and onSale', async () => {
    const sales = [];
    const { gateway, cp } = make({ onSale: (s) => sales.push(s) });
    const res = await gateway.handle(req('/posts/42?page=2&days=1', { headers: { 'x-payment': coinpayProof('0xw1') } }));
    assert.equal(res.status, 200);
    const settle = cp.calls.find((c) => c.url.endsWith('/api/x402/settle'));
    const meta = settle.body.metadata;
    assert.equal(meta.property, 'example.test');
    assert.equal(meta.resource_path, '/posts/42?page=2');
    assert.equal(meta.payer, '0xPAYER');
    assert.equal(meta.user_agent, GPTBOT);
    assert.match(meta.ip_hash, /^[0-9a-f]{32}$/);
    assert.ok(!JSON.stringify(meta).includes('203.0.113.9'));
    assert.equal(meta.source, 'x402');
    assert.equal(sales.length, 1);
    assert.equal(sales[0].property, 'example.test');
    assert.equal(sales[0].resourcePath, '/posts/42?page=2');
    assert.equal(sales[0].ipHash, meta.ip_hash);
    assert.equal(sales[0].source, 'x402');
    assert.equal(sales[0].payer, '0xPAYER');
  });

  it('on the sales page, records the page named in ?from=', async () => {
    const { gateway, cp } = make({ property: 'shop.example' });
    await gateway.handle(req('/crawl?from=/feeds/abc', { headers: { 'x-payment': coinpayProof('0xw2') } }));
    const meta = cp.calls.find((c) => c.url.endsWith('/api/x402/settle')).body.metadata;
    assert.equal(meta.resource_path, '/feeds/abc');
    assert.equal(meta.property, 'shop.example');
  });

  it('takes the property from the request when given a function', async () => {
    const { gateway, cp } = make({ property: (r) => new URL(r.url).hostname.replace(/^www\./, '') });
    await gateway.handle(req('/x', { headers: { 'x-payment': coinpayProof('0xw3') } }));
    assert.equal(cp.calls.find((c) => c.url.endsWith('/api/x402/settle')).body.metadata.property, 'example.test');
  });
});

describe('the human checkout', () => {
  const html = { accept: 'text/html' };

  it('hides the button while CoinPay has no checkout sessions', async () => {
    const { gateway } = make({}, { sessionsStatus: 404 });
    const page = await (await gateway.handle(req('/crawl?format=html', { headers: html }))).text();
    assert.ok(!page.includes('Buy a day pass'));
  });

  it('shows it once CoinPay answers', async () => {
    const { gateway } = make();
    const page = await (await gateway.handle(req('/feeds/x', { headers: html }))).text();
    assert.ok(page.includes('Buy a day pass'));
    assert.ok(page.includes('action="/crawl/checkout"'));
    assert.ok(page.includes('name="from" value="/feeds/x"'));
    assert.ok(page.includes('PayPal'));
  });

  it('hides it when switched off', async () => {
    const { gateway } = make({ checkout: false });
    const page = await (await gateway.handle(req('/crawl?format=html', { headers: html }))).text();
    assert.ok(!page.includes('Buy a day pass'));
  });

  const buy = (gateway, fields, headers = {}) =>
    gateway.handle(
      req('/crawl/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
        body: new URLSearchParams(fields).toString(),
      }),
    );

  const cookieOf = (res) =>
    res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');

  it('creates a session with who and where, and sends the buyer to it', async () => {
    const { gateway, cp } = make({ checkout: { account: () => 'user_7' } });
    const res = await buy(gateway, { email: 'Buyer@Example.com', days: '3', from: '/feeds/x' });
    assert.equal(res.status, 303);
    assert.match(res.headers.get('location'), /\/checkout\/cs_1abcdef$/);
    assert.match(res.headers.get('set-cookie'), /x402_checkout=cs_1abcdef\.[0-9a-f]{32}; Path=\/crawl\/checkout;.*HttpOnly; Secure; SameSite=Lax/);
    const create = cp.calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/checkout/sessions'));
    assert.equal(create.headers.authorization, `Bearer ${KEY}`);
    const b = create.body;
    assert.equal(b.amount, 3);
    assert.equal(b.currency, 'USD');
    assert.equal(b.customer_email, 'buyer@example.com');
    assert.equal(b.account_id, 'user_7');
    assert.equal(b.property, 'example.test');
    assert.equal(b.metadata.resource_path, '/feeds/x');
    assert.equal(b.metadata.days, 3);
    assert.equal(b.metadata.kind, 'crawl_pass');
    assert.match(b.success_url, /^https:\/\/example\.test\/crawl\/checkout\/return/);
    assert.equal(b.cancel_url, 'https://example.test/crawl?format=html');
  });

  it('uses the email as the account when the site has no resolver', async () => {
    const { gateway, cp } = make();
    await buy(gateway, { email: 'a@b.co' });
    assert.equal(cp.calls.find((c) => c.method === 'POST').body.account_id, 'a@b.co');
  });

  it('refuses a missing email', async () => {
    const { gateway } = make();
    assert.equal((await buy(gateway, { email: 'nope' })).status, 400);
  });

  it('says so when CoinPay has no sessions endpoint yet', async () => {
    const { gateway } = make({}, { sessionsStatus: 404 });
    assert.equal((await buy(gateway, { email: 'a@b.co' })).status, 503);
  });

  it('waits while unpaid, then shows a pass the gateway honours', async () => {
    const sales = [];
    const { gateway, cp } = make({ onSale: (s) => sales.push(s) });
    const started = await buy(gateway, { email: 'a@b.co', days: '2', from: '/p' });
    const cookie = cookieOf(started);
    const back = () => gateway.handle(req('/crawl/checkout/return', { headers: { cookie, accept: 'text/html' } }));

    const waiting = await back();
    assert.equal(waiting.status, 202);
    assert.equal(waiting.headers.get('refresh'), '15');

    cp.sessions.cs_1abcdef.status = 'paid';
    cp.sessions.cs_1abcdef.paid_at = new Date().toISOString();
    const done = await back();
    assert.equal(done.status, 200);
    const page = await done.text();
    const token = done.headers.get('x-crawl-pass');
    assert.ok(token.startsWith('cp_'));
    assert.ok(page.includes(token));
    assert.ok(page.includes('Authorization: Bearer'));
    const exp = Date.parse(done.headers.get('x-crawl-pass-expires'));
    assert.ok(Math.abs(exp - (Date.now() + 2 * 86400 * 1000)) < 60_000);
    assert.ok(done.headers.getSetCookie().some((c) => c.startsWith(`crawl_pass=${token};`)));

    // The pass opens the site by header, bearer, or the cookie it set.
    assert.equal(await gateway.handle(req('/p', { headers: { 'x-crawl-pass': token } })), null);
    assert.equal(await gateway.handle(req('/p', { headers: { authorization: `Bearer ${token}` } })), null);
    assert.equal(await gateway.handle(req('/p', { headers: { cookie: `crawl_pass=${token}` } })), null);

    assert.equal(sales.length, 1);
    assert.equal(sales[0].source, 'checkout');
    assert.equal(sales[0].ref, 'checkout:cs_1abcdef');
    assert.equal(sales[0].email, 'a@b.co');
    assert.equal(sales[0].resourcePath, '/p');
    assert.equal(sales[0].days, 2);

    // Reloading re-mints the same pass rather than a longer one.
    const again = await back();
    assert.equal(again.headers.get('x-crawl-pass'), token);
  });

  it('finds the session from ?session_id= when the cookie is gone', async () => {
    const { gateway, cp } = make();
    await buy(gateway, { email: 'a@b.co' });
    cp.sessions.cs_1abcdef.status = 'completed';
    const res = await gateway.handle(req('/crawl/checkout/return?session_id=cs_1abcdef'));
    assert.equal(res.status, 200);
  });

  it('mints nothing for a session sold for another property', async () => {
    const { gateway, cp } = make();
    await buy(gateway, { email: 'a@b.co' });
    Object.assign(cp.sessions.cs_1abcdef, { status: 'paid', property: 'other.test' });
    const res = await gateway.handle(req('/crawl/checkout/return?session_id=cs_1abcdef'));
    assert.notEqual(res.status, 200);
    assert.equal(res.headers.get('x-crawl-pass'), null);
  });

  it('ignores a forged checkout cookie', async () => {
    const { gateway } = make();
    const res = await gateway.handle(req('/crawl/checkout/return', { headers: { cookie: 'x402_checkout=cs_1abcdef.00000000000000000000000000000000' } }));
    assert.equal(res.status, 400);
  });

  it('mints from a webhook only when CoinPay says the session is paid', async () => {
    const sales = [];
    const { gateway, cp } = make({ onSale: (s) => sales.push(s) });
    await buy(gateway, { email: 'a@b.co' });
    const hook = (body) =>
      gateway.handle(req('/crawl/checkout/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    const forged = await (await hook({ id: 'evt_1', type: 'checkout.paid', data: { checkout_session_id: 'cs_1abcdef' } })).json();
    assert.equal(forged.minted, false);
    assert.equal(sales.length, 0);

    cp.sessions.cs_1abcdef.status = 'paid';
    const real = await (await hook({ id: 'evt_2', type: 'checkout.paid', data: { checkout_session_id: 'cs_1abcdef' } })).json();
    assert.equal(real.minted, true);
    assert.equal(sales.length, 1);
    assert.equal(sales[0].checkoutSessionId, 'cs_1abcdef');

    const minted = await gateway.checkoutPaid('cs_1abcdef');
    assert.ok(minted.token.startsWith('cp_'));
  });
});

describe('checkout helpers', () => {
  it('reads the session id off a nested webhook, never the event id', () => {
    assert.equal(sessionIdFromWebhook({ id: 'evt_abcdef', data: { checkout_session_id: 'cs_123456' } }), 'cs_123456');
    assert.equal(sessionIdFromWebhook({ checkout_session_id: 'cs_999999' }), 'cs_999999');
    assert.equal(sessionIdFromWebhook({ id: 'evt_abcdef' }), null);
  });

  it('normalises session status and amount', () => {
    assert.equal(sessionState({ status: 'PAID', amount: 2 }).cents, 200);
    assert.equal(sessionState({ status: 'paid' }).paid, true);
    assert.equal(sessionState({ status: 'expired' }).dead, true);
    assert.equal(sessionState({ status: 'open' }).paid, false);
    assert.equal(sessionState({ paid: true, amount_cents: 300 }).cents, 300);
  });
});
