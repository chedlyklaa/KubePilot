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

// Sweep expired tokens every 15 minutes to avoid memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [tok, entry] of tokens)      { if (now > entry.expiresAt) tokens.delete(tok); }
  for (const [tok, entry] of resetTokens) { if (now > entry.expiresAt) resetTokens.delete(tok); }
}, 15 * 60 * 1000).unref(); // .unref() so this timer doesn't prevent process exit

// Seed default users on first start
async function seedUsers() {
  const count = await User.countDocuments();
  if (count === 0) {
    await User.insertMany([
      { email: 'admin@admin.com',         password: await bcrypt.hash('admin', SALT_ROUNDS),     name: 'Admin',     role: 'admin' },
      { email: 'developer@developer.com', password: await bcrypt.hash('developer', SALT_ROUNDS), name: 'Developer', role: 'developer' },
    ]);
    console.log('[Auth] Default users seeded');
  }
}

async function login(email, password) {
  const user = await User.findOne({ email: email.toLowerCase().trim(), active: true });
  if (!user) return null;
  const match = await bcrypt.compare(password, user.password);
  if (!match) return null;
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
  if (!user) throw Object.assign(new Error('No account found for this email. Ask your admin to create one.'), { status: 404 });
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
