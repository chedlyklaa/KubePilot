// src/notifications/Teams.js
// Sends Adaptive Card messages to Microsoft Teams via Incoming Webhooks.
//
// .env keys required:
//   TEAMS_WEBHOOK_URL        — general channel  (all users, escalations)
//   TEAMS_ADMIN_WEBHOOK_URL  — admin channel    (approval requests)
//   DASHBOARD_URL            — e.g. http://localhost:5173

const https = require('https');
const url   = require('url');

// ── Low-level POST ─────────────────────────────────────────────────────────────
function post(webhookUrl, body) {
  return new Promise((resolve, reject) => {
    if (!webhookUrl) {
      console.warn('[Teams] Webhook URL not set — skipping');
      return resolve();
    }

    const data    = JSON.stringify(body);
    const parsed  = url.parse(webhookUrl);
    const options = {
      hostname: parsed.hostname,
      path:     parsed.path,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };

    const req = https.request(options, res => {
      res.resume();
      if (res.statusCode >= 200 && res.statusCode < 300) resolve();
      else reject(new Error(`Teams HTTP ${res.statusCode}`));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Shared card builders ───────────────────────────────────────────────────────
function factRow(title, value) {
  return { title, value: String(value ?? '—') };
}

function riskColor(risk) {
  return risk === 'HIGH' ? 'attention' : risk === 'MEDIUM' ? 'warning' : 'good';
}

// ── Send to admin webhook (approval requests) ─────────────────────────────────
async function sendApprovalRequest({ issueKey, action, risk, cluster, namespace, rootCause, dashboardUrl }) {
  const card = {
    type:        'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type:    'AdaptiveCard',
        version: '1.4',
        body: [
          {
            type:   'TextBlock',
            text:   '🔐 Approval Required — K8s AI Agent',
            weight: 'Bolder',
            size:   'Large',
            color:  'Warning',
          },
          {
            type:  'TextBlock',
            text:  'The agent detected a **high-risk action** and needs admin approval before proceeding.',
            wrap:  true,
            color: 'Default',
            spacing: 'Small',
          },
          {
            type:  'FactSet',
            facts: [
              factRow('Issue Key',  issueKey),
              factRow('Cluster',    cluster),
              factRow('Namespace',  namespace),
              factRow('Action',     action),
              factRow('Risk',       risk),
              factRow('Root Cause', rootCause),
            ],
          },
          {
            type:    'TextBlock',
            text:    `⏱ Auto-denied in **10 minutes** if no action is taken.`,
            wrap:    true,
            size:    'Small',
            color:   'Attention',
            spacing: 'Small',
          },
        ],
        actions: [
          {
            type:  'Action.OpenUrl',
            title: '→ Open Dashboard to Approve / Deny',
            url:   `${dashboardUrl || 'http://localhost:5173'}`,
            style: 'positive',
          },
        ],
      },
    }],
  };

  try {
    await post(process.env.TEAMS_ADMIN_WEBHOOK_URL, card);
    console.log(`[Teams] Approval request sent for ${issueKey}`);
  } catch (err) {
    console.error('[Teams] Failed to send approval request:', err.message);
  }
}

// ── Send to general webhook (escalations) ─────────────────────────────────────
async function sendEscalation({ issueKey, cluster, namespace, type, attempts, dashboardUrl }) {
  const card = {
    type:        'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type:    'AdaptiveCard',
        version: '1.4',
        body: [
          {
            type:   'TextBlock',
            text:   '🚨 Escalation — Manual Intervention Required',
            weight: 'Bolder',
            size:   'Large',
            color:  'Attention',
          },
          {
            type:  'TextBlock',
            text:  `The K8s AI Agent tried **${attempts} time${attempts !== 1 ? 's' : ''}** and could not fix this issue automatically. A team member must handle it manually.`,
            wrap:  true,
            color: 'Default',
            spacing: 'Small',
          },
          {
            type:  'FactSet',
            facts: [
              factRow('Issue Key',  issueKey),
              factRow('Cluster',    cluster),
              factRow('Namespace',  namespace),
              factRow('Issue Type', type),
              factRow('Attempts',   attempts),
            ],
          },
          {
            type:    'TextBlock',
            text:    'Please open the dashboard, go to **Escalations**, and claim this issue.',
            wrap:    true,
            size:    'Small',
            color:   'Warning',
            spacing: 'Small',
          },
        ],
        actions: [
          {
            type:  'Action.OpenUrl',
            title: '→ Open Escalations Dashboard',
            url:   `${dashboardUrl || 'http://localhost:5173'}`,
            style: 'destructive',
          },
        ],
      },
    }],
  };

  try {
    await post(process.env.TEAMS_WEBHOOK_URL, card);
    console.log(`[Teams] Escalation alert sent for ${issueKey}`);
  } catch (err) {
    console.error('[Teams] Failed to send escalation alert:', err.message);
  }
}

// ── Send to general webhook (generic alert) ───────────────────────────────────
async function sendAlert({ title, message, color = 'Default' }) {
  const card = {
    type:        'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type:    'AdaptiveCard',
        version: '1.4',
        body: [
          { type: 'TextBlock', text: title,   weight: 'Bolder', size: 'Medium', color },
          { type: 'TextBlock', text: message, wrap: true },
        ],
      },
    }],
  };

  try {
    await post(process.env.TEAMS_WEBHOOK_URL, card);
    console.log(`[Teams] Alert sent: ${title}`);
  } catch (err) {
    console.error('[Teams] Failed to send alert:', err.message);
  }
}

module.exports = { sendApprovalRequest, sendEscalation, sendAlert };
