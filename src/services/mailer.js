'use strict';

const nodemailer = require('nodemailer');

const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:5173';

// Admin-configured email channel (Notification Settings UI) takes priority;
// EMAIL_* env vars are the fallback for deployments that haven't configured it there yet.
async function _getSmtpConfig() {
  try {
    const { NotificationChannelConfig } = require('../db/models');
    const { decrypt } = require('./notifications/crypto');
    const doc = await NotificationChannelConfig.findOne({ type: 'email', enabled: true }).lean();
    if (doc?.config) {
      const config = decrypt(doc.config);
      if (config.smtpHost && config.smtpUser && config.smtpPass) return config;
    }
  } catch { /* fall through to env vars below */ }

  if (process.env.EMAIL_HOST && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    return {
      smtpHost: process.env.EMAIL_HOST,
      smtpPort: process.env.EMAIL_PORT,
      smtpUser: process.env.EMAIL_USER,
      smtpPass: process.env.EMAIL_PASS,
      smtpFrom: process.env.EMAIL_FROM,
    };
  }

  throw Object.assign(
    new Error('Email is not configured on this server — set it up in Notification Settings or EMAIL_* env vars'),
    { status: 503 }
  );
}

// Whether either config source (DB channel or env vars) is usable right now.
async function isConfigured() {
  try {
    await _getSmtpConfig();
    return true;
  } catch {
    return false;
  }
}

async function _send({ to, subject, html, text }) {
  const config = await _getSmtpConfig();
  const port   = parseInt(config.smtpPort || '587', 10);
  const transport = nodemailer.createTransport({
    host: config.smtpHost, port, secure: port === 465,
    auth: { user: config.smtpUser, pass: config.smtpPass },
  });
  await transport.sendMail({
    from:    config.smtpFrom || `"KubePilot" <${config.smtpUser}>`,
    to, subject, html, text,
  });
}

function _baseLayout(header, body) {
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#f8fafc;padding:24px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;
            box-shadow:0 2px 8px rgba(0,0,0,.08)">
  <div style="background:#1e1b4b;padding:20px 24px">
    <div style="color:#a5b4fc;font-size:12px;font-weight:700;letter-spacing:.08em">⎈ KUBEPILOT</div>
    <div style="color:#fff;font-size:20px;font-weight:700;margin-top:4px">${header}</div>
  </div>
  ${body}
  <div style="border-top:1px solid #e5e7eb;padding:14px 24px;font-size:11px;color:#9ca3af">
    KubePilot · Autonomous Kubernetes Management
  </div>
</div></body></html>`;
}

async function sendWelcomeEmail(email, name, password) {
  const body = `
  <div style="padding:24px">
    <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 12px">Hi ${name},</p>
    <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 16px">Your KubePilot account has been created. Use the credentials below to sign in:</p>
    <div style="background:#f1f5f9;border-radius:8px;padding:16px 20px;margin:0 0 16px">
      <div style="font-size:12px;color:#6b7280;margin-bottom:3px;text-transform:uppercase;letter-spacing:.05em">Email</div>
      <div style="font-size:15px;font-weight:600;color:#111827;font-family:monospace">${email}</div>
      <div style="font-size:12px;color:#6b7280;margin:12px 0 3px;text-transform:uppercase;letter-spacing:.05em">Password</div>
      <div style="font-size:15px;font-weight:600;color:#111827;font-family:monospace">${password}</div>
    </div>
    <p style="color:#9ca3af;font-size:12px;margin:0">Change your password after first login for security.</p>
  </div>
  <div style="padding:0 24px 24px;text-align:center">
    <a href="${DASHBOARD_URL}" target="_blank"
       style="display:inline-block;padding:11px 28px;background:#4f46e5;color:#fff;
              font-size:14px;font-weight:600;text-decoration:none;border-radius:8px">
      Sign in to KubePilot →
    </a>
  </div>`;

  await _send({
    to:      email,
    subject: '[KubePilot] Your account has been created',
    html:    _baseLayout('Welcome to KubePilot!', body),
    text:    `Hi ${name},\n\nYour KubePilot account is ready.\n\nEmail: ${email}\nPassword: ${password}\n\nSign in at: ${DASHBOARD_URL}\n\nChange your password after first login.`,
  });
}

async function sendPasswordResetEmail(email, token) {
  const resetUrl = `${DASHBOARD_URL}?reset=${token}`;
  const body = `
  <div style="padding:24px">
    <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 12px">We received a request to reset your KubePilot password.</p>
    <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 16px">Click the button below — this link expires in <strong>15 minutes</strong>.</p>
    <p style="color:#9ca3af;font-size:12px;margin:0">If you didn't request a reset, you can safely ignore this email.</p>
  </div>
  <div style="padding:0 24px 24px;text-align:center">
    <a href="${resetUrl}" target="_blank"
       style="display:inline-block;padding:11px 28px;background:#4f46e5;color:#fff;
              font-size:14px;font-weight:600;text-decoration:none;border-radius:8px">
      Reset Password →
    </a>
  </div>`;

  await _send({
    to:      email,
    subject: '[KubePilot] Reset your password',
    html:    _baseLayout('Reset your password', body),
    text:    `Someone requested a password reset for your KubePilot account.\n\nReset link (expires in 15 min):\n${resetUrl}\n\nIf this wasn't you, ignore this email.`,
  });
}

async function sendOtp(email, name, otp) {
  const body = `
  <div style="padding:24px">
    <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 12px">Hi ${name},</p>
    <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 16px">Someone requested a password change for your KubePilot account. Use the code below to confirm:</p>
    <div style="font-size:34px;font-weight:800;letter-spacing:9px;text-align:center;
                padding:20px 16px;background:#f1f5f9;border-radius:8px;margin:0 0 16px;color:#4f46e5">
      ${otp}
    </div>
    <p style="color:#9ca3af;font-size:12px;margin:0">This code expires in <strong>10 minutes</strong>. If you did not request this, ignore this email — your password will not change.</p>
  </div>
  <div style="padding:0 24px 24px;text-align:center">
    <a href="${DASHBOARD_URL}" target="_blank"
       style="display:inline-block;padding:11px 28px;background:#4f46e5;color:#fff;
              font-size:14px;font-weight:600;text-decoration:none;border-radius:8px">
      Open Dashboard →
    </a>
  </div>`;

  await _send({
    to:      email,
    subject: 'KubePilot — Password Change Verification Code',
    html:    _baseLayout('Security Verification', body),
    text:    `Hi ${name},\n\nYour KubePilot password change code is: ${otp}\n\nExpires in 10 minutes.\n\nIf you did not request this, ignore this email.`,
  });
}

module.exports = { isConfigured, sendWelcomeEmail, sendPasswordResetEmail, sendOtp };
