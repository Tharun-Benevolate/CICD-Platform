// routes/pipeline.js — CodePipeline management routes.
// Extracted from server.js lines 705-867.

const router = require("express").Router();
const aws = require("../config/aws");
const auth = require("../middleware/auth");
const store = require("../stores/projectStore");
const auditStore = require("../stores/auditStore");
const { requireProject } = require("./projects");

// GET /api/pipeline/state & /api/pipeline/status
router.get(["/pipeline/state", "/pipeline/status"], async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const stages = await aws.getPipelineState(project.region, project.pipelineName);
    const executions = await aws.listPipelineExecutions(project.region, project.pipelineName);
    res.json({ ok: true, stages, stageStates: stages, executions: (executions || []).slice(0, 8) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/pipeline/approvals & /api/approvals — admin only
router.get(["/pipeline/approvals", "/approvals"], auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const pending = await aws.getPendingApprovals(project.region, project.pipelineName);
    res.json({
      ok: true,
      pending,
      approvals: pending,
      uat: pending.filter(p => p.envGate === "uat"),
      prod: pending.filter(p => p.envGate === "prod")
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/pipeline/approve & /api/approvals/action — admin only
router.post(["/pipeline/approve", "/approvals/action"], auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    let { stageName, actionName, token, approved, decision, comment } = req.body;

    const isApproved = approved !== undefined 
      ? Boolean(approved) 
      : (decision === "Approved" || decision === "approve" || decision === "APPROVED");

    // Auto-resolve token and actionName if missing
    if (!token || !actionName) {
      const pending = await aws.getPendingApprovals(project.region, project.pipelineName);
      const match = pending.find(p => p.stageName === stageName) || pending[0];
      if (match) {
        token = token || match.token;
        actionName = actionName || match.actionName;
        stageName = stageName || match.stageName;
      }
    }

    if (!stageName || !actionName || !token) {
      return res.status(400).json({ ok: false, error: "Missing required approval gate token or stage name." });
    }

    await aws.approveAction(project.region, project.pipelineName, stageName, actionName, token, isApproved, comment);
    res.json({ ok: true, status: isApproved ? "Approved" : "Rejected" });
    
    const user = auth.getLoggedInUser(req) || "unknown";
    const statusText = isApproved ? "Approved" : "Rejected";
    const auditMsg = `${statusText} stage "${stageName}" in pipeline. Reason/Comment: "${comment || "No comment provided"}"`;
    auditStore.logAction(user, auditMsg, project.name, "Success");
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/pipeline/live-status — SSE: push pipeline stage updates every 8s without client polling
router.get("/pipeline/live-status", async (req, res) => {
  const projectId = req.query.projectId;
  if (!projectId) { res.status(400).end(); return; }
  const project = await store.getProject(projectId).catch(() => null);
  if (!project || !project.pipelineName) { res.status(400).end(); return; }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch(e) {} };

  const poll = async () => {
    try {
      const [stages, executions] = await Promise.all([
        aws.getPipelineState(project.region, project.pipelineName),
        aws.listPipelineExecutions(project.region, project.pipelineName)
      ]);
      send({ stages: stages || [], executions: (executions || []).slice(0, 8) });
    } catch(e) { /* ignore transient AWS errors */ }
  };

  await poll(); // send immediately on connect
  const iv = setInterval(poll, 8000);
  req.on("close", () => clearInterval(iv));
});

// GET /api/pipeline/list
router.get("/pipeline/list", async (req, res) => {
  try {
    const region = req.query.region || process.env.AWS_REGION || "us-east-1";
    const pipelines = await aws.listPipelines(region);
    res.json({ ok: true, pipelines });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/pipeline/executions
router.get("/pipeline/executions", async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const executions = await aws.listPipelineExecutions(project.region, project.pipelineName);
    res.json({ ok: true, executions });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/pipeline/start
router.post("/pipeline/start", async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const user = auth.getLoggedInUser(req);
    const executionId = await aws.startPipeline(project.region, project.pipelineName);
    res.json({ ok: true, executionId });
    auditStore.logAction(user, "Triggered manual pipeline execution (Run Pipeline)", project.name, "Success");

    // Poll pipeline until it reaches a terminal state and log the final result
    const region = project.region;
    const pipelineName = project.pipelineName;
    const projectName = project.name;
    let attempts = 0;
    const pollPipeline = setInterval(async () => {
      attempts++;
      if (attempts > 120) { // stop polling after ~20 min
        clearInterval(pollPipeline);
        return;
      }
      try {
        const executions = await aws.listPipelineExecutions(region, pipelineName);
        const exec = (executions || []).find(e => e.pipelineExecutionId === executionId);
        if (!exec) return;
        const s = exec.status;
        if (s === "Succeeded") {
          clearInterval(pollPipeline);
          auditStore.logAction("system", "Pipeline execution", projectName, "Succeeded");
        } else if (s === "Failed" || s === "Stopped" || s === "Superseded") {
          clearInterval(pollPipeline);
          auditStore.logAction("system", "Pipeline execution", projectName, s);
        }
      } catch (e) { /* ignore transient errors */ }
    }, 10000); // poll every 10s
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/pipeline/approvals — admin only
router.get("/pipeline/approvals", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const pending = await aws.getPendingApprovals(project.region, project.pipelineName);
    res.json({
      ok: true,
      pending,
      uat: pending.filter(p => p.envGate === "uat"),
      prod: pending.filter(p => p.envGate === "prod")
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/pipeline/approve — admin only
router.post("/pipeline/approve", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const { stageName, actionName, token, approved, comment } = req.body;
    if (!stageName || !actionName || !token) {
      return res.status(400).json({ ok: false, error: "Missing required fields" });
    }
    await aws.approveAction(project.region, project.pipelineName, stageName, actionName, token, approved, comment);
    res.json({ ok: true, status: approved ? "Approved" : "Rejected" });
    
    const user = auth.getLoggedInUser(req) || "unknown";
    const statusText = approved ? "Approved" : "Rejected";
    const auditMsg = `${statusText} stage "${stageName}" in pipeline. Reason/Comment: "${comment || "No comment provided"}"`;
    auditStore.logAction(user, auditMsg, project.name, "Success");
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/pipeline/stop
router.post("/pipeline/stop", async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const { executionId } = req.body;
    if (!executionId) return res.status(400).json({ ok: false, error: "executionId required" });
    await aws.stopPipeline(project.region, project.pipelineName, executionId);
    
    const user = auth.getLoggedInUser(req) || "unknown";
    auditStore.logAction(user, `Stopped pipeline execution (${executionId.substring(0, 8)}...)`, project.name, "Success");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/pipeline/retry-stage
router.post("/pipeline/retry-stage", async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const { stageName, executionId } = req.body;
    if (!stageName || !executionId) return res.status(400).json({ ok: false, error: "stageName and executionId required" });
    await aws.retryStage(project.region, project.pipelineName, stageName, executionId);
    
    const user = auth.getLoggedInUser(req) || "unknown";
    auditStore.logAction(user, `Retried failed actions in stage "${stageName}"`, project.name, "Success");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
