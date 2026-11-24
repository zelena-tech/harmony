'use strict';

/**
 * Harmony kit, end to end, with no network.
 *
 *   node examples/quickstart-offline.js [templateId]
 *   node examples/quickstart-offline.js --samples     also writes the three sample cards of docs/assets/
 *
 * Takes a template (default last-mile-delivery), invents a team and a week of
 * work from the template's own metrics, scores it, plans the payout and
 * renders one preview Harmony Card per paid person into examples/out/.
 * Nothing is built, signed or sent: see examples/quickstart-testnet/ for the
 * same flow with real transactions. All names are made up.
 */

const fs = require('node:fs');
const path = require('node:path');
const { sdk } = require('../packages/core');
const kit = require('../packages/kit/src');
const { FIRST_NAMES, SKILL, syntheticActivity } = require('./quickstart-testnet/synthetic');

const args = process.argv.slice(2);
const SAMPLES = args.includes('--samples');
const templateId = args.find((a) => !a.startsWith('--')) || 'last-mile-delivery';
const OUT_DIR = path.join(__dirname, 'out');
const ASSETS_DIR = path.join(__dirname, '..', 'docs', 'assets');

const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);
const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const rule = (r) => (r.type === 'instant' ? 'instant' : `${r.type} ${day(r.at)}`);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Invents a team for `harmony`: a week of work, lifetime points, and wallets for all but one person. */
function team(harmony, names, seed) {
  const people = names.map((name) => ({ id: slug(name), name, skill: SKILL[name] }));
  const { events, lifetime } = syntheticActivity(harmony.program, people, seed);
  // Random keypairs, used for their public key only: nothing here is ever signed.
  const wallets = Object.fromEntries(people.map((p, i) => [p.id, i === people.length - 1 ? null : sdk.Keypair.random().publicKey()]));
  const roster = people.map((p) => ({ participantId: p.id, name: p.name, wallet: wallets[p.id] }));
  const { standings } = harmony.score({ events, lifetime });
  return { people, roster, events, lifetime, standings };
}

function showProgram(program) {
  console.log(`PROGRAM  ${program.name}  (${program.id})`);
  console.log(`  industry : ${program.industry}`);
  console.log(`  payout   : ${JSON.stringify(Object.fromEntries(Object.entries(program.payout).filter(([, v]) => v !== null)))}`);
  console.log('  metrics  :');
  for (const m of program.metrics) console.log(`    ${pad(m.id, 20)} ${rpad(m.points > 0 ? `+${m.points}` : m.points, 5)} pts${m.cap === null ? '' : `  (max ${m.cap} per person)`}`);
  console.log('  levels   :');
  for (const l of program.levels) console.log(`    ${pad(l.name, 14)} from ${rpad(l.minLifetimePoints, 6)} lifetime pts   x${l.multiplier}`);
  console.log('  pockets  :');
  for (const k of program.pockets) {
    const when = k.rule.type === 'instant' ? '' : ` after ${(k.rule.afterSeconds / 86400).toFixed(k.rule.afterSeconds % 86400 ? 2 : 0)} days`;
    console.log(`    ${pad(k.label, 18)} ${rpad(k.shareBp / 100, 5)} %   ${k.rule.type}${when}`);
  }
  console.log(`  people who cannot receive yet: ${program.unreachable.mode}, the payer may take it back after ${program.unreachable.reclaimAfterSeconds / 86400} days`);
}

function showStandings(standings, names) {
  console.log(`  ${pad('#', 3)}${pad('person', 12)}${rpad('earned', 8)}${rpad('adjusted', 10)}  ${pad('level', 16)}${rpad('lifetime', 9)}  qualified`);
  for (const s of standings) {
    console.log(`  ${pad(s.rank, 3)}${pad(names[s.participantId], 12)}${rpad(s.earnedPoints, 8)}${rpad(s.adjustedPoints, 10)}  ${pad(`${s.level.name} x${s.level.multiplier}`, 16)}${rpad(s.lifetimeBefore, 9)}  ${s.qualified ? 'yes' : 'no'}`);
  }
}

function showPlan(plan, asset) {
  console.log(`  rule: ${JSON.stringify(plan.rule)}   plan id ${plan.planId.slice(0, 16)}...`);
  for (const p of plan.payments) {
    console.log(`  #${p.rank} ${pad(p.name, 11)} ${pad(p.level ? p.level.name : '-', 12)} ${rpad(p.amount, 13)} ${asset}`);
    for (const k of p.pockets) console.log(`        ${pad(k.label, 18)} ${rpad(k.amount, 13)}   ${rule(k.rule)}`);
  }
  console.log(`  total ${plan.total} ${asset}`);
  for (const k of plan.byPocket) console.log(`    ${pad(k.label, 18)} ${rpad(k.amount, 13)}`);
}

function writeCards(harmony, t, plan, dir, prefix = '') {
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  for (const pay of plan.payments) {
    const person = t.roster.find((r) => r.participantId === pay.participantId);
    const standing = t.standings.find((s) => s.participantId === pay.participantId);
    const c = harmony.card({ participant: person, standing, of: t.standings.length, payment: pay, period: 'Week 12', now: plan.createdAt });
    const file = path.join(dir, `${prefix}${pay.participantId}.svg`);
    fs.writeFileSync(file, harmony.renderCardSvg(c));
    written.push(file);
  }
  return written;
}

function main() {
  const harmony = kit.createProgram({ tenant: { id: 'demo-org', network: 'testnet' }, program: templateId });
  const asset = harmony.tenant.rewardAsset.code;
  const names = FIRST_NAMES;
  const t = team(harmony, names, 7);
  const nameOf = Object.fromEntries(t.roster.map((r) => [r.participantId, r.name]));

  console.log(`Tenant demo-org on ${harmony.tenant.network}, reward asset ${asset}. No network is used.\n`);
  showProgram(harmony.program);
  console.log(`\nSTANDINGS  (${t.events.length} events, ${t.people.length} people; the last person has no wallet)`);
  showStandings(t.standings, nameOf);

  const plan = harmony.plan({ standings: t.standings, people: t.roster });
  console.log('\nPLAN');
  showPlan(plan, asset);
  console.log('\nWITHHELD (a share that belongs to someone without a wallet is kept aside, never given to anybody else)');
  if (!plan.withheld.length) console.log('  nothing');
  for (const w of plan.withheld) console.log(`  ${pad(w.name || w.workerId, 11)} ${rpad(w.amount, 13)} ${asset}   ${w.reason || 'no wallet registered'}`);

  const files = writeCards(harmony, t, plan, OUT_DIR);
  console.log(`\nCARDS  ${files.length} preview cards written to ${path.relative(process.cwd(), OUT_DIR) || '.'}${path.sep}`);

  if (SAMPLES) writeSamples();
}

/** Three sample cards for the docs: two templates, three levels, invented names, preview (nothing paid). */
function writeSamples() {
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  const specs = [
    { file: 'card-sample-1.svg', template: 'last-mile-delivery', name: 'Valentina', skill: 1.5, lifetime: 'second', period: 'Week 12' },
    { file: 'card-sample-2.svg', template: 'last-mile-delivery', name: 'Mateo', skill: 1.2, lifetime: 'top', period: 'Week 12' },
    { file: 'card-sample-3.svg', template: 'software-delivery', name: 'Sofia', skill: 1.1, lifetime: 'third', period: 'Sprint 24' },
  ];
  const others = ['Ana', 'Luis', 'Diego'];
  for (const s of specs) {
    const harmony = kit.createProgram({ tenant: { id: 'demo-org', network: 'testnet' }, program: s.template });
    const levels = harmony.program.levels;
    const rung = { second: levels[1], third: levels[Math.min(2, levels.length - 1)], top: levels[levels.length - 1] }[s.lifetime];
    const all = [{ id: slug(s.name), name: s.name, skill: s.skill }, ...others.map((n) => ({ id: slug(n), name: n, skill: SKILL[n] * 0.8 }))];
    const { events } = syntheticActivity(harmony.program, all, 11);
    const lifetime = Object.fromEntries(all.map((p) => [p.id, 0]));
    lifetime[slug(s.name)] = rung.minLifetimePoints + 120;
    const { standings } = harmony.score({ events, lifetime });
    const roster = all.map((p) => ({ participantId: p.id, name: p.name, wallet: sdk.Keypair.random().publicKey() }));
    const plan = harmony.plan({ standings, people: roster });
    const pay = plan.payments.find((p) => p.participantId === slug(s.name));
    const c = harmony.card({
      participant: roster[0], standing: standings.find((x) => x.participantId === slug(s.name)), of: standings.length,
      payment: pay, period: s.period, now: plan.createdAt,
    });
    fs.writeFileSync(path.join(ASSETS_DIR, s.file), harmony.renderCardSvg(c));
    console.log(`SAMPLE ${path.join('docs', 'assets', s.file)}  (${s.name}, ${harmony.program.id}, level ${c.level.name})`);
  }
}

main();
