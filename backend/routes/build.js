// routes/build.js — CodeBuild routes + build history management.
// Extracted from server.js lines 1018-1201.

const router = require("express").Router();
const aws = require("../config/aws");
const store = require("../stores/projectStore");
const { requireProject } = require("./projects");

// Internal: sync build history from ECR image tags into the project record.
// Self-heals by clearing stale ECR references if the repo no longer exists.
async function syncBuildHistoryFromEcr(project) {
  try {
    const ecrRepoName = project.ecrRepoName || (project.ecrRepoUrl ? project.ecrRepoUrl.split("/").pop() : "");
    if (!ecrRepoName) return project.buildHistory || [];

    const images = await aws.listEcrImages(project.region, ecrRepoName);
    if (!images || images.length === 0) return project.buildHistory || [];

    let history = project.buildHistory || [];
    let updated = false;

    // Check the last 10 images in ECR
    const recentImages = images.slice(0, 10);
    for (const img of recentImages) {
      const imgTags = img.imageTags || [];
      if (imgTags.length === 0) continue;

      const buildTag = imgTags.find(t => t.startsWith("build-")) || imgTags[0];
      const buildNumber = buildTag.startsWith("build-") ? parseInt(buildTag.replace("build-", "")) : 1;

      // Construct imageUri
      const repoUrl = project.ecrRepoUrl || `393886308751.dkr.ecr.${project.region}.amazonaws.com/${ecrRepoName}`;
      const imageUri = `${repoUrl}:${imgTags[0] || img.imageDigest}`;

      // Is this image already in history?
      const exists = history.some(b => b.imageUri === imageUri || (b.buildNumber === buildNumber && buildNumber > 1));
      if (!exists) {
        const pushedDate = img.imagePushedAt instanceof Date ? img.imagePushedAt.toISOString() : (img.imagePushedAt || new Date().toISOString());
        history.push({
          buildNumber,
          imageTag: buildTag,
          imageUri,
          createdAt: pushedDate,
          deployedTo: []
        });
        updated = true;
      }
    }

    if (updated) {
      // Sort history descending by buildNumber
      history.sort((a, b) => b.buildNumber - a.buildNumber);
      history = history.slice(0, 10);
      await store.updateProject(project.id, { buildHistory: history });
    }
    return history;
  } catch (err) {
    if (err.name === "RepositoryNotFoundException" || err.__type === "RepositoryNotFoundException") {
      // The ECR repo this project points at is genuinely gone (e.g. deployment
      // infra was destroyed before the fields-clearing fix existed, or was
      // destroyed manually outside the panel). Self-heal instead of
      // re-serving stale data and re-hitting AWS with the same dead repo
      // name on every single page load.
      console.warn(`ECR repo '${project.ecrRepoName || project.ecrRepoUrl}' no longer exists for project ${project.id} — clearing stale references.`);
      await store.updateProject(project.id, { ecrRepoUrl: null, buildHistory: [] });
      return [];
    }
    console.error("Error syncing build history from ECR:", err);
    return project.buildHistory || [];
  }
}

// GET /api/build/latest
router.get("/build/latest", async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const build = await aws.getLatestBuildForProject(project.region, project.buildProjectName);
    res.json({ ok: true, build });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/build/logs
router.get("/build/logs", async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const build = await aws.getLatestBuildForProject(project.region, project.buildProjectName);
    const logs = await aws.getBuildLogs(project.region, build);
    res.json({ ok: true, logs, status: build?.buildStatus || null });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/pipeline/stage-logs
router.get("/pipeline/stage-logs", async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const stageName = req.query.stageName || "";
    const lowerStage = stageName.toLowerCase();

    // 1. BUILD STAGE -> CodeBuild logs
    if (lowerStage.includes("build")) {
      const build = await aws.getLatestBuildForProject(project.region, project.buildProjectName);
      if (!build) {
        return res.json({ ok: true, logs: [{ message: "No active build found." }] });
      }
      const logs = await aws.getBuildLogs(project.region, build);
      return res.json({ ok: true, logs, status: build?.buildStatus || null });
    }

    // 2. DEPLOY STAGES -> ECS Service Events
    if (lowerStage.includes("deploy") || lowerStage.includes("prod")) {
      let env = "dev";
      if (lowerStage.includes("uat")) env = "uat";
      else if (lowerStage.includes("prod") || lowerStage.includes("production")) env = "prod";

      const serviceName = { dev: project.devServiceName, uat: project.uatServiceName, prod: project.prodServiceName }[env];
      if (!serviceName) {
        return res.json({ ok: true, logs: [{ message: `No ECS service configured for environment: ${env.toUpperCase()}` }] });
      }

      const clusterName = env === 'prod' ? (project.ecsClusterNameProd || project.ecsClusterName) : (project.ecsClusterNameNonProd || project.ecsClusterName);
      const service = await aws.describeEcsService(project.region, clusterName, serviceName);
      if (!service || !service.events) {
        return res.json({ ok: true, logs: [{ message: `Could not fetch ECS service events for ${serviceName}` }] });
      }

      const logs = service.events.slice().reverse().map(e => ({
        timestamp: new Date(e.createdAt).getTime(),
        message: `[${new Date(e.createdAt).toLocaleTimeString()}] ${e.message}`
      }));
      return res.json({ ok: true, logs });
    }

    // 3. SOURCE STAGE -> Commit info & Pipeline Trigger details
    if (lowerStage.includes("source")) {
      const executions = await aws.listPipelineExecutions(project.region, project.pipelineName);
      const latest = executions?.[0];
      if (!latest) {
        return res.json({ ok: true, logs: [{ message: "No pipeline execution history found." }] });
      }

      const rev = latest.artifactRevisions?.[0];
      const logs = [
        { message: `Pipeline Execution: ${latest.pipelineExecutionId}` },
        { message: `Trigger Mode: ${latest.trigger?.triggerType || "Manual/Git Push"}` },
        { message: `Execution Status: ${latest.status}` }
      ];

      if (rev) {
        logs.push(
          { message: `Source Commit ID: ${rev.revisionId}` },
          { message: `Commit Message: ${rev.revisionSummary || "No commit message provided"}` }
        );
      }
      return res.json({ ok: true, logs });
    }

    // 4. APPROVAL STAGES -> Static prompt / info
    if (lowerStage.includes("approve")) {
      const logs = [
        { message: `Pipeline manual approval gate: ${stageName}` },
        { message: "Awaiting approval comment and confirmation to proceed with promotion..." }
      ];
      return res.json({ ok: true, logs });
    }

    return res.json({ ok: true, logs: [{ message: `No logs available for stage: ${stageName}` }] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Helper: Find live AWS CodeBuild project name matching project candidates
async function findLiveCodeBuildProject(region, project) {
  const name = project.name;
  const storedName = project.buildProjectName;

  const candidates = [
    storedName,
    `${name}-build`,
    `${name}-cluster-build`,
    name
  ].filter(Boolean);

  const { CodeBuildClient, ListBuildsForProjectCommand } = require("@aws-sdk/client-codebuild");
  const cb = new CodeBuildClient({ region });

  for (const projName of candidates) {
    try {
      const res = await cb.send(new ListBuildsForProjectCommand({ projectName: projName }));
      if (res.ids) {
        if (project.buildProjectName !== projName) {
          store.updateProject(project.id, { buildProjectName: projName }).catch(e => console.error("Auto-sync buildProjectName failed:", e.message));
        }
        return projName;
      }
    } catch (e) {
      // try next candidate
    }
  }
  return storedName || null;
}

// POST /api/build/start or /api/build/trigger
router.post(["/build/start", "/build/trigger"], async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const region = project.region || "us-east-1";
    const projName = await findLiveCodeBuildProject(region, project);

    const build = await aws.startBuild(region, projName);
    res.json({ ok: true, build });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/build/execution-logs — fetch CloudWatch logs for a specific build ID
router.get("/build/execution-logs", async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const buildId = req.query.buildId;
    const region = project.region || "us-east-1";

    if (!buildId) return res.status(400).json({ ok: false, error: "buildId is required" });

    const { CodeBuildClient, BatchGetBuildsCommand } = require("@aws-sdk/client-codebuild");
    const cb = new CodeBuildClient({ region });
    const batchRes = await cb.send(new BatchGetBuildsCommand({ ids: [buildId] }));
    const build = batchRes.builds?.[0];

    if (!build) return res.status(404).json({ ok: false, error: "Build execution not found" });

    const logs = await aws.getBuildLogs(region, build);
    res.json({ ok: true, logs, buildStatus: build.buildStatus, build });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/build/history & /api/builds/history
router.get(["/build/history", "/builds/history"], async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const region = project.region || "us-east-1";
    const projName = await findLiveCodeBuildProject(region, project);
    if (!projName) {
      return res.json({
        ok: true,
        builds: [],
        history: [],
        projectName: project.name
      });
    }

    const { CodeBuildClient, ListBuildsForProjectCommand, BatchGetBuildsCommand } = require("@aws-sdk/client-codebuild");
    const cb = new CodeBuildClient({ region });

    let builds = [];
    try {
      const listRes = await cb.send(new ListBuildsForProjectCommand({ projectName: projName }));
      const ids = (listRes.ids || []).slice(0, 20);

      if (ids.length > 0) {
        const batchRes = await cb.send(new BatchGetBuildsCommand({ ids }));
        builds = (batchRes.builds || []).map(b => {
          let durationStr = "N/A";
          if (b.startTime && b.endTime) {
            const startMs = new Date(b.startTime).getTime();
            const endMs = new Date(b.endTime).getTime();
            const diffSec = Math.round((endMs - startMs) / 1000);
            const mins = Math.floor(diffSec / 60);
            const secs = diffSec % 60;
            durationStr = `${mins}m ${secs}s`;
          } else if (b.startTime) {
            const startMs = new Date(b.startTime).getTime();
            const diffSec = Math.round((Date.now() - startMs) / 1000);
            durationStr = `${Math.floor(diffSec / 60)}m ${diffSec % 60}s (In Progress)`;
          }

          return {
            id: b.id,
            buildNumber: b.buildNumber || parseInt(b.id.split(":").pop() || "1"),
            projectName: b.projectName || projName,
            status: b.buildStatus,
            currentPhase: b.currentPhase,
            startTime: b.startTime,
            endTime: b.endTime,
            duration: durationStr,
            sourceVersion: b.sourceVersion || (b.source?.location ? b.source.location.split("/").pop() : "main"),
            initiator: b.initiator || "AWS CodePipeline",
            logs: b.logs,
            environment: {
              computeType: b.environment?.computeType,
              image: b.environment?.image
            }
          };
        });
      }
    } catch (cbErr) {
      console.warn("Failed to fetch CodeBuild executions directly:", cbErr.message);
    }

    const history = await syncBuildHistoryFromEcr(project);

    res.json({
      ok: true,
      builds,
      history,
      projectName: projName
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;

