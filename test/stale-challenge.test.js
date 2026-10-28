import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { asksLikeABrowser, createGateway } from '../src/index.js';
import { currentMajor, isStaleBrowser } from '../src/edge.js';

const KEY = 'cp_live_0123456789abcdef0123456789abcdef';
const STALE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADLESS = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36';
const IP = '198.51.100.7';

const gw = (extra = {}) =>
  createGateway({
    siteUrl: 'https://example.test',
    coinpay: { apiKey: KEY, baseUrl: 'https://coinpay.test' },
    payTo: '0xCC3b072391AE7A8d10cF00DdC5F61DB2cA5541E5',
    fetch: async () => new Response('{}'),
    ...extra,
  });

const NAV = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const req = (path, ua, { accept = NAV, headers = {} } = {}) =>
  new Request(`https://example.test${path}`, { headers: { 'user-agent': ua, accept, 'x-real-ip': IP, ...headers } });

describe('a stale browser string asking the way a browser does (0.15.3)', () => {
  it('reads a page outright: no challenge, no 402, no script needed', async () => {
    assert.equal(await gw().handle(req('/blog', STALE)), null);
    assert.equal(await gw({ challenge: { paths: ['/only-this/'], work: 4 } }).handle(req('/blog', STALE)), null);
  });

  it('reads the subresources a page loads and Next.js client navigations', async () => {
    assert.equal(await gw().handle(req('/logo.png', STALE, { accept: 'image/avif,*/*', headers: { 'sec-fetch-dest': 'image' } })), null);
    assert.equal(await gw().handle(req('/blog', STALE, { accept: '*/*', headers: { rsc: '1' } })), null);
  });

  it('is still charged when it asks for JSON or */* like a script', async () => {
    const res = await gw().handle(req('/blog', STALE, { accept: 'application/json' }));
    assert.equal(res.status, 402);
    assert.ok((await res.json()).x402Version);
    assert.equal((await gw().handle(req('/blog', STALE, { accept: '*/*' }))).status, 402);
  });

  it('isPaid agrees with handle', () => {
    assert.equal(gw().isPaid(req('/blog', STALE)), false);
    assert.equal(gw().isPaid(req('/blog', STALE, { accept: '*/*' })), true);
  });

  it('a headless browser is charged however it asks', async () => {
    assert.equal((await gw().handle(req('/blog', HEADLESS))).status, 402);
  });
});

describe('the 2026-10-28 report: browsers 402d on profullstack.com', () => {
  const NOW = Date.UTC(2026, 9, 28);
  // The versions that were charged on the day: Chrome 120-132, Firefox 130.
  const REPORTED = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  ];

  it('every one of them reads a page it asks for with full navigation headers or none', async () => {
    for (const ua of REPORTED) {
      assert.equal(await gw().handle(req('/', ua)), null, ua);
      assert.equal(
        await gw().handle(req('/', ua, { headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' } })),
        null,
        ua,
      );
    }
  });

  it('the version estimate no longer runs years ahead (Chrome 154, Firefox 157 that week)', () => {
    assert.ok(currentMajor('chrome', NOW) <= 156, String(currentMajor('chrome', NOW)));
    assert.ok(currentMajor('firefox', NOW) <= 159, String(currentMajor('firefox', NOW)));
    assert.equal(isStaleBrowser(REPORTED[0], NOW), false);
    assert.equal(isStaleBrowser(REPORTED[1], NOW), false);
  });

  it('declared AI crawlers are still charged on a page', async () => {
    for (const ua of [
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
      'CCBot/2.0 (https://commoncrawl.org/faq/)',
    ]) assert.equal((await gw().handle(req('/', ua)))?.status, 402, ua);
  });
});

describe('asksLikeABrowser', () => {
  const r = (headers) => new Request('https://example.test/', { headers });
  it('is true for a page, a subresource or an RSC fetch, false for a script', () => {
    assert.equal(asksLikeABrowser(r({ accept: NAV })), true);
    assert.equal(asksLikeABrowser(r({ accept: '*/*', 'sec-fetch-dest': 'document' })), true);
    assert.equal(asksLikeABrowser(r({ accept: '*/*', 'next-router-state-tree': '[]' })), true);
    assert.equal(asksLikeABrowser(r({ accept: '*/*' })), false);
    assert.equal(asksLikeABrowser(r({ accept: 'application/json', 'sec-fetch-dest': 'empty' })), false);
    assert.equal(asksLikeABrowser(r({})), false);
  });
});
