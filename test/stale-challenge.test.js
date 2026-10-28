import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { challengeToken, solves } from '../src/challenge.js';
import { createGateway } from '../src/index.js';

const KEY = 'cp_live_0123456789abcdef0123456789abcdef';
const STALE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADLESS = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36';
const IP = '198.51.100.7';

// work: 4 keeps the tests fast; the default for stale browsers is 16 bits.
const gw = (extra = {}) =>
  createGateway({
    siteUrl: 'https://example.test',
    coinpay: { apiKey: KEY, baseUrl: 'https://coinpay.test' },
    payTo: '0xCC3b072391AE7A8d10cF00DdC5F61DB2cA5541E5',
    fetch: async () => new Response('{}'),
    challenge: { paths: ['/only-this/'], work: 4 },
    ...extra,
  });

const req = (path, ua, { accept = 'text/html,*/*', headers = {} } = {}) =>
  new Request(`https://example.test${path}`, { headers: { 'user-agent': ua, accept, 'x-real-ip': IP, ...headers } });

async function solved() {
  const token = await challengeToken(KEY, IP);
  for (let n = 0; ; n++) if (await solves(token, String(n), 4)) return `${token}.${n}`;
}

describe('a stale browser asking for a page', () => {
  it('gets the script challenge, not the sales page', async () => {
    const res = await gw().handle(req('/blog', STALE));
    assert.equal(res.status, 402);
    assert.match(await res.text(), /pf_js/);
  });

  it('reads once it has run the script', async () => {
    assert.equal(await gw().handle(req('/blog', STALE, { headers: { cookie: `pf_js=${await solved()}` } })), null);
  });

  it('is sold a pass when it asked for JSON, since it was never going to run a script', async () => {
    const res = await gw().handle(req('/blog', STALE, { accept: 'application/json' }));
    assert.equal(res.status, 402);
    assert.ok((await res.json()).x402Version);
  });

  it('is charged outright with challengeStaleBrowsers: false', async () => {
    const res = await gw({ challengeStaleBrowsers: false }).handle(req('/blog', STALE, { headers: { cookie: `pf_js=${await solved()}` } }));
    assert.equal(res.status, 402);
  });

  it('does not let a headless browser through by solving it', async () => {
    const res = await gw().handle(req('/blog', HEADLESS, { headers: { cookie: `pf_js=${await solved()}` } }));
    assert.equal(res.status, 402);
  });
});
