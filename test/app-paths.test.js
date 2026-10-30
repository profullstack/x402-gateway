import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { APP_PATHS, createGateway, isAppPath } from '../src/index.js';

const gatewayWith = (extra = {}) =>
  createGateway({
    siteUrl: 'https://example.test',
    coinpay: { apiKey: 'cp_live_test', baseUrl: 'https://coinpay.test' },
    payTo: '0x1111111111111111111111111111111111111111',
    fetch: async () => new Response('{}'),
    // These suites test the rules; the allowance in front of them has its own (suspect-allowance.test.js).
    suspectAllowance: false,
    botQuota: false,
    ...extra,
  });

// The three kinds of caller the reported lockout came from. Accept */*: a stale
// browser string asking for a page reads it (0.15.3), so these are scripts.
const STALE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADLESS = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36';
const GPTBOT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)';

const req = (path, ua, method = 'GET') =>
  new Request(`https://example.test${path}`, { method, headers: { 'user-agent': ua, accept: '*/*' } });

describe('sign-in, account and payment paths', () => {
  const gateway = gatewayWith();
  const app = [
    '/login',
    '/signup',
    '/oauth/authorize?client_id=x',
    '/api/oauth/authorize',
    '/api/auth/login',
    '/api/health',
    '/dashboard',
    '/dashboard/wallets',
    '/pay/abc123',
    '/checkout/cs_1',
    '/api/webhooks/coinpay',
    '/reset-password',
  ];

  for (const ua of [STALE, HEADLESS, GPTBOT]) {
    it(`are never charged for ${ua.match(/(Chrome|HeadlessChrome|GPTBot)\/[\d.]+/)[0]}`, async () => {
      for (const path of app) {
        const method = path.startsWith('/api/') ? 'POST' : 'GET';
        assert.equal(await gateway.handle(req(path, ua, method)), null, path);
      }
    });
  }

  it('leave content pages charged', async () => {
    for (const ua of [STALE, HEADLESS, GPTBOT]) {
      assert.equal((await gateway.handle(req('/blog/post', ua))).status, 402);
      assert.equal((await gateway.handle(req('/', ua))).status, 402);
    }
  });

  it('match whole segments, so a lookalike page is still charged', async () => {
    assert.equal(isAppPath('/pay'), true);
    assert.equal(isAppPath('/pay/x'), true);
    assert.equal(isAppPath('/payouts-explained'), false);
    assert.equal(isAppPath('/loginx'), false);
    assert.equal((await gateway.handle(req('/payouts-explained', STALE))).status, 402);
  });

  it('let any API route through that signs in or takes a delivery, wherever the segment sits', async () => {
    for (const path of ['/api/coinpay/callback', '/api/callback/oauth', '/api/v1/nixamp/oauth/callback', '/api/sp/oauth/linkedin/callback', '/api/stripe/webhook', '/api/v2/health']) {
      assert.equal(isAppPath(path), true, path);
      assert.equal(await gateway.handle(req(path, STALE)), null, path);
    }
    assert.equal(isAppPath('/api/posts'), false);
    assert.equal(isAppPath('/blog/oauth'), false);
    assert.equal((await gateway.handle(req('/api/authors', STALE))).status, 402);
  });

  it('take a site\'s own paths on top of the defaults', async () => {
    const g = gatewayWith({ appPaths: ['/api', '/i/'] });
    assert.equal(await g.handle(req('/api/payments/create', STALE, 'POST')), null);
    assert.equal(await g.handle(req('/i/inv_1', STALE)), null);
    assert.equal(await g.handle(req('/login', STALE)), null);
    assert.equal((await g.handle(req('/docs', STALE))).status, 402);
  });

  it('can be switched off', async () => {
    const g = gatewayWith({ appPaths: false });
    assert.equal((await g.handle(req('/login', STALE))).status, 402);
  });

  it('is a frozen list', () => {
    assert.ok(Object.isFrozen(APP_PATHS));
    assert.ok(APP_PATHS.includes('/oauth'));
  });
});
