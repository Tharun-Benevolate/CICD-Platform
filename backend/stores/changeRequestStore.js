// stores/changeRequestStore.js — CRUD for change_requests, change_request_files,
// review_comments, approvals, and commits tables.

const { pool } = require("../config/db");
const crypto = require("crypto");

// ─── Change Requests ───────────────────────────────────────────────────────

async function createChangeRequest({ repositoryId, branchId, title, description, author, baseBranch, headBranch, isQuickEdit }) {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO change_requests
       (id, repository_id, branch_id, title, description, author, status, base_branch, head_branch, is_quick_edit)
     VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
    [id, repositoryId, branchId || null, title, description || null, author, baseBranch || "main", headBranch, isQuickEdit ? 1 : 0]
  );
  return getChangeRequest(id);
}

async function getChangeRequest(id) {
  const [rows] = await pool.query(
    `SELECT cr.*, u.github_username, u.avatar_url
       FROM change_requests cr
       LEFT JOIN users u ON u.username = cr.author
      WHERE cr.id = ?`,
    [id]
  );
  return rows[0] || null;
}

async function listChangeRequests({ repositoryId, author, status, limit = 50, offset = 0 } = {}) {
  const conditions = [];
  const vals = [];
  if (repositoryId) { conditions.push("repository_id = ?"); vals.push(repositoryId); }
  if (author)       { conditions.push("author = ?");        vals.push(author); }
  if (status)       { conditions.push("status = ?");        vals.push(status); }

  const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
  const [rows] = await pool.query(
    `SELECT * FROM change_requests ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...vals, parseInt(limit), parseInt(offset)]
  );
  return rows;
}

async function updateChangeRequest(id, fields) {
  const allowed = ["title","description","status","head_sha","base_sha","merge_sha",
                   "files_changed","additions","deletions","merged_by","merged_at","closed_at"];
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    const col = k.replace(/[A-Z]/g, c => "_" + c.toLowerCase());
    if (allowed.includes(col)) { sets.push(`${col} = ?`); vals.push(v); }
  }
  if (!sets.length) return getChangeRequest(id);
  vals.push(id);
  await pool.query(`UPDATE change_requests SET ${sets.join(", ")} WHERE id = ?`, vals);
  return getChangeRequest(id);
}

// ─── Files ─────────────────────────────────────────────────────────────────

async function addFile({ changeRequestId, filePath, changeType, additions, deletions, patch, blobSha, oldPath }) {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO change_request_files
       (id, change_request_id, file_path, change_type, old_path, additions, deletions, patch, blob_sha)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, changeRequestId, filePath, changeType || "modified", oldPath || null, additions || 0, deletions || 0, patch || null, blobSha || null]
  );
  return { id, changeRequestId, filePath, changeType, additions, deletions, patch, blobSha };
}

async function getFiles(changeRequestId) {
  const [rows] = await pool.query(
    "SELECT * FROM change_request_files WHERE change_request_id = ? ORDER BY file_path ASC",
    [changeRequestId]
  );
  return rows;
}

async function removeFile(fileId) {
  await pool.query("DELETE FROM change_request_files WHERE id = ?", [fileId]);
  return true;
}

// ─── Comments ──────────────────────────────────────────────────────────────

async function addComment({ changeRequestId, author, body, filePath, lineNumber, commitSha }) {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO review_comments
       (id, change_request_id, author, body, file_path, line_number, commit_sha)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, changeRequestId, author, body, filePath || null, lineNumber || null, commitSha || null]
  );
  return { id, changeRequestId, author, body, filePath, lineNumber, commitSha, isResolved: false };
}

async function getComments(changeRequestId) {
  const [rows] = await pool.query(
    `SELECT rc.*, u.avatar_url
       FROM review_comments rc
       LEFT JOIN users u ON u.username = rc.author
      WHERE rc.change_request_id = ?
      ORDER BY rc.created_at ASC`,
    [changeRequestId]
  );
  return rows;
}

async function resolveComment(commentId, resolvedBy) {
  await pool.query(
    "UPDATE review_comments SET is_resolved = 1, resolved_by = ? WHERE id = ?",
    [resolvedBy, commentId]
  );
  return true;
}

// ─── Approvals ─────────────────────────────────────────────────────────────

async function addApproval({ changeRequestId, reviewer, decision, comment }) {
  const id = crypto.randomUUID();
  // One approval record per reviewer per CR (upsert on reviewer+CR)
  await pool.query(
    `INSERT INTO approvals (id, change_request_id, reviewer, decision, comment)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE decision = VALUES(decision), comment = VALUES(comment), id = id`,
    [id, changeRequestId, reviewer, decision, comment || null]
  );
  return { id, changeRequestId, reviewer, decision, comment };
}

async function getApprovals(changeRequestId) {
  const [rows] = await pool.query(
    "SELECT * FROM approvals WHERE change_request_id = ? ORDER BY created_at ASC",
    [changeRequestId]
  );
  return rows;
}

// Returns CRs with status 'open' or 'reviewing' — the admin review queue.
async function getMyPendingReviews(username) {
  const [rows] = await pool.query(
    `SELECT cr.* FROM change_requests cr
      WHERE cr.status IN ('open','reviewing')
        AND cr.author != ?
      ORDER BY cr.created_at ASC`,
    [username]
  );
  return rows;
}

// ─── Commits ───────────────────────────────────────────────────────────────

async function addCommit({ changeRequestId, repositoryId, sha, message, author, branchName, filesChanged }) {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO commits
       (id, change_request_id, repository_id, sha, message, author, branch_name, files_changed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, changeRequestId || null, repositoryId, sha, message, author, branchName || null, filesChanged || 0]
  );
  return { id, changeRequestId, repositoryId, sha, message, author, branchName, filesChanged };
}

async function getCommits(changeRequestId) {
  const [rows] = await pool.query(
    "SELECT * FROM commits WHERE change_request_id = ? ORDER BY created_at ASC",
    [changeRequestId]
  );
  return rows;
}

module.exports = {
  createChangeRequest, getChangeRequest, listChangeRequests, updateChangeRequest,
  addFile, getFiles, removeFile,
  addComment, getComments, resolveComment,
  addApproval, getApprovals, getMyPendingReviews,
  addCommit, getCommits
};
