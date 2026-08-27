provider "aws" {
  region = var.aws_region
}

data "aws_caller_identity" "current" {}

locals {
  # Either the connection this apply creates, or one reused from an earlier
  # project under the same GitHub owner (see variables.tf for why).
  github_connection_arn = var.create_github_connection ? aws_codestarconnections_connection.github[0].arn : var.existing_github_connection_arn
}

# ─── 1. S3 ARTIFACTS BUCKET ─────────────────────────────────────────

resource "aws_s3_bucket" "artifacts" {
  bucket        = var.s3_bucket_name
  force_destroy = true
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ─── 2. CODESTAR GITHUB CONNECTION ──────────────────────────────────
# IMPORTANT: After terraform apply, go to:
# AWS Console > CodePipeline > Settings > Connections
# Click "Update pending connection" to complete the GitHub OAuth handshake.
# This one-time click is required by AWS and cannot be automated.

resource "aws_codestarconnections_connection" "github" {
  count         = var.create_github_connection ? 1 : 0
  name          = var.github_connection_name
  provider_type = "GitHub"
}

# ─── 3. IAM ROLE: Golf_build_role ───────────────────────────────────

resource "aws_iam_role" "build_role" {
  name = var.build_role_name
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "codebuild.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "build_s3_access" {
  name = "AllowBuildRoleS3Access"
  role = aws_iam_role.build_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["s3:GetObject", "s3:GetObjectVersion", "s3:GetBucketVersioning", "s3:PutObjectAcl", "s3:PutObject"]
      Resource = [aws_s3_bucket.artifacts.arn, "${aws_s3_bucket.artifacts.arn}/*"]
    }]
  })
}

resource "aws_iam_role_policy" "build_ecr_auth" {
  name = "AllowECRAuthToken"
  role = aws_iam_role.build_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" }]
  })
}

resource "aws_iam_role_policy" "build_base_policy" {
  name = "CodeBuildBasePolicy-${var.build_role_name}-${var.aws_region}"
  role = aws_iam_role.build_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = [
          "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/codebuild/${var.project_name}",
          "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/codebuild/${var.project_name}:*"
        ]
      },
      {
        Effect = "Allow"
        Action = ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion", "s3:GetBucketAcl", "s3:GetBucketLocation"]
        Resource = "arn:aws:s3:::codepipeline-${var.aws_region}-*"
      },
      {
        Effect = "Allow"
        Action = ["codebuild:CreateReportGroup", "codebuild:CreateReport", "codebuild:UpdateReport", "codebuild:BatchPutTestCases", "codebuild:BatchPutCodeCoverages"]
        Resource = "arn:aws:codebuild:${var.aws_region}:${data.aws_caller_identity.current.account_id}:report-group/${var.project_name}-*"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "build_ecr_power" {
  role       = aws_iam_role.build_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryPowerUser"
}

resource "aws_iam_role_policy_attachment" "build_codebuild_admin" {
  role       = aws_iam_role.build_role.name
  policy_arn = "arn:aws:iam::aws:policy/AWSCodeBuildAdminAccess"
}

resource "aws_iam_role_policy_attachment" "build_cloudwatch" {
  role       = aws_iam_role.build_role.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchLogsFullAccess"
}

# Allow the CodeBuild role to register ECS task definitions (with secrets)
# so the buildspec can create a proper task def revision per environment.
resource "aws_iam_role_policy" "build_ecs_taskdef" {
  name = "AllowBuildRoleECSTaskDef"
  role = aws_iam_role.build_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ecs:RegisterTaskDefinition",
          "ecs:DescribeTaskDefinition",
          "ecs:DescribeServices",
          "ecs:UpdateService"
        ]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = "*"
        Condition = {
          StringLike = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" }
        }
      }
    ]
  })
}

# ─── 4. IAM ROLE: Golf_ecs_execution_role ───────────────────────────

resource "aws_iam_role" "ecs_execution_role" {
  name = var.ecs_execution_role_name
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "ecs_execution_log_group_create" {
  # AmazonECSTaskExecutionRolePolicy (attached below) grants CreateLogStream
  # + PutLogEvents but NOT CreateLogGroup — it assumes the log group already
  # exists. golf-infra-terraform pre-creates the dev/uat/prod log groups, so
  # this gap is invisible there, but any environment relying on the task
  # definition's "awslogs-create-group": "true" (e.g. Beta) fails at task
  # start with logs:CreateLogGroup AccessDeniedException without this.
  name = "${var.ecs_execution_role_name}-log-group-create"
  role = aws_iam_role.ecs_execution_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/ecs/*"
      },
      {
        # Allow ECS tasks to read ANY secret in this account/region so that
        # per-env secrets (e.g. {prefix}/dev-secrets, {prefix}/uat-secrets,
        # {prefix}/prod-secrets) are all accessible regardless of naming pattern.
        # Access is still bounded by the task execution role attached to each task.
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:*"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_execution_policy" {
  role       = aws_iam_role.ecs_execution_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# ─── 5. IAM ROLE: Golf_pipeline_role ────────────────────────────────

resource "aws_iam_role" "pipeline_role" {
  name = var.pipeline_role_name
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "codepipeline.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "pipeline_github" {
  name = "AddGithubConnection"
  role = aws_iam_role.pipeline_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["codestar-connections:UseConnection", "codeconnections:UseConnection"]
      Resource = "*"
    }]
  })
}

resource "aws_iam_role_policy" "pipeline_ecs" {
  name = "AllowPipelineECSDeployment"
  role = aws_iam_role.pipeline_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ecs:CreateTaskSet", "ecs:DeleteTaskSet", "ecs:DescribeTaskSets",
          "ecs:UpdateServicePrimaryTaskSet", "ecs:DescribeServices",
          "ecs:UpdateService", "ecs:RegisterTaskDefinition", "ecs:DescribeTaskDefinition"
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "codedeploy:CreateDeployment", "codedeploy:GetDeployment",
          "codedeploy:GetDeploymentConfig", "codedeploy:GetApplicationRevision",
          "codedeploy:RegisterApplicationRevision", "codedeploy:GetApplication"
        ]
        Resource = "*"
      },
      { Effect = "Allow", Action = ["iam:PassRole"], Resource = "*" }
    ]
  })
}

resource "aws_iam_role_policy" "pipeline_s3" {
  name = "AllowPipelineS3Artifacts"
  role = aws_iam_role.pipeline_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["s3:GetObject", "s3:GetObjectVersion", "s3:GetBucketVersioning", "s3:PutObjectAcl", "s3:PutObject"]
      Resource = [aws_s3_bucket.artifacts.arn, "${aws_s3_bucket.artifacts.arn}/*"]
    }]
  })
}

resource "aws_iam_role_policy" "pipeline_codebuild" {
  name = "AllowPipelineToStartBuilds"
  role = aws_iam_role.pipeline_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["codebuild:StartBuild", "codebuild:BatchGetBuilds", "codebuild:StopBuild"]
      Resource = "arn:aws:codebuild:${var.aws_region}:${data.aws_caller_identity.current.account_id}:project/${var.project_name}"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "pipeline_full_access" {
  role       = aws_iam_role.pipeline_role.name
  policy_arn = "arn:aws:iam::aws:policy/AWSCodePipeline_FullAccess"
}

# ─── 6. CODEBUILD PROJECT ───────────────────────────────────────────

resource "aws_codebuild_project" "build" {
  name         = var.project_name
  service_role = aws_iam_role.build_role.arn

  artifacts { type = "CODEPIPELINE" }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:7.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"
    privileged_mode             = true

    environment_variable {
      name  = "AWS_ACCOUNT_ID"
      value = data.aws_caller_identity.current.account_id
    }
    environment_variable {
      name  = "AWS_DEFAULT_REGION"
      value = var.aws_region
    }
    environment_variable {
      name  = "ECR_REPO_URI"
      value = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com/${var.project_name}"
    }
    environment_variable {
      # Was hardcoded to "golf-demo-app" — every other project's build would
      # have pushed imagedefinitions.json referencing the wrong container.
      # var.project_name IS the per-project prefix (see utils/projectNaming.js),
      # and golf-infra-terraform's ecr_repo_name/container name is that same
      # prefix, so this now always matches the project actually being built.
      name  = "CONTAINER_NAME"
      value = var.project_name
    }
    environment_variable {
      name  = "CONTAINER_PORT"
      # The real app listens on 3000. Must match container_port in golf-infra-terraform.
      value = "3000"
    }
    environment_variable {
      name  = "EXECUTION_ROLE_ARN"
      value = aws_iam_role.ecs_execution_role.arn
    }
    environment_variable {
      name  = "TASK_ROLE_ARN"
      value = aws_iam_role.ecs_execution_role.arn
    }
    environment_variable {
      # Was hardcoded to "golf-demo-cluster". golf-infra-terraform always
      # names the cluster "${project_prefix}-cluster" (var.ecs_cluster_name
      # there comes from names.ecsClusterName = `${prefix}-cluster` in
      # routes/terraform.js), and project_name here IS that same prefix.
      name  = "ECS_CLUSTER_NAME"
      value = "${var.project_name}-cluster"
    }
    environment_variable {
      name  = "AWS_REGION"
      value = var.aws_region
    }
    environment_variable {
      # Consumed by buildspec.yml when rendering taskdef.json, so the prod
      # blue/green deploy (which fully regenerates the task definition on
      # every release, bypassing Terraform) still carries this through.
      # Without it, the deployed app never calls the admin panel and silently
      # runs on its static fallback org list forever.
      name  = "ADMIN_API_URL"
      value = var.admin_api_url
    }
    environment_variable {
      # Secrets Manager secret ARN — injected by the platform when project
      # secrets are saved. Used by the buildspec to generate taskdef.json
      # with Secrets Manager references so pipeline deploys carry secrets.
      name  = "SECRET_ARN"
      value = var.secret_arn
    }
    environment_variable {
      # JSON array of secret key names — injected by the platform alongside
      # SECRET_ARN. The buildspec parses this to build the ECS secrets array.
      name  = "SECRET_KEYS"
      value = var.secret_keys
    }
    environment_variable {
      # Was hardcoded to "/ecs/golf-demo-cluster-prod" — must match the
      # aws_cloudwatch_log_group.prod name in golf-infra-terraform, which is
      # "/ecs/${ecs_cluster_name}-prod".
      name  = "LOG_GROUP_NAME"
      value = "/ecs/${var.project_name}-cluster-prod"
    }
    environment_variable {
      # Non-prod cluster name (dev + uat services run here).
      # golf-infra-terraform names this: ${project_prefix}-non-prod-cluster
      name  = "ECS_CLUSTER_NAME_NON_PROD"
      value = "${var.project_name}-non-prod-cluster"
    }
    environment_variable {
      # Prod cluster name (prod service runs here).
      # golf-infra-terraform names this: ${project_prefix}-prod-cluster
      name  = "ECS_CLUSTER_NAME_PROD"
      value = "${var.project_name}-prod-cluster"
    }
    # Per-environment Secrets Manager ARNs and key lists.
    # Populated by the platform (syncSecretsToCodeBuild) when project secrets
    # are saved or updated in the UI. The buildspec reads these to register
    # task def revisions with proper Secrets Manager references per env.
    environment_variable {
      name  = "SECRET_ARN_DEV"
      value = var.secret_arn_dev
    }
    environment_variable {
      name  = "SECRET_KEYS_DEV"
      value = var.secret_keys_dev
    }
    environment_variable {
      name  = "SECRET_ARN_UAT"
      value = var.secret_arn_uat
    }
    environment_variable {
      name  = "SECRET_KEYS_UAT"
      value = var.secret_keys_uat
    }
    environment_variable {
      name  = "SECRET_ARN_PROD"
      value = var.secret_arn_prod
    }
    environment_variable {
      name  = "SECRET_KEYS_PROD"
      value = var.secret_keys_prod
    }
    # ECS service names per env — used by register_taskdefs.py in the buildspec
    # to locate the correct service when injecting secrets into task definitions.
    environment_variable {
      name  = "DEV_SERVICE_NAME"
      value = "${var.project_name}-dev"
    }
    environment_variable {
      name  = "UAT_SERVICE_NAME"
      value = "${var.project_name}-uat"
    }
    environment_variable {
      name  = "PROD_SERVICE_NAME"
      value = "${var.project_name}-prod"
    }
  }

  source {
    type      = "CODEPIPELINE"
    buildspec = var.buildspec
  }

  logs_config {
    cloudwatch_logs {
      group_name  = "/aws/codebuild/${var.project_name}"
      stream_name = var.project_name
    }
  }

  # Prevent Terraform from clobbering env vars dynamically added by the
  # admin platform (SECRET_ARN_*, SECRET_KEYS_*, etc.) on re-apply.
  # The platform manages those via syncSecretsToCodeBuild independently.
  lifecycle {
    ignore_changes = [environment]
  }

  depends_on = [
    aws_iam_role_policy.build_s3_access,
    aws_iam_role_policy.build_ecr_auth,
    aws_iam_role_policy.build_base_policy,
    aws_iam_role_policy_attachment.build_ecr_power,
    aws_iam_role_policy_attachment.build_codebuild_admin
  ]
}
