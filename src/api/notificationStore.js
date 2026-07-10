// Per-user SSE notification delivery + MongoDB persistence.
// Tracks live SSE connections so notifications reach the right browser tab.

'use strict';

const { Notification } = require('../db/models');

const connections = new Map(); // userId → Set<SSEResponse>

function register(userId, res) {
  if (!connections.has(userId)) connections.set(userId, new Set());
  connections.get(userId).add(res);
  return () => connections.get(userId)?.delete(res);
}

function _push(userId, payload) {
  const conns = connections.get(userId);
  if (!conns) return;
  for (const res of conns) {
    try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch {}
  }
}

async function send(targetUserIds, { type = 'info', message, data = {} }) {
  let doc;
  try {
    doc = await Notification.create({ targetUserIds, type, message, data, readBy: [] });
  } catch (err) {
    console.error('[Notifications] DB save failed:', err.message);
    doc = { _id: String(Date.now()), targetUserIds, type, message, data, readBy: [], createdAt: new Date().toISOString() };
  }

  const payload = {
    type: 'notification',
    notification: {
      id:        doc._id.toString(),
      type:      doc.type,
      message:   doc.message,
      data:      doc.data,
      readBy:    doc.readBy ?? [],
      createdAt: doc.createdAt,
    },
  };

  for (const userId of targetUserIds) _push(userId, payload);
  return payload.notification;
}

async function getForUser(userId) {
  const docs = await Notification.find({ targetUserIds: userId }).sort({ createdAt: -1 }).limit(50);
  return docs.map(d => ({
    id:        d._id.toString(),
    type:      d.type,
    message:   d.message,
    data:      d.data,
    readBy:    d.readBy ?? [],
    createdAt: d.createdAt,
  }));
}

async function markRead(userId, notifId) {
  await Notification.findByIdAndUpdate(notifId, { $addToSet: { readBy: userId } });
}

async function markAllRead(userId) {
  await Notification.updateMany({ targetUserIds: userId }, { $addToSet: { readBy: userId } });
}

module.exports = { register, send, getForUser, markRead, markAllRead };
