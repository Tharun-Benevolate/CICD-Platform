variable "aws_region" {
  description = "The AWS region to deploy into"
  type        = string
  default     = "us-east-1"
}

variable "image_uri" {
  description = "The ECR image URI for the cicd-admin app (e.g. 123456789012.dkr.ecr.us-east-1.amazonaws.com/cicd-admin:latest)"
  type        = string
  default     = "nginx:latest" # Placeholder, update before apply or rely on pipeline to deploy real image
}

variable "app_secrets_secret_name" {
  description = "AWS Secrets Manager secret name that stores the runtime app configuration"
  type        = string
  default     = "cicd-admin/app-secrets-v2"
}

variable "db_host" {
  description = "Database Host"
  type        = string
  sensitive   = true
}

variable "db_name" {
  description = "Database Name"
  type        = string
  sensitive   = true
}

variable "db_user" {
  description = "Database User"
  type        = string
  sensitive   = true
}

variable "db_password" {
  description = "Database Password"
  type        = string
  sensitive   = true
}

variable "github_token" {
  description = "GitHub Personal Access Token"
  type        = string
  sensitive   = true
}

variable "jwt_secret" {
  description = "JWT Secret for Authentication"
  type        = string
  sensitive   = true
}

variable "credential_encryption_key" {
  description = "Encryption Key for Git Credentials"
  type        = string
  sensitive   = true
}

# --- Optional Integrations ---

variable "smtp_host" {
  type    = string
  default = ""
}

variable "smtp_port" {
  type    = string
  default = ""
}

variable "smtp_user" {
  type    = string
  default = ""
}

variable "smtp_pass" {
  type      = string
  default   = ""
  sensitive = true
}

variable "smtp_from" {
  type    = string
  default = ""
}

variable "slack_webhook_url" {
  type      = string
  default   = ""
  sensitive = true
}

variable "github_client_id" {
  type    = string
  default = ""
}

variable "github_client_secret" {
  type      = string
  default   = ""
  sensitive = true
}

variable "github_callback_url" {
  type    = string
  default = ""
}
