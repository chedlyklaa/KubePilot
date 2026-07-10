'use strict';
const express = require('express');
const cors    = require('cors');

// Route modules — one per domain, each mounting its own full "/api/..." paths.
// Mount order below only matters within a shared path prefix (e.g. all "/api/users/*"
// routes stay in their original relative order inside users.routes.js); there is no
// path overlap across different domain files, so cross-file order is unconstrained.
const authRoutes          = require('./routes/auth.routes');
const logsRoutes          = require('./routes/logs.routes');
const approvalsRoutes     = require('./routes/approvals.routes');
const silencesRoutes      = require('./routes/silences.routes');
const escalationsRoutes   = require('./routes/escalations.routes');
const notificationsRoutes = require('./routes/notifications.routes');
const historyRoutes       = require('./routes/history.routes');
const usersRoutes         = require('./routes/users.routes');
const clusterRoutes       = require('./routes/cluster.routes');
const chatRoutes          = require('./routes/chat.routes');
const commandsRoutes      = require('./routes/commands.routes');
const rbacRoutes          = require('./routes/rbac.routes');
const metricsRoutes       = require('./routes/metrics.routes');
const capacityRoutes      = require('./routes/capacity.routes');
const profileRoutes       = require('./routes/profile.routes');
const agentsRoutes        = require('./routes/agents.routes');
const auditRoutes         = require('./routes/audit.routes');

function createServer(port = 3001) {
  const app = express();
  const DASHBOARD_ORIGIN = process.env.DASHBOARD_URL || 'http://localhost:5173';
  app.use(cors({ origin: DASHBOARD_ORIGIN, credentials: true }));
  app.use(express.json({ limit: '5mb' }));

  app.use(authRoutes);
  app.use(logsRoutes);
  app.use(approvalsRoutes);
  app.use(silencesRoutes);
  app.use(escalationsRoutes);
  app.use(notificationsRoutes);
  app.use(historyRoutes);
  app.use(usersRoutes);
  app.use(clusterRoutes);
  app.use(chatRoutes);
  app.use(commandsRoutes);
  app.use(rbacRoutes);
  app.use(metricsRoutes);
  app.use(capacityRoutes);
  app.use(profileRoutes);
  app.use(agentsRoutes);
  app.use(auditRoutes);

  app.listen(port, () => console.log(`[API] Dashboard server on http://localhost:${port}`));
}

module.exports = { createServer };
