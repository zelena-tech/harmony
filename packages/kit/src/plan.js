'use strict';

const crypto = require('node:crypto');
const { HarmonyError, payouts } = require('@zelena/harmony-core');
const { toStroops, fromStroops, splitByBasisPoints } = require('./money');

/**
 * Payout plan of a program: who gets how much, and how each person's reward is
 * split into pockets. Pure: no network, and the clock is an input (`now`).
 *
 * The split between people is done by the audited planner of the engine
 * (`planCampaignPayout`), so the kit inherits its rules: the ranking is
 * computed over everybody, a share that belongs to someone without a wallet is
 * WITHHELD and reported (never redistributed), whoever already got the bonus of
 * the campaign is left out, recently changed wallets are flagged, and the
 * tenant caps are applied.
 *
 * Every amount in a kit plan is a string with 7 decimals.
 */

const short = (w) => `${w.slice(0, 4)}…${w.slice(-6)}`;

/** people as an array or as a map participantId -> { name, wallet } */
function peopleMap(people) {
  const out = new Map();
  if (Array.isArray(people)) {
    for (const p of people) if (p && p.participantId !== undefined) out.set(String(p.participantId), p);
  } else if (people && typeof people === 'object') {
    for (const [id, p] of Object.entries(people)) out.set(String(id), p || {});
  }
  return out;
}

/**
 * The kit hands ids to the engine as strings, so a map keyed by a number (a
 * database id, say) would never match and a person who was already paid would
 * be paid again. Re-keys any map by String(key).
 */
function stringKeyed(map) {
  if (!map) return map;
  return new Map([...map.entries()].map(([k, v]) => [String(k), v]));
}

/**
 * Stable id of a plan: sha256 of what will be paid. It travels on-chain as the
 * transaction memo, which ties every payment to its plan.
 */
function planIdOf(plan) {
  const canonical = JSON.stringify({
    program: plan.programId,
    tenant: plan.tenantId,
    asset: [plan.asset.code, plan.asset.issuer],
    createdAt: plan.createdAt,
    payments: plan.payments.map((p) => [
      p.participantId, p.wallet, p.amount,
      p.pockets.map((k) => [k.id, k.amount, k.rule.type, k.rule.at]),
    ]),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * @param {object} program  defineProgram() result
 * @param {object} tenant   defineTenant() result
 * @param {object} input
 * @param {Array}  input.standings            score().standings
 * @param {Array|Object} input.people         [{ participantId, name, wallet }] or a map by participantId
 * @param {number} [input.now]                unix seconds; pocket dates are computed from it
 * @param {Map}    [input.previous]           payouts.summarizePrevious() of this campaign (keys: participantId)
 * @param {Map}    [input.walletChanges]      participantId -> { hours }
 * @param {object} [input.options]            { pool, base, topN, rate, budget, includeAlreadyPaid }
 */
function plan(program, tenant, input) {
  const { standings, people, previous, walletChanges } = input || {};
  const opts = (input && input.options) || {};
  if (!Array.isArray(standings) || !standings.length) throw new HarmonyError(409, 'There are no standings: score the period first.');
  const now = input.now === undefined ? Math.floor(Date.now() / 1000) : input.now;
  if (!Number.isInteger(now) || now <= 0) throw new HarmonyError(400, 'now must be a unix time in seconds.');

  const who = peopleMap(people);
  const byId = new Map(standings.map((s) => [String(s.participantId), s]));
  // Only whoever qualified is paid. The ranks are unchanged, because everybody
  // who qualified is above everybody who did not.
  const ranking = standings.filter((s) => s.qualified && s.adjustedPoints > 0).map((s) => {
    const person = who.get(String(s.participantId)) || {};
    return {
      workerId: String(s.participantId),
      name: person.name || String(s.participantId),
      wallet: person.wallet || null,
      adjustedPoints: s.adjustedPoints,
    };
  });
  const qualified = ranking;
  if (!qualified.length) throw new HarmonyError(409, 'Nobody qualified in this period: there is nobody to pay.', { code: 'NOBODY_QUALIFIED' });
  const sumPoints = qualified.reduce((s, r) => s + r.adjustedPoints, 0);

  const model = program.payout.model;
  const num = (v, fallback) => (v === undefined || v === null || v === '' ? fallback : Number(v));
  let coreOptions;
  let rule;
  if (model === 'rate') {
    const rate = num(opts.rate, program.payout.rate);
    const budget = num(opts.budget, program.payout.budget);
    if (!Number.isFinite(rate) || rate <= 0) throw new HarmonyError(400, 'rate must be a number > 0');
    if (budget !== null && (!Number.isFinite(budget) || budget <= 0)) throw new HarmonyError(400, 'budget must be a number > 0');
    const due = Number((sumPoints * rate).toFixed(7));
    const pool = budget !== null && due > budget ? budget : due;
    coreOptions = { base: 0, pool, topN: qualified.length };
    rule = { model, rate, budget, due: fromStroops(toStroops(due)), scaledToBudget: pool < due };
  } else {
    const pool = num(opts.pool, program.payout.pool);
    if (!Number.isFinite(pool) || pool <= 0) throw new HarmonyError(400, 'pool must be a number > 0');
    if (model === 'topN') {
      const topN = num(opts.topN, program.payout.topN);
      const base = num(opts.base, program.payout.base);
      coreOptions = { base, pool, topN };
      rule = { model, pool, topN, base };
    } else {
      coreOptions = { base: 0, pool, topN: qualified.length };
      rule = { model, pool };
    }
  }
  coreOptions.includeAlreadyPaid = opts.includeAlreadyPaid === true;

  const core = payouts.planCampaignPayout({
    ranking,
    previous: stringKeyed(previous),
    walletChanges: stringKeyed(walletChanges),
    caps: tenant.payouts.caps,
    defaults: tenant.payouts.defaults,
    options: coreOptions,
  });

  const bps = program.pockets.map((k) => k.shareBp);
  const payments = core.payments.map((p) => {
    const total = toStroops(p.amount);
    const parts = splitByBasisPoints(total, bps);
    const standing = byId.get(String(p.workerId));
    const pockets = program.pockets
      .map((k, i) => ({
        id: k.id,
        label: k.label,
        amount: fromStroops(parts[i]),
        rule: { type: k.rule.type, at: k.rule.type === 'instant' ? null : now + k.rule.afterSeconds },
      }))
      .filter((k, i) => parts[i] > 0n);
    return {
      participantId: String(p.workerId),
      name: p.name,
      wallet: p.wallet,
      walletShort: short(p.wallet),
      amount: fromStroops(total),
      rank: p.rank,
      points: standing ? standing.adjustedPoints : null,
      level: standing ? { id: standing.level.id, name: standing.level.name, multiplier: standing.level.multiplier } : null,
      detail: p.detail,
      alert: p.alert,
      alreadyPaidBonus: p.alreadyPaidBonus,
      pockets,
    };
  });

  const result = {
    programId: program.id,
    tenantId: tenant.id,
    network: tenant.network,
    asset: { code: tenant.rewardAsset.code, issuer: tenant.rewardAsset.issuer },
    createdAt: now,
    rule,
    payments,
    total: fromStroops(payments.reduce((s, p) => s + toStroops(p.amount), 0n)),
    byPocket: program.pockets.map((k) => ({
      id: k.id,
      label: k.label,
      rule: k.rule.type,
      amount: fromStroops(payments.reduce((s, p) => s + toStroops((p.pockets.find((x) => x.id === k.id) || { amount: 0 }).amount), 0n)),
    })),
    withheld: core.withheld.map((x) => ({ ...x, amount: fromStroops(toStroops(x.amount)) })),
    withoutWallet: core.withoutWallet,
    excludedAlreadyPaid: core.excludedAlreadyPaid,
    flagged: core.flagged,
    caps: core.caps,
  };
  result.planId = planIdOf(result);
  return result;
}

/**
 * Checks that a plan was not altered after it was created: same id, pockets
 * that add up to each payment, payments that add up to the total.
 * Throws HarmonyError(400) otherwise.
 */
function assertPlanIntegrity(p) {
  const bad = (why) => { throw new HarmonyError(400, `The plan is not consistent: ${why}.`, { code: 'PLAN_ALTERED' }); };
  if (!p || !Array.isArray(p.payments) || !p.payments.length) bad('it has no payments');
  let total = 0n;
  for (const pay of p.payments) {
    const sum = (pay.pockets || []).reduce((s, k) => s + toStroops(k.amount), 0n);
    if (sum !== toStroops(pay.amount) || sum <= 0n) bad(`the pockets of ${pay.name || pay.participantId} do not add up to the payment`);
    total += sum;
  }
  if (total !== toStroops(p.total)) bad('the payments do not add up to the total');
  if (planIdOf(p) !== p.planId) bad('its id does not match its content');
}

module.exports = { plan, planIdOf, assertPlanIntegrity, peopleMap };
