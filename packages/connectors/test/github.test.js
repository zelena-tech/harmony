'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { githubEvents, creditMilestone, ConnectorError } = require('../src');
const { fakeFetch, json, user } = require('./helpers');

const SINCE = '2026-03-01T00:00:00Z';
const UNTIL = '2026-04-01T00:00:00Z';
const TOKEN = 'FAKE-github-token-for-tests-0123';
const BASE = '/repos/acme-demo/widgets';

const pr = (number, author, mergedAt, updatedAt, extra = {}) => ({
  number, user: user(author), merged_at: mergedAt, updated_at: updatedAt || mergedAt || '2026-03-10T00:00:00Z',
  html_url: `https://github.com/acme-demo/widgets/pull/${number}`, ...extra,
});
const review = (login, state, at = '2026-03-11T10:00:00Z', extra = {}) => ({
  user: user(login), state, submitted_at: at, html_url: `https://github.com/acme-demo/widgets/pull/1#r-${login}-${state}`, ...extra,
});
const commit = (sha, login, date, parents = 1, extra = {}) => ({
  sha, html_url: `https://github.com/acme-demo/widgets/commit/${sha}`,
  author: login ? user(login) : null,
  commit: { committer: { date } },
  parents: Array.from({ length: parents }, (_, i) => ({ sha: `p${i}` })),
  ...extra,
});

/** Serves fixtures by path. Anything not given answers an empty list. */
function repoFetch({ pulls = [], reviews = {}, commits = [], milestones = [] } = {}) {
  return fakeFetch((u) => {
    if (u.pathname === `${BASE}/pulls`) return json(pulls);
    const m = u.pathname.match(/\/pulls\/(\d+)\/reviews$/);
    if (m) return json(reviews[m[1]] || []);
    if (u.pathname === `${BASE}/commits`) return json(commits);
    if (u.pathname === `${BASE}/milestones`) return json(milestones);
    return undefined;
  });
}
const run = (fetch, extra = {}) => githubEvents({ owner: 'acme-demo', repo: 'widgets', since: SINCE, until: UNTIL, fetch, ...extra });
const byMetric = (events, metric) => events.filter((e) => e.metric === metric);

test('merged PRs are credited to the author, inside [since, until) only', async () => {
  const fetch = repoFetch({
    pulls: [
      pr(5, 'zed', '2026-04-01T00:00:00Z'), // exactly until: excluded
      pr(4, 'ana', '2026-03-31T23:59:59Z'),
      pr(3, 'ben', null, '2026-03-20T00:00:00Z'), // closed, not merged
      pr(2, 'cai', '2026-03-01T00:00:00Z'), // exactly since: included
      pr(1, 'dan', '2026-02-28T23:59:59Z', '2026-03-02T00:00:00Z'), // merged before the window
    ],
  });
  const r = await run(fetch, { include: { reviews: false, commits: false, milestones: false } });
  assert.deepEqual(r.events.map((e) => [e.participantId, e.metric, e.value]), [['ana', 'pr_merged', 1], ['cai', 'pr_merged', 1]]);
  assert.equal(r.events[0].at, '2026-03-31T23:59:59.000Z');
  assert.equal(r.events[0].ref, 'https://github.com/acme-demo/widgets/pull/4');
  assert.deepEqual(r.window, { since: '2026-03-01T00:00:00.000Z', until: '2026-04-01T00:00:00.000Z' });
  assert.equal(r.truncated, false);
});

test('pagination follows the Link header and stops once a page is entirely older than since', async () => {
  const p2 = 'https://api.github.com/repositories/1/pulls?page=2';
  const p3 = 'https://api.github.com/repositories/1/pulls?page=3';
  const fetch = fakeFetch((u) => {
    if (u.pathname === `${BASE}/pulls`) return json([pr(10, 'ana', '2026-03-20T00:00:00Z')], { headers: { link: `<${p2}>; rel="next"` } });
    if (u.href === p2) {
      return json([pr(9, 'ben', null, '2026-02-01T00:00:00Z')], { headers: { link: `<${p3}>; rel="next", <${p3}>; rel="last"` } });
    }
    return undefined; // page 3 must never be requested
  });
  const r = await run(fetch, { include: { reviews: false, commits: false, milestones: false } });
  assert.deepEqual(r.events.map((e) => e.participantId), ['ana']);
  assert.equal(fetch.calls.length, 2);
  assert.equal(r.truncated, false);
});

test('maxPages is a hard cap and sets truncated', async () => {
  const fetch = fakeFetch((u) => json([pr(1, 'ana', '2026-03-05T00:00:00Z', '2026-03-05T00:00:00Z')], {
    headers: { link: `<https://api.github.com${u.pathname}?page=${Number(u.searchParams.get('page') || 1) + 1}>; rel="next"` },
  }));
  const r = await run(fetch, { maxPages: 3, include: { reviews: false, commits: false, milestones: false } });
  assert.equal(fetch.calls.length, 3);
  assert.equal(r.truncated, true);
});

test('a Link header pointing to another host is never followed (the token would leak)', async () => {
  const fetch = fakeFetch(() => json([pr(1, 'ana', '2026-03-05T00:00:00Z')], { headers: { link: '<https://evil.example.com/x>; rel="next"' } }));
  await assert.rejects(run(fetch, { token: TOKEN, include: { reviews: false, commits: false, milestones: false } }), ConnectorError);
  assert.equal(fetch.calls.length, 1);
});

test('one review per reviewer per PR, only APPROVED / CHANGES_REQUESTED, never to the author', async () => {
  const fetch = repoFetch({
    pulls: [pr(1, 'ana', '2026-03-10T00:00:00Z')],
    reviews: {
      1: [
        review('ben', 'COMMENTED'),
        review('ben', 'CHANGES_REQUESTED', '2026-03-11T10:00:00Z'),
        review('ben', 'APPROVED', '2026-03-12T10:00:00Z'),
        review('cai', 'APPROVED'),
        review('ana', 'APPROVED'), // the author reviewing their own PR
        review('dan', 'DISMISSED'),
        review('eve', 'PENDING'),
      ],
    },
  });
  const r = await run(fetch, { include: { commits: false, milestones: false } });
  const reviews = byMetric(r.events, 'review');
  assert.deepEqual(reviews.map((e) => e.participantId), ['ben', 'cai']);
  assert.equal(reviews[0].at, '2026-03-11T10:00:00.000Z'); // the first qualifying review
  assert.equal(byMetric(r.events, 'pr_merged').length, 1);
});

test('the same reviewer on two PRs earns one review per PR', async () => {
  const fetch = repoFetch({
    pulls: [pr(1, 'ana', '2026-03-10T00:00:00Z'), pr(2, 'cai', '2026-03-12T00:00:00Z')],
    reviews: { 1: [review('ben', 'APPROVED')], 2: [review('ben', 'APPROVED')] },
  });
  const r = await run(fetch, { include: { commits: false, milestones: false } });
  assert.equal(byMetric(r.events, 'review').filter((e) => e.participantId === 'ben').length, 2);
});

test('commits: merge commits, unlinked commits and out-of-window commits are skipped', async () => {
  const fetch = repoFetch({
    commits: [
      commit('a1', 'ana', '2026-03-10T00:00:00Z'),
      commit('a2', 'ana', '2026-03-11T00:00:00Z', 2), // merge commit
      commit('a3', null, '2026-03-12T00:00:00Z'), // author not linked to a GitHub user
      commit('a4', 'ben', '2026-04-01T00:00:00Z'), // exactly until
      commit('a5', 'ben', '2026-02-28T00:00:00Z'), // before since
      commit('a6', 'ben', '2026-03-01T00:00:00Z'),
    ],
  });
  const r = await run(fetch, { include: { pulls: false, reviews: false, milestones: false } });
  assert.deepEqual(r.events.map((e) => [e.participantId, e.metric]), [['ana', 'commit'], ['ben', 'commit']]);
  const call = fetch.calls[0];
  assert.match(call.search, /since=2026-03-01T00%3A00%3A00\.000Z/);
  assert.match(call.search, /until=2026-04-01T00%3A00%3A00\.000Z/);
  assert.match(call.search, /per_page=100/);
});

test('bots are excluded by default (type Bot or [bot] suffix) and kept with excludeBots: false', async () => {
  const mk = () => repoFetch({
    pulls: [
      { ...pr(1, 'ana', '2026-03-10T00:00:00Z'), user: user('depbot[bot]', { type: 'Bot' }) },
      { ...pr(2, 'ana', '2026-03-10T00:00:00Z'), user: user('renamed-bot', { type: 'Bot' }) },
      pr(3, 'ana', '2026-03-10T00:00:00Z'),
    ],
    reviews: { 3: [review('ci[bot]', 'APPROVED'), review('ben', 'APPROVED')] },
    commits: [commit('c1', 'botty[bot]', '2026-03-10T00:00:00Z')],
  });
  const excluded = await run(mk(), { include: { milestones: false } });
  assert.deepEqual(excluded.events.map((e) => [e.participantId, e.metric]), [['ana', 'pr_merged'], ['ben', 'review']]);
  const kept = await run(mk(), { excludeBots: false, include: { milestones: false } });
  const ids = kept.events.map((e) => e.participantId);
  assert.ok(ids.includes('depbot[bot]') && ids.includes('renamed-bot') && ids.includes('ci[bot]') && ids.includes('botty[bot]'));
});

test('milestones are returned separately, nobody is credited, and creditMilestone fans them out', async () => {
  const fetch = repoFetch({
    milestones: [
      { title: 'v2.0', number: 7, closed_at: '2026-03-15T12:00:00Z', closed_issues: 12, html_url: 'https://github.com/acme-demo/widgets/milestone/7' },
      { title: 'v1.9', number: 6, closed_at: '2026-02-15T12:00:00Z', closed_issues: 3, html_url: 'https://github.com/acme-demo/widgets/milestone/6' },
      { title: 'open-ish', number: 5, closed_at: null, closed_issues: 0, html_url: 'x' },
    ],
  });
  const r = await run(fetch, { include: { pulls: false, reviews: false, commits: false } });
  assert.deepEqual(r.events, []);
  assert.deepEqual(r.milestones.map(({ title, number, closedAt, closedIssues, url }) => ({ title, number, closedAt, closedIssues, url })), [
    { title: 'v2.0', number: 7, closedAt: '2026-03-15T12:00:00.000Z', closedIssues: 12, url: 'https://github.com/acme-demo/widgets/milestone/7' },
  ]);
  assert.equal(fetch.calls[0].search.includes('state=closed'), true);

  const credited = creditMilestone(r.milestones, ['ana', 'ben', 'ana']);
  assert.deepEqual(credited.map((e) => [e.participantId, e.metric, e.value]), [['ana', 'milestone', 1], ['ben', 'milestone', 1]]);
  assert.equal(credited[0].ref, 'https://github.com/acme-demo/widgets/milestone/7');
  assert.equal(creditMilestone(r.milestones, ['ana'], { metric: 'release' })[0].metric, 'release');
  assert.deepEqual(creditMilestone([], ['ana']), []);
});

test('metrics renames the ids, including the milestone one', async () => {
  const fetch = repoFetch({
    pulls: [pr(1, 'ana', '2026-03-10T00:00:00Z')],
    reviews: { 1: [review('ben', 'APPROVED')] },
    commits: [commit('c1', 'cai', '2026-03-10T00:00:00Z')],
    milestones: [{ title: 'v2', number: 1, closed_at: '2026-03-10T00:00:00Z', closed_issues: 1, html_url: 'u' }],
  });
  const r = await run(fetch, { metrics: { pr_merged: 'prs', review: 'rev', commit: 'cm', milestone: 'ms' } });
  assert.deepEqual(r.events.map((e) => e.metric), ['prs', 'rev', 'cm']);
  assert.equal(creditMilestone(r.milestones, ['ana'])[0].metric, 'ms');
});

test('include switches control which endpoints are called', async () => {
  const fetch = repoFetch({ pulls: [pr(1, 'ana', '2026-03-10T00:00:00Z')] });
  await run(fetch, { include: { pulls: false, reviews: false, commits: true, milestones: false } });
  assert.deepEqual(fetch.calls.map((c) => c.path), [`${BASE}/commits`]);

  const f2 = repoFetch({ pulls: [pr(1, 'ana', '2026-03-10T00:00:00Z')], reviews: { 1: [review('ben', 'APPROVED')] } });
  const r2 = await run(f2, { include: { pulls: false, reviews: true, commits: false, milestones: false } });
  assert.deepEqual(r2.events.map((e) => [e.participantId, e.metric]), [['ben', 'review']]); // PR itself credits nobody

  const f3 = repoFetch();
  await run(f3);
  assert.deepEqual(f3.calls.map((c) => c.path), [`${BASE}/pulls`, `${BASE}/commits`, `${BASE}/milestones`]);
});

test('people lists each credited login once, with a profile url and no email', async () => {
  const fetch = repoFetch({
    pulls: [pr(1, 'ana', '2026-03-10T00:00:00Z'), pr(2, 'ana', '2026-03-11T00:00:00Z')],
    commits: [commit('c1', 'ben', '2026-03-10T00:00:00Z')],
  });
  const r = await run(fetch, { include: { reviews: false, milestones: false } });
  assert.deepEqual(r.people, [
    { participantId: 'ana', name: 'ana', url: 'https://github.com/ana' },
    { participantId: 'ben', name: 'ben', url: 'https://github.com/ben' },
  ]);
});

test('requests carry the documented headers; the token only goes in Authorization', async () => {
  const fetch = repoFetch({ pulls: [pr(1, 'ana', '2026-03-10T00:00:00Z')] });
  await run(fetch, { token: TOKEN });
  for (const c of fetch.calls) {
    assert.equal(c.init.headers.Accept, 'application/vnd.github+json');
    assert.equal(c.init.headers['X-GitHub-Api-Version'], '2022-11-28');
    assert.equal(c.init.headers['User-Agent'], 'harmony-connectors');
    assert.equal(c.init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(c.url.includes(TOKEN), false);
  }
  assert.ok(fetch.calls[0].url.startsWith('https://api.github.com/repos/acme-demo/widgets/pulls?state=closed&sort=updated&direction=desc&per_page=100'));
  const anon = repoFetch();
  await run(anon);
  assert.equal('Authorization' in anon.calls[0].init.headers, false);
});

test('404 and rate limits throw ConnectorError with status, endpoint and reset time, never the token', async () => {
  const notFound = fakeFetch(() => undefined);
  const e404 = await run(notFound, { token: TOKEN }).catch((e) => e);
  assert.ok(e404 instanceof ConnectorError);
  assert.equal(e404.status, 404);
  assert.equal(e404.source, 'github');
  assert.match(e404.message, /github GET \/repos\/acme-demo\/widgets\/pulls/);

  const reset = Math.floor(Date.parse('2026-03-05T10:00:00Z') / 1000);
  const limited = fakeFetch(() => json({ message: 'API rate limit exceeded' }, {
    status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
  }));
  const e403 = await run(limited, { token: TOKEN }).catch((e) => e);
  assert.equal(e403.status, 403);
  assert.match(e403.message, /resets at 2026-03-05T10:00:00\.000Z/);

  const retry = fakeFetch(() => json({}, { status: 429, headers: { 'retry-after': '60' } }));
  assert.match((await run(retry).catch((e) => e)).message, /retry after 60 seconds/);

  const down = fakeFetch(() => { throw Object.assign(new Error(`connect failed ${TOKEN}`), { code: 'ECONNRESET' }); });
  const eNet = await run(down, { token: TOKEN }).catch((e) => e);
  assert.equal(eNet.status, 0);

  for (const e of [e404, e403, eNet]) {
    const dump = `${e.message}\n${e.stack}\n${JSON.stringify(e)}\n${Object.getOwnPropertyNames(e).map((k) => String(e[k])).join('\n')}`;
    assert.equal(dump.includes(TOKEN), false);
  }
});

test('input validation', async () => {
  const fetch = repoFetch();
  await assert.rejects(githubEvents({ repo: 'x', since: SINCE, fetch }), TypeError);
  await assert.rejects(githubEvents({ owner: 'o', repo: 'x', fetch }), /since/);
  await assert.rejects(githubEvents({ owner: 'o', repo: 'x', since: 'nope', fetch }), TypeError);
  await assert.rejects(githubEvents({ owner: 'o', repo: 'x', since: UNTIL, until: SINCE, fetch }), RangeError);
  assert.equal(fetch.calls.length, 0);
  // Date objects are accepted
  const r = await githubEvents({ owner: 'acme-demo', repo: 'widgets', since: new Date(SINCE), until: new Date(UNTIL), fetch, include: { pulls: false, reviews: false, commits: false, milestones: false } });
  assert.deepEqual(r.events, []);
});
