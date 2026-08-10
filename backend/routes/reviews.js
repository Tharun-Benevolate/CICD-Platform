// routes/reviews.js — Code review routes (comments, approvals, merge).
// Phase 2/3 implementation.

const router = require("express").Router();
const auth = require("../middleware/auth");
const auditStore = require("../stores/auditStore");
const crStore = require("../stores/changeRequestStore");
const repoStore = require("../stores/repositoryStore");
const { getProvider } = require("../services/gitProvider");

// Helper: load CR or 404
async function requireCR(req, res) {
  const cr = await crStore.getChangeRequest(req.params.id);
  if (!cr) { res.status(404).json({ ok: false, error: "Change request not found" }); return null; }
  return cr;
}

// POST /api/change-requests/:id/comments — add a review comment (admin/devops)
router.post("/change-requests/:id/comments", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const cr = await requireCR(req, res); if (!cr) return;
    const { body, filePath, lineNumber, commitSha } = req.body;
    if (!body) return res.status(400).json({ ok: false, error: "Comment body is required" });
    const comment = await crStore.addComment({
      changeRequestId: cr.id,
      author: req.user.username,
      body, filePath, lineNumber, commitSha
    });
    // Mark CR as 'reviewing' if it was 'open'
    if (cr.status === "open") await crStore.updateChangeRequest(cr.id, { status: "reviewing" });
    res.json({ ok: true, comment });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PATCH /api/reviews/comments/:id/resolve — resolve a comment (author or admin)
router.patch("/reviews/comments/:id/resolve", async (req, res) => {
  try {
    await crStore.resolveComment(req.params.id, req.user.username);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/change-requests/:id/approve — approve a CR (admin/devops)
router.post("/change-requests/:id/approve", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const cr = await requireCR(req, res); if (!cr) return;
    if (!["open","reviewing"].includes(cr.status)) {
      return res.status(400).json({ ok: false, error: `Cannot approve a CR in "${cr.status}" status` });
    }
    await crStore.addApproval({ changeRequestId: cr.id, reviewer: req.user.username, decision: "approved", comment: req.body.comment });

    // Check if we should auto-merge (min_approvals met — for now 1 = enough)
    const approvals = await crStore.getApprovals(cr.id);
    const approved = approvals.filter(a => a.decision === "approved");
    if (approved.length >= 1) {
      // Attempt merge
      const repo = await repoStore.getRepository(cr.repository_id);
      if (repo) {
        try {
          const provider = getProvider(repo.provider);
          const mergeResult = await provider.mergeBranches(repo.owner, repo.repo_name, cr.base_branch, cr.head_branch,
            `Merge "${cr.head_branch}" into ${cr.base_branch} (CR: ${cr.title})`, "squash");
          await crStore.updateChangeRequest(cr.id, {
            status: "merged",
            mergedBy: req.user.username,
            mergedAt: new Date(),
            mergeSha: mergeResult.sha || null
          });
          auditStore.logAction(req.user.username, `Approved and merged CR: "${cr.title}"`, repo.repo_name, "Success", "Code Review");
          return res.json({ ok: true, status: "merged", mergeResult });
        } catch (mergeErr) {
          // Merge failed — still mark as approved so admin can retry
          await crStore.updateChangeRequest(cr.id, { status: "approved" });
          auditStore.logAction(req.user.username, `Approved CR: "${cr.title}" (merge failed: ${mergeErr.message})`, cr.repository_id, "Success", "Code Review");
          return res.json({ ok: true, status: "approved", mergeError: mergeErr.message });
        }
      }
    } else {
      await crStore.updateChangeRequest(cr.id, { status: "approved" });
    }

    auditStore.logAction(req.user.username, `Approved CR: "${cr.title}"`, cr.repository_id, "Success", "Code Review");
    res.json({ ok: true, status: "approved" });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/change-requests/:id/reject — reject a CR (admin/devops)
router.post("/change-requests/:id/reject", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const cr = await requireCR(req, res); if (!cr) return;
    const { comment } = req.body;
    if (!comment) return res.status(400).json({ ok: false, error: "A rejection comment/reason is required" });
    await crStore.addApproval({ changeRequestId: cr.id, reviewer: req.user.username, decision: "rejected", comment });
    await crStore.updateChangeRequest(cr.id, { status: "rejected" });
    auditStore.logAction(req.user.username, `Rejected CR: "${cr.title}" — ${comment}`, cr.repository_id, "Success", "Code Review");
    res.json({ ok: true, status: "rejected" });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/change-requests/:id/request-changes — request changes (admin/devops)
router.post("/change-requests/:id/request-changes", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const cr = await requireCR(req, res); if (!cr) return;
    const { comment } = req.body;
    if (!comment) return res.status(400).json({ ok: false, error: "A comment describing the required changes is required" });
    await crStore.addApproval({ changeRequestId: cr.id, reviewer: req.user.username, decision: "changes_requested", comment });
    await crStore.updateChangeRequest(cr.id, { status: "reviewing" });
    auditStore.logAction(req.user.username, `Requested changes on CR: "${cr.title}" — ${comment}`, cr.repository_id, "Success", "Code Review");
    res.json({ ok: true, status: "reviewing" });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/change-requests/pending-reviews — admin review queue
router.get("/change-requests/pending-reviews", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const pending = await crStore.getMyPendingReviews(req.user.username);
    res.json({ ok: true, changeRequests: pending });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
