// src/notifications/email.js
// Sends transactional emails via SMTP (nodemailer).
// Configure via .env:
//   EMAIL_HOST   — SMTP server (e.g. smtp.gmail.com)
//   EMAIL_PORT   — SMTP port (587 for TLS, 465 for SSL)
//   EMAIL_USER   — SMTP username / sender address
//   EMAIL_PASS   — SMTP password or app-password
//   EMAIL_FROM   — optional "From" display name + address

const nodemailer = require('nodemailer');

function isConfigured() {
  return !!(process.env.EMAIL_HOST && process.env.EMAIL_USER && process.env.EMAIL_PASS);
}

function createTransport() {
  if (!isConfigured()) return null;
  const port = parseInt(process.env.EMAIL_PORT || '587', 10);
  return nodemailer.createTransport({
    host:   process.env.EMAIL_HOST,
    port,
    secure: port === 465,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
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
      </div>`,
    text: `Hi ${name},\n\nYour KubePilot password change code is: ${otp}\n\nExpires in 10 minutes.`,
  });
}

module.exports = { isConfigured, sendOtp };
