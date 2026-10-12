'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('@stellar/stellar-sdk');
const { defineTenant, createHarmony, TenantConfigError, networks } = require('../src');

test('fills defaults per network', () => {
  const t = defineTenant({ id: 'acme', network: 'testnet' });
  assert.equal(t.networkPassphrase, sdk.Networks.TESTNET);
  assert.equal(t.rewardAsset.issuer, networks.NETWORKS.testnet.usdcIssuer);
  assert.equal(t.rpcUrl, 'https://soroban-testnet.stellar.org');
  assert.equal(t.scoring.pointsPerPicking, 10);
  assert.deepEqual(t.payouts.defaults, { base: 15, pool: 150, topN: 5 });
  const m = defineTenant({ id: 'acme', network: 'mainnet' });
  assert.equal(m.rewardAsset.issuer, networks.NETWORKS.mainnet.usdcIssuer);
  assert.equal(m.rpcUrl, null);
});

test('reports every invalid field at once', () => {
  try {
    defineTenant({
      id: 'Bad Id', network: 'futurenet',
      contracts: { organization: 'not-a-contract' },
      scoring: { weights: { performance: 2 }, topNDefault: 0 },
      payouts: { payerWallet: 'nope', caps: { perPerson: -1 } },
    });
    assert.fail('should throw');
  } catch (e) {
    assert.ok(e instanceof TenantConfigError);
    assert.ok(e.problems.length >= 6, e.problems.join('\n'));
  }
});

test('a tenant is deeply immutable', () => {
  const t = defineTenant({ id: 'acme', network: 'testnet' });
  assert.throws(() => { t.scoring.weights.performance = 1; }, TypeError);
  assert.throws(() => { t.payouts.caps.perPerson = 1; }, TypeError);
  assert.throws(() => { t.network = 'mainnet'; }, TypeError);
});

test('tenants are isolated: same activity, different configuration, different results', () => {
  const a = createHarmony({ id: 'tenant-a', network: 'testnet' });
  const b = createHarmony({ id: 'tenant-b', network: 'testnet', scoring: { pointsPerPicking: 1, velocityWeight: 1, precisionWeight: 0 } });
  const activity = [
    { workerId: 1, picking: 10, completed: 10, started: 10, activeSeconds: 3600 },
    // as fast as worker 1 (10/h) but only half of what was started got completed
    { workerId: 2, picking: 10, completed: 5, started: 10, activeSeconds: 1800 },
  ];
  const ra = a.computePeriod({ kind: 'orders', activity, fundTotal: 100 });
  const rb = b.computePeriod({ kind: 'orders', activity, fundTotal: 100 });
  assert.equal(ra.workers[0].pointsTotal, 100);
  assert.equal(rb.workers[0].pointsTotal, 10);
  assert.equal(ra.workers[1].finalScore, 75);  // velocity 100 × 0.5 + precision 50 × 0.5
  assert.equal(rb.workers[1].finalScore, 100); // velocity only
  // Defining b did not change a.
  assert.equal(a.tenant.scoring.pointsPerPicking, 10);
});

test('createHarmony accepts an already defined tenant', () => {
  const t = defineTenant({ id: 'acme', network: 'testnet' });
  assert.equal(createHarmony(t).tenant, t);
});
