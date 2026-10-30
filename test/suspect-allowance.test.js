import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGateway, memoryQuotaStore } from '../src/index.js';

/*
 * 0.16.0: a browser string that does not add up (stale, spoofed, headless)
 * reads a few pages before it is charged, and a site's own verified
 * credential is never charged at all. Reported 2026-10-28: an agent reading
 * profullstack.com/plans once got a 402, and an agent seller reading its own
 * ugig listing with Chrome/141 and no Sec-Fetch got a 402 too.
 */

const gw = (extra = {}) =>
  createGateway({
    siteUrl: 'https://example.test',
    coinpay: { apiKey: 'cp_live_test', baseUrl: 'https://coinpay.test' },
    payTo: '0x1111111111111111111111111111111111111111',
    fetch: async () => new Response('{}'),
    chargeSpoofedBrowsers: true,
    botQuota: false,
    ...extra,
  });

const STALE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SPOOFED = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const HEADLESS = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36';
const GPTBOT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)';

const req = (path, ua, { ip = '198.51.100.7', headers = {} } = {}) =>
  new Request(`https://example.test${path}`, { headers: { 'user-agent': ua, accept: '*/*', 'x-real-ip': ip, ...headers } });

describe('a suspect browser string reads a few pages first (0.16.0)', () => {
  for (const [name, ua] of [['stale', STALE], ['spoofed', SPOOFED], ['headless', HEADLESS]]) {
    it(`a ${name} string reads its first pages, then pays`, async () => {
      const gateway = gw({ suspectAllowance: { requests: 3, windowSeconds: 3600 } });
      for (let i = 0; i < 3; i++) assert.equal(await gateway.handle(req(`/p/${i}`, ua)), null);
      const res = await gateway.handle(req('/p/4', ua));
      assert.equal(res.status, 402);
      const body = await res.json();
      assert.equal(body.quota.requests, 3);
      assert.equal(res.headers.get('ratelimit-limit'), '3');
    });
  }

  it('defaults to 20 an hour per address, counted per address', async () => {
    const gateway = gw();
    for (let i = 0; i < 20; i++) assert.equal(await gateway.handle(req('/plans', STALE)), null);
    assert.equal((await gateway.handle(req('/plans', STALE))).status, 402);
    assert.equal(await gateway.handle(req('/plans', STALE, { ip: '198.51.100.8' })), null);
  });

  it('a declared training crawler still pays on the first request', async () => {
    const res = await gw().handle(req('/', GPTBOT));
    assert.equal(res.status, 402);
  });

  it('`suspectAllowance: false` charges on the first request, as before', async () => {
    assert.equal((await gw({ suspectAllowance: false }).handle(req('/', HEADLESS))).status, 402);
  });

  it('with paths, gives the allowance only there (0.16.1)', async () => {
    const gateway = gw({ suspectAllowance: { requests: 5, windowSeconds: 3600, paths: ['/', '/about'] } });
    assert.equal(await gateway.handle(req('/', SPOOFED)), null);
    assert.equal(await gateway.handle(req('/about', SPOOFED)), null);
    assert.equal((await gateway.handle(req('/topics/x', SPOOFED))).status, 402);
  });

  it('takes a shared store', async () => {
    const store = memoryQuotaStore();
    const a = gw({ suspectAllowance: { requests: 1, store } });
    const b = gw({ suspectAllowance: { requests: 1, store } });
    assert.equal(await a.handle(req('/', STALE)), null);
    assert.equal((await b.handle(req('/', STALE))).status, 402);
  });
});

describe('authenticate: a site verifies its own credential (0.16.0)', () => {
  const KEY = 'ugig_live_good';
  const authenticate = async (request) => {
    const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '');
    if (!m || !m[1].startsWith('ugig_')) return null;
    return m[1] === KEY;
  };

  it('a verified key is never charged, even wearing a crawler string past the allowance', async () => {
    const gateway = gw({ authenticate, suspectAllowance: { requests: 1 } });
    for (const ua of [SPOOFED, SPOOFED, GPTBOT]) {
      assert.equal(await gateway.handle(req('/api/gigs/1', ua, { headers: { authorization: `Bearer ${KEY}` } })), null);
    }
  });

  it('a refused key is answered 401, not offered a crawl pass', async () => {
    const res = await gw({ authenticate }).handle(req('/api/gigs/1', SPOOFED, { headers: { authorization: 'Bearer ugig_live_bogus' } }));
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('www-authenticate'), 'Bearer');
    assert.equal((await res.json()).status, 401);
  });

  it('no credential, or one the hook does not own, falls through to the rules', async () => {
    const gateway = gw({ authenticate, suspectAllowance: false });
    assert.equal((await gateway.handle(req('/x', SPOOFED))).status, 402);
    assert.equal((await gateway.handle(req('/x', SPOOFED, { headers: { authorization: 'Bearer whatever' } }))).status, 402);
  });

  it('a hook that throws is no opinion, never a pass', async () => {
    const gateway = gw({ authenticate: () => { throw new Error('db down'); }, suspectAllowance: false });
    assert.equal((await gateway.handle(req('/x', GPTBOT))).status, 402);
  });
});
