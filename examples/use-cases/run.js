'use strict';

/**
 * Harmony use cases from a CSV: reads an export, scores it with a template and
 * shows the ranking and what a payout would look like.
 *
 *   node examples/use-cases/run.js <case> [--out dir] [--now YYYY-MM-DD]
 *
 * <case> is a folder next to this file (carriers, suppliers, collections) with
 * a data.csv and a case.json. Pocket dates are counted from the end of the
 * period unless --now is given, so the output is the same on every run (the
 * wallets and the plan id are random).
 *
 * It stops at the plan. Nothing is built, signed or sent, and no network is
 * used. Wallets marked "generate" in case.json are random keypairs made for the
 * run: only their public key is used and the secret is thrown away.
 */

const fs = require('node:fs');
const path = require('node:path');
const { sdk } = require('../../packages/core');
const { csvEvents, ConnectorError } = require('../../packages/connectors/src');
const kit = require('../../packages/kit/src');

const TOP_KEYS = ['title', 'description', 'organization', 'period', 'mapping', 'template', 'overrides', 'people', 'lifetime'];
const USAGE = 'Usage: node examples/use-cases/run.js <case> [--out dir] [--now YYYY-MM-DD]\n'
  + `       cases: ${listCases().join(', ') || '(none found)'}`;

const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);
const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'person';
const mdCell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const money = (a) => Number(a).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}~` : String(s));
const when = (rule, at) => (rule.type === 'instant' ? 'on payment' : `${rule.type} ${day(at)}`);

class UsageError extends Error {}

function listCases() {
  try {
    return fs.readdirSync(__dirname, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(__dirname, d.name, 'case.json')))
      .map((d) => d.name).sort();
  } catch { return []; }
}

function parseArgs(argv) {
  const out = { name: null, out: null, now: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = (flag) => {
      if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
      i += 1;
      if (i >= argv.length || argv[i].startsWith('--')) throw new UsageError(`${flag} needs a value`);
      return argv[i];
    };
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--out' || a.startsWith('--out=')) out.out = value('--out');
    else if (a === '--now' || a.startsWith('--now=')) out.now = value('--now');
    else if (a.startsWith('--')) throw new UsageError(`unknown argument "${a}"`);
    else if (out.name === null) out.name = a;
    else throw new UsageError(`unexpected argument "${a}"`);
  }
  return out;
}

// -- case file ----------------------------------------------------------------

function loadCase(name) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name || '')) throw new UsageError(`"${name}" is not a case name`);
  const dir = path.join(__dirname, name);
  const caseFile = path.join(dir, 'case.json');
  if (!fs.existsSync(caseFile)) throw new UsageError(`there is no case "${name}"`);
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(caseFile, 'utf8').replace(/^﻿/, '')); } catch (e) { throw new UsageError(`${name}/case.json is not valid JSON: ${e.message}`); }

  const problems = [];
  if (!isObject(cfg)) throw new UsageError(`${name}/case.json must be a JSON object`);
  for (const k of Object.keys(cfg)) if (!TOP_KEYS.includes(k)) problems.push(`unknown key "${k}" (known keys: ${TOP_KEYS.join(', ')})`);
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(cfg.organization || '')) problems.push('organization must be a lowercase slug (a-z, 0-9, -), 2 to 63 characters');
  if (!isObject(cfg.period) || Number.isNaN(Date.parse(cfg.period.since)) || Number.isNaN(Date.parse(cfg.period.until))) {
    problems.push('period needs since and until: { "label": "November 2026", "since": "2026-11-01", "until": "2026-12-01" }');
  }
  if (!isObject(cfg.mapping)) problems.push('mapping is required: how the CSV columns become events (see packages/connectors/README.md)');
  if (typeof cfg.template !== 'string') problems.push('template is required (one of the ids of kit.templates())');
  for (const k of ['overrides', 'people', 'lifetime']) if (cfg[k] !== undefined && !isObject(cfg[k])) problems.push(`${k} must be an object`);
  for (const [id, p] of Object.entries(cfg.people || {})) {
    if (!isObject(p)) { problems.push(`people.${id} must be an object`); continue; }
    if (!(p.wallet === undefined || p.wallet === null || p.wallet === 'generate' || (typeof p.wallet === 'string' && sdk.StrKey.isValidEd25519PublicKey(p.wallet)))) {
      problems.push(`people.${id}.wallet must be "generate", null or a public key (G...)`);
    }
  }
  for (const [id, v] of Object.entries(cfg.lifetime || {})) if (!(Number.isFinite(v) && v >= 0)) problems.push(`lifetime.${id} must be a number >= 0`);
  if (problems.length) throw new UsageError(`${name}/case.json has problems:\n  - ${problems.join('\n  - ')}`);
  return { cfg, dir };
}

// -- the run ------------------------------------------------------------------

function run(cfg, text, nowSeconds) {
  const mapping = { ...cfg.mapping, since: cfg.period.since, until: cfg.period.until };
  const read = csvEvents(text, mapping);

  const harmony = kit.createProgram({
    tenant: { id: cfg.organization, network: 'testnet' },
    program: cfg.template,
    overrides: cfg.overrides,
  });

  const known = new Set(read.people.map((p) => p.participantId));
  const notInCsv = Object.keys(cfg.people || {}).filter((id) => !known.has(id));

  // Wallets: "generate" makes a random key for the run, anything else means nobody to pay yet.
  const roster = read.people.map((p) => {
    const entry = (cfg.people || {})[p.participantId] || {};
    const wallet = entry.wallet === 'generate' ? sdk.Keypair.random().publicKey() : (entry.wallet || null);
    return { participantId: p.participantId, name: entry.name || p.name, wallet };
  });

  const { standings, totals, ignored } = harmony.score({
    events: read.events,
    participants: read.people.map((p) => p.participantId),
    lifetime: cfg.lifetime,
  });

  let plan = null;
  let planError = null;
  try {
    plan = harmony.plan({ standings, people: roster, now: nowSeconds });
  } catch (e) {
    if (e && e.statusCode && e.code === 'NOBODY_QUALIFIED') planError = e.message;
    else throw e;
  }
  const byMetric = new Map();
  for (const e of read.events) {
    const m = byMetric.get(e.metric) || { events: 0, units: 0 };
    m.events += 1;
    m.units += e.value;
    byMetric.set(e.metric, m);
  }
  return { cfg, mapping, read, harmony, roster, standings, totals, ignored, plan, planError, notInCsv, byMetric, now: nowSeconds };
}

// -- screen -------------------------------------------------------------------

function nameOf(rep, id) {
  return (rep.roster.find((r) => r.participantId === id) || {}).name || id;
}

function printScreen(rep, outDir, files) {
  const { cfg, read, harmony, plan } = rep;
  const program = harmony.program;
  const line = (s = '') => console.log(s);

  line(`${cfg.title || cfg.template}   (${cfg.period.label || `${cfg.period.since} to ${cfg.period.until}`})`);
  if (cfg.description) line(cfg.description);
  line(`Template ${program.id}, ${program.industry}. Preview only: nothing is built, signed or sent.`);

  line('');
  line('WHAT WAS READ');
  line(`  ${read.rows} data rows  ->  ${read.events.length} events for ${read.people.length} participants; ${read.skipped.length} rows skipped; ${read.unmatched} usable rows matched no rule`);
  line(`  period ${cfg.period.since} up to, not including, ${cfg.period.until}`);
  line(`  ${pad('metric', 22)} ${rpad('events', 7)} ${rpad('units', 12)}`);
  for (const m of program.metrics) {
    const x = rep.byMetric.get(m.id) || { events: 0, units: 0 };
    line(`  ${pad(m.id, 22)} ${rpad(x.events, 7)} ${rpad(Number(x.units.toFixed(3)).toLocaleString('en-US'), 12)}`);
  }
  if (Object.keys(rep.ignored).length) line(`  events of metrics the program does not have: ${JSON.stringify(rep.ignored)}`);
  if (read.skipped.length) {
    line('');
    line('SKIPPED ROWS (review these before trusting the ranking)');
    for (const s of read.skipped) line(`  line ${rpad(s.line, 4)}  ${s.reason}`);
  }
  if (rep.notInCsv.length) line(`\n  note: people in case.json that have no usable row in the CSV: ${rep.notInCsv.join(', ')}`);

  line('');
  line(`STANDINGS  (${rep.totals.qualified} of ${rep.totals.participants} qualified; points = units x points per unit, with caps, times the level multiplier)`);
  for (const s of rep.standings) {
    const units = program.metrics.filter((m) => s.byMetric[m.id].reported > 0)
      .map((m) => {
        const b = s.byMetric[m.id];
        return `${m.id} ${Number(b.reported.toFixed(3))}${b.units < b.reported ? ` (counted ${Number(b.units.toFixed(3))}, capped)` : ''}`;
      }).join(', ');
    line(`  ${rpad(s.rank, 2)}  ${pad(clip(nameOf(rep, s.participantId), 28), 28)} ${pad(s.level.name, 16)} x${pad(s.level.multiplier, 5)} ${rpad(s.adjustedPoints, 8)} pts${s.qualified ? '' : '  (does not qualify)'}`);
    line(`      ${units || 'no events'}`);
  }

  line('');
  if (!plan) {
    line(`PAYOUT PREVIEW  none: ${rep.planError}`);
  } else {
    const r = plan.rule;
    const how = r.model === 'rate'
      ? `rate ${r.rate} per point, budget ${r.budget}: points are worth ${money(r.due)}${r.scaledToBudget ? `, cut down to the budget of ${money(r.budget)}` : ', inside the budget'}`
      : `pool ${money(r.pool)} shared by points`;
    line(`PAYOUT PREVIEW  ${plan.asset.code} on ${plan.network}   ${how}`);
    line(`  ${pad('', 3)}${pad('who', 28)} ${rpad('total', 11)}   pockets`);
    for (const p of plan.payments) {
      const parts = p.pockets.map((k) => `${money(k.amount)} ${k.label.toLowerCase()} (${when(k.rule, k.rule.at)})`).join(' + ');
      line(`  ${rpad(p.rank, 2)} ${pad(clip(p.name, 28), 28)} ${rpad(money(p.amount), 11)}   ${parts}`);
    }
    line(`  to pay now or later: ${money(plan.total)} ${plan.asset.code}`);
    line('');
    line('POCKETS');
    for (const k of plan.byPocket) {
      const def = program.pockets.find((x) => x.id === k.id);
      line(`  ${pad(k.label, 26)} ${rpad(money(k.amount), 11)}   ${when(def.rule, rep.now + (def.rule.afterSeconds || 0))}`);
    }
    if (plan.withheld.length) {
      line('');
      line('WITHHELD (the share of somebody with no wallet is kept aside, never given to anybody else)');
      for (const w of plan.withheld) line(`  ${pad(clip(w.name, 28), 28)} ${rpad(money(w.amount), 11)}   no wallet registered`);
    }
  }
  line('');
  line(`Written to ${outDir}`);
  line(`  ${files.map((f) => path.basename(f)).join(', ')}`);
  line('Nothing was built, signed or sent. The wallets are random keys made for this run; the amounts are a preview.');
}

// -- files --------------------------------------------------------------------

function markdown(rep) {
  const { cfg, read, harmony, plan } = rep;
  const program = harmony.program;
  const L = [];
  L.push(`# ${mdCell(cfg.title || cfg.template)} - ${mdCell(cfg.period.label || '')}`, '');
  L.push('Preview only: nothing was built, signed or sent. The numbers are only as good as the CSV.', '');
  if (cfg.description) L.push(cfg.description, '');
  L.push(`Template \`${program.id}\` (${mdCell(program.industry)}). Period ${cfg.period.since} up to, not including, ${cfg.period.until}.`, '');

  L.push('## What was read', '');
  L.push(`${read.rows} data rows gave ${read.events.length} events for ${read.people.length} participants. ${read.skipped.length} rows were skipped and ${read.unmatched} usable rows matched no rule.`, '');
  L.push('| Metric | Events | Units |', '| --- | ---: | ---: |');
  for (const m of program.metrics) {
    const x = rep.byMetric.get(m.id) || { events: 0, units: 0 };
    L.push(`| ${mdCell(m.label)} (\`${m.id}\`) | ${x.events} | ${Number(x.units.toFixed(3))} |`);
  }
  L.push('', '## Skipped rows', '');
  if (!read.skipped.length) L.push('None.');
  else {
    L.push('| Line | Reason |', '| ---: | --- |');
    for (const s of read.skipped) L.push(`| ${s.line} | ${mdCell(s.reason)} |`);
  }

  L.push('', '## Standings', '', '| Rank | Participant | Level | Points | Units counted |', '| ---: | --- | --- | ---: | --- |');
  for (const s of rep.standings) {
    const units = program.metrics.filter((m) => s.byMetric[m.id].reported > 0)
      .map((m) => `${m.id} ${Number(s.byMetric[m.id].reported.toFixed(3))}${s.byMetric[m.id].units < s.byMetric[m.id].reported ? ' (capped)' : ''}`).join(', ');
    L.push(`| ${s.rank} | ${mdCell(nameOf(rep, s.participantId))} | ${mdCell(s.level.name)} | ${s.adjustedPoints}${s.qualified ? '' : ' (does not qualify)'} | ${mdCell(units)} |`);
  }

  L.push('', '## Payout preview', '');
  if (!plan) L.push(`None: ${mdCell(rep.planError)}`);
  else {
    const r = plan.rule;
    L.push(r.model === 'rate'
      ? `Rate ${r.rate} per point with a budget of ${money(r.budget)}: the points are worth ${money(r.due)}${r.scaledToBudget ? ', cut down to the budget' : ', inside the budget'}.`
      : `Pool of ${money(r.pool)} shared by points.`, '');
    L.push(`| Rank | Who | Total (${plan.asset.code}) | Pockets |`, '| ---: | --- | ---: | --- |');
    for (const p of plan.payments) {
      L.push(`| ${p.rank} | ${mdCell(p.name)} | ${money(p.amount)} | ${mdCell(p.pockets.map((k) => `${money(k.amount)} ${k.label.toLowerCase()} (${when(k.rule, k.rule.at)})`).join(' + '))} |`);
    }
    L.push('', `Total planned: ${money(plan.total)} ${plan.asset.code}.`, '', '| Pocket | Amount | Rule |', '| --- | ---: | --- |');
    for (const k of plan.byPocket) {
      const def = program.pockets.find((x) => x.id === k.id);
      L.push(`| ${mdCell(k.label)} | ${money(k.amount)} | ${when(def.rule, rep.now + (def.rule.afterSeconds || 0))} |`);
    }
    if (plan.withheld.length) {
      L.push('', '### Withheld (no wallet registered)', '');
      for (const w of plan.withheld) L.push(`- ${mdCell(w.name)}: ${money(w.amount)} ${plan.asset.code}`);
    }
  }
  L.push('', '## Before you trust this', '',
    '- Read the skipped rows and the event list in `report.json` (each event carries the reference column you mapped).',
    '- Agree on the metric weights with the people being measured.',
    '- Rows are not deduplicated: an order listed twice counts twice.', '');
  return `${L.join('\n')}\n`;
}

function writeFiles(rep, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const files = [];
  const put = (name, text) => { const f = path.join(outDir, name); fs.writeFileSync(f, text); files.push(f); };

  const report = {
    kind: 'harmony-use-case-report',
    preview: true,
    organization: rep.cfg.organization,
    period: { label: rep.cfg.period.label || null, since: rep.cfg.period.since, until: rep.cfg.period.until, untilExclusive: true },
    program: { id: rep.harmony.program.id, name: rep.harmony.program.name },
    mapping: rep.mapping,
    read: { rows: rep.read.rows, events: rep.read.events.length, people: rep.read.people.length, skipped: rep.read.skipped, unmatched: rep.read.unmatched },
    byMetric: Object.fromEntries(rep.byMetric),
    standings: rep.standings.map((s) => ({ ...s, name: nameOf(rep, s.participantId) })),
    plan: rep.plan,
    planError: rep.planError,
    events: rep.read.events,
  };
  put('report.json', `${JSON.stringify(report, null, 2)}\n`);
  put('report.md', markdown(rep));

  if (rep.plan) {
    for (const p of rep.plan.payments) {
      const standing = rep.standings.find((s) => s.participantId === p.participantId);
      const person = rep.roster.find((r) => r.participantId === p.participantId);
      const card = rep.harmony.card({
        participant: person, standing, of: rep.standings.length, payment: p, period: rep.cfg.period.label, now: rep.now,
      });
      put(`card-${String(p.rank).padStart(2, '0')}-${slug(p.name)}.svg`, rep.harmony.renderCardSvg(card));
    }
  }
  return files;
}

// -- main ---------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); return 0; }
  if (!args.name) throw new UsageError('give the case to run');
  const { cfg, dir } = loadCase(args.name);

  let text;
  try { text = fs.readFileSync(path.join(dir, 'data.csv'), 'utf8'); } catch (e) { throw new UsageError(`cannot read ${args.name}/data.csv: ${e.code || e.message}`); }

  const base = args.now === null ? cfg.period.until : args.now;
  const nowMs = /^\d{4}-\d{2}-\d{2}$/.test(base) ? Date.parse(`${base}T00:00:00Z`) : Number.NaN;
  if (Number.isNaN(nowMs)) throw new UsageError('--now must be a date such as 2026-12-01');
  const rep = run(cfg, text, Math.floor(nowMs / 1000));

  const outDir = path.resolve(args.out || path.join(__dirname, '..', 'out', 'use-cases', args.name));
  const files = writeFiles(rep, outDir);
  printScreen(rep, outDir, files);
  return 0;
}

try {
  process.exitCode = main();
} catch (e) {
  if (e instanceof UsageError) {
    console.error(`${e.message}\n${USAGE}`);
    process.exitCode = 2;
  } else if (e instanceof ConnectorError || e instanceof TypeError || (e && e.statusCode === 400) || (e && e.name === 'ProgramConfigError')) {
    console.error(`Cannot run this case: ${e.message}`);
    process.exitCode = 1;
  } else {
    console.error(e);
    process.exitCode = 1;
  }
}
