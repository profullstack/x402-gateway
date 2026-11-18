/**
 * The buyer's side of XNO on Nano: read a 402, pay its `nano` entry with the
 * agent's own wallet, and present the proof. Opt-in, and separate from the
 * gateway: nothing here runs unless a buyer imports it.
 *
 *   import { payWithNano } from '@profullstack/x402-gateway/nano-pay';
 *   import { filePending } from '@profullstack/x402-gateway/nano-pay-file';
 *
 *   const res = await payWithNano('https://site.example/', {
 *     maxRaw: xnoToRaw('0.05'),          // the most this call may spend
 *     send: (s) => wallet.send(s),        // the agent's wallet; returns the block hash
 *     pending: filePending('/var/lib/agent/nano-pending.log'),
 *   });
 *
 * This module holds no key and signs nothing. `send` is the agent's wallet:
 * it gets `{ to, amountRaw, representative }`, publishes one send block, and
 * resolves to that block's hash. With an offer that asks for xno-binding v1
 * (`extra.binding`), `representative` is the order commitment that
 * `settleNano` checks, so the send proves this order and no other; without
 * it, `representative` is null and the wallet keeps its own.
 *
 * Paying twice is the buyer's replay problem, and a restart is when it bites:
 * the block is out but the process died before presenting it. With a
 * `pending` store the plan is written BEFORE the wallet is called and the
 * block hash right after, so the next run re-presents the same block for the
 * same order instead of paying again. A run that finds a plan with no block
 * hash refuses to send: the first send may be out, and only the wallet knows.
 *
 * Amounts are integer raw (1 XNO = 10^30 raw), compared as BigInt, and an
 * offer above `maxRaw` is refused before the wallet is called. The payee's
 * checksum is checked. No imports beyond the gateway's own edge modules.
 */
import { BINDING, canonicalAccount, isOrderId, newOrderId, orderRepresentative } from './nano.js';
import { decodeHeader, encodeHeader } from './x402.js';

/** 1 XNO in raw. */
export const RAW_PER_XNO = 10n ** 30n;

const RAW = /^[1-9]\d*$/;
const DECIMAL = /^(\d+)(?:\.(\d{1,30}))?$/;
const HASH = /^[0-9A-F]{64}$/;

/**
 * A decimal XNO amount as a raw string, derived from 10^30, never rounded:
 * more than 30 decimals, a sign, or zero is refused.
 */
export function xnoToRaw(xno) {
  const m = DECIMAL.exec(String(xno ?? '').trim());
  if (!m) throw new Error(`not an XNO amount: ${JSON.stringify(xno)}`);
  const raw = BigInt(m[1]) * RAW_PER_XNO + BigInt((m[2] ?? '').padEnd(30, '0') || '0');
  if (raw === 0n) throw new Error('an XNO amount must be more than zero');
  return raw.toString();
}

/**
 * The `exact` / `nano` entry of a 402, or null if there is none this module
 * can pay. Takes the JSON body (`{ accepts }`) or the PAYMENT-REQUIRED header
 * (base64 JSON). The payee must pass its checksum and the amount must be
 * integer raw; the returned entry carries the payee in canonical form.
 */
export function pickNanoOffer(required) {
  const offer = typeof required === 'string' ? decodeHeader(required) : required;
  const accepts = Array.isArray(offer?.accepts) ? offer.accepts : [];
  for (const a of accepts) {
    if (String(a?.scheme ?? '') !== 'exact' || String(a?.network ?? '').toLowerCase() !== 'nano') continue;
    if (a.asset !== undefined && a.asset !== 'XNO') continue;
    const payTo = canonicalAccount(a.payTo);
    const amount = String(a.amount ?? '');
    if (!payTo || !RAW.test(amount)) continue;
    return { ...a, network: 'nano', payTo, amount };
  }
  return null;
}

const toRaw = (v) => {
  const s = typeof v === 'bigint' ? v.toString() : String(v ?? '');
  if (!RAW.test(s)) throw new Error('maxRaw must be a positive integer amount in raw (see xnoToRaw)');
  return BigInt(s);
};

/**
 * What the wallet has to sign for this entry: `{ to, amountRaw, orderId,
 * representative }`. Throws, before anything is spent, when the entry asks
 * for more than `maxRaw`.
 */
export async function nanoPaymentPlan(entry, { maxRaw, orderId } = {}) {
  const cap = toRaw(maxRaw);
  const to = canonicalAccount(entry?.payTo);
  const amountRaw = String(entry?.amount ?? '');
  if (!to || !RAW.test(amountRaw)) throw new Error('not a Nano offer this module can pay');
  if (BigInt(amountRaw) > cap) {
    throw new Error(`the offer asks ${amountRaw} raw, more than maxRaw ${cap} raw; nothing was sent`);
  }
  const bound = entry?.extra?.binding === BINDING;
  const id = isOrderId(orderId) ? orderId : isOrderId(entry?.extra?.orderId) ? entry.extra.orderId : newOrderId();
  return {
    to,
    amountRaw,
    orderId: id,
    representative: bound ? await orderRepresentative({ orderId: id, payTo: to, amount: amountRaw }) : null,
  };
}

/**
 * The PAYMENT-SIGNATURE (and X-PAYMENT) value for a sent block: the spec v2
 * shape, with the chosen entry in `accepted` and the block hash and order id
 * in `payload`, which is what the gateway's `decodePayment` reads.
 */
export function nanoPaymentHeader(entry, { blockHash, orderId }) {
  const hash = String(blockHash ?? '').toUpperCase();
  if (!HASH.test(hash)) throw new Error('a Nano proof needs the 64-hex hash of the send block');
  if (!isOrderId(orderId)) throw new Error('a Nano proof needs the order id its send committed to');
  const { scheme, network, amount, asset, payTo, maxTimeoutSeconds, extra } = entry;
  return encodeHeader({
    x402Version: 2,
    accepted: { scheme, network, amount, asset, payTo, maxTimeoutSeconds, extra },
    payload: { blockHash: hash, orderId },
  });
}

/**
 * Pending payments in memory. For tests only: a restart forgets the plan,
 * and a block that was sent but not yet presented is paid for again.
 */
export function memoryPending() {
  const held = new Map();
  return {
    get: (key) => held.get(key) ?? null,
    put: (key, value) => void held.set(key, { ...value }),
    delete: (key) => void held.delete(key),
  };
}

async function present(url, entry, record, { fetch: f, init }) {
  const header = nanoPaymentHeader(entry, record);
  const headers = new Headers(init?.headers ?? {});
  headers.set('payment-signature', header);
  headers.set('x-payment', header);
  return f(url, { ...init, headers });
}

/**
 * Fetch `url`; on a 402 with a payable `nano` entry, pay it once and fetch
 * again with the proof. Resolves to the final Response (a 402 that still
 * refuses is returned as it is, with its reason in the body). Throws, having
 * sent nothing, when the offer is over `maxRaw` or there is no Nano entry.
 *
 * `pending` (`get`/`put`/`delete`, keyed by the URL) is what keeps a restart
 * from paying twice; `filePending` from `./nano-pay-file` keeps it on disk.
 */
export async function payWithNano(url, { send, maxRaw, pending = memoryPending(), fetch: f = globalThis.fetch, init = {} } = {}) {
  if (typeof send !== 'function') throw new Error('payWithNano needs send, the wallet call that publishes the block');
  toRaw(maxRaw);
  const key = String(url);
  const held = await pending.get(key);
  if (held && !held.blockHash) {
    throw new Error(
      `a Nano send for ${key} (order ${held.orderId}) was started and never recorded; find its block in the wallet and put its hash in the pending store before paying again`,
    );
  }

  const first = await f(url, init);
  if (first.status !== 402) {
    if (held) await pending.delete(key);
    return first;
  }
  let body = null;
  try {
    body = await first.clone().json();
  } catch {
    body = null;
  }
  const entry = pickNanoOffer(first.headers.get('payment-required') ?? body) ?? pickNanoOffer(body);
  if (!entry) throw new Error(`${key} answered 402 with no Nano (exact) entry`);

  let record = held;
  if (!record) {
    const plan = await nanoPaymentPlan(entry, { maxRaw });
    record = { orderId: plan.orderId, to: plan.to, amountRaw: plan.amountRaw, blockHash: null };
    await pending.put(key, record);
    const sent = String((await send({ to: plan.to, amountRaw: plan.amountRaw, representative: plan.representative })) ?? '').toUpperCase();
    if (!HASH.test(sent)) throw new Error('the wallet did not return a 64-hex block hash; the plan stays pending');
    record = { ...record, blockHash: sent };
    await pending.put(key, record);
  }
  // A held block is presented against the entry it was sent for, whatever this 402 now quotes.
  const paidEntry = { ...entry, payTo: record.to ?? entry.payTo, amount: record.amountRaw ?? entry.amount };
  const res = await present(url, paidEntry, record, { fetch: f, init });
  if (res.ok) await pending.delete(key);
  return res;
}
