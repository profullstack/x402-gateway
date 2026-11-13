/**
 * x402 v2, in CoinPayPortal's dialect, plus the spec's transport headers.
 *
 * Checked against @profullstack/coinpay/x402-v2 rather than remembered: the 402
 * body is JSON `{ x402Version: 2, accepts: [...] }`, the proof arrives as base64
 * JSON, and CoinPay's /api/x402/verify then /api/x402/settle do the
 * cryptography and the on-chain transfer (EIP-3009, with CoinPay's relayer
 * paying the gas, so the buyer needs no ETH).
 *
 * The x402 v2 transport spec moves all three messages into headers:
 * `PAYMENT-REQUIRED` (the offer, base64 JSON) on the 402, `PAYMENT-SIGNATURE`
 * (the proof) on the retry, and `PAYMENT-RESPONSE` (the settlement) on the
 * 200. The gateway speaks both: the body and `X-PAYMENT` stay for the clients
 * that already pay this way, and the headers are there for spec-strict ones.
 *
 * Reimplemented here in a few dozen lines because the SDK also carries the
 * CLI's interactive-prompt dependency, which a web server has no business
 * installing, and because a gateway that runs at the edge cannot import node:.
 */

import { BINDING, canonicalAccount, newOrderId } from './nano.js';

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
 *
 * Why not more: CoinPay's v2 settle broadcasts `transferWithAuthorization`
 * only on chains its relayer has an RPC and a funded wallet for, which are
 * exactly 1, 137 and 8453, and USDC is the only EIP-3009 dollar token on them
 * (USDT has no EIP-3009). Advertising anything else would quote a payment
 * that verifies and then never settles. Buyers who want another coin, or
 * PayPal, use the hosted checkout on the sales page instead. The one
 * exception is XNO on Nano, which CoinPay settles by a node lookup rather
 * than a relayer, and which `buildOffer` adds only when given a Nano payee.
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
 * XNO on Nano, opt-in: CoinPay verifies and settles network `nano` by asking a
 * Nano node whether the proof's block is a confirmed send of at least the
 * asking price to `payTo`. Nothing is signed or broadcast, so the buyer sends
 * the block first and presents its hash. Amounts are in raw, 10^30 per XNO.
 */
/**
 * A Nano payee in canonical `nano_` form, or null if it is not one. The
 * checksum is checked too: a mistyped address can still fit the alphabet,
 * and money sent to it is gone.
 */
export function nanoPayee(address) {
  return canonicalAccount(address);
}

/**
 * A price in raw XNO, rounded UP, at `rate` units of the price's currency per
 * XNO. BigInt throughout: 10^30 is far past what a float holds exactly, and
 * String() of a number that large is exponent notation no verifier parses.
 * The rate is read to 10^-9 and the price to 10^-6 of a cent. Null if either
 * is not a positive number.
 */
export function xnoRaw(priceCents, rate) {
  const cents = BigInt(Math.round(Number(priceCents) * 1e6));
  const per = BigInt(Number.isFinite(Number(rate)) ? Math.round(Number(rate) * 1e9) : 0);
  if (cents <= 0n || per <= 0n) return null;
  // raw = (cents / 100) / rate * 10^30 = (cents*1e6) * 10^31 / (rate*1e9)
  const num = cents * 10n ** 31n;
  return String((num + per - 1n) / per);
}

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
  nano = null,
}) {
  if (!payTo) throw new Error('an offer needs a payTo address');
  const amount = String(Math.ceil((Number(priceCents) / 100) * 10 ** DECIMALS));
  /*
   * XNO goes last, and only with a real Nano payee and a raw amount: without
   * both the offer is exactly the USDC one.
   */
  const xnoTo = nanoPayee(nano?.payTo);
  const xno =
    xnoTo && /^[1-9]\d*$/.test(String(nano.amount ?? ''))
      ? [
          {
            scheme: 'exact',
            network: 'nano',
            amount: String(nano.amount),
            asset: 'XNO',
            payTo: xnoTo,
            resource,
            description,
            mimeType: 'application/json',
            maxTimeoutSeconds,
            /*
             * With `binding`, the send must commit to an order in its
             * representative (see nano.js). The order id offered here is a
             * fresh random one; the payer may use it or its own, and must
             * present the one it signed for with the block hash.
             */
            extra: nano.binding ? { decimals: 30, binding: BINDING, orderId: newOrderId() } : { decimals: 30 },
          },
        ]
      : [];
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
    })).concat(xno),
  };
}

/** base64 -> utf8, without Buffer, so it runs at the edge. */
function fromBase64(s) {
  const bin = atob(String(s).trim().replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** utf8 JSON -> base64, without Buffer, for the PAYMENT-* headers. */
export function encodeHeader(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** A PAYMENT-* header back into an object. Null if it is not base64 JSON. */
export function decodeHeader(header) {
  if (!header) return null;
  try {
    const parsed = JSON.parse(fromBase64(header));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The proof out of a PAYMENT-SIGNATURE or X-PAYMENT header. Null if it is not
 * base64 JSON.
 *
 * Two shapes arrive. CoinPay's payer puts `scheme` and `network` at the top
 * level; a spec v2 client nests them in `accepted`, the requirement it chose.
 * Both carry the same `payload`, so the spec shape is lifted into CoinPay's,
 * which is what CoinPay's verify and settle read.
 */
export function decodePayment(header) {
  const parsed = decodeHeader(header);
  if (!parsed) return null;
  const chosen = parsed.accepted && typeof parsed.accepted === 'object' ? parsed.accepted : null;
  if (chosen) {
    if (!parsed.network && chosen.network) parsed.network = chosen.network;
    if (!parsed.scheme && chosen.scheme) parsed.scheme = chosen.scheme;
    if (parsed.x402Version === undefined) parsed.x402Version = 2;
  }
  /*
   * A Nano proof is a block hash, not an EIP-3009 authorization, and CoinPay
   * reads it on its v1 path: `x402Version` must not be 2, and `network`,
   * `scheme`, `to`, `amount` and `blockHash` are read from the payload. Lifted
   * there from wherever this payer put them.
   */
  const network = String(parsed.network ?? parsed.payload?.network ?? '').toLowerCase();
  if (network === 'nano') {
    const payload = { ...(parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : {}) };
    payload.network = 'nano';
    payload.scheme = payload.scheme || parsed.scheme || 'exact';
    if (!payload.blockHash && parsed.blockHash) payload.blockHash = parsed.blockHash;
    if (!payload.orderId && parsed.orderId) payload.orderId = parsed.orderId;
    if (!payload.to && chosen?.payTo) payload.to = chosen.payTo;
    if (payload.amount === undefined && chosen?.amount) payload.amount = String(chosen.amount);
    return { ...parsed, x402Version: 1, scheme: payload.scheme, network: 'nano', payload };
  }
  return parsed;
}

/**
 * The PAYMENT-REQUIRED header for an offer: the spec's PaymentRequired object,
 * base64 JSON. The resource moves to the top level, as the spec has it, and
 * each requirement keeps only the spec's own fields, so a strict schema has
 * nothing to choke on.
 */
export function paymentRequiredHeader(offer, { url, description, error } = {}) {
  const first = offer?.accepts?.[0];
  return encodeHeader({
    x402Version: 2,
    ...(error ? { error: String(error) } : {}),
    resource: {
      url: url ?? first?.resource ?? '',
      description: description ?? first?.description ?? '',
      mimeType: first?.mimeType ?? 'application/json',
    },
    accepts: (offer?.accepts ?? []).map((a) => ({
      scheme: a.scheme,
      network: a.network,
      amount: a.amount,
      asset: a.asset,
      payTo: a.payTo,
      maxTimeoutSeconds: a.maxTimeoutSeconds,
      extra: a.extra,
    })),
  });
}

/** The PAYMENT-RESPONSE header for a settled payment: the spec's SettlementResponse. */
export function paymentResponseHeader({ transaction, network, payer }) {
  return encodeHeader({
    success: true,
    transaction: transaction ?? '',
    network: network ?? '',
    ...(payer ? { payer } : {}),
  });
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
  /*
   * XNO is Nano's native coin, which CoinPay's v1 check accepts only with no
   * asset named on either side, or the same one named on both. The block is
   * what proves the payment either way.
   */
  if (network === 'nano') {
    const named = payment?.payload?.asset;
    return { amount: entry.amount, resource: entry.resource, payTo: entry.payTo, ...(named ? { asset: entry.asset } : {}) };
  }
  return { amount: entry.amount, resource: entry.resource, payTo: entry.payTo, asset: entry.asset };
}

/** The single-use nonce, which is what CoinPay keys replay detection on: a Nano proof's is its block hash. */
export const nonceOf = (payment) => payment?.payload?.authorization?.nonce ?? payment?.payload?.blockHash ?? null;

/** When the payer's signature stops being valid, as a unix timestamp in seconds. Null for Nano, which signs nothing with a deadline. */
export const validBeforeOf = (payment) => {
  if (String(payment?.network ?? '').toLowerCase() === 'nano') return null;
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
export async function verifyAndSettle(payment, expected, { apiKey, baseUrl, fetch: f = globalThis.fetch, metadata = null }) {
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

  /*
   * A block cannot name the resource it bought, so for Nano the gateway names
   * it: CoinPay compares `payload.resource` with `expected.resource` before it
   * asks the node about the block.
   */
  if (String(payment?.network ?? '').toLowerCase() === 'nano' && payment.payload && !payment.payload.resource) {
    payment = { ...payment, payload: { ...payment.payload, resource: expected.resource } };
  }
  const v = await call('/api/x402/verify', { payment, expected });
  if (!v.json?.valid) {
    const reason = String(v.json?.error ?? v.json?.reason ?? `verify failed (${v.status})`);
    return { ok: false, reason, replay: /already used|replay/i.test(reason) };
  }
  const payer = v.json.payment?.from ?? null;
  /*
   * Who paid and where, for CoinPay's ledger: the property, the page, the
   * payer, the user agent and a hash of the address. CoinPay keeps it on the
   * x402_payments row (and ignores it where it does not), so a sale can be
   * traced to the site and page it bought rather than only to the business.
   */
  const settleBody = metadata ? { payment, metadata: { ...metadata, ...(payer ? { payer } : {}) } } : { payment };
  const s = await call('/api/x402/settle', settleBody);
  if (!s.json?.settled) {
    const reason = String(s.json?.error ?? `settle failed (${s.status})`);
    return { ok: false, reason, replay: /already settled|already being settled/i.test(reason) };
  }
  return { ok: true, payer, ref: s.json.txHash ?? nonceOf(payment), txHash: s.json.txHash ?? null, network: s.json.network ?? payment?.network ?? null };
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
