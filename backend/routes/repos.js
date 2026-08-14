// routes/repos.js — CodeCommit repository and branch routes.
// Extracted from server.js lines 870-906.

const router = require("express").Router();
const aws = require("../config/aws");
const { requireProject } = require("./projects");

const repoStore = require("../stores/repositoryStore");
const projectStore = require("../stores/projectStore");
const accessStore = require("../stores/accessStore");
const auth = require("../middleware/auth");
const credManager = require("../services/credentialManager");
const gh = require("../services/githubService");

// GET /api/repos
router.get("/repos", async (req, res) => {
  try {
    const { projectId, region } = req.query;

    if (projectId) {
      let projectRepos = await repoStore.listRepositories(projectId);
      if (!projectRepos || projectRepos.length === 0) {
        const project = await projectStore.getProject(projectId);
        if (project && (project.repoName || project.githubRepo)) {
          const repoName = project.repoName || project.githubRepo;
          const provider = project.sourceType || "codecommit";
          const owner = project.githubOwner || null;
          const defaultBranch = project.githubBranch || project.data?.defaultBranch || "main";

          const created = await repoStore.createRepository({
            projectId,
            provider,
            owner,
            repoName,
            defaultBranch,
            createdBy: project.createdBy || "system"
          });
          projectRepos = [created];
        }
      }
      return res.json({ ok: true, repos: projectRepos, repositories: projectRepos });
    }

    // No projectId — determine what repos this user is allowed to see
    const username = auth.getLoggedInUser(req);
    const userType = auth.getLoggedInUserType(req);
    const isPrivileged = !username || userType === "super_admin" || userType === "devops" || userType === "admin";

    if (isPrivileged) {
      const r = region || process.env.AWS_REGION || "us-east-1";
      const reqProvider = (req.query.provider || "").toLowerCase();
      const [dbRepos, awsRepos] = await Promise.all([
        repoStore.listRepositories().catch(() => []),
        reqProvider && reqProvider !== "codecommit" ? Promise.resolve([]) : aws.listRepos(r).catch(() => [])
      ]);

      const combined = [];
      const seenNames = new Set();

      // Add AWS CodeCommit repos first if requesting codecommit or no provider specified
      if (Array.isArray(awsRepos) && (!reqProvider || reqProvider === "codecommit")) {
        awsRepos.forEach(ar => {
          const name = typeof ar === "string" ? ar : (ar.repositoryName || ar.name || "");
          if (name && !seenNames.has(name.toLowerCase())) {
            seenNames.add(name.toLowerCase());
            combined.push({
              id: ar.repositoryId || name,
              repo_name: name,
              repoName: name,
              repositoryName: name,
              provider: "codecommit"
            });
          }
        });
      }

      // Add database repos matching requested provider
      if (Array.isArray(dbRepos)) {
        dbRepos.forEach(dr => {
          const drProvider = (dr.provider || "").toLowerCase();
          if (reqProvider && drProvider && drProvider !== reqProvider) return;
          const name = dr.repo_name || dr.repoName || dr.repositoryName || dr.name || "";
          if (name && !seenNames.has(name.toLowerCase())) {
            seenNames.add(name.toLowerCase());
            combined.push({
              ...dr,
              repo_name: name,
              repoName: name,
              repositoryName: name
            });
          }
        });
      }

      return res.json({ ok: true, repos: combined, repositories: combined });
    }

    // Developers/Sales: only show repos from their assigned projects
    const userAccess = await accessStore.getUserAccess(username);
    if (!userAccess || userAccess.length === 0) {
      return res.json({ ok: true, repos: [], repositories: [] });
    }

    const allAssignedRepos = [];
    for (const access of userAccess) {
      const pid = access.projectId || access.project_id;
      if (!pid) continue;
      let projectRepos = await repoStore.listRepositories(pid);
      if (!projectRepos || projectRepos.length === 0) {
        const project = await projectStore.getProject(pid);
        if (project && (project.repoName || project.githubRepo)) {
          const repoName = project.repoName || project.githubRepo;
          const provider = project.sourceType || "codecommit";
          const owner = project.githubOwner || null;
          const defaultBranch = project.githubBranch || project.data?.defaultBranch || "main";
          try {
            const created = await repoStore.createRepository({
              projectId: pid, provider, owner, repoName, defaultBranch,
              createdBy: project.createdBy || "system"
            });
            projectRepos = [created];
          } catch (_) { projectRepos = []; }
        }
      }
      allAssignedRepos.push(...(projectRepos || []));
    }

    return res.json({ ok: true, repos: allAssignedRepos, repositories: allAssignedRepos });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/repos/connect — connect existing repository to project
router.post("/repos/connect", async (req, res) => {
  try {
    const { projectId, provider, repoName, owner, defaultBranch, cloneUrl } = req.body;
    if (!projectId || !repoName) {
      return res.status(400).json({ ok: false, error: "projectId and repoName are required" });
    }

    const username = auth.getLoggedInUser(req);
    const created = await repoStore.createRepository({
      projectId,
      provider: provider || "codecommit",
      owner: owner || null,
      repoName,
      defaultBranch: defaultBranch || "main",
      cloneUrl: cloneUrl || null,
      createdBy: username || "system"
    });

    // Also update primary project state
    await projectStore.updateProject(projectId, {
      sourceType: provider || "codecommit",
      repoName,
      githubRepo: provider === "github" ? repoName : null,
      githubOwner: owner || null,
      githubBranch: defaultBranch || "main"
    });

    res.json({ ok: true, repository: created });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/repos/disconnect — disconnect repository from project
router.post("/repos/disconnect", async (req, res) => {
  try {
    const { repositoryId, projectId } = req.body;
    if (!repositoryId) return res.status(400).json({ ok: false, error: "repositoryId is required" });

    const repo = await repoStore.getRepository(repositoryId);
    if (!repo) return res.status(404).json({ ok: false, error: "Repository not found" });

    const targetProjectId = projectId || repo.project_id || repo.projectId;

    await repoStore.deleteRepository(repositoryId);

    if (targetProjectId) {
      const remaining = await repoStore.listRepositories(targetProjectId);
      if (remaining && remaining.length > 0) {
        const next = remaining[0];
        await projectStore.updateProject(targetProjectId, {
          sourceType: next.provider || "codecommit",
          repoName: next.repo_name || next.repoName,
          githubRepo: next.provider === "github" ? (next.repo_name || next.repoName) : null,
          githubOwner: next.owner || null,
          githubBranch: next.default_branch || "main"
        });
      } else {
        await projectStore.updateProject(targetProjectId, {
          repoName: null,
          githubRepo: null,
          githubOwner: null
        });
      }
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/repos/delete-and-disconnect — delete repository at remote provider AND disconnect
router.post("/repos/delete-and-disconnect", async (req, res) => {
  try {
    const { repositoryId, projectId } = req.body;
    if (!repositoryId) return res.status(400).json({ ok: false, error: "repositoryId is required" });

    const repo = await repoStore.getRepository(repositoryId);
    if (!repo) return res.status(404).json({ ok: false, error: "Repository not found" });

    const targetProjectId = projectId || repo.project_id || repo.projectId;
    const provider = repo.provider;
    const repoName = repo.repo_name || repo.repoName;

    // 1. Delete remote repository at provider side
    if (provider === "codecommit") {
      const project = targetProjectId ? await projectStore.getProject(targetProjectId) : null;
      const region = project?.region || process.env.AWS_REGION || "us-east-1";
      await aws.deleteRepo(region, repoName);
    } else if (provider === "github") {
      let owner = repo.owner;
      let name = repoName;
      if (name.includes("/")) {
        const parts = name.split("/");
        owner = owner || parts[0];
        name = parts[1];
      }
      const username = auth.getLoggedInUser(req);
      let token = process.env.GITHUB_TOKEN;
      if (username) {
        try {
          const cred = await credManager.getCredential(username, "github");
          if (cred) token = cred;
        } catch (_) {}
      }
      if (!owner || !name) {
        return res.status(400).json({ ok: false, error: "Could not determine GitHub owner and repository name" });
      }
      await gh.deleteRepo(owner, name, token);
    }

    // 2. Delete database record
    await repoStore.deleteRepository(repositoryId);

    // Update project state if needed
    if (targetProjectId) {
      const remaining = await repoStore.listRepositories(targetProjectId);
      if (remaining && remaining.length > 0) {
        const next = remaining[0];
        await projectStore.updateProject(targetProjectId, {
          sourceType: next.provider || "codecommit",
          repoName: next.repo_name || next.repoName,
          githubRepo: next.provider === "github" ? (next.repo_name || next.repoName) : null,
          githubOwner: next.owner || null,
          githubBranch: next.default_branch || "main"
        });
      } else {
        await projectStore.updateProject(targetProjectId, {
          repoName: null,
          githubRepo: null,
          githubOwner: null
        });
      }
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/repos/create — create a new AWS CodeCommit repository
router.post("/repos/create", async (req, res) => {
  try {
    const { repositoryName, description, region } = req.body;
    if (!repositoryName) return res.status(400).json({ ok: false, error: "repositoryName is required" });
    const r = region || process.env.AWS_REGION || "us-east-1";
    const result = await aws.createRepo(r, repositoryName, description || `Created via Benevolate CI/CD`);
    res.json({ ok: true, repository: result });
  } catch (err) {
    if (err.name === "RepositoryNameExistsException") {
      return res.json({ ok: true, alreadyExisted: true });
    }
    res.status(err.$metadata?.httpStatusCode || 500).json({ ok: false, error: err.message });
  }
});

// POST /api/repos/delete — permanently delete a CodeCommit repository from AWS
router.post("/repos/delete", async (req, res) => {
  try {
    const { repositoryName, region } = req.body;
    if (!repositoryName) return res.status(400).json({ ok: false, error: "repositoryName is required" });
    const r = region || process.env.AWS_REGION || "us-east-1";
    await aws.deleteRepo(r, repositoryName);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.$metadata?.httpStatusCode || 500).json({ ok: false, error: err.message });
  }
});

// GET /api/branches
router.get("/branches", async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    // Accept explicit repoName query param (from repo selector dropdown)
    const repoName = (req.query.repoName || project.repoName || "").trim();
    if (!repoName) return res.status(400).json({ ok: false, error: "No repository configured for this project. Please connect a repository first." });
    const branches = await aws.listBranches(project.region, repoName);
    const detailed = await Promise.all(
      branches.map(b => aws.getBranchDetail(project.region, repoName, b).catch(() => ({ branchName: b, commitId: null, commit: null })))
    );
    res.json({ ok: true, branches: detailed });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/branches/create
router.post("/branches/create", async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const { branchName, baseBranch, repoName } = req.body;
    if (!branchName || !baseBranch) {
      return res.status(400).json({ ok: false, error: "branchName and baseBranch are required" });
    }
    const targetRepo = (repoName || project.repoName || "").trim();
    if (!targetRepo) {
      return res.status(400).json({ ok: false, error: "No repository name specified for branch creation" });
    }
    const result = await aws.createBranch(project.region, targetRepo, branchName, baseBranch);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});


// ── GitHub token resolution (Smart Multi-Tier Fallback) ────────────────────────
// 1. Current logged-in user's stored token (if valid and has access to repo)
// 2. Repo Creator's stored token (if user's token lacks repo access/gets 404)
// 3. System/Admin stored GitHub PAT or process.env.GITHUB_TOKEN
async function resolveGithubTokenForRepo(req, repo = null) {
  const { getLoggedInUser } = require("../middleware/auth");
  const username = getLoggedInUser(req) || "admin";

  let ghOwner = repo?.owner || "";
  let ghRepo = repo?.repo_name || repo?.repoName || repo?.name || "";
  if (ghRepo && ghRepo.includes("/")) {
    const parts = ghRepo.split("/");
    ghRepo = parts[parts.length - 1];
    if (!ghOwner) ghOwner = parts[0];
  }

  // 1. Prioritize Repo Creator's token (the Admin/DevOps who connected this repo to the project)
  const creator = repo?.created_by || repo?.createdBy;
  if (creator && ghOwner && ghRepo) {
    const creatorToken = await credManager.getCredential(creator, "github").catch(() => null);
    if (creatorToken) {
      const access = await gh.testRepoAccess(ghOwner, ghRepo, creatorToken);
      if (access.ok) {
        return { token: creatorToken, source: `Repo Creator (@${creator})`, username: creator };
      }
    }
  }

  // 2. Try current logged-in user's personal GitHub token
  let userToken = await credManager.getCredential(username, "github").catch(() => null);
  if (userToken) {
    if (ghOwner && ghRepo) {
      const access = await gh.testRepoAccess(ghOwner, ghRepo, userToken);
      if (access.ok) {
        return { token: userToken, source: `User (@${username})`, username };
      }
    } else {
      return { token: userToken, source: `User (@${username})`, username };
    }
  }

  // 3. Scan ALL stored GitHub credentials in DB for any Admin/DevOps token that can access this repository
  try {
    const { pool } = require("../config/db");
    const [allGhCreds] = await pool.query(
      `SELECT username, encrypted_token, token_iv, token_tag FROM repo_credentials WHERE LOWER(provider) = 'github' ORDER BY created_at DESC`
    );
    for (const row of allGhCreds) {
      const tok = credManager.decrypt(row.encrypted_token, row.token_iv, row.token_tag);
      if (tok && ghOwner && ghRepo) {
        const access = await gh.testRepoAccess(ghOwner, ghRepo, tok);
        if (access.ok) {
          return { token: tok, source: `Team Admin Token (@${row.username})`, username: row.username };
        }
      } else if (tok && (!ghOwner || !ghRepo)) {
        return { token: tok, source: `Team Admin Token (@${row.username})`, username: row.username };
      }
    }
  } catch (_) {}

  // 4. Fallback to process.env.GITHUB_TOKEN
  const fallbackToken = await credManager.resolveGithubToken(username);
  return { token: fallbackToken || userToken || "", source: "System Env Token", username };
}

async function resolveGithubToken(req) {
  return await resolveGithubTokenForRepo(req, null);
}

// Auto-clears the stored GitHub token for a user if it returned 401.
async function clearInvalidGithubToken(username) {
  if (!username) return;
  try {
    await credManager.deleteCredentialByProvider(username, "github");
    console.log(`[github] Auto-cleared invalid stored token for user: ${username}`);
  } catch (_) {}
}

// GET /api/repos/:id/diagnostics — Real-time live status and ownership diagnostics for a repo
router.get("/repos/:id/diagnostics", async (req, res) => {
  try {
    const repositoryId = req.params.id;
    let repo = await repoStore.getRepository(repositoryId);
    if (!repo) {
      const allRepos = await repoStore.listRepositories();
      repo = allRepos.find(r => r.id === repositoryId || r.repo_name === repositoryId || r.repoName === repositoryId);
    }

    if (!repo) {
      return res.status(404).json({ ok: false, error: "Repository not found in workspace" });
    }

    const { getLoggedInUser } = require("../middleware/auth");
    const loggedInUser = getLoggedInUser(req) || "admin";
    const provider = repo.provider || "codecommit";
    const repoName = repo.repo_name || repo.repoName;
    const owner = repo.owner || "";
    const createdBy = repo.created_by || repo.createdBy || "system";
    const createdAt = repo.created_at || repo.createdAt || null;

    let scope = "Personal Account";
    if (owner && owner.toLowerCase() !== createdBy.toLowerCase()) {
      scope = `Organization (@${owner})`;
    } else if (owner) {
      scope = `Personal Account (@${owner})`;
    } else {
      scope = `AWS CodeCommit (${process.env.AWS_REGION || "us-east-1"})`;
    }

    let creatorOAuthConnected = false;
    if (provider === "github" && createdBy) {
      const creatorTok = await credManager.getCredential(createdBy, "github").catch(() => null);
      creatorOAuthConnected = !!creatorTok;
    }

    let currentUserOAuthConnected = false;
    if (provider === "github") {
      const userTok = await credManager.getCredential(loggedInUser, "github").catch(() => null);
      currentUserOAuthConnected = !!userTok;
    }

    let httpStatusCode = 200;
    let userDirectAccess = true;
    let isPrivate = true;
    let resolvedTokenSource = "Direct User Token";
    let statusMessage = "Repository is active and fully accessible.";

    if (provider === "github") {
      let ghOwner = owner || "";
      let ghRepo = repoName || "";
      if (ghRepo.includes("/")) {
        const parts = ghRepo.split("/");
        ghRepo = parts[parts.length - 1];
        if (!ghOwner) ghOwner = parts[0];
      }

      // 1. Test current user's token directly
      const userTok = await credManager.getCredential(loggedInUser, "github").catch(() => null);
      if (userTok && ghOwner && ghRepo) {
        const userTest = await gh.testRepoAccess(ghOwner, ghRepo, userTok);
        if (!userTest.ok) {
          userDirectAccess = false;
          httpStatusCode = userTest.status || 404;
        } else {
          isPrivate = userTest.isPrivate ?? true;
        }
      } else if (!userTok) {
        userDirectAccess = false;
      }

      // 2. Test smart fallback token
      const { token: effectiveToken, source } = await resolveGithubTokenForRepo(req, repo);
      if (effectiveToken && ghOwner && ghRepo) {
        const fallbackTest = await gh.testRepoAccess(ghOwner, ghRepo, effectiveToken);
        if (fallbackTest.ok) {
          httpStatusCode = 200;
          resolvedTokenSource = source;
          isPrivate = fallbackTest.isPrivate ?? true;
          if (!userDirectAccess) {
            statusMessage = `Your GitHub account lacks direct permissions on GitHub (404), but team fallback token (${source}) is active and serving data.`;
          }
        } else {
          httpStatusCode = fallbackTest.status || 404;
          statusMessage = `Repository returned HTTP ${httpStatusCode}. GitHub token lacks permissions or repository was deleted on GitHub.`;
        }
      } else {
        httpStatusCode = 401;
        statusMessage = "No valid GitHub token available for this repository.";
      }
    }

    res.json({
      ok: true,
      diagnostics: {
        repoId: repo.id || repositoryId,
        repoName: repoName,
        owner: owner,
        fullPath: owner ? `${owner}/${repoName}` : repoName,
        provider: provider,
        scope: scope,
        createdBy: createdBy,
        loggedInUser: loggedInUser,
        createdAt: createdAt,
        isPrivate: isPrivate,
        creatorOAuthConnected: creatorOAuthConnected,
        currentUserOAuthConnected: currentUserOAuthConnected,
        userDirectAccess: userDirectAccess,
        httpStatusCode: httpStatusCode,
        resolvedTokenSource: resolvedTokenSource,
        statusMessage: statusMessage,
        isAccessible: httpStatusCode === 200
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/branches/by-repo?repositoryId=xxx&projectId=xxx
// Fetches branches for ANY connected repo (GitHub or CodeCommit) by repositoryId.
router.get("/branches/by-repo", async (req, res) => {
  try {
    const repositoryId = (req.query.repositoryId || req.query.repoId || req.query.repoName || "").trim();
    const projectId = req.query.projectId;
    if (!repositoryId) {
      return res.status(400).json({ ok: false, error: "repositoryId is required" });
    }
    let repo = await repoStore.getRepository(repositoryId);
    if (!repo && projectId) {
      const allRepos = await repoStore.listRepositories(projectId);
      repo = allRepos.find(r => r.id === repositoryId || r.repo_name === repositoryId || r.repoName === repositoryId);
    }
    if (!repo) {
      repo = {
        provider: repositoryId.includes("/") ? "github" : "codecommit",
        repo_name: repositoryId,
        default_branch: "main"
      };
    }

    const provider = repo.provider || "codecommit";
    const repoName = repo.repo_name || repo.repoName || repositoryId;
    const owner = repo.owner;

    if (provider === "github") {
      const { token, source, username } = await resolveGithubTokenForRepo(req, repo);
      if (!token) {
        return res.status(401).json({
          ok: false,
          authRequired: true,
          error: "No GitHub token available. Add a Personal Access Token in Settings → Git Credentials."
        });
      }

      // Derive owner/repo — repoName may be stored as "owner/repo" full path
      let ghOwner = owner || "";
      let ghRepo = repoName || "";
      if (ghRepo.includes("/")) {
        const parts = ghRepo.split("/");
        ghRepo = parts[parts.length - 1];
        if (!ghOwner) ghOwner = parts[0];
      }
      if (!ghOwner || !ghRepo) {
        return res.status(400).json({ ok: false, error: "Cannot resolve GitHub owner/repo from stored data." });
      }

      try {
        const data = await gh.listBranches(ghOwner, ghRepo, token);
        const branches = (data.branches || []).map(b => ({
          name: b.name, sha: b.sha,
          isDefault: b.isDefault || b.name === (data.defaultBranch || "main"),
          aheadBy: b.aheadBy || 0, behindBy: b.behindBy || 0
        }));
        return res.json({ ok: true, provider: "github", defaultBranch: data.defaultBranch || "main", branches });
      } catch (ghErr) {
        // If the stored cred was used and it returned 401, auto-clear it
        if (ghErr.status === 401 && source === "db") {
          await clearInvalidGithubToken(username);
          return res.status(401).json({
            ok: false, authRequired: true,
            error: "Your stored GitHub token has expired or was revoked. Please save a new PAT in Settings → Git Credentials."
          });
        }
        throw ghErr;
      }

    } else {
      // CodeCommit
      const project = projectId ? await require("../stores/projectStore").getProject(projectId) : null;
      const region = project?.region || repo.region || process.env.AWS_REGION || "us-east-1";

      const branchNames = await aws.listBranches(region, repoName);
      const detailed = await Promise.all(
        branchNames.map(b => aws.getBranchDetail(region, repoName, b)
          .catch(() => ({ branchName: b, commitId: null, commit: null }))
        )
      );
      const defaultBranch = repo.default_branch || repo.defaultBranch || "main";
      const branches = detailed.map(b => ({
        name: b.branchName || b.name,
        sha: b.commitId || b.sha || null,
        isDefault: (b.branchName || b.name) === defaultBranch,
        commitMessage: b.commit?.message || null,
        commitAuthor: b.commit?.author?.name || b.commit?.committer?.name || null,
        commitDate: b.commit?.author?.date || b.commit?.committer?.date || null
      }));
      return res.json({ ok: true, provider: "codecommit", defaultBranch, branches });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Parses CodeCommit date which may be a Unix epoch string ("1638466800") or ISO string
function parseCodeCommitDate(d) {
  if (!d) return null;
  const n = Number(d);
  if (!isNaN(n) && n > 1_000_000_000) return new Date(n * 1000).toISOString();
  const parsed = new Date(d);
  return isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

// GET /api/commits/by-repo?repositoryId=xxx&branch=xxx&limit=15
// Fetches commit history for ANY connected repo (GitHub or CodeCommit).
router.get("/commits/by-repo", async (req, res) => {
  try {
    const { repositoryId, branch, projectId } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 15, 30); // default 15, max 30
    if (!repositoryId) return res.status(400).json({ ok: false, error: "repositoryId is required" });

    const repo = await repoStore.getRepository(repositoryId);
    if (!repo) return res.status(404).json({ ok: false, error: "Repository not found" });

    const provider = repo.provider || "codecommit";
    const repoName = repo.repo_name || repo.repoName;
    const owner = repo.owner;
    const targetBranch = branch || repo.default_branch || repo.defaultBranch || "main";

    if (provider === "github") {
      const { token, source, username } = await resolveGithubTokenForRepo(req, repo);
      if (!token) {
        return res.status(401).json({
          ok: false, authRequired: true,
          error: "No GitHub token available. Add a Personal Access Token in Settings → Git Credentials."
        });
      }

      // Derive owner/repo — repoName may be stored as "owner/repo" full path
      let ghOwner = owner || "";
      let ghRepo = repoName || "";
      if (ghRepo.includes("/")) {
        const parts = ghRepo.split("/");
        ghRepo = parts[parts.length - 1];
        if (!ghOwner) ghOwner = parts[0];
      }
      if (!ghOwner || !ghRepo) {
        return res.status(400).json({ ok: false, error: "Cannot resolve GitHub owner/repo from stored data." });
      }

      try {
        const commits = await gh.getCommits(ghOwner, ghRepo, targetBranch, limit, token);
        return res.json({ ok: true, provider: "github", branch: targetBranch, commits });
      } catch (ghErr) {
        if (ghErr.status === 401 && source === "db") {
          await clearInvalidGithubToken(username);
          return res.status(401).json({
            ok: false, authRequired: true,
            error: "Your stored GitHub token has expired or was revoked. Please save a new PAT in Settings → Git Credentials."
          });
        }
        throw ghErr;
      }

    } else {
      // ── CodeCommit: batch fetch commits using BatchGetCommitsCommand ──────────
      // BatchGetCommitsCommand fetches up to 25 commits per call, drastically
      // reducing round-trips vs. one-by-one GetCommitCommand.
      const project = projectId ? await require("../stores/projectStore").getProject(projectId) : null;
      const region = project?.region || repo.region || process.env.AWS_REGION || "us-east-1";

      const {
        CodeCommitClient, GetBranchCommand, BatchGetCommitsCommand
      } = require("@aws-sdk/client-codecommit");
      const client = new CodeCommitClient({ region });

      // 1. Get HEAD SHA from branch (1 fast API call)
      let headSha = null;
      try {
        const branchRes = await client.send(
          new GetBranchCommand({ repositoryName: repoName, branchName: targetBranch })
        );
        headSha = branchRes.branch?.commitId;
      } catch (_) {}

      if (!headSha) {
        return res.json({ ok: true, provider: "codecommit", branch: targetBranch, commits: [] });
      }

      // 2. Walk the parent chain, batching up to 25 SHAs per round-trip
      const commits = [];
      const seen = new Set();
      let pendingShas = [headSha]; // SHAs queued for the next batch call

      while (pendingShas.length > 0 && commits.length < limit) {
        // Take as many as BatchGetCommits allows (25 max), capped by remaining quota
        const batchSize = Math.min(25, limit - commits.length);
        const toFetch = pendingShas.splice(0, batchSize).filter(s => s && !seen.has(s));
        if (toFetch.length === 0) break;
        toFetch.forEach(s => seen.add(s));

        let batchCommits = [];
        try {
          const batchRes = await client.send(
            new BatchGetCommitsCommand({ repositoryName: repoName, commitIds: toFetch })
          );
          batchCommits = batchRes.commits || [];
        } catch (_) { break; }

        // Sort by date descending so newest-first order is preserved
        batchCommits.sort((a, b) => {
          const da = parseCodeCommitDate(a.author?.date || a.committer?.date);
          const db = parseCodeCommitDate(b.author?.date || b.committer?.date);
          return (db ? new Date(db) : 0) - (da ? new Date(da) : 0);
        });

        for (const c of batchCommits) {
          commits.push({
            sha: c.commitId,
            message: (c.message || "").trim(),
            authorName: c.author?.name || c.committer?.name || "Unknown",
            authorEmail: c.author?.email || c.committer?.email || "",
            date: parseCodeCommitDate(c.author?.date || c.committer?.date),
            parents: c.parents || []
          });
          // Queue each commit's first parent for the next batch
          if (c.parents?.length > 0 && !seen.has(c.parents[0])) {
            pendingShas.push(c.parents[0]);
          }
        }
      }

      return res.json({ ok: true, provider: "codecommit", branch: targetBranch, commits });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/branches/create-for-repo — create branch on any provider
router.post("/branches/create-for-repo", async (req, res) => {
  try {
    const { repositoryId, branchName, baseBranch, projectId } = req.body;
    if (!repositoryId || !branchName || !baseBranch) {
      return res.status(400).json({ ok: false, error: "repositoryId, branchName and baseBranch are required" });
    }

    const repo = await repoStore.getRepository(repositoryId);
    if (!repo) return res.status(404).json({ ok: false, error: "Repository not found" });

    const provider = repo.provider || "codecommit";
    const repoName = repo.repo_name || repo.repoName;
    const owner = repo.owner;

    if (provider === "github") {
      const { getLoggedInUser } = require("../middleware/auth");
      const username = getLoggedInUser(req);
      let token = process.env.GITHUB_TOKEN || "";
      try {
        const cred = await credManager.getCredential(username, "github");
        if (cred) token = cred;
      } catch (_) {}

      // Derive owner/repo — repoName may be stored as "owner/repo" full path
      let ghOwner = owner || "";
      let ghRepo = repoName || "";
      if (ghRepo.includes("/")) {
        const parts = ghRepo.split("/");
        ghRepo = parts[parts.length - 1];
        if (!ghOwner) ghOwner = parts[0];
      }

      await gh.createBranch(ghOwner, ghRepo, branchName, baseBranch, token);
      return res.json({ ok: true });

    } else {
      const project = projectId ? await require("../stores/projectStore").getProject(projectId) : null;
      const region = project?.region || repo.region || process.env.AWS_REGION || "us-east-1";
      const result = await aws.createBranch(region, repoName, branchName, baseBranch);
      return res.json({ ok: true, ...result });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.resolveGithubTokenForRepo = resolveGithubTokenForRepo;
router.resolveGithubToken = resolveGithubToken;
module.exports = router;

// ─── Branch Compare & Merge (used by Git Diff & Merge page) ─────────────────
// These are registered separately in server.js after repos router, or appended here.

// GET /api/branches/compare?repositoryId=&base=&head=
router.get("/branches/compare", async (req, res) => {
  try {
    const { repositoryId, base, head } = req.query;
    if (!repositoryId || !base || !head) {
      return res.status(400).json({ ok: false, error: "repositoryId, base, and head are required" });
    }
    const repo = await repoStore.getRepository(repositoryId);
    if (!repo) return res.status(404).json({ ok: false, error: "Repository not found" });

    const { token } = await resolveGithubToken(req);
    const { getProvider } = require("../services/gitProvider");
    const provider = getProvider(repo.provider);
    const diff = await provider.compareBranches(repo.owner, repo.repo_name, base, head, token);
    res.json({ ok: true, diff });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// POST /api/branches/merge
router.post("/branches/merge", async (req, res) => {
  try {
    const { repositoryId, baseBranch, headBranch, commitMessage } = req.body;
    if (!repositoryId || !baseBranch || !headBranch) {
      return res.status(400).json({ ok: false, error: "repositoryId, baseBranch, and headBranch are required" });
    }
    const repo = await repoStore.getRepository(repositoryId);
    if (!repo) return res.status(404).json({ ok: false, error: "Repository not found" });

    const { token } = await resolveGithubToken(req);
    const { getProvider } = require("../services/gitProvider");
    const provider = getProvider(repo.provider);
    const result = await provider.mergeBranches(
      repo.owner, repo.repo_name, baseBranch, headBranch,
      commitMessage || `Merge '${headBranch}' into '${baseBranch}'`,
      null, token
    );

    if (result.alreadyUpToDate) {
      return res.status(400).json({ ok: false, error: "Branch is already up to date with base" });
    }

    const auditStore = require("../stores/auditStore");
    auditStore.logAction(
      req.user?.username || "system",
      `Merged branch '${headBranch}' into '${baseBranch}'`,
      repo.repo_name, "Success", "Change Requests"
    );
    res.json({ ok: true, mergeResult: result });
  } catch (err) {
    if (err.status === 409) {
      return res.status(409).json({ ok: false, error: "Merge conflict detected. Resolve conflicts before merging." });
    }
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});
