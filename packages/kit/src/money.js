'use strict';

/**
 * Exact money arithmetic. Stellar amounts have 7 decimals (1 stroop); every
 * split in the kit is done with integer stroops (BigInt) and every amount that
 * leaves the kit is a string with exactly 7 decimals, ready to go on-chain.
 */

const STROOPS_PER_UNIT = 10000000n;

/** @param {number|string} amount non-negative, at most 7 decimals are kept */
function toStroops(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) throw new RangeError(`Invalid amount: ${amount}`);
  if (n > 900000000) throw new RangeError(`Amount too large to be exact: ${amount}`);
  return BigInt(Math.round(n * 1e7));
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

module.exports = { STROOPS_PER_UNIT, toStroops, fromStroops, splitByBasisPoints };
