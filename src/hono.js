import { createGateway } from './index.js';

/**
 * The gateway as Hono middleware.
 *
 *   import { x402Gateway } from '@profullstack/x402-gateway/hono';
 *   app.use('*', x402Gateway({ siteUrl, coinpay: { apiKey }, payTo }));
 *
 * Register it before the routes and after any outright user-agent block: a
 * crawler that is refused everywhere should not be sold anything. Takes either
 * options or a gateway already created with `createGateway`, so an app can
 * keep the gateway around for `robotsTxt()` and `page()`.
 */
export function x402Gateway(gatewayOrOptions) {
  const gateway =
    gatewayOrOptions && typeof gatewayOrOptions.handle === 'function'
      ? gatewayOrOptions
      : createGateway(gatewayOrOptions);
  return async (c, next) => {
    const answer = await gateway.handle(c.req.raw);
    if (answer) return answer;
    await next();
  };
}
