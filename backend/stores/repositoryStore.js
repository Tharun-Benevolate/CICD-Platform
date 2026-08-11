// stores/repositoryStore.js — CRUD for the `repositories` table.
// Follows the same pattern as projectStore.js (pool.query, crypto.randomUUID).

const { pool } = require("../config/db");
const crypto = require("crypto");

async function createRepository({ projectId, provider, owner, repoName, defaultBranch, cloneUrl, createdBy }) {
  const id = crypto.randomUUID();
  const now = new Date();
  await pool.query(
    `INSERT INTO repositories (id, project_id, provider, owner, repo_name, default_branch, clone_url, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, projectId, provider, owner || null, repoName, defaultBranch || "main", cloneUrl || null, createdBy || null, now, now]
  );
  return { id, projectId, provider, owner, repoName, defaultBranch: defaultBranch || "main", cloneUrl, createdBy, isActive: true, createdAt: now, updatedAt: now };
}

async function getRepository(id) {
  const [rows] = await pool.query("SELECT * FROM repositories WHERE id = ?", [id]);
  return rows[0] || null;
}

async function listRepositories(projectId) {
  if (!projectId) {
    const [rows] = await pool.query("SELECT * FROM repositories ORDER BY created_at DESC");
    return rows;
  }
  const [rows] = await pool.query(
    "SELECT * FROM repositories WHERE project_id = ? ORDER BY created_at DESC",
    [projectId]
  );
  return rows;
}

async function updateRepository(id, fields) {
  const allowed = ["provider","owner","repo_name","default_branch","clone_url","is_active"];
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    const col = k.replace(/[A-Z]/g, c => "_" + c.toLowerCase()); // camelCase → snake_case
    if (allowed.includes(col)) { sets.push(`${col} = ?`); vals.push(v); }
  }
  if (!sets.length) return getRepository(id);
  vals.push(id);
  await pool.query(`UPDATE repositories SET ${sets.join(", ")} WHERE id = ?`, vals);
  return getRepository(id);
}

async function deleteRepository(id) {
  await pool.query("DELETE FROM repositories WHERE id = ?", [id]);
  return true;
}

async function getRepositoryByOwnerAndName(owner, repoName) {
  const [rows] = await pool.query(
    "SELECT * FROM repositories WHERE owner = ? AND repo_name = ? LIMIT 1",
    [owner, repoName]
  );
  return rows[0] || null;
}

module.exports = { createRepository, getRepository, listRepositories, updateRepository, deleteRepository, getRepositoryByOwnerAndName };
