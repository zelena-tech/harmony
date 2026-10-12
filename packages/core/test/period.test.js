'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computePeriod } = require('../src/period');
const { defineTenant } = require('../src/tenant');
const { scoreCounter } = require('../src/scoring/inventory');

const tenant = defineTenant({ id: 'tenant-a', network: 'testnet' });

const orders = [
  // 10 orders in 1 h, all completed
  { workerId: 1, picking: 10, packing: 0, completed: 10, started: 10, activeSeconds: 3600 },
  // 5 completed of 10 started, 5 per hour
  { workerId: 2, picking: 5, packing: 0, completed: 5, started: 10, activeSeconds: 3600 },
];

test('orders: velocity vs the best, precision = completed / started, fund by adjusted points', () => {
  const r = computePeriod({ scoring: tenant.scoring, kind: 'orders', activity: orders, fundTotal: 100 });
  const [a, b] = r.workers;
  assert.deepEqual([a.velocityScore, a.precisionScore, a.finalScore, a.pointsTotal, a.adjustedPoints], [100, 100, 100, 100, 100]);
  assert.deepEqual([b.velocityScore, b.precisionScore, b.finalScore, b.pointsTotal, b.adjustedPoints], [50, 50, 50, 50, 25]);
  assert.equal(a.fundShare, 0.8);
  assert.equal(b.fundShare, 0.2);
  assert.deepEqual([a.assignedAmount, b.assignedAmount], [80, 20]);
  assert.equal(r.totals.adjustedPointsQualified, 125);
});

test('orders: campaign overrides and top-N do not apply', () => {
  const r = computePeriod({ scoring: tenant.scoring, kind: 'orders', activity: orders, fundTotal: 100, overrides: { topN: 1, performance: 0 } });
  assert.equal(r.topN, null);
  assert.ok(r.workers.every((w) => w.qualified));
  assert.equal(r.workers[0].finalScore, 100);
});

test('orders: velocity is neutral (75) when nobody has time data', () => {
  const r = computePeriod({ scoring: tenant.scoring, kind: 'orders', activity: [{ workerId: 1, picking: 3, completed: 3, started: 3 }] });
  assert.equal(r.workers[0].velocityScore, 75);
});

test('orders: evaluation and attendance enter the weighted average', () => {
  const r = computePeriod({
    scoring: tenant.scoring, kind: 'orders', activity: [orders[0]],
    evaluations: { 1: { 7: 6 } }, criteria: [{ id: 7, weight: 1 }],
    attendance: { 1: 50 },
  });
  // 100*0.5 + 50*0.2 + 60*0.3 = 78
  assert.equal(r.workers[0].finalScore, 78);
  assert.equal(r.workers[0].evaluationAverage, 6);
});

test('inventory: quality rule, ineligible workers keep points but get 0, top-N', () => {
  const quality = new Map([
    [1, scoreCounter({ correct: 10, wrong: 0, weightCorrect: 30, weightWrong: 0 })],
    [2, scoreCounter({ correct: 9, wrong: 1, weightCorrect: 20, weightWrong: 1 })],
    [3, scoreCounter({ correct: 5, wrong: 5, weightCorrect: 50, weightWrong: 5 })], // 50% precision
  ]);
  const r = computePeriod({
    scoring: tenant.scoring, kind: 'inventory', fundTotal: 90, quality,
    activity: [{ workerId: 1, counts: 10 }, { workerId: 2, counts: 10 }, { workerId: 3, counts: 10 }],
    overrides: { topN: 2 },
  });
  const [w1, w2, w3] = r.workers;
  assert.equal(r.topN, 2);
  assert.deepEqual([w1.pointsTotal, w1.adjustedPoints, w1.qualified], [30, 30, true]);
  assert.deepEqual([w2.pointsTotal, w2.adjustedPoints, w2.qualified], [18, 18, true]);
  assert.deepEqual([w3.pointsTotal, w3.adjustedPoints, w3.qualified, w3.fundShare], [40, 0, false, 0]);
  assert.ok(Math.abs(w1.fundShare + w2.fundShare - 1) < 1e-12);
  assert.equal(w1.precisionScore, 100);
});

test('shares of the qualified always add up to 1', () => {
  const activity = Array.from({ length: 7 }, (_, i) => ({ workerId: i + 1, counts: (i + 1) * 13 }));
  const r = computePeriod({ scoring: tenant.scoring, kind: 'inventory', activity, fundTotal: 150, overrides: { topN: 4 } });
  const sum = r.workers.filter((w) => w.qualified).reduce((s, w) => s + w.fundShare, 0);
  assert.ok(Math.abs(sum - 1) < 1e-12);
  assert.equal(r.workers.filter((w) => w.qualified).length, 4);
  assert.ok(r.workers.filter((w) => !w.qualified).every((w) => w.fundShare === 0 && w.assignedAmount === 0));
});

test('tenant weights change the result', () => {
  const speedOnly = defineTenant({ id: 'tenant-b', network: 'testnet', scoring: { velocityWeight: 1, precisionWeight: 0 } });
  const r = computePeriod({ scoring: speedOnly.scoring, kind: 'orders', activity: orders });
  assert.equal(r.workers[1].finalScore, 50); // only velocity counts
  const r2 = computePeriod({ scoring: tenant.scoring, kind: 'orders', activity: [{ ...orders[1], activeSeconds: 1800 }, orders[0]] });
  assert.equal(r2.workers[0].velocityScore, 100);
});
