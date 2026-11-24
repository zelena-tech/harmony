'use strict';

/**
 * A program describes, for one industry or team, how work becomes money:
 *
 *   metrics  what counts and how many points each unit is worth
 *   levels   the ladder a person climbs with lifetime points (and its multiplier)
 *   payout   how the pool is shared (proportional, top-N or a rate per point)
 *   pockets  how each person's reward is split, each pocket with its own rule
 *
 * A program has no network and no keys: it is plain validated data, deeply
 * frozen, so it can be stored as JSON, shown in a form or shipped as a template.
 */

const PAYOUT_MODELS = Object.freeze(['proportional', 'topN', 'rate']);
const POCKET_RULES = Object.freeze(['instant', 'expires', 'unlocks']);
const MAX_POCKETS = 6;
const SECONDS_PER_DAY = 86400;

class ProgramConfigError extends Error {
  constructor(problems) {
    super(`Invalid program: ${problems.join('; ')}`);
    this.name = 'ProgramConfigError';
    this.problems = problems;
  }
}

const isSlug = (v) => typeof v === 'string' && /^[a-z0-9][a-z0-9_-]{0,62}$/.test(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isText = (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 120;

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  return Object.freeze(o);
}

const DEFAULT_LEVELS = [{ id: 'member', name: 'Member', minLifetimePoints: 0, multiplier: 1 }];
const DEFAULT_POCKETS = [{ id: 'available', label: 'Available now', share: 1, rule: { type: 'instant' } }];
const DEFAULT_UNREACHABLE = { mode: 'hold', reclaimAfterDays: 30 };

/** Seconds of a pocket rule given as `afterDays` or `afterSeconds` (exactly one). */
function ruleSeconds(rule, problems, where) {
  const hasDays = rule.afterDays !== undefined && rule.afterDays !== null;
  const hasSeconds = rule.afterSeconds !== undefined && rule.afterSeconds !== null;
  if (hasDays === hasSeconds) { problems.push(`${where}: give afterDays or afterSeconds (exactly one)`); return null; }
  const s = hasDays ? rule.afterDays * SECONDS_PER_DAY : rule.afterSeconds;
  if (!isNum(s) || s <= 0 || s > 3650 * SECONDS_PER_DAY) { problems.push(`${where}: the delay must be > 0 and at most 10 years`); return null; }
  return Math.round(s);
}

/**
 * Validates a program definition, fills defaults and returns an immutable copy.
 * Throws ProgramConfigError listing every problem found.
 *
 * @param {object} input
 * @param {string} input.id           slug
 * @param {string} input.name
 * @param {string} [input.industry]
 * @param {string} [input.description]
 * @param {Array<{id: string, label: string, points: number, cap?: number|null}>} input.metrics
 *        `points` may be negative (a penalty); `cap` limits the units counted per person and period
 * @param {{weight: number}|null} [input.quality]  how much a 0..1 quality score moves the points
 * @param {number} [input.minPoints]  minimum points to qualify for the payout
 * @param {Array<{id: string, name: string, minLifetimePoints: number, multiplier: number}>} [input.levels]
 * @param {object} input.payout       { model: 'proportional', pool } | { model: 'topN', pool, topN, base? }
 *                                    | { model: 'rate', rate, budget? }
 * @param {Array<{id: string, label: string, share: number, rule: object}>} [input.pockets]
 * @param {{mode: 'hold'|'skip', reclaimAfterDays?: number}} [input.unreachable]
 *        what to do with someone who cannot receive yet (no account or no trustline)
 */
function defineProgram(input) {
  const problems = [];
  const p = input || {};

  if (!isSlug(p.id)) problems.push('id must be a slug (a-z, 0-9, - or _)');
  if (!isText(p.name)) problems.push('name is required (up to 120 chars)');
  for (const k of ['industry', 'description', 'unit']) {
    if (p[k] != null && typeof p[k] !== 'string') problems.push(`${k} must be a string`);
  }

  // ── metrics ────────────────────────────────────────────────────────────────
  const metrics = [];
  if (!Array.isArray(p.metrics) || !p.metrics.length) problems.push('metrics must be a non-empty array');
  else {
    const seen = new Set();
    p.metrics.forEach((m, i) => {
      const where = `metrics[${i}]`;
      if (!m || !isSlug(m.id)) { problems.push(`${where}.id must be a slug`); return; }
      if (seen.has(m.id)) problems.push(`${where}.id "${m.id}" is repeated`);
      seen.add(m.id);
      if (!isText(m.label)) problems.push(`${where}.label is required`);
      if (!isNum(m.points) || m.points === 0) problems.push(`${where}.points must be a number different from 0`);
      const cap = m.cap === undefined ? null : m.cap;
      if (cap !== null && !(isNum(cap) && cap > 0)) problems.push(`${where}.cap must be a positive number or null`);
      metrics.push({ id: m.id, label: m.label, points: m.points, cap });
    });
    if (metrics.length && !metrics.some((m) => m.points > 0)) problems.push('at least one metric must give positive points');
  }

  // ── quality and qualification ──────────────────────────────────────────────
  let quality = null;
  if (p.quality != null) {
    if (!isNum(p.quality.weight) || p.quality.weight < 0 || p.quality.weight > 1) problems.push('quality.weight must be between 0 and 1');
    else quality = { weight: p.quality.weight };
  }
  const minPoints = p.minPoints === undefined ? 0 : p.minPoints;
  if (!isNum(minPoints) || minPoints < 0) problems.push('minPoints must be a number >= 0');

  // ── levels ─────────────────────────────────────────────────────────────────
  const levels = [];
  const rawLevels = p.levels === undefined ? DEFAULT_LEVELS : p.levels;
  if (!Array.isArray(rawLevels) || !rawLevels.length) problems.push('levels must be a non-empty array');
  else {
    const seen = new Set();
    rawLevels.forEach((l, i) => {
      const where = `levels[${i}]`;
      if (!l || !isSlug(l.id)) { problems.push(`${where}.id must be a slug`); return; }
      if (seen.has(l.id)) problems.push(`${where}.id "${l.id}" is repeated`);
      seen.add(l.id);
      if (!isText(l.name)) problems.push(`${where}.name is required`);
      if (!isNum(l.minLifetimePoints) || l.minLifetimePoints < 0) problems.push(`${where}.minLifetimePoints must be a number >= 0`);
      const multiplier = l.multiplier === undefined ? 1 : l.multiplier;
      if (!isNum(multiplier) || multiplier <= 0 || multiplier > 5) problems.push(`${where}.multiplier must be > 0 and <= 5`);
      levels.push({ id: l.id, name: l.name, minLifetimePoints: l.minLifetimePoints, multiplier });
    });
    for (let i = 1; i < levels.length; i++) {
      if (!(levels[i].minLifetimePoints > levels[i - 1].minLifetimePoints)) {
        problems.push('levels must be sorted by strictly increasing minLifetimePoints');
        break;
      }
    }
    if (levels.length && levels[0].minLifetimePoints !== 0) problems.push('the first level must start at 0 lifetime points');
  }

  // ── payout ─────────────────────────────────────────────────────────────────
  const po = p.payout || {};
  const payout = { model: po.model, pool: null, base: 0, topN: null, rate: null, budget: null };
  if (!PAYOUT_MODELS.includes(po.model)) problems.push(`payout.model must be one of: ${PAYOUT_MODELS.join(', ')}`);
  else if (po.model === 'rate') {
    if (!isNum(po.rate) || po.rate <= 0) problems.push('payout.rate must be a number > 0 (reward units per point)');
    else payout.rate = po.rate;
    if (po.budget != null) {
      if (!isNum(po.budget) || po.budget <= 0) problems.push('payout.budget must be a number > 0 or null');
      else payout.budget = po.budget;
    }
  } else {
    if (!isNum(po.pool) || po.pool <= 0) problems.push('payout.pool must be a number > 0');
    else payout.pool = po.pool;
    if (po.model === 'topN') {
      if (!Number.isInteger(po.topN) || po.topN <= 0) problems.push('payout.topN must be a positive integer');
      else payout.topN = po.topN;
      if (po.base != null) {
        if (!isNum(po.base) || po.base < 0) problems.push('payout.base must be a number >= 0');
        else payout.base = po.base;
      }
    }
  }

  // ── pockets ────────────────────────────────────────────────────────────────
  const pockets = [];
  const rawPockets = p.pockets === undefined ? DEFAULT_POCKETS : p.pockets;
  if (!Array.isArray(rawPockets) || !rawPockets.length) problems.push('pockets must be a non-empty array');
  else if (rawPockets.length > MAX_POCKETS) problems.push(`at most ${MAX_POCKETS} pockets`);
  else {
    const seen = new Set();
    let totalBp = 0;
    rawPockets.forEach((k, i) => {
      const where = `pockets[${i}]`;
      if (!k || !isSlug(k.id)) { problems.push(`${where}.id must be a slug`); return; }
      if (seen.has(k.id)) problems.push(`${where}.id "${k.id}" is repeated`);
      seen.add(k.id);
      if (!isText(k.label)) problems.push(`${where}.label is required`);
      const bp = isNum(k.share) ? Math.round(k.share * 10000) : NaN;
      if (!(bp > 0 && bp <= 10000) || Math.abs(bp - k.share * 10000) > 1e-6) {
        problems.push(`${where}.share must be > 0 and <= 1, with at most 4 decimals`);
      } else totalBp += bp;
      const rule = k.rule || {};
      if (!POCKET_RULES.includes(rule.type)) { problems.push(`${where}.rule.type must be one of: ${POCKET_RULES.join(', ')}`); return; }
      const seconds = rule.type === 'instant' ? null : ruleSeconds(rule, problems, `${where}.rule`);
      pockets.push({ id: k.id, label: k.label, shareBp: bp, rule: { type: rule.type, afterSeconds: seconds } });
    });
    if (pockets.length === rawPockets.length && totalBp !== 10000) problems.push('the pocket shares must add up to exactly 1');
  }

  // ── people who cannot receive yet ──────────────────────────────────────────
  const un = { ...DEFAULT_UNREACHABLE, ...(p.unreachable || {}) };
  if (!['hold', 'skip'].includes(un.mode)) problems.push('unreachable.mode must be "hold" or "skip"');
  if (!isNum(un.reclaimAfterDays) || un.reclaimAfterDays <= 0 || un.reclaimAfterDays > 3650) {
    problems.push('unreachable.reclaimAfterDays must be > 0 and at most 3650');
  }

  if (problems.length) throw new ProgramConfigError(problems);

  return deepFreeze({
    id: p.id,
    name: p.name,
    industry: p.industry || null,
    description: p.description || null,
    unit: p.unit || null,
    metrics,
    quality,
    minPoints,
    levels,
    payout,
    pockets,
    unreachable: { mode: un.mode, reclaimAfterSeconds: Math.round(un.reclaimAfterDays * SECONDS_PER_DAY) },
  });
}

const isProgram = (o) => !!o && Object.isFrozen(o) && Array.isArray(o.metrics) && Array.isArray(o.pockets) && !!o.unreachable;

module.exports = { defineProgram, isProgram, ProgramConfigError, PAYOUT_MODELS, POCKET_RULES, MAX_POCKETS, SECONDS_PER_DAY };
