'use strict';

const crypto = require('node:crypto');

/*
 * Stellar Disbursement Platform (SDP) instruction file, verified against
 * stellar-disbursement-platform-backend 7.1.0 (main @ 331ab68, 2026-10-26):
 *   internal/serve/httphandler/disbursement_handler.go  (validateCSVHeaders, limits)
 *   internal/serve/validators/disbursement_instructions_validator.go
 *   internal/utils/validation.go                          (phone, email, amount, verification)
 *   internal/data/disbursement_instructions.go            (csv column names)
 */

const STROOPS = 7;
const MAX_ROWS = 10000; // data.MaxInstructionsPerDisbursement
const MAX_ID_LENGTH = 64; // `id` and `paymentID`
const MAX_NATIONAL_ID_LENGTH = 50;
const PHONE_RX = /^\+[1-9][0-9]{9,14}$/; // SDP rxPhone (E.164)
const EMAIL_RX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const WALLET_RX = /^G[A-Z2-7]{55}$/; // shape only: the checksum is verified by SDP
const AMOUNT_RX = /^\d+\.\d{7}$/;
const FORMULA_RX = /^[=+\-@\t\r]/;
const CONTROL_RX = /[\u0000-\u001f\u007f]/;

/** Column layout per SDP "registration contact type". Order is the header order. */
const MODES = {
  phone: { contact: 'phone', wallet: false, columns: ['phone', 'id', 'amount', 'verification', 'paymentID'] },
  email: { contact: 'email', wallet: false, columns: ['email', 'id', 'amount', 'verification', 'paymentID'] },
  phone_wallet: { contact: 'phone', wallet: true, columns: ['phone', 'id', 'amount', 'walletAddress', 'paymentID'] },
  email_wallet: { contact: 'email', wallet: true, columns: ['email', 'id', 'amount', 'walletAddress', 'paymentID'] },
};

function validDate(s) {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const VERIFICATION = {
  DATE_OF_BIRTH: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && validDate(v),
  YEAR_MONTH: (v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(v),
  PIN: (v) => v.length >= 4 && v.length <= 8,
  NATIONAL_ID_NUMBER: (v) => v.length >= 1 && v.length <= MAX_NATIONAL_ID_LENGTH,
};

/** "12.5000000" -> 125000000n. Throws on anything but exactly 7 decimals. */
function toStroops(amount, where) {
  if (typeof amount !== 'string' || !AMOUNT_RX.test(amount)) {
    throw new TypeError(`${where} must be a string with exactly ${STROOPS} decimals, got ${JSON.stringify(amount)}`);
  }
  const [whole, frac] = amount.split('.');
  return BigInt(whole) * 10n ** BigInt(STROOPS) + BigInt(frac);
}

/** 125000000n -> "12.5000000". */
function fromStroops(stroops) {
  const s = stroops.toString().padStart(STROOPS + 1, '0');
  return `${s.slice(0, -STROOPS)}.${s.slice(-STROOPS)}`;
}

/** RFC 4180 escaping: quote a field that holds a comma, a quote or a line break. */
function csvField(value) {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Deterministic `paymentID` for one person in one plan:
 * `<first 12 chars of planId>-<participantId>`. When the participant id holds a
 * character outside [A-Za-z0-9._-], or the result would exceed SDP's 64
 * characters, a short hash of the original id is used instead
 * (`<first 12 chars>-h<16 hex>`), so two participants never share a paymentID.
 */
function paymentIdFor(planId, participantId) {
  const prefix = String(planId).slice(0, 12);
  const plain = `${prefix}-${participantId}`;
  if (/^[A-Za-z0-9._-]+$/.test(participantId) && plain.length <= MAX_ID_LENGTH) return plain;
  const h = crypto.createHash('sha256').update(participantId).digest('hex').slice(0, 16);
  return `${prefix}-h${h}`;
}

function pickPockets(payment, selection) {
  const pockets = Array.isArray(payment.pockets) ? payment.pockets : [];
  if (pockets.length === 0) return { included: [{ id: 'amount', amount: payment.amount }], excluded: [] };
  const included = [];
  const excluded = [];
  for (const p of pockets) {
    const keep = selection === 'all'
      || (Array.isArray(selection) ? selection.includes(p.id) : !!p.rule && p.rule.type === 'instant');
    (keep ? included : excluded).push(p);
  }
  return { included, excluded };
}

/**
 * Turns a Harmony payout plan into a Stellar Disbursement Platform (SDP)
 * disbursement instruction file (CSV). Pure: no network, no file system.
 *
 * SDP fixes the columns when a disbursement is created (its "registration
 * contact type"), so `mode` must match the one you choose in SDP:
 *
 * | mode           | SDP registration contact type    | columns                                 |
 * | -------------- | -------------------------------- | --------------------------------------- |
 * | `phone`        | PHONE_NUMBER                     | phone,id,amount,verification,paymentID  |
 * | `email`        | EMAIL                            | email,id,amount,verification,paymentID  |
 * | `phone_wallet` | PHONE_NUMBER_AND_WALLET_ADDRESS  | phone,id,amount,walletAddress,paymentID |
 * | `email_wallet` | EMAIL_AND_WALLET_ADDRESS         | email,id,amount,walletAddress,paymentID |
 *
 * SDP has no wallet-only variant: every receiver is identified by a phone or an
 * email. The wallet variants also register the supplied wallet (and take no
 * verification column); the `phone` / `email` variants need a verification
 * value per person, of the one type configured on the disbursement.
 *
 * `paymentID` is `<first 12 chars of planId>-<participantId>` (hashed when the
 * id has unusual characters or is long), so re-exporting the same plan gives
 * the same ids. Rows a person cannot fill completely go to `skipped`.
 *
 * @param {object} plan Harmony payout plan.
 * @param {object} options
 * @param {'phone'|'email'|'phone_wallet'|'email_wallet'} options.mode Required.
 * @param {Object<string, {phone?: string, email?: string, verification?: string}>} [options.contacts]
 *   Host-supplied contact data by participantId. Never read from the plan.
 * @param {'DATE_OF_BIRTH'|'YEAR_MONTH'|'PIN'|'NATIONAL_ID_NUMBER'} [options.verificationType]
 *   Required for modes `phone` and `email`.
 * @param {'instant'|'all'|string[]} [options.pockets='instant'] Which pockets to pay.
 *   `'instant'` keeps pockets whose rule.type is `instant`; `'all'` keeps every
 *   pocket (time rules are lost); an array keeps those pocket ids.
 * @returns {{csv: string, rows: object[], skipped: {participantId: string, name: string|null, reason: string}[],
 *   total: string, columns: string[], notes: string[]}}
 */
function toSdpDisbursement(plan, options = {}) {
  if (!plan || !Array.isArray(plan.payments)) throw new TypeError('"plan" must be a Harmony payout plan with a payments array');
  const mode = MODES[options.mode];
  if (!mode) throw new TypeError(`"mode" must be one of ${Object.keys(MODES).join(', ')}`);
  const selection = options.pockets == null ? 'instant' : options.pockets;
  if (selection !== 'instant' && selection !== 'all' && !Array.isArray(selection)) {
    throw new TypeError('"pockets" must be "instant", "all" or an array of pocket ids');
  }
  let verify = null;
  if (!mode.wallet) {
    verify = VERIFICATION[options.verificationType];
    if (!verify) throw new TypeError(`"verificationType" is required for mode "${options.mode}": one of ${Object.keys(VERIFICATION).join(', ')}`);
  }
  const contacts = options.contacts || {};
  const columns = mode.columns.slice();

  const rows = [];
  const skipped = [];
  const seenContacts = new Set();
  const seenWallets = new Set();
  let total = 0n;
  let excludedTotal = 0n;

  for (const payment of plan.payments) {
    const pid = payment && payment.participantId;
    const name = payment && typeof payment.name === 'string' ? payment.name : null;
    const skip = (reason) => skipped.push({ participantId: pid == null ? '' : String(pid), name, reason });

    const { included, excluded } = pickPockets(payment, selection);
    for (const p of excluded) excludedTotal += toStroops(p.amount, `pocket "${p.id}" amount of ${pid}`);
    const stroops = included.reduce((s, p) => s + toStroops(p.amount, `pocket "${p.id}" amount of ${pid}`), 0n);

    if (typeof pid !== 'string' || pid.trim() === '') { skip('participantId is empty'); continue; }
    if (pid !== pid.trim() || pid.length > MAX_ID_LENGTH || CONTROL_RX.test(pid)) {
      skip(`participantId is not a valid SDP id (1-${MAX_ID_LENGTH} characters, no control characters, no surrounding spaces)`);
      continue;
    }
    if (FORMULA_RX.test(pid)) { skip('participantId starts with a character that spreadsheets read as a formula (= + - @)'); continue; }
    if (stroops <= 0n) { skip('nothing to pay in the selected pockets'); continue; }

    const c = Object.prototype.hasOwnProperty.call(contacts, pid) && contacts[pid] ? contacts[pid] : {};
    const row = { id: pid, amount: fromStroops(stroops), paymentID: paymentIdFor(plan.planId, pid) };

    const raw = typeof c[mode.contact] === 'string' ? c[mode.contact].trim() : '';
    if (!raw) { skip(`no ${mode.contact} supplied`); continue; }
    if (mode.contact === 'phone') {
      if (!PHONE_RX.test(raw)) { skip('phone is not in E.164 format (+ and 10 to 15 digits)'); continue; }
      row.phone = raw;
    } else {
      if (!EMAIL_RX.test(raw) || raw.length > 254) { skip('email is not valid'); continue; }
      if (FORMULA_RX.test(raw)) { skip('email starts with a character that spreadsheets read as a formula (= + - @)'); continue; }
      row.email = raw.toLowerCase(); // SDP lowercases contacts
    }
    const contactKey = row[mode.contact];
    if (seenContacts.has(contactKey)) { skip(`duplicate ${mode.contact}: SDP rejects a file where two rows share a contact`); continue; }

    if (mode.wallet) {
      const w = (payment.wallet == null ? '' : String(payment.wallet)).trim().toUpperCase();
      if (!w) { skip('no wallet in the plan'); continue; }
      if (!WALLET_RX.test(w)) { skip('wallet is not shaped like a Stellar public key (G + 55 characters)'); continue; }
      if (seenWallets.has(w)) { skip('duplicate wallet: SDP rejects a wallet registered for two receivers'); continue; }
      row.walletAddress = w;
    } else {
      const v = typeof c.verification === 'string' ? c.verification.trim() : '';
      if (!v) { skip(`no verification value supplied (${options.verificationType})`); continue; }
      if (CONTROL_RX.test(v) || !verify(v)) { skip(`verification value does not match ${options.verificationType}`); continue; }
      if (FORMULA_RX.test(v)) { skip('verification starts with a character that spreadsheets read as a formula (= + - @)'); continue; }
      row.verification = v;
    }

    seenContacts.add(contactKey);
    if (row.walletAddress) seenWallets.add(row.walletAddress);
    rows.push(row);
    total += stroops;
  }

  const notes = [];
  if (rows.length > MAX_ROWS) notes.push(`SDP accepts at most ${MAX_ROWS} rows per disbursement; split this file before uploading.`);
  if (selection === 'all') {
    notes.push('All pockets were summed into one plain payment: time rules (unlocks, expires) are lost. SDP pays everything immediately.');
  } else if (excludedTotal > 0n) {
    const code = plan.asset && plan.asset.code ? ` ${plan.asset.code}` : '';
    notes.push(`${fromStroops(excludedTotal)}${code} in pockets that were not selected is not in this file and must be paid by another route.`);
  }
  if (!mode.wallet) notes.push('In this mode SDP pays the wallet each receiver registers themselves, not the wallet in the Harmony plan.');
  if (mode.wallet && Array.isArray(plan.withoutWallet) && plan.withoutWallet.length > 0) {
    notes.push(`${plan.withoutWallet.length} participant(s) in the plan have no wallet and are not in this file.`);
  }
  notes.push('The asset, the registration contact type and the verification type are chosen in SDP when the disbursement is created; they must match the plan and this mode.');

  const lines = [columns.join(',')];
  for (const r of rows) lines.push(columns.map((col) => csvField(r[col])).join(','));
  return { csv: `${lines.join('\n')}\n`, rows, skipped, total: fromStroops(total), columns, notes };
}

module.exports = { toSdpDisbursement };
