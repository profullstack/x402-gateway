import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  accountFromKey,
  accountKey,
  blake2b,
  canonicalAccount,
  isOrderId,
  memoryClaims,
  newOrderId,
  nodeUrl,
  orderCommitment,
  orderRepresentative,
  readBlock,
  settleNano,
} from '../src/nano.js';
import { fileClaims } from '../src/nano-claims-file.js';

const hex = (bytes) => Buffer.from(bytes).toString('hex');

// The all-zero key: the burn account, which every Nano tool prints the same way.
const BURN = 'nano_1111111111111111111111111111111111111111111111111111hifc8npp';
const PAY_TO = 'nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3';
// The key 0x01 * 32, so the payer is an account nobody is.
const PAYER = 'nano_11a3161i41a3161i41a3161i41a3161i41a3161i41a3161i41a3bqbhquyj';
const XNO = 10n ** 30n;
const AMOUNT = String((5n * XNO) / 100n); // 0.05 XNO, derived, not typed
const ORDER = 'Qm9yZGVyLWlkLWZvci10ZXN0cw';
const HASH = 'B'.repeat(64);

describe('BLAKE2b', () => {
  it('matches RFC 7693 for "abc"', () => {
    assert.equal(
      hex(blake2b('abc')),
      'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923',
    );
  });
  it('closes a message that is exactly one block, and one that spans two', () => {
    // Independent value: Python's hashlib.blake2b(b"a" * n).hexdigest()[:16].
    assert.equal(hex(blake2b('a'.repeat(128))).slice(0, 16), 'fc6c71f688f43ea7');
    assert.equal(hex(blake2b('a'.repeat(129))).slice(0, 16), '55e6e0eb418149a8');
  });
});

describe('Nano accounts', () => {
  it('encodes the all-zero key as the burn account', () => {
    assert.equal(accountFromKey(new Uint8Array(32)), BURN);
    assert.equal(hex(accountKey(BURN)), '00'.repeat(32));
  });
  it('round-trips a real account and its xrb_ spelling', () => {
    const key = accountKey(PAY_TO);
    assert.ok(key);
    assert.equal(accountFromKey(key), PAY_TO);
    assert.equal(canonicalAccount(`xrb_${PAY_TO.slice(5)}`), PAY_TO);
    assert.equal(canonicalAccount(PAY_TO.toUpperCase()), PAY_TO);
  });
  it('refuses an address whose checksum does not match', () => {
    // One character of the key changed: still the right alphabet and length.
    const typo = `${PAY_TO.slice(0, 10)}${PAY_TO[10] === '5' ? '6' : '5'}${PAY_TO.slice(11)}`;
    assert.equal(accountKey(typo), null);
    assert.equal(canonicalAccount(`${PAY_TO.slice(0, -1)}${PAY_TO.endsWith('3') ? '4' : '3'}`), null);
    assert.equal(canonicalAccount('nano_123'), null);
    assert.equal(canonicalAccount(''), null);
  });
});

describe('order binding (xno-binding v1, representative)', () => {
  it('reproduces the published test vector', async () => {
    const v = { orderId: 'order-0001', payTo: BURN, amount: '50000000000000000000000000000' };
    assert.equal(v.amount, String((5n * XNO) / 100n));
    assert.equal(hex(await orderCommitment(v)), '86e75a339b908cc926a478c1a0e5eb5dd6fc612c1d3251eb661faa78135c36cf');
    assert.equal(await orderRepresentative(v), 'nano_33q9dassq66es6mcay83n5kypqgpzjikr9bkc9ope9xch1borfphgehj4ozj');
  });
  it('changes with the order, the payee and the amount', async () => {
    const base = await orderRepresentative({ orderId: ORDER, payTo: PAY_TO, amount: AMOUNT });
    assert.notEqual(await orderRepresentative({ orderId: `${ORDER}x`, payTo: PAY_TO, amount: AMOUNT }), base);
    assert.notEqual(await orderRepresentative({ orderId: ORDER, payTo: BURN, amount: AMOUNT }), base);
    assert.notEqual(await orderRepresentative({ orderId: ORDER, payTo: PAY_TO, amount: `${AMOUNT}0` }), base);
  });
  it('makes random order ids long enough to be a secret, and refuses short ones', () => {
    const a = newOrderId();
    assert.ok(isOrderId(a));
    assert.notEqual(a, newOrderId());
    assert.equal(isOrderId('order-0001'), false);
    assert.equal(isOrderId(`${ORDER} `), false);
    assert.equal(isOrderId(undefined), false);
  });
});

describe('node URL', () => {
  it('takes https anywhere and http only on loopback', () => {
    assert.equal(nodeUrl('https://node.example/rpc'), 'https://node.example/rpc');
    assert.equal(nodeUrl('http://127.0.0.1:7076'), 'http://127.0.0.1:7076/');
    assert.equal(nodeUrl('http://localhost:7076'), 'http://localhost:7076/');
    assert.equal(nodeUrl('http://node.example/rpc'), null);
    assert.equal(nodeUrl('ftp://node.example'), null);
    assert.equal(nodeUrl(''), null);
  });
});

/** A node that knows one block, and counts the reads. */
async function nodeWith(over = {}) {
  const representative = over.representative ?? (await orderRepresentative({ orderId: ORDER, payTo: PAY_TO, amount: AMOUNT }));
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.hash !== HASH) return new Response(JSON.stringify({ error: 'Block not found' }));
    return new Response(
      JSON.stringify({
        block_account: PAYER,
        amount: over.amount ?? AMOUNT,
        confirmed: over.confirmed ?? 'true',
        subtype: over.subtype ?? 'send',
        contents: {
          type: 'state',
          account: PAYER,
          representative,
          link_as_account: over.to ?? PAY_TO,
        },
      }),
    );
  };
  return { fetch, calls };
}

const proof = (extra = {}) => ({ network: 'nano', payload: { blockHash: HASH, orderId: ORDER, ...extra } });
const expected = { amount: AMOUNT, payTo: PAY_TO };

describe('settleNano', () => {
  it('reads block_info from the configured node and accepts a bound, confirmed, exact send', async () => {
    const node = await nodeWith();
    const r = await settleNano(proof(), expected, { rpcUrl: 'https://node.test', claims: memoryClaims(), fetch: node.fetch, now: () => 100 });
    assert.deepEqual(r, { ok: true, payer: PAYER, ref: HASH, txHash: HASH, network: 'nano' });
    assert.deepEqual(node.calls[0], { action: 'block_info', json_block: 'true', hash: HASH });
  });
  it('accepts a lower-case block hash as the same block', async () => {
    const node = await nodeWith();
    const r = await settleNano(proof({ blockHash: HASH.toLowerCase() }), expected, { rpcUrl: 'https://node.test', claims: memoryClaims(), fetch: node.fetch });
    assert.equal(r.ok, true);
  });
  it('refuses a block hash presented without its order id, or with another one', async () => {
    const node = await nodeWith();
    const opts = { rpcUrl: 'https://node.test', claims: memoryClaims(), fetch: node.fetch };
    assert.match((await settleNano(proof({ orderId: undefined }), expected, opts)).reason, /orderId/);
    const other = await settleNano(proof({ orderId: `${ORDER}-other` }), expected, opts);
    assert.equal(other.ok, false);
    assert.match(other.reason, /not bound to this order/);
  });
  it('refuses unconfirmed, wrong payee, short, over and non-send blocks', async () => {
    const cases = [
      [{ confirmed: 'false' }, /not confirmed/],
      [{ to: BURN }, /does not pay this gateway/],
      [{ amount: String(BigInt(AMOUNT) - 1n) }, /exactly/],
      [{ amount: String(BigInt(AMOUNT) + 1n) }, /exactly/],
      [{ subtype: 'receive' }, /not a send/],
    ];
    for (const [over, reason] of cases) {
      const node = await nodeWith(over);
      const r = await settleNano(proof(), expected, { rpcUrl: 'https://node.test', claims: memoryClaims(), fetch: node.fetch });
      assert.equal(r.ok, false, JSON.stringify(over));
      assert.match(r.reason, reason);
    }
  });
  it('refuses a block the node does not know, and a node that does not answer', async () => {
    const node = await nodeWith();
    const r = await settleNano(proof({ blockHash: 'C'.repeat(64) }), expected, { rpcUrl: 'https://node.test', claims: memoryClaims(), fetch: node.fetch });
    assert.match(r.reason, /does not know this block/);
    const down = await readBlock(HASH, { rpcUrl: 'https://node.test', fetch: async () => { throw new TypeError('fetch failed'); } });
    assert.match(down.error, /did not answer/);
    const huge = await readBlock(HASH, { rpcUrl: 'https://node.test', fetch: async () => new Response('x'.repeat(70000)) });
    assert.match(huge.error, /too large/);
  });
  it('credits a block once: the same order again is a replay, another order is refused', async () => {
    const node = await nodeWith();
    const claims = memoryClaims();
    const opts = { rpcUrl: 'https://node.test', claims, fetch: node.fetch, now: () => 100 };
    assert.equal((await settleNano(proof(), expected, opts)).ok, true);
    const again = await settleNano(proof(), expected, { ...opts, now: () => 200 });
    assert.equal(again.ok, false);
    assert.equal(again.replay, true);
    assert.equal(again.claimedAt, 100);
    // The same order id on a second block is a second payment for one order: refused, not credited.
    assert.deepEqual(claims.claim('D'.repeat(64), ORDER, 300), { status: 'taken' });
  });
  it('refuses a malformed hash before reading the node', async () => {
    const node = await nodeWith();
    const r = await settleNano(proof({ blockHash: 'xyz' }), expected, { rpcUrl: 'https://node.test', claims: memoryClaims(), fetch: node.fetch });
    assert.match(r.reason, /blockHash/);
    assert.equal(node.calls.length, 0);
  });
});

describe('fileClaims', () => {
  const fresh = () => join(mkdtempSync(join(tmpdir(), 'nano-claims-')), 'claims.log');

  it('keeps a claim across a restart', async () => {
    const path = fresh();
    const node = await nodeWith();
    const first = await settleNano(proof(), expected, { rpcUrl: 'https://node.test', claims: fileClaims(path), fetch: node.fetch, now: () => 100 });
    assert.equal(first.ok, true);
    // A new process: a new store over the same file.
    const after = await settleNano(proof(), expected, { rpcUrl: 'https://node.test', claims: fileClaims(path), fetch: node.fetch, now: () => 500 });
    assert.equal(after.ok, false);
    assert.equal(after.replay, true);
    assert.equal(after.claimedAt, 100);
    assert.match(readFileSync(path, 'utf8'), new RegExp(`${HASH} ${ORDER} 100`));
  });
  it('holds each hash and each order id once', () => {
    const claims = fileClaims(fresh());
    assert.equal(claims.claim(HASH, ORDER, 1).status, 'new');
    assert.equal(claims.claim(HASH, ORDER, 2).status, 'same');
    assert.equal(claims.claim(HASH, `${ORDER}-b`, 3).status, 'taken');
    assert.equal(claims.claim('E'.repeat(64), ORDER, 4).status, 'taken');
    assert.equal(claims.size, 1);
  });
  it('skips a torn last line and still appends cleanly after it', () => {
    const path = fresh();
    fileClaims(path).claim(HASH, ORDER, 1);
    appendFileSync(path, 'FFFF partial');
    const claims = fileClaims(path);
    assert.equal(claims.size, 1);
    assert.equal(claims.claim('F'.repeat(64), `${ORDER}-c`, 2).status, 'new');
    assert.equal(fileClaims(path).size, 2);
  });
  it('starts empty when the file does not exist yet', () => {
    assert.equal(fileClaims(fresh()).size, 0);
    assert.throws(() => fileClaims(''), /needs a path/);
  });
});
