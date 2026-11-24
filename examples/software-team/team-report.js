'use strict';

/**
 * Harmony team report: reads the work of a software team (GitHub pull requests,
 * reviews and milestones, Azure Boards items) and shows what Harmony would do
 * with it: points, a ranking, a payout preview and one card per person.
 *
 *   node examples/software-team/team-report.js --config team.json [--out dir] [--fixtures]
 *   node examples/software-team/team-report.js --fixtures          (invented data, no tokens, no network)
 *
 * It only READS. It never builds, signs or sends a transaction: it stops at the
 * plan (adoption level 0/1 preview). See README.md and team.example.json.
 *
 * Tokens come only from the environment and are never printed or written:
 *   GITHUB_TOKEN        optional for public repositories
 *   AZURE_DEVOPS_TOKEN  required when "azureBoards" is used
 *   AZURE_DEVOPS_AUTH   "pat" (default) or "bearer"
 */

const fs = require('node:fs');
const path = require('node:path');
const { sdk } = require('../../packages/core');
const { githubEvents, creditMilestone, azureBoardsEvents, mergeEvents } = require('../../packages/connectors/src');
const kit = require('../../packages/kit/src');

const TOP_KEYS = ['organization', 'period', 'github', 'azureBoards', 'identities', 'people', 'milestones', 'program', 'lifetime'];
const INCLUDE_KEYS = ['pulls', 'reviews', 'commits', 'milestones'];
// Squash merges make a pull request show up twice (as a PR and as a commit), so commits are off by default.
const DEFAULT_INCLUDE = { pulls: true, reviews: true, commits: false, milestones: true };
// Where cards and reports go by default. examples/software-team/out/ is not git-ignored, examples/out/ is.
const DEFAULT_OUT = path.join(__dirname, '..', 'out', 'software-team');

const USAGE = 'Usage: node examples/software-team/team-report.js --config team.json [--out dir] [--fixtures]\n'
  + '       node examples/software-team/team-report.js --fixtures        (invented data, fully offline)';

// ── small helpers ────────────────────────────────────────────────────────────

const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);
const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'person';
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim().length > 0;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const mdCell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

class UsageError extends Error {}

function parseArgs(argv) {
  const out = { config: null, out: null, fixtures: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = (name) => {
      if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
      i += 1;
      if (i >= argv.length || argv[i].startsWith('--')) throw new UsageError(`${name} needs a value`);
      return argv[i];
    };
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--fixtures') out.fixtures = true;
    else if (a === '--config' || a.startsWith('--config=')) out.config = value('--config');
    else if (a === '--out' || a.startsWith('--out=')) out.out = value('--out');
    else throw new UsageError(`unknown argument "${a}"`);
  }
  return out;
}

// ── configuration ────────────────────────────────────────────────────────────

/** Date or ISO date-time; returns a Date or null. A date alone is midnight UTC. */
function parseWhen(v) {
  if (typeof v !== 'string') return null;
  const m = v.match(/^(\d{4}-\d{2}-\d{2})(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/);
  if (!m) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  if (!m[2] && d.toISOString().slice(0, 10) !== v) return null; // 2026-02-31 and friends
  return d;
}

function walletOk(w) {
  try { return sdk.StrKey.isValidEd25519PublicKey(w); } catch { return false; }
}

/** Returns the list of problems; empty when the configuration is usable. */
function validateConfig(cfg) {
  const problems = [];
  if (!isObject(cfg)) return ['the configuration must be a JSON object'];
  for (const k of Object.keys(cfg)) if (!TOP_KEYS.includes(k)) problems.push(`unknown key "${k}" (known keys: ${TOP_KEYS.join(', ')})`);

  if (!(typeof cfg.organization === 'string' && /^[a-z0-9][a-z0-9-]{1,62}$/.test(cfg.organization))) {
    problems.push('organization must be a lowercase slug (a-z, 0-9, -), 2 to 63 characters');
  }

  if (!isObject(cfg.period)) problems.push('period is required: { "label": "Sprint 12", "since": "2026-11-09", "until": "2026-11-23" }');
  else {
    if (cfg.period.label !== undefined && !isText(cfg.period.label)) problems.push('period.label must be a non-empty string');
    const since = parseWhen(cfg.period.since);
    const until = parseWhen(cfg.period.until);
    if (!since) problems.push('period.since must be a date like 2026-11-09 (or an ISO date-time)');
    if (!until) problems.push('period.until must be a date like 2026-11-23 (or an ISO date-time); it is exclusive');
    if (since && until && until <= since) problems.push('period.until must be after period.since');
  }

  const sources = (key, check) => {
    const v = cfg[key];
    if (v === undefined) return 0;
    if (!Array.isArray(v)) { problems.push(`${key} must be an array`); return 0; }
    v.forEach((entry, i) => {
      if (!isObject(entry)) { problems.push(`${key}[${i}] must be an object`); return; }
      check(entry, `${key}[${i}]`);
    });
    return v.length;
  };
  const nameOk = (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(v);
  const total = sources('github', (e, where) => {
    if (!nameOk(e.owner) || /\s/.test(e.owner)) problems.push(`${where}.owner is required (the user or organization that owns the repository)`);
    if (!nameOk(e.repo) || /\s/.test(e.repo)) problems.push(`${where}.repo is required (the repository name)`);
    if (e.include !== undefined) {
      if (!isObject(e.include)) problems.push(`${where}.include must be an object`);
      else {
        for (const [k, v] of Object.entries(e.include)) {
          if (!INCLUDE_KEYS.includes(k)) problems.push(`${where}.include.${k} is not known (use ${INCLUDE_KEYS.join(', ')})`);
          else if (typeof v !== 'boolean') problems.push(`${where}.include.${k} must be true or false`);
        }
      }
    }
    if (e.maxPages !== undefined && !(Number.isInteger(e.maxPages) && e.maxPages >= 1)) problems.push(`${where}.maxPages must be an integer >= 1`);
    if (e.excludeBots !== undefined && typeof e.excludeBots !== 'boolean') problems.push(`${where}.excludeBots must be true or false`);
  }) + sources('azureBoards', (e, where) => {
    if (!isText(e.organization)) problems.push(`${where}.organization is required (the Azure DevOps organization)`);
    if (!isText(e.project)) problems.push(`${where}.project is required`);
    if (e.participantKey !== undefined && !['uniqueName', 'id'].includes(e.participantKey)) problems.push(`${where}.participantKey must be "uniqueName" or "id"`);
    for (const k of ['doneStates', 'bugTypes', 'effortFields', 'types']) {
      if (e[k] !== undefined && !(Array.isArray(e[k]) && e[k].length && e[k].every(isText))) problems.push(`${where}.${k} must be a non-empty array of strings`);
    }
  });
  if (total === 0) problems.push('give at least one source: "github" and/or "azureBoards" must have an entry');

  if (cfg.identities !== undefined) {
    if (!isObject(cfg.identities)) problems.push('identities must be an object: { "github-login": "canonical-id" }');
    else for (const [k, v] of Object.entries(cfg.identities)) if (!isText(v)) problems.push(`identities["${k}"] must be a non-empty canonical id`);
  }
  if (cfg.people !== undefined) {
    if (!isObject(cfg.people)) problems.push('people must be an object: { "canonical-id": { "name": "...", "wallet": null } }');
    else {
      for (const [id, p] of Object.entries(cfg.people)) {
        if (!isObject(p)) { problems.push(`people["${id}"] must be an object`); continue; }
        if (p.name !== undefined && !isText(p.name)) problems.push(`people["${id}"].name must be a non-empty string`);
        if (p.wallet !== undefined && p.wallet !== null && !(typeof p.wallet === 'string' && walletOk(p.wallet))) {
          problems.push(`people["${id}"].wallet must be null or a valid Stellar public key (G...)`);
        }
      }
    }
  }
  if (cfg.milestones !== undefined) {
    if (!isObject(cfg.milestones)) problems.push('milestones must be an object: { "creditEveryone": true }');
    else if (cfg.milestones.creditEveryone !== undefined && typeof cfg.milestones.creditEveryone !== 'boolean') problems.push('milestones.creditEveryone must be true or false');
  }
  if (cfg.lifetime !== undefined) {
    if (!isObject(cfg.lifetime)) problems.push('lifetime must be an object: { "canonical-id": points }');
    else for (const [id, v] of Object.entries(cfg.lifetime)) if (!(typeof v === 'number' && Number.isFinite(v) && v >= 0)) problems.push(`lifetime["${id}"] must be a number >= 0`);
  }
  if (cfg.program !== undefined && !isObject(cfg.program)) problems.push('program must be an object of overrides for the software-delivery template');
  return problems;
}

function buildHarmony(cfg, problems) {
  try {
    return kit.createProgram({ tenant: { id: /^[a-z0-9][a-z0-9-]{1,62}$/.test(cfg.organization) ? cfg.organization : 'placeholder', network: 'testnet' }, program: 'software-delivery', overrides: cfg.program || undefined });
  } catch (e) {
    if (e && Array.isArray(e.problems)) problems.push(...e.problems.map((p) => `program: ${p}`));
    else problems.push(`program: ${e.message}`);
    return null;
  }
}

/** Tokens live only in the environment and only in these variables. Never printed. */
function readTokens() {
  const auth = (process.env.AZURE_DEVOPS_AUTH || 'pat').toLowerCase();
  return {
    github: process.env.GITHUB_TOKEN || undefined,
    azure: process.env.AZURE_DEVOPS_TOKEN || undefined,
    azureAuth: auth,
  };
}

// ── reading the sources ──────────────────────────────────────────────────────

const countBy = (events) => events.reduce((m, e) => { m[e.metric] = (m[e.metric] || 0) + 1; return m; }, {});

async function readSources(cfg, { since, until, fetchImpl, tokens }) {
  const reads = [];
  for (const entry of cfg.github || []) {
    const label = `GitHub ${entry.owner}/${entry.repo}`;
    const include = { ...DEFAULT_INCLUDE, ...(entry.include || {}) };
    try {
      const r = await githubEvents({
        owner: entry.owner, repo: entry.repo, since, until, token: tokens.github, fetch: fetchImpl,
        include, excludeBots: entry.excludeBots, maxPages: entry.maxPages,
      });
      reads.push({
        kind: 'github', label, result: r, include, authenticated: Boolean(tokens.github),
        counts: countBy(r.events), milestones: r.milestones.length, truncated: r.truncated,
      });
    } catch (e) {
      throw new Error(`${label}: ${e.message}`);
    }
  }
  for (const entry of cfg.azureBoards || []) {
    const label = `Azure Boards ${entry.organization}/${entry.project}`;
    try {
      const r = await azureBoardsEvents({
        organization: entry.organization, project: entry.project, since, until, token: tokens.azure, auth: tokens.azureAuth,
        fetch: fetchImpl, participantKey: entry.participantKey, doneStates: entry.doneStates, bugTypes: entry.bugTypes,
        effortFields: entry.effortFields, types: entry.types,
      });
      reads.push({
        kind: 'azure', label, result: r, counts: countBy(r.events), closedItems: r.items.length,
        unassigned: r.unassigned.count, truncated: false,
      });
    } catch (e) {
      throw new Error(`${label}: ${e.message}`);
    }
  }
  return reads;
}

// ── report ───────────────────────────────────────────────────────────────────

function buildReport(cfg, harmony, reads, { since, until, now, fixtures }) {
  const identities = cfg.identities || {};
  const merged = mergeEvents(...reads.map((r) => r.result), { identities });

  // An id that is already a canonical id (a login equal to the canonical name) is not "unmapped".
  const known = new Set([...Object.values(identities), ...Object.keys(cfg.people || {})].map((v) => String(v).toLowerCase()));
  const unmapped = merged.unmapped.filter((id) => !known.has(String(id).toLowerCase()));

  const nameOf = new Map(merged.people.map((p) => [String(p.participantId), p.name]));
  const display = (id) => ((cfg.people || {})[id] && cfg.people[id].name) || nameOf.get(String(id)) || String(id);

  // Milestones are team events: credit each one to everybody who did something else in the period.
  const base = merged.events;
  const milestones = reads.flatMap((r) => (r.kind === 'github' ? r.result.milestones : []));
  const creditEveryone = Boolean(cfg.milestones && cfg.milestones.creditEveryone);
  const credited = creditEveryone ? creditMilestone(milestones, [...new Set(base.map((e) => e.participantId))]) : [];

  // Events whose metric the program does not value (a team may have removed one) are set aside, not fatal.
  const valued = new Set(harmony.program.metrics.map((m) => m.id));
  const all = [...base, ...credited];
  const events = all.filter((e) => valued.has(e.metric));
  const ignored = countBy(all.filter((e) => !valued.has(e.metric)));

  const result = {
    harmony, events, ignored, unmapped, milestones, creditEveryone, display, now, since, until, fixtures,
    standings: [], totals: null, plan: null, planError: null, idle: [],
  };
  const seen = new Set(events.map((e) => String(e.participantId)));
  result.idle = Object.keys(cfg.people || {}).filter((id) => !seen.has(id));
  if (!events.length) return result;

  const scored = harmony.score({ events, lifetime: cfg.lifetime || {} });
  result.standings = scored.standings;
  result.totals = scored.totals;
  const roster = scored.standings.map((s) => ({
    participantId: s.participantId, name: display(s.participantId), wallet: ((cfg.people || {})[s.participantId] || {}).wallet || null,
  }));
  result.roster = roster;
  try {
    result.plan = harmony.plan({ standings: scored.standings, people: roster, now });
  } catch (e) {
    result.planError = e.message;
  }
  return result;
}

// ── screen ───────────────────────────────────────────────────────────────────

function unitsTable(rep) {
  const ids = rep.harmony.program.metrics.map((m) => m.id).filter((id) => rep.standings.some((s) => s.byMetric[id] && s.byMetric[id].units > 0));
  return ids;
}

function printScreen(cfg, rep, reads, outDir, files) {
  const asset = rep.harmony.tenant.rewardAsset.code;
  const p = rep.harmony.program;
  const label = (cfg.period.label ? `${cfg.period.label}  ` : '');
  console.log(`HARMONY TEAM REPORT  ${cfg.organization}${rep.fixtures ? '  (invented fixtures, no network)' : ''}`);
  console.log(`  ${label}${rep.since.toISOString().slice(0, 10)} to ${rep.until.toISOString().slice(0, 10)} (end date not included)`);
  console.log(`  program ${p.name} (${p.id}); preview only: nothing is built, signed or sent (adoption level 0/1)`);

  console.log('\nSOURCES READ');
  for (const r of reads) {
    const c = r.counts;
    if (r.kind === 'github') {
      const parts = [];
      if (r.include.pulls) parts.push(plural(c.pr_merged || 0, 'merged PR'));
      if (r.include.reviews) parts.push(plural(c.review || 0, 'review'));
      if (r.include.commits) parts.push(plural(c.commit || 0, 'commit'));
      parts.push(plural(r.milestones, 'closed milestone'));
      console.log(`  ${pad(r.label, 38)} ${parts.join(', ')}${r.authenticated || rep.fixtures ? '' : '  (anonymous)'}`);
    } else {
      console.log(`  ${pad(r.label, 38)} ${plural(r.closedItems, 'closed item')} (${c.item_done || 0} done, ${c.bug_fixed || 0} bugs, ${r.unassigned} unassigned)`);
    }
    if (r.truncated) console.log('    WARNING: truncated. maxPages cut a list short, so older activity in the window is NOT counted. Raise maxPages or shorten the period.');
  }
  const withCommits = reads.filter((r) => r.kind === 'github' && r.include.commits);
  if (withCommits.length) {
    console.log(`  Commits ARE counted for ${withCommits.map((r) => r.label).join(', ')}: a squash-merged pull request is counted twice (as a PR and as a commit).`);
  } else if (reads.some((r) => r.kind === 'github')) {
    console.log('  Commits are not counted (a squash-merged pull request would count twice); set include.commits to true per repository to count them.');
  }
  if (rep.creditEveryone) console.log(`  Milestones: ${plural(rep.milestones.length, 'milestone')} closed, each credited to everybody with other activity (milestones.creditEveryone).`);
  else if (rep.milestones.length) console.log(`  Milestones: ${plural(rep.milestones.length, 'milestone')} closed but credited to nobody (milestones.creditEveryone is not true).`);
  const ign = Object.entries(rep.ignored);
  if (ign.length) console.log(`  Set aside, the program has no such metric: ${ign.map(([m, n]) => `${m} x${n}`).join(', ')}`);

  if (!rep.standings.length) {
    console.log('\nNo work was found in this period, so there is no ranking, plan or card. Check the dates and the sources above.');
    console.log(`\nFILES  ${path.relative(process.cwd(), outDir) || '.'}${path.sep}  ${files.map((f) => path.basename(f)).join(', ')}`);
    return;
  }

  const cols = unitsTable(rep);
  const head = `  ${pad('#', 3)}${pad('person', 16)}${pad('level', 20)}${rpad('points', 7)}${rpad('adjusted', 10)}  ${cols.map((m) => rpad(m, 10)).join('')}`;
  console.log('\nSTANDINGS  (points = what was counted x the metric points; adjusted = points x the level multiplier, what the pool is shared by)');
  console.log(head);
  for (const s of rep.standings) {
    console.log(`  ${pad(s.rank, 3)}${pad(rep.display(s.participantId).slice(0, 15), 16)}${pad(`${s.level.name} x${s.level.multiplier}`, 20)}${rpad(s.earnedPoints, 7)}${rpad(s.adjustedPoints, 10)}  ${cols.map((m) => rpad(s.byMetric[m].units, 10)).join('')}`);
  }

  console.log('\nPAYOUT PREVIEW');
  const plan = rep.plan;
  if (!plan) {
    console.log(`  No plan: ${rep.planError}`);
  } else {
    console.log(`  rule ${JSON.stringify(plan.rule)}  payable ${plan.total} ${asset}${plan.withheld.length ? ' (the rest of the pool is withheld)' : ''}  plan id ${plan.planId.slice(0, 16)}...`);
    if (!plan.payments.length) console.log('  Nobody has a wallet in "people", so there is nothing to pay yet; the shares below are withheld.');
    for (const pay of plan.payments) {
      console.log(`  #${pad(pay.rank, 3)}${pad(pay.name.slice(0, 15), 16)}${rpad(pay.amount, 14)} ${asset}`);
      for (const k of pay.pockets) console.log(`        ${pad(k.label, 24)}${rpad(k.amount, 14)}   ${k.rule.type === 'instant' ? 'instant' : `${k.rule.type} ${day(k.rule.at)}`}`);
    }
    if (plan.byPocket.length && plan.payments.length) console.log(`  by pocket: ${plan.byPocket.map((k) => `${k.label} ${k.amount}`).join('; ')}`);
    if (plan.withheld.length) {
      console.log('  Withheld (the share of someone without a wallet is kept aside, never given to anybody else):');
      for (const w of plan.withheld) console.log(`    #${pad(w.rank, 3)}${pad(String(w.name).slice(0, 15), 16)}${rpad(w.amount, 14)} ${asset}`);
    }
    if (plan.withoutWallet.length) console.log(`  People without a wallet: ${plan.withoutWallet.join(', ')}. Add "wallet" to their entry in "people" to pay them.`);
  }

  console.log('\nAUDIT TRAIL');
  const linked = rep.events.filter((e) => e.ref).length;
  console.log(`  ${plural(rep.events.length, 'event')} behind these numbers, ${linked} with a link to the pull request, review, milestone or work item (see report.json).`);

  console.log('\nUNMAPPED IDENTITIES');
  if (!rep.unmapped.length) console.log('  none: every id was mapped in "identities" or already is a canonical id.');
  else {
    console.log('  Kept as they came, so a person may appear twice. Add them to "identities" (id -> canonical person id):');
    for (const id of rep.unmapped) console.log(`    ${id}`);
  }
  if (rep.idle.length) console.log(`\nIn "people" but with no activity in the period: ${rep.idle.join(', ')}`);

  console.log(`\nFILES  ${path.relative(process.cwd(), outDir) || '.'}${path.sep}`);
  console.log(`  ${files.map((f) => path.basename(f)).join(', ')}`);
  console.log('\nThis is a preview. To pay it for real, see docs/kit.md and examples/quickstart-testnet/README.md.');
}

// ── files ────────────────────────────────────────────────────────────────────

function markdown(cfg, rep, reads) {
  const asset = rep.harmony.tenant.rewardAsset.code;
  const L = [];
  L.push(`# ${cfg.organization}: ${cfg.period.label || 'delivery report'}`, '');
  L.push(`Period ${rep.since.toISOString().slice(0, 10)} to ${rep.until.toISOString().slice(0, 10)} (end date not included). Program: ${rep.harmony.program.name}.`);
  L.push('', '**Preview only.** Nothing was paid, built or signed. Points count what GitHub and Azure Boards recorded; they do not measure quality or effort on their own.', '');
  L.push('## Sources', '');
  for (const r of reads) {
    const c = r.counts;
    const detail = r.kind === 'github'
      ? `${c.pr_merged || 0} merged PRs, ${c.review || 0} reviews${r.include.commits ? `, ${c.commit || 0} commits` : ''}, ${plural(r.milestones, 'closed milestone')}`
      : `${r.closedItems} closed items (${c.item_done || 0} done, ${c.bug_fixed || 0} bugs, ${r.unassigned} unassigned)`;
    L.push(`- ${mdCell(r.label)}: ${detail}${r.truncated ? ' **(truncated: older activity not counted)**' : ''}`);
  }
  if (!rep.standings.length) return `${L.join('\n')}\n\nNo work was found in this period.\n`;

  const cols = unitsTable(rep);
  L.push('', '## Standings', '');
  L.push(`| # | Person | Level | Points | Adjusted | ${cols.join(' | ')} |`, `|---|---|---|---:|---:|${cols.map(() => '---:').join('|')}|`);
  for (const s of rep.standings) {
    L.push(`| ${s.rank} | ${mdCell(rep.display(s.participantId))} | ${s.level.name} x${s.level.multiplier} | ${s.earnedPoints} | ${s.adjustedPoints} | ${cols.map((m) => s.byMetric[m].units).join(' | ')} |`);
  }
  L.push('', '## Payout preview', '');
  if (!rep.plan) L.push(`No plan: ${rep.planError}`);
  else {
    const plan = rep.plan;
    L.push(`Pool rule: \`${JSON.stringify(plan.rule)}\`. Payable ${plan.total} ${asset}${plan.withheld.length ? ' (the rest of the pool is withheld)' : ''}.`, '');
    if (plan.payments.length) {
      L.push('| # | Person | Amount | Pockets |', '|---|---|---:|---|');
      for (const pay of plan.payments) {
        L.push(`| ${pay.rank} | ${mdCell(pay.name)} | ${pay.amount} ${asset} | ${pay.pockets.map((k) => `${mdCell(k.label)} ${k.amount}${k.rule.type === 'instant' ? '' : ` (${k.rule.type} ${day(k.rule.at)})`}`).join('; ')} |`);
      }
    } else L.push('Nobody has a wallet yet, so there is nothing to pay; the shares are withheld.');
    if (plan.withheld.length) {
      L.push('', 'Withheld (no wallet registered; never given to anybody else):', '');
      for (const w of plan.withheld) L.push(`- #${w.rank} ${mdCell(w.name)}: ${w.amount} ${asset}`);
    }
  }
  L.push('', '## Audit trail', '');
  L.push(`${rep.events.length} events produced these numbers. Each one carries a link to its pull request, review, milestone or work item in \`report.json\`.`);
  if (rep.unmapped.length) {
    L.push('', '## Unmapped identities', '', 'These ids were not in `identities`, so they are counted as separate people:', '');
    for (const id of rep.unmapped) L.push(`- ${mdCell(id)}`);
  }
  return `${L.join('\n')}\n`;
}

function writeFiles(cfg, rep, reads, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const files = [];
  const put = (name, text) => { const f = path.join(outDir, name); fs.writeFileSync(f, text); files.push(f); };

  const report = {
    kind: 'harmony-team-report',
    preview: true,
    organization: cfg.organization,
    period: { label: cfg.period.label || null, since: rep.since.toISOString(), until: rep.until.toISOString(), untilExclusive: true },
    program: { id: rep.harmony.program.id, name: rep.harmony.program.name },
    sources: reads.map((r) => ({
      source: r.label, counts: r.counts, truncated: r.truncated,
      ...(r.kind === 'github' ? { include: r.include, milestones: r.milestones } : { closedItems: r.closedItems, unassigned: r.unassigned }),
    })),
    ignoredMetrics: rep.ignored,
    standings: rep.standings.map((s) => ({ ...s, name: rep.display(s.participantId) })),
    plan: rep.plan,
    planError: rep.planError,
    unmapped: rep.unmapped,
    events: rep.events,
  };
  put('report.json', `${JSON.stringify(report, null, 2)}\n`);
  put('report.md', markdown(cfg, rep, reads));

  const used = new Map();
  for (const s of rep.standings) {
    const person = rep.roster.find((r) => r.participantId === s.participantId);
    const payment = rep.plan ? rep.plan.payments.find((x) => x.participantId === s.participantId) : undefined;
    const c = rep.harmony.card({
      participant: person, standing: s, of: rep.standings.length, payment, period: cfg.period.label, now: rep.now,
    });
    let base = slug(s.participantId);
    const n = (used.get(base) || 0) + 1;
    used.set(base, n);
    if (n > 1) base = `${base}-${n}`;
    put(`${base}.svg`, rep.harmony.renderCardSvg(c));
  }
  return files;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); return 0; }
  if (!args.config && !args.fixtures) throw new UsageError('give --config team.json (or --fixtures to run on invented data)');

  const fixtures = args.fixtures ? require('./fixtures') : null;
  let cfg;
  if (args.config) {
    let text;
    try { text = fs.readFileSync(path.resolve(args.config), 'utf8'); } catch (e) { throw new UsageError(`cannot read ${args.config}: ${e.code || e.message}`); }
    try { cfg = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { throw new UsageError(`${args.config} is not valid JSON: ${e.message}`); }
  } else cfg = JSON.parse(JSON.stringify(fixtures.config));

  const problems = validateConfig(cfg);
  const tokens = readTokens();
  if (!['pat', 'bearer'].includes(tokens.azureAuth)) problems.push('AZURE_DEVOPS_AUTH must be "pat" or "bearer"');
  if (Array.isArray(cfg.azureBoards) && cfg.azureBoards.length && !tokens.azure && !fixtures) {
    problems.push('azureBoards is configured but the AZURE_DEVOPS_TOKEN environment variable is not set (it needs Work Items: Read)');
  }
  const harmony = isObject(cfg) ? buildHarmony(cfg, problems) : null;
  if (problems.length) {
    console.error(`The configuration has ${plural(problems.length, 'problem')}:`);
    for (const p of problems) console.error(`  - ${p}`);
    return 2;
  }

  const since = parseWhen(cfg.period.since);
  const until = parseWhen(cfg.period.until);
  const outDir = path.resolve(args.out || DEFAULT_OUT);
  // Fixtures are deterministic: the plan is dated at the end of the period instead of "now".
  const now = fixtures ? Math.floor(until.getTime() / 1000) : Math.floor(Date.now() / 1000);

  // The fake fetch never checks credentials, but the connector insists on a non-empty token.
  if (fixtures) tokens.azure = 'fixtures';
  const reads = await readSources(cfg, {
    since, until, tokens,
    fetchImpl: fixtures ? fixtures.fakeFetch() : undefined,
  });
  const rep = buildReport(cfg, harmony, reads, { since, until, now, fixtures: Boolean(fixtures) });
  const files = writeFiles(cfg, rep, reads, outDir);
  printScreen(cfg, rep, reads, outDir, files);
  return 0;
}

main().then((code) => { process.exitCode = code; }, (e) => {
  if (e instanceof UsageError) {
    console.error(`${e.message}\n${USAGE}`);
    process.exitCode = 2;
  } else {
    // Only the message: connector errors never carry a token.
    console.error(`Failed: ${e.message}`);
    process.exitCode = 1;
  }
});
