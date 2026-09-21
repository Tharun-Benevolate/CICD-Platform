// routes/notifications.js — In-app notification & Slack Webhook integration routes.

const router  = require("express").Router();
const auth    = require("../middleware/auth");
const { pool } = require("../config/db");
const crypto  = require("crypto");
const slackService = require("../services/slackService");

// ── Helper: Check and inject OAuth warning notifications ───────────
async function checkAndInjectOAuthWarnings(username) {
  if (!username) return { githubConnected: false, slackConnected: false };
  try {
    const [rows] = await pool.query(
      "SELECT LOWER(provider) AS provider FROM repo_credentials WHERE LOWER(username) = ?",
      [username.toLowerCase().trim()]
    );
    const providers = new Set(rows.map(r => r.provider));
    const githubConnected = providers.has("github");
    const slackConnected = providers.has("slack");

    if (!githubConnected) {
      // Prevent duplicate generation: do not insert if a notification already exists, regardless of is_read state
      const [existing] = await pool.query(
        "SELECT id FROM notifications WHERE recipient = ? AND type = 'system' AND title LIKE '%GitHub%' LIMIT 1",
        [username]
      );
      if (existing.length === 0) {
        const extId = crypto.randomUUID();
        await pool.query(
          `INSERT INTO notifications (ext_id, recipient, type, title, body, link, is_read)
           VALUES (?, ?, 'system', 'GitHub Account Not Connected', 'Link your GitHub account in Settings > Integrations to push commits, view branches, and submit Change Requests.', '/settings/integrations', 0)`,
          [extId, username]
        ).catch(err => console.error("[OAuth Warning GitHub Insert Error]:", err.message));
      }
    } else {
      // Clear warning once connected
      await pool.query(
        "DELETE FROM notifications WHERE recipient = ? AND type = 'system' AND title LIKE '%GitHub%'",
        [username]
      ).catch(() => {});
    }

    if (!slackConnected) {
      // Prevent duplicate generation: do not insert if a notification already exists, regardless of is_read state
      const [existing] = await pool.query(
        "SELECT id FROM notifications WHERE recipient = ? AND type = 'system' AND title LIKE '%Slack%' LIMIT 1",
        [username]
      );
      if (existing.length === 0) {
        const extId = crypto.randomUUID();
        await pool.query(
          `INSERT INTO notifications (ext_id, recipient, type, title, body, link, is_read)
           VALUES (?, ?, 'system', 'Slack Workspace Not Connected', 'Connect your Slack account in Settings > Integrations to receive live deployment and review alerts.', '/settings/integrations', 0)`,
          [extId, username]
        ).catch(err => console.error("[OAuth Warning Slack Insert Error]:", err.message));
      }
    } else {
      // Clear warning once connected
      await pool.query(
        "DELETE FROM notifications WHERE recipient = ? AND type = 'system' AND title LIKE '%Slack%'",
        [username]
      ).catch(() => {});
    }

    return { githubConnected, slackConnected };
  } catch (err) {
    console.error("[checkAndInjectOAuthWarnings]", err.message);
    return { githubConnected: false, slackConnected: false };
  }
}

// ── GET /api/notifications/settings — Get user notification preferences ──
router.get("/notifications/settings", auth.requireAuth, async (req, res) => {
  const username = req.user ? req.user.username : auth.getLoggedInUser(req);
  if (!username) return res.status(401).json({ ok: false, error: "Unauthorized" });

  try {
    const [rows] = await pool.query(
      "SELECT in_app, email, slack FROM notification_settings WHERE username = ?",
      [username]
    );
    if (rows.length > 0) {
      res.json({
        ok: true,
        settings: {
          inApp: Boolean(rows[0].in_app),
          email: Boolean(rows[0].email),
          slack: Boolean(rows[0].slack)
        }
      });
    } else {
      res.json({
        ok: true,
        settings: {
          inApp: true,
          email: false,
          slack: false
        }
      });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── PUT /api/notifications/settings — Update user notification preferences ──
router.put("/notifications/settings", auth.requireAuth, async (req, res) => {
  const username = req.user ? req.user.username : auth.getLoggedInUser(req);
  if (!username) return res.status(401).json({ ok: false, error: "Unauthorized" });

  const { inApp, email, slack } = req.body;
  try {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO notification_settings (id, username, in_app, email, slack)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         in_app = VALUES(in_app),
         email = VALUES(email),
         slack = VALUES(slack)`,
      [id, username, inApp ? 1 : 0, email ? 1 : 0, slack ? 1 : 0]
    );
    res.json({
      ok: true,
      message: "Notification preferences saved successfully.",
      settings: {
        inApp: Boolean(inApp),
        email: Boolean(email),
        slack: Boolean(slack)
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/notifications — list for logged-in user ─────────────
router.get("/notifications", async (req, res) => {
  const username = req.user ? req.user.username : auth.getLoggedInUser(req);
  if (!username) return res.status(401).json({ ok: false, error: "Unauthorized" });

  try {
    const oauthStatus = await checkAndInjectOAuthWarnings(username);
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
    res.json({ ok: true, notifications: rows, unreadCount: unread, oauthStatus });
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
  const {
    devWebhookUrl,
    opsWebhookUrl,
    opsChannelId,
    opsChannelName,
    securityChannelId,
    securityChannelName,
    enabled
  } = req.body;
  try {
    await slackService.saveSlackConfig({
      devWebhookUrl,
      opsWebhookUrl,
      opsChannelId,
      opsChannelName,
      securityChannelId,
      securityChannelName,
      enabled
    });
    res.json({ ok: true, message: "Slack configuration saved successfully." });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/slack/provision-system-channels ───────────────────────────
router.post("/slack/provision-system-channels", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const result = await slackService.ensureSystemSlackChannels();
    if (result) {
      res.json({ ok: true, message: "System Slack channels checked and provisioned.", channels: result });
    } else {
      res.status(400).json({ ok: false, error: "Unable to provision system Slack channels. Please ensure a Slack account or Bot Token is connected." });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/slack/test-security ───────────────────────────────────────
router.post("/slack/test-security", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const success = await slackService.sendSecurityAlert({
      actor: req.user.username,
      action: "Access Control Violation (403 Forbidden)",
      ip: req.ip || "127.0.0.1",
      endpoint: "/api/secrets/prod-database-credentials",
      method: "DELETE",
      actionTaken: "Blocked (403 Forbidden)",
      details: "Simulated security breach test: Actor attempted restricted write access to production database credentials without proper IAM elevation.",
      severity: "critical"
    });
    if (success) {
      res.json({ ok: true, message: "Live security alert dispatched to #integrate-security-alerts!" });
    } else {
      res.status(400).json({ ok: false, error: "Failed to dispatch security alert. Please ensure Slack integration is configured." });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/slack/test-ops ───────────────────────────────────────────
router.post("/slack/test-ops", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const success = await slackService.sendOpsAlert({
      project: "deploy-watch",
      environment: "production",
      title: "Infrastructure Setup Complete: ECS Fargate Cluster",
      message: `Terraform provisioning and automated ECS service deployment completed for project *deploy-watch*. All 4 tasks are healthy in target group.`,
      fields: [
        { title: "Status", value: "Active & Operational" },
        { title: "Region", value: "us-east-1" },
        { title: "Cluster", value: "benevolate-prod-fargate" },
        { title: "Triggered By", value: `@${req.user.username}` }
      ],
      level: "success"
    });
    if (success) {
      res.json({ ok: true, message: "Live ops alert dispatched to #integrate-devops-alerts!" });
    } else {
      res.status(400).json({ ok: false, error: "Failed to dispatch DevOps alert." });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/slack/test-digest ────────────────────────────────────────
router.post("/slack/test-digest", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const success = await slackService.sendHourlyOpsDigest();
    if (success) {
      res.json({ ok: true, message: "Hourly telemetry digest dispatched to #integrate-devops-alerts!" });
    } else {
      res.status(400).json({ ok: false, error: "Failed to dispatch hourly telemetry digest." });
    }
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

// ── POST /api/notifications/test-deployed ─────────────────────────────
router.post("/notifications/test-deployed", auth.requireAuth, async (req, res) => {
  const { projectName = "deploy-watch", environment = "dev", liveUrl } = req.body;
  try {
    const success = await slackService.notifyProjectDeployedLive({
      projectName,
      environment,
      liveUrl,
      triggeredBy: req.user.username
    });
    if (success) {
      res.json({ ok: true, message: `Live deployment alert & notification dispatched for ${projectName} (${environment})!` });
    } else {
      res.status(400).json({ ok: false, error: "Failed to dispatch live deployment notification." });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * Programmatic helper to create an in-app notification from any backend servicent.
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

// ── Super Admin: GET /api/admin/slack/channels — List all Slack channels ──
router.get("/admin/slack/channels", auth.requireRole("super_admin"), async (req, res) => {
  try {
    const result = await slackService.listAllSlackChannels();
    if (result.ok) {
      res.json({ ok: true, channels: result.channels });
    } else {
      res.status(400).json({ ok: false, error: result.error });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Super Admin: DELETE /api/admin/slack/channels/:id — Delete/Archive Slack channel ──
router.delete("/admin/slack/channels/:id", auth.requireRole("super_admin"), async (req, res) => {
  try {
    const channelId = req.params.id;
    const result = await slackService.deleteOrArchiveSlackChannel(channelId);
    if (result.ok) {
      res.json({ ok: true, message: result.message, mode: result.mode });
    } else {
      res.status(400).json({ ok: false, error: result.error });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
module.exports.createNotification = createNotification;
