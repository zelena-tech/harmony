'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { defineProgram, isProgram, ProgramConfigError } = require('../src/program');

const base = (extra = {}) => ({
  id: 'demo',
  name: 'Demo',
  metrics: [{ id: 'unit', label: 'Unit', points: 1 }],
  payout: { model: 'proportional', pool: 100 },
  ...extra,
});

/** Asserts that defining the input fails and that one of the problems matches. */
function invalid(input, pattern) {
  assert.throws(() => defineProgram(input), (e) => {
    assert.ok(e instanceof ProgramConfigError, 'expected a ProgramConfigError');
    assert.ok(e.problems.some((p) => pattern.test(p)), `no problem matches ${pattern}: ${e.problems.join(' | ')}`);
    return true;
  });
}

test('defaults: one level, one instant pocket, hold unreachable people for 30 days', () => {
  const p = defineProgram(base());
  assert.deepEqual(p.levels, [{ id: 'member', name: 'Member', minLifetimePoints: 0, multiplier: 1 }]);
  assert.equal(p.pockets.length, 1);
  assert.deepEqual(p.pockets[0], { id: 'available', label: 'Available now', shareBp: 10000, rule: { type: 'instant', afterSeconds: null } });
  assert.deepEqual(p.unreachable, { mode: 'hold', reclaimAfterSeconds: 30 * 86400 });
  assert.equal(p.minPoints, 0);
  assert.equal(p.quality, null);
  assert.equal(p.industry, null);
  assert.deepEqual(p.metrics[0], { id: 'unit', label: 'Unit', points: 1, cap: null });
  assert.equal(p.payout.model, 'proportional');
  assert.equal(p.payout.pool, 100);
});

test('the result is deeply frozen and isProgram recognises it', () => {
  const p = defineProgram(base());
  assert.ok(isProgram(p));
  assert.ok(Object.isFrozen(p));
  assert.ok(Object.isFrozen(p.metrics) && Object.isFrozen(p.metrics[0]));
  assert.ok(Object.isFrozen(p.pockets[0].rule));
  assert.ok(Object.isFrozen(p.payout));
  assert.ok(Object.isFrozen(p.unreachable));
  assert.throws(() => { p.metrics[0].points = 99; }, TypeError);
  assert.throws(() => { p.pockets.push({}); }, TypeError);
  assert.ok(!isProgram(base()));
  assert.ok(!isProgram(null));
});

test('the input is not mutated and later edits to it do not reach the program', () => {
  const input = base();
  const p = defineProgram(input);
  input.metrics[0].points = 500;
  input.name = 'Changed';
  assert.equal(p.metrics[0].points, 1);
  assert.equal(p.name, 'Demo');
});

test('defineProgram(undefined) reports problems instead of crashing', () => {
  assert.throws(() => defineProgram(undefined), ProgramConfigError);
  assert.throws(() => defineProgram(null), ProgramConfigError);
});

test('id and name', () => {
  for (const id of ['', 'Has Upper', '-lead', 'a'.repeat(64), 'with space', 7, null, undefined]) invalid(base({ id }), /id must be a slug/);
  assert.equal(defineProgram(base({ id: 'a_b-9' })).id, 'a_b-9');
  invalid(base({ name: '' }), /name is required/);
  invalid(base({ name: '   ' }), /name is required/);
  invalid(base({ name: 'x'.repeat(121) }), /name is required/);
  invalid(base({ industry: 5 }), /industry must be a string/);
});

test('metrics: required, slug ids, no repeats, points other than 0, cap, one positive', () => {
  invalid(base({ metrics: [] }), /metrics must be a non-empty array/);
  invalid(base({ metrics: 'nope' }), /metrics must be a non-empty array/);
  invalid(base({ metrics: [{ id: 'Bad Id', label: 'x', points: 1 }] }), /metrics\[0\]\.id must be a slug/);
  invalid(base({ metrics: [null] }), /metrics\[0\]\.id must be a slug/);
  invalid(base({ metrics: [{ id: 'a', label: 'A', points: 1 }, { id: 'a', label: 'B', points: 1 }] }), /is repeated/);
  invalid(base({ metrics: [{ id: 'a', label: '', points: 1 }] }), /label is required/);
  invalid(base({ metrics: [{ id: 'a', label: 'A', points: 0 }] }), /points must be a number different from 0/);
  invalid(base({ metrics: [{ id: 'a', label: 'A', points: NaN }] }), /points must be a number/);
  invalid(base({ metrics: [{ id: 'a', label: 'A', points: '5' }] }), /points must be a number/);
  invalid(base({ metrics: [{ id: 'a', label: 'A', points: 1, cap: 0 }] }), /cap must be a positive number or null/);
  invalid(base({ metrics: [{ id: 'a', label: 'A', points: 1, cap: -3 }] }), /cap must be a positive number or null/);
  invalid(base({ metrics: [{ id: 'a', label: 'A', points: -5 }] }), /at least one metric must give positive points/);
  const ok = defineProgram(base({ metrics: [{ id: 'a', label: 'A', points: 2, cap: 10 }, { id: 'b', label: 'B', points: -3, cap: null }] }));
  assert.equal(ok.metrics[0].cap, 10);
  assert.equal(ok.metrics[1].cap, null);
  assert.equal(ok.metrics[1].points, -3);
});

test('quality weight and minPoints', () => {
  assert.deepEqual(defineProgram(base({ quality: { weight: 0.4 } })).quality, { weight: 0.4 });
  assert.equal(defineProgram(base({ quality: null })).quality, null);
  invalid(base({ quality: { weight: 1.2 } }), /quality\.weight/);
  invalid(base({ quality: { weight: -0.1 } }), /quality\.weight/);
  invalid(base({ quality: {} }), /quality\.weight/);
  assert.equal(defineProgram(base({ minPoints: 40 })).minPoints, 40);
  invalid(base({ minPoints: -1 }), /minPoints/);
  invalid(base({ minPoints: 'x' }), /minPoints/);
});

test('levels: must start at 0, strictly increasing, multiplier in (0, 5]', () => {
  const lv = (id, min, multiplier) => ({ id, name: id.toUpperCase(), minLifetimePoints: min, multiplier });
  const ok = defineProgram(base({ levels: [lv('a', 0, 1), lv('b', 100, 1.5), lv('c', 500, 5)] }));
  assert.equal(ok.levels.length, 3);
  assert.equal(defineProgram(base({ levels: [{ id: 'a', name: 'A', minLifetimePoints: 0 }] })).levels[0].multiplier, 1);
  invalid(base({ levels: [] }), /levels must be a non-empty array/);
  invalid(base({ levels: [lv('a', 0, 1), lv('b', 500, 1), lv('c', 100, 1)] }), /strictly increasing/);
  invalid(base({ levels: [lv('a', 0, 1), lv('b', 0, 1)] }), /strictly increasing/);
  invalid(base({ levels: [lv('a', 10, 1)] }), /first level must start at 0/);
  invalid(base({ levels: [lv('a', 0, 0)] }), /multiplier must be > 0 and <= 5/);
  invalid(base({ levels: [lv('a', 0, 5.01)] }), /multiplier must be > 0 and <= 5/);
  invalid(base({ levels: [lv('a', 0, -1)] }), /multiplier must be > 0 and <= 5/);
  invalid(base({ levels: [lv('a', -5, 1)] }), /minLifetimePoints must be a number >= 0/);
  invalid(base({ levels: [lv('a', 0, 1), lv('a', 10, 1)] }), /is repeated/);
  invalid(base({ levels: [{ id: 'A', name: 'x', minLifetimePoints: 0 }] }), /levels\[0\]\.id must be a slug/);
  invalid(base({ levels: [{ id: 'a', name: '', minLifetimePoints: 0 }] }), /levels\[0\]\.name is required/);
});

test('payout: the model must be known', () => {
  invalid(base({ payout: { model: 'magic', pool: 1 } }), /payout\.model must be one of/);
  invalid(base({ payout: undefined }), /payout\.model must be one of/);
});

test('payout proportional: needs a pool > 0', () => {
  invalid(base({ payout: { model: 'proportional' } }), /payout\.pool must be a number > 0/);
  invalid(base({ payout: { model: 'proportional', pool: 0 } }), /payout\.pool must be a number > 0/);
  invalid(base({ payout: { model: 'proportional', pool: -5 } }), /payout\.pool must be a number > 0/);
  invalid(base({ payout: { model: 'proportional', pool: '100' } }), /payout\.pool must be a number > 0/);
  const p = defineProgram(base({ payout: { model: 'proportional', pool: 75.5 } }));
  assert.deepEqual(p.payout, { model: 'proportional', pool: 75.5, base: 0, topN: null, rate: null, budget: null });
});

test('payout topN: needs pool and a positive integer topN, optional base >= 0', () => {
  invalid(base({ payout: { model: 'topN', pool: 100 } }), /payout\.topN must be a positive integer/);
  invalid(base({ payout: { model: 'topN', pool: 100, topN: 0 } }), /payout\.topN must be a positive integer/);
  invalid(base({ payout: { model: 'topN', pool: 100, topN: 2.5 } }), /payout\.topN must be a positive integer/);
  invalid(base({ payout: { model: 'topN', topN: 3 } }), /payout\.pool must be a number > 0/);
  invalid(base({ payout: { model: 'topN', pool: 100, topN: 3, base: -1 } }), /payout\.base must be a number >= 0/);
  const p = defineProgram(base({ payout: { model: 'topN', pool: 100, topN: 3, base: 5 } }));
  assert.deepEqual(p.payout, { model: 'topN', pool: 100, base: 5, topN: 3, rate: null, budget: null });
  assert.equal(defineProgram(base({ payout: { model: 'topN', pool: 100, topN: 3 } })).payout.base, 0);
});

test('payout rate: needs a rate > 0, optional budget > 0', () => {
  invalid(base({ payout: { model: 'rate' } }), /payout\.rate must be a number > 0/);
  invalid(base({ payout: { model: 'rate', rate: 0 } }), /payout\.rate must be a number > 0/);
  invalid(base({ payout: { model: 'rate', rate: 0.1, budget: 0 } }), /payout\.budget must be a number > 0 or null/);
  invalid(base({ payout: { model: 'rate', rate: 0.1, budget: -4 } }), /payout\.budget/);
  const p = defineProgram(base({ payout: { model: 'rate', rate: 0.05 } }));
  assert.deepEqual(p.payout, { model: 'rate', pool: null, base: 0, topN: null, rate: 0.05, budget: null });
  assert.equal(defineProgram(base({ payout: { model: 'rate', rate: 0.05, budget: 250 } })).payout.budget, 250);
  assert.equal(defineProgram(base({ payout: { model: 'rate', rate: 0.05, budget: null } })).payout.budget, null);
});

const pk = (id, share, rule = { type: 'instant' }) => ({ id, label: id, share, rule });

test('pockets: shares must add up to exactly 1', () => {
  const ok = defineProgram(base({ pockets: [pk('now', 0.7), pk('later', 0.3, { type: 'unlocks', afterDays: 30 })] }));
  assert.deepEqual(ok.pockets.map((k) => k.shareBp), [7000, 3000]);
  invalid(base({ pockets: [pk('a', 0.5), pk('b', 0.4)] }), /add up to exactly 1/);
  invalid(base({ pockets: [pk('a', 0.6), pk('b', 0.5)] }), /add up to exactly 1/);
  const thirds = [pk('a', 0.3333), pk('b', 0.3333), pk('c', 0.3334)];
  assert.deepEqual(defineProgram(base({ pockets: thirds })).pockets.map((k) => k.shareBp), [3333, 3333, 3334]);
  invalid(base({ pockets: [pk('a', 0.33333), pk('b', 0.66667)] }), /at most 4 decimals/);
});

test('pockets: each share in (0, 1], slug ids, no repeats, between 1 and 6', () => {
  invalid(base({ pockets: [pk('a', 0), pk('b', 1)] }), /share must be > 0 and <= 1/);
  invalid(base({ pockets: [pk('a', 1.5)] }), /share must be > 0 and <= 1/);
  invalid(base({ pockets: [pk('a', -0.2), pk('b', 1.2)] }), /share must be > 0 and <= 1/);
  invalid(base({ pockets: [pk('a', 'half'), pk('b', 0.5)] }), /share must be > 0 and <= 1/);
  invalid(base({ pockets: [pk('Bad', 1)] }), /pockets\[0\]\.id must be a slug/);
  invalid(base({ pockets: [pk('a', 0.5), pk('a', 0.5)] }), /is repeated/);
  invalid(base({ pockets: [] }), /pockets must be a non-empty array/);
  invalid(base({ pockets: [{ id: 'a', label: '', share: 1, rule: { type: 'instant' } }] }), /label is required/);
  const seven = Array.from({ length: 7 }, (_, i) => pk(`p${i}`, 1 / 7));
  invalid(base({ pockets: seven }), /at most 6 pockets/);
  const six = [0.5, 0.2, 0.1, 0.1, 0.05, 0.05].map((s, i) => pk(`p${i}`, s));
  assert.equal(defineProgram(base({ pockets: six })).pockets.length, 6);
});

test('pocket rules: type is checked; delay is given in days or seconds, exactly one', () => {
  invalid(base({ pockets: [pk('a', 1, { type: 'sometime' })] }), /rule\.type must be one of/);
  invalid(base({ pockets: [{ id: 'a', label: 'a', share: 1 }] }), /rule\.type must be one of/);
  invalid(base({ pockets: [pk('a', 1, { type: 'expires' })] }), /give afterDays or afterSeconds \(exactly one\)/);
  invalid(base({ pockets: [pk('a', 1, { type: 'unlocks', afterDays: 1, afterSeconds: 60 })] }), /exactly one/);
  invalid(base({ pockets: [pk('a', 1, { type: 'unlocks', afterDays: 0 })] }), /delay must be > 0/);
  invalid(base({ pockets: [pk('a', 1, { type: 'unlocks', afterDays: -2 })] }), /delay must be > 0/);
  invalid(base({ pockets: [pk('a', 1, { type: 'unlocks', afterSeconds: 0 })] }), /delay must be > 0/);
  invalid(base({ pockets: [pk('a', 1, { type: 'unlocks', afterDays: 3651 })] }), /at most 10 years/);
  invalid(base({ pockets: [pk('a', 1, { type: 'unlocks', afterDays: 'x' })] }), /delay must be > 0/);
  const days = defineProgram(base({ pockets: [pk('a', 1, { type: 'unlocks', afterDays: 30 })] }));
  assert.equal(days.pockets[0].rule.afterSeconds, 30 * 86400);
  const secs = defineProgram(base({ pockets: [pk('a', 1, { type: 'expires', afterSeconds: 3600 })] }));
  assert.deepEqual(secs.pockets[0].rule, { type: 'expires', afterSeconds: 3600 });
  const frac = defineProgram(base({ pockets: [pk('a', 1, { type: 'expires', afterDays: 0.5 })] }));
  assert.equal(frac.pockets[0].rule.afterSeconds, 43200);
  const max = defineProgram(base({ pockets: [pk('a', 1, { type: 'unlocks', afterDays: 3650 })] }));
  assert.equal(max.pockets[0].rule.afterSeconds, 3650 * 86400);
  // An instant pocket carries no delay even if one is given.
  assert.equal(defineProgram(base({ pockets: [pk('a', 1, { type: 'instant', afterDays: 5 })] })).pockets[0].rule.afterSeconds, null);
});

test('unreachable: mode and reclaim delay', () => {
  assert.deepEqual(defineProgram(base({ unreachable: { mode: 'skip' } })).unreachable, { mode: 'skip', reclaimAfterSeconds: 30 * 86400 });
  assert.deepEqual(defineProgram(base({ unreachable: { reclaimAfterDays: 7 } })).unreachable, { mode: 'hold', reclaimAfterSeconds: 7 * 86400 });
  invalid(base({ unreachable: { mode: 'ignore' } }), /unreachable\.mode/);
  invalid(base({ unreachable: { reclaimAfterDays: 0 } }), /reclaimAfterDays/);
  invalid(base({ unreachable: { reclaimAfterDays: -1 } }), /reclaimAfterDays/);
  invalid(base({ unreachable: { reclaimAfterDays: 4000 } }), /reclaimAfterDays/);
});

test('every problem is reported at once', () => {
  assert.throws(() => defineProgram({ id: 'BAD', name: '', metrics: [], payout: { model: 'x' } }), (e) => e.problems.length >= 4);
});
