'use strict';

/**
 * Inventory campaign points based on QUALITY. Pure functions.
 *
 * The unit is the LINE each person counted (product + location), compared with
 * the final result of the cross-count:
 *   - correct: the person's number is the agreed value, or the person entered 0
 *              as a verifier and the line was discarded;
 *   - wrong:   the number differs, the person counted in the wrong location
 *              (discarded line), or a supervisor voided the record;
 *   - not evaluated: the line has no consensus yet (adds nothing, removes nothing).
 *
 * Line weight = 1 + log10(units): counting 10 000 units is worth more than
 * counting 1, but not ten thousand times more (1 → 1, 10 → 2, 100 → 3, 10 000 → 5).
 * Points = Σ weight(correct) − PENALTY × Σ weight(wrong), never negative.
 * Only people with at least MIN_PRECISION correct lines are eligible for the
 * reward: whoever fails more than 1 line in 10 stays in the ranking but out of the prize.
 */

const MIN_PRECISION = 0.9;
const PENALTY = 2;

const lineWeight = (units) => 1 + Math.log10(Math.max(1, Number(units) || 0));

/**
 * Evaluates the lines of one counting zone and accumulates per person into `acc`.
 *
 * Input shape (produced by the host's cross-count):
 *   products: [{ locations: [{
 *     discarded?: boolean,
 *     consensus: 'resolved' | 'pending' | ...,
 *     consensusValue: number|null,
 *     counters: [{ workerId, total, voided?: boolean }],
 *   }] }]
 *
 * @param {Array} products
 * @param {Map} [acc] workerId → metrics
 * @returns {Map} acc
 */
function accumulateZone(products, acc = new Map()) {
  const of = (id) => {
    if (!acc.has(id)) acc.set(id, { correct: 0, wrong: 0, weightCorrect: 0, weightWrong: 0, unitsError: 0, unitsRef: 0 });
    return acc.get(id);
  };
  for (const p of products || []) {
    for (const l of p.locations || []) {
      // Reference value of the line: 0 when discarded; the consensus when resolved.
      let ref = null;
      if (l.discarded) ref = 0;
      else if (l.consensus === 'resolved') ref = Number(l.consensusValue);
      if (ref === null || !Number.isFinite(ref)) continue;
      for (const c of l.counters || []) {
        const m = of(c.workerId);
        const x = Number(c.total) || 0;
        const ok = !c.voided && x === ref;
        const w = lineWeight(Math.max(x, ref));
        m.unitsRef += Math.max(x, ref);
        m.unitsError += c.voided ? Math.max(x, ref) : Math.abs(x - ref);
        if (ok) { m.correct++; m.weightCorrect += w; } else { m.wrong++; m.weightWrong += w; }
      }
    }
  }
  return acc;
}

/**
 * Points, precision and eligibility from one person's metrics.
 *
 * @param {object} m output of accumulateZone for one person
 * @param {{minPrecision?: number, penalty?: number}} [opts]
 */
function scoreCounter(m, { minPrecision = MIN_PRECISION, penalty = PENALTY } = {}) {
  const evaluated = (m?.correct || 0) + (m?.wrong || 0);
  const precision = evaluated ? m.correct / evaluated : 0;
  const accuracy = m?.unitsRef ? Math.max(0, 1 - m.unitsError / m.unitsRef) : 0;
  const points = Math.max(0, Math.round((m?.weightCorrect || 0) - penalty * (m?.weightWrong || 0)));
  return {
    lines: evaluated,
    correct: m?.correct || 0,
    wrong: m?.wrong || 0,
    precision,
    accuracy,
    points,
    // Without evaluated lines nobody knows whether the person counted well.
    eligible: evaluated > 0 && precision >= minPrecision,
  };
}

/** Accumulates every zone of a session and scores each person. */
function scoreSession(zones, opts) {
  const acc = new Map();
  for (const products of zones || []) accumulateZone(products, acc);
  const out = new Map();
  for (const [id, m] of acc) out.set(id, scoreCounter(m, opts));
  return out;
}

module.exports = { MIN_PRECISION, PENALTY, lineWeight, accumulateZone, scoreCounter, scoreSession };
