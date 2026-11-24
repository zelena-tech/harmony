'use strict';

const { HarmonyError } = require('@zelena/harmony-core');

/**
 * Exact money arithmetic. Stellar amounts have 7 decimals (1 stroop); every
 * split in the kit is done with integer stroops (BigInt) and every amount that
 * leaves the kit is a string with exactly 7 decimals, ready to go on-chain.
 */

const STROOPS_PER_UNIT = 10000000n;
/** Largest amount a Stellar balance or operation can hold (int64), in stroops. */
const MAX_STROOPS = 9223372036854775807n;

/**
 * Exact conversion, with no floating-point multiplication. Numbers go through
 * `toFixed(7)` (the 7th decimal is rounded, as the core planner does); strings
 * must be plain decimals with at most 7 decimals. Negatives, NaN, exponent
 * notation, more than 7 decimals in a string and anything above the int64
 * maximum are refused with HarmonyError(400).
 *
 * @param {number|string} amount
 * @returns {bigint}
 */
function toStroops(amount) {
  const bad = () => new HarmonyError(400, `Invalid amount: ${typeof amount === 'string' ? JSON.stringify(amount) : String(amount)}`, { code: 'INVALID_AMOUNT' });
  let s;
  if (typeof amount === 'number') {
    if (!Number.isFinite(amount) || amount < 0) throw bad();
    s = amount.toFixed(7); // from 1e21 on toFixed gives exponent notation, which the pattern below refuses
  } else if (typeof amount === 'string') s = amount;
  else throw bad();
  if (!/^\d+(\.\d{1,7})?$/.test(s)) throw bad();
  const [whole, frac = ''] = s.split('.');
  const stroops = BigInt(whole) * STROOPS_PER_UNIT + BigInt(frac.padEnd(7, '0'));
  if (stroops > MAX_STROOPS) throw new HarmonyError(400, `Amount too large: ${s}`, { code: 'INVALID_AMOUNT' });
  return stroops;
}

/** @param {bigint} stroops @returns {string} e.g. "12.5000000" */
function fromStroops(stroops) {
  const b = BigInt(stroops);
  if (b < 0n) throw new RangeError('Negative amount');
  return `${b / STROOPS_PER_UNIT}.${(b % STROOPS_PER_UNIT).toString().padStart(7, '0')}`;
}

/**
 * Splits `total` stroops by basis points (the bps must add up to 10 000).
 * Each part is rounded down and the remainder goes to the first part, so the
 * parts always add up to exactly `total`.
 *
 * @param {bigint} total
 * @param {number[]} bps
 * @returns {bigint[]}
 */
function splitByBasisPoints(total, bps) {
  const parts = bps.map((bp) => (total * BigInt(bp)) / 10000n);
  const rest = total - parts.reduce((s, v) => s + v, 0n);
  if (parts.length) parts[0] += rest;
  return parts;
}

/**
 * Splits `total` stroops between people in proportion to their `weights`
 * (positive integers, as BigInt), exactly: each share is
 * `floor(total x weight / sum)`, and the stroops left over are handed out one
 * by one by largest remainder (`total x weight mod sum`), ties going to the
 * earlier position. The shares always add up to exactly `total`, and no share
 * differs from the real-number share by a whole stroop or more.
 *
 * @param {bigint} total
 * @param {bigint[]} weights in rank order (earlier = better)
 * @returns {bigint[]}
 */
function splitProportional(total, weights) {
  if (!weights.length) return [];
  const sum = weights.reduce((s, w) => s + w, 0n);
  if (sum <= 0n) throw new RangeError('The weights must add up to more than zero');
  const parts = weights.map((w) => (total * w) / sum);
  let left = total - parts.reduce((s, v) => s + v, 0n);
  if (left > 0n) {
    const order = weights.map((w, i) => ({ i, rem: (total * w) % sum }))
      .sort((a, b) => (a.rem === b.rem ? a.i - b.i : (a.rem > b.rem ? -1 : 1)));
    for (let k = 0; left > 0n; k += 1, left -= 1n) parts[order[k].i] += 1n;
  }
  return parts;
}

module.exports = { STROOPS_PER_UNIT, MAX_STROOPS, toStroops, fromStroops, splitByBasisPoints, splitProportional };
