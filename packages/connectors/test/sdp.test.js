'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { toSdpDisbursement } = require('../src');

const wallet = (c) => `G${c.repeat(55)}`; // well-shaped, not a real key
const PLAN_ID = 'abcdef0123456789'.repeat(4);

const pocket = (id, amount, type) => ({ id, label: id, amount, rule: { type, at: type === 'instant' ? null : 1790000000 } });
const payment = (participantId, name, w, now, saved) => ({
  participantId, name, wallet: w, amount: '0.0000000', rank: 1,
  pockets: [pocket('now', now, 'instant'), ...(saved ? [pocket('savings', saved, 'unlocks')] : [])],
});

const plan = (payments, extra = {}) => ({
  planId: PLAN_ID, programId: 'demo', tenantId: 'acme', network: 'testnet',
  asset: { code: 'USDC', issuer: wallet('B') }, total: '0.0000000', payments, withoutWallet: [], ...extra,
});

const contacts = {
  w1: { phone: '+12025550101', email: 'Ana@Example.com', verification: '1990-01-30' },
  w2: { phone: '+12025550102', email: 'ben@example.com', verification: '1991-02-28' },
};
const basePlan = () => plan([
  payment('w1', 'Ana Demo', wallet('A'), '48.0000000', '12.0000000'),
  payment('w2', 'Ben Demo', wallet('C'), '0.1000000', '0.2000000'),
]);

test('phone_wallet: exact header and rows, default pockets are instant only', () => {
  const r = toSdpDisbursement(basePlan(), { mode: 'phone_wallet', contacts });
  assert.equal(r.csv.split('\n')[0], 'phone,id,amount,walletAddress,paymentID');
  assert.deepEqual(r.columns, ['phone', 'id', 'amount', 'walletAddress', 'paymentID']);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].amount, '48.0000000');
  assert.equal(r.rows[1].amount, '0.1000000');
  assert.equal(r.total, '48.1000000');
  assert.equal(r.csv.split('\n')[1], `+12025550101,w1,48.0000000,${wallet('A')},abcdef012345-w1`);
  assert.ok(r.csv.endsWith('\n'));
  assert.ok(r.notes.some((n) => /not selected/.test(n)));
});

test('email_wallet: header, lowercased email', () => {
  const r = toSdpDisbursement(basePlan(), { mode: 'email_wallet', contacts });
  assert.equal(r.csv.split('\n')[0], 'email,id,amount,walletAddress,paymentID');
  assert.equal(r.rows[0].email, 'ana@example.com');
  assert.equal(r.skipped.length, 0);
});

test('phone mode: verification column, header snapshot', () => {
  const r = toSdpDisbursement(basePlan(), { mode: 'phone', contacts, verificationType: 'DATE_OF_BIRTH' });
  assert.equal(r.csv.split('\n')[0], 'phone,id,amount,verification,paymentID');
  assert.equal(r.csv.split('\n')[1], '+12025550101,w1,48.0000000,1990-01-30,abcdef012345-w1');
  assert.ok(r.notes.some((n) => /registers themselves/.test(n)));
});

test('email mode: header snapshot', () => {
  const r = toSdpDisbursement(basePlan(), { mode: 'email', contacts, verificationType: 'DATE_OF_BIRTH' });
  assert.equal(r.csv.split('\n')[0], 'email,id,amount,verification,paymentID');
  assert.equal(r.rows.length, 2);
});

test('verification types are validated per type', () => {
  const run = (verificationType, verification) => toSdpDisbursement(
    plan([payment('w1', 'Ana', wallet('A'), '1.0000000')]),
    { mode: 'phone', verificationType, contacts: { w1: { phone: '+12025550101', verification } } },
  );
  assert.equal(run('YEAR_MONTH', '1990-12').rows.length, 1);
  assert.equal(run('YEAR_MONTH', '1990-13').rows.length, 0);
  assert.equal(run('DATE_OF_BIRTH', '1990-02-30').rows.length, 0);
  assert.equal(run('PIN', '123').rows.length, 0);
  assert.equal(run('PIN', '1234').rows.length, 1);
  assert.equal(run('PIN', '123456789').rows.length, 0);
  assert.equal(run('NATIONAL_ID_NUMBER', 'X'.repeat(51)).rows.length, 0);
  assert.equal(run('NATIONAL_ID_NUMBER', 'AB-1234').rows.length, 1);
  assert.throws(() => run('MOTHERS_NAME', 'x'), TypeError);
  assert.throws(() => toSdpDisbursement(basePlan(), { mode: 'phone', contacts }), /verificationType/);
});

test('mode is required and checked', () => {
  assert.throws(() => toSdpDisbursement(basePlan(), {}), /mode/);
  assert.throws(() => toSdpDisbursement(basePlan(), { mode: 'wallet' }), /mode/);
  assert.throws(() => toSdpDisbursement(null, { mode: 'phone_wallet' }), TypeError);
});

test('pockets: all sums everything and warns that time rules are lost', () => {
  const r = toSdpDisbursement(basePlan(), { mode: 'phone_wallet', contacts, pockets: 'all' });
  assert.equal(r.rows[0].amount, '60.0000000');
  assert.equal(r.rows[1].amount, '0.3000000');
  assert.equal(r.total, '60.3000000');
  assert.ok(r.notes.some((n) => /time rules/.test(n)));
});

test('pockets: list of ids', () => {
  const r = toSdpDisbursement(basePlan(), { mode: 'phone_wallet', contacts, pockets: ['savings'] });
  assert.equal(r.rows[0].amount, '12.0000000');
  assert.throws(() => toSdpDisbursement(basePlan(), { mode: 'phone_wallet', contacts, pockets: 7 }), TypeError);
});

test('amounts are summed exactly, with no floating point', () => {
  const p = plan([{ participantId: 'w1', name: 'Ana', wallet: wallet('A'), amount: '0.3000000', pockets: [
    pocket('a', '0.1000000', 'instant'), pocket('b', '0.2000000', 'instant'), pocket('c', '0.0000001', 'instant'),
    pocket('d', '9007199254740993.0000001', 'instant'),
  ] }]);
  const r = toSdpDisbursement(p, { mode: 'phone_wallet', contacts });
  assert.equal(r.rows[0].amount, '9007199254740993.3000002');
  assert.equal(r.total, '9007199254740993.3000002');
});

test('malformed amounts throw instead of being guessed', () => {
  const p = plan([payment('w1', 'Ana', wallet('A'), '1.5')]);
  assert.throws(() => toSdpDisbursement(p, { mode: 'phone_wallet', contacts }), /7 decimals/);
});

test('payment without pockets uses its amount', () => {
  const p = plan([{ participantId: 'w1', name: 'Ana', wallet: wallet('A'), amount: '5.0000000' }]);
  assert.equal(toSdpDisbursement(p, { mode: 'phone_wallet', contacts }).rows[0].amount, '5.0000000');
});

test('paymentID is deterministic, unique per person and within SDP limits', () => {
  const p = plan([
    payment('w1', 'Ana', wallet('A'), '1.0000000'),
    payment('a/b', 'Odd', wallet('C'), '1.0000000'),
    payment('a_b', 'Odd2', wallet('D'), '1.0000000'),
    payment('x'.repeat(64), 'Long', wallet('E'), '1.0000000'),
  ]);
  const c = {
    w1: { phone: '+12025550101' }, 'a/b': { phone: '+12025550102' },
    a_b: { phone: '+12025550103' }, ['x'.repeat(64)]: { phone: '+12025550104' },
  };
  const a = toSdpDisbursement(p, { mode: 'phone_wallet', contacts: c });
  const b = toSdpDisbursement(p, { mode: 'phone_wallet', contacts: c });
  assert.deepEqual(a.rows, b.rows);
  const ids = a.rows.map((r) => r.paymentID);
  assert.equal(new Set(ids).size, 4);
  assert.equal(ids[0], 'abcdef012345-w1');
  for (const id of ids) {
    assert.ok(id.length <= 64);
    assert.match(id, /^[A-Za-z0-9._-]+$/);
  }
  const other = toSdpDisbursement({ ...p, planId: 'f'.repeat(64) }, { mode: 'phone_wallet', contacts: c });
  assert.notEqual(other.rows[0].paymentID, ids[0]);
});

test('skipped: missing or invalid identifiers never produce a half-filled row', () => {
  const p = plan([
    payment('ok', 'Ok', wallet('A'), '1.0000000'),
    payment('nocontact', 'No Contact', wallet('C'), '1.0000000'),
    payment('badphone', 'Bad Phone', wallet('D'), '1.0000000'),
    payment('nowallet', 'No Wallet', '', '1.0000000'),
    payment('badwallet', 'Bad Wallet', 'GABC', '1.0000000'),
    payment('zero', 'Zero', wallet('E'), '0.0000000', '5.0000000'),
    payment('dup', 'Same Phone', wallet('F'), '1.0000000'),
  ]);
  const c = {
    ok: { phone: '+12025550101' },
    badphone: { phone: '2025550102' },
    nowallet: { phone: '+12025550103' },
    badwallet: { phone: '+12025550104' },
    zero: { phone: '+12025550105' },
    dup: { phone: '+12025550101' },
  };
  const r = toSdpDisbursement(p, { mode: 'phone_wallet', contacts: c });
  assert.deepEqual(r.rows.map((x) => x.id), ['ok']);
  const why = Object.fromEntries(r.skipped.map((s) => [s.participantId, s.reason]));
  assert.match(why.nocontact, /no phone/);
  assert.match(why.badphone, /E\.164/);
  assert.match(why.nowallet, /no wallet/);
  assert.match(why.badwallet, /shaped/);
  assert.match(why.zero, /nothing to pay/);
  assert.match(why.dup, /duplicate phone/);
  assert.equal(r.skipped.find((s) => s.participantId === 'nocontact').name, 'No Contact');
  assert.equal(r.csv.trim().split('\n').length, 2);
  assert.equal(r.total, '1.0000000');
});

test('duplicate wallets and duplicate emails (case-insensitive) are skipped', () => {
  const p = plan([payment('a', 'A', wallet('A'), '1.0000000'), payment('b', 'B', wallet('A'), '1.0000000'), payment('c', 'C', wallet('C'), '1.0000000')]);
  const r = toSdpDisbursement(p, { mode: 'email_wallet', contacts: {
    a: { email: 'x@example.com' }, b: { email: 'y@example.com' }, c: { email: 'X@EXAMPLE.COM' },
  } });
  assert.deepEqual(r.rows.map((x) => x.id), ['a']);
  assert.match(r.skipped.find((s) => s.participantId === 'b').reason, /duplicate wallet/);
  assert.match(r.skipped.find((s) => s.participantId === 'c').reason, /duplicate email/);
});

test('contacts lookup ignores inherited properties', () => {
  const p = plan([payment('constructor', 'X', wallet('A'), '1.0000000')]);
  const r = toSdpDisbursement(p, { mode: 'phone_wallet', contacts: {} });
  assert.equal(r.rows.length, 0);
  assert.match(r.skipped[0].reason, /no phone/);
});

test('CSV escaping: commas, quotes and newlines are quoted', () => {
  const p = plan([payment('a,b', 'A', wallet('A'), '1.0000000'), payment('say "hi"', 'B', wallet('C'), '1.0000000')]);
  const r = toSdpDisbursement(p, { mode: 'phone_wallet', contacts: {
    'a,b': { phone: '+12025550101' }, 'say "hi"': { phone: '+12025550102' },
  } });
  const lines = r.csv.split('\n');
  assert.match(lines[1], /^\+12025550101,"a,b",1\.0000000,G/);
  assert.match(lines[2], /^\+12025550102,"say ""hi""",1\.0000000,G/);
  const nl = toSdpDisbursement(plan([payment('a\nb', 'A', wallet('A'), '1.0000000')]), { mode: 'phone_wallet', contacts: { 'a\nb': { phone: '+12025550101' } } });
  assert.equal(nl.rows.length, 0); // control characters in an id are refused, not escaped
});

test('formula injection: ids, emails and verification values starting with = + - @ are skipped', () => {
  const p = plan(['=cmd', '+cmd', '-cmd', '@cmd', 'safe'].map((id, i) => payment(id, id, wallet('ACDEF'[i]), '1.0000000')));
  const r = toSdpDisbursement(p, { mode: 'email_wallet', contacts: { safe: { email: 'safe@example.com' } } });
  assert.deepEqual(r.rows.map((x) => x.id), ['safe']);
  assert.equal(r.skipped.length, 4);
  for (const s of r.skipped) assert.match(s.reason, /formula/);

  const e = toSdpDisbursement(plan([payment('a', 'A', wallet('A'), '1.0000000')]), { mode: 'email_wallet', contacts: { a: { email: '=1+1@example.com' } } });
  assert.equal(e.rows.length, 0);
  assert.match(e.skipped[0].reason, /formula/);

  const v = toSdpDisbursement(plan([payment('a', 'A', wallet('A'), '1.0000000')]), {
    mode: 'phone', verificationType: 'NATIONAL_ID_NUMBER', contacts: { a: { phone: '+12025550101', verification: '=HYPERLINK("x")' } },
  });
  assert.equal(v.rows.length, 0);
  assert.match(v.skipped[0].reason, /formula/);
});

test('notes: people without a wallet, and the SDP-side configuration reminder', () => {
  const r = toSdpDisbursement(plan([payment('w1', 'Ana', wallet('A'), '1.0000000')], { withoutWallet: ['Someone'] }),
    { mode: 'phone_wallet', contacts });
  assert.ok(r.notes.some((n) => /no wallet/.test(n)));
  assert.ok(r.notes.some((n) => /chosen in SDP/.test(n)));
});

test('the plan is not mutated', () => {
  const p = basePlan();
  const before = JSON.stringify(p);
  toSdpDisbursement(p, { mode: 'phone_wallet', contacts });
  assert.equal(JSON.stringify(p), before);
});
