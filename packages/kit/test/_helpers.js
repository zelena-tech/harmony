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

/** Horizon account record: XLM, optional reward asset line and subentry counters. */
function account({ xlm = '100000.0000000', usdc, issuer = ISSUER, subentries = 0, sponsoring = 0, sponsored = 0 } = {}) {
  const balances = [{ asset_type: 'native', balance: xlm }];
  if (usdc !== undefined && usdc !== null) {
    balances.push({ asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: issuer, balance: usdc });
  }
  return { balances, subentry_count: subentries, num_sponsoring: sponsoring, num_sponsored: sponsored };
}

/**
 * Fake Horizon. `accounts` maps an account id to account(); anything else is a
 * 404. `failAt` makes the n-th (0-based) submission fail like the network does.
 * `claimable` is what claimableBalances() returns: one page of records, or
 * with `claimablePages` several pages that `page.next()` walks through (an
 * empty page after the last one, as Horizon does). `calls.pages` counts them.
 */
function fakeHorizon(accounts, { failAt = null, claimable = [], claimablePages = null } = {}) {
  const submitted = [];
  const calls = { claimant: [], asset: [], limit: [], pages: 0 };
  const pages = claimablePages || [claimable];
  const pageAt = (i) => { calls.pages += 1; return { records: pages[i] || [], next: async () => pageAt(i + 1) }; };
  let attempts = 0;
  return {
    submitted,
    calls,
    loadAccount: async (id) => {
      const a = accounts[id];
      if (!a) { const e = new Error('Not Found'); e.response = { status: 404 }; throw e; }
      const acc = new sdk.Account(id, '100');
      Object.assign(acc, a);
      return acc;
    },
    submitTransaction: async (tx) => {
      const n = attempts++;
      if (failAt !== null && n === failAt) {
        const e = new Error('Bad Request');
        e.response = { status: 400, data: { extras: { result_codes: { transaction: 'tx_bad_seq' } } } };
        throw e;
      }
      submitted.push(tx);
      return { hash: tx.hash().toString('hex'), ledger: 1000 + n };
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
