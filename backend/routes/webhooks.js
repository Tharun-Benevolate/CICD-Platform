const express = require("express");
const router = express.Router();
const auditStore = require("../stores/auditStore");
const notificationService = require("../services/notificationService");
const { pool } = require("../config/db");

// POST /api/webhooks/deploy
// Simulates a webhook receiver for deployment status updates (e.g. from ArgoCD, CodeDeploy, etc.)
router.post("/deploy", async (req, res) => {
  try {
    const { projectId, status, environment, url, commitSha } = req.body;
    if (!projectId || !status) {
      return res.status(400).json({ ok: false, error: "projectId and status are required" });
    }

    // Lookup project to find the owner/admin to notify
    const [projects] = await pool.query("SELECT * FROM projects WHERE id = ?", [projectId]);
    if (!projects.length) {
      return res.status(404).json({ ok: false, error: "Project not found" });
    }
    const project = projects[0];

    // Notification Type
    let notifType = "system";
    if (status === "success" || status === "completed") notifType = "deploy_completed";
    if (status === "failed" || status === "error") notifType = "deploy_failed";

    const title = `Deployment ${status.toUpperCase()}`;
    const body = `Deployment to ${environment || "production"} finished with status: ${status}. Commit: ${commitSha || "N/A"}`;
    
    // Notify the project creator (as a simulation for notifying the team)
    const recipient = project.created_by || "testadmin";
    await notificationService.notify(
      recipient,
      notifType,
      title,
      body,
      url || null,
      null
    );

    // Also log it to the audit log for the project
    auditStore.logAction("system", `Webhook received: ${title} (${environment})`, project.id, status === "failed" ? "Failed" : "Success", "Deployment");

    res.json({ ok: true, message: "Webhook processed" });
  } catch (err) {
    console.error("Deploy Webhook Error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
