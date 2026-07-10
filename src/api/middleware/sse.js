'use strict';

function sseHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
}

// Attach a heartbeat to an SSE response — prevents ECONNRESET on idle streams
function heartbeat(req, res) {
  const iv = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25_000);
  req.on('close', () => clearInterval(iv));
}

module.exports = { sseHeaders, heartbeat };
