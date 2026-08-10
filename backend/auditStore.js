// Aurora MySQL-backed audit log.
// Compatible with the existing cicd_admin.audit_log table (VARCHAR id PK)
// and expanded categories from the Updated Project feature set.
const { pool } = require("./db");

async function ensureAuditTableExists() {
  // Table creation is handled by schema.sql / migrate-local.js.
}

const VALID_CATEGORIES = [
  "Login", "Approvals", "Pipeline Executions", "Terraform",
  "User Management", "Change Requests", "Code Review",
  "Repository", "Access Control", "Notifications", "Settings", "Other"
];

function inferCategory(action) {
  const a = (action || "").toLowerCase();
  if (a.includes("logged in") || a.includes("logged out") || a.includes("login") || a.includes("registered")) return "Login";
  if (a.includes("approved") || a.includes("rejected") || a.includes("approval")) return "Approvals";
  if (a.includes("infrastructure")) return "Terraform";
  if (a.includes("pipeline") || a.includes("build") || a.includes("stage") || a.includes("deploy")) return "Pipeline Executions";
  if (a.includes("role") || a.includes("user type")) return "User Management";
  if (a.includes("change request") || a.includes(" merged ") || a.includes("cr ")) return "Change Requests";
  if (a.includes("review") || a.includes("comment")) return "Code Review";
  if (a.includes("access") || a.includes("granted") || a.includes("revoked")) return "Access Control";
  if (a.includes("credential") || a.includes("repository") || a.includes("repo")) return "Repository";
  return "Other";
}

async function logAction(user, action, projectName, result, category) {
  try {
    const id = Date.now().toString() + "-" + Math.random().toString(36).substring(2, 7);
    const resolvedCategory = VALID_CATEGORIES.includes(category) ? category : inferCategory(action);

    // Prefer legacy VARCHAR id schema (current Aurora). If the migrated
    // BIGINT/ext_id schema is in place, fall back to that insert shape.
    try {
      await pool.query(
        "INSERT INTO audit_log (id, timestamp, username, action, category, project_name, result) VALUES (?, NOW(3), ?, ?, ?, ?, ?)",
        [id, user || "system", action || "Unknown Action", resolvedCategory, projectName || "N/A", result || "Unknown"]
      );
    } catch (err) {
      if (err.code === "ER_BAD_FIELD_ERROR" || err.message.includes("ext_id")) {
        await pool.query(
          `INSERT INTO audit_log (ext_id, username, action, category, project_name, result)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [id, user || "system", action || "Unknown Action", resolvedCategory, projectName || "N/A", result || "Unknown"]
        );
      } else {
        throw err;
      }
    }
  } catch (err) {
    console.error("Failed to write to audit log:", err);
  }
}

async function getAuditLogs(filters = {}) {
  try {
    const conditions = [];
    const params = [];

    if (filters.username) {
      conditions.push("username = ?");
      params.push(filters.username.toLowerCase().trim());
    }
    if (filters.category && VALID_CATEGORIES.includes(filters.category)) {
      conditions.push("category = ?");
      params.push(filters.category);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Number.isInteger(filters.limit) ? filters.limit : 50;

    const [rows] = await pool.query(
      `SELECT id, timestamp, username AS user, action, category, project_name AS projectName, result
       FROM audit_log ${where} ORDER BY timestamp DESC LIMIT ?`,
      [...params, limit]
    );
    return rows.map(r => ({ ...r, timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : r.timestamp }));
  } catch (err) {
    console.error("Failed to read audit log:", err);
    return [];
  }
}

module.exports = { ensureAuditTableExists, logAction, getAuditLogs, VALID_CATEGORIES };
