// routes/access.js — Developer access control routes (admin only for writes).

const router = require("express").Router();
const auth = require("../middleware/auth");
const auditStore = require("../stores/auditStore");
const accessStore = require("../stores/accessStore");

// GET /api/projects/:id/access — list who has access to a project
router.get("/projects/:id/access", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const access = await accessStore.getProjectAccess(req.params.id);
    res.json({ ok: true, access });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/projects/:id/access — grant access to a user
router.post("/projects/:id/access", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const { username, accessLevel } = req.body;
    if (!username || !accessLevel) return res.status(400).json({ ok: false, error: "username and accessLevel required" });
    const VALID_LEVELS = ["pull", "push", "push_pull", "admin"];
    if (!VALID_LEVELS.includes(accessLevel)) return res.status(400).json({ ok: false, error: `accessLevel must be one of: ${VALID_LEVELS.join(", ")}` });

    await accessStore.grantAccess({ projectId: req.params.id, username, accessLevel, grantedBy: req.user.username });
    auditStore.logAction(req.user.username, `Granted "${accessLevel}" access to "${username}"`, req.params.id, "Success", "Access Control");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PATCH /api/projects/:id/access/:username — update an existing access level
router.patch("/projects/:id/access/:username", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const { accessLevel } = req.body;
    if (!accessLevel) return res.status(400).json({ ok: false, error: "accessLevel required" });
    await accessStore.grantAccess({ projectId: req.params.id, username: req.params.username, accessLevel, grantedBy: req.user.username });
    auditStore.logAction(req.user.username, `Updated access for "${req.params.username}" to "${accessLevel}"`, req.params.id, "Success", "Access Control");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /api/projects/:id/access/:username — revoke a user's access
router.delete("/projects/:id/access/:username", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    await accessStore.revokeAccess(req.params.id, req.params.username);
    auditStore.logAction(req.user.username, `Revoked access for "${req.params.username}"`, req.params.id, "Success", "Access Control");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/my/access — any user can see their own access list
router.get("/my/access", async (req, res) => {
  try {
    const access = await accessStore.getUserAccess(req.user.username);
    res.json({ ok: true, access });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
