// betaImageStore.js — Stores ECR image URIs produced by Ad-Hoc CodeBuild runs.
// Images are saved automatically when a build SUCCEEDS and listed on the
// Beta Environment page as a dropdown so users never have to copy-paste URIs.
//
// Retention policy:
//   - Keep ALL images until manually deleted.
//   - Auto-delete images that are BOTH:
//       (a) older than 10 days, AND
//       (b) have never been deployed to the beta service (deployed_at IS NULL).
//   cleanupStaleImages() is called once on server startup.

const { randomUUID } = require("crypto");
const { pool } = require("../config/db");

// Self-healing schema — safe to run on every startup.
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS beta_images (
      id          VARCHAR(64)    NOT NULL,
      project_id  VARCHAR(64)    NOT NULL,
      image_uri   VARCHAR(1024)  NOT NULL,
      branch      VARCHAR(255)   NULL,
      commit_sha  VARCHAR(64)    NULL,
      build_id    VARCHAR(255)   NULL,
      built_by    VARCHAR(128)   NULL,
      deployed_at DATETIME       NULL,
      created_at  DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_beta_image_build (project_id, build_id),
      INDEX idx_beta_images_project (project_id),
      INDEX idx_beta_images_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
}

// List all stored images for a project, newest first.
async function listImages(projectId, limit = 50) {
  const [rows] = await pool.query(
    `SELECT id, project_id AS projectId, image_uri AS imageUri, branch,
            commit_sha AS commitSha, build_id AS buildId, built_by AS builtBy,
            deployed_at AS deployedAt, created_at AS createdAt
     FROM beta_images
     WHERE project_id = ?
     ORDER BY created_at DESC
     LIMIT ?`,
    [projectId, limit]
  );
  return rows;
}

// Save a new image entry. Uses INSERT IGNORE so repeated polls on the same
// succeeded build don't create duplicate rows (project_id + build_id unique key).
async function saveImage({ projectId, imageUri, branch, commitSha, buildId, builtBy }) {
  if (!projectId || !imageUri) throw new Error("projectId and imageUri are required");
  const id = randomUUID();
  await pool.query(
    `INSERT IGNORE INTO beta_images
       (id, project_id, image_uri, branch, commit_sha, build_id, built_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, projectId, imageUri, branch || null, commitSha || null, buildId || null, builtBy || null]
  );
  return { id, projectId, imageUri, branch, commitSha, buildId, builtBy, createdAt: new Date().toISOString() };
}

// Mark an image as deployed to the beta service (sets deployed_at = NOW()).
// This protects it from the 10-day auto-cleanup.
async function markDeployed(imageId) {
  if (!imageId) return;
  await pool.query(`UPDATE beta_images SET deployed_at = NOW() WHERE id = ?`, [imageId]);
}

// Manually delete a single image by ID.
async function deleteImage(imageId) {
  const [result] = await pool.query(`DELETE FROM beta_images WHERE id = ?`, [imageId]);
  return result.affectedRows > 0;
}

// Auto-cleanup: remove images that are older than 10 days AND were never deployed.
// Safe to call on every server startup.
async function cleanupStaleImages() {
  try {
    const [result] = await pool.query(
      `DELETE FROM beta_images
       WHERE deployed_at IS NULL
         AND created_at < DATE_SUB(NOW(), INTERVAL 10 DAY)`
    );
    if (result.affectedRows > 0) {
      console.log(`[betaImageStore] Auto-cleanup: removed ${result.affectedRows} stale beta image(s) (>10 days, never deployed).`);
    }
    return result.affectedRows;
  } catch (e) {
    console.warn("[betaImageStore] Cleanup skipped (table may not exist yet):", e.message);
    return 0;
  }
}

module.exports = { ensureSchema, listImages, saveImage, markDeployed, deleteImage, cleanupStaleImages };
