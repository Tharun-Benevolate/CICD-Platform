// migrate-local.js — Full schema migration against local MySQL.
// Safe to run multiple times — all CREATE TABLE statements use IF NOT EXISTS.
// Run with: npm run migrate
//
// Growth design decisions:
//   - UUIDs (VARCHAR 64) for all entity PKs → safe for future distributed/sharding
//   - BIGINT AUTO_INCREMENT for high-volume log/event tables (audit_log, notifications)
//     so they stay fast at millions of rows
//   - JSON column on `projects` stays — allows adding new project fields with zero migrations
//   - Composite indexes on the most common query patterns (status+created, recipient+read)
//   - All tables utf8mb4_0900_ai_ci — supports emoji, full Unicode, case-insensitive sort
//   - Generous VARCHAR lengths throughout (avoid re-migrations for "field too small")
//   - created_at / updated_at on every table — essential for auditing and pagination

require("dotenv").config();
const mysql = require("mysql2/promise");

async function columnExists(conn, table, col) {
  const [r] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, col]
  );
  return r[0].cnt > 0;
}

// ─── Table definitions (dependency order — parents before children) ────────
const TABLES = [

  // ── Core: users ────────────────────────────────────────────────────────
  // username is the natural PK (64 chars, login identifier).
  // New profile columns added for developer identity (GitHub, Slack, avatar).
  // user_type ENUM kept open-ended for future roles (contractor, viewer, etc.)
  ["users", `
    CREATE TABLE IF NOT EXISTS users (
      username        VARCHAR(128)  NOT NULL,
      password_hash   VARCHAR(255)  NOT NULL,
      email           VARCHAR(255)  NULL,
      slack_id        VARCHAR(128)  NULL,
      github_username VARCHAR(128)  NULL,
      avatar_url      VARCHAR(512)  NULL,
      user_type       ENUM('super_admin','devops','developer','sales') NOT NULL DEFAULT 'developer',
      created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (username),
      INDEX idx_users_email (email),
      INDEX idx_users_type  (user_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `],

  // ── Core: projects ─────────────────────────────────────────────────────
  // data JSON column deliberately holds all evolving project fields
  // (ECR, ECS, Terraform state, build history, etc.) so new fields
  // never need a migration — only structured query fields get real columns.
  ["projects", `
    CREATE TABLE IF NOT EXISTS projects (
      id         VARCHAR(64)   NOT NULL,
      name       VARCHAR(512)  NOT NULL,
      data       JSON          NOT NULL,
      created_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_projects_name (name(255))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `],

  // ── Core: audit_log ────────────────────────────────────────────────────
  // BIGINT AUTO_INCREMENT PK — better performance at scale (millions of rows).
  // UUID secondary index for external reference if needed.
  // category ENUM includes all current + phase 2-5 values upfront to avoid
  // future ENUM ALTERs (which lock the table on large datasets).
  ["audit_log", `
    CREATE TABLE IF NOT EXISTS audit_log (
      id           BIGINT        NOT NULL AUTO_INCREMENT,
      ext_id       VARCHAR(64)   NOT NULL,
      timestamp    DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      username     VARCHAR(128)  NOT NULL,
      action       TEXT          NOT NULL,
      category     ENUM(
        'Login', 'Approvals', 'Pipeline Executions', 'Terraform',
        'User Management', 'Change Requests', 'Code Review',
        'Repository', 'Access Control', 'Notifications', 'Settings', 'Other'
      ) NOT NULL DEFAULT 'Other',
      project_name VARCHAR(512)  NOT NULL DEFAULT 'N/A',
      result       VARCHAR(64)   NOT NULL DEFAULT 'Unknown',
      ip_address   VARCHAR(64)   NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_audit_ext_id   (ext_id),
      INDEX idx_audit_username     (username),
      INDEX idx_audit_category     (category),
      INDEX idx_audit_timestamp    (timestamp),
      INDEX idx_audit_project      (project_name(255)),
      INDEX idx_audit_cat_ts       (category, timestamp)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `],

  // ── Repositories ───────────────────────────────────────────────────────
  ["repositories", `
    CREATE TABLE IF NOT EXISTS repositories (
      id             VARCHAR(64)   NOT NULL,
      project_id     VARCHAR(64)   NOT NULL,
      provider       ENUM('github','gitlab','codecommit','bitbucket','azure_devops','gitea')
                                   NOT NULL DEFAULT 'github',
      owner          VARCHAR(255)  NULL     COMMENT 'GitHub org/user, GitLab namespace, etc.',
      repo_name      VARCHAR(255)  NOT NULL,
      display_name   VARCHAR(255)  NULL     COMMENT 'Optional friendly name shown in UI',
      default_branch VARCHAR(128)  NOT NULL DEFAULT 'main',
      clone_url      VARCHAR(1024) NULL,
      is_active      TINYINT(1)    NOT NULL DEFAULT 1,
      created_by     VARCHAR(128)  NULL,
      created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_repo_project    (project_id),
      INDEX idx_repo_provider   (provider),
      INDEX idx_repo_active     (is_active),
      CONSTRAINT fk_repo_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `],

  // ── Stored credentials (AES-256-GCM encrypted tokens) ─────────────────
  ["repo_credentials", `
    CREATE TABLE IF NOT EXISTS repo_credentials (
      id              VARCHAR(64)   NOT NULL,
      username        VARCHAR(128)  NOT NULL,
      repository_id   VARCHAR(64)   NULL     COMMENT 'NULL = applies to all repos for this provider',
      provider        ENUM('github','gitlab','codecommit','bitbucket','azure_devops','gitea') NOT NULL,
      credential_type ENUM('pat','oauth','ssh_key','basic','app_password') NOT NULL DEFAULT 'pat',
      encrypted_token TEXT          NOT NULL,
      token_iv        VARCHAR(64)   NOT NULL COMMENT 'AES-GCM 96-bit nonce (hex)',
      token_tag       VARCHAR(64)   NOT NULL COMMENT 'AES-GCM auth tag (hex)',
      label           VARCHAR(255)  NULL     COMMENT 'User-facing name e.g. "Work GitHub PAT"',
      expires_at      DATETIME      NULL,
      last_used_at    DATETIME      NULL,
      created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_cred_user_provider (username, provider),
      INDEX idx_cred_repo          (repository_id),
      CONSTRAINT fk_cred_user FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `],

  // ── Developer access control ───────────────────────────────────────────
  ["developer_access", `
    CREATE TABLE IF NOT EXISTS developer_access (
      id           VARCHAR(64)   NOT NULL,
      project_id   VARCHAR(64)   NOT NULL,
      username     VARCHAR(128)  NOT NULL,
      access_level ENUM('read','pull','push','push_pull','admin') NOT NULL DEFAULT 'pull',
      granted_by   VARCHAR(128)  NULL,
      note         VARCHAR(512)  NULL     COMMENT 'Reason for granting access',
      expires_at   DATETIME      NULL     COMMENT 'Optional expiry for temporary access',
      created_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_access_project_user (project_id, username),
      INDEX idx_access_username   (username),
      INDEX idx_access_level      (access_level),
      CONSTRAINT fk_access_project FOREIGN KEY (project_id) REFERENCES projects(id)   ON DELETE CASCADE,
      CONSTRAINT fk_access_user    FOREIGN KEY (username)   REFERENCES users(username) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `],

  // ── Feature branches ───────────────────────────────────────────────────
  ["branches", `
    CREATE TABLE IF NOT EXISTS branches (
      id            VARCHAR(64)   NOT NULL,
      repository_id VARCHAR(64)   NOT NULL,
      name          VARCHAR(512)  NOT NULL,
      base_branch   VARCHAR(128)  NOT NULL DEFAULT 'main',
      head_sha      VARCHAR(64)   NULL,
      status        ENUM('active','merged','deleted','stale','locked') NOT NULL DEFAULT 'active',
      created_by    VARCHAR(128)  NULL,
      created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      merged_at     DATETIME      NULL,
      deleted_at    DATETIME      NULL,
      PRIMARY KEY (id),
      INDEX idx_branch_repo_status  (repository_id, status),
      INDEX idx_branch_created_by   (created_by),
      INDEX idx_branch_created_at   (created_at),
      CONSTRAINT fk_branch_repo FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `],

  // ── Change requests (internal PRs) ─────────────────────────────────────
  ["change_requests", `
    CREATE TABLE IF NOT EXISTS change_requests (
      id             VARCHAR(64)   NOT NULL,
      repository_id  VARCHAR(64)   NOT NULL,
      branch_id      VARCHAR(64)   NULL,
      title          VARCHAR(1024) NOT NULL,
      description    MEDIUMTEXT    NULL,
      author         VARCHAR(128)  NOT NULL,
      status         ENUM('draft','open','reviewing','approved','rejected','merged','closed','conflict')
                                   NOT NULL DEFAULT 'draft',
      base_branch    VARCHAR(255)  NOT NULL DEFAULT 'main',
      head_branch    VARCHAR(512)  NOT NULL,
      base_sha       VARCHAR(64)   NULL,
      head_sha       VARCHAR(64)   NULL,
      merge_sha      VARCHAR(64)   NULL,
      files_changed  INT           NOT NULL DEFAULT 0,
      additions      INT           NOT NULL DEFAULT 0,
      deletions      INT           NOT NULL DEFAULT 0,
      is_quick_edit  TINYINT(1)    NOT NULL DEFAULT 0,
      priority       ENUM('low','normal','high','urgent') NOT NULL DEFAULT 'normal',
      labels         JSON          NULL     COMMENT 'Array of label strings e.g. ["bug","frontend"]',
      merged_by      VARCHAR(128)  NULL,
      created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      merged_at      DATETIME      NULL,
      closed_at      DATETIME      NULL,
      PRIMARY KEY (id),
      INDEX idx_cr_repository      (repository_id),
      INDEX idx_cr_author          (author),
      INDEX idx_cr_status          (status),
      INDEX idx_cr_status_created  (status, created_at),
      INDEX idx_cr_updated         (updated_at),
      CONSTRAINT fk_cr_repository FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
      CONSTRAINT fk_cr_branch     FOREIGN KEY (branch_id)     REFERENCES branches(id)      ON DELETE SET NULL,
      CONSTRAINT fk_cr_author     FOREIGN KEY (author)        REFERENCES users(username)   ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `],

  // ── Files changed in a CR ──────────────────────────────────────────────
  ["change_request_files", `
    CREATE TABLE IF NOT EXISTS change_request_files (
      id                VARCHAR(64)   NOT NULL,
      change_request_id VARCHAR(64)   NOT NULL,
      file_path         VARCHAR(4096) NOT NULL,
      change_type       ENUM('added','modified','deleted','renamed','copied') NOT NULL DEFAULT 'modified',
      old_path          VARCHAR(4096) NULL,
      additions         INT           NOT NULL DEFAULT 0,
      deletions         INT           NOT NULL DEFAULT 0,
      patch             LONGTEXT      NULL     COMMENT 'Unified diff — LONGTEXT for large files',
      blob_sha          VARCHAR(64)   NULL,
      created_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_crf_cr   (change_request_id),
      INDEX idx_crf_type (change_type),
      CONSTRAINT fk_crf_cr FOREIGN KEY (change_request_id) REFERENCES change_requests(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `],

  // ── Inline + general review comments ──────────────────────────────────
  ["review_comments", `
    CREATE TABLE IF NOT EXISTS review_comments (
      id                VARCHAR(64)   NOT NULL,
      change_request_id VARCHAR(64)   NOT NULL,
      parent_id         VARCHAR(64)   NULL     COMMENT 'For threaded replies',
      author            VARCHAR(128)  NOT NULL,
      body              MEDIUMTEXT    NOT NULL,
      file_path         VARCHAR(4096) NULL     COMMENT 'NULL = top-level CR comment',
      line_number       INT           NULL,
      side              ENUM('LEFT','RIGHT') NULL COMMENT 'Diff side for inline comments',
      commit_sha        VARCHAR(64)   NULL,
      is_resolved       TINYINT(1)    NOT NULL DEFAULT 0,
      resolved_by       VARCHAR(128)  NULL,
      created_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_rc_cr       (change_request_id),
      INDEX idx_rc_author   (author),
      INDEX idx_rc_resolved (is_resolved),
      INDEX idx_rc_parent   (parent_id),
      CONSTRAINT fk_rc_cr       FOREIGN KEY (change_request_id) REFERENCES change_requests(id) ON DELETE CASCADE,
      CONSTRAINT fk_rc_author   FOREIGN KEY (author)            REFERENCES users(username)      ON DELETE CASCADE,
      CONSTRAINT fk_rc_parent   FOREIGN KEY (parent_id)         REFERENCES review_comments(id)  ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `],

  // ── Review decisions ───────────────────────────────────────────────────
  ["approvals", `
    CREATE TABLE IF NOT EXISTS approvals (
      id                VARCHAR(64)   NOT NULL,
      change_request_id VARCHAR(64)   NOT NULL,
      reviewer          VARCHAR(128)  NOT NULL,
      decision          ENUM('approved','rejected','changes_requested') NOT NULL,
      comment           MEDIUMTEXT    NULL,
      created_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_approval_cr       (change_request_id),
      INDEX idx_approval_reviewer (reviewer),
      INDEX idx_approval_decision (decision),
      CONSTRAINT fk_approval_cr       FOREIGN KEY (change_request_id) REFERENCES change_requests(id) ON DELETE CASCADE,
      CONSTRAINT fk_approval_reviewer FOREIGN KEY (reviewer)          REFERENCES users(username)      ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `],

  // ── Commit tracking ────────────────────────────────────────────────────
  ["commits", `
    CREATE TABLE IF NOT EXISTS commits (
      id                VARCHAR(64)   NOT NULL,
      change_request_id VARCHAR(64)   NULL,
      repository_id     VARCHAR(64)   NOT NULL,
      sha               VARCHAR(64)   NOT NULL,
      message           TEXT          NOT NULL,
      author            VARCHAR(128)  NOT NULL,
      author_email      VARCHAR(255)  NULL,
      branch_name       VARCHAR(512)  NULL,
      files_changed     INT           NOT NULL DEFAULT 0,
      additions         INT           NOT NULL DEFAULT 0,
      deletions         INT           NOT NULL DEFAULT 0,
      created_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_commit_cr     (change_request_id),
      INDEX idx_commit_sha    (sha),
      INDEX idx_commit_repo   (repository_id),
      INDEX idx_commit_author (author),
      CONSTRAINT fk_commit_repo FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `],

  // ── In-app notifications — BIGINT PK for high volume ──────────────────
  ["notifications", `
    CREATE TABLE IF NOT EXISTS notifications (
      id                BIGINT        NOT NULL AUTO_INCREMENT,
      ext_id            VARCHAR(64)   NOT NULL COMMENT 'UUID for external reference',
      recipient         VARCHAR(128)  NOT NULL,
      type              ENUM(
        'cr_submitted','cr_approved','cr_rejected','cr_merged','cr_comment',
        'cr_conflict','pipeline_failed','pipeline_succeeded',
        'deploy_completed','deploy_failed','access_granted','mention','system'
      ) NOT NULL,
      title             VARCHAR(512)  NOT NULL,
      body              TEXT          NULL,
      link              VARCHAR(2048) NULL,
      is_read           TINYINT(1)    NOT NULL DEFAULT 0,
      change_request_id VARCHAR(64)   NULL,
      created_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_notif_ext_id          (ext_id),
      INDEX idx_notif_recipient_read      (recipient, is_read),
      INDEX idx_notif_recipient_created   (recipient, created_at),
      INDEX idx_notif_type                (type),
      CONSTRAINT fk_notif_recipient FOREIGN KEY (recipient) REFERENCES users(username) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `],

  // ── Branch merge policies ──────────────────────────────────────────────
  ["branch_policies", `
    CREATE TABLE IF NOT EXISTS branch_policies (
      id                 VARCHAR(64)   NOT NULL,
      repository_id      VARCHAR(64)   NOT NULL,
      branch_pattern     VARCHAR(255)  NOT NULL DEFAULT 'main',
      require_review     TINYINT(1)    NOT NULL DEFAULT 1,
      min_approvals      INT           NOT NULL DEFAULT 1,
      require_ci_pass    TINYINT(1)    NOT NULL DEFAULT 0,
      auto_delete_branch TINYINT(1)    NOT NULL DEFAULT 1,
      allow_force_push   TINYINT(1)    NOT NULL DEFAULT 0,
      merge_strategy     ENUM('squash','merge','rebase') NOT NULL DEFAULT 'squash',
      extra_settings     JSON          NULL COMMENT 'Future policy config without migrations',
      created_at         DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at         DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_bp_repo (repository_id),
      CONSTRAINT fk_bp_repo FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `],

  // ── Per-user notification preferences ─────────────────────────────────
  ["notification_settings", `
    CREATE TABLE IF NOT EXISTS notification_settings (
      id                VARCHAR(64)   NOT NULL,
      username          VARCHAR(128)  NOT NULL,
      in_app            TINYINT(1)    NOT NULL DEFAULT 1,
      email             TINYINT(1)    NOT NULL DEFAULT 0,
      slack             TINYINT(1)    NOT NULL DEFAULT 0,
      slack_webhook_url VARCHAR(2048) NULL,
      preferences       JSON          NULL COMMENT 'Granular per-event toggles',
      created_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_notif_settings_user (username),
      CONSTRAINT fk_ns_user FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `],

  // ── Advisory file edit locks ───────────────────────────────────────────
  ["file_locks", `
    CREATE TABLE IF NOT EXISTS file_locks (
      id                VARCHAR(64)   NOT NULL,
      repository_id     VARCHAR(64)   NOT NULL,
      file_path         VARCHAR(4096) NOT NULL,
      locked_by         VARCHAR(128)  NOT NULL,
      change_request_id VARCHAR(64)   NULL,
      locked_at         DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at        DATETIME      NOT NULL,
      PRIMARY KEY (id),
      INDEX idx_fl_repo_path (repository_id, file_path(255)),
      INDEX idx_fl_user      (locked_by),
      INDEX idx_fl_expires   (expires_at),
      CONSTRAINT fk_fl_repo FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
      CONSTRAINT fk_fl_user FOREIGN KEY (locked_by)     REFERENCES users(username)  ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `],

  // ── Beta organizations (cookie-based blue/green routing) ─────────────────
  // From mergeproject — orgs listed here are routed to prod-beta ECS service.
  ["beta_orgs", `
    CREATE TABLE IF NOT EXISTS beta_orgs (
      org_id      VARCHAR(128)  NOT NULL,
      org_name    VARCHAR(255)  NOT NULL,
      org_domain  VARCHAR(255)  NULL UNIQUE COMMENT 'Email domain → orgId resolver',
      added_by    VARCHAR(128)  NULL,
      notes       TEXT          NULL,
      added_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (org_id),
      INDEX idx_beta_org_domain (org_domain)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `],

  // ── Release promotion tracking ─────────────────────────────────────────
  // From mergeproject — tracks release → main merges that trigger pipeline runs.
  ["release_promotions", `
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
  `]
];

async function run() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || "127.0.0.1",
    port: parseInt(process.env.DB_PORT || "3306"),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "root",
    database: process.env.DB_NAME || "cicd_admin"
  });
  console.log(`✔  Connected → ${process.env.DB_HOST || "127.0.0.1"}:${process.env.DB_PORT || "3306"}/${process.env.DB_NAME || "cicd_admin"}\n`);

  // Handle users table that may already exist without the new columns
  const extraUserCols = [
    { col: "email",           def: "VARCHAR(255) NULL AFTER password_hash" },
    { col: "slack_id",        def: "VARCHAR(128) NULL AFTER email" },
    { col: "github_username", def: "VARCHAR(128) NULL AFTER slack_id" },
    { col: "avatar_url",      def: "VARCHAR(512) NULL AFTER github_username" },
    { col: "updated_at",      def: "DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at" }
  ];

  // Handle audit_log: add ext_id and ip_address if missing
  const extraAuditCols = [
    { col: "ext_id",     def: "VARCHAR(64) NULL AFTER id" },
    { col: "ip_address", def: "VARCHAR(64) NULL AFTER result" }
  ];

  for (const [name, sql] of TABLES) {
    await conn.query(sql.trim());
    console.log(`  ✔  ${name}`);

    if (name === "users") {
      for (const { col, def } of extraUserCols) {
        if (!(await columnExists(conn, "users", col))) {
          await conn.query(`ALTER TABLE users ADD COLUMN \`${col}\` ${def}`);
          console.log(`      ↳ added column: ${col}`);
        }
      }
    }

    if (name === "audit_log") {
      for (const { col, def } of extraAuditCols) {
        if (!(await columnExists(conn, "audit_log", col))) {
          await conn.query(`ALTER TABLE audit_log ADD COLUMN \`${col}\` ${def}`);
          console.log(`      ↳ added column: ${col}`);
        }
      }
    }
  }

  const [tables] = await conn.query("SHOW TABLES");
  console.log(`\n✅  Migration complete — ${tables.length} tables ready in cicd_admin:`);
  tables.forEach(t => console.log("   ·", Object.values(t)[0]));
  await conn.end();
}

run().catch(e => {
  console.error("\n❌  Migration failed:", e.message);
  process.exit(1);
});
