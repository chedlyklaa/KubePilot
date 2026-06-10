'use strict';
const { User } = require('../db/models');

class UserService {
  async list() {
    return User.find().select('-password').sort({ createdAt: 1 }).lean();
  }

  async create({ email, name, role, password }) {
    if (!email || !password || !name)
      throw Object.assign(new Error('email, password and name required'), { status: 400 });
    if (await User.findOne({ email: email.toLowerCase() }))
      throw Object.assign(new Error('Email already in use'), { status: 409 });
    const u = await User.create({ email, password, name, role: role || 'developer' });
    return { id: u._id, email: u.email, name: u.name, role: u.role };
  }

  async update(id, { name, role, password, active }) {
    const upd = {};
    if (name !== undefined) {
      if (!name?.trim()) throw Object.assign(new Error('Name cannot be empty'), { status: 400 });
      upd.name = name.trim();
    }
    if (role     !== undefined) upd.role     = role;
    if (password !== undefined) upd.password = password;
    if (active   !== undefined) upd.active   = active;

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
