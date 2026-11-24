'use strict';

const { ConnectorError } = require('./errors');
const { toDate, resolveFetch, inWindow } = require('./util');

const CHUNK = 200;
const DEFAULT_METRICS = { item_done: 'item_done', bug_fixed: 'bug_fixed' };
const DEFAULT_MAX_EFFORT = 100;

/** WIQL string literal: single quotes are doubled. */
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const list = (values) => `(${values.map(lit).join(', ')})`;
const wiqlDate = (d) => lit(d.toISOString());

/**
 * Builds the WIQL text. Exported for tests.
 * @returns {string}
 */
function buildWiql({ project, since, until, doneStates, types }) {
  const where = [
    `[System.TeamProject] = ${lit(project)}`,
    `[System.State] IN ${list(doneStates)}`,
    `[Microsoft.VSTS.Common.ClosedDate] >= ${wiqlDate(since)}`,
    `[Microsoft.VSTS.Common.ClosedDate] < ${wiqlDate(until)}`,
  ];
  if (types && types.length) where.push(`[System.WorkItemType] IN ${list(types)}`);
  return `SELECT [System.Id] FROM WorkItems WHERE ${where.join(' AND ')} ORDER BY [System.Id]`;
}

async function post(ctx, path, body) {
  const url = `https://dev.azure.com/${encodeURIComponent(ctx.organization)}/${encodeURIComponent(ctx.project)}${path}`;
  const shown = new URL(url).pathname;
  let res;
  try {
    res = await ctx.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'harmony-connectors',
        Authorization: ctx.authorization,
      },
      body: JSON.stringify(body),
      redirect: 'manual',
    });
  } catch (e) {
    throw new ConnectorError(`azure-boards POST ${shown} failed: network error (${(e && (e.code || e.name)) || 'unknown'})`,
      { status: 0, source: 'azure-boards', endpoint: shown });
  }
  // Azure DevOps answers a bad or expired PAT with a 203 sign-in page or a redirect, not a 401.
  if (res.status === 203 || (res.status >= 300 && res.status < 400)) {
    throw new ConnectorError(`azure-boards POST ${shown} failed: authentication was rejected (HTTP ${res.status}); check the token and its Work Items (Read) scope`,
      { status: 401, source: 'azure-boards', endpoint: shown });
  }
  if (!res.ok) {
    throw new ConnectorError(`azure-boards POST ${shown} failed with HTTP ${res.status}`,
      { status: res.status, source: 'azure-boards', endpoint: shown });
  }
  return res.json();
}

/**
 * Reads work items closed in [since, until) from Azure Boards and returns plain
 * Harmony events.
 *
 * Each closed item with an assignee credits that person: `bug_fixed` (value 1)
 * for the types in `bugTypes`, otherwise `item_done` with value = the first
 * effort field that is a positive number, else 1. Items without an assignee are
 * reported in `unassigned` and credit nobody.
 *
 * PRIVACY: with the default `participantKey: 'uniqueName'` the participant id is
 * the assignee's sign-in name, which is usually an email address (personal data
 * that then lives in your payout records). Use `participantKey: 'id'` to use the
 * opaque identity GUID instead, and map it with mergeEvents({ identities }).
 *
 * @param {object} o
 * @param {string} o.organization
 * @param {string} o.project
 * @param {string|Date} o.since
 * @param {string|Date} [o.until] defaults to now
 * @param {string} o.token
 * @param {'pat'|'bearer'} [o.auth='pat']
 * @param {Function} [o.fetch]
 * @param {string[]} [o.doneStates]
 * @param {string[]} [o.bugTypes]
 * @param {string[]} [o.effortFields]
 * @param {string[]} [o.types] restrict to these work item types
 * @param {'uniqueName'|'id'} [o.participantKey='uniqueName']
 * @param {Partial<typeof DEFAULT_METRICS>} [o.metrics]
 * @param {number} [o.maxEffort=100] largest effort one item may credit. Effort is editable by any board user,
 *        so a larger value is clamped to this one and the item id is listed in `clamped`. A missing, zero,
 *        negative or non-finite effort counts as 1.
 * @returns {Promise<{events: Array, people: Array, window: object, items: Array, unassigned: {count: number, ids: number[]}, clamped: number[]}>}
 */
async function azureBoardsEvents(o = {}) {
  const {
    organization, project, token, auth = 'pat',
    doneStates = ['Done', 'Closed'], bugTypes = ['Bug'],
    effortFields = ['Microsoft.VSTS.Scheduling.Effort', 'Microsoft.VSTS.Scheduling.StoryPoints'],
    types, participantKey = 'uniqueName', maxEffort = DEFAULT_MAX_EFFORT,
  } = o;
  if (!organization || !project) throw new TypeError('"organization" and "project" are required');
  if (!token) throw new TypeError('"token" is required');
  if (auth !== 'pat' && auth !== 'bearer') throw new TypeError('"auth" must be "pat" or "bearer"');
  if (typeof maxEffort !== 'number' || !Number.isFinite(maxEffort) || maxEffort <= 0) throw new TypeError('"maxEffort" must be a number > 0');
  if (participantKey !== 'uniqueName' && participantKey !== 'id') {
    throw new TypeError('"participantKey" must be "uniqueName" or "id"');
  }
  const since = toDate(o.since, 'since');
  const until = o.until == null ? new Date() : toDate(o.until, 'until');
  if (until <= since) throw new RangeError('"until" must be after "since"');
  const metrics = { ...DEFAULT_METRICS, ...(o.metrics || {}) };
  const ctx = {
    fetch: resolveFetch(o.fetch),
    organization,
    project,
    authorization: auth === 'pat' ? `Basic ${Buffer.from(`:${token}`).toString('base64')}` : `Bearer ${token}`,
  };

  const wiql = buildWiql({ project, since, until, doneStates, types });
  // timePrecision makes WIQL compare date-times instead of whole days.
  const q = await post(ctx, '/_apis/wit/wiql?timePrecision=true&api-version=7.1', { query: wiql });
  const ids = ((q && q.workItems) || []).map((w) => w.id);

  const fields = ['System.Id', 'System.Title', 'System.WorkItemType', 'System.State', 'System.AssignedTo',
    'Microsoft.VSTS.Common.ClosedDate', ...effortFields];
  const raw = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const r = await post(ctx, '/_apis/wit/workitemsbatch?api-version=7.1', { ids: ids.slice(i, i + CHUNK), fields });
    raw.push(...((r && r.value) || []));
  }

  const bugSet = new Set(bugTypes.map((t) => t.toLowerCase()));
  const events = [];
  const items = [];
  const people = new Map();
  const unassigned = { count: 0, ids: [] };
  const clamped = [];
  const orgPath = `${encodeURIComponent(organization)}/${encodeURIComponent(project)}`;

  for (const w of raw) {
    const f = w.fields || {};
    const closedAt = f['Microsoft.VSTS.Common.ClosedDate'];
    if (!inWindow(closedAt, since, until)) continue; // belt and braces over WIQL
    const type = f['System.WorkItemType'];
    const isBug = bugSet.has(String(type).toLowerCase());
    let effort = null;
    for (const name of effortFields) {
      const n = Number(f[name]);
      if (Number.isFinite(n) && n > 0) { effort = n; break; }
    }
    const a = f['System.AssignedTo'];
    const pid = a && typeof a === 'object' ? a[participantKey] : null;
    items.push({
      id: w.id,
      title: f['System.Title'],
      type,
      state: f['System.State'],
      closedAt: new Date(closedAt).toISOString(),
      participantId: pid || null,
    });
    if (!pid) { unassigned.count += 1; unassigned.ids.push(w.id); continue; }
    if (!isBug && effort !== null && effort > maxEffort) { effort = maxEffort; clamped.push(w.id); }
    people.set(pid, { participantId: pid, name: a.displayName || pid });
    events.push({
      participantId: pid,
      metric: isBug ? metrics.bug_fixed : metrics.item_done,
      value: isBug ? 1 : (effort == null ? 1 : effort),
      at: new Date(closedAt).toISOString(),
      ref: `https://dev.azure.com/${orgPath}/_workitems/edit/${w.id}`,
    });
  }

  return {
    events,
    people: [...people.values()].sort((x, y) => x.participantId.localeCompare(y.participantId)),
    window: { since: since.toISOString(), until: until.toISOString() },
    items,
    unassigned,
    clamped,
  };
}

module.exports = { azureBoardsEvents, buildWiql };
