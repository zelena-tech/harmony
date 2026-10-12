'use strict';

/**
 * Top-N ranking and per-campaign weight overrides. Pure functions.
 *
 * Golden rule: when nothing is configured the result is identical to the
 * legacy behavior (the fund is shared among everybody with the global weights).
 */

/**
 * Effective performance/evaluation weights for a campaign: the campaign
 * override when defined (0 is a valid override, so it is compared with
 * null/undefined, never with a truthy check), otherwise the tenant default.
 * The attendance weight is never overridden per campaign.
 *
 * @param {{performance?: number|null, evaluation?: number|null}} [overrides]
 * @param {{performance?: number, evaluation?: number}} [defaults]
 * @returns {{performance: number, evaluation: number}}
 */
function resolveWeights(overrides, defaults) {
  const globalPerformance = parseFloat(defaults?.performance ?? 0.5);
  const globalEvaluation = parseFloat(defaults?.evaluation ?? 0.3);
  const o = overrides || {};
  return {
    performance: o.performance === null || o.performance === undefined ? globalPerformance : parseFloat(o.performance),
    evaluation: o.evaluation === null || o.evaluation === undefined ? globalEvaluation : parseFloat(o.evaluation),
  };
}

/**
 * Number of people who get paid: the campaign value when defined, otherwise the
 * tenant default, otherwise null (no limit). Accepts numeric strings because
 * the value usually comes from a form.
 *
 * @returns {number|null}
 */
function resolveTopN(campaignTopN, defaultTopN) {
  for (const v of [campaignTopN, defaultTopN]) {
    if (v !== null && v !== undefined) {
      const n = parseInt(v, 10);
      return Number.isInteger(n) && n > 0 ? n : null;
    }
  }
  return null;
}

/**
 * Marks the N entries with the highest adjustedPoints as qualified.
 *
 * Nobody is removed from the list: everybody comes back (so the team can see
 * the full ranking) and only `qualified=false` marks who is out of the top-N.
 * The caller must give those entries a fund share of 0. With n = null it is a
 * no-op and everybody qualifies. Ties keep the input order (stable sort).
 *
 * @param {Array<{workerId: any, adjustedPoints: number}>} entries
 * @param {number|null} n
 * @returns {Array<{workerId: any, adjustedPoints: number, qualified: boolean}>}
 */
function applyTopN(entries, n) {
  const list = entries || [];
  if (n === null || n === undefined) return list.map((e) => ({ ...e, qualified: true }));

  const sorted = [...list].sort((a, b) => b.adjustedPoints - a.adjustedPoints);
  const ids = new Set(sorted.slice(0, n).map((e) => e.workerId));
  return list.map((e) => ({ ...e, qualified: ids.has(e.workerId) }));
}

/**
 * Review multipliers (basis points) to encode an inventory campaign on-chain.
 *
 * In an inventory campaign each participant has ONE on-chain task, so the
 * contract's proportional split (points / total points) must carry the
 * points themselves: the multiplier is proportional to adjustedPoints,
 * normalized to the maximum (20 000 bp = 200%, the contract ceiling).
 * Whoever did not qualify gets 0 and therefore cannot claim on-chain.
 * A qualified worker with points always gets at least 1 bp.
 *
 * @param {Array<{workerId: any, adjustedPoints: number|string, fundShare: number|string}>} rows
 * @returns {Object<string, number>|null} workerId → bp (0-20000), or null when nobody qualified with points
 */
function inventoryMultipliersBp(rows) {
  const list = (rows || []).map((r) => ({
    workerId: r.workerId,
    points: parseInt(r.adjustedPoints, 10) || 0,
    qualified: parseFloat(r.fundShare) > 0,
  }));
  const max = Math.max(0, ...list.map((r) => (r.qualified ? r.points : 0)));
  if (max <= 0) return null;

  const out = {};
  for (const r of list) {
    out[r.workerId] = r.qualified && r.points > 0
      ? Math.max(1, Math.min(20000, Math.round((r.points / max) * 20000)))
      : 0;
  }
  return out;
}

module.exports = { resolveWeights, resolveTopN, applyTopN, inventoryMultipliersBp };
