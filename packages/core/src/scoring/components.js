'use strict';

/**
 * Score components, all on a 0-100 scale. Pure functions.
 *
 * The period score is a WEIGHTED AVERAGE of the components that are available.
 * There are no multipliers: when a component is missing (attendance tracking
 * disabled, the leader did not evaluate), its weight is redistributed among
 * the others, so a missing component never penalizes the worker.
 */

const ATTENDANCE_WEIGHT = 0.6;
const UTILIZATION_WEIGHT = 0.4;

/**
 * Working days between two 'YYYY-MM-DD' dates (inclusive), excluding Sundays
 * and holidays. Saturday counts as a working day (typical warehouse week);
 * if the business does not work Saturdays, attendance is capped at 100 anyway.
 *
 * @param {string} from 'YYYY-MM-DD'
 * @param {string} to   'YYYY-MM-DD'
 * @param {Iterable<string>} [holidays] 'YYYY-MM-DD'
 * @returns {number}
 */
function workingDays(from, to, holidays) {
  const set = new Set(Array.from(holidays || []).map((d) => String(d).slice(0, 10)));
  const [y1, m1, d1] = String(from).slice(0, 10).split('-').map(Number);
  const [y2, m2, d2] = String(to).slice(0, 10).split('-').map(Number);
  let day = new Date(y1, m1 - 1, d1);
  const end = new Date(y2, m2 - 1, d2);
  let n = 0;
  while (day <= end) {
    const iso = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    if (day.getDay() !== 0 && !set.has(iso)) n += 1;
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
  }
  return n;
}

/**
 * Attendance score 0-100: attendance (60%) = days worked / working days,
 * capped at 100; utilization (40%) = time on task / time present, capped at 100.
 * Without utilization data, attendance takes the whole weight.
 *
 * @param {{daysWorked: number, utilization?: number|null}} totals
 * @param {number} nWorkingDays
 * @returns {number|null} null when there is no attendance data for the period
 */
function attendanceScore(totals, nWorkingDays) {
  if (!totals || !nWorkingDays || nWorkingDays <= 0) return null;
  if (!totals.daysWorked || totals.daysWorked <= 0) return null;

  const attendance = Math.min(1, totals.daysWorked / nWorkingDays) * 100;
  if (totals.utilization === null || totals.utilization === undefined) {
    return Math.round(attendance);
  }
  const utilization = Math.min(1, Math.max(0, totals.utilization)) * 100;
  return Math.round(attendance * ATTENDANCE_WEIGHT + utilization * UTILIZATION_WEIGHT);
}

/**
 * Leader evaluation score 0-100: grades 1-10 averaged with each criterion's
 * weight, × 10. Only criteria with a valid grade count.
 *
 * @param {Object<string|number, number>} grades {criterionId: 1..10}
 * @param {Array<{id: string|number, weight?: number}>} criteria active catalog
 * @returns {{score: number, average: number}|null} null when there is no valid grade
 */
function evaluationScore(grades, criteria) {
  if (!grades || !criteria || criteria.length === 0) return null;

  let sum = 0;
  let sumWeights = 0;
  let sumPlain = 0;
  let n = 0;
  for (const c of criteria) {
    const grade = Number(grades[c.id]);
    if (!Number.isFinite(grade) || grade < 1 || grade > 10) continue;
    const weight = Number(c.weight) > 0 ? Number(c.weight) : 1;
    sum += grade * weight;
    sumWeights += weight;
    sumPlain += grade;
    n += 1;
  }
  if (n === 0) return null;

  return {
    score: Math.round((sum / sumWeights) * 10),     // 0-100
    average: Math.round((sumPlain / n) * 10) / 10,  // 1-10, one decimal (display)
  };
}

/**
 * Combines components into the final 0-100 score. Components with a null score
 * are excluded and their weights are redistributed proportionally.
 *
 * @param {Array<{score: number|null, weight: number}>} components
 * @returns {number|null} null when no component has a score
 */
function combineScores(components) {
  const present = (components || []).filter(
    (c) => c && c.score !== null && c.score !== undefined && Number(c.weight) > 0,
  );
  if (present.length === 0) return null;

  const totalWeight = present.reduce((s, c) => s + Number(c.weight), 0);
  return Math.round(present.reduce((s, c) => s + Number(c.score) * (Number(c.weight) / totalWeight), 0));
}

module.exports = { workingDays, attendanceScore, evaluationScore, combineScores };
