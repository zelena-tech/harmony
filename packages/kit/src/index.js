'use strict';

const { defineTenant, HarmonyError } = require('@zelena/harmony-core');
const { defineProgram, isProgram, ProgramConfigError, PAYOUT_MODELS, POCKET_RULES } = require('./program');
const { score, levelFor } = require('./score');
const { plan, planIdOf, assertPlanIntegrity, sealOf, assertSealKey, hasSealKey } = require('./plan');
const { build } = require('./build');
const { submit, validateOperations, explorerUrl } = require('./submit');
const { listClaimable, buildClaim, submitClaim, predicateAllows } = require('./claims');
const { card, renderCardSvg } = require('./card');
const templates = require('./templates');
const money = require('./money');

/**
 * Binds one program to one tenant (organization).
 *
 *   const harmony = createProgram({ tenant: { id: 'acme', network: 'testnet' }, program: 'last-mile-delivery' });
 *   const { standings } = harmony.score({ events });
 *   const plan = harmony.plan({ standings, people });
 *   const built = await harmony.build({ plan, payer });      // unsigned XDR
 *   // ...the payer signs in its own wallet...
 *   const receipt = await harmony.submit({ built, signedXdrs });
 *
 * @param {object} input
 * @param {object} input.tenant            tenant configuration (see @zelena/harmony-core) or a defined tenant
 * @param {string|object} input.program    a template id, a program definition or a defined program
 * @param {object} [input.overrides]       fields that replace those of the template (payout, pockets, levels…).
 *        A SHALLOW merge: overriding `metrics` or `payout` replaces the whole key.
 * @param {string|Buffer} [input.sealKey]  >= 32 bytes. When given, every plan is sealed (HMAC of its id) and
 *        `build` refuses a plan without a valid seal. Use it when the plan leaves your server (a browser, a queue).
 *        Leave the property out to run unsealed; a property that is present but undefined, null or empty
 *        (`sealKey: process.env.MISSING`) throws INVALID_SEAL_KEY instead of silently turning sealing off.
 */
function createProgram(options) {
  const { tenant, program, overrides } = options;
  const sealKey = options.sealKey;
  const keyGiven = hasSealKey(options);
  if (keyGiven) assertSealKey(sealKey);
  const sealed = (input) => (keyGiven ? { ...input, sealKey } : input);
  const t = Object.isFrozen(tenant) && tenant && tenant.networkPassphrase ? tenant : defineTenant(tenant);
  let p;
  if (isProgram(program) && !overrides) p = program;
  else if (isProgram(program)) {
    // A defined program stores pockets in basis points and delays in seconds,
    // which defineProgram() does not accept back: edit the definition instead.
    throw new HarmonyError(400, 'overrides can be applied to a template id or a program definition, not to an already defined program.',
      { code: 'OVERRIDES_ON_DEFINED_PROGRAM' });
  } else {
    const base = typeof program === 'string' ? templates.template(program) : program;
    p = defineProgram({ ...base, ...(overrides || {}) });
  }
  return {
    tenant: t,
    program: p,
    score: (input) => score(p, input),
    plan: (input) => plan(p, t, sealed(input)),
    build: (input) => build(p, t, sealed(input)),
    submit: (input) => submit(t, input),
    listClaimable: (input) => listClaimable(t, input),
    buildClaim: (input) => buildClaim(t, input),
    submitClaim: (input) => submitClaim(t, input),
    card: (input) => card(p, t, input),
    renderCardSvg,
    explorerUrl: (hash) => explorerUrl(t.network, hash),
  };
}

module.exports = {
  createProgram,
  defineProgram,
  ProgramConfigError,
  PAYOUT_MODELS,
  POCKET_RULES,
  templates: templates.list,
  template: templates.template,
  score,
  levelFor,
  plan,
  planIdOf,
  assertPlanIntegrity,
  sealOf,
  build,
  submit,
  validateOperations,
  listClaimable,
  buildClaim,
  submitClaim,
  predicateAllows,
  card,
  renderCardSvg,
  explorerUrl,
  money,
};
