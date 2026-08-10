// routes/fileBrowser.js — File browser and editor API routes.
// Provides repository file tree browsing, file content read/write, and upload.
// Phase 2 implementation.

const router = require("express").Router();
const repoStore = require("../stores/repositoryStore");
const crStore = require("../stores/changeRequestStore");
const { getProvider } = require("../services/gitProvider");
const multer = require("multer");
const unzipper = require("unzipper");
const path = require("path");
const auth = require("../middleware/auth");
const projectStore = require("../stores/projectStore");

// Multer: store ZIP in memory (max 50 MB)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// Helper: resolve GitHub token (user PAT -> system/admin PAT -> GITHUB_TOKEN env)
async function getGithubToken(req) {
  try {
    const username = auth.getLoggedInUser(req);
    const credManager = require("../services/credentialManager");
    return await credManager.resolveGithubToken(username);
  } catch { return process.env.GITHUB_TOKEN || ""; }
}


// Helper: resolve repository + project region or 400
async function requireRepo(req, res) {
  const id = req.query.repositoryId || req.body.repositoryId;
  const repoName = req.query.repo || req.body.repo;
  const projectId = req.query.projectId || req.body.projectId;

  let repo = null;
  if (id) {
    repo = await repoStore.getRepository(id);
  }

  if (!repo && (repoName || projectId)) {
    if (projectId) {
      const list = await repoStore.listRepositories(projectId);
      if (repoName) {
        repo = list.find(r => (r.repo_name === repoName || r.repositoryName === repoName));
      }
      if (!repo && list.length > 0) {
        repo = list[0];
      }
    }
    if (!repo && repoName) {
      const { pool } = require("../config/db");
      const [rows] = await pool.query(`SELECT * FROM repositories WHERE repo_name = ? LIMIT 1`, [repoName]);
      if (rows.length > 0) repo = rows[0];
    }
  }

  if (!repo && projectId) {
    try {
      const project = await projectStore.getProject(projectId);
      if (project) {
        repo = {
          id: `p-${project.id}`,
          project_id: project.id,
          provider: project.githubRepo ? "github" : (project.sourceType || "codecommit"),
          repo_name: project.githubRepo || project.repoName || "cicd-app",
          owner: project.githubOwner || null,
          default_branch: project.githubBranch || "main",
          _region: project.region
        };
      }
    } catch {}
  }

  if (!repo) {
    res.status(404).json({ ok: false, error: "Repository not found" });
    return null;
  }

  // Parse GitHub owner/repo if combined in repo_name
  if (repo.provider === "github" && repo.repo_name && repo.repo_name.includes("/")) {
    const parts = repo.repo_name.split("/");
    repo.owner = parts[0];
    repo.repo_name = parts[1];
  }

  if (repo.provider === "codecommit" && repo.project_id && !repo._region) {
    try {
      const project = await projectStore.getProject(repo.project_id);
      if (project && project.region) repo._region = project.region;
    } catch {}
  }

  return repo;
}

// GET /api/repos/branches?repositoryId=&projectId=&repo= — unified branch list (GitHub & CodeCommit)
router.get("/repos/branches", async (req, res) => {
  try {
    const repo = await requireRepo(req, res); if (!repo) return;
    const provider = getProvider(repo.provider);
    let branches = [];
    if (repo.provider === "github") {
      const token = await getGithubToken(req);
      branches = await provider.listBranchesSimple(repo.owner, repo.repo_name, token);
    } else {
      branches = await provider.listBranches(repo._region, repo.repo_name);
    }
    res.json({ ok: true, branches });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// GET /api/files/tree?repositoryId=&ref=&path= — get file tree for a folder
router.get("/files/tree", async (req, res) => {
  try {
    const repo = await requireRepo(req, res); if (!repo) return;
    const ref = req.query.ref || repo.default_branch || "main";
    const folderPath = req.query.path || "";
    const provider = getProvider(repo.provider);
    let tree;
    if (repo.provider === "github") {
      const token = await getGithubToken(req);
      tree = await provider.getTree(repo.owner, repo.repo_name, ref, true, folderPath, token);
    } else {
      tree = await provider.getTree(repo._region, repo.repo_name, ref, true, folderPath);
    }
    res.json({ ok: true, ref, tree });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// GET /api/files/content?repositoryId=&path=&ref= — get a single file's content
router.get("/files/content", async (req, res) => {
  try {
    const repo = await requireRepo(req, res); if (!repo) return;
    const { path: filePath, ref } = req.query;
    if (!filePath) return res.status(400).json({ ok: false, error: "path is required" });
    const provider = getProvider(repo.provider);
    let file;
    if (repo.provider === "github") {
      const token = await getGithubToken(req);
      file = await provider.getFileContent(repo.owner, repo.repo_name, filePath, ref || repo.default_branch, token);
    } else {
      file = await provider.getFileContent(repo._region, repo.repo_name, filePath, ref || repo.default_branch);
    }
    res.json({ ok: true, file });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// PUT /api/files/content — update a single file (editor save)
// Body: { repositoryId, projectId, path, content, message, branch, sha, changeRequestId? }
router.put("/files/content", async (req, res) => {
  try {
    const { path: filePath, content, message, branch, sha, changeRequestId } = req.body;
    if (!filePath || content === undefined || !message || !branch) {
      return res.status(400).json({ ok: false, error: "path, content, message, and branch are required" });
    }

    const repo = await requireRepo(req, res); if (!repo) return;
    const provider = getProvider(repo.provider);
    const committer = { name: req.user?.username || "benevolate", email: `${req.user?.username || "benevolate"}@benevolate.internal` };
    let fileSha = sha || null;
    let result;
    if (repo.provider === "github") {
      const token = await getGithubToken(req);
      if (!fileSha) {
        try {
          const existing = await provider.getFileContent(repo.owner, repo.repo_name, filePath, branch, token);
          if (existing && existing.sha) {
            fileSha = existing.sha;
          }
        } catch (_) {
          // File does not exist yet (creating new file)
        }
      }
      result = await provider.updateFile(repo.owner, repo.repo_name, filePath, content, message, branch, fileSha, committer, token);
    } else {
      result = await provider.updateFile(repo._region, repo.repo_name, filePath, content, message, branch, fileSha, committer);
    }

    // If tied to a CR, record the file change
    if (changeRequestId && repo.id) {
      await crStore.addFile({
        changeRequestId,
        filePath,
        changeType: sha ? "modified" : "added",
        additions: content.split("\n").length,
        deletions: 0,
        blobSha: result.content?.sha
      });
    }

    const slackService = require("../services/slackService");
    slackService.notifyCodePush({
      projectName: repo.repo_name,
      committer: req.user?.username || "benevolate",
      branch,
      commitMsg: message,
      commitHash: result.commit?.sha || result.commit?.commitId || "latest"
    }).catch(() => {});

    res.json({ ok: true, commit: result.commit, content: result.content });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// POST /api/files/upload — commit multiple files in one go (multi-file commit)
// Body: { repositoryId, projectId, repo, branch, message, files: [{ path, content }], changeRequestId? }
router.post("/files/upload", async (req, res) => {
  try {
    const { branch, message, files, changeRequestId } = req.body;
    if (!branch || !message || !Array.isArray(files) || !files.length) {
      return res.status(400).json({ ok: false, error: "branch, message, and files[] are required" });
    }

    const repo = await requireRepo(req, res);
    if (!repo) return;

    const provider = getProvider(repo.provider);
    const committer = { name: req.user?.username || "benevolate", email: `${req.user?.username || "benevolate"}@benevolate.internal` };
    const token = repo.provider === "github" ? await getGithubToken(req) : null;
    const ownerOrRegion = repo.provider === "github" ? repo.owner : repo._region;

    const result = await provider.createMultiFileCommit(ownerOrRegion, repo.repo_name, branch, files, message, committer, token);

    // Record each file in the CR if provided
    if (changeRequestId && repo.id) {
      for (const f of files) {
        await crStore.addFile({
          changeRequestId,
          filePath: f.path,
          changeType: "modified",
          additions: typeof f.content === "string" ? f.content.split("\n").length : 0,
          deletions: 0
        });
      }
    }

    res.json({ ok: true, sha: result?.sha, message: result?.message || message, filesCommitted: files.length });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// POST /api/files/extract-zip — parse uploaded ZIP in memory and return extracted text files
router.post("/files/extract-zip", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "No ZIP file uploaded" });
    const directory = await unzipper.Open.buffer(req.file.buffer);
    const files = [];
    for (const file of directory.files) {
      if (file.type === "File" && !file.path.includes("__MACOSX") && !file.path.startsWith(".")) {
        const contentBuf = await file.buffer();
        // Skip binary / huge files > 1MB
        if (contentBuf.length < 1024 * 1024 && !contentBuf.includes(0)) {
          files.push({
            path: file.path,
            content: contentBuf.toString("utf8")
          });
        }
      }
    }
    res.json({ ok: true, files });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/files/github-fetch-files — fetch text files from a connected GitHub repo for integration
router.post("/files/github-fetch-files", async (req, res) => {
  try {
    const { githubRepo, branch } = req.body;
    if (!githubRepo) return res.status(400).json({ ok: false, error: "githubRepo is required" });
    const token = await getGithubToken(req);
    if (!token) return res.status(401).json({ ok: false, requiresOAuth: true, error: "GitHub OAuth token not found" });

    const parts = githubRepo.split("/");
    const owner = parts[0];
    const repoName = parts[1] || parts[0];

    const githubProvider = getProvider("github");
    const ref = branch || "main";
    const tree = await githubProvider.getTree(owner, repoName, ref, true, "", token);

    const fileItems = (tree || []).filter(item => item.type === "blob" || item.type === "file");
    const fetchedFiles = [];

    // Fetch up to 30 text files
    for (const item of fileItems.slice(0, 30)) {
      try {
        const fileRes = await githubProvider.getFileContent(owner, repoName, item.path, ref, token);
        if (fileRes && fileRes.content !== undefined) {
          fetchedFiles.push({ path: item.path, content: fileRes.content });
        }
      } catch (_) {}
    }

    res.json({ ok: true, files: fetchedFiles });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /api/files/content — delete a file or folder with a commit
// Body: { repositoryId, repo, projectId, path, message, branch, sha, isFolder? }
router.delete("/files/content", async (req, res) => {
  try {
    const { path: filePath, message, branch, isFolder } = req.body;
    if (!filePath || !message || !branch) {
      return res.status(400).json({ ok: false, error: "path, message, and branch are required" });
    }

    const repo = await requireRepo(req, res);
    if (!repo) return;

    const provider = getProvider(repo.provider);
    const committer = { name: req.user?.username || "benevolate", email: `${req.user?.username || "benevolate"}@benevolate.internal` };
    const token = repo.provider === "github" ? await getGithubToken(req) : null;
    const ownerOrRegion = repo.provider === "github" ? repo.owner : repo._region;

    if (isFolder) {
      // Fetch sub-tree under folder and delete all contained blob files
      const fullTree = repo.provider === "github"
        ? await provider.getTree(ownerOrRegion, repo.repo_name, branch, true, filePath, token)
        : await provider.getTree(ownerOrRegion, repo.repo_name, branch, true, filePath);
      const blobFiles = (fullTree || []).filter(item => item.type === "blob" || item.type === "file");
      for (const item of blobFiles) {
        try {
          await provider.deleteFile(ownerOrRegion, repo.repo_name, item.path, `Delete ${item.path} in ${filePath}`, branch, null, committer, token);
        } catch (_) {}
      }
      res.json({ ok: true, deletedFolder: filePath, filesDeleted: blobFiles.length });
    } else {
      await provider.deleteFile(ownerOrRegion, repo.repo_name, filePath, message, branch, req.body.sha || null, committer, token);
      res.json({ ok: true });
    }
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// GET /api/repositories?projectId= — list repos for a project
router.get("/repositories", async (req, res) => {
  try {
    const { projectId } = req.query;
    if (!projectId) return res.status(400).json({ ok: false, error: "projectId is required" });
    const repos = await repoStore.listRepositories(projectId);
    res.json({ ok: true, repositories: repos });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/repositories — create/register a new repository for a project
router.post("/repositories", async (req, res) => {
  try {
    const { projectId, provider, owner, repoName, defaultBranch, cloneUrl } = req.body;
    if (!projectId || !provider || !repoName) {
      return res.status(400).json({ ok: false, error: "projectId, provider, and repoName are required" });
    }
    const repo = await repoStore.createRepository({
      projectId, provider, owner, repoName, defaultBranch, cloneUrl, createdBy: req.user.username
    });
    res.json({ ok: true, repository: repo });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/repos/:id/propose-change — creates a new branch, commits the file, and creates a Change Request
router.post("/repos/:id/propose-change", async (req, res) => {
  try {
    const { id } = req.params;
    const { path: filePath, branch: baseBranch, newContent, title, commitMessage, description } = req.body;
    
    if (!id || !filePath || !baseBranch || !newContent || !title) {
      return res.status(400).json({ ok: false, error: "Missing required fields" });
    }

    const repo = await repoStore.getRepository(id);
    if (!repo) return res.status(404).json({ ok: false, error: "Repository not found" });

    const provider = getProvider(repo.provider);
    
    // 1. Generate a new feature branch name
    const branchName = `propose/${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}-${Date.now().toString(36)}`;
    
    // 2. Create the branch off the base branch
    await provider.createBranch(repo.owner, repo.repo_name, branchName, baseBranch);
    
    // 3. Record the branch in the database
    const { pool } = require("../config/db");
    const crypto = require("crypto");
    const branchId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO branches (id, repository_id, name, base_branch, status, created_by) VALUES (?, ?, ?, ?, 'active', ?)`,
      [branchId, id, branchName, baseBranch, req.user.username]
    );

    // 4. Update the file on the new branch
    const committer = { name: req.user.username, email: `${req.user.username}@benevolate.internal` };
    
    // Try to get the existing file SHA if it exists, otherwise it's a new file
    let sha = null;
    try {
      const fileData = await provider.getFileContent(repo.owner, repo.repo_name, filePath, baseBranch);
      sha = fileData.sha;
    } catch (e) {
      // File doesn't exist, which is fine for new files
    }

    const commitResult = await provider.updateFile(repo.owner, repo.repo_name, filePath, newContent, commitMessage || `Update ${filePath}`, branchName, sha, committer);

    // 5. Create the Change Request
    const cr = await crStore.createChangeRequest({
      repositoryId: id,
      branchId,
      title,
      description: description || null,
      author: req.user.username,
      baseBranch,
      headBranch: branchName,
      isQuickEdit: true
    });

    // 6. Record the file change
    await crStore.addFile({
      changeRequestId: cr.id,
      filePath,
      changeType: sha ? "modified" : "added",
      additions: newContent.split("\\n").length,
      deletions: 0,
      blobSha: commitResult.content?.sha
    });

    res.json({ ok: true, changeRequest: cr });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// POST /api/files/upload-zip — extract a ZIP archive and commit all files to the repo
// Multipart form: zipFile (file), repositoryId, branch, message
router.post("/files/upload-zip", upload.single("zipFile"), async (req, res) => {
  try {
    const { repositoryId, branch, message } = req.body;
    if (!repositoryId || !branch || !message) {
      return res.status(400).json({ ok: false, error: "repositoryId, branch, and message are required" });
    }
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "No ZIP file uploaded" });
    }

    const repo = await repoStore.getRepository(repositoryId);
    if (!repo) return res.status(404).json({ ok: false, error: "Repository not found" });
    if (repo.provider === "codecommit" && repo.project_id) {
      try { const p = await projectStore.getProject(repo.project_id); if (p?.region) repo._region = p.region; } catch {}
    }

    // Extract ZIP from buffer
    const directory = await unzipper.Open.buffer(req.file.buffer);
    const files = [];

    for (const entry of directory.files) {
      if (entry.type === "Directory") continue;
      // Skip hidden git internals and OS junk
      const entryPath = entry.path;
      const basename = path.basename(entryPath);
      if (basename === ".DS_Store" || basename === "Thumbs.db") continue;
      // Skip .git directory contents
      if (entryPath.startsWith(".git/") || entryPath.includes("/.git/")) continue;

      const content = await entry.buffer();
      // Only handle text files (skip binary by checking for null bytes)
      const isBinary = content.includes(0x00);
      files.push({
        path: entryPath,
        content: isBinary ? "" : content.toString("utf-8"),
        isBinary
      });
    }

    const textFiles = files.filter(f => !f.isBinary);
    if (!textFiles.length) {
      return res.status(400).json({ ok: false, error: "No text files found in ZIP (binary files are skipped)" });
    }

    // Commit all files using the provider's multi-file commit
    const provider = getProvider(repo.provider);
    const committer = { name: req.user.username, email: `${req.user.username}@benevolate.internal` };
    await provider.createMultiFileCommit(
      repo._region || repo.owner,
      repo.repo_name,
      branch,
      textFiles.map(f => ({ path: f.path, content: f.content })),
      message,
      committer
    );

    res.json({ ok: true, filesCommitted: textFiles.length, skippedBinary: files.length - textFiles.length });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// POST /api/files/parse-zip — extract a ZIP archive and return list of extracted text files for side-by-side diff
router.post("/files/parse-zip", upload.single("zipFile"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "No ZIP file uploaded" });
    }

    const directory = await unzipper.Open.buffer(req.file.buffer);
    const files = [];

    for (const entry of directory.files) {
      if (entry.type === "Directory") continue;
      const entryPath = entry.path;
      const basename = path.basename(entryPath);
      if (basename === ".DS_Store" || basename === "Thumbs.db") continue;
      if (entryPath.startsWith(".git/") || entryPath.includes("/.git/")) continue;

      const content = await entry.buffer();
      const isBinary = content.includes(0x00);
      if (!isBinary) {
        files.push({
          path: entryPath,
          content: content.toString("utf-8")
        });
      }
    }

    res.json({ ok: true, files });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/files/upload-zip-commit — commit array of parsed files directly
router.post("/files/upload-zip-commit", async (req, res) => {
  try {
    const { branch, message, files } = req.body;
    if (!branch || !message || !Array.isArray(files)) {
      return res.status(400).json({ ok: false, error: "branch, message, and files array are required" });
    }

    const repo = await requireRepo(req, res);
    if (!repo) return;

    const provider = getProvider(repo.provider);
    const committer = { name: req.user.username, email: `${req.user.username}@benevolate.internal` };
    await provider.createMultiFileCommit(
      repo._region || repo.owner,
      repo.repo_name,
      branch,
      files.map(f => ({ path: f.path, content: f.content })),
      message,
      committer
    );

    res.json({ ok: true, filesCommitted: files.length });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// POST /api/files/github-fetch-files — fetch repo tree & text files from GitHub using user's saved PAT
router.post("/files/github-fetch-files", async (req, res) => {
  try {
    const { githubRepo } = req.body;
    if (!githubRepo) return res.status(400).json({ ok: false, error: "githubRepo is required" });

    const credentialManager = require("../services/credentialManager");
    const creds = await credentialManager.listCredentials(req.user.username);
    const ghCred = creds.find(c => c.provider === "github");
    if (!ghCred) return res.status(400).json({ ok: false, error: "No saved GitHub PAT credential found" });

    const token = await credentialManager.getCredential(req.user.username, "github");

    // Get repository details first to determine default branch
    let defaultBranch = "main";
    let authHeader = `token ${token}`;
    try {
      let repoDetailsRes = await fetch(`https://api.github.com/repos/${githubRepo}`, {
        headers: { 
          "Authorization": authHeader, 
          "User-Agent": "Benevolate-App",
          "Accept": "application/vnd.github+json" 
        }
      });
      if (!repoDetailsRes.ok && repoDetailsRes.status === 401) {
        authHeader = `Bearer ${token}`;
        repoDetailsRes = await fetch(`https://api.github.com/repos/${githubRepo}`, {
          headers: { 
            "Authorization": authHeader, 
            "User-Agent": "Benevolate-App",
            "Accept": "application/vnd.github+json" 
          }
        });
      }
      if (repoDetailsRes.ok) {
        const repoDetails = await repoDetailsRes.json();
        defaultBranch = repoDetails.default_branch || "main";
      }
    } catch {}

    // Fetch repository tree recursively from GitHub API using the default branch or master
    let treeRes = await fetch(`https://api.github.com/repos/${githubRepo}/git/trees/${defaultBranch}?recursive=1`, {
      headers: { 
        "Authorization": authHeader, 
        "User-Agent": "Benevolate-App",
        "Accept": "application/vnd.github+json" 
      }
    });

    if (!treeRes.ok && defaultBranch !== "master") {
      // Fallback try 'master' or 'main'
      const altBranch = defaultBranch === "main" ? "master" : "main";
      const altTreeRes = await fetch(`https://api.github.com/repos/${githubRepo}/git/trees/${altBranch}?recursive=1`, {
        headers: { 
          "Authorization": authHeader, 
          "User-Agent": "Benevolate-App",
          "Accept": "application/vnd.github+json" 
        }
      });
      if (altTreeRes.ok) {
        treeRes = altTreeRes;
      }
    }

    let files = [];
    if (treeRes.ok) {
      const treeData = await treeRes.json();
      const blobItems = (treeData.tree || []).filter(item => item.type === "blob" && item.size < 500000); // max 500KB per file

      // Fetch contents of up to 30 text files
      for (const item of blobItems.slice(0, 30)) {
        if (item.path.startsWith(".git/") || item.path.includes("/.git/")) continue;
        try {
          const fileRes = await fetch(`https://api.github.com/repos/${githubRepo}/contents/${item.path}`, {
            headers: { 
              "Authorization": authHeader, 
              "User-Agent": "Benevolate-App",
              "Accept": "application/vnd.github.raw+json" 
            }
          });
          if (fileRes.ok) {
            const content = await fileRes.text();
            if (!content.includes("\0")) {
              files.push({ path: item.path, content });
            }
          }
        } catch {}
      }
    } else {
      // Fallback to contents API endpoint if trees API fails or returns 403 due to token scope limits
      const contentsRes = await fetch(`https://api.github.com/repos/${githubRepo}/contents`, {
        headers: { 
          "Authorization": authHeader, 
          "User-Agent": "Benevolate-App",
          "Accept": "application/vnd.github+json" 
        }
      });
      if (!contentsRes.ok) {
        if (contentsRes.status === 403) {
          return res.status(403).json({
            ok: false,
            error: `GitHub API error (403): Forbidden. Your Fine-Grained Personal Access Token does not have 'Contents' read access for private repository '${githubRepo}'. On GitHub, go to Settings -> Developer Settings -> Personal Access Tokens -> Fine-grained tokens -> Edit Token -> Repository permissions -> set 'Contents' to 'Read-only'.`
          });
        }
        return res.status(contentsRes.status).json({ ok: false, error: `GitHub API error (${contentsRes.status}): ${contentsRes.statusText}` });
      }
      const items = await contentsRes.json();
      for (const item of (Array.isArray(items) ? items : [])) {
        if (item.type === "file") {
          try {
            const fileRes = await fetch(item.download_url || item.url, {
              headers: { "Authorization": authHeader, "User-Agent": "Benevolate-App" }
            });
            if (fileRes.ok) {
              const content = await fileRes.text();
              if (!content.includes("\0")) files.push({ path: item.name, content });
            }
          } catch {}
        }
      }
    }

    res.json({ ok: true, files });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
