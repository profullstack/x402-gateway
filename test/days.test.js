/**
 * Buying more than a day at once.
 *
 * Two ways in, one rule: `?days=N` shapes the offer a buyer reads, and the
 * days a proof buys are read off the value it authorizes. So a standard
 * client that pays exactly what the N-day offer asks gets N days, a client
 * that simply signs for three times the price gets three, and a value that is
 * not a whole number of day-prices buys nothing before anyone is charged.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createGateway, daysPaid, paidValueOf } from '../src/index.js';
import { METHODS } from '../src/x402.js';

const META = 'Mozilla/5.0 (compatible; meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler))';
const KEY = 'cp_live_0123456789abcdef0123456789abcdef';
const PAY_TO = '0xCC3b072391AE7A8d10cF00DdC5F61DB2cA5541E5';
const DAY = 24 * 3600 * 1000;

const toBase64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');

const proof = ({ value = '1000000', nonce = '0xabc', validBefore } = {}) =>
  toBase64({
    x402Version: 2,
    scheme: 'exact',
    network: 'eip155:8453',
    payload: {
      signature: '0xsig',
      authorization: {
        from: '0xPAYER',
        to: PAY_TO,
        value,
        validAfter: '0',
        validBefore: String(validBefore ?? Math.floor(Date.now() / 1000) + 600),
        nonce,
      },
    },
  });

function fakeCoinpay(script = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const path = new URL(url).pathname;
    const answer = script[path] ?? (path.endsWith('/verify') ? { valid: true, payment: { from: '0xPAYER' } } : { settled: true, txHash: '0xtx' });
    return new Response(JSON.stringify(answer), { status: answer.status ?? 200 });
  };
  return { fetch, calls };
}

const gatewayFor = (extra = {}, script) => {
  const cp = fakeCoinpay(script);
  const sales = [];
  const gateway = createGateway({
    siteUrl: 'https://example.test',
    coinpay: { apiKey: KEY, baseUrl: 'https://coinpay.test' },
    payTo: PAY_TO,
    fetch: cp.fetch,
    onSale: (s) => sales.push(s),
    ...extra,
  });
  return { gateway, cp, sales };
};

const req = (path, { ua = META, accept = 'application/json', headers = {} } = {}) =>
  new Request(`https://example.test${path}`, { headers: { 'user-agent': ua, accept, ...headers } });

describe('the offer for more than a day', () => {
  it('quotes ?days=N at N times the price, on the sales page and on any gated page', async () => {
    const { gateway } = gatewayFor();
    const week = await (await gateway.handle(req('/crawl?days=7'))).json();
    assert.equal(week.accepts[0].amount, '7000000');
    assert.equal(week.accepts[1].amount, '7000000');
    assert.match(week.accepts[0].description, /10080 minutes .* \(7 × 1440\)/);
    assert.equal(week.pass.days, 7);
    assert.equal(week.pass.total, '7.00 USD');
    assert.equal(week.pass.price, '1.00 USD');
    assert.equal(week.pass.maxDays, 30);
    assert.equal(week.pass.buy, 'https://example.test/crawl?days=7');
    assert.equal(week.pass.buyDays, 'https://example.test/crawl?days=<n>');

    const page = await (await gateway.handle(req('/events/1?days=3'))).json();
    assert.equal(page.accepts[0].amount, '3000000');
    assert.equal(page.pass.days, 3);
  });

  it('a plain request still quotes one day, and says how to get more', async () => {
    const { gateway } = gatewayFor();
    const one = await (await gateway.handle(req('/crawl'))).json();
    assert.equal(one.accepts[0].amount, '1000000');
    assert.equal(one.pass.days, 1);
    assert.equal(one.pass.buy, 'https://example.test/crawl');
    const html = await (await gateway.handle(req('/crawl', { accept: 'text/html' }))).text();
    assert.match(html, /\?days=/);
    assert.match(html, /up to 30 days/);
  });

  it('clamps days to [1, maxDays] and shrugs at nonsense', async () => {
    const { gateway } = gatewayFor({ maxDays: 10 });
    for (const [q, days] of [['?days=0', 1], ['?days=-4', 1], ['?days=abc', 1], ['?days=2.9', 2], ['?days=99', 10], ['?days=10', 10]]) {
      const body = await (await gateway.handle(req(`/crawl${q}`))).json();
      assert.equal(body.pass.days, days, q);
      assert.equal(body.accepts[0].amount, String(days * 1000000), q);
    }
    const html = await (await gateway.handle(req('/crawl?days=5', { accept: 'text/html' }))).text();
    assert.match(html, /5\.00 USD/);
    assert.match(html, /5 × one day/);
  });
});

describe('what a proof buys', () => {
  it('a proof for three days buys a pass that lasts three days', async () => {
    const { gateway, cp, sales } = gatewayFor();
    const res = await gateway.handle(req('/events/1', { headers: { 'x-payment': proof({ value: '3000000', nonce: '0xd3' }) } }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.days, 3);
    assert.equal(body.minutes, 3 * 1440);
    const exp = Date.parse(body.expires_at) - Date.now();
    assert.ok(exp > 2.99 * DAY && exp <= 3 * DAY, String(exp));

    // CoinPay was asked to verify exactly what was signed, against the 3-day offer.
    assert.equal(cp.calls[0].body.expected.amount, '3000000');
    assert.equal(cp.calls[0].body.expected.asset, METHODS[0].asset);
    assert.equal(sales.length, 1);
    assert.equal(sales[0].days, 3);
    assert.equal(sales[0].priceCents, 100);
    assert.equal(sales[0].totalCents, 300);

    // The pass opens the site.
    assert.equal(await gateway.handle(req('/events/2', { headers: { 'x-crawl-pass': body.pass } })), null);
  });

  it('the money decides, not the URL', async () => {
    const { gateway, cp } = gatewayFor();
    // Asked for seven, signed for two: two.
    const res = await gateway.handle(req('/crawl?days=7', { headers: { 'x-payment': proof({ value: '2000000', nonce: '0xd2' }) } }));
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.days, 2);
    assert.equal(cp.calls[0].body.expected.amount, '2000000');
  });

  it('a value that is not a whole number of days buys nothing, before anyone is charged', async () => {
    const { gateway, cp } = gatewayFor();
    for (const value of ['1500000', '999999', '0', '-1000000', 'lots']) {
      const res = await gateway.handle(req('/x', { headers: { 'x-payment': proof({ value }) } }));
      assert.equal(res.status, 402, value);
      const body = await res.json();
      assert.match(body.error, /whole number of days/);
      assert.match(body.error, /1000000 per day/);
    }
    assert.equal(cp.calls.length, 0, 'CoinPay was never asked');
  });

  it('refuses more than maxDays in one proof', async () => {
    const { gateway, cp } = gatewayFor({ maxDays: 5 });
    const res = await gateway.handle(req('/x', { headers: { 'x-payment': proof({ value: '6000000' }) } }));
    assert.equal(res.status, 402);
    assert.match((await res.json()).error, /up to 5 days/);
    assert.equal(cp.calls.length, 0);

    const ok = await gateway.handle(req('/x', { headers: { 'x-payment': proof({ value: '5000000', nonce: '0xd5' }) } }));
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).days, 5);
  });

  it('a replayed multi-day proof is bounded by its own validity plus the days it bought', async () => {
    const validBefore = Math.floor(Date.now() / 1000) - 3600;
    const { gateway } = gatewayFor({}, {
      '/api/x402/verify': { valid: false, error: 'Proof already used', status: 400 },
      '/api/x402/settle': { settled: false, error: 'already settled', status: 409 },
    });
    const res = await gateway.handle(req('/x', { headers: { 'x-payment': proof({ value: '4000000', validBefore }) } }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.replayed, true);
    assert.equal(body.days, 4);
    assert.equal(Math.round(Date.parse(body.expires_at) / 1000), validBefore + 4 * 1440 * 60);
  });

  it('a custom price divides exactly in the smallest unit', async () => {
    // 0.35 USD a day: 350000 units. Three days is 1050000, and 1000000 is not a day.
    const { gateway } = gatewayFor({ priceCents: 35 });
    const three = await gateway.handle(req('/x', { headers: { 'x-payment': proof({ value: '1050000', nonce: '0xc3' }) } }));
    assert.equal((await three.json()).days, 3);
    const off = await gateway.handle(req('/x', { headers: { 'x-payment': proof({ value: '1000000' }) } }));
    assert.equal(off.status, 402);
  });
});

describe('the arithmetic', () => {
  it('daysPaid', () => {
    assert.equal(daysPaid(1000000n, '1000000', 30), 1);
    assert.equal(daysPaid(30000000n, '1000000', 30), 30);
    assert.equal(daysPaid(31000000n, '1000000', 30), 0);
    assert.equal(daysPaid(1500000n, '1000000', 30), 0);
    assert.equal(daysPaid(0n, '1000000', 30), 0);
    assert.equal(daysPaid(null, '1000000', 30), 0);
    assert.equal(daysPaid(1000000n, '0', 30), 0);
    assert.equal(daysPaid(1000000n, 'x', 30), 0);
  });
  it('paidValueOf', () => {
    assert.equal(paidValueOf({ payload: { authorization: { value: '42' } } }), 42n);
    assert.equal(paidValueOf({ payload: { authorization: { value: '0' } } }), null);
    assert.equal(paidValueOf({ payload: { authorization: { value: '-1' } } }), null);
    assert.equal(paidValueOf({ payload: { authorization: { value: 'nope' } } }), null);
    assert.equal(paidValueOf({ payload: {} }), null);
    assert.equal(paidValueOf(null), null);
  });
});
