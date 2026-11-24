'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sdk, kit, NOW, DAY, ISSUER, USDC, scenario, simpleProgram, tenant, keypair, wallet, account, fakeHorizon,
  parse, claimantsOf, scoreOf, peopleOf,
} = require('./_helpers');

const THREE_POCKETS = [
  { id: 'now', label: 'Now', share: 0.5, rule: { type: 'instant' } },
  { id: 'soon', label: 'Soon', share: 0.3, rule: { type: 'expires', afterDays: 14 } },
  { id: 'later', label: 'Later', share: 0.2, rule: { type: 'unlocks', afterDays: 60 } },
];

const buildOf = (s, extra = {}) => kit.build(s.program, s.tenant, { plan: s.plan, payer: s.payer.publicKey(), horizon: s.horizon, now: s.now, ...extra });

/** All operations of all built transactions, parsed back from the XDR. */
const opsOf = (built) => built.xdrs.map((x) => parse(x).operations);

/** Same plan, edited and re-identified: what a host bug or an attacker with the plan code could produce. */
function reidentified(plan, edit) {
  const p = JSON.parse(JSON.stringify(plan));
  edit(p);
  p.planId = kit.planIdOf(p);
  return p;
}

test('instant pockets become plain payments, in one transaction with the plan id as memo', async () => {
  const s = scenario();
  const built = await buildOf(s);
  assert.equal(built.xdrs.length, 1);
  assert.equal(built.hashes.length, 1);
  const tx = parse(built.xdrs[0]);
  assert.equal(tx.source, s.payer.publicKey());
  assert.deepEqual(tx.operations.map((o) => o.type), ['payment', 'payment', 'payment']);
  assert.deepEqual(tx.operations.map((o) => o.amount), ['50.0000000', '30.0000000', '20.0000000']);
  assert.deepEqual(tx.operations.map((o) => o.destination), s.plan.payments.map((p) => p.wallet));
  tx.operations.forEach((o) => { assert.equal(o.asset.getCode(), 'USDC'); assert.equal(o.asset.getIssuer(), ISSUER); });
  assert.equal(tx.memo.type, 'hash');
  assert.equal(Buffer.from(tx.memo.value).toString('hex'), s.plan.planId);
  assert.equal(tx.hash().toString('hex'), built.hashes[0]);
  assert.equal(tx.fee, '3000');
  assert.equal(built.total, '100.0000000');
  assert.equal(built.reserveXlm, 0);
  assert.equal(built.feeXlm, 0.0003);
  assert.equal(built.planId, s.plan.planId);
  assert.equal(built.network, 'testnet');
  assert.equal(built.skipped.length, 0);
  assert.ok(built.operations.every((o) => o.kind === 'payment' && o.balanceId === null && o.tx === 0));
  assert.deepEqual(built.operations.map((o) => o.index), [0, 1, 2]);
  assert.deepEqual(built.asset, { code: 'USDC', issuer: ISSUER });
});

test('the transaction carries a time bound so it cannot be signed and kept forever', async () => {
  const s = scenario();
  const tx = parse((await buildOf(s)).xdrs[0]);
  assert.ok(Number(tx.timeBounds.maxTime) > 0);
});

test('expires and unlocks pockets become claimable balances with the exact claimants and predicates', async () => {
  const s = scenario({ program: simpleProgram({ pockets: THREE_POCKETS }), points: { a: 1 } });
  const built = await buildOf(s);
  const payer = s.payer.publicKey();
  const w = s.plan.payments[0].wallet;
  const pockets = s.plan.payments[0].pockets;
  const ops = opsOf(built)[0];
  assert.deepEqual(ops.map((o) => o.type), ['payment', 'createClaimableBalance', 'createClaimableBalance']);
  assert.equal(ops[0].amount, pockets[0].amount);

  const soon = pockets[1].rule.at;
  assert.equal(soon, NOW + 14 * DAY);
  assert.equal(ops[1].amount, pockets[1].amount);
  assert.deepEqual(claimantsOf(ops[1]), [
    { destination: w, predicate: { before: soon } },
    { destination: payer, predicate: { not: { before: soon } } },
  ]);

  const later = pockets[2].rule.at;
  assert.equal(later, NOW + 60 * DAY);
  assert.equal(ops[2].amount, pockets[2].amount);
  assert.deepEqual(claimantsOf(ops[2]), [{ destination: w, predicate: { not: { before: later } } }]);

  // What the host stores about each operation.
  const [pay, exp, unl] = built.operations;
  assert.deepEqual([pay.kind, exp.kind, unl.kind], ['payment', 'expires', 'unlocks']);
  assert.equal(exp.claimableFrom, NOW);
  assert.equal(exp.claimableUntil, soon);
  assert.equal(exp.payerCanReclaimFrom, soon);
  assert.equal(unl.claimableFrom, later);
  assert.equal(unl.claimableUntil, null);
  assert.equal(unl.payerCanReclaimFrom, null);
  assert.equal(built.operations.every((o) => o.pocketId && o.participantId === 'a'), true);
  assert.equal(built.operations.some((o) => 'operation' in o || 'claimants' in o), false, 'SDK objects do not leak');
});

test('the reserve of the claimable balances and the fees are reported', async () => {
  const s = scenario({ program: simpleProgram({ pockets: THREE_POCKETS }), points: { a: 1 } });
  const built = await buildOf(s);
  // expires has two claimants (1.0 XLM), unlocks one (0.5 XLM)
  assert.equal(built.reserveXlm, 1.5);
  assert.equal(built.feeXlm, 0.0003);
});

test('the balanceId of each claimable operation is the one the network will assign', async () => {
  const s = scenario({ program: simpleProgram({ pockets: THREE_POCKETS }), points: { a: 60, b: 40 } });
  const built = await buildOf(s);
  const txs = built.xdrs.map((x) => parse(x));
  let claimables = 0;
  for (const o of built.operations) {
    const tx = txs[o.tx];
    if (o.kind === 'payment') { assert.equal(o.balanceId, null); continue; }
    claimables += 1;
    assert.equal(tx.operations[o.index].type, 'createClaimableBalance');
    assert.equal(o.balanceId, tx.getClaimableBalanceId(o.index));
    assert.match(o.balanceId, /^[0-9a-f]{72}$/);
  }
  assert.equal(claimables, 4);
  assert.equal(new Set(built.operations.map((o) => o.balanceId)).size, 5, 'null for payments plus four distinct ids');
});

test('hold: a person who cannot receive yet gets a claimable balance the payer can reclaim later', async () => {
  const s = scenario({ program: simpleProgram({ pockets: THREE_POCKETS, unreachable: { mode: 'hold', reclaimAfterDays: 10 } }), points: { a: 60, b: 40, c: 10 }, funded: false });
  const [a, b, c] = s.plan.payments.map((p) => p.wallet);
  s.horizon = fakeHorizon({
    [s.payer.publicKey()]: account({ usdc: '1000000.0000000' }),
    [a]: account({ usdc: '0.0000000' }), // ready
    [b]: account({}),                    // exists, no trustline
    // c: no account at all
  });
  const built = await buildOf(s);
  const payer = s.payer.publicKey();
  const hold = NOW + 10 * DAY;
  const kinds = (id) => built.operations.filter((o) => o.participantId === id).map((o) => o.kind);
  assert.deepEqual(kinds('a'), ['payment', 'expires', 'unlocks']);
  assert.deepEqual(kinds('b'), ['hold', 'expires', 'unlocks']);
  assert.deepEqual(kinds('c'), ['hold', 'expires', 'unlocks']);
  assert.equal(built.skipped.length, 0);

  const all = opsOf(built).flat();
  const forWallet = (w, type) => all.filter((o) => o.type === type && o.claimants && o.claimants.some((cl) => cl.destination === w));
  for (const w of [b, c]) {
    const [first] = built.operations.filter((o) => o.wallet === w);
    assert.equal(first.kind, 'hold');
    assert.equal(first.claimableFrom, NOW);
    assert.equal(first.claimableUntil, null);
    assert.equal(first.payerCanReclaimFrom, hold);
    const op = forWallet(w, 'createClaimableBalance').find((o) => o.amount === first.amount);
    assert.deepEqual(claimantsOf(op), [
      { destination: w, predicate: { unconditional: true } },
      { destination: payer, predicate: { not: { before: hold } } },
    ]);
  }
  // The reachable person keeps a real payment.
  assert.equal(all.filter((o) => o.type === 'payment').length, 1);
  assert.equal(all.filter((o) => o.type === 'payment')[0].destination, a);
  assert.equal(built.total, s.plan.total);
});

test('skip: people who cannot receive are left out and reported with the reason', async () => {
  const s = scenario({ program: simpleProgram({ unreachable: { mode: 'skip' } }), points: { a: 60, b: 30, c: 10 }, funded: false });
  const [a, b, c] = s.plan.payments.map((p) => p.wallet);
  s.horizon = fakeHorizon({
    [s.payer.publicKey()]: account({ usdc: '1000000.0000000' }),
    [a]: account({ usdc: '0.0000000' }),
    [b]: account({}),
  });
  const built = await buildOf(s);
  assert.equal(built.operations.length, 1);
  assert.equal(built.operations[0].wallet, a);
  assert.deepEqual(built.skipped.map((x) => [x.participantId, x.reason]), [
    ['b', 'no trustline for the reward asset'],
    ['c', 'account does not exist on testnet'],
  ]);
  assert.equal(built.skipped[0].amount, s.plan.payments[1].amount);
  assert.equal(built.skipped[1].wallet, c);
  assert.equal(built.total, s.plan.payments[0].amount);
});

test('skip with nobody able to receive fails with 409 and lists who was skipped', async () => {
  const s = scenario({ program: simpleProgram({ unreachable: { mode: 'skip' } }), funded: false });
  await assert.rejects(buildOf(s), (e) => e.statusCode === 409 && /No recipient can receive/.test(e.message) && e.skipped.length === 3);
});

test('a wallet that is not valid and the payer as a recipient are skipped', async () => {
  const s = scenario({ points: { a: 50, b: 30, c: 20 } });
  const payer = s.payer.publicKey();
  const plan = reidentified(s.plan, (p) => { p.payments[0].wallet = 'GNOTAVALIDADDRESS'; p.payments[1].wallet = payer; });
  const built = await buildOf(s, { plan });
  assert.deepEqual(built.skipped.map((x) => [x.participantId, x.reason]), [['a', 'invalid address'], ['b', 'same as the payer wallet']]);
  assert.equal(built.operations.length, 1);
  assert.equal(built.operations[0].participantId, 'c');
});

test('the same wallet is looked up once, even with several pockets', async () => {
  const s = scenario({ program: simpleProgram({ pockets: THREE_POCKETS }), points: { a: 1 } });
  let loads = 0;
  const inner = s.horizon.loadAccount;
  s.horizon.loadAccount = async (id) => { loads += 1; return inner(id); };
  await buildOf(s);
  assert.equal(loads, 2); // the payer and the one recipient
});

test('insufficient reward asset balance is refused with 409', async () => {
  const s = scenario({ usdc: '99.9999999' });
  await assert.rejects(buildOf(s), (e) => e.statusCode === 409 && e.code === 'INSUFFICIENT_BALANCE' && e.balance === '99.9999999' && e.total === '100.0000000');
  const exact = scenario({ usdc: '100.0000000' });
  assert.equal((await buildOf(exact)).xdrs.length, 1);
});

test('a payer without a trustline has no balance', async () => {
  const s = scenario();
  s.horizon = fakeHorizon({ ...s.accounts, [s.payer.publicKey()]: account({}) });
  await assert.rejects(buildOf(s), (e) => e.code === 'INSUFFICIENT_BALANCE' && e.balance === '0.0000000');
});

test('the XLM needed for reserves is checked down to the threshold', async () => {
  // One claimable balance with two claimants: 1.0 XLM of reserve, 0.0001 of fee, 1.0 of minimum balance.
  const program = simpleProgram({ pockets: [{ id: 'soon', label: 'Soon', share: 1, rule: { type: 'expires', afterDays: 7 } }] });
  const low = scenario({ program, points: { a: 1 }, xlm: '2.0000000' });
  await assert.rejects(buildOf(low), (e) => e.statusCode === 409 && e.code === 'INSUFFICIENT_XLM' && e.reserveXlm === 1 && e.minimumXlm === 1 && e.feeXlm === 0.0001);
  const enough = scenario({ program, points: { a: 1 }, xlm: '2.0001000' });
  assert.equal((await buildOf(enough)).xdrs.length, 1);
});

test('the minimum balance counts subentries and sponsorship', async () => {
  const program = simpleProgram({ pockets: [{ id: 'soon', label: 'Soon', share: 1, rule: { type: 'expires', afterDays: 7 } }] });
  const s = scenario({ program, points: { a: 1 }, xlm: '3.0000000' });
  const payer = s.payer.publicKey();
  const withEntries = (extra) => fakeHorizon({ ...s.accounts, [payer]: account({ usdc: '1000.0000000', xlm: '3.0000000', ...extra }) });
  // 2 base + 4 subentries = 3.0 XLM minimum, plus 1.0 reserve: not enough
  await assert.rejects(buildOf(s, { horizon: withEntries({ subentries: 4 }) }), (e) => e.code === 'INSUFFICIENT_XLM' && e.minimumXlm === 3);
  // sponsoring raises the minimum, being sponsored lowers it
  await assert.rejects(buildOf(s, { horizon: withEntries({ sponsoring: 2 }) }), (e) => e.code === 'INSUFFICIENT_XLM' && e.minimumXlm === 2);
  assert.equal((await buildOf(s, { horizon: withEntries({ subentries: 2, sponsored: 2 }) })).xdrs.length, 1);
});

test('payments alone only need the fee on top of the minimum balance', async () => {
  const s = scenario({ xlm: '1.0004000' });
  assert.equal((await buildOf(s)).xdrs.length, 1);
  const short = scenario({ xlm: '1.0002000' });
  await assert.rejects(buildOf(short), (e) => e.code === 'INSUFFICIENT_XLM');
});

test('a custom base reserve is honoured', async () => {
  const program = simpleProgram({ pockets: [{ id: 'later', label: 'Later', share: 1, rule: { type: 'unlocks', afterDays: 7 } }] });
  const s = scenario({ program, points: { a: 1 }, xlm: '5.0000000' });
  const built = await buildOf(s, { baseReserveXlm: 1 });
  assert.equal(built.reserveXlm, 1); // one claimant x 1 XLM
});

test('more than 20 operations are split into consecutive transactions, each tied to the plan', async () => {
  const points = {};
  for (let i = 0; i < 25; i++) points[`p${i}`] = 1 + i;
  const s = scenario({ program: simpleProgram({ pockets: THREE_POCKETS, payout: { model: 'proportional', pool: 1000 } }), points });
  const built = await buildOf(s);
  assert.equal(built.xdrs.length, 4); // 75 operations: 20 + 20 + 20 + 15
  assert.equal(built.hashes.length, 4);
  const txs = built.xdrs.map((x) => parse(x));
  assert.deepEqual(txs.map((t) => t.operations.length), [20, 20, 20, 15]);
  for (let i = 1; i < txs.length; i++) assert.equal(BigInt(txs[i].sequence), BigInt(txs[i - 1].sequence) + 1n);
  txs.forEach((t, i) => {
    assert.equal(Buffer.from(t.memo.value).toString('hex'), s.plan.planId);
    assert.equal(t.hash().toString('hex'), built.hashes[i]);
  });
  assert.equal(new Set(built.hashes).size, 4);
  assert.equal(built.operations.length, 75);
  assert.deepEqual(built.operations.map((o) => [o.tx, o.index]).slice(18, 23), [[0, 18], [0, 19], [1, 0], [1, 1], [1, 2]]);
  // Every plan pocket appears exactly once and the amounts add up to the plan.
  const seen = new Set(built.operations.map((o) => `${o.participantId}/${o.pocketId}`));
  assert.equal(seen.size, 75);
  assert.equal(built.total, s.plan.total);
  // Fees for every operation.
  assert.equal(built.feeXlm, 0.0075);
});

test('a plan of exactly 20 operations is a single transaction', async () => {
  const points = {};
  for (let i = 0; i < 20; i++) points[`p${i}`] = 1;
  const s = scenario({ points });
  assert.equal((await buildOf(s)).xdrs.length, 1);
});

test('a plan from another tenant, program, network or asset is rejected', async () => {
  const s = scenario();
  const mismatch = (e) => e.statusCode === 400 && e.code === 'PLAN_MISMATCH';
  await assert.rejects(kit.build(s.program, tenant({ id: 'someone-else' }), { plan: s.plan, payer: s.payer.publicKey(), horizon: s.horizon, now: s.now }), mismatch);
  await assert.rejects(kit.build(simpleProgram({ id: 'other-program' }), s.tenant, { plan: s.plan, payer: s.payer.publicKey(), horizon: s.horizon, now: s.now }), mismatch);
  await assert.rejects(kit.build(s.program, tenant({ network: 'mainnet' }), { plan: s.plan, payer: s.payer.publicKey(), horizon: s.horizon, now: s.now }), mismatch);
  const otherAsset = tenant({ rewardAsset: { code: 'EURC', issuer: wallet() } });
  await assert.rejects(kit.build(s.program, otherAsset, { plan: s.plan, payer: s.payer.publicKey(), horizon: s.horizon, now: s.now }), mismatch);
});

test('an edited plan is rejected before anything is built', async () => {
  const s = scenario();
  const edited = JSON.parse(JSON.stringify(s.plan));
  edited.payments[0].wallet = wallet();
  await assert.rejects(buildOf(s, { plan: edited }), (e) => e.code === 'PLAN_ALTERED');
});

test('mainnet: the payer must be the registered one; testnet accepts any payer', async () => {
  const registered = keypair();
  const t = tenant({ network: 'mainnet', payouts: { payerWallet: registered.publicKey() } });
  const program = simpleProgram();
  const { standings } = scoreOf(program, { a: 1 });
  const people = peopleOf(['a']);
  const plan = kit.plan(program, t, { standings, people, now: NOW });
  const intruder = keypair();
  const accounts = {
    [registered.publicKey()]: account({ usdc: '500.0000000', issuer: t.rewardAsset.issuer }),
    [intruder.publicKey()]: account({ usdc: '500.0000000', issuer: t.rewardAsset.issuer }),
    [people.a.wallet]: account({ usdc: '0', issuer: t.rewardAsset.issuer }),
  };
  const horizon = fakeHorizon(accounts);
  await assert.rejects(kit.build(program, t, { plan, payer: intruder.publicKey(), horizon, now: NOW }), (e) => e.statusCode === 409 && e.code === 'UNEXPECTED_PAYER');
  const built = await kit.build(program, t, { plan, payer: registered.publicKey(), horizon, now: NOW });
  assert.equal(built.xdrs.length, 1);
  assert.equal(built.networkPassphrase, sdk.Networks.PUBLIC);

  const testnet = scenario({ tenantExtra: { payouts: { payerWallet: registered.publicKey() } } });
  assert.equal((await buildOf(testnet)).xdrs.length, 1); // payer is not the registered one, and that is fine on testnet
});

test('caps are enforced again at build time, even for a plan whose id was recomputed', async () => {
  const s = scenario({ tenantExtra: { payouts: { caps: { perPerson: 60 } } } });
  assert.equal((await buildOf(s)).xdrs.length, 1);
  const inflated = reidentified(s.plan, (p) => {
    p.payments[0].amount = '75.0000000';
    p.payments[0].pockets[0].amount = '75.0000000';
    p.total = '125.0000000';
  });
  await assert.rejects(buildOf(s, { plan: inflated }), (e) => e.statusCode === 409 && e.cap === 'person');
});

test('bad payer or a payer that does not exist', async () => {
  const s = scenario();
  await assert.rejects(kit.build(s.program, s.tenant, { plan: s.plan, payer: 'GNOPE', horizon: s.horizon }), (e) => e.statusCode === 400 && /payer wallet is not a Stellar account/.test(e.message));
  await assert.rejects(buildOf(s, { payer: keypair().publicKey() }), (e) => e.statusCode === 400 && /does not exist/.test(e.message));
  // Other lookup failures are not swallowed.
  const broken = { loadAccount: async () => { throw new Error('horizon down'); } };
  await assert.rejects(buildOf(s, { horizon: broken }), /horizon down/);
});

test('the built result holds no secret and strings for money', async () => {
  const built = await buildOf(scenario({ program: simpleProgram({ pockets: THREE_POCKETS }) }));
  assert.doesNotMatch(JSON.stringify(built), /S[A-Z2-7]{55}/);
  built.operations.forEach((o) => assert.equal(typeof o.amount, 'string'));
  assert.equal(typeof built.total, 'string');
  assert.equal(typeof built.payerBalance, 'string');
});

test('USDC constant of the tests is the tenant asset', () => {
  assert.equal(USDC.getIssuer(), tenant().rewardAsset.issuer);
});

// ── stale plans ─────────────────────────────────────────────────────────────

const stale = (e) => e.statusCode === 409 && e.code === 'PLAN_EXPIRED';
const TIMEOUT = 1800;

test('a plan older than maxPlanAgeSeconds (default one day) is not built', async () => {
  const s = scenario();
  await assert.rejects(buildOf(s, { now: s.now + DAY + 1 }), stale);
  const built = await buildOf(s, { now: s.now + DAY });
  assert.equal(built.xdrs.length, 1);
  await assert.rejects(buildOf(s, { now: s.now + 601, maxPlanAgeSeconds: 600 }), stale);
  assert.equal((await buildOf(s, { now: s.now + 600, maxPlanAgeSeconds: 600 })).xdrs.length, 1);
  await assert.rejects(buildOf(s, { maxPlanAgeSeconds: 0 }), (e) => e.statusCode === 400);
  await assert.rejects(buildOf(s, { now: 1.5 }), (e) => e.statusCode === 400);
});

test('the clock cannot be earlier than the plan, beyond five minutes of skew', async () => {
  const s = scenario();
  assert.equal((await buildOf(s, { now: s.now - 300 })).xdrs.length, 1);
  await assert.rejects(buildOf(s, { now: s.now - 301 }), stale);
});

test('an expires pocket that the payer could take back within the validity window is refused', async () => {
  const program = simpleProgram({
    pockets: [
      { id: 'now', label: 'Now', share: 0.5, rule: { type: 'instant' } },
      { id: 'soon', label: 'Soon', share: 0.5, rule: { type: 'expires', afterSeconds: 7200 } },
    ],
  });
  const s = scenario({ program });
  const at = s.now + 7200;
  assert.equal((await buildOf(s, { now: at - TIMEOUT })).xdrs.length, 1);
  await assert.rejects(buildOf(s, { now: at - TIMEOUT + 1 }), (e) => stale(e) && e.pocketId === 'soon');
  await assert.rejects(buildOf(s, { now: at + 10, maxPlanAgeSeconds: 1e9 }), stale);
});

test('a hold that the payer could take back within the validity window is refused; nobody held means no check', async () => {
  const program = simpleProgram({ unreachable: { mode: 'hold', reclaimAfterDays: 1 } });
  const s = scenario({ program, funded: false });
  const at = s.now + DAY;
  assert.equal((await buildOf(s, { now: at - TIMEOUT, maxPlanAgeSeconds: 1e9 })).operations[0].kind, 'hold');
  await assert.rejects(buildOf(s, { now: at - TIMEOUT + 1, maxPlanAgeSeconds: 1e9 }), (e) => stale(e) && /hold/.test(e.message));
  // Everybody can receive: no hold is created, so the hold date is irrelevant.
  const funded = scenario({ program });
  assert.equal((await buildOf(funded, { now: at + 5, maxPlanAgeSeconds: 1e9 })).operations[0].kind, 'payment');
});

test('an unlocks date in the past is harmless: the pocket is simply claimable at once', async () => {
  const program = simpleProgram({
    pockets: [
      { id: 'now', label: 'Now', share: 0.5, rule: { type: 'instant' } },
      { id: 'later', label: 'Later', share: 0.5, rule: { type: 'unlocks', afterSeconds: 600 } },
    ],
  });
  const s = scenario({ program });
  const built = await buildOf(s, { now: s.now + 3600 });
  const later = built.operations.filter((o) => o.kind === 'unlocks');
  assert.equal(later.length, 3);
  assert.ok(later.every((o) => o.claimableFrom < s.now + 3600));
});
