'use strict';
const bcrypt = require('bcrypt');
const { User } = require('../db/models');

const SALT_ROUNDS = 10;

class UserService {
  async list() {
    return User.find().select('-password').sort({ createdAt: 1 }).lean();
  }

  async create({ email, name, role, password }) {
    if (!email || !password || !name)
      throw Object.assign(new Error('email, password and name required'), { status: 400 });
    if (await User.findOne({ email: email.toLowerCase() }))
      throw Object.assign(new Error('Email already in use'), { status: 409 });
    const hashed = await bcrypt.hash(password, SALT_ROUNDS);
    const u = await User.create({ email, password: hashed, name, role: role || 'developer' });
    try {
      const mailer = require('./mailer');
      await mailer.sendWelcomeEmail(u.email, u.name, password);
    } catch (err) {
      console.warn('[UserService] Welcome email failed:', err.message);
    }
    return { id: u._id, email: u.email, name: u.name, role: u.role };
  }

  async update(id, { name, role, password, active, canProvision }) {
    const upd = {};
    if (name !== undefined) {
      if (!name?.trim()) throw Object.assign(new Error('Name cannot be empty'), { status: 400 });
      upd.name = name.trim();
    }
    if (role         !== undefined) upd.role         = role;
    if (password     !== undefined) upd.password     = await bcrypt.hash(password, SALT_ROUNDS);
    if (active       !== undefined) upd.active       = active;
    if (canProvision !== undefined) upd.canProvision = canProvision;

    const u = await User.findByIdAndUpdate(id, upd, { new: true, runValidators: true }).select('-password');
    if (!u) throw Object.assign(new Error('User not found'), { status: 404 });
    return u;
  }

  async delete(id, requestingUserId) {
    if (id === requestingUserId)
      throw Object.assign(new Error('Cannot delete your own account'), { status: 400 });
    await User.findByIdAndDelete(id);
    return { success: true };
  }
}

module.exports = new UserService();
