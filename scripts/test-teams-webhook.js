// scripts/test-teams-webhook.js
// Quick test for a Teams Incoming Webhook URL.
// Usage: node scripts/test-teams-webhook.js

const https = require('https');

const WEBHOOK_URL = 'https://adbi00.webhook.office.com/webhookb2/f8a5b5c9-6792-412d-a63c-b34173fa7c27@d98bd02c-ad70-4803-8a51-ab4c7d1a77e9/IncomingWebhook/d10a1f4f792f4181a9d1bade6b3d6c64/1eb71807-583a-4595-9803-13a971415052/V21ZOmOW95FU614iv_xYVDoW5pZv35Sq2dES1tedb7sw01';

const payload = {
  type: 'message',
  attachments: [{
    contentType: 'application/vnd.microsoft.card.adaptive',
    content: {
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      type: 'AdaptiveCard',
      version: '1.4',
      body: [
        {
          type: 'TextBlock',
          text: '✅ KubePilot — Webhook Test',
          weight: 'Bolder',
          size: 'Large',
          color: 'Good',
        },
        {
          type: 'TextBlock',
          text: `If you see this card in Teams, the webhook is working correctly.\nTimestamp: ${new Date().toISOString()}`,
          wrap: true,
        },
      ],
    },
  }],
};

function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const { hostname, pathname, search } = new URL(url);
    const req = https.request({
      hostname,
      path:    pathname + (search ?? ''),
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  console.log('Sending test message to Teams...');
  console.log('URL:', WEBHOOK_URL);
  try {
    const { status, body } = await post(WEBHOOK_URL, payload);
    if (status >= 200 && status < 300) {
      console.log(`\n✅  SUCCESS  (HTTP ${status})`);
      console.log('   Check your Teams channel — you should see the test card.');
    } else {
      console.log(`\n❌  FAILED  (HTTP ${status})`);
      console.log('   Response:', body || '(empty)');
      if (status === 403) {
        console.log('\n   → This webhook.office.com URL has been retired by Microsoft.');
        console.log('   → Create a new one via: Teams channel → ··· → Workflows');
        console.log('   → Template: "Post to a channel when a webhook request is received"');
      }
    }
  } catch (err) {
    console.log('\n❌  ERROR:', err.message);
  }
})();
