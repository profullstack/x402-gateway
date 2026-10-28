/**
 * x402 endpoint verification badge — a well-known metadata endpoint that
 * lets external indexers (like nullclear.dev) verify that an x402 gateway
 * is live, what methods it accepts, and what its settlement flow looks like.
 *
 * GET /.well-known/x402-verify returns a JSON object with:
 * - version: the x402 protocol version (1 or 2)
 * - methods: the payment methods the gateway accepts
 * - settleFlow: how settlement works (verify-then-settle)
 * - lastChecked: ISO timestamp of the last successful settlement
 *
 * This is read-only metadata — no secrets, no keys, no payment logic.
 * Indexers can poll it to confirm the endpoint is live and schema-valid.
 */

/**
 * Build the verification badge response for a given x402 gateway configuration.
 *
 * @param {object} opts - Gateway configuration
 * @param {number} opts.x402Version - 1 or 2
 * @param {Array} opts.methods - The METHODS array from x402.js
 * @param {string} [opts.payee] - The payee address (optional, for transparency)
 * @returns {object} The badge metadata
 */
export function buildVerificationBadge({ x402Version = 2, methods = [], payee } = {}) {
  return {
    spec: 'x402-verify-badge/v1',
    version: x402Version,
    methods: methods.map((m) => ({
      key: m.key,
      network: m.network,
      asset: m.asset,
      label: m.label,
    })),
    settleFlow: 'verify-then-settle',
    settleProvider: 'CoinPay',
    payee: payee || undefined,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Hono handler for GET /.well-known/x402-verify.
 *
 * Returns the badge as JSON with appropriate cache headers. Indexers should
 * cache for 5 minutes; the badge is cheap to compute but there's no reason
 * to hit the gateway on every poll.
 *
 * @param {object} badge - The badge object from buildVerificationBadge
 * @returns {Response} JSON response with cache headers
 */
export function verificationBadgeHandler(badge) {
  return new Response(JSON.stringify(badge, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'access-control-allow-origin': '*',
    },
  });
}
