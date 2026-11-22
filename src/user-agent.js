/**
 * Every request the gateway makes on its own behalf (CoinPay verify/settle,
 * hosted checkout, the bot-hit report, a Nano node) names the site it runs for.
 *
 * Without this the runtime default goes out ('Bun/1.4.4', 'node',
 * 'Next.js Middleware'), so CoinPay sees dozens of sites on one host as one
 * anonymous caller and its logs cannot say which one is misbehaving.
 */

export const VERSION = '0.18.2';

const env = (name) => {
  try {
    const v = globalThis.process?.env?.[name];
    return typeof v === 'string' && v.trim() ? v.trim() : '';
  } catch {
    return '';
  }
};

/**
 * `<host>/<app version> (+<siteUrl>) x402-gateway/<v>`. The app version comes
 * from npm/bun run (`npm_package_version`) and is left out when unknown.
 * `X402_USER_AGENT` or `COINPAY_USER_AGENT` replace it whole.
 */
export function defaultUserAgent(siteUrl) {
  const override = env('X402_USER_AGENT') || env('COINPAY_USER_AGENT');
  if (override) return override;
  let host = 'unknown-site';
  try {
    host = new URL(siteUrl).hostname || host;
  } catch {}
  const appVersion = env('npm_package_version');
  const product = appVersion ? `${host}/${appVersion}` : host;
  return `${product} (+${siteUrl}) x402-gateway/${VERSION}`;
}

/**
 * Wrap a fetch so each call carries `userAgent` unless the caller set one.
 * Plain-object headers stay plain objects, so a test fetch can still read
 * `init.headers.authorization`.
 */
export function withUserAgent(f, userAgent) {
  if (typeof f !== 'function' || !userAgent) return f;
  const wrapped = (input, init = {}) => {
    const h = init.headers;
    if (h && typeof h.has === 'function') {
      if (h.has('user-agent')) return f(input, init);
      const copy = new Headers(h);
      copy.set('user-agent', userAgent);
      return f(input, { ...init, headers: copy });
    }
    const obj = Array.isArray(h) ? Object.fromEntries(h) : { ...(h ?? {}) };
    if (Object.keys(obj).some((k) => k.toLowerCase() === 'user-agent')) return f(input, init);
    return f(input, { ...init, headers: { ...obj, 'user-agent': userAgent } });
  };
  return wrapped;
}
