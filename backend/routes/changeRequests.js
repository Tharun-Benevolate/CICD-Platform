// routes/changeRequests.js — Change Request (internal PR) routes.
// Phase 2 implementation.

const router = require("express").Router();
const auth = require("../middleware/auth");
const auditStore = require("../stores/auditStore");
const crStore = require("../stores/changeRequestStore");
const repoStore = require("../stores/repositoryStore");
const { getProvider } = require("../services/gitProvider");

// ─── Helpers ───────────────────────────────────────────────────────────────

// Generate a feature branch name from title
function generateBranchName(branchType, title) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40);
  return `${branchType}/${slug}-${Date.now().toString(36)}`;
}

// Load a repository or 404
async function requireRepo(req, res) {
  const repositoryId = req.query.repositoryId || req.body.repositoryId || req.params.repositoryId;
  if (!repositoryId) { res.status(400).json({ ok: false, error: "repositoryId is required" }); return null; }
  const repo = await repoStore.getRepository(repositoryId);
  if (!repo) { res.status(404).json({ ok: false, error: "Repository not found" }); return null; }
  return repo;
}

// Load a CR or 404
async function requireCR(req, res) {
  const cr = await crStore.getChangeRequest(req.params.id);
  if (!cr) { res.status(404).json({ ok: false, error: "Change request not found" }); return null; }
  return cr;
}

// ─── Routes ───────────────────────────────────────────────────────────────

// GET /api/change-requests — list with optional filters
router.get("/change-requests", async (req, res) => {
  try {
    const { repositoryId, author, status, limit, offset } = req.query;
    const crs = await crStore.listChangeRequests({ repositoryId, author, status, limit, offset });
    res.json({ ok: true, changeRequests: crs, total: crs.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/change-requests/:id — single CR with files and comments
router.get("/change-requests/:id", async (req, res) => {
  try {
    const cr = await requireCR(req, res); if (!cr) return;
    const [files, comments, approvals, commits] = await Promise.all([
      crStore.getFiles(cr.id),
      crStore.getComments(cr.id),
      crStore.getApprovals(cr.id),
      crStore.getCommits(cr.id)
    ]);
    res.json({ ok: true, changeRequest: { ...cr, files, comments, approvals, commits } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/change-requests — create a new CR (auto-creates feature branch)
router.post("/change-requests", async (req, res) => {
  try {
    const { repositoryId, title, description, branchType, isQuickEdit } = req.body;
    if (!repositoryId) return res.status(400).json({ ok: false, error: "repositoryId is required" });
    if (!title)        return res.status(400).json({ ok: false, error: "title is required" });

    const repo = await repoStore.getRepository(repositoryId);
    if (!repo) return res.status(404).json({ ok: false, error: "Repository not found" });

    const provider = getProvider(repo.provider);
    const author = req.user.username;
    const type = branchType || "feature";
    const customHeadBranch = req.body.headBranch || req.body.head_branch;
    const headBranch = customHeadBranch || generateBranchName(type, title);
    const baseBranch = req.body.baseBranch || req.body.base_branch || repo.default_branch || "main";

    // If customHeadBranch was not provided, create the feature branch
    if (!customHeadBranch) {
      try {
        await provider.createBranch(repo.owner, repo.repo_name, headBranch, baseBranch);
      } catch {}
    }

    // Record the branch in our platform DB if missing
    const { pool } = require("../config/db");
    const crypto = require("crypto");
    let [existingBranch] = await pool.query(`SELECT id FROM branches WHERE repository_id = ? AND name = ?`, [repositoryId, headBranch]).catch(() => [[]]);
    let branchId = existingBranch && existingBranch[0] ? existingBranch[0].id : null;
    if (!branchId) {
      branchId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO branches (id, repository_id, name, base_branch, status, created_by) VALUES (?, ?, ?, ?, 'active', ?)`,
        [branchId, repositoryId, headBranch, baseBranch, author]
      ).catch(() => {});
    }

    // Create the CR in 'draft' state
    const cr = await crStore.createChangeRequest({
      repositoryId, branchId, title, description, author, baseBranch, headBranch, isQuickEdit: !!isQuickEdit
    });

    auditStore.logAction(author, `Created Change Request: "${title}"`, repo.repo_name, "Success", "Change Requests");
    res.json({ ok: true, changeRequest: cr });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// PATCH /api/change-requests/:id — update title/description (author only)
router.patch("/change-requests/:id", async (req, res) => {
  try {
    const cr = await requireCR(req, res); if (!cr) return;
    if (cr.author !== req.user.username && !auth.ADMIN_ROLES.includes(req.user.userType)) {
      return res.status(403).json({ ok: false, error: "Only the author or an admin can edit a change request" });
    }
    const { title, description } = req.body;
    const updated = await crStore.updateChangeRequest(cr.id, { title, description });
    res.json({ ok: true, changeRequest: updated });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/change-requests/:id/submit — submit draft for review (author only)
router.post("/change-requests/:id/submit", async (req, res) => {
  try {
    const cr = await requireCR(req, res); if (!cr) return;
    if (cr.author !== req.user.username) {
      return res.status(403).json({ ok: false, error: "Only the author can submit a change request" });
    }
    if (cr.status !== "draft") {
      return res.status(400).json({ ok: false, error: `Cannot submit a CR in "${cr.status}" status. Only drafts can be submitted.` });
    }

    // Run a conflict check before opening
    const repo = await repoStore.getRepository(cr.repository_id);
    if (repo) {
      try {
        const provider = getProvider(repo.provider);
        const conflictResult = await provider.checkConflicts(repo.owner, repo.repo_name, cr.base_branch, cr.head_branch);
        if (conflictResult.hasConflicts) {
          await crStore.updateChangeRequest(cr.id, { status: "conflict" });
          return res.status(409).json({ ok: false, error: "This branch has merge conflicts with the base branch. Resolve them before submitting.", conflictResult });
        }

        // Get the diff stats from compare
        const diff = await provider.compareBranches(repo.owner, repo.repo_name, cr.base_branch, cr.head_branch);
        const additions = diff.files.reduce((s, f) => s + f.additions, 0);
        const deletions = diff.files.reduce((s, f) => s + f.deletions, 0);
        await crStore.updateChangeRequest(cr.id, {
          status: "open",
          filesChanged: diff.files.length,
          additions, deletions,
          headSha: diff.commits?.[diff.commits.length - 1]?.sha || null
        });

        // Record the changed files in our DB
        for (const f of diff.files) {
          await crStore.addFile({
            changeRequestId: cr.id,
            filePath: f.filename,
            changeType: f.status === "added" ? "added" : f.status === "removed" ? "deleted" : f.status === "renamed" ? "renamed" : "modified",
            additions: f.additions,
            deletions: f.deletions,
            patch: f.patch || null
          });
        }
      } catch (conflictErr) {
        console.error("Conflict check failed (non-fatal, opening anyway):", conflictErr.message);
        await crStore.updateChangeRequest(cr.id, { status: "open" });
      }
    } else {
      await crStore.updateChangeRequest(cr.id, { status: "open" });
    }

    const slackService = require("../services/slackService");
    auditStore.logAction(req.user.username, `Submitted CR for review: "${cr.title}"`, cr.repository_id, "Success", "Change Requests");
    slackService.notifyChangeRequestSubmitted({
      crId: cr.id,
      title: cr.title,
      requester: req.user.username,
      projectName: cr.repository_id
    }).catch(() => {});
    const updated = await crStore.getChangeRequest(cr.id);
    res.json({ ok: true, changeRequest: updated });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/change-requests/:id/close — close without merging (author or admin)
router.post("/change-requests/:id/close", async (req, res) => {
  try {
    const cr = await requireCR(req, res); if (!cr) return;
    const isAdmin = auth.ADMIN_ROLES.includes(req.user.userType);
    if (cr.author !== req.user.username && !isAdmin) {
      return res.status(403).json({ ok: false, error: "Only the author or an admin can close a change request" });
    }
    if (["merged", "closed"].includes(cr.status)) {
      return res.status(400).json({ ok: false, error: `CR is already ${cr.status}` });
    }
    const updated = await crStore.updateChangeRequest(cr.id, { status: "closed", closedAt: new Date() });
    auditStore.logAction(req.user.username, `Closed CR: "${cr.title}"`, cr.repository_id, "Success", "Change Requests");
    res.json({ ok: true, changeRequest: updated });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/change-requests/:id/diff — full diff via compare
router.get("/change-requests/:id/diff", async (req, res) => {
  try {
    const cr = await requireCR(req, res); if (!cr) return;
    const repo = await repoStore.getRepository(cr.repository_id);
    if (!repo) return res.status(404).json({ ok: false, error: "Repository not found" });
    const provider = getProvider(repo.provider);
    const diff = await provider.compareBranches(repo.owner, repo.repo_name, cr.base_branch, cr.head_branch);
    res.json({ ok: true, diff });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// GET /api/change-requests/:id/conflicts — live conflict check
router.get("/change-requests/:id/conflicts", async (req, res) => {
  try {
    const cr = await requireCR(req, res); if (!cr) return;
    const repo = await repoStore.getRepository(cr.repository_id);
    if (!repo) return res.status(404).json({ ok: false, error: "Repository not found" });
    const provider = getProvider(repo.provider);
    const result = await provider.checkConflicts(repo.owner, repo.repo_name, cr.base_branch, cr.head_branch);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// POST /api/change-requests/:id/merge — enforce policies and merge
router.post("/change-requests/:id/merge", async (req, res) => {
  try {
    const cr = await requireCR(req, res); if (!cr) return;
    if (cr.status !== "open" && cr.status !== "approved") {
      return res.status(400).json({ ok: false, error: `Cannot merge CR in status: ${cr.status}` });
    }

    const repo = await repoStore.getRepository(cr.repository_id);
    if (!repo) return res.status(404).json({ ok: false, error: "Repository not found" });
    
    // 1. Fetch branch policies for the base branch
    const { pool } = require("../config/db");
    const [policies] = await pool.query(
      `SELECT * FROM branch_policies WHERE repository_id = ? AND branch_pattern = ?`,
      [repo.id, cr.base_branch]
    );
    const policy = policies[0];

    if (policy) {
      // 2. Check min_approvals
      if (policy.require_review && policy.min_approvals > 0) {
        const [approvals] = await pool.query(
          `SELECT decision FROM approvals WHERE change_request_id = ?`,
          [cr.id]
        );
        const approvedCount = approvals.filter(a => a.decision === "approved").length;
        if (approvedCount < policy.min_approvals) {
          return res.status(403).json({
            ok: false,
            error: `Policy requires at least ${policy.min_approvals} approval(s). Currently has ${approvedCount}.`
          });
        }
      }

      // 3. Check require_ci_pass
      if (policy.require_ci_pass) {
        const provider = getProvider(repo.provider);
        if (provider.getCommitStatus) {
          // get the HEAD sha of the CR branch
          const branchData = await provider.getTree(repo.owner, repo.repo_name, cr.head_branch, false);
          // since getTree doesn't easily return the commit sha unless we use getCommits, let's fetch commits
          const commits = await provider.getCommits(repo.owner, repo.repo_name, cr.head_branch, 1);
          if (commits.length > 0) {
            const headSha = commits[0].sha;
            const ciStatus = await provider.getCommitStatus(repo.owner, repo.repo_name, headSha);
            if (ciStatus.state !== "success") {
              return res.status(403).json({
                ok: false,
                error: `Policy requires CI to pass. Current CI status is "${ciStatus.state}".`
              });
            }
          }
        }
      }
    }

    // 4. Merge via provider
    const provider = getProvider(repo.provider);
    const result = await provider.mergeBranches(
      repo.owner, repo.repo_name, cr.base_branch, cr.head_branch, 
      req.body.commitMessage || `Merge PR #${cr.id.split('-')[0]}`
    );

    if (result.alreadyUpToDate) {
      return res.status(400).json({ ok: false, error: "Branch is already up to date" });
    }

    // 5. Update CR status
    await crStore.updateChangeRequest(cr.id, {
      status: "merged",
      mergedAt: new Date(),
      mergedBy: req.user.username,
      mergeSha: result.sha
    });

    const notificationService = require("../services/notificationService");
    await notificationService.notify(
      cr.author, 
      "cr_merged", 
      `Change Request Merged`, 
      `Your Change Request "${cr.title}" was merged by ${req.user.username}.`,
      `#change-requests`,
      cr.id
    );

    const slackService = require("../services/slackService");
    slackService.notifyChangeRequestApproved({
      crId: cr.id,
      title: cr.title,
      approvedBy: req.user.username,
      requester: cr.author,
      projectName: cr.repository_id
    }).catch(() => {});

    auditStore.logAction(req.user.username, `Merged CR: "${cr.title}"`, cr.repository_id, "Success", "Change Requests");
    const updated = await crStore.getChangeRequest(cr.id);
    res.json({ ok: true, changeRequest: updated, mergeResult: result });
  } catch (err) {
    if (err.status === 409) {
      return res.status(409).json({ ok: false, error: "Merge conflict detected. Cannot merge." });
    }
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// POST /api/change-requests/:id/revert — admin creates a revert CR
router.post("/change-requests/:id/revert", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const cr = await requireCR(req, res); if (!cr) return;
    if (cr.status !== "merged") {
      return res.status(400).json({ ok: false, error: "Can only revert merged change requests" });
    }
    const repo = await repoStore.getRepository(cr.repository_id);
    if (!repo) return res.status(404).json({ ok: false, error: "Repository not found" });

    const revertTitle = `Revert: "${cr.title}"`;
    const revertBranch = generateBranchName("revert", cr.title);
    const provider = getProvider(repo.provider);

    await provider.createBranch(repo.owner, repo.repo_name, revertBranch, cr.base_branch);

    const { pool } = require("../config/db");
    const crypto = require("crypto");
    const branchId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO branches (id, repository_id, name, base_branch, status, created_by) VALUES (?, ?, ?, ?, 'active', ?)`,
      [branchId, cr.repository_id, revertBranch, cr.base_branch, req.user.username]
    );

    const revertCr = await crStore.createChangeRequest({
      repositoryId: cr.repository_id,
      branchId,
      title: revertTitle,
      description: `This reverts change request: ${cr.id} — "${cr.title}"`,
      author: req.user.username,
      baseBranch: cr.base_branch,
      headBranch: revertBranch,
      isQuickEdit: false
    });

    auditStore.logAction(req.user.username, `Created revert CR for: "${cr.title}"`, repo.repo_name, "Success", "Change Requests");
    res.json({ ok: true, changeRequest: revertCr });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// POST /api/change-requests/:id/comments — post comment/reply in CR 2-way discussion thread
router.post("/change-requests/:id/comments", async (req, res) => {
  try {
    const cr = await requireCR(req, res); if (!cr) return;
    const { body, filePath, lineNumber } = req.body;
    if (!body) return res.status(400).json({ ok: false, error: "Comment body is required" });

    const author = req.user?.username || "benevolate";
    const comment = await crStore.addComment({
      changeRequestId: cr.id,
      author,
      body,
      filePath: filePath || null,
      lineNumber: lineNumber || null
    });

    const slackService = require("../services/slackService");
    slackService.notifySlackChannel(`💬 **Change Request Discussion Comment** by @${author}:\n> "${body}"`).catch(() => {});

    auditStore.logAction(author, `Commented on CR: "${cr.title}"`, cr.repository_id || "platform", "Success", "Change Requests");
    res.json({ ok: true, comment });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
