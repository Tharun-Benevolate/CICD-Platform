variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "cluster_identifier" {
  description = "Name of the Aurora cluster"
  type        = string
  default     = "cicd-admin-db"
}

variable "database_name" {
  description = "Initial database name created inside the cluster (matches DB_NAME in .env / schema.sql)"
  type        = string
  default     = "cicd_admin"
}

variable "master_username" {
  description = "Master username for the Aurora cluster"
  type        = string
  default     = "admin"
}

variable "master_password" {
  description = "Master password for the Aurora cluster. Do not hardcode — pass via TF_VAR_master_password env var or a .tfvars file that is gitignored."
  type        = string
  sensitive   = true
}

variable "instance_class" {
  description = "Instance class for the Aurora writer instance. db.t4g.medium is a reasonable low-cost default for an admin panel's database; scale up if needed."
  type        = string
  default     = "db.t4g.medium"
}

variable "engine_version" {
  description = <<-EOT
    Aurora MySQL engine version. Leave as "" (default) to let AWS use its
    current default version for aurora-mysql — recommended, since specific
    version strings vary by region/account and change over time. Only set
    this if you need to pin a specific version; check what's available
    first with:
      aws rds describe-db-engine-versions --engine aurora-mysql \
        --query "DBEngineVersions[].EngineVersion" --output table
  EOT
  type    = string
  default = ""
}

variable "allowed_cidr_blocks" {
  description = <<-EOT
    CIDR blocks allowed to reach the database on port 3306.
    Add your laptop's public IP as "<ip>/32" (run `curl ifconfig.me` to find it)
    for wherever `node server.js` runs. Do NOT default this to 0.0.0.0/0.
  EOT
  type    = list(string)
  default = []
}

variable "publicly_accessible" {
  description = <<-EOT
    Whether the Aurora instance gets a public endpoint. Needed if node
    server.js runs on a laptop outside AWS (the setup described in the
    project's server setup docs). Set to false and add the app's VPC/
    security group to allowed_cidr_blocks instead if the app will run
    inside AWS (e.g. on the same ECS cluster as the deployed pipelines).
  EOT
  type    = bool
  default = true
}

variable "skip_final_snapshot" {
  description = "Skip the final snapshot on destroy. Convenient for dev/test; set false for anything holding real data you can't afford to lose."
  type    = bool
  default = true
}

variable "backup_retention_days" {
  description = "Number of days to retain automated backups"
  type        = number
  default     = 7
}
