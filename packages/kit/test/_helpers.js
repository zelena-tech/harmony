'use strict';

// Shared fixtures. Nothing here touches the network and no key is written
// down: every keypair is random and lives only for the test run.

const crypto = require('node:crypto');
const { sdk, defineTenant, networks } = require('@zelena/harmony-core');
const kit = require('../src');

const NOW = 1_800_000_000; // a fixed "current time" in unix seconds
const DAY = 86400;
const ISSUER = networks.NETWORKS.testnet.usdcIssuer;
const OTHER_ISSUER = networks.NETWORKS.mainnet.usdcIssuer;
const USDC = new sdk.Asset('USDC', ISSUER);
const PASSPHRASE = sdk.Networks.TESTNET;

const keypair = () => sdk.Keypair.random();
const wallet = () => sdk.Keypair.random().publicKey();
const balanceId = () => `00000000${crypto.randomBytes(32).toString('hex')}`;

function tenant(extra = {}) {
  return defineTenant({ id: 'acme-kit', network: 'testnet', ...extra });
}

/** A program with a single 1-point metric so a person's points are their `pt` units. */
function simpleProgram(overrides = {}) {
  return kit.defineProgram({
    id: 'simple',
    name: 'Simple',
    metrics: [{ id: 'pt', label: 'Points', points: 1 }],
    payout: { model: 'proportional', pool: 100 },
    ...overrides,
  });
}

/** score() of a program where each id has the given points. */
function scoreOf(program, pointsById, extra = {}) {
  const events = Object.entries(pointsById).map(([participantId, value]) => ({ participantId, metric: 'pt', value }));
  return kit.score(program, { events, ...extra });
}

/** people map: id -> { name, wallet } */
function peopleOf(ids) {
  const out = {};
  for (const id of ids) out[id] = { name: `Person ${id}`, wallet: wallet() };
  return out;
}

/**
 * Horizon account record: XLM, optional reward asset line and subentry counters.
 * The trustline can carry a `limit`, `authorized` (is_authorized) and `buyingLiabilities`.
 */
function account({
  xlm = '100000.0000000', usdc, issuer = ISSUER, subentries = 0, sponsoring = 0, sponsored = 0, limit, authorized, buyingLiabilities,
} = {}) {
  const balances = [{ asset_type: 'native', balance: xlm }];
  if (usdc !== undefined && usdc !== null) {
    balances.push({
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      asset_issuer: issuer,
      balance: usdc,
      ...(limit !== undefined ? { limit } : {}),
      ...(authorized !== undefined ? { is_authorized: authorized } : {}),
      ...(buyingLiabilities !== undefined ? { buying_liabilities: buyingLiabilities } : {}),
    });
  }
  return { balances, subentry_count: subentries, num_sponsoring: sponsoring, num_sponsored: sponsored };
}

/**
 * Fake Horizon with a small ledger. `accounts` maps an account id to account();
 * anything else is a 404. Like the network it keeps a sequence number per
 * account and applies a transaction only when its sequence is the next one
 * (`tx_bad_seq` otherwise); a transaction it already applied is answered with
 * the stored result, not applied twice (Horizon deduplicates by hash).
 *
 * Options:
 *   failAt        n-th (0-based) submission is rejected with result codes (NOT applied)
 *   timeoutOn     Set of submission indexes that are APPLIED but answered with a 504
 *   dropOn        Set of submission indexes that are NOT applied and answered with a 504
 *   lookupError   transactions() lookups fail with this error
 *   ledgerTime    unix seconds stamped (created_at) on the transactions it applies, default NOW
 *   claimable / claimablePages   what claimableBalances() returns: one page, or several pages
 *                 that `page.next()` walks through (an empty page after the last, as Horizon does)
 *
 * `submitted` lists the applied transactions; `calls` counts what was asked.
 * `appliedStroops()` is the sum of every payment and claimable balance applied.
 */
function fakeHorizon(accounts, {
  failAt = null, claimable = [], claimablePages = null, timeoutOn = null, dropOn = null, lookupError = null, ledgerTime = NOW,
} = {}) {
  const submitted = [];
  const history = []; // transaction records as Horizon lists them, oldest first
  const stored = new Map(); // hash -> result
  const seqs = new Map();
  const calls = { claimant: [], asset: [], limit: [], pages: 0, transactions: 0, transactionPages: 0, lookups: [] };
  const pages = claimablePages || [claimable];
  const pageAt = (i) => { calls.pages += 1; return { records: pages[i] || [], next: async () => pageAt(i + 1) }; };
  let attempts = 0;
  const reject = (transaction) => {
    const e = new Error('Bad Request');
    e.response = { status: 400, data: { extras: { result_codes: { transaction } } } };
    return e;
  };
  const unknown = () => { const e = new Error('Request failed with status code 504'); e.response = { status: 504, data: { title: 'Timeout' } }; return e; };
  return {
    submitted,
    calls,
    history,
    /** n unrelated transactions of `account`, newer than everything so far, stamped `at` (unix seconds) */
    noise: (account, n, at = ledgerTime) => {
      for (let i = 0; i < n; i++) history.push({ hash: `noise-${history.length}`, source_account: account, created_at: new Date(at * 1000).toISOString(), memo_type: 'none' });
    },
    appliedStroops: () => submitted.reduce((sum, tx) => sum + tx.operations.reduce((t, op) => (
      t + (op.type === 'payment' || op.type === 'createClaimableBalance' ? BigInt(Math.round(Number(op.amount) * 1e7)) : 0n)), 0n), 0n),
    loadAccount: async (id) => {
      const a = accounts[id];
      if (!a) { const e = new Error('Not Found'); e.response = { status: 404 }; throw e; }
      const acc = new sdk.Account(id, String(seqs.has(id) ? seqs.get(id) : 100n));
      Object.assign(acc, a);
      return acc;
    },
    submitTransaction: async (tx) => {
      const n = attempts++;
      const hash = tx.hash().toString('hex');
      if (stored.has(hash)) return stored.get(hash);
      if (failAt !== null && n === failAt) throw reject('tx_bad_seq');
      if (dropOn && dropOn.has(n)) throw unknown();
      const current = seqs.has(tx.source) ? seqs.get(tx.source) : 100n;
      if (BigInt(tx.sequence) !== current + 1n) throw reject('tx_bad_seq');
      seqs.set(tx.source, current + 1n);
      submitted.push(tx);
      history.push({
        hash,
        source_account: tx.source,
        created_at: new Date(ledgerTime * 1000).toISOString(),
        memo_type: tx.memo && tx.memo.type === 'hash' ? 'hash' : 'none',
        ...(tx.memo && tx.memo.type === 'hash' ? { memo: Buffer.from(tx.memo.value).toString('base64') } : {}),
      });
      const result = { hash, ledger: 1000 + n };
      stored.set(hash, result);
      if (timeoutOn && timeoutOn.has(n)) throw unknown();
      return result;
    },
    transactions: () => {
      calls.transactions += 1;
      const q = { account: null, direction: 'asc', max: 10 };
      const b = {
        forAccount: (a) => { q.account = a; return b; },
        order: (o) => { q.direction = o; return b; },
        limit: (l) => { q.max = l; calls.lookups.push({ account: q.account, order: q.direction, limit: l }); return b; },
        call: async () => {
          if (lookupError) throw lookupError;
          const mine = history.filter((r) => r.source_account === q.account);
          const ordered = q.direction === 'desc' ? mine.slice().reverse() : mine;
          // Pages of `limit` records, walked by page.next(); an empty page after the last, as Horizon does.
          const pageAt = (i) => { calls.transactionPages += 1; return { records: ordered.slice(i * q.max, (i + 1) * q.max), next: async () => pageAt(i + 1) }; };
          return pageAt(0);
        },
      };
      return b;
    },
    claimableBalances: () => {
      const b = {
        claimant: (w) => { calls.claimant.push(w); return b; },
        asset: (a) => { calls.asset.push(a); return b; },
        limit: (l) => { calls.limit.push(l); return b; },
        call: async () => pageAt(0),
      };
      return b;
    },
  };
}

/** Signs an XDR with `signer` and returns the signed XDR. */
function signXdr(xdr, signer, passphrase = PASSPHRASE) {
  const tx = sdk.TransactionBuilder.fromXDR(xdr, passphrase);
  tx.sign(signer);
  return tx.toXDR();
}

const parse = (xdr, passphrase = PASSPHRASE) => sdk.TransactionBuilder.fromXDR(xdr, passphrase);

/** Plain-object view of an XDR claim predicate, independent of the kit code. */
function describePredicate(p) {
  const t = p.switch().name;
  if (t === 'claimPredicateUnconditional') return { unconditional: true };
  if (t === 'claimPredicateBeforeAbsoluteTime') return { before: Number(p.absBefore().toString()) };
  if (t === 'claimPredicateNot') return { not: describePredicate(p.notPredicate()) };
  if (t === 'claimPredicateAnd') return { and: p.andPredicates().map(describePredicate) };
  if (t === 'claimPredicateOr') return { or: p.orPredicates().map(describePredicate) };
  return { other: t };
}

const claimantsOf = (op) => op.claimants.map((c) => ({ destination: c.destination, predicate: describePredicate(c.predicate) }));

/** An unsigned (or signed) transaction made by hand, to feed validators. */
function rawTx(source, ops, { sign = null, passphrase = PASSPHRASE, seq = '100' } = {}) {
  const b = new sdk.TransactionBuilder(new sdk.Account(source, seq), { fee: '1000', networkPassphrase: passphrase });
  ops.forEach((o) => b.addOperation(o));
  const tx = b.setTimeout(600).build();
  if (sign) tx.sign(sign);
  return tx;
}

const { Claimant } = sdk;
const before = (t) => Claimant.predicateBeforeAbsoluteTime(String(t));
const notBefore = (t) => Claimant.predicateNot(before(t));
const unconditional = () => Claimant.predicateUnconditional();
const claimable = (claimants, { asset = USDC, amount = '1.0000000' } = {}) => sdk.Operation.createClaimableBalance({ asset, amount, claimants });
const payment = (destination, { asset = USDC, amount = '1.0000000', source } = {}) => sdk.Operation.payment({ destination, asset, amount, ...(source ? { source } : {}) });

/**
 * A complete offline scenario: a program, a tenant, standings, people, a plan,
 * a payer and a fake Horizon where every recipient already has a trustline.
 */
function scenario({
  program = simpleProgram(),
  tenantExtra = {},
  points = { a: 50, b: 30, c: 20 },
  now = NOW,
  planOptions,
  funded = true,
  usdc = '1000000.0000000',
  xlm = '100000.0000000',
  horizonOptions,
} = {}) {
  const t = tenant(tenantExtra);
  const { standings } = scoreOf(program, points);
  const people = peopleOf(Object.keys(points));
  const plan = kit.plan(program, t, { standings, people, now, ...(planOptions ? { options: planOptions } : {}) });
  const payer = keypair();
  const accounts = { [payer.publicKey()]: account({ xlm, usdc }) };
  if (funded) for (const p of Object.values(people)) accounts[p.wallet] = account({ usdc: '0.0000000' });
  const horizon = fakeHorizon(accounts, horizonOptions);
  return { program, tenant: t, standings, people, plan, payer, accounts, horizon, now };
}

module.exports = {
  NOW, DAY, ISSUER, OTHER_ISSUER, USDC, PASSPHRASE,
  keypair, wallet, balanceId, tenant, simpleProgram, scoreOf, peopleOf, account, fakeHorizon,
  signXdr, parse, describePredicate, claimantsOf, rawTx, before, notBefore, unconditional, claimable, payment, scenario,
  sdk, kit,
};
