// routes/notifications.js — In-app notification & Slack Webhook integration routes.

const router  = require("express").Router();
const auth    = require("../middleware/auth");
const { pool } = require("../config/db");
const crypto  = require("crypto");
const slackService = require("../services/slackService");

// ── GET /api/notifications — list for logged-in user ─────────────
router.get("/notifications", async (req, res) => {
  const username = req.user.username;
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const [rows] = await pool.query(
      `SELECT id, ext_id, type, title, body, link, is_read, change_request_id, created_at
       FROM notifications
       WHERE recipient = ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [username, limit]
    );
    const unread = rows.filter(r => !r.is_read).length;
    res.json({ ok: true, notifications: rows, unreadCount: unread });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/notifications/:id/read — mark one read ─────────────
router.post("/notifications/:id/read", async (req, res) => {
  const username = req.user.username;
  try {
    await pool.query(
      "UPDATE notifications SET is_read = 1 WHERE (id = ? OR ext_id = ?) AND recipient = ?",
      [req.params.id, req.params.id, username]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/notifications/read-all ─────────────────────────────
router.post("/notifications/read-all", async (req, res) => {
  const username = req.user.username;
  try {
    await pool.query(
      "UPDATE notifications SET is_read = 1 WHERE recipient = ? AND is_read = 0",
      [username]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/slack/config — Get Global & Channel Webhooks ─────────────
router.get("/slack/config", async (req, res) => {
  try {
    const config = await slackService.getSlackConfig();
    res.json({ ok: true, config });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/slack/config — Save Webhooks Configuration ────────────
router.post("/slack/config", auth.requireAuth, async (req, res) => {
  const { devWebhookUrl, opsWebhookUrl, enabled } = req.body;
  try {
    await slackService.saveSlackConfig({ devWebhookUrl, opsWebhookUrl, enabled });
    res.json({ ok: true, message: "Slack configuration saved successfully." });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/slack/test — Send Live Test Notification ───────────────
router.post("/slack/test", auth.requireAuth, async (req, res) => {
  const { targetChannel = 'both' } = req.body;
  try {
    const success = await slackService.sendSlackNotification({
      channelType: targetChannel,
      title: '🔔 Benevolate Platform Test Alert',
      message: `*Slack Integration Verified!* Hello *@${req.user.username}*, your Slack webhooks are connected and active.`,
      fields: [
        { title: "Status", value: "Active & Connected" },
        { title: "Verified By", value: `@${req.user.username}` },
        { title: "Target Channel", value: targetChannel === 'dev' ? 'Developer Channel' : targetChannel === 'ops' ? 'DevOps/Admin Channel' : 'Both Channels' }
      ],
      color: '#10b981'
    });
    if (success) {
      res.json({ ok: true, message: "Live test notification sent to Slack!" });
    } else {
      res.status(400).json({ ok: false, error: "Failed to dispatch test notification. Please verify your Webhook URLs." });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * Utility: create a notification for a recipient.
 */
async function createNotification({ recipient, type, title, body, link, changeRequestId }) {
  try {
    const extId = `notif-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await pool.query(
      `INSERT INTO notifications (ext_id, recipient, type, title, body, link, is_read, change_request_id)
       VALUES (?,?,?,?,?,?,0,?)`,
      [extId, recipient, type, title, body || null, link || null, changeRequestId || null]
    );
  } catch (err) {
    console.error("Failed to create notification:", err.message);
  }
}

module.exports = router;
module.exports.createNotification = createNotification;
