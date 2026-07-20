const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { User } = require('../db/models');

const SALT_ROUNDS = 10;

// In-memory token store: token → { user payload + expiresAt }
const tokens = new Map();

// Token TTL: 8 hours from login
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

// In-memory password reset tokens: token → { email, expiresAt }
const resetTokens = new Map();
const RESET_TTL_MS = 15 * 60 * 1000; // 15 minutes

// Per-account login lockout: email → { count, lastAttempt, lockedUntil }
// Keyed by account rather than IP — combined with the per-IP rateLimit middleware
// on the route (which stops one attacker hammering many accounts), this stops
// repeated guesses against one specific account regardless of source IP.
const loginAttempts       = new Map();
const MAX_LOGIN_ATTEMPTS  = 5;
const LOGIN_LOCKOUT_MS    = 15 * 60 * 1000; // 15 minutes

// Sweep expired tokens every 15 minutes to avoid memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [tok, entry] of tokens)      { if (now > entry.expiresAt) tokens.delete(tok); }
  for (const [tok, entry] of resetTokens) { if (now > entry.expiresAt) resetTokens.delete(tok); }
  for (const [key, entry] of loginAttempts) {
    const staleAt = entry.lockedUntil ?? (entry.lastAttempt + LOGIN_LOCKOUT_MS);
    if (now > staleAt) loginAttempts.delete(key);
  }
}, 15 * 60 * 1000).unref(); // .unref() so this timer doesn't prevent process exit

function _recordFailedLogin(key) {
  const entry = loginAttempts.get(key) ?? { count: 0, lockedUntil: null };
  entry.count += 1;
  entry.lastAttempt = Date.now();
  if (entry.count >= MAX_LOGIN_ATTEMPTS) entry.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
  loginAttempts.set(key, entry);
}

// Seed default users on first start.
// Passwords are randomly generated per-install rather than hardcoded — a fixed default
// password is a well-known attack vector against any deployment that forgets to change it.
async function seedUsers() {
  const count = await User.countDocuments();
  if (count === 0) {
    const adminPassword = crypto.randomBytes(9).toString('hex');
    const devPassword   = crypto.randomBytes(9).toString('hex');
    await User.insertMany([
      { email: 'admin@admin.com',         password: await bcrypt.hash(adminPassword, SALT_ROUNDS), name: 'Admin',     role: 'admin' },
      { email: 'developer@developer.com', password: await bcrypt.hash(devPassword, SALT_ROUNDS),   name: 'Developer', role: 'developer' },
    ]);
    console.log('[Auth] Default users seeded — change these passwords immediately after first login:');
    console.log(`[Auth]   admin@admin.com         : ${adminPassword}`);
    console.log(`[Auth]   developer@developer.com : ${devPassword}`);
  }
}

async function login(email, password) {
  const key = (email || '').toLowerCase().trim();

  const attempt = loginAttempts.get(key);
  if (attempt?.lockedUntil && Date.now() < attempt.lockedUntil) {
    throw Object.assign(new Error('Too many failed login attempts. Try again in a few minutes.'), { status: 429 });
  }

  const user  = await User.findOne({ email: key, active: true });
  const match = user && await bcrypt.compare(password, user.password);
  if (!user || !match) {
    _recordFailedLogin(key);
    return null;
  }
  loginAttempts.delete(key);

  const token   = crypto.randomBytes(32).toString('hex');
  const payload = {
    id: user._id.toString(), email: user.email, name: user.name, role: user.role,
    permissions: user.permissions ?? [], group: user.group ?? null,
  };
  tokens.set(token, { ...payload, expiresAt: Date.now() + TOKEN_TTL_MS });
  return { token, user: payload };
}

function getUser(token) {
  const entry = tokens.get(token);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    tokens.delete(token); // expired — force 401
    return null;
  }
  return entry;
}

function logout(token) {
  tokens.delete(token);
}

// Update the in-memory payload for all active sessions belonging to a user.
// Call this after a profile name change so req.user.name stays current.
function updateUserPayload(userId, patch) {
  for (const entry of tokens.values()) {
    if (entry.id === userId) Object.assign(entry, patch);
  }
}

async function forgotPassword(email) {
  if (!email) throw Object.assign(new Error('Email is required'), { status: 400 });
  const user = await User.findOne({ email: email.toLowerCase().trim(), active: true });
  // Return silently (same as the success path) whether or not the account exists —
  // a distinct response for "no account" lets an attacker enumerate valid emails.
  if (!user) return;
  const token = crypto.randomBytes(32).toString('hex');
  resetTokens.set(token, { email: user.email, expiresAt: Date.now() + RESET_TTL_MS });
  try {
    const mailer = require('../services/mailer');
    await mailer.sendPasswordResetEmail(user.email, token);
  } catch (err) {
    console.warn('[Auth] Password reset email failed:', err.message);
  }
}

async function resetPassword(token, newPassword) {
  if (!token || !newPassword) throw Object.assign(new Error('token and password required'), { status: 400 });
  const entry = resetTokens.get(token);
  if (!entry) throw Object.assign(new Error('Invalid or expired reset link'), { status: 400 });
  if (Date.now() > entry.expiresAt) {
    resetTokens.delete(token);
    throw Object.assign(new Error('Reset link has expired'), { status: 400 });
  }
  const hashed = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await User.updateOne({ email: entry.email }, { password: hashed });
  resetTokens.delete(token);
}

module.exports = { seedUsers, login, getUser, logout, updateUserPayload, forgotPassword, resetPassword };
