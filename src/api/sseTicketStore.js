'use strict';
const crypto = require('crypto');

// SSE (EventSource) requests can't carry an Authorization header, so the real
// session token used to have to ride in the URL query string — landing in server
// access logs, browser history, and any Referer header sent by the page. Instead,
// callers exchange their real token for a short-lived, single-use ticket via
// POST /api/auth/sse-ticket, and put *that* in the stream URL.
const TICKET_TTL_MS = 30 * 1000; // just long enough for the browser to open the connection
const tickets = new Map(); // ticket → { token, expiresAt }

setInterval(() => {
  const now = Date.now();
  for (const [ticket, entry] of tickets) { if (now > entry.expiresAt) tickets.delete(ticket); }
}, 60 * 1000).unref();

function issue(token) {
  const ticket = crypto.randomBytes(24).toString('hex');
  tickets.set(ticket, { token, expiresAt: Date.now() + TICKET_TTL_MS });
  return ticket;
}

// Single-use: consuming a ticket deletes it immediately, so it can't be replayed
// even within its TTL (e.g. if it leaked via a log line or Referer header).
function consume(ticket) {
  const entry = tickets.get(ticket);
  if (!entry) return null;
  tickets.delete(ticket);
  if (Date.now() > entry.expiresAt) return null;
  return entry.token;
}

module.exports = { issue, consume };
