'use strict';

// The already-submitted lookup walks the payer's history back to the time of
// the plan, fails closed when it cannot, and build() reports until when its
// transactions stay valid. Offline: the fake Horizon pages like the real one.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  kit, NOW, DAY, scenario, wallet, signXdr, parse,
} = require('./_helpers');

const buildOf = (s, extra = {}) => kit.build(s.program, s.tenant, { plan: s.plan, payer: s.payer.publicKey(), horizon: s.horizon, now: s.now, ...extra });
const submitted = async (s) => {
  const built = await buildOf(s);
  await kit.submit(s.tenant, { built, signedXdrs: built.xdrs.map((x) => signXdr(x, s.payer)), horizon: s.horizon });
  return built;
};

test('the lookup pages back through more than 200 newer transactions and still finds the payout', async () => {
  const s = scenario({ points: { a: 60, b: 40 } });
  await submitted(s);
  s.horizon.noise(s.payer.publicKey(), 450); // newer, unrelated, as recent as the plan
  const before = s.horizon.calls.transactionPages;
  await assert.rejects(buildOf(s, { now: NOW + 600 }), (e) => e.statusCode === 409 && e.code === 'PLAN_ALREADY_SUBMITTED' && e.hashes.length === 1);
  assert.ok(s.horizon.calls.transactionPages - before >= 3, 'it read 451 records in pages of 200');
});

test('the lookup stops at the first record older than the plan: it does not read the whole history', async () => {
  const s = scenario({ points: { a: 60, b: 40 } });
  s.horizon.noise(s.payer.publicKey(), 600, NOW - 10 * DAY); // old history, before the plan existed
  const before = s.horizon.calls.transactionPages;
  assert.ok(await buildOf(s)); // nothing was submitted
  assert.equal(s.horizon.calls.transactionPages - before, 1, 'the first page already reached back past the plan');
  await submitted(s);
  const mark = s.horizon.calls.transactionPages;
  await assert.rejects(buildOf(s, { now: NOW + 60 }), (e) => e.code === 'PLAN_ALREADY_SUBMITTED');
  assert.equal(s.horizon.calls.transactionPages - mark, 1);
});

test('when maxLookupPages is reached before the plan time, build fails closed and says to pass alreadySubmitted', async () => {
  const s = scenario({ points: { a: 60, b: 40 } });
  s.horizon.noise(s.payer.publicKey(), 1000); // as recent as the plan: it never reaches back past it
  await assert.rejects(buildOf(s, { maxLookupPages: 2 }), (e) => {
    assert.equal(e.code, 'CANNOT_CHECK_SUBMISSIONS');
    assert.match(e.message, /alreadySubmitted/);
    return true;
  });
  assert.equal(s.horizon.calls.transactionPages, 2, 'it read exactly the pages it was allowed');
  assert.ok(await buildOf(s, { maxLookupPages: 10 }), 'with a bigger limit the list ends before the valve');
  for (const bad of [0, -1, 1.5, '3', NaN]) await assert.rejects(buildOf(s, { maxLookupPages: bad }), (e) => e.statusCode === 400, String(bad));
  // The default is 25 pages: 25 full pages of recent transactions cannot be checked either.
  const big = scenario({ points: { a: 1 } });
  big.horizon.noise(big.payer.publicKey(), 25 * 200 + 1);
  await assert.rejects(buildOf(big), (e) => e.code === 'CANNOT_CHECK_SUBMISSIONS');
  assert.equal(big.horizon.calls.transactionPages, 25);
});

test('only transactions whose source is the payer count', async () => {
  const s = scenario({ points: { a: 60, b: 40 } });
  const built = await submitted(s);
  const other = wallet();
  s.horizon.history.forEach((r) => { r.source_account = other; }); // the same transaction, but of somebody else
  assert.ok(await buildOf(s, { now: NOW + 60 }), `${built.hashes.length} transaction(s) of another account do not block the payer`);
});

test('build returns validUntil, the latest maxTime of its transactions', async () => {
  const s = scenario({ points: Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`p${i}`, 1 + i])) });
  const built = await buildOf(s);
  assert.equal(built.xdrs.length, 3);
  const times = built.xdrs.map((x) => Number(parse(x).timeBounds.maxTime));
  assert.equal(built.validUntil, Math.max(...times));
  assert.ok(Number.isInteger(built.validUntil) && built.validUntil > Math.floor(Date.now() / 1000));
});
