'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('@stellar/stellar-sdk');
const { defineTenant } = require('../src/tenant');
const { NETWORKS } = require('../src/stellar/networks');
const { validateSignedTransaction, buildPayoutTransactions, submitSignedTransactions } = require('../src/payouts/transactions');

const ISSUER = NETWORKS.mainnet.usdcIssuer;
const PAYER = sdk.Keypair.random();
const W1 = sdk.Keypair.random().publicKey();
const FOREIGN = sdk.Keypair.random().publicKey();
const USDC = new sdk.Asset('USDC', ISSUER);
const OTHER = new sdk.Asset('USDC', NETWORKS.testnet.usdcIssuer);

function tx(source, ops, sign = true, passphrase = sdk.Networks.PUBLIC) {
  const b = new sdk.TransactionBuilder(new sdk.Account(source, '1'), { fee: '100', networkPassphrase: passphrase });
  ops.forEach((o) => b.addOperation(o));
  const t = b.setTimeout(60).build();
  if (sign) t.sign(sdk.Keypair.random()); // any signature: the network judges its validity
  return t;
}
const pay = (dest, asset = USDC) => sdk.Operation.payment({ destination: dest, asset, amount: '1' });
const ctx = (extra = {}) => ({ expectedIssuer: ISSUER, registeredWallets: new Set([W1]), expectedPayer: PAYER.publicKey(), network: 'mainnet', ...extra });

// ── validateSignedTransaction ───────────────────────────────────────────────
test('accepts reward asset payments to registered wallets from the payer', () => {
  assert.equal(validateSignedTransaction(tx(PAYER.publicKey(), [pay(W1)]), ctx()).length, 1);
});

test('rejects destinations that are not registered wallets', () => {
  assert.throws(() => validateSignedTransaction(tx(PAYER.publicKey(), [pay(W1), pay(FOREIGN)]), ctx()), /not registered wallets/);
});

test('rejects another issuer and non-payment operations', () => {
  assert.throws(() => validateSignedTransaction(tx(PAYER.publicKey(), [pay(W1, OTHER)]), ctx()), /expected asset/);
  assert.throws(() => validateSignedTransaction(tx(PAYER.publicKey(), [sdk.Operation.manageData({ name: 'x', value: 'y' })]), ctx()), /expected asset/);
});

test('mainnet: rejects a signer that is not the registered payer; testnet does not require it', () => {
  assert.throws(() => validateSignedTransaction(tx(FOREIGN, [pay(W1)]), ctx()), /not the registered payer/);
  assert.equal(validateSignedTransaction(tx(FOREIGN, [pay(W1)]), ctx({ network: 'testnet' })).length, 1);
});

test('rejects unsigned transactions and transactions without operations', () => {
  assert.throws(() => validateSignedTransaction(tx(PAYER.publicKey(), [pay(W1)], false), ctx()), /not signed/);
  assert.throws(() => validateSignedTransaction(tx(PAYER.publicKey(), [], false), ctx()), /no operations/);
});

// ── buildPayoutTransactions / submitSignedTransactions with a fake Horizon ──
const tenant = defineTenant({
  id: 'tenant-a', network: 'mainnet', rpcUrl: 'https://rpc.invalid',
  payouts: { payerWallet: PAYER.publicKey(), caps: { perPerson: 100, perBatch: 10_000 } },
});
const trustline = (amount = '0') => ({ asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: ISSUER, balance: amount });

function fakeHorizon(accounts) {
  const submitted = [];
  return {
    submitted,
    loadAccount: async (id) => {
      const a = accounts[id];
      if (!a) { const e = new Error('Not Found'); e.response = { status: 404 }; throw e; }
      const acc = new sdk.Account(id, '100');
      acc.balances = a;
      return acc;
    },
    submitTransaction: async (t) => { submitted.push(t); return { hash: t.hash().toString('hex'), ledger: 42 }; },
  };
}

test('build: skips recipients that cannot receive, batches 20 payments per transaction', async () => {
  const recipients = Array.from({ length: 25 }, () => sdk.Keypair.random().publicKey());
  const noTrust = sdk.Keypair.random().publicKey();
  const missing = sdk.Keypair.random().publicKey();
  const accounts = { [PAYER.publicKey()]: [trustline('1000')], [noTrust]: [] };
  for (const r of recipients) accounts[r] = [trustline()];
  const payments = [...recipients, noTrust, missing].map((wallet) => ({ wallet, amount: 2 }));

  const out = await buildPayoutTransactions({ tenant, payer: PAYER.publicKey(), payments, memo: 'campaign 1', horizon: fakeHorizon(accounts) });
  assert.equal(out.xdrs.length, 2);
  assert.equal(out.ready.length, 25);
  assert.deepEqual(out.skipped.map((s) => s.reason).sort(), ['account does not exist on mainnet', 'no trustline for the reward asset']);
  assert.equal(out.total, 50);
  const first = sdk.TransactionBuilder.fromXDR(out.xdrs[0], tenant.networkPassphrase);
  const second = sdk.TransactionBuilder.fromXDR(out.xdrs[1], tenant.networkPassphrase);
  assert.equal(first.operations.length, 20);
  assert.equal(second.operations.length, 5);
  assert.equal(BigInt(second.sequence), BigInt(first.sequence) + 1n);
});

test('build: refuses an unexpected payer on mainnet, caps and insufficient balance', async () => {
  const r = sdk.Keypair.random().publicKey();
  const h = fakeHorizon({ [PAYER.publicKey()]: [trustline('5')], [r]: [trustline()] });
  await assert.rejects(buildPayoutTransactions({ tenant, payer: FOREIGN, payments: [{ wallet: r, amount: 1 }], horizon: h }), (e) => e.code === 'UNEXPECTED_PAYER');
  await assert.rejects(buildPayoutTransactions({ tenant, payer: PAYER.publicKey(), payments: [{ wallet: r, amount: 150 }], horizon: h }), (e) => e.cap === 'person');
  await assert.rejects(buildPayoutTransactions({ tenant, payer: PAYER.publicKey(), payments: [{ wallet: r, amount: 6 }], horizon: h }), /Insufficient payer balance/);
});

test('submit: validates every transaction and records amounts read from the XDR', async () => {
  const signed = tx(PAYER.publicKey(), [pay(W1)]);
  const h = fakeHorizon({});
  const out = await submitSignedTransactions({ tenant, signedXdrs: [signed.toXDR()], registeredWallets: new Set([W1]), horizon: h });
  assert.equal(h.submitted.length, 1);
  assert.deepEqual(out.transactions[0].payments, [{ wallet: W1, amount: 1 }]);

  const rogue = tx(PAYER.publicKey(), [pay(FOREIGN)]);
  await assert.rejects(submitSignedTransactions({ tenant, signedXdrs: [rogue.toXDR()], registeredWallets: new Set([W1]), horizon: h }),
    (e) => e.code === 'UNREGISTERED_DESTINATION');
  assert.equal(h.submitted.length, 1);
});

test('submit: malformed XDR is rejected before reaching the network', async () => {
  const h = fakeHorizon({});
  await assert.rejects(submitSignedTransactions({ tenant, signedXdrs: ['not-xdr'], registeredWallets: new Set([W1]), horizon: h }),
    (e) => e.statusCode === 400 && /Invalid XDR/.test(e.message));
  assert.equal(h.submitted.length, 0);
});

test('submit: signatures are NOT verified locally (the network does it) — see HMY-12', async () => {
  // Signed for testnet, parsed as mainnet: it passes local validation and only
  // the network would reject it (tx_bad_auth).
  const testnetTx = tx(PAYER.publicKey(), [pay(W1)], true, sdk.Networks.TESTNET);
  const h = fakeHorizon({});
  await submitSignedTransactions({ tenant, signedXdrs: [testnetTx.toXDR()], registeredWallets: new Set([W1]), horizon: h });
  assert.equal(h.submitted.length, 1);
});
