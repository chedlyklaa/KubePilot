const crypto = require('crypto');
const { User } = require('../db/models');

// In-memory token store: token → { user payload + expiresAt }
const tokens = new Map();

// Token TTL: 8 hours from login
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

// Sweep expired tokens every 15 minutes to avoid memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [tok, entry] of tokens) {
    if (now > entry.expiresAt) tokens.delete(tok);
  }
}, 15 * 60 * 1000).unref(); // .unref() so this timer doesn't prevent process exit

// Seed default users on first start
async function seedUsers() {
  const count = await User.countDocuments();
  if (count === 0) {
    await User.insertMany([
      { email: 'admin@admin.com',         password: 'admin',     name: 'Admin',     role: 'admin' },
      { email: 'developer@developer.com', password: 'developer', name: 'Developer', role: 'developer' },
    ]);
    console.log('[Auth] Default users seeded');
  }
}

async function login(email, password) {
  const user = await User.findOne({ email: email.toLowerCase().trim(), active: true });
  if (!user || user.password !== password) return null;
  const token   = crypto.randomBytes(32).toString('hex');
  const payload = { id: user._id.toString(), email: user.email, name: user.name, role: user.role };
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

module.exports = { seedUsers, login, getUser, logout };
