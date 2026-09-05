/**
 * x402 v2, in CoinPayPortal's dialect.
 *
 * Checked against @profullstack/coinpay/x402-v2 rather than remembered: the 402
 * body is JSON `{ x402Version: 2, accepts: [...] }`, the proof arrives as base64
 * JSON in an `X-PAYMENT` request header, and CoinPay's /api/x402/verify then
 * /api/x402/settle do the cryptography and the on-chain transfer (EIP-3009,
 * with CoinPay's relayer paying the gas, so the buyer needs no ETH).
 *
 * Reimplemented here in a few dozen lines because the SDK also carries the
 * CLI's interactive-prompt dependency, which a web server has no business
 * installing, and because a gateway that runs at the edge cannot import node:.
 */

/**
 * The three things CoinPay can settle under the `exact` scheme. USDC only:
 * EIP-3009 is an ERC-20 extension, so native ETH cannot be paid this way.
 *
 * CAIP-2 network ids, 6-decimal amounts, and the token's own EIP-712 domain in
 * `extra`, which is not derivable from the contract and was read over JSON-RPC
 * once upstream: all three USDC deployments answer "USD Coin" / "2".
 *
 * Base first. Merchant order is the payer's preference order, and Base is where
 * the relayer's gas is cheapest.
 */
export const METHODS = [
  {
    key: 'usdc_base',
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    label: 'USDC on Base',
  },
  {
    key: 'usdc_polygon',
    network: 'eip155:137',
    asset: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    label: 'USDC on Polygon',
  },
  {
    key: 'usdc_eth',
    network: 'eip155:1',
    asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    label: 'USDC on Ethereum',
  },
];

const DECIMALS = 6;
const DOMAIN = { name: 'USD Coin', version: '2' };

/**
 * A v2 402 body.
 *
 * `amount` is the price in the token's smallest unit, rounded UP: a fraction of
 * a cent rounded down would quote less than the asking price and then verify as
 * underpayment.
 */
export function buildOffer({
  payTo,
  priceCents,
  resource,
  description = 'Payment required',
  maxTimeoutSeconds = 300,
  methods = METHODS,
}) {
  if (!payTo) throw new Error('an offer needs a payTo address');
  const amount = String(Math.ceil((Number(priceCents) / 100) * 10 ** DECIMALS));
  return {
    x402Version: 2,
    accepts: methods.map((m) => ({
      scheme: 'exact',
      network: m.network,
      amount,
      asset: m.asset,
      payTo,
      resource,
      description,
      mimeType: 'application/json',
      maxTimeoutSeconds,
      extra: { ...DOMAIN },
    })),
  };
}

/** base64 -> utf8, without Buffer, so it runs at the edge. */
function fromBase64(s) {
  const bin = atob(String(s).trim().replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** The proof out of an X-PAYMENT header. Null if it is not base64 JSON. */
export function decodePayment(header) {
  if (!header) return null;
  try {
    const parsed = JSON.parse(fromBase64(header));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * What CoinPay must hold the proof to.
 *
 * Its v2 verify refuses without all four of amount, resource, payTo and asset,
 * and takes them from the OFFERED entry for the proof's network -- never from
 * the proof itself, which is the payer's claim about what it paid.
 */
export function expectedFor(payment, offer) {
  const network = String(payment?.network ?? '').toLowerCase();
  const entry = (offer?.accepts ?? []).find((a) => a.network.toLowerCase() === network);
  if (!entry) return null;
  return { amount: entry.amount, resource: entry.resource, payTo: entry.payTo, asset: entry.asset };
}

/** The single-use nonce, which is what CoinPay keys replay detection on. */
export const nonceOf = (payment) => payment?.payload?.authorization?.nonce ?? null;

/** When the payer's signature stops being valid, as a unix timestamp in seconds. */
export const validBeforeOf = (payment) => {
  const v = Number(payment?.payload?.authorization?.validBefore);
  return Number.isFinite(v) && v > 0 ? v : null;
};

/**
 * Verify, then settle. Two calls because verify moves no money: it checks the
 * signature and records the proof, and settle broadcasts the transfer.
 *
 * Resolves to `{ ok: true, payer, ref }` or `{ ok: false, reason, replay }`.
 * `replay` is set when CoinPay has already seen this proof -- the case where a
 * crawler paid, lost our answer, and is retrying with the same header. The
 * gateway answers that with a pass rather than a second charge, bounded by the
 * proof's own validity window so the same header cannot buy hour after hour.
 */
export async function verifyAndSettle(payment, expected, { apiKey, baseUrl, fetch: f = globalThis.fetch }) {
  const call = async (path, body) => {
    const res = await f(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    let json = {};
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json };
  };

  const v = await call('/api/x402/verify', { payment, expected });
  if (!v.json?.valid) {
    const reason = String(v.json?.error ?? v.json?.reason ?? `verify failed (${v.status})`);
    return { ok: false, reason, replay: /already used|replay/i.test(reason) };
  }
  const s = await call('/api/x402/settle', { payment });
  if (!s.json?.settled) {
    const reason = String(s.json?.error ?? `settle failed (${s.status})`);
    return { ok: false, reason, replay: /already settled|already being settled/i.test(reason) };
  }
  return { ok: true, payer: v.json.payment?.from ?? null, ref: s.json.txHash ?? nonceOf(payment) };
}

/** Whether the proof has already been paid, when a settle is asked about twice. */
export async function settleAgain(payment, { apiKey, baseUrl, fetch: f = globalThis.fetch }) {
  const res = await f(`${baseUrl}/api/x402/settle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ payment }),
    signal: AbortSignal.timeout(20000),
  });
  let json = {};
  try {
    json = JSON.parse(await res.text());
  } catch {}
  const reason = String(json?.error ?? '');
  return Boolean(json?.settled) || /already settled/i.test(reason);
}
