'use strict';

const https = require('https');

function _post(webhookUrl, body) {
  return new Promise((resolve, reject) => {
    const data    = JSON.stringify(body);
    const parsed  = new URL(webhookUrl);
    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = https.request(options, res => {
      res.resume();
      res.statusCode >= 200 && res.statusCode < 300 ? resolve() : reject(new Error(`HTTP ${res.statusCode}`));
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

function _severityColor(severity) {
  return { CRITICAL: 'Attention', ERROR: 'Attention', WARNING: 'Warning', INFO: 'Good' }[severity] ?? 'Default';
}

function _buildCard(notification) {
  const { severity, category, title, message, namespace, source } = notification;
  const facts = [
    { title: 'Time',     value: new Date().toLocaleString('en-GB', { hour12: false }) },
    { title: 'Severity', value: severity ?? 'INFO' },
    { title: 'Category', value: category ?? '—' },
  ];
  if (namespace) facts.push({ title: 'Namespace', value: namespace });
  if (source)    facts.push({ title: 'Source',    value: source });

  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard', version: '1.4',
        body: [
          { type: 'TextBlock', text: `🔔 ${title}`, weight: 'Bolder', size: 'Large', color: _severityColor(severity) },
          { type: 'TextBlock', text: message, wrap: true, spacing: 'Small' },
          { type: 'FactSet',   facts },
        ],
        actions: [{
          type: 'Action.OpenUrl',
          title: '→ Open KubePilot Dashboard',
          url:   process.env.DASHBOARD_URL || 'http://localhost:5173',
          style: 'positive',
        }],
      },
    }],
  };
}

async function send(notification, config) {
  if (!config?.webhookUrl) throw new Error('Teams webhook URL not configured');
  await _post(config.webhookUrl, _buildCard(notification));
}

async function testConnection(config) {
  if (!config?.webhookUrl) throw new Error('Webhook URL is required');
  const card = {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard', version: '1.4',
        body: [{ type: 'TextBlock', text: '✅ KubePilot — Test connection successful', weight: 'Bolder', color: 'Good' }],
      },
    }],
  };
  await _post(config.webhookUrl, card);
}

module.exports = { send, testConnection };
