import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { memoryClaims, orderRepresentative, settleNano } from '../src/nano.js';
import {
  RAW_PER_XNO,
  memoryPending,
  nanoPaymentHeader,
  nanoPaymentPlan,
  payWithNano,
  pickNanoOffer,
  xnoToRaw,
} from '../src/nano-pay.js';
import { filePending } from '../src/nano-pay-file.js';
import { buildOffer, decodePayment, expectedFor, paymentRequiredHeader } from '../src/x402.js';

const PAY_TO = 'nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3';
// The key 0x01 * 32, so the payer is an account nobody is.
const PAYER = 'nano_11a3161i41a3161i41a3161i41a3161i41a3161i41a3161i41a3bqbhquyj';
const AMOUNT = String((5n * RAW_PER_XNO) / 100n); // 0.05 XNO, derived, not typed
const URL_ = 'https://site.example/page';
const RPC = 'https://node.example/rpc';
const EVM = '0x1111111111111111111111111111111111111111';

const offerWith = (nano) => buildOffer({ payTo: EVM, priceCents: 5, resource: URL_, nano });
const bound = () => offerWith({ payTo: PAY_TO, amount: AMOUNT, binding: true });

/**
 * A seller built from the gateway's own pieces (buildOffer, decodePayment,
 * expectedFor, settleNano) and a Nano node that knows the blocks the fake
 * wallet published. `confirmed` decides whether the node reports them
 * confirmed yet.
 */
function world({ claims = memoryClaims(), confirmed = true } = {}) {
  const blocks = new Map();
  const state = { confirmed, sends: 0, presented: 0 };
  let n = 0;
  const wallet = async ({ to, amountRaw, representative }) => {
    state.sends += 1;
    n += 1;
    const hash = n.toString(16).toUpperCase().padStart(64, 'A');
    blocks.set(hash, { to, amountRaw, representative });
    return hash.toLowerCase();
  };
  const fetch = async (url, init = {}) => {
    if (url === RPC) {
      const { hash } = JSON.parse(init.body);
      const b = blocks.get(hash);
      if (!b) return new Response(JSON.stringify({ error: 'Block not found' }));
      return new Response(
        JSON.stringify({
          block_account: PAYER,
          amount: b.amountRaw,
          subtype: 'send',
          confirmed: state.confirmed ? 'true' : 'false',
          contents: { type: 'state', account: PAYER, link_as_account: b.to, representative: b.representative ?? PAYER },
        }),
      );
    }
    const offer = bound();
    const proof = new Headers(init.headers ?? {}).get('payment-signature');
    if (!proof) {
      return new Response(JSON.stringify(offer), { status: 402, headers: { 'payment-required': paymentRequiredHeader(offer) } });
    }
    state.presented += 1;
    const payment = decodePayment(proof);
    const expected = expectedFor(payment, offer);
    const result = await settleNano(payment, expected, { rpcUrl: RPC, claims, fetch });
    if (result.ok || result.replay) return new Response(JSON.stringify({ ok: true, ref: result.ref ?? null }), { status: 200 });
    return new Response(JSON.stringify({ error: result.reason }), { status: 402 });
  };
  return { wallet, fetch, state, blocks };
}

describe('xnoToRaw', () => {
  it('derives raw from 10^30', () => {
    assert.equal(xnoToRaw('1'), RAW_PER_XNO.toString());
    assert.equal(xnoToRaw('0.05'), AMOUNT);
    assert.equal(xnoToRaw('0.000000000000000000000000000001'), '1');
  });
  it('refuses what is not a positive amount of at most 30 decimals', () => {
    for (const bad of ['', '0', '0.0', '-1', '1e3', 'abc', '0.0000000000000000000000000000001', ' 1.2.3']) {
      assert.throws(() => xnoToRaw(bad), undefined, bad);
    }
  });
});

describe('pickNanoOffer', () => {
  it('finds the nano entry in the body and in the PAYMENT-REQUIRED header', () => {
    const offer = bound();
    for (const from of [offer, paymentRequiredHeader(offer)]) {
      const e = pickNanoOffer(from);
      assert.equal(e.network, 'nano');
      assert.equal(e.payTo, PAY_TO);
      assert.equal(e.amount, AMOUNT);
      assert.equal(e.extra.binding, 'xno-binding/v1/rep');
    }
  });
  it('is null without a Nano entry, so a USDC-only 402 is never paid in XNO', () => {
    assert.equal(pickNanoOffer(offerWith(null)), null);
    assert.equal(pickNanoOffer('not base64 json'), null);
  });
  it('refuses a payee whose checksum fails, and a non-raw amount', () => {
    const offer = bound();
    const e = offer.accepts.find((a) => a.network === 'nano');
    e.payTo = `${PAY_TO.slice(0, -1)}4`;
    assert.equal(pickNanoOffer(offer), null);
    const again = bound();
    again.accepts.find((a) => a.network === 'nano').amount = '0.05';
    assert.equal(pickNanoOffer(again), null);
  });
});

describe('nanoPaymentPlan', () => {
  it('commits the send to the offered order, as settleNano checks it', async () => {
    const entry = pickNanoOffer(bound());
    const plan = await nanoPaymentPlan(entry, { maxRaw: xnoToRaw('0.05') });
    assert.equal(plan.orderId, entry.extra.orderId);
    assert.equal(plan.to, PAY_TO);
    assert.equal(plan.amountRaw, AMOUNT);
    assert.equal(plan.representative, await orderRepresentative({ orderId: plan.orderId, payTo: PAY_TO, amount: AMOUNT }));
  });
  it('leaves the representative to the wallet when the offer asks for no binding', async () => {
    const entry = pickNanoOffer(offerWith({ payTo: PAY_TO, amount: AMOUNT }));
    assert.equal((await nanoPaymentPlan(entry, { maxRaw: AMOUNT })).representative, null);
  });
  it('refuses an offer above maxRaw, and a missing maxRaw', async () => {
    const entry = pickNanoOffer(bound());
    await assert.rejects(nanoPaymentPlan(entry, { maxRaw: BigInt(AMOUNT) - 1n }), /more than maxRaw/);
    await assert.rejects(nanoPaymentPlan(entry, {}), /maxRaw/);
  });
});

describe('nanoPaymentHeader', () => {
  it('decodes, through the gateway, to a nano proof with the block and order', () => {
    const entry = pickNanoOffer(bound());
    const p = decodePayment(nanoPaymentHeader(entry, { blockHash: 'ab'.repeat(32), orderId: entry.extra.orderId }));
    assert.equal(p.network, 'nano');
    assert.equal(p.payload.blockHash, 'AB'.repeat(32));
    assert.equal(p.payload.orderId, entry.extra.orderId);
    assert.equal(p.payload.to, PAY_TO);
    assert.equal(p.payload.amount, AMOUNT);
  });
  it('refuses a proof with no block hash or no order id', () => {
    const entry = pickNanoOffer(bound());
    assert.throws(() => nanoPaymentHeader(entry, { blockHash: 'xyz', orderId: entry.extra.orderId }));
    assert.throws(() => nanoPaymentHeader(entry, { blockHash: 'AB'.repeat(32), orderId: 'short' }));
  });
});

describe('payWithNano', () => {
  it('pays the 402 once and gets the page, settled by the gateway against the node', async () => {
    const w = world();
    const res = await payWithNano(URL_, { send: w.wallet, maxRaw: xnoToRaw('0.05'), fetch: w.fetch });
    assert.equal(res.status, 200);
    assert.equal(w.state.sends, 1);
    assert.match((await res.json()).ref, /^[0-9A-F]{64}$/);
  });

  it('sends nothing when the offer is over budget', async () => {
    const w = world();
    await assert.rejects(payWithNano(URL_, { send: w.wallet, maxRaw: xnoToRaw('0.01'), fetch: w.fetch }), /more than maxRaw/);
    assert.equal(w.state.sends, 0);
  });

  it('after a restart, presents the block it already sent instead of paying again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nano-pay-'));
    const path = join(dir, 'pending.log');
    const w = world({ confirmed: false });
    const first = await payWithNano(URL_, { send: w.wallet, maxRaw: AMOUNT, fetch: w.fetch, pending: filePending(path) });
    assert.equal(first.status, 402);
    assert.match((await first.json()).error, /not confirmed/);
    assert.equal(filePending(path).get(URL_).blockHash.length, 64);

    w.state.confirmed = true;
    const second = await payWithNano(URL_, { send: w.wallet, maxRaw: AMOUNT, fetch: w.fetch, pending: filePending(path) });
    assert.equal(second.status, 200);
    assert.equal(w.state.sends, 1, 'one block, presented twice');
    assert.equal(filePending(path).get(URL_), null, 'settled, so nothing is pending');
  });

  it('refuses to send again when a send was started and its hash never recorded', async () => {
    const pending = memoryPending();
    const w = world();
    const dies = async () => {
      throw new Error('process died mid-send');
    };
    await assert.rejects(payWithNano(URL_, { send: dies, maxRaw: AMOUNT, fetch: w.fetch, pending }), /mid-send/);
    await assert.rejects(payWithNano(URL_, { send: w.wallet, maxRaw: AMOUNT, fetch: w.fetch, pending }), /never recorded/);
    assert.equal(w.state.sends, 0);
  });

  it('a block presented for another order is refused by the gateway', async () => {
    const w = world();
    // A wallet that ignores the commitment it was given.
    const careless = async (s) => w.wallet({ ...s, representative: PAYER });
    const res = await payWithNano(URL_, { send: careless, maxRaw: AMOUNT, fetch: w.fetch });
    assert.equal(res.status, 402);
    assert.match((await res.json()).error, /not bound to this order/);
  });

  it('a 402 without a Nano entry sends nothing', async () => {
    const fetch = async () => new Response(JSON.stringify(offerWith(null)), { status: 402 });
    let sends = 0;
    await assert.rejects(payWithNano(URL_, { send: async () => (sends += 1), maxRaw: AMOUNT, fetch }), /no Nano/);
    assert.equal(sends, 0);
  });
});

describe('filePending', () => {
  it('reads back puts and deletes, and skips a torn last line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nano-pay-file-'));
    const path = join(dir, 'pending.log');
    const a = filePending(path);
    a.put('k1', { orderId: 'o1', blockHash: null });
    a.put('k1', { orderId: 'o1', blockHash: 'AB'.repeat(32) });
    a.put('k2', { orderId: 'o2', blockHash: null });
    a.delete('k2');
    appendFileSync(path, '{"key":"k3","value":{"ord');
    const b = filePending(path);
    assert.equal(b.size, 1);
    assert.equal(b.get('k1').blockHash, 'AB'.repeat(32));
    assert.equal(b.get('k2'), null);
    assert.equal(b.get('k3'), null);
  });
});
