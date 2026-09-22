const router = require("express").Router();
const userStore = require("../stores/userStore");
const projectStore = require("../stores/projectStore");
const credManager = require("../services/credentialManager");
const auth = require("../middleware/auth");
const fetch = require("node-fetch"); // v2 CommonJS
const { pool } = require("../config/db");

// ── GitHub API helper ─────────────────────────────────────────────────────────
async function githubGet(path, token) {
  try {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });
    if (!res.ok) return null;
    return res.json().catch(() => null);
  } catch { return null; }
}

// ── Audit log helper ──────────────────────────────────────────────────────────
// NOTE: table is "audit_log" (singular). Usernames match users.username.
async function hasAuditLog(username, matchers, since) {
  if (!username) return false;
  const likeConditions = matchers.map(() => `action LIKE ?`).join(" OR ");
  const sinceClause = since ? ` AND timestamp >= ?` : "";
  const values = [username.toLowerCase(), ...matchers.map(m => `%${m}%`), ...(since ? [since] : [])];
  try {
    const [rows] = await pool.query(
      `SELECT id FROM audit_log WHERE LOWER(username) = ? AND (${likeConditions})${sinceClause} LIMIT 1`,
      values
    );
    return rows.length > 0;
  } catch (e) {
    console.error("[adoption] hasAuditLog error:", e.message);
    return false;
  }
}

// ── GitHub token helper ───────────────────────────────────────────────────────
async function findAdminGithubToken() {
  try {
    // Iterate all users — try every GitHub credential until one works
    const [allRows] = await pool.query(`SELECT username FROM users WHERE is_blocked = 0 ORDER BY FIELD(user_type,'super_admin','admin','devops') LIMIT 10`);
    for (const row of allRows) {
      const cred = await credManager.getCredentialByProvider(row.username, "github");
      if (!cred?.token) continue;
      // Quick validity check
      const check = await githubGet("/user", cred.token);
      if (check?.login) { console.log("[adoption] Using GitHub token of:", row.username); return cred.token; }
    }
  } catch (e) { console.warn("[adoption] Token search error:", e.message); }
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  return null;
}

// ── Pre-fetch all branch head-commit authors from GitHub ─────────────────────
async function getGithubBranchAuthors(owner, repo, token) {
  try {
    const branches = await githubGet(`/repos/${owner}/${repo}/branches?per_page=100`, token);
    if (!Array.isArray(branches)) return [];
    const results = await Promise.all(branches.map(async (b) => {
      const commit = await githubGet(`/repos/${owner}/${repo}/commits/${b.commit.sha}`, token);
      return {
        branchName: b.name,
        authorLogin: (commit?.author?.login || "").toLowerCase(),
        authorName:  (commit?.commit?.author?.name || "").toLowerCase(),
        authorEmail: (commit?.commit?.author?.email || "").toLowerCase()
      };
    }));
    return results;
  } catch (e) { console.warn("[adoption] getGithubBranchAuthors:", e.message); return []; }
}

// ── Pre-fetch all recent commit authors from GitHub ───────────────────────────
// Returns a Set of strings: { githubLogin, gitName, gitEmail } for fast lookup
async function getGithubCommitAuthors(owner, repo, token, since) {
  try {
    const sinceParam = since ? `&since=${new Date(since).toISOString()}` : "";
    const commits = await githubGet(`/repos/${owner}/${repo}/commits?per_page=100${sinceParam}`, token);
    if (!Array.isArray(commits)) return { logins: new Set(), names: new Set(), emails: new Set() };
    const logins = new Set(), names = new Set(), emails = new Set();
    for (const c of commits) {
      if (c.author?.login)           logins.add(c.author.login.toLowerCase());
      if (c.commit?.author?.name)    names.add(c.commit.author.name.toLowerCase());
      if (c.commit?.author?.email)   emails.add(c.commit.author.email.toLowerCase());
    }
    return { logins, names, emails };
  } catch (e) { return { logins: new Set(), names: new Set(), emails: new Set() }; }
}

// ── GET /api/adoption/reset-config ───────────────────────────────────────────
// Returns the current reset timestamp (or null if never reset)
router.get("/adoption/reset-config", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT setting_value FROM platform_settings WHERE setting_key = 'adoption_reset_at' LIMIT 1`
    );
    res.json({ ok: true, resetAt: rows[0]?.setting_value || null });
  } catch (e) {
    // Table might not exist yet — just return null
    res.json({ ok: true, resetAt: null });
  }
});

// ── POST /api/adoption/reset ──────────────────────────────────────────────────
// Sets reset timestamp to NOW — all checks will only look at activity after this date
router.post("/adoption/reset", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const now = new Date().toISOString();
    // Ensure table exists (idempotent)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS platform_settings (
        setting_key   VARCHAR(100) PRIMARY KEY,
        setting_value TEXT,
        updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    await pool.query(
      `INSERT INTO platform_settings (setting_key, setting_value) VALUES ('adoption_reset_at', ?)
       ON DUPLICATE KEY UPDATE setting_value = ?, updated_at = NOW()`,
      [now, now]
    );
    res.json({ ok: true, resetAt: now, message: "Tracking reset. Only activity after this date will count." });
  } catch (err) {
    console.error("[adoption/reset] error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/adoption/stats ───────────────────────────────────────────────────
router.get("/adoption/stats", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const users    = await userStore.listUsers();
    const projects = await projectStore.listProjects();
    const mainProject = projects.find(p => p.githubOwner && p.githubRepo) || null;

    // Resolve a working GitHub token
    const githubToken   = await findAdminGithubToken();
    const canQueryGithub = !!(githubToken && mainProject);

    // Get reset date (null = track all time)
    let since = null;
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS platform_settings (setting_key VARCHAR(100) PRIMARY KEY, setting_value TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
      const [cfg] = await pool.query(`SELECT setting_value FROM platform_settings WHERE setting_key = 'adoption_reset_at' LIMIT 1`);
      since = cfg[0]?.setting_value || null;
    } catch { /* ignore */ }

    // Pre-fetch GitHub data once for all users
    let githubBranchAuthors = [];
    let githubCommitAuthors = { logins: new Set(), names: new Set(), emails: new Set() };
    if (canQueryGithub) {
      [githubBranchAuthors, githubCommitAuthors] = await Promise.all([
        getGithubBranchAuthors(mainProject.githubOwner, mainProject.githubRepo, githubToken),
        getGithubCommitAuthors(mainProject.githubOwner, mainProject.githubRepo, githubToken, since)
      ]);
      console.log(`[adoption] GitHub: ${githubBranchAuthors.length} branches, ${githubCommitAuthors.logins.size} committer logins, ${githubCommitAuthors.names.size} names`);
    }

    const stats = await Promise.all(users.map(async (u) => {
      // Task 1 – Profile Setup: Auto-checked for all
      const task1 = true;

      // ── Task 2: Branch Creation ─────────────────────────────────────────
      // Source 1: platform branches table
      let task2 = false;
      try {
        const sinceClause = since ? ` AND created_at >= ?` : "";
        const [branchRows] = await pool.query(
          `SELECT id FROM branches WHERE LOWER(created_by) = ?${sinceClause} AND deleted_at IS NULL LIMIT 1`,
          [u.username.toLowerCase(), ...(since ? [since] : [])]
        );
        if (branchRows.length > 0) task2 = true;
      } catch { /* ignore */ }

      // Source 2: GitHub branch head-commit author (by login OR git name OR email)
      if (!task2 && githubBranchAuthors.length > 0) {
        const ghLogin = (u.githubUsername || "").toLowerCase();
        const uName   = u.username.toLowerCase();
        const uEmail  = (u.email || "").toLowerCase();
        const match = githubBranchAuthors.find(b =>
          (ghLogin && b.authorLogin === ghLogin) ||
          b.authorName === uName ||
          (uEmail && b.authorEmail === uEmail)
        );
        if (match) task2 = true;
      }

      // Source 3: audit_log fallback
      if (!task2) {
        task2 = await hasAuditLog(u.username, [
          "Created GitHub branch", "Executed git command: git branch",
          "Executed git command: git checkout -b", "Executed git command: git switch -c"
        ], since);
      }

      // ── Task 3: Commit / Merge / Rebase ────────────────────────────────
      // Source 1: GitHub API — match by login, git name, OR email
      let task3 = false;
      if (githubCommitAuthors.logins.size > 0 || githubCommitAuthors.names.size > 0) {
        const ghLogin = (u.githubUsername || "").toLowerCase();
        const uName   = u.username.toLowerCase();
        const uEmail  = (u.email || "").toLowerCase();
        if ((ghLogin && githubCommitAuthors.logins.has(ghLogin)) ||
            githubCommitAuthors.names.has(uName) ||
            (uEmail && githubCommitAuthors.emails.has(uEmail))) {
          task3 = true;
        }
      }
      // Source 2: audit_log fallback
      if (!task3) {
        task3 = await hasAuditLog(u.username, [
          "Executed git command: git commit", "Executed git command: git merge",
          "Executed git command: git rebase", "Executed git command: git pull",
          "Executed git command: git push", "Merged \"", "already up to date"
        ], since);
      }

      // ── Task 4: Pull Request / Change Request ───────────────────────────
      let task4 = await hasAuditLog(u.username, [
        "Created Change Request", "Merged CR", "Submitted CR for review"
      ], since);
      if (!task4) {
        try {
          const sinceClause = since ? ` AND created_at >= ?` : "";
          const [crRows] = await pool.query(
            `SELECT id FROM change_requests WHERE LOWER(author) = ?${sinceClause} LIMIT 1`,
            [u.username.toLowerCase(), ...(since ? [since] : [])]
          );
          if (crRows.length > 0) task4 = true;
        } catch { /* ignore */ }
      }

      // ── Task 5: Deployment ──────────────────────────────────────────────
      const task5 = await hasAuditLog(u.username, [
        "Triggered manual pipeline execution", "Pipeline execution",
        "Ad-hoc build started", "Beta environment started", "Promoted beta image"
      ], since);

      const completedCount = [task1, task2, task3, task4, task5].filter(Boolean).length;
      const progress = Math.round((completedCount / 5) * 100);

      return {
        username: u.username, userType: u.userType,
        githubUsername: u.githubUsername || null,
        avatarUrl: u.avatarUrl || null,
        isOnline: u.isOnline || false,
        tasks: { profile: task1, branch: task2, commit: task3, pr: task4, deploy: task5 },
        progress
      };
    }));

    stats.sort((a, b) => b.progress - a.progress);
    res.json({ ok: true, stats, githubConnected: canQueryGithub, since });
  } catch (err) {
    console.error("[adoption/stats] error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
