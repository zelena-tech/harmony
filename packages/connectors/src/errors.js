'use strict';

/**
 * Error raised by every connector. The message names the source and the
 * endpoint path and never contains a token, a query string or a response body.
 */
class ConnectorError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, source?: string, endpoint?: string}} [info]
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'ConnectorError';
    this.status = info.status != null ? info.status : 0;
    this.source = info.source || null;
    this.endpoint = info.endpoint || null;
  }
}

module.exports = { ConnectorError };
