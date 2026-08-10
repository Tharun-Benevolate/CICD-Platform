terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# ------------------------------------------------------------------------------
# Default VPC
# ------------------------------------------------------------------------------
# This module now expects an existing database and stores the runtime app
# configuration in AWS Secrets Manager instead of generating a plaintext .env.

data "aws_vpc" "default" {
  default = true
}

# ------------------------------------------------------------------------------
# Runtime IAM identity for the app container
# ------------------------------------------------------------------------------
# The cicd-admin panel runs as a plain Docker container on a Lightsail
# instance, not on ECS/EC2 — so there's no instance/task role to attach
# policies to. This user IS the app's AWS identity. Its access key is written
# into the same Secrets Manager secret every other runtime setting comes
# from, so docker-entrypoint.sh picks it up automatically as an env var and
# both the AWS SDK (in aws.js) and Terraform's own AWS provider (which reads
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY by default) resolve it the same
# way. This is intentionally applied here, once, from your own machine —
# never through the panel — because the panel's own terraform runs depend on
# this identity already having permissions before it can do anything.

resource "aws_iam_user" "app_runtime" {
  name = "cicd-admin-app-runtime"
}

resource "aws_iam_access_key" "app_runtime" {
  user = aws_iam_user.app_runtime.name
}

resource "aws_iam_policy" "tf_state_backend" {
  name   = "cicd-admin-tf-state-backend"
  policy = file("${path.module}/iam-policies/1-terraform-state-backend.json")
}

resource "aws_iam_policy" "networking" {
  name   = "cicd-admin-networking-shared-foundation"
  policy = file("${path.module}/iam-policies/2-networking-shared-foundation.json")
}

resource "aws_iam_policy" "compute_pipeline" {
  name   = "cicd-admin-compute-pipeline"
  policy = file("${path.module}/iam-policies/3-compute-pipeline.json")
}

resource "aws_iam_policy" "iam_and_platform" {
  name   = "cicd-admin-iam-and-platform-services"
  policy = file("${path.module}/iam-policies/4-iam-and-platform-services.json")
}

resource "aws_iam_user_policy_attachment" "tf_state_backend" {
  user       = aws_iam_user.app_runtime.name
  policy_arn = aws_iam_policy.tf_state_backend.arn
}

resource "aws_iam_user_policy_attachment" "networking" {
  user       = aws_iam_user.app_runtime.name
  policy_arn = aws_iam_policy.networking.arn
}

resource "aws_iam_user_policy_attachment" "compute_pipeline" {
  user       = aws_iam_user.app_runtime.name
  policy_arn = aws_iam_policy.compute_pipeline.arn
}

resource "aws_iam_user_policy_attachment" "iam_and_platform" {
  user       = aws_iam_user.app_runtime.name
  policy_arn = aws_iam_policy.iam_and_platform.arn
}

locals {
  app_secrets = {
    PORT                      = "3000"
    DB_HOST                   = var.db_host
    DB_PORT                   = "3306"
    DB_USER                   = var.db_user
    DB_PASSWORD               = var.db_password
    DB_NAME                   = var.db_name
    AWS_REGION                = var.aws_region
    AWS_ACCESS_KEY_ID         = aws_iam_access_key.app_runtime.id
    AWS_SECRET_ACCESS_KEY     = aws_iam_access_key.app_runtime.secret
    GITHUB_TOKEN              = var.github_token
    JWT_SECRET                = var.jwt_secret
    CREDENTIAL_ENCRYPTION_KEY = var.credential_encryption_key
    TF_STATE_BUCKET           = "benevolate-tf-state-393886308751"
    TF_LOCK_TABLE             = "benevolate-tf-locks"
    TF_STATE_REGION           = "us-east-1"
    GOOGLE_CLIENT_ID          = "1018746602979-blog5afpgc9iv4ke0gllpam30v5fs8b7.apps.googleusercontent.com"
    SMTP_HOST                 = var.smtp_host
    SMTP_PORT                 = var.smtp_port
    SMTP_USER                 = var.smtp_user
    SMTP_PASS                 = var.smtp_pass
    SMTP_FROM                 = var.smtp_from
    SLACK_WEBHOOK_URL         = var.slack_webhook_url
    GITHUB_CLIENT_ID          = var.github_client_id
    GITHUB_CLIENT_SECRET      = var.github_client_secret
    GITHUB_CALLBACK_URL       = var.github_callback_url
  }
}

resource "aws_secretsmanager_secret" "app" {
  name                    = var.app_secrets_secret_name
  # Skip the 30-day recovery window on delete, so a future destroy + apply
  # can immediately recreate a secret with this same name instead of
  # colliding with one still sitting in AWS's pending-deletion queue.
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id     = aws_secretsmanager_secret.app.id
  secret_string = jsonencode(local.app_secrets)
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

# ------------------------------------------------------------------------------
# ECR Repository (Keep for GitHub Actions)
# ------------------------------------------------------------------------------
resource "aws_ecr_repository" "cicd_admin" {
  name                 = "cicd-admin"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }
}

# ------------------------------------------------------------------------------
# External Database Configuration (DB created/managed outside this module)
# ------------------------------------------------------------------------------
# This module expects an existing database and publishes the runtime app
# configuration to AWS Secrets Manager instead of writing a plaintext .env.

# ------------------------------------------------------------------------------
# AWS Lightsail
# ------------------------------------------------------------------------------

# (VPC Peering is already enabled account-wide via AWS CLI)

# Create an SSH Key Pair for GitHub Actions
resource "aws_lightsail_key_pair" "cicd_admin" {
  name = "cicd-admin-deploy-key"
}

resource "aws_lightsail_instance" "app" {
  name              = "cicd-admin-server"
  availability_zone = "${var.aws_region}a"
  blueprint_id      = "amazon_linux_2023"
  bundle_id         = "small_3_0" # $12 bundle (2GB RAM, 2 vCPU)
  key_pair_name     = aws_lightsail_key_pair.cicd_admin.name

  # Install docker and docker-compose on boot (Amazon Linux 2023)
  user_data = <<-EOF
    #!/bin/bash
    sudo dnf update -y
    sudo dnf install docker -y
    sudo service docker start
    sudo usermod -a -G docker ec2-user
    sudo curl -L "https://github.com/docker/compose/releases/download/v2.24.5/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    sudo chmod +x /usr/local/bin/docker-compose
  EOF
}

# Open port 3000, 80 (HTTP), and 443 (HTTPS) on the Lightsail instance
resource "aws_lightsail_instance_public_ports" "app_ports" {
  instance_name = aws_lightsail_instance.app.name

  port_info {
    protocol  = "tcp"
    from_port = 3000
    to_port   = 3000
  }

  port_info {
    protocol  = "tcp"
    from_port = 22
    to_port   = 22
  }

  port_info {
    protocol  = "tcp"
    from_port = 80
    to_port   = 80
  }

  port_info {
    protocol  = "tcp"
    from_port = 443
    to_port   = 443
  }
}

# Attach the existing 'DevOps' Static IP to the instance
resource "aws_lightsail_static_ip_attachment" "app_ip_attach" {
  static_ip_name = "DevOps"
  instance_name  = aws_lightsail_instance.app.name
}

# ------------------------------------------------------------------------------
# Outputs
# ------------------------------------------------------------------------------
output "lightsail_public_ip" {
  value = aws_lightsail_instance.app.public_ip_address
}

output "app_secrets_secret_arn" {
  description = "ARN of the Secrets Manager secret that stores the runtime app configuration"
  value       = aws_secretsmanager_secret.app.arn
}

output "ssh_private_key" {
  value     = aws_lightsail_key_pair.cicd_admin.private_key
  sensitive = true
}

output "app_runtime_iam_user" {
  description = "The IAM user whose access key is now injected into the app's runtime secrets"
  value       = aws_iam_user.app_runtime.name
}
