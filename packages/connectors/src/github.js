'use strict';

const { ConnectorError } = require('./errors');
const { toDate, resolveFetch, inWindow } = require('./util');

const API = 'https://api.github.com';
const DEFAULT_METRICS = { pr_merged: 'pr_merged', review: 'review', commit: 'commit', milestone: 'milestone' };
const DEFAULT_INCLUDE = { pulls: true, reviews: true, commits: true, milestones: true };
const REVIEW_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED']);

const isBot = (user) => !!user && (user.type === 'Bot' || /\[bot\]$/i.test(user.login || ''));

/** Extracts the rel="next" URL of a Link header, or null. */
function nextLink(header) {
  if (!header) return null;
  for (const part of String(header).split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (m) return m[1];
  }
  return null;
}

function rateLimitHint(headers) {
  const remaining = headers.get('x-ratelimit-remaining');
  const reset = headers.get('x-ratelimit-reset');
  const retry = headers.get('retry-after');
  if (remaining === '0' && reset && Number.isFinite(Number(reset))) {
    return ` Rate limit exhausted; it resets at ${new Date(Number(reset) * 1000).toISOString()}.`;
  }
  if (retry && Number.isFinite(Number(retry))) return ` Rate limited; retry after ${Number(retry)} seconds.`;
  return '';
}

/** One GET. The token only travels in the Authorization header, never in a URL. */
async function getJson(ctx, urlOrPath) {
  const url = new URL(urlOrPath, API);
  if (url.origin !== API) {
    // A Link header must never make us send the token to another host.
    throw new ConnectorError(`github refused to follow a link outside ${API}`, { source: 'github', endpoint: url.pathname });
  }
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'harmony-connectors',
  };
  if (ctx.token) headers.Authorization = `Bearer ${ctx.token}`;
  let res;
  try {
    res = await ctx.fetch(url.toString(), { method: 'GET', headers });
  } catch (e) {
    throw new ConnectorError(`github GET ${url.pathname} failed: network error (${(e && (e.code || e.name)) || 'unknown'})`,
      { status: 0, source: 'github', endpoint: url.pathname });
  }
  if (!res.ok) {
    const hint = res.status === 403 || res.status === 429 ? rateLimitHint(res.headers) : '';
    throw new ConnectorError(`github GET ${url.pathname} failed with HTTP ${res.status}.${hint}`,
      { status: res.status, source: 'github', endpoint: url.pathname });
  }
  return { body: await res.json(), next: nextLink(res.headers.get('link')) };
}

/**
 * Walks a paginated endpoint. `onPage(items)` may return true to stop early.
 * @returns {Promise<{truncated: boolean}>} truncated: maxPages was hit with more pages available
 */
async function paginate(ctx, path, onPage) {
  let url = path;
  for (let page = 1; ; page += 1) {
    const { body, next } = await getJson(ctx, url);
    const stop = onPage(Array.isArray(body) ? body : []) === true;
    if (stop || !next) return { truncated: false };
    if (page >= ctx.maxPages) return { truncated: true };
    url = next;
  }
}

/**
 * Reads merged PRs, reviews, default-branch commits and closed milestones of one
 * repository and returns plain Harmony events.
 *
 * Window: events are those that happened in [since, until). `until` defaults to now.
 * Reviews are read per kept PR, so `include.reviews` fetches the PR list even when
 * `include.pulls` is false (the PRs then credit nothing).
 * Milestones are a TEAM event: they are returned separately and the host decides
 * who is credited (see creditMilestone).
 *
 * @param {object} o
 * @param {string} o.owner
 * @param {string} o.repo
 * @param {string|Date} o.since
 * @param {string|Date} [o.until]
 * @param {string} [o.token] read-only token; optional for public repositories
 * @param {Function} [o.fetch] defaults to globalThis.fetch
 * @param {Partial<typeof DEFAULT_METRICS>} [o.metrics] rename metric ids
 * @param {Partial<typeof DEFAULT_INCLUDE>} [o.include] turn sources on/off
 * @param {boolean} [o.excludeBots=true]
 * @param {number} [o.maxPages=10] page cap per endpoint
 * @returns {Promise<{events: Array, milestones: Array, people: Array, window: {since: string, until: string}, truncated: boolean}>}
 */
async function githubEvents(o = {}) {
  const { owner, repo, token, excludeBots = true, maxPages = 10 } = o;
  if (!owner || !repo) throw new TypeError('"owner" and "repo" are required');
  const since = toDate(o.since, 'since');
  const until = o.until == null ? new Date() : toDate(o.until, 'until');
  if (until <= since) throw new RangeError('"until" must be after "since"');
  const metrics = { ...DEFAULT_METRICS, ...(o.metrics || {}) };
  const include = { ...DEFAULT_INCLUDE, ...(o.include || {}) };
  const ctx = { fetch: resolveFetch(o.fetch), token, maxPages: Math.max(1, Number(maxPages) || 1) };
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const skip = (user) => !user || !user.login || (excludeBots && isBot(user));

  const events = [];
  const milestones = [];
  const people = new Map();
  let truncated = false;
  const credit = (user, metric, at, ref) => {
    people.set(user.login, { participantId: user.login, name: user.login, url: user.html_url || `https://github.com/${user.login}` });
    events.push({ participantId: user.login, metric, value: 1, at: new Date(at).toISOString(), ref });
  };

  if (include.pulls || include.reviews) {
    const prs = [];
    const r = await paginate(ctx, `${base}/pulls?state=closed&sort=updated&direction=desc&per_page=100`, (items) => {
      for (const pr of items) if (pr.merged_at && inWindow(pr.merged_at, since, until)) prs.push(pr);
      // Sorted by updated_at desc, and merged_at <= updated_at: nothing older can still be in the window.
      return items.length > 0 && items.every((pr) => new Date(pr.updated_at).getTime() < since.getTime());
    });
    truncated = truncated || r.truncated;

    for (const pr of prs) {
      if (include.pulls && !skip(pr.user)) credit(pr.user, metrics.pr_merged, pr.merged_at, pr.html_url);
      if (!include.reviews) continue;
      const seen = new Set();
      const rr = await paginate(ctx, `${base}/pulls/${pr.number}/reviews?per_page=100`, (items) => {
        for (const rv of items) {
          if (!REVIEW_STATES.has(rv.state) || skip(rv.user)) continue;
          if (pr.user && rv.user.login === pr.user.login) continue;
          if (seen.has(rv.user.login)) continue;
          seen.add(rv.user.login);
          credit(rv.user, metrics.review, rv.submitted_at || pr.merged_at, rv.html_url || pr.html_url);
        }
      });
      truncated = truncated || rr.truncated;
    }
  }

  if (include.commits) {
    const qs = `since=${encodeURIComponent(since.toISOString())}&until=${encodeURIComponent(until.toISOString())}&per_page=100`;
    const r = await paginate(ctx, `${base}/commits?${qs}`, (items) => {
      for (const c of items) {
        if ((c.parents || []).length > 1) continue; // merge commit
        if (skip(c.author)) continue; // not linked to a GitHub user
        const at = c.commit && c.commit.committer && c.commit.committer.date;
        if (!inWindow(at, since, until)) continue;
        credit(c.author, metrics.commit, at, c.html_url);
      }
    });
    truncated = truncated || r.truncated;
  }

  if (include.milestones) {
    const r = await paginate(ctx, `${base}/milestones?state=closed&sort=due_on&direction=desc&per_page=100`, (items) => {
      for (const m of items) {
        if (!m.closed_at || !inWindow(m.closed_at, since, until)) continue;
        milestones.push({
          title: m.title, number: m.number, closedAt: new Date(m.closed_at).toISOString(),
          closedIssues: m.closed_issues, url: m.html_url, metric: metrics.milestone,
        });
      }
    });
    truncated = truncated || r.truncated;
  }

  return {
    events,
    milestones,
    people: [...people.values()].sort((a, b) => a.participantId.localeCompare(b.participantId)),
    window: { since: since.toISOString(), until: until.toISOString() },
    truncated,
  };
}

/**
 * A milestone is a team event, so the connector credits nobody. The host decides
 * who earns it (for example the team roster) and calls this helper.
 *
 * @param {Array<{title?: string, closedAt: string, url?: string, metric?: string}>} milestones
 * @param {string[]} participantIds
 * @param {{metric?: string}} [options] default: the metric carried by each milestone, else "milestone"
 * @returns {Array<{participantId: string, metric: string, value: number, at: string, ref: string}>}
 */
function creditMilestone(milestones, participantIds, options = {}) {
  const ids = [...new Set(participantIds || [])];
  const out = [];
  for (const m of milestones || []) {
    for (const participantId of ids) {
      out.push({
        participantId, metric: options.metric || m.metric || 'milestone', value: 1, at: m.closedAt, ref: m.url,
      });
    }
  }
  return out;
}

module.exports = { githubEvents, creditMilestone, nextLink };
