const router = require("express").Router();
const userStore = require("../stores/userStore");
const projectStore = require("../stores/projectStore");
const credManager = require("../services/credentialManager");
const gh = require("../services/githubService");
const auth = require("../middleware/auth");
const { pool } = require("../config/db");

// ── Audit log helper ──────────────────────────────────────────────────────────
// Returns true if the given username has ANY audit log matching at least one matcher.
async function hasAuditLog(username, matchers) {
  const likeConditions = matchers.map(() => `action LIKE ?`).join(" OR ");
  const values = [username.toLowerCase(), ...matchers.map(m => `%${m}%`)];
  const [rows] = await pool.query(
    `SELECT id FROM audit_logs WHERE LOWER(username) = ? AND (${likeConditions}) LIMIT 1`,
    values
  );
  return rows.length > 0;
}

// ── GitHub token helper ───────────────────────────────────────────────────────
// Finds the GitHub PAT for any super_admin/admin user who has connected GitHub OAuth.
// Returns the decrypted token string, or null if none is found.
async function findAdminGithubToken() {
  // Get super_admin/admin users from the DB
  const [adminRows] = await pool.query(
    `SELECT username FROM users WHERE user_type IN ('super_admin', 'admin') AND is_blocked = 0 LIMIT 5`
  );
  for (const row of adminRows) {
    const cred = await credManager.getCredentialByProvider(row.username, "github");
    if (cred && cred.token) return { token: cred.token, username: row.username };
  }
  // Fallback: try the environment variable (project-level PAT set in .env)
  if (process.env.GITHUB_TOKEN) return { token: process.env.GITHUB_TOKEN, username: "env" };
  return null;
}

// ── GET /api/adoption/stats ───────────────────────────────────────────────────
router.get("/adoption/stats", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    // listUsers() returns camelCase: username, userType, githubUsername, avatarUrl etc.
    const users    = await userStore.listUsers();
    const projects = await projectStore.listProjects();

    // Use the first configured project as the reference GitHub repo
    const mainProject = projects.find(p => p.githubOwner && p.githubRepo) || projects[0];

    // Resolve a GitHub token for cross-user commit lookups
    const ghCred = await findAdminGithubToken();
    const canQueryGithub = !!(ghCred && mainProject && mainProject.githubOwner && mainProject.githubRepo);

    const stats = await Promise.all(users.map(async (u) => {
      // Task 1 – Profile / Onboarding: Auto-checked for all registered users
      const task1 = true;

      // Task 2 – Branch Creation: check audit logs for any branch-related action
      const task2 = await hasAuditLog(u.username, [
        "Created GitHub branch",
        "Executed git command: git branch",
        "Executed git command: git checkout -b",
        "Executed git command: git switch -c"
      ]);

      // Task 3 – Commit / Merge / Rebase:
      //   Primary source: live GitHub API (catches local `git push` from any IDE)
      //   Fallback: audit log of git commands executed in the platform terminal
      let task3 = false;
      if (canQueryGithub && u.githubUsername) {
        try {
          // Use the existing githubService.getCommits with author filter via raw URL
          const raw = await require("node-fetch")(
            `https://api.github.com/repos/${mainProject.githubOwner}/${mainProject.githubRepo}/commits?author=${encodeURIComponent(u.githubUsername)}&per_page=1`,
            {
              headers: {
                "Authorization": `Bearer ${ghCred.token}`,
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28"
              }
            }
          );
          if (raw.ok) {
            const data = await raw.json().catch(() => []);
            if (Array.isArray(data) && data.length > 0) task3 = true;
          }
        } catch (e) {
          console.warn(`[adoption] GitHub API commit check failed for ${u.githubUsername}:`, e.message);
        }
      }
      // Platform terminal fallback
      if (!task3) {
        task3 = await hasAuditLog(u.username, [
          "Executed git command: git commit",
          "Executed git command: git merge",
          "Executed git command: git rebase",
          "Executed git command: git pull",
          "Executed git command: git push",
          "Merged \"",    // e.g. Merged "feature/x" into "main"
          "already up to date"
        ]);
      }

      // Task 4 – Pull Request / Change Request:
      //   Check audit logs (created, submitted, merged) AND directly query the CR table by author
      let task4 = await hasAuditLog(u.username, [
        "Created Change Request",
        "Merged CR",
        "Submitted CR for review"
      ]);
      if (!task4) {
        const [crRows] = await pool.query(
          `SELECT id FROM change_requests WHERE LOWER(author) = ? LIMIT 1`,
          [u.username.toLowerCase()]
        );
        if (crRows.length > 0) task4 = true;
      }

      // Task 5 – Deployment (pipeline trigger):
      //   Check audit logs for any pipeline-related execution
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
        userType:       u.userType,       // camelCase from listUsers()
        githubUsername: u.githubUsername, // camelCase from listUsers()
        avatarUrl:      u.avatarUrl,      // camelCase from listUsers()
        isOnline:       u.isOnline,
        tasks: { profile: task1, branch: task2, commit: task3, pr: task4, deploy: task5 },
        progress
      };
    }));

    // Sort: fully adopted first, then by progress descending
    stats.sort((a, b) => b.progress - a.progress);

    res.json({ ok: true, stats, githubConnected: canQueryGithub });
  } catch (err) {
    console.error("[adoption/stats] error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
