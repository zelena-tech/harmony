'use strict';

const { DEFAULTS } = require('./tenant');
const { evaluationScore, combineScores } = require('./scoring/components');
const { resolveWeights, resolveTopN, applyTopN } = require('./scoring/ranking');
const { scoreCounter } = require('./scoring/inventory');
const { toStroopPrecision } = require('./stellar/networks');

/**
 * Computes the points and fund share of every worker for one period (campaign).
 * Pure function: the host reads its own database and passes the activity in.
 *
 * Two kinds of campaign:
 *  - 'orders': effort = orders picked/packed; performance = velocity + precision.
 *  - 'inventory': effort = lines counted; when `quality` is given, points and
 *    eligibility come from the quality rule (scoring/inventory.js). Only this
 *    kind honors the campaign overrides (weights, top-N).
 *
 * Steps
 *  1. base points = picking × pointsPerPicking + packing × pointsPerPacking
 *  2. velocity  = (completed / active hours) vs the best of the team → 0-100
 *                 (75 = neutral when nobody has time data)
 *     precision = completed / started → 0-100 (100 when nothing was started)
 *     performance = velocity × velocityWeight + precision × precisionWeight
 *  3. final score = weighted average of performance, attendance and leader
 *     evaluation; missing components redistribute their weight
 *  4. adjusted points = round(base points × final score / 100)
 *  5. top-N: only the N best adjusted points qualify (null = everybody)
 *  6. fund share = adjusted / Σ adjusted of the qualified; amount = share × fund
 *     (rounded to 7 decimals; the sum can differ from the fund by a few stroops,
 *     the payout planner corrects that before paying)
 *
 * @param {object} input
 * @param {object} input.scoring         tenant.scoring (defaults applied when omitted)
 * @param {'orders'|'inventory'} input.kind
 * @param {Array} input.activity
 *   orders:    [{ workerId, picking, packing, completed, started, activeSeconds }]
 *   inventory: [{ workerId, counts }]
 * @param {Map}    [input.quality]       inventory only: workerId → scoreSession() result
 * @param {object} [input.evaluations]   { [workerId]: { [criterionId]: grade 1-10 } }
 * @param {Array}  [input.criteria]      [{ id, weight }]
 * @param {object|null} [input.attendance] { [workerId]: score 0-100 | null }, null = disabled
 * @param {{performance?: number|null, evaluation?: number|null, topN?: number|null}} [input.overrides]
 * @param {number} [input.fundTotal]     confirmed fund of the period, in reward asset units
 */
function computePeriod(input) {
  const scoring = input.scoring || DEFAULTS.scoring;
  const inventory = input.kind === 'inventory';
  const quality = inventory ? input.quality || null : null;
  const overrides = input.overrides || {};
  const fundTotal = Number(input.fundTotal) || 0;

  const { performance: wPerformance, evaluation: wEvaluation } = inventory
    ? resolveWeights(overrides, scoring.weights)
    : { performance: scoring.weights.performance, evaluation: scoring.weights.evaluation };
  const wAttendance = scoring.weights.attendance;
  const topN = inventory ? resolveTopN(overrides.topN, scoring.topNDefault) : null;

  // ── 1. Effort per worker ─────────────────────────────────────────────────
  const entries = (input.activity || []).map((a) => {
    const e = inventory
      ? { workerId: a.workerId, picking: a.counts, packing: 0, completed: a.counts, started: a.counts,
          // Counts carry no per-record timestamp: a fixed hour makes velocity
          // normalize against whoever counted the most.
          activeSeconds: a.counts > 0 ? 3600 : 0 }
      : { workerId: a.workerId, picking: a.picking || 0, packing: a.packing || 0,
          completed: a.completed || 0, started: a.started || 0, activeSeconds: a.activeSeconds || 0 };
    e.pointsPicking = e.picking * scoring.pointsPerPicking;
    e.pointsPacking = e.packing * scoring.pointsPerPacking;
    e.pointsTotal = e.pointsPicking + e.pointsPacking;
    const hours = e.activeSeconds / 3600;
    e.perHour = hours > 0 ? e.completed / hours : 0;
    return e;
  });

  // ── 2-4. Scores and adjusted points ──────────────────────────────────────
  const maxPerHour = entries.reduce((m, e) => Math.max(m, e.perHour), 0);
  for (const e of entries) {
    const velocity = maxPerHour > 0 ? Math.min(100, Math.round((e.perHour / maxPerHour) * 100)) : 75;
    const precision = e.started > 0 ? Math.min(100, Math.round((e.completed / e.started) * 100)) : 100;
    const performance = Math.round(velocity * scoring.velocityWeight + precision * scoring.precisionWeight);

    const evaluation = evaluationScore((input.evaluations || {})[e.workerId], input.criteria || []);
    const attendance = input.attendance ? (input.attendance[e.workerId] ?? null) : null;
    const finalScore = combineScores([
      { score: performance, weight: wPerformance },
      { score: attendance, weight: wAttendance },
      { score: evaluation?.score ?? null, weight: wEvaluation },
    ]) ?? performance;

    Object.assign(e, {
      velocityScore: velocity,
      precisionScore: precision,
      attendanceScore: attendance,
      evaluationScore: evaluation?.score ?? null,
      evaluationAverage: evaluation?.average ?? null,
      finalScore,
      adjustedPoints: Math.round(e.pointsTotal * (finalScore / 100)),
    });

    // Inventory quality rule: points and score come from the counted lines.
    // Whoever is below the minimum precision keeps the points visible
    // (pointsTotal) but adjustedPoints = 0: out of the top and of the fund.
    if (quality) {
      const q = quality.get(e.workerId) || scoreCounter({}, scoring.inventory);
      Object.assign(e, {
        picking: q.lines,
        pointsPicking: q.points,
        pointsTotal: q.points,
        precisionScore: Math.round(q.precision * 100),
        velocityScore: Math.round(q.accuracy * 100), // accuracy in units
        finalScore: Math.round(q.precision * 100),
        adjustedPoints: q.eligible ? q.points : 0,
      });
    }
    e.tokenAmount = toStroopPrecision(e.adjustedPoints * scoring.tokenRate);
    e.fiatEquivalent = scoring.fiatPerToken === null ? null : Math.round(e.tokenAmount * scoring.fiatPerToken);
  }

  // ── 5-6. Top-N and fund share ────────────────────────────────────────────
  const ranked = applyTopN(entries, topN);
  const qualified = new Map(ranked.map((e) => [e.workerId, e.qualified]));
  const totalQualified = entries
    .filter((e) => qualified.get(e.workerId))
    .reduce((s, e) => s + e.adjustedPoints, 0);

  const workers = entries.map((e) => {
    const isQualified = qualified.get(e.workerId);
    const fundShare = isQualified && totalQualified > 0 ? e.adjustedPoints / totalQualified : 0;
    const { perHour, ...row } = e;
    return { ...row, qualified: isQualified, fundShare, assignedAmount: toStroopPrecision(fundShare * fundTotal) };
  });

  return {
    kind: inventory ? 'inventory' : 'orders',
    topN,
    fundTotal,
    totals: {
      workers: workers.length,
      basePoints: workers.reduce((s, w) => s + w.pointsTotal, 0),
      adjustedPoints: workers.reduce((s, w) => s + w.adjustedPoints, 0),
      adjustedPointsQualified: totalQualified,
    },
    workers,
  };
}

module.exports = { computePeriod };
