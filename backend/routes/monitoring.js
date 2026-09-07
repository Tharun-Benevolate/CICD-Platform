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

// ─── GET /api/monitoring/:projectId/metrics ──────────────────────────────
// Returns service health + task resource allocations for all envs
// NOTE: CPU/Memory *utilization percentages* require @aws-sdk/client-cloudwatch
// which is not yet installed. We show service health + task resource reservations.
// Once client-cloudwatch is added, we can fetch real utilization.
router.get("/:projectId/metrics", auth.requireAuth, async (req, res) => {
  try {
    req.query.projectId = req.params.projectId;
    const project = await requireProject(req, res);
    if (!project) return;

    const region = project.region || "us-east-1";
    const ecsClient = new ECSClient({ region });

    const envs = ["dev", "uat", "prod"];
    const results = {};

    for (const env of envs) {
      const { cluster, service } = resolveEnvConfig(project, env);
      if (!cluster || !service) {
        results[env] = {
          cpu: { avg: null, max: null },
          memory: { avg: null, max: null },
          service: { desiredCount: 0, runningCount: 0, status: "unconfigured", taskCount: 0 },
        };
        continue;
      }

      // Get service health (running vs desired)
      let serviceInfo = { desiredCount: 0, runningCount: 0, status: "unknown", taskCount: 0 };
      let taskDetails = [];
      try {
        const svcResp = await ecsClient.send(new DescribeServicesCommand({
          cluster: cluster,
          services: [service],
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
      } catch (svcErr) {
        serviceInfo.error = svcErr.message;
      }

      // Get running tasks and their CPU/memory reservations
      if (serviceInfo.runningCount > 0) {
        try {
          const listResp = await ecsClient.send(new ListTasksCommand({
            cluster,
            serviceName: service,
            desiredStatus: "RUNNING",
          }));
          const taskArns = listResp.taskArns || [];
          if (taskArns.length > 0) {
            const descResp = await ecsClient.send(new DescribeTasksCommand({
              cluster,
              tasks: taskArns,
            }));
            taskDetails = (descResp.tasks || []).map(t => ({
              taskArn:        t.taskArn || "",
              lastStatus:     t.lastStatus || "",
              healthStatus:   t.healthStatus || "UNKNOWN",
              cpu:            t.cpu || "",
              memory:         t.memory || "",
              launchType:     t.launchType || "",
              createdAt:      t.createdAt || null,
              containers:     (t.containers || []).map(c => ({
                name:         c.name || "",
                lastStatus:   c.lastStatus || "",
                healthStatus: c.healthStatus || "UNKNOWN",
              })),
            }));
          }
        } catch (_) {}
      }

      // Compute total CPU/memory reservations across tasks
      let totalCpu = 0, totalMemory = 0;
      taskDetails.forEach(t => {
        totalCpu    += parseInt(t.cpu, 10)    || 0;
        totalMemory += parseInt(t.memory, 10) || 0;
      });

      results[env] = {
        cpu: {
          avg: serviceInfo.runningCount > 0 ? totalCpu : null,
          max: totalCpu,
          unit: "units",
          note: "ECS task CPU reservations (not utilization %)",
        },
        memory: {
          avg: serviceInfo.runningCount > 0 ? totalMemory : null,
          max: totalMemory,
          unit: "MiB",
          note: "ECS task memory reservations (not utilization %)",
        },
        service: serviceInfo,
        tasks: taskDetails,
      };
    }

    // Also check beta if configured
    if (project.prodBetaServiceName) {
      const cluster = project.ecsClusterNameProd || project.ecsClusterName || "";
      const service = project.prodBetaServiceName;
      if (cluster && service) {
        let serviceInfo = { desiredCount: 0, runningCount: 0, status: "unknown" };
        let taskDetails = [];
        try {
          const svcResp = await ecsClient.send(new DescribeServicesCommand({
            cluster, services: [service],
          }));
          const svc = (svcResp.services || [])[0];
          if (svc) {
            serviceInfo = {
              desiredCount: svc.desiredCount || 0,
              runningCount: svc.runningCount || 0,
              pendingCount: svc.pendingCount || 0,
              status: svc.status || "UNKNOWN",
            };
          }
        } catch (_) {}

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
                taskArn: t.taskArn || "",
                lastStatus: t.lastStatus || "",
                healthStatus: t.healthStatus || "UNKNOWN",
                cpu: t.cpu || "",
                memory: t.memory || "",
                containers: (t.containers || []).map(c => ({
                  name: c.name || "", lastStatus: c.lastStatus || "",
                  healthStatus: c.healthStatus || "UNKNOWN",
                })),
              }));
            }
          } catch (_) {}
        }

        let totalCpu = 0, totalMemory = 0;
        taskDetails.forEach(t => {
          totalCpu    += parseInt(t.cpu, 10)    || 0;
          totalMemory += parseInt(t.memory, 10) || 0;
        });

        results.beta = {
          cpu: { avg: totalCpu || null, max: totalCpu, unit: "units",
            note: "ECS task CPU reservations (not utilization %)" },
          memory: { avg: totalMemory || null, max: totalMemory, unit: "MiB",
            note: "ECS task memory reservations (not utilization %)" },
          service: serviceInfo,
          tasks: taskDetails,
        };
      }
    }

    res.json({ ok: true, metrics: results, region });
  } catch (err) {
    console.error("[monitoring] Metrics error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /api/monitoring/:projectId/services ─────────────────────────────
// Quick service health check (just ECS API, no CloudWatch)
router.get("/:projectId/services", auth.requireAuth, async (req, res) => {
  try {
    req.query.projectId = req.params.projectId;
    const project = await requireProject(req, res);
    if (!project) return;

    const region = project.region || "us-east-1";
    const ecsClient = new ECSClient({ region });
    const envs = ["dev", "uat", "prod"];
    const services = [];

    for (const env of envs) {
      const { cluster, service } = resolveEnvConfig(project, env);
      if (!cluster || !service) {
        services.push({ env, status: "unconfigured", desired: 0, running: 0 });
        continue;
      }
      try {
        const resp = await ecsClient.send(new DescribeServicesCommand({
          cluster, services: [service],
        }));
        const svc = (resp.services || [])[0];
        services.push({
          env,
          name:     service,
          cluster,
          status:   svc?.status || "UNKNOWN",
          desired:  svc?.desiredCount  || 0,
          running:  svc?.runningCount  || 0,
          pending:  svc?.pendingCount  || 0,
          launchType: svc?.launchType  || "FARGATE",
          taskDefinition: svc?.taskDefinition || "",
        });
      } catch (e) {
        services.push({ env, status: "error", error: e.message, desired: 0, running: 0 });
      }
    }

    // Beta service
    if (project.prodBetaServiceName) {
      const cluster = project.ecsClusterNameProd || project.ecsClusterName || "";
      try {
        const resp = await ecsClient.send(new DescribeServicesCommand({
          cluster, services: [project.prodBetaServiceName],
        }));
        const svc = (resp.services || [])[0];
        services.push({
          env: "beta",
          name: project.prodBetaServiceName,
          cluster,
          status:   svc?.status || "UNKNOWN",
          desired:  svc?.desiredCount  || 0,
          running:  svc?.runningCount  || 0,
          pending:  svc?.pendingCount  || 0,
          launchType: svc?.launchType  || "FARGATE",
          taskDefinition: svc?.taskDefinition || "",
        });
      } catch (e) {
        services.push({ env: "beta", status: "error", error: e.message, desired: 0, running: 0 });
      }
    }

    res.json({ ok: true, services, region });
  } catch (err) {
    console.error("[monitoring] Services error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /api/monitoring/:projectId/tasks/:env ────────────────────────────
// List running ECS tasks for a specific environment (for debugging)
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
      cluster,
      serviceName: service,
      desiredStatus: "RUNNING",
    }));

    const taskArns = listResp.taskArns || [];
    if (taskArns.length === 0) {
      return res.json({ ok: true, tasks: [], env, count: 0 });
    }

    const descResp = await ecsClient.send(new DescribeTasksCommand({
      cluster,
      tasks: taskArns,
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
