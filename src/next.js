import { createGateway } from './index.js';

/**
 * The gateway for Next.js, in `proxy.ts` (Next 16) or `middleware.ts` (earlier).
 *
 *   import { x402Proxy } from '@profullstack/x402-gateway/next';
 *   export const proxy = x402Proxy({ siteUrl, coinpay: { apiKey }, payTo });
 *   export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
 *
 * Returning `undefined` from a Next proxy means "carry on", which is what the
 * gateway's null becomes. When the app already has a proxy for something
 * else, compose: `const answer = await gate(request); if (answer) return answer;`
 * and then do whatever it did before. Runs at the edge: nothing here imports
 * node:, and the pass is verified with Web Crypto rather than a database.
 */
export function x402Proxy(gatewayOrOptions) {
  const gateway =
    gatewayOrOptions && typeof gatewayOrOptions.handle === 'function'
      ? gatewayOrOptions
      : createGateway(gatewayOrOptions);
  return async (request) => (await gateway.handle(request)) ?? undefined;
}

/**
 * A Route Handler for `app/robots.txt/route.js`, so robots.txt and the gateway
 * are generated from one set of lists.
 *
 *   import { robotsRoute } from '@profullstack/x402-gateway/next';
 *   export const GET = robotsRoute(gateway, { disallow: ['/login', '/api/'] });
 */
export function robotsRoute(gateway, extra = {}) {
  return () =>
    new Response(gateway.robotsTxt(extra), {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
}
