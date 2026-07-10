'use strict';

// System/driver-level failures (DNS, connection refused, Mongo topology loss, etc.)
// carry messages that can leak internal details (hostnames, connection strings).
// Everything else thrown by application/store code (e.g. "Cluster not found",
// Mongoose ValidationError) has a message the frontend already surfaces to users —
// keep exposing those as before so no client-facing behavior changes.
function isSafeToExpose(err) {
  if (err.code && /^E[A-Z]+$/.test(err.code)) return false; // ECONNREFUSED, ENOTFOUND, ...
  if (err.name === 'MongoNetworkError' || err.name === 'MongoServerSelectionError') return false;
  return true;
}

// Wraps an async route handler so a rejected promise results in a logged error
// and a JSON error response, instead of an unhandled rejection. Replaces the
// repeated `try { ... } catch (err) { res.status(500).json({ error: err.message }) }`
// block that used to appear in nearly every handler.
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(err => {
      console.error(`[API] ${req.method} ${req.originalUrl}:`, err);
      if (res.headersSent) return next(err);
      res.status(err.status ?? 500).json({
        error: isSafeToExpose(err) ? err.message : 'Internal server error',
      });
    });
  };
}

module.exports = { asyncHandler };
