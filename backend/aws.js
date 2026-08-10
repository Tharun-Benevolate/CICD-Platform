const {
  CodePipelineClient, GetPipelineStateCommand, PutApprovalResultCommand, ListPipelinesCommand,
  StartPipelineExecutionCommand, ListPipelineExecutionsCommand, CreatePipelineCommand,
  GetPipelineCommand, DeletePipelineCommand, StopPipelineExecutionCommand, RetryStageExecutionCommand,
  GetPipelineExecutionCommand
} = require("@aws-sdk/client-codepipeline");

const {
  CodeCommitClient, ListRepositoriesCommand, GetRepositoryCommand, ListBranchesCommand,
  GetBranchCommand, CreateBranchCommand, GetCommitCommand, CreateRepositoryCommand, DeleteRepositoryCommand, PutFileCommand
} = require("@aws-sdk/client-codecommit");

const {
  CodeBuildClient, ListBuildsForProjectCommand, BatchGetBuildsCommand, CreateProjectCommand,
  ListProjectsCommand, DeleteProjectCommand, StartBuildCommand
} = require("@aws-sdk/client-codebuild");

const { CloudWatchLogsClient, GetLogEventsCommand } = require("@aws-sdk/client-cloudwatch-logs");
const { STSClient, GetCallerIdentityCommand } = require("@aws-sdk/client-sts");

const {
  ECRClient, DescribeImagesCommand, CreateRepositoryCommand: CreateEcrRepoCommand
} = require("@aws-sdk/client-ecr");

const {
  ECSClient, CreateClusterCommand, CreateServiceCommand, UpdateServiceCommand,
  DescribeServicesCommand, RegisterTaskDefinitionCommand, DescribeTaskDefinitionCommand,
  ListTasksCommand, DescribeTasksCommand, waitUntilServicesStable
} = require("@aws-sdk/client-ecs");

const {
  CodeStarConnectionsClient, ListConnectionsCommand
} = require("@aws-sdk/client-codestar-connections");

const {
  ApplicationAutoScalingClient, RegisterScalableTargetCommand, DescribeScalableTargetsCommand,
  PutScalingPolicyCommand, DescribeScalingPoliciesCommand, DescribeScalingActivitiesCommand
} = require("@aws-sdk/client-application-auto-scaling");

const {
  ElasticLoadBalancingV2Client, DescribeRulesCommand, ModifyRuleCommand,
  CreateTargetGroupCommand, CreateRuleCommand, DeleteRuleCommand, DeleteTargetGroupCommand,
  DescribeListenersCommand, DescribeLoadBalancersCommand, DescribeTargetGroupsCommand,
  SetRulePrioritiesCommand
} = require("@aws-sdk/client-elastic-load-balancing-v2");

const {
  CodeDeployClient, CreateDeploymentCommand, GetDeploymentCommand,
  StopDeploymentCommand, ListDeploymentsCommand, ContinueDeploymentCommand,
  UpdateDeploymentGroupCommand
} = require("@aws-sdk/client-codedeploy");

const { S3Client, CreateBucketCommand, HeadBucketCommand } = require("@aws-sdk/client-s3");
const { DynamoDBClient, CreateTableCommand, DescribeTableCommand } = require("@aws-sdk/client-dynamodb");

function clients(region) {
  const config = { region };
  return {
    pipeline:    new CodePipelineClient(config),
    codecommit:  new CodeCommitClient(config),
    codebuild:   new CodeBuildClient(config),
    cwlogs:      new CloudWatchLogsClient(config),
    sts:         new STSClient(config),
    ecr:         new ECRClient(config),
    ecs:         new ECSClient(config),
    codestar:    new CodeStarConnectionsClient(config),
    appscaling:  new ApplicationAutoScalingClient(config),
    elbv2:       new ElasticLoadBalancingV2Client(config),
    codedeploy:  new CodeDeployClient(config)
  };
}

// --- Health / credentials check ---

async function getCallerAccountId(region = process.env.AWS_REGION || "us-east-1") {
  const { sts } = clients(region);
  try {
    const res = await sts.send(new GetCallerIdentityCommand({}));
    if (res.Account) return res.Account;
  } catch (err) {
    console.error("Failed to get caller account ID:", err.message);
  }
  return process.env.AWS_ACCOUNT_ID || "511974512004";
}

async function ensureTerraformBackendInfra(region = process.env.AWS_REGION || "us-east-1") {
  try {
    const accountId = await getCallerAccountId(region);
    const bucketName = `benevolate-tf-state-${accountId}`;
    const tableName = process.env.TF_LOCK_TABLE || "benevolate-tf-locks";

    const s3 = new S3Client({ region });
    const dynamodb = new DynamoDBClient({ region });

    // 1. Ensure S3 State Bucket exists
    try {
      await s3.send(new HeadBucketCommand({ Bucket: bucketName }));
    } catch (err) {
      if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404 || err.name === "NoSuchBucket") {
        console.log(`[AWS BACKEND] Creating S3 state bucket for account ${accountId}: ${bucketName}`);
        const createParams = { Bucket: bucketName };
        if (region !== "us-east-1") {
          createParams.CreateBucketConfiguration = { LocationConstraint: region };
        }
        await s3.send(new CreateBucketCommand(createParams));
      }
    }

    // 2. Ensure DynamoDB Lock Table exists
    try {
      await dynamodb.send(new DescribeTableCommand({ TableName: tableName }));
    } catch (err) {
      if (err.name === "ResourceNotFoundException" || err.$metadata?.httpStatusCode === 404) {
        console.log(`[AWS BACKEND] Creating DynamoDB lock table for account ${accountId}: ${tableName}`);
        await dynamodb.send(new CreateTableCommand({
          TableName: tableName,
          AttributeDefinitions: [{ AttributeName: "LockID", AttributeType: "S" }],
          KeySchema: [{ AttributeName: "LockID", KeyType: "HASH" }],
          BillingMode: "PAY_PER_REQUEST"
        }));
      }
    }

    return { bucketName, tableName, accountId };
  } catch (err) {
    console.error("Notice: Terraform backend infra check warning:", err.message);
    return null;
  }
}

async function checkCredentials(region) {
  const { sts } = clients(region);
  try {
    const res = await sts.send(new GetCallerIdentityCommand({}));
    return { ok: true, account: res.Account, arn: res.Arn };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// --- CodePipeline ---

async function getPipelineState(region, pipelineName) {
  if (!pipelineName) return [];
  try {
    const { pipeline } = clients(region);
    const res = await pipeline.send(new GetPipelineStateCommand({ name: pipelineName }));
    return res.stageStates || [];
  } catch (err) {
    return [];
  }
}

async function listPipelines(region) {
  try {
    const { pipeline } = clients(region);
    const res = await pipeline.send(new ListPipelinesCommand({}));
    return res.pipelines || [];
  } catch (err) {
    return [];
  }
}

async function getPipelineDefinition(region, pipelineName) {
  if (!pipelineName) return null;
  try {
    const { pipeline } = clients(region);
    const res = await pipeline.send(new GetPipelineCommand({ name: pipelineName }));
    return res.pipeline || null;
  } catch (err) {
    return null;
  }
}

async function startPipeline(region, pipelineName) {
  const { pipeline } = clients(region);
  const res = await pipeline.send(new StartPipelineExecutionCommand({ name: pipelineName }));
  return res.pipelineExecutionId;
}

async function listPipelineExecutions(region, pipelineName) {
  if (!pipelineName) return [];
  try {
    const { pipeline } = clients(region);
    const res = await pipeline.send(new ListPipelineExecutionsCommand({ pipelineName, maxResults: 10 }));
    return res.pipelineExecutionSummaries || [];
  } catch (err) {
    return [];
  }
}

async function getPipelineExecution(region, pipelineName, pipelineExecutionId) {
  const { pipeline } = clients(region);
  const res = await pipeline.send(new GetPipelineExecutionCommand({ pipelineName, pipelineExecutionId }));
  return res.pipelineExecution;
}

async function waitForNewPipelineExecution(region, pipelineName, { after = new Date(), maxWaitSeconds = 120, pollSeconds = 3 } = {}) {
  const deadline = Date.now() + maxWaitSeconds * 1000;
  const afterMs = after instanceof Date ? after.getTime() : Number(after) || 0;
  while (Date.now() < deadline) {
    const executions = await listPipelineExecutions(region, pipelineName);
    const match = (executions || []).find(e => {
      const started = e.startTime ? new Date(e.startTime).getTime() : 0;
      return started >= afterMs - 5000 && ["InProgress", "Succeeded", "Superseded"].includes(e.status);
    });
    if (match) return match.pipelineExecutionId;
    await new Promise(r => setTimeout(r, pollSeconds * 1000));
  }
  return null;
}

function _executionIdFromStages(stages) {
  for (const stage of stages || []) {
    for (const action of stage.actionStates || []) {
      const id = action.latestExecution?.pipelineExecutionId;
      if (id) return id;
    }
  }
  return null;
}

function _sourceRevisionFromExecution(execution) {
  const rev = (execution?.artifactRevisions || []).find(a =>
    a.name === "SourceOutput" || a.name === "source_output" || /source/i.test(a.name || "")
  ) || (execution?.artifactRevisions || [])[0];
  if (!rev) return null;
  return {
    revisionId: rev.revisionId || null,
    revisionSummary: rev.revisionSummary || null,
    revisionUrl: rev.revisionUrl || null
  };
}

async function getPendingApprovals(region, pipelineName, enrichOpts = {}) {
  const stages = await getPipelineState(region, pipelineName);
  const pipelineExecutionId = _executionIdFromStages(stages);
  let executionContext = null;

  if (pipelineExecutionId) {
    try {
      const execution = await getPipelineExecution(region, pipelineName, pipelineExecutionId);
      const sourceRev = _sourceRevisionFromExecution(execution);
      executionContext = {
        pipelineExecutionId,
        sourceRevisionId: sourceRev?.revisionId || null,
        sourceRevisionSummary: sourceRev?.revisionSummary || null,
        sourceRevisionUrl: sourceRev?.revisionUrl || null,
        trigger: execution?.trigger || null
      };
    } catch (_) { /* non-fatal */ }
  }

  let releaseContext = null;
  if (enrichOpts.projectId && enrichOpts.releasePromotionStore) {
    const store = enrichOpts.releasePromotionStore;
    if (pipelineExecutionId) {
      releaseContext = await store.findByExecution(enrichOpts.projectId, pipelineExecutionId);
    }
    if (!releaseContext) {
      releaseContext = await store.findLatestForProject(enrichOpts.projectId, 48);
    }
  }

  // Optional GitHub commit enrichment
  if (enrichOpts.github && enrichOpts.githubOwner && enrichOpts.githubRepo) {
    const sha = releaseContext?.commitSha || executionContext?.sourceRevisionId;
    if (sha && /^[0-9a-f]{7,40}$/i.test(sha)) {
      try {
        const commit = await enrichOpts.github.getCommit(
          enrichOpts.githubOwner, enrichOpts.githubRepo, sha
        );
        if (commit?.message && !releaseContext?.commitMessage) {
          executionContext = executionContext || {};
          executionContext.commitMessage = commit.message;
        }
      } catch (_) { /* non-fatal */ }
    }
  }

  const pending = [];
  for (const stage of stages) {
    for (const action of (stage.actionStates || [])) {
      const status = action.latestExecution?.status;
      if (status === "InProgress" && action.actionName?.toLowerCase().includes("approv")) {
        let envGate = "unknown";
        const lower = stage.stageName.toLowerCase();
        if (lower.includes("uat")) envGate = "uat";
        else if (lower.includes("prod")) envGate = "prod";

        pending.push({
          stageName: stage.stageName,
          actionName: action.actionName,
          token: action.latestExecution?.token,
          lastUpdate: action.latestExecution?.lastStatusChange,
          pipelineName,
          pipelineExecutionId: action.latestExecution?.pipelineExecutionId || pipelineExecutionId,
          envGate,
          releaseBranch: releaseContext?.releaseBranch || null,
          triggeredBy: releaseContext?.triggeredBy || null,
          commitSha: releaseContext?.commitSha || executionContext?.sourceRevisionId || null,
          commitMessage: releaseContext?.commitMessage || executionContext?.commitMessage || executionContext?.sourceRevisionSummary || null,
          mergeTargetBranch: releaseContext?.targetBranch || null
        });
      }
    }
  }
  return pending;
}

async function approveAction(region, pipelineName, stageName, actionName, token, approved, comment = "") {
  const { pipeline } = clients(region);
  return pipeline.send(new PutApprovalResultCommand({
    pipelineName, stageName, actionName, token,
    result: {
      status: approved ? "Approved" : "Rejected",
      summary: comment || (approved ? "Approved via admin panel" : "Rejected via admin panel")
    }
  }));
}

// Builds the Source stage action depending on sourceType — keeps CodeCommit working, adds GitHub
function buildSourceAction({ sourceType, repoName, branchName, githubConnectionArn, githubOwner, githubRepo, githubBranch }) {
  if (sourceType === "github") {
    return {
      name: "Source",
      actionTypeId: { category: "Source", owner: "AWS", provider: "CodeStarSourceConnection", version: "1" },
      outputArtifacts: [{ name: "SourceOutput" }],
      configuration: {
        ConnectionArn: githubConnectionArn,
        FullRepositoryId: `${githubOwner}/${githubRepo}`,
        BranchName: githubBranch || "main",
        OutputArtifactFormat: "CODE_ZIP"
      }
    };
  }
  // legacy CodeCommit source
  return {
    name: "Source",
    actionTypeId: { category: "Source", owner: "AWS", provider: "CodeCommit", version: "1" },
    outputArtifacts: [{ name: "SourceOutput" }],
    configuration: { RepositoryName: repoName, BranchName: branchName || "test", PollForSourceChanges: "false" }
  };
}

// Creates a pipeline. Two modes:
//  - "single": Source -> Build -> Manual Approval -> Deploy   (legacy, EC2/CodeDeploy projects no longer use this path for deploy, but pipeline shape itself still supported for other deploy types)
//  - "dev-uat-prod": Source -> Build -> Deploy(dev, auto) -> Approval(uat) -> Deploy(uat) -> Approval(prod) -> Deploy(prod)   (Sanjay's spec, ECS-based)
async function createPipeline(region, opts) {
  const { pipeline } = clients(region);
  const {
    pipelineName, roleArn, artifactBucket, pipelineMode,
    buildProjectName,
    // single mode deploy (kept for non-EC2 future use, e.g. could point at an ECS deploy action too)
    deployActionConfig,
    // dev-uat-prod mode
    ecsClusterName, devServiceName, uatServiceName, prodServiceName
  } = opts;

  const sourceAction = buildSourceAction(opts);

  let stages;

  if (pipelineMode === "dev-uat-prod") {
    stages = [
      { name: "Source", actions: [sourceAction] },
      {
        name: "Build",
        actions: [{
          name: "Build",
          actionTypeId: { category: "Build", owner: "AWS", provider: "CodeBuild", version: "1" },
          inputArtifacts: [{ name: "SourceOutput" }],
          outputArtifacts: [{ name: "BuildOutput" }],
          configuration: { ProjectName: buildProjectName }
        }]
      },
      {
        name: "DeployDev",
        actions: [{
          name: "DeployDev",
          actionTypeId: { category: "Deploy", owner: "AWS", provider: "ECS", version: "1" },
          inputArtifacts: [{ name: "BuildOutput" }],
          configuration: { ClusterName: ecsClusterName, ServiceName: devServiceName }
        }]
      },
      {
        name: "ApproveUAT",
        actions: [{
          name: "ApproveUAT",
          actionTypeId: { category: "Approval", owner: "AWS", provider: "Manual", version: "1" },
          configuration: {}
        }]
      },
      {
        name: "DeployUAT",
        actions: [{
          name: "DeployUAT",
          actionTypeId: { category: "Deploy", owner: "AWS", provider: "ECS", version: "1" },
          inputArtifacts: [{ name: "BuildOutput" }],
          configuration: { ClusterName: ecsClusterName, ServiceName: uatServiceName }
        }]
      },
      {
        name: "ApproveProd",
        actions: [{
          name: "ApproveProd",
          actionTypeId: { category: "Approval", owner: "AWS", provider: "Manual", version: "1" },
          configuration: {}
        }]
      },
      {
        name: "DeployProd",
        actions: [{
          name: "DeployProd",
          actionTypeId: { category: "Deploy", owner: "AWS", provider: "ECS", version: "1" },
          inputArtifacts: [{ name: "BuildOutput" }],
          configuration: { ClusterName: ecsClusterName, ServiceName: prodServiceName }
        }]
      }
    ];
  } else {
    // legacy single-approval mode
    stages = [
      { name: "Source", actions: [sourceAction] },
      {
        name: "Build",
        actions: [{
          name: "Build",
          actionTypeId: { category: "Build", owner: "AWS", provider: "CodeBuild", version: "1" },
          inputArtifacts: [{ name: "SourceOutput" }],
          outputArtifacts: [{ name: "BuildOutput" }],
          configuration: { ProjectName: buildProjectName }
        }]
      },
      {
        name: "Approval",
        actions: [{
          name: "ManualApproval",
          actionTypeId: { category: "Approval", owner: "AWS", provider: "Manual", version: "1" },
          configuration: {}
        }]
      },
      {
        name: "Deploy",
        actions: [{
          name: "Deploy",
          actionTypeId: { category: "Deploy", owner: "AWS", provider: "ECS", version: "1" },
          inputArtifacts: [{ name: "BuildOutput" }],
          configuration: deployActionConfig || {}
        }]
      }
    ];
  }

  const definition = {
    pipeline: {
      name: pipelineName,
      roleArn,
      artifactStore: { type: "S3", location: artifactBucket },
      stages
    }
  };
  const res = await pipeline.send(new CreatePipelineCommand(definition));
  return res.pipeline;
}

async function deletePipeline(region, pipelineName) {
  const { pipeline } = clients(region);
  return pipeline.send(new DeletePipelineCommand({ name: pipelineName }));
}

// --- CodeCommit ---

async function listRepos(region) {
  const { codecommit } = clients(region);
  const res = await codecommit.send(new ListRepositoriesCommand({}));
  return res.repositories;
}

async function getRepo(region, repositoryName) {
  const { codecommit } = clients(region);
  const res = await codecommit.send(new GetRepositoryCommand({ repositoryName }));
  return res.repositoryMetadata;
}

async function createRepo(region, repositoryName, description) {
  const { codecommit } = clients(region);
  const res = await codecommit.send(new CreateRepositoryCommand({ repositoryName, repositoryDescription: description || "" }));
  return res.repositoryMetadata;
}

async function deleteRepo(region, repositoryName) {
  const { codecommit } = clients(region);
  return codecommit.send(new DeleteRepositoryCommand({ repositoryName }));
}

async function listBranches(region, repositoryName) {
  const { codecommit } = clients(region);
  const res = await codecommit.send(new ListBranchesCommand({ repositoryName }));
  return res.branches || [];
}

async function getBranchDetail(region, repositoryName, branchName) {
  const { codecommit } = clients(region);
  const res = await codecommit.send(new GetBranchCommand({ repositoryName, branchName }));
  const commitId = res.branch.commitId;
  let commit = null;
  try {
    const c = await codecommit.send(new GetCommitCommand({ repositoryName, commitId }));
    commit = c.commit;
  } catch (e) { /* ignore */ }
  return { branchName, commitId, commit };
}

async function createBranch(region, repositoryName, branchName, baseBranch) {
  const { codecommit } = clients(region);
  let commitId = null;
  try {
    const baseRes = await codecommit.send(new GetBranchCommand({ repositoryName, branchName: baseBranch || "main" }));
    commitId = baseRes.branch?.commitId;
  } catch (e) {
    // If base branch doesn't exist yet (e.g. fresh empty repo), put an initial commit first
    try {
      const initRes = await codecommit.send(new PutFileCommand({
        repositoryName,
        branchName: branchName || "main",
        fileContent: Buffer.from("# " + repositoryName + "\nInitial repository setup.\n"),
        filePath: "README.md",
        commitMessage: "Initial commit"
      }));
      return { branchName: branchName || "main", basedOn: "initial", commitId: initRes.commitId };
    } catch (putErr) {
      throw e;
    }
  }
  await codecommit.send(new CreateBranchCommand({ repositoryName, branchName, commitId }));
  return { branchName, basedOn: baseBranch, commitId };
}

// --- CodeBuild ---

async function createBuildProject(region, { projectName, repoName, roleArn, buildspec, artifactBucket, computeImage }) {
  const { codebuild } = clients(region);
  const res = await codebuild.send(new CreateProjectCommand({
    name: projectName,
    source: { type: "CODEPIPELINE", buildspec: buildspec || undefined },
    artifacts: { type: "CODEPIPELINE" },
    environment: {
      type: "LINUX_CONTAINER",
      image: computeImage || "aws/codebuild/standard:7.0",
      computeType: "BUILD_GENERAL1_SMALL"
    },
    serviceRole: roleArn
  }));
  return res.project;
}

async function deleteBuildProject(region, projectName) {
  const { codebuild } = clients(region);
  return codebuild.send(new DeleteProjectCommand({ name: projectName }));
}

async function startBuild(region, projectName) {
  const { codebuild } = clients(region);
  const res = await codebuild.send(new StartBuildCommand({ projectName }));
  return res.build;
}

async function getLatestBuildForProject(region, projectName) {
  const { codebuild } = clients(region);
  const list = await codebuild.send(new ListBuildsForProjectCommand({ projectName }));
  const ids = (list.ids || []).slice(0, 1);
  if (ids.length === 0) return null;
  const detail = await codebuild.send(new BatchGetBuildsCommand({ ids }));
  return detail.builds?.[0] || null;
}

async function getBuildLogs(region, build) {
  if (!build?.logs?.groupName || !build?.logs?.streamName) return [];
  const { cwlogs } = clients(region);
  try {
    const res = await cwlogs.send(new GetLogEventsCommand({
      logGroupName: build.logs.groupName,
      logStreamName: build.logs.streamName,
      startFromHead: true,
      limit: 200
    }));
    return (res.events || []).map(e => ({ timestamp: e.timestamp, message: e.message }));
  } catch (e) {
    return [];
  }
}

// --- CodeStar Connections (GitHub auth bridge) ---

async function listConnections(region) {
  const { codestar } = clients(region);
  const res = await codestar.send(new ListConnectionsCommand({}));
  return res.Connections || [];
}

// --- ECR (container image registry — holds the last N build images) ---

async function createEcrRepo(region, repositoryName) {
  const { ecr } = clients(region);
  const res = await ecr.send(new CreateEcrRepoCommand({ repositoryName }));
  return res.repository;
}

async function listEcrImages(region, repositoryName) {
  const { ecr } = clients(region);
  const res = await ecr.send(new DescribeImagesCommand({ repositoryName }));
  return (res.imageDetails || []).sort((a, b) => new Date(b.imagePushedAt) - new Date(a.imagePushedAt));
}

// --- ECS / Fargate ---

async function createEcsCluster(region, clusterName) {
  const { ecs } = clients(region);
  const res = await ecs.send(new CreateClusterCommand({ clusterName }));
  return res.cluster;
}

async function registerTaskDefinition(region, { family, image, executionRoleArn, taskRoleArn, containerPort, cpu, memory, containerName, environment }) {
  const { ecs } = clients(region);
  const res = await ecs.send(new RegisterTaskDefinitionCommand({
    family,
    requiresCompatibilities: ["FARGATE"],
    networkMode: "awsvpc",
    cpu: cpu || "256",
    memory: memory || "512",
    executionRoleArn,
    taskRoleArn: taskRoleArn || executionRoleArn,
    containerDefinitions: [{
      name: containerName || family,
      image,
      essential: true,
      portMappings: [{ containerPort: containerPort || 3000, protocol: "tcp" }],
      environment: environment || [],
      logConfiguration: {
        logDriver: "awslogs",
        options: {
          "awslogs-group": `/ecs/${family}`,
          "awslogs-region": region,
          "awslogs-stream-prefix": family,
          "awslogs-create-group": "true"
        }
      }
    }]
  }));
  return res.taskDefinition;
}

// project.subnetIds is a comma-separated string when it comes from the
// normal Terraform-output flow (routes/terraform.js), but some code paths
// (direct API calls, project import/seed data) can persist it as an array
// instead — projectStore.updateProject() does a raw merge with no schema
// coercion, so whatever shape was written is what comes back out. Accept
// both so a caller never has to know which one it's holding.
function normalizeSubnetIds(subnetIds) {
  if (Array.isArray(subnetIds)) return subnetIds.map(s => String(s).trim()).filter(Boolean);
  return String(subnetIds || "").split(",").map(s => s.trim()).filter(Boolean);
}

async function createEcsService(region, { clusterName, serviceName, taskDefinitionArn, subnetIds, securityGroupId, targetGroupArn, containerName, containerPort, desiredCount = 1, assignPublicIp = "ENABLED" }) {
  const { ecs } = clients(region);
  const res = await ecs.send(new CreateServiceCommand({
    cluster: clusterName,
    serviceName,
    taskDefinition: taskDefinitionArn,
    desiredCount,
    launchType: "FARGATE",
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: normalizeSubnetIds(subnetIds),
        securityGroups: [securityGroupId],
        assignPublicIp
      }
    },
    ...(targetGroupArn ? { loadBalancers: [{
      targetGroupArn,
      containerName,
      containerPort: containerPort || 3000
    }] } : {})
  }));
  return res.service;
}

async function describeEcsService(region, clusterName, serviceName) {
  const { ecs } = clients(region);
  const res = await ecs.send(new DescribeServicesCommand({ cluster: clusterName, services: [serviceName] }));
  return res.services?.[0] || null;
}

// --- Manual Auto-scaling Controls ---
// resourceId format for ECS services: "service/<clusterName>/<serviceName>"

function ecsResourceId(clusterName, serviceName) {
  return `service/${clusterName}/${serviceName}`;
}

// Reads the current scalable target (min/max capacity) and any target-tracking
// CPU policy for an ECS service, so the UI can show what's actually configured
// in AWS right now (which may have been set by Terraform, not just this panel).
async function getScalingConfig(region, clusterName, serviceName) {
  const { appscaling } = clients(region);
  const resourceId = ecsResourceId(clusterName, serviceName);

  const [targets, policies] = await Promise.all([
    appscaling.send(new DescribeScalableTargetsCommand({
      ServiceNamespace: "ecs",
      ResourceIds: [resourceId],
      ScalableDimension: "ecs:service:DesiredCount"
    })),
    appscaling.send(new DescribeScalingPoliciesCommand({
      ServiceNamespace: "ecs",
      ResourceId: resourceId,
      ScalableDimension: "ecs:service:DesiredCount"
    }))
  ]);

  const target = targets.ScalableTargets?.[0] || null;
  const cpuPolicy = (policies.ScalingPolicies || []).find(
    p => p.TargetTrackingScalingPolicyConfiguration?.PredefinedMetricSpecification?.PredefinedMetricType === "ECSServiceAverageCPUUtilization"
  ) || null;

  return {
    configured: !!target,
    minCapacity: target?.MinCapacity ?? null,
    maxCapacity: target?.MaxCapacity ?? null,
    targetCpuPercent: cpuPolicy?.TargetTrackingScalingPolicyConfiguration?.TargetValue ?? null,
    scaleOutCooldown: cpuPolicy?.TargetTrackingScalingPolicyConfiguration?.ScaleOutCooldown ?? null,
    scaleInCooldown: cpuPolicy?.TargetTrackingScalingPolicyConfiguration?.ScaleInCooldown ?? null,
    policyArn: cpuPolicy?.PolicyARN || null
  };
}

// Sets min/max capacity and a target-tracking CPU policy for an ECS service.
// NOTE: if this environment's infra is also managed by Terraform with hardcoded
// min/max/target values, a future `terraform apply` without updating those
// variables will silently revert whatever is set here. This is a drift risk,
// not a bug — Terraform and this API call both write to the same AWS resource.
async function setScalingConfig(region, clusterName, serviceName, { minCapacity, maxCapacity, targetCpuPercent }) {
  const { appscaling } = clients(region);
  const resourceId = ecsResourceId(clusterName, serviceName);

  await appscaling.send(new RegisterScalableTargetCommand({
    ServiceNamespace: "ecs",
    ResourceId: resourceId,
    ScalableDimension: "ecs:service:DesiredCount",
    MinCapacity: minCapacity,
    MaxCapacity: maxCapacity
  }));

  await appscaling.send(new PutScalingPolicyCommand({
    ServiceNamespace: "ecs",
    ResourceId: resourceId,
    ScalableDimension: "ecs:service:DesiredCount",
    PolicyName: `${serviceName}-cpu-target-tracking`,
    PolicyType: "TargetTrackingScaling",
    TargetTrackingScalingPolicyConfiguration: {
      TargetValue: targetCpuPercent,
      PredefinedMetricSpecification: { PredefinedMetricType: "ECSServiceAverageCPUUtilization" },
      ScaleOutCooldown: 60,
      ScaleInCooldown: 120
    }
  }));

  return getScalingConfig(region, clusterName, serviceName);
}

// Recent scale-out/scale-in activity, so the UI can show "what the autoscaler actually did"
async function getScalingActivity(region, clusterName, serviceName) {
  const { appscaling } = clients(region);
  const resourceId = ecsResourceId(clusterName, serviceName);
  const res = await appscaling.send(new DescribeScalingActivitiesCommand({
    ServiceNamespace: "ecs",
    ResourceId: resourceId,
    ScalableDimension: "ecs:service:DesiredCount",
    MaxResults: 10
  }));
  return (res.ScalingActivities || []).map(a => ({
    activityId: a.ActivityId,
    description: a.Description,
    cause: a.Cause,
    statusCode: a.StatusCode,
    startTime: a.StartTime,
    endTime: a.EndTime
  }));
}

// --- Blue-Green traffic weight control (prod only) ---
// Reads/modifies the weighted forward action on the prod listener rule
// directly via the ELBv2 API. This does NOT touch Terraform state — it's a
// live, reversible change. If Terraform is re-applied afterward without
// updating prod_blue_weight/prod_green_weight to match, it will revert
// the weights back to whatever those variables say.

async function getBlueGreenWeights(region, listenerRuleArn) {
  const { elbv2 } = clients(region);
  const res = await elbv2.send(new DescribeRulesCommand({ RuleArns: [listenerRuleArn] }));
  const rule = res.Rules?.[0];
  if (!rule) throw new Error("Listener rule not found");

  const action = (rule.Actions || []).find(a => a.Type === "forward");
  const groups = action?.ForwardConfig?.TargetGroups || [];
  return groups.map(g => ({ targetGroupArn: g.TargetGroupArn, weight: g.Weight }));
}

async function setBlueGreenWeights(region, listenerRuleArn, blueTargetGroupArn, greenTargetGroupArn, blueWeight, greenWeight) {
  const { elbv2 } = clients(region);
  await elbv2.send(new ModifyRuleCommand({
    RuleArn: listenerRuleArn,
    Actions: [{
      Type: "forward",
      ForwardConfig: {
        TargetGroups: [
          { TargetGroupArn: blueTargetGroupArn, Weight: blueWeight },
          { TargetGroupArn: greenTargetGroupArn, Weight: greenWeight }
        ]
      }
    }]
  }));
  return getBlueGreenWeights(region, listenerRuleArn);
}

async function describeTaskDefinition(region, taskDefinitionArn) {
  const { ecs } = clients(region);
  const res = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: taskDefinitionArn }));
  return res.taskDefinition || null;
}

// Deploys a specific image to an environment's ECS service by registering a new task def revision
// and updating the service to use it. This IS the rollback mechanism too — pass any old image URI.
async function deployImageToService(region, { clusterName, serviceName, family, image, executionRoleArn, taskRoleArn, containerPort }) {
  const service = await describeEcsService(region, clusterName, serviceName);
  let containerName = family; // fallback
  let port = containerPort || 3000;
  let environment = [];

  if (service && service.taskDefinition) {
    const activeTaskDef = await describeTaskDefinition(region, service.taskDefinition);
    if (activeTaskDef && activeTaskDef.containerDefinitions && activeTaskDef.containerDefinitions[0]) {
      const mainContainer = activeTaskDef.containerDefinitions[0];
      containerName = mainContainer.name;
      if (mainContainer.portMappings && mainContainer.portMappings[0]) {
        port = mainContainer.portMappings[0].containerPort;
      }
      // Carry forward whatever env vars the previous revision had (e.g.
      // ADMIN_API_URL, ECS_CLUSTER, ALB_LISTENER_RULE_ARN) — otherwise every
      // redeploy silently registers a fresh task def with an empty
      // environment array and quietly breaks anything that depended on it.
      environment = mainContainer.environment || [];
    }
  }

  const taskDef = await registerTaskDefinition(region, { 
    family, 
    image, 
    executionRoleArn, 
    taskRoleArn, 
    containerPort: port,
    containerName,
    environment
  });
  
  const { ecs } = clients(region);
  const res = await ecs.send(new UpdateServiceCommand({
    cluster: clusterName,
    service: serviceName,
    taskDefinition: taskDef.taskDefinitionArn,
    forceNewDeployment: true
  }));
  return { service: res.service, taskDefinitionArn: taskDef.taskDefinitionArn };
}

async function listRunningTasks(region, clusterName, serviceName) {
  const { ecs } = clients(region);
  const listRes = await ecs.send(new ListTasksCommand({ cluster: clusterName, serviceName }));
  if (!listRes.taskArns || listRes.taskArns.length === 0) return [];
  const detail = await ecs.send(new DescribeTasksCommand({ cluster: clusterName, tasks: listRes.taskArns }));
  return detail.tasks || [];
}

async function stopPipeline(region, pipelineName, executionId) {
  const { pipeline } = clients(region);
  return pipeline.send(new StopPipelineExecutionCommand({
    pipelineName, pipelineExecutionId: executionId,
    abandon: false, reason: "Stopped via Benevolate Admin Panel"
  }));
}

async function retryStage(region, pipelineName, stageName, pipelineExecutionId) {
  const { pipeline } = clients(region);
  return pipeline.send(new RetryStageExecutionCommand({
    pipelineName, stageName, pipelineExecutionId,
    retryMode: "FAILED_ACTIONS"
  }));
}

// ─── CodeDeploy (Blue/Green) ──────────────────────────────────────────────

async function createDeployment(region, { appName, deploymentGroupName, taskDefArn, containerName, containerPort, deploymentConfigName }) {
  const { codedeploy } = clients(region);
  const appspec = {
    version: "0.0",
    Resources: [{
      TargetService: {
        Type: "AWS::ECS::Service",
        Properties: {
          TaskDefinition: taskDefArn,
          LoadBalancerInfo: {
            ContainerName: containerName,
            ContainerPort: containerPort
          }
        }
      }
    }]
  };
  const params = {
    applicationName: appName,
    deploymentGroupName,
    revision: {
      revisionType: "AppSpecContent",
      appSpecContent: { content: JSON.stringify(appspec) }
    }
  };
  if (deploymentConfigName) params.deploymentConfigName = deploymentConfigName;
  return codedeploy.send(new CreateDeploymentCommand(params));
}

async function updateDeploymentGroup(region, appName, deploymentGroupName, { terminationWaitTimeInMinutes }) {
  const { codedeploy } = clients(region);
  return codedeploy.send(new UpdateDeploymentGroupCommand({
    applicationName: appName,
    currentDeploymentGroupName: deploymentGroupName,
    blueGreenDeploymentConfiguration: {
      // AWS requires deploymentReadyOption to be present whenever
      // blueGreenDeploymentConfiguration is sent — even if unchanged.
      // We keep the same CONTINUE_DEPLOYMENT/0-min setting Terraform provisions.
      deploymentReadyOption: {
        actionOnTimeout: "CONTINUE_DEPLOYMENT",
        waitTimeInMinutes: 0
      },
      terminateBlueInstancesOnDeploymentSuccess: {
        action: "TERMINATE",
        terminationWaitTimeInMinutes: Math.max(0, Math.min(2880, terminationWaitTimeInMinutes))
      }
    }
  }));
}

async function getDeployment(region, deploymentId) {
  const { codedeploy } = clients(region);
  const res = await codedeploy.send(new GetDeploymentCommand({ deploymentId }));
  const d = res.deploymentInfo;
  return {
    deploymentId: d.deploymentId,
    status: d.status,                     // Created|Queued|InProgress|Baking|Succeeded|Failed|Stopped|Ready
    createTime: d.createTime,
    completeTime: d.completeTime,
    description: d.description,
    errorInformation: d.errorInformation,
    blueGreenDeploymentConfiguration: d.blueGreenDeploymentConfiguration,
    deploymentOverview: d.deploymentOverview  // {Pending, InProgress, Succeeded, Failed, Skipped, Ready}
  };
}

async function stopDeployment(region, deploymentId, autoRollbackEnabled = true) {
  const { codedeploy } = clients(region);
  return codedeploy.send(new StopDeploymentCommand({
    deploymentId,
    autoRollbackEnabled
  }));
}

async function continueDeployment(region, deploymentId) {
  const { codedeploy } = clients(region);
  return codedeploy.send(new ContinueDeploymentCommand({
    deploymentId,
    deploymentWaitType: "READY_WAIT" // advance past the "wait for traffic shift" gate
  }));
}

async function listRecentDeployments(region, appName, deploymentGroupName, limit = 5) {
  const { codedeploy } = clients(region);
  const list = await codedeploy.send(new ListDeploymentsCommand({
    applicationName: appName,
    deploymentGroupName,
    includeOnlyStatuses: ["Created", "Queued", "InProgress", "Baking", "Ready", "Succeeded", "Failed", "Stopped"]
  }));
  const ids = (list.deployments || []).slice(0, limit);
  if (ids.length === 0) return [];
  return Promise.all(ids.map(id => getDeployment(region, id)));
}


// ── Cookie-based beta / release helpers (preserved from current platform) ──
const BETA_ROUTING_OFF_VALUE = "__beta_off__";

async function scaleEcsService(region, clusterName, serviceName, desiredCount) {
  const { ecs } = clients(region);
  const res = await ecs.send(new UpdateServiceCommand({
    cluster: clusterName,
    service: serviceName,
    desiredCount
  }));
  return res.service;
}

async function waitForServiceStable(region, clusterName, serviceName, maxWaitSeconds = 600) {
  const { ecs } = clients(region);
  await waitUntilServicesStable(
    {
      client: ecs,
      maxWaitTime: maxWaitSeconds,
      minDelay: 10,
      maxDelay: 20
    },
    { cluster: clusterName, services: [serviceName] }
  );
  const svc = await describeEcsService(region, clusterName, serviceName);
  return {
    serviceName,
    desiredCount: svc?.desiredCount ?? null,
    runningCount: svc?.runningCount ?? null,
    pendingCount: svc?.pendingCount ?? null,
    taskDefinition: svc?.taskDefinition || null
  };
}

async function startBuildFromBranch(region, projectName, branchName, sourceLocation) {
  const { codebuild } = clients(region);
  // Prefer refs/heads/... so CodeBuild resolves the branch tip, not a tag of the same name.
  const sourceVersion = branchName.startsWith("refs/") || /^[0-9a-f]{7,40}$/i.test(branchName)
    ? branchName
    : `refs/heads/${branchName}`;
  const params = {
    projectName,
    sourceVersion,
    artifactsOverride: { type: "NO_ARTIFACTS" }
  };
  if (sourceLocation) {
    params.sourceTypeOverride = "GITHUB";
    params.sourceLocationOverride = sourceLocation;
  }
  const res = await codebuild.send(new StartBuildCommand(params));
  return res.build;
}

async function getBuildById(region, buildId) {
  const { codebuild } = clients(region);
  const res = await codebuild.send(new BatchGetBuildsCommand({ ids: [buildId] }));
  return res.builds?.[0] || null;
}

async function getBetaListenerRule(region, ruleArn) {
  const { elbv2 } = clients(region);
  const res = await elbv2.send(new DescribeRulesCommand({ RuleArns: [ruleArn] }));
  const rule = res.Rules?.[0];
  if (!rule) throw new Error('Beta listener rule not found');
  return rule;
}

async function updateBetaListenerRule(region, ruleArn, cookieName, cookieValue) {
  const { elbv2 } = clients(region);
  const rule = await getBetaListenerRule(region, ruleArn);
  const conditions = (rule.Conditions || []).map(c => {
    if (c.Field === 'http-header') {
      return {
        Field: 'http-header',
        HttpHeaderConfig: { HttpHeaderName: 'Cookie', Values: [`*${cookieName}=${cookieValue}*`] }
      };
    }
    // DescribeRules populates BOTH the deprecated top-level `Values` field and the
    // modern typed *Config field on every condition, for backwards compatibility.
    // ModifyRule rejects conditions that have both set (e.g. "You cannot provide
    // both Values and 'HostHeaderConfig'"), so strip the legacy field before
    // passing unrelated conditions back through unchanged.
    const { Values, ...rest } = c;
    return rest;
  });
  await elbv2.send(new ModifyRuleCommand({ RuleArn: ruleArn, Conditions: conditions }));
  return getBetaListenerRule(region, ruleArn);
}

async function setBetaRoutingEnabled(region, ruleArn, enabled, cookieName = "__env") {
  const cookieValue = enabled ? "beta" : BETA_ROUTING_OFF_VALUE;
  await updateBetaListenerRule(region, ruleArn, cookieName, cookieValue);
  return { enabled: !!enabled, cookieName, cookieValue };
}


// ─── Beta On-Demand: create a host-header+cookie scoped ALB rule + TG ────────
async function createBetaTargetGroup(region, { vpcId, name, port = 3000 }) {
  const { elbv2 } = clients(region);
  // AWS caps target group Name at 32 chars and rejects a trailing hyphen —
  // a blind slice(0, 32) can land mid-suffix and leave one dangling.
  const tgName = name.slice(0, 32).replace(/-+$/, "");
  try {
    const res = await elbv2.send(new CreateTargetGroupCommand({
      Name: tgName,
      Protocol: "HTTP",
      Port: port,
      VpcId: vpcId,
      TargetType: "ip",
      HealthCheckPath: "/health",
      HealthCheckIntervalSeconds: 30,
      HealthyThresholdCount: 2,
      UnhealthyThresholdCount: 3
    }));
    return res.TargetGroups[0];
  } catch (err) {
    // A previous provisioning attempt can fail partway through and leave
    // this target group behind (e.g. the ECS service or listener rule step
    // failed afterward). Reuse it instead of erroring on every retry —
    // otherwise every project that hits a transient failure here is stuck
    // needing manual AWS console cleanup before it can ever succeed.
    if (String(err.name).includes("DuplicateTargetGroupName") || String(err.message).includes("already exists")) {
      const existing = await elbv2.send(new DescribeTargetGroupsCommand({ Names: [tgName] }));
      if (existing.TargetGroups?.[0]) return existing.TargetGroups[0];
    }
    throw err;
  }
}

async function getNextListenerRulePriority(region, listenerArn, hostHeader) {
  const { elbv2 } = clients(region);
  const rules = [];
  let marker = undefined;

  do {
    const res = await elbv2.send(new DescribeRulesCommand({ ListenerArn: listenerArn, Marker: marker }));
    for (const rule of res.Rules || []) {
      if (rule.IsDefault) continue;
      const p = parseInt(rule.Priority, 10);
      if (!isNaN(p)) rules.push({ priority: p, conditions: rule.Conditions || [] });
    }
    marker = res.NextMarker;
  } while (marker);

  const usedPriorities = new Set(rules.map(r => r.priority));

  // golf-infra-terraform creates an UNCONDITIONAL host-header-only rule for
  // prod (aws_lb_listener_rule.prod — no cookie condition, forwards straight
  // to prod_blue). ALB evaluates rules in ascending priority order and stops
  // at the first match. If our cookie-based beta rule lands at a HIGHER
  // priority number than that catch-all rule (which is what "next available"
  // does — it always appends at the end), the catch-all wins for every
  // single request to that host, cookie or not, and the beta rule can never
  // fire no matter how correctly the cookie is set. So: find that catch-all
  // rule for this exact host and insert just below its priority number
  // instead of appending after everything.
  if (hostHeader) {
    const catchAll = rules.find(r => {
      const hostCond = r.conditions.find(c => c.Field === "host-header");
      const hostValues = hostCond?.HostHeaderConfig?.Values || hostCond?.Values || [];
      const hasCookieCond = r.conditions.some(c => c.Field === "http-header");
      return hostValues.includes(hostHeader) && !hasCookieCond;
    });
    if (catchAll) {
      let candidate = catchAll.priority - 1;
      while (candidate > 0 && usedPriorities.has(candidate)) candidate--;
      if (candidate > 0) return candidate.toString();
      // no free slot below it — fall through to old behavior rather than fail outright
    }
  }

  // Return the next available priority. We start at 10.
  // AWS ELB priorities can go up to 50000.
  let maxPriority = 9;
  for (const p of usedPriorities) if (p > maxPriority) maxPriority = p;
  return (maxPriority + 1).toString();
}

// getNextListenerRulePriority only gets the ordering right at the moment a
// beta rule is first created. If the host's catch-all rule (aws_lb_listener_rule.prod
// in golf-infra-terraform) is created or re-applied AFTER that — e.g. Terraform
// re-provisioning the prod host-header rule later, or a beta rule created
// before the catch-all existed yet — the beta rule can be left at a HIGHER
// priority number than the catch-all with no automatic way to notice. Since
// ALB always evaluates ascending and stops at first match, that silently
// makes the __env=beta cookie a no-op for every request, with no error
// anywhere. Call this before every beta start so ordering self-heals on
// each deploy rather than requiring a manual `aws elbv2 set-rule-priorities`.
async function ensureBetaRulePriorityBelowCatchAll(region, listenerArn, betaRuleArn, hostHeader) {
  const { elbv2 } = clients(region);
  const rules = [];
  let marker = undefined;
  do {
    const res = await elbv2.send(new DescribeRulesCommand({ ListenerArn: listenerArn, Marker: marker }));
    for (const rule of res.Rules || []) {
      if (rule.IsDefault) continue;
      const p = parseInt(rule.Priority, 10);
      if (!isNaN(p)) rules.push({ priority: p, arn: rule.RuleArn, conditions: rule.Conditions || [] });
    }
    marker = res.NextMarker;
  } while (marker);

  const betaRule = rules.find(r => r.arn === betaRuleArn);
  if (!betaRule) return { fixed: false, reason: "beta rule not found on listener" };

  const catchAll = rules.find(r => {
    const hostCond = r.conditions.find(c => c.Field === "host-header");
    const hostValues = hostCond?.HostHeaderConfig?.Values || hostCond?.Values || [];
    const hasCookieCond = r.conditions.some(c => c.Field === "http-header");
    return hostValues.includes(hostHeader) && !hasCookieCond && r.arn !== betaRuleArn;
  });
  if (!catchAll) return { fixed: false, reason: "no catch-all rule found for host" };

  if (betaRule.priority < catchAll.priority) {
    return { fixed: false, reason: "already correctly ordered", betaPriority: betaRule.priority, catchAllPriority: catchAll.priority };
  }

  // Misordered — swap them atomically. set-rule-priorities requires the
  // whole batch to end up with unique priorities, so a direct two-rule swap
  // (rather than two sequential modify calls) is the only safe way to do
  // this without a transient state where both share/collide on a priority.
  await elbv2.send(new SetRulePrioritiesCommand({
    RulePriorities: [
      { RuleArn: betaRule.arn, Priority: catchAll.priority },
      { RuleArn: catchAll.arn, Priority: betaRule.priority }
    ]
  }));

  return {
    fixed: true,
    betaPriorityBefore: betaRule.priority,
    catchAllPriorityBefore: catchAll.priority,
    betaPriorityAfter: catchAll.priority,
    catchAllPriorityAfter: betaRule.priority
  };
}

async function createBetaListenerRule(region, { listenerArn, targetGroupArn, hostHeader, priority }) {
  const { elbv2 } = clients(region);
  const res = await elbv2.send(new CreateRuleCommand({
    ListenerArn: listenerArn,
    Priority: priority || 10,
    Conditions: [
      { Field: "host-header", HostHeaderConfig: { Values: [hostHeader] } },
      { Field: "http-header", HttpHeaderConfig: { HttpHeaderName: "Cookie", Values: [`*__env=${BETA_ROUTING_OFF_VALUE}*`] } }
    ],
    Actions: [{ Type: "forward", TargetGroupArn: targetGroupArn }]
  }));
  return res.Rules[0];
}

async function deleteBetaListenerRule(region, ruleArn) {
  if (!ruleArn) return;
  const { elbv2 } = clients(region);
  try { await elbv2.send(new DeleteRuleCommand({ RuleArn: ruleArn })); } catch(e) { /* ignore if already gone */ }
}

async function deleteBetaTargetGroup(region, tgArn) {
  if (!tgArn) return;
  const { elbv2 } = clients(region);
  try { await elbv2.send(new DeleteTargetGroupCommand({ TargetGroupArn: tgArn })); } catch(e) { /* ignore if already gone */ }
}

async function getAlbListenerArn(region, albDnsOrArn) {
  const { elbv2 } = clients(region);
  // If it already looks like an ARN, just find the HTTP listener on it
  if (albDnsOrArn && albDnsOrArn.startsWith("arn:")) {
    const res = await elbv2.send(new DescribeListenersCommand({ LoadBalancerArn: albDnsOrArn }));
    const l = (res.Listeners || []).find(l => l.Port === 80) || res.Listeners?.[0];
    return l?.ListenerArn || null;
  }
  // Try describing by name (dns prefix)
  const lbRes = await elbv2.send(new DescribeLoadBalancersCommand({}));
  const lb = (lbRes.LoadBalancers || []).find(lb => lb.DNSName === albDnsOrArn || lb.LoadBalancerName === albDnsOrArn);
  if (!lb) return null;
  const lisRes = await elbv2.send(new DescribeListenersCommand({ LoadBalancerArn: lb.LoadBalancerArn }));
  const l = (lisRes.Listeners || []).find(l => l.Port === 80) || lisRes.Listeners?.[0];
  return l?.ListenerArn || null;
}
module.exports = {
  getCallerAccountId,
  ensureTerraformBackendInfra,
  createBetaTargetGroup,
  getNextListenerRulePriority,
  ensureBetaRulePriorityBelowCatchAll,
  createBetaListenerRule,
  deleteBetaListenerRule, deleteBetaTargetGroup, getAlbListenerArn,
  checkCredentials,
  getPipelineState, listPipelines, getPipelineDefinition, startPipeline, listPipelineExecutions,
  getPipelineExecution, waitForNewPipelineExecution,
  getPendingApprovals, approveAction, createPipeline, deletePipeline,
  stopPipeline, retryStage,
  listRepos, getRepo, createRepo, deleteRepo, listBranches, getBranchDetail, createBranch,
  createBuildProject, deleteBuildProject, startBuild, getLatestBuildForProject, getBuildLogs,
  listConnections,
  createEcrRepo, listEcrImages,
  createEcsCluster, registerTaskDefinition, createEcsService, describeEcsService, describeTaskDefinition,
  normalizeSubnetIds,
  deployImageToService, listRunningTasks,
  getScalingConfig, setScalingConfig, getScalingActivity,
  getBlueGreenWeights, setBlueGreenWeights,
  createDeployment, updateDeploymentGroup, getDeployment, stopDeployment, continueDeployment, listRecentDeployments,
  // Cookie-based beta routing + release helpers (kept from local)
  scaleEcsService,
  waitForServiceStable,
  startBuildFromBranch,
  getBuildById,
  getBetaListenerRule,
  updateBetaListenerRule,
  setBetaRoutingEnabled,
};
