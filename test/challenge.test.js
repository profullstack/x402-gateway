import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AI_INDEX_AGENTS } from '../src/agents.js';
import { challengeToken, leadingZeros, solves, stylesheetToken } from '../src/challenge.js';
import { createGateway } from '../src/index.js';

const KEY = 'cp_live_0123456789abcdef0123456789abcdef';
const PAY_TO = '0xCC3b072391AE7A8d10cF00DdC5F61DB2cA5541E5';
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

const gw = (extra = {}) =>
  createGateway({ siteUrl: 'https://example.test', coinpay: { apiKey: KEY }, payTo: PAY_TO, challenge: { paths: ['/i/'] }, botQuota: false, ...extra });
const req = (path, ua = CHROME, headers = {}) =>
  new Request(`https://example.test${path}`, { headers: { 'user-agent': ua, 'sec-fetch-mode': 'navigate', 'x-real-ip': '198.51.100.7', ...headers } });

describe('the script challenge', () => {
  it('asks a browser without the cookie to run a script, with a 402 that names the sales page', async () => {
    const res = await gw().handle(req('/i/63576915', CHROME, { accept: 'text/html,application/xhtml+xml' }));
    assert.equal(res.status, 402);
    const body = await res.text();
    assert.match(body, /document\.cookie="pf_js=[0-9a-f]{32}; Max-Age=172800/);
    assert.match(body, /location\.reload\(\)/);
    assert.match(body, /https:\/\/example\.test\/crawl/);
  });

  it('answers a client that did not ask for HTML with the JSON offer', async () => {
    const res = await gw().handle(req('/i/63576915', CHROME, { accept: '*/*' }));
    assert.equal(res.status, 402);
    const body = await res.json();
    assert.ok(body.accepts.length);
    assert.match(body.error, /browser/);
  });

  it('lets the same browser through once it carries the token for its address', async () => {
    const token = await challengeToken(KEY, '198.51.100.7');
    assert.equal(await gw().handle(req('/i/63576915', CHROME, { cookie: `a=1; pf_js=${token}` })), null);
  });

  it('a token minted for one address does not open another', async () => {
    const token = await challengeToken(KEY, '198.51.100.8');
    assert.equal((await gw().handle(req('/i/1', CHROME, { cookie: `pf_js=${token}` })))?.status, 402);
  });

  it('accepts yesterday’s token, not older', async () => {
    const day = Math.floor(Date.now() / 86_400_000);
    const y = await challengeToken(KEY, '198.51.100.7', day - 1);
    const old = await challengeToken(KEY, '198.51.100.7', day - 2);
    assert.equal(await gw().handle(req('/i/1', CHROME, { cookie: `pf_js=${y}` })), null);
    assert.equal((await gw().handle(req('/i/1', CHROME, { cookie: `pf_js=${old}` })))?.status, 402);
  });

  it('only on the challenged paths, only GET/HEAD, never a verified search crawler or an exempt session', async () => {
    const g = gw({ exempt: (r) => (r.headers.get('cookie') ?? '').includes('session=') });
    assert.equal(await g.handle(req('/about')), null);
    assert.equal(await g.handle(new Request('https://example.test/i/1', { method: 'POST', headers: { 'user-agent': CHROME, 'sec-fetch-mode': 'navigate', 'x-real-ip': '198.51.100.7' } })), null);
    assert.equal(await g.handle(req('/i/1', GOOGLEBOT, { 'x-real-ip': '66.249.73.129' })), null);
    assert.equal(await g.handle(req('/i/1', CHROME, { cookie: 'session=abc' })), null);
  });

  it('challenges a self-declared unknown bot too, but never a named retrieval crawler', async () => {
    assert.equal((await gw().handle(req('/i/1', 'Mozilla/5.0 (compatible; RandomBot/1.0)')))?.status, 402);
    assert.equal(await gw().handle(req('/i/1', 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; OAI-SearchBot/1.3)', { 'x-real-ip': '74.7.175.130' })), null);
    assert.equal(await gw().handle(req('/i/1', 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0)')), null);
  });

  it('is off unless configured', async () => {
    assert.equal(await gw({ challenge: undefined }).handle(req('/i/1')), null);
  });
});

describe('AI answer-engine indexers', () => {
  it('are welcome retrieval crawlers since 0.10, named welcome in robots.txt, and can still be charged by choice', async () => {
    const g = gw({ challenge: undefined });
    for (const a of AI_INDEX_AGENTS) {
      assert.equal(await g.handle(req('/about', `Mozilla/5.0 (compatible; ${a}/1.0)`)), null, a);
      assert.equal(await gw().handle(req('/i/1', `Mozilla/5.0 (compatible; ${a}/1.0)`)), null, a);
    }
    assert.match(g.robotsTxt(), /User-agent: meta-webindexer\nAllow: \//);
    const charging = gw({ challenge: undefined, aiIndex: AI_INDEX_AGENTS });
    assert.equal((await charging.handle(req('/about', 'Mozilla/5.0 (compatible; YouBot/1.0)')))?.status, 402);
  });
});

describe('challenge.when', () => {
  it('challenges only the URLs the predicate accepts, e.g. faceted ones', async () => {
    const g = gw({ challenge: { paths: ['/tlds', '/feeds/'], when: (_r, url) => url.search.length > 1 } });
    const html = { accept: 'text/html' };
    assert.equal(await g.handle(req('/tlds', CHROME, html)), null, 'plain /tlds');
    assert.equal(await g.handle(req('/feeds/new', CHROME, html)), null, 'plain feed');
    assert.equal((await g.handle(req('/tlds?manager=x&sort=tld', CHROME, html)))?.status, 402);
    assert.equal((await g.handle(req('/feeds/new?collection=packages&tags=ai', CHROME, html)))?.status, 402);
    const token = await challengeToken(KEY, '198.51.100.7');
    assert.equal(await g.handle(req('/tlds?manager=x', CHROME, { ...html, cookie: `pf_js=${token}` })), null);
  });
});

describe('challenge.work (proof of work)', () => {
  const pow = (extra = {}) => gw({ challenge: { paths: ['/i/'], work: 8 }, ...extra });
  const html = { accept: 'text/html' };
  async function solve(seed, work) {
    for (let n = 0; ; n++) if (await solves(seed, String(n), work)) return String(n);
  }

  it('the page carries a solver, not a bare cookie', async () => {
    const res = await pow().handle(req('/i/1', CHROME, html));
    assert.equal(res.status, 402);
    const body = await res.text();
    assert.match(body, /crypto\.subtle\.digest\('SHA-256'/);
    assert.match(body, /w=8,/);
    assert.match(body, /navigator\.webdriver/);
  });

  it('the bare token no longer opens the page; token plus a solving nonce does', async () => {
    const token = await challengeToken(KEY, '198.51.100.7');
    assert.equal((await pow().handle(req('/i/1', CHROME, { cookie: `pf_js=${token}` })))?.status, 402);
    let bad = 0;
    while (await solves(token, String(bad), 8)) bad++;
    assert.equal((await pow().handle(req('/i/1', CHROME, { cookie: `pf_js=${token}.${bad}` })))?.status, 402);
    const nonce = await solve(token, 8);
    assert.equal(await pow().handle(req('/i/1', CHROME, { cookie: `pf_js=${token}.${nonce}` })), null);
  });

  it('a solved cookie for one address does not open another', async () => {
    const token = await challengeToken(KEY, '198.51.100.8');
    const nonce = await solve(token, 8);
    assert.equal((await pow().handle(req('/i/1', CHROME, { cookie: `pf_js=${token}.${nonce}` })))?.status, 402);
  });

  it('true means 16 bits, and the answer the page script finds is accepted', async () => {
    const res = await gw({ challenge: { paths: ['/i/'], work: true } }).handle(req('/i/1', CHROME, html));
    assert.match(await res.text(), /w=16,/);
    assert.equal(leadingZeros(new Uint8Array([0, 0x0f]), 12), true);
    assert.equal(leadingZeros(new Uint8Array([0, 0x10]), 12), false);
  });
});

describe('challenge.css (the stylesheet test)', () => {
  const g = () => gw({ challenge: { paths: ['/i/'], work: 4, css: true } });
  const html = { accept: 'text/html' };
  async function solved(ip = '198.51.100.7') {
    const token = await challengeToken(KEY, ip);
    for (let n = 0; ; n++) if (await solves(token, String(n), 4)) return `${token}.${n}`;
  }

  it('links a stylesheet unique to the address and day, and waits for it before reloading', async () => {
    const res = await g().handle(req('/i/1', CHROME, html));
    assert.equal(res.status, 402);
    const body = await res.text();
    const token = await challengeToken(KEY, '198.51.100.7');
    assert.ok(body.includes(`<link id="pfc" rel="stylesheet" href="/__pf/c/${token}" onload="window.__pfc=1" onerror="window.__pfc=2">`));
    assert.match(body, /window\.__pfc!==1/);
  });

  it('a solved puzzle alone no longer opens the page; with the stylesheet cookie it does', async () => {
    const pf = await solved();
    assert.equal((await g().handle(req('/i/1', CHROME, { cookie: `pf_js=${pf}` })))?.status, 402);
    const css = await stylesheetToken(KEY, '198.51.100.7');
    assert.equal(await g().handle(req('/i/1', CHROME, { cookie: `pf_js=${pf}; pf_js_css=${css}` })), null);
    const other = await stylesheetToken(KEY, '198.51.100.8');
    assert.equal((await g().handle(req('/i/1', CHROME, { cookie: `pf_js=${pf}; pf_js_css=${other}` })))?.status, 402);
  });

  it('fetching the stylesheet sets the cookie, only for its own address', async () => {
    const token = await challengeToken(KEY, '198.51.100.7');
    const res = await g().handle(req(`/__pf/c/${token}`, CHROME, { accept: 'text/css' }));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/css/);
    const css = await stylesheetToken(KEY, '198.51.100.7');
    assert.match(res.headers.get('set-cookie') ?? '', new RegExp(`pf_js_css=${css};`));
    const elsewhere = await g().handle(req(`/__pf/c/${token}`, CHROME, { 'x-real-ip': '198.51.100.9' }));
    assert.equal(elsewhere.status, 200);
    assert.equal(elsewhere.headers.get('set-cookie'), null);
    const junk = await g().handle(req('/__pf/c/nope', CHROME));
    assert.equal(junk.headers.get('set-cookie'), null);
  });

  it('is off unless asked for: no stylesheet route, no link', async () => {
    const plain = gw({ challenge: { paths: ['/i/'], work: 4 } });
    assert.equal(await plain.handle(req('/__pf/c/abc')), null);
    assert.doesNotMatch(await (await plain.handle(req('/i/1', CHROME, html))).text(), /rel="stylesheet"/);
  });
});
