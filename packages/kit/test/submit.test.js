'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sdk, kit, NOW, ISSUER, OTHER_ISSUER, USDC, PASSPHRASE, scenario, simpleProgram, keypair, wallet, fakeHorizon, signXdr, parse,
  rawTx, before, notBefore, unconditional, claimable, payment, tenant,
} = require('./_helpers');
const { submit, validateOperations } = require('../src/submit');

const THREE_POCKETS = [
  { id: 'now', label: 'Now', share: 0.5, rule: { type: 'instant' } },
  { id: 'soon', label: 'Soon', share: 0.3, rule: { type: 'expires', afterDays: 14 } },
  { id: 'later', label: 'Later', share: 0.2, rule: { type: 'unlocks', afterDays: 60 } },
];

async function built(opts) {
  const s = scenario(opts);
  const b = await kit.build(s.program, s.tenant, { plan: s.plan, payer: s.payer.publicKey(), horizon: s.horizon, now: s.now });
  return { ...s, built: b, signed: b.xdrs.map((x) => signXdr(x, s.payer)) };
}

const manyPeople = () => {
  const points = {};
  for (let i = 0; i < 25; i++) points[`p${i}`] = 1 + i;
  return { program: simpleProgram({ pockets: THREE_POCKETS, payout: { model: 'proportional', pool: 1000 } }), points };
};

test('happy path: submits the signed transaction and reports what it contains', async () => {
  const s = await built();
  const h = fakeHorizon({});
  const receipt = await submit(s.tenant, { built: s.built, signedXdrs: s.signed, horizon: h });
  assert.equal(h.submitted.length, 1);
  assert.equal(receipt.planId, s.plan.planId);
  assert.equal(receipt.network, 'testnet');
  assert.equal(receipt.transactions.length, 1);
  const [t] = receipt.transactions;
  assert.equal(t.hash, s.built.hashes[0]);
  assert.equal(t.ledger, 1000);
  assert.equal(t.payer, s.payer.publicKey());
  assert.deepEqual(t.operations, s.built.operations);
});

test('a signed transaction that is not one of the built ones is rejected (different amount)', async () => {
  const s = await built();
  const original = parse(s.built.xdrs[0]);
  const ops = original.operations.map((o, i) => sdk.Operation.payment({ destination: o.destination, asset: USDC, amount: i === 0 ? '99.0000000' : o.amount }));
  const forged = rawTx(s.payer.publicKey(), ops, { sign: s.payer, seq: String(BigInt(original.sequence) - 1n) });
  const h = fakeHorizon({});
  await assert.rejects(submit(s.tenant, { built: s.built, signedXdrs: [forged.toXDR()], horizon: h }),
    (e) => e.statusCode === 400 && e.code === 'NOT_THE_BUILT_TRANSACTION');
  assert.equal(h.submitted.length, 0);
});

test('the same operations with a different memo, fee or sequence are also not the built transaction', async () => {
  const s = await built();
  const original = parse(s.built.xdrs[0]);
  const seq = String(BigInt(original.sequence) - 1n);
  const ops = () => original.operations.map((o) => sdk.Operation.payment({ destination: o.destination, asset: USDC, amount: o.amount }));
  const make = (fee, memo) => {
    const b = new sdk.TransactionBuilder(new sdk.Account(s.payer.publicKey(), seq), { fee, networkPassphrase: PASSPHRASE });
    ops().forEach((o) => b.addOperation(o));
    if (memo) b.addMemo(memo);
    const tx = b.setTimeout(600).build();
    tx.sign(s.payer);
    return tx.toXDR();
  };
  const h = fakeHorizon({});
  for (const xdr of [make('1000', sdk.Memo.text('hello')), make('9999', sdk.Memo.hash(s.plan.planId))]) {
    await assert.rejects(submit(s.tenant, { built: s.built, signedXdrs: [xdr], horizon: h }), (e) => e.code === 'NOT_THE_BUILT_TRANSACTION');
  }
  assert.equal(h.submitted.length, 0);
});

test('a transaction with an extra operation appended after building is rejected', async () => {
  const s = await built();
  const original = parse(s.built.xdrs[0]);
  const ops = [...original.operations.map((o) => sdk.Operation.payment({ destination: o.destination, asset: USDC, amount: o.amount })),
    sdk.Operation.payment({ destination: wallet(), asset: USDC, amount: '1.0000000' })];
  const forged = rawTx(s.payer.publicKey(), ops, { sign: s.payer });
  await assert.rejects(submit(s.tenant, { built: s.built, signedXdrs: [forged.toXDR()], horizon: fakeHorizon({}) }),
    (e) => e.code === 'NOT_THE_BUILT_TRANSACTION');
});

test('submission follows the build order even when the signed XDRs arrive reversed', async () => {
  const { program, points } = manyPeople();
  const s = await built({ program, points });
  assert.equal(s.built.xdrs.length, 4);
  const h = fakeHorizon({});
  const receipt = await submit(s.tenant, { built: s.built, signedXdrs: [...s.signed].reverse(), horizon: h });
  assert.deepEqual(h.submitted.map((t) => t.hash().toString('hex')), s.built.hashes);
  assert.deepEqual(receipt.transactions.map((t) => t.hash), s.built.hashes);
  // Each receipt lists exactly the operations of its own transaction.
  receipt.transactions.forEach((t, i) => assert.ok(t.operations.length > 0 && t.operations.every((o) => o.tx === i)));
  assert.equal(receipt.transactions.reduce((n, t) => n + t.operations.length, 0), 75);
});

test('the same transaction sent twice is rejected before anything is submitted', async () => {
  const s = await built();
  const h = fakeHorizon({});
  await assert.rejects(submit(s.tenant, { built: s.built, signedXdrs: [s.signed[0], s.signed[0]], horizon: h }),
    (e) => e.statusCode === 400 && /sent twice/.test(e.message));
  assert.equal(h.submitted.length, 0);
});

test('when the network rejects the second transaction the first is reported as submitted (502)', async () => {
  const { program, points } = manyPeople();
  const s = await built({ program, points });
  const h = fakeHorizon({}, { failAt: 1 });
  await assert.rejects(submit(s.tenant, { built: s.built, signedXdrs: s.signed, horizon: h }), (e) => {
    assert.equal(e.statusCode, 502);
    assert.equal(e.submitted.length, 1);
    assert.equal(e.submitted[0].hash, s.built.hashes[0]);
    assert.equal(e.submitted[0].operations.length, 20);
    assert.equal(e.failedHash, s.built.hashes[1]);
    assert.deepEqual(e.resultCodes, { transaction: 'tx_bad_seq' });
    assert.match(e.message, /tx_bad_seq/);
    return true;
  });
  assert.equal(h.submitted.length, 1, 'nothing after the failure is attempted');
});

test('a failure without result codes still reports the reason', async () => {
  const s = await built();
  const h = { submitTransaction: async () => { throw new Error('socket hang up'); } };
  await assert.rejects(submit(s.tenant, { built: s.built, signedXdrs: s.signed, horizon: h }),
    (e) => e.statusCode === 502 && /socket hang up/.test(e.message) && e.resultCodes === null && e.submitted.length === 0);
});

test('an unsigned built transaction is refused', async () => {
  const s = await built();
  await assert.rejects(submit(s.tenant, { built: s.built, signedXdrs: s.built.xdrs, horizon: fakeHorizon({}) }),
    (e) => e.statusCode === 400 && /not signed/.test(e.message));
});

test('malformed input is refused with a 400', async () => {
  const s = await built();
  const h = fakeHorizon({});
  await assert.rejects(submit(s.tenant, { built: s.built, signedXdrs: ['not-xdr'], horizon: h }), (e) => e.statusCode === 400 && /Invalid XDR/.test(e.message));
  await assert.rejects(submit(s.tenant, { built: s.built, signedXdrs: [], horizon: h }), (e) => e.statusCode === 400 && /No signed transactions/.test(e.message));
  await assert.rejects(submit(s.tenant, { built: s.built, horizon: h }), (e) => e.statusCode === 400);
  await assert.rejects(submit(s.tenant, { signedXdrs: s.signed, horizon: h }), (e) => e.statusCode === 400 && /build is missing/.test(e.message));
  await assert.rejects(submit(s.tenant, { built: { hashes: [], operations: 'x' }, signedXdrs: s.signed, horizon: h }), (e) => e.statusCode === 400);
  await assert.rejects(submit(tenant({ network: 'mainnet' }), { built: s.built, signedXdrs: s.signed, horizon: h }), (e) => e.statusCode === 400 && /another network/.test(e.message));
  assert.equal(h.submitted.length, 0);
});

test('a fee-bump wrapper around a built transaction is not accepted', async () => {
  const s = await built();
  const inner = parse(s.signed[0]);
  const bump = sdk.TransactionBuilder.buildFeeBumpTransaction(keypair(), '5000', inner, PASSPHRASE);
  const h = fakeHorizon({});
  await assert.rejects(submit(s.tenant, { built: s.built, signedXdrs: [bump.toXDR()], horizon: h }), (e) => e.statusCode === 400);
  assert.equal(h.submitted.length, 0);
});

test('mainnet: the signing account must be the registered payer', async () => {
  const registered = keypair();
  const t = tenant({ network: 'mainnet', payouts: { payerWallet: registered.publicKey() } });
  const recipient = wallet();
  const other = keypair();
  const tx = rawTx(other.publicKey(), [payment(recipient, { asset: new sdk.Asset('USDC', t.rewardAsset.issuer) })], { passphrase: sdk.Networks.PUBLIC, sign: other });
  const fake = { network: 'mainnet', planId: 'x', hashes: [tx.hash().toString('hex')], operations: [{ wallet: recipient, tx: 0 }], payer: other.publicKey() };
  await assert.rejects(submit(t, { built: fake, signedXdrs: [tx.toXDR()], horizon: fakeHorizon({}) }), (e) => e.statusCode === 409 && e.code === 'UNEXPECTED_PAYER');
});

// ── validateOperations, on its own ──────────────────────────────────────────
const payer = keypair();
const P = payer.publicKey();
const R = wallet();
const R2 = wallet();
const ctx = (extra = {}) => ({ code: 'USDC', issuer: ISSUER, wallets: new Set([R, R2]), expectedPayer: P, ...extra });
const signedTx = (ops, source = P, signer = payer) => rawTx(source, ops, { sign: signer });
const T = NOW + 1000;

const invalid = (tx, code, c = ctx()) => assert.throws(() => validateOperations(tx, c), (e) => {
  assert.ok(e.statusCode === 400 || e.statusCode === 409);
  if (code) assert.equal(e.code, code);
  assert.match(e.message, /Not submitted/);
  return true;
});

test('validateOperations accepts what the kit builds', () => {
  assert.equal(validateOperations(signedTx([payment(R)]), ctx()).length, 1);
  const expires = claimable([new sdk.Claimant(R, before(T)), new sdk.Claimant(P, notBefore(T))]);
  const unlocks = claimable([new sdk.Claimant(R, notBefore(T))]);
  const hold = claimable([new sdk.Claimant(R, unconditional()), new sdk.Claimant(P, notBefore(T))]);
  assert.equal(validateOperations(signedTx([payment(R), expires, unlocks, hold]), ctx()).length, 4);
  // A payer that waits longer than the person's deadline is still safe for the person.
  assert.equal(validateOperations(signedTx([claimable([new sdk.Claimant(R, before(T)), new sdk.Claimant(P, notBefore(T + 500))])]), ctx()).length, 1);
});

test('validateOperations rejects an operation with a source other than the transaction source', () => {
  const victim = keypair();
  invalid(signedTx([payment(R, { source: victim.publicKey() })]), 'FOREIGN_SOURCE');
  // The same source as the transaction is harmless.
  assert.equal(validateOperations(signedTx([payment(R, { source: P })]), ctx()).length, 1);
});

test('validateOperations rejects the wrong asset, in payments and in claimable balances', () => {
  invalid(signedTx([payment(R, { asset: new sdk.Asset('USDC', OTHER_ISSUER) })]), 'UNEXPECTED_ASSET');
  invalid(signedTx([payment(R, { asset: new sdk.Asset('EURC', ISSUER) })]), 'UNEXPECTED_ASSET');
  invalid(signedTx([payment(R, { asset: sdk.Asset.native() })]), 'UNEXPECTED_ASSET');
  invalid(signedTx([claimable([new sdk.Claimant(R, notBefore(T))], { asset: new sdk.Asset('USDC', OTHER_ISSUER) })]), 'UNEXPECTED_ASSET');
});

test('validateOperations rejects any other operation type', () => {
  invalid(signedTx([sdk.Operation.manageData({ name: 'x', value: 'y' })]), 'UNEXPECTED_OPERATION');
  invalid(signedTx([sdk.Operation.changeTrust({ asset: USDC })]), 'UNEXPECTED_OPERATION');
  invalid(signedTx([sdk.Operation.setOptions({ masterWeight: 0 })]), 'UNEXPECTED_OPERATION');
  invalid(signedTx([sdk.Operation.accountMerge({ destination: R })]), 'UNEXPECTED_OPERATION');
  invalid(signedTx([sdk.Operation.claimClaimableBalance({ balanceId: `00000000${'a'.repeat(64)}` })]), 'UNEXPECTED_OPERATION');
  invalid(signedTx([payment(R), sdk.Operation.manageData({ name: 'x', value: 'y' })]), 'UNEXPECTED_OPERATION');
});

test('validateOperations rejects destinations and claimants that are not in the plan', () => {
  invalid(signedTx([payment(wallet())]), 'UNREGISTERED_DESTINATION');
  invalid(signedTx([payment(R), payment(wallet())]), 'UNREGISTERED_DESTINATION');
  invalid(signedTx([claimable([new sdk.Claimant(wallet(), notBefore(T))])]), 'UNREGISTERED_DESTINATION');
  invalid(signedTx([claimable([new sdk.Claimant(wallet(), before(T)), new sdk.Claimant(P, notBefore(T))])]), 'UNREGISTERED_DESTINATION');
});

test('validateOperations: the payer can never take the money back while the person can still claim it', () => {
  const C = sdk.Claimant;
  // payer unconditional
  invalid(signedTx([claimable([new C(R, unconditional()), new C(P, unconditional())])]), 'UNEXPECTED_PREDICATE');
  invalid(signedTx([claimable([new C(R, before(T)), new C(P, unconditional())])]), 'UNEXPECTED_PREDICATE');
  // payer deadline earlier than the person's
  invalid(signedTx([claimable([new C(R, before(T)), new C(P, notBefore(T - 1))])]), 'UNEXPECTED_PREDICATE');
  // payer "before" instead of "not before"
  invalid(signedTx([claimable([new C(R, before(T)), new C(P, before(T))])]), 'UNEXPECTED_PREDICATE');
  // a locked pocket must not have a payer at all
  invalid(signedTx([claimable([new C(R, notBefore(T)), new C(P, notBefore(T + 10))])]), 'UNEXPECTED_PREDICATE');
  // compound predicates are not something the kit builds
  invalid(signedTx([claimable([new C(R, C.predicateAnd(before(T), before(T + 5))), new C(P, notBefore(T + 5))])]), 'UNEXPECTED_PREDICATE');
  invalid(signedTx([claimable([new C(R, before(T)), new C(P, C.predicateOr(notBefore(T), notBefore(T + 5)))])]), 'UNEXPECTED_PREDICATE');
});

test('validateOperations: the set of claimants must be one person, plus optionally the payer', () => {
  const C = sdk.Claimant;
  invalid(signedTx([claimable([new C(R, unconditional())])]), 'UNEXPECTED_CLAIMANTS'); // nobody could ever reclaim a hold: not what the kit builds
  invalid(signedTx([claimable([new C(R, before(T))])]), 'UNEXPECTED_CLAIMANTS');
  invalid(signedTx([claimable([new C(P, notBefore(T))])]), 'UNEXPECTED_CLAIMANTS'); // only the payer
  invalid(signedTx([claimable([new C(R, notBefore(T)), new C(R2, notBefore(T))])]), 'UNEXPECTED_CLAIMANTS'); // two people
  invalid(signedTx([claimable([new C(R, before(T)), new C(P, notBefore(T)), new C(R2, notBefore(T))])]), 'UNEXPECTED_CLAIMANTS');
});

test('validateOperations rejects a transaction that is unsigned, empty or from another payer', () => {
  invalid(rawTx(P, [payment(R)]), null);
  assert.throws(() => validateOperations(rawTx(P, [payment(R)]), ctx()), /not signed/);
  assert.throws(() => validateOperations({ source: P, operations: [], signatures: [1] }, ctx()), /no operations/);
  const other = keypair();
  assert.throws(() => validateOperations(signedTx([payment(R)], other.publicKey(), other), ctx()), (e) => e.statusCode === 409 && e.code === 'UNEXPECTED_PAYER');
  // Without an expected payer the source is not pinned.
  assert.equal(validateOperations(signedTx([payment(R)], other.publicKey(), other), ctx({ expectedPayer: undefined })).length, 1);
});

test('validateOperations rejects fee-bump transactions', () => {
  const inner = signedTx([payment(R)]);
  const bump = sdk.TransactionBuilder.buildFeeBumpTransaction(keypair(), '5000', inner, PASSPHRASE);
  bump.sign(keypair());
  invalid(bump, null);
  assert.throws(() => validateOperations(bump, ctx()), /Fee-bump/);
});

test('explorerUrl points to the right network', () => {
  assert.equal(kit.explorerUrl('mainnet', 'abc'), 'https://stellar.expert/explorer/public/tx/abc');
  assert.equal(kit.explorerUrl('testnet', 'abc'), 'https://stellar.expert/explorer/testnet/tx/abc');
});

// ── signature check ─────────────────────────────────────────────────────────

const badSignature = (e) => e.statusCode === 400 && e.code === 'BAD_SIGNATURE';

test('a transaction signed by another key is refused before anything is submitted', async () => {
  const s = await built();
  const h = fakeHorizon({});
  const wrong = [signXdr(s.built.xdrs[0], keypair())];
  await assert.rejects(submit(s.tenant, { built: s.built, signedXdrs: wrong, horizon: h }), badSignature);
  assert.equal(h.submitted.length, 0);
});

test('a signature copied from another transaction is refused', async () => {
  const { program, points } = manyPeople();
  const s = await built({ program, points });
  const h = fakeHorizon({});
  // The payer's valid signature over transaction 0, attached to transaction 1.
  const sig0 = parse(s.signed[0]).signatures[0];
  const tx1 = parse(s.built.xdrs[1]);
  tx1.signatures.push(sig0);
  const signed = [s.signed[0], tx1.toXDR(), ...s.signed.slice(2)];
  await assert.rejects(submit(s.tenant, { built: s.built, signedXdrs: signed, horizon: h }), badSignature);
  assert.equal(h.submitted.length, 0);
});

test('nothing is submitted when the SECOND transaction of a batch is badly signed', async () => {
  const { program, points } = manyPeople();
  const s = await built({ program, points });
  assert.ok(s.built.xdrs.length >= 2);
  const h = fakeHorizon({});
  const signed = [s.signed[0], signXdr(s.built.xdrs[1], keypair()), ...s.signed.slice(2)];
  await assert.rejects(submit(s.tenant, { built: s.built, signedXdrs: signed, horizon: h }), badSignature);
  assert.equal(h.submitted.length, 0, 'the first, valid transaction was not sent either');
});

test('verifySignatures: false leaves the judgement to the network (accounts with custom signers)', async () => {
  const s = await built();
  const h = fakeHorizon({});
  const other = [signXdr(s.built.xdrs[0], keypair())];
  const receipt = await submit(s.tenant, { built: s.built, signedXdrs: other, horizon: h, verifySignatures: false });
  assert.equal(receipt.transactions.length, 1);
  assert.equal(h.submitted.length, 1);
  // Even then a transaction without any signature is refused.
  await assert.rejects(submit(s.tenant, { built: s.built, signedXdrs: s.built.xdrs, horizon: h, verifySignatures: false }), (e) => /not signed/.test(e.message));
});

test('a valid signature among several is enough (the payer plus an extra signer)', async () => {
  const s = await built();
  const h = fakeHorizon({});
  const tx = parse(s.signed[0]);
  tx.sign(keypair());
  const receipt = await submit(s.tenant, { built: s.built, signedXdrs: [tx.toXDR()], horizon: h });
  assert.equal(receipt.transactions.length, 1);
});
