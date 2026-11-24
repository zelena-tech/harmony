'use strict';

const { ConnectorError } = require('./errors');

/**
 * @param {string|number|Date} value
 * @param {string} name option name, for the error message
 * @returns {Date}
 */
function toDate(value, name) {
  const d = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (value == null || Number.isNaN(d.getTime())) {
    throw new TypeError(`"${name}" must be an ISO date string or a Date`);
  }
  return d;
}

/**
 * Resolves the fetch implementation: the injected one or the global one.
 * @param {Function} [injected]
 * @returns {Function}
 */
function resolveFetch(injected) {
  const f = injected || globalThis.fetch;
  if (typeof f !== 'function') {
    throw new ConnectorError('No fetch implementation available: pass options.fetch', { status: 0 });
  }
  return f;
}

/** True when `at` is inside [start, end). */
function inWindow(at, start, end) {
  const t = new Date(at).getTime();
  return Number.isFinite(t) && t >= start.getTime() && t < end.getTime();
}

module.exports = { toDate, resolveFetch, inWindow };
