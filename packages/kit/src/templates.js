'use strict';

const { HarmonyError } = require('@zelena/harmony-core');

/**
 * Ready-made programs, one per industry. Each file in `templates/` holds
 * `{ meta, program }`: `program` is a definition for defineProgram() and
 * `meta` explains who pays, which signals feed it and what to build with it.
 *
 * To add an industry, add one JSON file and one line here. The requires are
 * explicit (no directory scan) so bundlers can include them.
 */
const FILES = [
  require('../templates/warehouse-fulfillment.json'),
  require('../templates/last-mile-delivery.json'),
  require('../templates/retail-sales.json'),
  require('../templates/customer-support.json'),
  require('../templates/construction-crew.json'),
  require('../templates/healthcare-shifts.json'),
  require('../templates/learn-to-earn.json'),
  require('../templates/tip-pool.json'),
  require('../templates/open-source-bounties.json'),
  require('../templates/harvest-piece-rate.json'),
  require('../templates/software-delivery.json'),
];
const BY_ID = new Map(FILES.map((f) => [f.program.id, f]));

/** Summary of every template. */
function list() {
  return FILES.map((f) => ({
    id: f.program.id,
    name: f.program.name,
    industry: f.program.industry,
    payout: f.program.payout.model,
    metrics: f.program.metrics.map((m) => m.id),
    levels: (f.program.levels || [{ name: 'Member' }]).map((l) => l.name),
    pockets: (f.program.pockets || [{ label: 'Available now' }]).map((k) => k.label),
    ...f.meta,
  }));
}

/** A fresh copy of the program definition of a template, ready to edit and pass to defineProgram(). */
function template(id) {
  const f = BY_ID.get(id);
  if (!f) throw new HarmonyError(400, `Unknown template "${id}". Available: ${[...BY_ID.keys()].join(', ')}.`, { code: 'UNKNOWN_TEMPLATE' });
  return JSON.parse(JSON.stringify(f.program));
}

module.exports = { list, template };
