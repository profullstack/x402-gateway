/**
 * Passes: what a payment buys.
 *
 * A pass is a signed, self-describing token -- `cp_<payload>.<signature>` --
 * carrying its own expiry and the reference of the payment that bought it.
 * There is no table behind it. The gateway runs in front of six sites on two
 * frameworks, some of them at the edge with no database in reach, and a token
 * that proves itself needs none of them to agree on a schema.
 *
 * HMAC-SHA256 over Web Crypto, which is what Node, Bun and every edge runtime
 * have in common. The key defaults to the CoinPay API key: it is already the
 * one secret every deployment holds, and using it as key material never sends
 * it anywhere.
 */

const enc = new TextEncoder();

function toBase64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s) {
  const bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

async function sign(secret, data) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return toBase64Url(new Uint8Array(sig));
}

/** Constant-time compare of two short strings. */
function same(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Mint a pass.
 *
 * @param {object} args
 * @param {string} args.secret
 * @param {string|null} args.ref   payment reference, for the accounting question
 * @param {number} args.expiresAt  unix seconds
 * @param {number} [args.now]      unix seconds, for tests
 */
export async function mintPass({ secret, ref, expiresAt, now = Math.floor(Date.now() / 1000) }) {
  if (!secret) throw new Error('a pass needs a signing secret');
  if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new Error('a pass needs a future expiry');
  const payload = toBase64Url(enc.encode(JSON.stringify({ v: 1, iat: now, exp: Math.floor(expiresAt), ref: ref ?? null })));
  const sig = await sign(secret, payload);
  return { token: `cp_${payload}.${sig}`, expiresAt: Math.floor(expiresAt), ref: ref ?? null };
}

/**
 * Read a pass. Resolves to `{ exp, iat, ref }` when the signature holds and the
 * pass has not expired, null otherwise. Never throws on garbage input: a token
 * is untrusted text from a crawler.
 */
export async function readPass(token, { secret, now = Math.floor(Date.now() / 1000) }) {
  if (!secret || typeof token !== 'string' || !token.startsWith('cp_')) return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const payload = token.slice(3, dot);
  const sig = token.slice(dot + 1);
  if (!payload || !sig) return null;
  try {
    const expect = await sign(secret, payload);
    if (!same(expect, sig)) return null;
    const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
    if (!claims || claims.v !== 1 || !Number.isFinite(claims.exp)) return null;
    if (claims.exp <= now) return null;
    return { exp: claims.exp, iat: claims.iat ?? null, ref: claims.ref ?? null };
  } catch {
    return null;
  }
}
