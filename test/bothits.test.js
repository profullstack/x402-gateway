import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HEADLESS_AGENTS, SCRAPER_AGENTS, TRAINING_AGENTS, WELCOME_CRAWLERS } from '../src/agents.js';
import { currentMajor, isStaleBrowser, welcomeCrawler } from '../src/edge.js';
import { createGateway } from '../src/index.js';

const NOW = Date.UTC(2026, 9, 19);
const KEY = 'cp_live_0123456789abcdef0123456789abcdef';
const PAY_TO = '0xCC3b072391AE7A8d10cF00DdC5F61DB2cA5541E5';

// The pool seen on watchnews.now and r4ck.dev on 2026-10-19.
const POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Edg/119.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:120.0) Gecko/20100101 Firefox/120.0',
];
const CURRENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
const GOOGLEBOT =
  'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.8010.52 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

const req = (path, ua, headers = {}) =>
  new Request(`https://example.test${path}`, { headers: { 'user-agent': ua, 'sec-fetch-mode': 'navigate', ...headers } });

const gatewayFor = (extra = {}) =>
  createGateway({ siteUrl: 'https://example.test', coinpay: { apiKey: KEY }, payTo: PAY_TO, suspectAllowance: false, ...extra });

describe('stale browser strings', () => {
  it('knows roughly where Chrome and Firefox are today', () => {
    assert.ok(currentMajor('chrome', NOW) >= 150 && currentMajor('chrome', NOW) <= 160);
    assert.ok(currentMajor('firefox', NOW) >= 150 && currentMajor('firefox', NOW) <= 160);
  });

  it('calls every string in the rotation pool stale', () => {
    for (const ua of POOL) assert.equal(isStaleBrowser(ua, NOW), true, ua);
  });

  it('leaves current browsers, phones, ESRs, terminal versions and declared crawlers alone', () => {
    assert.equal(isStaleBrowser(CURRENT, NOW), false);
    assert.equal(isStaleBrowser(GOOGLEBOT, NOW), false);
    assert.equal(
      isStaleBrowser('Mozilla/5.0 (Linux; Android 6.0.1; SM-J500M) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/95.0.4638.74 Mobile Safari/537.36', NOW),
      false,
    );
    assert.equal(isStaleBrowser('Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36', NOW), false);
    assert.equal(isStaleBrowser('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:115.0) Gecko/20100101 Firefox/115.0', NOW), false);
    assert.equal(
      isStaleBrowser('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Amazonbot/0.1) Chrome/119.0.6045.214 Safari/537.36', NOW),
      false,
    );
  });

  it('never judges a TV, a cast stick or a console, or an ARM Linux box', () => {
    for (const ua of [
      'Mozilla/5.0 (X11; Linux armv7l) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.162 Safari/537.36 CrKey/1.56.500000',
      'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36',
      'Mozilla/5.0 (Linux; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) 76.0.3809.146/6.0 TV Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; Xbox; Xbox One) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0.4844.74 Safari/537.36 Edge/44.18363.8131',
    ]) assert.equal(isStaleBrowser(ua, NOW), false, ua);
    assert.equal(isStaleBrowser('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', NOW), true);
  });

  it('Chrome 109 is only terminal on Windows 7/8', () => {
    assert.equal(isStaleBrowser('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36', NOW), true);
  });
});

describe('who pays, 0.8.0', () => {
  it('charges headless browsers, SEO resellers and Amazonbot by default', async () => {
    const g = gatewayFor();
    for (const ua of [
      'Lightpanda/1.0',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.8010.12 Safari/537.36',
      'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
      'Mozilla/5.0 (compatible; DataForSeoBot/1.0; +https://dataforseo.com/dataforseo-bot)',
      'Mozilla/5.0 (compatible; MJ12bot/v1.4.8; http://mj12bot.com/)',
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot) Chrome/119.0.6045.214 Safari/537.36',
    ]) {
      const res = await g.handle(req('/events/1', ua));
      assert.equal(res?.status, 402, ua);
    }
    assert.ok(TRAINING_AGENTS.includes('Amazonbot'));
    assert.ok(HEADLESS_AGENTS.includes('Lightpanda'));
  });

  it('charges the stale pool and lets a current browser through', async () => {
    const g = gatewayFor();
    for (const ua of POOL) assert.equal((await g.handle(req('/', ua)))?.status, 402, ua);
    assert.equal(await g.handle(req('/', CURRENT)), null);
  });

  it('a signed-in exempt request on an old browser is never charged', async () => {
    const g = gatewayFor({ exempt: (r) => (r.headers.get('cookie') ?? '').includes('session=') });
    assert.equal(await g.handle(req('/', POOL[0], { cookie: 'session=abc' })), null);
  });

  it('stale charging can be switched off', async () => {
    const g = gatewayFor({ chargeStaleBrowsers: false });
    assert.equal(await g.handle(req('/', POOL[0])), null);
  });

  it('robots.txt refuses the SEO resellers but never names the headless ones', () => {
    const txt = gatewayFor().robotsTxt();
    for (const a of SCRAPER_AGENTS) assert.match(txt, new RegExp(`User-agent: ${a}\\nDisallow: /`));
    assert.doesNotMatch(txt, /Lightpanda/);
  });

  it('isPaid mirrors handle', () => {
    const g = gatewayFor();
    assert.equal(g.isPaid(req('/', 'Lightpanda/1.0')), true);
    assert.equal(g.isPaid(req('/', CURRENT)), false);
  });
});

describe('welcome crawlers are never metered', () => {
  const quota = { requests: 2, windowSeconds: 60 };

  it('real Googlebot (name and address agree) outruns the free allowance untouched', async () => {
    const g = gatewayFor({ freeQuota: quota });
    for (let i = 0; i < 10; i++) {
      assert.equal(await g.handle(req('/api/v1/search', GOOGLEBOT, { 'x-real-ip': '66.249.73.129' })), null);
    }
    assert.equal(g.isWelcome(req('/', GOOGLEBOT, { 'x-real-ip': '66.249.73.129' })), true);
  });

  it('a copied Googlebot string from anywhere else is charged as an impostor', async () => {
    const g = gatewayFor({ freeQuota: quota });
    for (let i = 0; i < 3; i++) {
      const res = await g.handle(req('/api/v1/search', GOOGLEBOT, { 'x-real-ip': '203.0.113.9' }));
      assert.equal(res?.status, 402);
    }
    assert.equal(g.isPaid(req('/', GOOGLEBOT, { 'x-real-ip': '203.0.113.9' })), true);
    assert.equal(g.isPaid(req('/', GOOGLEBOT, { 'x-real-ip': '66.249.73.129' })), false);
  });

  it('with chargeImpostors off, a copied Googlebot string is metered like everyone', async () => {
    const g = gatewayFor({ freeQuota: quota, chargeImpostors: false });
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      const res = await g.handle(req('/api/v1/search', GOOGLEBOT, { 'x-real-ip': '203.0.113.9' }));
      statuses.push(res?.status ?? 200);
    }
    assert.deepEqual(statuses, [200, 200, 402, 402]);
  });

  it('never judges an impostor without a readable address', async () => {
    assert.equal(await gatewayFor().handle(req('/', GOOGLEBOT)), null);
  });

  it('verifies Googlebot over IPv6 and behind Cloudflare', async () => {
    const g = gatewayFor({ freeQuota: quota });
    assert.equal(g.isWelcome(req('/', GOOGLEBOT, { 'x-real-ip': '2001:4860:4801:10::1' })), true);
    // Through Cloudflare's proxy the hop is Cloudflare's and the caller is in CF-Connecting-IP.
    const viaCf = { 'x-real-ip': '172.68.1.1', 'cf-connecting-ip': '66.249.73.129' };
    assert.equal(g.isWelcome(req('/', GOOGLEBOT, viaCf)), true);
    // ...but a client cannot choose its address with that header.
    assert.equal(g.isPaid(req('/', GOOGLEBOT, { 'x-real-ip': '203.0.113.9', 'cf-connecting-ip': '66.249.73.129' })), true);
  });

  it('DuckDuckBot and Cloudflare crawlers are welcome from their ranges', () => {
    const g = gatewayFor();
    assert.equal(g.isWelcome(req('/', 'DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)', { 'x-real-ip': '20.191.45.212' })), true);
    assert.equal(g.isWelcome(req('/', 'Mozilla/5.0 (compatible; Cloudflare-AlwaysOnline/1.0)', { 'x-real-ip': '104.16.1.1' })), true);
    assert.equal(g.isPaid(req('/', 'Mozilla/5.0 (compatible; Cloudflare-AlwaysOnline/1.0)', { 'x-real-ip': '203.0.113.9' })), true);
  });

  it('matches bingbot and Applebot by their ranges, and can be switched off', () => {
    const bing = req('/', 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)', { 'x-real-ip': '40.77.167.20' });
    const apple = req('/', 'Mozilla/5.0 (Macintosh) Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)', { 'x-real-ip': '17.241.1.1' });
    assert.equal(welcomeCrawler(bing, WELCOME_CRAWLERS), 'bingbot');
    assert.equal(welcomeCrawler(apple, WELCOME_CRAWLERS), 'Applebot');
    assert.equal(gatewayFor({ welcome: false }).isWelcome(bing), false);
    // An Applebot string from outside Apple's ranges is an impostor.
    const fake = req('/', 'Mozilla/5.0 (Macintosh) Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)', { 'x-real-ip': '203.0.113.9' });
    assert.equal(gatewayFor().isPaid(fake), true);
  });
});

describe('retrieval crawlers and AI chat fetchers are welcome and unmetered', () => {
  const quota = { requests: 1, windowSeconds: 60 };
  const ua = (t) => `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ${t}/1.0; +https://example.com/bot)`;

  it('names without published addresses are believed by name, past the allowance', async () => {
    const g = gatewayFor({ freeQuota: quota });
    for (const t of ['Claude-User', 'Claude-SearchBot', 'meta-externalfetcher', 'meta-webindexer', 'YouBot', 'ExaSearchBot', 'AionBot', 'DuckAssistBot', 'MistralAI-User']) {
      for (let i = 0; i < 3; i++) assert.equal(await g.handle(req('/', ua(t), { 'x-real-ip': '203.0.113.9' })), null, t);
      assert.equal(g.isWelcome(req('/', ua(t), { 'x-real-ip': '203.0.113.9' })), true, t);
    }
  });

  it('OpenAI and Perplexity are believed only from their published addresses', async () => {
    const g = gatewayFor({ freeQuota: quota });
    assert.equal(g.isWelcome(req('/', ua('ChatGPT-User'), { 'x-real-ip': '23.98.142.177' })), true);
    assert.equal(g.isWelcome(req('/', ua('OAI-SearchBot'), { 'x-real-ip': '74.7.175.130' })), true);
    // From elsewhere: metered like anyone, not charged outright.
    const elsewhere = { 'x-real-ip': '203.0.113.9' };
    assert.equal(g.isWelcome(req('/', ua('ChatGPT-User'), elsewhere)), false);
    assert.equal(g.isPaid(req('/', ua('ChatGPT-User'), elsewhere)), false);
    assert.equal(await g.handle(req('/', ua('ChatGPT-User'), elsewhere)), null);
    assert.equal((await g.handle(req('/', ua('ChatGPT-User'), elsewhere)))?.status, 402);
  });

  it('training crawlers are still charged', async () => {
    for (const t of ['GPTBot', 'ClaudeBot', 'CCBot', 'Bytespider', 'Amazonbot', 'meta-externalagent']) {
      assert.equal((await gatewayFor().handle(req('/', ua(t), { 'x-real-ip': '23.98.142.177' })))?.status, 402, t);
    }
  });
});
