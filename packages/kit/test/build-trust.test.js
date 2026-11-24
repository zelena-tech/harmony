'use strict';

// What build() and submit() must refuse or report when the plan did not stay on
// the server, when a payment may have been made already, and when a recipient
// cannot really receive. Offline: the fake Horizon keeps a small ledger.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  sdk, kit, NOW, DAY, scenario, simpleProgram, tenant, keypair, wallet, account, fakeHorizon, signXdr, parse, claimantsOf,
} = require('./_helpers');

const THREE_POCKETS = [
  { id: 'now', label: 'Now', share: 0.5, rule: { type: 'instant' } },
  { id: 'soon', label: 'Soon', share: 0.3, rule: { type: 'expires', afterDays: 14 } },
  { id: 'later', label: 'Later', share: 0.2, rule: { type: 'unlocks', afterDays: 60 } },
];

const buildOf = (s, extra = {}) => kit.build(s.program, s.tenant, { plan: s.plan, payer: s.payer.publicKey(), horizon: s.horizon, now: s.now, ...extra });
const clone = (o) => JSON.parse(JSON.stringify(o));

/** Same plan, edited and re-identified: what anybody who holds the plan can produce (planId is only a checksum). */
function reidentified(plan, edit) {
  const p = clone(plan);
  edit(p);
  p.planId = kit.planIdOf(p);
  return p;
}

// ── A. a plan edited outside the server ────────────────────────────────────

test('A: a plan edited and re-identified is refused when its pockets no longer match the program', async () => {
  const s = scenario({ program: simpleProgram({ pockets: THREE_POCKETS }), points: { a: 60, b: 40 } });
  await buildOf(s); // the untouched plan builds
  const altered = (label, edit) => assert.rejects(buildOf(s, { plan: reidentified(s.plan, edit) }),
    (e) => e.statusCode === 400 && e.code === 'PLAN_ALTERED', label);
  // The "expires" pocket of the second person: the payer could take it back within minutes.
  await altered('rule date', (p) => { p.payments[1].pockets[1].rule.at = NOW + 1900; });
  // An instant pocket turned into an unlocks pocket in the far future (locked "forever").
  await altered('rule type', (p) => { p.payments[1].pockets[0].rule = { type: 'unlocks', at: 9999999999 }; });
  // createdAt moved forward to defeat the age limit, the dates left as they were.
  await altered('createdAt', (p) => { p.createdAt += 5 * DAY; });
  // The same money, shifted between pockets.
  await altered('amounts', (p) => {
    const k = p.payments[0].pockets;
    k[0].amount = (Number(k[0].amount) - 1).toFixed(7);
    k[2].amount = (Number(k[2].amount) + 1).toFixed(7);
  });
  await altered('order', (p) => { p.payments[0].pockets.reverse(); });
  await altered('pocket removed', (p) => { p.payments[0].pockets.pop(); });
  await altered('pocket id', (p) => { p.payments[0].pockets[0].id = 'other'; });
});

test('A: the wallets cannot be checked without a list; with `wallets` an edited destination is refused', async () => {
  const s = scenario({ points: { a: 60, b: 40 } });
  const attacker = wallet();
  const edited = reidentified(s.plan, (p) => { p.payments[0].wallet = attacker; });
  s.horizon = fakeHorizon({ ...s.accounts, [attacker]: account({ usdc: '0' }) });
  // Without the list the edit is invisible to build(): this is why the docs say planId is a checksum.
  assert.equal((await buildOf(s, { plan: edited })).operations[0].wallet, attacker);

  const registered = s.plan.payments.map((p) => p.wallet);
  s.horizon = fakeHorizon(s.accounts);
  for (const wallets of [registered, new Set(registered)]) {
    await assert.rejects(buildOf(s, { plan: edited, wallets }), (e) => e.statusCode === 400 && e.code === 'UNREGISTERED_DESTINATION');
    assert.equal((await buildOf(s, { wallets })).operations.length, 2);
  }
});

test('A: with a sealKey the plan carries an HMAC of its id and build() requires it', async () => {
  const sealKey = crypto.randomBytes(32);
  const s = scenario({ program: simpleProgram({ pockets: THREE_POCKETS }), points: { a: 60, b: 40 } });
  const people = Object.fromEntries(s.plan.payments.map((p) => [p.participantId, { name: p.name, wallet: p.wallet }]));
  const sealed = kit.plan(s.program, s.tenant, { standings: s.standings, people, now: NOW, sealKey });
  assert.equal(sealed.seal, crypto.createHmac('sha256', sealKey).update(sealed.planId).digest('hex'));
  assert.equal(kit.plan(s.program, s.tenant, { standings: s.standings, people, now: NOW }).seal, undefined, 'without a key nothing changes');

  const ok = await buildOf(s, { plan: sealed, sealKey });
  assert.equal(ok.operations.length > 0, true);
  s.horizon = fakeHorizon(s.accounts);

  const refuses = (plan, code, key = sealKey) => assert.rejects(buildOf(s, { plan, sealKey: key }), (e) => e.statusCode === 400 && e.code === code);
  await refuses(s.plan, 'PLAN_NOT_SEALED'); // an unsealed plan
  const noSeal = clone(sealed); delete noSeal.seal;
  await refuses(noSeal, 'PLAN_NOT_SEALED');
  // Edited AND re-identified, with the old seal: the checksum is fine, the seal is not.
  await refuses(reidentified(sealed, (p) => { p.payments[0].wallet = wallet(); }), 'PLAN_ALTERED');
  await refuses({ ...sealed, seal: 'zz' }, 'PLAN_ALTERED');
  await refuses({ ...sealed, seal: sealed.seal.slice(0, 62) }, 'PLAN_ALTERED');
  await refuses(sealed, 'PLAN_ALTERED', crypto.randomBytes(32)); // sealed with another key
  // A plan that carries a seal is never built without the key: the seal would silently not be checked.
  await assert.rejects(buildOf(s, { plan: sealed }), (e) => e.statusCode === 400 && e.code === 'PLAN_SEALED_NO_KEY');
});

test('A: a seal key shorter than 32 bytes is refused, as a string or as a Buffer', async () => {
  const s = scenario();
  const people = Object.fromEntries(s.plan.payments.map((p) => [p.participantId, { name: p.name, wallet: p.wallet }]));
  for (const bad of ['short', Buffer.alloc(31), 12345, '']) {
    assert.throws(() => kit.plan(s.program, s.tenant, { standings: s.standings, people, now: NOW, sealKey: bad }), (e) => e.statusCode === 400 && e.code === 'INVALID_SEAL_KEY');
    assert.throws(() => kit.createProgram({ tenant: { id: 'acme', network: 'testnet' }, program: s.program, sealKey: bad }), (e) => e.code === 'INVALID_SEAL_KEY');
    await assert.rejects(buildOf(s, { sealKey: bad }), (e) => e.code === 'INVALID_SEAL_KEY');
  }
  assert.ok(kit.createProgram({ tenant: { id: 'acme', network: 'testnet' }, program: s.program, sealKey: 'x'.repeat(32) }));
});

test('A: createProgram with a sealKey seals every plan and requires the seal in build', async () => {
  const sealKey = 'k'.repeat(40);
  const program = simpleProgram();
  const harmony = kit.createProgram({ tenant: { id: 'acme-kit', network: 'testnet' }, program, sealKey });
  const s = scenario({ program });
  const people = Object.fromEntries(s.plan.payments.map((p) => [p.participantId, { name: p.name, wallet: p.wallet }]));
  const plan = harmony.plan({ standings: s.standings, people, now: NOW });
  assert.match(plan.seal, /^[0-9a-f]{64}$/);
  const input = { payer: s.payer.publicKey(), horizon: s.horizon, now: NOW };
  assert.ok(await harmony.build({ plan, ...input }));
  s.horizon = fakeHorizon(s.accounts);
  await assert.rejects(harmony.build({ plan: s.plan, payer: s.payer.publicKey(), horizon: s.horizon, now: NOW }), (e) => e.code === 'PLAN_NOT_SEALED');
});

// ── B. paying twice, and outcomes nobody knows ─────────────────────────────

const many = (n) => {
  const points = {};
  for (let i = 0; i < n; i++) points[`p${i}`] = 1 + i;
  return { program: simpleProgram({ payout: { model: 'proportional', pool: 1000 } }), points };
};
const sign = (s, b) => b.xdrs.map((x) => signXdr(x, s.payer));

test('B: a 504 on a transaction that WAS applied is an unknown outcome; rebuilding is refused; resubmitting the same XDRs pays exactly once', async () => {
  const s = scenario({ ...many(25), horizonOptions: { timeoutOn: new Set([1]) } });
  const built = await buildOf(s);
  assert.equal(built.xdrs.length, 2);
  const signed = sign(s, built);

  await assert.rejects(kit.submit(s.tenant, { built, signedXdrs: signed, horizon: s.horizon }), (e) => {
    assert.equal(e.statusCode, 504);
    assert.equal(e.code, 'SUBMISSION_UNKNOWN');
    assert.equal(e.unknownHash, built.hashes[1]);
    assert.deepEqual(e.submitted.map((t) => t.hash), [built.hashes[0]]);
    assert.deepEqual(e.notSent, []);
    assert.match(e.message, /may still be applied/);
    assert.match(e.message, /SAME signed transactions/);
    assert.match(e.message, /Never build this plan again/);
    return true;
  });
  assert.equal(s.horizon.submitted.length, 2, 'the network did apply the second transaction');

  // The natural (wrong) recovery, build again, is refused with the evidence found on the ledger.
  await assert.rejects(buildOf(s, { now: NOW + 600 }), (e) => {
    assert.equal(e.statusCode, 409);
    assert.equal(e.code, 'PLAN_ALREADY_SUBMITTED');
    assert.deepEqual([...e.hashes].sort(), [...built.hashes].sort());
    return true;
  });
  assert.deepEqual(s.horizon.calls.lookups[0], { account: s.payer.publicKey(), order: 'desc', limit: 200 });

  // The right recovery: the same signed transactions, which the network deduplicates by hash.
  const receipt = await kit.submit(s.tenant, { built, signedXdrs: signed, horizon: s.horizon });
  assert.deepEqual(receipt.transactions.map((t) => t.hash), built.hashes);
  assert.equal(s.horizon.submitted.length, 2, 'nothing was applied twice');
  assert.equal(s.horizon.appliedStroops(), BigInt(s.plan.total.replace('.', '')));
});

test('B: a 504 on a transaction that was NOT applied is also unknown; resubmitting applies it', async () => {
  const s = scenario({ ...many(25), horizonOptions: { dropOn: new Set([1]) } });
  const built = await buildOf(s);
  const signed = sign(s, built);
  await assert.rejects(kit.submit(s.tenant, { built, signedXdrs: signed, horizon: s.horizon }), (e) => e.code === 'SUBMISSION_UNKNOWN' && e.unknownHash === built.hashes[1]);
  assert.equal(s.horizon.submitted.length, 1);
  await kit.submit(s.tenant, { built, signedXdrs: signed, horizon: s.horizon });
  assert.equal(s.horizon.appliedStroops(), BigInt(s.plan.total.replace('.', '')));
});

test('B: a definitive rejection says which transaction failed and which were not sent', async () => {
  const s = scenario({ ...many(45), horizonOptions: { failAt: 1 } });
  const built = await buildOf(s);
  assert.equal(built.xdrs.length, 3);
  await assert.rejects(kit.submit(s.tenant, { built, signedXdrs: sign(s, built), horizon: s.horizon }), (e) => {
    assert.equal(e.statusCode, 502);
    assert.equal(e.code, 'TRANSACTION_REJECTED');
    assert.deepEqual(e.resultCodes, { transaction: 'tx_bad_seq' });
    assert.equal(e.failedHash, built.hashes[1]);
    assert.deepEqual(e.submitted.map((t) => t.hash), [built.hashes[0]]);
    assert.deepEqual(e.notSent, [built.hashes[2]]);
    return true;
  });
  assert.equal(s.horizon.submitted.length, 1, 'sending stops at the failure');
  // What did land carries the plan id: building the same plan again is refused too.
  await assert.rejects(buildOf(s), (e) => e.code === 'PLAN_ALREADY_SUBMITTED' && e.hashes.length === 1);
});

test('B: the memo is compared as bytes; other memos and other memo types do not block a build', async () => {
  const s = scenario({ points: { a: 1 } });
  const listing = (records) => ({ ...s.horizon, transactions: () => ({ forAccount() { return this; }, order() { return this; }, limit() { return this; }, call: async () => ({ records }) }) });
  const b64 = (hex) => Buffer.from(hex, 'hex').toString('base64');
  const payer = s.payer.publicKey();
  const at = { source_account: payer, created_at: new Date(NOW * 1000).toISOString() };
  const harmless = [
    { ...at, hash: 'h1', memo_type: 'text', memo: b64(s.plan.planId) },                  // right bytes, wrong memo type
    { ...at, hash: 'h2', memo_type: 'hash', memo: b64('ab'.repeat(32)) },                // another plan
    { ...at, hash: 'h3', memo_type: 'hash', memo: s.plan.planId },                       // hex, not base64: not what Horizon returns
    { ...at, hash: 'h4', memo_type: 'none' },
    // the right memo, but a transaction of somebody else that merely involves the payer
    { ...at, source_account: wallet(), hash: 'h6', memo_type: 'hash', memo: b64(s.plan.planId) },
  ];
  assert.ok(await buildOf(s, { horizon: listing(harmless) }));
  await assert.rejects(buildOf(s, { horizon: listing([...harmless, { ...at, hash: 'h5', memo_type: 'hash', memo: b64(s.plan.planId) }]) }),
    (e) => e.code === 'PLAN_ALREADY_SUBMITTED' && e.hashes.length === 1 && e.hashes[0] === 'h5');
});

test('B: checkAlreadySubmitted: false skips the lookup; alreadySubmitted: true refuses without one; a failed lookup is an error', async () => {
  const s = scenario({ points: { a: 1 } });
  const built = await buildOf(s);
  await kit.submit(s.tenant, { built, signedXdrs: sign(s, built), horizon: s.horizon });
  const lookups = () => s.horizon.calls.transactions;
  const before = lookups();
  assert.ok(await buildOf(s, { checkAlreadySubmitted: false }), 'the host opted out, e.g. because it records submissions itself');
  assert.equal(lookups(), before);

  const fresh = scenario({ points: { a: 1 } });
  await assert.rejects(buildOf(fresh, { alreadySubmitted: true }), (e) => e.statusCode === 409 && e.code === 'PLAN_ALREADY_SUBMITTED');
  assert.equal(fresh.horizon.calls.transactions, 0, 'no lookup was needed');

  const failing = scenario({ points: { a: 1 }, horizonOptions: { lookupError: new Error('horizon is down') } });
  await assert.rejects(buildOf(failing), (e) => /horizon is down/.test(e.message), 'fail closed: a lookup that fails is not a pass');

  // A horizon that cannot list transactions cannot be trusted to say "not submitted".
  const bare = scenario({ points: { a: 1 } });
  const { transactions, ...noLookup } = bare.horizon;
  await assert.rejects(buildOf(bare, { horizon: noLookup }), (e) => e.code === 'CANNOT_CHECK_SUBMISSIONS');
  assert.ok(await buildOf(bare, { horizon: noLookup, checkAlreadySubmitted: false }));
});

// ── C. an unlocks pocket for somebody who never activates ──────────────────

test('C: the unlocks pocket of somebody who cannot receive gets a payer claimant, never before the unlock', async () => {
  for (const [reclaimAfterDays, expectedDays] of [[10, 70], [90, 150]]) { // the later of the hold date and unlock + window
    const program = simpleProgram({ pockets: THREE_POCKETS, unreachable: { mode: 'hold', reclaimAfterDays } });
    const s = scenario({ program, points: { a: 60, b: 40, c: 10 }, funded: false });
    const [a, b, c] = s.plan.payments.map((p) => p.wallet);
    s.horizon = fakeHorizon({
      [s.payer.publicKey()]: account({ usdc: '1000000.0000000' }),
      [a]: account({ usdc: '0.0000000' }), // can receive
      [b]: account({}),                    // no trustline
      // c: no account
    });
    const built = await buildOf(s);
    const payer = s.payer.publicKey();
    const at = NOW + 60 * DAY;
    const reclaim = NOW + expectedDays * DAY;
    const unlocks = (w) => built.operations.filter((o) => o.wallet === w && o.kind === 'unlocks');

    // Somebody who can receive: nobody can ever take an unlocks pocket back.
    assert.equal(unlocks(a)[0].payerCanReclaimFrom, null);
    assert.equal(unlocks(a)[0].reason, undefined);
    // Somebody who cannot: the payer can, from max(unlock date + reclaim window, hold date): the person always
    // has the whole window after the unlock date to claim first.
    for (const w of [b, c]) {
      const [u] = unlocks(w);
      assert.equal(u.payerCanReclaimFrom, reclaim);
      assert.equal(u.claimableFrom, at);
      assert.equal(u.reason, w === b ? 'no trustline for the reward asset' : 'account does not exist');
      assert.deepEqual(claimantsOf(parse(built.xdrs[u.tx]).operations[u.index]), [
        { destination: w, predicate: { not: { before: at } } },
        { destination: payer, predicate: { not: { before: reclaim } } },
      ]);
    }
    // The reserve counts the second claimant: a: 1.0 (expires) + 0.5 (unlocks); b and c: 1 (hold) + 1 (expires) + 1 (unlocks).
    assert.equal(built.reserveXlm, 1.5 + 3 + 3);

    // The submit-side check accepts what build produced.
    const receipt = await kit.submit(s.tenant, { built, signedXdrs: sign(s, built), horizon: s.horizon });
    assert.equal(receipt.transactions.length, 1);
  }
});

test('C: skip mode leaves the unreachable person out altogether, unlocks included', async () => {
  const program = simpleProgram({ pockets: THREE_POCKETS, unreachable: { mode: 'skip' } });
  const s = scenario({ program, points: { a: 60, b: 40 }, funded: false });
  const [a] = s.plan.payments.map((p) => p.wallet);
  s.horizon = fakeHorizon({ [s.payer.publicKey()]: account({ usdc: '1000000.0000000' }), [a]: account({ usdc: '0.0000000' }) });
  const built = await buildOf(s);
  assert.equal(built.operations.every((o) => o.wallet === a), true);
  assert.equal(built.skipped.length, 1);
});

test('C: the payer date of an unlocks pocket for an unreachable person must be ahead of the validity window', async () => {
  // Hold date and unlock date both within the transaction validity window of "now".
  const program = simpleProgram({
    pockets: [{ id: 'now', label: 'Now', share: 0.5, rule: { type: 'instant' } }, { id: 'later', label: 'Later', share: 0.5, rule: { type: 'unlocks', afterSeconds: 600 } }],
    unreachable: { mode: 'hold', reclaimAfterDays: 1 },
  });
  const s = scenario({ program, points: { a: 1 }, funded: false });
  s.horizon = fakeHorizon({ [s.payer.publicKey()]: account({ usdc: '1000000.0000000' }) });
  assert.ok(await buildOf(s));
  // Built a day later the hold date is in the past or too close: the plan is refused, as for any hold.
  await assert.rejects(buildOf(s, { now: NOW + DAY - 100 }), (e) => e.statusCode === 409 && e.code === 'PLAN_EXPIRED');
});

// ── F. a trustline that cannot really receive ──────────────────────────────

test('F: an unauthorized trustline, or one without room, is "unreachable" with the reason recorded', async () => {
  const program = simpleProgram({ unreachable: { mode: 'hold', reclaimAfterDays: 10 } });
  const s = scenario({ program, points: { ok: 40, edge: 30, noauth: 10, small: 10, liab: 10 }, funded: false });
  const w = Object.fromEntries(s.plan.payments.map((p) => [p.participantId, p.wallet]));
  const amount = (id) => s.plan.payments.find((p) => p.participantId === id).amount; // 40, 30, 10, 10, 10
  assert.equal(amount('edge'), '30.0000000');
  s.horizon = fakeHorizon({
    [s.payer.publicKey()]: account({ usdc: '1000000.0000000' }),
    [w.ok]: account({ usdc: '0.0000000', limit: '922337203685.4775807', authorized: true }),
    [w.edge]: account({ usdc: '5.0000000', limit: '35.0000000' }), // room 30 = exactly the payment
    [w.noauth]: account({ usdc: '0.0000000', authorized: false }),
    [w.small]: account({ usdc: '0.0000000', limit: '9.9999999' }),
    [w.liab]: account({ usdc: '0.0000000', limit: '15.0000000', buyingLiabilities: '5.0000001' }),
  });
  const built = await buildOf(s);
  const row = (id) => built.operations.find((o) => o.participantId === id);
  assert.equal(row('ok').kind, 'payment');
  assert.equal(row('edge').kind, 'payment');
  assert.deepEqual([row('noauth').kind, row('noauth').reason], ['hold', 'trustline not authorized']);
  assert.deepEqual([row('small').kind, row('small').reason], ['hold', 'trustline limit too low']);
  assert.deepEqual([row('liab').kind, row('liab').reason], ['hold', 'trustline limit too low']);
  // Nothing is ever a plain payment to somebody who cannot receive it: the whole batch is applicable.
  assert.equal(built.operations.filter((o) => o.kind === 'payment').length, 2);
});

test('F: in skip mode they are left out, with the reason', async () => {
  const program = simpleProgram({ unreachable: { mode: 'skip' } });
  const s = scenario({ program, points: { a: 60, b: 30, c: 10 }, funded: false });
  const [a, b, c] = s.plan.payments.map((p) => p.wallet);
  s.horizon = fakeHorizon({
    [s.payer.publicKey()]: account({ usdc: '1000000.0000000' }),
    [a]: account({ usdc: '0.0000000' }),
    [b]: account({ usdc: '0.0000000', authorized: false }),
    [c]: account({ usdc: '0.0000000', limit: '1.0000000' }),
  });
  const built = await buildOf(s);
  assert.deepEqual(built.skipped.map((x) => [x.participantId, x.reason]), [['b', 'trustline not authorized'], ['c', 'trustline limit too low']]);
});

test('F: the room needed is the sum of the instant pockets only', async () => {
  const s = scenario({ program: simpleProgram({ pockets: THREE_POCKETS }), points: { a: 1 }, funded: false });
  const [a] = s.plan.payments.map((p) => p.wallet);
  // The instant pocket is 50; a limit of 50 is enough even though the person's whole reward is 100.
  s.horizon = fakeHorizon({ [s.payer.publicKey()]: account({ usdc: '1000000.0000000' }), [a]: account({ usdc: '0.0000000', limit: '50.0000000' }) });
  assert.equal((await buildOf(s)).operations[0].kind, 'payment');
});

test('G: a payer holding a billion units of the asset still builds', async () => {
  const s = scenario({ usdc: '1000000000.0000000', points: { a: 1 } });
  const built = await buildOf(s);
  assert.equal(built.payerBalance, '1000000000.0000000');
});
