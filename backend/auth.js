const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const userStore = require("./userStore");

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET must be set");
}

// Roles with full access to approvals and infrastructure create/destroy,
// per the 2026-07-02 project meeting. Developers and sales accounts are
// restricted to development-related activity only.
const ADMIN_ROLES = ["super_admin", "devops"];

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derivedKey = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derivedKey}`;
}

function verifyPassword(password, hash) {
  const [salt, key] = hash.split(":");
  const derivedKey = crypto.scryptSync(password, salt, 64).toString("hex");
  return key === derivedKey;
}

async function registerUser(username, password, userType) {
  if (!username || !password) return { ok: false, error: "Username and password required" };
  if (password.length < 6) return { ok: false, error: "Password must be at least 6 characters" };

  const existing = await userStore.getUser(username);
  if (existing) return { ok: false, error: "Username already exists" };

  try {
    const hash = hashPassword(password);
    // userStore assigns the role: the first account ever created becomes
    // super_admin; every account after that defaults to "developer" unless
    // an explicit userType is passed (admin-only UI flow).
    const user = await userStore.createUser(username, hash, userType || null);
    // Registration only creates the account — it does not issue a session token.
    // The user must log in separately with these credentials.
    return { ok: true, username: user.username, userType: user.userType };
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      return { ok: false, error: "Username already exists" };
    }
    throw err;
  }
}

async function loginUser(username, password) {
  if (!username || !password) return { ok: false, error: "Username and password required" };

  const user = await userStore.getUser(username);
  if (!user || !verifyPassword(password, user.hash)) {
    return { ok: false, error: "Invalid username or password" };
  }

  const token = jwt.sign({ username: user.username, userType: user.userType }, JWT_SECRET, { expiresIn: "24h" });
  return { ok: true, token, username: user.username, userType: user.userType };
}

async function googleSSOLogin(email) {
  if (!email || !email.endsWith("@benevolate.com")) {
    return { ok: false, error: "Unauthorized domain. Please use a @benevolate.com email." };
  }

  let user = await userStore.getUser(email);
  if (!user) {
    // Auto-register Google users with a random password they will never use
    const hash = hashPassword(crypto.randomBytes(32).toString("hex"));
    user = await userStore.createUser(email, hash, null);
  }

  const token = jwt.sign({ username: user.username, userType: user.userType }, JWT_SECRET, { expiresIn: "24h" });
  return { ok: true, token, username: user.username, userType: user.userType };
}

function decodeToken(req) {
  const token = req.cookies.auth_token;
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET); // { username, userType }
  } catch (err) {
    return null;
  }
}

function requireAuth(req, res, next) {
  const decoded = decodeToken(req);
  if (!decoded) {
    // sessionExpired is a deliberate marker the frontend uses to decide
    // whether to force the login modal open. Plain HTTP 401 alone isn't a
    // safe signal for that anymore — other integrations (e.g. github.js)
    // can legitimately fail with upstream 401s that have nothing to do
    // with this app's session. Only *this* middleware, the one actually
    // validating the app's own auth cookie, should ever set this flag.
    return res.status(401).json({ ok: false, error: "Authentication required", sessionExpired: true });
  }
  req.user = decoded; // { username, userType }
  next();
}

/**
 * Middleware factory restricting a route to specific user_type values.
 * Usage: app.post("/api/pipeline/approve", auth.requireRole(...auth.ADMIN_ROLES), ...)
 * Must run after requireAuth (or after the global /api auth middleware).
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    const decoded = req.user || decodeToken(req);
    if (!decoded) {
      return res.status(401).json({ ok: false, error: "Authentication required", sessionExpired: true });
    }
    if (!allowedRoles.includes(decoded.userType)) {
      return res.status(403).json({ ok: false, error: "You do not have permission to perform this action" });
    }
    req.user = decoded;
    next();
  };
}

function getLoggedInUser(req) {
  const decoded = decodeToken(req);
  return decoded ? decoded.username : null;
}

function getLoggedInUserType(req) {
  const decoded = decodeToken(req);
  return decoded ? decoded.userType : null;
}

module.exports = {
  registerUser,
  loginUser,
  googleSSOLogin,
  requireAuth,
  requireRole,
  getLoggedInUser,
  getLoggedInUserType,
  ADMIN_ROLES
};
