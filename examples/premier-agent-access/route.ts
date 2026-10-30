import { createHash } from 'node:crypto';
import { mintKey } from '@profullstack/keys';
import { createGateway, readPass } from '@profullstack/x402-gateway';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const env = (name: string) => process.env[name];
const PRICE_CENTS = 2900;
const TERM_SECONDS = 30 * 24 * 60 * 60;

/**
 * GET returns a $29 x402 offer. Retry with X-PAYMENT; after settlement this
 * returns the fleet-wide Power Key with its fixed 30-day expiry.
 */
export async function GET(request: Request) {
  const apiKey = env('COINPAY_X402_KEY');
  const payTo = env('CRAWL_PAY_TO');
  const privateKey = env('POWER_KEY_PRIVATE_KEY');
  const siteUrl = (env('SITE_URL') || 'https://example.com').replace(/\/+$/, '');
  if (!apiKey || !payTo || !privateKey) {
    return NextResponse.json({ ok: false, error: 'agent checkout is not configured' }, { status: 503 });
  }

  const gateway = createGateway({
    siteUrl,
    siteName: 'Premier Developer Access',
    path: '/api/shop/agent',
    coinpay: { apiKey },
    payTo,
    priceCents: PRICE_CENTS,
    currency: 'USD',
    passMinutes: TERM_SECONDS / 60,
    maxDays: 1,
    secret: apiKey,
    powerKeys: false,
    benefits: ['One key for every Profullstack service', '30 days of access', 'No email or manual key delivery'],
  });

  const result = await gateway.sell(request);
  if (result.status !== 200) return result;

  try {
    const receipt = (await result.json()) as { pass?: string; expires_at?: string };
    if (!receipt.pass) throw new Error('CoinPay receipt did not include the gateway pass');
    const claims = await readPass(receipt.pass, { secret: apiKey });
    if (!claims) throw new Error('gateway could not verify the settled pass');

    const subject = claims.ref ?? createHash('sha256').update(receipt.pass).digest('base64url');
    const { key } = await mintKey({
      privateKey,
      sub: subject,
      plan: 'monthly',
      exp: claims.exp,
    });

    return NextResponse.json(
      {
        ok: true,
        plan: 'power-monthly',
        amount: '$29 USD',
        term: '30 days',
        key,
        expires_at: receipt.expires_at ?? new Date(claims.exp * 1000).toISOString(),
        send: { header: 'Authorization: Bearer', alternative: 'x-power-key' },
      },
      { headers: { 'cache-control': 'no-store', pragma: 'no-cache' } },
    );
  } catch (error) {
    console.error('[shop] agent key issuance failed: %s', (error as Error).message);
    return NextResponse.json(
      { ok: false, error: 'payment settled but key issuance needs retry' },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
}
