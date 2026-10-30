# Premier Developer Access for agents

This example shows both sides of the automated $29/30-day workflow:

1. `route.ts` returns an x402 offer and turns a settled payment into a fleet-wide Power Key in the same response.
2. `renew.mjs` lets an agent schedule another x402 payment shortly before its current key expires, then updates its own secret store.

The buyer keeps the wallet signer. CoinPay checks an agent wallet's budget before it settles an x402 v2 payment. A declined payment leaves the current key unchanged until its expiration.

## One-time CoinPay setup

Register the agent EVM address with a CoinPay API key that has the `payouts:create` scope. Set limits in USD; a per-payment limit cannot exceed the daily limit, and the daily limit cannot exceed the total limit. For example, a $29 per-payment and daily limit allows at most one renewal payment in a rolling 24-hour window:

```sh
curl -X POST https://coinpayportal.com/api/v1/agents \
  -H "x-api-key: $COINPAY_AGENT_ADMIN_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "name": "profullstack-access",
    "address": "0xYOUR_AGENT_WALLET_ADDRESS",
    "perPaymentLimitUsd": 29,
    "dailyLimitUsd": 29,
    "totalLimitUsd": 348
  }'
```

The example total limit allows up to twelve payments. Choose the limit that fits the wallet owner's budget. Keep funds in the supported payment asset and run payments through CoinPay's x402 v2 settlement; direct wallet transfers bypass CoinPay's agent budget checks.

## Deploy the checkout route

Copy `route.ts` into a Next.js route at `app/api/shop/agent/route.ts` and install `@profullstack/x402-gateway` plus `@profullstack/keys`. Configure these server-side environment variables:

| Variable | Purpose |
| --- | --- |
| `COINPAY_X402_KEY` | CoinPay merchant API key used to verify and settle x402 payments |
| `CRAWL_PAY_TO` | EVM address that receives the $29 payment |
| `POWER_KEY_PRIVATE_KEY` | Ed25519 private key that signs the returned access key |
| `SITE_URL` | Canonical site origin |

Never expose `COINPAY_X402_KEY` or `POWER_KEY_PRIVATE_KEY` in browser code.

## Client renewal

Pass `x402fetch` from `@profullstack/coinpay`, the agent's EVM signer, and a secret-store adapter to `ensurePremierAccess`. Call it before making a request to a Profullstack service. It reuses the saved key while it is valid, then pays only when the key is within five minutes of expiration.

```js
import { x402fetch } from '@profullstack/coinpay';
import { ensurePremierAccess } from './renew.mjs';

const access = await ensurePremierAccess({
  x402fetch,
  signer: agentSigner,
  secretStore: agentSecretStore,
});

const response = await fetch('https://nichedb.dev/', {
  headers: { authorization: `Bearer ${access.key}` },
});
```

This is a new, separately budget-checked x402 payment for each 30-day term. The checkout does not save a card or create a recurring debit.
