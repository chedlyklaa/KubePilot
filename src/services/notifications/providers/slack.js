'use strict';

const https = require('https');

function _post(webhookUrl, body) {
  return new Promise((resolve, reject) => {
    const data   = JSON.stringify(body);
    const parsed = new URL(webhookUrl);
    const opts   = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = https.request(opts, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end',  () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`Slack HTTP ${res.statusCode}: ${body}`));
      });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

const SEVERITY_EMOJI = { CRITICAL: '🚨', ERROR: '❌', WARNING: '⚠️', INFO: 'ℹ️' };
const SEVERITY_COLOR = { CRITICAL: '#dc2626', ERROR: '#ea580c', WARNING: '#d97706', INFO: '#2563eb' };

async function send(notification, config) {
  if (!config?.webhookUrl) throw new Error('Slack webhook URL not configured');
  const { severity = 'INFO', category, title, message, namespace, source } = notification;

  const fields = [];
  if (category)  fields.push({ type: 'mrkdwn', text: `*Category*\n${category}` });
  if (namespace) fields.push({ type: 'mrkdwn', text: `*Namespace*\n${namespace}` });
  if (source)    fields.push({ type: 'mrkdwn', text: `*Source*\n${source}` });

  const payload = {
    attachments: [{
      color:  SEVERITY_COLOR[severity] ?? '#6366f1',
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: `${SEVERITY_EMOJI[severity] ?? '🔔'} ${title}`, emoji: true } },
        { type: 'section', text: { type: 'mrkdwn', text: message } },
        ...(fields.length ? [{ type: 'section', fields }] : []),
        { type: 'context', elements: [{ type: 'mrkdwn', text: `KubePilot · ${new Date().toLocaleString('en-GB', { hour12: false })}` }] },
      ],
    }],
  };

  await _post(config.webhookUrl, payload);
}

async function testConnection(config) {
  if (!config?.webhookUrl) throw new Error('Webhook URL is required');
  await _post(config.webhookUrl, {
    text: '✅ *KubePilot* — Test connection successful',
  });
}

module.exports = { send, testConnection };
