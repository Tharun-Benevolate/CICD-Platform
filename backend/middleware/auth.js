// middleware/auth.js — JWT session guard + Google SSO login helper + 2FA TOTP handling.

const jwt        = require("jsonwebtoken");
const crypto     = require("crypto");
const { OAuth2Client } = require("google-auth-library");
const userStore  = require("../stores/userStore");

const JWT_SECRET    = process.env.JWT_SECRET || "fallback-secret-change-in-production-12345";
const GOOGLE_CLIENT = process.env.GOOGLE_CLIENT_ID;

// Roles with full access to approvals and infrastructure create/destroy.
const ADMIN_ROLES = ["super_admin", "devops"];

// ── Password helpers ──────────────────────────────────────────────────────

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

function validateStrongPassword(password) {
  if (!password || password.length < 7) {
    return "Password must be at least 7 characters long.";
  }
  if (!/[A-Z]/.test(password)) {
    return "Password must contain at least one uppercase letter (A-Z).";
  }
  if (!/[a-z]/.test(password)) {
    return "Password must contain at least one lowercase letter (a-z).";
  }
  if (!/[0-9]/.test(password)) {
    return "Password must contain at least one number (0-9).";
  }
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
    return "Password must contain at least one special character (e.g. !@#$%^&*).";
  }
  return null;
}

function issueAuthToken(user) {
  const isCompleted = user.isProfileCompleted === 1 || user.isProfileCompleted === true;
  return jwt.sign(
    {
      username: user.username,
      userType: user.userType,
      email: user.email || null,
      jobTitle: user.jobTitle || null,
      isProfileCompleted: isCompleted,
      totpEnabled: !!user.totpEnabled
    },
    JWT_SECRET,
    { expiresIn: "24h" }
  );
}

// ── User registration ─────────────────────────────────────────────────────

async function registerUser(username, password, userType, email = null) {
  if (!username || !password) return { ok: false, error: "Username and password required" };
  const pwdErr = validateStrongPassword(password);
  if (pwdErr) return { ok: false, error: pwdErr };

  const existing = await userStore.getUser(username);
  if (existing) return { ok: false, error: "Username already exists" };

  try {
    const hash = hashPassword(password);
    const user = await userStore.createUser(username, hash, userType || null, { email, isProfileCompleted: 1 });
    return { ok: true, username: user.username, userType: user.userType };
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      return { ok: false, error: "Username or email already exists" };
    }
    throw err;
  }
}

// ── Password login ────────────────────────────────────────────────────────

async function loginUser(username, password) {
  if (!username || !password) return { ok: false, error: "Username and password required" };

  const user = await userStore.getUser(username);
  if (!user || !verifyPassword(password, user.hash)) {
    return { ok: false, error: "Invalid username or password" };
  }

  if (user.isBlocked) {
    return { ok: false, error: "Your account has been suspended by an administrator. Please contact IT support." };
  }

  // Check 2FA requirement
  if (user.totpEnabled) {
    const tempToken = jwt.sign(
      { username: user.username, pending2FA: true },
      JWT_SECRET,
      { expiresIn: "5m" }
    );
    return { ok: true, require2FA: true, tempToken, username: user.username };
  }

  const token = issueAuthToken(user);
  return {
    ok: true,
    token,
    username: user.username,
    userType: user.userType,
    email: user.email,
    jobTitle: user.jobTitle,
    isProfileCompleted: user.isProfileCompleted === 1 || user.isProfileCompleted === true,
    totpEnabled: user.totpEnabled
  };
}

// ── Google SSO login ──────────────────────────────────────────────────────

async function googleSSOLogin(credential) {
  if (!GOOGLE_CLIENT) {
    return { ok: false, error: "Google SSO is not configured. Set GOOGLE_CLIENT_ID in .env" };
  }

  let payload;
  try {
    const oauthClient = new OAuth2Client(GOOGLE_CLIENT);
    const ticket = await oauthClient.verifyIdToken({
      idToken:  credential,
      audience: GOOGLE_CLIENT,
    });
    payload = ticket.getPayload();
  } catch (err) {
    return { ok: false, error: `Google token verification failed: ${err.message}` };
  }

  const email = payload?.email;
  if (!email) return { ok: false, error: "Could not read email from Google token" };

  // Enforce @benevolate.com organization domain restriction
  const allowedDomain = process.env.GOOGLE_ALLOWED_DOMAIN || "benevolate.com";
  if (!email.toLowerCase().endsWith(`@${allowedDomain.toLowerCase()}`)) {
    return {
      ok: false,
      error: `Access restricted. Only @${allowedDomain} organization emails are permitted to sign in via Google OAuth.`
    };
  }

  // Check if account already exists by email or username
  let user = await userStore.getUser(email);
  if (!user) {
    const defaultUsername = email.split("@")[0].replace(/[^a-zA-Z0-9_]/g, "_");
    const dummyHash = hashPassword(crypto.randomBytes(32).toString("hex"));
    
    try {
      user = await userStore.createUser(defaultUsername, dummyHash, "developer", {
        email,
        isProfileCompleted: 0
      });
    } catch {
      const fallbackUsername = `user_${crypto.randomBytes(4).toString("hex")}`;
      user = await userStore.createUser(fallbackUsername, dummyHash, "developer", {
        email,
        isProfileCompleted: 0
      });
    }
  }

  if (user.isBlocked) {
    return { ok: false, error: "Your account has been suspended by an administrator. Please contact IT support." };
  }

  // Check 2FA requirement
  if (user.totpEnabled) {
    const tempToken = jwt.sign(
      { username: user.username, pending2FA: true },
      JWT_SECRET,
      { expiresIn: "5m" }
    );
    return { ok: true, require2FA: true, tempToken, username: user.username };
  }

  const token = issueAuthToken(user);
  return {
    ok: true,
    token,
    username: user.username,
    userType: user.userType,
    email: user.email,
    jobTitle: user.jobTitle,
    isProfileCompleted: user.isProfileCompleted === 1 || user.isProfileCompleted === true,
    totpEnabled: user.totpEnabled
  };
}

// ── Token decoder ─────────────────────────────────────────────────────────

function decodeToken(req) {
  let token = req.cookies?.auth_token;
  if (!token && req.headers.authorization) {
    const authHeader = req.headers.authorization;
    if (authHeader.startsWith("Bearer ")) {
      token = authHeader.substring(7).trim();
    }
  }

  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// ── Auth middleware ───────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const decoded = decodeToken(req);
  if (!decoded || decoded.pending2FA) {
    return res.status(401).json({ ok: false, error: "Authentication required", sessionExpired: true });
  }
  req.user = decoded;
  if (decoded.username) {
    userStore.updateLastActive(decoded.username).catch(() => {});
  }
  next();
}

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    const decoded = req.user || decodeToken(req);
    if (!decoded || decoded.pending2FA) {
      return res.status(401).json({ ok: false, error: "Authentication required", sessionExpired: true });
    }
    if (!allowedRoles.includes(decoded.userType)) {
      return res.status(403).json({ ok: false, error: "You do not have permission to perform this action" });
    }
    req.user = decoded;
    if (decoded.username) {
      userStore.updateLastActive(decoded.username).catch(() => {});
    }
    next();
  };
}

function getLoggedInUser(req)     { const d = decodeToken(req); return d && !d.pending2FA ? d.username : null; }
function getLoggedInUserType(req) { const d = decodeToken(req); return d && !d.pending2FA ? d.userType : null; }

module.exports = {
  registerUser,
  loginUser,
  googleSSOLogin,
  requireAuth,
  requireRole,
  getLoggedInUser,
  getLoggedInUserType,
  hashPassword,
  verifyPassword,
  validateStrongPassword,
  issueAuthToken,
  ADMIN_ROLES,
  JWT_SECRET
};
