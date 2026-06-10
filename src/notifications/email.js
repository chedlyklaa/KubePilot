// src/notifications/email.js
// Sends transactional emails via SMTP (nodemailer).
// SMTP config is loaded from the database (NotificationChannelConfig) by callers.
// Falls back to env vars for legacy paths (OTP).
//   EMAIL_HOST   — SMTP server (e.g. smtp.gmail.com)
//   EMAIL_PORT   — SMTP port (587 for TLS, 465 for SSL)
//   EMAIL_USER   — SMTP username / sender address
//   EMAIL_PASS   — SMTP password or app-password
//   EMAIL_FROM   — optional "From" display name + address

const nodemailer = require('nodemailer');

function isConfigured() {
  return !!(process.env.EMAIL_HOST && process.env.EMAIL_USER && process.env.EMAIL_PASS);
}

// Accepts an optional DB-sourced config object { smtpHost, smtpPort, smtpUser, smtpPass, smtpFrom }.
// Falls back to environment variables when no config is supplied.
function createTransport(cfg = null) {
  if (cfg) {
    if (!cfg.smtpHost || !cfg.smtpUser || !cfg.smtpPass) return null;
    const port = parseInt(cfg.smtpPort || '587', 10);
    return nodemailer.createTransport({
      host:   cfg.smtpHost,
      port,
      secure: port === 465,
      auth:   { user: cfg.smtpUser, pass: cfg.smtpPass },
    });
  }
  if (!isConfigured()) return null;
  const port = parseInt(process.env.EMAIL_PORT || '587', 10);
  return nodemailer.createTransport({
    host:   process.env.EMAIL_HOST,
    port,
    secure: port === 465,
    auth:   { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });
}

async function sendOtp(toEmail, name, otp) {
  const transport = createTransport();
  if (!transport) throw new Error('Email service is not configured on this server');

  await transport.sendMail({
    from:    process.env.EMAIL_FROM || `"KubePilot" <${process.env.EMAIL_USER}>`,
    to:      toEmail,
    subject: 'KubePilot — Password Change Verification Code',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;
                  background:#1a1b26;color:#e2e8f0;border-radius:12px;">
        <h2 style="margin:0 0 4px;color:#6366f1;font-size:22px;">⎈ KubePilot</h2>
        <p style="margin:0 0 24px;color:#94a3b8;font-size:13px;">Security Verification</p>
        <p>Hi <strong>${name}</strong>,</p>
        <p>Someone requested a password change for your KubePilot account.
           Use the code below to confirm:</p>
        <div style="font-size:38px;font-weight:800;letter-spacing:10px;text-align:center;
                    padding:22px 16px;background:#252636;border-radius:10px;
                    margin:24px 0;color:#6366f1;border:1px solid #363750;">
          ${otp}
        </div>
        <p style="color:#94a3b8;font-size:13px;">
          This code expires in <strong>10 minutes</strong>.<br>
          If you did not request this, ignore this email — your password will not change.
        </p>
        <div style="text-align:center;margin-top:28px">
          <a href="${process.env.DASHBOARD_URL || 'http://localhost:5173'}" target="_blank"
             style="display:inline-block;padding:11px 28px;background:#6366f1;color:#fff;
                    font-size:14px;font-weight:600;text-decoration:none;border-radius:8px">
            Open Dashboard →
          </a>
        </div>
      </div>`,
    text: `Hi ${name},\n\nYour KubePilot password change code is: ${otp}\n\nExpires in 10 minutes.`,
  });
}

// smtpConfig — optional DB-sourced SMTP config; if omitted falls back to env vars.
async function sendAssignment(toEmail, assigneeName, { issueKey, assignedBy }, smtpConfig = null) {
  const transport = createTransport(smtpConfig);
  if (!transport) throw new Error('Email service is not configured on this server');

  const fromAddr = smtpConfig?.smtpFrom
    || process.env.EMAIL_FROM
    || `"KubePilot" <${smtpConfig?.smtpUser || process.env.EMAIL_USER}>`;
  const dashUrl = process.env.DASHBOARD_URL || 'http://localhost:5173';

  await transport.sendMail({
    from:    fromAddr,
    to:      toEmail,
    subject: `KubePilot — Escalation assigned to you: ${issueKey}`,
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;
                  background:#1a1b26;color:#e2e8f0;border-radius:12px;">
        <h2 style="margin:0 0 4px;color:#6366f1;font-size:22px;">⎈ KubePilot</h2>
        <p style="margin:0 0 24px;color:#94a3b8;font-size:13px;">Escalation Assignment</p>

        <p>Hi <strong>${assigneeName}</strong>,</p>
        <p>You have been assigned to handle the following escalated incident:</p>

        <div style="padding:16px 20px;background:#252636;border-radius:10px;
                    border-left:4px solid #f59e0b;margin:20px 0;">
          <div style="font-size:12px;color:#94a3b8;margin-bottom:4px;text-transform:uppercase;
                      letter-spacing:.06em;">Incident</div>
          <div style="font-size:16px;font-weight:700;color:#fbbf24;word-break:break-all;">
            ${issueKey}
          </div>
          ${assignedBy ? `
          <div style="margin-top:10px;font-size:13px;color:#94a3b8;">
            Assigned by <strong style="color:#e2e8f0">${assignedBy}</strong>
          </div>` : ''}
        </div>

        <p style="color:#94a3b8;font-size:13px;">
          Log in to the dashboard, go to <strong>Escalations</strong>, and acknowledge this incident to begin.
        </p>

        <div style="text-align:center;margin-top:28px">
          <a href="${dashUrl}" target="_blank"
             style="display:inline-block;padding:11px 28px;background:#6366f1;color:#fff;
                    font-size:14px;font-weight:600;text-decoration:none;border-radius:8px">
            Open Dashboard →
          </a>
        </div>
      </div>`,
    text:
      `Hi ${assigneeName},\n\n` +
      `You have been assigned to: ${issueKey}\n` +
      (assignedBy ? `Assigned by: ${assignedBy}\n` : '') +
      `\nLog in to the KubePilot dashboard to manage this incident:\n${dashUrl}`,
  });
}

module.exports = { isConfigured, sendOtp, sendAssignment };
