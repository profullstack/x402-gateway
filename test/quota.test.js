import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGateway, mintPass } from '../src/index.js';
import { memoryQuotaStore, normaliseQuota, spend } from '../src/quota.js';

const SITE = 'https://example.com';
const SECRET = 'cp_live_test_secret_0123456789';
const PAY_TO = '0xCC3b072391AE7A8d10cF00DdC5F61DB2cA5541E5';
const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const reader = (ip, extra = {}) =>
  new Request(`${SITE}/topics/anything`, {
    headers: { 'user-agent': CHROME, 'sec-fetch-mode': 'navigate', 'x-real-ip': ip, ...extra },
  });

const gateway = (freeQuota, extra = {}) =>
  createGateway({
    siteUrl: SITE,
    coinpay: { apiKey: SECRET },
    payTo: PAY_TO,
    freeQuota,
    ...extra,
  });

describe('normaliseQuota', () => {
  it('reads a bare number as requests per minute', () => {
    const quota = normaliseQuota(100);
    assert.equal(quota.requests, 100);
    assert.equal(quota.windowSeconds, 60);
  });

  it('is off for anything that is not a usable allowance', () => {
    for (const input of [undefined, null, 0, -5, {}, { requests: 'lots' }]) {
      assert.equal(normaliseQuota(input), null, JSON.stringify(input));
    }
  });
});

describe('memoryQuotaStore', () => {
  it('counts within a window and rolls over after it', () => {
    let clock = 0;
    const store = memoryQuotaStore({ now: () => clock });
    assert.equal(store.hit('a', 60).count, 1);
    assert.equal(store.hit('a', 60).count, 2);
    clock += 60_000;
    assert.equal(store.hit('a', 60).count, 1, 'a new window starts at one');
  });

  it('counts each key separately', () => {
    const store = memoryQuotaStore();
    store.hit('a', 60);
    assert.equal(store.hit('b', 60).count, 1);
  });

  it('reports a reset that shrinks as the window runs down', () => {
    let clock = 0;
    const store = memoryQuotaStore({ now: () => clock });
    assert.equal(store.hit('a', 60).resetSeconds, 60);
    clock += 30_000;
    assert.equal(store.hit('a', 60).resetSeconds, 30);
  });

  it('forgets expired keys rather than growing without bound', () => {
    let clock = 0;
    const store = memoryQuotaStore({ now: () => clock });
    for (let i = 0; i < 50; i += 1) store.hit(`key-${i}`, 60);
    assert.equal(store.size, 50);
    clock += 61_000;
    store.sweep();
    assert.equal(store.size, 0);
  });
});

describe('spend', () => {
  it('treats an unidentifiable caller as within the allowance', async () => {
    // Refusing here would charge someone for our own edge not giving us an
    // address, which is our gap and not their abuse.
    assert.equal(await spend(normaliseQuota(1), ''), null);
    assert.equal(await spend(normaliseQuota(1), null), null);
  });

  it('goes over only once the allowance is actually exceeded', async () => {
    const quota = normaliseQuota({ requests: 2, windowSeconds: 60 });
    assert.equal((await spend(quota, 'ip')).overLimit, false);
    assert.equal((await spend(quota, 'ip')).overLimit, false, 'the last free one is still free');
    assert.equal((await spend(quota, 'ip')).overLimit, true);
  });

  it('reports what is left, never going below zero', async () => {
    const quota = normaliseQuota({ requests: 1, windowSeconds: 60 });
    assert.equal((await spend(quota, 'ip')).remaining, 0);
    assert.equal((await spend(quota, 'ip')).remaining, 0);
  });
});

describe('the gate with a free allowance', () => {
  it('lets an ordinary reader through until the allowance runs out', async () => {
    const gw = gateway({ requests: 3, windowSeconds: 60 });
    for (let i = 0; i < 3; i += 1) {
      assert.equal(await gw.handle(reader('1.2.3.4')), null, `request ${i + 1} should pass`);
    }
    const refused = await gw.handle(reader('1.2.3.4'));
    assert.equal(refused.status, 402, 'the fourth is answered with a price');
  });

  it('answers 402 and not 429, because there is something to sell', async () => {
    const gw = gateway(1);
    await gw.handle(reader('1.2.3.4'));
    const answer = await gw.handle(reader('1.2.3.4'));
    assert.equal(answer.status, 402);
    const body = await answer.json();
    assert.equal(body.x402Version, 2);
    assert.ok(body.accepts.length > 0, 'the offer is right there in the refusal');
  });

  it('says what ran out, when it returns, and what it costs', async () => {
    const gw = gateway({ requests: 1, windowSeconds: 60 });
    await gw.handle(reader('1.2.3.4'));
    const body = await (await gw.handle(reader('1.2.3.4'))).json();
    assert.equal(body.quota.requests, 1);
    assert.equal(body.quota.windowSeconds, 60);
    assert.equal(body.quota.used, 2);
    assert.match(body.error, /Free allowance used/);
    assert.match(body.error, /1\.00 USD a day/);
  });

  it('sends the RateLimit headers on the refusal', async () => {
    const gw = gateway(1);
    await gw.handle(reader('1.2.3.4'));
    const answer = await gw.handle(reader('1.2.3.4'));
    assert.equal(answer.headers.get('ratelimit-limit'), '1');
    assert.equal(answer.headers.get('ratelimit-remaining'), '0');
    assert.ok(Number(answer.headers.get('ratelimit-reset')) > 0);
  });

  it('counts each address separately, which is the part a rotation exploits', async () => {
    // Stated as a test because it is the known limit of the mechanism, not a
    // bug: the answer to rotation is the price, not a cleverer counter.
    const gw = gateway(1);
    await gw.handle(reader('1.1.1.1'));
    assert.equal(await gw.handle(reader('2.2.2.2')), null);
  });

  it('lists what a pass unlocks when the site says so', async () => {
    const gw = gateway(1, { benefits: ['No rate limit', 'Bulk export endpoint'] });
    await gw.handle(reader('1.2.3.4'));
    const body = await (await gw.handle(reader('1.2.3.4'))).json();
    assert.deepEqual(body.unlocks, ['No rate limit', 'Bulk export endpoint']);
  });
});

describe('a pass lifts the allowance', () => {
  it('never throttles a request holding a valid pass', async () => {
    const gw = gateway(1);
    const now = Math.floor(Date.now() / 1000);
    const { token } = await mintPass({ secret: SECRET, ref: null, expiresAt: now + 3600, now });

    // Far past the free allowance, and every one of them is let through.
    for (let i = 0; i < 25; i += 1) {
      const answer = await gw.handle(reader('1.2.3.4', { 'x-crawl-pass': token }));
      assert.equal(answer, null, `paid request ${i + 1} should pass`);
    }
  });

  it('still throttles once the pass is not presented', async () => {
    const gw = gateway(1);
    const now = Math.floor(Date.now() / 1000);
    const { token } = await mintPass({ secret: SECRET, ref: null, expiresAt: now + 3600, now });
    await gw.handle(reader('9.9.9.9', { 'x-crawl-pass': token }));
    await gw.handle(reader('9.9.9.9'));
    assert.equal((await gw.handle(reader('9.9.9.9'))).status, 402);
  });
});

describe('what the allowance does not touch', () => {
  it('leaves the sales page reachable when the allowance is spent', async () => {
    // Being unable to reach the page that sells the fix would be the worst
    // possible failure of a throttle that exists to sell something.
    const gw = gateway(1);
    await gw.handle(reader('1.2.3.4'));
    await gw.handle(reader('1.2.3.4'));
    const page = await gw.handle(
      new Request(`${SITE}/crawl`, { headers: { 'x-real-ip': '1.2.3.4', accept: 'text/html' } }),
    );
    assert.equal(page.status, 402);
    assert.match(await page.text(), /Crawl access/);
  });

  it('leaves robots.txt readable', async () => {
    const gw = gateway(1);
    await gw.handle(reader('1.2.3.4'));
    await gw.handle(reader('1.2.3.4'));
    const answer = await gw.handle(
      new Request(`${SITE}/robots.txt`, { headers: { 'x-real-ip': '1.2.3.4' } }),
    );
    assert.equal(answer, null);
  });

  it('meters only the paths a site names', async () => {
    const gw = gateway({ requests: 1, paths: ['/api/'] });
    await gw.handle(new Request(`${SITE}/api/x`, { headers: { 'x-real-ip': '5.5.5.5' } }));
    const metered = await gw.handle(
      new Request(`${SITE}/api/y`, { headers: { 'x-real-ip': '5.5.5.5' } }),
    );
    assert.equal(metered.status, 402);
    const unmetered = await gw.handle(
      new Request(`${SITE}/about`, { headers: { 'x-real-ip': '5.5.5.5' } }),
    );
    assert.equal(unmetered, null);
  });

  it('is off entirely when no allowance is configured', async () => {
    const gw = gateway(undefined);
    for (let i = 0; i < 50; i += 1) {
      assert.equal(await gw.handle(reader('1.2.3.4')), null);
    }
  });

  it('still charges a training crawler on its first request', async () => {
    // The allowance is for readers. A named training crawler is charged by the
    // list, and a generous free tier must not become a loophole for it.
    const gw = gateway(1000);
    const answer = await gw.handle(
      new Request(`${SITE}/`, { headers: { 'user-agent': 'GPTBot/1.2', 'x-real-ip': '1.2.3.4' } }),
    );
    assert.equal(answer.status, 402);
  });
});

describe('the page a throttled reader sees', () => {
  it('does not call a heavy reader a training crawler', async () => {
    const gw = gateway(1);
    const html = () =>
      gw.handle(
        new Request(`${SITE}/topics/x`, {
          headers: {
            'user-agent': CHROME,
            'sec-fetch-mode': 'navigate',
            'x-real-ip': '1.2.3.4',
            accept: 'text/html',
          },
        }),
      );
    await html();
    const page = await (await html()).text();
    assert.match(page, /used up the free allowance/);
    assert.doesNotMatch(page, /Training crawlers pay for access here/);
  });

  it('makes the case against a proxy pool in plain arithmetic', async () => {
    const gw = gateway(1);
    const html = () =>
      gw.handle(
        new Request(`${SITE}/topics/x`, {
          headers: {
            'user-agent': CHROME,
            'sec-fetch-mode': 'navigate',
            'x-real-ip': '1.2.3.4',
            accept: 'text/html',
          },
        }),
      );
    await html();
    const page = await (await html()).text();
    assert.match(page, /sold by the gigabyte/);
  });
});

describe("an allowance the caller counted itself", () => {
  // The app-wide throttle in @profullstack/throttle meters every route, not
  // just the crawler lists, and then asks the gateway to sell. The 402 has to
  // quote the limit that actually stopped the request.
  const usage = { count: 101, remaining: 0, resetSeconds: 42, overLimit: true };

  it("quotes the caller's numbers, not the gateway's", async () => {
    const gate = gateway(null); // no freeQuota of its own
    const answer = await gate.sell(reader("203.0.113.9"), {
      usage,
      quota: { requests: 100, windowSeconds: 60 },
    });
    assert.equal(answer.status, 402);
    const body = await answer.json();
    assert.match(body.error, /100 requests per 60s/);
    assert.match(body.error, /resets in 42s/);
    assert.equal(body.quota.requests, 100);
    assert.equal(body.quota.used, 101);
    assert.equal(answer.headers.get("ratelimit-limit"), "100");
    assert.equal(answer.headers.get("ratelimit-reset"), "42");
  });

  it("still falls back to the gateway's own allowance", async () => {
    const gate = gateway(25);
    const answer = await gate.sell(reader("203.0.113.9"), { usage });
    const body = await answer.json();
    assert.match(body.error, /25 requests per 60s/);
  });

  // Regression: `sell` used to read o.freeQuota unconditionally whenever a
  // usage was passed, so a gateway without one threw on the throttle's path.
  it("does not throw when neither side has an allowance", async () => {
    const gate = gateway(null);
    const answer = await gate.sell(reader("203.0.113.9"), { usage });
    assert.equal(answer.status, 402);
    const body = await answer.json();
    assert.match(body.error, /Payment required/);
  });

  it("renders the caller's allowance on the HTML page too", async () => {
    const gate = gateway(null);
    const answer = await gate.sell(
      reader("203.0.113.9", { accept: "text/html" }),
      { usage, quota: { requests: 100, windowSeconds: 60 } },
    );
    assert.equal(answer.status, 402);
    assert.match(await answer.text(), /100/);
  });
});

describe("verifyPass", () => {
  it("honours a pass this gateway minted, and nothing else", async () => {
    const gate = gateway(100);
    const now = Math.floor(Date.now() / 1000);
    const good = await mintPass({ secret: SECRET, ref: "r1", expiresAt: now + 60, now });
    assert.equal(await gate.verifyPass(good.token), true);
    assert.equal(await gate.verifyPass("cp_nonsense.abc"), false);
    assert.equal(await gate.verifyPass(null), false);

    const expired = await mintPass({ secret: SECRET, ref: "r2", expiresAt: now - 1, now: now - 61 });
    assert.equal(await gate.verifyPass(expired.token), false);
  });

  it("reads the token off a request, header or bearer", () => {
    const gate = gateway(100);
    const header = new Request(`${SITE}/`, { headers: { "x-crawl-pass": " tok " } });
    assert.equal(gate.passFrom(header), "tok");
    const bearer = new Request(`${SITE}/`, {
      headers: { authorization: "Bearer cp_abc.def" },
    });
    assert.equal(gate.passFrom(bearer), "cp_abc.def");
    assert.equal(gate.passFrom(new Request(`${SITE}/`)), null);
  });
});

describe('offer and receipt, for a site with its own refusal', () => {
  it('hand back what the 402 would have carried, without a request', () => {
    const gate = gateway(null);
    const offer = gate.offer();
    assert.equal(offer.x402Version, 2);
    assert.ok(offer.accepts.length > 0);
    assert.equal(offer.accepts[0].payTo, PAY_TO);

    const receipt = gate.receipt();
    assert.equal(receipt.pass.price, '1.00 USD');
    assert.equal(receipt.pass.buy, `${SITE}/crawl`);
    assert.deepEqual(receipt.accepts, offer.accepts);
  });

  it('quote more than one day', () => {
    const gate = gateway(null);
    const one = BigInt(gate.offer(1).accepts[0].amount);
    const three = BigInt(gate.offer(3).accepts[0].amount);
    assert.equal(three, one * 3n);
    assert.equal(gate.receipt(3).pass.days, 3);
  });

  it('offer nothing when payments are not switched on', () => {
    const unpaid = createGateway({ siteUrl: SITE });
    assert.deepEqual(unpaid.offer().accepts, []);
  });
});
