const { pool } = require("../config/db");
const { getStoreReq } = require("../middleware/ipContext");

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
  let target = reqOrIp || getStoreReq();
  if (!target) return "127.0.0.1";
  let raw = "";
  if (typeof target === "string") {
    raw = target;
  } else if (typeof target === "object") {
    const headers = target.headers || {};
    raw = headers["cf-connecting-ip"] || headers["x-forwarded-for"] || headers["x-real-ip"] || target.ip || target.socket?.remoteAddress || "";
  }
  if (raw.includes(",")) {
    const parts = raw.split(",").map(p => p.trim());
    raw = parts.find(p => p && p !== "127.0.0.1" && !p.startsWith("10.") && !p.startsWith("172.16.") && !p.startsWith("192.168.")) || parts[0];
  }
  raw = (raw || "").trim();
  if (raw.startsWith("::ffff:")) raw = raw.replace("::ffff:", "");
  if (raw === "::1" || raw === "127.0.0.1" || !raw) return "127.0.0.1";
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
    let reqObj = reqOrIp;
    let actualCategory = category;

    if (!reqObj) {
      if (typeof category === "object" && category !== null && (category.headers || category.ip || category.socket)) {
        reqObj = category;
        actualCategory = undefined;
      } else {
        reqObj = getStoreReq();
      }
    }

    const extId = Date.now().toString() + "-" + Math.random().toString(36).substring(2, 7);
    const resolvedCategory = VALID_CATEGORIES.includes(actualCategory) ? actualCategory : inferCategory(action);
    const clientIp = extractClientIp(reqObj);

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
 * Get audit logs in stable, newest-first pages. Keeping pagination in MySQL
 * avoids truncating the audit trail in the browser as the table grows.
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
    if (filters.securityOnly) {
      // Security events existed before a dedicated UI filter, so classify them
      // from their durable category plus well-known sensitive action terms.
      // This keeps historical login, role, access, and secret events visible.
      conditions.push(`(
        category IN ('Login', 'User Management', 'Access Control')
        OR LOWER(action) LIKE ? OR LOWER(action) LIKE ? OR LOWER(action) LIKE ?
        OR LOWER(action) LIKE ? OR LOWER(action) LIKE ? OR LOWER(action) LIKE ?
      )`);
      params.push('%secret%', '%credential%', '%password%', '%two factor%', '%totp%', '%session%');
    }
    if (filters.search) {
      const search = `%${String(filters.search).trim()}%`;
      if (search !== "%%") {
        conditions.push("(action LIKE ? OR username LIKE ? OR category LIKE ? OR project_name LIKE ? OR result LIKE ?)");
        params.push(search, search, search, search, search);
      }
    }
    if (Array.isArray(filters.projectNames) && filters.projectNames.length) {
      const names = filters.projectNames.filter(Boolean);
      if (names.length) {
        conditions.push(`project_name IN (${names.map(() => "?").join(",")})`);
        params.push(...names);
      }
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(Math.max(Number.parseInt(filters.limit, 10) || 50, 1), 100);
    const page = Math.max(Number.parseInt(filters.page, 10) || 1, 1);
    const offset = (page - 1) * limit;

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM audit_log ${where}`,
      params
    );
    const total = Number(countRows[0]?.total || 0);

    const [rows] = await pool.query(
      `SELECT id, ext_id AS extId, timestamp, username AS user, username, action, category,
              project_name AS projectName, result, COALESCE(ip_address, '127.0.0.1') AS ipAddress
       FROM audit_log ${where} ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    return {
      logs: rows.map(r => ({
        ...r,
        timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : r.timestamp,
        ipAddress: r.ipAddress || '127.0.0.1'
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(Math.ceil(total / limit), 1),
        hasPrevious: page > 1,
        hasNext: offset + rows.length < total
      }
    };
  } catch (err) {
    console.error("Failed to read audit log:", err);
    return { logs: [], pagination: { page: 1, limit: 50, total: 0, totalPages: 1, hasPrevious: false, hasNext: false } };
  }
}

module.exports = { ensureAuditTableExists, logAction, getAuditLogs, VALID_CATEGORIES, extractClientIp };
