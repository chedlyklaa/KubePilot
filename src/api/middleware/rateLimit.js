'use strict';
const rateLimit = require('express-rate-limit');

// Blanket per-IP throttle for authentication endpoints (login, forgot-password,
// reset-password, OTP request) — the ones a credential-stuffing / brute-force /
// enumeration script would hit repeatedly. This is a second, independent layer on
// top of the per-account lockout in authService.js and the per-OTP attempt counter
// in profileService.js: those stop one attacker hammering one account, this stops
// one attacker hammering many accounts from the same IP.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});

module.exports = { authLimiter };
