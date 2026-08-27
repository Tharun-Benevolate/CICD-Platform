variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "The CodeBuild project and ECR repository name"
  type        = string
  default     = "golf-demo-app"
}

variable "admin_api_url" {
  description = "Base URL of the CI/CD admin panel's public API (org-for-domain / is-beta-org). Injected into deployed apps as ADMIN_API_URL so beta-org changes made in the admin panel take effect without a redeploy."
  type        = string
  default     = "https://devops.benevolaite.com"
}

variable "s3_bucket_name" {
  description = "S3 bucket for pipeline artifacts"
  type        = string
  default     = "golf-demo-app-artifacts-bucket"
}

variable "github_connection_name" {
  description = "Name for the CodeStar GitHub connection (only used when create_github_connection = true)"
  type        = string
  default     = "app-github"
}

variable "create_github_connection" {
  description = <<-EOT
    Whether this apply should create a new CodeStar Connections resource.
    A CodeStar connection authorizes ONE specific GitHub identity (the
    account/org you click "Update pending connection" as) — but it can be
    reused across every repo that identity's GitHub App installation has
    access to, including other private repos in the same account/org.
    routes/terraform.js sets this to false and populates
    existing_github_connection_arn when another project already created a
    connection for the same github_owner, so we don't spin up (and require a
    manual OAuth click for) a redundant connection per project. Note: a repo
    under a DIFFERENT GitHub account/org still needs its own connection —
    the authorization is per-identity, not truly global.
  EOT
  type    = bool
  default = true
}

variable "existing_github_connection_arn" {
  description = "ARN of an already-authorized CodeStar connection to reuse (required when create_github_connection = false)"
  type        = string
  default     = ""
}

variable "build_role_name" {
  description = "Name for the CodeBuild IAM role"
  type        = string
  default     = "app-build-role"
}

variable "pipeline_role_name" {
  description = "Name for the CodePipeline IAM role"
  type        = string
  default     = "app-pipeline-role"
}

variable "ecs_execution_role_name" {
  description = "Name for the ECS task execution IAM role"
  type        = string
  default     = "app-ecs-execution-role"
}

variable "github_owner" {
  description = "GitHub account or org name where the repo lives"
  type        = string
}

variable "github_repo" {
  description = "GitHub repository name"
  type        = string
  default     = "Golf-test-app"
}

variable "github_branch" {
  description = "Branch to watch for pipeline triggers"
  type        = string
  default     = "main"
}

variable "buildspec" {
  description = "Path to the buildspec file or inline buildspec YAML"
  type        = string
  default     = "buildspec.yml"
}

variable "secret_arn" {
  description = "(Legacy) ARN of the Secrets Manager secret for this project. Use per-env vars below for new deployments."
  type        = string
  default     = ""
}

variable "secret_keys" {
  description = "(Legacy) JSON array of secret key names. Use per-env vars below for new deployments."
  type        = string
  default     = "[]"
}

# ─── Per-environment secrets (populated by syncSecretsToCodeBuild) ───────────

variable "secret_arn_dev" {
  description = "ARN of the Secrets Manager secret for the DEV environment."
  type        = string
  default     = ""
}

variable "secret_keys_dev" {
  description = "JSON array of secret key names for DEV."
  type        = string
  default     = "[]"
}

variable "secret_arn_uat" {
  description = "ARN of the Secrets Manager secret for the UAT environment."
  type        = string
  default     = ""
}

variable "secret_keys_uat" {
  description = "JSON array of secret key names for UAT."
  type        = string
  default     = "[]"
}

variable "secret_arn_prod" {
  description = "ARN of the Secrets Manager secret for the PROD environment."
  type        = string
  default     = ""
}

variable "secret_keys_prod" {
  description = "JSON array of secret key names for PROD."
  type        = string
  default     = "[]"
}
