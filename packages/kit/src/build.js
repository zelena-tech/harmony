'use strict';

const { HarmonyError, payouts, networks, sdk } = require('@zelena/harmony-core');
const { toStroops, fromStroops } = require('./money');
const { assertPlanIntegrity } = require('./plan');

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
 * Someone who cannot receive yet (the account does not exist, or it has no
 * trustline for the reward asset) is not left out: with `unreachable.mode =
 * 'hold'` the instant pocket becomes a claimable balance that waits for them,
 * and that the payer can take back after `reclaimAfterDays`.
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
function claimantsFor(kind, wallet, payer, at) {
  if (kind === 'expires') return [new sdk.Claimant(wallet, before(at)), new sdk.Claimant(payer, notBefore(at))];
  if (kind === 'unlocks') return [new sdk.Claimant(wallet, notBefore(at))];
  return [new sdk.Claimant(wallet, sdk.Claimant.predicateUnconditional()), new sdk.Claimant(payer, notBefore(at))]; // hold
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
 */
async function build(program, tenant, {
  plan, payer, horizon, baseReserveXlm = BASE_RESERVE_XLM, now = Math.floor(Date.now() / 1000), maxPlanAgeSeconds = DEFAULT_MAX_PLAN_AGE_SECONDS,
}) {
  if (!networks.isAccountId(payer)) throw new HarmonyError(400, 'The payer wallet is not a Stellar account (G + 55 chars).');
  assertPlanIntegrity(plan);
  if (plan.tenantId !== tenant.id || plan.programId !== program.id || plan.network !== tenant.network
    || plan.asset.code !== tenant.rewardAsset.code || plan.asset.issuer !== tenant.rewardAsset.issuer) {
    throw new HarmonyError(400, 'The plan belongs to another tenant, program, network or asset.', { code: 'PLAN_MISMATCH' });
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

  const h = horizon || new sdk.Horizon.Server(tenant.horizonUrl);
  const asset = payouts.rewardAsset(tenant);
  let account;
  try { account = await h.loadAccount(payer); } catch (e) {
    if (isNotFound(e)) throw new HarmonyError(400, `The payer wallet does not exist on ${tenant.network}.`);
    throw e;
  }
  const line = account.balances.find((b) => b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer());
  const native = account.balances.find((b) => b.asset_type === 'native');
  const assetBalance = toStroops(line ? line.balance : 0);

  // One network lookup per distinct wallet.
  const statusByWallet = new Map();
  for (const p of plan.payments) {
    if (!statusByWallet.has(p.wallet) && networks.isAccountId(p.wallet) && p.wallet !== payer) {
      statusByWallet.set(p.wallet, await payouts.accountStatus(h, asset, p.wallet));
    }
  }

  const ops = [];
  const skipped = [];
  const holdUntil = plan.createdAt + program.unreachable.reclaimAfterSeconds;
  for (const p of plan.payments) {
    const skip = (reason) => skipped.push({ participantId: p.participantId, name: p.name, wallet: p.wallet, amount: p.amount, reason });
    if (!networks.isAccountId(p.wallet)) { skip('invalid address'); continue; }
    if (p.wallet === payer) { skip('same as the payer wallet'); continue; }
    const s = statusByWallet.get(p.wallet);
    const reachable = s.exists && s.trustline;
    if (!reachable && program.unreachable.mode === 'skip') {
      skip(s.exists ? 'no trustline for the reward asset' : `account does not exist on ${tenant.network}`);
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
      // From `at` on the payer may take the money back (not for unlocks): it must still be well ahead.
      if (kind !== 'unlocks' && at < now + payouts.TIMEOUT_SECONDS) {
        expired(`The ${kind === 'hold' ? 'hold' : `pocket "${k.id}"`} of ${p.name} would be reclaimable by the payer at ${new Date(at * 1000).toISOString()}, `
          + `less than ${payouts.TIMEOUT_SECONDS} s from now: plan again.`, { pocketId: k.id, participantId: p.participantId, reclaimableFrom: at });
      }
      const claimants = claimantsFor(kind, p.wallet, payer, at);
      ops.push({
        ...common,
        kind,
        claimableFrom: kind === 'unlocks' ? at : plan.createdAt,
        claimableUntil: kind === 'expires' ? at : null,
        payerCanReclaimFrom: kind === 'unlocks' ? null : at,
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
