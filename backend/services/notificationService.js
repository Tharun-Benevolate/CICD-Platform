const { pool } = require("../config/db");
const crypto = require("crypto");

/**
 * Service for dispatching notifications (In-app, Slack, Email)
 */
class NotificationService {
  /**
   * Send a notification to a specific user
   * @param {string} recipient - Username of the recipient
   * @param {string} type - Event type (e.g., 'cr_merged', 'cr_submitted')
   * @param {string} title - Short title of the notification
   * @param {string} body - Longer description or context
   * @param {string} link - URL to jump to (optional)
   * @param {string} crId - Related change request ID (optional)
   */
  async notify(recipient, type, title, body, link, crId) {
    // 1. Fetch user notification settings
    const [settings] = await pool.query(
      "SELECT * FROM notification_settings WHERE username = ?",
      [recipient]
    );
    const prefs = settings[0] || { in_app: 1, email: 0, slack: 0 }; // default

    // 2. In-App Notification (Always stored if enabled)
    if (prefs.in_app) {
      const extId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO notifications (ext_id, recipient, type, title, body, link, change_request_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [extId, recipient, type, title, body, link || null, crId || null]
      );
    }

    // 3. Email Integration Structure
    if (prefs.email) {
      this.sendEmailAlert(recipient, type, title, body, link);
    }

    // 4. Slack Integration Structure
    if (prefs.slack && prefs.slack_webhook_url) {
      this.sendSlackAlert(prefs.slack_webhook_url, type, title, body, link);
    }
  }

  /**
   * Stub for sending an email alert via SMTP / SendGrid
   */
  sendEmailAlert(recipient, type, title, body, link) {
    console.log(`[EMAIL DISPATCH] To: ${recipient}`);
    console.log(`Subject: [Benevolate] ${title}`);
    console.log(`Body: ${body}\nLink: ${link || "N/A"}\n`);
    // TODO: Integrate actual SMTP transport here
  }

  /**
   * Stub for sending a Slack webhook alert
   */
  async sendSlackAlert(webhookUrl, type, title, body, link) {
    console.log(`[SLACK DISPATCH] Webhook: ${webhookUrl}`);
    const payload = {
      text: `*${title}*\n${body}\n${link ? `<${link}|View Details>` : ""}`,
      mrkdwn: true
    };
    
    try {
      /*
      // Real implementation would uncomment this:
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      */
      console.log(`[SLACK DISPATCH SUCCESS] Payload:`, payload);
    } catch (err) {
      console.error(`[SLACK DISPATCH FAILED]`, err.message);
    }
  }
}

module.exports = new NotificationService();
