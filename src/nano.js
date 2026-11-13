/**
 * Nano (XNO) proofs checked against the operator's own Nano node, opt-in.
 *
 * The CoinPay path holds a block to the payee and the amount, and nothing
 * else: a Nano block has no memo, so a confirmed send proves money reached an
 * account and says nothing about which sale it paid for, and its hash is
 * public, so anyone who reads the ledger can present it. This module adds the
 * two checks that close that, following the xno-binding v1 order commitment
 * (https://github.com/dhyabi2/xno-call-binding/blob/main/docs/BINDING-STANDARD.md,
 * option C):
 *
 *   - Bound to the order. The payer picks a random order id and signs its send
 *     with `representative` set to SHA-256("xno-binding/v1/rep|" + orderId +
 *     "|" + payTo + "|" + amountRaw), encoded as a nano_ account. The gateway
 *     recomputes that from the order id in the proof and the offered payee and
 *     amount, so a block only proves the order it was signed for, and a block
 *     hash read off the ledger is worthless without the order id.
 *   - Single-use, across restarts. A verified block is claimed in a store the
 *     operator supplies (block hash and order id, each at most once). The
 *     store in `nano-claims-file.js` appends and fsyncs every claim and reads
 *     them back on start.
 *
 * No key, no seed, no signing: the node is only read (`block_info`). Amounts
 * are integer raw (1 XNO = 10^30 raw) and must match exactly. Addresses are
 * checksum-validated.
 *
 * No imports, so it runs at the edge like the rest of the gateway: SHA-256 is
 * Web Crypto, and BLAKE2b (which the address checksum uses) is below.
 */

// ---------------------------------------------------------------- BLAKE2b

const MASK = (1n << 64n) - 1n;
const IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

const rotr = (x, n) => ((x >> n) | (x << (64n - n))) & MASK;

function compress(h, block, t, last) {
  const m = [];
  for (let i = 0; i < 16; i++) {
    let w = 0n;
    for (let j = 7; j >= 0; j--) w = (w << 8n) | BigInt(block[i * 8 + j]);
    m.push(w);
  }
  const v = [...h, ...IV];
  v[12] ^= t & MASK;
  v[13] ^= (t >> 64n) & MASK;
  if (last) v[14] ^= MASK;
  const g = (a, b, c, d, x, y) => {
    v[a] = (v[a] + v[b] + x) & MASK;
    v[d] = rotr(v[d] ^ v[a], 32n);
    v[c] = (v[c] + v[d]) & MASK;
    v[b] = rotr(v[b] ^ v[c], 24n);
    v[a] = (v[a] + v[b] + y) & MASK;
    v[d] = rotr(v[d] ^ v[a], 16n);
    v[c] = (v[c] + v[d]) & MASK;
    v[b] = rotr(v[b] ^ v[c], 63n);
  };
  for (let r = 0; r < 12; r++) {
    const s = SIGMA[r % 10];
    g(0, 4, 8, 12, m[s[0]], m[s[1]]);
    g(1, 5, 9, 13, m[s[2]], m[s[3]]);
    g(2, 6, 10, 14, m[s[4]], m[s[5]]);
    g(3, 7, 11, 15, m[s[6]], m[s[7]]);
    g(0, 5, 10, 15, m[s[8]], m[s[9]]);
    g(1, 6, 11, 12, m[s[10]], m[s[11]]);
    g(2, 7, 8, 13, m[s[12]], m[s[13]]);
    g(3, 4, 9, 14, m[s[14]], m[s[15]]);
  }
  for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
}

/** Unkeyed BLAKE2b with an `outLen`-byte digest (RFC 7693). */
export function blake2b(data, outLen = 64) {
  const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
  const h = [...IV];
  h[0] ^= 0x01010000n ^ BigInt(outLen);
  let t = 0n;
  let off = 0;
  // Every full block but the last is compressed as it comes; the last (even if full) closes.
  while (bytes.length - off > 128) {
    t += 128n;
    compress(h, bytes.subarray(off, off + 128), t, false);
    off += 128;
  }
  const tail = new Uint8Array(128);
  tail.set(bytes.subarray(off));
  t += BigInt(bytes.length - off);
  compress(h, tail, t, true);
  const out = new Uint8Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = Number((h[i >> 3] >> (8n * BigInt(i & 7))) & 0xffn);
  return out;
}

// ---------------------------------------------------------------- accounts

const ALPHABET = '13456789abcdefghijkmnopqrstuwxyz';
const ACCOUNT = /^(nano|xrb)_([13][13456789abcdefghijkmnopqrstuwxyz]{59})$/;

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function encode32(value, chars) {
  let s = '';
  for (let i = chars - 1; i >= 0; i--) s += ALPHABET[Number((value >> BigInt(5 * i)) & 31n)];
  return s;
}

function decode32(text) {
  let v = 0n;
  for (const ch of text) v = (v << 5n) | BigInt(ALPHABET.indexOf(ch));
  return v;
}

/** The 5-byte checksum of a public key, in the order the address writes it. */
const checksumOf = (key) => blake2b(key, 5).reverse();

/** A 32-byte public key (or any 32 bytes) as a `nano_` account. */
export function accountFromKey(key) {
  if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error('an account is 32 bytes');
  let k = 0n;
  for (const b of key) k = (k << 8n) | BigInt(b);
  let c = 0n;
  for (const b of checksumOf(key)) c = (c << 8n) | BigInt(b);
  return `nano_${encode32(k, 52)}${encode32(c, 8)}`;
}

/**
 * The public key of a `nano_` or `xrb_` account, as 32 bytes, or null if the
 * text is not one or its checksum does not match. A mistyped address that
 * still fits the alphabet fails here rather than taking payments for an
 * account nobody holds.
 */
export function accountKey(address) {
  const m = ACCOUNT.exec(String(address ?? '').trim().toLowerCase());
  if (!m) return null;
  const k = decode32(m[2].slice(0, 52));
  if (k >> 256n) return null;
  const key = new Uint8Array(32);
  for (let i = 0; i < 32; i++) key[i] = Number((k >> BigInt(8 * (31 - i))) & 0xffn);
  return BigInt(`0x${toHex(checksumOf(key))}`) === decode32(m[2].slice(52)) ? key : null;
}

/** A checksum-valid account in canonical `nano_` form, or null. */
export function canonicalAccount(address) {
  const key = accountKey(address);
  return key ? accountFromKey(key) : null;
}

// ---------------------------------------------------------------- binding

export const BINDING = 'xno-binding/v1/rep';
const ORDER_ID = /^[A-Za-z0-9_-]{22,128}$/;
const RAW = /^[1-9]\d*$/;

/** A fresh random order id: 16 bytes, base64url, 22 characters. */
export function newOrderId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Whether an order id is long and plain enough to be a secret the payer chose at random. */
export const isOrderId = (id) => typeof id === 'string' && ORDER_ID.test(id);

/** SHA-256("xno-binding/v1/rep|" + orderId + "|" + payTo + "|" + amountRaw), as 32 bytes. */
export async function orderCommitment({ orderId, payTo, amount }) {
  const text = `${BINDING}|${orderId}|${payTo}|${amount}`;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/** The representative a payer sets on its send to bind it to this order. */
export async function orderRepresentative({ orderId, payTo, amount }) {
  return accountFromKey(await orderCommitment({ orderId, payTo, amount }));
}

// ---------------------------------------------------------------- the node

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

/**
 * The node URL if it is one the gateway will read money from: https, or plain
 * http only on loopback (a node beside the gateway). Null otherwise.
 */
export function nodeUrl(url) {
  let u;
  try {
    u = new URL(String(url ?? ''));
  } catch {
    return null;
  }
  if (u.protocol === 'https:') return u.toString();
  if (u.protocol === 'http:' && LOOPBACK.test(u.hostname)) return u.toString();
  return null;
}

const MAX_BODY = 64 * 1024;

/**
 * One block as the node reports it, or `{ error }`. Bounded: a timeout and a
 * size cap on the answer, since the node is outside the gateway.
 */
export async function readBlock(hash, { rpcUrl, fetch: f = globalThis.fetch, timeoutMs = 10000 }) {
  let text;
  try {
    const res = await f(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'block_info', json_block: 'true', hash }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (err) {
    return { error: `the Nano node did not answer (${err?.name ?? 'error'})` };
  }
  if (text.length > MAX_BODY) return { error: 'the Nano node answer is too large' };
  let info;
  try {
    info = JSON.parse(text);
  } catch {
    return { error: 'the Nano node answer is not JSON' };
  }
  if (!info || typeof info !== 'object' || info.error || !info.contents) {
    return { error: `the Nano node does not know this block${info?.error ? ` (${String(info.error)})` : ''}` };
  }
  const c = info.contents;
  return {
    account: canonicalAccount(info.block_account ?? c.account),
    to: canonicalAccount(c.link_as_account),
    representative: canonicalAccount(c.representative),
    amount: String(info.amount ?? ''),
    subtype: String(info.subtype ?? ''),
    type: String(c.type ?? ''),
    confirmed: info.confirmed === true || info.confirmed === 'true',
  };
}

// ---------------------------------------------------------------- claims

/**
 * Claims in memory. For tests and for trying the flow out only: a restart
 * forgets every claim, and every block it forgot can be presented again.
 * Production uses `fileClaims` from `nano-claims-file.js`, or any store with
 * the same `claim` method backed by a table with both columns UNIQUE.
 */
export function memoryClaims() {
  const byHash = new Map();
  const byOrder = new Map();
  return {
    claim(hash, orderId, at) {
      const held = byHash.get(hash);
      if (held) return held.orderId === orderId ? { status: 'same', at: held.at } : { status: 'taken' };
      if (byOrder.has(orderId)) return { status: 'taken' };
      byHash.set(hash, { orderId, at });
      byOrder.set(orderId, hash);
      return { status: 'new', at };
    },
  };
}

// ---------------------------------------------------------------- settle

const HASH = /^[0-9A-F]{64}$/;

/**
 * Check a Nano proof against the node and claim it.
 *
 * `expected` is the offered entry's `{ amount, payTo }` for the days the proof
 * pays for. Resolves the way `verifyAndSettle` does -- `{ ok: true, payer,
 * ref, txHash, network }` or `{ ok: false, reason, replay }` -- plus
 * `claimedAt` (unix seconds) when the block is already claimed by this same
 * order, which is the payer retrying after losing the answer.
 */
export async function settleNano(payment, expected, { rpcUrl, claims, fetch: f = globalThis.fetch, now = () => Math.floor(Date.now() / 1000) }) {
  const refuse = (reason) => ({ ok: false, reason, replay: false });
  const hash = String(payment?.payload?.blockHash ?? '').toUpperCase();
  if (!HASH.test(hash)) return refuse('A Nano proof needs payload.blockHash, the 64-hex hash of the send block.');
  const orderId = payment?.payload?.orderId;
  if (!isOrderId(orderId)) {
    return refuse(`A Nano proof needs payload.orderId, the random order id (22 to 128 of A-Z a-z 0-9 _ -) the send committed to in its representative (${BINDING}).`);
  }
  const payTo = canonicalAccount(expected?.payTo);
  const amount = String(expected?.amount ?? '');
  if (!payTo || !RAW.test(amount)) return refuse('No Nano offer to hold this proof to.');

  const block = await readBlock(hash, { rpcUrl, fetch: f });
  if (block.error) return refuse(block.error);
  if (!block.confirmed) return refuse('The Nano block is not confirmed yet. Present it again once it is.');
  if (block.type !== 'state' || block.subtype !== 'send') return refuse('The Nano block is not a send.');
  if (block.to !== payTo) return refuse('The Nano block does not pay this gateway.');
  if (block.amount !== amount) return refuse(`The Nano block sends ${block.amount || 'nothing'} raw; this offer is exactly ${amount} raw.`);
  const representative = await orderRepresentative({ orderId, payTo, amount });
  if (block.representative !== representative) {
    return refuse(`The Nano block is not bound to this order: its representative must be ${representative} (${BINDING}).`);
  }

  const claim = await claims.claim(hash, orderId, now());
  if (claim?.status === 'new') {
    return { ok: true, payer: block.account, ref: hash, txHash: hash, network: 'nano' };
  }
  if (claim?.status === 'same') {
    return { ok: false, reason: 'This Nano block was already used for this order.', replay: true, claimedAt: Number(claim.at) };
  }
  return refuse('This Nano block or order id has already been used.');
}
