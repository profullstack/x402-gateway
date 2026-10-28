import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildVerificationBadge, verificationBadgeHandler } from '../src/verify-badge.js';

describe('buildVerificationBadge', () => {
  it('returns a badge with the correct spec version', () => {
    const badge = buildVerificationBadge({ x402Version: 2 });
    assert.equal(badge.spec, 'x402-verify-badge/v1');
    assert.equal(badge.version, 2);
  });

  it('includes payment methods', () => {
    const methods = [
      { key: 'usdc_base', network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', label: 'USDC on Base' },
    ];
    const badge = buildVerificationBadge({ methods });
    assert.equal(badge.methods.length, 1);
    assert.equal(badge.methods[0].key, 'usdc_base');
    assert.equal(badge.methods[0].network, 'eip155:8453');
  });

  it('includes settlement flow metadata', () => {
    const badge = buildVerificationBadge({});
    assert.equal(badge.settleFlow, 'verify-then-settle');
    assert.equal(badge.settleProvider, 'CoinPay');
  });

  it('includes a generatedAt timestamp', () => {
    const badge = buildVerificationBadge({});
    assert.ok(badge.generatedAt);
    // Should be a valid ISO date
    assert.equal(new Date(badge.generatedAt).toISOString(), badge.generatedAt);
  });

  it('optionally includes a payee address', () => {
    const badge = buildVerificationBadge({ payee: '0x1234...' });
    assert.equal(badge.payee, '0x1234...');
  });

  it('omits payee when not provided', () => {
    const badge = buildVerificationBadge({});
    assert.equal(badge.payee, undefined);
  });
});

describe('verificationBadgeHandler', () => {
  it('returns a 200 JSON response', () => {
    const badge = buildVerificationBadge({});
    const res = verificationBadgeHandler(badge);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type').includes('application/json'));
  });

  it('sets a 5-minute cache header', () => {
    const badge = buildVerificationBadge({});
    const res = verificationBadgeHandler(badge);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
  });

  it('allows cross-origin access (CORS)', () => {
    const badge = buildVerificationBadge({});
    const res = verificationBadgeHandler(badge);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });

  it('returns the badge as JSON in the body', async () => {
    const badge = buildVerificationBadge({ x402Version: 2 });
    const res = verificationBadgeHandler(badge);
    const body = await res.json();
    assert.equal(body.spec, 'x402-verify-badge/v1');
    assert.equal(body.version, 2);
  });
});
