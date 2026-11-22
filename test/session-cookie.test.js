import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGateway } from '../src/index.js';

/*
 * 0.18.3: a session cookie that is merely present is a hint, not a pass.
 * Every fleet site exempted `Cookie: <site>_session=<anything>`, so GPTBot
 * with a made-up cookie read free. `sessionCookie` spares only a suspect
 * browser string; `exempt` is awaited so a site can verify a real session.
 */

const gw = (extra = {}) =>
  createGateway({
    siteUrl: 'https://example.test',
    coinpay: { apiKey: 'cp_live_test', baseUrl: 'https://coinpay.test' },
    payTo: '0x1111111111111111111111111111111111111111',
    fetch: async () => new Response('{}'),
    chargeSpoofedBrowsers: true,
    suspectAllowance: false,
    botQuota: false,
    massScrape: false,
    ...extra,
  });

const SPOOFED = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const GPTBOT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)';

const req = (ua, cookie) =>
  new Request('https://example.test/p/1', {
    headers: { 'user-agent': ua, accept: '*/*', 'x-real-ip': '198.51.100.7', ...(cookie ? { cookie } : {}) },
  });

describe('sessionCookie is a hint, never a pass (0.18.3)', () => {
  it('a declared crawler with a forged session cookie is still charged', async () => {
    const gateway = gw({ sessionCookie: 'site_session' });
    const res = await gateway.handle(req(GPTBOT, 'site_session=forged'));
    assert.equal(res?.status, 402);
  });

  it('a suspect browser string with the session cookie is not charged for the string', async () => {
    const gateway = gw({ sessionCookie: 'site_session' });
    assert.equal((await gateway.handle(req(SPOOFED)))?.status, 402);
    assert.equal(await gateway.handle(req(SPOOFED, 'a=1; site_session=abc')), null);
  });

  it('matches by whole cookie name, and takes a RegExp or a list', async () => {
    assert.equal((await gw({ sessionCookie: 'site_session' }).handle(req(SPOOFED, 'xsite_session=1')))?.status, 402);
    assert.equal(await gw({ sessionCookie: /^sb-.*-auth-token$/ }).handle(req(SPOOFED, 'sb-abc-auth-token=1')), null);
    assert.equal(await gw({ sessionCookie: ['a_session', 'b_session'] }).handle(req(SPOOFED, 'b_session=1')), null);
  });

  it('does not stop a challenge or the OVH-style deny list', async () => {
    const gateway = gw({ sessionCookie: 'site_session', denyCidrs: ['198.51.100.0/24'] });
    assert.equal((await gateway.handle(req(SPOOFED, 'site_session=forged')))?.status, 403);
  });
});

describe('exempt is awaited (0.18.3)', () => {
  it('an async verifier that says no does not exempt a forged cookie', async () => {
    const gateway = gw({ exempt: async (r) => (r.headers.get('cookie') ?? '') === 'site_session=real' });
    assert.equal((await gateway.handle(req(GPTBOT, 'site_session=forged')))?.status, 402);
    assert.equal(await gateway.handle(req(GPTBOT, 'site_session=real')), null);
  });

  it('a pending Promise is not truthy by accident', async () => {
    const gateway = gw({ exempt: async () => false });
    assert.equal((await gateway.handle(req(GPTBOT)))?.status, 402);
  });
});
