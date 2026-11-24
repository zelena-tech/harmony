'use strict';

const { HarmonyError, networks, payouts, sdk } = require('@zelena/harmony-core');

/**
 * Validation and submission of the transactions the payer signed.
 *
 * Three independent checks, all of them for EVERY transaction before the first
 * one reaches the network (a batch is never half-validated):
 *
 *  1. The signed transaction must be one of the transactions `build` produced
 *     (same hash). A signature does not change the hash, so any edit made
 *     between build and signature — another destination, another amount, an
 *     extra operation — is detected. The host must keep `built.hashes` on its
 *     side and never accept them back from the browser.
 *  2. `validateOperations`: a structural SECOND check that does not depend on
 *     (1). Only payments and claimable balances of the reward asset, only
 *     towards the wallets it is given, no operation acting on behalf of
 *     another account, the payer can only ever be a "take it back later"
 *     claimant, the transaction expires, and its fee is bounded. On its own it
 *     is not sufficient (it cannot know the amounts or the people): the hash
 *     check against a `built` kept on the server is the control.
 *  3. The signature: at least one signature must be a valid signature of the
 *     transaction hash by the source account's own key. Without this a wrongly
 *     signed transaction in a batch would only be refused by the network after
 *     the earlier ones were already accepted. An account with custom signers
 *     (multisig) signs with other keys; a host that uses such accounts sets
 *     `verifySignatures: false` and lets the network judge the signatures.
 */

const predicateType = (pred) => pred.switch().name;

/** Unix time of a `not(before T)` predicate, or null if the predicate is anything else. */
function notBeforeTime(pred) {
  if (predicateType(pred) !== 'claimPredicateNot') return null;
  const inner = pred.notPredicate();
  if (!inner || predicateType(inner) !== 'claimPredicateBeforeAbsoluteTime') return null;
  return Number(inner.absBefore().toString());
}

/** 'unconditional' | 'before' | 'notBefore' with its time, or null when the shape is not one the kit builds. */
function recipientWindow(pred) {
  const type = predicateType(pred);
  if (type === 'claimPredicateUnconditional') return { type: 'unconditional', at: null };
  if (type === 'claimPredicateBeforeAbsoluteTime') return { type: 'before', at: Number(pred.absBefore().toString()) };
  const t = notBeforeTime(pred);
  return t === null ? null : { type: 'notBefore', at: t };
}

/**
 * Pure structural validation of a signed transaction. Throws HarmonyError.
 *
 * @param {object} tx  parsed transaction
 * @param {object} ctx
 * @param {string} ctx.code                reward asset code
 * @param {string} ctx.issuer              reward asset issuer
 * @param {Set<string>} ctx.wallets        wallets the plan pays
 * @param {string} [ctx.expectedPayer]     required source account (mainnet)
 * @returns {Array} the operations
 */
function validateOperations(tx, { code, issuer, wallets, expectedPayer }) {
  const reject = (message, extra) => { throw new HarmonyError(400, `${message} Not submitted.`, extra); };
  if (tx.innerTransaction) reject('Fee-bump transactions are not accepted.');
  const ops = tx.operations || [];
  if (!ops.length) reject('The transaction has no operations.');
  // A transaction without an expiry could be submitted years from now.
  const maxTime = tx.timeBounds && tx.timeBounds.maxTime !== undefined ? Number(tx.timeBounds.maxTime) : 0;
  if (!(maxTime > 0)) reject('The transaction never expires (no maximum time).', { code: 'NO_EXPIRY' });
  if (BigInt(tx.fee) > BigInt(payouts.FEE_PER_OP) * 100n * BigInt(ops.length)) {
    reject(`The fee (${tx.fee} stroops) is more than 100 times the usual fee per operation.`, { code: 'FEE_TOO_HIGH' });
  }
  if (expectedPayer && tx.source !== expectedPayer) {
    throw new HarmonyError(409, `The signing account (${tx.source.slice(0, 6)}…) is not the registered payer. Not submitted.`, { code: 'UNEXPECTED_PAYER' });
  }
  ops.forEach((op, i) => {
    const where = `Operation ${i + 1}`;
    // An operation with its own source would move the funds of ANOTHER account
    // that happened to sign. The kit never builds one.
    if (op.source && op.source !== tx.source) reject(`${where} acts on behalf of another account.`, { code: 'FOREIGN_SOURCE' });
    if (op.type !== 'payment' && op.type !== 'createClaimableBalance') reject(`${where} is not a payment nor a claimable balance.`, { code: 'UNEXPECTED_OPERATION' });
    if (!op.asset || op.asset.getCode() !== code || op.asset.getIssuer() !== issuer) reject(`${where} does not use the reward asset.`, { code: 'UNEXPECTED_ASSET' });
    if (op.type === 'payment') {
      if (!wallets.has(op.destination)) reject(`${where} pays ${op.destination.slice(0, 6)}…, which is not in the plan.`, { code: 'UNREGISTERED_DESTINATION' });
      return;
    }
    const claimants = op.claimants || [];
    const recipients = claimants.filter((c) => c.destination !== tx.source);
    const payers = claimants.filter((c) => c.destination === tx.source);
    if (recipients.length !== 1 || payers.length > 1 || claimants.length > 2) reject(`${where} has an unexpected set of claimants.`, { code: 'UNEXPECTED_CLAIMANTS' });
    if (!wallets.has(recipients[0].destination)) reject(`${where} can be claimed by ${recipients[0].destination.slice(0, 6)}…, which is not in the plan.`, { code: 'UNREGISTERED_DESTINATION' });
    const window = recipientWindow(recipients[0].predicate);
    if (!window) reject(`${where} has a claim condition the kit does not build.`, { code: 'UNEXPECTED_PREDICATE' });
    if (payers.length) {
      const back = notBeforeTime(payers[0].predicate);
      // The payer may only take the money back later, never while the person can still claim it.
      // (An `unlocks` pocket of someone who cannot receive yet has a payer claimant too, never before the unlock.)
      if (back === null || (window.type !== 'unconditional' && back < window.at)) {
        reject(`${where} would let the payer take the money back early.`, { code: 'UNEXPECTED_PREDICATE' });
      }
    } else if (window.type !== 'notBefore') {
      reject(`${where} has an unexpected set of claimants.`, { code: 'UNEXPECTED_CLAIMANTS' });
    }
  });
  if (!tx.signatures || !tx.signatures.length) reject('The transaction is not signed.');
  return ops;
}

/**
 * True when at least one signature of `tx` is a valid signature of its hash by
 * the key of its source account. Only meaningful for accounts that sign with
 * their own master key.
 */
function signedBySource(tx) {
  let key;
  try { key = sdk.Keypair.fromPublicKey(tx.source); } catch { return false; }
  const hash = tx.hash();
  return (tx.signatures || []).some((sig) => {
    try { return key.verify(hash, sig.signature()); } catch { return false; }
  });
}

/**
 * Validates and submits the signed transactions of a build, in order.
 *
 * @param {object} tenant
 * @param {object} input
 * @param {object} input.built         build() result, kept by the host
 * @param {string[]} input.signedXdrs  what the payer's wallet returned
 * @param {object} [input.horizon]     injectable (submitTransaction) for tests
 * @param {boolean} [input.verifySignatures=true]  require a valid signature by the source account's own key
 *        (error 400, code BAD_SIGNATURE). Set it to false only for a payer account with custom
 *        signers (multisig), whose signatures are made with other keys; the network then judges them.
 * @returns {Promise<{planId: string, network: string, transactions: Array}>}
 *          Stops at the first failure and throws a HarmonyError whose `submitted` lists the transactions
 *          that DID go through (record them) and `notSent` the hashes that were not sent:
 *
 *          - 502, code TRANSACTION_REJECTED: the network answered with result codes. The transaction
 *            `failedHash` was NOT applied. The ones in `notSent` were not sent: whoever they would have
 *            paid needs a NEW plan (pass `previous`).
 *          - 504, code SUBMISSION_UNKNOWN: no answer with result codes (timeout, 5xx, network error).
 *            `unknownHash` MAY have been applied. Resubmit the SAME signed transactions (resubmitting is
 *            safe: the network deduplicates by hash). Never build the plan again.
 */
async function submit(tenant, { built, signedXdrs, horizon, verifySignatures = true }) {
  if (!built || !Array.isArray(built.hashes) || !Array.isArray(built.operations)) throw new HarmonyError(400, 'The build is missing: keep the result of build() and pass it here.');
  if (!Array.isArray(signedXdrs) || !signedXdrs.length) throw new HarmonyError(400, 'No signed transactions were received.');
  if (built.network !== tenant.network) throw new HarmonyError(400, 'The build belongs to another network.');

  const wallets = new Set(built.operations.map((o) => o.wallet));
  const parsed = signedXdrs.map((xdr) => {
    let tx;
    try { tx = sdk.TransactionBuilder.fromXDR(xdr, tenant.networkPassphrase); } catch (e) {
      throw new HarmonyError(400, `Invalid XDR or wrong network: ${e.message}`);
    }
    const hash = typeof tx.hash === 'function' ? tx.hash().toString('hex') : null;
    const position = built.hashes.indexOf(hash);
    if (position < 0) {
      throw new HarmonyError(400, 'A signed transaction is not one of the transactions that were built for this plan. Not submitted.',
        { code: 'NOT_THE_BUILT_TRANSACTION' });
    }
    validateOperations(tx, {
      code: tenant.rewardAsset.code,
      issuer: tenant.rewardAsset.issuer,
      wallets,
      expectedPayer: tenant.network === 'mainnet' ? (tenant.payouts.payerWallet || built.payer) : built.payer,
    });
    if (verifySignatures && !signedBySource(tx)) {
      throw new HarmonyError(400, `The transaction ${hash.slice(0, 8)}… has no valid signature of its source account. Nothing was submitted.`,
        { code: 'BAD_SIGNATURE', hash });
    }
    return { tx, hash, position };
  });
  if (new Set(parsed.map((p) => p.position)).size !== parsed.length) throw new HarmonyError(400, 'The same transaction was sent twice.');
  parsed.sort((a, b) => a.position - b.position); // consecutive sequence numbers

  const h = horizon || new sdk.Horizon.Server(tenant.horizonUrl);
  const transactions = [];
  for (const { tx, hash, position } of parsed) {
    let res;
    try { res = await h.submitTransaction(tx); } catch (e) {
      const codes = e && e.response && e.response.data && e.response.data.extras && e.response.data.extras.result_codes;
      const notSent = parsed.slice(parsed.findIndex((x) => x.hash === hash) + 1).map((x) => x.hash);
      if (codes) {
        throw new HarmonyError(502, `The network rejected the transaction: ${JSON.stringify(codes)}`,
          { code: 'TRANSACTION_REJECTED', resultCodes: codes, failedHash: hash, submitted: transactions, notSent });
      }
      throw new HarmonyError(504, `The outcome of the transaction ${hash.slice(0, 8)}… is unknown (${(e && e.message) || 'no answer'}). `
        + 'It may still be applied. Resubmit the SAME signed transactions (resubmitting is safe: the network deduplicates by hash). '
        + 'Never build this plan again: that would pay it twice.',
      { code: 'SUBMISSION_UNKNOWN', unknownHash: hash, submitted: transactions, notSent });
    }
    transactions.push({
      hash: res.hash || hash,
      ledger: res.ledger === undefined ? null : res.ledger,
      payer: tx.source,
      operations: built.operations.filter((o) => o.tx === position),
    });
  }
  return { planId: built.planId, network: tenant.network, transactions };
}

/** Public explorer link of a transaction. */
const explorerUrl = (network, hash) => `https://stellar.expert/explorer/${network === 'mainnet' ? 'public' : 'testnet'}/tx/${hash}`;

module.exports = { submit, validateOperations, signedBySource, explorerUrl, isAccountId: networks.isAccountId };
