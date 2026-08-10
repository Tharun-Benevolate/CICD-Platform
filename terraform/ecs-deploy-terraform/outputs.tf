# ecs-deploy-terraform/outputs.tf

output "github_secrets_instructions" {
  description = "Exact values to copy and paste into GitHub Repository Secrets"
  value       = <<EOF
=========================================================
  GITHUB REPOSITORY SECRETS FOR DEPLOY.YML
=========================================================
Create the following secrets in GitHub -> Settings -> Secrets and variables -> Actions:

ECR_REPOSITORY     = ${aws_ecr_repository.cicd_admin.name}
LIGHTSAIL_HOST     = your Lightsail public IP or DNS name
APP_SECRETS_SECRET_ARN = ${aws_secretsmanager_secret.app.arn}
LIGHTSAIL_SSH_KEY  = (Paste the contents of cicd-admin-deploy-key.pem generated after apply)
DB_HOST            = your Aurora or existing DB host
DB_NAME            = your database name
DB_USER            = your database user
DB_PASSWORD        = your database password
GITHUB_TOKEN_ADMIN = your GitHub token for repo automation
JWT_SECRET         = your JWT signing secret
CREDENTIAL_ENCRYPTION_KEY = your credential encryption key

Optional secrets used only if configured:
SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
SLACK_WEBHOOK_URL
GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_CALLBACK_URL

(You will also need to add AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY manually if not already present)
=========================================================
EOF
}

output "app_url_instructions" {
  description = "How to access the new Lightsail deployment"
  value       = <<EOF
The application is deployed on an AWS Lightsail instance.
To access your app, open your browser and go to:
http://44.218.156.113:3000

Runtime secrets are stored in AWS Secrets Manager as:
${aws_secretsmanager_secret.app.arn}
EOF
}
