'use strict';

/**
 * Invented data for `team-report.js --fixtures`: a fake `fetch` that answers
 * like GitHub (acme/platform) and Azure Boards (acme / Platform) for the sprint
 * of 2026-11-09 to 2026-11-23. Everybody, every login, every email and every
 * wallet below is made up (example.com addresses, wallets derived from a public
 * label). It is deterministic: the same call always returns the same data, so a
 * newcomer and CI see the same report.
 *
 * Totals you can check by hand against `team-report.js --fixtures`
 * (points: pull request 20, review 8, board item 5 per effort point, bug 10,
 * milestone 50):
 *
 *   person   PRs  reviews  item_done  bugs  milestone  points  level x       adjusted
 *   ben        3      5        13        2       1       235    contributor 1  235
 *   dmitri     2      1        15        1       1       183    senior 1.1     201
 *   ana        3      4         6        1       1       182    builder 1.05   191
 *   carla      2      4         9        0       1       167    contributor 1  167
 *   eve        1      1         5        2       1       123    contributor 1  123
 *   guest      0      1         0        0       1        58    (unmapped)      58
 *
 * Ignored on purpose: a PR merged before the sprint (#98) and one after it
 * (#114), a PR closed without merging (#113), a pull request by a bot (#111,
 * not credited; only the review on it is), a self review (#101), a COMMENTED
 * review (#103), a board item closed before (2022) and after (2021) the sprint,
 * and one closed item with nobody assigned (2020).
 */

const GITHUB_REPO = { owner: 'acme', repo: 'platform' };
const AZURE = { organization: 'acme', project: 'Platform' };

const WALLETS = {
  ana: 'GAYP5GW2ZOJPZ7FIBRWLSHHWU7THPQTSIGQYE5G7XAS3YIE34AAIJEAW',
  ben: 'GCVJELPHY6K5F3KADZ7AZFBTKZSCDKOGUG3HGFRTFKUS7TJ2NJWXBAEX',
  carla: 'GCLRGXCOJTZO5NTZ4EK3VNQOL4YZAQROFZZ3IRQCAWNPTYNHQ5QPUO6R',
  dmitri: 'GCRCAITJ7YMS6P2KMJAVWHB25N4GJ4KMSMB7QIFJGNVZ7WCRW5GRYCRG',
};

/** The team.json that goes with this data. team.example.json carries the same content. */
const config = {
  organization: 'acme-software',
  period: { label: 'Sprint 12', since: '2026-11-09', until: '2026-11-23' },
  github: [{ owner: GITHUB_REPO.owner, repo: GITHUB_REPO.repo, include: { reviews: true } }],
  azureBoards: [{ organization: AZURE.organization, project: AZURE.project }],
  identities: {
    'ana-dev': 'ana', 'ana@example.com': 'ana',
    'ben-codes': 'ben', 'ben@example.com': 'ben',
    'carla-m': 'carla', 'carla@example.com': 'carla',
    'dmitri-k': 'dmitri', 'dmitri@example.com': 'dmitri',
    'eve-ops': 'eve', 'eve@example.com': 'eve',
  },
  people: {
    ana: { name: 'Ana', wallet: WALLETS.ana },
    ben: { name: 'Ben', wallet: WALLETS.ben },
    carla: { name: 'Carla', wallet: WALLETS.carla },
    dmitri: { name: 'Dmitri', wallet: WALLETS.dmitri },
    eve: { name: 'Eve', wallet: null },
  },
  milestones: { creditEveryone: true },
  program: { payout: { model: 'proportional', pool: 1000 } },
  lifetime: { ana: 1200, dmitri: 5200 },
};

// ── GitHub ───────────────────────────────────────────────────────────────────

const ghUser = (login, type = 'User') => ({ login, type, html_url: `https://github.com/${login}` });
const PR_URL = (n) => `https://github.com/acme/platform/pull/${n}`;

/** [number, author, mergedAt, reviews as [login, state, submittedAt][]] */
const PULLS = [
  [101, 'ana-dev', '2026-11-10T14:00:00Z', [['ben-codes', 'APPROVED', '2026-11-10T12:00:00Z'], ['carla-m', 'CHANGES_REQUESTED', '2026-11-09T16:00:00Z'], ['carla-m', 'APPROVED', '2026-11-10T13:00:00Z'], ['ana-dev', 'APPROVED', '2026-11-10T13:30:00Z']]],
  [102, 'ana-dev', '2026-11-11T10:30:00Z', [['ben-codes', 'APPROVED', '2026-11-11T09:00:00Z']]],
  [103, 'ana-dev', '2026-11-16T15:00:00Z', [['carla-m', 'APPROVED', '2026-11-16T14:00:00Z'], ['dmitri-k', 'COMMENTED', '2026-11-16T13:00:00Z']]],
  [104, 'ben-codes', '2026-11-12T11:00:00Z', [['ana-dev', 'APPROVED', '2026-11-12T10:00:00Z'], ['guest-reviewer', 'APPROVED', '2026-11-12T10:30:00Z']]],
  [105, 'ben-codes', '2026-11-13T17:00:00Z', [['carla-m', 'APPROVED', '2026-11-13T16:00:00Z']]],
  [106, 'carla-m', '2026-11-12T09:00:00Z', [['ana-dev', 'APPROVED', '2026-11-12T08:00:00Z'], ['ben-codes', 'APPROVED', '2026-11-12T08:30:00Z']]],
  [107, 'carla-m', '2026-11-17T13:00:00Z', [['dmitri-k', 'APPROVED', '2026-11-17T12:00:00Z']]],
  [108, 'dmitri-k', '2026-11-18T16:00:00Z', [['ben-codes', 'APPROVED', '2026-11-18T15:00:00Z']]],
  [109, 'dmitri-k', '2026-11-20T10:00:00Z', [['carla-m', 'APPROVED', '2026-11-20T09:00:00Z'], ['ana-dev', 'APPROVED', '2026-11-20T09:30:00Z']]],
  [110, 'eve-ops', '2026-11-19T12:00:00Z', [['ben-codes', 'APPROVED', '2026-11-19T11:00:00Z']]],
  [111, 'dependabot[bot]', '2026-11-14T08:00:00Z', [['eve-ops', 'APPROVED', '2026-11-14T07:30:00Z']]],
  [112, 'ben-codes', '2026-11-22T14:00:00Z', [['ana-dev', 'APPROVED', '2026-11-22T13:00:00Z']]],
  // Outside the sprint or not merged: never counted.
  [114, 'ana-dev', '2026-11-23T10:00:00Z', []],
  [98, 'eve-ops', '2026-11-05T10:00:00Z', [['ben-codes', 'APPROVED', '2026-11-05T09:00:00Z']]],
  [113, 'carla-m', null, []],
];

const pullObject = ([number, author, mergedAt]) => ({
  number,
  state: 'closed',
  merged_at: mergedAt,
  updated_at: mergedAt || '2026-11-15T09:00:00Z',
  html_url: PR_URL(number),
  user: ghUser(author, author.endsWith('[bot]') ? 'Bot' : 'User'),
});

const reviewObjects = ([number, , , reviews]) => reviews.map(([login, state, at], i) => ({
  id: number * 10 + i,
  state,
  submitted_at: at,
  html_url: `${PR_URL(number)}#pullrequestreview-${number * 10 + i}`,
  user: ghUser(login),
}));

// A few direct commits, so `include.commits: true` has something to read.
const COMMITS = [
  ['ana-dev', '2026-11-10T14:00:00Z', 'a1b2c3d'], ['ben-codes', '2026-11-12T11:00:00Z', 'b2c3d4e'],
  ['carla-m', '2026-11-12T09:00:00Z', 'c3d4e5f'], ['dmitri-k', '2026-11-18T16:00:00Z', 'd4e5f6a'],
].map(([login, at, sha]) => ({
  sha, parents: [{ sha: '0000000' }], author: ghUser(login), html_url: `https://github.com/acme/platform/commit/${sha}`,
  commit: { committer: { date: at } },
}));

const MILESTONES = [
  { title: 'v2.4 Release', number: 7, closed_at: '2026-11-20T18:00:00Z', closed_issues: 14, html_url: 'https://github.com/acme/platform/milestone/7' },
  { title: 'v2.3 Release', number: 6, closed_at: '2026-11-02T18:00:00Z', closed_issues: 9, html_url: 'https://github.com/acme/platform/milestone/6' },
];

// ── Azure Boards ─────────────────────────────────────────────────────────────

const PERSON = (name) => ({ displayName: name[0].toUpperCase() + name.slice(1), uniqueName: `${name}@example.com`, id: `00000000-0000-4000-8000-${name.padEnd(12, '0')}` });
const SP = 'Microsoft.VSTS.Scheduling.StoryPoints';
const EF = 'Microsoft.VSTS.Scheduling.Effort';

/** [id, type, assignee, effort field, effort, closedAt] */
const ITEMS = [
  [2001, 'User Story', 'ana', SP, 5, '2026-11-10T09:00:00Z'],
  [2002, 'Task', 'ana', null, null, '2026-11-12T09:00:00Z'],
  [2003, 'Bug', 'ana', null, null, '2026-11-17T09:00:00Z'],
  [2004, 'User Story', 'ben', SP, 3, '2026-11-10T10:00:00Z'],
  [2005, 'User Story', 'ben', SP, 8, '2026-11-18T10:00:00Z'],
  [2006, 'Bug', 'ben', null, null, '2026-11-11T10:00:00Z'],
  [2007, 'Bug', 'ben', null, null, '2026-11-19T10:00:00Z'],
  [2008, 'Task', 'ben', EF, 2, '2026-11-20T10:00:00Z'],
  [2009, 'User Story', 'carla', SP, 5, '2026-11-13T11:00:00Z'],
  [2010, 'Task', 'carla', null, null, '2026-11-16T11:00:00Z'],
  [2011, 'Task', 'carla', EF, 3, '2026-11-19T11:00:00Z'],
  [2012, 'User Story', 'dmitri', SP, 13, '2026-11-20T12:00:00Z'],
  [2013, 'Bug', 'dmitri', null, null, '2026-11-12T12:00:00Z'],
  [2014, 'Task', 'dmitri', null, null, '2026-11-13T12:00:00Z'],
  [2015, 'Task', 'dmitri', EF, 0, '2026-11-17T12:00:00Z'],
  [2016, 'Task', 'eve', EF, 2, '2026-11-11T13:00:00Z'],
  [2017, 'Bug', 'eve', null, null, '2026-11-12T13:00:00Z'],
  [2018, 'Bug', 'eve', null, null, '2026-11-18T13:00:00Z'],
  [2019, 'User Story', 'eve', SP, 3, '2026-11-19T13:00:00Z'],
  [2020, 'Task', null, null, null, '2026-11-15T13:00:00Z'], // nobody assigned
  // Outside the sprint: the fake WIQL returns them anyway; the connector filters them out.
  [2021, 'Task', 'ana', null, null, '2026-11-24T09:00:00Z'],
  [2022, 'Task', 'ben', null, null, '2026-11-05T09:00:00Z'],
];

const workItem = ([id, type, who, field, effort, closedAt]) => ({
  id,
  fields: {
    'System.Id': id,
    'System.Title': `Invented work item ${id}`,
    'System.WorkItemType': type,
    'System.State': 'Done',
    'Microsoft.VSTS.Common.ClosedDate': closedAt,
    ...(who ? { 'System.AssignedTo': PERSON(who) } : {}),
    ...(field ? { [field]: effort } : {}),
  },
});

// ── The fake fetch ───────────────────────────────────────────────────────────

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const notFound = (what) => json(404, { message: `Not Found (fixtures serve only ${what})` });

/**
 * A fetch that answers the few GitHub and Azure DevOps endpoints the connectors
 * use, with the invented data above. No network. Anything else is a 404.
 */
function fakeFetch() {
  return async function fixturesFetch(input, init = {}) {
    const url = new URL(String(input));
    const base = '/repos/acme/platform';

    if (url.origin === 'https://api.github.com') {
      if (url.pathname === `${base}/pulls`) {
        const list = PULLS.map(pullObject).sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
        return json(200, list);
      }
      const review = url.pathname.match(new RegExp(`^${base}/pulls/(\\d+)/reviews$`));
      if (review) {
        const pull = PULLS.find((p) => p[0] === Number(review[1]));
        return pull ? json(200, reviewObjects(pull)) : json(404, { message: 'Not Found' });
      }
      if (url.pathname === `${base}/commits`) return json(200, COMMITS);
      if (url.pathname === `${base}/milestones`) return json(200, MILESTONES);
      return notFound('acme/platform');
    }

    if (url.origin === 'https://dev.azure.com') {
      const prefix = `/${AZURE.organization}/${AZURE.project}/_apis/wit/`;
      if (!url.pathname.startsWith(prefix) || init.method !== 'POST') return notFound('the acme / Platform project');
      const body = JSON.parse(init.body || '{}');
      if (url.pathname === `${prefix}wiql`) return json(200, { workItems: ITEMS.map((i) => ({ id: i[0] })) });
      if (url.pathname === `${prefix}workitemsbatch`) {
        const wanted = new Set(body.ids);
        return json(200, { value: ITEMS.filter((i) => wanted.has(i[0])).map(workItem) });
      }
    }
    return notFound('GitHub acme/platform and Azure Boards acme / Platform');
  };
}

module.exports = { fakeFetch, config, WALLETS };
