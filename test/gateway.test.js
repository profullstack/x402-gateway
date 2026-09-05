import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isTrainingAgent, RETRIEVAL_AGENTS, TRAINING_AGENTS } from '../src/agents.js';
import { createGateway, wantsHtml } from '../src/index.js';
import { x402Gateway } from '../src/hono.js';
import { robotsRoute, x402Proxy } from '../src/next.js';
import { mintPass, readPass } from '../src/pass.js';
import { robotsTxt } from '../src/robots.js';
import { buildOffer, decodePayment, expectedFor, METHODS } from '../src/x402.js';

const META = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (compatible; meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler))';
const CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0 Safari/537.36';
const SEARCH = 'Mozilla/5.0 AppleWebKit/537.36 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)';

const KEY = 'cp_live_0123456789abcdef0123456789abcdef';
const PAY_TO = '0xCC3b072391AE7A8d10cF00DdC5F61DB2cA5541E5';

const toBase64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');

/** A proof shaped the way CoinPay's v2 payer shapes it. */
const proof = ({ network = 'eip155:8453', nonce = '0xabc', validBefore } = {}) =>
  toBase64({
    x402Version: 2,
    scheme: 'exact',
    network,
    payload: {
      signature: '0xsig',
      authorization: {
        from: '0xPAYER',
        to: PAY_TO,
        value: '1000000',
        validAfter: '0',
        validBefore: String(validBefore ?? Math.floor(Date.now() / 1000) + 600),
        nonce,
      },
    },
  });

/** A CoinPay that verifies and settles whatever it is sent, and remembers the calls. */
function fakeCoinpay(script = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    const path = new URL(url).pathname;
    const answer = script[path] ?? (path.endsWith('/verify') ? { valid: true, payment: { from: '0xPAYER' } } : { settled: true, txHash: '0xtx' });
    const res = typeof answer === 'function' ? answer(body) : answer;
    return new Response(JSON.stringify(res), { status: res.status ?? 200 });
  };
  return { fetch, calls };
}

const gatewayFor = (extra = {}, script) => {
  const cp = fakeCoinpay(script);
  const gateway = createGateway({
    siteUrl: 'https://example.test',
    coinpay: { apiKey: KEY, baseUrl: 'https://coinpay.test' },
    payTo: PAY_TO,
    fetch: cp.fetch,
    ...extra,
  });
  return { gateway, cp };
};

const req = (path, { ua = META, accept = 'text/html,*/*', headers = {} } = {}) =>
  new Request(`https://example.test${path}`, { headers: { 'user-agent': ua, accept, ...headers } });

describe('who pays', () => {
  it('matches the documented training tokens, case-insensitively, inside a browser-looking UA', () => {
    assert.equal(isTrainingAgent(META), true);
    assert.equal(isTrainingAgent('GPTBot/1.2'), true);
    assert.equal(isTrainingAgent('ccbot/2.0'), true);
  });
  it('does not match people or retrieval crawlers', () => {
    assert.equal(isTrainingAgent(CHROME), false);
    assert.equal(isTrainingAgent(SEARCH), false);
    assert.equal(isTrainingAgent(''), false);
    assert.equal(isTrainingAgent(undefined), false);
  });
  it('keeps the pairs apart: the retrieval half of each pair is never charged', () => {
    for (const a of RETRIEVAL_AGENTS) assert.equal(isTrainingAgent(a), false, a);
    for (const a of TRAINING_AGENTS) assert.equal(isTrainingAgent(a), true, a);
  });
  it('Applebot itself is not charged, only Applebot-Extended', () => {
    assert.equal(isTrainingAgent('Mozilla/5.0 (compatible; Applebot/0.1)'), false);
    assert.equal(isTrainingAgent('Applebot-Extended'), true);
  });
});

describe('robots.txt', () => {
  const txt = robotsTxt({ siteUrl: 'https://example.test/', disallow: ['/login', '/api/'], allow: ['/api/v1'], refused: ['AwarioBot'] });
  const group = (agent) => txt.split('\n\n').find((g) => g.startsWith(`User-agent: ${agent}\n`)) ?? '';

  it('refuses training crawlers everywhere but the sales page', () => {
    for (const a of TRAINING_AGENTS) assert.equal(group(a), `User-agent: ${a}\nDisallow: /\nAllow: /crawl`, a);
  });
  it('names retrieval crawlers with the same rules as the wildcard', () => {
    for (const a of [...RETRIEVAL_AGENTS, '*']) {
      const g = group(a);
      assert.match(g, /Allow: \/\n/);
      assert.match(g, /Allow: \/api\/v1/);
      assert.match(g, /Disallow: \/login/);
      assert.match(g, /Disallow: \/api\//);
    }
  });
  it('refuses the extra agents outright and offers the sitemap', () => {
    assert.equal(group('AwarioBot'), 'User-agent: AwarioBot\nDisallow: /');
    assert.match(txt, /Sitemap: https:\/\/example\.test\/sitemap\.xml/);
  });
  it('can omit the sitemap', () => {
    assert.doesNotMatch(robotsTxt({ siteUrl: 'https://x.test', sitemap: '' }), /Sitemap/);
  });
});

describe('passes', () => {
  it('round-trips and carries its expiry and reference', async () => {
    const now = 1_000_000;
    const { token } = await mintPass({ secret: KEY, ref: '0xabc', expiresAt: now + 60, now });
    assert.match(token, /^cp_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const claims = await readPass(token, { secret: KEY, now });
    assert.deepEqual(claims, { exp: now + 60, iat: now, ref: '0xabc' });
  });
  it('expires, and fails with the wrong secret or a tampered payload', async () => {
    const now = 1_000_000;
    const { token } = await mintPass({ secret: KEY, ref: null, expiresAt: now + 60, now });
    assert.equal(await readPass(token, { secret: KEY, now: now + 61 }), null);
    assert.equal(await readPass(token, { secret: 'other', now }), null);
    const [head, sig] = token.split('.');
    assert.equal(await readPass(`${head}x.${sig}`, { secret: KEY, now }), null);
    assert.equal(await readPass('garbage', { secret: KEY, now }), null);
    assert.equal(await readPass('cp_.', { secret: KEY, now }), null);
  });
  it('refuses to mint a pass that is already expired', async () => {
    await assert.rejects(mintPass({ secret: KEY, ref: null, expiresAt: 10, now: 20 }));
  });
});

describe('the x402 offer', () => {
  it('quotes $1 as 1000000 USDC units on all three chains, Base first, with the token domain', () => {
    const offer = buildOffer({ payTo: PAY_TO, priceCents: 100, resource: 'https://example.test/crawl' });
    assert.equal(offer.x402Version, 2);
    assert.equal(offer.accepts.length, 3);
    assert.equal(offer.accepts[0].network, 'eip155:8453');
    for (const a of offer.accepts) {
      assert.equal(a.amount, '1000000');
      assert.equal(a.scheme, 'exact');
      assert.equal(a.payTo, PAY_TO);
      assert.deepEqual(a.extra, { name: 'USD Coin', version: '2' });
      assert.equal(a.resource, 'https://example.test/crawl');
    }
  });
  it('rounds a fraction of a cent UP so it never quotes under the asking price', () => {
    assert.equal(buildOffer({ payTo: PAY_TO, priceCents: 0.0001, resource: 'r' }).accepts[0].amount, '1');
  });
  it('decodes a base64 proof and picks the expected values from the OFFERED entry', () => {
    const offer = buildOffer({ payTo: PAY_TO, priceCents: 100, resource: 'r' });
    const payment = decodePayment(proof({ network: 'EIP155:137' }));
    const expected = expectedFor(payment, offer);
    assert.deepEqual(expected, { amount: '1000000', resource: 'r', payTo: PAY_TO, asset: METHODS[1].asset });
    assert.equal(expectedFor(decodePayment(proof({ network: 'eip155:999' })), offer), null);
    assert.equal(decodePayment('not base64 json'), null);
    assert.equal(decodePayment(''), null);
  });
});

describe('the gate', () => {
  it('lets people and retrieval crawlers through everywhere', async () => {
    const { gateway } = gatewayFor();
    assert.equal(await gateway.handle(req('/events/1', { ua: CHROME })), null);
    assert.equal(await gateway.handle(req('/events/1', { ua: SEARCH })), null);
    assert.equal(await gateway.handle(req('/login', { ua: '' })), null);
  });
  it('answers a training crawler with 402 HTML when it asks for HTML', async () => {
    const { gateway } = gatewayFor();
    const res = await gateway.handle(req('/events/1'));
    assert.equal(res.status, 402);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.text();
    assert.match(body, /coinpay x402 pay https:\/\/example\.test\/crawl/);
    assert.match(body, /1\.00 USD/);
    assert.match(body, /one day/);
    assert.match(body, /x-crawl-pass/);
  });
  it('answers with the JSON offer when HTML is not wanted', async () => {
    const { gateway } = gatewayFor();
    const res = await gateway.handle(req('/events/1', { accept: 'application/json' }));
    assert.equal(res.status, 402);
    const body = await res.json();
    assert.equal(body.x402Version, 2);
    assert.equal(body.accepts.length, 3);
    assert.equal(body.pass.header, 'x-crawl-pass');
    assert.equal(body.pass.buy, 'https://example.test/crawl');
    assert.match(body.error, /Payment required/);
  });
  it('leaves robots.txt, the sales page and .well-known readable', async () => {
    const { gateway } = gatewayFor({ openPaths: ['/llms.txt'] });
    assert.equal(await gateway.handle(req('/robots.txt')), null);
    assert.equal(await gateway.handle(req('/.well-known/security.txt')), null);
    assert.equal(await gateway.handle(req('/llms.txt')), null);
    assert.equal((await gateway.handle(req('/crawl'))).status, 402);
  });
  it('sells at the sales page to anyone, whatever user agent', async () => {
    const { gateway } = gatewayFor();
    const res = await gateway.handle(req('/crawl', { ua: 'curl/8.0', accept: '*/*' }));
    assert.equal(res.status, 402);
    assert.equal((await res.json()).accepts.length, 3);
    const page = await gateway.handle(req('/crawl', { ua: CHROME }));
    assert.equal(page.status, 402);
    assert.match(page.headers.get('content-type'), /text\/html/);
  });

  it('verifies, settles, mints a pass, and then honours it', async () => {
    const sales = [];
    const { gateway, cp } = gatewayFor({ onSale: (s) => sales.push(s) });
    const res = await gateway.handle(req('/events/1', { headers: { 'x-payment': proof({ nonce: '0xn1' }) } }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.match(body.pass, /^cp_/);
    assert.equal(body.header, 'x-crawl-pass');
    assert.equal(res.headers.get('x-crawl-pass'), body.pass);
    assert.ok(res.headers.get('x-crawl-pass-expires'));

    // Both CoinPay calls, in order, with the scoped key and the offered expectations.
    assert.deepEqual(cp.calls.map((c) => new URL(c.url).pathname), ['/api/x402/verify', '/api/x402/settle']);
    assert.equal(cp.calls[0].headers['x-api-key'], KEY);
    assert.deepEqual(cp.calls[0].body.expected, { amount: '1000000', resource: 'https://example.test/crawl', payTo: PAY_TO, asset: METHODS[0].asset });
    assert.equal(cp.calls[1].body.payment.payload.authorization.nonce, '0xn1');

    // The accounting hook saw it once.
    assert.equal(sales.length, 1);
    assert.equal(sales[0].payer, '0xPAYER');
    assert.equal(sales[0].ref, '0xn1');

    // The pass opens every page, in the header or as a bearer token.
    assert.equal(await gateway.handle(req('/events/1', { headers: { 'x-crawl-pass': body.pass } })), null);
    assert.equal(await gateway.handle(req('/events/2', { headers: { authorization: `Bearer ${body.pass}` } })), null);
    // A pass for a day.
    const exp = Date.parse(body.expires_at) - Date.now();
    assert.ok(exp > 23.9 * 3600 * 1000 && exp <= 24 * 3600 * 1000, String(exp));
  });

  it('refuses an unverifiable proof with a 402 and the reason', async () => {
    const { gateway } = gatewayFor({}, { '/api/x402/verify': { valid: false, error: 'Signature does not recover to `from`', status: 400 } });
    const res = await gateway.handle(req('/events/1', { headers: { 'x-payment': proof() } }));
    assert.equal(res.status, 402);
    assert.match((await res.json()).error, /Signature/);
  });
  it('refuses when settlement fails, so an unsettled proof buys nothing', async () => {
    const { gateway } = gatewayFor({}, { '/api/x402/settle': { settled: false, error: 'relayer out of gas', status: 500 } });
    const res = await gateway.handle(req('/events/1', { headers: { 'x-payment': proof() } }));
    assert.equal(res.status, 402);
    assert.match((await res.json()).error, /relayer/);
  });
  it('refuses garbage proofs and proofs for networks it did not offer', async () => {
    const { gateway, cp } = gatewayFor();
    assert.equal((await gateway.handle(req('/x', { headers: { 'x-payment': '%%%' } }))).status, 402);
    assert.equal((await gateway.handle(req('/x', { headers: { 'x-payment': proof({ network: 'eip155:42' }) } }))).status, 402);
    assert.equal(cp.calls.length, 0, 'never reached CoinPay');
  });

  it('answers a replayed proof with a pass bounded by the proof window, if the money moved', async () => {
    // Signed an hour ago: the window has passed, so the pass ends a day after
    // the WINDOW, not a day after this retry.
    const validBefore = Math.floor(Date.now() / 1000) - 3600;
    const { gateway } = gatewayFor(
      {},
      {
        '/api/x402/verify': { valid: false, error: 'Payment proof already used (replay detected)', status: 400 },
        '/api/x402/settle': { settled: false, error: 'Payment already settled', status: 409 },
      },
    );
    const res = await gateway.handle(req('/x', { headers: { 'x-payment': proof({ validBefore }) } }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.replayed, true);
    // Expires at validBefore + a day, not now + a day: replaying cannot roll the clock.
    assert.equal(Math.round(Date.parse(body.expires_at) / 1000), validBefore + 1440 * 60);
  });
  it('refuses a replayed proof whose window has closed, and one that never settled', async () => {
    const stale = gatewayFor(
      {},
      {
        '/api/x402/verify': { valid: false, error: 'Payment proof already used (replay detected)', status: 400 },
        '/api/x402/settle': { settled: false, error: 'Payment already settled', status: 409 },
      },
    ).gateway;
    const res = await stale.handle(req('/x', { headers: { 'x-payment': proof({ validBefore: Math.floor(Date.now() / 1000) - 2 * 1440 * 60 }) } }));
    assert.equal(res.status, 402);

    const unsettled = gatewayFor(
      {},
      {
        '/api/x402/verify': { valid: false, error: 'Payment proof already used (replay detected)', status: 400 },
        '/api/x402/settle': { settled: false, error: 'Payment not found. Call /api/x402/verify first.', status: 400 },
      },
    ).gateway;
    assert.equal((await unsettled.handle(req('/x', { headers: { 'x-payment': proof() } }))).status, 402);
  });

  it('with no CoinPay key or payTo, refuses with an empty offer and says so on the page', async () => {
    const gateway = createGateway({ siteUrl: 'https://example.test' });
    assert.equal(gateway.enabled, false);
    const res = await gateway.handle(req('/x', { accept: 'application/json' }));
    assert.equal(res.status, 402);
    assert.deepEqual((await res.json()).accepts, []);
    const page = await (await gateway.handle(req('/x'))).text();
    assert.match(page, /not switched on/);
    const paid = await gateway.handle(req('/x', { headers: { 'x-payment': proof() } }));
    assert.equal(paid.status, 402);
  });

  it('honours a custom price, window, header, path and page', async () => {
    const { gateway } = gatewayFor({ priceCents: 250, passMinutes: 60, header: 'X-Pass', path: '/pay', page: (ctx) => `<p>${ctx.price} ${ctx.minutes}</p>` });
    const res = await gateway.handle(req('/pay'));
    assert.equal(await res.text(), '<p>2.50 USD 60</p>');
    const json = await (await gateway.handle(req('/x', { accept: '*/*' }))).json();
    assert.equal(json.accepts[0].amount, '2500000');
    assert.equal(json.pass.header, 'x-pass');
    assert.equal(json.pass.buy, 'https://example.test/pay');
    assert.equal(await gateway.handle(req('/crawl', { ua: CHROME })), null, 'the old path is just a path now');
  });

  it('can be told who pays', async () => {
    const { gateway } = gatewayFor({ isPaidAgent: (ua) => /Lightpanda/.test(ua) });
    assert.equal(await gateway.handle(req('/x', { ua: META })), null);
    assert.equal((await gateway.handle(req('/x', { ua: 'Lightpanda/1.0' }))).status, 402);
  });

  it('generates robots.txt and the page from the same lists', () => {
    const { gateway } = gatewayFor({ path: '/pay', training: ['FooBot'] });
    const txt = gateway.robotsTxt({ disallow: ['/login'] });
    assert.match(txt, /User-agent: FooBot\nDisallow: \/\nAllow: \/pay/);
    assert.doesNotMatch(txt, /GPTBot/);
    assert.match(gateway.page(), /FooBot/);
  });

  it('wantsHtml reads the Accept header', () => {
    assert.equal(wantsHtml('text/html,application/xhtml+xml'), true);
    assert.equal(wantsHtml('application/json'), false);
    assert.equal(wantsHtml(undefined), false);
  });
});

describe('adapters', () => {
  it('Hono: returns the gateway response or calls next', async () => {
    const { gateway } = gatewayFor();
    const mw = x402Gateway(gateway);
    let nexted = 0;
    const c = (r) => ({ req: { raw: r } });
    const res = await mw(c(req('/x')), async () => nexted++);
    assert.equal(res.status, 402);
    assert.equal(nexted, 0);
    assert.equal(await mw(c(req('/x', { ua: CHROME })), async () => nexted++), undefined);
    assert.equal(nexted, 1);
    // Options work too.
    const fromOptions = x402Gateway({ siteUrl: 'https://example.test' });
    assert.equal((await fromOptions(c(req('/x')), async () => {})).status, 402);
  });
  it('Next: returns the response or undefined, and serves robots.txt', async () => {
    const { gateway } = gatewayFor();
    const proxy = x402Proxy(gateway);
    assert.equal((await proxy(req('/x'))).status, 402);
    assert.equal(await proxy(req('/x', { ua: CHROME })), undefined);
    const robots = await robotsRoute(gateway, { disallow: ['/login'] })();
    assert.match(robots.headers.get('content-type'), /text\/plain/);
    assert.match(await robots.text(), /Disallow: \/login/);
  });
});
