// routes/setup.js — Setup wizard API routes.
// Extracted from server.js lines 530-703.

const router = require("express").Router();
const aws = require("../config/aws");
const store = require("../stores/projectStore");
const { requireProject } = require("./projects");

// POST /api/setup/repo
router.post("/setup/repo", async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const { repoName, description } = req.body;
    const repo = await aws.createRepo(project.region, repoName, description);
    store.updateProject(project.id, { repoName });
    res.json({ ok: true, repo });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/setup/build
router.post("/setup/build", async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const { buildProjectName, buildspec, computeImage } = req.body;
    if (!project.buildRoleArn) return res.status(400).json({ ok: false, error: "Project is missing a CodeBuild service role ARN. Add it in project settings first." });
    const result = await aws.createBuildProject(project.region, {
      projectName: buildProjectName,
      roleArn: project.buildRoleArn,
      buildspec,
      computeImage
    });
    store.updateProject(project.id, { buildProjectName });
    res.json({ ok: true, project: result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/setup/github
router.post("/setup/github", async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const { githubConnectionArn, githubOwner, githubRepo, githubBranch } = req.body;
    if (!githubConnectionArn || !githubOwner || !githubRepo) {
      return res.status(400).json({ ok: false, error: "Connection ARN, owner, and repo are required" });
    }
    store.updateProject(project.id, {
      sourceType: "github",
      githubConnectionArn, githubOwner, githubRepo,
      githubBranch: githubBranch || "main"
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/github/connections
router.get("/github/connections", async (req, res) => {
  try {
    const region = req.query.region || process.env.AWS_REGION || "us-east-1";
    const connections = await aws.listConnections(region);
    res.json({ ok: true, connections });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/setup/ecs
router.post("/setup/ecs", async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const { ecsClusterName, ecrRepoName, devServiceName, uatServiceName, prodServiceName, subnetIds, securityGroupId, containerPort } = req.body;

    if (!project.ecsExecutionRoleArn) {
      return res.status(400).json({ ok: false, error: "Project is missing an ECS task execution role ARN. Add it in project settings first." });
    }
    if (!ecsClusterName || !ecrRepoName || !devServiceName || !uatServiceName || !prodServiceName || !subnetIds || !securityGroupId) {
      return res.status(400).json({ ok: false, error: "All ECS fields (cluster, ECR repo, three service names, subnets, security group) are required." });
    }

    // 1. ECR repo to hold build images (Ignores "already exists" errors)
    await aws.createEcrRepo(project.region, ecrRepoName).catch(e => {
      if (!String(e.message).includes("already exists") && !String(e.message).includes("RepositoryAlreadyExistsException")) throw e;
    });

    // 2. ECS cluster (AWS treats this as an upsert, perfectly safe if it exists)
    await aws.createEcsCluster(project.region, ecsClusterName);

    // 3. Placeholder task def + one service per environment (dev/uat/prod)
    const placeholderImage = "public.ecr.aws/docker/library/httpd:latest";
    const envs = [
      { family: `${ecsClusterName}-dev`, service: devServiceName },
      { family: `${ecsClusterName}-uat`, service: uatServiceName },
      { family: `${ecsClusterName}-prod`, service: prodServiceName }
    ];

    for (const env of envs) {
      // Step A: Check if the Terraform service is already there
      let existingService = null;
      try {
        existingService = await aws.describeEcsService(project.region, ecsClusterName, env.service);
      } catch (e) {
        console.log(`Service ${env.service} check returned: ${e.message}`);
      }

      // Step B: If it exists, SKIP creation! Just link it.
      if (existingService && existingService.status === "ACTIVE") {
        console.log(`[Import] Service ${env.service} already exists via Terraform. Linking to panel.`);
        continue;
      }

      // Step C: Fallback creation (if you ever use the panel without Terraform)
      const taskDef = await aws.registerTaskDefinition(project.region, {
        family: env.family,
        image: placeholderImage,
        executionRoleArn: project.ecsExecutionRoleArn,
        taskRoleArn: project.ecsTaskRoleArn,
        containerPort: containerPort || 3000
      });
      await aws.createEcsService(project.region, {
        clusterName: ecsClusterName,
        serviceName: env.service,
        taskDefinitionArn: taskDef.taskDefinitionArn,
        subnetIds, securityGroupId
      });
    }

    // Save the imported names into project state
    store.updateProject(project.id, {
      ecsClusterName, ecrRepoName, devServiceName, uatServiceName, prodServiceName,
      subnetIds, securityGroupId
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/setup/pipeline
router.post("/setup/pipeline", async (req, res) => {
  try {
    const project = await requireProject(req, res); if (!project) return;
    const { pipelineName, pipelineMode } = req.body;

    if (!project.pipelineRoleArn) return res.status(400).json({ ok: false, error: "Project is missing a CodePipeline service role ARN. Add it in project settings first." });
    if (!project.artifactBucket) return res.status(400).json({ ok: false, error: "Project is missing an S3 artifact bucket. Add it in project settings first." });
    if (!project.buildProjectName) return res.status(400).json({ ok: false, error: "Create the build project first." });

    const mode = pipelineMode || project.pipelineMode || "dev-uat-prod";

    if (project.sourceType === "github" && (!project.githubConnectionArn || !project.githubOwner || !project.githubRepo)) {
      return res.status(400).json({ ok: false, error: "Connect GitHub first." });
    }
    if (project.sourceType === "codecommit" && !project.repoName) {
      return res.status(400).json({ ok: false, error: "Create the CodeCommit repo first." });
    }
    if (mode === "dev-uat-prod" && (!project.ecsClusterName || !project.devServiceName || !project.uatServiceName || !project.prodServiceName)) {
      return res.status(400).json({ ok: false, error: "Complete the ECS setup step first." });
    }

    const result = await aws.createPipeline(project.region, {
      pipelineName,
      pipelineMode: mode,
      roleArn: project.pipelineRoleArn,
      artifactBucket: project.artifactBucket,
      buildProjectName: project.buildProjectName,
      sourceType: project.sourceType,
      repoName: project.repoName,
      branchName: project.githubBranch || "test",
      githubConnectionArn: project.githubConnectionArn,
      githubOwner: project.githubOwner,
      githubRepo: project.githubRepo,
      githubBranch: project.githubBranch,
      ecsClusterName: project.ecsClusterName,
      devServiceName: project.devServiceName,
      uatServiceName: project.uatServiceName,
      prodServiceName: project.prodServiceName
    });
    store.updateProject(project.id, { pipelineName, pipelineMode: mode });
    res.json({ ok: true, pipeline: result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
