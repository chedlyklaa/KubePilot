'use strict';
const authService        = require('../authService');
const permissionService  = require('../../services/permissionService');

function getToken(req) {
  return req.headers.authorization?.replace('Bearer ', '') || req.query.token || null;
}

function requireAuth(req, res, next) {
  const user = authService.getUser(getToken(req));
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  req.user = user; next();
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  next();
}

async function loadPerms(req, res, next) {
  if (req.user?.role === 'admin') {
    req.permissions = [{ cluster: '*', namespace: '*', role: 'admin' }];
    return next();
  }
  try { req.permissions = await permissionService.loadPermissions(req.user.id); }
  catch (_e) { req.permissions = []; }
  next();
}

module.exports = { getToken, requireAuth, requireAdmin, loadPerms };
