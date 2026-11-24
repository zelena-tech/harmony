'use strict';

/**
 * Reads the PUBLIC activity of a public GitHub repository and prints the Harmony
 * events it produces, plus a count per contributor.
 *
 *   node examples/software-team/github-to-plan.js [owner/repo] [days]
 *
 * Defaults: stellar/js-stellar-sdk, 30 days. Unauthenticated GitHub allows 60
 * requests per hour, so this example reads at most 2 pages of pull requests and
 * 2 of commits and skips reviews (one request per PR). Set GITHUB_TOKEN to raise
 * the limit and to turn reviews on; the token is only read here and never printed.
 */

const { githubEvents } = require('../../packages/connectors/src');

async function main() {
  const [slug = 'stellar/js-stellar-sdk', daysArg = '30'] = process.argv.slice(2);
  const [owner, repo] = slug.split('/');
  const days = Number(daysArg);
  if (!owner || !repo || !Number.isFinite(days) || days <= 0) {
    console.error('Usage: node github-to-plan.js [owner/repo] [days]');
    process.exit(2);
  }
  const token = process.env.GITHUB_TOKEN || undefined;
  const until = new Date();
  const since = new Date(until.getTime() - days * 24 * 3600 * 1000);

  const result = await githubEvents({
    owner,
    repo,
    since,
    until,
    token,
    maxPages: 2,
    include: { pulls: true, reviews: Boolean(token), commits: true, milestones: true },
  });

  console.log(`${owner}/${repo}: ${result.window.since} to ${result.window.until}${token ? ' (authenticated)' : ' (anonymous)'}`);
  if (result.truncated) console.log('Note: maxPages was reached, older activity in the window is not counted.');

  const table = new Map();
  for (const e of result.events) {
    const row = table.get(e.participantId) || {};
    row[e.metric] = (row[e.metric] || 0) + e.value;
    table.set(e.participantId, row);
  }
  const metrics = [...new Set(result.events.map((e) => e.metric))].sort();
  const rows = [...table.entries()]
    .map(([id, row]) => ({ id, row, total: metrics.reduce((s, m) => s + (row[m] || 0), 0) }))
    .sort((a, b) => b.total - a.total || a.id.localeCompare(b.id));

  const width = Math.max(11, ...rows.map((r) => r.id.length));
  console.log(`\n${'contributor'.padEnd(width)}  ${metrics.map((m) => m.padStart(9)).join(' ')}  ${'total'.padStart(5)}`);
  for (const r of rows) {
    console.log(`${r.id.padEnd(width)}  ${metrics.map((m) => String(r.row[m] || 0).padStart(9)).join(' ')}  ${String(r.total).padStart(5)}`);
  }

  console.log(`\nClosed milestones in the window: ${result.milestones.length}`);
  for (const m of result.milestones) console.log(`  ${m.title} (${m.closedIssues} issues) ${m.url}`);

  console.log(`\nEvents (${result.events.length}):`);
  for (const e of result.events) console.log(`  ${e.at}  ${e.participantId}  ${e.metric}  ${e.value}  ${e.ref}`);
}

main().catch((err) => {
  console.error(`${err.name}: ${err.message}`);
  process.exit(1);
});
