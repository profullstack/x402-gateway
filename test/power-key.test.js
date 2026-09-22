import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateKeypair, mintKey } from '@profullstack/keys';
import { createGateway, PROFULLSTACK_KEYS } from '../src/index.js';

const GPTBOT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.0; +https://openai.com/gptbot)';
const KEY = 'cp_live_0123456789abcdef0123456789abcdef';
const PAY_TO = '0xCC3b072391AE7A8d10cF00DdC5F61DB2cA5541E5';

const pair = await generateKeypair();
const publicKeys = { [pair.kid]: pair.publicKey };
const { key: powerKey } = await mintKey({ privateKey: pair.privateKey, sub: 'pay_lifetime' });
const { key: yearKey } = await mintKey({
  privateKey: pair.privateKey,
  sub: 'pay_year',
  plan: 'year',
  exp: Math.floor(Date.now() / 1000) + 3600,
});

const gateway = (extra = {}) =>
  createGateway({ siteUrl: 'https://site.test', coinpay: { apiKey: KEY }, payTo: PAY_TO, powerKeys: publicKeys, ...extra });

const crawl = (headers = {}) => new Request('https://site.test/some/page', { headers: { 'user-agent': GPTBOT, ...headers } });

describe('a Power Key is a pass', () => {
  it('opens the site for a training crawler, however it is sent', async () => {
    const g = gateway();
    assert.equal((await g.handle(crawl()))?.status, 402);
    assert.equal(await g.handle(crawl({ authorization: `Bearer ${powerKey}` })), null);
    assert.equal(await g.handle(crawl({ 'x-power-key': powerKey })), null);
    assert.equal(await g.handle(crawl({ 'x-api-key': powerKey })), null);
    assert.equal(await g.handle(crawl({ authorization: `Bearer ${yearKey}` })), null);
  });

  it('is never metered against the free allowance', async () => {
    const g = gateway({ freeQuota: 1 });
    const ip = { 'x-real-ip': '203.0.113.9' };
    const person = (h = {}) => new Request('https://site.test/p', { headers: { 'user-agent': 'curl/8', ...ip, ...h } });
    assert.equal(await g.handle(person()), null);
    assert.equal((await g.handle(person()))?.status, 402);
    assert.equal(await g.handle(person({ authorization: `Bearer ${powerKey}` })), null);
    assert.equal(await g.handle(person({ authorization: `Bearer ${powerKey}` })), null);
  });

  it('is what passFrom and verifyPass report, so a throttle skips it too', async () => {
    const g = gateway();
    assert.equal(g.passFrom(crawl({ authorization: `Bearer ${powerKey}` })), powerKey);
    assert.equal(g.passFrom(crawl({ 'x-power-key': powerKey })), powerKey);
    assert.equal(await g.verifyPass(powerKey), true);
    assert.equal(await g.verifyPass('pfs_junk.junk'), false);
    assert.equal(await g.verifyPass(null), false);
  });

  it('refuses a key from a signer it does not know, and a revoked one', async () => {
    const stranger = await generateKeypair();
    const { key: forged } = await mintKey({ privateKey: stranger.privateKey, sub: 'pay_x' });
    assert.equal((await gateway().handle(crawl({ authorization: `Bearer ${forged}` })))?.status, 402);
    const g = gateway({ revokedKeys: ['pay_lifetime'] });
    assert.equal((await g.handle(crawl({ authorization: `Bearer ${powerKey}` })))?.status, 402);
    assert.equal(await g.handle(crawl({ authorization: `Bearer ${yearKey}` })), null);
  });

  it('can be switched off', async () => {
    const g = gateway({ powerKeys: false });
    assert.equal((await g.handle(crawl({ authorization: `Bearer ${powerKey}` })))?.status, 402);
    assert.equal(g.passFrom(crawl({ 'x-power-key': powerKey })), null);
    const body = await (await g.handle(crawl({ accept: 'application/json' }))).json();
    assert.equal(body.powerKey, undefined);
  });

  it('defaults to Profullstack keys and says where to buy one', async () => {
    const g = createGateway({ siteUrl: 'https://site.test', coinpay: { apiKey: KEY }, payTo: PAY_TO });
    assert.deepEqual(g.options.powerKeys, PROFULLSTACK_KEYS);
    const res = await g.handle(crawl({ accept: 'application/json' }));
    const body = await res.json();
    assert.deepEqual(body.powerKey, { shop: 'https://profullstack.com/shop', header: 'x-power-key', bearer: true });
    const page = await (await g.handle(crawl({ accept: 'text/html' }))).text();
    assert.match(page, /profullstack\.com\/shop/);
    assert.match(page, /Power Key/);
    // A stranger's key is still refused: the default list is Profullstack's only.
    assert.equal((await g.handle(crawl({ authorization: `Bearer ${powerKey}` })))?.status, 402);
  });

  it('a day pass still works alongside it', async () => {
    const g = gateway();
    const { mintPass } = await import('../src/pass.js');
    const pass = await mintPass({ secret: KEY, ref: 'r', expiresAt: Math.floor(Date.now() / 1000) + 60 });
    assert.equal(await g.handle(crawl({ 'x-crawl-pass': pass.token })), null);
    assert.equal(await g.handle(crawl({ authorization: `Bearer ${pass.token}` })), null);
  });
});
