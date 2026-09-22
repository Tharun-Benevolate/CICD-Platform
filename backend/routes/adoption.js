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

// ── Find a working GitHub token ───────────────────────────────────────────────
async function findWorkingToken() {
  try {
    const [rows] = await pool.query(`SELECT username FROM users WHERE is_blocked = 0 ORDER BY FIELD(user_type,'super_admin','admin','devops') LIMIT 15`);
    for (const row of rows) {
      const cred = await credManager.getCredentialByProvider(row.username, "github");
      if (!cred?.token) continue;
      const check = await githubGet("/user", cred.token);
      if (check?.login) {
        console.log(`[adoption] Using token from user: ${row.username} (github: ${check.login})`);
        return cred.token;
      }
    }
  } catch (e) { console.warn("[adoption] Token search:", e.message); }
  return process.env.GITHUB_TOKEN || null;
}

// ── Audit log check with optional since filter ────────────────────────────────
// NOTE: table is "audit_log" (singular)
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
  } catch { return false; }
}

// ── Build a rich "identity set" for a user ────────────────────────────────────
// Used to match against GitHub commit author fields from any direction
function buildUserIdentifiers(u) {
  const ids = new Set();
  const add = (v) => { if (v && v.trim()) ids.add(v.trim().toLowerCase()); };

  add(u.githubUsername);           // stored GitHub username (may be wrong org account)
  add(u.username);                 // platform username
  add(u.email);                    // full email
  if (u.username) add(u.username.split("@")[0]);  // email-prefix e.g. "tharun"
  if (u.email)    add(u.email.split("@")[0]);

  return ids;
}

// ── Match commit to user ──────────────────────────────────────────────────────
function commitMatchesUser(commit, userIds) {
  const login  = (commit.author?.login          || "").toLowerCase();
  const name   = (commit.commit?.author?.name   || "").toLowerCase();
  const email  = (commit.commit?.author?.email  || "").toLowerCase();
  const ePart  = email.split("@")[0];

  return (login  && userIds.has(login))  ||
         (name   && userIds.has(name))   ||
         (email  && userIds.has(email))  ||
         (ePart  && ePart.length > 2 && userIds.has(ePart));
}

// ── Fetch all commits across ALL branches (paginated up to 5 pages each) ──────
// Returns array of commit objects with author info
async function fetchAllCommits(owner, repo, token, since) {
  try {
    const branches = await githubGet(`/repos/${owner}/${repo}/branches?per_page=100`, token);
    if (!Array.isArray(branches)) return [];

    const sinceParam = since ? `&since=${new Date(since).toISOString()}` : "";
    const allCommits = new Map(); // dedupe by sha

    await Promise.all(branches.map(async (b) => {
      // Fetch up to 2 pages (200 commits) per branch
      for (let page = 1; page <= 2; page++) {
        const commits = await githubGet(
          `/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(b.name)}&per_page=100&page=${page}${sinceParam}`,
          token
        );
        if (!Array.isArray(commits) || commits.length === 0) break;
        for (const c of commits) allCommits.set(c.sha, c);
        if (commits.length < 100) break;
      }
    }));

    console.log(`[adoption] Total unique commits fetched across all branches: ${allCommits.size}`);
    return Array.from(allCommits.values());
  } catch (e) {
    console.warn("[adoption] fetchAllCommits:", e.message);
    return [];
  }
}

// ── Fetch branch list with head commit author ─────────────────────────────────
async function fetchBranchAuthors(owner, repo, token) {
  try {
    const branches = await githubGet(`/repos/${owner}/${repo}/branches?per_page=100`, token);
    if (!Array.isArray(branches)) return [];

    const results = await Promise.all(branches.map(async (b) => {
      const commit = await githubGet(`/repos/${owner}/${repo}/commits/${b.commit.sha}`, token);
      return {
        name:       b.name,
        login:      (commit?.author?.login || "").toLowerCase(),
        authorName: (commit?.commit?.author?.name || "").toLowerCase(),
        email:      (commit?.commit?.author?.email || "").toLowerCase(),
      };
    }));
    return results;
  } catch (e) { return []; }
}

// ── GET /api/adoption/reset-config ───────────────────────────────────────────
router.get("/adoption/reset-config", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT setting_value FROM platform_settings WHERE setting_key = 'adoption_reset_at' LIMIT 1`);
    res.json({ ok: true, resetAt: rows[0]?.setting_value || null });
  } catch { res.json({ ok: true, resetAt: null }); }
});

// ── POST /api/adoption/reset ──────────────────────────────────────────────────
router.post("/adoption/reset", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const now = new Date().toISOString();
    await pool.query(`CREATE TABLE IF NOT EXISTS platform_settings (
      setting_key   VARCHAR(100) PRIMARY KEY,
      setting_value TEXT,
      updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`);
    await pool.query(
      `INSERT INTO platform_settings (setting_key, setting_value) VALUES ('adoption_reset_at', ?)
       ON DUPLICATE KEY UPDATE setting_value = ?, updated_at = NOW()`,
      [now, now]
    );
    res.json({ ok: true, resetAt: now });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/adoption/stats?projectId=xxx ────────────────────────────────────
router.get("/adoption/stats", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const { projectId } = req.query;

    // Resolve the correct project — use projectId from query, fallback to active
    const allProjects = await projectStore.listProjects();
    let project = projectId
      ? allProjects.find(p => p.id === projectId)
      : allProjects.find(p => p.isActive) || allProjects[0];

    const canQueryGithub = !!(project?.githubOwner && project?.githubRepo);
    const owner = project?.githubOwner;
    const repo  = project?.githubRepo;

    console.log(`[adoption] Project: ${project?.name} | Repo: ${owner}/${repo}`);

    // Get reset since date
    let since = null;
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS platform_settings (setting_key VARCHAR(100) PRIMARY KEY, setting_value TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
      const [cfg] = await pool.query(`SELECT setting_value FROM platform_settings WHERE setting_key = 'adoption_reset_at' LIMIT 1`);
      since = cfg[0]?.setting_value || null;
    } catch { /* ignore */ }

    // Get working GitHub token
    const token = canQueryGithub ? await findWorkingToken() : null;
    const githubOk = !!(token && canQueryGithub);

    // Pre-fetch ALL commits across ALL branches + branch authors — ONE time for all users
    let allCommits = [];
    let branchAuthors = [];
    if (githubOk) {
      [allCommits, branchAuthors] = await Promise.all([
        fetchAllCommits(owner, repo, token, since),
        fetchBranchAuthors(owner, repo, token)
      ]);
    }

    // Get project members — only show users who have access to this project
    let users = [];
    if (project) {
      try {
        const [memberRows] = await pool.query(
          `SELECT username FROM developer_access WHERE project_id = ?`,
          [project.id]
        );
        const memberUsernames = new Set(memberRows.map(r => r.username.toLowerCase()));
        const allUsers = await userStore.listUsers();
        // Include: project members + admins
        users = allUsers.filter(u =>
          memberUsernames.has(u.username.toLowerCase()) ||
          ["super_admin", "admin", "devops"].includes(u.userType)
        );
      } catch {
        users = await userStore.listUsers();
      }
    } else {
      users = await userStore.listUsers();
    }

    const stats = await Promise.all(users.map(async (u) => {
      const userIds = buildUserIdentifiers(u);

      // ── Task 1: Profile Setup — auto ✅ for all ─────────────────────────
      const task1 = true;

      // ── Task 2: Branch Creation ─────────────────────────────────────────
      // Source 1: platform branches table
      let task2 = false;
      try {
        const sinceClause = since ? ` AND created_at >= ?` : "";
        const [rows] = await pool.query(
          `SELECT id FROM branches WHERE LOWER(created_by) = ?${sinceClause} AND deleted_at IS NULL LIMIT 1`,
          [u.username.toLowerCase(), ...(since ? [since] : [])]
        );
        if (rows.length > 0) task2 = true;
      } catch { /* ignore */ }

      // Source 2: GitHub branch head-commit author — match by any identifier
      if (!task2 && branchAuthors.length > 0) {
        const match = branchAuthors.find(b => {
          const ePart = b.email.split("@")[0];
          return (b.login  && userIds.has(b.login))  ||
                 (b.authorName && userIds.has(b.authorName)) ||
                 (b.email && userIds.has(b.email))   ||
                 (ePart && ePart.length > 2 && userIds.has(ePart));
        });
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
      // Source 1: GitHub — check ALL commits across ALL branches
      let task3 = false;
      if (allCommits.length > 0) {
        task3 = allCommits.some(c => commitMatchesUser(c, userIds));
      }
      // Source 2: audit_log fallback
      if (!task3) {
        task3 = await hasAuditLog(u.username, [
          "Executed git command: git commit", "Executed git command: git merge",
          "Executed git command: git rebase", "Executed git command: git push",
          "Merged \"", "already up to date"
        ], since);
      }

      // ── Dependency Logic: commit done → branch done ─────────────────────
      // If someone committed to a branch they didn't create, they've still done branch work
      if (task3 && !task2) task2 = true;

      // ── Task 4: Pull Request / Change Request ───────────────────────────
      let task4 = await hasAuditLog(u.username, [
        "Created Change Request", "Merged CR", "Submitted CR for review"
      ], since);
      if (!task4) {
        try {
          const sinceClause = since ? ` AND created_at >= ?` : "";
          const [rows] = await pool.query(
            `SELECT id FROM change_requests WHERE LOWER(author) = ?${sinceClause} LIMIT 1`,
            [u.username.toLowerCase(), ...(since ? [since] : [])]
          );
          if (rows.length > 0) task4 = true;
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
        username:       u.username,
        userType:       u.userType,
        githubUsername: u.githubUsername || null,
        avatarUrl:      u.avatarUrl || null,
        isOnline:       u.isOnline || false,
        tasks: { profile: task1, branch: task2, commit: task3, pr: task4, deploy: task5 },
        progress
      };
    }));

    stats.sort((a, b) => b.progress - a.progress);
    res.json({
      ok: true,
      stats,
      projectName: project?.name || "Unknown",
      githubRepo:  canQueryGithub ? `${owner}/${repo}` : null,
      githubConnected: githubOk,
      since
    });
  } catch (err) {
    console.error("[adoption/stats] error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
