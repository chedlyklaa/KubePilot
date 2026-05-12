// src/notifications/teams.js

const axios = require('axios');

/**
 * Microsoft Teams Notification Service
 *
 * Sends:
 * - alerts
 * - escalation messages
 * - approval requests
 * - critical incident notifications
 */

class TeamsNotifier {
  constructor() {
    this.webhookUrl =
      process.env.TEAMS_WEBHOOK_URL;
  }

  /**
   * Send generic Teams message
   */
  async sendMessage(title, message, color = '0076D7') {
    try {
      const payload = {
        '@type': 'MessageCard',

        '@context': 'https://schema.org/extensions',

        themeColor: color,

        summary: title,

        sections: [
          {
            activityTitle: title,

            text: message,
          },
        ],
      };

      await axios.post(this.webhookUrl, payload);

      console.log(
        `[TEAMS] Notification sent: ${title}`
      );
    } catch (error) {
      console.error(
        '[TEAMS] Failed to send notification:',
        error.message
      );
    }
  }

  /**
   * Send risk escalation
   */
  async sendRiskAlert(event) {
    const title =
      '⚠️ High-Risk Kubernetes Action Detected';

    const message = `
Cluster: ${event.cluster}

Action: ${event.action}

Risk Score: ${event.riskScore}

Decision: ${event.decision}

Reason: ${event.reason}
`;

    await this.sendMessage(title, message, 'FFAA00');
  }

  /**
   * Send blocked dangerous action
   */
  async sendBlockedAction(event) {
    const title =
      '🛑 Dangerous Action Blocked';

    const message = `
Cluster: ${event.cluster}

Action: ${event.action}

Risk Score: ${event.riskScore}

Reason: ${event.reason}

Human approval required.
`;

    await this.sendMessage(title, message, 'FF0000');
  }

  /**
   * Send successful remediation
   */
  async sendSuccess(event) {
    const title =
      '✅ Autonomous Remediation Successful';

    const message = `
Cluster: ${event.cluster}

Action: ${event.action}

Issue: ${event.issue}

Risk Score: ${event.riskScore}
`;

    await this.sendMessage(title, message, '00CC66');
  }

  /**
   * Send critical incident
   */
  async sendCriticalIncident(event) {
    const title =
      '🚨 Critical Kubernetes Incident';

    const message = `
Cluster: ${event.cluster}

Issue: ${event.issue}

Severity: ${event.severity}

Immediate attention required.
`;

    await this.sendMessage(title, message, 'CC0000');
  }
}

module.exports = new TeamsNotifier();