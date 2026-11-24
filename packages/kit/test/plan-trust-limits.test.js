'use strict';

// What an unsealed plan can and cannot be trusted for (the documented limits),
// the sealing rules, and the plan-level checks that build() repeats. Offline.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  kit, NOW, DAY, scenario, simpleProgram, tenant, wallet, account, fakeHorizon, signXdr,
} = require('./_helpers');

const KEY = 'k'.repeat(40);
const POCKETS = [
  { id: 'now', label: 'Now', share: 0.7, rule: { type: 'instant' } },
  { id: 'later', label: 'Later', share: 0.3, rule: { type: 'expires', afterDays: 30 } },
];
const clone = (o) => JSON.parse(JSON.stringify(o));
const buildOf = (s, extra = {}) => kit.build(s.program, s.tenant, { plan: s.plan, payer: s.payer.publicKey(), horizon: s.horizon, now: s.now, ...extra });
const fresh = (s) => { s.horizon = fakeHorizon(s.accounts); };
const peopleOfPlan = (plan) => Object.fromEntries(plan.payments.map((p) => [p.participantId, { name: p.name, wallet: p.wallet }]));

/** What anybody who holds a plan can do: edit it, fix the totals the way a careful editor would, recompute the id. */
function reidentified(plan, program, edit) {
  const p = clone(plan);
  edit(p);
  const bps = program.pockets.map((k) => k.shareBp);
  for (const pay of p.payments) {
    const parts = kit.money.splitByBasisPoints(kit.money.toStroops(pay.amount), bps);
    pay.pockets = program.pockets
      .map((k, i) => ({ id: k.id, label: k.label, amount: kit.money.fromStroops(parts[i]), rule: { type: k.rule.type, at: k.rule.type === 'instant' ? null : p.createdAt + k.rule.afterSeconds } }))
      .filter((k, i) => parts[i] > 0n);
  }
  p.total = kit.money.fromStroops(p.payments.reduce((sum, x) => sum + kit.money.toStroops(x.amount), 0n));
  p.planId = kit.planIdOf(p);
  return p;
}

// ── the limits of an unsealed plan, stated exactly (docs/kit.md, "Trusting a plan") ──

test('without a sealKey an edited plan still builds in these ways; with a sealKey every one is refused', async () => {
  const program = simpleProgram({ pockets: POCKETS });
  const s = scenario({ program, points: { a: 60, b: 40 } });
  const people = peopleOfPlan(s.plan);
  const registered = s.plan.payments.map((p) => p.wallet);
  const sealed = kit.plan(program, s.tenant, { standings: s.standings, people, now: NOW, sealKey: KEY });
  const old = kit.plan(program, s.tenant, { standings: s.standings, people, now: NOW - 5 * DAY, sealKey: KEY });

  const edits = {
    'wallets swapped between registered people': (p) => { [p.payments[0].wallet, p.payments[1].wallet] = [p.payments[1].wallet, p.payments[0].wallet]; },
    'amount moved between people': (p) => { p.payments[0].amount = '5.0000000'; p.payments[1].amount = '95.0000000'; },
    'a payment removed': (p) => { p.payments.pop(); },
    'createdAt moved to now': (p) => { p.createdAt = NOW; },
    'salt changed': (p) => { p.salt = '0'.repeat(32); },
  };
  for (const [label, edit] of Object.entries(edits)) {
    const base = label.startsWith('createdAt') ? old : sealed;
    const unsealed = clone(base);
    delete unsealed.seal;
    fresh(s);
    const built = await buildOf(s, { plan: reidentified(unsealed, program, edit), wallets: registered });
    assert.ok(built.operations.length > 0, `unsealed: "${label}" builds (a documented limit)`);
    // The same edit on a sealed plan: the seal no longer matches the recomputed id.
    fresh(s);
    await assert.rejects(buildOf(s, { plan: reidentified(base, program, edit), sealKey: KEY, wallets: registered }),
      (e) => e.statusCode === 400 && e.code === 'PLAN_ALTERED', `sealed: "${label}"`);
  }
  // The old plan, unedited, is too old: it is the edit of createdAt that made it buildable.
  fresh(s);
  await assert.rejects(buildOf(s, { plan: old, sealKey: KEY }), (e) => e.code === 'PLAN_EXPIRED');
});

test('without a sealKey a changed salt hides an earlier payment from the already-submitted check; the same plan does not', async () => {
  const s = scenario({ points: { a: 60, b: 40 } });
  const built = await buildOf(s);
  await kit.submit(s.tenant, { built, signedXdrs: built.xdrs.map((x) => signXdr(x, s.payer)), horizon: s.horizon });
  await assert.rejects(buildOf(s, { now: NOW + 60 }), (e) => e.code === 'PLAN_ALREADY_SUBMITTED');
  const resalted = reidentified(s.plan, s.program, (p) => { p.salt = '0'.repeat(32); });
  assert.ok(await buildOf(s, { plan: resalted, now: NOW + 60 }), 'the documented limit: use sealKey, or alreadySubmitted from the host records');
});

// ── a missing key must not silently turn sealing off ───────────────────────

test('a sealKey property that is present but undefined, null or empty throws INVALID_SEAL_KEY (createProgram, plan, build)', async () => {
  const s = scenario();
  const people = peopleOfPlan(s.plan);
  const missing = process.env.HARMONY_TEST_SURELY_UNSET; // undefined, as an unset environment variable is
  const code = (e) => e.statusCode === 400 && e.code === 'INVALID_SEAL_KEY';
  for (const bad of [missing, undefined, null, '', Buffer.alloc(0)]) {
    assert.throws(() => kit.createProgram({ tenant: { id: 'acme', network: 'testnet' }, program: s.program, sealKey: bad }), code, `createProgram ${String(bad)}`);
    assert.throws(() => kit.plan(s.program, s.tenant, { standings: s.standings, people, now: NOW, sealKey: bad }), code, `plan ${String(bad)}`);
    await assert.rejects(buildOf(s, { sealKey: bad }), code, `build ${String(bad)}`);
  }
  // A per-call property that is present and empty is refused on an instance too.
  const harmony = kit.createProgram({ tenant: { id: 'acme-kit', network: 'testnet' }, program: s.program });
  assert.throws(() => harmony.plan({ standings: s.standings, people, now: NOW, sealKey: missing }), code);
  // Leaving the property out is the way to run unsealed.
  assert.equal(kit.plan(s.program, s.tenant, { standings: s.standings, people, now: NOW }).seal, undefined);
});

test('build refuses a plan that carries a seal when no key was given (PLAN_SEALED_NO_KEY)', async () => {
  const s = scenario();
  const sealed = kit.plan(s.program, s.tenant, { standings: s.standings, people: peopleOfPlan(s.plan), now: NOW, sealKey: KEY });
  await assert.rejects(buildOf(s, { plan: sealed }), (e) => e.statusCode === 400 && e.code === 'PLAN_SEALED_NO_KEY');
  assert.ok(await buildOf(s, { plan: sealed, sealKey: KEY }));
});

// ── the network is part of the plan id ─────────────────────────────────────

test('a sealed testnet plan relabelled as mainnet is refused', async () => {
  const asset = { code: 'PTS', issuer: wallet() };
  const testnet = tenant({ rewardAsset: asset });
  const mainnet = tenant({ network: 'mainnet', rewardAsset: asset });
  const program = simpleProgram();
  const s = scenario({ program, points: { a: 60, b: 40 } });
  const plan = kit.plan(program, testnet, { standings: s.standings, people: peopleOfPlan(s.plan), now: NOW, sealKey: KEY });
  const relabelled = clone(plan);
  relabelled.network = 'mainnet';
  assert.notEqual(kit.planIdOf(relabelled), plan.planId, 'the id covers the network');
  const run = (p) => kit.build(program, mainnet, { plan: p, payer: s.payer.publicKey(), horizon: s.horizon, now: NOW, sealKey: KEY });
  await assert.rejects(run(relabelled), (e) => e.code === 'PLAN_ALTERED', 'stale id');
  relabelled.planId = kit.planIdOf(relabelled);
  await assert.rejects(run(relabelled), (e) => e.code === 'PLAN_ALTERED', 'recomputed id, but the seal covered the old one');
});

// ── plan-level checks repeated in build ────────────────────────────────────

test('build repeats DUPLICATE_PARTICIPANT and SHARED_WALLET; allowSharedWallets lets a shared wallet through', async () => {
  const s = scenario({ points: { a: 60, b: 40 } });
  const dup = reidentified(s.plan, s.program, (p) => { p.payments.push(clone(p.payments[1])); });
  await assert.rejects(buildOf(s, { plan: dup }), (e) => e.statusCode === 400 && e.code === 'DUPLICATE_PARTICIPANT');

  const shared = reidentified(s.plan, s.program, (p) => { p.payments[1].wallet = p.payments[0].wallet; });
  await assert.rejects(buildOf(s, { plan: shared }), (e) => e.statusCode === 409 && e.code === 'SHARED_WALLET');
  await assert.rejects(buildOf(s, { plan: shared, allowSharedWallets: 'yes' }), (e) => e.code === 'SHARED_WALLET', 'only true allows it');
  assert.equal((await buildOf(s, { plan: shared, allowSharedWallets: true })).operations.length, 2);
});

// ── room on a trustline, across every payment of the wallet ─────────────────

test('the room of a shared wallet must hold ALL its plain payments, not just the first', async () => {
  const s = scenario({ points: { a: 1, b: 1 } }); // 50 each
  const shared = wallet();
  const people = { a: { name: 'A', wallet: shared }, b: { name: 'B', wallet: shared } };
  s.plan = kit.plan(s.program, s.tenant, { standings: s.standings, people, now: NOW, options: { allowSharedWallets: true } });
  const payer = s.payer.publicKey();
  const kinds = async (limit) => {
    s.horizon = fakeHorizon({ [payer]: s.accounts[payer], [shared]: account({ usdc: '0.0000000', limit }) });
    const built = await buildOf(s, { allowSharedWallets: true });
    return built.operations.map((o) => `${o.kind}${o.reason ? `:${o.reason}` : ''}`);
  };
  // Room for one payment of 50 but not for two: neither is a plain payment, both wait as claimable balances.
  assert.deepEqual(await kinds('60.0000000'), ['hold:trustline limit too low', 'hold:trustline limit too low']);
  assert.deepEqual(await kinds('100.0000000'), ['payment', 'payment']);
});
