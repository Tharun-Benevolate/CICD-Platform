// routes/betaRelease.js — Cookie-based Beta Environment + Release Management APIs.
// Preserved from the current platform (not the Updated Project CodeDeploy blue/green).
// Mount BEFORE routes/deploy.js so /bluegreen/status is this cookie-beta status.

const router = require("express").Router();
const aws = require("../config/aws");
const auth = require("../middleware/auth");
const auditStore = require("../stores/auditStore");
const betaOrgStore = require("../stores/betaOrgStore");
const releasePromotionStore = require("../stores/releasePromotionStore");
const gh = require("../services/githubService");
const { requireProject } = require("./projects");
const { betaTgNameFor } = require("../utils/projectNaming");

// GET /api/bluegreen/cookie-config
router.get("/bluegreen/cookie-config", auth.requireAuth, async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const ruleArn = project.prodBetaListenerRuleArn;
    if (!ruleArn) return res.json({ ok: true, cookieName: "__env", cookieValue: "beta", configured: false });
    const rule = await aws.getBetaListenerRule(project.region || "us-east-1", ruleArn);
    const httpHeader = (rule.Conditions || []).find(c => c.Field === "http-header");
    const rawPattern = httpHeader?.HttpHeaderConfig?.Values?.[0] || "*__env=beta*";
    const match = rawPattern.replace(/\*/g, "").match(/^([^=]+)=(.+)$/);
    res.json({ ok: true, cookieName: match?.[1] || "__env", cookieValue: match?.[2] || "beta", rawPattern, configured: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/bluegreen/cookie-config
router.post("/bluegreen/cookie-config", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const { cookieName, cookieValue } = req.body;
    if (!cookieName || !cookieValue) return res.status(400).json({ ok: false, error: "cookieName and cookieValue are required" });
    const ruleArn = project.prodBetaListenerRuleArn;
    if (!ruleArn) return res.status(400).json({ ok: false, error: "Beta listener rule not configured. Run Terraform apply first." });
    await aws.updateBetaListenerRule(project.region || "us-east-1", ruleArn, cookieName, cookieValue);
    const user = auth.getLoggedInUser(req) || "unknown";
    auditStore.logAction(user, `Updated beta cookie rule: ${cookieName}=${cookieValue}`, project.name, "Success");
    res.json({ ok: true, cookieName, cookieValue });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/release/build-branch
router.post("/release/build-branch", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const { branchName } = req.body;
    if (!branchName) return res.status(400).json({ ok: false, error: "branchName is required" });
    const codebuildProject = project.buildProjectName;
    if (!codebuildProject) return res.status(400).json({ ok: false, error: "CodeBuild project not configured for this project." });
    const sourceLocation = (project.githubOwner && project.githubRepo)
      ? `https://github.com/${project.githubOwner}/${project.githubRepo}.git`
      : null;
    const build = await aws.startBuildFromBranch(project.region || "us-east-1", codebuildProject, branchName, sourceLocation);
    const resolved = build.resolvedSourceVersion || "";
    if (build.sourceVersion && !String(build.sourceVersion).includes(branchName) && !/^[0-9a-f]{7,40}$/i.test(branchName)) {
      console.warn(`Release build sourceVersion=${build.sourceVersion} branch=${branchName}`);
    }
    const user = auth.getLoggedInUser(req) || "unknown";
    auditStore.logAction(user, `Ad-hoc build started for branch: ${branchName} (resolved ${resolved.slice(0, 8) || "pending"})`, project.name, "Success");
    res.json({ ok: true, buildId: build.id, buildArn: build.arn, buildStatus: build.buildStatus, sourceVersion: build.sourceVersion, resolvedSourceVersion: build.resolvedSourceVersion });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/release/build-status
router.get("/release/build-status", auth.requireAuth, async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const { buildId } = req.query;
    if (!buildId) return res.status(400).json({ ok: false, error: "buildId is required" });
    const region = project.region || "us-east-1";
    const build = await aws.getBuildById(region, buildId);
    if (!build) return res.status(404).json({ ok: false, error: "Build not found" });
    const logs = await aws.getBuildLogs(region, build).catch(() => []);
    const commitSha = build.resolvedSourceVersion || "";
    const shortSha = commitSha.slice(0, 8);
    const builtImage = (build.buildStatus === "SUCCEEDED" && project.ecrRepoUrl && shortSha)
      ? `${project.ecrRepoUrl}:${shortSha}`
      : null;
    res.json({
      ok: true,
      buildId: build.id,
      buildStatus: build.buildStatus,
      resolvedSourceVersion: commitSha,
      startTime: build.startTime,
      endTime: build.endTime,
      builtImage,
      logs
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/beta-orgs
router.get("/beta-orgs", auth.requireAuth, async (req, res) => {
  try {
    const orgs = await betaOrgStore.listBetaOrgs();
    res.json({ ok: true, orgs });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/beta-orgs
router.post("/beta-orgs", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const { orgId, orgName, notes, orgDomain } = req.body;
    if (!orgId) return res.status(400).json({ ok: false, error: "orgId is required" });
    if (!orgDomain || !String(orgDomain).trim()) {
      return res.status(400).json({ ok: false, error: "orgDomain is required — it's how users get mapped to this org" });
    }
    const user = auth.getLoggedInUser(req) || "unknown";
    const org = await betaOrgStore.addBetaOrg(orgId, orgName, user, notes, orgDomain);
    auditStore.logAction(user, `Added org to beta list: ${orgId} (${orgDomain})`, "System", "Success");
    res.json({ ok: true, org });
  } catch (err) {
    if (err.code === "DUPLICATE_ORG") return res.status(409).json({ ok: false, error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /api/beta-orgs/:orgId
router.delete("/beta-orgs/:orgId", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const { orgId } = req.params;
    const removed = await betaOrgStore.removeBetaOrg(orgId);
    if (!removed) return res.status(404).json({ ok: false, error: "Org not found in beta list" });
    const user = auth.getLoggedInUser(req) || "unknown";
    auditStore.logAction(user, `Removed org from beta list: ${orgId}`, "System", "Success");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/bluegreen/status — cookie-based beta environment status
router.get("/bluegreen/status", auth.requireAuth, async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    if (!project.prodBetaServiceName) {
      return res.json({ ok: true, betaActive: false, betaOrgs: [], betaTaskCount: 0 });
    }
    const region = project.region || "us-east-1";
    const [svc, orgs] = await Promise.all([
      aws.describeEcsService(region, project.ecsClusterNameProd || project.ecsClusterName, project.prodBetaServiceName).catch(() => null),
      betaOrgStore.listBetaOrgs()
    ]);
    const desiredCount = svc ? (svc.desiredCount || 0) : 0;
    const runningCount = svc ? (svc.runningCount || 0) : 0;
    const betaActive = desiredCount > 0;
    let betaImage = null;
    if (svc && svc.taskDefinition) {
      try {
        const td = await aws.describeTaskDefinition(region, svc.taskDefinition);
        betaImage = td && td.containerDefinitions && td.containerDefinitions[0]
          ? td.containerDefinitions[0].image : null;
      } catch (_) {}
    }
    res.json({
      ok: true,
      betaActive,
      desiredCount,
      runningCount,
      betaImage,
      betaOrgs: orgs,
      betaServiceName: project.prodBetaServiceName
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/bluegreen/beta/start
router.post("/bluegreen/beta/start", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    if (!project.prodBetaServiceName) {
      return res.status(400).json({ ok: false, error: "Beta service not deployed for this project. Apply Terraform first." });
    }
    const { imageUri } = req.body;
    if (!imageUri) return res.status(400).json({ ok: false, error: "imageUri is required" });
    const region = project.region || "us-east-1";
    const clusterName = project.ecsClusterNameProd || project.ecsClusterName;
    const result = await aws.deployImageToService(region, {
      clusterName: clusterName,
      serviceName: project.prodBetaServiceName,
      family: `${clusterName}-prod-beta`,
      image: imageUri,
      executionRoleArn: project.ecsExecutionRoleArn,
      taskRoleArn: project.ecsTaskRoleArn || project.ecsExecutionRoleArn
    });
    await aws.scaleEcsService(region, clusterName, project.prodBetaServiceName, 1);
    const stable = await aws.waitForServiceStable(region, clusterName, project.prodBetaServiceName);
    let priorityFix = null;
    if (project.prodBetaListenerRuleArn) {
      // Fix any rule-ordering drift BEFORE flipping the cookie condition back
      // on — otherwise a misordered rule makes the cookie a no-op and this
      // "start" appears to succeed while beta silently never receives traffic.
      const region2 = project.region || "us-east-1";
      const resolvedListenerArn = project.albListenerArn || (project.albDnsName ? await aws.getAlbListenerArn(region2, project.albDnsName) : null);
      const hostHeader = project.prodUrl ? project.prodUrl.replace(/^https?:\/\//, "").split("/")[0] : null;
      if (resolvedListenerArn && hostHeader) {
        priorityFix = await aws.ensureBetaRulePriorityBelowCatchAll(region2, resolvedListenerArn, project.prodBetaListenerRuleArn, hostHeader).catch(err => ({ fixed: false, reason: err.message }));
      }
      await aws.setBetaRoutingEnabled(region, project.prodBetaListenerRuleArn, true);
    }
    const user = auth.getLoggedInUser(req) || "unknown";
    auditStore.logAction(user, `Beta environment started with image: ${imageUri}`, project.name, "Success");
    if (priorityFix?.fixed) {
      auditStore.logAction(user, `Beta listener rule priority auto-corrected (was ${priorityFix.betaPriorityBefore}, now ${priorityFix.betaPriorityAfter}, below catch-all) — beta cookie routing was being bypassed`, project.name, "Success");
    }
    res.json({ ok: true, taskDefinitionArn: result.taskDefinitionArn, stable, priorityFix });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/bluegreen/beta/stop
router.post("/bluegreen/beta/stop", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    if (!project.prodBetaServiceName) {
      return res.status(400).json({ ok: false, error: "Beta service not configured." });
    }
    const region = project.region || "us-east-1";
    if (project.prodBetaListenerRuleArn) {
      await aws.setBetaRoutingEnabled(region, project.prodBetaListenerRuleArn, false);
    }
    const clusterName = project.ecsClusterNameProd || project.ecsClusterName;
    await aws.scaleEcsService(region, clusterName, project.prodBetaServiceName, 0);
    const stable = await aws.waitForServiceStable(region, clusterName, project.prodBetaServiceName);
    const user = auth.getLoggedInUser(req) || "unknown";
    auditStore.logAction(user, "Beta environment stopped (scaled to 0); ALB beta routing disabled", project.name, "Success");
    res.json({ ok: true, stable, betaRoutingEnabled: false });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/release/promote-to-prod — merge release branch → main, trigger pipeline (no direct image copy)
router.post("/release/promote-to-prod", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const { branchName, commitMessage } = req.body;
    if (!branchName) return res.status(400).json({ ok: false, error: "branchName is required" });
    if (!project.githubOwner || !project.githubRepo) {
      return res.status(400).json({ ok: false, error: "GitHub repository not configured for this project." });
    }
    if (!project.pipelineName) {
      return res.status(400).json({ ok: false, error: "No pipeline configured. Run deployment infrastructure first." });
    }

    const user = auth.getLoggedInUser(req) || "unknown";
    const targetBranch = project.githubBranch || "main";
    const region = project.region || "us-east-1";

    if (branchName === targetBranch) {
      return res.status(400).json({ ok: false, error: `Cannot promote — already on ${targetBranch}. Select a release branch.` });
    }

    // Fetch head commit message for approval context
    let headCommitMessage = commitMessage || null;
    try {
      const commits = await gh.getCommits(project.githubOwner, project.githubRepo, branchName, 1);
      if (commits?.[0]?.message && !headCommitMessage) headCommitMessage = commits[0].message;
    } catch (_) { /* optional */ }

    const mergeMsg = commitMessage
      || `Release: merge ${branchName} into ${targetBranch} (promoted by ${user})`;

    const mergeStartedAt = new Date();
    const mergeResult = await gh.mergeBranches(
      project.githubOwner, project.githubRepo, targetBranch, branchName, mergeMsg
    );

    const commitSha = mergeResult.sha || null;
    const finalCommitMessage = mergeResult.message || headCommitMessage || mergeMsg;

    const promotion = await releasePromotionStore.createPromotion({
      projectId: project.id,
      releaseBranch: branchName,
      targetBranch,
      triggeredBy: user,
      commitSha,
      commitMessage: finalCommitMessage,
      pipelineName: project.pipelineName
    });

    // Scale down beta — release path is complete; prod will come via pipeline
    if (project.prodBetaServiceName && (project.ecsClusterNameProd || project.ecsClusterName)) {
      try {
        if (project.prodBetaListenerRuleArn) {
          await aws.setBetaRoutingEnabled(region, project.prodBetaListenerRuleArn, false);
        }
        await aws.scaleEcsService(region, project.ecsClusterNameProd || project.ecsClusterName, project.prodBetaServiceName, 0);
      } catch (betaErr) {
        console.warn("Beta stop after promote-to-prod:", betaErr.message);
      }
    }

    const pipelineExecutionId = await aws.waitForNewPipelineExecution(region, project.pipelineName, {
      after: mergeStartedAt,
      maxWaitSeconds: 90
    });

    if (pipelineExecutionId) {
      await releasePromotionStore.updatePipelineExecution(promotion.id, pipelineExecutionId);
    }

    auditStore.logAction(
      user,
      mergeResult.alreadyUpToDate
        ? `Release promote: ${branchName} already up to date with ${targetBranch}; pipeline may not re-run`
        : `Release promote: merged ${branchName} → ${targetBranch}; pipeline ${pipelineExecutionId ? "started" : "pending"}`,
      project.name,
      "Success",
      "Pipeline Executions"
    );

    res.json({
      ok: true,
      alreadyUpToDate: !!mergeResult.alreadyUpToDate,
      merged: !!mergeResult.merged,
      commitSha,
      commitMessage: finalCommitMessage,
      releaseBranch: branchName,
      targetBranch,
      pipelineExecutionId,
      promotionId: promotion.id,
      message: mergeResult.alreadyUpToDate
        ? `${branchName} is already merged into ${targetBranch}.`
        : `Merged ${branchName} into ${targetBranch}. The 7-stage pipeline is running — approve UAT and Production in the Approvals page.`
    });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// GET /api/release/history — list past release branch promotions
router.get("/release/history", auth.requireAuth, async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const limit = parseInt(req.query.limit, 10) || 50;
    const promotions = await releasePromotionStore.getPromotionsForProject(project.id, limit);
    res.json({ ok: true, promotions });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/release/promote — alias to promote-to-prod
router.post("/release/promote", auth.requireRole(...auth.ADMIN_ROLES), async (req, res, next) => {
  req.url = "/release/promote-to-prod";
  router.handle(req, res, next);
});

// POST /api/bluegreen/beta/promote — emergency hot-promote (direct image copy). Prefer /release/promote-to-prod.
router.post("/bluegreen/beta/promote", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    if (!project.prodBetaServiceName || !project.prodServiceName) {
      return res.status(400).json({ ok: false, error: "Beta or prod service not configured." });
    }
    const region = project.region || "us-east-1";
    const clusterName = project.ecsClusterNameProd || project.ecsClusterName;
    const betaSvc = await aws.describeEcsService(region, clusterName, project.prodBetaServiceName);
    if (!betaSvc || !betaSvc.taskDefinition) {
      return res.status(400).json({ ok: false, error: "Beta service has no active task definition. Start the beta environment first." });
    }
    const td = await aws.describeTaskDefinition(region, betaSvc.taskDefinition);
    const betaImage = td && td.containerDefinitions && td.containerDefinitions[0]
      ? td.containerDefinitions[0].image : null;
    if (!betaImage) {
      return res.status(400).json({ ok: false, error: "Could not determine beta image URI." });
    }
    const result = await aws.deployImageToService(region, {
      clusterName: clusterName,
      serviceName: project.prodServiceName,
      family: `${clusterName}-prod`,
      image: betaImage,
      executionRoleArn: project.ecsExecutionRoleArn,
      taskRoleArn: project.ecsTaskRoleArn || project.ecsExecutionRoleArn
    });
    const stable = await aws.waitForServiceStable(region, clusterName, project.prodServiceName);
    const user = auth.getLoggedInUser(req) || "unknown";
    auditStore.logAction(user, `Promoted beta image to prod: ${betaImage}`, project.name, "Success");
    res.json({ ok: true, promotedImage: betaImage, taskDefinitionArn: result.taskDefinitionArn, stable });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});


// POST /api/bluegreen/beta/provision
// Creates the Beta ECS service, TG, and host-scoped ALB rule on demand.
// No Terraform needed — the platform manages this resource lifecycle.
router.post("/bluegreen/beta/provision", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const region = project.region || "us-east-1";
    const store = require("../stores/projectStore");

    if (project.prodBetaServiceName) {
      return res.status(409).json({ ok: false, error: "Beta environment already provisioned. Tear it down first to re-provision." });
    }

    // Required project fields
    const { ecsClusterNameProd, ecsClusterName, prodServiceName, ecsExecutionRoleArn, ecsTaskRoleArn,
            subnetIds, securityGroupId, prodBetaListenerRuleArn, albListenerArn,
            prodUrl, vpcId } = project;

    const actualCluster = ecsClusterNameProd || ecsClusterName;
    if (!actualCluster) return res.status(400).json({ ok: false, error: "ECS cluster not configured." });
    if (!albListenerArn && !project.albDnsName) return res.status(400).json({ ok: false, error: "ALB listener ARN or DNS not configured on this project." });

    const user = auth.getLoggedInUser(req) || "unknown";

    // 1. Derive beta service name from existing prod service name
    const prefix = prodServiceName ? prodServiceName.replace(/-prod$/, "") : actualCluster;
    const betaServiceName = `${prefix}-prod-beta`;
    const betaTgName     = betaTgNameFor(prefix);

    // 2. Resolve the prod task def to use as base for beta
    let baseImage = null;
    try {
      const prodSvc = await aws.describeEcsService(region, actualCluster, prodServiceName);
      if (prodSvc?.taskDefinition) {
        const td = await aws.describeTaskDefinition(region, prodSvc.taskDefinition);
        baseImage = td?.containerDefinitions?.[0]?.image || null;
      }
    } catch (_) {}

    // 3. Create beta target group
    const betaVpcId = vpcId || project.vpcId;
    if (!betaVpcId) return res.status(400).json({ ok: false, error: "VPC ID not configured on this project. Add it in project settings." });

    const tg = await aws.createBetaTargetGroup(region, { vpcId: betaVpcId, name: betaTgName, port: project.containerPort || 3000 });
    const betaTgArn = tg.TargetGroupArn;

    // 4. (Task definition is registered further down, after the beta
    //    listener rule exists — see step 5c — since its env vars need
    //    betaRuleArn, which isn't known until step 5.)

    // 5. Attach the target group to the ALB *before* creating the ECS
    // service — AWS rejects CreateService's loadBalancers config if the
    // target group isn't already associated with a load balancer, so this
    // must happen before step 6, not after.
    const resolvedListenerArn = albListenerArn || (project.albDnsName ? await aws.getAlbListenerArn(region, project.albDnsName) : null);
    if (!resolvedListenerArn) {
      await aws.deleteBetaTargetGroup(region, betaTgArn).catch(() => {});
      return res.status(400).json({ ok: false, error: "ALB listener ARN could not be resolved (not set on project and albDnsName lookup failed). Re-run the deployment Terraform apply so shared-foundation outputs populate albListenerArn." });
    }
    const hostHeader = prodUrl ? prodUrl.replace(/^https?:\/\//, "").split("/")[0] : null;
    if (!hostHeader) {
      await aws.deleteBetaTargetGroup(region, betaTgArn).catch(() => {});
      return res.status(400).json({ ok: false, error: "Prod URL not configured on this project — needed to build the beta host-header rule." });
    }
    const nextPriority = await aws.getNextListenerRulePriority(region, resolvedListenerArn, hostHeader);
    const rule = await aws.createBetaListenerRule(region, {
      listenerArn: resolvedListenerArn,
      targetGroupArn: betaTgArn,
      hostHeader,
      priority: parseInt(nextPriority, 10)
    }).catch(async (err) => {
      await aws.deleteBetaTargetGroup(region, betaTgArn).catch(() => {});
      throw err;
    });
    const betaRuleArn = rule?.RuleArn || null;

    // 5a. getNextListenerRulePriority only sees the catch-all rule if it
    // already exists at creation time. Re-check right away in case it was
    // missing then (or gets recreated by a later terraform apply) — cheap
    // and makes this self-healing rather than a one-shot best-effort.
    if (betaRuleArn) {
      await aws.ensureBetaRulePriorityBelowCatchAll(region, resolvedListenerArn, betaRuleArn, hostHeader).catch(() => {});
    }

    // 5b. Newly created rules must start OFF — the beta service below is
    // created with desiredCount=0, so the routing rule must match that
    // until an explicit /bluegreen/beta/start turns it on. Without this,
    // there's a window where __env=beta is live on the ALB pointing at a
    // target group with zero running tasks.
    if (betaRuleArn) {
      await aws.setBetaRoutingEnabled(region, betaRuleArn, false).catch(async (err) => {
        await aws.deleteBetaListenerRule(region, betaRuleArn).catch(() => {});
        await aws.deleteBetaTargetGroup(region, betaTgArn).catch(() => {});
        throw err;
      });
    }

    // 5c. Register the beta task definition now that betaRuleArn is known.
    //    These env vars are what the deployed app's beta-sync logic requires
    //    to auto-reconcile the ALB routing rule — without them auto-sync is
    //    disabled and it never touches the rule. deployImageToService()
    //    carries these forward on every subsequent redeploy, so they only
    //    need to be set here, once, at provision time.
    const registeredTd = await aws.registerTaskDefinition(region, {
      family: `${prefix}-prod-beta`,
      image: baseImage || "amazon/amazon-ecs-sample",
      executionRoleArn: ecsExecutionRoleArn,
      taskRoleArn: ecsTaskRoleArn || ecsExecutionRoleArn,
      containerPort: project.containerPort || 3000,
      cpu: "256", memory: "512",
      containerName: prefix,
      environment: [
        { name: "ADMIN_API_URL", value: process.env.PANEL_PUBLIC_URL || "" },
        { name: "AWS_REGION", value: region },
        { name: "ECS_CLUSTER", value: actualCluster },
        { name: "ECS_BETA_SERVICE", value: betaServiceName },
        { name: "ECS_PROD_SERVICE", value: prodServiceName },
        { name: "ALB_LISTENER_RULE_ARN", value: betaRuleArn || prodBetaListenerRuleArn || "" }
      ]
    }).catch(async (err) => {
      await aws.deleteBetaListenerRule(region, betaRuleArn).catch(() => {});
      await aws.deleteBetaTargetGroup(region, betaTgArn).catch(() => {});
      throw err;
    });

    // 6. Create the ECS service (desired_count=0 — off by default). The TG
    // is now attached to the ALB from step 5, so this passes AWS's check.
    await aws.createEcsService(region, {
      clusterName: actualCluster,
      serviceName: betaServiceName,
      taskDefinitionArn: registeredTd.taskDefinitionArn,
      subnetIds: (subnetIds || "").split(",").map(s => s.trim()).filter(Boolean),
      securityGroupId,
      targetGroupArn: betaTgArn,
      containerName: prefix,
      containerPort: project.containerPort || 3000,
      desiredCount: 0,
      assignPublicIp: "DISABLED"
    }).catch(async (err) => {
      await aws.deleteBetaListenerRule(region, betaRuleArn).catch(() => {});
      await aws.deleteBetaTargetGroup(region, betaTgArn).catch(() => {});
      throw err;
    });

    // 7. Persist beta fields to project
    await store.updateProject(project.id, {
      prodBetaServiceName: betaServiceName,
      prodBetaTgArn: betaTgArn,
      prodBetaListenerRuleArn: betaRuleArn || project.prodBetaListenerRuleArn || null
    });

    auditStore.logAction(user, `Beta environment provisioned on-demand: ${betaServiceName}`, project.name, "Success");
    res.json({ ok: true, betaServiceName, betaTgArn, betaRuleArn });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/bluegreen/beta/teardown
// Deletes the beta ECS service, ALB rule, and target group. Clears project fields.
router.post("/bluegreen/beta/teardown", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    if (!project.prodBetaServiceName) {
      return res.status(400).json({ ok: false, error: "No beta environment provisioned for this project." });
    }
    const region = project.region || "us-east-1";
    const store  = require("../stores/projectStore");
    const user   = auth.getLoggedInUser(req) || "unknown";

    // 1. Disable routing and scale to 0 before deleting
    try {
      if (project.prodBetaListenerRuleArn) await aws.setBetaRoutingEnabled(region, project.prodBetaListenerRuleArn, false);
      const clusterName = project.ecsClusterNameProd || project.ecsClusterName;
      await aws.scaleEcsService(region, clusterName, project.prodBetaServiceName, 0);
      await aws.waitForServiceStable(region, clusterName, project.prodBetaServiceName, 120);
    } catch (_) {}

    // 2. Delete ECS service
    try {
      const { ecs } = require("../config/aws").__clients ? require("../config/aws").__clients(region) : {};
      // Use AWS SDK directly — deleteService is not exposed, so use force delete via update then delete
      const { ECSClient, DeleteServiceCommand, UpdateServiceCommand } = require("@aws-sdk/client-ecs");
      const ecsClient = new ECSClient({ region });
      const clusterName = project.ecsClusterNameProd || project.ecsClusterName;
      await ecsClient.send(new UpdateServiceCommand({ cluster: clusterName, service: project.prodBetaServiceName, desiredCount: 0 }));
      await ecsClient.send(new DeleteServiceCommand({ cluster: clusterName, service: project.prodBetaServiceName, force: true }));
    } catch (e) { console.warn("Beta service delete:", e.message); }

    // 3. Delete ALB listener rule
    await aws.deleteBetaListenerRule(region, project.prodBetaListenerRuleArn);

    // 4. Delete target group (must be after rule deletion)
    await aws.deleteBetaTargetGroup(region, project.prodBetaTgArn);

    // 5. Clear project fields
    await store.updateProject(project.id, {
      prodBetaServiceName: "",
      prodBetaTgArn: "",
      prodBetaListenerRuleArn: ""
    });

    auditStore.logAction(user, `Beta environment torn down: ${project.prodBetaServiceName}`, project.name, "Success");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
