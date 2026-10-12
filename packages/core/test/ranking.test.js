'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveWeights, resolveTopN, applyTopN, inventoryMultipliersBp } = require('../src/scoring/ranking');

test('resolveWeights: no override → tenant defaults', () => {
  assert.deepEqual(resolveWeights({ performance: null, evaluation: null }, { performance: 0.5, evaluation: 0.3 }), { performance: 0.5, evaluation: 0.3 });
  assert.deepEqual(resolveWeights({}, { performance: 0.5, evaluation: 0.3 }), { performance: 0.5, evaluation: 0.3 });
  assert.deepEqual(resolveWeights({}, undefined), { performance: 0.5, evaluation: 0.3 });
});

test('resolveWeights: overrides win, and 0 is a valid override', () => {
  assert.deepEqual(resolveWeights({ performance: 0.7, evaluation: 0.1 }, { performance: 0.5, evaluation: 0.3 }), { performance: 0.7, evaluation: 0.1 });
  const r = resolveWeights({ performance: 0, evaluation: null }, { performance: 0.5, evaluation: 0.3 });
  assert.equal(r.performance, 0);
  assert.equal(r.evaluation, 0.3);
});

test('resolveTopN: campaign value, then default, then null', () => {
  assert.equal(resolveTopN(null, null), null);
  assert.equal(resolveTopN(undefined, undefined), null);
  assert.equal(resolveTopN(3, 10), 3);
  assert.equal(resolveTopN(null, 5), 5);
  assert.equal(resolveTopN('5', null), 5);
});

test('resolveTopN: invalid values → null', () => {
  assert.equal(resolveTopN(0, null), null);
  assert.equal(resolveTopN(-3, null), null);
  assert.equal(resolveTopN('abc', null), null);
});

const five = [
  { workerId: 1, adjustedPoints: 100 },
  { workerId: 2, adjustedPoints: 80 },
  { workerId: 3, adjustedPoints: 60 },
  { workerId: 4, adjustedPoints: 40 },
  { workerId: 5, adjustedPoints: 20 },
];

test('applyTopN: null is a no-op', () => {
  const r = applyTopN(five, null);
  assert.equal(r.length, 5);
  assert.ok(r.every((e) => e.qualified));
});

test('applyTopN: only the N best qualify and nobody is removed', () => {
  const r = applyTopN(five, 3);
  assert.deepEqual(r.filter((e) => e.qualified).map((e) => e.workerId), [1, 2, 3]);
  assert.deepEqual(r.filter((e) => !e.qualified).map((e) => e.workerId), [4, 5]);
  assert.equal(r.length, 5);
});

test('applyTopN: N larger than the list → everybody qualifies; input is not mutated', () => {
  const copy = five.map((e) => ({ ...e }));
  assert.ok(applyTopN(five, 10).every((e) => e.qualified));
  applyTopN(five, 3);
  assert.deepEqual(five, copy);
});

test('applyTopN: ties keep the input order', () => {
  const r = applyTopN([{ workerId: 'a', adjustedPoints: 5 }, { workerId: 'b', adjustedPoints: 5 }], 1);
  assert.deepEqual(r.map((e) => e.qualified), [true, false]);
});

test('inventoryMultipliersBp: proportional to points, max = 20000', () => {
  const bp = inventoryMultipliersBp([
    { workerId: 1, adjustedPoints: 5000, fundShare: '0.5' },
    { workerId: 2, adjustedPoints: 2500, fundShare: '0.25' },
    { workerId: 3, adjustedPoints: 1250, fundShare: '0.125' },
  ]);
  assert.deepEqual(bp, { 1: 20000, 2: 10000, 3: 5000 });
});

test('inventoryMultipliersBp: not qualified → 0 bp even with points', () => {
  const bp = inventoryMultipliersBp([
    { workerId: 1, adjustedPoints: 5000, fundShare: '0.7' },
    { workerId: 2, adjustedPoints: 4000, fundShare: '0.3' },
    { workerId: 3, adjustedPoints: 3000, fundShare: '0' },
  ]);
  assert.deepEqual(bp, { 1: 20000, 2: 16000, 3: 0 });
});

test('inventoryMultipliersBp: a qualified tiny share never rounds to 0', () => {
  const bp = inventoryMultipliersBp([
    { workerId: 1, adjustedPoints: 1_000_000, fundShare: '0.999' },
    { workerId: 2, adjustedPoints: 1, fundShare: '0.001' },
  ]);
  assert.equal(bp[2], 1);
});

test('inventoryMultipliersBp: nobody qualified with points → null', () => {
  assert.equal(inventoryMultipliersBp([]), null);
  assert.equal(inventoryMultipliersBp([{ workerId: 1, adjustedPoints: 0, fundShare: '0' }]), null);
  assert.equal(inventoryMultipliersBp(null), null);
});

test('inventoryMultipliersBp: on-chain shares replicate the off-chain shares', () => {
  const bp = inventoryMultipliersBp([
    { workerId: 1, adjustedPoints: 3680, fundShare: '0.4' },
    { workerId: 2, adjustedPoints: 1840, fundShare: '0.2' },
    { workerId: 3, adjustedPoints: 3680, fundShare: '0.4' },
  ]);
  const total = bp[1] + bp[2] + bp[3];
  assert.ok(Math.abs(bp[1] / total - 3680 / 9200) < 1e-4);
  assert.ok(Math.abs(bp[2] / total - 1840 / 9200) < 1e-4);
});
