'use strict';

const sdk = require('@stellar/stellar-sdk');
const { HarmonyError } = require('../errors');
const { PAYMENTS_PER_TX, isAccountId, toStroopPrecision: a7 } = require('../stellar/networks');
const { applyCaps } = require('./plan');

/**
 * Non-custodial direct payments.
 *
 *  1. buildPayoutTransactions: the host builds UNSIGNED transactions (batches of
 *     up to 20 payments) from the tenant's payer wallet. Recipients that cannot
 *     receive (missing account, missing trustline) are left out, never paid blindly.
 *  2. The payer signs in its own wallet (e.g. Freighter). The secret key never
 *     touches the server.
 *  3. submitSignedTransactions: before submitting, every operation of every
 *     signed transaction is validated (validateSignedTransaction). The amounts
 *     recorded afterwards are read from the signed XDR, never from the client.
 *
 * `horizon` is injectable (an object with loadAccount/submitTransaction) so the
 * logic can be tested without network access.
 */

const FEE_PER_OP = '1000';     // 0.0001 XLM per operation: headroom under congestion
const TIMEOUT_SECONDS = 1800;  // 30 min to review and sign calmly

const rewardAsset = (tenant) => new sdk.Asset(tenant.rewardAsset.code, tenant.rewardAsset.issuer);
const horizonOf = (tenant, horizon) => horizon || new sdk.Horizon.Server(tenant.horizonUrl);
const isNotFound = (e) => e && e.response && e.response.status === 404;

/** Account existence and trustline of the reward asset. */
async function accountStatus(horizon, asset, wallet) {
  try {
    const a = await horizon.loadAccount(wallet);
    const tl = a.balances.find((b) => b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer());
    return { exists: true, trustline: !!tl, amount: tl ? Number(tl.balance) : 0 };
  } catch (e) {
    if (isNotFound(e)) return { exists: false, trustline: false, amount: 0 };
    throw e;
  }
}

/**
 * Reward asset balance of the payer (read only). Tolerant: returns null if the
 * network does not answer, so a plan can still be shown.
 */
async function payerBalance({ tenant, wallet, horizon }) {
  if (!isAccountId(wallet)) return null;
  try {
    const s = await accountStatus(horizonOf(tenant, horizon), rewardAsset(tenant), wallet);
    return { wallet, amount: s.amount, trustline: s.trustline, exists: s.exists, network: tenant.network };
  } catch {
    return null;
  }
}

/**
 * Builds the unsigned payout transactions.
 *
 * @param {object} input
 * @param {object} input.tenant
 * @param {string} input.payer   account that will sign (must match tenant.payouts.payerWallet on mainnet)
 * @param {Array<{wallet: string, amount: number, name?: string}>} input.payments
 * @param {string} [input.memo]  text memo, truncated to 28 bytes
 * @param {object} [input.horizon]
 */
async function buildPayoutTransactions({ tenant, payer, payments, memo, horizon }) {
  if (!isAccountId(payer)) throw new HarmonyError(400, 'The payer wallet is not a Stellar account (G + 55 chars).');
  if (!Array.isArray(payments) || !payments.length) throw new HarmonyError(400, 'There are no payments to build.');

  // On mainnet the signer must be the registered payer; on testnet the payer is
  // a rehearsal account and can change.
  const expected = tenant.payouts.payerWallet;
  if (tenant.network === 'mainnet' && expected && expected !== payer) {
    throw new HarmonyError(409, `The connected wallet (${payer.slice(0, 6)}…) is not the registered payer (${expected.slice(0, 6)}…).`,
      { code: 'UNEXPECTED_PAYER' });
  }
  applyCaps(payments, tenant.payouts.caps);

  const h = horizonOf(tenant, horizon);
  const asset = rewardAsset(tenant);
  let account;
  try { account = await h.loadAccount(payer); } catch (e) {
    if (isNotFound(e)) throw new HarmonyError(400, `The payer wallet does not exist on ${tenant.network}.`);
    throw e;
  }
  const tl = account.balances.find((b) => b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer());
  const balance = tl ? Number(tl.balance) : 0;

  const ready = [];
  const skipped = [];
  for (const p of payments) {
    if (!isAccountId(p.wallet)) { skipped.push({ ...p, reason: 'invalid address' }); continue; }
    if (p.wallet === payer) { skipped.push({ ...p, reason: 'same as the payer wallet' }); continue; }
    const s = await accountStatus(h, asset, p.wallet);
    if (!s.exists) skipped.push({ ...p, reason: `account does not exist on ${tenant.network}` });
    else if (!s.trustline) skipped.push({ ...p, reason: 'no trustline for the reward asset' });
    else ready.push(p);
  }
  const total = a7(ready.reduce((s, p) => s + Number(p.amount), 0));
  if (!ready.length) throw new HarmonyError(409, 'No recipient can receive the payment.', { skipped });
  if (balance + 1e-9 < total) {
    throw new HarmonyError(409, `Insufficient payer balance: ${balance} available, the plan needs ${total}.`, { balance, total });
  }

  const xdrs = [];
  for (let i = 0; i < ready.length; i += PAYMENTS_PER_TX) {
    const b = new sdk.TransactionBuilder(account, { fee: FEE_PER_OP, networkPassphrase: tenant.networkPassphrase });
    for (const p of ready.slice(i, i + PAYMENTS_PER_TX)) {
      b.addOperation(sdk.Operation.payment({ destination: p.wallet, asset, amount: Number(p.amount).toFixed(7) }));
    }
    if (memo) b.addMemo(sdk.Memo.text(String(memo).slice(0, 28)));
    // build() increments the account sequence: the next batch is consecutive.
    xdrs.push(b.setTimeout(TIMEOUT_SECONDS).build().toXDR());
  }
  return {
    network: tenant.network,
    networkPassphrase: tenant.networkPassphrase,
    issuer: asset.getIssuer(),
    xdrs,
    ready,
    skipped,
    total,
    payerBalance: balance,
    feeXlm: (Number(FEE_PER_OP) * ready.length) / 1e7,
  };
}

/**
 * Validates a SIGNED transaction before it is submitted. Pure (no network).
 *  - only payments of the expected reward asset (code + issuer),
 *  - only to REGISTERED wallets (a hand-made XDR to a foreign address is
 *    rejected even if it is signed),
 *  - on mainnet the source must be the expected payer,
 *  - at least one signature.
 *
 * @returns {Array} the operations
 */
function validateSignedTransaction(tx, { expectedCode = 'USDC', expectedIssuer, registeredWallets, expectedPayer, network }) {
  const ops = tx.operations || [];
  if (!ops.length) throw new HarmonyError(400, 'The transaction has no operations.');
  const odd = ops.find((op) => op.type !== 'payment' || !op.asset
    || op.asset.getCode() !== expectedCode || op.asset.getIssuer() !== expectedIssuer);
  if (odd) throw new HarmonyError(400, 'The transaction contains operations that are not payments of the expected asset. Not submitted.');
  const foreign = ops.filter((op) => !registeredWallets.has(op.destination)).map((op) => `${op.destination.slice(0, 6)}…`);
  if (foreign.length) {
    throw new HarmonyError(400, `The transaction pays addresses that are not registered wallets: ${foreign.join(', ')}.`,
      { code: 'UNREGISTERED_DESTINATION' });
  }
  if (network === 'mainnet' && expectedPayer && tx.source !== expectedPayer) {
    throw new HarmonyError(409, `The signing account (${tx.source.slice(0, 6)}…) is not the registered payer. Not submitted.`,
      { code: 'UNEXPECTED_PAYER' });
  }
  if (!tx.signatures || !tx.signatures.length) throw new HarmonyError(400, 'The transaction is not signed.');
  return ops;
}

/**
 * Validates and submits signed transactions. Returns, per transaction, the
 * payments it actually contains (read from the XDR).
 *
 * @param {object} input
 * @param {object} input.tenant
 * @param {string[]} input.signedXdrs
 * @param {Set<string>} input.registeredWallets  wallets of the tenant's people
 * @param {object} [input.horizon]
 */
async function submitSignedTransactions({ tenant, signedXdrs, registeredWallets, horizon }) {
  if (!Array.isArray(signedXdrs) || !signedXdrs.length) throw new HarmonyError(400, 'No signed transactions were received.');
  const h = horizonOf(tenant, horizon);
  const asset = rewardAsset(tenant);
  const results = [];
  for (const xdr of signedXdrs) {
    let tx;
    try { tx = sdk.TransactionBuilder.fromXDR(xdr, tenant.networkPassphrase); } catch (e) {
      throw new HarmonyError(400, `Invalid XDR or wrong network: ${e.message}`);
    }
    const ops = validateSignedTransaction(tx, {
      expectedCode: asset.getCode(), expectedIssuer: asset.getIssuer(), registeredWallets,
      expectedPayer: tenant.payouts.payerWallet, network: tenant.network,
    });
    let res;
    try { res = await h.submitTransaction(tx); } catch (e) {
      const codes = e && e.response && e.response.data && e.response.data.extras && e.response.data.extras.result_codes;
      throw new HarmonyError(502, `The network rejected the transaction: ${codes ? JSON.stringify(codes) : e.message}`,
        { resultCodes: codes || null });
    }
    results.push({
      hash: res.hash,
      ledger: res.ledger,
      payer: tx.source,
      payments: ops.map((op) => ({ wallet: op.destination, amount: a7(op.amount) })),
    });
  }
  return { network: tenant.network, transactions: results };
}

module.exports = {
  FEE_PER_OP, TIMEOUT_SECONDS, rewardAsset, accountStatus, payerBalance,
  buildPayoutTransactions, validateSignedTransaction, submitSignedTransactions,
};
