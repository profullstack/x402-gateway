import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGateway, massCounter } from '../src/index.js';

/*
 * nichedb.dev 2026-11-14: ~6,000 item pages an hour to ~4,650 addresses, 3,934
 * of them reading exactly one page, every one solving the script + stylesheet
 * challenge. No per-address test reaches that; the site-wide total does.
 */

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/999.0.0.0 Safari/537.36';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
let n = 0;
const nextIp = () => `198.51.${(++n >> 8) & 255}.${n & 255}`;
const req = (path, { ip = nextIp(), ua = CHROME, headers = {} } = {}) =>
  new Request(`https://example.test${path}`, {
    headers: { 'user-agent': ua, accept: 'text/html', 'sec-fetch-mode': 'navigate', 'x-real-ip': ip, ...headers },
  });

const gw = (massScrape, extra = {}) =>
  createGateway({
    siteUrl: 'https://example.test',
    coinpay: { apiKey: 'cp_live_test', baseUrl: 'https://coinpay.test' },
    payTo: '0x1111111111111111111111111111111111111111',
    fetch: async () => new Response('{}'),
    botQuota: false,
    checkout: false,
    massScrape,
    ...extra,
  });

describe('massCounter', () => {
  it('trips past the threshold and holds after the rate falls', () => {
    let t = 1_000_000;
    const c = massCounter({ requests: 5, windowSeconds: 60, holdSeconds: 600 }, () => t);
    for (let i = 0; i < 5; i++) assert.equal(c.hit().on, false);
    const sixth = c.hit();
    assert.equal(sixth.on, true);
    assert.equal(sixth.tripped, true);
    assert.equal(c.hit().tripped, false);
    t += 120_000; // the window has emptied, the hold has not
    assert.equal(c.on(), true);
    t += 600_000;
    assert.equal(c.on(), false);
    assert.equal(c.hit().on, false);
  });
});

describe('massScrape gate', () => {
  it('reads free under the rate, then 402s everyone anonymous on the gated paths', async () => {
    const g = gw({ paths: ['/i/'], requests: 10, perAddress: false });
    for (let i = 0; i < 10; i++) assert.equal(await g.handle(req(`/i/${i}`)), null);
    const res = await g.handle(req('/i/11'));
    assert.equal(res.status, 402);
    assert.ok(res.headers.get('payment-required'));
    const body = await res.text();
    assert.match(body, /being scraped in bulk/);
    assert.doesNotMatch(body, /sign in/i);
    // A fresh address is refused too: the surge is site-wide.
    assert.equal((await g.handle(req('/i/12'))).status, 402);
    assert.equal(g.massScrapeState().on, true);
  });

  it('leaves ungated paths alone during a surge', async () => {
    const g = gw({ paths: ['/i/'], requests: 1, perAddress: false });
    await g.handle(req('/i/1'));
    await g.handle(req('/i/2'));
    assert.equal(await g.handle(req('/')), null);
    assert.equal(await g.handle(req('/about')), null);
  });

  it('answers JSON clients with the x402 offer', async () => {
    const g = gw({ paths: ['/i/'], requests: 1, perAddress: false });
    await g.handle(req('/i/1'));
    const res = await g.handle(req('/i/2', { headers: { accept: 'application/json' } }));
    assert.equal(res.status, 402);
    const body = await res.json();
    assert.match(body.error, /scraped in bulk/);
    assert.ok(body.accepts.length);
  });

  it('a fake session cookie (exempt) pays; a verified credential, sign-in pages and Googlebot still read', async () => {
    const g = gw(
      { paths: ['/i/'], requests: 1, perAddress: false },
      {
        exempt: (r) => /sess=/.test(r.headers.get('cookie') ?? ''),
        authenticate: (r) => (r.headers.get('authorization') === 'Bearer good' ? true : null),
        appPaths: ['/i/login'],
      },
    );
    await g.handle(req('/i/1'));
    await g.handle(req('/i/2'));
    assert.equal((await g.handle(req('/i/3', { headers: { cookie: 'sess=junk' } }))).status, 402);
    assert.equal(await g.handle(req('/i/4', { headers: { authorization: 'Bearer good' } })), null);
    assert.equal(await g.handle(req('/i/login')), null);
    // Googlebot from Google's published range (66.249.64.0/19).
    assert.equal(await g.handle(req('/i/5', { ua: GOOGLEBOT, ip: '66.249.66.1' })), null);
  });

  it('is on by default for page loads, never the homepage or a script fetching JSON', async () => {
    const posts = [];
    const g = gw(undefined, { fetch: async (url, init) => (posts.push({ url, init }), new Response('{}')) });
    for (let i = 0; i < 60; i++) assert.equal(await g.handle(req(`/post/${i}`)), null);
    assert.equal((await g.handle(req('/post/61'))).status, 402);
    assert.equal(await g.handle(req('/')), null);
    assert.equal(await g.handle(req('/api/x', { headers: { accept: 'application/json', 'sec-fetch-dest': 'empty' } })), null);
    await g.flushBotHits();
    assert.equal(JSON.parse(posts[0].init.body).site, 'example.test');
    assert.equal(posts[0].init.headers.authorization, undefined);
  });

  it('massScrape: false switches it off', async () => {
    const g = gw(false);
    for (let i = 0; i < 200; i++) assert.equal(await g.handle(req(`/post/${i}`, { ip: '203.0.113.1' })), null);
    assert.equal(g.massScrapeState(), null);
  });

  it('a single address past perAddress pays even with no surge', async () => {
    const g = gw({ paths: ['/i/'], requests: 10_000, perAddress: { requests: 3, windowSeconds: 3600 } });
    const ip = '203.0.113.9';
    for (let i = 0; i < 3; i++) assert.equal(await g.handle(req(`/i/${i}`, { ip })), null);
    const res = await g.handle(req('/i/9', { ip }));
    assert.equal(res.status, 402);
    assert.match(await res.text(), /more pages than a person/);
    assert.equal(g.massScrapeState().on, false);
  });

  it('reports refusals to CrawlProof as bot:swarm, grouped by prefix', async () => {
    const posts = [];
    const fetch = async (url, init) => {
      posts.push({ url, init });
      return new Response('{"ok":true}');
    };
    const g = gw(
      { paths: ['/i/', '/c/'], requests: 1, perAddress: false, report: { token: 'crp_test', site: 'example.test' } },
      { fetch },
    );
    await g.handle(req('/i/1'));
    for (const p of ['/i/2', '/i/3', '/c/x?y=1']) assert.equal((await g.handle(req(p))).status, 402);
    assert.equal(await g.flushBotHits(), true);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, 'https://crawlproof.com/api/tracker/v1/bot-hits');
    assert.equal(posts[0].init.headers.authorization, 'Bearer crp_test');
    const body = JSON.parse(posts[0].init.body);
    assert.equal(body.site, 'example.test');
    assert.deepEqual(body.hits, [
      { bucket: 'bot:swarm', path: '/i/', count: 2 },
      { bucket: 'bot:swarm', path: '/c/', count: 1 },
    ]);
    assert.equal(g.massScrapeState().reported, 3);
  });
});

describe('botQuota is opt-in (0.18.1)', () => {
  it('a declared training crawler pays from its first request by default', async () => {
    const g = createGateway({
      siteUrl: 'https://example.test',
      coinpay: { apiKey: 'cp_live_test', baseUrl: 'https://coinpay.test' },
      payTo: '0x1111111111111111111111111111111111111111',
      fetch: async () => new Response('{}'),
      checkout: false,
    });
    const res = await g.handle(
      new Request('https://example.test/post/1', { headers: { 'user-agent': 'Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)', 'x-real-ip': '192.0.2.50' } }),
    );
    assert.equal(res.status, 402);
  });
});
