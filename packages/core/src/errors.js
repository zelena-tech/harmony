'use strict';

/**
 * Error with an HTTP-like status so a host API can forward it unchanged:
 * 400 = invalid input, 409 = valid input that conflicts with the current state
 * (caps exceeded, nobody to pay, insufficient balance…), 502 = the network
 * rejected a transaction.
 */
class HarmonyError extends Error {
  constructor(statusCode, message, extra) {
    super(message);
    this.name = 'HarmonyError';
    this.statusCode = statusCode;
    Object.assign(this, extra || {});
  }
}

/** Invalid tenant configuration. `problems` lists every field that failed. */
class TenantConfigError extends Error {
  constructor(problems) {
    super(`Invalid tenant configuration: ${problems.join('; ')}`);
    this.name = 'TenantConfigError';
    this.problems = problems;
  }
}

module.exports = { HarmonyError, TenantConfigError };
