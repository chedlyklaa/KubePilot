'use strict';

// Check if an error message is safe to return
function isSafeToExpose(err) {
  if (err.code && /^E[A-Z]+$/.test(err.code)) return false;
  if (err.name === 'MongoNetworkError' || err.name === 'MongoServerSelectionError') return false;
  return true;
}

// Wrap an async route handler
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
