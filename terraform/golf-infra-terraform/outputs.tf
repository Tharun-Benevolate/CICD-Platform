output "ecr_repository_url" {
  description = "ECR repo URL — used by CodeBuild to push images"
  value       = aws_ecr_repository.app.repository_url
}

output "ecs_cluster_name_non_prod" {
  value = aws_ecs_cluster.non_prod.name
}

output "ecs_cluster_name_prod" {
  value = aws_ecs_cluster.prod.name
}

output "dev_service_name" { value = aws_ecs_service.dev.name }
output "uat_service_name" { value = aws_ecs_service.uat.name }
output "prod_service_name" { value = aws_ecs_service.prod.name }

output "prod_blue_target_group_arn" { value = aws_lb_target_group.prod_blue.arn }
output "prod_listener_rule_arn" { value = aws_lb_listener_rule.prod.arn }

output "ecs_security_group_id" {
  description = "Security group ID for ECS tasks — passthrough of the shared-foundation SG this project was given"
  value       = var.ecs_sg_id
}

output "private_subnet_ids" {
  description = "Private subnet IDs where ECS tasks run — passthrough of the shared-foundation subnets this project was given"
  value       = var.private_subnet_ids
}

output "alb_dns_name" {
  description = "Shared ALB public DNS — use this to test before DNS propagates"
  value       = var.alb_dns_name
}

output "dev_url" { value = "http://${local.dev_host}" }
output "uat_url" { value = "http://${local.uat_host}" }
output "prod_url" { value = "http://${local.prod_host}" }

output "pipeline_name" {
  value = aws_codepipeline.main.name
}

output "cost_estimate_monthly" {
  description = "Approximate incremental monthly cost of THIS project — the ALB and NAT Gateway are shared platform-wide (see shared-foundation-terraform) and billed once regardless of project count, not per project."
  value       = "No dedicated always-on compute added by this stack — ECR/ECS/CodePipeline/CodeBuild are pay-per-use. Shared ALB (~$17/mo) + shared NAT Gateway (~$32/mo + data) are amortized across every project from shared-foundation-terraform."
}

# Needed by the platform for on-demand beta provisioning
output "vpc_id" { value = var.vpc_id }
output "alb_listener_arn" { value = var.alb_listener_arn }
