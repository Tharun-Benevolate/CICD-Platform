// routes/terraform.js — Terraform runner routes + SSE log streaming.
// Extracted from server.js lines 185-528.

const router = require("express").Router();
const tf = require("../services/terraformRunner");
const auth = require("../middleware/auth");
const store = require("../stores/projectStore");
const auditStore = require("../stores/auditStore");
const { namesForProject, resolveSecretName, getSecretForEnv } = require("../utils/projectNaming");

const { requireProject } = require("./projects");

const { listProjectSecretKeys } = require("../aws");

// Helper: collect per-env secret ARNs and keys for a project.
// Returns { dev: { arn, keys }, uat: { arn, keys }, prod: { arn, keys } }
async function collectPerEnvSecrets(project) {
  const region = project.region || "us-east-1";
  const result = { dev: { arn: "", keys: [] }, uat: { arn: "", keys: [] }, prod: { arn: "", keys: [] } };
  for (const env of ["dev", "uat", "prod"]) {
    const cfg = getSecretForEnv(project, env);
    if (cfg && cfg.arn) {
      result[env].arn = cfg.arn;
      try {
        result[env].keys = await listProjectSecretKeys(region, cfg.name);
      } catch (err) {
        console.warn(`[terraform] Secret read failed for ${env} (${err.message}) — clearing stale secret.`);
        const updatedSecrets = { ...(project.secrets || {}), [env]: null };
        await store.updateProject(project.id, { secrets: updatedSecrets });
        result[env] = { arn: "", keys: [] };
      }
    }
  }
  return result;
}

// ─── Fix: strip owner prefix from githubRepo if stored as "owner/repo" full path ───
// Terraform uses github_owner + "/" + github_repo to form FullRepositoryName.
// If githubRepo is already stored as "amruthkumartj/deploy-watch-new" (full path),
// passing owner separately causes "amruthkumartj/amruthkumartj/deploy-watch-new".
function resolveGithubRepo(owner, repo) {
  let o = (owner || '').trim();
  let r = (repo || '').trim();
  if (r.includes('/')) {
    const parts = r.split('/');
    r = parts[parts.length - 1]; // repo name only
    if (!o) o = parts[0];        // use embedded owner only if not set
  }
  return { owner: o, repo: r };
}

// Registry so the SSE route (which only knows a runId) can look up which
// project/type a run belongs to, and save its outputs to the DB itself
// before telling the browser "done" — this removes the race where the
// browser was told to reload data before the DB write had landed.
const _runRegistry = new Map(); // runId -> { projectId, type }

async function _saveRunOutputs(runId) {
  const meta = _runRegistry.get(runId);
  if (!meta) return; // unknown run (e.g. server restarted) — nothing to save
  const run = tf.getRun(runId);
  if (!run || run.status === "running") return;
  if (run._saved) return; // idempotent — SSE route and background watcher can both call this
  run._saved = true;

  const proj = await store.getProject(meta.projectId);
  const projectName = proj ? proj.name : meta.projectId;

  const ACTIONS = {
    initial: "Create Initial Infrastructure",
    "initial-destroy": "Destroy Initial Infrastructure",
    deployment: "Create Deployment Infrastructure",
    "deployment-destroy": "Destroy Deployment Infrastructure"
  };
  const action = ACTIONS[meta.type] || meta.type;

  if (run.status !== "done") {
    auditStore.logAction("system", action, projectName, "Failed");
    return;
  }

  if (meta.type === "initial") {
    const o = run.outputs || {};
    await store.updateProject(meta.projectId, {
      artifactBucket: o.s3_bucket_name,
      githubConnectionArn: o.github_connection_arn,
      buildRoleArn: o.build_role_arn,
      pipelineRoleArn: o.pipeline_role_arn,
      ecsExecutionRoleArn: o.ecs_execution_role_arn,
      buildProjectName: o.codebuild_project_name,
      initialTfApplied: true
    });
  } else if (meta.type === "deployment") {
    const o = run.outputs || {};
    await store.updateProject(meta.projectId, {
      ecsClusterName: o.ecs_cluster_name_non_prod, // Keep for legacy usage where needed
      ecsClusterNameNonProd: o.ecs_cluster_name_non_prod,
      ecsClusterNameProd: o.ecs_cluster_name_prod,
      ecrRepoUrl: o.ecr_repository_url,
      devServiceName: o.dev_service_name,
      uatServiceName: o.uat_service_name,
      prodServiceName: o.prod_service_name,
      subnetIds: o.private_subnet_ids,
      securityGroupId: o.ecs_security_group_id,
      albDnsName: o.alb_dns_name,
      pipelineName: o.pipeline_name,
      devUrl: o.dev_url,
      uatUrl: o.uat_url,
      prodUrl: o.prod_url,
      prodBlueTargetGroupArn: o.prod_blue_target_group_arn,
      prodGreenTargetGroupArn: o.prod_green_target_group_arn,
      prodListenerRuleArn: o.prod_listener_rule_arn,
      prodBetaListenerRuleArn: o.prod_beta_listener_rule_arn,
      prodBetaTgArn: o.prod_beta_target_group_arn,
      // Shared infra references — needed for on-demand beta provisioning
      vpcId: o.vpc_id,
      albListenerArn: o.alb_listener_arn,
      albHttpsListenerArn: o.alb_https_listener_arn,
      codedeployAppName: o.codedeploy_app_name,
      codedeployDeploymentGroup: o.codedeploy_deployment_group,
      deploymentTfApplied: true,
      // EFS outputs — persisted so the UI shows the connected filesystem
      efsFilesystemId:    o.efs_filesystem_id    || null,
      efsAccessPointDev:  o.efs_access_point_id_dev  || null,
      efsAccessPointUat:  o.efs_access_point_id_uat  || null,
      efsAccessPointProd: o.efs_access_point_id_prod || null,
      efsMountPath:       o.efs_mount_path        || null,
    });

    // After deployment infra is provisioned, sync cluster/service/role/secrets
    // env vars into the CodeBuild project so the buildspec can register task
    // definitions with the correct Secrets Manager references per env.
    // This is safe to run even when no secrets are configured yet — the
    // cluster/service/role names are needed by the buildspec regardless.
    try {
      const updatedProj = await store.getProject(meta.projectId);
      if (updatedProj && updatedProj.buildProjectName) {
        const { syncSecretsToCodeBuild: _sync } = require("../routes/secrets");
        if (typeof _sync === "function") {
          await _sync(updatedProj);
        }
      }
    } catch (syncErr) {
      console.warn("[terraform] Could not sync secrets to CodeBuild after deployment apply:", syncErr.message);
    }

  } else if (meta.type === "initial-destroy") {
    await store.updateProject(meta.projectId, {
      artifactBucket: null,
      githubConnectionArn: null,
      buildRoleArn: null,
      pipelineRoleArn: null,
      ecsExecutionRoleArn: null,
      buildProjectName: null,
      initialTfApplied: false
    });
  } else if (meta.type === "deployment-destroy") {
    await store.updateProject(meta.projectId, {
      ecsClusterName: null,
      ecsClusterNameNonProd: null,
      ecsClusterNameProd: null,
      ecrRepoUrl: null,
      devServiceName: null,
      uatServiceName: null,
      prodServiceName: null,
      subnetIds: null,
      securityGroupId: null,
      albDnsName: null,
      pipelineName: null,
      devUrl: null,
      uatUrl: null,
      prodUrl: null,
      prodBlueTargetGroupArn: null,
      prodGreenTargetGroupArn: null,
      prodListenerRuleArn: null,
      prodBetaListenerRuleArn: null,
      prodBetaTgArn: null,
      vpcId: null,
      albListenerArn: null,
      codedeployAppName: null,
      codedeployDeploymentGroup: null,
      buildHistory: [],
      deploymentTfApplied: false,
      // Clear EFS references on destroy (filesystem itself is kept in AWS)
      efsFilesystemId: null,
      efsAccessPointDev: null,
      efsAccessPointUat: null,
      efsAccessPointProd: null,
      efsMountPath: null,
    });
  }

  auditStore.logAction("system", action, projectName, "Completed");
}

// Background watchers — safety net in case the browser tab is closed mid-run;
// _saveRunOutputs() is idempotent so this won't double-save if the SSE route
// already handled it.
function _watchAndSaveInitial(runId, projectId) {
  _runRegistry.set(runId, { projectId, type: "initial" });
  const iv = setInterval(async () => {
    const run = tf.getRun(runId);
    if (!run || run.status === "running") return;
    clearInterval(iv);
    await _saveRunOutputs(runId);
  }, 1000);
}

function _watchAndSaveDeployment(runId, projectId) {
  _runRegistry.set(runId, { projectId, type: "deployment" });
  const iv = setInterval(async () => {
    const run = tf.getRun(runId);
    if (!run || run.status === "running") return;
    clearInterval(iv);
    await _saveRunOutputs(runId);
  }, 1000);
}

function _watchAndSaveInitialDestroy(runId, projectId) {
  _runRegistry.set(runId, { projectId, type: "initial-destroy" });
  const iv = setInterval(async () => {
    const run = tf.getRun(runId);
    if (!run || run.status === "running") return;
    clearInterval(iv);
    await _saveRunOutputs(runId);
  }, 1000);
}

function _watchAndSaveDeploymentDestroy(runId, projectId) {
  _runRegistry.set(runId, { projectId, type: "deployment-destroy" });
  const iv = setInterval(async () => {
    const run = tf.getRun(runId);
    if (!run || run.status === "running") return;
    clearInterval(iv);
    await _saveRunOutputs(runId);
  }, 1000);
}

function _watchAndSaveFoundation(runId) {
  const iv = setInterval(async () => {
    const run = tf.getRun(runId);
    if (!run || run.status === "running") return;
    clearInterval(iv);
    if (run.status === "done" && run.outputs && run.outputs.vpc_id) {
      await tf.saveFoundationOutputs(run.outputs);
    } else {
      tf.clearFoundationCache();
      await tf.readFoundationOutputs(true);
    }
  }, 1000);
}

function _watchAndSaveFoundationDestroy(runId) {
  const iv = setInterval(async () => {
    const run = tf.getRun(runId);
    if (!run || run.status === "running") return;
    clearInterval(iv);
    if (run.status === "done") {
      tf.clearFoundationCache();
    }
  }, 1000);
}

// Helper: Determine the buildspec to pass to Terraform.
// Priority: project repo's buildspec.yml > project.customBuildspec > generic buildspec.
// The generic buildspec has a __TASKDEF_SCRIPT_B64__ placeholder that we fill with
// the base64-encoded register_taskdefs.py so the Python script travels with the YAML
// without any YAML parsing conflicts (no code embedded inline).
async function resolveBuildspecForTerraform(project, isCodeCommit, repoName, githubOwner, githubRepo, githubBranch) {
  try {
    let hasFile = false;
    if (isCodeCommit) {
      const aws = require("../config/aws");
      const targetRepo = repoName || project.repoName;
      const targetBranch = githubBranch || project.githubBranch || "main";
      if (targetRepo) {
        hasFile = await aws.codecommitFileExists(project.region || "us-east-1", targetRepo, targetBranch, "buildspec.yml");
      }
    } else {
      const github = require("../github");
      const owner = githubOwner || project.githubOwner;
      const repo = githubRepo || project.githubRepo;
      const targetBranch = githubBranch || project.githubBranch || "main";
      if (owner && repo) {
        hasFile = await github.fileExists(owner, repo, targetBranch, "buildspec.yml");
      }
    }
    if (hasFile) return "buildspec.yml";
  } catch (err) {
    console.warn("Failed to check for buildspec.yml in repo:", err.message);
  }

  if (project.customBuildspec) return project.customBuildspec;

  try {
    const fs = require("fs");
    const path = require("path");
    const dataDir = path.join(__dirname, "../data");
    const buildspecPath = path.join(dataDir, "generic-buildspec.yml");
    const scriptPath    = path.join(dataDir, "register_taskdefs.py");

    if (!fs.existsSync(buildspecPath)) return "buildspec.yml";

    let buildspec = fs.readFileSync(buildspecPath, "utf8");

    // Inject the base64-encoded Python script so CodeBuild can decode and run it.
    // Using base64 avoids YAML parsing issues (no colons at column 0, no heredoc conflicts).
    if (fs.existsSync(scriptPath)) {
      const scriptB64 = fs.readFileSync(scriptPath).toString("base64");
      // replaceAll because the placeholder appears in both a comment and the echo command
      buildspec = buildspec.replaceAll("__TASKDEF_SCRIPT_B64__", scriptB64);
    } else {
      const noopB64 = Buffer.from('print("register_taskdefs.py not found - skipping task def registration")').toString("base64");
      buildspec = buildspec.replaceAll("__TASKDEF_SCRIPT_B64__", noopB64);
      console.warn("[buildspec] register_taskdefs.py not found — task def registration will be skipped");
    }

    return buildspec;
  } catch (e) {
    console.warn("[buildspec] Failed to load generic buildspec:", e.message);
  }

  return "buildspec.yml";
}

// POST /api/terraform/initial/run — runs infra-initial, saves outputs to DB
router.post("/terraform/initial/run", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const { githubOwner, githubRepo, githubBranch, repoName, sourceType, projectName } = req.body;
    const isCodeCommit = sourceType === 'codecommit' || (!githubOwner && (repoName || project.repoName));

    // GitHub projects still require githubOwner
    if (!isCodeCommit && !githubOwner && !project.githubOwner) {
      return res.status(400).json({ ok: false, error: "githubOwner is required for GitHub-sourced projects" });
    }

    const names = namesForProject({
      githubRepo: githubRepo || project.githubRepo,
      projectName: projectName || project.name,
      buildProjectName: project.buildProjectName
    });

    // Collect per-env secrets to embed in CodeBuild from day one.
    // At initial apply time, secrets may not exist yet — defaults to empty strings.
    const perEnvSecrets = await collectPerEnvSecrets(project);

    const tfvars = {
      project_name: names.projectName,
      s3_bucket_name: names.s3BucketName,
      build_role_name: `${names.projectName}-build-role`,
      pipeline_role_name: `${names.projectName}-pipeline-role`,
      ecs_execution_role_name: `${names.projectName}-ecs-exec-role`,
      github_connection_name: names.githubConnectionName,
      aws_region: project.region || process.env.AWS_REGION || "us-east-1",
      source_type: isCodeCommit ? "codecommit" : "github",
      // GitHub vars (empty string for CodeCommit — terraform will ignore them)
      github_owner:  isCodeCommit ? "" : (githubOwner || project.githubOwner || ""),
      github_repo:   isCodeCommit ? "" : (githubRepo  || project.githubRepo  || "Golf-test-app"),
      github_branch: isCodeCommit ? "main" : (githubBranch || project.githubBranch || "main"),
      // CodeCommit vars
      codecommit_repo_name: isCodeCommit ? (repoName || project.repoName || "") : "",
      buildspec: await resolveBuildspecForTerraform(project, isCodeCommit, repoName, githubOwner, githubRepo, githubBranch),
      // Per-environment secrets — seeded into CodeBuild env vars from the start
      secret_arn:      "",
      secret_keys:     JSON.stringify([]),
      secret_arn_dev:  perEnvSecrets.dev.arn,
      secret_keys_dev: JSON.stringify(perEnvSecrets.dev.keys),
      secret_arn_uat:  perEnvSecrets.uat.arn,
      secret_keys_uat: JSON.stringify(perEnvSecrets.uat.keys),
      secret_arn_prod: perEnvSecrets.prod.arn,
      secret_keys_prod: JSON.stringify(perEnvSecrets.prod.keys)
    };

    const runId = tf.startRun(tf.INITIAL_DIR, tfvars, { projectId: project.id, moduleLabel: "initial" });
    auditStore.logAction(auth.getLoggedInUser(req), "Create Initial Infrastructure", project.name, "Started");
    res.json({ ok: true, runId });

    // When done, parse outputs and auto-save to DB
    _watchAndSaveInitial(runId, project.id);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});


// POST /api/terraform/initial/destroy — runs terraform destroy for initial infra
router.post("/terraform/initial/destroy", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const { githubOwner, githubRepo, githubBranch, projectName } = req.body;
    if (!githubOwner && !project.githubOwner) return res.status(400).json({ ok: false, error: "githubOwner is required" });

    const names = namesForProject({
      githubRepo: githubRepo || project.githubRepo,
      projectName: projectName || project.name,
      buildProjectName: project.buildProjectName
    });

    const tfvars = {
      github_owner: githubOwner || project.githubOwner,
      github_repo: githubRepo || project.githubRepo || "Golf-test-app",
      github_branch: githubBranch || project.githubBranch || "main",
      project_name: names.projectName,
      s3_bucket_name: names.s3BucketName,
      build_role_name: `${names.projectName}-build-role`,
      pipeline_role_name: `${names.projectName}-pipeline-role`,
      ecs_execution_role_name: `${names.projectName}-ecs-exec-role`,
      github_connection_name: names.githubConnectionName,
      aws_region: project.region || process.env.AWS_REGION || "us-east-1"
    };

    const runId = tf.startDestroy(tf.INITIAL_DIR, tfvars, { projectId: project.id, moduleLabel: "initial-destroy" });
    auditStore.logAction(auth.getLoggedInUser(req), "Destroy Initial Infrastructure", project.name, "Started");
    res.json({ ok: true, runId });

    // Mark as destroyed in DB when done
    _watchAndSaveInitialDestroy(runId, project.id);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/terraform/deployment/run — runs golf-infra-terraform, saves outputs to DB
router.post("/terraform/deployment/run", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;

    // Require infra-initial to have been applied first
    if (!project.initialTfApplied) {
      return res.status(400).json({ ok: false, error: "Run Initial Infrastructure first — required ARNs are not set." });
    }

    const names = namesForProject({
      githubRepo: project.githubRepo,
      projectName: project.name,
      buildProjectName: project.buildProjectName
    });

    // Fetch Shared Foundation outputs dynamically for active AWS account
    const sfOutputs = (await tf.readFoundationOutputs(true)) || {};
    
    // Fetch per-env secret ARNs and keys
    const perEnvSecrets = await collectPerEnvSecrets(project);

    if (!sfOutputs.vpc_id) {
      return res.status(400).json({
        ok: false,
        error: "Shared Foundation is not provisioned in this AWS account yet. Please click 'Re-apply Shared Foundation' (Step 0) first to provision the shared VPC and ALB!"
      });
    }

    const tfvars = {
      aws_region: project.region || "us-east-1",
      project_name: project.buildProjectName || names.projectName,
      ecs_execution_role_arn: project.ecsExecutionRoleArn,
      pipeline_role_arn: project.pipelineRoleArn,
      s3_bucket_name: project.artifactBucket || names.s3BucketName,
      github_connection_arn: project.githubConnectionArn,
      github_owner: resolveGithubRepo(project.githubOwner, project.githubRepo).owner,
      github_repo:  resolveGithubRepo(project.githubOwner, project.githubRepo).repo,
      github_branch: project.githubBranch || "main",
      codebuild_project_name: project.buildProjectName || names.codebuildProjectName,
      ecs_cluster_name_non_prod: project.ecsClusterNameNonProd || names.ecsClusterNameNonProd,
      ecs_cluster_name_prod: project.ecsClusterNameProd || names.ecsClusterNameProd,
      ecr_repo_name: names.ecrRepoName,
      dev_service_name: project.devServiceName || names.devServiceName,
      uat_service_name: project.uatServiceName || names.uatServiceName,
      prod_service_name: project.prodServiceName || names.prodServiceName,
      prod_beta_service_name: project.prodBetaServiceName || names.prodBetaServiceName,
      dns_host_prefix: names.dnsHostPrefix || "",
      project_prefix: names.dnsHostPrefix || "",
      domain_name: req.body.domainName || "benevolaite.com",

      // Shared Foundation inputs required by golf-infra-terraform
      vpc_id: sfOutputs.vpc_id,
      private_subnet_ids: sfOutputs.private_subnet_ids,
      ecs_sg_id: sfOutputs.ecs_sg_id,
      alb_dns_name: sfOutputs.alb_dns_name,
      alb_zone_id: sfOutputs.alb_zone_id,
      alb_listener_arn: sfOutputs.alb_listener_arn,
      alb_https_listener_arn: sfOutputs.alb_https_listener_arn || sfOutputs.alb_listener_arn || "",
      manage_route53: true,
      // Per-environment secrets (keys must be JSON strings for Terraform string variable type)
      secret_arn_dev:  perEnvSecrets.dev.arn,
      secret_keys_dev: JSON.stringify(perEnvSecrets.dev.keys),
      secret_arn_uat:  perEnvSecrets.uat.arn,
      secret_keys_uat: JSON.stringify(perEnvSecrets.uat.keys),
      secret_arn_prod: perEnvSecrets.prod.arn,
      secret_keys_prod: JSON.stringify(perEnvSecrets.prod.keys),
      // Legacy fallback (empty when per-env is used)
      secret_arn: "",
      secret_keys: "[]",
      // EFS persistent storage (optional)
      enable_efs:        !!project.efsEnabled,
      efs_filesystem_id: project.efsFilesystemId || "",
      efs_mount_path:    project.efsMountPath    || "/mnt/efs",
      efs_sg_id:         sfOutputs.efs_sg_id     || "",
    };

    const runId = tf.startRun(tf.DEPLOYMENT_DIR, tfvars, { projectId: project.id, moduleLabel: "deployment" });
    auditStore.logAction(auth.getLoggedInUser(req), "Create Deployment Infrastructure", project.name, "Started");
    res.json({ ok: true, runId });

    _watchAndSaveDeployment(runId, project.id);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/terraform/deployment/destroy — runs terraform destroy for deployment infra
router.post("/terraform/deployment/destroy", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;

    const names = namesForProject({
      githubRepo: project.githubRepo,
      projectName: project.name,
      buildProjectName: project.buildProjectName
    });

    const sfOutputs = (await tf.readFoundationOutputs()) || {};

    const tfvars = {
      aws_region: project.region || "us-east-1",
      project_name: project.buildProjectName || names.projectName,
      ecs_execution_role_arn: project.ecsExecutionRoleArn,
      pipeline_role_arn: project.pipelineRoleArn,
      s3_bucket_name: project.artifactBucket || names.s3BucketName,
      github_connection_arn: project.githubConnectionArn,
      github_owner: resolveGithubRepo(project.githubOwner, project.githubRepo).owner,
      github_repo:  resolveGithubRepo(project.githubOwner, project.githubRepo).repo,
      github_branch: project.githubBranch || "main",
      codebuild_project_name: project.buildProjectName || names.codebuildProjectName,
      ecs_cluster_name_non_prod: project.ecsClusterNameNonProd || names.ecsClusterNameNonProd,
      ecs_cluster_name_prod: project.ecsClusterNameProd || names.ecsClusterNameProd,
      ecr_repo_name: names.ecrRepoName,
      dev_service_name: project.devServiceName || names.devServiceName,
      uat_service_name: project.uatServiceName || names.uatServiceName,
      prod_service_name: project.prodServiceName || names.prodServiceName,
      prod_beta_service_name: project.prodBetaServiceName || names.prodBetaServiceName,
      dns_host_prefix: names.dnsHostPrefix || "",
      project_prefix: names.dnsHostPrefix || "",
      domain_name: req.body.domainName || "benevolaite.com",

      vpc_id: sfOutputs.vpc_id || "vpc-072331fff93bf37da",
      private_subnet_ids: sfOutputs.private_subnet_ids || "subnet-074a2d8264c435203,subnet-0a48ad1184ca5f2f0",
      ecs_sg_id: sfOutputs.ecs_sg_id || "sg-0b171cfe56be54815",
      alb_dns_name: sfOutputs.alb_dns_name || "shared-foundation-alb-737213570.us-east-1.elb.amazonaws.com",
      alb_zone_id: sfOutputs.alb_zone_id || "Z35SXDOTRQ7X7K",
      alb_listener_arn: sfOutputs.alb_listener_arn || "arn:aws:elasticloadbalancing:us-east-1:511974512004:listener/app/shared-foundation-alb/a36126009c7b192e/0eacc50cd4bf7e49",
      alb_https_listener_arn: sfOutputs.alb_https_listener_arn || sfOutputs.alb_listener_arn || "",
      manage_route53: true,
      secret_arn: project.secretArn || "",
      secret_keys: "[]",
      // EFS persistent storage — needed for destroy to know what to tear down
      enable_efs:        !!project.efsEnabled,
      efs_filesystem_id: project.efsFilesystemId || "",
      efs_mount_path:    project.efsMountPath    || "/mnt/efs",
      efs_sg_id:         sfOutputs.efs_sg_id     || "",
    };

    const runId = tf.startDestroy(tf.DEPLOYMENT_DIR, tfvars, { projectId: project.id, moduleLabel: "deployment-destroy" });
    auditStore.logAction(auth.getLoggedInUser(req), "Destroy Deployment Infrastructure", project.name, "Started");
    res.json({ ok: true, runId });

    _watchAndSaveDeploymentDestroy(runId, project.id);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/terraform/initial/reapply — re-runs terraform apply for initial infra
// using the project's saved settings. Idempotent — safe to run at any time;
// Terraform reconciles state vs AWS and only changes what's different.
router.post("/terraform/initial/reapply", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    if (!project.githubOwner) {
      return res.status(400).json({ ok: false, error: "No GitHub owner saved for this project — run Initial Infrastructure first to set it." });
    }
    const names = namesForProject({
      githubRepo: project.githubRepo,
      projectName: project.name,
      buildProjectName: project.buildProjectName
    });
    const perEnvSecrets = await collectPerEnvSecrets(project);

    const tfvars = {
      github_owner:  resolveGithubRepo(project.githubOwner, project.githubRepo).owner,
      github_repo:   resolveGithubRepo(project.githubOwner, project.githubRepo).repo || "Golf-test-app",
      github_branch: project.githubBranch || "main",
      project_name:  project.buildProjectName || names.projectName,
      s3_bucket_name: project.artifactBucket || names.s3BucketName,
      aws_region:    project.region || process.env.AWS_REGION || "us-east-1",
      buildspec:     await resolveBuildspecForTerraform(project, project.sourceType === 'codecommit', project.repoName, project.githubOwner, project.githubRepo, project.githubBranch),
      // Per-environment secrets — seeded into CodeBuild env vars on re-apply
      secret_arn:      "",
      secret_keys:     JSON.stringify([]),
      secret_arn_dev:  perEnvSecrets.dev.arn,
      secret_keys_dev: JSON.stringify(perEnvSecrets.dev.keys),
      secret_arn_uat:  perEnvSecrets.uat.arn,
      secret_keys_uat: JSON.stringify(perEnvSecrets.uat.keys),
      secret_arn_prod: perEnvSecrets.prod.arn,
      secret_keys_prod: JSON.stringify(perEnvSecrets.prod.keys)
    };
    const runId = tf.startRun(tf.INITIAL_DIR, tfvars, { projectId: project.id, moduleLabel: "initial" });
    auditStore.logAction(auth.getLoggedInUser(req), "Re-apply Initial Infrastructure", project.name, "Started");
    res.json({ ok: true, runId });
    _watchAndSaveInitial(runId, project.id);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/terraform/deployment/reapply — re-runs terraform apply for deployment infra.
// Terraform state is read first; only changed resources are updated. No destroy needed.
router.post("/terraform/deployment/reapply", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    if (!project.initialTfApplied) {
      return res.status(400).json({ ok: false, error: "Run Initial Infrastructure first — required ARNs are not set." });
    }
    const names = namesForProject({
      githubRepo: project.githubRepo,
      projectName: project.name,
      buildProjectName: project.buildProjectName
    });
    const sfOutputs = (await tf.readFoundationOutputs()) || {};

    // Fetch per-env secret ARNs and keys
    const perEnvSecrets = await collectPerEnvSecrets(project);

    const tfvars = {
      aws_region:             project.region || "us-east-1",
      ecs_execution_role_arn: project.ecsExecutionRoleArn,
      pipeline_role_arn:      project.pipelineRoleArn,
      s3_bucket_name:         project.artifactBucket || names.s3BucketName,
      github_connection_arn:  project.githubConnectionArn,
      github_owner:           resolveGithubRepo(project.githubOwner, project.githubRepo).owner,
      github_repo:            resolveGithubRepo(project.githubOwner, project.githubRepo).repo,
      github_branch:          project.githubBranch || "main",
      codebuild_project_name: project.buildProjectName || names.codebuildProjectName,
      ecs_cluster_name_non_prod: project.ecsClusterNameNonProd || names.ecsClusterNameNonProd,
      ecs_cluster_name_prod: project.ecsClusterNameProd || names.ecsClusterNameProd,
      ecr_repo_name:          names.ecrRepoName,
      dev_service_name:       project.devServiceName || names.devServiceName,
      uat_service_name:       project.uatServiceName || names.uatServiceName,
      prod_service_name:      project.prodServiceName || names.prodServiceName,
      prod_beta_service_name: project.prodBetaServiceName || names.prodBetaServiceName,
      dns_host_prefix:        names.dnsHostPrefix || "",
      project_prefix:         names.dnsHostPrefix || "",
      domain_name:            req.body.domainName || "benevolaite.com",

      // Shared Foundation inputs required by golf-infra-terraform
      vpc_id:                 sfOutputs.vpc_id || "vpc-072331fff93bf37da",
      private_subnet_ids:     sfOutputs.private_subnet_ids || "subnet-074a2d8264c435203,subnet-0a48ad1184ca5f2f0",
      ecs_sg_id:              sfOutputs.ecs_sg_id || "sg-0b171cfe56be54815",
      alb_dns_name:           sfOutputs.alb_dns_name || "shared-foundation-alb-737213570.us-east-1.elb.amazonaws.com",
      alb_zone_id:            sfOutputs.alb_zone_id || "Z35SXDOTRQ7X7K",
      alb_listener_arn:       sfOutputs.alb_listener_arn || "arn:aws:elasticloadbalancing:us-east-1:511974512004:listener/app/shared-foundation-alb/a36126009c7b192e/0eacc50cd4bf7e49",
      alb_https_listener_arn: sfOutputs.alb_https_listener_arn || sfOutputs.alb_listener_arn || "",
      manage_route53:         true,
      // Per-environment secrets
      secret_arn_dev:  perEnvSecrets.dev.arn,
      secret_keys_dev: perEnvSecrets.dev.keys,
      secret_arn_uat:  perEnvSecrets.uat.arn,
      secret_keys_uat: perEnvSecrets.uat.keys,
      secret_arn_prod: perEnvSecrets.prod.arn,
      secret_keys_prod: perEnvSecrets.prod.keys,
      // Legacy fallback
      secret_arn: "",
      secret_keys: "[]"
    };
    const runId = tf.startRun(tf.DEPLOYMENT_DIR, tfvars, { projectId: project.id, moduleLabel: "deployment" });
    auditStore.logAction(auth.getLoggedInUser(req), "Re-apply Deployment Infrastructure", project.name, "Started");
    res.json({ ok: true, runId, stateUrl: tf.stateUrl(project.id, "deployment") });
    _watchAndSaveDeployment(runId, project.id);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/terraform/:runId/logs — SSE stream of live terraform output
router.get("/terraform/:runId/logs", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const { runId } = req.params;
  let lastIdx = 0;

  const interval = setInterval(async () => {
    const run = tf.getRun(runId);
    if (!run) { res.write(`event: error\ndata: ${JSON.stringify({ error: "Run not found" })}\n\n`); clearInterval(interval); res.end(); return; }

    const newLogs = run.logs.slice(lastIdx);
    newLogs.forEach(entry => res.write(`data: ${JSON.stringify(entry)}\n\n`));
    lastIdx += newLogs.length;

    if (run.status !== "running") {
      clearInterval(interval);
      // Save to DB BEFORE telling the browser we're done, so the
      // browser's subsequent loadProjects() call always sees fresh data.
      try { await _saveRunOutputs(runId); } catch (e) { /* logged inside */ }
      res.write(`event: done\ndata: ${JSON.stringify({ status: run.status, outputs: run.outputs, error: run.error })}\n\n`);
      res.end();
    }
  }, 400);

  req.on("close", () => clearInterval(interval));
});

// GET /api/terraform/foundation/status — checks if Shared Foundation is applied live from server VM
router.get("/terraform/foundation/status", async (req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  try {
    const outputs = await tf.readFoundationOutputs(false);
    res.json({ ok: true, applied: !!(outputs && outputs.vpc_id), outputs: outputs || {} });
  } catch (err) {
    res.json({ ok: true, applied: false, outputs: {} });
  }
});

// GET /api/terraform/active-run — returns active running terraform run if one exists
router.get("/terraform/active-run", (req, res) => {
  try {
    const projectId = req.query.projectId;
    const activeRun = tf.getActiveRun(projectId);
    res.json({ ok: true, activeRun });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/terraform/foundation/run — runs shared-foundation-terraform stack
router.post("/terraform/foundation/run", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const region = req.body.region || process.env.AWS_REGION || "us-east-1";
    const tfvars = { aws_region: region };
    const runId = tf.startRun(tf.SHARED_FOUNDATION_DIR, tfvars, { moduleLabel: "foundation" });
    auditStore.logAction(auth.getLoggedInUser(req), "Apply Shared Foundation Infrastructure", "Platform", "Started");
    res.json({ ok: true, runId });
    _watchAndSaveFoundation(runId);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/terraform/foundation/destroy — destroys shared-foundation-terraform stack
router.post("/terraform/foundation/destroy", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    // Check if any project has active infrastructure
    const allProjects = await store.listProjects();
    const activeInfraProjects = allProjects.filter(p => p.initialTfApplied || p.deploymentTfApplied);
    if (activeInfraProjects.length > 0) {
      const names = activeInfraProjects.map(p => p.name).join(", ");
      return res.status(400).json({
        ok: false,
        error: `Cannot destroy Shared Foundation. Active project infrastructure exists (${names}). Please destroy Deployment Infra and Initial Infra for all projects first!`
      });
    }

    const region = req.body.region || process.env.AWS_REGION || "us-east-1";
    const tfvars = { aws_region: region };
    const runId = tf.startDestroy(tf.SHARED_FOUNDATION_DIR, tfvars, { moduleLabel: "foundation-destroy" });
    auditStore.logAction(auth.getLoggedInUser(req), "Destroy Shared Foundation Infrastructure", "Platform", "Started");
    res.json({ ok: true, runId });
    _watchAndSaveFoundationDestroy(runId);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/terraform/state-url — returns the S3 URL of a project's state files
router.get("/terraform/state-url", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const initialUrl = tf.stateUrl ? tf.stateUrl(project.id, "initial") : "s3://benevolate-tf-state/initial.tfstate";
    const deploymentUrl = tf.stateUrl ? tf.stateUrl(project.id, "deployment") : "s3://benevolate-tf-state/deployment.tfstate";
    res.json({
      ok: true,
      initial: initialUrl,
      deployment: deploymentUrl,
      bucket: process.env.TF_STATE_BUCKET || "benevolate-tf-state"
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});


// ─── EFS Storage Management Routes ──────────────────────────────────

// GET /api/efs/list — enumerate EFS filesystems in the active AWS account.
// Used by the Project Settings Storage card to populate the "connect existing" dropdown.
router.get("/efs/list", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = req.query.projectId ? await store.getProject(req.query.projectId) : null;
    const region = (project && project.region) || req.query.region || process.env.AWS_REGION || "us-east-1";
    const { EFSClient, DescribeFileSystemsCommand } = require("@aws-sdk/client-efs");
    const efsClient = new EFSClient({ region });
    const result = await efsClient.send(new DescribeFileSystemsCommand({}));
    res.json({
      ok: true,
      filesystems: (result.FileSystems || []).map(fs => ({
        id: fs.FileSystemId,
        name: (fs.Tags || []).find(t => t.Key === "Name")?.Value || fs.FileSystemId,
        sizeBytes: fs.SizeInBytes?.Value,
        state: fs.LifeCycleState,
        encrypted: fs.Encrypted
      }))
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/projects/:id/storage — save EFS config for a project (enables/disables EFS).
// Does NOT provision anything — user must Re-apply Deployment Infra in Setup Wizard after this.
router.post("/projects/:id/storage", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await store.getProject(req.params.id);
    if (!project) return res.status(404).json({ ok: false, error: "Project not found" });

    const { enabled, existingEfsId, mountPath } = req.body;
    await store.updateProject(project.id, {
      efsEnabled:      !!enabled,
      efsFilesystemId: existingEfsId || "",
      efsMountPath:    mountPath     || "/mnt/efs"
    });

    auditStore.logAction(
      auth.getLoggedInUser(req),
      enabled ? "Enable EFS Storage" : "Disable EFS Storage",
      project.name,
      "Completed"
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
