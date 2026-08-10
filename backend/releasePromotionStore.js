// releasePromotionStore.js — tracks release → main merges that trigger pipeline runs.
// Used to enrich the Approvals page with who promoted, from which branch, and commit info.
const { randomUUID } = require("crypto");
const { pool } = require("./db");

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS release_promotions (
      id                     VARCHAR(64)   NOT NULL,
      project_id             VARCHAR(64)   NOT NULL,
      release_branch         VARCHAR(255)  NOT NULL,
      target_branch          VARCHAR(255)  NOT NULL DEFAULT 'main',
      triggered_by           VARCHAR(128)  NOT NULL,
      commit_sha             VARCHAR(64)   NULL,
      commit_message         TEXT          NULL,
      pipeline_execution_id  VARCHAR(128)  NULL,
      pipeline_name          VARCHAR(255)  NULL,
      status                 ENUM('pending','pipeline_started','completed','failed') NOT NULL DEFAULT 'pending',
      created_at             DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at             DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_rp_project     (project_id),
      INDEX idx_rp_execution   (pipeline_execution_id),
      INDEX idx_rp_project_ts  (project_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
}

async function createPromotion({
  projectId,
  releaseBranch,
  targetBranch,
  triggeredBy,
  commitSha,
  commitMessage,
  pipelineName,
  pipelineExecutionId
}) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO release_promotions
      (id, project_id, release_branch, target_branch, triggered_by, commit_sha, commit_message,
       pipeline_name, pipeline_execution_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      projectId,
      releaseBranch,
      targetBranch || "main",
      triggeredBy,
      commitSha || null,
      commitMessage || null,
      pipelineName || null,
      pipelineExecutionId || null,
      pipelineExecutionId ? "pipeline_started" : "pending"
    ]
  );
  return getPromotion(id);
}

async function getPromotion(id) {
  const [rows] = await pool.query(
    `SELECT id, project_id AS projectId, release_branch AS releaseBranch,
            target_branch AS targetBranch, triggered_by AS triggeredBy,
            commit_sha AS commitSha, commit_message AS commitMessage,
            pipeline_execution_id AS pipelineExecutionId, pipeline_name AS pipelineName,
            status, created_at AS createdAt, updated_at AS updatedAt
     FROM release_promotions WHERE id = ?`,
    [id]
  );
  return rows[0] || null;
}

async function updatePipelineExecution(id, pipelineExecutionId, status = "pipeline_started") {
  await pool.query(
    `UPDATE release_promotions
     SET pipeline_execution_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [pipelineExecutionId, status, id]
  );
  return getPromotion(id);
}

async function findByExecution(projectId, pipelineExecutionId) {
  if (!projectId || !pipelineExecutionId) return null;
  const [rows] = await pool.query(
    `SELECT id, project_id AS projectId, release_branch AS releaseBranch,
            target_branch AS targetBranch, triggered_by AS triggeredBy,
            commit_sha AS commitSha, commit_message AS commitMessage,
            pipeline_execution_id AS pipelineExecutionId, pipeline_name AS pipelineName,
            status, created_at AS createdAt
     FROM release_promotions
     WHERE project_id = ? AND pipeline_execution_id = ?
     ORDER BY created_at DESC LIMIT 1`,
    [projectId, pipelineExecutionId]
  );
  return rows[0] || null;
}

async function findLatestForProject(projectId, withinHours = 48) {
  const [rows] = await pool.query(
    `SELECT id, project_id AS projectId, release_branch AS releaseBranch,
            target_branch AS targetBranch, triggered_by AS triggeredBy,
            commit_sha AS commitSha, commit_message AS commitMessage,
            pipeline_execution_id AS pipelineExecutionId, pipeline_name AS pipelineName,
            status, created_at AS createdAt
     FROM release_promotions
     WHERE project_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
     ORDER BY created_at DESC LIMIT 1`,
    [projectId, withinHours]
  );
  return rows[0] || null;
}

module.exports = {
  ensureSchema,
  createPromotion,
  getPromotion,
  updatePipelineExecution,
  findByExecution,
  findLatestForProject
};
