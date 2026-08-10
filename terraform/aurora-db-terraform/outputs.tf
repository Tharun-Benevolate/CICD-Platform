output "cluster_endpoint" {
  description = "Writer endpoint — use this as DB_HOST in .env"
  value       = aws_rds_cluster.this.endpoint
}

output "reader_endpoint" {
  description = "Read-only endpoint, if you later add read replicas"
  value       = aws_rds_cluster.this.reader_endpoint
}

output "port" {
  description = "Port — use this as DB_PORT in .env"
  value       = aws_rds_cluster.this.port
}

output "database_name" {
  description = "Database name — use this as DB_NAME in .env"
  value       = aws_rds_cluster.this.database_name
}

output "master_username" {
  description = "Master username — use this as DB_USER in .env"
  value       = aws_rds_cluster.this.master_username
}

output "security_group_id" {
  description = "Security group controlling inbound access to the cluster"
  value       = aws_security_group.db.id
}

output "env_snippet" {
  description = "Paste this directly into your .env file (password is not included — copy it from your tfvars)"
  value = <<-EOT
    DB_HOST=${aws_rds_cluster.this.endpoint}
    DB_PORT=${aws_rds_cluster.this.port}
    DB_USER=${aws_rds_cluster.this.master_username}
    DB_NAME=${aws_rds_cluster.this.database_name}
  EOT
}
