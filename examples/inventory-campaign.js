'use strict';

/**
 * End-to-end example, fully offline: an inventory counting campaign for one
 * tenant, from counted lines to the payout plan.
 *
 *   cd packages/core && npm ci && cd ../..
 *   node examples/inventory-campaign.js
 */

const { Keypair } = require('../packages/core/node_modules/@stellar/stellar-sdk');
const { createHarmony } = require('../packages/core/src');

const acme = createHarmony({
  id: 'acme-warehouse',
  network: 'testnet',
  scoring: { topNDefault: 3 },
  payouts: { caps: { perPerson: 100, perBatch: 500 } },
});

// 1. Cross-count result of one zone, as the host system produces it.
const counter = (workerId, total, extra = {}) => ({ workerId, total, ...extra });
const zoneA = [
  { locations: [
    { consensus: 'resolved', consensusValue: 120, counters: [counter('w1', 120), counter('w2', 120), counter('w3', 118)] },
    { consensus: 'resolved', consensusValue: 8, counters: [counter('w1', 8), counter('w4', 8)] },
    { consensus: 'resolved', consensusValue: 2400, counters: [counter('w2', 2400), counter('w4', 2400)] },
  ] },
  { locations: [
    { consensus: 'resolved', consensusValue: 35, counters: [counter('w3', 35), counter('w5', 35)] },
    { consensus: 'pending', consensusValue: null, counters: [counter('w1', 3), counter('w5', 4)] },
    { discarded: true, consensus: 'resolved', consensusValue: 0, counters: [counter('w5', 0), counter('w4', 60)] },
  ] },
];
const quality = acme.scoreInventorySession([zoneA]);

// 2. Points and shares of the period (100 USDC fund, top-3 qualify).
const period = acme.computePeriod({
  kind: 'inventory',
  activity: [...quality.keys()].map((workerId) => ({ workerId, counts: quality.get(workerId).lines })),
  quality,
  fundTotal: 100,
});
console.table(period.workers.map((w) => ({
  worker: w.workerId, lines: w.picking, precision: `${w.precisionScore}%`,
  points: w.pointsTotal, adjusted: w.adjustedPoints, qualified: w.qualified, share: w.assignedAmount,
})));

// 3. Direct-payment plan: 10 USDC base for everybody + 100 USDC pool for the top-3.
const ranking = [...period.workers]
  .sort((a, b) => b.adjustedPoints - a.adjustedPoints)
  .map((w) => ({ workerId: w.workerId, name: w.workerId, wallet: Keypair.random().publicKey(), adjustedPoints: w.adjustedPoints }));
const plan = acme.planCampaignPayout({ ranking, options: { base: 10, pool: 100, topN: 3 } });
console.table(plan.payments.map((p) => ({ worker: p.name, amount: p.amount, detail: p.detail })));
console.log(`total ${plan.total} USDC (caps: ${plan.caps.perPerson} per person, ${plan.caps.perBatch} per batch)`);
