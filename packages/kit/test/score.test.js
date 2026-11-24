'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { defineProgram } = require('../src/program');
const { score, levelFor } = require('../src/score');

const program = (extra = {}) => defineProgram({
  id: 'demo',
  name: 'Demo',
  metrics: [
    { id: 'good', label: 'Good', points: 10 },
    { id: 'capped', label: 'Capped', points: 5, cap: 4 },
    { id: 'bad', label: 'Bad', points: -20 },
  ],
  payout: { model: 'proportional', pool: 100 },
  ...extra,
});

const ev = (participantId, metric, value) => (value === undefined ? { participantId, metric } : { participantId, metric, value });
const row = (res, id) => res.standings.find((s) => s.participantId === String(id));

test('points are units x points; a missing value counts as one unit', () => {
  const res = score(program(), { events: [ev('a', 'good', 3), ev('a', 'good'), ev('a', 'good', 1.5)] });
  const a = row(res, 'a');
  assert.equal(a.byMetric.good.units, 5.5);
  assert.equal(a.byMetric.good.points, 55);
  assert.equal(a.rawPoints, 55);
  assert.equal(a.earnedPoints, 55);
  assert.equal(a.adjustedPoints, 55);
});

test('the cap of a metric limits the units counted but keeps what was reported', () => {
  const res = score(program(), { events: [ev('a', 'capped', 3), ev('a', 'capped', 9)] });
  const m = row(res, 'a').byMetric.capped;
  assert.equal(m.reported, 12);
  assert.equal(m.units, 4);
  assert.equal(m.points, 20);
  // Below the cap nothing changes.
  assert.equal(row(score(program(), { events: [ev('a', 'capped', 2)] }), 'a').byMetric.capped.units, 2);
});

test('penalties can never push a person below zero', () => {
  const res = score(program(), { events: [ev('a', 'good', 1), ev('a', 'bad', 5), ev('b', 'bad', 1)] });
  assert.equal(row(res, 'a').rawPoints, 0);
  assert.equal(row(res, 'a').adjustedPoints, 0);
  assert.equal(row(res, 'a').qualified, false);
  assert.equal(row(res, 'b').rawPoints, 0);
  assert.equal(row(res, 'b').byMetric.bad.points, -20);
  assert.equal(res.totals.qualified, 0);
  assert.equal(res.totals.adjustedPoints, 0);
});

test('a penalty reduces points but does not erase them', () => {
  const res = score(program(), { events: [ev('a', 'good', 5), ev('a', 'bad', 1)] });
  assert.equal(row(res, 'a').rawPoints, 30);
});

test('quality factor: 1 - w + w x q, clamped to 0..1, ignored without a score', () => {
  const p = program({ quality: { weight: 0.5 } });
  const events = [ev('a', 'good', 10), ev('b', 'good', 10), ev('c', 'good', 10), ev('d', 'good', 10), ev('e', 'good', 10)];
  const res = score(p, { events, quality: { a: 1, b: 0, c: 0.5, d: 7, e: -3 } });
  assert.equal(row(res, 'a').qualityFactor, 1);
  assert.equal(row(res, 'a').earnedPoints, 100);
  assert.equal(row(res, 'b').qualityFactor, 0.5);
  assert.equal(row(res, 'b').earnedPoints, 50);
  assert.equal(row(res, 'c').qualityFactor, 0.75);
  assert.equal(row(res, 'c').earnedPoints, 75);
  assert.equal(row(res, 'd').quality, 1); // clamped down
  assert.equal(row(res, 'e').quality, 0); // clamped up
  assert.equal(row(res, 'e').earnedPoints, 50);
  // No score for the person: the factor is 1.
  const none = score(p, { events: [ev('z', 'good', 10)], quality: { other: 0 } });
  assert.equal(row(none, 'z').quality, null);
  assert.equal(row(none, 'z').qualityFactor, 1);
  assert.equal(row(none, 'z').earnedPoints, 100);
});

test('a program without quality ignores quality scores', () => {
  const res = score(program(), { events: [ev('a', 'good', 10)], quality: { a: 0 } });
  assert.equal(row(res, 'a').earnedPoints, 100);
  assert.equal(row(res, 'a').qualityFactor, 1);
});

const ladder = defineProgram({
  id: 'ladder',
  name: 'Ladder',
  metrics: [{ id: 'good', label: 'Good', points: 10 }],
  payout: { model: 'proportional', pool: 100 },
  levels: [
    { id: 'l1', name: 'One', minLifetimePoints: 0, multiplier: 1 },
    { id: 'l2', name: 'Two', minLifetimePoints: 100, multiplier: 1.5 },
    { id: 'l3', name: 'Three', minLifetimePoints: 500, multiplier: 2 },
  ],
});

test('levelFor: boundaries, next step and points to go', () => {
  assert.equal(levelFor(ladder, 0).id, 'l1');
  assert.equal(levelFor(ladder, 99).id, 'l1');
  assert.equal(levelFor(ladder, 100).id, 'l2');
  assert.equal(levelFor(ladder, 499).id, 'l2');
  assert.equal(levelFor(ladder, 500).id, 'l3');
  assert.equal(levelFor(ladder, 99999).id, 'l3');
  assert.deepEqual(levelFor(ladder, 40).next, { id: 'l2', name: 'Two', pointsToGo: 60 });
  assert.equal(levelFor(ladder, 600).next, null);
  assert.deepEqual([levelFor(ladder, 100).step, levelFor(ladder, 100).steps], [2, 3]);
  assert.equal(levelFor(ladder, -50).id, 'l1');
  assert.equal(levelFor(ladder, 'garbage').id, 'l1');
});

test('the level comes from the lifetime points BEFORE the period', () => {
  // 90 lifetime + 100 earned = 190 would be level two, but the period is paid at level one.
  const res = score(ladder, { events: [ev('a', 'good', 10)], lifetime: { a: 90 } });
  const a = row(res, 'a');
  assert.equal(a.level.id, 'l1');
  assert.equal(a.adjustedPoints, 100);
  assert.equal(a.lifetimeBefore, 90);
  assert.equal(a.lifetimeAfter, 190);
  assert.equal(a.levelAfter.id, 'l2');
  // Someone who was already at level two is paid with its multiplier.
  const b = row(score(ladder, { events: [ev('b', 'good', 10)], lifetime: { b: 100 } }), 'b');
  assert.equal(b.level.id, 'l2');
  assert.equal(b.earnedPoints, 100);
  assert.equal(b.adjustedPoints, 150);
});

test('adjusted points are rounded', () => {
  const res = score(ladder, { events: [ev('a', 'good', 0.37)], lifetime: { a: 200 } }); // 3.7 raw -> 4 earned -> 6 adjusted
  assert.equal(row(res, 'a').earnedPoints, 4);
  assert.equal(row(res, 'a').adjustedPoints, 6);
});

test('standings are ordered by adjusted points, then earned, then first appearance', () => {
  const res = score(ladder, {
    events: [ev('t1', 'good', 10), ev('low', 'good', 1), ev('t2', 'good', 10), ev('high', 'good', 50), ev('boosted', 'good', 7)],
    lifetime: { boosted: 200 }, // 70 earned x 1.5 = 105 adjusted
  });
  assert.deepEqual(res.standings.map((s) => s.participantId), ['high', 'boosted', 't1', 't2', 'low']);
  assert.deepEqual(res.standings.map((s) => s.rank), [1, 2, 3, 4, 5]);
  assert.ok(res.standings.every((s) => !('order' in s)));
});

test('a tie on adjusted points is broken by earned points', () => {
  // x: 100 earned x 1 = 100; y: 50 earned x 2 = 100.
  const res = score(ladder, { events: [ev('y', 'good', 5), ev('x', 'good', 10)], lifetime: { y: 900 } });
  assert.equal(row(res, 'x').adjustedPoints, 100);
  assert.equal(row(res, 'y').adjustedPoints, 100);
  assert.deepEqual(res.standings.map((s) => s.participantId), ['x', 'y']);
});

test('participants without events are listed, in the order given, with zero points', () => {
  const res = score(program(), { events: [ev('b', 'good', 1)], participants: ['a', 'b', 'c'] });
  assert.equal(res.totals.participants, 3);
  assert.deepEqual(res.standings.map((s) => s.participantId), ['b', 'a', 'c']);
  assert.equal(row(res, 'a').adjustedPoints, 0);
  assert.equal(row(res, 'a').qualified, false);
  assert.equal(row(res, 'a').byMetric.good.units, 0);
  assert.equal(res.totals.qualified, 1);
});

test('ids are compared as strings: 7 and "7" are the same person', () => {
  const res = score(program(), { events: [ev(7, 'good', 1), ev('7', 'good', 1)], participants: [7] });
  assert.equal(res.standings.length, 1);
  assert.equal(res.standings[0].participantId, '7');
  assert.equal(res.standings[0].byMetric.good.units, 2);
});

test('minPoints decides who qualifies, and totals only add the qualified', () => {
  const p = program({ minPoints: 50 });
  const res = score(p, { events: [ev('a', 'good', 6), ev('b', 'good', 5), ev('c', 'good', 4)] });
  assert.equal(row(res, 'a').qualified, true);
  assert.equal(row(res, 'b').qualified, true); // exactly the minimum
  assert.equal(row(res, 'c').qualified, false);
  assert.equal(res.totals.qualified, 2);
  assert.equal(res.totals.adjustedPoints, 110);
});

test('unknown metrics are reported together and nothing is scored', () => {
  assert.throws(() => score(program(), { events: [ev('a', 'good', 1), ev('a', 'ghost', 1), ev('b', 'phantom', 2)] }), (e) => {
    assert.equal(e.statusCode, 400);
    assert.equal(e.code, 'UNKNOWN_METRIC');
    assert.match(e.message, /ghost/);
    assert.match(e.message, /phantom/);
    assert.match(e.message, /good, capped, bad/);
    return true;
  });
});

test('bad input is rejected with a 400', () => {
  const bad = (input, pattern) => assert.throws(() => score(program(), input), (e) => e.statusCode === 400 && pattern.test(e.message));
  bad({}, /events must be an array/);
  bad(undefined, /events must be an array/);
  bad({ events: 'x' }, /events must be an array/);
  bad({ events: [null] }, /not an object/);
  bad({ events: [ev('a', 'good', -1)] }, /value must be a number >= 0/);
  bad({ events: [ev('a', 'good', NaN)] }, /value must be a number >= 0/);
  bad({ events: [ev('a', 'good', 'many')] }, /value must be a number >= 0/);
  bad({ events: [{ metric: 'good' }] }, /participantId/);
  bad({ events: [ev('', 'good', 1)] }, /participantId/);
  bad({ events: [], participants: [null] }, /participantId/);
});

test('no events and no participants gives empty standings', () => {
  const res = score(program(), { events: [] });
  assert.deepEqual(res.standings, []);
  assert.deepEqual(res.totals, { participants: 0, qualified: 0, adjustedPoints: 0 });
});

test('scoring is pure: the same input gives the same output and the input is untouched', () => {
  const events = [ev('a', 'good', 3), ev('b', 'good', 2)];
  const copy = JSON.parse(JSON.stringify(events));
  assert.deepEqual(score(program(), { events }), score(program(), { events }));
  assert.deepEqual(events, copy);
});
