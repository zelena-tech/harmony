'use strict';

const { defineTenant, DEFAULTS } = require('./tenant');
const { HarmonyError, TenantConfigError } = require('./errors');
const networks = require('./stellar/networks');
const components = require('./scoring/components');
const ranking = require('./scoring/ranking');
const inventory = require('./scoring/inventory');
const { computePeriod } = require('./period');
const plan = require('./payouts/plan');
const transactions = require('./payouts/transactions');
const organization = require('./soroban/organization');

/**
 * Binds the engine to one tenant. Everything returned here only ever sees
 * that tenant's configuration; create one instance per tenant.
 *
 * @param {object} tenantConfig  raw configuration (validated with defineTenant)
 *                               or an already defined tenant
 */
function createHarmony(tenantConfig) {
  const tenant = Object.isFrozen(tenantConfig) && tenantConfig.networkPassphrase ? tenantConfig : defineTenant(tenantConfig);
  return {
    tenant,
    computePeriod: (input) => computePeriod({ ...input, scoring: tenant.scoring }),
    scoreInventorySession: (zones) => inventory.scoreSession(zones, tenant.scoring.inventory),
    planCampaignPayout: (input) => plan.planCampaignPayout({ ...input, caps: tenant.payouts.caps, defaults: tenant.payouts.defaults }),
    planFreePayout: (input) => plan.planFreePayout({ ...input, caps: tenant.payouts.caps }),
    payerBalance: (wallet, horizon) => transactions.payerBalance({ tenant, wallet, horizon }),
    buildPayoutTransactions: (input) => transactions.buildPayoutTransactions({ ...input, tenant }),
    submitSignedTransactions: (input) => transactions.submitSignedTransactions({ ...input, tenant }),
    organization: (opts) => organization.createOrganizationClient({ ...opts, tenant }),
  };
}

module.exports = {
  createHarmony,
  defineTenant,
  DEFAULTS,
  HarmonyError,
  TenantConfigError,
  networks,
  scoring: { ...components, ...ranking, inventory },
  computePeriod,
  payouts: { ...plan, ...transactions },
  soroban: organization,
};
