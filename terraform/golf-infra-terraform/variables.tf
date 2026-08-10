variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "domain_name" {
  description = "Route53 hosted zone domain"
  type        = string
  default     = "benevolaite.com"
}

variable "ecs_cluster_name" {
  type    = string
  default = "golf-demo-cluster"
}

variable "ecr_repo_name" {
  type    = string
  default = "golf-demo-app"
}

variable "dev_service_name" {
  type    = string
  default = "golf-demo-dev"
}

variable "uat_service_name" {
  type    = string
  default = "golf-demo-uat"
}

variable "prod_service_name" {
  type    = string
  default = "golf-demo-prod"
}

variable "container_port" {
  # The real app (Golf-test-app) is a Node.js server: Dockerfile sets
  # ENV PORT=3000, EXPOSE 3000, and its HEALTHCHECK hits
  # http://localhost:3000/health. The earlier switch to 80 was based on
  # CloudWatch logs from the Terraform-managed placeholder image
  # (public.ecr.aws/docker/library/httpd:latest) used to bootstrap the dev/uat
  # task definitions before the pipeline's first real deploy — not from the
  # actual app. Reverted to 3000, the app's real listening port.
  type    = number
  default = 3000
}


# ── Passed from infra-initial outputs ──────────────────────────────
variable "ecs_execution_role_arn" {
  description = "Golf_ecs_execution_role ARN (output of infra-initial)"
  type        = string
}

variable "ecs_task_role_arn" {
  description = "ECS task role ARN — leave blank to reuse execution role"
  type        = string
  default     = ""
}

variable "pipeline_role_arn" {
  description = "Golf_pipeline_role ARN (output of infra-initial)"
  type        = string
}

variable "s3_bucket_name" {
  description = "Artifact S3 bucket name (output of infra-initial)"
  type        = string
  default     = "golf-demo-app-artifacts-bucket"
}

variable "github_connection_arn" {
  description = "CodeStar connection ARN (output of infra-initial)"
  type        = string
}

variable "github_owner" {
  description = "GitHub account or org name"
  type        = string
}

variable "github_repo" {
  description = "GitHub repository name"
  type        = string
  default     = "Golf-test-app"
}

variable "github_branch" {
  description = "Branch to trigger pipeline on"
  type        = string
  default     = "main"
}

variable "codebuild_project_name" {
  description = "CodeBuild project name (output of infra-initial)"
  type        = string
  default     = "golf-demo-app"
}

variable "dns_host_prefix" {
  description = "Optional per-project DNS prefix — dev becomes dev-<prefix>.domain when set; empty keeps dev.domain for backward compatibility"
  type        = string
  default     = ""
}

variable "project_prefix" {
  description = "Sanitized repo name used to prefix all per-project resources (cluster, services, TGs, pipeline, CodeBuild). Defaults to dns_host_prefix when empty. Example: 'golf-demo' produces golf-demo-cluster, golf-demo-dev-svc, etc."
  type        = string
  default     = ""
}

variable "vpc_id" {
  description = "VPC ID of the shared VPC (output of shared-foundation-terraform)"
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs where ECS tasks run, comma-separated (output of shared-foundation-terraform). A real list(string) type doesn't work here — the panel's tfvars writer always emits quoted strings, so this stays a delimited string and gets split() below, matching the rest of this codebase's convention."
  type        = string
}

variable "ecs_sg_id" {
  description = "Security group ID for ECS tasks (output of shared-foundation-terraform)"
  type        = string
}

variable "alb_dns_name" {
  description = "Shared ALB DNS name, used for Route53 alias records (output of shared-foundation-terraform)"
  type        = string
}

variable "alb_zone_id" {
  description = "Shared ALB hosted zone ID, used for Route53 alias records (output of shared-foundation-terraform)"
  type        = string
}

variable "alb_listener_arn" {
  description = "ARN of the shared ALB's HTTP listener (output of shared-foundation-terraform). Every project attaches its own host-header listener rules to this one shared listener."
  type        = string
}

variable "manage_route53" {
  description = "Whether to create Route53 DNS alias records for the domain"
  type        = bool
  default     = false
}

