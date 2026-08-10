// Aurora MySQL-backed user store (replaces the DynamoDB "cicd-users" table).
const { pool } = require("../config/db");

async function ensureUsersTableExists() {
  // Table creation is handled by schema.sql against the Aurora cluster.
}

async function userCount() {
  const [rows] = await pool.query("SELECT COUNT(*) AS count FROM users");
  return rows[0].count;
}

async function createUser(username, hash, userType, options = {}) {
  const normalized = username.toLowerCase().trim();
  const { email = null, isProfileCompleted = 1, jobTitle = null } = options;

  let resolvedType = userType;
  if (!resolvedType) {
    const existing = await userCount();
    resolvedType = existing === 0 ? "super_admin" : "developer";
  }

  try {
    await pool.query(
      `INSERT INTO users (username, password_hash, user_type, email, is_profile_completed, job_title, is_blocked, last_active_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      [normalized, hash, resolvedType, email, isProfileCompleted ? 1 : 0, jobTitle || null, Date.now()]
    );
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      const dupErr = new Error("Username or Email already exists");
      dupErr.name = "ConditionalCheckFailedException";
      throw dupErr;
    }
    throw err;
  }

  return {
    username: normalized,
    userType: resolvedType,
    email,
    jobTitle: jobTitle || null,
    isProfileCompleted: isProfileCompleted ? 1 : 0,
    isBlocked: false,
    createdAt: new Date().toISOString()
  };
}

async function getUser(username) {
  if (!username) return null;
  const normalized = username.toLowerCase().trim();
  const [rows] = await pool.query(
    `SELECT username,
            password_hash AS hash,
            email,
            job_title AS jobTitle,
            user_type AS userType,
            is_profile_completed AS isProfileCompleted,
            is_blocked AS isBlocked,
            totp_secret AS totpSecret,
            totp_enabled AS totpEnabled,
            github_username AS githubUsername,
            avatar_url AS avatarUrl,
            last_active_at AS lastActiveAt,
            created_at AS createdAt,
            updated_at AS updatedAt
       FROM users
      WHERE username = ? OR email = ?`,
    [normalized, normalized]
  );
  if (!rows[0]) return null;
  const now = Date.now();
  const lastActive = Number(rows[0].lastActiveAt || 0);
  const isOnline = lastActive > 0 && (now - lastActive) <= (15 * 60 * 1000);
  return {
    ...rows[0],
    isProfileCompleted: !!rows[0].isProfileCompleted,
    isBlocked: !!rows[0].isBlocked,
    totpEnabled: !!rows[0].totpEnabled,
    isOnline
  };
}

async function listUsers() {
  const [rows] = await pool.query(
    `SELECT username, email, job_title AS jobTitle, user_type AS userType, is_profile_completed AS isProfileCompleted,
            is_blocked AS isBlocked, totp_enabled AS totpEnabled, github_username AS githubUsername, avatar_url AS avatarUrl,
            last_active_at AS lastActiveAt, created_at AS createdAt, updated_at AS updatedAt
       FROM users ORDER BY created_at DESC`
  );
  const now = Date.now();
  return rows.map(r => {
    const lastActive = Number(r.lastActiveAt || 0);
    const isOnline = lastActive > 0 && (now - lastActive) <= (15 * 60 * 1000);
    return {
      ...r,
      isProfileCompleted: !!r.isProfileCompleted,
      isBlocked: !!r.isBlocked,
      totpEnabled: !!r.totpEnabled,
      isOnline
    };
  });
}

async function updateLastActive(username) {
  if (!username) return;
  const normalized = username.toLowerCase().trim();
  await pool.query("UPDATE users SET last_active_at = ? WHERE username = ?", [Date.now(), normalized]);
}

async function setUserType(username, userType) {
  const normalized = username.toLowerCase().trim();
  const [result] = await pool.query(
    "UPDATE users SET user_type = ? WHERE username = ?",
    [userType, normalized]
  );
  return result.affectedRows > 0;
}

async function setBlockStatus(username, isBlocked) {
  const normalized = username.toLowerCase().trim();
  const [result] = await pool.query(
    "UPDATE users SET is_blocked = ? WHERE username = ?",
    [isBlocked ? 1 : 0, normalized]
  );
  return result.affectedRows > 0;
}

async function updateUserProfile(username, fields = {}) {
  const normalized = username.toLowerCase().trim();
  const updates = [];
  const values = [];

  if (fields.email !== undefined) { updates.push("email = ?"); values.push(fields.email); }
  if (fields.jobTitle !== undefined) { updates.push("job_title = ?"); values.push(fields.jobTitle); }
  if (fields.isProfileCompleted !== undefined) { updates.push("is_profile_completed = ?"); values.push(fields.isProfileCompleted ? 1 : 0); }
  if (fields.passwordHash !== undefined) { updates.push("password_hash = ?"); values.push(fields.passwordHash); }
  if (fields.totpSecret !== undefined) { updates.push("totp_secret = ?"); values.push(fields.totpSecret); }
  if (fields.totpEnabled !== undefined) { updates.push("totp_enabled = ?"); values.push(fields.totpEnabled ? 1 : 0); }

  if (!updates.length) return false;

  values.push(normalized);
  const [result] = await pool.query(
    `UPDATE users SET ${updates.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE username = ?`,
    values
  );
  return result.affectedRows > 0;
}

async function updateGithubProfile(username, githubUsername, avatarUrl) {
  const normalized = username.toLowerCase().trim();
  const [result] = await pool.query(
    "UPDATE users SET github_username = ?, avatar_url = ? WHERE username = ?",
    [githubUsername, avatarUrl, normalized]
  );
  return result.affectedRows > 0;
}

async function setTotpSecret(username, secret) {
  const normalized = username.toLowerCase().trim();
  const [result] = await pool.query(
    "UPDATE users SET totp_secret = ? WHERE username = ?",
    [secret, normalized]
  );
  return result.affectedRows > 0;
}

async function enableTotp(username, enabled = true) {
  const normalized = username.toLowerCase().trim();
  const [result] = await pool.query(
    "UPDATE users SET totp_enabled = ? WHERE username = ?",
    [enabled ? 1 : 0, normalized]
  );
  return result.affectedRows > 0;
}

module.exports = {
  ensureUsersTableExists,
  userCount,
  createUser,
  getUser,
  listUsers,
  updateLastActive,
  setUserType,
  setBlockStatus,
  updateUserProfile,
  updateGithubProfile,
  setTotpSecret,
  enableTotp
};

