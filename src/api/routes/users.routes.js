'use strict';
const express = require('express');
const userService = require('../../services/userService');
const permissionService = require('../../services/permissionService');
const rbacSync = require('../../services/rbacSync');
const { User, Group } = require('../../db/models');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');

const router = express.Router();

// Lightweight member list — any authenticated user can fetch names for filters
router.get('/api/users/members', requireAuth, asyncHandler(async (_req, res) => {
  const members = await User.find({ active: { $ne: false } })
    .select('_id name role email').sort({ name: 1 }).lean();
  res.json(members);
}));

// ── User management (admin only) ──────────────────────────────────────────
router.get('/api/users', requireAuth, requireAdmin, async (_req, res) => {
  res.json(await userService.list());
});
router.post('/api/users', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  res.status(201).json(await userService.create(req.body));
}));
router.put('/api/users/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  res.json(await userService.update(req.params.id, req.body));
}));
router.delete('/api/users/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  res.json(await userService.delete(req.params.id, req.user.id));
}));

// ── Groups (team-based permissions) ───────────────────────────────────────
router.get('/api/groups', requireAuth, requireAdmin, asyncHandler(async (_req, res) => {
  res.json(await Group.find().sort({ name: 1 }).lean());
}));
router.post('/api/groups', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, description, permissions, members } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    const g = await Group.create({ name: name.trim(), description, permissions: permissions ?? [] });
    if (Array.isArray(members) && members.length) {
      await User.updateMany({ _id: { $in: members } }, { group: g._id });
      // Sync new members to K8s
      for (const uid of members) {
        try { await rbacSync.syncUserToK8s(uid); } catch {}
      }
    }
    res.status(201).json(g);
  } catch (err) {
    const status = err.code === 11000 ? 409 : 500;
    res.status(status).json({ error: err.code === 11000 ? 'Group name already exists' : err.message });
  }
});
router.put('/api/groups/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { name, description, permissions, members } = req.body;
  const upd = {};
  if (name !== undefined)        upd.name = name.trim();
  if (description !== undefined) upd.description = description;
  if (permissions !== undefined)  upd.permissions = permissions;
  const g = await Group.findByIdAndUpdate(req.params.id, upd, { new: true, runValidators: true });
  if (!g) return res.status(404).json({ error: 'Group not found' });
  // Update membership: unlink old members not in the new list, link new ones
  if (Array.isArray(members)) {
    const oldMembers = await User.find({ group: req.params.id }).select('_id').lean();
    const oldIds = oldMembers.map(u => u._id.toString());
    const removed = oldIds.filter(id => !members.includes(id));
    const added   = members.filter(id => !oldIds.includes(id));
    if (removed.length) await User.updateMany({ _id: { $in: removed } }, { $unset: { group: '' } });
    if (added.length)   await User.updateMany({ _id: { $in: added } }, { group: g._id });
    // Re-sync changed users to K8s
    for (const uid of [...removed, ...added]) {
      try { await rbacSync.syncUserToK8s(uid); } catch {}
    }
  }
  // When permissions changed, sync all current members to K8s
  if (permissions !== undefined) {
    try { await rbacSync.syncGroupToK8s(req.params.id); }
    catch (err) { console.warn('[RBAC Sync] group sync failed:', err.message); }
  }
  res.json(g);
}));
router.delete('/api/groups/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  // Collect members before unlinking so we can re-sync them (removes group bindings)
  const members = await User.find({ group: req.params.id }).select('_id role').lean();
  await User.updateMany({ group: req.params.id }, { $unset: { group: '' } });
  await Group.findByIdAndDelete(req.params.id);
  // Re-sync each ex-member — their effective perms no longer include the group's scopes
  for (const m of members) {
    if (m.role !== 'admin') {
      try { await rbacSync.syncUserToK8s(m._id); } catch {}
    }
  }
  res.json({ success: true });
}));

// ── User permissions + group assignment ───────────────────────────────────
router.get('/api/users/:id/permissions', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).select('permissions group').populate('group').lean();
  if (!user) return res.status(404).json({ error: 'User not found' });
  const effective = await permissionService.loadPermissions(req.params.id);
  res.json({ own: user.permissions ?? [], group: user.group ?? null, effective });
}));
router.put('/api/users/:id/permissions', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { permissions, group } = req.body;
  const upd = {};
  if (permissions !== undefined) upd.permissions = permissions;
  if (group !== undefined) upd.group = group || null;
  const user = await User.findByIdAndUpdate(req.params.id, upd, { new: true, runValidators: true }).select('-password');
  if (!user) return res.status(404).json({ error: 'User not found' });
  // Sync to real K8s RBAC in the background — don't block the response
  let k8sSync = null;
  if (user.role !== 'admin') {
    try { k8sSync = await rbacSync.syncUserToK8s(req.params.id); }
    catch (err) { console.warn('[RBAC Sync] user sync failed:', err.message); }
  }
  res.json({ ...user.toObject?.() ?? user, k8sSync });
}));

module.exports = router;
