// Aurora MySQL-backed audit log (replaces the DynamoDB "cicd-audit-log" table).
const { pool } = require("../config/db");

async function ensureAuditTableExists() {
  // Table creation is handled by schema.sql against the Aurora cluster.
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
  return "Other";
}

function extractClientIp(reqOrIp) {
  if (!reqOrIp) return "127.0.0.1";
  let raw = "";
  if (typeof reqOrIp === "string") {
    raw = reqOrIp;
  } else if (typeof reqOrIp === "object") {
    raw = reqOrIp.headers?.["x-forwarded-for"] || reqOrIp.socket?.remoteAddress || reqOrIp.ip || "";
  }
  raw = raw.split(",")[0].trim();
  if (raw.startsWith("::ffff:")) raw = raw.replace("::ffff:", "");
  if (raw === "::1" || !raw) raw = "127.0.0.1";
  return raw;
}

/**
 * Log an action to the audit table.
 * @param {string} user - The username who performed the action
 * @param {string} action - Describe the action (e.g. "Create Initial Infrastructure")
 * @param {string} projectName - The name of the project affected
 * @param {string} result - "Success", "Failed", etc.
 * @param {string} [category] - One of VALID_CATEGORIES; inferred from `action` if omitted
 * @param {object|string} [reqOrIp] - Express request object or IP string
 */
async function logAction(user, action, projectName, result, category, reqOrIp) {
  try {
    const extId = Date.now().toString() + "-" + Math.random().toString(36).substring(2, 7);
    const resolvedCategory = VALID_CATEGORIES.includes(category) ? category : inferCategory(action);
    const clientIp = extractClientIp(reqOrIp);

    await pool.query(
      `INSERT INTO audit_log (ext_id, username, action, category, project_name, result, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [extId, user || "system", action || "Unknown Action", resolvedCategory, projectName || "N/A", result || "Unknown", clientIp]
    );
  } catch (err) {
    console.error("Failed to write to audit log:", err);
  }
}

/**
 * Get recent audit logs, sorted by timestamp descending, optionally filtered.
 */
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
      `SELECT id, ext_id AS extId, timestamp, username AS user, username, action, category,
              project_name AS projectName, result, COALESCE(ip_address, '127.0.0.1') AS ipAddress
       FROM audit_log ${where} ORDER BY timestamp DESC LIMIT ?`,
      [...params, limit]
    );
    return rows.map(r => ({
      ...r,
      timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : r.timestamp,
      ipAddress: r.ipAddress || '127.0.0.1'
    }));
  } catch (err) {
    console.error("Failed to read audit log:", err);
    return [];
  }
}

module.exports = { ensureAuditTableExists, logAction, getAuditLogs, VALID_CATEGORIES, extractClientIp };
