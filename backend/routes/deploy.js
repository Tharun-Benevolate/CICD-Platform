// routes/deploy.js — ECS deployment, auto-scaling, and blue-green (CodeDeploy) routes.
// Extracted from server.js lines 1203-1667.

const router = require("express").Router();
const aws = require("../config/aws");
const auth = require("../middleware/auth");
const store = require("../stores/projectStore");
const auditStore = require("../stores/auditStore");
const { requireProject } = require("./projects");

// GET /api/ecs/service
router.get("/ecs/service", async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const env = req.query.env; // "dev" | "uat" | "prod"
    const serviceName = { dev: project.devServiceName, uat: project.uatServiceName, prod: project.prodServiceName }[env];
    if (!serviceName) return res.status(400).json({ ok: false, error: "Invalid or unconfigured environment" });
    const clusterName = env === 'prod' ? (project.ecsClusterNameProd || project.ecsClusterName) : (project.ecsClusterNameNonProd || project.ecsClusterName);
    const service = await aws.describeEcsService(project.region, clusterName, serviceName);
    let imageUri = "";
    if (service && service.taskDefinition) {
      const taskDef = await aws.describeTaskDefinition(project.region, service.taskDefinition);
      if (taskDef && taskDef.containerDefinitions && taskDef.containerDefinitions[0]) {
        imageUri = taskDef.containerDefinitions[0].image;
      }
    }
    res.json({ ok: true, service, imageUri });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/ecs/deploy — Manually deploy a chosen build (from history) to a chosen environment
// This IS the rollback mechanism too
router.post("/ecs/deploy", async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const { env, imageUri, buildNumber, comment } = req.body;
    if (env === "prod" && !comment) {
      return res.status(400).json({ ok: false, error: "Deployment comment/reason is required for Production." });
    }

    const serviceMap = { dev: project.devServiceName, uat: project.uatServiceName, prod: project.prodServiceName };
    const serviceName = serviceMap[env];
    if (!serviceName) return res.status(400).json({ ok: false, error: "Invalid or unconfigured environment" });
    if (!imageUri) return res.status(400).json({ ok: false, error: "imageUri is required" });

    const clusterName = env === 'prod' ? (project.ecsClusterNameProd || project.ecsClusterName) : (project.ecsClusterNameNonProd || project.ecsClusterName);
    const result = await aws.deployImageToService(project.region, {
      clusterName: clusterName,
      serviceName,
      family: `${clusterName}-${env}`,
      image: imageUri,
      executionRoleArn: project.ecsExecutionRoleArn,
      taskRoleArn: project.ecsTaskRoleArn
    });

    // Coordinate with CodePipeline: If there is a pending approval for this environment, approve it automatically!
    if (project.pipelineName && (env === "uat" || env === "prod")) {
      try {
        const pending = await aws.getPendingApprovals(project.region, project.pipelineName);
        const match = pending.find(p => p.envGate === env);
        if (match && match.token) {
          console.log(`Auto-approving pipeline action ${match.actionName} in stage ${match.stageName} for env ${env}`);
          await aws.approveAction(
            project.region,
            project.pipelineName,
            match.stageName,
            match.actionName,
            match.token,
            true,
            comment || `Approved automatically via manual Build History deployment to ${env.toUpperCase()}`
          );
        }
      } catch (cpErr) {
        console.error("Failed to auto-approve matching pipeline action:", cpErr);
      }
    }

    // record which env this build was deployed to, in history
    let history = project.buildHistory || [];
    let found = false;
    history = history.map(b => {
      if (b.buildNumber === buildNumber || b.imageUri === imageUri) {
        found = true;
        return { ...b, deployedTo: [...new Set([...(b.deployedTo || []), env])] };
      }
      return b;
    });
    if (!found) {
      const tag = imageUri.split(":").pop() || "latest";
      history.unshift({
        buildNumber: buildNumber || 1,
        imageTag: tag,
        imageUri,
        createdAt: new Date().toISOString(),
        deployedTo: [env]
      });
      history = history.slice(0, 10);
    }
    await store.updateProject(project.id, { buildHistory: history });

    // Detailed Audit Logging
    const user = auth.getLoggedInUser(req) || "unknown";
    const auditMsg = env === "prod"
      ? `Approved manual deployment of Build #${buildNumber || "unknown"} to PROD. Comment: "${comment}"`
      : `Manually deployed Build #${buildNumber || "unknown"} to ${env.toUpperCase()}`;
    auditStore.logAction(user, auditMsg, project.name, "Success");

    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Helper: Dynamically find live ECS cluster & service name across possible naming candidates
async function findLiveEcsService(region, project, env) {
  const name = project.name;
  const storedCluster = env === 'prod' ? (project.ecsClusterNameProd || project.ecsClusterName) : (project.ecsClusterNameNonProd || project.ecsClusterName);
  const storedSvc = { dev: project.devServiceName, uat: project.uatServiceName, prod: project.prodServiceName }[env];

  const clusterCandidates = [
    storedCluster,
    `${name}-cluster`,
    name,
    "golf-demo-cluster"
  ].filter(Boolean);

  const serviceCandidates = [
    storedSvc,
    `${name}-${env}`,
    `${name}_${env}`,
    `golf-demo-${env}`
  ].filter(Boolean);

  for (const cluster of clusterCandidates) {
    for (const serviceName of serviceCandidates) {
      try {
        const svc = await aws.describeEcsService(region, cluster, serviceName);
        if (svc && (svc.status === "ACTIVE" || svc.status === "DRAINING")) {
          // Persist correct names to project store if they differ
          const updates = {};
          if (env === 'prod' && project.ecsClusterNameProd !== cluster) updates.ecsClusterNameProd = cluster;
          if (env !== 'prod' && project.ecsClusterNameNonProd !== cluster) updates.ecsClusterNameNonProd = cluster;
          const svcKey = `${env}ServiceName`;
          if (project[svcKey] !== serviceName) updates[svcKey] = serviceName;
          if (Object.keys(updates).length > 0) {
            store.updateProject(project.id, updates).catch(e => console.error("Auto-sync project failed:", e.message));
          }

          return { cluster, serviceName, service: svc };
        }
      } catch (e) {
        // try next candidate
      }
    }
  }
  return null;
}

// GET /api/ecs/fleet-status — Batch fetch live ECS task counts and active images for dev, uat, prod
router.get(["/ecs/fleet-status", "/deploy/services"], async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const region = project.region || "us-east-1";

    const environments = ["dev", "uat", "prod"];
    const fleet = {};
    const servicesList = [];

    await Promise.all(environments.map(async (env) => {
      const match = await findLiveEcsService(region, project, env);
      if (!match) {
        fleet[env] = { environment: env, configured: false, runningCount: 0, desiredCount: 0, pendingCount: 0, imageUri: "" };
        servicesList.push(fleet[env]);
        return;
      }

      const { cluster, serviceName, service: svc } = match;
      let imageUri = "";
      if (svc && svc.taskDefinition) {
        try {
          const taskDef = await aws.describeTaskDefinition(region, svc.taskDefinition);
          if (taskDef && taskDef.containerDefinitions && taskDef.containerDefinitions[0]) {
            imageUri = taskDef.containerDefinitions[0].image || "";
          }
        } catch (_) {}
      }

      fleet[env] = {
        environment: env,
        configured: true,
        clusterName: cluster,
        serviceName,
        status: svc?.status || "UNKNOWN",
        runningCount: svc?.runningCount ?? 0,
        desiredCount: svc?.desiredCount ?? 0,
        pendingCount: svc?.pendingCount ?? 0,
        taskDefinition: svc?.taskDefinition || "",
        imageUri
      };
      servicesList.push(fleet[env]);
    }));

    res.json({ ok: true, fleet, services: servicesList });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/ecs/scale — Direct manual scaling override for desired task count
router.post(["/ecs/scale", "/deploy/scale"], auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const { environment, desiredCount } = req.body;
    const env = environment || req.body.env;
    const count = parseInt(desiredCount, 10);
    
    if (isNaN(count) || count < 0) {
      return res.status(400).json({ ok: false, error: "desiredCount must be a non-negative integer" });
    }

    const region = project.region || "us-east-1";
    const match = await findLiveEcsService(region, project, env);
    if (!match) return res.status(404).json({ ok: false, error: `Live ECS service for environment '${env}' not found in AWS.` });

    const { cluster, serviceName } = match;
    const updatedSvc = await aws.scaleEcsService(region, cluster, serviceName, count);

    const user = auth.getLoggedInUser(req) || "unknown";
    auditStore.logAction(user, `Scaled ${env.toUpperCase()} ECS service (${serviceName}) tasks to ${count}`, project.name, "Success");

    res.json({ ok: true, service: updatedSvc, desiredCount: count });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Manual Auto-scaling Controls (admin/devops only for changes; anyone with project access can view) ---

// GET /api/scaling/config
router.get("/scaling/config", async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const env = req.query.env;
    const region = project.region || "us-east-1";
    const match = await findLiveEcsService(region, project, env);
    if (!match) return res.json({ ok: true, configured: false, minCapacity: 1, maxCapacity: 5, targetCpuPercent: 70 });

    const config = await aws.getScalingConfig(region, match.cluster, match.serviceName);
    res.json({ ok: true, ...config });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/scaling/activity
router.get("/scaling/activity", async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const env = req.query.env;
    const region = project.region || "us-east-1";
    const match = await findLiveEcsService(region, project, env);
    if (!match) return res.json({ ok: true, activities: [] });

    const activities = await aws.getScalingActivity(region, match.cluster, match.serviceName);
    res.json({ ok: true, activities });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/scaling/config — admin only
router.post("/scaling/config", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const { env, minCapacity, maxCapacity, targetCpuPercent } = req.body;
    const region = project.region || "us-east-1";
    const match = await findLiveEcsService(region, project, env);
    if (!match) return res.status(404).json({ ok: false, error: `Live ECS service for environment '${env}' not found in AWS.` });

    const min = parseInt(minCapacity, 10);
    const max = parseInt(maxCapacity, 10);
    const target = parseFloat(targetCpuPercent);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min) {
      return res.status(400).json({ ok: false, error: "minCapacity/maxCapacity must be valid, with max >= min" });
    }
    if (!(target > 0 && target <= 100)) {
      return res.status(400).json({ ok: false, error: "targetCpuPercent must be between 0 and 100" });
    }

    const config = await aws.setScalingConfig(region, match.cluster, match.serviceName, {
      minCapacity: min, maxCapacity: max, targetCpuPercent: target
    });

    const user = auth.getLoggedInUser(req) || "unknown";
    auditStore.logAction(
      user,
      `Updated auto-scaling for ${env.toUpperCase()}: min=${min}, max=${max}, target CPU=${target}%.`,
      project.name,
      "Success"
    );

    res.json({ ok: true, ...config });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});


// --- Blue-Green Deployment (prod only) ---

// GET /api/bluegreen/weights
router.get("/bluegreen/weights", async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    if (!project.prodListenerRuleArn) {
      return res.status(400).json({ ok: false, error: "Blue-green infrastructure not deployed for this project yet. Re-run the deployment Terraform to create it." });
    }
    const weights = await aws.getBlueGreenWeights(project.region, project.prodListenerRuleArn);
    res.json({ ok: true, weights });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/bluegreen/weights — admin only
router.post("/bluegreen/weights", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const { blueWeight, greenWeight } = req.body;
    if (!project.prodListenerRuleArn || !project.prodBlueTargetGroupArn || !project.prodGreenTargetGroupArn) {
      return res.status(400).json({ ok: false, error: "Blue-green infrastructure not deployed for this project yet." });
    }
    const blue = parseInt(blueWeight, 10);
    const green = parseInt(greenWeight, 10);
    if (!Number.isInteger(blue) || !Number.isInteger(green) || blue < 0 || green < 0) {
      return res.status(400).json({ ok: false, error: "blueWeight/greenWeight must be non-negative integers" });
    }

    const weights = await aws.setBlueGreenWeights(
      project.region, project.prodListenerRuleArn,
      project.prodBlueTargetGroupArn, project.prodGreenTargetGroupArn,
      blue, green
    );

    const user = auth.getLoggedInUser(req) || "unknown";
    auditStore.logAction(user, `Shifted PROD blue-green traffic weights: blue=${blue}, green=${green}`, project.name, "Success");

    res.json({ ok: true, weights });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/bluegreen/deploy-green — admin only
// Deploy a chosen image to the GREEN prod service specifically, without touching blue or live traffic weights.
router.post("/bluegreen/deploy-green", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const { imageUri } = req.body;
    if (!project.prodGreenServiceName) {
      return res.status(400).json({ ok: false, error: "Green service not deployed for this project yet." });
    }
    if (!imageUri) return res.status(400).json({ ok: false, error: "imageUri is required" });

    const clusterName = project.ecsClusterNameProd || project.ecsClusterName;
    const result = await aws.deployImageToService(project.region, {
      clusterName: clusterName,
      serviceName: project.prodGreenServiceName,
      family: `${clusterName}-prod-green`,
      image: imageUri,
      executionRoleArn: project.ecsExecutionRoleArn,
      taskRoleArn: project.ecsTaskRoleArn
    });

    const user = auth.getLoggedInUser(req) || "unknown";
    auditStore.logAction(user, `Deployed image to PROD green service (traffic weight unchanged): ${imageUri}`, project.name, "Success");

    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/ecr/images
router.get("/ecr/images", async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    // Derive repo name from ecrRepoName, falling back to the last segment of ecrRepoUrl
    const repoName = project.ecrRepoName ||
      (project.ecrRepoUrl ? project.ecrRepoUrl.split("/").pop() : "");
    if (!repoName) return res.json({ ok: true, images: [] });
    const images = await aws.listEcrImages(project.region, repoName);
    res.json({ ok: true, images });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── CodeDeploy Blue/Green routes ──────────────────────────────────────────

// GET /api/bluegreen/status — live state of the most recent deployment
router.get("/bluegreen/status", auth.requireAuth, async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    if (!project.codedeployAppName) {
      return res.json({ ok: true, deployments: [], ready: false });
    }
    const deployments = await aws.listRecentDeployments(
      project.region || "us-east-1",
      project.codedeployAppName,
      project.codedeployDeploymentGroup
    );
    res.json({ ok: true, deployments });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/bluegreen/settings — save traffic shifting config to the project — admin only
router.post("/bluegreen/settings", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const { bgDeployConfig, bgTerminationWaitMins } = req.body;

    // Whitelist allowed built-in CodeDeploy ECS deployment configs
    const ALLOWED_CONFIGS = [
      "CodeDeployDefault.ECSAllAtOnce",
      "CodeDeployDefault.ECSLinear10PercentEvery1Minutes",
      "CodeDeployDefault.ECSLinear10PercentEvery3Minutes",
      "CodeDeployDefault.ECSCanary10Percent5Minutes",
      "CodeDeployDefault.ECSCanary10Percent15Minutes"
    ];
    if (bgDeployConfig && !ALLOWED_CONFIGS.includes(bgDeployConfig)) {
      return res.status(400).json({ ok: false, error: "Invalid deployment config name." });
    }
    const waitMins = parseInt(bgTerminationWaitMins, 10);
    if (isNaN(waitMins) || waitMins < 0 || waitMins > 2880) {
      return res.status(400).json({ ok: false, error: "Termination wait must be 0–2880 minutes." });
    }

    const updated = await store.updateProject(project.id, {
      bgDeployConfig: bgDeployConfig || project.bgDeployConfig,
      bgTerminationWaitMins: waitMins
    });
    const user = auth.getLoggedInUser(req);
    auditStore.logAction(user, "Blue-Green Settings Updated", project.name,
      `Config: ${updated.bgDeployConfig}, Soak: ${updated.bgTerminationWaitMins} min`);
    res.json({ ok: true, bgDeployConfig: updated.bgDeployConfig, bgTerminationWaitMins: updated.bgTerminationWaitMins });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/bluegreen/deploy-from-image — admin only
// Full "Promote to PROD" action:
//   1. Reads current PROD task definition to clone its settings (cpu, memory, roles, container name, port)
//   2. Registers a new task definition revision with the chosen ECR image
//   3. Applies soak time to the deployment group
//   4. Triggers a CodeDeploy Blue/Green deployment with the selected traffic config
router.post("/bluegreen/deploy-from-image", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    if (!project.codedeployAppName) {
      return res.status(400).json({ ok: false, error: "CodeDeploy is not configured for this project." });
    }
    const { imageUri } = req.body;
    if (!imageUri) return res.status(400).json({ ok: false, error: "imageUri is required." });

    const region       = project.region || "us-east-1";
    const soakMins     = typeof project.bgTerminationWaitMins === "number" ? project.bgTerminationWaitMins : 15;
    const deployConfig = project.bgDeployConfig || "CodeDeployDefault.ECSAllAtOnce";

    // ── Step 1: Read current PROD task def to clone its settings ──────────
    const clusterName = project.ecsClusterNameProd || project.ecsClusterName || "app";
    let family        = `${clusterName}-prod`;
    let containerName = family;
    let containerPort = 3000;
    let cpu           = "256";
    let memory        = "512";

    try {
      const prodService = await aws.describeEcsService(region, clusterName, project.prodServiceName);
      if (prodService && prodService.taskDefinition) {
        const td = await aws.describeTaskDefinition(region, prodService.taskDefinition);
        if (td) {
          family        = td.family || family;
          cpu           = td.cpu    || cpu;
          memory        = td.memory || memory;
          const c0 = td.containerDefinitions && td.containerDefinitions[0];
          if (c0) {
            containerName = c0.name || containerName;
            containerPort = (c0.portMappings && c0.portMappings[0] && c0.portMappings[0].containerPort) || containerPort;
          }
        }
      }
    } catch (e) {
      console.warn("[deploy-from-image] Could not read prod task def (using defaults):", e.message);
    }

    // ── Step 2: Register new task def revision with the chosen image ──────
    const newTaskDef = await aws.registerTaskDefinition(region, {
      family,
      image: imageUri,
      executionRoleArn: project.ecsExecutionRoleArn,
      taskRoleArn:      project.ecsTaskRoleArn || project.ecsExecutionRoleArn,
      containerName,
      containerPort,
      cpu,
      memory
    });

    // ── Step 3: Apply soak time to the deployment group ──────────────────
    try {
      await aws.updateDeploymentGroup(region, project.codedeployAppName, project.codedeployDeploymentGroup,
        { terminationWaitTimeInMinutes: soakMins });
    } catch (e) {
      console.warn("[deploy-from-image] updateDeploymentGroup failed (non-fatal):", e.message);
    }

    // ── Step 4: Trigger CodeDeploy deployment ────────────────────────────
    const result = await aws.createDeployment(region, {
      appName:             project.codedeployAppName,
      deploymentGroupName: project.codedeployDeploymentGroup,
      taskDefArn:          newTaskDef.taskDefinitionArn,
      containerName,
      containerPort,
      deploymentConfigName: deployConfig
    });

    const user = auth.getLoggedInUser(req);
    auditStore.logAction(user, "Blue-Green Deploy from Image", project.name,
      `Image: ${imageUri} → TaskDef: ${newTaskDef.taskDefinitionArn} → Deployment: ${result.deploymentId}`);

    res.json({
      ok: true,
      deploymentId:     result.deploymentId,
      taskDefinitionArn: newTaskDef.taskDefinitionArn
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/bluegreen/deploy — trigger a new CodeDeploy blue/green deployment — admin only
// Body: { taskDefArn, containerName?, containerPort? }
router.post("/bluegreen/deploy", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    if (!project.codedeployAppName) {
      return res.status(400).json({ ok: false, error: "CodeDeploy is not configured for this project. Apply the deployment Terraform first." });
    }
    const { taskDefArn, containerName, containerPort } = req.body;
    if (!taskDefArn) return res.status(400).json({ ok: false, error: "taskDefArn is required" });

    const region = project.region || "us-east-1";
    const soakMins = typeof project.bgTerminationWaitMins === "number" ? project.bgTerminationWaitMins : 15;
    const deployConfig = project.bgDeployConfig || "CodeDeployDefault.ECSAllAtOnce";

    // Apply soak time to the deployment group before deploying
    try {
      await aws.updateDeploymentGroup(region, project.codedeployAppName, project.codedeployDeploymentGroup,
        { terminationWaitTimeInMinutes: soakMins });
    } catch (e) {
      console.warn("[bluegreen/deploy] updateDeploymentGroup failed (non-fatal):", e.message);
    }

    const result = await aws.createDeployment(region, {
      appName: project.codedeployAppName,
      deploymentGroupName: project.codedeployDeploymentGroup,
      taskDefArn,
      containerName: containerName || "golf-demo-app",
      containerPort: containerPort || 3000,
      deploymentConfigName: deployConfig
    });

    auditStore.logAction(auth.getLoggedInUser(req), "CodeDeploy Blue/Green Deploy", project.name, `Deployment: ${result.deploymentId}`);
    res.json({ ok: true, deploymentId: result.deploymentId });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/bluegreen/rollback — stop in-progress deployment (auto-rollback fires) — admin only
router.post("/bluegreen/rollback", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const { deploymentId } = req.body;
    if (!deploymentId) return res.status(400).json({ ok: false, error: "deploymentId is required" });

    const result = await aws.stopDeployment(project.region || "us-east-1", deploymentId, true);
    auditStore.logAction(auth.getLoggedInUser(req), "CodeDeploy Rollback", project.name, `Deployment: ${deploymentId}`);
    res.json({ ok: true, status: result.status });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/bluegreen/continue — advance deployment past the READY gate (shift traffic) — admin only
router.post("/bluegreen/continue", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const { deploymentId } = req.body;
    if (!deploymentId) return res.status(400).json({ ok: false, error: "deploymentId is required" });

    await aws.continueDeployment(project.region || "us-east-1", deploymentId);
    auditStore.logAction(auth.getLoggedInUser(req), "CodeDeploy Continue", project.name, `Deployment: ${deploymentId}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
