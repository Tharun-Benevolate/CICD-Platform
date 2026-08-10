const fs = require('fs');

const raw = fs.readFileSync('aws_mysql_schema.sql', 'utf-8');
const blocks = raw.split(/-- ---------------------------------------------------------------------------\r?\n/);

const tableBlocks = {};

for (let i = 1; i < blocks.length; i++) {
  const block = blocks[i].trim();
  const match = block.match(/-- Table: ([a-zA-Z0-9_]+)/);
  if (match) {
    const tableName = match[1];
    tableBlocks[tableName] = block;
  }
}

const orderedTables = [
  'users',
  'projects',
  'audit_log',
  'beta_orgs',
  'slack_config',
  'repositories',
  'repo_credentials',
  'developer_access',
  'branches',
  'change_requests',
  'change_request_files',
  'review_comments',
  'approvals',
  'commits',
  'notifications',
  'branch_policies',
  'notification_settings',
  'file_locks',
  'release_promotions'
];

let output = `-- ============================================================================
-- Benevolate CI/CD Admin Platform — AWS MySQL / Aurora Database Schema
-- Standardized Dependency Order with Full Table Schemas & User/Project Seed Data
-- ============================================================================

CREATE DATABASE IF NOT EXISTS \`cicd_admin\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE \`cicd_admin\`;

SET FOREIGN_KEY_CHECKS = 0;
`;

for (const t of orderedTables) {
  if (tableBlocks[t]) {
    output += `\n-- ---------------------------------------------------------------------------\n${tableBlocks[t]}\n`;
  }
}

output += `\nSET FOREIGN_KEY_CHECKS = 1;\n\n-- Dump complete.\n`;

fs.writeFileSync('aws_mysql_schema.sql', output, 'utf-8');
console.log('Reordered schema saved. Total bytes:', output.length);
