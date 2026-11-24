'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { azureBoardsEvents, ConnectorError } = require('../src');
const { fakeFetch, json } = require('./helpers');

const SINCE = '2026-03-01T00:00:00Z';
const UNTIL = '2026-04-01T00:00:00Z';
const TOKEN = 'azure-FAKE-token-for-tests-xyz';
const EFFORT = 'Microsoft.VSTS.Scheduling.Effort';
const POINTS = 'Microsoft.VSTS.Scheduling.StoryPoints';

const person = (name, extra = {}) => ({
  displayName: `${name} Demo`, uniqueName: `${name}@example.com`, id: `00000000-0000-0000-0000-${name.padEnd(12, '0')}`, ...extra,
});
const item = (id, type, who, extra = {}) => ({
  id,
  fields: {
    'System.Id': id,
    'System.Title': `Item ${id}`,
    'System.WorkItemType': type,
    'System.State': 'Done',
    'System.AssignedTo': who,
    'Microsoft.VSTS.Common.ClosedDate': '2026-03-10T08:00:00Z',
    ...extra,
  },
});

/** Serves WIQL ids and the batch endpoint from a list of work items. */
function boardFetch(items) {
  const fetch = fakeFetch((u, init) => {
    const body = JSON.parse(init.body);
    if (u.pathname.endsWith('/_apis/wit/wiql')) return json({ workItems: items.map((w) => ({ id: w.id })) });
    if (u.pathname.endsWith('/_apis/wit/workitemsbatch')) {
      return json({ value: items.filter((w) => body.ids.includes(w.id)), count: body.ids.length });
    }
    return undefined;
  });
  return fetch;
}
const run = (fetch, extra = {}) => azureBoardsEvents({
  organization: 'acme-demo', project: 'Widgets', since: SINCE, until: UNTIL, token: TOKEN, fetch, ...extra,
});

test('WIQL selects done items of the project closed in [since, until)', async () => {
  const fetch = boardFetch([]);
  await run(fetch);
  const [call] = fetch.calls;
  assert.equal(call.init.method, 'POST');
  assert.equal(call.url, 'https://dev.azure.com/acme-demo/Widgets/_apis/wit/wiql?timePrecision=true&api-version=7.1');
  const { query } = JSON.parse(call.init.body);
  assert.equal(query,
    "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'Widgets'"
    + " AND [System.State] IN ('Done', 'Closed')"
    + " AND [Microsoft.VSTS.Common.ClosedDate] >= '2026-03-01T00:00:00.000Z'"
    + " AND [Microsoft.VSTS.Common.ClosedDate] < '2026-04-01T00:00:00.000Z'"
    + ' ORDER BY [System.Id]');
});

test('WIQL: type filter, custom states and single-quote escaping', async () => {
  const fetch = boardFetch([]);
  await run(fetch, { project: "O'Brien's Board", doneStates: ["Won't fix", 'Done'], types: ['User Story', "Dev's Task"] });
  const { query } = JSON.parse(fetch.calls[0].init.body);
  assert.match(query, /\[System\.TeamProject\] = 'O''Brien''s Board'/);
  assert.match(query, /\[System\.State\] IN \('Won''t fix', 'Done'\)/);
  assert.match(query, /\[System\.WorkItemType\] IN \('User Story', 'Dev''s Task'\)/);
});

test('organization and project are URL-encoded', async () => {
  const fetch = boardFetch([]);
  await run(fetch, { organization: 'my org', project: 'A/B C' });
  assert.ok(fetch.calls[0].url.startsWith('https://dev.azure.com/my%20org/A%2FB%20C/_apis/wit/wiql'));
});

test('batches work item ids in chunks of 200 and asks for the right fields', async () => {
  const items = Array.from({ length: 450 }, (_, i) => item(i + 1, 'Task', person('ana')));
  const fetch = boardFetch(items);
  const r = await run(fetch);
  const batches = fetch.calls.filter((c) => c.path.endsWith('/workitemsbatch'));
  assert.deepEqual(batches.map((c) => JSON.parse(c.init.body).ids.length), [200, 200, 50]);
  assert.ok(batches[0].url.endsWith('/_apis/wit/workitemsbatch?api-version=7.1'));
  assert.deepEqual(JSON.parse(batches[0].init.body).fields, [
    'System.Id', 'System.Title', 'System.WorkItemType', 'System.State', 'System.AssignedTo',
    'Microsoft.VSTS.Common.ClosedDate', EFFORT, POINTS,
  ]);
  assert.equal(r.events.length, 450);
});

test('item_done value: first positive effort field, then 1; bugs are bug_fixed with value 1', async () => {
  const fetch = boardFetch([
    item(1, 'User Story', person('ana'), { [EFFORT]: 5, [POINTS]: 8 }),
    item(2, 'User Story', person('ana'), { [POINTS]: 3 }),
    item(3, 'Task', person('ben'), { [EFFORT]: 0 }),
    item(4, 'Task', person('ben')),
    item(5, 'Bug', person('cai'), { [EFFORT]: 13 }),
    item(6, 'bug', person('cai')),
  ]);
  const r = await run(fetch);
  assert.deepEqual(r.events.map((e) => [e.participantId, e.metric, e.value]), [
    ['ana@example.com', 'item_done', 5],
    ['ana@example.com', 'item_done', 3],
    ['ben@example.com', 'item_done', 1],
    ['ben@example.com', 'item_done', 1],
    ['cai@example.com', 'bug_fixed', 1],
    ['cai@example.com', 'bug_fixed', 1],
  ]);
  assert.equal(r.events[0].ref, 'https://dev.azure.com/acme-demo/Widgets/_workitems/edit/1');
  assert.equal(r.events[0].at, '2026-03-10T08:00:00.000Z');
});

test('custom effortFields, bugTypes and metric ids', async () => {
  const fetch = boardFetch([
    item(1, 'Story', person('ana'), { 'Custom.Size': 21 }),
    item(2, 'Defect', person('ben')),
  ]);
  const r = await run(fetch, { effortFields: ['Custom.Size'], bugTypes: ['Defect'], metrics: { item_done: 'done', bug_fixed: 'fixed' } });
  assert.deepEqual(r.events.map((e) => [e.metric, e.value]), [['done', 21], ['fixed', 1]]);
});

test('items without an assignee are reported, never credited to a made-up participant', async () => {
  const fetch = boardFetch([item(1, 'Task', person('ana')), item(2, 'Task', undefined), item(3, 'Bug', null)]);
  const r = await run(fetch);
  assert.equal(r.events.length, 1);
  assert.deepEqual(r.unassigned, { count: 2, ids: [2, 3] });
  assert.equal(r.items.length, 3);
});

test('items closed outside the window are ignored even if the server returns them', async () => {
  const fetch = boardFetch([
    item(1, 'Task', person('ana'), { 'Microsoft.VSTS.Common.ClosedDate': '2026-04-01T00:00:00Z' }),
    item(2, 'Task', person('ana'), { 'Microsoft.VSTS.Common.ClosedDate': '2026-02-28T23:59:59Z' }),
    item(3, 'Task', person('ana'), { 'Microsoft.VSTS.Common.ClosedDate': '2026-03-01T00:00:00Z' }),
  ]);
  const r = await run(fetch);
  assert.deepEqual(r.events.map((e) => e.ref.split('/').pop()), ['3']);
});

test('auth pat sends Basic base64(":" + token); bearer sends Bearer', async () => {
  const pat = boardFetch([item(1, 'Task', person('ana'))]);
  await run(pat);
  for (const c of pat.calls) {
    assert.equal(c.init.headers.Authorization, `Basic ${Buffer.from(`:${TOKEN}`).toString('base64')}`);
    assert.equal(c.url.includes(TOKEN), false);
  }
  const bearer = boardFetch([item(1, 'Task', person('ana'))]);
  await run(bearer, { auth: 'bearer' });
  for (const c of bearer.calls) assert.equal(c.init.headers.Authorization, `Bearer ${TOKEN}`);
});

test('participantKey: uniqueName by default, id on request; people carry the display name only', async () => {
  const ana = person('ana');
  const fetch = boardFetch([item(1, 'Task', ana), item(2, 'Task', ana)]);
  const byName = await run(fetch);
  assert.deepEqual(byName.people, [{ participantId: 'ana@example.com', name: 'ana Demo' }]);
  const byId = await run(fetch, { participantKey: 'id' });
  assert.deepEqual(byId.people, [{ participantId: ana.id, name: 'ana Demo' }]);
  assert.equal(byId.events[0].participantId, ana.id);
  await assert.rejects(run(fetch, { participantKey: 'email' }), TypeError);
});

test('errors: HTTP status, rejected PAT (203) and network failure never expose the token', async () => {
  const e400 = await run(fakeFetch(() => json({ message: 'too many' }, { status: 400 }))).catch((e) => e);
  assert.ok(e400 instanceof ConnectorError);
  assert.equal(e400.status, 400);
  assert.match(e400.message, /azure-boards POST \/acme-demo\/Widgets\/_apis\/wit\/wiql/);

  const e203 = await run(fakeFetch(() => new Response('<html>sign in</html>', { status: 203 }))).catch((e) => e);
  assert.equal(e203.status, 401);
  assert.match(e203.message, /authentication was rejected/);

  const eNet = await run(fakeFetch(() => { throw Object.assign(new Error(`boom ${TOKEN}`), { code: 'ENOTFOUND' }); })).catch((e) => e);
  assert.equal(eNet.status, 0);

  for (const e of [e400, e203, eNet]) {
    const dump = `${e.message}\n${e.stack}\n${JSON.stringify(e)}`;
    assert.equal(dump.includes(TOKEN), false);
    assert.equal(dump.includes(Buffer.from(`:${TOKEN}`).toString('base64')), false);
  }
});

test('input validation', async () => {
  const fetch = boardFetch([]);
  await assert.rejects(azureBoardsEvents({ project: 'p', since: SINCE, token: 't', fetch }), TypeError);
  await assert.rejects(azureBoardsEvents({ organization: 'o', project: 'p', since: SINCE, fetch }), /token/);
  await assert.rejects(azureBoardsEvents({ organization: 'o', project: 'p', since: SINCE, token: 't', auth: 'basic', fetch }), TypeError);
  await assert.rejects(azureBoardsEvents({ organization: 'o', project: 'p', since: UNTIL, until: SINCE, token: 't', fetch }), RangeError);
  assert.equal(fetch.calls.length, 0);
});
