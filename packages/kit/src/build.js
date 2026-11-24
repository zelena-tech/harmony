'use strict';

const crypto = require('node:crypto');
const { HarmonyError, payouts, networks, sdk } = require('@zelena/harmony-core');
const { toStroops, fromStroops, splitByBasisPoints, MAX_STROOPS } = require('./money');
const { assertPlanIntegrity, assertSealKey, sealOf } = require('./plan');

/**
 * From a plan to UNSIGNED Stellar transactions. Non-custodial: the kit never
 * sees a secret key; the payer signs in its own wallet.
 *
 * Each pocket of each payment becomes one operation:
 *
 *   instant  -> payment
 *   expires  -> claimable balance: the person can claim BEFORE the date;
 *               from that date on, the payer can take it back
 *   unlocks  -> claimable balance: the person can claim only FROM the date on;
 *               the payer can never take it back
 *
 * Someone who cannot receive yet (the account does not exist, or its trustline
 * for the reward asset is missing, not authorized or too small for the
 * payment) is not left out: with `unreachable.mode = 'hold'` the instant pocket
 * becomes a claimable balance that waits for them, and that the payer can take
 * back after `reclaimAfterDays`. Their `unlocks` pockets get the same payer
 * claimant (never earlier than the unlock date), so that money cannot stay
 * locked forever for someone who never activates the account.
 *
 * Trust. `planId` is a checksum, not authentication. `build` therefore
 * re-derives every pocket from the PROGRAM and refuses a plan whose pockets,
 * rules, dates or amounts differ (PLAN_ALTERED). It cannot know whether the
 * wallets are the right ones: for that, pass `wallets` (the organization's
 * registered wallets) and/or seal the plan with `sealKey` (see plan()).
 *
 * Paying twice. `build` looks for a transaction of the payer that carries
 * this plan id as memo and refuses (PLAN_ALREADY_SUBMITTED) if it finds one.
 *
 * A claimable balance costs the payer one base reserve (0.5 XLM) per claimant;
 * the network returns it when the balance is claimed. `build` reports that
 * reserve and refuses to build if the payer cannot cover it.
 *
 * Freshness. Pocket and hold dates are computed from `plan.createdAt`, so a
 * plan that is built late could produce a balance the payer may take back at
 * once. `build` therefore refuses (HarmonyError 409, code PLAN_EXPIRED) when
 * the plan is older than `maxPlanAgeSeconds`, when the clock is earlier than
 * the plan (beyond a small skew), or when a date after which the payer may
 * take money back is not at least `payouts.TIMEOUT_SECONDS` (the validity
 * window of the transactions) in the future. An `unlocks` date in the past is
 * harmless: that pocket is simply claimable at once.
 */

const OPS_PER_TX = networks.PAYMENTS_PER_TX;
const BASE_RESERVE_XLM = 0.5;

const DEFAULT_MAX_PLAN_AGE_SECONDS = 86400;
const CLOCK_SKEW_SECONDS = 300;

const before = (t) => sdk.Claimant.predicateBeforeAbsoluteTime(String(t));
const notBefore = (t) => sdk.Claimant.predicateNot(before(t));
const isNotFound = (e) => e && e.response && e.response.status === 404;

/** The claimants of a claimable pocket. */
function claimantsFor(kind, wallet, payer, at, reclaimAt = null) {
  if (kind === 'expires') return [new sdk.Claimant(wallet, before(at)), new sdk.Claimant(payer, notBefore(at))];
  if (kind === 'unlocks') {
    // `reclaimAt` is given only for someone who cannot receive: the payer can then take the pocket back.
    return reclaimAt === null || reclaimAt === undefined
      ? [new sdk.Claimant(wallet, notBefore(at))]
      : [new sdk.Claimant(wallet, notBefore(at)), new sdk.Claimant(payer, notBefore(reclaimAt))];
  }
  return [new sdk.Claimant(wallet, sdk.Claimant.predicateUnconditional()), new sdk.Claimant(payer, notBefore(at))]; // hold
}

/**
 * Re-derives the pockets of every payment from the program and refuses the plan
 * if anything differs: pocket ids and order, rule type, date, amounts.
 */
function assertPocketsFromProgram(program, plan) {
  const altered = (why) => { throw new HarmonyError(400, `The plan does not match the program: ${why}.`, { code: 'PLAN_ALTERED' }); };
  if (!Number.isInteger(plan.createdAt) || plan.createdAt <= 0) altered('createdAt is not a unix time');
  const bps = program.pockets.map((k) => k.shareBp);
  for (const p of plan.payments) {
    const who = p.name || p.participantId;
    const parts = splitByBasisPoints(toStroops(p.amount), bps);
    const expected = program.pockets
      .map((k, i) => ({ k, amount: fromStroops(parts[i]), part: parts[i] }))
      .filter((x) => x.part > 0n);
    const got = p.pockets || [];
    if (got.length !== expected.length) altered(`the pockets of ${who} are not those of the program`);
    expected.forEach((x, i) => {
      const g = got[i];
      const at = x.k.rule.type === 'instant' ? null : plan.createdAt + x.k.rule.afterSeconds;
      if (!g || g.id !== x.k.id || g.amount !== x.amount || !g.rule || g.rule.type !== x.k.rule.type || g.rule.at !== at) {
        altered(`pocket "${x.k.id}" of ${who} differs from the program (id, amount, rule or date)`);
      }
    });
  }
}

/** Seal check: with a sealKey the plan MUST carry a valid seal. */
function assertSeal(plan, sealKey) {
  assertSealKey(sealKey);
  if (typeof plan.seal !== 'string') throw new HarmonyError(400, 'The plan is not sealed: it did not come from this server.', { code: 'PLAN_NOT_SEALED' });
  const expected = Buffer.from(sealOf(plan.planId, sealKey), 'hex');
  const given = /^[0-9a-f]{64}$/.test(plan.seal) ? Buffer.from(plan.seal, 'hex') : Buffer.alloc(0);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    throw new HarmonyError(400, 'The seal of the plan is not valid: the plan was altered or sealed with another key.', { code: 'PLAN_ALTERED' });
  }
}

/** Hashes of the payer's recent transactions that carry `planId` as hash memo. Fails closed. */
async function findSubmissions(h, payer, planId) {
  if (typeof h.transactions !== 'function') {
    throw new HarmonyError(400, 'This horizon cannot list transactions, so it cannot be checked whether the plan was already submitted. '
      + 'Pass checkAlreadySubmitted: false only if the host records submissions itself.', { code: 'CANNOT_CHECK_SUBMISSIONS' });
  }
  const page = await h.transactions().forAccount(payer).order('desc').limit(200).call();
  const want = Buffer.from(planId, 'hex');
  return (page.records || [])
    .filter((r) => r.memo_type === 'hash' && typeof r.memo === 'string' && Buffer.from(r.memo, 'base64').equals(want))
    .map((r) => r.hash);
}

/** Why a recipient cannot take a plain payment of `need` stroops, or null when it can. */
function receiveProblem(account, asset, need) {
  if (!account) return 'account does not exist';
  const line = account.balances.find((b) => b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer());
  if (!line) return 'no trustline for the reward asset';
  if (line.is_authorized === false) return 'trustline not authorized';
  const limit = line.limit === undefined ? MAX_STROOPS : toStroops(line.limit);
  const room = limit - toStroops(line.balance || 0) - toStroops(line.buying_liabilities || 0);
  if (room < need) return 'trustline limit too low';
  return null;
}

/**
 * @param {object} program
 * @param {object} tenant
 * @param {object} input
 * @param {object} input.plan     plan() result, unaltered
 * @param {string} input.payer    account that will sign
 * @param {object} [input.horizon] injectable (loadAccount) for tests
 * @param {number} [input.baseReserveXlm] network base reserve, 0.5 XLM today
 * @param {number} [input.now]       unix seconds, default the clock (same convention as plan())
 * @param {number} [input.maxPlanAgeSeconds] oldest plan that may still be built, default 86400
 * @param {string|Buffer} [input.sealKey]  when given, the plan must carry a valid seal (PLAN_NOT_SEALED / PLAN_ALTERED)
 * @param {Array|Set} [input.wallets]      registered wallets of the organization: every payment wallet must be one (UNREGISTERED_DESTINATION)
 * @param {boolean} [input.checkAlreadySubmitted=true]  look for a transaction of the payer with this plan id as memo
 *        in its latest 200 (PLAN_ALREADY_SUBMITTED). A failed lookup is an error, never a pass.
 * @param {boolean} [input.alreadySubmitted]  the host knows it was submitted: refuse without looking
 */
async function build(program, tenant, {
  plan, payer, horizon, baseReserveXlm = BASE_RESERVE_XLM, now = Math.floor(Date.now() / 1000), maxPlanAgeSeconds = DEFAULT_MAX_PLAN_AGE_SECONDS,
  sealKey, wallets, checkAlreadySubmitted = true, alreadySubmitted = false,
}) {
  if (!networks.isAccountId(payer)) throw new HarmonyError(400, 'The payer wallet is not a Stellar account (G + 55 chars).');
  assertPlanIntegrity(plan);
  if (plan.tenantId !== tenant.id || plan.programId !== program.id || plan.network !== tenant.network
    || plan.asset.code !== tenant.rewardAsset.code || plan.asset.issuer !== tenant.rewardAsset.issuer) {
    throw new HarmonyError(400, 'The plan belongs to another tenant, program, network or asset.', { code: 'PLAN_MISMATCH' });
  }
  if (sealKey !== undefined && sealKey !== null) assertSeal(plan, sealKey);
  assertPocketsFromProgram(program, plan);
  if (wallets !== undefined && wallets !== null) {
    const registered = new Set(wallets);
    for (const p of plan.payments) {
      if (!registered.has(p.wallet)) {
        throw new HarmonyError(400, `The plan pays ${p.name || p.participantId} at a wallet that is not registered for this organization.`,
          { code: 'UNREGISTERED_DESTINATION', participantId: p.participantId });
      }
    }
  }
  const expected = tenant.payouts.payerWallet;
  if (tenant.network === 'mainnet' && expected && expected !== payer) {
    throw new HarmonyError(409, `The connected wallet (${payer.slice(0, 6)}…) is not the registered payer (${expected.slice(0, 6)}…).`,
      { code: 'UNEXPECTED_PAYER' });
  }
  if (!Number.isInteger(now) || now <= 0) throw new HarmonyError(400, 'now must be a unix time in seconds.');
  if (!Number.isFinite(maxPlanAgeSeconds) || maxPlanAgeSeconds <= 0) throw new HarmonyError(400, 'maxPlanAgeSeconds must be a number > 0.');
  const expired = (message, extra) => { throw new HarmonyError(409, message, { code: 'PLAN_EXPIRED', ...extra }); };
  if (now - plan.createdAt > maxPlanAgeSeconds) {
    expired(`The plan is too old to build (${now - plan.createdAt} s, the limit is ${maxPlanAgeSeconds} s): plan again.`, { ageSeconds: now - plan.createdAt, maxPlanAgeSeconds });
  }
  if (now < plan.createdAt - CLOCK_SKEW_SECONDS) {
    expired(`The clock is ${plan.createdAt - now} s earlier than the plan: check the clock of this machine.`, { skewSeconds: plan.createdAt - now });
  }
  // Defense in depth: the caps were applied when planning and are applied again here.
  payouts.applyCaps(plan.payments.map((p) => ({ name: p.name, wallet: p.wallet, amount: Number(p.amount) })), tenant.payouts.caps);

  if (alreadySubmitted === true) {
    throw new HarmonyError(409, 'The host says this plan was already submitted. Resubmit the SAME signed transactions if needed; never build it again.',
      { code: 'PLAN_ALREADY_SUBMITTED', hashes: [] });
  }

  const h = horizon || new sdk.Horizon.Server(tenant.horizonUrl);
  const asset = payouts.rewardAsset(tenant);
  let account;
  try { account = await h.loadAccount(payer); } catch (e) {
    if (isNotFound(e)) throw new HarmonyError(400, `The payer wallet does not exist on ${tenant.network}.`);
    throw e;
  }
  if (checkAlreadySubmitted !== false) {
    const hashes = await findSubmissions(h, payer, plan.planId);
    if (hashes.length) {
      throw new HarmonyError(409, 'The payer already has transactions with this plan id as memo: the plan was (at least partly) submitted. '
        + 'Resubmit the SAME signed transactions if some did not arrive; never build this plan again. To pay whoever is missing, plan again.',
      { code: 'PLAN_ALREADY_SUBMITTED', hashes });
    }
  }
  const line = account.balances.find((b) => b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer());
  const native = account.balances.find((b) => b.asset_type === 'native');
  const assetBalance = toStroops(line ? line.balance : 0);

  // One network lookup per distinct wallet. Whoever cannot actually receive a plain payment
  // (no account, no trustline, not authorized, or no room under the limit) is "unreachable".
  const problemByWallet = new Map();
  for (const p of plan.payments) {
    if (problemByWallet.has(p.wallet) || !networks.isAccountId(p.wallet) || p.wallet === payer) continue;
    let acc = null;
    try { acc = await h.loadAccount(p.wallet); } catch (e) { if (!isNotFound(e)) throw e; }
    const need = p.pockets.filter((k) => k.rule.type === 'instant').reduce((sum, k) => sum + toStroops(k.amount), 0n);
    problemByWallet.set(p.wallet, receiveProblem(acc, asset, need));
  }

  const ops = [];
  const skipped = [];
  const holdUntil = plan.createdAt + program.unreachable.reclaimAfterSeconds;
  for (const p of plan.payments) {
    const skip = (reason) => skipped.push({ participantId: p.participantId, name: p.name, wallet: p.wallet, amount: p.amount, reason });
    if (!networks.isAccountId(p.wallet)) { skip('invalid address'); continue; }
    if (p.wallet === payer) { skip('same as the payer wallet'); continue; }
    const problem = problemByWallet.get(p.wallet);
    const reachable = problem === null;
    if (!reachable && program.unreachable.mode === 'skip') {
      skip(problem === 'account does not exist' ? `account does not exist on ${tenant.network}` : problem);
      continue;
    }
    for (const k of p.pockets) {
      const common = { participantId: p.participantId, name: p.name, wallet: p.wallet, pocketId: k.id, amount: k.amount };
      if (k.rule.type === 'instant' && reachable) {
        ops.push({ ...common, kind: 'payment', claimableFrom: null, claimableUntil: null,
          operation: sdk.Operation.payment({ destination: p.wallet, asset, amount: k.amount }) });
        continue;
      }
      const kind = k.rule.type === 'instant' ? 'hold' : k.rule.type;
      const at = kind === 'hold' ? holdUntil : k.rule.at;
      // When the payer may take the money back: from `at` (expires, hold); never for an unlocks pocket of
      // someone who can receive; for someone who cannot, from the later of the unlock and the hold date.
      const reclaimAt = kind === 'unlocks' ? (reachable ? null : Math.max(at, holdUntil)) : at;
      if (reclaimAt !== null && reclaimAt < now + payouts.TIMEOUT_SECONDS) {
        expired(`The ${kind === 'hold' ? 'hold' : `pocket "${k.id}"`} of ${p.name} would be reclaimable by the payer at ${new Date(reclaimAt * 1000).toISOString()}, `
          + `less than ${payouts.TIMEOUT_SECONDS} s from now: plan again.`, { pocketId: k.id, participantId: p.participantId, reclaimableFrom: reclaimAt });
      }
      const claimants = claimantsFor(kind, p.wallet, payer, at, kind === 'unlocks' ? reclaimAt : null);
      ops.push({
        ...common,
        kind,
        ...(reachable || kind === 'expires' ? {} : { reason: problem }),
        claimableFrom: kind === 'unlocks' ? at : plan.createdAt,
        claimableUntil: kind === 'expires' ? at : null,
        payerCanReclaimFrom: reclaimAt,
        claimants: claimants.length,
        operation: sdk.Operation.createClaimableBalance({ asset, amount: k.amount, claimants }),
      });
    }
  }
  if (!ops.length) throw new HarmonyError(409, 'No recipient can receive the payment.', { skipped });

  const total = ops.reduce((s, o) => s + toStroops(o.amount), 0n);
  if (assetBalance < total) {
    throw new HarmonyError(409, `Insufficient payer balance: ${fromStroops(assetBalance)} ${asset.getCode()} available, the plan needs ${fromStroops(total)}.`,
      { code: 'INSUFFICIENT_BALANCE', balance: fromStroops(assetBalance), total: fromStroops(total) });
  }

  // `feeXlm` is the most the payer bids (FEE_PER_OP per operation, headroom for congestion); the
  // network charges the current base fee, typically 10 times less. The check below is a safe upper bound.
  // XLM the payer needs: fees, plus one base reserve per claimant of every new
  // claimable balance, on top of the minimum balance the account already has.
  const feeXlm = (Number(payouts.FEE_PER_OP) * ops.length) / 1e7;
  const reserveXlm = ops.reduce((s, o) => s + (o.claimants || 0), 0) * baseReserveXlm;
  const entries = 2 + Number(account.subentry_count || 0) + Number(account.num_sponsoring || 0) - Number(account.num_sponsored || 0);
  const minimumXlm = entries * baseReserveXlm;
  const nativeXlm = Number(native ? native.balance : 0);
  if (native && nativeXlm + 1e-7 < minimumXlm + reserveXlm + feeXlm) {
    throw new HarmonyError(409,
      `The payer needs ${(minimumXlm + reserveXlm + feeXlm).toFixed(7)} XLM (minimum balance ${minimumXlm}, reserves of the pockets ${reserveXlm}, fees ${feeXlm}) and has ${nativeXlm}.`,
      { code: 'INSUFFICIENT_XLM', reserveXlm, feeXlm, minimumXlm, nativeXlm });
  }

  const xdrs = [];
  const hashes = [];
  const operations = [];
  for (let i = 0; i < ops.length; i += OPS_PER_TX) {
    const chunk = ops.slice(i, i + OPS_PER_TX);
    const b = new sdk.TransactionBuilder(account, { fee: payouts.FEE_PER_OP, networkPassphrase: tenant.networkPassphrase });
    for (const o of chunk) b.addOperation(o.operation);
    b.addMemo(sdk.Memo.hash(plan.planId));
    // build() increments the account sequence: the next batch is consecutive.
    const tx = b.setTimeout(payouts.TIMEOUT_SECONDS).build();
    xdrs.push(tx.toXDR());
    hashes.push(tx.hash().toString('hex'));
    chunk.forEach((o, index) => {
      const { operation, claimants, ...rest } = o;
      operations.push({ ...rest, tx: xdrs.length - 1, index, balanceId: o.kind === 'payment' ? null : tx.getClaimableBalanceId(index) });
    });
  }

  return {
    planId: plan.planId,
    network: tenant.network,
    networkPassphrase: tenant.networkPassphrase,
    asset: { code: asset.getCode(), issuer: asset.getIssuer() },
    payer,
    xdrs,
    hashes,
    operations,
    skipped,
    total: fromStroops(total),
    payerBalance: fromStroops(assetBalance),
    feeXlm,
    reserveXlm,
  };
}

module.exports = { build, claimantsFor, OPS_PER_TX, BASE_RESERVE_XLM, DEFAULT_MAX_PLAN_AGE_SECONDS };
