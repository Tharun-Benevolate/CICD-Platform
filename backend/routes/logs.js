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

// ── Category → native CloudWatch filter pattern ────────────────────────────
// Doing the filtering *inside* CloudWatch (instead of downloading everything
// and filtering client-side) is what makes "Errors & Fails" / "Warnings" /
// "Application" fast and complete — CloudWatch only ships back matching
// lines, so the payload stays small even across a large time range.
const CATEGORY_PATTERNS = {
  error: '?ERROR ?Error ?error ?EXCEPTION ?Exception ?exception ?FATAL ?Fatal ?FAIL ?Fail ?fail ?panic ?PANIC ?"500 "',
  warn:  '?WARN ?Warn ?warn ?WARNING ?Warning ?deprecated ?Deprecated ?"429 "',
  info:  '?INFO ?Info ?info ?notice ?Notice ?listening ?Listening ?started ?Started ?healthy ?Healthy',
};

// ── Housekeeping noise to always mute ───────────────────────────────────────
// Apache (and similar servers) log its own routine worker-recycling chatter
// at "notice" level — caught SIGWINCH, "resuming normal operations", the
// command-line echo — which otherwise floods every view every few minutes
// with zero signal. These are excluded from every preset category *and* from
// the default "All" view. An explicit typed search (Search Logs text box)
// always overrides this, since that's the user deliberately asking to see
// something specific.
const NOISE_EXCLUDE_TERMS = [
  '-SIGWINCH',
  '-"resuming normal operations"',
  '-"Command line:"',
];

function buildFilterPattern({ category, filterPattern }) {
  const custom = (filterPattern || "").trim();
  if (custom) return custom; // explicit text search always wins — never mute what the user typed
  const preset = CATEGORY_PATTERNS[(category || "").toLowerCase()];
  const noise = NOISE_EXCLUDE_TERMS.join(" ");
  return preset ? `${preset} ${noise}` : noise;
}

// ── Tiny short-lived response cache ─────────────────────────────────────────
// The Live Stream view polls every few seconds and Search re-runs the same
// query on "Load more" / re-render — caching identical CloudWatch queries for
// a few seconds avoids redundant AWS round-trips and makes the UI feel instant
// without risking stale results for a genuinely new query.
const CACHE_TTL_MS = 4000;
const _cache = new Map();
function cacheGet(key) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { _cache.delete(key); return null; }
  return hit.value;
}
function cacheSet(key, value) {
  _cache.set(key, { value, at: Date.now() });
  // Opportunistic cleanup so this never grows unbounded
  if (_cache.size > 500) {
    const cutoff = Date.now() - CACHE_TTL_MS;
    for (const [k, v] of _cache) if (v.at < cutoff) _cache.delete(k);
  }
}

// Shared helper to call FilterLogEvents
async function filterLogs(client, logGroupName, params, cacheKey) {
  if (cacheKey) {
    const cached = cacheGet(cacheKey);
    if (cached) return { ...cached, cached: true };
  }

  try {
    const command = new FilterLogEventsCommand({ logGroupName, interleaved: true, ...params });
    const response = await client.send(command);
    const result = {
      ok: true,
      events: (response.events || []).map(e => ({
        timestamp: e.timestamp,
        message: e.message,
        logStreamName: e.logStreamName
      })),
      nextToken: response.nextToken,
      logGroupName
    };
    if (cacheKey) cacheSet(cacheKey, result);
    return result;
  } catch (awsErr) {
    if (awsErr.name === "ResourceNotFoundException") {
      const result = { ok: true, events: [], nextToken: null, logGroupName, notFound: true };
      if (cacheKey) cacheSet(cacheKey, result);
      return result;
    }
    throw awsErr;
  }
}

// GET /api/logs/search/:projectId/:env — searchable log query with filters
// MUST be registered BEFORE /:projectId/:env so Express doesn't treat "search" as a projectId
// Query params: filterPattern, category (error|warn|info), startTime (ms epoch), endTime (ms epoch), limit
router.get("/search/:projectId/:env", auth.requireAuth, async (req, res) => {
  try {
    req.query.projectId = req.params.projectId;
    const project = await requireProject(req, res);
    if (!project) return;

    const { env } = req.params;
    const { filterPattern, category, startTime, endTime, limit, nextToken } = req.query;

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
    if (nextToken) params.nextToken = nextToken;

    // CloudWatch filterPattern: empty string means "all logs"
    const pattern = buildFilterPattern({ category, filterPattern });
    if (pattern) params.filterPattern = pattern;

    const cacheKey = !nextToken
      ? `search:${logGroupName}:${JSON.stringify(params)}`
      : null; // never cache paginated "load more" calls — nextToken is one-shot

    res.json(await filterLogs(client, logGroupName, params, cacheKey));
  } catch (err) {
    console.error("[logs] Search error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/logs/:projectId/:env — live streaming (polling)
// Query params: nextToken, startTime, type (all|error|warn|info) — mirrors search categories
// so "Errors & Fails" / "Warnings" in Live mode are filtered by CloudWatch itself,
// not just scanned out of whatever happened to be in the last poll.
router.get("/:projectId/:env", auth.requireAuth, async (req, res) => {
  try {
    req.query.projectId = req.params.projectId;
    const project = await requireProject(req, res);
    if (!project) return;

    const { env } = req.params;
    const { nextToken, startTime, type } = req.query;

    const logGroupName = getLogGroupName(project, env);
    if (!logGroupName) return res.status(400).json({ ok: false, error: "Invalid environment." });

    const client = new CloudWatchLogsClient({ region: project.region || "us-east-1" });
    const params = { limit: 150 };
    if (nextToken) {
      params.nextToken = nextToken;
    } else {
      // Default lookback bumped from 2h -> 24h (matches Search Logs' default).
      // With only a 2h window, any tab that hadn't been polling continuously
      // (e.g. you just switched envs, or the only matching event — like a
      // one-off startup warning — is a few hours old) would silently show
      // "no matching activity" even though the event is sitting right there
      // in CloudWatch. Combined with the per-tab cache below, this is now
      // only paid once per tab (first visit), not on every switch.
      params.startTime = startTime ? parseInt(startTime, 10) : Date.now() - (24 * 60 * 60 * 1000);
    }

    const pattern = buildFilterPattern({ category: type });
    if (pattern) params.filterPattern = pattern;

    // Only cache the "start of stream" call (no nextToken) — this is what the
    // 3s poll interval repeats most often across tabs/users on the same env.
    const cacheKey = !nextToken
      ? `live:${logGroupName}:${type || "all"}:${params.startTime}`
      : null;

    res.json(await filterLogs(client, logGroupName, params, cacheKey));
  } catch (err) {
    console.error("[logs] Live fetch error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
