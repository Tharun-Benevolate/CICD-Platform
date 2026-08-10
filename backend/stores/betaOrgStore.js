// betaOrgStore.js — CRUD for the beta_orgs table.
// Orgs listed here have their users routed to the prod-beta ECS service
// (via the __env=beta ALB cookie). The deployed application calls
// GET /api/public/is-beta-org?orgId=X at login time and sets the cookie.
//
// org_domain is what makes that possible in the first place: the deployed
// app resolves a logged-in user's email domain to an org ID via
// GET /api/public/org-for-domain?domain=X (see orgIdForDomain() below)
// BEFORE it ever checks is-beta-org. So org_domain is required for every
// org — an org row with no domain is unreachable by any real login.
const { pool } = require("../config/db");

// Self-healing schema migration — safe to run repeatedly on every startup.
// Adds org_domain to beta_orgs if it's missing (e.g. on a DB that was
// created before this field existed), without requiring a manual
// `ALTER TABLE` against the already-deployed Aurora cluster.
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS beta_orgs (
      org_id      VARCHAR(128)  NOT NULL,
      org_name    VARCHAR(255)  NOT NULL,
      org_domain  VARCHAR(255)  NULL UNIQUE,
      added_by    VARCHAR(128)  NULL,
      notes       TEXT          NULL,
      added_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (org_id),
      INDEX idx_beta_org_domain (org_domain)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
}

function normalizeDomain(domain) {
  return String(domain || "").trim().toLowerCase();
}

async function listBetaOrgs() {
  const [rows] = await pool.query(
    "SELECT org_id AS orgId, org_name AS orgName, org_domain AS orgDomain, added_by AS addedBy, notes, added_at AS addedAt FROM beta_orgs ORDER BY added_at DESC"
  );
  return rows;
}

async function isBetaOrg(orgId) {
  if (!orgId) return false;
  const [rows] = await pool.query(
    "SELECT 1 FROM beta_orgs WHERE org_id = ? LIMIT 1",
    [String(orgId).trim()]
  );
  return rows.length > 0;
}

// Resolves an email domain (e.g. "benevolate.com") to the org ID it maps
// to. This is the ONLY place an org ID ever gets assigned to a user — the
// deployed app calls this via GET /api/public/org-for-domain before it
// checks is-beta-org. Returns null if the domain isn't mapped to any org.
async function orgIdForDomain(domain) {
  const d = normalizeDomain(domain);
  if (!d) return null;
  const [rows] = await pool.query(
    "SELECT org_id AS orgId FROM beta_orgs WHERE org_domain = ? LIMIT 1",
    [d]
  );
  return rows.length > 0 ? rows[0].orgId : null;
}

async function addBetaOrg(orgId, orgName, addedBy, notes = null, orgDomain = null) {
  const id = String(orgId).trim();
  if (!id) throw new Error("orgId is required");
  const domain = normalizeDomain(orgDomain);
  if (!domain) {
    // org_domain is the only mechanism that maps a user's email to this
    // org, so an org with no domain would be permanently unreachable.
    throw new Error("orgDomain is required — it's how logged-in users get mapped to this org");
  }
  try {
    await pool.query(
      "INSERT INTO beta_orgs (org_id, org_name, org_domain, added_by, notes) VALUES (?, ?, ?, ?, ?)",
      [id, orgName || "", domain, addedBy || "system", notes]
    );
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      const dup = new Error(
        err.message && err.message.includes("org_domain")
          ? "That domain is already mapped to another org"
          : "Org ID already exists in the beta list"
      );
      dup.code = "DUPLICATE_ORG";
      throw dup;
    }
    throw err;
  }
  return { orgId: id, orgName: orgName || "", orgDomain: domain, addedBy, notes, addedAt: new Date().toISOString() };
}

async function removeBetaOrg(orgId) {
  const [result] = await pool.query("DELETE FROM beta_orgs WHERE org_id = ?", [String(orgId).trim()]);
  return result.affectedRows > 0;
}

module.exports = { ensureSchema, listBetaOrgs, isBetaOrg, orgIdForDomain, addBetaOrg, removeBetaOrg };
