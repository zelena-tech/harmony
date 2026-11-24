'use strict';

/**
 * Fake fetch: `handler(url: URL, init)` returns a Response or undefined (404).
 * Every call is recorded in `fetch.calls`.
 */
function fakeFetch(handler) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url: String(url), path: u.pathname, search: u.search, init });
    const res = await handler(u, init);
    return res || json({ message: 'Not Found' }, { status: 404 });
  };
  fetch.calls = calls;
  return fetch;
}

function json(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const user = (login, extra = {}) => ({ login, type: 'User', html_url: `https://github.com/${login}`, ...extra });

module.exports = { fakeFetch, json, user };
