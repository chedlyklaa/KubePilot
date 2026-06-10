'use strict';

const nodemailer = require('nodemailer');

const SEVERITY_COLOR = { CRITICAL: '#dc2626', ERROR: '#ea580c', WARNING: '#d97706', INFO: '#2563eb' };
const SEVERITY_LABEL = { CRITICAL: '🚨 CRITICAL', ERROR: '❌ ERROR', WARNING: '⚠️ WARNING', INFO: 'ℹ️ INFO' };

function _buildHtml(notification) {
  const { severity = 'INFO', category, title, message, namespace, source } = notification;
  const color        = SEVERITY_COLOR[severity] ?? '#6366f1';
  const label        = SEVERITY_LABEL[severity] ?? severity;
  const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:5173';
  const rows  = [
    ['Severity', label],
    ['Category', category ?? '—'],
    ['Time',     new Date().toLocaleString('en-GB', { hour12: false })],
    ...(namespace ? [['Namespace', namespace]] : []),
    ...(source    ? [['Source',    source]]    : []),
  ];

  return `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#f8fafc;padding:24px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;
            box-shadow:0 2px 8px rgba(0,0,0,.08)">
  <div style="background:#1e1b4b;padding:20px 24px">
    <div style="color:#a5b4fc;font-size:12px;font-weight:700;letter-spacing:.08em">⎈ KUBEPILOT ALERT</div>
    <div style="color:#fff;font-size:20px;font-weight:700;margin-top:4px">${title}</div>
  </div>
  <div style="border-left:4px solid ${color};margin:20px 24px;padding:12px 14px;
              background:#f8fafc;border-radius:0 6px 6px 0">
    <div style="color:#374151;font-size:14px;line-height:1.6">${message}</div>
  </div>
  <table style="width:100%;border-collapse:collapse;margin:0 0 20px">
    ${rows.map(([k, v]) => `<tr><td style="padding:7px 24px;font-size:12px;font-weight:600;color:#6b7280;
      width:120px">${k}</td><td style="padding:7px 24px;font-size:13px;color:#111827">${v}</td></tr>`).join('')}
  </table>
  <div style="padding:4px 24px 24px;text-align:center">
    <a href="${dashboardUrl}" target="_blank"
       style="display:inline-block;padding:11px 28px;background:#4f46e5;color:#fff;
              font-size:14px;font-weight:600;text-decoration:none;border-radius:8px;
              letter-spacing:.01em">
      Open Dashboard →
    </a>
  </div>
  <div style="border-top:1px solid #e5e7eb;padding:14px 24px;font-size:11px;color:#9ca3af">
    KubePilot · Autonomous Kubernetes Management
  </div>
</div></body></html>`;
}

async function send(notification, config) {
  if (!config?.smtpHost || !config?.smtpUser || !config?.smtpPass) throw new Error('Email SMTP not configured');
  const recipients = config.recipients || config.smtpUser;
  const port       = parseInt(config.smtpPort || '587', 10);
  const transport  = nodemailer.createTransport({
    host: config.smtpHost, port, secure: port === 465,
    auth: { user: config.smtpUser, pass: config.smtpPass },
  });

  await transport.sendMail({
    from:    config.smtpFrom || `"KubePilot" <${config.smtpUser}>`,
    to:      Array.isArray(recipients) ? recipients.join(', ') : recipients,
    subject: `[KubePilot] ${notification.severity ?? 'INFO'}: ${notification.title}`,
    html:    _buildHtml(notification),
    text:    `${notification.title}\n\n${notification.message}\n\nSeverity: ${notification.severity}\nCategory: ${notification.category}`,
  });
}

async function testConnection(config) {
  if (!config?.smtpHost || !config?.smtpUser || !config?.smtpPass) throw new Error('SMTP credentials required');
  const port      = parseInt(config.smtpPort || '587', 10);
  const transport = nodemailer.createTransport({
    host: config.smtpHost, port, secure: port === 465,
    auth: { user: config.smtpUser, pass: config.smtpPass },
  });
  await transport.verify();
}

module.exports = { send, testConnection };
