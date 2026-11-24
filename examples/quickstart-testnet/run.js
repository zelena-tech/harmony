'use strict';

/**
 * Harmony kit on the REAL Stellar testnet, end to end.
 *
 *   node examples/quickstart-testnet/run.js [templateId]      (default: last-mile-delivery)
 *
 * This script plays every role itself, and says so as it goes: the issuer of a
 * test asset (TESTUSD), the payer, and each person's own wallet. Every key is
 * generated in memory when the script starts, is never written to disk and is
 * never printed: only public keys and transaction hashes appear on screen and
 * in out/summary.json. The tenant is hard-coded to testnet.
 *
 * What it proves, on the public ledger: instant payments, a hold for somebody
 * with no trustline and for somebody with no account, one-signature claiming
 * (trustline + claim in a single transaction), and a time lock that the
 * network itself enforces.
 */

const fs = require('node:fs');
const path = require('node:path');
const { sdk, HarmonyError } = require('../../packages/core');
const kit = require('../../packages/kit/src');
const { FIRST_NAMES, SKILL, syntheticActivity } = require('./synthetic');

const NETWORK = 'testnet'; // not configurable on purpose: this script moves (worthless) test money only
const HORIZON = 'https://horizon-testnet.stellar.org';
const FRIENDBOT = 'https://friendbot.stellar.org';
const EXPLORER = 'https://stellar.expert/explorer/testnet';
const OUT_DIR = path.join(__dirname, 'out');
const ASSET_CODE = 'TESTUSD';
const UNLOCK_AFTER_SECONDS = 45;
const EXPIRES_AFTER_SECONDS = 7200;

// ── small helpers ────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);
const txUrl = (hash) => `${EXPLORER}/tx/${hash}`;
const acctUrl = (id) => `${EXPLORER}/account/${id}`;
const iso = (t) => new Date(t * 1000).toISOString().replace('.000Z', 'Z');
const log = (s = '') => console.log(s);
const note = (s) => console.log(`    ${s}`);
const started = Date.now();
const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;

function stage(n, title) {
  log();
  log(`=== STAGE ${n}/9  ${title}  [${elapsed()}]`);
}

class Unreachable extends Error {}

/** Retries a network read a few times with a short, growing backoff. */
async function retry(label, fn, tries = 4) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); } catch (e) {
      // A refusal of the kit or of the network is an answer, not a flaky connection.
      if (e instanceof HarmonyError || (e && e.response && e.response.status && e.response.status < 500 && e.response.status !== 429)) throw e;
      last = e;
      if (i < tries) { note(`(${label}: ${e.message}; retrying ${i}/${tries - 1})`); await sleep(1200 * i); }
    }
  }
  throw new Unreachable(`${label}: ${last && last.message}`);
}

const server = new sdk.Horizon.Server(HORIZON);

async function friendbot(publicKey) {
  return retry('friendbot', async () => {
    const res = await fetch(`${FRIENDBOT}?addr=${publicKey}`);
    if (res.status >= 500 || res.status === 429) { const e = new Error(`HTTP ${res.status}`); throw e; }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(`friendbot refused: ${body.detail || res.status}`);
      e.response = { status: res.status };
      throw e;
    }
    return body.hash || (body.successful_transaction_hash) || null;
  });
}

/** Builds, signs with `signer` and submits one classic transaction; returns its hash. */
async function send(signer, operations, label) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const account = await retry(`load ${label}`, () => server.loadAccount(signer.publicKey()));
      const b = new sdk.TransactionBuilder(account, { fee: '1000', networkPassphrase: sdk.Networks.TESTNET });
      operations.forEach((o) => b.addOperation(o));
      const tx = b.setTimeout(120).build();
      tx.sign(signer);
      const res = await server.submitTransaction(tx);
      return res.hash;
    } catch (e) {
      const codes = e && e.response && e.response.data && e.response.data.extras && e.response.data.extras.result_codes;
      if (codes && codes.transaction !== 'tx_bad_seq') throw new Error(`${label} failed: ${JSON.stringify(codes)}`);
      if (attempt === 3) throw new Unreachable(`${label}: ${codes ? JSON.stringify(codes) : e.message}`);
      await sleep(1500 * attempt);
    }
  }
  return null;
}

/** Close time (unix seconds) of the latest ledger: the clock the network uses for claim predicates. */
async function ledgerTime() {
  const page = await retry('latest ledger', () => server.ledgers().order('desc').limit(1).call());
  return Math.floor(Date.parse(page.records[0].closed_at) / 1000);
}

async function balanceOf(publicKey, asset) {
  const a = await retry('account', () => server.loadAccount(publicKey));
  const line = a.balances.find((b) => b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer());
  return { amount: line ? line.balance : null, account: a };
}

const signAll = (xdrs, keypair) => xdrs.map((x) => {
  const tx = sdk.TransactionBuilder.fromXDR(x, sdk.Networks.TESTNET);
  tx.sign(keypair);
  return tx.toXDR();
});

const countBy = (items, key) => items.reduce((m, i) => { m[i[key]] = (m[i[key]] || 0) + 1; return m; }, {});

// ── the run ──────────────────────────────────────────────────────────────────

async function main() {
  const templateId = process.argv[2] || 'last-mile-delivery';
  kit.template(templateId); // fails early, listing the available templates, if the id is unknown

  log('Harmony kit on the REAL Stellar testnet. Only test money, only testnet. This script plays every role:');
  log('  issuer of TESTUSD, the payer, and the wallet of each person. Keys live in memory and are never saved or shown.');
  try { await retry('horizon', () => server.root(), 3); } catch (e) {
    log(`\nThe Stellar testnet is not reachable (${e.message}). Check your connection, or try again in a few minutes.`);
    process.exit(1);
  }

  const summary = { network: NETWORK, template: templateId, date: new Date().toISOString(), setup: {}, accounts: {}, payout: {}, claims: {} };
  const issuer = sdk.Keypair.random();
  const payer = sdk.Keypair.random();
  const people = FIRST_NAMES.slice(0, 4).map((name, i) => ({ letter: 'ABCD'[i], id: name.toLowerCase(), name, keypair: sdk.Keypair.random(), skill: SKILL[name] }));
  const [A, B, C, D] = people;
  const asset = new sdk.Asset(ASSET_CODE, issuer.publicKey());

  // ── 1. accounts, asset, trustlines ─────────────────────────────────────────
  stage(1, 'Accounts, the TESTUSD asset and trustlines');
  const funded = [['issuer', issuer], ['payer', payer], ...people.slice(0, 3).map((p) => [`person ${p.letter} (${p.name})`, p.keypair])];
  await Promise.all(funded.map(([, kp]) => friendbot(kp.publicKey())));
  funded.forEach(([role, kp]) => note(`${pad(role, 18)} ${kp.publicKey()}   funded with testnet XLM by friendbot`));
  note(`${pad(`person D (${D.name})`, 18)} ${D.keypair.publicKey()}   keypair only: NO account on the network`);
  summary.accounts = {
    issuer: issuer.publicKey(), payer: payer.publicKey(),
    ...Object.fromEntries(people.map((p) => [`person${p.letter}`, p.keypair.publicKey()])),
  };

  const trusts = await Promise.all([payer, A.keypair, B.keypair].map((kp, i) => send(kp, [sdk.Operation.changeTrust({ asset })], `trustline ${i}`)));
  note(`trustline TESTUSD: payer      ${txUrl(trusts[0])}`);
  note(`trustline TESTUSD: ${A.name}        ${txUrl(trusts[1])}`);
  note(`trustline TESTUSD: ${B.name}       ${txUrl(trusts[2])}`);
  note(`(${C.name} has no trustline on purpose; ${D.name} has no account)`);
  const issued = await send(issuer, [sdk.Operation.payment({ destination: payer.publicKey(), asset, amount: '10000' })], 'issue TESTUSD');
  note(`issuer pays 10000 ${ASSET_CODE} to the payer   ${txUrl(issued)}`);
  summary.setup = { trustlines: { payer: trusts[0], personA: trusts[1], personB: trusts[2] }, issued };

  // ── 2. the program ─────────────────────────────────────────────────────────
  stage(2, 'The program, from the template, with short time rules');
  const base = kit.template(templateId);
  const overrides = {};
  if (base.pockets && base.pockets.some((k) => k.rule.type !== 'instant')) {
    overrides.pockets = base.pockets.map((k) => ({
      id: k.id, label: k.label, share: k.share,
      rule: k.rule.type === 'unlocks' ? { type: 'unlocks', afterSeconds: UNLOCK_AFTER_SECONDS }
        : k.rule.type === 'expires' ? { type: 'expires', afterSeconds: EXPIRES_AFTER_SECONDS } : { type: 'instant' },
    }));
  }
  const harmony = kit.createProgram({
    tenant: { id: 'quickstart', network: NETWORK, rewardAsset: { code: ASSET_CODE, issuer: issuer.publicKey() }, payouts: { payerWallet: payer.publicKey() } },
    program: templateId,
    overrides: Object.keys(overrides).length ? overrides : undefined,
  });
  if (harmony.tenant.network !== 'testnet') throw new Error('Refusing to run: this example only runs on testnet.');
  const program = harmony.program;
  note(`${program.name} (${program.id}), payout ${program.payout.model}, ${program.levels.length} levels, ${program.metrics.length} metrics`);
  for (const k of program.pockets) {
    const when = k.rule.type === 'instant' ? '' : `  after ${k.rule.afterSeconds} s`;
    note(`pocket ${pad(k.label, 18)} ${rpad(k.shareBp / 100, 5)} %  ${k.rule.type}${when}`);
  }
  const hasUnlocks = program.pockets.some((k) => k.rule.type === 'unlocks');
  const hasExpires = program.pockets.some((k) => k.rule.type === 'expires');

  // ── 3. work, score, plan ───────────────────────────────────────────────────
  stage(3, 'Synthetic work, scoring and plan');
  const { events, lifetime } = syntheticActivity(program, people, 21);
  const { standings } = harmony.score({ events, lifetime });
  const roster = people.map((p) => ({ participantId: p.id, name: p.name, wallet: p.keypair.publicKey() }));
  const nameOf = Object.fromEntries(people.map((p) => [p.id, `${p.name} (${p.letter})`]));
  note(`${events.length} invented events for 4 invented people`);
  for (const s of standings) {
    note(`#${s.rank} ${pad(nameOf[s.participantId], 14)} ${rpad(s.adjustedPoints, 6)} pts   ${s.level.name} x${s.level.multiplier}   ${s.qualified ? '' : '(not qualified)'}`);
  }
  const plan = harmony.plan({ standings, people: roster });
  note(`plan ${plan.planId.slice(0, 16)}...  total ${plan.total} ${ASSET_CODE}  (created ${iso(plan.createdAt)})`);
  for (const p of plan.payments) {
    note(`${pad(nameOf[p.participantId], 14)} ${rpad(p.amount, 12)}  ${p.pockets.map((k) => `${k.label} ${k.amount}`).join(' | ')}`);
  }

  // ── 4. build, sign, submit ─────────────────────────────────────────────────
  stage(4, 'Build, sign (the payer, in this script) and submit');
  const built = await retry('build', () => harmony.build({ plan, payer: payer.publicKey() }));
  const kinds = countBy(built.operations, 'kind');
  note(`${built.operations.length} operations in ${built.xdrs.length} transaction(s): ${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ')}`);
  note(`XLM reserve the payer locks (returned when claimed): ${built.reserveXlm}   fee bid: ${built.feeXlm} XLM   total ${built.total} ${ASSET_CODE}`);
  for (const p of people) {
    const mine = built.operations.filter((o) => o.participantId === p.id);
    note(`${pad(nameOf[p.id], 14)} ${mine.map((o) => `${o.pocketId}:${o.kind}`).join('  ')}`);
  }
  const receipt = await harmony.submit({ built, signedXdrs: signAll(built.xdrs, payer) });
  const payoutHashes = receipt.transactions.map((t) => t.hash);
  receipt.transactions.forEach((t, i) => note(`transaction ${i + 1}/${receipt.transactions.length}  ledger ${t.ledger}  ${txUrl(t.hash)}`));
  summary.payout = { planId: plan.planId, hashes: payoutHashes, total: plan.total, operations: built.operations.map((o) => ({ person: o.participantId, pocket: o.pocketId, kind: o.kind, amount: o.amount, balanceId: o.balanceId, tx: payoutHashes[o.tx] })) };

  // What the network says about it: the reserve, the fee and the balance ids the kit predicted.
  const payerAccount = (await balanceOf(payer.publicKey(), asset)).account;
  const expectedClaimants = Math.round(built.reserveXlm / 0.5);
  note(`check: payer now sponsors ${payerAccount.num_sponsoring} entries (the kit counted ${expectedClaimants} claimants)  ${Number(payerAccount.num_sponsoring) === expectedClaimants ? 'OK' : 'DIFFERENT'}`);
  const charged = (await Promise.all(payoutHashes.map((h) => retry('transaction', () => server.transactions().transaction(h).call())))).reduce((s, t) => s + Number(t.fee_charged), 0);
  note(`check: fee charged by the network ${charged / 1e7} XLM (the kit reported the bid, ${built.feeXlm})`);
  const claimableOps = built.operations.filter((o) => o.balanceId);
  const found = await Promise.all(claimableOps.map((o) => retry('balance', () => server.claimableBalances().claimableBalance(o.balanceId).call().then(() => true, (e) => { if (e.response && e.response.status === 404) return false; throw e; }))));
  note(`check: ${found.filter(Boolean).length}/${claimableOps.length} balance ids predicted by build() exist on the network  ${found.every(Boolean) ? 'OK' : 'MISMATCH'}`);

  // ── 5. the same plan cannot be built (and paid) again ──────────────────────
  stage(5, 'The same plan cannot be paid twice');
  let refusedRebuild = null;
  for (let attempt = 1; attempt <= 4 && !refusedRebuild; attempt++) {
    try { await retry('rebuild', () => harmony.build({ plan, payer: payer.publicKey() })); } catch (e) {
      if (!(e instanceof HarmonyError)) throw e;
      refusedRebuild = e;
    }
    if (!refusedRebuild) { note(`(Horizon has not listed the payment yet; looking again ${attempt}/4)`); await sleep(2000); }
  }
  if (!refusedRebuild || refusedRebuild.code !== 'PLAN_ALREADY_SUBMITTED') {
    throw new Error(`Expected build() to refuse the same plan with PLAN_ALREADY_SUBMITTED, got: ${refusedRebuild ? `${refusedRebuild.code} ${refusedRebuild.message}` : 'a successful build'}`);
  }
  note(`EXPECTED OUTCOME: build() refused the same plan (HTTP ${refusedRebuild.statusCode}, ${refusedRebuild.code}).`);
  note(`It read the payer's latest transactions on Horizon and found ${refusedRebuild.hashes.length} with this plan id as memo:`);
  refusedRebuild.hashes.forEach((h) => note(`  ${txUrl(h)}`));
  const sameHashes = refusedRebuild.hashes.length === payoutHashes.length && payoutHashes.every((h) => refusedRebuild.hashes.includes(h));
  note(`check: they are exactly the ${payoutHashes.length} transaction(s) of the payout  ${sameHashes ? 'OK' : 'DIFFERENT'}`);
  summary.payout.rebuildRefused = { code: refusedRebuild.code, statusCode: refusedRebuild.statusCode, hashes: refusedRebuild.hashes };

  // ── 6. C claims everything claimable now, with one transaction ─────────────
  stage(6, `${C.name} (C) claims everything that is claimable now, with ONE signature`);
  const cList = await retry('claimable C', () => harmony.listClaimable({ wallet: C.keypair.publicKey() }));
  note(`${cList.length} balances wait for ${C.name}:`);
  cList.forEach((b) => note(`  ${rpad(b.amount, 12)}  ${b.claimableNow ? 'claimable now' : `locked until ${iso(b.from)}`}   ${b.balanceId.slice(0, 16)}...`));
  const cNow = cList.filter((b) => b.claimableNow).map((b) => b.balanceId);
  const cBefore = await balanceOf(C.keypair.publicKey(), asset);
  note(`${C.name} before: ${ASSET_CODE} balance ${cBefore.amount === null ? 'no trustline' : cBefore.amount}`);
  const cClaim = await retry('buildClaim C', () => harmony.buildClaim({ wallet: C.keypair.publicKey(), balanceIds: cNow }));
  const cSigned = signAll(cClaim.xdrs, C.keypair);
  const cTypes = sdk.TransactionBuilder.fromXDR(cSigned[0], sdk.Networks.TESTNET).operations.map((o) => o.type);
  note(`the transaction has ${cTypes.length} operations: ${Object.entries(countBy(cTypes.map((t) => ({ t })), 't')).map(([t, n]) => `${n} x ${t}`).join(', ')}   (adds the trustline: ${cClaim.addsTrustline})`);
  const cReceipt = await harmony.submitClaim({ wallet: C.keypair.publicKey(), signedXdrs: cSigned });
  cReceipt.transactions.forEach((t) => note(`claim transaction  ledger ${t.ledger}  ${txUrl(t.hash)}`));
  const cOps = await retry('operations', () => server.operations().forTransaction(cReceipt.transactions[0].hash).call());
  note(`Horizon confirms the operations: ${cOps.records.map((o) => o.type).join(', ')}`);
  const cAfter = await balanceOf(C.keypair.publicKey(), asset);
  note(`${C.name} after:  ${ASSET_CODE} balance ${cAfter.amount}   ${Number(cAfter.amount) > 0 && cTypes.includes('changeTrust') ? 'OK: paid, with a trustline created in the same transaction' : 'UNEXPECTED'}`);
  summary.claims.personC = { hashes: cReceipt.transactions.map((t) => t.hash), claimed: cNow, addedTrustline: cClaim.addsTrustline, balanceAfter: cAfter.amount };

  // ── 6. the time lock, enforced by the network ──────────────────────────────
  stage(7, 'The time lock, proven on the network');
  let unlockProof = null;
  if (!hasUnlocks) note('This template has no "unlocks" pocket: stage skipped.');
  else {
    const aList = await retry('claimable A', () => harmony.listClaimable({ wallet: A.keypair.publicKey(), now: plan.createdAt }));
    const locked = aList.filter((b) => b.from !== null);
    const unlockAt = locked[0].from;
    note(`${A.name} (A) has ${locked.length} locked balance(s), claimable from ${iso(unlockAt)}`);
    const nowLedger = await ledgerTime();
    note(`ledger clock now ${iso(nowLedger)}  (${unlockAt - nowLedger} s before the unlock)`);
    const early = await harmony.buildClaim({ wallet: A.keypair.publicKey(), balanceIds: locked.map((b) => b.balanceId) });
    let refused = null;
    const earlySigned = signAll(early.xdrs, A.keypair);
    const earlyHash = sdk.TransactionBuilder.fromXDR(earlySigned[0], sdk.Networks.TESTNET).hash().toString('hex');
    try { await harmony.submitClaim({ wallet: A.keypair.publicKey(), signedXdrs: earlySigned }); } catch (e) {
      if (!(e instanceof HarmonyError) || e.statusCode !== 502) throw e;
      refused = e;
    }
    if (refused) {
      note('EXPECTED OUTCOME: the network refused the early claim.');
      note(`result codes: ${JSON.stringify(refused.resultCodes)}`);
      note(`(a failed transaction is still recorded, and its fee charged)  ${txUrl(earlyHash)}`);
    } else {
      note('The early claim went through: the unlock time had already passed when it arrived (this run was slow), so the lock was not demonstrated. Run it again.');
    }
    const t0 = Date.now();
    let t = await ledgerTime();
    while (t < unlockAt) {
      process.stdout.write(`\r    waiting for the unlock: ${Math.max(0, unlockAt - t)} s to go (network clock)   `);
      await sleep(2500);
      t = await ledgerTime();
    }
    process.stdout.write(`\r    unlock time reached on the network clock after ${Math.round((Date.now() - t0) / 1000)} s of waiting.         \n`);
    if (refused) {
      const remaining = (await harmony.listClaimable({ wallet: A.keypair.publicKey(), now: t })).filter((b) => locked.some((l) => l.balanceId === b.balanceId));
      const late = await harmony.buildClaim({ wallet: A.keypair.publicKey(), balanceIds: remaining.map((b) => b.balanceId) });
      const lateReceipt = await harmony.submitClaim({ wallet: A.keypair.publicKey(), signedXdrs: signAll(late.xdrs, A.keypair) });
      lateReceipt.transactions.forEach((x) => note(`claim after the unlock: ledger ${x.ledger}  ${txUrl(x.hash)}   OK`));
      unlockProof = { refusedCodes: refused.resultCodes, refusedHash: earlyHash, claimedAfter: lateReceipt.transactions.map((x) => x.hash), unlockAt };
    }
    summary.claims.personA = unlockProof;
  }

  // ── 7. D: money waiting for an account that does not exist ─────────────────
  stage(8, `${D.name} (D): money waiting for an account that does not exist yet`);
  const dList = await retry('claimable D', () => harmony.listClaimable({ wallet: D.keypair.publicKey() }));
  dList.forEach((b) => note(`${rpad(b.amount, 12)} ${ASSET_CODE}  ${b.from !== null ? `from ${iso(b.from)}` : b.until !== null ? `until ${iso(b.until)}` : 'any time'}   ${b.balanceId.slice(0, 16)}...`));
  try { await harmony.buildClaim({ wallet: D.keypair.publicKey(), balanceIds: dList.map((b) => b.balanceId) }); } catch (e) {
    if (!(e instanceof HarmonyError)) throw e;
    note(`${D.name} cannot claim yet (${e.code}): ${e.message}`);
  }
  const dOps = built.operations.filter((o) => o.participantId === D.id);
  for (const o of dOps.filter((x) => x.kind === 'unlocks')) {
    const rec = await retry('balance of D', () => server.claimableBalances().claimableBalance(o.balanceId).call());
    const payerClaimant = rec.claimants.find((c) => c.destination === payer.publicKey());
    note(`pocket "${o.pocketId}" (unlocks) of ${D.name}: ${rec.claimants.length} claimants on the network; payer can take it back from ${o.payerCanReclaimFrom ? iso(o.payerCanReclaimFrom) : 'never'}  ${payerClaimant ? 'OK: not locked forever' : 'UNEXPECTED: no payer claimant'}`);
  }
  note(`The payer can take the held money back only after ${iso(plan.createdAt + program.unreachable.reclaimAfterSeconds)}.`);
  summary.claims.personD = { waiting: dList.map((b) => ({ balanceId: b.balanceId, amount: b.amount })) };

  // ── 8. cards and summary ───────────────────────────────────────────────────
  stage(9, 'Harmony Cards and summary');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const pay of plan.payments) {
    const person = roster.find((r) => r.participantId === pay.participantId);
    const c = harmony.card({ participant: person, standing: standings.find((s) => s.participantId === pay.participantId), of: standings.length, payment: pay, receipt, period: 'Week 1' });
    fs.writeFileSync(path.join(OUT_DIR, `${pay.participantId}.svg`), harmony.renderCardSvg(c));
  }
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  note(`${plan.payments.length} cards and summary.json written to ${path.relative(process.cwd(), OUT_DIR) || '.'}${path.sep} (public data only)`);
  log(`\nDone in ${elapsed()}. Explorer: ${acctUrl(payer.publicKey())}`);
  log('Testnet is reset periodically: these links stop resolving after a reset.');
}

main().catch((e) => {
  if (e instanceof Unreachable) {
    console.error(`\nThe Stellar testnet did not answer (${e.message}). Check your connection, or try again in a few minutes.`);
  } else {
    console.error(`\nFailed: ${e.message}`);
    if (e instanceof HarmonyError) console.error(JSON.stringify({ code: e.code, resultCodes: e.resultCodes }));
  }
  process.exit(1);
});
