const CHECKOUT = 'https://profullstack.com/api/shop/agent';
const SECRET_KEY = 'profullstack.powerKey';
const EXPIRY_KEY = 'profullstack.powerKeyExpiresAt';
const RENEW_AHEAD_MS = 5 * 60 * 1000;

/**
 * Return the saved key while it has more than five minutes left. Otherwise,
 * use the agent's CoinPay-backed signer to pay the x402 offer and save the new
 * key. `secretStore` must keep values encrypted and private to the agent.
 */
export async function ensurePremierAccess({ x402fetch, signer, secretStore, now = Date.now() }) {
  const [currentKey, savedExpiry] = await Promise.all([
    secretStore.get(SECRET_KEY),
    secretStore.get(EXPIRY_KEY),
  ]);
  const expiresAt = typeof savedExpiry === 'string' ? Date.parse(savedExpiry) : NaN;

  if (currentKey && Number.isFinite(expiresAt) && expiresAt > now + RENEW_AHEAD_MS) {
    return { key: currentKey, expires_at: savedExpiry, renewed: false };
  }

  const response = await x402fetch(CHECKOUT, {
    paymentMethods: { base: { signer } },
    preferredMethod: 'usdc_base',
    maxAmount: '29.00',
  });
  if (!response.ok) throw new Error(`Premier Developer Access payment failed: ${response.status}`);

  const purchase = await response.json();
  if (!purchase?.ok || typeof purchase.key !== 'string' || typeof purchase.expires_at !== 'string') {
    throw new Error('Premier Developer Access returned an invalid receipt');
  }

  // Save only after settlement and validation. A failed renewal preserves the
  // old key until its existing expiration.
  await secretStore.set(SECRET_KEY, purchase.key);
  await secretStore.set(EXPIRY_KEY, purchase.expires_at);
  return { ...purchase, renewed: true };
}
