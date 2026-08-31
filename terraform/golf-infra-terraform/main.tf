provider "aws" {
  region = var.aws_region
}

data "aws_caller_identity" "current" {}

data "aws_availability_zones" "available" { state = "available" }

locals {
  placeholder_image = "public.ecr.aws/docker/library/httpd:latest"
  task_role         = var.ecs_task_role_arn != "" ? var.ecs_task_role_arn : var.ecs_execution_role_arn
  container_name    = var.ecr_repo_name
  project_prefix    = var.project_prefix != "" ? var.project_prefix : replace(var.ecs_cluster_name_non_prod, "-non-prod-cluster", "")
  aws_name_prefix   = substr(var.project_prefix != "" ? var.project_prefix : replace(var.ecs_cluster_name_non_prod, "-non-prod-cluster", ""), 0, 19)
  dev_host          = var.dns_host_prefix != "" ? "dev-${var.dns_host_prefix}.${var.domain_name}" : "dev.${var.domain_name}"
  uat_host          = var.dns_host_prefix != "" ? "uat-${var.dns_host_prefix}.${var.domain_name}" : "uat.${var.domain_name}"
  prod_host         = var.dns_host_prefix != "" ? "${var.dns_host_prefix}.${var.domain_name}" : "${var.domain_name}"
}

# ─── 1-4. VPC, NAT GATEWAY, SECURITY GROUPS, ALB ──────────────────────
# These used to be created per-project here — a hard AWS-level name
# collision on the ALB (names are unique per region/account) meant a
# second project's apply failed outright, and every project paid for
# its own duplicate NAT Gateway (~$32/mo). They now live once in
# shared-foundation-terraform, applied a single time for the whole
# platform, and are consumed here as inputs: var.vpc_id,
# var.public_subnet_ids, var.private_subnet_ids, var.alb_sg_id,
# var.ecs_sg_id, var.alb_arn, var.alb_dns_name, var.alb_zone_id,
# var.alb_listener_arn.

resource "aws_lb_target_group" "dev" {
  name = "${local.aws_name_prefix}-dev-tg"
  # Deliberately NOT var.container_port. For target_type = "ip", ECS always
  # registers each target with an explicit port override (the service's
  # load_balancer.container_port), so AWS uses that override — and defaults
  # the health check port to "traffic-port" (whatever port the target was
  # registered on) — regardless of this field. This field only matters as a
  # required schema default, is otherwise unused, and is immutable (any
  # change forces target group replacement, which fails with
  # "ResourceInUse" while a listener/rule still references it). Keep it
  # fixed so changing container_port elsewhere never touches this.
  port        = 80
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"
  deregistration_delay = 30
  health_check {
    path                = "/health"
    healthy_threshold   = 2
    unhealthy_threshold = 10
    interval            = 15
    timeout             = 5
  }
}

resource "aws_lb_target_group" "uat" {
  name = "${local.aws_name_prefix}-uat-tg"
  # See the comment on aws_lb_target_group.dev above — kept fixed on purpose.
  port        = 80
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"
  deregistration_delay = 30
  health_check {
    path                = "/health"
    healthy_threshold   = 2
    unhealthy_threshold = 10
    interval            = 15
    timeout             = 5
  }
}

# Blue (current) target group — CodeDeploy routes live traffic here by default.
# Do NOT rename to just "prod": CodeDeploy's deployment group references both
# TG names explicitly, and renaming would force a TG recreation.
resource "aws_lb_target_group" "prod_blue" {
  name = "${local.aws_name_prefix}-prod-blue-tg"
  # See the comment on aws_lb_target_group.dev above — kept fixed on purpose.
  # Doubly important here: this TG is live in prod, and this rule's listener
  # action has ignore_changes = [action] (see aws_lb_listener_rule.prod
  # below), so a forced replacement here would permanently orphan the old
  # blue TG with no way for Terraform to ever repoint the rule at a new one.
  port        = 80
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"
  deregistration_delay = 30
  health_check {
    path                = "/health"
    healthy_threshold   = 2
    unhealthy_threshold = 10
    interval            = 15
    timeout             = 5
  }
}

# NOTE: no aws_lb_listener resource here. The ALB and its port-80 HTTP
# listener are created ONCE in shared-foundation-terraform (an AWS ALB can
# only have one listener per port, so a second project creating its own
# listener on the same ALB/port would hard-fail). Every project instead
# adds host-header LISTENER RULES against that shared listener
# (var.alb_listener_arn) — including prod, which used to ride the shared
# listener's default_action but now needs its own rule since the shared
# listener's default is just a 404 fixed-response for unmatched hosts.

# Beta resources are deliberately absent from this stack. The Release page
# provisions the isolated beta service, target group, and cookie rule only
# when an administrator elects to test a release with selected clients.
# Omitting listener priorities lets AWS allocate non-conflicting priorities
# as projects are added to this shared listener.
resource "aws_lb_listener_rule" "dev" {
  listener_arn = var.alb_https_listener_arn
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.dev.arn
  }
  condition {
    host_header {
      values = [local.dev_host]
    }
  }
}

resource "aws_lb_listener_rule" "prod" {
  listener_arn = var.alb_https_listener_arn
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.prod_blue.arn
  }
  condition {
    host_header { values = [local.prod_host] }
  }
  # The dashboard's Promote/Rollback flow may repoint this at a different TG at runtime via
  # ModifyRule; don't let a routine apply revert that.
  lifecycle { ignore_changes = [action] }
}

resource "aws_lb_listener_rule" "uat" {
  listener_arn = var.alb_https_listener_arn
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.uat.arn
  }
  condition {
    host_header {
      values = [local.uat_host]
    }
  }
}

# ─── 5. ROUTE 53 ─────────────────────────────────────────────────────

data "aws_route53_zone" "main" {
  count        = var.manage_route53 ? 1 : 0
  name         = var.domain_name
  private_zone = false
}

resource "aws_route53_record" "dev" {
  count   = var.manage_route53 ? 1 : 0
  zone_id = data.aws_route53_zone.main[0].zone_id
  name    = local.dev_host
  type    = "A"
  alias {
    name                   = var.alb_dns_name
    zone_id                = var.alb_zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "uat" {
  count   = var.manage_route53 ? 1 : 0
  zone_id = data.aws_route53_zone.main[0].zone_id
  name    = local.uat_host
  type    = "A"
  alias {
    name                   = var.alb_dns_name
    zone_id                = var.alb_zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "prod" {
  count   = var.manage_route53 ? 1 : 0
  zone_id = data.aws_route53_zone.main[0].zone_id
  name    = local.prod_host
  type    = "A"
  alias {
    name                   = var.alb_dns_name
    zone_id                = var.alb_zone_id
    evaluate_target_health = true
  }
}

# ─── 5a. AUTOMATED SSL CERTIFICATES (ACM) ────────────────────────────

resource "aws_acm_certificate" "project_cert" {
  count                     = var.manage_route53 ? 1 : 0
  domain_name               = local.prod_host
  subject_alternative_names = [local.dev_host, local.uat_host]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name    = "${local.project_prefix}-cert"
    Project = local.project_prefix
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = var.manage_route53 ? {
    for dvo in aws_acm_certificate.project_cert[0].domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  } : {}

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = data.aws_route53_zone.main[0].zone_id
}

resource "aws_acm_certificate_validation" "project_cert" {
  count                   = var.manage_route53 ? 1 : 0
  certificate_arn         = aws_acm_certificate.project_cert[0].arn
  validation_record_fqdns = [for record in aws_route53_record.cert_validation : record.fqdn]
}

resource "aws_lb_listener_certificate" "project_cert" {
  count           = var.manage_route53 ? 1 : 0
  listener_arn    = var.alb_https_listener_arn
  certificate_arn = aws_acm_certificate_validation.project_cert[0].certificate_arn
}

# ─── 5b. EFS PERSISTENT STORAGE (optional, per-project) ─────────────
# When var.enable_efs = true:
#   - If var.efs_filesystem_id is empty → creates a NEW encrypted EFS filesystem
#   - If var.efs_filesystem_id is set   → attaches to an EXISTING filesystem
# Each environment (dev/uat/prod) gets its own access point with an isolated
# root directory so files don't leak between environments.
# Mount targets are created in every private subnet for Fargate network access.
# The filesystem itself survives project infra destroy (data-safe by default).

resource "aws_efs_file_system" "dev" {
  count          = var.enable_efs && var.efs_filesystem_id == "" ? 1 : 0
  creation_token = "dev-${local.project_prefix}-efs"
  encrypted      = true

  lifecycle {
    prevent_destroy = false
  }

  tags = {
    Name        = "dev-${local.project_prefix}-efs"
    Project     = local.project_prefix
    Environment = "dev"
  }
}

resource "aws_efs_file_system" "uat" {
  count          = var.enable_efs && var.efs_filesystem_id == "" ? 1 : 0
  creation_token = "uat-${local.project_prefix}-efs"
  encrypted      = true

  lifecycle {
    prevent_destroy = false
  }

  tags = {
    Name        = "uat-${local.project_prefix}-efs"
    Project     = local.project_prefix
    Environment = "uat"
  }
}

resource "aws_efs_file_system" "prod" {
  count          = var.enable_efs && var.efs_filesystem_id == "" ? 1 : 0
  creation_token = "prod-${local.project_prefix}-efs"
  encrypted      = true

  lifecycle {
    prevent_destroy = false
  }

  tags = {
    Name        = "prod-${local.project_prefix}-efs"
    Project     = local.project_prefix
    Environment = "prod"
  }
}

locals {
  efs_id_dev  = var.enable_efs ? (var.efs_filesystem_id != "" ? var.efs_filesystem_id : aws_efs_file_system.dev[0].id)  : ""
  efs_id_uat  = var.enable_efs ? (var.efs_filesystem_id != "" ? var.efs_filesystem_id : aws_efs_file_system.uat[0].id)  : ""
  efs_id_prod = var.enable_efs ? (var.efs_filesystem_id != "" ? var.efs_filesystem_id : aws_efs_file_system.prod[0].id) : ""
}

# Per-environment access points — each connects to its dedicated environment filesystem
resource "aws_efs_access_point" "dev" {
  count          = var.enable_efs ? 1 : 0
  file_system_id = local.efs_id_dev

  posix_user {
    gid = 1000
    uid = 1000
  }

  root_directory {
    path = "/${local.project_prefix}/dev"
    creation_info {
      owner_gid   = 1000
      owner_uid   = 1000
      permissions = "755"
    }
  }

  tags = { Name = "${local.project_prefix}-dev-ap" }
}

resource "aws_efs_access_point" "uat" {
  count          = var.enable_efs ? 1 : 0
  file_system_id = local.efs_id_uat

  posix_user {
    gid = 1000
    uid = 1000
  }

  root_directory {
    path = "/${local.project_prefix}/uat"
    creation_info {
      owner_gid   = 1000
      owner_uid   = 1000
      permissions = "755"
    }
  }

  tags = { Name = "${local.project_prefix}-uat-ap" }
}

resource "aws_efs_access_point" "prod" {
  count          = var.enable_efs ? 1 : 0
  file_system_id = local.efs_id_prod

  posix_user {
    gid = 1000
    uid = 1000
  }

  root_directory {
    path = "/${local.project_prefix}/prod"
    creation_info {
      owner_gid   = 1000
      owner_uid   = 1000
      permissions = "755"
    }
  }

  tags = { Name = "${local.project_prefix}-prod-ap" }
}

# Mount targets — created for each environment's filesystem across private subnets
resource "aws_efs_mount_target" "dev_private" {
  count           = var.enable_efs && var.efs_filesystem_id == "" ? length(split(",", var.private_subnet_ids)) : 0
  file_system_id  = local.efs_id_dev
  subnet_id       = split(",", var.private_subnet_ids)[count.index]
  security_groups = [var.efs_sg_id]
}

resource "aws_efs_mount_target" "uat_private" {
  count           = var.enable_efs && var.efs_filesystem_id == "" ? length(split(",", var.private_subnet_ids)) : 0
  file_system_id  = local.efs_id_uat
  subnet_id       = split(",", var.private_subnet_ids)[count.index]
  security_groups = [var.efs_sg_id]
}

resource "aws_efs_mount_target" "prod_private" {
  count           = var.enable_efs && var.efs_filesystem_id == "" ? length(split(",", var.private_subnet_ids)) : 0
  file_system_id  = local.efs_id_prod
  subnet_id       = split(",", var.private_subnet_ids)[count.index]
  security_groups = [var.efs_sg_id]
}

# ─── 6. ECR + ECS CLUSTER + LOGS ────────────────────────────────────

resource "aws_ecr_repository" "app" {
  name                 = var.ecr_repo_name
  image_tag_mutability = "MUTABLE"
  force_delete         = true
}

resource "aws_ecs_cluster" "non_prod" { name = var.ecs_cluster_name_non_prod }
resource "aws_ecs_cluster" "prod" { name = var.ecs_cluster_name_prod }

resource "aws_cloudwatch_log_group" "dev" {
  name              = "/ecs/${var.ecs_cluster_name_non_prod}-dev"
  retention_in_days = 7
}
resource "aws_cloudwatch_log_group" "uat" {
  name              = "/ecs/${var.ecs_cluster_name_non_prod}-uat"
  retention_in_days = 7
}
resource "aws_cloudwatch_log_group" "prod" {
  name              = "/ecs/${var.ecs_cluster_name_prod}-prod"
  retention_in_days = 7
}

# ─── 7. TASK DEFINITIONS ─────────────────────────────────────────────

resource "aws_ecs_task_definition" "dev" {
  family                   = "${var.ecs_cluster_name_non_prod}-dev"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = var.ecs_execution_role_arn
  task_role_arn            = local.task_role

  dynamic "volume" {
    for_each = var.enable_efs ? [1] : []
    content {
      name = "efs-storage"
      efs_volume_configuration {
        file_system_id     = local.efs_id_dev
        transit_encryption = "ENABLED"
        authorization_config {
          access_point_id = aws_efs_access_point.dev[0].id
          iam             = "ENABLED"
        }
      }
    }
  }

  container_definitions = jsonencode([{
    name      = local.container_name
    image     = local.placeholder_image
    essential = true
    portMappings = [{
      containerPort = var.container_port
      protocol      = "tcp"
    }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.dev.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "dev"
      }
    }
    # Per-env secrets: use secret_arn_dev if set, fall back to legacy secret_arn.
    # Keys are stored as JSON strings and decoded here so the type is consistent
    # whether the value came from a tfvars file or a CodeBuild env var.
    secrets = (var.secret_arn_dev != "" ? var.secret_arn_dev : var.secret_arn) != "" ? [
      for key in (
        length(jsondecode(var.secret_keys_dev)) > 0
          ? jsondecode(var.secret_keys_dev)
          : jsondecode(var.secret_keys)
      ) : {
        name      = key
        valueFrom = "${var.secret_arn_dev != "" ? var.secret_arn_dev : var.secret_arn}:${key}::"
      }
    ] : []
    mountPoints = var.enable_efs ? [{
      sourceVolume  = "efs-storage"
      containerPath = var.efs_mount_path
      readOnly      = false
    }] : []
  }])

  # CodePipeline's plain "ECS" deploy action registers a new task-def
  # revision directly (outside Terraform) whenever it deploys the real app
  # image. Without this, any unrelated `terraform apply` that touches
  # container_definitions (e.g. changing container_port) forces Terraform to
  # register its own new revision using local.placeholder_image, silently
  # rolling the dev service back to the httpd placeholder. Ignoring changes
  # here lets the pipeline's deployed image/task-def stick.
  lifecycle {
    # Terraform only bootstraps this task def once (placeholder image + secrets).
    # CodePipeline owns all subsequent revisions — ignoring here prevents any
    # unrelated `terraform apply` from reverting the live service back to httpd.
    ignore_changes = [container_definitions]
  }
}

resource "aws_ecs_task_definition" "uat" {
  family                   = "${var.ecs_cluster_name_non_prod}-uat"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = var.ecs_execution_role_arn
  task_role_arn            = local.task_role

  dynamic "volume" {
    for_each = var.enable_efs ? [1] : []
    content {
      name = "efs-storage"
      efs_volume_configuration {
        file_system_id     = local.efs_id_uat
        transit_encryption = "ENABLED"
        authorization_config {
          access_point_id = aws_efs_access_point.uat[0].id
          iam             = "ENABLED"
        }
      }
    }
  }

  container_definitions = jsonencode([{
    name      = local.container_name
    image     = local.placeholder_image
    essential = true
    portMappings = [{
      containerPort = var.container_port
      protocol      = "tcp"
    }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.uat.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "uat"
      }
    }
    # Per-env secrets: use secret_arn_uat if set, fall back to legacy secret_arn
    secrets = (var.secret_arn_uat != "" ? var.secret_arn_uat : var.secret_arn) != "" ? [
      for key in (
        length(jsondecode(var.secret_keys_uat)) > 0
          ? jsondecode(var.secret_keys_uat)
          : jsondecode(var.secret_keys)
      ) : {
        name      = key
        valueFrom = "${var.secret_arn_uat != "" ? var.secret_arn_uat : var.secret_arn}:${key}::"
      }
    ] : []
    mountPoints = var.enable_efs ? [{
      sourceVolume  = "efs-storage"
      containerPath = var.efs_mount_path
      readOnly      = false
    }] : []
  }])

  # Same reasoning as the dev task definition above: prevent Terraform from
  # reverting the pipeline-deployed image/task-def back to the placeholder
  # on unrelated applies.
  lifecycle {
    # Same reasoning as dev: Terraform bootstraps once, CodePipeline owns the
    # live revision. Ignoring changes here keeps UAT stable across unrelated applies.
    ignore_changes = [container_definitions]
  }
}

resource "aws_ecs_task_definition" "prod" {
  family                   = "${var.ecs_cluster_name_prod}-prod"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = var.ecs_execution_role_arn
  task_role_arn            = local.task_role

  dynamic "volume" {
    for_each = var.enable_efs ? [1] : []
    content {
      name = "efs-storage"
      efs_volume_configuration {
        file_system_id     = local.efs_id_prod
        transit_encryption = "ENABLED"
        authorization_config {
          access_point_id = aws_efs_access_point.prod[0].id
          iam             = "ENABLED"
        }
      }
    }
  }

  container_definitions = jsonencode([{
    name      = local.container_name
    image     = local.placeholder_image
    essential = true
    portMappings = [{
      containerPort = var.container_port
      protocol      = "tcp"
    }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.prod.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "prod"
      }
    }
    # Per-env secrets: use secret_arn_prod if set, fall back to legacy secret_arn
    secrets = (var.secret_arn_prod != "" ? var.secret_arn_prod : var.secret_arn) != "" ? [
      for key in (
        length(jsondecode(var.secret_keys_prod)) > 0
          ? jsondecode(var.secret_keys_prod)
          : jsondecode(var.secret_keys)
      ) : {
        name      = key
        valueFrom = "${var.secret_arn_prod != "" ? var.secret_arn_prod : var.secret_arn}:${key}::"
      }
    ] : []
    mountPoints = var.enable_efs ? [{
      sourceVolume  = "efs-storage"
      containerPath = var.efs_mount_path
      readOnly      = false
    }] : []
  }])

  # CRITICAL: unlike dev/uat, prod's live task revision is entirely owned by
  # CodeDeploy — it registers a brand-new real-image revision on every
  # deployment via appspec.yaml/taskdef.json, independent of this resource.
  # This resource is ONLY a one-time bootstrap stub (placeholder image) so
  # the service has something to launch before the first real deploy.
  #
  # Without this guard, any unrelated change here (e.g. container_port)
  # makes Terraform destroy/recreate this resource, which DEREGISTERS
  # whatever specific revision was previously active in this family. Even
  # though aws_ecs_service.prod already ignores task_definition/load_balancer
  # changes, ECS still falls back to the newest ACTIVE revision in the
  # family when replacing an unhealthy task — which, post-deregistration,
  # becomes this placeholder. That silently swapped live prod traffic from
  # the real Node app back to Apache httpd. Ignoring changes here for good
  # closes that gap permanently.
  lifecycle {
    ignore_changes = [container_definitions]
  }
}

# ─── 8. ECS SERVICES (private subnets, wired to ALB) ─────────────────

resource "aws_ecs_service" "dev" {
  name    = var.dev_service_name
  cluster = aws_ecs_cluster.non_prod.id
  # Use the family name, not .arn — ECS resolves this to whatever revision
  # is currently ACTIVE in the family (the pipeline's real-image revision),
  # instead of Terraform's own frozen placeholder revision ARN. See the
  # ignore_changes note below for why this matters.
  task_definition = aws_ecs_task_definition.dev.family
  desired_count   = 1
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = split(",", var.private_subnet_ids)
    security_groups  = [var.ecs_sg_id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.dev.arn
    container_name   = local.container_name
    container_port   = var.container_port
  }

  # CRITICAL: CodePipeline's Deploy-Dev stage updates this service's live
  # task_definition directly (outside Terraform) on every pipeline run.
  # Without this guard, ANY terraform apply — even ones unrelated to dev —
  # forcibly resets task_definition back to aws_ecs_task_definition.dev.arn,
  # which is Terraform's own frozen placeholder (httpd) revision. That
  # silently reverts live dev traffic from the real app back to the
  # placeholder, only surfacing once ECS next needs to launch a replacement
  # task. Ignoring changes here stops Terraform from ever touching it again.
  lifecycle {
    ignore_changes = [task_definition]
  }
}

resource "aws_ecs_service" "uat" {
  name    = var.uat_service_name
  cluster = aws_ecs_cluster.non_prod.id
  # Same reasoning as aws_ecs_service.dev above.
  task_definition = aws_ecs_task_definition.uat.family
  desired_count   = 1
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = split(",", var.private_subnet_ids)
    security_groups  = [var.ecs_sg_id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.uat.arn
    container_name   = local.container_name
    container_port   = var.container_port
  }

  # Same reasoning as aws_ecs_service.dev above.
  lifecycle {
    ignore_changes = [task_definition]
  }
}

resource "aws_ecs_service" "prod" {
  name            = var.prod_service_name
  cluster         = aws_ecs_cluster.prod.id
  task_definition = aws_ecs_task_definition.prod.family
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = split(",", var.private_subnet_ids)
    security_groups  = [var.ecs_sg_id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.prod_blue.arn
    container_name   = local.container_name
    container_port   = var.container_port
  }

  # task_definition is updated by the dashboard Promote action (UpdateService API).
  # Ignoring here prevents Terraform from reverting the promoted image on
  # unrelated applies.
  lifecycle {
    ignore_changes = [task_definition]
  }
}

# ─── 9. AUTO SCALING — UAT & PROD ONLY ───────────────────────────────
# Dev stays at desired_count = 1 (no scaling needed for dev)

# UAT Auto Scaling
resource "aws_appautoscaling_target" "uat" {
  max_capacity       = 4
  min_capacity       = 1
  resource_id        = "service/${aws_ecs_cluster.non_prod.name}/${aws_ecs_service.uat.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "uat_cpu" {
  name               = "${var.ecs_cluster_name_non_prod}-uat-cpu-scaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.uat.resource_id
  scalable_dimension = aws_appautoscaling_target.uat.scalable_dimension
  service_namespace  = aws_appautoscaling_target.uat.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = 65.0
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}

# Prod Auto Scaling
resource "aws_appautoscaling_target" "prod" {
  max_capacity       = 4
  min_capacity       = 1
  resource_id        = "service/${aws_ecs_cluster.prod.name}/${aws_ecs_service.prod.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "prod_cpu" {
  name               = "${var.ecs_cluster_name_prod}-prod-cpu-scaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.prod.resource_id
  scalable_dimension = aws_appautoscaling_target.prod.scalable_dimension
  service_namespace  = aws_appautoscaling_target.prod.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = 65.0
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}

# No separate autoscaling for prod_beta — it runs at 0 or 1 task only.
# CPU scaling does not apply to a beta slot.

# ─── 9. FULL 7-STAGE CODEPIPELINE ────────────────────────────────────

resource "aws_codepipeline" "main" {
  name     = "${var.ecs_cluster_name_prod}-pipeline"
  role_arn = var.pipeline_role_arn

  artifact_store {
    location = var.s3_bucket_name
    type     = "S3"
  }

  # Stage 1: Source
  stage {
    name = "Source"
    action {
      name             = "Source"
      category         = "Source"
      owner            = "AWS"
      provider         = "CodeStarSourceConnection"
      version          = "1"
      output_artifacts = ["source_output"]
      configuration = {
        ConnectionArn    = var.github_connection_arn
        FullRepositoryId = "${var.github_owner}/${var.github_repo}"
        BranchName       = var.github_branch
      }
    }
  }

  # Stage 2: Build
  stage {
    name = "Build"
    action {
      name             = "Build"
      category         = "Build"
      owner            = "AWS"
      provider         = "CodeBuild"
      version          = "1"
      input_artifacts  = ["source_output"]
      output_artifacts = ["build_output"]
      configuration = {
        ProjectName = var.codebuild_project_name
      }
    }
  }

  # Stage 3: Deploy to Dev (automatic)
  stage {
    name = "Deploy-Dev"
    action {
      name            = "Deploy-Dev"
      category        = "Deploy"
      owner           = "AWS"
      provider        = "ECS"
      version         = "1"
      input_artifacts = ["build_output"]
      configuration = {
        ClusterName = var.ecs_cluster_name_non_prod
        ServiceName = var.dev_service_name
        # The buildspec registers a task def with secrets, then writes this file.
        # The ECS deploy action updates the service image only; secrets are
        # already in the registered task def.
        FileName    = "imagedefinitions-dev.json"
      }
    }
  }

  # Stage 4: Approve UAT (manual with required comment)
  stage {
    name = "Approve-UAT"
    action {
      name     = "Approve-UAT"
      category = "Approval"
      owner    = "AWS"
      provider = "Manual"
      version  = "1"
      configuration = {
        CustomData = "QA verified on Dev? Add your test confirmation comment before approving UAT."
      }
    }
  }

  # Stage 5: Deploy to UAT
  stage {
    name = "Deploy-UAT"
    action {
      name            = "Deploy-UAT"
      category        = "Deploy"
      owner           = "AWS"
      provider        = "ECS"
      version         = "1"
      input_artifacts = ["build_output"]
      configuration = {
        ClusterName = var.ecs_cluster_name_non_prod
        ServiceName = var.uat_service_name
        FileName    = "imagedefinitions-uat.json"
      }
    }
  }

  # Stage 6: Approve Prod (final sign-off)
  stage {
    name = "Approve-Prod"
    action {
      name     = "Approve-Prod"
      category = "Approval"
      owner    = "AWS"
      provider = "Manual"
      version  = "1"
      configuration = {
        CustomData = "UAT sign-off complete? This will deploy to production."
      }
    }
  }

  # Stage 7: Deploy to live prod (blue).
  stage {
    name = "Deploy-Prod"
    action {
      name            = "Deploy-Prod"
      category        = "Deploy"
      owner           = "AWS"
      provider        = "ECS"
      version         = "1"
      input_artifacts = ["build_output"]
      configuration = {
        ClusterName = var.ecs_cluster_name_prod
        ServiceName = var.prod_service_name
        FileName    = "imagedefinitions-prod.json"
      }
    }
  }

  depends_on = [aws_ecs_service.dev, aws_ecs_service.uat, aws_ecs_service.prod]
}
