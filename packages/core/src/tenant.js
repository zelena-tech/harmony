'use strict';

const { network, isAccountId, isContractId } = require('./stellar/networks');
const { TenantConfigError } = require('./errors');

/**
 * Multi-tenant model
 * ------------------
 * A tenant is one organization (one company, one warehouse operator). Each
 * tenant has:
 *  - its own Organization contract on Soroban (registered in the shared Factory),
 *  - its own reward asset, payer wallet and payout caps,
 *  - its own scoring weights.
 *
 * The engine never reads global state or environment variables: every function
 * receives the tenant explicitly. Two tenants in the same process cannot see
 * or change each other's configuration (tenant objects are deeply frozen).
 */

const DEFAULTS = Object.freeze({
  scoring: {
    pointsPerPicking: 10,
    pointsPerPacking: 10,
    velocityWeight: 0.5,
    precisionWeight: 0.5,
    weights: { performance: 0.5, attendance: 0.2, evaluation: 0.3 },
    topNDefault: null,
    tokenRate: 0.5,
    fiatPerToken: null,
    inventory: { minPrecision: 0.9, penalty: 2 },
  },
  payouts: {
    payerWallet: null,
    caps: { perPerson: null, perBatch: null },
    defaults: { base: 15, pool: 150, topN: 5 },
  },
});

const isWeight = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const isPositiveOrNull = (v) => v === null || (typeof v === 'number' && Number.isFinite(v) && v > 0);
const isNonNegative = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  return Object.freeze(o);
}

/**
 * Validates a tenant configuration, fills defaults and returns an immutable copy.
 * Throws TenantConfigError listing every problem found.
 *
 * @param {object} input
 * @param {string} input.id                 slug, e.g. 'acme-warehouse'
 * @param {'testnet'|'mainnet'} input.network
 * @param {string} [input.rpcUrl]           Soroban RPC (required on mainnet to use contracts)
 * @param {string} [input.horizonUrl]
 * @param {{code?: string, issuer?: string}} [input.rewardAsset]  default USDC of the network
 * @param {{factory?: string, organization?: string}} [input.contracts]
 * @param {object} [input.scoring]          see DEFAULTS.scoring
 * @param {object} [input.payouts]          see DEFAULTS.payouts
 */
function defineTenant(input) {
  const problems = [];
  const t = input || {};

  if (typeof t.id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(t.id)) {
    problems.push('id must be a lowercase slug (a-z, 0-9, -), 2-63 chars');
  }

  let net = null;
  try { net = network(t.network); } catch { problems.push('network must be "testnet" or "mainnet"'); }

  const rewardAsset = {
    code: (t.rewardAsset && t.rewardAsset.code) || 'USDC',
    issuer: (t.rewardAsset && t.rewardAsset.issuer) || (net ? net.usdcIssuer : null),
  };
  if (!/^[A-Za-z0-9]{1,12}$/.test(rewardAsset.code)) problems.push('rewardAsset.code must be 1-12 alphanumeric chars');
  if (!isAccountId(rewardAsset.issuer)) problems.push('rewardAsset.issuer must be a Stellar account (G...)');

  const contracts = { factory: null, organization: null, ...(t.contracts || {}) };
  for (const k of ['factory', 'organization']) {
    if (contracts[k] !== null && !isContractId(contracts[k])) problems.push(`contracts.${k} must be a contract id (C...)`);
  }

  const s = t.scoring || {};
  const scoring = {
    ...DEFAULTS.scoring,
    ...s,
    weights: { ...DEFAULTS.scoring.weights, ...(s.weights || {}) },
    inventory: { ...DEFAULTS.scoring.inventory, ...(s.inventory || {}) },
  };
  for (const k of ['pointsPerPicking', 'pointsPerPacking']) {
    if (!isNonNegative(scoring[k])) problems.push(`scoring.${k} must be a number >= 0`);
  }
  for (const k of ['velocityWeight', 'precisionWeight']) {
    if (!isWeight(scoring[k])) problems.push(`scoring.${k} must be between 0 and 1`);
  }
  for (const [k, v] of Object.entries(scoring.weights)) {
    if (!isWeight(v)) problems.push(`scoring.weights.${k} must be between 0 and 1`);
  }
  if (scoring.topNDefault !== null && !(Number.isInteger(scoring.topNDefault) && scoring.topNDefault > 0)) {
    problems.push('scoring.topNDefault must be a positive integer or null');
  }
  if (!isNonNegative(scoring.tokenRate)) problems.push('scoring.tokenRate must be a number >= 0');
  if (scoring.fiatPerToken !== null && !isNonNegative(scoring.fiatPerToken)) problems.push('scoring.fiatPerToken must be a number >= 0 or null');
  if (!isWeight(scoring.inventory.minPrecision)) problems.push('scoring.inventory.minPrecision must be between 0 and 1');
  if (!isNonNegative(scoring.inventory.penalty)) problems.push('scoring.inventory.penalty must be a number >= 0');

  const p = t.payouts || {};
  const payouts = {
    ...DEFAULTS.payouts,
    ...p,
    caps: { ...DEFAULTS.payouts.caps, ...(p.caps || {}) },
    defaults: { ...DEFAULTS.payouts.defaults, ...(p.defaults || {}) },
  };
  if (payouts.payerWallet !== null && !isAccountId(payouts.payerWallet)) problems.push('payouts.payerWallet must be a Stellar account (G...) or null');
  for (const k of ['perPerson', 'perBatch']) {
    if (!isPositiveOrNull(payouts.caps[k])) problems.push(`payouts.caps.${k} must be a positive number or null`);
  }
  if (!isNonNegative(payouts.defaults.base)) problems.push('payouts.defaults.base must be a number >= 0');
  if (!isNonNegative(payouts.defaults.pool)) problems.push('payouts.defaults.pool must be a number >= 0');
  if (!(Number.isInteger(payouts.defaults.topN) && payouts.defaults.topN >= 0)) problems.push('payouts.defaults.topN must be an integer >= 0');

  if (problems.length) throw new TenantConfigError(problems);

  return deepFreeze({
    id: t.id,
    network: net.name,
    networkPassphrase: net.passphrase,
    horizonUrl: t.horizonUrl || net.horizonUrl,
    rpcUrl: t.rpcUrl || net.rpcUrl,
    rewardAsset,
    contracts,
    scoring,
    payouts,
  });
}

module.exports = { defineTenant, DEFAULTS };
