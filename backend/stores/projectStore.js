// Aurora MySQL-backed project store (replaces the DynamoDB "cicd-admin-projects" table).
//
// Project records carry many fields that have grown organically as this
// application evolved (Terraform outputs, ECR/ECS references, build
// history, etc.). Rather than modeling each one as its own column — which
// would require a schema migration every time a new field is added — the
// full project object is stored as a JSON document in the `data` column.
// `id` and `name` are kept as real columns since they're the only fields
// queried directly (primary key lookup, and sorting by creation order).
require("dotenv").config();
const { pool } = require("../config/db");

function slugify(str) {
  return (str || "project").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

async function ensureTableExists() {
  // Table creation is handled by schema.sql against the Aurora cluster.
  // Kept as a no-op so server.js's startup sequence does not need to change.
}

function rowToProject(row) {
  if (!row) return null;
  // `data` already contains the full project object (including id/name);
  // the separate id/name columns exist only for indexing.
  const data = typeof row.data === "string" ? JSON.parse(row.data) : (row.data || {});
  const project = { id: row.id, name: row.name, ...data };
  if (project.githubRepo && project.githubRepo.includes("/")) {
    project.githubRepo = project.githubRepo.split("/").pop();
  }
  return project;
}

async function listProjects() {
  const [rows] = await pool.query("SELECT id, name, data FROM projects ORDER BY created_at ASC");
  return rows.map(rowToProject);
}

async function getProject(id) {
  const [rows] = await pool.query("SELECT id, name, data FROM projects WHERE id = ?", [id]);
  return rows.length ? rowToProject(rows[0]) : null;
}

async function createProject(data) {
  const id = data.id || slugify(data.name) + "-" + Date.now().toString(36);
  const project = {
    id,
    name:                data.name                || "",
    region:              data.region               || "us-east-1",
    sourceType:          data.sourceType           || "github",
    pipelineMode:        data.pipelineMode         || "dev-uat-prod",
    repoName:            data.repoName             || "",
    githubConnectionArn: data.githubConnectionArn  || "",
    githubOwner:         data.githubOwner          || "",
    githubRepo:          data.githubRepo           || "",
    githubBranch:        data.githubBranch         || "main",
    buildProjectName:    data.buildProjectName     || "",
    ecsClusterName:      data.ecsClusterName       || "",
    ecrRepoName:         data.ecrRepoName          || "",
    ecrRepoUrl:          data.ecrRepoUrl           || "",
    devServiceName:      data.devServiceName       || "",
    uatServiceName:      data.uatServiceName       || "",
    prodServiceName:     data.prodServiceName      || "",
    subnetIds:           data.subnetIds            || "",
    securityGroupId:     data.securityGroupId      || "",
    pipelineName:        data.pipelineName         || "",
    artifactBucket:      data.artifactBucket       || "",
    pipelineRoleArn:     data.pipelineRoleArn      || "",
    buildRoleArn:        data.buildRoleArn         || "",
    ecsExecutionRoleArn: data.ecsExecutionRoleArn  || "",
    ecsTaskRoleArn:      data.ecsTaskRoleArn       || "",
    albDnsName:          data.albDnsName           || "",
    devUrl:              data.devUrl               || "",
    uatUrl:              data.uatUrl               || "",
    prodUrl:             data.prodUrl              || "",
    localRepoPath:       data.localRepoPath        || "",
    bgDeployConfig:      data.bgDeployConfig       || "CodeDeployDefault.ECSAllAtOnce",
    bgTerminationWaitMins: typeof data.bgTerminationWaitMins === "number" ? data.bgTerminationWaitMins : 15,
    initialTfApplied:    data.initialTfApplied     || false,
    deploymentTfApplied: data.deploymentTfApplied  || false,
    buildHistory:        data.buildHistory         || [],
    createdAt:           new Date().toISOString()
  };

  await pool.query(
    "INSERT INTO projects (id, name, data) VALUES (?, ?, ?)",
    [id, project.name, JSON.stringify(project)]
  );

  // Auto-register repository record in DB so File Browser and API tools link cleanly
  try {
    const repoStore = require("./repositoryStore");
    const repoName = project.repoName || project.githubRepo;
    if (repoName) {
      await repoStore.createRepository({
        projectId: id,
        provider: project.sourceType || "codecommit",
        owner: project.githubOwner || null,
        repoName: repoName,
        defaultBranch: project.githubBranch || "main",
        createdBy: "system"
      });
    }
  } catch (err) {
    console.error("Auto repo creation notice:", err.message);
  }

  return project;
}

async function updateProject(id, patch) {
  const existing = await getProject(id);
  if (!existing) return null;
  const updated = { ...existing, ...patch, id };

  await pool.query(
    "UPDATE projects SET name = ?, data = ? WHERE id = ?",
    [updated.name, JSON.stringify(updated), id]
  );
  return updated;
}

async function setActiveProject(id) {
  const projects = await listProjects();
  if (!projects || projects.length === 0) return null;

  let activeProject = null;
  for (const p of projects) {
    const isTarget = p.id === id || p.name === id;
    if (isTarget) activeProject = p;
    await updateProject(p.id, { isActive: isTarget });
  }

  if (!activeProject && projects.length > 0) {
    activeProject = projects[0];
    await updateProject(activeProject.id, { isActive: true });
  }

  return activeProject;
}

async function deleteProject(id) {
  await pool.query("DELETE FROM projects WHERE id = ?", [id]);
  return true;
}

async function addBuildToHistory(id, buildEntry) {
  const project = await getProject(id);
  if (!project) return null;
  const history = [buildEntry, ...(project.buildHistory || [])].slice(0, 10);
  return await updateProject(id, { buildHistory: history });
}

module.exports = {
  ensureTableExists,
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  addBuildToHistory,
  setActiveProject
};
