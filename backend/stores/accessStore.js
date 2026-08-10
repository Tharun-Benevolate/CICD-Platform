// stores/accessStore.js — Developer access control per project.

const { pool } = require("../config/db");
const crypto = require("crypto");

// Grant (or update) a user's access level on a project.
// Uses upsert so admins can call this to both grant and change level.
async function grantAccess({ projectId, username, accessLevel, grantedBy }) {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO developer_access (id, project_id, username, access_level, granted_by)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE access_level = VALUES(access_level), granted_by = VALUES(granted_by)`,
    [id, projectId, username, accessLevel, grantedBy || null]
  );
  return checkAccess(projectId, username);
}

async function revokeAccess(projectId, username) {
  await pool.query(
    "DELETE FROM developer_access WHERE project_id = ? AND username = ?",
    [projectId, username]
  );
  return true;
}

// All users with access to a specific project, with their display info.
async function getProjectAccess(projectId) {
  const [rows] = await pool.query(
    `SELECT da.*, u.github_username, u.avatar_url, u.email
       FROM developer_access da
       LEFT JOIN users u ON u.username = da.username
      WHERE da.project_id = ?
      ORDER BY da.created_at ASC`,
    [projectId]
  );
  return rows;
}

// All projects a specific user has access to, with access level.
async function getUserAccess(username) {
  const [rows] = await pool.query(
    `SELECT da.*, p.name AS project_name, p.data AS project_data
       FROM developer_access da
       LEFT JOIN projects p ON p.id = da.project_id
      WHERE da.username = ?
      ORDER BY da.created_at ASC`,
    [username]
  );
  return rows.map(row => ({
    ...row,
    projectName: row.project_name,
    // parse JSON project data to get display name
    project: (() => { try { return typeof row.project_data === "string" ? JSON.parse(row.project_data) : row.project_data; } catch { return null; } })()
  }));
}

// Returns the access_level string for a user on a project, or null if no access.
async function checkAccess(projectId, username) {
  const [rows] = await pool.query(
    "SELECT access_level FROM developer_access WHERE project_id = ? AND username = ? LIMIT 1",
    [projectId, username]
  );
  return rows.length ? rows[0].access_level : null;
}

module.exports = { grantAccess, revokeAccess, getProjectAccess, getUserAccess, checkAccess };
