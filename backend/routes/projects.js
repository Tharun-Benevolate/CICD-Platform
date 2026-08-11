// routes/projects.js — Project CRUD routes + shared helper functions.

const router = require("express").Router();
const store = require("../stores/projectStore");
const auth = require("../middleware/auth");
const accessStore = require("../stores/accessStore");

// --- Project CRUD ---

// GET /api/projects — Role-based project access isolation
router.get("/projects", async (req, res) => {
  try {
    const username = auth.getLoggedInUser(req);
    const userType = auth.getLoggedInUserType(req);
    const allProjects = await store.listProjects();

    // Super Admin & DevOps have access to all projects
    if (!username || userType === "super_admin" || userType === "devops") {
      return res.json({ ok: true, projects: allProjects });
    }

    // Developers only see assigned projects or projects created by them
    const userAccess = await accessStore.getUserAccess(username);
    const assignedIds = new Set(userAccess.map(a => a.projectId || a.project_id));
    const filtered = allProjects.filter(p =>
      assignedIds.has(p.id) ||
      p.createdBy === username ||
      p.data?.createdBy === username
    );

    res.json({ ok: true, projects: filtered });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/projects/:id
router.get("/projects/:id", async (req, res) => {
  try {
    const project = await store.getProject(req.params.id);
    if (!project) return res.status(404).json({ ok: false, error: "Project not found" });
    res.json({ ok: true, project });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// GET /api/projects/:id/members — get assigned members for a project
router.get("/projects/:id/members", async (req, res) => {
  try {
    const { id } = req.params;
    const accessList = await accessStore.getProjectAccess(id);
    const userStore = require("../stores/userStore");
    const allUsers = await userStore.listUsers();

    // Usernames explicitly granted access to this project
    const grantedUsernames = new Set(accessList.map(a => a.username.toLowerCase()));

    // Members of this project: users explicitly granted access ONLY
    const members = allUsers.filter(u =>
      grantedUsernames.has(u.username.toLowerCase())
    );

    res.json({ ok: true, members, grantedUsernames: Array.from(grantedUsernames) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/projects/:id/members — update assigned members for a project
router.post("/projects/:id/members", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const { id } = req.params;
    const { members } = req.body; // array of allowed usernames
    if (!Array.isArray(members)) {
      return res.status(400).json({ ok: false, error: "members array is required" });
    }

    const currentAccess = await accessStore.getProjectAccess(id);
    const currentGranted = new Set(currentAccess.map(a => a.username.toLowerCase()));
    const targetSet = new Set(members.map(m => m.toLowerCase().trim()));

    const caller = auth.getLoggedInUser(req) || "admin";

    // Grant access to newly checked members
    for (const username of targetSet) {
      if (!currentGranted.has(username)) {
        await accessStore.grantAccess({ projectId: id, username, accessLevel: "write", grantedBy: caller });
      }
    }

    // Revoke access from unchecked members
    for (const username of currentGranted) {
      if (!targetSet.has(username)) {
        await accessStore.revokeAccess(id, username);
      }
    }

    const auditStore = require("../stores/auditStore");
    const slackService = require("../services/slackService");
    const project = await store.getProject(id);
    auditStore.logAction(caller, `Updated project access list (${targetSet.size} members)`, project?.name || id, "Success", "User Management");

    slackService.notifyProjectAssignment({
      projectName: project?.name || id,
      creator: caller,
      assignedMembers: Array.from(targetSet)
    }).catch(() => {});

    slackService.syncProjectMembersToSlackChannel({
      projectId: id,
      assignedMembers: Array.from(targetSet)
    }).catch(() => {});

    res.json({ ok: true, grantedUsernames: Array.from(targetSet) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/projects — devops / super_admin only
router.post("/projects", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    if (!req.body.name) return res.status(400).json({ ok: false, error: "Project name is required" });
    const username = auth.getLoggedInUser(req);
    const projectData = {
      ...req.body,
      createdBy: username || "system",
      createdAt: new Date().toISOString()
    };
    const project = await store.createProject(projectData);
    await store.setActiveProject(project.id);

    // Auto-grant access to creator
    if (username) {
      await accessStore.grantAccess({ projectId: project.id, username, accessLevel: "admin", grantedBy: "system" });
    }

    const slackService = require("../services/slackService");
    slackService.autoProvisionProjectSlackChannel({
      projectId: project.id,
      projectName: project.name,
      creator: username || "admin"
    }).catch(() => {});

    res.json({ ok: true, project });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// POST /api/projects/switch — Switch active project
router.post("/projects/switch", async (req, res) => {
  try {
    const targetId = req.body.id || req.body.projectId || req.body.slug;
    if (!targetId) return res.status(400).json({ ok: false, error: "Project ID is required" });
    const active = await store.setActiveProject(targetId);
    res.json({ ok: true, activeProject: active });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PUT /api/projects/:id
router.put("/projects/:id", async (req, res) => {
  try {
    const project = await store.updateProject(req.params.id, req.body);
    if (!project) return res.status(404).json({ ok: false, error: "Project not found" });
    res.json({ ok: true, project });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// DELETE /api/projects/:id — Destroy project & optionally provider repository
router.delete("/projects/:id", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const { id } = req.params;
    const { deleteRepos } = req.body || {};
    const project = await store.getProject(id);
    if (!project) return res.status(404).json({ ok: false, error: "Project not found" });

    // Enterprise Safety Guard: Reject deletion if initial or deployment infrastructure is active
    if (project.initialTfApplied || project.deploymentTfApplied) {
      const activeSteps = [];
      if (project.initialTfApplied) activeSteps.push("Initial Infrastructure (Step 1)");
      if (project.deploymentTfApplied) activeSteps.push("Deployment Infrastructure (Step 2)");
      return res.status(400).json({
        ok: false,
        error: `Cannot delete project while active infrastructure is running (${activeSteps.join(", ")}). Please destroy infrastructure first.`
      });
    }

    // Delete connected repository from provider if requested
    if (deleteRepos && (project.repoName || project.githubRepo)) {
      const targetRepo = project.repoName || project.githubRepo;
      if (project.sourceType === "codecommit" || !project.sourceType) {
        try {
          const aws = require("../config/aws");
          await aws.deleteRepo(project.region || "us-east-1", targetRepo);
        } catch (e) {
          console.error("CodeCommit repo deletion notice:", e.message);
        }
      }
    }

    await store.deleteProject(id);
    const username = auth.getLoggedInUser(req);
    const auditStore = require("../stores/auditStore");
    auditStore.logAction(username || "admin", `Destroyed project ${project.name}`, project.name, "Success", "User Management");

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/settings/buildspec — Returns the platform's generic buildspec template
router.get("/settings/buildspec", (req, res) => {
  try {
    const fs = require("fs");
    const path = require("path");
    const filepath = path.join(__dirname, "../data/generic-buildspec.yml");
    const content = fs.existsSync(filepath) ? fs.readFileSync(filepath, "utf8") : "";
    res.json({ ok: true, buildspec: content });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PUT /api/projects/:id/buildspec — Updates the custom buildspec and updates CodeBuild instantly
router.put("/projects/:id/buildspec", async (req, res) => {
  try {
    const project = await store.getProject(req.params.id);
    if (!project) return res.status(404).json({ ok: false, error: "Project not found" });

    const { customBuildspec } = req.body;
    const updated = await store.updateProject(req.params.id, { customBuildspec });

    // Instantly update AWS CodeBuild if the project has a CodeBuild project name
    console.log(`[buildspec] project.buildProjectName=${project.buildProjectName} initialTfApplied=${project.initialTfApplied}`);
    if (project.buildProjectName) {
      try {
        const aws = require("../aws");
        await aws.updateBuildProject(project.region || "us-east-1", project.buildProjectName, customBuildspec);
        console.log(`[buildspec] ✔ CodeBuild project '${project.buildProjectName}' updated successfully`);
      } catch (awsErr) {
        console.error(`[buildspec] ✘ Failed to update CodeBuild:`, awsErr.message);
        // Still return success for DB save, but include a warning
        return res.json({ ok: true, project: updated, warning: `Saved to DB but CodeBuild update failed: ${awsErr.message}` });
      }
    } else {
      console.warn(`[buildspec] Skipping CodeBuild update — buildProjectName not set on project '${project.name}'`);
    }

    res.json({ ok: true, project: updated });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Shared helper functions exported for use by other route modules ---

// helper: resolve project or 400 (async)
async function requireProject(req, res) {
  const id = req.query.projectId || req.body.projectId;
  if (!id) { res.status(400).json({ ok: false, error: "projectId is required" }); return null; }
  const project = await store.getProject(id);
  if (!project) { res.status(404).json({ ok: false, error: "Project not found" }); return null; }
  return project;
}

// Same as requireProject, but also confirms this project actually has a
// GitHub repo wired up (sourceType !== "codecommit" and owner/repo are set).
// All /api/github/* routes need this.
async function requireGithubProject(req, res) {
  const project = await requireProject(req, res); if (!project) return null;
  if (project.sourceType === "codecommit") {
    res.status(400).json({ ok: false, error: "This project uses CodeCommit, not GitHub." });
    return null;
  }
  if (!project.githubOwner || !project.githubRepo) {
    res.status(400).json({ ok: false, error: "No GitHub repository is connected to this project yet." });
    return null;
  }
  return project;
}

module.exports = router;
module.exports.requireProject = requireProject;
module.exports.requireGithubProject = requireGithubProject;
