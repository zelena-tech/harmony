'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeEvents } = require('../src');

const gh = {
  events: [{ participantId: 'ana-dev', metric: 'pr_merged', value: 1 }, { participantId: 'ben-dev', metric: 'commit', value: 1 }],
  people: [{ participantId: 'ana-dev', name: 'ana-dev', url: 'https://github.com/ana-dev' }],
};
const az = {
  events: [{ participantId: 'ana@example.com', metric: 'item_done', value: 5 }, { participantId: 'cai@example.com', metric: 'bug_fixed', value: 1 }],
  people: [{ participantId: 'ana@example.com', name: 'Ana Demo' }],
};

test('without identities it just concatenates and leaves ids untouched', () => {
  const r = mergeEvents(gh, az);
  assert.equal(r.events.length, 4);
  assert.deepEqual(r.events.map((e) => e.participantId), ['ana-dev', 'ben-dev', 'ana@example.com', 'cai@example.com']);
  assert.deepEqual(r.unmapped, []);
  assert.equal(r.people.length, 2);
});

test('with identities the same person from two systems becomes one participant', () => {
  const r = mergeEvents(gh, az, { identities: { 'ana-dev': 'ana', 'Ana@Example.com': 'ana', 'ben-dev': 'ben' } });
  assert.deepEqual(r.events.map((e) => e.participantId), ['ana', 'ben', 'ana', 'cai@example.com']);
  assert.deepEqual(r.unmapped, ['cai@example.com']);
  assert.deepEqual(r.people.map((p) => p.participantId), ['ana']); // first seen wins; unmapped ids without a person row are not invented
  assert.equal(r.people[0].name, 'ana-dev');
});

test('inputs are not mutated and extra event fields survive', () => {
  const input = { events: [{ participantId: 'ana-dev', metric: 'commit', value: 1, ref: 'r', at: 'a' }], people: [] };
  const r = mergeEvents(input, { identities: { 'ana-dev': 'ana' } });
  assert.equal(input.events[0].participantId, 'ana-dev');
  assert.deepEqual(r.events[0], { participantId: 'ana', metric: 'commit', value: 1, ref: 'r', at: 'a' });
});

test('empty and missing results are tolerated', () => {
  assert.deepEqual(mergeEvents(), { events: [], people: [], unmapped: [], assumedCanonical: [] });
  assert.deepEqual(mergeEvents({}, null).events, []);
});

test('an id that is already a canonical id is not reported as unmapped', () => {
  const identities = { 'ana-dev': 'ana', 'ana@example.com': 'Ana' };
  const r = mergeEvents(gh, { events: [{ participantId: 'ana', metric: 'review', value: 1 }, { participantId: 'ANA', metric: 'review', value: 1 }, { participantId: 'zed', metric: 'review', value: 1 }], people: [] },
    { identities });
  assert.deepEqual(r.events.map((e) => e.participantId), ['ana', 'ben-dev', 'ana', 'ANA', 'zed']);
  assert.deepEqual(r.unmapped, ['ben-dev', 'zed'], 'ana and ANA are canonical (case ignored); the others are not in the map');
  assert.deepEqual(r.assumedCanonical, ['ANA', 'ana'], 'but they are not hidden: they were taken as the canonical person because the id matches');
});

test('a collision between an unmapped id and a canonical id is visible in assumedCanonical', () => {
  // Two different people: the one mapped to "ana", and an unrelated GitHub user whose login is "ana".
  const github = { events: [{ participantId: 'ana-dev', metric: 'pr_merged', value: 1 }, { participantId: 'ana', metric: 'pr_merged', value: 1 }], people: [] };
  const azure = { events: [{ participantId: 'ana@example.com', metric: 'item_done', value: 3 }], people: [] };
  const r = mergeEvents(github, azure, { identities: { 'ana-dev': 'ana', 'ana@example.com': 'ana' } });
  assert.deepEqual(r.events.map((e) => e.participantId), ['ana', 'ana', 'ana'], 'merged into one person, as documented');
  assert.deepEqual(r.unmapped, []);
  assert.deepEqual(r.assumedCanonical, ['ana'], 'the host can see the id was assumed and review it');
  // Without identities nothing is assumed.
  assert.deepEqual(mergeEvents(github, azure).assumedCanonical, []);
});
