'use strict';

const crypto = require('crypto');

// NOTIFICATION_SECRET protects Slack/Teams/SMTP credentials stored in NotificationChannelConfig.
// It must be set explicitly — falling back to a fixed value would mean every deployment
// that forgets to set it encrypts its channel secrets with the same publicly-known key.
if (!process.env.NOTIFICATION_SECRET) {
  throw new Error(
    'NOTIFICATION_SECRET environment variable is required (protects encrypted Slack/Teams/SMTP ' +
    'channel credentials). Set it to a long random value, e.g.: openssl rand -hex 32'
  );
}

const KEY = crypto.createHash('sha256')
  .update(process.env.NOTIFICATION_SECRET)
  .digest(); // 32 bytes for AES-256

function encrypt(obj) {
  const text   = JSON.stringify(obj);
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc    = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return [iv.toString('hex'), tag.toString('hex'), enc.toString('hex')].join(':');
}

function decrypt(str) {
  if (!str) return {};
  try {
    const [ivHex, tagHex, encHex] = str.split(':');
    const iv       = Buffer.from(ivHex,  'hex');
    const tag      = Buffer.from(tagHex, 'hex');
    const enc      = Buffer.from(encHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return JSON.parse(dec.toString('utf8'));
  } catch {
    return {};
  }
}

// Return a copy of config with secret fields replaced by '••••••••'
function mask(config) {
  const SECRET_FIELDS = ['webhookUrl', 'password', 'token', 'botToken', 'apiKey', 'smtpPass'];
  return Object.fromEntries(
    Object.entries(config).map(([k, v]) =>
      SECRET_FIELDS.includes(k) && v ? [k, '••••••••'] : [k, v]
    )
  );
}

module.exports = { encrypt, decrypt, mask };
