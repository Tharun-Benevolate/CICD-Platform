// routes/auth.js — Authentication, user management, 2FA TOTP & profile setup.

const router = require("express").Router();
const jwt = require("jsonwebtoken");
const auth = require("../middleware/auth");
const auditStore = require("../stores/auditStore");
const userStore = require("../stores/userStore");
const totpService = require("../services/totpService");

// POST /api/register
router.post("/register", async (req, res) => {
  const { username, password, userType, email } = req.body;
  try {
    const callerType = req.user?.userType;
    const allowedToSetRole = callerType === "super_admin" || callerType === "devops";
    const result = await auth.registerUser(username, password, allowedToSetRole ? userType : null, email);
    if (result.ok) {
      auditStore.logAction(result.username, "User registered", "System", "Success", "User Management", req);
      res.json({ ok: true, username: result.username, userType: result.userType });
    } else {
      res.status(400).json(result);
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/login
router.post("/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await auth.loginUser(username, password);
    if (result.ok) {
      if (result.require2FA) {
        return res.json({
          ok: true,
          require2FA: true,
          tempToken: result.tempToken,
          username: result.username
        });
      }
      res.cookie("auth_token", result.token, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 });
      res.cookie("token", result.token, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 });
      auditStore.logAction(result.username, "User logged in", "System", "Success", "Login", req);
      res.json({
        ok: true,
        username: result.username,
        userType: result.userType,
        email: result.email,
        jobTitle: result.jobTitle,
        isProfileCompleted: result.isProfileCompleted,
        totpEnabled: result.totpEnabled
      });
    } else {
      auditStore.logAction(username, "Failed login attempt", "System", "Failed", "Login", req);
      res.status(401).json(result);
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/auth/google
router.post("/auth/google", async (req, res) => {
  const { credential } = req.body;
  try {
    const result = await auth.googleSSOLogin(credential);
    if (result.ok) {
      if (result.require2FA) {
        return res.json({
          ok: true,
          require2FA: true,
          tempToken: result.tempToken,
          username: result.username
        });
      }
      res.cookie("auth_token", result.token, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 });
      auditStore.logAction(result.username, "User logged in via Google SSO", "System", "Success", "Login", req);
      res.json({
        ok: true,
        username: result.username,
        userType: result.userType,
        email: result.email,
        jobTitle: result.jobTitle,
        isProfileCompleted: result.isProfileCompleted,
        totpEnabled: result.totpEnabled
      });
    } else {
      auditStore.logAction("google-user", "Failed Google SSO login", "System", "Failed", "Login", req);
      res.status(401).json(result);
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/auth/2fa/verify-login
router.post("/auth/2fa/verify-login", async (req, res) => {
  const { tempToken, code } = req.body;
  if (!tempToken || !code) {
    return res.status(400).json({ ok: false, error: "tempToken and authenticator code are required" });
  }

  try {
    let payload;
    try {
      payload = jwt.verify(tempToken, auth.JWT_SECRET);
    } catch {
      return res.status(401).json({ ok: false, error: "2FA challenge expired. Please sign in again." });
    }

    if (!payload.pending2FA || !payload.username) {
      return res.status(400).json({ ok: false, error: "Invalid 2FA challenge token" });
    }

    const user = await userStore.getUser(payload.username);
    if (!user || !user.totpSecret) {
      return res.status(400).json({ ok: false, error: "2FA is not enabled for this account" });
    }

    if (user.isBlocked) {
      return res.status(401).json({ ok: false, error: "Your account has been suspended by an administrator." });
    }

    const isValid = totpService.verifyTOTP(user.totpSecret, code);
    if (!isValid) {
      auditStore.logAction(user.username, "Failed 2FA code verification", "System", "Failed");
      return res.status(401).json({ ok: false, error: "Invalid 6-digit Authenticator code. Please check your phone." });
    }

    const token = auth.issueAuthToken(user);
    res.cookie("auth_token", token, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 });
    auditStore.logAction(user.username, "User completed 2FA login", "System", "Success");

    res.json({
      ok: true,
      username: user.username,
      userType: user.userType,
      email: user.email,
      jobTitle: user.jobTitle,
      isProfileCompleted: user.isProfileCompleted,
      totpEnabled: true
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── 2FA Setup Endpoints (Authenticated) ──────────────────────────────────

// POST /api/auth/2fa/setup — Generate fresh unique 2FA secret key & QR Code Data URL
router.post("/auth/2fa/setup", auth.requireAuth, async (req, res) => {
  try {
    const username = req.user.username;
    let user = await userStore.getUser(username);
    
    // Always generate a fresh unique secret key for this setup/refresh session
    const secret = totpService.generateSecret(20);
    await userStore.setTotpSecret(username, secret);

    const userLabel = user?.email ? `${user.email} (${username})` : username;
    const otpauthUrl = totpService.getOTPAuthURL(userLabel, secret);
    const qrCodeUrl = await totpService.getQRCodeDataURL(otpauthUrl);

    res.json({
      ok: true,
      secret,
      qrCodeUrl,
      otpauthUrl
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/auth/2fa/verify-setup — Verify setup code and enable 2FA
router.post("/auth/2fa/verify-setup", auth.requireAuth, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ ok: false, error: "6-digit code is required" });

  try {
    const username = req.user.username;
    const user = await userStore.getUser(username);
    if (!user || !user.totpSecret) {
      return res.status(400).json({ ok: false, error: "No 2FA secret set up. Call /api/auth/2fa/setup first." });
    }

    const isValid = totpService.verifyTOTP(user.totpSecret, code);
    if (!isValid) {
      return res.status(400).json({ ok: false, error: "Invalid code. Make sure your phone's clock is synced and enter the latest 6-digit code." });
    }

    await userStore.enableTotp(username, true);
    const updatedUser = { ...user, totpEnabled: true };
    const newToken = auth.issueAuthToken(updatedUser);
    res.cookie("auth_token", newToken, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 });

    auditStore.logAction(username, "Enabled 2FA Authenticator", "System", "Success");
    res.json({ ok: true, message: "Two-Factor Authentication enabled successfully!" });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/logout
router.post("/logout", (req, res) => {
  const user = auth.getLoggedInUser(req);
  if (user) auditStore.logAction(user, "User logged out", "System", "Success");
  // Clear both cookies with the same options they were set with
  res.clearCookie("auth_token", { httpOnly: true, path: "/" });
  res.clearCookie("token",      { httpOnly: true, path: "/" });
  res.json({ ok: true });
});

// GET /api/me
router.get("/me", async (req, res) => {
  const username = auth.getLoggedInUser(req);
  if (!username) {
    return res.status(401).json({ ok: false, error: "Not logged in" });
  }
  try {
    const user = await userStore.getUser(username);
    if (!user) return res.status(401).json({ ok: false, error: "User not found" });
    res.json({
      ok: true,
      username: user.username,
      userType: user.userType,
      email: user.email,
      jobTitle: user.jobTitle,
      isProfileCompleted: user.isProfileCompleted,
      isBlocked: user.isBlocked,
      totpEnabled: user.totpEnabled
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/audit-logs
router.get("/audit-logs", auth.requireAuth, async (req, res) => {
  const { user, category } = req.query;
  const logs = await auditStore.getAuditLogs({ username: user, category, limit: 200 });
  res.json({ ok: true, logs, categories: auditStore.VALID_CATEGORIES });
});

// --- Enterprise Admin User & Security Management (super_admin / devops only) ---

// GET /api/users
router.get("/users", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const users = await userStore.listUsers();
    res.json({ ok: true, users });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PATCH /api/users/:username/role
router.patch("/users/:username/role", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  const { userType } = req.body;
  const VALID_TYPES = ["super_admin", "devops", "developer", "sales"];
  if (!VALID_TYPES.includes(userType)) {
    return res.status(400).json({ ok: false, error: `userType must be one of: ${VALID_TYPES.join(", ")}` });
  }
  try {
    const updated = await userStore.setUserType(req.params.username, userType);
    if (!updated) return res.status(404).json({ ok: false, error: "User not found" });
    auditStore.logAction(
      req.user.username,
      `Changed role for "${req.params.username}" to "${userType}"`,
      "N/A",
      "Success",
      "User Management"
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PATCH /api/users/:username/block — Suspend or Unblock account
router.patch("/users/:username/block", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  const { isBlocked } = req.body;
  const target = req.params.username.toLowerCase().trim();
  if (target === req.user.username) {
    return res.status(400).json({ ok: false, error: "You cannot suspend your own account" });
  }
  try {
    const updated = await userStore.setBlockStatus(target, isBlocked);
    if (!updated) return res.status(404).json({ ok: false, error: "User not found" });
    auditStore.logAction(
      req.user.username,
      `${isBlocked ? "Suspended" : "Unblocked"} account for "${target}"`,
      "N/A",
      "Success",
      "User Management"
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PATCH /api/users/:username/approve — Admin approval for fresh user
router.patch("/users/:username/approve", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  const target = req.params.username.toLowerCase().trim();
  try {
    const updated = await userStore.updateUserProfile(target, { isProfileCompleted: 1 });
    if (!updated) return res.status(404).json({ ok: false, error: "User not found" });
    auditStore.logAction(
      req.user.username,
      `Approved signup for user "${target}"`,
      "N/A",
      "Success",
      "User Management"
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/admin/users/:username/details — User details + recent activity logs
router.get("/admin/users/:username/details", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  const target = req.params.username.toLowerCase().trim();
  try {
    const user = await userStore.getUser(target);
    if (!user) return res.status(404).json({ ok: false, error: "User not found" });
    const clientIp = auditStore.extractClientIp(req);
    const rawLogs = await auditStore.getAuditLogs({ username: user.username, limit: 15 });
    const userLogs = rawLogs.map(log => {
      if (!log.ipAddress || log.ipAddress === "127.0.0.1" || log.ipAddress === "::1") {
        return { ...log, ipAddress: clientIp !== "127.0.0.1" ? clientIp : (log.ipAddress || "127.0.0.1") };
      }
      return log;
    });
    
    res.json({
      ok: true,
      user: {
        username: user.username,
        email: user.email,
        jobTitle: user.jobTitle,
        userType: user.userType,
        isProfileCompleted: user.isProfileCompleted,
        isBlocked: user.isBlocked,
        totpEnabled: user.totpEnabled,
        githubUsername: user.githubUsername,
        avatarUrl: user.avatarUrl,
        isOnline: user.isOnline,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
      },
      activityLogs: userLogs
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /api/users/:username — Admin deletion of user account
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
