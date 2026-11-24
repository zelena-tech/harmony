'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { toStroops, fromStroops, MAX_STROOPS } = require('../src/money');

const refuses = (v) => assert.throws(() => toStroops(v), (e) => e.name === 'HarmonyError' && e.statusCode === 400 && !(e instanceof RangeError), `refuses ${String(v)}`);

test('toStroops is exact for strings: every whole/fraction pair up to ten million units', () => {
  // The old conversion multiplied by 1e7 in floating point and was off by a stroop from about 3e7 units.
  let seed = 123456789;
  const next = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (const max of [1e3, 1e6, 3e7, 1e8, 9e8, 9e11]) {
    for (let i = 0; i < 20000; i++) {
      const whole = BigInt(next(Math.min(max, 2147483647))) * BigInt(Math.max(1, Math.floor(max / 2147483647)));
      const frac = BigInt(next(1e7));
      const s = `${whole}.${frac.toString().padStart(7, '0')}`;
      assert.equal(toStroops(s), whole * 10000000n + frac, s);
    }
  }
  assert.equal(toStroops('899999999.9999999'), 8999999999999999n);
});

test('toStroops accepts numbers through toFixed(7) and strings with 0 to 7 decimals', () => {
  assert.equal(toStroops(0), 0n);
  assert.equal(toStroops(1), 10000000n);
  assert.equal(toStroops(0.1 + 0.2), 3000000n);
  assert.equal(toStroops(33.33333333333333), 333333333n);
  assert.equal(toStroops('5'), 50000000n);
  assert.equal(toStroops('5.5'), 55000000n);
  assert.equal(toStroops('0.0000001'), 1n);
  assert.equal(toStroops('0007.5000000'), 75000000n);
  assert.equal(toStroops(900000000.5), 9000000005000000n);
});

test('toStroops refuses negatives, NaN, exponents, text, more than 7 decimals and anything that is not a plain amount', () => {
  for (const bad of [-1, '-1', -0.0000001, NaN, Infinity, -Infinity, '', ' ', ' 1', '1 ', '1e3', '1E3', 1e21, '0x10', '1,5', '.5', '5.', '1.12345678', '+1',
    null, undefined, {}, [], true, 10n, 'Infinity', 'NaN']) refuses(bad);
});

test('toStroops stops at the int64 maximum of the network', () => {
  assert.equal(toStroops('922337203685.4775807'), MAX_STROOPS);
  refuses('922337203685.4775808');
  refuses('922337203686');
  refuses(922337203686);
  refuses(1e15);
  assert.equal(fromStroops(MAX_STROOPS), '922337203685.4775807');
});

test('a payer balance of a billion units is a normal amount', () => {
  assert.equal(toStroops('1000000000.0000000'), 10000000000000000n);
  assert.equal(fromStroops(toStroops('1000000000.1234567')), '1000000000.1234567');
});
