const router = require("express").Router();
const auth = require("../middleware/auth");
const { requireProject } = require("./projects");
const { CloudWatchLogsClient, FilterLogEventsCommand } = require("@aws-sdk/client-cloudwatch-logs");

// Helper to determine the log group name based on the environment
function getLogGroupName(project, env) {
  if (env === "dev")  return `/ecs/${project.ecsClusterNameNonProd}-dev`;
  if (env === "uat")  return `/ecs/${project.ecsClusterNameNonProd}-uat`;
  if (env === "prod") return `/ecs/${project.ecsClusterNameProd}-prod`;
  if (env === "beta") return `/ecs/${project.ecsClusterNameProd}-prod-beta`;
  return null;
}

// Shared helper to call FilterLogEvents
async function filterLogs(client, logGroupName, params) {
  try {
    const command = new FilterLogEventsCommand({ logGroupName, interleaved: true, ...params });
    const response = await client.send(command);
    return {
      ok: true,
      events: (response.events || []).map(e => ({
        timestamp: e.timestamp,
        message: e.message,
        logStreamName: e.logStreamName
      })),
      nextToken: response.nextToken,
      logGroupName
    };
  } catch (awsErr) {
    if (awsErr.name === "ResourceNotFoundException") {
      return { ok: true, events: [], nextToken: null, logGroupName, notFound: true };
    }
    throw awsErr;
  }
}

// GET /api/logs/search/:projectId/:env — searchable log query with filters
// MUST be registered BEFORE /:projectId/:env so Express doesn't treat "search" as a projectId
// Query params: filterPattern, startTime (ms epoch), endTime (ms epoch), limit
router.get("/search/:projectId/:env", auth.requireAuth, async (req, res) => {
  try {
    req.query.projectId = req.params.projectId;
    const project = await requireProject(req, res);
    if (!project) return;

    const { env } = req.params;
    const { filterPattern, startTime, endTime, limit } = req.query;

    const logGroupName = getLogGroupName(project, env);
    if (!logGroupName) return res.status(400).json({ ok: false, error: "Invalid environment." });

    const client = new CloudWatchLogsClient({ region: project.region || "us-east-1" });

    // Default: last 24 hours if no range given
    const now = Date.now();
    const params = {
      limit: Math.min(parseInt(limit, 10) || 200, 500),
      startTime: startTime ? parseInt(startTime, 10) : now - 24 * 60 * 60 * 1000,
      endTime:   endTime   ? parseInt(endTime, 10)   : now,
    };

    // CloudWatch filterPattern: empty string means "all logs"
    if (filterPattern && filterPattern.trim()) {
      params.filterPattern = filterPattern.trim();
    }

    res.json(await filterLogs(client, logGroupName, params));
  } catch (err) {
    console.error("[logs] Search error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/logs/:projectId/:env — live streaming (polling)
router.get("/:projectId/:env", auth.requireAuth, async (req, res) => {
  try {
    req.query.projectId = req.params.projectId;
    const project = await requireProject(req, res);
    if (!project) return;

    const { env } = req.params;
    const { nextToken, startTime } = req.query;

    const logGroupName = getLogGroupName(project, env);
    if (!logGroupName) return res.status(400).json({ ok: false, error: "Invalid environment." });

    const client = new CloudWatchLogsClient({ region: project.region || "us-east-1" });
    const params = { limit: 100 };
    if (nextToken) {
      params.nextToken = nextToken;
    } else {
      params.startTime = startTime ? parseInt(startTime, 10) : Date.now() - (2 * 60 * 60 * 1000);
    }

    res.json(await filterLogs(client, logGroupName, params));
  } catch (err) {
    console.error("[logs] Live fetch error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
