// routes/github.js — GitHub Git workspace routes (GitHub API only).

const router = require("express").Router();
const gh = require("../services/githubService");
const gitExec = require("../services/gitExec");
const auth = require("../middleware/auth");
const auditStore = require("../stores/auditStore");
const credManager = require("../services/credentialManager");
const { requireGithubProject } = require("./projects");

async function resolveToken(req) {
  const user = auth.getLoggedInUser(req);
  return credManager.resolveGithubToken(user);
}


// GET /api/github/branches
router.get("/github/branches", async (req, res) => {
  try {
    const project = await requireGithubProject(req, res); if (!project) return;
    const token = await resolveToken(req);
    const data = await gh.listBranches(project.githubOwner, project.githubRepo, token);
    res.json({ ok: true, ...data });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// GET /api/github/commits
router.get("/github/commits", async (req, res) => {
  try {
    const project = await requireGithubProject(req, res); if (!project) return;
    const token = await resolveToken(req);
    const ref = req.query.ref || project.githubBranch || "main";
    const commits = await gh.getCommits(project.githubOwner, project.githubRepo, ref, req.query.limit || 30, token);
    res.json({ ok: true, ref, commits });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// GET /api/github/commit/:sha
router.get("/github/commit/:sha", async (req, res) => {
  try {
    const project = await requireGithubProject(req, res); if (!project) return;
    const token = await resolveToken(req);
    const commit = await gh.getCommit(project.githubOwner, project.githubRepo, req.params.sha, token);
    res.json({ ok: true, commit });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// GET /api/github/compare
router.get("/github/compare", async (req, res) => {
  try {
    const project = await requireGithubProject(req, res); if (!project) return;
    const { base, head } = req.query;
    if (!base || !head) return res.status(400).json({ ok: false, error: "base and head query params are required" });
    const result = await gh.compareBranches(project.githubOwner, project.githubRepo, base, head);
    res.json({ ok: true, base, head, ...result });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// POST /api/github/branches — admin only
router.post("/github/branches", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireGithubProject(req, res); if (!project) return;
    const { branchName, baseBranch } = req.body;
    if (!branchName || !baseBranch) return res.status(400).json({ ok: false, error: "branchName and baseBranch are required" });
    await gh.createBranch(project.githubOwner, project.githubRepo, branchName, baseBranch);
    auditStore.logAction(auth.getLoggedInUser(req), `Created GitHub branch "${branchName}" from "${baseBranch}"`, project.name, "Success");
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// DELETE /api/github/branches/:name — admin only
router.delete("/github/branches/:name", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireGithubProject(req, res); if (!project) return;
    const branchName = req.params.name;
    if (branchName === (project.githubBranch || "main")) {
      return res.status(400).json({ ok: false, error: "Refusing to delete the pipeline's configured branch." });
    }
    await gh.deleteBranch(project.githubOwner, project.githubRepo, branchName);
    auditStore.logAction(auth.getLoggedInUser(req), `Deleted GitHub branch "${branchName}"`, project.name, "Success");
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// POST /api/github/merge — admin only
router.post("/github/merge", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireGithubProject(req, res); if (!project) return;
    const { base, head, commitMessage } = req.body;
    if (!base || !head) return res.status(400).json({ ok: false, error: "base and head are required" });
    const result = await gh.mergeBranches(project.githubOwner, project.githubRepo, base, head, commitMessage);
    auditStore.logAction(
      auth.getLoggedInUser(req),
      result.alreadyUpToDate
        ? `Merge "${head}" into "${base}" — already up to date`
        : `Merged "${head}" into "${base}" (${result.sha?.slice(0, 10)})`,
      project.name, "Success"
    );
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// POST /api/git/exec — admin only
router.post("/git/exec", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireGithubProject(req, res); if (!project) return;
    const { command } = req.body;
    if (!command) return res.status(400).json({ ok: false, error: "command is required" });
    
    const result = await gitExec.runGitCommand(project, command);
    auditStore.logAction(auth.getLoggedInUser(req), `Executed git command: ${command}`, project.name, result.success ? "Success" : "Failed");
    res.json({ ok: true, result });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// GET /api/github/list-repos — list connected user's GitHub repositories
router.get("/github/list-repos", async (req, res) => {
  try {
    const username = auth.getLoggedInUser(req);
    let token = null;
    if (username) {
      const cred = await credManager.getCredentialByProvider(username, "github");
      token = cred?.token;
    }

    if (!token) {
      return res.json({
        ok: false,
        requiresOAuth: true,
        error: "No GitHub OAuth connection found",
        message: "Please connect your GitHub account via OAuth to list and select your repositories."
      });
    }

    const { org } = req.query;
    const repos = await gh.listUserRepos(token, org);
    res.json({ ok: true, repos });
  } catch (err) {
    console.error("[github/list-repos error]:", err);
    res.json({
      ok: false,
      requiresOAuth: false,
      error: err.message
    });
  }
});

// GET /api/github/orgs — list GitHub organizations connected user has access to
router.get("/github/orgs", async (req, res) => {
  try {
    const username = auth.getLoggedInUser(req);
    const cred = await credManager.getCredentialByProvider(username, "github");
    if (!cred || !cred.token) {
      return res.status(401).json({ ok: false, error: "GitHub account not connected via OAuth" });
    }
    const orgs = await gh.listUserOrgs(cred.token);
    res.json({ ok: true, orgs });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// POST /api/github/create-repo — create a private repo under personal or org workspace
router.post("/github/create-repo", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  const { repoName, org, description } = req.body;
  if (!repoName) return res.status(400).json({ ok: false, error: "repoName is required" });

  try {
    const username = auth.getLoggedInUser(req);
    const cred = await credManager.getCredentialByProvider(username, "github");
    if (!cred || !cred.token) {
      return res.status(401).json({ ok: false, error: "GitHub account not connected via OAuth" });
    }

    const newRepo = await gh.createRepo(cred.token, repoName, org || null, description);
    auditStore.logAction(
      username,
      `Created private GitHub repository "${newRepo.full_name}"`,
      newRepo.name,
      "Success"
    );
    res.json({ ok: true, repo: newRepo });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
