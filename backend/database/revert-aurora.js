// revert-aurora.js — Reverts ONLY the changes made by the failed migrate-v2 run.
// Safe to run multiple times (checks before dropping).
//
// What it reverts:
//   users table     — removes: email, slack_id, github_username, avatar_url
//   audit_log table — reverts category ENUM back to original 6 values
//
// Usage: node revert-aurora.js

require("dotenv").config();
const mysql = require("mysql2/promise");

async function revert() {
  const conn = await mysql.createConnection({
    host:     process.env.DB_HOST,
    port:     parseInt(process.env.DB_PORT || "3306"),
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });

  console.log(`Connected to Aurora → ${process.env.DB_HOST}/${process.env.DB_NAME}\n`);

  // ── 1. Drop the 4 columns added to users ──────────────────────────────
  const columnsToRemove = ["email", "slack_id", "github_username", "avatar_url"];
  for (const col of columnsToRemove) {
    const [rows] = await conn.query(
      `SELECT COUNT(*) AS cnt FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = ?`,
      [col]
    );
    if (rows[0].cnt > 0) {
      await conn.query(`ALTER TABLE users DROP COLUMN \`${col}\``);
      console.log(`✔  DROPPED  users.${col}`);
    } else {
      console.log(`–  SKIP     users.${col} (column doesn't exist, nothing to do)`);
    }
  }

  // ── 2. Revert audit_log.category ENUM to original schema.sql values ───
  // Original: Login | Approvals | Pipeline Executions | Terraform | User Management | Other
  // IMPORTANT: Any rows containing the new ENUM values (Change Requests, Code Review,
  //            Repository, Access Control) would be rejected. Since no new app code
  //            has been running, there should be no such rows. We verify first.
  const [badRows] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM audit_log
     WHERE category IN ('Change Requests','Code Review','Repository','Access Control')`
  );
  if (badRows[0].cnt > 0) {
    console.warn(`\n⚠  WARNING: ${badRows[0].cnt} audit_log row(s) use the new ENUM values.`);
    console.warn("   Updating them to 'Other' before reverting ENUM...");
    await conn.query(
      `UPDATE audit_log SET category = 'Other'
       WHERE category IN ('Change Requests','Code Review','Repository','Access Control')`
    );
    console.log("   Updated rows → 'Other'");
  }

  await conn.query(`
    ALTER TABLE audit_log
    MODIFY category ENUM('Login','Approvals','Pipeline Executions','Terraform','User Management','Other')
    NOT NULL DEFAULT 'Other'
  `);
  console.log("✔  REVERTED audit_log.category ENUM → original 6 values\n");

  await conn.end();
  console.log("✅  Aurora is clean. All migrate-v2 changes have been reverted.");
  console.log("    The other developer's environment is unaffected.\n");
}

revert().catch(e => {
  console.error("\n❌  Revert failed:", e.message);
  process.exit(1);
});
