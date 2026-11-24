'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sdk, kit, NOW, USDC, ISSUER, OTHER_ISSUER, PASSPHRASE, tenant, keypair, wallet, balanceId, account, fakeHorizon, signXdr, parse, rawTx,
} = require('./_helpers');
const {
  predicateAllows, predicateWindow, listClaimable, buildClaim, submitClaim, CLAIMS_PER_TX,
} = require('../src/claims');

const iso = (t) => new Date(t * 1000).toISOString();
const T = NOW + 5000;

test('predicateAllows: unconditional and missing predicates', () => {
  assert.equal(predicateAllows({ unconditional: true }, NOW), true);
  assert.equal(predicateAllows(undefined, NOW), true);
  assert.equal(predicateAllows(null, NOW), true);
});

test('predicateAllows: abs_before_epoch and abs_before are exclusive upper bounds', () => {
  assert.equal(predicateAllows({ abs_before_epoch: String(T) }, T - 1), true);
  assert.equal(predicateAllows({ abs_before_epoch: String(T) }, T), false);
  assert.equal(predicateAllows({ abs_before_epoch: T }, T + 1), false);
  assert.equal(predicateAllows({ abs_before: iso(T) }, T - 1), true);
  assert.equal(predicateAllows({ abs_before: iso(T) }, T), false);
  // the epoch wins when both are present, as Horizon sends them
  assert.equal(predicateAllows({ abs_before: iso(T), abs_before_epoch: String(T) }, T - 1), true);
});

test('predicateAllows: not, and, or', () => {
  const not = { not: { abs_before_epoch: String(T) } };
  assert.equal(predicateAllows(not, T - 1), false);
  assert.equal(predicateAllows(not, T), true);
  assert.equal(predicateAllows({ not: { not: { abs_before_epoch: String(T) } } }, T - 1), true);
  const window = { and: [{ not: { abs_before_epoch: String(T) } }, { abs_before_epoch: String(T + 100) }] };
  assert.equal(predicateAllows(window, T - 1), false);
  assert.equal(predicateAllows(window, T + 50), true);
  assert.equal(predicateAllows(window, T + 100), false);
  const either = { or: [{ abs_before_epoch: String(T) }, { not: { abs_before_epoch: String(T + 100) } }] };
  assert.equal(predicateAllows(either, T - 1), true);
  assert.equal(predicateAllows(either, T + 50), false);
  assert.equal(predicateAllows(either, T + 100), true);
});

test('predicateAllows: relative or unknown predicates are never allowed', () => {
  assert.equal(predicateAllows({ rel_before: '3600' }, NOW), false);
  assert.equal(predicateAllows({}, NOW), false);
  assert.equal(predicateAllows({ weird: true }, NOW), false);
});

test('predicateWindow: the shapes the kit builds', () => {
  assert.deepEqual(predicateWindow({ unconditional: true }), { from: null, until: null });
  assert.deepEqual(predicateWindow(undefined), { from: null, until: null });
  assert.deepEqual(predicateWindow({ abs_before_epoch: String(T) }), { from: null, until: T });
  assert.deepEqual(predicateWindow({ abs_before: iso(T) }), { from: null, until: T });
  assert.deepEqual(predicateWindow({ not: { abs_before_epoch: String(T) } }), { from: T, until: null });
  assert.deepEqual(predicateWindow({ not: { abs_before: iso(T) } }), { from: T, until: null });
  // anything else is reported as no limit rather than guessed
  assert.deepEqual(predicateWindow({ and: [{ abs_before_epoch: String(T) }] }), { from: null, until: null });
  assert.deepEqual(predicateWindow({ not: { unconditional: true } }), { from: null, until: null });
});

test('the predicates in the XDR and the ones Horizon returns agree', () => {
  // Build the kit predicates, describe them the way Horizon does and evaluate them.
  const asJson = (p) => {
    const t = p.switch().name;
    if (t === 'claimPredicateUnconditional') return { unconditional: true };
    if (t === 'claimPredicateBeforeAbsoluteTime') return { abs_before_epoch: p.absBefore().toString() };
    return { not: asJson(p.notPredicate()) };
  };
  const C = sdk.Claimant;
  const person = asJson(C.predicateBeforeAbsoluteTime(String(T)));
  const payer = asJson(C.predicateNot(C.predicateBeforeAbsoluteTime(String(T))));
  for (const now of [T - 10, T - 1, T, T + 1, T + 10]) {
    assert.notEqual(predicateAllows(person, now), predicateAllows(payer, now), `exactly one of them can claim at ${now}`);
  }
});

const mine = (w, predicate) => ({ claimants: [{ destination: w, predicate }, { destination: wallet(), predicate: { unconditional: true } }] });

test('listClaimable returns the balances of the wallet with their window', async () => {
  const w = wallet();
  const ids = [balanceId(), balanceId(), balanceId(), balanceId()];
  const horizon = fakeHorizon({}, {
    claimable: [
      { id: ids[0], amount: '10.0000000', sponsor: 'GSPONSOR', ...mine(w, { unconditional: true }) },
      { id: ids[1], amount: '20.0000000', ...mine(w, { abs_before_epoch: String(T) }) },
      { id: ids[2], amount: '30.0000000', ...mine(w, { not: { abs_before_epoch: String(T) } }) },
      { id: ids[3], amount: '40.0000000', claimants: [{ destination: wallet(), predicate: { unconditional: true } }] },
    ],
  });
  const early = await listClaimable(tenant(), { wallet: w, now: T - 1, horizon });
  assert.deepEqual(early.map((b) => [b.balanceId, b.amount, b.claimableNow, b.from, b.until]), [
    [ids[0], '10.0000000', true, null, null],
    [ids[1], '20.0000000', true, null, T],
    [ids[2], '30.0000000', false, T, null],
    [ids[3], '40.0000000', false, null, null], // the wallet is not a claimant
  ]);
  assert.equal(early[0].sponsor, 'GSPONSOR');
  assert.equal(early[1].sponsor, null);
  const late = await listClaimable(tenant(), { wallet: w, now: T, horizon });
  assert.deepEqual(late.map((b) => b.claimableNow), [true, false, true, false]);
  // It asks Horizon for this wallet and the reward asset only.
  assert.equal(horizon.calls.claimant[0], w);
  assert.equal(horizon.calls.asset[0].getCode(), 'USDC');
  assert.equal(horizon.calls.asset[0].getIssuer(), ISSUER);
});

test('listClaimable handles an empty page and rejects a bad wallet', async () => {
  const w = wallet();
  assert.deepEqual(await listClaimable(tenant(), { wallet: w, horizon: fakeHorizon({}, { claimable: [] }) }), []);
  const noRecords = { claimableBalances: () => ({ claimant() { return this; }, asset() { return this; }, limit() { return this; }, call: async () => ({}) }) };
  assert.deepEqual(await listClaimable(tenant(), { wallet: w, horizon: noRecords }), []);
  await assert.rejects(listClaimable(tenant(), { wallet: 'nope', horizon: fakeHorizon({}) }), (e) => e.statusCode === 400);
});

test('listClaimable follows the pages until one is empty and is not truncated', async () => {
  const w = wallet();
  const rec = (n) => Array.from({ length: n }, (_, i) => ({ id: balanceId(), amount: `${i + 1}.0000000`, ...mine(w, { unconditional: true }) }));
  const horizon = fakeHorizon({}, { claimablePages: [rec(3), rec(2), rec(1)] });
  const all = await listClaimable(tenant(), { wallet: w, now: T, horizon });
  assert.equal(all.length, 6);
  assert.ok(Array.isArray(all));
  assert.equal(all.truncated, false);
  assert.equal(horizon.calls.pages, 4, 'three pages and the empty one that ends the walk');
  assert.equal(horizon.calls.limit[0], 200);
});

test('listClaimable stops at maxPages and says so', async () => {
  const w = wallet();
  const rec = (n) => Array.from({ length: n }, () => ({ id: balanceId(), amount: '1.0000000', ...mine(w, { unconditional: true }) }));
  const horizon = fakeHorizon({}, { claimablePages: [rec(2), rec(2), rec(2), rec(2)] });
  const some = await listClaimable(tenant(), { wallet: w, now: T, maxPages: 2, horizon });
  assert.equal(some.length, 4);
  assert.equal(some.truncated, true);
  assert.equal(horizon.calls.pages, 2);
  await assert.rejects(listClaimable(tenant(), { wallet: w, maxPages: 0, horizon: fakeHorizon({}) }), (e) => e.statusCode === 400);
});

// ── buildClaim ──────────────────────────────────────────────────────────────

test('buildClaim adds the trustline only when it is missing', async () => {
  const person = keypair();
  const w = person.publicKey();
  const ids = [balanceId(), balanceId()];

  const without = await buildClaim(tenant(), { wallet: w, balanceIds: ids, horizon: fakeHorizon({ [w]: account({}) }) });
  assert.equal(without.addsTrustline, true);
  assert.equal(without.xdrs.length, 1);
  const tx = parse(without.xdrs[0]);
  assert.deepEqual(tx.operations.map((o) => o.type), ['changeTrust', 'claimClaimableBalance', 'claimClaimableBalance']);
  assert.equal(tx.operations[0].line.getCode(), 'USDC');
  assert.equal(tx.operations[0].line.getIssuer(), ISSUER);
  assert.deepEqual(tx.operations.slice(1).map((o) => o.balanceId), ids);
  assert.equal(tx.source, w);
  assert.deepEqual(without.balanceIds, ids);

  const withLine = await buildClaim(tenant(), { wallet: w, balanceIds: ids, horizon: fakeHorizon({ [w]: account({ usdc: '5.0000000' }) }) });
  assert.equal(withLine.addsTrustline, false);
  assert.deepEqual(parse(withLine.xdrs[0]).operations.map((o) => o.type), ['claimClaimableBalance', 'claimClaimableBalance']);

  // A trustline for another issuer's USDC is not the reward asset.
  const otherIssuer = await buildClaim(tenant(), { wallet: w, balanceIds: ids, horizon: fakeHorizon({ [w]: account({ usdc: '5', issuer: OTHER_ISSUER }) }) });
  assert.equal(otherIssuer.addsTrustline, true);
});

test('buildClaim splits more than 19 ids into transactions of at most 20 operations', async () => {
  const w = wallet();
  const ids = Array.from({ length: 41 }, balanceId);
  const out = await buildClaim(tenant(), { wallet: w, balanceIds: ids, horizon: fakeHorizon({ [w]: account({}) }) });
  assert.equal(CLAIMS_PER_TX, 19);
  const txs = out.xdrs.map((x) => parse(x));
  assert.deepEqual(txs.map((t) => t.operations.length), [20, 19, 3]); // trustline only in the first
  assert.equal(txs[1].operations.some((o) => o.type === 'changeTrust'), false);
  for (let i = 1; i < txs.length; i++) assert.equal(BigInt(txs[i].sequence), BigInt(txs[i - 1].sequence) + 1n);
  const claimed = txs.flatMap((t) => t.operations.filter((o) => o.type === 'claimClaimableBalance').map((o) => o.balanceId));
  assert.deepEqual(claimed, ids);

  const withLine = await buildClaim(tenant(), { wallet: w, balanceIds: ids, horizon: fakeHorizon({ [w]: account({ usdc: '0' }) }) });
  assert.deepEqual(withLine.xdrs.map((x) => parse(x).operations.length), [19, 19, 3]);
});

test('buildClaim removes duplicated ids and rejects bad input', async () => {
  const w = wallet();
  const id = balanceId();
  const horizon = fakeHorizon({ [w]: account({ usdc: '0' }) });
  const out = await buildClaim(tenant(), { wallet: w, balanceIds: [id, id, id], horizon });
  assert.equal(parse(out.xdrs[0]).operations.length, 1);
  assert.deepEqual(out.balanceIds, [id]);

  const bad = (input, status, pattern) => assert.rejects(buildClaim(tenant(), { horizon, ...input }), (e) => e.statusCode === status && pattern.test(e.message));
  await bad({ wallet: 'GNOPE', balanceIds: [id] }, 400, /not a Stellar account/);
  await bad({ wallet: w, balanceIds: [] }, 400, /nothing to claim/);
  await bad({ wallet: w }, 400, /nothing to claim/);
  await bad({ wallet: w, balanceIds: ['abc'] }, 400, /not valid/);
  await bad({ wallet: w, balanceIds: [id.slice(1)] }, 400, /not valid/);
  await bad({ wallet: w, balanceIds: [`${id}00`] }, 400, /not valid/);
  await bad({ wallet: w, balanceIds: [`${'z'.repeat(72)}`] }, 400, /not valid/);
  await bad({ wallet: w, balanceIds: [id, 42] }, 400, /not valid/);
});

test('buildClaim: an account that does not exist yet cannot claim', async () => {
  const w = wallet();
  await assert.rejects(buildClaim(tenant(), { wallet: w, balanceIds: [balanceId()], horizon: fakeHorizon({}) }),
    (e) => e.statusCode === 409 && e.code === 'ACCOUNT_NOT_FOUND');
  const broken = { loadAccount: async () => { throw new Error('horizon down'); } };
  await assert.rejects(buildClaim(tenant(), { wallet: w, balanceIds: [balanceId()], horizon: broken }), /horizon down/);
});

// ── submitClaim ─────────────────────────────────────────────────────────────

const claimOp = () => sdk.Operation.claimClaimableBalance({ balanceId: balanceId() });
const trust = (asset = USDC) => sdk.Operation.changeTrust({ asset });

test('submitClaim: a claim built by buildClaim is accepted and submitted', async () => {
  const person = keypair();
  const w = person.publicKey();
  const ids = [balanceId(), balanceId()];
  const out = await buildClaim(tenant(), { wallet: w, balanceIds: ids, horizon: fakeHorizon({ [w]: account({}) }) });
  const h = fakeHorizon({});
  const res = await submitClaim(tenant(), { wallet: w, signedXdrs: out.xdrs.map((x) => signXdr(x, person)), horizon: h });
  assert.equal(h.submitted.length, 1);
  assert.equal(res.network, 'testnet');
  assert.deepEqual(res.transactions[0].claimed, ids);
  assert.equal(res.transactions[0].ledger, 1000);
  assert.equal(res.transactions[0].hash, parse(out.xdrs[0]).hash().toString('hex'));
});

test('submitClaim rejects anything that is not a claim or the reward trustline', async () => {
  const person = keypair();
  const w = person.publicKey();
  const h = fakeHorizon({});
  const run = (ops, extra = {}) => submitClaim(tenant(), { wallet: w, signedXdrs: [rawTx(w, ops, { sign: person }).toXDR()], horizon: h, ...extra });
  const unexpected = (e) => e.statusCode === 400 && e.code === 'UNEXPECTED_OPERATION';

  await assert.rejects(run([sdk.Operation.payment({ destination: wallet(), asset: USDC, amount: '5' })]), unexpected);
  await assert.rejects(run([claimOp(), sdk.Operation.manageData({ name: 'x', value: 'y' })]), unexpected);
  await assert.rejects(run([sdk.Operation.accountMerge({ destination: wallet() })]), unexpected);
  await assert.rejects(run([sdk.Operation.setOptions({ masterWeight: 0 })]), unexpected);
  await assert.rejects(run([sdk.Operation.createClaimableBalance({ asset: USDC, amount: '1', claimants: [new sdk.Claimant(wallet())] })]), unexpected);
  // trustline for another asset, for the same code from another issuer, and for XLM
  await assert.rejects(run([trust(new sdk.Asset('USDC', OTHER_ISSUER))]), unexpected);
  await assert.rejects(run([trust(new sdk.Asset('EURC', ISSUER))]), unexpected);
  await assert.rejects(run([trust(sdk.Asset.native())]), unexpected);
  // an operation that acts on behalf of somebody else
  await assert.rejects(run([sdk.Operation.claimClaimableBalance({ balanceId: balanceId(), source: wallet() })]), unexpected);
  assert.equal(h.submitted.length, 0);
  // Both accepted shapes together are fine, and an own-source operation is fine.
  await run([trust(), claimOp(), sdk.Operation.claimClaimableBalance({ balanceId: balanceId(), source: w })]);
  assert.equal(h.submitted.length, 1);
});

test('submitClaim: a trustline with limit 0 (which removes it) is refused; default and positive limits pass', async () => {
  const person = keypair();
  const w = person.publicKey();
  const h = fakeHorizon({});
  const run = (op, seq = '100') => submitClaim(tenant(), { wallet: w, signedXdrs: [rawTx(w, [op, claimOp()], { sign: person, seq }).toXDR()], horizon: h });
  await assert.rejects(run(sdk.Operation.changeTrust({ asset: USDC, limit: '0' })), (e) => e.statusCode === 400 && e.code === 'UNEXPECTED_OPERATION');
  assert.equal(h.submitted.length, 0);
  await run(sdk.Operation.changeTrust({ asset: USDC }));
  await run(sdk.Operation.changeTrust({ asset: USDC, limit: '1000.0000000' }), '101'); // the next sequence number of the wallet
  assert.equal(h.submitted.length, 2);
});

test('submitClaim rejects a transaction of another wallet, unsigned, fee-bump, malformed or empty requests', async () => {
  const person = keypair();
  const w = person.publicKey();
  const other = keypair();
  const h = fakeHorizon({});
  const fails = (signedXdrs, pattern, status = 400) => assert.rejects(submitClaim(tenant(), { wallet: w, signedXdrs, horizon: h }), (e) => e.statusCode === status && pattern.test(e.message));
  await fails([rawTx(other.publicKey(), [claimOp()], { sign: other }).toXDR()], /not built for this wallet/);
  await fails([rawTx(w, [claimOp()]).toXDR()], /not signed/);
  const inner = rawTx(other.publicKey(), [claimOp()], { sign: other });
  await fails([sdk.TransactionBuilder.buildFeeBumpTransaction(person, '5000', inner, PASSPHRASE).toXDR()], /Fee-bump/);
  await fails(['not-xdr'], /Invalid XDR/);
  await fails([], /No signed transactions/);
  assert.equal(h.submitted.length, 0);
  await assert.rejects(submitClaim(tenant(), { wallet: w, horizon: h }), (e) => e.statusCode === 400);
});

test('submitClaim: a network failure is a 502 that lists what already went through', async () => {
  const person = keypair();
  const w = person.publicKey();
  const mk = () => rawTx(w, [claimOp()], { sign: person });
  const h = fakeHorizon({}, { failAt: 1 });
  await assert.rejects(submitClaim(tenant(), { wallet: w, signedXdrs: [mk().toXDR(), mk().toXDR()], horizon: h }), (e) => {
    assert.equal(e.statusCode, 502);
    assert.equal(e.submitted.length, 1);
    assert.deepEqual(e.resultCodes, { transaction: 'tx_bad_seq' });
    assert.equal(e.code, 'TRANSACTION_REJECTED');
    return true;
  });
});

test('submitClaim: no result codes is an unknown outcome (504); resubmitting the same signed claim is safe', async () => {
  const person = keypair();
  const w = person.publicKey();
  const xdr = rawTx(w, [claimOp()], { sign: person }).toXDR();
  for (const option of ['timeoutOn', 'dropOn']) { // applied but unanswered, and not applied at all
    const h = fakeHorizon({}, { [option]: new Set([0]) });
    await assert.rejects(submitClaim(tenant(), { wallet: w, signedXdrs: [xdr], horizon: h }), (e) => {
      assert.equal(e.statusCode, 504);
      assert.equal(e.code, 'SUBMISSION_UNKNOWN');
      assert.equal(e.unknownHash, parse(xdr).hash().toString('hex'));
      assert.deepEqual(e.submitted, []);
      assert.match(e.message, /Resubmitting the SAME signed claim is safe/);
      return true;
    });
    const again = await submitClaim(tenant(), { wallet: w, signedXdrs: [xdr], horizon: h });
    assert.equal(again.transactions.length, 1);
    assert.equal(h.submitted.length, 1, 'applied once, whichever way the first attempt went');
  }
});

test('the instance methods are bound to the tenant', async () => {
  const w = wallet();
  const harmony = kit.createProgram({ tenant: { id: 'acme-kit', network: 'testnet' }, program: 'tip-pool' });
  assert.deepEqual(await harmony.listClaimable({ wallet: w, horizon: fakeHorizon({}) }), []);
});

test('listClaimable with `sponsors` returns only the balances created by those payers', async () => {
  const w = wallet();
  const payer = wallet();
  const stranger = wallet();
  const horizon = () => fakeHorizon({}, {
    claimable: [
      { id: balanceId(), amount: '10.0000000', sponsor: payer, ...mine(w, { unconditional: true }) },
      { id: balanceId(), amount: '0.0000001', sponsor: stranger, ...mine(w, { unconditional: true }) }, // dust sent by anybody
      { id: balanceId(), amount: '20.0000000', ...mine(w, { unconditional: true }) },                    // no sponsor
    ],
  });
  assert.equal((await listClaimable(tenant(), { wallet: w, horizon: horizon() })).length, 3, 'without the option nothing changes');
  for (const sponsors of [[payer], new Set([payer])]) {
    const only = await listClaimable(tenant(), { wallet: w, sponsors, horizon: horizon() });
    assert.deepEqual(only.map((b) => [b.amount, b.sponsor]), [['10.0000000', payer]]);
  }
  assert.deepEqual(await listClaimable(tenant(), { wallet: w, sponsors: [], horizon: horizon() }), []);
});
