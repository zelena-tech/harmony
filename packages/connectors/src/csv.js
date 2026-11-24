'use strict';

const { ConnectorError } = require('./errors');

/**
 * CSV to Harmony events. Pure: text in, events out, no file system and no network.
 *
 * Most companies cannot give API access on day one, but all of them can export a
 * spreadsheet. `csvEvents` turns such an export into the same plain events the
 * other connectors produce, `{ participantId, metric, value, at?, ref? }`.
 *
 * Nothing is guessed. A row that cannot be used (no participant, a date or a
 * number that does not parse, a negative value, a different number of columns
 * than the header) is reported in `skipped` with its line number and the reason.
 * An ambiguous date (05/03/2026) is only read when the mapping says which order
 * it uses; a number with separators only when the mapping says which character
 * is the decimal one. Cells are data: a cell that starts with `=` is text.
 */

const DEFAULT_MAX_ROWS = 200000;
const MAX_CHARS = 64 * 1024 * 1024; // hard ceiling on the input, whatever maxRows says
const MAX_EVENT_VALUE = 1e9; // the kit rejects larger event values
const MAX_ID_LENGTH = 200;
const MAX_REF_LENGTH = 200;
const MAX_NUMBER_LENGTH = 40;

const MAPPING_KEYS = ['participant', 'name', 'date', 'dateFormat', 'since', 'until', 'rules', 'ref', 'decimal', 'delimiter', 'maxRows'];
const OPERATORS = ['equals', 'in', 'notEmpty', 'gt', 'gte', 'lt', 'lte'];
const DATE_FORMATS = ['ISO', 'DD/MM/YYYY', 'MM/DD/YYYY'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim().length > 0;
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}...` : s);
const show = (s) => JSON.stringify(clip(String(s), 30));

/** A row-level problem: the row goes to `skipped`, the run goes on. */
class RowProblem extends Error {}

// -- parser -------------------------------------------------------------------

/**
 * RFC 4180 reader. Returns records `{ line, fields, problem }` where `line` is the
 * 1-based physical line on which the record starts. Blank lines are dropped.
 * A quoted field may hold the delimiter, doubled quotes and line breaks.
 */
function parseCsv(text, delimiter, maxRecords) {
  const records = [];
  let fields = [];
  let field = '';
  let inQuotes = false;
  let afterQuote = false;
  let quotedAny = false;
  let problem = null;
  let line = 1;
  let recordLine = 1;
  let quoteLine = 1;
  const n = text.length;

  const endField = () => { fields.push(field); field = ''; afterQuote = false; };
  const endRecord = () => {
    endField();
    const blank = fields.length === 1 && !quotedAny && fields[0].trim() === '';
    if (!blank) {
      if (records.length >= maxRecords) {
        throw new ConnectorError(`csv has more than ${maxRecords - 1} data rows: split the file or raise "maxRows"`, { source: 'csv' });
      }
      records.push({ line: recordLine, fields, problem });
    }
    fields = [];
    quotedAny = false;
    problem = null;
  };

  for (let i = 0; i < n; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; afterQuote = true; }
      } else {
        if (c === '\n') line += 1;
        field += c;
      }
    } else if (c === delimiter) {
      endField();
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      endRecord();
      line += 1;
      recordLine = line;
    } else if (afterQuote) {
      if (!problem) problem = 'text after the closing quote of a field';
    } else if (c === '"' && field === '') {
      inQuotes = true;
      quotedAny = true;
      quoteLine = line;
    } else {
      field += c; // a quote in the middle of an unquoted field is plain text
    }
  }
  if (inQuotes) {
    throw new ConnectorError(`csv has an unterminated quoted field that starts at line ${quoteLine}: the file looks truncated or a quote is missing`, { source: 'csv' });
  }
  if (field !== '' || fields.length > 0 || quotedAny) endRecord();
  return records;
}

// -- numbers and dates --------------------------------------------------------

/**
 * Strict decimal number. With decimal '.', "1,234.56" and "1234.56"; with ',',
 * "1.234,56" and "1234,56". No exponent, no currency sign, no NaN, no hex.
 * Returns NaN when the text is not a number in that notation.
 */
function parseNumber(text, decimal) {
  const s = String(text).trim();
  if (!s || s.length > MAX_NUMBER_LENGTH) return NaN;
  const group = decimal === ',' ? '\\.' : ',';
  const dec = decimal === ',' ? ',' : '\\.';
  const rx = new RegExp(`^[+-]?(\\d+|\\d{1,3}(${group}\\d{3})+)(${dec}\\d+)?$`);
  if (!rx.test(s)) return NaN;
  const plain = decimal === ',' ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  const v = Number(plain);
  return Number.isFinite(v) ? v : NaN;
}

function utcDate(y, mo, d, h, mi, s, offsetMinutes) {
  const t = Date.UTC(y, mo - 1, d, h, mi, s);
  const probe = new Date(t);
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null; // 31/02 and friends
  if (h > 23 || mi > 59 || s > 59) return null;
  return new Date(t - offsetMinutes * 60000);
}

const ISO_RX = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const SLASH_RX = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

function offsetOf(z) {
  if (!z || z === 'Z') return 0;
  const m = z.match(/^([+-])(\d{2}):?(\d{2})$/);
  const mins = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === '-' ? -mins : mins;
}

/**
 * ISO dates are always read; a day-first or month-first date only when `format`
 * says which. A time without an offset is UTC. Returns a Date, or throws RowProblem.
 */
function parseDate(text, format) {
  const s = String(text).trim();
  if (!s) throw new RowProblem('the date cell is empty');
  let m = s.match(ISO_RX);
  if (m) {
    const d = utcDate(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), offsetOf(m[7]));
    if (d) return d;
    throw new RowProblem(`date ${show(s)} is not a real date`);
  }
  m = s.match(SLASH_RX);
  if (m) {
    if (format === 'ISO') throw new RowProblem(`date ${show(s)} is not ISO (YYYY-MM-DD): set "dateFormat" to DD/MM/YYYY or MM/DD/YYYY`);
    const first = +m[1];
    const second = +m[3];
    const [day, month] = format === 'DD/MM/YYYY' ? [first, second] : [second, first];
    const d = utcDate(+m[4], month, day, +(m[5] || 0), +(m[6] || 0), +(m[7] || 0), 0);
    if (d) return d;
    throw new RowProblem(`date ${show(s)} is not a real ${format} date`);
  }
  throw new RowProblem(`date ${show(s)} cannot be read`);
}

/** Strict ISO date or date-time for the `since`/`until` options. */
function windowDate(value, name) {
  const m = typeof value === 'string' ? value.match(ISO_RX) : null;
  const d = m ? utcDate(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), offsetOf(m[7])) : null;
  if (!d) throw new TypeError(`"${name}" must be an ISO date such as 2026-11-01`);
  return d;
}

// -- mapping ------------------------------------------------------------------

function readCondition(c, where) {
  if (!isObject(c)) throw new TypeError(`${where} must be an object`);
  if (!isText(c.column)) throw new TypeError(`${where}.column is required`);
  const ops = Object.keys(c).filter((k) => k !== 'column');
  const bad = ops.filter((k) => !OPERATORS.includes(k));
  if (bad.length) throw new TypeError(`${where}: unknown key "${bad[0]}" (use one of ${OPERATORS.join(', ')})`);
  if (!ops.length) throw new TypeError(`${where} needs one of ${OPERATORS.join(', ')}`);
  for (const k of ['gt', 'gte', 'lt', 'lte']) {
    if (k in c && !(typeof c[k] === 'number' && Number.isFinite(c[k]))) throw new TypeError(`${where}.${k} must be a finite number`);
  }
  if ('in' in c && !(Array.isArray(c.in) && c.in.length && c.in.every((x) => typeof x === 'string' || typeof x === 'number'))) {
    throw new TypeError(`${where}.in must be a non-empty array of strings or numbers`);
  }
  if ('equals' in c && !(typeof c.equals === 'string' || typeof c.equals === 'number')) throw new TypeError(`${where}.equals must be a string or a number`);
  if ('notEmpty' in c && typeof c.notEmpty !== 'boolean') throw new TypeError(`${where}.notEmpty must be true or false`);
  return { column: c.column, ...Object.fromEntries(ops.map((k) => [k, c[k]])) };
}

function readRule(r, i) {
  const where = `mapping.rules[${i}]`;
  if (!isObject(r)) throw new TypeError(`${where} must be an object`);
  for (const k of Object.keys(r)) if (!['metric', 'when', 'value'].includes(k)) throw new TypeError(`${where}: unknown key "${k}"`);
  if (!isText(r.metric)) throw new TypeError(`${where}.metric is required`);
  const when = r.when === undefined ? [] : (Array.isArray(r.when) ? r.when : [r.when]);
  const conditions = when.map((c, j) => readCondition(c, `${where}.when${Array.isArray(r.when) ? `[${j}]` : ''}`));
  let value = { constant: 1 };
  if (r.value !== undefined) {
    if (typeof r.value === 'number') {
      if (!(Number.isFinite(r.value) && r.value >= 0 && r.value <= MAX_EVENT_VALUE)) throw new TypeError(`${where}.value must be a number between 0 and ${MAX_EVENT_VALUE}`);
      value = { constant: r.value };
    } else if (isObject(r.value)) {
      for (const k of Object.keys(r.value)) if (!['column', 'scale', 'round'].includes(k)) throw new TypeError(`${where}.value: unknown key "${k}"`);
      if (!isText(r.value.column)) throw new TypeError(`${where}.value.column is required`);
      const scale = r.value.scale === undefined ? 1 : r.value.scale;
      if (!(typeof scale === 'number' && Number.isFinite(scale) && scale > 0)) throw new TypeError(`${where}.value.scale must be a number greater than 0`);
      const round = r.value.round;
      if (round !== undefined && !(round === 'floor' || round === 'ceil' || (Number.isInteger(round) && round >= 0 && round <= 7))) {
        throw new TypeError(`${where}.value.round must be "floor", "ceil" or a number of decimals (0 to 7)`);
      }
      value = { column: r.value.column, scale, round };
    } else {
      throw new TypeError(`${where}.value must be a number or { column, scale?, round? }`);
    }
  }
  return { metric: r.metric, conditions, value };
}

function readMapping(mapping) {
  if (!isObject(mapping)) throw new TypeError('mapping must be an object');
  for (const k of Object.keys(mapping)) {
    if (!MAPPING_KEYS.includes(k)) throw new TypeError(`mapping: unknown key "${k}" (known keys: ${MAPPING_KEYS.join(', ')})`);
  }
  if (!isText(mapping.participant)) throw new TypeError('mapping.participant is required: the column that says who did the work');
  for (const k of ['name', 'date', 'ref']) {
    if (mapping[k] !== undefined && !isText(mapping[k])) throw new TypeError(`mapping.${k} must be a column name`);
  }
  const dateFormat = mapping.dateFormat === undefined ? 'ISO' : mapping.dateFormat;
  if (!DATE_FORMATS.includes(dateFormat)) throw new TypeError(`mapping.dateFormat must be one of ${DATE_FORMATS.join(', ')}`);
  const decimal = mapping.decimal === undefined ? '.' : mapping.decimal;
  if (decimal !== '.' && decimal !== ',') throw new TypeError('mapping.decimal must be "." or ","');
  const delimiter = mapping.delimiter === undefined ? ',' : mapping.delimiter;
  if (typeof delimiter !== 'string' || delimiter.length !== 1 || delimiter === '"' || delimiter === '\n' || delimiter === '\r') {
    throw new TypeError('mapping.delimiter must be one character other than a quote or a line break');
  }
  const maxRows = mapping.maxRows === undefined ? DEFAULT_MAX_ROWS : mapping.maxRows;
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > DEFAULT_MAX_ROWS) throw new TypeError(`mapping.maxRows must be an integer from 1 to ${DEFAULT_MAX_ROWS}`);
  if (!Array.isArray(mapping.rules) || !mapping.rules.length) throw new TypeError('mapping.rules must be a non-empty array');
  const rules = mapping.rules.map(readRule);

  const since = mapping.since === undefined ? null : windowDate(mapping.since, 'since');
  const until = mapping.until === undefined ? null : windowDate(mapping.until, 'until');
  if ((since || until) && !mapping.date) throw new TypeError('mapping.since and mapping.until need mapping.date: the column that holds the date of each row');
  if (since && until && until <= since) throw new TypeError('mapping.until must be after mapping.since');

  return {
    participant: mapping.participant, name: mapping.name || null, date: mapping.date || null, ref: mapping.ref || null,
    dateFormat, decimal, delimiter, maxRows, rules, since, until,
  };
}

// -- rules --------------------------------------------------------------------

function holds(cond, cell, decimal) {
  const text = cell.trim();
  if ('notEmpty' in cond && (text !== '') !== cond.notEmpty) return false;
  if ('equals' in cond && text !== String(cond.equals)) return false;
  if ('in' in cond && !cond.in.some((x) => text === String(x))) return false;
  const numeric = ['gt', 'gte', 'lt', 'lte'].filter((k) => k in cond);
  if (numeric.length) {
    if (text === '') return false;
    const v = parseNumber(text, decimal);
    if (Number.isNaN(v)) throw new RowProblem(`column "${cond.column}" is not a number: ${show(text)}`);
    if ('gt' in cond && !(v > cond.gt)) return false;
    if ('gte' in cond && !(v >= cond.gte)) return false;
    if ('lt' in cond && !(v < cond.lt)) return false;
    if ('lte' in cond && !(v <= cond.lte)) return false;
  }
  return true;
}

function roundTo(v, round) {
  if (round === undefined) return v;
  if (round === 'floor') return Math.floor(v);
  if (round === 'ceil') return Math.ceil(v);
  const f = 10 ** round;
  return Math.round(v * f) / f;
}

function valueOf(rule, cell, decimal) {
  if (rule.value.column === undefined) return rule.value.constant;
  const text = cell.trim();
  if (text === '') throw new RowProblem(`column "${rule.value.column}" is empty but metric "${rule.metric}" needs a number`);
  const n = parseNumber(text, decimal);
  if (Number.isNaN(n)) throw new RowProblem(`column "${rule.value.column}" is not a number: ${show(text)}`);
  if (n < 0) throw new RowProblem(`column "${rule.value.column}" is negative (${show(text)}): a value is never negative, use a metric with negative points instead`);
  const v = roundTo(Number((n * rule.value.scale).toPrecision(12)), rule.value.round); // toPrecision drops float noise such as 12.345600000000001
  if (!Number.isFinite(v) || v > MAX_EVENT_VALUE) throw new RowProblem(`column "${rule.value.column}" gives ${show(v)}, above the limit of ${MAX_EVENT_VALUE} per event`);
  return v;
}

// -- main ---------------------------------------------------------------------

/**
 * Turns CSV text into events.
 *
 * @param {string} text
 * @param {object} mapping
 * @param {string} mapping.participant  column that holds who did the work (required)
 * @param {string} [mapping.name]       column with the display name
 * @param {string} [mapping.date]       column with the date of the row
 * @param {string} [mapping.dateFormat] 'ISO' (default), 'DD/MM/YYYY' or 'MM/DD/YYYY'
 * @param {string} [mapping.since]      ISO date; rows before it are skipped (needs `date`)
 * @param {string} [mapping.until]      ISO date, exclusive; rows from it on are skipped (needs `date`)
 * @param {Array}  mapping.rules        [{ metric, when?, value? }]: each rule makes at most one event per row
 * @param {string} [mapping.ref]        column copied to the `ref` of each event
 * @param {'.'|','} [mapping.decimal]   decimal character of the numbers (default '.')
 * @param {string} [mapping.delimiter]  field delimiter (default ',')
 * @param {number} [mapping.maxRows]    most data rows accepted (default and ceiling 200000)
 * @returns {{
 *   events: Array<{participantId: string, metric: string, value: number, at?: string, ref?: string}>,
 *   people: Array<{participantId: string, name: string}>,
 *   rows: number,
 *   skipped: Array<{line: number, reason: string}>,
 *   unmatched: number,
 *   window: {since: string|null, until: string|null}|null,
 * }}
 *   `rows` counts the data rows read (blank lines excluded). `unmatched` counts usable rows
 *   that no rule turned into an event (a cancelled order, say): they are not errors, but they
 *   are counted so that nothing disappears. `people` lists everybody who has a usable row.
 */
function csvEvents(text, mapping) {
  if (typeof text !== 'string') throw new TypeError('csvEvents needs the CSV as a string');
  const m = readMapping(mapping);
  if (text.length > MAX_CHARS) throw new ConnectorError(`csv is larger than ${MAX_CHARS} characters`, { source: 'csv' });
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const records = parseCsv(body, m.delimiter, m.maxRows + 1);
  if (!records.length) throw new ConnectorError('csv has no header row', { source: 'csv' });
  const head = records[0];
  if (head.problem) throw new ConnectorError(`csv header row (line ${head.line}) is malformed: ${head.problem}`, { source: 'csv' });
  const headers = head.fields.map((h) => h.trim());
  const index = new Map();
  headers.forEach((h, i) => {
    if (h === '') return;
    if (index.has(h)) throw new ConnectorError(`csv header "${h}" appears twice (columns ${index.get(h) + 1} and ${i + 1}): rename one so a column can be told apart`, { source: 'csv' });
    index.set(h, i);
  });

  const columnOf = (name, what) => {
    if (!index.has(name)) {
      throw new ConnectorError(`csv has no column "${name}" (${what}). Columns found: ${headers.filter(Boolean).map((h) => `"${h}"`).join(', ') || 'none'}`, { source: 'csv' });
    }
    return index.get(name);
  };
  const col = {
    participant: columnOf(m.participant, 'mapping.participant'),
    name: m.name ? columnOf(m.name, 'mapping.name') : -1,
    date: m.date ? columnOf(m.date, 'mapping.date') : -1,
    ref: m.ref ? columnOf(m.ref, 'mapping.ref') : -1,
  };
  const rules = m.rules.map((r) => ({
    ...r,
    conditions: r.conditions.map((c) => ({ ...c, index: columnOf(c.column, `condition of "${r.metric}"`) })),
    value: r.value.column === undefined ? r.value : { ...r.value, index: columnOf(r.value.column, `value of "${r.metric}"`) },
  }));

  const events = [];
  const skipped = [];
  const people = new Map();
  let unmatched = 0;
  let rows = 0;

  for (let r = 1; r < records.length; r += 1) {
    const rec = records[r];
    rows += 1;
    const skip = (reason) => skipped.push({ line: rec.line, reason });
    if (rec.problem) { skip(rec.problem); continue; }
    if (rec.fields.length !== headers.length) { skip(`expected ${headers.length} columns, found ${rec.fields.length}`); continue; }
    const cells = rec.fields;

    try {
      const participantId = cells[col.participant].trim();
      if (!participantId) throw new RowProblem(`no participant (column "${m.participant}" is empty)`);
      if (participantId.length > MAX_ID_LENGTH) throw new RowProblem(`participant is longer than ${MAX_ID_LENGTH} characters`);

      let at;
      if (col.date >= 0) {
        const d = parseDate(cells[col.date], m.dateFormat);
        if ((m.since && d < m.since) || (m.until && d >= m.until)) {
          throw new RowProblem(`outside the period (${d.toISOString().slice(0, 10)})`);
        }
        at = d.toISOString();
      }
      let ref;
      if (col.ref >= 0) {
        const v = cells[col.ref].trim();
        if (v.length > MAX_REF_LENGTH) throw new RowProblem(`reference is longer than ${MAX_REF_LENGTH} characters`);
        if (v) ref = v;
      }

      const made = [];
      for (const rule of rules) {
        if (!rule.conditions.every((c) => holds(c, cells[c.index], m.decimal))) continue;
        const value = valueOf(rule, rule.value.index === undefined ? '' : cells[rule.value.index], m.decimal);
        if (value === 0) continue; // zero units: nothing to credit
        const ev = { participantId, metric: rule.metric, value };
        if (at !== undefined) ev.at = at;
        if (ref !== undefined) ev.ref = ref;
        made.push(ev);
      }

      if (!people.has(participantId)) people.set(participantId, '');
      if (col.name >= 0 && !people.get(participantId)) people.set(participantId, cells[col.name].trim());
      if (!made.length) unmatched += 1;
      for (const ev of made) events.push(ev);
    } catch (e) {
      if (!(e instanceof RowProblem)) throw e;
      skip(e.message);
    }
  }

  return {
    events,
    people: [...people].map(([participantId, name]) => ({ participantId, name: name || participantId })),
    rows,
    skipped,
    unmatched,
    window: m.since || m.until ? { since: m.since ? m.since.toISOString() : null, until: m.until ? m.until.toISOString() : null } : null,
  };
}

module.exports = { csvEvents, parseCsv, parseNumber };
