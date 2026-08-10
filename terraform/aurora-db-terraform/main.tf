provider "aws" {
  region = var.aws_region
}

data "aws_availability_zones" "available" { state = "available" }

# ─── Networking ─────────────────────────────────────────────────────
# A small, dedicated VPC for the admin panel's database. Kept separate
# from golf-infra-terraform's per-project VPC since this database is
# shared infrastructure for the CI/CD admin tool itself, not tied to
# any single deployed project.

resource "aws_vpc" "db" {
  cidr_block           = "10.90.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "cicd-admin-db-vpc" }
}

resource "aws_internet_gateway" "db" {
  vpc_id = aws_vpc.db.id
  tags   = { Name = "cicd-admin-db-igw" }
}

resource "aws_subnet" "db_1" {
  vpc_id                  = aws_vpc.db.id
  cidr_block              = "10.90.1.0/24"
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = true
  tags                    = { Name = "cicd-admin-db-subnet-1" }
}

resource "aws_subnet" "db_2" {
  vpc_id                  = aws_vpc.db.id
  cidr_block              = "10.90.2.0/24"
  availability_zone       = data.aws_availability_zones.available.names[1]
  map_public_ip_on_launch = true
  tags                    = { Name = "cicd-admin-db-subnet-2" }
}

resource "aws_route_table" "db" {
  vpc_id = aws_vpc.db.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.db.id
  }
  tags = { Name = "cicd-admin-db-rt" }
}

resource "aws_route_table_association" "db_1" {
  subnet_id      = aws_subnet.db_1.id
  route_table_id = aws_route_table.db.id
}

resource "aws_route_table_association" "db_2" {
  subnet_id      = aws_subnet.db_2.id
  route_table_id = aws_route_table.db.id
}

resource "aws_db_subnet_group" "db" {
  name       = "cicd-admin-db-subnet-group"
  subnet_ids = [aws_subnet.db_1.id, aws_subnet.db_2.id]
  tags       = { Name = "cicd-admin-db-subnet-group" }
}

# ─── Security group ─────────────────────────────────────────────────
# Only the CIDR blocks listed in var.allowed_cidr_blocks may reach port
# 3306. This must include whatever IP node server.js connects from —
# see the note on var.allowed_cidr_blocks in variables.tf.

resource "aws_security_group" "db" {
  name        = "cicd-admin-db-sg"
  description = "Allows MySQL (3306) access to the Aurora cluster from explicitly approved CIDR blocks only"
  vpc_id      = aws_vpc.db.id

  dynamic "ingress" {
    for_each = var.allowed_cidr_blocks
    content {
      description = "MySQL access"
      from_port   = 3306
      to_port     = 3306
      protocol    = "tcp"
      cidr_blocks = [ingress.value]
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "cicd-admin-db-sg" }
}

# ─── Aurora MySQL cluster ───────────────────────────────────────────

resource "aws_rds_cluster" "this" {
  cluster_identifier      = var.cluster_identifier
  engine                  = "aurora-mysql"
  engine_version           = var.engine_version != "" ? var.engine_version : null
  database_name            = var.database_name
  master_username           = var.master_username
  master_password          = var.master_password
  db_subnet_group_name     = aws_db_subnet_group.db.name
  vpc_security_group_ids   = [aws_security_group.db.id]
  backup_retention_period  = var.backup_retention_days
  preferred_backup_window   = "03:00-04:00"
  skip_final_snapshot      = var.skip_final_snapshot
  final_snapshot_identifier = var.skip_final_snapshot ? null : "${var.cluster_identifier}-final"
  storage_encrypted        = true

  tags = { Name = var.cluster_identifier }

  lifecycle {
    ignore_changes = [engine_version] # avoid unwanted diffs/upgrades if AWS's default version shifts after creation
  }
}

resource "aws_rds_cluster_instance" "writer" {
  identifier           = "${var.cluster_identifier}-writer"
  cluster_identifier   = aws_rds_cluster.this.id
  instance_class       = var.instance_class
  engine               = aws_rds_cluster.this.engine
  engine_version       = aws_rds_cluster.this.engine_version
  publicly_accessible  = var.publicly_accessible
  db_subnet_group_name = aws_db_subnet_group.db.name

  tags = { Name = "${var.cluster_identifier}-writer" }
}
