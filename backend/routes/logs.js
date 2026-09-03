const router = require("express").Router();
const auth = require("../middleware/auth");
const { requireProject } = require("./projects");
const { CloudWatchLogsClient, FilterLogEventsCommand } = require("@aws-sdk/client-cloudwatch-logs");

// Helper to determine the log group name based on the environment
function getLogGroupName(project, env) {
  if (env === "dev") {
    return `/ecs/${project.ecsClusterNameNonProd}-dev`;
  } else if (env === "uat") {
    return `/ecs/${project.ecsClusterNameNonProd}-uat`;
  } else if (env === "prod") {
    return `/ecs/${project.ecsClusterNameProd}-prod`;
  } else if (env === "beta") {
    return `/ecs/${project.ecsClusterNameProd}-prod-beta`;
  }
  return null;
}

// GET /api/logs/:projectId/:env
router.get("/:projectId/:env", auth.requireAuth, async (req, res) => {
  try {
    req.query.projectId = req.params.projectId; // Required for requireProject helper
    const project = await requireProject(req, res);
    if (!project) return;

    const { env } = req.params;
    const { nextToken, startTime } = req.query;

    const logGroupName = getLogGroupName(project, env);
    if (!logGroupName) {
      return res.status(400).json({ ok: false, error: "Invalid environment specified." });
    }

    const region = project.region || "us-east-1";
    const client = new CloudWatchLogsClient({ region });

    const params = {
      logGroupName,
      limit: 100, // Fetch up to 100 logs per request
      interleaved: true, // Chronological order across streams
    };

    if (nextToken) {
      params.nextToken = nextToken;
    } else {
      // If no nextToken is provided, fetch logs from the last 2 hours by default
      // or from the specified startTime
      params.startTime = startTime ? parseInt(startTime, 10) : Date.now() - (2 * 60 * 60 * 1000);
    }

    try {
      const command = new FilterLogEventsCommand(params);
      const response = await client.send(command);

      const events = (response.events || []).map(e => ({
        timestamp: e.timestamp,
        message: e.message,
        logStreamName: e.logStreamName
      }));

      res.json({
        ok: true,
        events,
        nextToken: response.nextToken,
        logGroupName
      });
    } catch (awsErr) {
      if (awsErr.name === 'ResourceNotFoundException') {
        // Log group might not exist yet if no tasks have run
        return res.json({ ok: true, events: [], nextToken: null, logGroupName, notFound: true });
      }
      throw awsErr;
    }

  } catch (err) {
    console.error("[logs] Error fetching logs:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
