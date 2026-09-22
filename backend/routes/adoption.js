const router = require("express").Router();
const userStore = require("../stores/userStore");
const projectStore = require("../stores/projectStore");
const credManager = require("../services/credentialManager");
const auth = require("../middleware/auth");
const fetch = require("node-fetch"); // v2 CommonJS
const { pool } = require("../config/db");

// ── Audit log helper ──────────────────────────────────────────────────────────
// NOTE: the table is "audit_log" (singular) — verified against live DB.
// Usernames in audit_log match users.username (short form, e.g. "aditya").
async function hasAuditLog(username, matchers) {
  if (!username) return false;
  const likeConditions = matchers.map(() => `action LIKE ?`).join(" OR ");
  const values = [username.toLowerCase(), ...matchers.map(m => `%${m}%`)];
  try {
    const [rows] = await pool.query(
      `SELECT id FROM audit_log WHERE LOWER(username) = ? AND (${likeConditions}) LIMIT 1`,
      values
    );
    return rows.length > 0;
  } catch (e) {
    console.error("[adoption] hasAuditLog error:", e.message);
    return false;
  }
}

// ── GitHub token helper ───────────────────────────────────────────────────────
// Find a usable GitHub token: try admin users' stored OAuth tokens first,
// then fall back to the GITHUB_TOKEN environment variable.
async function findAdminGithubToken() {
  try {
    const [adminRows] = await pool.query(
      `SELECT username FROM users WHERE user_type IN ('super_admin', 'admin') AND is_blocked = 0 LIMIT 5`
    );
    for (const row of adminRows) {
      const cred = await credManager.getCredentialByProvider(row.username, "github");
      if (cred && cred.token) return cred.token;
    }
  } catch (e) {
    console.warn("[adoption] Could not find admin GitHub token from DB:", e.message);
  }
  // Fallback: use environment-level PAT
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  return null;
}

// ── GET /api/adoption/stats ───────────────────────────────────────────────────
router.get("/adoption/stats", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    // listUsers() returns camelCase: username, userType, githubUsername, avatarUrl etc.
    const users    = await userStore.listUsers();
    const projects = await projectStore.listProjects();

    // Use first project with a connected GitHub repo
    const mainProject = projects.find(p => p.githubOwner && p.githubRepo) || null;
    const githubToken = await findAdminGithubToken();
    const canQueryGithub = !!(githubToken && mainProject);

    const stats = await Promise.all(users.map(async (u) => {
      // Task 1 – Profile / Platform Onboarding: Auto-checked for all registered users
      const task1 = true;

      // Task 2 – Branch Creation: audit_log entries
      const task2 = await hasAuditLog(u.username, [
        "Created GitHub branch",
        "Executed git command: git branch",
        "Executed git command: git checkout -b",
        "Executed git command: git switch -c"
      ]);

      // Task 3 – Commit / Merge / Rebase:
      //   Primary: live GitHub API (catches any local push from laptop/IDE)
      //   Fallback: audit_log for git commands run in platform terminal
      let task3 = false;
      if (canQueryGithub && u.githubUsername) {
        try {
          const apiRes = await fetch(
            `https://api.github.com/repos/${mainProject.githubOwner}/${mainProject.githubRepo}/commits?author=${encodeURIComponent(u.githubUsername)}&per_page=1`,
            {
              headers: {
                "Authorization": `Bearer ${githubToken}`,
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28"
              }
            }
          );
          if (apiRes.ok) {
            const data = await apiRes.json();
            if (Array.isArray(data) && data.length > 0) task3 = true;
          }
        } catch (e) {
          console.warn(`[adoption] GitHub API commit check failed for ${u.githubUsername}:`, e.message);
        }
      }
      // Fallback to platform terminal audit logs
      if (!task3) {
        task3 = await hasAuditLog(u.username, [
          "Executed git command: git commit",
          "Executed git command: git merge",
          "Executed git command: git rebase",
          "Executed git command: git pull",
          "Executed git command: git push",
          "Merged \"",
          "already up to date"
        ]);
      }

      // Task 4 – Pull Request / Change Request:
      //   Check audit_log AND directly query the change_requests table by author
      let task4 = await hasAuditLog(u.username, [
        "Created Change Request",
        "Merged CR",
        "Submitted CR for review"
      ]);
      if (!task4) {
        try {
          const [crRows] = await pool.query(
            `SELECT id FROM change_requests WHERE LOWER(author) = ? LIMIT 1`,
            [u.username.toLowerCase()]
          );
          if (crRows.length > 0) task4 = true;
        } catch (e) { /* table may not exist */ }
      }

      // Task 5 – Deployment / Pipeline trigger:
      const task5 = await hasAuditLog(u.username, [
        "Triggered manual pipeline execution",
        "Pipeline execution",
        "Ad-hoc build started",
        "Beta environment started",
        "Promoted beta image"
      ]);

      const completedCount = [task1, task2, task3, task4, task5].filter(Boolean).length;
      const progress = Math.round((completedCount / 5) * 100);

      return {
        username:       u.username,
        userType:       u.userType,
        githubUsername: u.githubUsername || null,
        avatarUrl:      u.avatarUrl || null,
        isOnline:       u.isOnline || false,
        tasks: { profile: task1, branch: task2, commit: task3, pr: task4, deploy: task5 },
        progress
      };
    }));

    // Sort by progress descending
    stats.sort((a, b) => b.progress - a.progress);

    res.json({ ok: true, stats, githubConnected: canQueryGithub });
  } catch (err) {
    console.error("[adoption/stats] error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
