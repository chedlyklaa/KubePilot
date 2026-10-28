'use strict';
const crypto = require('crypto');

const TICKET_TTL_MS = 30 * 1000;
const tickets = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [ticket, entry] of tickets) { if (now > entry.expiresAt) tickets.delete(ticket); }
}, 60 * 1000).unref();

function issue(token) {
  const ticket = crypto.randomBytes(24).toString('hex');
  tickets.set(ticket, { token, expiresAt: Date.now() + TICKET_TTL_MS });
  return ticket;
}

// Consume a one-time SSE ticket
function consume(ticket) {
  const entry = tickets.get(ticket);
  if (!entry) return null;
  tickets.delete(ticket);
  if (Date.now() > entry.expiresAt) return null;
  return entry.token;
}

module.exports = { issue, consume };
