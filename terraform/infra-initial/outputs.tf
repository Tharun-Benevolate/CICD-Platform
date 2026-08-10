output "s3_bucket_name" {
  description = "Artifact bucket name — paste into infra-deployment variables"
  value       = aws_s3_bucket.artifacts.bucket
}

output "github_connection_arn" {
  description = "CodeStar connection ARN — paste into infra-deployment variables. NOTE: if this apply created a new connection, it must be manually activated once in AWS Console (Update pending connection) before the pipeline will work. If reused from another project, it's already active."
  value       = local.github_connection_arn
}

output "build_role_arn" {
  description = "Golf_build_role ARN"
  value       = aws_iam_role.build_role.arn
}

output "pipeline_role_arn" {
  description = "Golf_pipeline_role ARN — paste into infra-deployment variables"
  value       = aws_iam_role.pipeline_role.arn
}

output "ecs_execution_role_arn" {
  description = "Golf_ecs_execution_role ARN — paste into infra-deployment variables"
  value       = aws_iam_role.ecs_execution_role.arn
}

output "codebuild_project_name" {
  description = "CodeBuild project name — paste into infra-deployment variables"
  value       = aws_codebuild_project.build.name
}

output "github_connection_status" {
  description = "Current connection status — must be AVAILABLE (not PENDING) before first pipeline run. Shows \"REUSED_EXISTING\" when this apply reused another project's already-active connection instead of creating one."
  value       = var.create_github_connection ? aws_codestarconnections_connection.github[0].connection_status : "REUSED_EXISTING"
}
