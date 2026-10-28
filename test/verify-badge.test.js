import { describe, it, expect } from 'vitest';
import { buildVerificationBadge, verificationBadgeHandler } from '../src/verify-badge.js';

describe('buildVerificationBadge', () => {
  it('returns a badge with the correct spec version', () => {
    const badge = buildVerificationBadge({ x402Version: 2 });
    expect(badge.spec).toBe('x402-verify-badge/v1');
    expect(badge.version).toBe(2);
  });

  it('includes payment methods', () => {
    const methods = [
      { key: 'usdc_base', network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', label: 'USDC on Base' },
    ];
    const badge = buildVerificationBadge({ methods });
    expect(badge.methods).toHaveLength(1);
    expect(badge.methods[0].key).toBe('usdc_base');
    expect(badge.methods[0].network).toBe('eip155:8453');
  });

  it('includes settlement flow metadata', () => {
    const badge = buildVerificationBadge({});
    expect(badge.settleFlow).toBe('verify-then-settle');
    expect(badge.settleProvider).toBe('CoinPay');
  });

  it('includes a generatedAt timestamp', () => {
    const badge = buildVerificationBadge({});
    expect(badge.generatedAt).toBeTruthy();
    // Should be a valid ISO date
    expect(new Date(badge.generatedAt).toISOString()).toBe(badge.generatedAt);
  });

  it('optionally includes a payee address', () => {
    const badge = buildVerificationBadge({ payee: '0x1234...' });
    expect(badge.payee).toBe('0x1234...');
  });

  it('omits payee when not provided', () => {
    const badge = buildVerificationBadge({});
    expect(badge.payee).toBeUndefined();
  });
});

describe('verificationBadgeHandler', () => {
  it('returns a 200 JSON response', () => {
    const badge = buildVerificationBadge({});
    const res = verificationBadgeHandler(badge);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('sets a 5-minute cache header', () => {
    const badge = buildVerificationBadge({});
    const res = verificationBadgeHandler(badge);
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
  });

  it('allows cross-origin access (CORS)', () => {
    const badge = buildVerificationBadge({});
    const res = verificationBadgeHandler(badge);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('returns the badge as JSON in the body', async () => {
    const badge = buildVerificationBadge({ x402Version: 2 });
    const res = verificationBadgeHandler(badge);
    const body = await res.json();
    expect(body.spec).toBe('x402-verify-badge/v1');
    expect(body.version).toBe(2);
  });
});
