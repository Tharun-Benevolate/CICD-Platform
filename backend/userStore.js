// Aurora MySQL-backed user store (replaces the DynamoDB "cicd-users" table).
const { pool } = require("./db");

async function ensureUsersTableExists() {
  // Table creation is handled by schema.sql against the Aurora cluster.
  // This function is kept (as a no-op) so server.js's startup sequence,
  // which calls it unconditionally, does not need to change.
}

async function userCount() {
  const [rows] = await pool.query("SELECT COUNT(*) AS count FROM users");
  return rows[0].count;
}

async function createUser(username, hash, userType) {
  const normalized = username.toLowerCase().trim();

  // The first account ever created has no one to grant it admin access, so
  // it is automatically made super_admin. Every account after that defaults
  // to the least-privileged role and must be promoted by an existing admin
  // via PATCH /api/users/:username/role.
  let resolvedType = userType;
  if (!resolvedType) {
    const existing = await userCount();
    resolvedType = existing === 0 ? "super_admin" : "developer";
  }

  try {
    await pool.query(
      "INSERT INTO users (username, password_hash, user_type) VALUES (?, ?, ?)",
      [normalized, hash, resolvedType]
    );
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      const dupErr = new Error("Username already exists");
      dupErr.name = "ConditionalCheckFailedException"; // preserve the error name auth.js already checks for
      throw dupErr;
    }
    throw err;
  }

  return { username: normalized, userType: resolvedType, createdAt: new Date().toISOString() };
}

async function getUser(username) {
  const normalized = username.toLowerCase().trim();
  const [rows] = await pool.query(
    "SELECT username, password_hash AS hash, user_type AS userType, created_at AS createdAt FROM users WHERE username = ?",
    [normalized]
  );
  return rows[0] || null;
}

async function listUsers() {
  const [rows] = await pool.query(
    "SELECT username, user_type AS userType, created_at AS createdAt FROM users ORDER BY created_at ASC"
  );
  return rows;
}

async function setUserType(username, userType) {
  const normalized = username.toLowerCase().trim();
  const [result] = await pool.query(
    "UPDATE users SET user_type = ? WHERE username = ?",
    [userType, normalized]
  );
  return result.affectedRows > 0;
}

module.exports = { ensureUsersTableExists, createUser, getUser, listUsers, setUserType };
