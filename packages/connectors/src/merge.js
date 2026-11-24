'use strict';

/**
 * Concatenates the events of several connector results and, optionally, rewrites
 * participant ids so one person coming from two systems is one participant.
 *
 * Usage: mergeEvents(github, azure) or mergeEvents(github, azure, { identities }).
 * `identities` maps a source id (GitHub login, email, ...) to a canonical id;
 * lookup ignores case. Ids missing from the map are kept as they are and listed
 * in `unmapped` (only when `identities` is given).
 *
 * @param {...object} args connector results, optionally followed by { identities }
 * @returns {{events: Array, people: Array, unmapped: string[]}}
 */
function mergeEvents(...args) {
  let identities = null;
  const last = args[args.length - 1];
  if (last && !Array.isArray(last.events) && Object.prototype.hasOwnProperty.call(last, 'identities')) {
    identities = last.identities;
    args = args.slice(0, -1);
  }
  const map = new Map();
  if (identities) for (const [k, v] of Object.entries(identities)) map.set(k.toLowerCase(), v);
  const unmapped = new Set();
  const canon = (id) => {
    if (!identities) return id;
    const hit = map.get(String(id).toLowerCase());
    if (hit == null) { unmapped.add(id); return id; }
    return hit;
  };

  const events = [];
  const people = new Map();
  for (const result of args) {
    for (const e of (result && result.events) || []) events.push({ ...e, participantId: canon(e.participantId) });
    for (const p of (result && result.people) || []) {
      const id = canon(p.participantId);
      if (!people.has(id)) people.set(id, { ...p, participantId: id });
    }
  }
  return { events, people: [...people.values()], unmapped: [...unmapped].sort() };
}

module.exports = { mergeEvents };
