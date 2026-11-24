'use strict';

/**
 * Synthetic work for the quickstart examples: made-up people, made-up events.
 *
 * Everything is derived from the program itself (its own metric ids, points,
 * caps and level thresholds), so it works for ANY template, and it is seeded,
 * so the same inputs always give the same numbers. Nothing here is real data.
 */

/** Small seeded pseudo-random generator (mulberry32): same seed, same sequence. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Invented first names. */
const FIRST_NAMES = ['Ana', 'Luis', 'Sofia', 'Mateo', 'Valentina', 'Diego'];

/** How productive each person is in the period (1 = average). */
const SKILL = { Ana: 1.4, Luis: 1.0, Sofia: 0.8, Mateo: 1.2, Valentina: 0.6, Diego: 0.9 };

/**
 * Events for one period.
 *
 * @param {object} program  a defined program (kit.createProgram(...).program)
 * @param {Array<{id: string, skill?: number}>} people
 * @param {number} [seed]
 * @returns {{events: Array, lifetime: Object<string, number>}}
 *   `lifetime` spreads the people over the ladder so several levels show up.
 */
function syntheticActivity(program, people, seed = 7) {
  const rand = rng(seed);
  const positive = program.metrics.filter((m) => m.points > 0);
  const negative = program.metrics.filter((m) => m.points < 0);
  const events = [];
  const lifetime = {};
  people.forEach((person, index) => {
    const skill = person.skill === undefined ? 1 : person.skill;
    // About 500 points of positive work for an average person, whatever the points per unit are.
    const target = 500 * skill * (0.85 + 0.3 * rand());
    for (const m of positive) {
      let units = Math.max(1, Math.round((target / positive.length) / m.points * (0.6 + 0.8 * rand())));
      if (m.cap !== null) units = Math.min(units, Math.max(1, Math.round(m.cap * (0.5 + 0.5 * rand()))));
      // Split into a few events, as real systems report them.
      const parts = Math.min(units, 1 + Math.floor(rand() * 3));
      let left = units;
      for (let i = 0; i < parts; i++) {
        const value = i === parts - 1 ? left : Math.max(1, Math.floor(left / (parts - i)));
        left -= value;
        events.push({ participantId: person.id, metric: m.id, value });
      }
    }
    for (const m of negative) {
      const units = Math.floor(rand() * 3);
      if (units > 0) events.push({ participantId: person.id, metric: m.id, value: units });
    }
    // Lifetime points: the people sit on different rungs of the ladder.
    const rung = program.levels[(index + 1) % program.levels.length];
    lifetime[person.id] = rung.minLifetimePoints + Math.floor(rand() * 40);
  });
  return { events, lifetime };
}

module.exports = { rng, FIRST_NAMES, SKILL, syntheticActivity };
