const { pool } = require("./db");
const crypto = require("crypto");

async function run() {
  try {
    const projectId = crypto.randomUUID();
    const repoId = crypto.randomUUID();

    // 1. Create a Project
    await pool.query(
      `INSERT INTO projects (id, name, data) VALUES (?, ?, '{}')`,
      [projectId, "GitHub Test Project"]
    );

    // 2. Create a Repository
    await pool.query(
      `INSERT INTO repositories (id, project_id, provider, owner, repo_name, default_branch, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [repoId, projectId, "github", "amruthkumartj", "Testing", "main", "testadmin"]
    );

    console.log("Created project:", projectId);
    console.log("Created repository:", repoId);
  } catch (err) {
    console.error(err);
  } finally {
    process.exit(0);
  }
}

run();
