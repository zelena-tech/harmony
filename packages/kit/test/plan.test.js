'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { payouts } = require('@zelena/harmony-core');
const { simpleProgram, scoreOf, peopleOf, tenant, wallet, NOW, DAY, kit } = require('./_helpers');
const { toStroops } = require('../src/money');

const sumStroops = (list) => list.reduce((s, a) => s + toStroops(a), 0n);

/** Every payment's pockets add up to it, and the payments add up to the plan total. */
function assertExact(p) {
  for (const pay of p.payments) {
    assert.equal(sumStroops(pay.pockets.map((k) => k.amount)), toStroops(pay.amount), `pockets of ${pay.participantId}`);
    assert.ok(/^\d+\.\d{7}$/.test(pay.amount), `amount format ${pay.amount}`);
    pay.pockets.forEach((k) => assert.ok(/^\d+\.\d{7}$/.test(k.amount) && toStroops(k.amount) > 0n));
  }
  assert.equal(sumStroops(p.payments.map((x) => x.amount)), toStroops(p.total));
  assert.equal(sumStroops(p.byPocket.map((x) => x.amount)), toStroops(p.total));
  kit.assertPlanIntegrity(p);
}

const THREE_POCKETS = [
  { id: 'now', label: 'Now', share: 0.5, rule: { type: 'instant' } },
  { id: 'soon', label: 'Soon', share: 0.3, rule: { type: 'expires', afterDays: 14 } },
  { id: 'later', label: 'Later', share: 0.2, rule: { type: 'unlocks', afterDays: 60 } },
];

const SALT = '0123456789abcdef0123456789abcdef'; // a fixed salt makes plan ids reproducible

function run(program, points, { t = tenant(), people, planInput = {} } = {}) {
  const { standings } = scoreOf(program, points);
  const who = people || peopleOf(Object.keys(points));
  return { plan: kit.plan(program, t, { standings, people: who, now: NOW, salt: SALT, ...planInput }), standings, people: who, tenant: t };
}

test('proportional: the whole pool is shared by points, to the stroop', () => {
  const { plan } = run(simpleProgram(), { a: 50, b: 30, c: 20 });
  assert.deepEqual(plan.payments.map((p) => [p.participantId, p.amount]), [['a', '50.0000000'], ['b', '30.0000000'], ['c', '20.0000000']]);
  assert.equal(plan.total, '100.0000000');
  assert.deepEqual(plan.rule, { model: 'proportional', pool: 100 });
  assert.deepEqual(plan.payments.map((p) => p.rank), [1, 2, 3]);
  assertExact(plan);
});

test('proportional: an awkward pool (100 / 3) is shared without losing a stroop', () => {
  const { plan } = run(simpleProgram(), { a: 10, b: 10, c: 10 });
  assert.equal(plan.total, '100.0000000');
  // The residue of 1 stroop goes to the first position.
  assert.deepEqual(plan.payments.map((p) => p.amount), ['33.3333334', '33.3333333', '33.3333333']);
  assertExact(plan);
});

test('proportional: stroop-scale pools', () => {
  const one = run(simpleProgram({ payout: { model: 'proportional', pool: 0.0000001 } }), { a: 10, b: 10, c: 10 });
  assert.equal(one.plan.total, '0.0000001');
  assert.equal(one.plan.payments.length, 1); // others would get 0 and are left out
  assert.equal(one.plan.payments[0].amount, '0.0000001');
  assert.equal(one.plan.payments[0].pockets.length, 1);
  assertExact(one.plan);

  const seven = run(simpleProgram({ payout: { model: 'proportional', pool: 0.0000007 } }), { a: 1, b: 2, c: 3, d: 4 });
  assert.equal(seven.plan.total, '0.0000007');
  assertExact(seven.plan);

  // One stroop spread over pockets: it lands whole in the first pocket.
  const pockets = run(simpleProgram({ payout: { model: 'proportional', pool: 0.0000001 }, pockets: THREE_POCKETS }), { a: 1 });
  assert.deepEqual(pockets.plan.payments[0].pockets.map((k) => [k.id, k.amount]), [['now', '0.0000001']]);
  assertExact(pockets.plan);
});

test('pockets split every payment exactly, with the remainder in the first pocket', () => {
  const { plan } = run(simpleProgram({ pockets: THREE_POCKETS }), { a: 10, b: 10, c: 10 });
  assertExact(plan);
  const first = plan.payments[0];
  assert.equal(first.amount, '33.3333334');
  // 50% = 16.66666670, 30% = 10.00000002 -> 10.0000000, 20% = 6.66666668 -> 6.6666666, remainder 1 stroop
  const stroops = first.pockets.map((k) => toStroops(k.amount));
  assert.equal(stroops[1], (333333334n * 3000n) / 10000n);
  assert.equal(stroops[2], (333333334n * 2000n) / 10000n);
  assert.equal(stroops[0], 333333334n - stroops[1] - stroops[2]);
  assert.deepEqual(plan.byPocket.map((x) => x.id), ['now', 'soon', 'later']);
  assert.deepEqual(plan.byPocket.map((x) => x.rule), ['instant', 'expires', 'unlocks']);
});

test('pocket dates come from `now` plus the delay; instant pockets have none', () => {
  const { plan } = run(simpleProgram({ pockets: THREE_POCKETS }), { a: 10 });
  const [now, soon, later] = plan.payments[0].pockets;
  assert.deepEqual(now.rule, { type: 'instant', at: null });
  assert.deepEqual(soon.rule, { type: 'expires', at: NOW + 14 * DAY });
  assert.deepEqual(later.rule, { type: 'unlocks', at: NOW + 60 * DAY });
  assert.equal(plan.createdAt, NOW);
});

test('many random pools and points always add up exactly', () => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let trial = 0; trial < 150; trial++) {
    const n = 1 + Math.floor(rnd() * 12);
    const poolStroops = 1 + Math.floor(rnd() * 5e11);
    const pool = poolStroops / 1e7;
    const points = {};
    for (let i = 0; i < n; i++) points[`p${i}`] = 1 + Math.floor(rnd() * 900);
    const { plan } = run(simpleProgram({ payout: { model: 'proportional', pool }, pockets: THREE_POCKETS }), points);
    assert.equal(toStroops(plan.total), BigInt(poolStroops), `trial ${trial}: pool ${pool}`);
    assertExact(plan);
  }
});

test('topN: a base for everybody who qualifies and the pool among the top', () => {
  const program = simpleProgram({ payout: { model: 'topN', pool: 100, topN: 2, base: 5 } });
  const { plan } = run(program, { a: 60, b: 20, c: 15, d: 5 });
  const by = Object.fromEntries(plan.payments.map((p) => [p.participantId, p.amount]));
  // top two share 100 in proportion 60:20 -> 75 and 25
  assert.deepEqual(by, { a: '80.0000000', b: '30.0000000', c: '5.0000000', d: '5.0000000' });
  assert.equal(plan.total, '120.0000000'); // the pool plus a base for each of the four
  assert.deepEqual(plan.rule, { model: 'topN', pool: 100, topN: 2, base: 5 });
  assert.match(plan.payments[0].detail, /prize 75\.00 \(rank 1\)/);
  assert.equal(plan.payments[2].detail, 'base 5');
  assertExact(plan);
});

test('topN without base pays only the top', () => {
  const { plan } = run(simpleProgram({ payout: { model: 'topN', pool: 90, topN: 2 } }), { a: 2, b: 1, c: 1 });
  assert.deepEqual(plan.payments.map((p) => p.participantId), ['a', 'b']);
  assert.equal(plan.total, '90.0000000');
  assertExact(plan);
});

test('rate: every point is worth the rate; the budget scales the pool down', () => {
  const noBudget = run(simpleProgram({ payout: { model: 'rate', rate: 0.02 } }), { a: 100, b: 50 });
  assert.deepEqual(noBudget.plan.payments.map((p) => p.amount), ['2.0000000', '1.0000000']);
  assert.equal(noBudget.plan.total, '3.0000000');
  assert.equal(noBudget.plan.rule.scaledToBudget, false);
  assertExact(noBudget.plan);

  const tight = run(simpleProgram({ payout: { model: 'rate', rate: 0.02, budget: 1.5 } }), { a: 100, b: 50 });
  assert.equal(tight.plan.total, '1.5000000');
  assert.deepEqual(tight.plan.payments.map((p) => p.amount), ['1.0000000', '0.5000000']);
  assert.equal(tight.plan.rule.scaledToBudget, true);
  assert.equal(tight.plan.rule.due, '3.0000000');
  assertExact(tight.plan);

  const roomy = run(simpleProgram({ payout: { model: 'rate', rate: 0.02, budget: 10 } }), { a: 100, b: 50 });
  assert.equal(roomy.plan.total, '3.0000000');
  assert.equal(roomy.plan.rule.scaledToBudget, false);
});

test('rate with an awkward rate still adds up to the stroop', () => {
  const { plan } = run(simpleProgram({ payout: { model: 'rate', rate: 0.0123457 }, pockets: THREE_POCKETS }), { a: 333, b: 777, c: 1 });
  assert.equal(plan.total, plan.rule.due);
  assertExact(plan);
});

test('options override the program for one run', () => {
  const program = simpleProgram({ payout: { model: 'topN', pool: 100, topN: 2, base: 0 } });
  const { plan } = run(program, { a: 3, b: 1, c: 1 }, { planInput: { options: { pool: 50, topN: 3, base: 1 } } });
  assert.equal(plan.total, '53.0000000');
  assert.deepEqual(plan.rule, { model: 'topN', pool: 50, topN: 3, base: 1 });
  const rate = run(simpleProgram({ payout: { model: 'rate', rate: 1 } }), { a: 10 }, { planInput: { options: { rate: 0.5 } } });
  assert.equal(rate.plan.total, '5.0000000');
});

test('invalid options and empty inputs fail with a clear status', () => {
  const t = tenant();
  const { standings } = scoreOf(simpleProgram(), { a: 1 });
  const people = peopleOf(['a']);
  const fail = (program, input, status, pattern) => assert.throws(() => kit.plan(program, t, input), (e) => e.statusCode === status && pattern.test(e.message));
  fail(simpleProgram(), { standings, people, now: NOW, options: { pool: -1 } }, 400, /pool must be a number > 0/);
  fail(simpleProgram({ payout: { model: 'rate', rate: 1 } }), { standings, people, now: NOW, options: { rate: 0 } }, 400, /rate must be/);
  fail(simpleProgram({ payout: { model: 'rate', rate: 1 } }), { standings, people, now: NOW, options: { budget: -2 } }, 400, /budget must be/);
  fail(simpleProgram(), { standings, people, now: 0 }, 400, /now must be a unix time/);
  fail(simpleProgram(), { standings, people, now: 1.5 }, 400, /now must be a unix time/);
  fail(simpleProgram(), { standings: [], people, now: NOW }, 409, /no standings/);
  fail(simpleProgram(), { people, now: NOW }, 409, /no standings/);
  fail(simpleProgram(), undefined, 409, /no standings/);
});

test('nobody qualified: there is nobody to pay', () => {
  const program = simpleProgram({ minPoints: 100 });
  const { standings } = scoreOf(program, { a: 10, b: 20 });
  assert.throws(() => kit.plan(program, tenant(), { standings, people: peopleOf(['a', 'b']), now: NOW }), (e) => e.statusCode === 409 && e.code === 'NOBODY_QUALIFIED');
});

test('people below the minimum are not paid; the rest keep their ranks', () => {
  const program = simpleProgram({ minPoints: 15 });
  const { plan } = run(program, { a: 40, b: 10, c: 20 });
  assert.deepEqual(plan.payments.map((p) => [p.participantId, p.rank]), [['a', 1], ['c', 2]]);
  assert.equal(plan.total, '100.0000000');
});

test('people can be an array or a map; missing people use their id as name', () => {
  const t = tenant();
  const w = wallet();
  const { standings } = scoreOf(simpleProgram(), { a: 1, b: 1 });
  const fromArray = kit.plan(simpleProgram(), t, { standings, people: [{ participantId: 'a', name: 'Ana', wallet: w }], now: NOW });
  assert.equal(fromArray.payments.length, 1);
  assert.equal(fromArray.payments[0].name, 'Ana');
  assert.deepEqual(fromArray.withoutWallet, ['b']);
  const fromMap = kit.plan(simpleProgram(), t, { standings, people: { a: { name: 'Ana', wallet: w } }, now: NOW });
  assert.equal(fromMap.payments[0].wallet, w);
  assert.equal(fromMap.payments[0].walletShort, `${w.slice(0, 4)}…${w.slice(-6)}`);
});

test('a share that belongs to someone without a wallet is withheld, never redistributed', () => {
  const people = peopleOf(['a', 'b', 'c']);
  people.a.wallet = null;
  const { plan } = run(simpleProgram(), { a: 50, b: 30, c: 20 }, { people });
  assert.deepEqual(plan.payments.map((p) => [p.participantId, p.amount]), [['b', '30.0000000'], ['c', '20.0000000']]);
  assert.deepEqual(plan.withheld, [{ name: 'Person a', rank: 1, amount: '50.0000000' }]);
  assert.deepEqual(plan.withoutWallet, ['Person a']);
  assert.equal(plan.total, '50.0000000');
  // withheld + paid = the pool: nothing disappeared and nothing moved to others
  assert.equal(toStroops(plan.total) + toStroops(plan.withheld[0].amount), toStroops('100'));
  assertExact(plan);
});

test('an invalid wallet counts as no wallet', () => {
  const people = peopleOf(['a', 'b']);
  people.a.wallet = 'GNOTAWALLET';
  const { plan } = run(simpleProgram(), { a: 1, b: 1 }, { people });
  assert.equal(plan.payments.length, 1);
  assert.equal(plan.withheld.length, 1);
});

test('whoever already got the bonus of the campaign is left out, unless re-included', () => {
  const people = peopleOf(['a', 'b', 'c']);
  const previous = payouts.summarizePrevious([{ workerId: 'a', wallet: people.a.wallet, kind: 'bonus', amount: 10 }]);
  const { plan } = run(simpleProgram(), { a: 50, b: 30, c: 20 }, { people, planInput: { previous } });
  assert.deepEqual(plan.payments.map((p) => p.participantId), ['b', 'c']);
  assert.equal(plan.excludedAlreadyPaid.length, 1);
  assert.equal(plan.excludedAlreadyPaid[0].name, 'Person a');
  const again = run(simpleProgram(), { a: 50, b: 30, c: 20 }, { people, planInput: { previous, options: { includeAlreadyPaid: true } } });
  assert.deepEqual(again.plan.payments.map((p) => p.participantId), ['a', 'b', 'c']);
  assert.equal(again.plan.payments[0].alreadyPaidBonus, 10);
});

test('previous payments keyed by a number still exclude the person (ids are strings in the kit)', () => {
  const people = peopleOf(['7', '8']);
  const previous = payouts.summarizePrevious([{ workerId: 7, wallet: people['7'].wallet, kind: 'bonus', amount: 10 }]);
  const { plan } = run(simpleProgram(), { 7: 10, 8: 10 }, { people, planInput: { previous } });
  assert.deepEqual(plan.payments.map((p) => p.participantId), ['8']);
  assert.equal(plan.excludedAlreadyPaid.length, 1);
});

test('wallet changes raise an alert on the payment', () => {
  const people = peopleOf(['a', 'b']);
  const walletChanges = new Map([['a', { hours: 5 }]]);
  const { plan } = run(simpleProgram(), { a: 1, b: 1 }, { people, planInput: { walletChanges } });
  assert.match(plan.payments[0].alert, /wallet changed 5 h ago/);
  assert.equal(plan.payments[1].alert, null);
  assert.equal(plan.flagged, 1);
  const numeric = run(simpleProgram(), { 7: 1 }, { people: peopleOf(['7']), planInput: { walletChanges: new Map([[7, { hours: 2 }]]) } });
  assert.equal(numeric.plan.flagged, 1);
});

test('the tenant caps are enforced when planning', () => {
  const t = tenant({ payouts: { caps: { perPerson: 40 } } });
  assert.throws(() => run(simpleProgram(), { a: 50, b: 30, c: 20 }, { t }), (e) => e.statusCode === 409 && e.cap === 'person');
  const batch = tenant({ payouts: { caps: { perBatch: 90 } } });
  assert.throws(() => run(simpleProgram(), { a: 50, b: 30, c: 20 }, { t: batch }), (e) => e.statusCode === 409 && e.cap === 'batch');
  const fine = tenant({ payouts: { caps: { perPerson: 50, perBatch: 100 } } });
  assert.equal(run(simpleProgram(), { a: 50, b: 30, c: 20 }, { t: fine }).plan.total, '100.0000000');
});

test('planId is deterministic for the same salt and changes when anything that is paid changes', () => {
  const people = peopleOf(['a', 'b']);
  const first = run(simpleProgram(), { a: 60, b: 40 }, { people }).plan;
  const same = run(simpleProgram(), { a: 60, b: 40 }, { people }).plan;
  assert.equal(first.planId, same.planId);
  assert.match(first.planId, /^[0-9a-f]{64}$/);

  const differentPoints = run(simpleProgram(), { a: 61, b: 40 }, { people }).plan;
  assert.notEqual(differentPoints.planId, first.planId);

  const otherWallet = { ...people, b: { ...people.b, wallet: wallet() } };
  assert.notEqual(run(simpleProgram(), { a: 60, b: 40 }, { people: otherWallet }).plan.planId, first.planId);

  const otherTime = run(simpleProgram(), { a: 60, b: 40 }, { people, planInput: { now: NOW + 1 } }).plan;
  assert.notEqual(otherTime.planId, first.planId);

  const otherPool = run(simpleProgram({ payout: { model: 'proportional', pool: 101 } }), { a: 60, b: 40 }, { people }).plan;
  assert.notEqual(otherPool.planId, first.planId);

  const otherPockets = run(simpleProgram({ pockets: THREE_POCKETS }), { a: 60, b: 40 }, { people }).plan;
  assert.notEqual(otherPockets.planId, first.planId);

  const otherTenant = run(simpleProgram(), { a: 60, b: 40 }, { people, t: tenant({ id: 'other-org' }) }).plan;
  assert.notEqual(otherTenant.planId, first.planId);

  const otherProgram = run(simpleProgram({ id: 'another' }), { a: 60, b: 40 }, { people }).plan;
  assert.notEqual(otherProgram.planId, first.planId);
});

test('assertPlanIntegrity accepts a fresh plan and rejects every kind of edit', () => {
  const { plan } = run(simpleProgram({ pockets: THREE_POCKETS }), { a: 60, b: 40 });
  kit.assertPlanIntegrity(plan);
  const clone = () => JSON.parse(JSON.stringify(plan));
  const rejects = (edit, label) => {
    const p = clone();
    edit(p);
    assert.throws(() => kit.assertPlanIntegrity(p), (e) => e.statusCode === 400 && e.code === 'PLAN_ALTERED', label);
  };
  rejects((p) => { p.payments[0].amount = '99.0000000'; }, 'payment amount');
  rejects((p) => { p.payments[0].pockets[0].amount = '1.0000000'; }, 'pocket amount');
  rejects((p) => { p.total = '1.0000000'; }, 'total');
  rejects((p) => { p.payments[1].wallet = wallet(); }, 'wallet');
  rejects((p) => { p.planId = '0'.repeat(64); }, 'plan id');
  rejects((p) => { p.payments[0].pockets[1].rule.at += 1; }, 'pocket date');
  rejects((p) => { p.payments[0].pockets[2].rule.type = 'instant'; }, 'pocket rule');
  rejects((p) => { p.createdAt += 1; }, 'creation time');
  rejects((p) => { p.asset.issuer = wallet(); }, 'asset');
  rejects((p) => { p.payments.pop(); }, 'removed payment');
  rejects((p) => { p.payments = []; }, 'no payments');
  rejects((p) => { delete p.payments[0].pockets; }, 'no pockets');
  rejects((p) => { p.payments[0].pockets[0].amount = '0.0000000'; p.payments[0].pockets[1].amount = String(p.payments[0].amount); }, 'zero pocket');
  // Editing amount, pockets and total consistently still breaks the id.
  rejects((p) => {
    p.payments[0].amount = '10.0000000';
    p.payments[0].pockets = [{ ...p.payments[0].pockets[0], amount: '10.0000000' }];
    p.total = '50.0000000';
  }, 'consistent edit');
  assert.throws(() => kit.assertPlanIntegrity(null), (e) => e.code === 'PLAN_ALTERED');
});

test('the plan holds no secret and only strings for money', () => {
  const { plan } = run(simpleProgram({ pockets: THREE_POCKETS }), { a: 60, b: 40 });
  for (const p of plan.payments) {
    assert.equal(typeof p.amount, 'string');
    p.pockets.forEach((k) => assert.equal(typeof k.amount, 'string'));
  }
  assert.equal(typeof plan.total, 'string');
  assert.doesNotMatch(JSON.stringify(plan), /S[A-Z2-7]{55}/);
});

test('E: the plan has a random salt; the id depends on it', () => {
  const people = peopleOf(['a', 'b']);
  const random = (n) => run(simpleProgram(), { a: 60, b: 40 }, { people, planInput: { salt: undefined } }).plan;
  const [x, y] = [random(), random()];
  assert.match(x.salt, /^[0-9a-f]{32}$/);
  assert.notEqual(x.salt, y.salt);
  assert.notEqual(x.planId, y.planId, 'the same data with another salt is another id');
  kit.assertPlanIntegrity(x);

  const same = (salt) => run(simpleProgram(), { a: 60, b: 40 }, { people, planInput: { salt } }).plan;
  assert.equal(same(SALT).planId, same(SALT).planId);
  assert.notEqual(same(SALT).planId, same('f'.repeat(32)).planId);
  // The salt is part of what the id covers: swapping it without recomputing the id is detected.
  const tampered = { ...same(SALT), salt: 'f'.repeat(32) };
  assert.throws(() => kit.assertPlanIntegrity(tampered), (e) => e.code === 'PLAN_ALTERED');
  for (const bad of ['', 'abc', 'G'.repeat(32), 'A'.repeat(32), 5]) {
    assert.throws(() => same(bad), (e) => e.statusCode === 400, String(bad));
  }
});

test('D: duplicate participant ids in the standings are refused', () => {
  const { standings } = scoreOf(simpleProgram(), { a: 50, b: 50 });
  const people = peopleOf(['a', 'b']);
  assert.throws(() => kit.plan(simpleProgram(), tenant(), { standings: [...standings, standings[0]], people, now: NOW }),
    (e) => e.statusCode === 400 && e.code === 'DUPLICATE_PARTICIPANT');
  // A number and its string are the same participant.
  const asNumber = [{ ...standings[0], participantId: 1 }, { ...standings[1], participantId: '1' }];
  assert.throws(() => kit.plan(simpleProgram(), tenant(), { standings: asNumber, people: { 1: { name: 'x', wallet: wallet() } }, now: NOW }), (e) => e.code === 'DUPLICATE_PARTICIPANT');
});

test('D: two different participants with the same wallet are refused unless allowSharedWallets', () => {
  const { standings } = scoreOf(simpleProgram(), { a: 50, b: 30, c: 20 });
  const shared = wallet();
  const people = { a: { name: 'A', wallet: shared }, b: { name: 'B', wallet: shared }, c: { name: 'C', wallet: wallet() } };
  const plan = (options) => kit.plan(simpleProgram(), tenant(), { standings, people, now: NOW, ...(options ? { options } : {}) });
  assert.throws(() => plan(), (e) => e.statusCode === 409 && e.code === 'SHARED_WALLET');
  assert.throws(() => plan({ allowSharedWallets: 'yes' }), (e) => e.code === 'SHARED_WALLET', 'only true allows it');
  assert.equal(plan({ allowSharedWallets: true }).payments.length, 3);
  // Somebody who did not qualify does not count.
  const { standings: some } = scoreOf(simpleProgram({ minPoints: 40 }), { a: 50, b: 30, c: 60 });
  assert.equal(kit.plan(simpleProgram({ minPoints: 40 }), tenant(), { standings: some, people, now: NOW }).payments.length, 2);
});

test('D: a pool so small that the shares round up past it is refused (proportional and rate)', () => {
  const points = {};
  for (let i = 0; i < 3000; i++) points[`p${i}`] = 1;
  const small = simpleProgram({ payout: { model: 'proportional', pool: 0.0011 } });
  const { standings } = scoreOf(small, points);
  const people = peopleOf(Object.keys(points));
  assert.throws(() => kit.plan(small, tenant(), { standings, people, now: NOW }), (e) => e.statusCode === 409 && e.code === 'POOL_TOO_SMALL');

  // The same through the rate model: due = points x rate, 3000 x 0.00000036667
  const rate = simpleProgram({ payout: { model: 'rate', rate: 0.00000036667 } });
  const r = scoreOf(rate, points);
  assert.throws(() => kit.plan(rate, tenant(), { standings: r.standings, people, now: NOW, options: { budget: 0.0011 } }), (e) => e.code === 'POOL_TOO_SMALL');

  // A pool that shares evenly is fine, and so is the whole existing range of ordinary pools.
  const fine = simpleProgram({ payout: { model: 'proportional', pool: 100 } });
  assert.equal(kit.plan(fine, tenant(), { standings: scoreOf(fine, points).standings, people, now: NOW }).total, '100.0000000');
});
