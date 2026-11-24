'use strict';

// The split BETWEEN people is exact to the stroop: floor of each share, the
// leftover stroops by largest remainder (ties to the better rank). Property
// style, with a seeded generator so a failure can be reproduced.

const test = require('node:test');
const assert = require('node:assert/strict');
const { payouts } = require('@zelena/harmony-core');
const {
  kit, NOW, simpleProgram, scoreOf, tenant, wallet,
} = require('./_helpers');
const { toStroops, fromStroops, splitProportional } = require('../src/money');

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const POOL_WALLETS = Array.from({ length: 3000 }, () => wallet());
const sum = (list) => list.reduce((s, v) => s + v, 0n);

/** pool in units, whole stroops: from 1 stroop up to `maxUnits` units */
const randomPool = (r, maxUnits) => {
  const stroops = BigInt(Math.floor(r() * maxUnits * 1e7)) + 1n;
  return fromStroops(stroops);
};

test('splitProportional: shares add up to the pool exactly and none is a whole stroop away from the real share', () => {
  const r = rng(20260724);
  for (let n = 0; n < 400; n++) {
    const people = 1 + Math.floor(r() * 3000);
    const weights = Array.from({ length: people }, () => BigInt(1 + Math.floor(r() * (r() < 0.2 ? 1e9 : 1000))));
    const pool = toStroops(randomPool(r, r() < 0.5 ? 1000 : 9e8));
    const parts = splitProportional(pool, weights);
    const total = sum(weights);
    assert.equal(sum(parts), pool, `sum, ${people} people`);
    parts.forEach((part, i) => {
      // |part - pool x w / total| < 1 stroop, in exact integer arithmetic
      const diff = part * total - pool * weights[i];
      assert.ok((diff < 0n ? -diff : diff) < total, `share ${i} is within one stroop of the real one`);
    });
  }
});

test('splitProportional: leftover stroops go to the largest remainder, ties to the better rank', () => {
  assert.deepEqual(splitProportional(100n, [1n, 1n, 1n]), [34n, 33n, 33n]);
  assert.deepEqual(splitProportional(1n, [5n, 5n, 5n]), [1n, 0n, 0n]);
  assert.deepEqual(splitProportional(2n, [1n, 1n, 2n]), [1n, 0n, 1n]); // 0.5, 0.5, 1.0: the exact share of the third is taken first
  assert.deepEqual(splitProportional(10n, [1n, 2n, 7n]), [1n, 2n, 7n]);
  assert.deepEqual(splitProportional(7n, [3n, 1n]), [5n, 2n]); // 5.25 and 1.75: the remainders are .25 and .75
  assert.deepEqual(splitProportional(0n, [1n, 2n]), [0n, 0n]);
  assert.deepEqual(splitProportional(5n, []), []);
  assert.throws(() => splitProportional(5n, [0n]), RangeError);
});

/** plan() of random standings; returns what the independent split of the same points says */
function planOf(program, points, { options, people } = {}) {
  const { standings } = scoreOf(program, points);
  const ids = Object.keys(points);
  const who = people || Object.fromEntries(ids.map((id, i) => [id, { name: `Person ${id}`, wallet: POOL_WALLETS[i % POOL_WALLETS.length] }]));
  return { standings, plan: kit.plan(program, tenant(), { standings, people: who, now: NOW, ...(options ? { options } : {}) }) };
}

test('plan: the whole pool is paid to the stroop, for random pools from 1 stroop to 9e8 units and 1 to 3000 people', () => {
  const r = rng(7);
  for (let n = 0; n < 40; n++) {
    const people = n < 3 ? 3000 : 1 + Math.floor(r() * 120);
    const points = {};
    for (let i = 0; i < people; i++) points[`p${i}`] = 1 + Math.floor(r() * 5000);
    const pool = randomPool(r, [1e-3, 1, 1e3, 1e6, 9e8][n % 5]);
    const program = simpleProgram({ payout: { model: 'proportional', pool: Number(pool) } });
    // The kit converts a number with toFixed(7); use the same number the plan will see.
    const poolStroops = toStroops(Number(pool));
    const { standings, plan } = planOf(program, points, { options: { pool: Number(pool) } });
    const expected = splitProportional(poolStroops, standings.map((s) => BigInt(s.adjustedPoints)));
    assert.equal(sum(expected), poolStroops);
    const byId = new Map(plan.payments.map((p) => [p.participantId, toStroops(p.amount)]));
    standings.forEach((s, i) => assert.equal(byId.get(s.participantId) || 0n, expected[i], `${s.participantId}`));
    assert.equal(plan.total, fromStroops(poolStroops));
    kit.assertPlanIntegrity(plan);
  }
});

test('plan: for ordinary pools every amount is within 2 stroops of the planner of the engine (the first position within its rounding residue)', () => {
  const r = rng(99);
  for (let n = 0; n < 120; n++) {
    const people = 1 + Math.floor(r() * 100);
    const points = {};
    for (let i = 0; i < people; i++) points[`p${i}`] = 1 + Math.floor(r() * 5000);
    const pool = Number(randomPool(r, 1e6));
    const program = simpleProgram({ payout: { model: 'proportional', pool } });
    const { standings, plan } = planOf(program, points, { options: { pool } });
    const ranking = standings.map((s, i) => ({ workerId: s.participantId, name: `Person ${s.participantId}`, wallet: POOL_WALLETS[i], adjustedPoints: s.adjustedPoints }));
    const core = payouts.planCampaignPayout({ ranking, options: { base: 0, pool, topN: ranking.length } });
    const mine = new Map(plan.payments.map((p) => [p.participantId, toStroops(p.amount)]));
    for (const c of core.payments) {
      const diff = (mine.get(c.workerId) || 0n) - toStroops(c.amount);
      // The engine hands its whole rounding residue (up to half a stroop per person) to the first position;
      // everybody else is within 2 stroops of it.
      const bound = c.rank === 1 ? BigInt(Math.ceil(people / 2) + 2) : 2n;
      assert.ok(diff >= -bound && diff <= bound, `${c.workerId} (rank ${c.rank}): ${diff} stroops apart`);
    }
  }
});

test('plan: no more POOL_TOO_SMALL false positives (regression of the reviewer fuzz: pools up to 1e8, 2 to 51 people)', () => {
  const r = rng(5);
  for (const max of [1e3, 1e5, 1e6, 1e7, 1e8]) {
    for (let n = 0; n < 60; n++) {
      const people = 2 + Math.floor(r() * 50);
      const points = {};
      for (let i = 0; i < people; i++) points[`p${i}`] = 1 + Math.floor(r() * 1000);
      const pool = Number((r() * max + 1).toFixed(Math.floor(r() * 8)));
      const program = simpleProgram({ payout: { model: 'proportional', pool } });
      const { plan } = planOf(program, points, { options: { pool } });
      assert.equal(plan.total, fromStroops(toStroops(pool)));
    }
  }
  // Large pools with several pockets: every plan is consistent (it was PLAN_ALTERED before).
  const three = simpleProgram({ pockets: [
    { id: 'a', label: 'A', share: 0.3333, rule: { type: 'instant' } },
    { id: 'b', label: 'B', share: 0.3333, rule: { type: 'instant' } },
    { id: 'c', label: 'C', share: 0.3334, rule: { type: 'instant' } },
  ] });
  for (let n = 0; n < 100; n++) {
    const pool = Number((3e8 + r() * 6e8).toFixed(7));
    const { plan } = planOf(three, { x: 7, y: 3 }, { options: { pool } });
    kit.assertPlanIntegrity(plan);
    assert.equal(plan.total, fromStroops(toStroops(pool)));
  }
});

test('plan: a pool of fewer stroops than people shares out exactly; whoever would get nothing is not paid', () => {
  const points = {};
  for (let i = 0; i < 3000; i++) points[`p${i}`] = 1;
  const program = simpleProgram({ payout: { model: 'proportional', pool: 0.0000100 } }); // 100 stroops for 3000 people
  const { plan } = planOf(program, points);
  assert.equal(plan.total, '0.0000100');
  assert.equal(plan.payments.length, 100);
  assert.ok(plan.payments.every((p) => p.amount === '0.0000001'));
  assert.deepEqual(plan.payments.slice(0, 3).map((p) => p.rank), [1, 2, 3], 'ties go to the better rank');
});

test('topN: the pool is shared exactly among the first topN, who also get the base; a tiny pool no longer overpays', () => {
  const points = {};
  for (let i = 0; i < 3000; i++) points[`p${i}`] = 3000 - i;
  const program = simpleProgram({ payout: { model: 'topN', pool: 0.0011, topN: 3000, base: 0 } });
  const { plan } = planOf(program, points);
  assert.equal(plan.total, '0.0011000');
  assert.ok(plan.payments.length <= 3000);

  const small = simpleProgram({ payout: { model: 'topN', pool: 100, topN: 3, base: 5 } });
  const { plan: p2 } = planOf(small, { a: 50, b: 30, c: 15, d: 4, e: 1 });
  // 100 shared by 50:30:15 -> 52.6315789.. / 31.5789473.. / 15.7894736..; the 2 leftover stroops go to the
  // largest remainders (c, then b); plus a base of 5 for all five people
  assert.deepEqual(p2.payments.map((p) => [p.participantId, p.amount]), [
    ['a', '57.6315789'], ['b', '36.5789474'], ['c', '20.7894737'], ['d', '5.0000000'], ['e', '5.0000000'],
  ]);
  assert.match(p2.payments[0].detail, /^base 5 \+ prize 52\.63 \(rank 1\)$/);
  assert.equal(p2.payments[4].detail, 'base 5');
});

test('rate: each person gets points x rate to within a stroop, and the total is the rounded sum', () => {
  const program = simpleProgram({ payout: { model: 'rate', rate: 0.0123457 } });
  const { plan } = planOf(program, { a: 1000, b: 500, c: 3 });
  const due = toStroops(Number((1503 * 0.0123457).toFixed(7)));
  assert.equal(toStroops(plan.total), due);
  for (const p of plan.payments) {
    const exact = p.points * 0.0123457 * 1e7;
    assert.ok(Math.abs(Number(toStroops(p.amount)) - exact) < 1.01, `${p.participantId}`);
  }
  const scaled = planOf(simpleProgram({ payout: { model: 'rate', rate: 1, budget: 100 } }), { a: 1000, b: 500, c: 3 }).plan;
  assert.equal(scaled.total, '100.0000000');
  assert.equal(scaled.rule.scaledToBudget, true);
});

test('withheld and excluded shares are never redistributed, and everything adds up to the pool', () => {
  const r = rng(11);
  for (let n = 0; n < 60; n++) {
    const people = 3 + Math.floor(r() * 40);
    const points = {};
    for (let i = 0; i < people; i++) points[`p${i}`] = 1 + Math.floor(r() * 900);
    const program = simpleProgram({ payout: { model: 'proportional', pool: 1234.5678901 } });
    const who = Object.fromEntries(Object.keys(points).map((id, i) => [id, { name: `Person ${id}`, wallet: r() < 0.2 ? null : POOL_WALLETS[i] }]));
    const { standings } = scoreOf(program, points);
    const previous = payouts.summarizePrevious(standings.filter(() => r() < 0.15).map((s) => ({ workerId: s.participantId, wallet: who[s.participantId].wallet, kind: 'bonus', amount: 1 })));
    let plan;
    try { plan = kit.plan(program, tenant(), { standings, people: who, previous, now: NOW }); } catch (e) { if (e.code === 'NOBODY_QUALIFIED') continue; throw e; }
    const shares = splitProportional(toStroops(1234.5678901), standings.map((s) => BigInt(s.adjustedPoints)));
    const paid = new Map(plan.payments.map((p) => [p.rank, toStroops(p.amount)]));
    const withheld = new Map(plan.withheld.map((w) => [w.rank, toStroops(w.amount)]));
    const excluded = new Set(plan.excludedAlreadyPaid.map((x) => x.rank));
    let accounted = 0n;
    standings.forEach((s, i) => {
      const rank = i + 1;
      if (paid.has(rank)) { assert.equal(paid.get(rank), shares[i]); accounted += shares[i]; }
      else if (withheld.has(rank)) { assert.equal(withheld.get(rank), shares[i]); accounted += shares[i]; }
      else if (excluded.has(rank)) accounted += shares[i]; // its share is simply not paid
      else assert.equal(shares[i], 0n, `${s.participantId} got nothing only because its share was nothing`);
    });
    assert.equal(accounted, toStroops(1234.5678901), 'paid + withheld + excluded = the pool');
  }
});

test('the tenant caps are applied to the exact amounts', () => {
  const t = tenant({ payouts: { caps: { perPerson: 60 } } });
  const program = simpleProgram();
  const { standings } = scoreOf(program, { a: 50, b: 30, c: 20 });
  const people = Object.fromEntries(['a', 'b', 'c'].map((id, i) => [id, { name: id, wallet: POOL_WALLETS[i] }]));
  assert.ok(kit.plan(program, t, { standings, people, now: NOW }));
  assert.throws(() => kit.plan(program, t, { standings, people, now: NOW, options: { pool: 130 } }), (e) => e.statusCode === 409 && e.cap === 'person');
});
