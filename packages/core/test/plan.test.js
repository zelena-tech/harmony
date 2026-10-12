'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('@stellar/stellar-sdk');
const { planCampaignPayout, planFreePayout, summarizePrevious, withBalance } = require('../src/payouts/plan');
const { createHarmony } = require('../src');

const W = () => sdk.Keypair.random().publicKey();
const caps = { perPerson: 200, perBatch: 1000 };
const close = (a, b, d = 1e-6) => assert.ok(Math.abs(a - b) < d, `${a} ≈ ${b}`);

// ── Base for everybody + pool among the top-N ───────────────────────────────
const wallets = [W(), W(), W(), W()];
const ranking = [
  { workerId: 1, name: 'worker-1', wallet: wallets[0], adjustedPoints: 2000 },
  { workerId: 2, name: 'worker-2', wallet: null, adjustedPoints: 1500 },        // top without wallet
  { workerId: 3, name: 'worker-3', wallet: wallets[1], adjustedPoints: 1000 },
  { workerId: 4, name: 'worker-4', wallet: wallets[2], adjustedPoints: 500 },
  { workerId: 5, name: 'worker-5', wallet: 'garbage', adjustedPoints: 100 },   // invalid = no wallet
];
const plan = (options, extra = {}) => planCampaignPayout({ ranking, caps, options, ...extra });

test('base for everybody with a wallet; the pool is shared by points among the real top-3', () => {
  const r = plan({ base: 15, pool: 150, topN: 3 });
  const by = (n) => r.payments.find((p) => p.name === n);
  close(by('worker-1').amount, 15 + 150 * 2000 / 4500);
  close(by('worker-3').amount, 15 + 150 * 1000 / 4500);
  assert.equal(by('worker-4').amount, 15);
  assert.ok(!r.payments.some((p) => ['worker-2', 'worker-5'].includes(p.name)));
  assert.deepEqual(r.withoutWallet, ['worker-2', 'worker-5']);
  assert.equal(by('worker-1').walletShort, `${wallets[0].slice(0, 4)}…${wallets[0].slice(-6)}`);
});

test('the share of a top worker without wallet is withheld, not redistributed', () => {
  const r = plan({ base: 15, pool: 150, topN: 3 });
  assert.equal(r.withheld.length, 1);
  assert.equal(r.withheld[0].name, 'worker-2');
  close(r.withheld[0].amount, 150 * 1500 / 4500);
  const paid = r.payments.reduce((s, p) => s + p.amount, 0);
  close(paid + r.withheld[0].amount, 15 * 3 + 150, 1e-5);
});

test('the rank does not depend on having a wallet', () => {
  const r = plan({ base: 15, pool: 150, topN: 3 });
  assert.equal(r.payments.find((p) => p.name === 'worker-3').rank, 3);
  assert.equal(r.payments.find((p) => p.name === 'worker-4').rank, 4);
});

// ── Anti double payment ─────────────────────────────────────────────────────
const previous = summarizePrevious([
  { workerId: 1, wallet: wallets[0], kind: 'bonus', amount: '81.67' },
  { workerId: 3, wallet: wallets[1], kind: 'test', amount: '0.50' },
]);

test('whoever already got the bonus is excluded by default and listed', () => {
  const r = plan({ base: 15, pool: 150, topN: 3 }, { previous });
  assert.ok(!r.payments.some((p) => p.name === 'worker-1'));
  assert.deepEqual(r.excludedAlreadyPaid, [{ name: 'worker-1', rank: 1, alreadyPaid: 81.67 }]);
  const w3 = r.payments.find((p) => p.name === 'worker-3');
  close(w3.alreadyPaidTest, 0.5);
  assert.equal(w3.alreadyPaidBonus, 0);
});

test('includeAlreadyPaid re-includes them, flagged with what they got', () => {
  const r = plan({ base: 15, pool: 150, topN: 3, includeAlreadyPaid: true }, { previous });
  close(r.payments.find((p) => p.name === 'worker-1').alreadyPaidBonus, 81.67);
  assert.deepEqual(r.excludedAlreadyPaid, []);
});

test('a proportional test payment does not exclude anybody', () => {
  const r = plan({ testAmount: 5 }, { previous });
  assert.ok(r.payments.some((p) => p.name === 'worker-1'));
  close(r.total, 5);
});

// ── Caps and alerts ─────────────────────────────────────────────────────────
test('per-person cap blocks the plan', () => {
  assert.throws(() => plan({ base: 250, pool: 0, topN: 0 }), (e) => e.statusCode === 409 && e.cap === 'person');
});

test('batch cap blocks the plan', () => {
  assert.throws(() => planCampaignPayout({ ranking, caps: { perPerson: 5000, perBatch: 100 }, options: { base: 50, pool: 0, topN: 0 } }),
    (e) => e.statusCode === 409 && e.cap === 'batch');
});

test('without caps nothing is blocked', () => {
  const r = planCampaignPayout({ ranking, options: { base: 250, pool: 0, topN: 0 } });
  assert.deepEqual(r.caps, { perPerson: null, perBatch: null });
  assert.equal(r.payments.length, 3);
});

test('flags a recently changed wallet and a wallet different from the last payment', () => {
  const r = plan({ testAmount: 5 }, {
    walletChanges: new Map([[3, { hours: 2.3 }]]),
    previous: summarizePrevious([{ workerId: 4, wallet: W(), kind: 'test', amount: '0.1' }]),
  });
  assert.match(r.payments.find((p) => p.name === 'worker-3').alert, /wallet changed 2 h ago/);
  assert.match(r.payments.find((p) => p.name === 'worker-4').alert, /differs from the last payment/);
  assert.equal(r.payments.find((p) => p.name === 'worker-1').alert, null);
  assert.equal(r.flagged, 2);
});

test('rejects negative parameters and campaigns without points', () => {
  assert.throws(() => plan({ base: -1 }), (e) => e.statusCode === 400);
  assert.throws(() => planCampaignPayout({ ranking: [], options: {} }), (e) => e.statusCode === 409);
});

// ── Pool only for the winners, details, stroop exactness ────────────────────
const seven = [2720, 2148, 2098, 1624, 1562, 1537, 1140].map((p, i) => ({
  workerId: i + 1, name: `worker-${i + 1}`, wallet: i === 6 ? null : W(), adjustedPoints: String(p),
}));

test('defaults come from the tenant configuration', () => {
  const h = createHarmony({ id: 'tenant-a', network: 'testnet', payouts: { defaults: { base: 0, pool: 100, topN: 3 } } });
  const r = h.planCampaignPayout({ ranking: seven, options: {} });
  assert.deepEqual([r.rule.base, r.rule.pool, r.rule.topN], [0, 100, 3]);
  assert.equal(r.payments.length, 3);
  close(r.total, 100, 1e-5);
});

test('base 0: only the top-N enter and the detail mentions only the prize', () => {
  const r = planCampaignPayout({ ranking: seven, options: { base: 0, pool: 150, topN: 5 } });
  assert.deepEqual(r.payments.map((p) => p.name), ['worker-1', 'worker-2', 'worker-3', 'worker-4', 'worker-5']);
  for (const p of r.payments) assert.match(p.detail, /^prize \d+\.\d{2} \(rank [1-5]\)$/);
  assert.deepEqual(r.withheld, []);
  assert.deepEqual(r.withoutWallet, ['worker-7']);
});

test('base + pool: the top says "base + prize", the rest only "base"', () => {
  const r = planCampaignPayout({ ranking: seven, options: { base: 15, pool: 150, topN: 5 } });
  assert.equal(r.payments.length, 6);
  assert.match(r.payments[0].detail, /^base 15 \+ prize \d+\.\d{2} \(rank 1\)$/);
  assert.deepEqual([r.payments[5].amount, r.payments[5].detail], [15, 'base 15']);
  close(r.total, 6 * 15 + 150, 1e-5);
});

test('the rounded split never exceeds the pool (regression: 150.0000001)', () => {
  const top5 = seven.slice(0, 5);
  const r = planCampaignPayout({ ranking: top5, options: { base: 0, pool: 150, topN: 5 } });
  assert.ok(r.total <= 150);
  close(r.total, 150, 1e-7);
  const t = planCampaignPayout({ ranking: top5, options: { testAmount: 5 } });
  assert.ok(t.total <= 5);
  close(t.total, 5, 1e-7);
});

// ── Fixed prize per position ────────────────────────────────────────────────
const withZero = [987, 723, 644, 546, 504, 235, 0].map((p, i) => ({
  workerId: i + 1, name: `worker-${i + 1}`, wallet: W(), adjustedPoints: String(p),
}));

test('fixed prize 30 for the top 5: exactly 30 each, nobody else', () => {
  const r = planCampaignPayout({ ranking: withZero, options: { base: 0, fixedPrize: 30, topN: 5 } });
  assert.deepEqual(r.payments.map((p) => p.amount), [30, 30, 30, 30, 30]);
  assert.equal(r.total, 150);
  assert.deepEqual(r.rule, { base: 0, pool: null, fixedPrize: 30, topN: 5, includeAlreadyPaid: false });
});

test('fixed prize: a worker with 0 points never enters the top', () => {
  const r = planCampaignPayout({ ranking: withZero, options: { base: 0, fixedPrize: 30, topN: 10 } });
  assert.ok(!r.payments.some((p) => p.name === 'worker-7'));
  assert.equal(r.payments.length, 6);
});

test('negative fixed prize → 400', () => {
  assert.throws(() => planCampaignPayout({ ranking: withZero, options: { fixedPrize: -1 } }), (e) => e.statusCode === 400);
});

// ── Free payments ───────────────────────────────────────────────────────────
const people = [
  { workerId: 1, name: 'person-a', wallet: W() },
  { workerId: 2, name: 'person-b', wallet: W() },
  { workerId: 3, name: 'person-c', wallet: W() },
  { workerId: 4, name: 'person-d', wallet: null },
];

test('free payout: even split exact to the stroop, only people with wallet', () => {
  const r = planFreePayout({ recipients: people, totalAmount: 10, caps });
  assert.equal(r.payments.length, 3);
  assert.deepEqual(r.withoutWallet, ['person-d']);
  assert.equal(r.payments.reduce((s, p) => s + Math.round(p.amount * 1e7), 0), 100000000);
  close(r.payments[0].amount, 3.3333334, 1e-8);
  close(r.payments[2].amount, 3.3333333, 1e-8);
});

test('free payout: fixed amount per person', () => {
  const r = planFreePayout({ recipients: people.slice(0, 2), perPersonAmount: 15, caps });
  assert.deepEqual(r.payments.map((p) => p.amount), [15, 15]);
  assert.deepEqual(r.rule, { perPersonAmount: 15 });
});

test('free payout: input validation', () => {
  assert.throws(() => planFreePayout({ recipients: [], totalAmount: 5 }), (e) => e.statusCode === 400);
  assert.throws(() => planFreePayout({ recipients: people }), (e) => e.statusCode === 400);
  assert.throws(() => planFreePayout({ recipients: people, totalAmount: 0 }), (e) => e.statusCode === 400);
  assert.throws(() => planFreePayout({ recipients: people, perPersonAmount: -3 }), (e) => e.statusCode === 400);
  assert.throws(() => planFreePayout({ recipients: [people[3]], totalAmount: 5 }), (e) => e.statusCode === 409 && e.withoutWallet[0] === 'person-d');
});

test('free payout: caps and alerts', () => {
  assert.throws(() => planFreePayout({ recipients: people.slice(0, 1), perPersonAmount: 250, caps }), (e) => e.cap === 'person');
  assert.throws(() => planFreePayout({ recipients: people.slice(0, 3), perPersonAmount: 50, caps: { perBatch: 100 } }), (e) => e.cap === 'batch');
  const r = planFreePayout({ recipients: people.slice(0, 2), totalAmount: 2, walletChanges: new Map([[2, { hours: 5 }]]) });
  assert.match(r.payments[1].alert, /5 h ago/);
  assert.equal(r.flagged, 1);
});

test('withBalance reports whether the payer can afford the plan', () => {
  const p = { total: 10 };
  assert.deepEqual(withBalance(p, null), { total: 10, payerBalance: null });
  assert.equal(withBalance(p, { amount: 12, trustline: true }).enough, true);
  const short = withBalance(p, { amount: 7.5, trustline: true });
  assert.deepEqual([short.enough, short.missing], [false, 2.5]);
});
