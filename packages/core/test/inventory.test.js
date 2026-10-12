'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../src/scoring/inventory');

const c = (workerId, total, extra = {}) => ({ workerId, total, ...extra });
const line = (consensus, consensusValue, counters, extra = {}) => ({ consensus, consensusValue, counters, ...extra });

test('lineWeight: 1 → 1, 10 → 2, 10 000 → 5, 0 → 1', () => {
  assert.equal(Q.lineWeight(1), 1);
  assert.equal(Q.lineWeight(10), 2);
  assert.equal(Q.lineWeight(10000), 5);
  assert.equal(Q.lineWeight(0), 1);
});

const zone = [{ locations: [
  line('resolved', 100, [c(1, 100), c(2, 100), c(3, 90)]),          // 1 and 2 correct, 3 wrong
  line('resolved', 10, [c(1, 10), c(3, 10)]),                        // both correct
  line('resolved', 0, [c(4, 0, { voided: true }), c(1, 0)]),          // 4 voided: wrong
  line('pending', null, [c(1, 5), c(3, 7)]),                         // not evaluated
  line('resolved', 0, [c(2, 0), c(3, 6000)], { discarded: true }),   // 2 correct, 3 wrong
] }];

test('accumulateZone counts correct, wrong and skips lines without consensus', () => {
  const acc = Q.accumulateZone(zone);
  assert.deepEqual([acc.get(1).correct, acc.get(1).wrong], [3, 0]);
  assert.deepEqual([acc.get(2).correct, acc.get(2).wrong], [2, 0]);
  assert.deepEqual([acc.get(3).correct, acc.get(3).wrong], [1, 2]);
  assert.deepEqual([acc.get(4).correct, acc.get(4).wrong], [0, 1]);
});

test('points = weight(correct) − 2 × weight(wrong), never negative', () => {
  const acc = Q.accumulateZone(zone);
  assert.equal(Q.scoreCounter(acc.get(3)).points, 0);
  const s1 = Q.scoreCounter(acc.get(1));
  assert.equal(s1.points, 3 + 2 + 1); // lines of 100, 10 and 0 units
  assert.equal(s1.precision, 1);
});

test('eligible only with precision >= 90%', () => {
  assert.equal(Q.scoreCounter({ correct: 9, wrong: 1, weightCorrect: 9, weightWrong: 1 }).eligible, true);
  assert.equal(Q.scoreCounter({ correct: 8, wrong: 2, weightCorrect: 8, weightWrong: 2 }).eligible, false);
  assert.equal(Q.scoreCounter({}).eligible, false);
});

test('accuracy in units', () => {
  const s = Q.scoreCounter({ correct: 1, wrong: 1, weightCorrect: 1, weightWrong: 1, unitsError: 10, unitsRef: 100 });
  assert.ok(Math.abs(s.accuracy - 0.9) < 1e-9);
});

test('scoreSession accumulates every zone and honors tenant options', () => {
  const out = Q.scoreSession([zone, zone], { minPrecision: 0.5, penalty: 1 });
  assert.equal(out.get(1).lines, 6);
  assert.equal(out.get(3).eligible, false); // 2/6 correct < 50%
  assert.equal(out.get(2).eligible, true);
});
