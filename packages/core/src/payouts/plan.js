'use strict';

const { HarmonyError } = require('../errors');
const { isAccountId, toStroopPrecision: a7 } = require('../stellar/networks');

/**
 * Payout planning for the DIRECT PAYMENT rail (classic Stellar payments signed
 * by the organization's payer wallet). Pure functions: no database, no network.
 *
 * Campaign bonus rule: a base amount for every participant with a wallet, plus
 * a pool shared among the top-N, proportional to adjustedPoints (or a fixed
 * prize per top-N position). The ranking is computed over ALL participants:
 * having a wallet does not move anybody up or down. If someone in the top-N has
 * no wallet, their share is WITHHELD and reported; it is never redistributed.
 *
 * Every amount is rounded to 1 stroop (7 decimals) and the rounding residue is
 * assigned to the first position, so the plan never pays more than the pool.
 */

const short = (w) => `${w.slice(0, 4)}…${w.slice(-6)}`;

/**
 * Caps are a guard against typing mistakes. They are applied when planning AND
 * when building the transactions (defense in depth). A missing cap is not applied.
 *
 * @param {Array<{name?: string, amount: number}>} payments
 * @param {{perPerson?: number|null, perBatch?: number|null}} [caps]
 * @returns {number} total of the payments
 */
function applyCaps(payments, caps) {
  const perPerson = caps && caps.perPerson != null ? Number(caps.perPerson) : null;
  const perBatch = caps && caps.perBatch != null ? Number(caps.perBatch) : null;
  const total = a7(payments.reduce((s, p) => s + Number(p.amount), 0));
  if (Number.isFinite(perPerson) && perPerson > 0) {
    const over = payments.filter((p) => Number(p.amount) > perPerson);
    if (over.length) {
      throw new HarmonyError(409, `Per-person cap exceeded (${perPerson}): `
        + over.map((p) => `${p.name || p.wallet} ${Number(p.amount).toFixed(2)}`).join(', '), { cap: 'person' });
    }
  }
  if (Number.isFinite(perBatch) && perBatch > 0 && total > perBatch) {
    throw new HarmonyError(409, `Batch cap exceeded: the plan adds up to ${total} and the cap is ${perBatch}`,
      { cap: 'batch', total });
  }
  return total;
}

/**
 * Summarizes previous payments of a campaign per worker.
 * @param {Array<{workerId: any, wallet: string, kind: 'bonus'|'test', amount: number|string}>} rows
 * @returns {Map<any, {bonus: number, test: number, wallets: Set<string>}>}
 */
function summarizePrevious(rows) {
  const out = new Map();
  for (const r of rows || []) {
    const u = out.get(r.workerId) || { bonus: 0, test: 0, wallets: new Set() };
    u[r.kind === 'test' ? 'test' : 'bonus'] += Number(r.amount);
    u.wallets.add(r.wallet);
    out.set(r.workerId, u);
  }
  return out;
}

/**
 * Plan of a campaign bonus.
 *
 * @param {object} input
 * @param {Array<{workerId: any, name: string, wallet: string|null, adjustedPoints: number|string}>} input.ranking
 *        every participant, sorted by adjustedPoints DESC (ties: stable host order)
 * @param {Map}    [input.previous]       summarizePrevious() of this campaign
 * @param {Map}    [input.walletChanges]  workerId → {hours} for wallets changed recently (e.g. 72 h)
 * @param {object} [input.caps]           tenant.payouts.caps
 * @param {object} [input.defaults]       tenant.payouts.defaults {base, pool, topN}
 * @param {object} [input.options]
 * @param {number} [input.options.testAmount]   proportional TEST payment instead of the bonus
 * @param {number} [input.options.base]
 * @param {number} [input.options.pool]
 * @param {number} [input.options.topN]
 * @param {number} [input.options.fixedPrize]   fixed amount per top-N position instead of the pool
 * @param {boolean} [input.options.includeAlreadyPaid] re-include whoever already got the bonus
 */
function planCampaignPayout(input) {
  const opts = input.options || {};
  const def = { base: 15, pool: 150, topN: 5, ...(input.defaults || {}) };
  const previous = input.previous || new Map();
  const changes = input.walletChanges || new Map();

  const num = (v) => (v != null && v !== '' ? Number(v) : null);
  const testAmount = num(opts.testAmount);
  const base = num(opts.base) ?? Number(def.base);
  const pool = num(opts.pool) ?? Number(def.pool);
  const top = opts.topN != null ? parseInt(opts.topN, 10) : parseInt(def.topN, 10);
  const fixedPrize = num(opts.fixedPrize);
  const includeAlreadyPaid = opts.includeAlreadyPaid === true || opts.includeAlreadyPaid === 'true';

  for (const [k, v] of Object.entries({ testAmount, base, pool, fixedPrize })) {
    if (v != null && (!Number.isFinite(v) || v < 0)) throw new HarmonyError(400, `${k} must be a number >= 0`);
  }
  if (!Number.isInteger(top) || top < 0) throw new HarmonyError(400, 'topN must be an integer >= 0');

  const rows = input.ranking || [];
  if (!rows.length) throw new HarmonyError(409, 'The campaign has no computed points: compute the period first.');

  const withWallet = rows.filter((r) => isAccountId(r.wallet));
  const withoutWallet = rows.filter((r) => !isAccountId(r.wallet)).map((r) => r.name);
  const payments = [];
  const withheld = [];
  const excludedAlreadyPaid = [];

  // Anti double payment: whoever already got the bonus of this campaign is left
  // out unless explicitly re-included. Test payments can be repeated.
  const alreadyGotBonus = (r) => (previous.get(r.workerId)?.bonus || 0) > 0;
  const decorate = (r, p) => {
    const prev = previous.get(r.workerId);
    const change = changes.get(r.workerId);
    const alerts = [];
    if (change) alerts.push(`wallet changed ${Math.max(1, Math.round(Number(change.hours)))} h ago`);
    if (prev && prev.wallets.size && !prev.wallets.has(r.wallet)) alerts.push('wallet differs from the last payment');
    return {
      ...p,
      walletShort: short(r.wallet),
      alreadyPaidBonus: a7(prev?.bonus || 0),
      alreadyPaidTest: a7(prev?.test || 0),
      alert: alerts.length ? alerts.join(' · ') : null,
    };
  };

  if (testAmount != null) {
    const totalPoints = withWallet.reduce((s, r) => s + Number(r.adjustedPoints), 0);
    if (totalPoints <= 0) throw new HarmonyError(409, 'Nobody with a wallet has points: there is nobody to pay.');
    const parts = withWallet.map((r) => a7(testAmount * Number(r.adjustedPoints) / totalPoints));
    const residue = a7(testAmount - parts.reduce((s, v) => s + v, 0));
    if (residue !== 0 && parts.length) parts[0] = a7(parts[0] + residue);
    withWallet.forEach((r, i) => {
      if (parts[i] > 0) {
        payments.push(decorate(r, { workerId: r.workerId, name: r.name, wallet: r.wallet, amount: parts[i],
          rank: rows.indexOf(r) + 1, detail: 'test (proportional)' }));
      }
    });
  } else {
    // With a fixed prize only people with points enter the top (an inventory
    // campaign leaves at 0 whoever is below the minimum precision).
    const topRows = fixedPrize != null
      ? rows.filter((r) => Number(r.adjustedPoints) > 0).slice(0, top)
      : rows.slice(0, top);
    const sumTop = topRows.reduce((s, r) => s + Number(r.adjustedPoints), 0);
    const prizes = new Map();
    for (const r of topRows) {
      prizes.set(r, fixedPrize != null ? a7(fixedPrize) : (sumTop > 0 ? a7(pool * Number(r.adjustedPoints) / sumTop) : 0));
    }
    // Signed residue: the rounded parts can be a few stroops above OR below the
    // pool. It goes to the first position so the total is exactly the pool.
    const residue = a7(pool - [...prizes.values()].reduce((s, v) => s + v, 0));
    if (fixedPrize == null && residue !== 0 && topRows.length && sumTop > 0) {
      prizes.set(topRows[0], a7(prizes.get(topRows[0]) + residue));
    }
    for (const r of rows) {
      const inTop = topRows.includes(r) && sumTop > 0;
      const prize = inTop ? prizes.get(r) : 0;
      const rank = rows.indexOf(r) + 1;
      if (!isAccountId(r.wallet)) {
        if (prize > 0) withheld.push({ name: r.name, rank, amount: prize });
        continue;
      }
      if (alreadyGotBonus(r) && !includeAlreadyPaid) {
        excludedAlreadyPaid.push({ name: r.name, rank, alreadyPaid: a7(previous.get(r.workerId).bonus) });
        continue;
      }
      const amount = a7(base + prize);
      if (amount > 0) {
        const detail = inTop
          ? `${base > 0 ? `base ${base} + ` : ''}prize ${prize.toFixed(2)} (rank ${rank})`
          : `base ${base}`;
        payments.push(decorate(r, { workerId: r.workerId, name: r.name, wallet: r.wallet, amount, rank, detail }));
      }
    }
  }

  const caps = input.caps || {};
  const total = payments.length ? applyCaps(payments, caps) : 0;
  return {
    payments,
    withoutWallet,
    withheld,
    excludedAlreadyPaid,
    total,
    flagged: payments.filter((p) => p.alert).length,
    caps: { perPerson: caps.perPerson ?? null, perBatch: caps.perBatch ?? null },
    rule: testAmount != null
      ? { testAmount }
      : { base, pool: fixedPrize != null ? null : pool, fixedPrize, topN: top, includeAlreadyPaid },
  };
}

/**
 * Free payment (outside a campaign): the payer picks people and an amount,
 * either a total split evenly or a fixed amount per person. The even split is
 * exact to the stroop: the remainder goes to the first recipients.
 *
 * @param {object} input
 * @param {Array<{workerId: any, name: string, wallet: string|null}>} input.recipients active people chosen
 * @param {number} [input.totalAmount]
 * @param {number} [input.perPersonAmount]
 * @param {object} [input.caps]
 * @param {Map}    [input.walletChanges]
 */
function planFreePayout(input) {
  const recipients = input.recipients || [];
  if (!recipients.length) throw new HarmonyError(400, 'Choose at least one person.');
  const total = input.totalAmount != null && input.totalAmount !== '' ? Number(input.totalAmount) : null;
  const perPerson = input.perPersonAmount != null && input.perPersonAmount !== '' ? Number(input.perPersonAmount) : null;
  if (total == null && perPerson == null) throw new HarmonyError(400, 'Give the total amount or the amount per person.');
  if (total != null && (!Number.isFinite(total) || total <= 0)) throw new HarmonyError(400, 'The total amount must be greater than zero.');
  if (perPerson != null && (!Number.isFinite(perPerson) || perPerson <= 0)) throw new HarmonyError(400, 'The amount per person must be greater than zero.');

  const withWallet = recipients.filter((r) => isAccountId(r.wallet));
  const withoutWallet = recipients.filter((r) => !isAccountId(r.wallet)).map((r) => r.name);
  if (!withWallet.length) throw new HarmonyError(409, 'None of the chosen people has a wallet.', { withoutWallet });

  let amounts;
  if (perPerson != null) {
    amounts = withWallet.map(() => a7(perPerson));
  } else {
    const stroops = Math.round(total * 1e7);
    const each = Math.floor(stroops / withWallet.length);
    let rest = stroops - each * withWallet.length;
    amounts = withWallet.map(() => { const m = each + (rest > 0 ? 1 : 0); if (rest > 0) rest--; return a7(m / 1e7); });
  }
  const changes = input.walletChanges || new Map();
  const payments = withWallet.map((r, i) => {
    const change = changes.get(r.workerId);
    return {
      workerId: r.workerId, name: r.name, wallet: r.wallet, amount: amounts[i],
      walletShort: short(r.wallet),
      detail: perPerson != null ? 'amount per person' : 'even split',
      alert: change ? `wallet changed ${Math.max(1, Math.round(Number(change.hours)))} h ago` : null,
    };
  }).filter((p) => p.amount > 0);

  const caps = input.caps || {};
  return {
    payments,
    withoutWallet,
    total: applyCaps(payments, caps),
    flagged: payments.filter((p) => p.alert).length,
    caps: { perPerson: caps.perPerson ?? null, perBatch: caps.perBatch ?? null },
    rule: perPerson != null ? { perPersonAmount: perPerson } : { totalAmount: total, split: 'even' },
  };
}

/** Compares the plan total with the payer balance: enough / missing. Pure. */
function withBalance(plan, balance) {
  if (!balance) return { ...plan, payerBalance: null };
  const missing = a7(Math.max(0, Number(plan.total) - balance.amount));
  return { ...plan, payerBalance: balance, enough: missing <= 0 && balance.trustline !== false, missing };
}

module.exports = { applyCaps, summarizePrevious, planCampaignPayout, planFreePayout, withBalance };
