import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultUserAgent, withUserAgent, VERSION } from '../src/user-agent.js';
import pkg from '../package.json' with { type: 'json' };

test('VERSION matches package.json', () => {
  assert.equal(VERSION, pkg.version);
});

test('default names the site and the gateway', () => {
  const prev = { a: process.env.X402_USER_AGENT, b: process.env.COINPAY_USER_AGENT, v: process.env.npm_package_version };
  delete process.env.X402_USER_AGENT;
  delete process.env.COINPAY_USER_AGENT;
  process.env.npm_package_version = '1.2.3';
  try {
    assert.equal(defaultUserAgent('https://example.test'), `example.test/1.2.3 (+https://example.test) x402-gateway/${VERSION}`);
    delete process.env.npm_package_version;
    assert.equal(defaultUserAgent('https://example.test'), `example.test (+https://example.test) x402-gateway/${VERSION}`);
    process.env.COINPAY_USER_AGENT = 'custom/1';
    assert.equal(defaultUserAgent('https://example.test'), 'custom/1');
  } finally {
    for (const [k, v] of [['X402_USER_AGENT', prev.a], ['COINPAY_USER_AGENT', prev.b], ['npm_package_version', prev.v]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('wrapper adds the header and keeps plain objects plain', async () => {
  const seen = [];
  const f = withUserAgent(async (url, init) => (seen.push(init.headers), new Response('{}')), 'site/1');
  await f('https://x.test', { headers: { authorization: 'Bearer k' } });
  assert.deepEqual(seen[0], { authorization: 'Bearer k', 'user-agent': 'site/1' });
  await f('https://x.test');
  assert.deepEqual(seen[1], { 'user-agent': 'site/1' });
  await f('https://x.test', { headers: { 'User-Agent': 'mine' } });
  assert.deepEqual(seen[2], { 'User-Agent': 'mine' });
  await f('https://x.test', { headers: new Headers({ a: 'b' }) });
  assert.equal(seen[3].get('user-agent'), 'site/1');
});

