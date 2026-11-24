'use strict';

const crypto = require('node:crypto');
const { HarmonyError, payouts } = require('@zelena/harmony-core');
const { toStroops, fromStroops, splitByBasisPoints, splitProportional } = require('./money');

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
 * Id of a plan: sha256 of what will be paid plus a random salt. It travels
 * on-chain as the transaction memo, which ties every payment to its plan.
 *
 * It covers the network too, so a plan cannot be relabelled from testnet to
 * mainnet without changing its id (and, with a `sealKey`, its seal).
 *
 * It is a CHECKSUM, not authentication: anybody who holds a plan can edit it
 * and recompute the id. The salt keeps the public memo from being guessable
 * from the (possibly personal) participant ids; keep the plan private. To
 * detect edits made outside your server use `sealKey` (see `sealOf`).
 */
function planIdOf(plan) {
  const canonical = JSON.stringify({
    salt: plan.salt,
    program: plan.programId,
    tenant: plan.tenantId,
    network: plan.network,
    asset: [plan.asset.code, plan.asset.issuer],
    createdAt: plan.createdAt,
    payments: plan.payments.map((p) => [
      p.participantId, p.wallet, p.amount,
      p.pockets.map((k) => [k.id, k.amount, k.rule.type, k.rule.at]),
    ]),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

const SALT_RX = /^[0-9a-f]{32}$/;

/** A seal key is a string or a Buffer of at least 32 bytes. Throws otherwise. */
function assertSealKey(sealKey) {
  const ok = (typeof sealKey === 'string' || Buffer.isBuffer(sealKey)) && Buffer.byteLength(sealKey) >= 32;
  if (!ok) throw new HarmonyError(400, 'sealKey must be a string or a Buffer of at least 32 bytes.', { code: 'INVALID_SEAL_KEY' });
}

/** True when the input has a `sealKey` property at all, even an undefined one (an unset environment variable). */
const hasSealKey = (input) => !!input && Object.prototype.hasOwnProperty.call(input, 'sealKey');

/** HMAC-SHA256(sealKey, planId), hex: proves the plan id was issued by whoever holds the key. */
function sealOf(planId, sealKey) {
  assertSealKey(sealKey);
  return crypto.createHmac('sha256', sealKey).update(String(planId)).digest('hex');
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
 * @param {object} [input.options]            { pool, base, topN, rate, budget, includeAlreadyPaid, allowSharedWallets }
 * @param {string} [input.salt]               32 hex chars; random by default (pass one only for reproducible tests)
 * @param {string|Buffer} [input.sealKey]     >= 32 bytes: the plan gets `seal`, which build() then requires.
 *        If the property is present it must be a valid key: undefined, null or empty throw INVALID_SEAL_KEY
 */
function plan(program, tenant, input) {
  const { standings, people, previous, walletChanges } = input || {};
  const opts = (input && input.options) || {};
  if (!Array.isArray(standings) || !standings.length) throw new HarmonyError(409, 'There are no standings: score the period first.');
  // A `sealKey` property that is present but empty (sealKey: process.env.MISSING) is an error, never "no seal".
  const sealed = hasSealKey(input);
  const sealKey = input.sealKey;
  if (sealed) assertSealKey(sealKey);
  const salt = input.salt === undefined ? crypto.randomBytes(16).toString('hex') : input.salt;
  if (typeof salt !== 'string' || !SALT_RX.test(salt)) throw new HarmonyError(400, 'salt must be 32 lowercase hex characters (16 bytes).');
  const now = input.now === undefined ? Math.floor(Date.now() / 1000) : input.now;
  if (!Number.isInteger(now) || now <= 0) throw new HarmonyError(400, 'now must be a unix time in seconds.');

  const byId = new Map();
  for (const s of standings) {
    const id = String(s && s.participantId);
    if (byId.has(id)) throw new HarmonyError(400, `The standings list "${id}" twice: a person must appear once.`, { code: 'DUPLICATE_PARTICIPANT' });
    byId.set(id, s);
  }
  const who = peopleMap(people);
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
  if (opts.allowSharedWallets !== true) {
    const owner = new Map();
    for (const r of ranking) {
      if (!r.wallet) continue;
      if (owner.has(r.wallet)) {
        throw new HarmonyError(409, `"${owner.get(r.wallet)}" and "${r.workerId}" have the same wallet: one person could be paid twice. `
          + 'Fix the wallets, or pass options.allowSharedWallets: true if sharing is intended.', { code: 'SHARED_WALLET' });
      }
      owner.set(r.wallet, r.workerId);
    }
  }
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

  // WHO is paid, withheld or excluded, the ranks, the alerts and the wallet checks come from the audited
  // planner of the engine. Its amounts are floating point, so the kit does not use them: the planner is
  // asked with a marker prize of 1 for everybody who shares the pool (so that it lists each of them as
  // paid or withheld, whatever the rounding would have given), and the amounts are computed below in
  // exact BigInt stroops. The caps are applied to those exact amounts.
  const core = payouts.planCampaignPayout({
    ranking,
    previous: stringKeyed(previous),
    walletChanges: stringKeyed(walletChanges),
    caps: {},
    defaults: tenant.payouts.defaults,
    options: { base: coreOptions.base, topN: coreOptions.topN, fixedPrize: 1, includeAlreadyPaid: coreOptions.includeAlreadyPaid },
  });

  // The people who share the pool are the top rows exactly as the planner defines them: everybody who
  // qualified (proportional, rate) or the first topN of them. Those without a wallet keep their share
  // withheld and those already paid are not paid again; nobody else gets it.
  const sharers = Math.min(parseInt(coreOptions.topN, 10), ranking.length);
  const poolStroops = toStroops(coreOptions.pool);
  for (const r of ranking.slice(0, sharers)) {
    if (!Number.isSafeInteger(r.adjustedPoints)) throw new HarmonyError(400, `The adjusted points of "${r.workerId}" are not an integer: score the period first.`, { code: 'INVALID_POINTS' });
  }
  // No POOL_TOO_SMALL: the split is exact whatever the pool. If the pool has fewer stroops than there are
  // people, some of them simply get nothing and are not paid; the shares still add up to the pool.
  const shares = splitProportional(poolStroops, ranking.slice(0, sharers).map((r) => BigInt(r.adjustedPoints)));
  const baseStroops = model === 'topN' ? toStroops(coreOptions.base) : 0n;

  const bps = program.pockets.map((k) => k.shareBp);
  const payments = [];
  for (const p of core.payments) {
    const index = p.rank - 1;
    const share = index < sharers ? shares[index] : 0n;
    const total = baseStroops + share;
    if (total <= 0n) continue; // a share that rounds to nothing is not paid
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
    payments.push({
      participantId: String(p.workerId),
      name: p.name,
      wallet: p.wallet,
      walletShort: short(p.wallet),
      amount: fromStroops(total),
      rank: p.rank,
      points: standing ? standing.adjustedPoints : null,
      level: standing ? { id: standing.level.id, name: standing.level.name, multiplier: standing.level.multiplier } : null,
      detail: share > 0n
        ? `${baseStroops > 0n ? `base ${coreOptions.base} + ` : ''}prize ${Number(fromStroops(share)).toFixed(2)} (rank ${p.rank})`
        : `base ${coreOptions.base}`,
      alert: p.alert,
      alreadyPaidBonus: p.alreadyPaidBonus,
      pockets,
    });
  }
  // Defense in depth: the tenant caps, applied to the exact amounts.
  const caps = tenant.payouts.caps || {};
  payouts.applyCaps(payments.map((p) => ({ name: p.name, wallet: p.wallet, amount: Number(p.amount) })), caps);
  const withheld = core.withheld
    .map((x) => ({ name: x.name, rank: x.rank, amount: shares[x.rank - 1] || 0n }))
    .filter((x) => x.amount > 0n)
    .map((x) => ({ ...x, amount: fromStroops(x.amount) }));

  const result = {
    programId: program.id,
    tenantId: tenant.id,
    network: tenant.network,
    asset: { code: tenant.rewardAsset.code, issuer: tenant.rewardAsset.issuer },
    createdAt: now,
    salt,
    rule,
    payments,
    total: fromStroops(payments.reduce((s, p) => s + toStroops(p.amount), 0n)),
    byPocket: program.pockets.map((k) => ({
      id: k.id,
      label: k.label,
      rule: k.rule.type,
      amount: fromStroops(payments.reduce((s, p) => s + toStroops((p.pockets.find((x) => x.id === k.id) || { amount: 0 }).amount), 0n)),
    })),
    withheld,
    withoutWallet: core.withoutWallet,
    excludedAlreadyPaid: core.excludedAlreadyPaid,
    flagged: payments.filter((p) => p.alert).length,
    caps: { perPerson: caps.perPerson ?? null, perBatch: caps.perBatch ?? null },
  };
  result.planId = planIdOf(result);
  if (sealed) result.seal = sealOf(result.planId, sealKey);
  return result;
}

/**
 * Consistency check of a plan: same id, pockets that add up to each payment,
 * payments that add up to the total. Throws HarmonyError(400) otherwise.
 *
 * This is NOT authentication: the id is an unkeyed checksum, so whoever edits
 * a plan can recompute it. It catches accidents. `build` re-derives the
 * pockets from the program and, with a `sealKey`, requires the seal.
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

module.exports = { plan, planIdOf, assertPlanIntegrity, peopleMap, sealOf, assertSealKey, hasSealKey };
