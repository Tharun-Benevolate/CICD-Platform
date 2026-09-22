const router = require("express").Router();
const userStore = require("../stores/userStore");
const auditStore = require("../stores/auditStore");
const projectStore = require("../stores/projectStore");
const auth = require("../middleware/auth");
const { Octokit } = require("@octokit/rest");

// Helper to check audit logs
async function hasAuditLog(username, matchers) {
  const { pool } = require("../config/db");
  const likeConditions = matchers.map(() => `action LIKE ?`).join(" OR ");
  const values = [username, ...matchers.map(m => `%${m}%`)];
  const [rows] = await pool.query(
    `SELECT id FROM audit_logs WHERE username = ? AND (${likeConditions}) LIMIT 1`,
    values
  );
  return rows.length > 0;
}

// GET /api/adoption/stats
router.get("/adoption/stats", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const users = await userStore.listUsers();
    const projects = await projectStore.listProjects();
    
    // Use the first active project as the main reference for GitHub repo
    const mainProject = projects[0];
    let octokit = null;

    if (mainProject && mainProject.githubOwner && mainProject.githubRepo) {
      // Find a super_admin token to query GitHub API broadly
      const { pool } = require("../config/db");
      const [tokenRows] = await pool.query(
        `SELECT token FROM credentials WHERE provider = 'github' AND user = 'admin' LIMIT 1`
      );
      if (tokenRows.length > 0) {
        octokit = new Octokit({ auth: tokenRows[0].token });
      }
    }

    const stats = await Promise.all(users.map(async (u) => {
      // Task 1: Profile Setup (Auto-checked as per user request)
      const task1 = true;

      // Task 2: Branch Creation (Audit Log)
      const task2 = await hasAuditLog(u.username, ["Created GitHub branch", "Executed git command: git branch", "Executed git command: git checkout"]);

      // Task 3: Local Commit / Merge / Rebase (GitHub API + Audit Log fallback)
      let task3 = false;
      if (octokit && u.github_username && mainProject) {
        try {
          const commits = await octokit.rest.repos.listCommits({
            owner: mainProject.githubOwner,
            repo: mainProject.githubRepo,
            author: u.github_username,
            per_page: 1
          });
          if (commits.data && commits.data.length > 0) task3 = true;
        } catch (e) {
          console.error(`GitHub API error fetching commits for ${u.github_username}:`, e.message);
        }
      }
      if (!task3) {
        task3 = await hasAuditLog(u.username, ["Executed git command: git commit", "Executed git command: git merge", "Executed git command: git rebase", "Executed git command: git push"]);
      }

      // Task 4: PR Creation (Audit log 'Change Request' or 'Merge CR')
      let task4 = await hasAuditLog(u.username, ["Created Change Request", "Merged CR", "Submitted CR for review"]);

      // Task 5: Pipeline Deployment (Audit Log)
      let task5 = await hasAuditLog(u.username, ["Triggered manual pipeline execution", "Pipeline execution", "Ad-hoc build started", "Beta environment started"]);

      const completedCount = [task1, task2, task3, task4, task5].filter(Boolean).length;
      const progress = Math.round((completedCount / 5) * 100);

      return {
        username: u.username,
        userType: u.user_type,
        githubUsername: u.github_username,
        avatarUrl: u.avatar_url,
        tasks: {
          profile: task1,
          branch: task2,
          commit: task3,
          pr: task4,
          deploy: task5
        },
        progress
      };
    }));

    // Sort by progress descending
    stats.sort((a, b) => b.progress - a.progress);

    res.json({ ok: true, stats });
  } catch (err) {
    console.error("[adoption/stats] error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
