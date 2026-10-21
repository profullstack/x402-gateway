/**
 * The human way in: a day pass bought through CoinPay's hosted checkout.
 *
 * An x402 proof needs a wallet that signs EIP-3009, which is a program's
 * tool. A person who landed on the sales page wants a button: pay with any
 * coin CoinPay takes, or PayPal, and get the same pass the x402 path mints.
 *
 * CoinPay hosts the payment (`POST /api/checkout/sessions` -> `{ id, url }`),
 * and the gateway stays stateless: the session id rides in a signed cookie to
 * the return page, the return page asks CoinPay whether that session is paid,
 * and the pass is minted from what CoinPay answers. Nothing the buyer's
 * browser says is believed about money.
 *
 * The endpoint is new, so its absence is expected: `available()` probes it
 * and the sales page shows the button only when it answers.
 */

const PAID = new Set(['paid', 'complete', 'completed', 'succeeded', 'success', 'confirmed', 'settled', 'forwarded']);
const DEAD = new Set(['expired', 'cancelled', 'canceled', 'failed', 'void', 'voided', 'refunded']);

/** How long a probe answer is believed, by outcome. */
const PROBE_TTL_UP = 10 * 60 * 1000;
const PROBE_TTL_DOWN = 5 * 60 * 1000;

/** Probe answers shared by every gateway in the process that talks to one CoinPay. */
const probes = new Map();

/** A CoinPay checkout session id as the gateway will accept one: short, URL-safe. */
export const isSessionId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{6,128}$/.test(id);

/** Whether a string looks like an email address, enough to send a receipt to. */
export const isEmail = (s) => typeof s === 'string' && s.length <= 254 && /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(s);

/**
 * @param {object} args
 * @param {string} args.apiKey
 * @param {string} args.baseUrl
 * @param {typeof fetch} [args.fetch]
 */
export function checkoutClient({ apiKey, baseUrl, fetch: f = globalThis.fetch }) {
  const root = `${baseUrl}/api/checkout/sessions`;
  const headers = { authorization: `Bearer ${apiKey}`, accept: 'application/json' };

  const readJson = async (res) => {
    try {
      return JSON.parse(await res.text());
    } catch {
      return {};
    }
  };

  /** Mark the endpoint as missing, so the button hides until the next probe. */
  const markDown = () => probes.set(root, { ok: false, at: Date.now() });

  return {
    /**
     * Whether CoinPay serves checkout sessions yet. A 404 means the route is
     * not deployed; any other answer below 500 (401, 405, 200) means it is.
     * Errors and timeouts read as "not now" without being cached for long.
     */
    async available() {
      const hit = probes.get(root);
      const now = Date.now();
      if (hit && now - hit.at < (hit.ok ? PROBE_TTL_UP : PROBE_TTL_DOWN)) return hit.ok;
      let ok = false;
      try {
        const res = await f(root, { method: 'GET', headers, signal: AbortSignal.timeout(3000) });
        ok = res.status !== 404 && res.status < 500;
        if (res.status >= 500) {
          // Up but unwell: believe it for a minute, not ten.
          probes.set(root, { ok: false, at: now - PROBE_TTL_DOWN + 60_000 });
          return false;
        }
      } catch {
        probes.set(root, { ok: false, at: now - PROBE_TTL_DOWN + 60_000 });
        return false;
      }
      probes.set(root, { ok, at: now });
      return ok;
    },

    /** The last probe answer without asking again: for a renderer that cannot wait. */
    known() {
      return probes.get(root)?.ok ?? false;
    },

    /**
     * Create a session. Resolves to `{ ok: true, id, url }`, or
     * `{ ok: false, status, missing, reason }` where `missing` means the
     * endpoint is not deployed.
     */
    async create(body) {
      let res;
      try {
        res = await f(root, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15000),
        });
      } catch (err) {
        return { ok: false, status: 0, missing: false, reason: String(err?.message ?? err) };
      }
      const json = await readJson(res);
      if (res.status === 404) {
        markDown();
        return { ok: false, status: 404, missing: true, reason: 'checkout sessions are not available' };
      }
      const s = json?.session ?? json?.data ?? json;
      const id = s?.id ?? s?.session_id ?? s?.checkout_session_id;
      const url = s?.url ?? s?.checkout_url ?? s?.hosted_url;
      if (!res.ok || !isSessionId(String(id ?? '')) || !/^https:\/\//.test(String(url ?? ''))) {
        return { ok: false, status: res.status, missing: false, reason: String(json?.error ?? `checkout failed (${res.status})`) };
      }
      return { ok: true, id: String(id), url: String(url) };
    },

    /** Read a session back from CoinPay. Null when it cannot be read. */
    async get(id) {
      if (!isSessionId(id)) return null;
      try {
        const res = await f(`${root}/${encodeURIComponent(id)}`, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) return null;
        const json = await readJson(res);
        const s = json?.session ?? json?.data ?? json;
        return s && typeof s === 'object' ? s : null;
      } catch {
        return null;
      }
    },
  };
}

const toSeconds = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Date.parse(String(v));
  if (!Number.isFinite(n)) return null;
  // A number below 10^11 is already seconds; anything larger is milliseconds.
  return Math.floor(n < 1e11 ? n : n / 1000);
};

/**
 * What a session says, normalised: whether it is paid, still open, or dead,
 * how much it was for, when it was paid, and who and where it was for.
 *
 * `amount` is read in dollars (the unit the session was created in) unless
 * the session also names `amount_cents`.
 */
export function sessionState(session) {
  const status = String(session?.status ?? session?.payment_status ?? '').toLowerCase();
  const paid = session?.paid === true || PAID.has(status);
  const dead = !paid && DEAD.has(status);
  const metadata = session?.metadata && typeof session.metadata === 'object' ? session.metadata : {};
  let cents = null;
  if (Number.isFinite(Number(session?.amount_cents))) cents = Math.round(Number(session.amount_cents));
  else if (session?.amount !== undefined && Number.isFinite(Number(session.amount))) cents = Math.round(Number(session.amount) * 100);
  const currency = String(session?.currency ?? 'USD').toUpperCase();
  const paidAt =
    toSeconds(session?.paid_at) ??
    toSeconds(session?.completed_at) ??
    toSeconds(session?.confirmed_at) ??
    toSeconds(session?.updated_at) ??
    toSeconds(session?.created_at);
  return {
    id: session?.id ? String(session.id) : null,
    status,
    paid,
    dead,
    cents,
    currency,
    paidAt,
    property: session?.property ?? metadata.property ?? null,
    email: session?.customer_email ?? metadata.customer_email ?? null,
    accountId: session?.account_id ?? metadata.account_id ?? null,
    metadata,
  };
}

/**
 * The session id a CoinPay webhook is about. Webhook bodies are nested
 * (`{ id: <event>, type, data: { ... } }`), so the top-level `id` is the
 * EVENT and is never taken for the session.
 */
export function sessionIdFromWebhook(body) {
  const candidates = [
    body?.checkout_session_id,
    body?.data?.checkout_session_id,
    body?.data?.session_id,
    body?.data?.object?.checkout_session_id,
    body?.data?.object?.id,
    body?.data?.id,
  ];
  for (const c of candidates) if (isSessionId(String(c ?? ''))) return String(c);
  return null;
}
