'use strict';

const { HarmonyError } = require('@zelena/harmony-core');

/**
 * Turns the activity of a period into standings. Pure: no network, no clock.
 *
 *   units    = sum of event values per metric, limited by the metric cap
 *   raw      = max(0, sum of units x points)          (penalties never go below 0)
 *   earned   = round(raw x qualityFactor)             (what is added to the lifetime total)
 *   adjusted = round(earned x level multiplier)       (what the payout is shared by)
 *
 * qualityFactor = 1 - w + w x q, with q the person's quality score in 0..1 and
 * w the program's quality weight. Without a score the factor is 1.
 *
 * The level comes from the lifetime points BEFORE this period, so a period can
 * never promote someone and pay them with the new multiplier at the same time.
 */

/** Level of a lifetime total, plus the next step of the ladder. */
function levelFor(program, lifetimePoints) {
  const total = Math.max(0, Number(lifetimePoints) || 0);
  let index = 0;
  program.levels.forEach((l, i) => { if (total >= l.minLifetimePoints) index = i; });
  const level = program.levels[index];
  const next = program.levels[index + 1] || null;
  return {
    id: level.id,
    name: level.name,
    multiplier: level.multiplier,
    step: index + 1,
    steps: program.levels.length,
    next: next ? { id: next.id, name: next.name, pointsToGo: Math.max(0, next.minLifetimePoints - total) } : null,
  };
}

/**
 * @param {object} program  defineProgram() result
 * @param {object} input
 * @param {Array<{participantId: string|number, metric: string, value?: number}>} input.events
 * @param {Array<string|number>} [input.participants]  people to list even without events
 * @param {Object<string, number>} [input.quality]     participantId -> 0..1
 * @param {Object<string, number>} [input.lifetime]    participantId -> lifetime points before this period
 * @returns {{standings: Array, totals: {participants: number, qualified: number, adjustedPoints: number}}}
 */
function score(program, input) {
  const { events, participants, quality, lifetime } = input || {};
  if (!Array.isArray(events)) throw new HarmonyError(400, 'events must be an array of { participantId, metric, value }.');
  const metricById = new Map(program.metrics.map((m) => [m.id, m]));

  const rows = new Map(); // participantId (string) -> { units: Map(metric -> units) }
  const touch = (id) => {
    const key = String(id);
    if (id === null || id === undefined || key === '') throw new HarmonyError(400, 'Every event needs a participantId.');
    if (!rows.has(key)) rows.set(key, new Map());
    return rows.get(key);
  };
  for (const id of participants || []) touch(id);

  const unknown = new Set();
  events.forEach((e, i) => {
    if (!e || typeof e !== 'object') throw new HarmonyError(400, `events[${i}] is not an object.`);
    const metric = metricById.get(e.metric);
    if (!metric) { unknown.add(String(e.metric)); return; }
    const value = e.value === undefined ? 1 : Number(e.value);
    if (!Number.isFinite(value) || value < 0) throw new HarmonyError(400, `events[${i}].value must be a number >= 0.`);
    const units = touch(e.participantId);
    units.set(metric.id, (units.get(metric.id) || 0) + value);
  });
  if (unknown.size) {
    throw new HarmonyError(400, `Unknown metric(s): ${[...unknown].join(', ')}. The program "${program.id}" accepts: ${[...metricById.keys()].join(', ')}.`,
      { code: 'UNKNOWN_METRIC' });
  }

  const w = program.quality ? program.quality.weight : 0;
  const standings = [...rows.entries()].map(([participantId, units], order) => {
    const byMetric = {};
    let raw = 0;
    for (const m of program.metrics) {
      const reported = units.get(m.id) || 0;
      const counted = m.cap === null ? reported : Math.min(reported, m.cap);
      const points = counted * m.points;
      byMetric[m.id] = { units: counted, reported, points };
      raw += points;
    }
    raw = Math.max(0, raw);
    const q = quality && quality[participantId] !== undefined ? Math.min(1, Math.max(0, Number(quality[participantId]) || 0)) : null;
    const qualityFactor = q === null ? 1 : 1 - w + w * q;
    const earnedPoints = Math.round(raw * qualityFactor);
    const lifetimeBefore = Math.max(0, Number(lifetime && lifetime[participantId]) || 0);
    const level = levelFor(program, lifetimeBefore);
    const adjustedPoints = Math.round(earnedPoints * level.multiplier);
    return {
      participantId,
      byMetric,
      rawPoints: raw,
      quality: q,
      qualityFactor: Number(qualityFactor.toFixed(6)),
      earnedPoints,
      level,
      adjustedPoints,
      qualified: adjustedPoints > 0 && adjustedPoints >= program.minPoints,
      lifetimeBefore,
      lifetimeAfter: lifetimeBefore + earnedPoints,
      levelAfter: levelFor(program, lifetimeBefore + earnedPoints),
      order,
    };
  });

  // Highest first; ties keep the order in which people first appeared.
  standings.sort((a, b) => (b.adjustedPoints - a.adjustedPoints) || (b.earnedPoints - a.earnedPoints) || (a.order - b.order));
  standings.forEach((s, i) => { s.rank = i + 1; delete s.order; });

  return {
    standings,
    totals: {
      participants: standings.length,
      qualified: standings.filter((s) => s.qualified).length,
      adjustedPoints: standings.reduce((s, r) => s + (r.qualified ? r.adjustedPoints : 0), 0),
    },
  };
}

module.exports = { score, levelFor };
