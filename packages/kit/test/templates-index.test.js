'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  kit, NOW, DAY, keypair, wallet, account, fakeHorizon, signXdr, parse, tenant,
} = require('./_helpers');
const { toStroops } = require('../src/money');
const { ProgramConfigError } = require('../src/program');

const IDS = [
  'warehouse-fulfillment', 'last-mile-delivery', 'retail-sales', 'customer-support', 'construction-crew', 'healthcare-shifts',
  'learn-to-earn', 'tip-pool', 'open-source-bounties', 'harvest-piece-rate', 'software-delivery',
];

test('the catalogue lists the eleven templates with their story', () => {
  const list = kit.templates();
  assert.deepEqual(list.map((t) => t.id).sort(), [...IDS].sort());
  assert.equal(new Set(list.map((t) => t.id)).size, list.length);
  for (const t of list) {
    assert.ok(t.name && t.industry, `${t.id}: name and industry`);
    assert.ok(['proportional', 'topN', 'rate'].includes(t.payout), `${t.id}: payout`);
    assert.ok(t.metrics.length >= 1 && t.levels.length >= 1 && t.pockets.length >= 1, `${t.id}: lists`);
    for (const k of ['pitch', 'whoPays', 'signals', 'idea']) assert.ok(typeof t[k] === 'string' && t[k].length > 10, `${t.id}: meta.${k}`);
  }
});

test('every template is a valid program', () => {
  for (const id of IDS) {
    const program = kit.defineProgram(kit.template(id));
    assert.equal(program.id, id);
    assert.ok(Object.isFrozen(program));
    assert.ok(program.metrics.some((m) => m.points > 0));
    assert.equal(program.pockets.reduce((s, k) => s + k.shareBp, 0), 10000);
  }
});

test('templates hold no wallet, key or person: only rules', () => {
  for (const id of IDS) {
    const text = JSON.stringify(kit.template(id));
    assert.doesNotMatch(text, /\bG[A-Z2-7]{55}\b/, `${id}: account id`);
    assert.doesNotMatch(text, /\bS[A-Z2-7]{55}\b/, `${id}: secret key`);
    assert.doesNotMatch(text, /@[a-z0-9-]+\.[a-z]{2,}/i, `${id}: email`);
  }
});

test('template() returns a fresh copy each time and rejects unknown ids', () => {
  const a = kit.template('tip-pool');
  a.metrics[0].points = 12345;
  a.name = 'Changed';
  const b = kit.template('tip-pool');
  assert.notEqual(b.metrics[0].points, 12345);
  assert.notEqual(b.name, 'Changed');
  assert.throws(() => kit.template('nope'), (e) => e.statusCode === 400 && e.code === 'UNKNOWN_TEMPLATE' && /tip-pool/.test(e.message));
});

test('createProgram works for every template id', () => {
  for (const id of IDS) {
    const harmony = kit.createProgram({ tenant: { id: 'acme-kit', network: 'testnet' }, program: id });
    assert.equal(harmony.program.id, id);
    assert.equal(harmony.tenant.id, 'acme-kit');
    for (const fn of ['score', 'plan', 'build', 'submit', 'listClaimable', 'buildClaim', 'submitClaim', 'card', 'renderCardSvg', 'explorerUrl']) {
      assert.equal(typeof harmony[fn], 'function', `${id}.${fn}`);
    }
  }
});

test('createProgram accepts a defined tenant, a definition and a defined program', () => {
  const t = tenant();
  const def = kit.template('tip-pool');
  const fromDef = kit.createProgram({ tenant: t, program: def });
  assert.equal(fromDef.tenant, t, 'a defined tenant is used as it is');
  const defined = kit.defineProgram(def);
  assert.equal(kit.createProgram({ tenant: t, program: defined }).program, defined);
});

test('overrides replace fields of the template', () => {
  const harmony = kit.createProgram({
    tenant: { id: 'acme-kit', network: 'testnet' },
    program: 'warehouse-fulfillment',
    overrides: {
      payout: { model: 'proportional', pool: 42 },
      pockets: [{ id: 'all', label: 'All of it', share: 1, rule: { type: 'instant' } }],
      name: 'My own name',
    },
  });
  assert.equal(harmony.program.name, 'My own name');
  assert.deepEqual([harmony.program.payout.model, harmony.program.payout.pool], ['proportional', 42]);
  assert.deepEqual(harmony.program.pockets.map((k) => k.id), ['all']);
  // what was not overridden stays
  assert.equal(harmony.program.id, 'warehouse-fulfillment');
  assert.ok(harmony.program.metrics.length >= 4);
  // and the template itself is not changed
  assert.notEqual(kit.template('warehouse-fulfillment').name, 'My own name');
  // overrides are validated like any program
  assert.throws(() => kit.createProgram({ tenant: { id: 'acme-kit', network: 'testnet' }, program: 'tip-pool', overrides: { pockets: [{ id: 'a', label: 'A', share: 0.5, rule: { type: 'instant' } }] } }), ProgramConfigError);
});

test('overrides on an already defined program are refused clearly, not with a confusing validation error', () => {
  const defined = kit.defineProgram(kit.template('tip-pool'));
  assert.throws(() => kit.createProgram({ tenant: { id: 'acme-kit', network: 'testnet' }, program: defined, overrides: { name: 'x' } }),
    (e) => e.statusCode === 400 && e.code === 'OVERRIDES_ON_DEFINED_PROGRAM');
});

test('an invalid tenant is reported by the engine', () => {
  assert.throws(() => kit.createProgram({ tenant: { id: 'X', network: 'moon' }, program: 'tip-pool' }), /Invalid tenant configuration/);
});

// ── end to end, offline ─────────────────────────────────────────────────────

/** Events that give every metric of the program some units to every person; returns also the people. */
function activity(program, count) {
  const ids = Array.from({ length: count }, (_, i) => `person-${i + 1}`);
  const events = [];
  ids.forEach((participantId, i) => {
    for (const m of program.metrics) {
      // positive metrics: a lot, descending by person, so ranks are clear and everybody clears minPoints;
      // penalties: a little, and only for some people
      const value = m.points > 0 ? 400 - i * 37 : (i % 2 ? 1 : 0);
      if (value > 0) events.push({ participantId, metric: m.id, value });
    }
  });
  return { ids, events };
}

for (const id of IDS) {
  test(`end to end offline: ${id}`, async () => {
    const harmony = kit.createProgram({ tenant: { id: 'acme-kit', network: 'testnet' }, program: id });
    const { program } = harmony;
    const { ids, events } = activity(program, 6);

    // 1. score
    const lifetime = { 'person-1': 3000, 'person-2': 120 };
    const { standings, totals } = harmony.score({ events, lifetime, quality: { 'person-3': 0.5 } });
    assert.equal(standings.length, 6);
    assert.ok(totals.qualified >= 3, 'the activity qualifies people');
    assert.deepEqual(standings.map((s) => s.rank), [1, 2, 3, 4, 5, 6]);

    // 2. plan: five people have a wallet; one of them has no account yet, one has no trustline
    const payer = keypair();
    const people = {};
    ids.forEach((pid, i) => { people[pid] = { name: `Worker ${i + 1}`, wallet: i < 5 ? wallet() : null }; });
    const plan = harmony.plan({ standings, people, now: NOW });
    assert.ok(plan.payments.length >= 1);
    const withheld = plan.withheld.reduce((n, x) => n + toStroops(x.amount), 0n);
    if (plan.rule.model === 'proportional') assert.equal(toStroops(plan.total) + withheld, toStroops(String(plan.rule.pool)));
    if (plan.rule.model === 'rate') assert.equal(toStroops(plan.total) + withheld, toStroops(plan.rule.scaledToBudget ? String(plan.rule.budget) : plan.rule.due));
    kit.assertPlanIntegrity(plan);

    // 3. build: person-4 has no trustline, person-5 has no account
    const accounts = { [payer.publicKey()]: account({ usdc: '10000000.0000000' }) };
    const p4 = people['person-4'].wallet;
    for (const pid of ids.slice(0, 5)) {
      if (pid === 'person-5') continue;
      accounts[people[pid].wallet] = pid === 'person-4' ? account({}) : account({ usdc: '0.0000000' });
    }
    assert.ok(p4);
    const horizon = fakeHorizon(accounts);
    const built = await harmony.build({ plan, payer: payer.publicKey(), horizon, now: NOW });
    assert.equal(built.skipped.length, 0, 'hold mode leaves nobody out');
    assert.equal(built.total, plan.total);
    assert.equal(built.operations.length, plan.payments.reduce((n, p) => n + p.pockets.length, 0));
    const txs = built.xdrs.map((x) => parse(x));
    txs.forEach((t, i) => {
      assert.ok(t.operations.length <= 20);
      assert.equal(Buffer.from(t.memo.value).toString('hex'), plan.planId);
      assert.equal(t.hash().toString('hex'), built.hashes[i]);
    });
    // Whoever can receive gets payments for instant pockets; whoever cannot gets claimable balances.
    const kinds = (pid) => built.operations.filter((o) => o.participantId === pid).map((o) => o.kind);
    for (const pay of plan.payments) {
      const k = kinds(pay.participantId);
      if (['person-4', 'person-5'].includes(pay.participantId)) assert.ok(!k.includes('payment'), `${pay.participantId} cannot receive a payment`);
      else assert.ok(k.every((x) => x !== 'hold'), `${pay.participantId} needs no hold`);
    }

    // 4. sign with a random key and 5. submit
    const signed = built.xdrs.map((x) => signXdr(x, payer));
    const net = fakeHorizon({});
    const receipt = await harmony.submit({ built, signedXdrs: [...signed].reverse(), horizon: net });
    assert.deepEqual(net.submitted.map((t) => t.hash().toString('hex')), built.hashes);
    assert.equal(receipt.transactions.flatMap((t) => t.operations).length, built.operations.length);

    // 6. cards: one per person who was paid
    for (const pay of plan.payments) {
      const standing = standings.find((s) => s.participantId === pay.participantId);
      const c = harmony.card({
        participant: { participantId: pay.participantId, name: pay.name, wallet: pay.wallet },
        standing, of: standings.length, payment: pay, receipt, period: 'Week 1', now: NOW + DAY,
      });
      assert.equal(c.preview, false);
      assert.equal(c.planId, plan.planId);
      assert.equal(c.reward.total, pay.amount);
      assert.equal(c.reward.pockets.length, pay.pockets.length);
      assert.ok(c.reward.pockets.every((k) => k.status !== 'planned'), 'every pocket is in the receipt');
      assert.ok(c.proofs.length >= 1);
      assert.ok(!JSON.stringify(c).includes(pay.wallet));
      const svg = harmony.renderCardSvg(c);
      assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'));
      assert.ok(!svg.includes(pay.wallet));
    }
  });
}

test('end to end: a person claims what was held for them and a late claim after expiry is theirs to lose', async () => {
  const harmony = kit.createProgram({
    tenant: { id: 'acme-kit', network: 'testnet' },
    program: 'last-mile-delivery',
  });
  const { ids, events } = activity(harmony.program, 3);
  const { standings } = harmony.score({ events });
  const payer = keypair();
  const courier = keypair();
  const people = Object.fromEntries(ids.map((pid, i) => [pid, { name: pid, wallet: i === 0 ? courier.publicKey() : wallet() }]));
  const plan = harmony.plan({ standings, people, now: NOW });
  // Nobody has an account yet: everything is held.
  const horizon = fakeHorizon({ [payer.publicKey()]: account({ usdc: '10000000.0000000' }) });
  const built = await harmony.build({ plan, payer: payer.publicKey(), horizon, now: NOW });
  assert.ok(built.operations.every((o) => o.kind !== 'payment'));
  await harmony.submit({ built, signedXdrs: built.xdrs.map((x) => signXdr(x, payer)), horizon: fakeHorizon({}) });

  // The courier opens an account and claims every balance that was created for them, with one signature.
  const mine = built.operations.filter((o) => o.wallet === courier.publicKey()).map((o) => o.balanceId);
  assert.equal(mine.length, plan.payments[0].pockets.length);
  const claim = await harmony.buildClaim({ wallet: courier.publicKey(), balanceIds: mine, horizon: fakeHorizon({ [courier.publicKey()]: account({}) }) });
  assert.equal(claim.addsTrustline, true);
  const net = fakeHorizon({});
  const res = await harmony.submitClaim({ wallet: courier.publicKey(), signedXdrs: claim.xdrs.map((x) => signXdr(x, courier)), horizon: net });
  assert.deepEqual(res.transactions.flatMap((t) => t.claimed), mine);
  assert.match(res.transactions[0].hash, /^[0-9a-f]{64}$/);
});

test('software-delivery caps the effort of a board item, which any board user can edit', () => {
  const program = kit.defineProgram(kit.template('software-delivery'));
  assert.equal(program.metrics.find((m) => m.id === 'item_done').cap, 200);
  const { standings } = kit.score(program, { events: [{ participantId: 'mallory', metric: 'item_done', value: 1e9 }] });
  assert.equal(standings[0].byMetric.item_done.units, 200);
  assert.equal(standings[0].adjustedPoints, 1000);
});

test('software-delivery caps every metric a team member can inflate from the tools', () => {
  const metrics = Object.fromEntries(kit.template('software-delivery').metrics.map((m) => [m.id, m.cap]));
  assert.equal(metrics.pr_merged, 60);
  assert.equal(metrics.review, 120);
  assert.equal(metrics.bug_fixed, 30);
  assert.equal(metrics.item_done, 200);
  assert.equal(metrics.commit, 100);
});
