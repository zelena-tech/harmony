'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { csvEvents, ConnectorError } = require('../src');
const { parseCsv, parseNumber } = require('../src/csv');

const base = { participant: 'who', rules: [{ metric: 'done' }] };

// -- parser -------------------------------------------------------------------

test('parser: quoted fields with commas, doubled quotes and newlines inside quotes', () => {
  const r = parseCsv('a,b\r\n"x, y","say ""hi"""\r\n"two\nlines",z\r\n', ',', 100);
  assert.deepEqual(r.map((x) => x.fields), [['a', 'b'], ['x, y', 'say "hi"'], ['two\nlines', 'z']]);
  assert.deepEqual(r.map((x) => x.line), [1, 2, 3]);
});

test('parser: line numbers count the line breaks inside quotes', () => {
  const r = parseCsv('a\n"1\n2\n3"\nlast\n', ',', 100);
  assert.deepEqual(r.map((x) => x.line), [1, 2, 5]);
});

test('parser: LF, CRLF and lone CR, blank lines ignored, no final newline needed', () => {
  assert.equal(parseCsv('a\r\nb\n\n   \r\nc\rd', ',', 100).map((x) => x.fields[0]).join(''), 'abcd');
});

test('parser: a quoted empty field is data, not a blank line', () => {
  const r = parseCsv('a\n""\n', ',', 100);
  assert.equal(r.length, 2);
  assert.deepEqual(r[1].fields, ['']);
});

test('parser: other delimiters, and a quote inside an unquoted field is plain text', () => {
  assert.deepEqual(parseCsv('a;b\n5" pipe;"c;d"', ';', 100).map((x) => x.fields), [['a', 'b'], ['5" pipe', 'c;d']]);
});

test('parser: text after a closing quote marks the record, an unterminated quote throws', () => {
  const r = parseCsv('a,b\n"x"y,2\n', ',', 100);
  assert.match(r[1].problem, /after the closing quote/);
  assert.throws(() => parseCsv('a\n"never closed\nmore', ',', 100), (e) => e instanceof ConnectorError && /line 2/.test(e.message));
});

test('parseNumber: both notations only when declared, nothing exotic', () => {
  assert.equal(parseNumber('1,234.56', '.'), 1234.56);
  assert.equal(parseNumber('1234.56', '.'), 1234.56);
  assert.equal(parseNumber('1.234,56', ','), 1234.56);
  assert.equal(parseNumber('1234,5', ','), 1234.5);
  assert.equal(parseNumber('-3', '.'), -3);
  assert.ok(Number.isNaN(parseNumber('1.234,56', '.')));
  assert.ok(Number.isNaN(parseNumber('1,234.56', ',')));
  assert.ok(Number.isNaN(parseNumber('1,23', '.')));
  for (const bad of ['', ' ', 'abc', '1e5', '0x10', 'Infinity', 'NaN', '$5', '5 USD', '1,2,3', '.5', '5.', '1'.repeat(41)]) {
    assert.ok(Number.isNaN(parseNumber(bad, '.')), JSON.stringify(bad));
  }
});

// -- csvEvents ----------------------------------------------------------------

test('basic: participant, name, one event per row, people deduplicated, BOM and padding tolerated', () => {
  const text = '﻿ who , Full name ,x\r\nana,Ana Demo,1\r\nben,Ben,1\r\nana,Ana Other,1\r\n';
  const r = csvEvents(text, { participant: 'who', name: 'Full name', rules: [{ metric: 'done' }] });
  assert.equal(r.rows, 3);
  assert.deepEqual(r.events, [
    { participantId: 'ana', metric: 'done', value: 1 },
    { participantId: 'ben', metric: 'done', value: 1 },
    { participantId: 'ana', metric: 'done', value: 1 },
  ]);
  assert.deepEqual(r.people, [{ participantId: 'ana', name: 'Ana Demo' }, { participantId: 'ben', name: 'Ben' }]);
  assert.deepEqual(r.skipped, []);
  assert.equal(r.window, null);
});

test('name falls back to the participant id', () => {
  const r = csvEvents('who\nana\n', base);
  assert.deepEqual(r.people, [{ participantId: 'ana', name: 'ana' }]);
});

test('delimiter ";" and decimal "," as Spanish-locale exports have them', () => {
  const text = 'who;amount\nana;"1.234,50"\nben;99,5\n';
  const r = csvEvents(text, { participant: 'who', delimiter: ';', decimal: ',', rules: [{ metric: 'sum', value: { column: 'amount' } }] });
  assert.deepEqual(r.events.map((e) => e.value), [1234.5, 99.5]);
});

test('numbers with the wrong separator for the declared notation are skipped, never guessed', () => {
  const r = csvEvents('who,amount\nana,"1.234,50"\nben,12\n', { participant: 'who', rules: [{ metric: 'sum', value: { column: 'amount' } }] });
  assert.equal(r.events.length, 1);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].line, 2);
  assert.match(r.skipped[0].reason, /not a number/);
});

test('rules: equals, in, notEmpty, comparisons; several conditions must all hold; a row feeds several rules', () => {
  const text = [
    'who,status,days,pod,amount',
    'ana,delivered,2,yes,100',
    'ana,delivered,9,,50',
    'ben,returned,1,yes,10',
    'cai,delivered,3,yes,70',
  ].join('\n');
  const r = csvEvents(text, {
    participant: 'who',
    rules: [
      { metric: 'delivery', when: [{ column: 'status', equals: 'delivered' }, { column: 'pod', notEmpty: true }] },
      { metric: 'fast', when: { column: 'days', lte: 3 } },
      { metric: 'bad', when: { column: 'status', in: ['returned', 'lost'] } },
      { metric: 'mid', when: { column: 'days', gt: 1, lt: 9 }, value: { column: 'amount' } },
      { metric: 'nopod', when: { column: 'pod', notEmpty: false } },
    ],
  });
  const summary = r.events.map((e) => `${e.participantId}:${e.metric}:${e.value}`);
  assert.deepEqual(summary, [
    'ana:delivery:1', 'ana:fast:1', 'ana:mid:100',
    'ana:nopod:1',
    'ben:fast:1', 'ben:bad:1',
    'cai:delivery:1', 'cai:fast:1', 'cai:mid:70',
  ]);
  assert.equal(r.unmatched, 0);
});

test('equals is exact: no case folding, no guessing', () => {
  const r = csvEvents('who,s\nana,Delivered\nben,delivered\n', { participant: 'who', rules: [{ metric: 'd', when: { column: 's', equals: 'delivered' } }] });
  assert.deepEqual(r.events.map((e) => e.participantId), ['ben']);
  assert.equal(r.unmatched, 1);
});

test('a comparison on an empty cell is false; on a non-number the row is skipped', () => {
  const r = csvEvents('who,days\nana,\nben,x\ncai,2\n', { participant: 'who', rules: [{ metric: 'fast', when: { column: 'days', lte: 3 } }] });
  assert.deepEqual(r.events.map((e) => e.participantId), ['cai']);
  assert.deepEqual(r.skipped.map((s) => s.line), [3]);
  assert.equal(r.unmatched, 1);
});

test('value: constant, column with scale and round; zero credits nothing', () => {
  const text = 'who,amount\nana,"12,345.60"\nben,999\ncai,0\n';
  const mk = (value) => csvEvents(text, { participant: 'who', rules: [{ metric: 'k', value }] }).events.map((e) => e.value);
  assert.deepEqual(mk(5), [5, 5, 5]);
  assert.deepEqual(mk({ column: 'amount', scale: 0.001 }), [12.3456, 0.999]);
  assert.deepEqual(mk({ column: 'amount', scale: 0.001, round: 'floor' }), [12]); // 0.999 floors to 0: nothing to credit
  assert.deepEqual(mk({ column: 'amount', scale: 0.001, round: 'ceil' }), [13, 1]);
  assert.deepEqual(mk({ column: 'amount', scale: 0.001, round: 1 }), [12.3, 1]);
});

test('unusable rows go to skipped with line and reason: no participant, bad number, negative, wrong column count', () => {
  const text = [
    'who,amount',
    ',5',
    'ana,abc',
    'ben,-4',
    'cai',
    'dan,1,extra',
    'eve,7',
  ].join('\n');
  const r = csvEvents(text, { participant: 'who', rules: [{ metric: 'k', value: { column: 'amount' } }] });
  assert.equal(r.rows, 6);
  assert.deepEqual(r.events, [{ participantId: 'eve', metric: 'k', value: 7 }]);
  assert.deepEqual(r.skipped.map((s) => s.line), [2, 3, 4, 5, 6]);
  assert.match(r.skipped[0].reason, /no participant/);
  assert.match(r.skipped[1].reason, /not a number/);
  assert.match(r.skipped[2].reason, /negative/);
  assert.match(r.skipped[3].reason, /expected 2 columns, found 1/);
  assert.match(r.skipped[4].reason, /expected 2 columns, found 3/);
});

test('a skipped row produces no event at all, not even from the rules that did work', () => {
  const r = csvEvents('who,ok,amount\nana,yes,abc\n', {
    participant: 'who',
    rules: [{ metric: 'a', when: { column: 'ok', equals: 'yes' } }, { metric: 'b', value: { column: 'amount' } }],
  });
  assert.deepEqual(r.events, []);
  assert.equal(r.skipped.length, 1);
  assert.deepEqual(r.people, []);
});

test('dates: ISO always, window [since, until) with until exclusive, at as ISO string', () => {
  const text = [
    'who,when',
    'ana,2026-10-31',
    'ana,2026-11-01',
    'ana,2026-11-15 13:30:00',
    'ana,2026-11-30T23:59:59Z',
    'ana,2026-12-01',
    'ana,2026-11-10T08:00:00-05:00',
  ].join('\n');
  const r = csvEvents(text, { participant: 'who', date: 'when', since: '2026-11-01', until: '2026-12-01', rules: [{ metric: 'k' }] });
  assert.deepEqual(r.events.map((e) => e.at), [
    '2026-11-01T00:00:00.000Z', '2026-11-15T13:30:00.000Z', '2026-11-30T23:59:59.000Z', '2026-11-10T13:00:00.000Z',
  ]);
  assert.deepEqual(r.skipped.map((s) => [s.line, /outside the period/.test(s.reason)]), [[2, true], [6, true]]);
  assert.deepEqual(r.window, { since: '2026-11-01T00:00:00.000Z', until: '2026-12-01T00:00:00.000Z' });
});

test('dates: a day-first or month-first date is read only when dateFormat says which', () => {
  const text = 'who,when\nana,05/03/2026\nben,13/03/2026\ncai,31/02/2026\n';
  const none = csvEvents(text, { participant: 'who', date: 'when', rules: [{ metric: 'k' }] });
  assert.equal(none.events.length, 0);
  assert.match(none.skipped[0].reason, /set "dateFormat"/);
  const dmy = csvEvents(text, { participant: 'who', date: 'when', dateFormat: 'DD/MM/YYYY', rules: [{ metric: 'k' }] });
  assert.deepEqual(dmy.events.map((e) => e.at.slice(0, 10)), ['2026-03-05', '2026-03-13']);
  assert.match(dmy.skipped[0].reason, /not a real/);
  const mdy = csvEvents(text, { participant: 'who', date: 'when', dateFormat: 'MM/DD/YYYY', rules: [{ metric: 'k' }] });
  assert.deepEqual(mdy.events.map((e) => e.at.slice(0, 10)), ['2026-05-03']);
  assert.equal(mdy.skipped.length, 2);
});

test('dates: empty, impossible and garbled dates are skipped', () => {
  const r = csvEvents('who,when\nana,\nben,2026-02-30\ncai,soon\ndan,2026-13-01\n', { participant: 'who', date: 'when', rules: [{ metric: 'k' }] });
  assert.equal(r.events.length, 0);
  assert.equal(r.skipped.length, 4);
});

test('ref is copied to each event, and a very long ref skips the row', () => {
  const r = csvEvents(`who,order\nana,SO-1\nben,\ncai,${'x'.repeat(201)}\n`, { participant: 'who', ref: 'order', rules: [{ metric: 'k' }, { metric: 'j' }] });
  assert.deepEqual(r.events.map((e) => [e.participantId, e.metric, e.ref]), [['ana', 'k', 'SO-1'], ['ana', 'j', 'SO-1'], ['ben', 'k', undefined], ['ben', 'j', undefined]]);
  assert.ok(!('ref' in r.events[2]));
  assert.equal(r.skipped.length, 1);
});

test('a usable row that no rule turns into an event is counted, not hidden', () => {
  const r = csvEvents('who,s\nana,x\nben,y\n', { participant: 'who', rules: [{ metric: 'k', when: { column: 's', equals: 'x' } }] });
  assert.equal(r.unmatched, 1);
  assert.deepEqual(r.people.map((p) => p.participantId), ['ana', 'ben']);
});

// -- hostile and limit cases --------------------------------------------------

test('formula-looking cells are plain data', () => {
  const r = csvEvents('who,s\n=HYPERLINK("http://x"),+1\n@cmd,-1\n', { participant: 'who', rules: [{ metric: 'k' }] });
  assert.deepEqual(r.events.map((e) => e.participantId), ['=HYPERLINK("http://x")', '@cmd']);
});

test('hostile ids that look like object keys do not touch prototypes', () => {
  const r = csvEvents('who\n__proto__\nconstructor\nhasOwnProperty\n', { participant: 'who', rules: [{ metric: 'k' }] });
  assert.deepEqual(r.people.map((p) => p.participantId), ['__proto__', 'constructor', 'hasOwnProperty']);
  assert.equal(({}).polluted, undefined);
});

test('huge numbers are skipped, not turned into Infinity or accepted', () => {
  const text = `who,amount\nana,${'9'.repeat(30)}\nben,1000000001\ncai,1e400\ndan,1000000000\n`;
  const r = csvEvents(text, { participant: 'who', rules: [{ metric: 'k', value: { column: 'amount' } }] });
  assert.deepEqual(r.events.map((e) => e.participantId), ['dan']);
  assert.equal(r.skipped.length, 3);
});

test('scale cannot be used to smuggle a huge value past the limit', () => {
  const r = csvEvents('who,amount\nana,500000000\n', { participant: 'who', rules: [{ metric: 'k', value: { column: 'amount', scale: 1000 } }] });
  assert.equal(r.events.length, 0);
  assert.match(r.skipped[0].reason, /limit/);
});

test('a very long participant id is skipped', () => {
  const r = csvEvents(`who\n${'a'.repeat(201)}\nok\n`, { participant: 'who', rules: [{ metric: 'k' }] });
  assert.deepEqual(r.events.map((e) => e.participantId), ['ok']);
  assert.equal(r.skipped.length, 1);
});

test('duplicate headers are an error that names both columns', () => {
  assert.throws(() => csvEvents('who,amount, amount \nana,1,2\n', base),
    (e) => e instanceof ConnectorError && e.source === 'csv' && /"amount" appears twice \(columns 2 and 3\)/.test(e.message));
});

test('a mapped column that is not in the header is an error listing the columns found', () => {
  assert.throws(() => csvEvents('a,b\n1,2\n', base), (e) => e instanceof ConnectorError && /no column "who"/.test(e.message) && /"a", "b"/.test(e.message));
  assert.throws(() => csvEvents('who\nx\n', { participant: 'who', rules: [{ metric: 'k', when: { column: 'nope', notEmpty: true } }] }), /no column "nope"/);
});

test('no header, header only, unterminated quote', () => {
  assert.throws(() => csvEvents('', base), /no header row/);
  assert.throws(() => csvEvents('\n\n', base), /no header row/);
  const r = csvEvents('who\n', base);
  assert.deepEqual([r.rows, r.events.length, r.skipped.length], [0, 0, 0]);
  assert.throws(() => csvEvents('who\n"abc\n', base), /unterminated/);
});

test('row limit: a clear error, not a silent truncation', () => {
  const text = `who\n${Array.from({ length: 6 }, (_, i) => `p${i}`).join('\n')}\n`;
  assert.equal(csvEvents(text, { ...base, maxRows: 6 }).rows, 6);
  assert.throws(() => csvEvents(text, { ...base, maxRows: 5 }), (e) => e instanceof ConnectorError && /more than 5 data rows/.test(e.message));
});

test('the default row limit is 200,000 and cannot be raised', () => {
  assert.throws(() => csvEvents('who\na\n', { ...base, maxRows: 200001 }), /maxRows/);
  const text = `who\n${'a\n'.repeat(200001)}`;
  assert.throws(() => csvEvents(text, base), /more than 200000 data rows/);
});

test('mapping problems are TypeErrors that say what to fix', () => {
  const bad = (m, rx) => assert.throws(() => csvEvents('who\na\n', m), (e) => e instanceof TypeError && rx.test(e.message), JSON.stringify(m));
  bad(null, /mapping must be an object/);
  bad({ rules: [{ metric: 'k' }] }, /participant is required/);
  bad({ participant: 'who' }, /rules must be a non-empty array/);
  bad({ participant: 'who', rules: [{ metric: 'k' }], colour: 1 }, /unknown key "colour"/);
  bad({ participant: 'who', rules: [{}] }, /metric is required/);
  bad({ participant: 'who', rules: [{ metric: 'k', value: -1 }] }, /value must be a number between/);
  bad({ participant: 'who', rules: [{ metric: 'k', value: { column: 'who', scale: 0 } }] }, /scale/);
  bad({ participant: 'who', rules: [{ metric: 'k', when: { column: 'who' } }] }, /needs one of/);
  bad({ participant: 'who', rules: [{ metric: 'k', when: { column: 'who', like: 'a' } }] }, /unknown key "like"/);
  bad({ participant: 'who', rules: [{ metric: 'k', when: { column: 'who', gt: 'a' } }] }, /finite number/);
  bad({ participant: 'who', rules: [{ metric: 'k' }], since: '2026-11-01' }, /need mapping.date/);
  bad({ participant: 'who', date: 'who', rules: [{ metric: 'k' }], since: 'yesterday' }, /ISO date/);
  bad({ participant: 'who', date: 'who', rules: [{ metric: 'k' }], since: '2026-11-02', until: '2026-11-01' }, /after mapping.since/);
  bad({ participant: 'who', rules: [{ metric: 'k' }], decimal: ';' }, /decimal/);
  bad({ participant: 'who', rules: [{ metric: 'k' }], delimiter: '"' }, /delimiter/);
  bad({ participant: 'who', rules: [{ metric: 'k' }], dateFormat: 'YYYY' }, /dateFormat/);
  assert.throws(() => csvEvents(42, base), /as a string/);
});

test('the mapping is not mutated and the result does not share state between calls', () => {
  const mapping = { participant: 'who', rules: [{ metric: 'k', when: { column: 'who', notEmpty: true } }] };
  const before = JSON.stringify(mapping);
  const a = csvEvents('who\nana\n', mapping);
  const b = csvEvents('who\nben\n', mapping);
  assert.equal(JSON.stringify(mapping), before);
  assert.equal(a.events[0].participantId, 'ana');
  assert.equal(b.events[0].participantId, 'ben');
});
