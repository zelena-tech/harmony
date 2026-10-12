'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { workingDays, attendanceScore, evaluationScore, combineScores } = require('../src/scoring/components');

test('workingDays excludes Sundays and holidays', () => {
  // 2026-06-01 (Monday) to 2026-06-07 (Sunday): 6 working days
  assert.equal(workingDays('2026-06-01', '2026-06-07', new Set()), 6);
  assert.equal(workingDays('2026-06-01', '2026-06-07', ['2026-06-05']), 5);
  assert.equal(workingDays('2026-07-20', '2026-07-20', ['2026-07-20']), 0);
});

test('attendanceScore: 60% attendance + 40% utilization', () => {
  assert.equal(attendanceScore({ daysWorked: 6, utilization: 0.9 }, 6), 96);   // 100*0.6 + 90*0.4
});

test('attendanceScore: attendance only when utilization is missing', () => {
  assert.equal(attendanceScore({ daysWorked: 3, utilization: null }, 6), 50);
});

test('attendanceScore: capped at 100', () => {
  assert.equal(attendanceScore({ daysWorked: 8, utilization: 1 }, 6), 100);
});

test('attendanceScore: null without data (its weight is redistributed)', () => {
  assert.equal(attendanceScore({ daysWorked: 0, utilization: null }, 6), null);
  assert.equal(attendanceScore(null, 6), null);
  assert.equal(attendanceScore({ daysWorked: 5 }, 0), null);
});

const criteria = [{ id: 1, weight: 1 }, { id: 2, weight: 1 }, { id: 3, weight: 2 }];

test('evaluationScore: weighted average scaled to 0-100', () => {
  const r = evaluationScore({ 1: 8, 2: 6, 3: 10 }, criteria);
  assert.equal(r.score, 85);    // (8 + 6 + 20) / 4 = 8.5
  assert.equal(r.average, 8);   // (8 + 6 + 10) / 3
});

test('evaluationScore: only graded criteria count', () => {
  assert.deepEqual(evaluationScore({ 1: 10 }, criteria), { score: 100, average: 10 });
});

test('evaluationScore: out of range grades are ignored; none valid → null', () => {
  assert.equal(evaluationScore({ 1: 0, 2: 11 }, criteria), null);
  assert.equal(evaluationScore({}, criteria), null);
  assert.equal(evaluationScore(null, criteria), null);
});

test('combineScores: all components present', () => {
  assert.equal(combineScores([{ score: 80, weight: 0.5 }, { score: 100, weight: 0.2 }, { score: 90, weight: 0.3 }]), 87);
});

test('combineScores: a missing component redistributes its weight (never penalizes)', () => {
  // (80*0.5 + 90*0.3) / 0.8 = 83.75 → 84
  assert.equal(combineScores([{ score: 80, weight: 0.5 }, { score: null, weight: 0.2 }, { score: 90, weight: 0.3 }]), 84);
  assert.equal(combineScores([{ score: 73, weight: 0.5 }, { score: null, weight: 0.2 }, { score: null, weight: 0.3 }]), 73);
});

test('combineScores: no component → null', () => {
  assert.equal(combineScores([{ score: null, weight: 0.5 }, { score: null, weight: 0.5 }]), null);
  assert.equal(combineScores([]), null);
});
