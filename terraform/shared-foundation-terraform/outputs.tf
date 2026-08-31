output "vpc_id" {
  description = "Shared VPC ID"
  value       = aws_vpc.main.id
}

output "public_subnet_ids" {
  description = "Shared public subnet IDs"
  value       = join(",", [aws_subnet.public_1.id, aws_subnet.public_2.id])
}

output "private_subnet_ids" {
  description = "Shared private subnet IDs"
  value       = join(",", [aws_subnet.private_1.id, aws_subnet.private_2.id])
}

output "ecs_sg_id" {
  description = "Shared ECS task security group ID"
  value       = aws_security_group.ecs.id
}

output "alb_sg_id" {
  description = "Shared ALB security group ID"
  value       = aws_security_group.alb.id
}

output "efs_sg_id" {
  description = "Shared EFS security group ID — allows NFS from ECS tasks"
  value       = aws_security_group.efs.id
}

output "alb_dns_name" {
  description = "Shared ALB DNS name"
  value       = aws_lb.main.dns_name
}

output "alb_zone_id" {
  description = "Shared ALB hosted zone ID"
  value       = aws_lb.main.zone_id
}

output "alb_listener_arn" {
  description = "Shared ALB HTTP listener ARN"
  value       = aws_lb_listener.http.arn
}

output "alb_https_listener_arn" {
  description = "Shared ALB HTTPS listener ARN"
  value       = aws_lb_listener.https.arn
}

output "nat_gateway_id" {
  description = "Shared NAT Gateway ID"
  value       = aws_nat_gateway.main.id
}
