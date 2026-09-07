const router = require("express").Router();
const auth = require("../middleware/auth");
const { requireProject } = require("./projects");
const {
  ECSClient, DescribeServicesCommand, ListTasksCommand,
  DescribeTasksCommand
} = require("@aws-sdk/client-ecs");

// ─── Helper: resolve project cluster/service names per env ────────────────
function resolveEnvConfig(project, env) {
  const isProd = env === "prod";
  const cluster = isProd
    ? (project.ecsClusterNameProd || project.ecsClusterName || "")
    : (project.ecsClusterNameNonProd || project.ecsClusterName || "");
  const serviceMap = {
    dev:  project.devServiceName  || "",
    uat:  project.uatServiceName  || "",
    prod: project.prodServiceName || "",
  };
  return { cluster, service: serviceMap[env] || "" };
}

// ─── Fetch one env's metrics in a single function (for parallelization) ──
async function fetchEnvMetrics(ecsClient, cluster, service) {
  if (!cluster || !service) {
    return {
      cpu: { avg: null, max: null },
      memory: { avg: null, max: null },
      service: { desiredCount: 0, runningCount: 0, status: "unconfigured" },
      tasks: [],
    };
  }

  // Step 1: Get service health
  let serviceInfo = { desiredCount: 0, runningCount: 0, status: "unknown" };
  try {
    const svcResp = await ecsClient.send(new DescribeServicesCommand({
      cluster, services: [service],
    }));
    const svc = (svcResp.services || [])[0];
    if (svc) {
      serviceInfo = {
        desiredCount:   svc.desiredCount   || 0,
        runningCount:   svc.runningCount   || 0,
        pendingCount:   svc.pendingCount   || 0,
        status:         svc.status         || "UNKNOWN",
        launchType:     svc.launchType     || "FARGATE",
        taskDefinition: svc.taskDefinition || "",
      };
    }
  } catch (e) {
    serviceInfo.error = e.message;
  }

  // Step 2: If running, get task details — but only if service is up
  let taskDetails = [];
  if (serviceInfo.runningCount > 0) {
    try {
      const listResp = await ecsClient.send(new ListTasksCommand({
        cluster, serviceName: service, desiredStatus: "RUNNING",
      }));
      const taskArns = listResp.taskArns || [];
      if (taskArns.length > 0) {
        const descResp = await ecsClient.send(new DescribeTasksCommand({
          cluster, tasks: taskArns,
        }));
        taskDetails = (descResp.tasks || []).map(t => ({
          taskArn:      t.taskArn || "",
          lastStatus:   t.lastStatus || "",
          healthStatus: t.healthStatus || "UNKNOWN",
          cpu:          t.cpu || "",
          memory:       t.memory || "",
          createdAt:    t.createdAt || null,
          containers:   (t.containers || []).map(c => ({
            name:         c.name || "",
            lastStatus:   c.lastStatus || "",
            healthStatus: c.healthStatus || "UNKNOWN",
          })),
        }));
      }
    } catch (_) {}
  }

  // Step 3: Sum up CPU/memory reservations
  let totalCpu = 0, totalMemory = 0;
  taskDetails.forEach(t => {
    totalCpu    += parseInt(t.cpu, 10)    || 0;
    totalMemory += parseInt(t.memory, 10) || 0;
  });

  return {
    cpu: {
      avg: serviceInfo.runningCount > 0 ? totalCpu : null,
      max: totalCpu, unit: "units",
      note: "ECS task CPU reservations (not utilization %)",
    },
    memory: {
      avg: serviceInfo.runningCount > 0 ? totalMemory : null,
      max: totalMemory, unit: "MiB",
      note: "ECS task memory reservations (not utilization %)",
    },
    service: serviceInfo,
    tasks: taskDetails,
  };
}

// ─── GET /api/monitoring/:projectId/metrics ──────────────────────────────
// All envs fetched IN PARALLEL for fast loading (~2-3s instead of 15-20s)
router.get("/:projectId/metrics", auth.requireAuth, async (req, res) => {
  try {
    req.query.projectId = req.params.projectId;
    const project = await requireProject(req, res);
    if (!project) return;

    const region = project.region || "us-east-1";
    const ecsClient = new ECSClient({ region });

    // Build env configs
    const envConfigs = {};
    for (const env of ["dev", "uat", "prod"]) {
      envConfigs[env] = resolveEnvConfig(project, env);
    }
    // Beta
    if (project.prodBetaServiceName) {
      const cluster = project.ecsClusterNameProd || project.ecsClusterName || "";
      envConfigs.beta = { cluster, service: project.prodBetaServiceName };
    }

    // Fetch ALL envs in parallel — this is the key performance fix
    const envNames = Object.keys(envConfigs);
    const envPromises = envNames.map(env => {
      const { cluster, service } = envConfigs[env];
      return fetchEnvMetrics(ecsClient, cluster, service);
    });

    const envResults = await Promise.all(envPromises);

    const results = {};
    envNames.forEach((env, i) => {
      results[env] = envResults[i];
    });

    res.json({ ok: true, metrics: results, region });
  } catch (err) {
    console.error("[monitoring] Metrics error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /api/monitoring/:projectId/services ─────────────────────────────
// Quick service health check — also parallelized
router.get("/:projectId/services", auth.requireAuth, async (req, res) => {
  try {
    req.query.projectId = req.params.projectId;
    const project = await requireProject(req, res);
    if (!project) return;

    const region = project.region || "us-east-1";
    const ecsClient = new ECSClient({ region });

    const envs = ["dev", "uat", "prod"];
    const configs = envs.map(env => ({
      env,
      ...resolveEnvConfig(project, env),
    }));
    if (project.prodBetaServiceName) {
      configs.push({
        env: "beta",
        cluster: project.ecsClusterNameProd || project.ecsClusterName || "",
        service: project.prodBetaServiceName,
      });
    }

    // Fetch all services in parallel
    const svcPromises = configs.map(async ({ env, cluster, service }) => {
      if (!cluster || !service) {
        return { env, status: "unconfigured", desired: 0, running: 0 };
      }
      try {
        const resp = await ecsClient.send(new DescribeServicesCommand({
          cluster, services: [service],
        }));
        const svc = (resp.services || [])[0];
        return {
          env, name: service, cluster,
          status:   svc?.status   || "UNKNOWN",
          desired:  svc?.desiredCount || 0,
          running:  svc?.runningCount || 0,
          pending:  svc?.pendingCount || 0,
          launchType: svc?.launchType || "FARGATE",
          taskDefinition: svc?.taskDefinition || "",
        };
      } catch (e) {
        return { env, status: "error", error: e.message, desired: 0, running: 0 };
      }
    });

    const services = await Promise.all(svcPromises);
    res.json({ ok: true, services, region });
  } catch (err) {
    console.error("[monitoring] Services error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /api/monitoring/:projectId/tasks/:env ────────────────────────────
router.get("/:projectId/tasks/:env", auth.requireAuth, async (req, res) => {
  try {
    req.query.projectId = req.params.projectId;
    const project = await requireProject(req, res);
    if (!project) return;

    const { env } = req.params;
    const { cluster, service } = resolveEnvConfig(project, env);
    if (!cluster || !service) {
      return res.json({ ok: true, tasks: [], env });
    }

    const ecsClient = new ECSClient({ region: project.region || "us-east-1" });
    const listResp = await ecsClient.send(new ListTasksCommand({
      cluster, serviceName: service, desiredStatus: "RUNNING",
    }));

    const taskArns = listResp.taskArns || [];
    if (taskArns.length === 0) {
      return res.json({ ok: true, tasks: [], env, count: 0 });
    }

    const descResp = await ecsClient.send(new DescribeTasksCommand({
      cluster, tasks: taskArns,
    }));

    const tasks = (descResp.tasks || []).map(t => ({
      taskArn:       t.taskArn,
      lastStatus:    t.lastStatus,
      desiredStatus: t.desiredStatus,
      healthStatus:  t.healthStatus || "UNKNOWN",
      cpu:           t.cpu || "",
      memory:        t.memory || "",
      taskDefinitionArn: t.taskDefinitionArn,
      containers:    (t.containers || []).map(c => ({
        name:         c.name,
        lastStatus:   c.lastStatus,
        healthStatus: c.healthStatus || "UNKNOWN",
        runtimeId:    c.runtimeId,
      })),
      createdAt:     t.createdAt,
    }));

    res.json({ ok: true, tasks, env, count: tasks.length });
  } catch (err) {
    console.error("[monitoring] Tasks error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
