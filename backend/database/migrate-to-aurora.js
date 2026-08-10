// One-time migration: copies existing data from the DynamoDB tables
// (cicd-admin-projects, cicd-users, cicd-audit-log) into the new Aurora
// MySQL database defined in schema.sql.
//
// Run once, after creating the Aurora cluster and applying schema.sql,
// and BEFORE switching the app over to userStore.js/projectStore.js/
// auditStore.js (Aurora versions). Safe to re-run — uses INSERT IGNORE,
// so already-migrated rows are skipped rather than duplicated.
//
// Usage:
//   node migrate-to-aurora.js
//
// Requires the same DynamoDB env vars the app already uses (AWS_REGION,
// DYNAMODB_TABLE, DYNAMODB_USERS_TABLE, DYNAMODB_AUDIT_TABLE) plus the
// Aurora connection env vars (DB_HOST, DB_USER, DB_PASSWORD, DB_NAME).
require("dotenv").config();
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand } = require("@aws-sdk/lib-dynamodb");
const { pool } = require("./db");

const raw = new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" });
const ddb = DynamoDBDocumentClient.from(raw);

async function scanAll(tableName) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(new ScanCommand({ TableName: tableName, ExclusiveStartKey }));
    items.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function migrateUsers() {
  const table = process.env.DYNAMODB_USERS_TABLE || "cicd-users";
  console.log(`Reading users from DynamoDB table "${table}"...`);
  const users = await scanAll(table);
  console.log(`Found ${users.length} user(s).`);

  for (const u of users) {
    // Existing DynamoDB users predate the user_type column — default them
    // to "developer" so an admin must consciously grant elevated access
    // rather than everyone inheriting it silently. Promote real admins
    // manually afterward via PATCH /api/users/:username/role.
    await pool.query(
      "INSERT IGNORE INTO users (username, password_hash, user_type, created_at) VALUES (?, ?, ?, ?)",
      [u.username, u.hash, u.userType || "developer", u.createdAt ? new Date(u.createdAt) : new Date()]
    );
  }
  console.log("Users migrated. Remember to manually promote your admin accounts:");
  console.log('  UPDATE users SET user_type = "super_admin" WHERE username = "...";');
}

async function migrateProjects() {
  const table = process.env.DYNAMODB_TABLE || "cicd-admin-projects";
  console.log(`Reading projects from DynamoDB table "${table}"...`);
  const projects = await scanAll(table);
  console.log(`Found ${projects.length} project(s).`);

  for (const p of projects) {
    await pool.query(
      "INSERT IGNORE INTO projects (id, name, data, created_at) VALUES (?, ?, ?, ?)",
      [p.id, p.name || "", JSON.stringify(p), p.createdAt ? new Date(p.createdAt) : new Date()]
    );
  }
  console.log("Projects migrated.");
}

async function migrateAuditLog() {
  const table = process.env.DYNAMODB_AUDIT_TABLE || "cicd-audit-log";
  console.log(`Reading audit log from DynamoDB table "${table}"...`);
  const entries = await scanAll(table);
  console.log(`Found ${entries.length} audit log entr${entries.length === 1 ? "y" : "ies"}.`);

  const auditStore = require("./auditStore"); // for inferCategory-equivalent logic via VALID_CATEGORIES check
  for (const e of entries) {
    const category = auditStore.VALID_CATEGORIES.includes(e.category) ? e.category : "Other";
    await pool.query(
      "INSERT IGNORE INTO audit_log (id, timestamp, username, action, category, project_name, result) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [e.id, new Date(e.timestamp), e.user || "system", e.action || "Unknown Action", category, e.projectName || "N/A", e.result || "Unknown"]
    );
  }
  console.log("Audit log migrated.");
}

(async function main() {
  try {
    await migrateUsers();
    await migrateProjects();
    await migrateAuditLog();
    console.log("Migration complete.");
  } catch (err) {
    console.error("Migration failed:", err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
