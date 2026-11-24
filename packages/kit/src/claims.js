'use strict';

const { HarmonyError, payouts, networks, sdk } = require('@zelena/harmony-core');

/**
 * The person's side of the pockets: what is waiting for them, and the single
 * transaction that claims it.
 *
 * `buildClaim` adds the trustline of the reward asset when it is missing, so
 * somebody who has never held the asset goes from "nothing set up" to "paid"
 * with ONE signature in their own wallet.
 *
 * The payer uses the same functions to take back an expired pocket.
 */

const CLAIMS_PER_TX = 19; // + 1 optional changeTrust = 20 operations
const isNotFound = (e) => e && e.response && e.response.status === 404;

/** Evaluates a claim predicate as Horizon returns it (JSON). */
function predicateAllows(pred, now) {
  if (!pred || pred.unconditional === true) return true;
  if (pred.abs_before_epoch !== undefined || pred.abs_before !== undefined) {
    const t = pred.abs_before_epoch !== undefined ? Number(pred.abs_before_epoch) : Math.floor(Date.parse(pred.abs_before) / 1000);
    return now < t;
  }
  if (pred.not) return !predicateAllows(pred.not, now);
  if (Array.isArray(pred.and)) return pred.and.every((p) => predicateAllows(p, now));
  if (Array.isArray(pred.or)) return pred.or.some((p) => predicateAllows(p, now));
  return false; // relative or unknown predicates: the kit does not build them
}

/** { from, until } of the predicates the kit builds; nulls mean "no limit on that side". */
function predicateWindow(pred) {
  const epoch = (p) => (p.abs_before_epoch !== undefined ? Number(p.abs_before_epoch) : Math.floor(Date.parse(p.abs_before) / 1000));
  if (!pred || pred.unconditional === true) return { from: null, until: null };
  if (pred.abs_before_epoch !== undefined || pred.abs_before !== undefined) return { from: null, until: epoch(pred) };
  if (pred.not && (pred.not.abs_before_epoch !== undefined || pred.not.abs_before !== undefined)) return { from: epoch(pred.not), until: null };
  return { from: null, until: null };
}

/**
 * Claimable balances of the reward asset where `wallet` is a claimant.
 *
 * Follows Horizon's pages (200 balances each) until one comes back empty or
 * `maxPages` pages were read. The result is an array, as always; its
 * non-enumerable `truncated` property is true when the last page read was not empty, so
 * there may be more balances than were returned.
 *
 * @param {object} tenant
 * @param {object} input
 * @param {string} input.wallet
 * @param {number} [input.now]       unix seconds
 * @param {number} [input.maxPages=10] pages of 200 to read at most
 * @param {Array|Set} [input.sponsors] payer accounts: when given, only balances created by one of them are returned
 *        (anybody can create a claimable balance that names you as claimant; this keeps the list to your payers)
 * @param {object} [input.horizon]   injectable
 * @returns {Promise<Array<{balanceId: string, amount: string, sponsor: string, claimableNow: boolean, from: number|null, until: number|null}> & {truncated: boolean}>}
 */
async function listClaimable(tenant, { wallet, now = Math.floor(Date.now() / 1000), maxPages = 10, sponsors, horizon }) {
  if (!networks.isAccountId(wallet)) throw new HarmonyError(400, 'The wallet is not a Stellar account (G + 55 chars).');
  const h = horizon || new sdk.Horizon.Server(tenant.horizonUrl);
  const asset = payouts.rewardAsset(tenant);
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new HarmonyError(400, 'maxPages must be an integer >= 1.');
  let page = await h.claimableBalances().claimant(wallet).asset(asset).limit(200).call();
  const records = [];
  let pages = 1;
  let truncated = false;
  for (;;) {
    const got = page.records || [];
    records.push(...got);
    if (!got.length || typeof page.next !== 'function') break;
    if (pages >= maxPages) { truncated = true; break; }
    page = await page.next();
    pages += 1;
  }
  const trusted = sponsors === undefined || sponsors === null ? null : new Set(sponsors);
  const out = records.filter((r) => !trusted || trusted.has(r.sponsor)).map((r) => {
    const mine = (r.claimants || []).find((c) => c.destination === wallet);
    const window = predicateWindow(mine && mine.predicate);
    return {
      balanceId: r.id,
      amount: r.amount,
      sponsor: r.sponsor || null,
      claimableNow: !!mine && predicateAllows(mine.predicate, now),
      from: window.from,
      until: window.until,
    };
  });
  // Non-enumerable: the array stays exactly what it always was (deep-equal, JSON, spread).
  Object.defineProperty(out, 'truncated', { value: truncated, enumerable: false });
  return out;
}

/**
 * Unsigned transaction(s) with which `wallet` claims the given balances.
 *
 * @param {object} tenant
 * @param {object} input
 * @param {string} input.wallet        the account that claims and signs
 * @param {string[]} input.balanceIds  from listClaimable() or from build().operations
 * @param {object} [input.horizon]     injectable
 * @returns {Promise<{xdrs: string[], addsTrustline: boolean, balanceIds: string[]}>}
 */
async function buildClaim(tenant, { wallet, balanceIds, horizon }) {
  if (!networks.isAccountId(wallet)) throw new HarmonyError(400, 'The wallet is not a Stellar account (G + 55 chars).');
  const ids = [...new Set(balanceIds || [])];
  if (!ids.length) throw new HarmonyError(400, 'There is nothing to claim.');
  if (ids.some((id) => typeof id !== 'string' || !/^[0-9a-f]{72}$/i.test(id))) throw new HarmonyError(400, 'A balance id is not valid.');

  const h = horizon || new sdk.Horizon.Server(tenant.horizonUrl);
  const asset = payouts.rewardAsset(tenant);
  let account;
  try { account = await h.loadAccount(wallet); } catch (e) {
    if (isNotFound(e)) {
      throw new HarmonyError(409, `The account does not exist on ${tenant.network} yet: it needs a first deposit of XLM before it can claim.`,
        { code: 'ACCOUNT_NOT_FOUND' });
    }
    throw e;
  }
  const hasTrustline = account.balances.some((b) => b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer());

  const xdrs = [];
  for (let i = 0; i < ids.length; i += CLAIMS_PER_TX) {
    const b = new sdk.TransactionBuilder(account, { fee: payouts.FEE_PER_OP, networkPassphrase: tenant.networkPassphrase });
    if (i === 0 && !hasTrustline) b.addOperation(sdk.Operation.changeTrust({ asset }));
    for (const balanceId of ids.slice(i, i + CLAIMS_PER_TX)) b.addOperation(sdk.Operation.claimClaimableBalance({ balanceId }));
    xdrs.push(b.setTimeout(payouts.TIMEOUT_SECONDS).build().toXDR());
  }
  return { xdrs, addsTrustline: !hasTrustline, balanceIds: ids };
}

/**
 * Validates and submits a signed claim. Only two kinds of operation are
 * accepted: the trustline of the reward asset and claims.
 */
async function submitClaim(tenant, { wallet, signedXdrs, horizon }) {
  if (!Array.isArray(signedXdrs) || !signedXdrs.length) throw new HarmonyError(400, 'No signed transactions were received.');
  const h = horizon || new sdk.Horizon.Server(tenant.horizonUrl);
  const asset = payouts.rewardAsset(tenant);
  const transactions = [];
  for (const xdr of signedXdrs) {
    let tx;
    try { tx = sdk.TransactionBuilder.fromXDR(xdr, tenant.networkPassphrase); } catch (e) {
      throw new HarmonyError(400, `Invalid XDR or wrong network: ${e.message}`);
    }
    if (tx.innerTransaction) throw new HarmonyError(400, 'Fee-bump transactions are not accepted. Not submitted.');
    if (tx.source !== wallet) throw new HarmonyError(400, 'The transaction was not built for this wallet. Not submitted.');
    for (const op of tx.operations) {
      // A limit of 0 would REMOVE the trustline: only the default (maximum) or a positive limit.
      const ok = (!op.source || op.source === wallet) && (op.type === 'claimClaimableBalance'
        || (op.type === 'changeTrust' && op.line && typeof op.line.getCode === 'function'
          && op.line.getCode() === asset.getCode() && op.line.getIssuer() === asset.getIssuer()
          && Number(op.limit) > 0));
      if (!ok) throw new HarmonyError(400, 'The transaction contains operations that are not claims. Not submitted.', { code: 'UNEXPECTED_OPERATION' });
    }
    if (!tx.signatures.length) throw new HarmonyError(400, 'The transaction is not signed.');
    let res;
    try { res = await h.submitTransaction(tx); } catch (e) {
      const codes = e && e.response && e.response.data && e.response.data.extras && e.response.data.extras.result_codes;
      throw new HarmonyError(502, `The network rejected the claim: ${codes ? JSON.stringify(codes) : e.message}`,
        { resultCodes: codes || null, submitted: transactions });
    }
    transactions.push({
      hash: res.hash,
      ledger: res.ledger === undefined ? null : res.ledger,
      claimed: tx.operations.filter((op) => op.type === 'claimClaimableBalance').map((op) => op.balanceId),
    });
  }
  return { network: tenant.network, transactions };
}

module.exports = { listClaimable, buildClaim, submitClaim, predicateAllows, predicateWindow, CLAIMS_PER_TX };
