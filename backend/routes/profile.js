// routes/profile.js — User profile and password management routes.

const router    = require("express").Router();
const auth      = require("../middleware/auth");
const userStore = require("../stores/userStore");
const { pool }  = require("../config/db");
const crypto    = require("crypto");

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derivedKey = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derivedKey}`;
}

function verifyPassword(password, hash) {
  if (!hash || !password) return false;
  const [salt, key] = hash.split(":");
  if (!salt || !key) return false;
  const derivedKey = crypto.scryptSync(password, salt, 64).toString("hex");
  return key === derivedKey;
}

// ── GET /api/me/profile ───────────────────────────────────────────
router.get("/me/profile", auth.requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT username, email, job_title, github_username, slack_id, avatar_url, user_type, is_profile_completed, totp_enabled, created_at
       FROM users WHERE username = ?`,
      [req.user.username]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: "User not found" });
    const u = rows[0];
    res.json({
      ok: true,
      username: u.username,
      email: u.email,
      jobTitle: u.job_title,
      githubUsername: u.github_username,
      slackId: u.slack_id,
      avatarUrl: u.avatar_url,
      userType: u.user_type,
      isProfileCompleted: !!u.is_profile_completed,
      totpEnabled: !!u.totp_enabled,
      createdAt: u.created_at
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post("/me/profile", auth.requireAuth, async (req, res) => {
  const { email, job_title, jobTitle, role, github_username, slack_id, avatar_url, username, newUsername } = req.body;
  const title = jobTitle || job_title || role;
  const sessionUsername = req.user.username;
  const targetUsername = (newUsername || username || "").trim();

  try {
    // Resolve current DB username for this logged-in account (by session username or email)
    const [userRows] = await pool.query(
      "SELECT username, email FROM users WHERE LOWER(username) = LOWER(?) OR (email IS NOT NULL AND email != '' AND LOWER(email) = LOWER(?))",
      [sessionUsername, req.user.email || '']
    );

    let currentDbUsername = sessionUsername;
    if (userRows.length > 0) {
      currentDbUsername = userRows[0].username;
    }

    let finalUsername = currentDbUsername;

    if (targetUsername && targetUsername.toLowerCase() !== currentDbUsername.toLowerCase()) {
      // Check if targetUsername is taken by ANOTHER account
      const [existing] = await pool.query(
        "SELECT username FROM users WHERE LOWER(username) = LOWER(?) AND LOWER(username) != LOWER(?)",
        [targetUsername, currentDbUsername]
      );
      if (existing.length) {
        return res.status(400).json({ ok: false, error: "Username is already taken by another account" });
      }

      await pool.query("SET FOREIGN_KEY_CHECKS = 0");
      try {
        await pool.query("UPDATE users SET username = ? WHERE username = ?", [targetUsername, currentDbUsername]);
        await pool.query("UPDATE repo_credentials SET username = ? WHERE username = ?", [targetUsername, currentDbUsername]);
        await pool.query("UPDATE developer_access SET username = ? WHERE username = ?", [targetUsername, currentDbUsername]);
        await pool.query("UPDATE developer_access SET granted_by = ? WHERE granted_by = ?", [targetUsername, currentDbUsername]);
        await pool.query("UPDATE notification_settings SET username = ? WHERE username = ?", [targetUsername, currentDbUsername]);
        await pool.query("UPDATE audit_log SET username = ? WHERE username = ?", [targetUsername, currentDbUsername]);
        await pool.query("UPDATE change_requests SET author = ? WHERE author = ?", [targetUsername, currentDbUsername]);
        await pool.query("UPDATE review_comments SET author = ? WHERE author = ?", [targetUsername, currentDbUsername]);
        await pool.query("UPDATE file_locks SET locked_by = ? WHERE locked_by = ?", [targetUsername, currentDbUsername]);
        await pool.query("UPDATE approvals SET approved_by = ? WHERE approved_by = ?", [targetUsername, currentDbUsername]);
      } finally {
        await pool.query("SET FOREIGN_KEY_CHECKS = 1");
      }
      finalUsername = targetUsername;
    }

    await pool.query(
      `UPDATE users SET email=?, job_title=?, github_username=?, slack_id=?, avatar_url=?, updated_at=NOW()
       WHERE username=?`,
      [email || null, title || null, github_username || null, slack_id || null, avatar_url || null, finalUsername]
    );

    const user = await userStore.getUser(finalUsername);
    if (user) {
      const newToken = auth.issueAuthToken(user);
      res.cookie("auth_token", newToken, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 });
    }

    res.json({ ok: true, username: finalUsername, jobTitle: title });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});




// ── POST /api/profile/complete — Onboarding completion ─────────────
router.post("/profile/complete", auth.requireAuth, async (req, res) => {
  const { email, password, username, jobTitle } = req.body;
  try {
    const user = await userStore.getUser(req.user.username);
    if (!user) return res.status(404).json({ ok: false, error: "User not found" });

    let newHash = user.hash;
    if (password) {
      const pwdErr = auth.validateStrongPassword(password);
      if (pwdErr) {
        return res.status(400).json({ ok: false, error: pwdErr });
      }
      newHash = hashPassword(password);
    }

    const targetEmail = email || user.email;
    await userStore.updateUserProfile(user.username, {
      email: targetEmail,
      hash: newHash,
      jobTitle: jobTitle || user.jobTitle || null,
      isProfileCompleted: 1
    });

    const updatedUser = await userStore.getUser(user.username);
    const newToken = auth.issueAuthToken(updatedUser);
    res.cookie("auth_token", newToken, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 });

    res.json({
      ok: true,
      username: updatedUser.username,
      email: updatedUser.email,
      userType: updatedUser.userType,
      jobTitle: updatedUser.jobTitle,
      isProfileCompleted: true,
      totpEnabled: updatedUser.totpEnabled
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/me/password or PATCH /api/profile/password ──────────
const passwordHandler = async (req, res) => {
  const { oldPassword, currentPassword, newPassword } = req.body;
  const current = currentPassword || oldPassword;
  
  const pwdErr = auth.validateStrongPassword(newPassword);
  if (pwdErr) {
    return res.status(400).json({ ok: false, error: pwdErr });
  }

  try {
    const [rows] = await pool.query(
      "SELECT password_hash FROM users WHERE username = ?",
      [req.user.username]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: "User not found" });

    if (rows[0].password_hash && current) {
      if (!verifyPassword(current, rows[0].password_hash)) {
        return res.status(401).json({ ok: false, error: "Current password is incorrect" });
      }
    }

    const newHash = hashPassword(newPassword);
    await pool.query(
      "UPDATE users SET password_hash=?, updated_at=NOW() WHERE username=?",
      [newHash, req.user.username]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};

router.post("/me/password", auth.requireAuth, passwordHandler);
router.patch("/profile/password", auth.requireAuth, passwordHandler);

// ── DELETE /api/users/:username — admin only ──────────────────────
router.delete("/users/:username", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  const target = req.params.username.toLowerCase().trim();
  const caller = req.user.username;

  if (target === caller) {
    return res.status(400).json({ ok: false, error: "You cannot delete your own account" });
  }

  try {
    const deleted = await userStore.deleteUser(target);
    if (!deleted) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }
    auditStore.logAction(
      caller,
      `Deleted user account "${target}"`,
      "N/A",
      "Success",
      "User Management"
    );
    res.json({ ok: true, deleted: target });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
