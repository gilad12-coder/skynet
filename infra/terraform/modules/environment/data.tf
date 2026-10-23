# One RDS PostgreSQL instance per environment holds two databases:
#   skynet  - the app database (pgvector), owned by the skynet_app role
#   litellm - the LiteLLM proxy database, owned by the litellm role
# The master user is for the dbadmin task only (role setup, restores).
# One instance is cheaper than two (about $25-95 per month saved per
# environment) and still keeps the data apart: separate databases and roles.
# scripts/create-db-roles.sh creates the app and litellm roles and the
# litellm database, because Terraform cannot reach the isolated subnets.
#
# No RDS Proxy / PgBouncer: at 2-4 app tasks with a 20+20 SQLAlchemy pool the
# connection count stays far below max_connections, and direct connections
# keep advisory locks and FOR UPDATE SKIP LOCKED semantics unchanged.

resource "random_password" "db_master" {
  length  = 40
  special = false
}

resource "random_password" "db_app" {
  length  = 40
  special = false
}

resource "random_password" "db_litellm" {
  length  = 40
  special = false
}

resource "random_password" "valkey_auth" {
  length  = 64
  special = false
}

resource "aws_db_subnet_group" "this" {
  name       = local.name
  subnet_ids = aws_subnet.isolated[*].id
}

resource "aws_db_parameter_group" "this" {
  name_prefix = "${local.name}-pg18-"
  family      = "postgres18"

  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }

  parameter {
    name  = "log_lock_waits"
    value = "1"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_iam_role" "rds_monitoring" {
  name = "${local.name}-rds-monitoring"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "monitoring.rds.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  role       = aws_iam_role.rds_monitoring.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

resource "aws_db_instance" "this" {
  identifier     = local.name
  engine         = "postgres"
  engine_version = var.postgres_engine_version
  instance_class = var.db_instance_class

  db_name  = "skynet"
  username = "skynet"
  password = random_password.db_master.result

  allocated_storage     = var.db_allocated_storage_gb
  max_allocated_storage = var.db_max_allocated_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true

  multi_az               = var.db_multi_az
  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.this["postgres"].id]
  parameter_group_name   = aws_db_parameter_group.this.name
  publicly_accessible    = false

  backup_retention_period  = var.db_backup_retention_days
  backup_window            = "08:00-08:30"
  maintenance_window       = "sun:09:00-sun:10:00"
  copy_tags_to_snapshot    = true
  delete_automated_backups = var.environment != "production"
  deletion_protection      = var.db_deletion_protection
  skip_final_snapshot      = var.environment != "production"
  final_snapshot_identifier = (
    var.environment == "production" ? "${local.name}-final" : null
  )

  # Minor upgrades go through postgres_engine_version, so Terraform state
  # never disagrees with the running version.
  auto_minor_version_upgrade          = false
  allow_major_version_upgrade         = false
  apply_immediately                   = var.environment != "production"
  iam_database_authentication_enabled = true

  performance_insights_enabled          = true
  performance_insights_retention_period = 7
  monitoring_interval                   = 60
  monitoring_role_arn                   = aws_iam_role.rds_monitoring.arn
  enabled_cloudwatch_logs_exports       = ["postgresql", "upgrade"]
}

# ---------------------------------------------------------------- Valkey

resource "aws_elasticache_subnet_group" "this" {
  name       = local.name
  subnet_ids = aws_subnet.isolated[*].id
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id = local.name
  description          = "Skynet ${var.environment} shared Redis-compatible cache (app + litellm)"

  engine               = "valkey"
  engine_version       = var.valkey_engine_version
  node_type            = var.cache_node_type
  num_cache_clusters   = var.cache_node_count
  parameter_group_name = "default.valkey8"
  port                 = 6379

  subnet_group_name  = aws_elasticache_subnet_group.this.name
  security_group_ids = [aws_security_group.this["valkey"].id]

  automatic_failover_enabled = var.cache_node_count > 1
  multi_az_enabled           = var.cache_node_count > 1

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = random_password.valkey_auth.result

  snapshot_retention_limit   = var.environment == "production" ? 3 : 0
  snapshot_window            = "07:00-08:00"
  maintenance_window         = "sun:10:00-sun:11:00"
  auto_minor_version_upgrade = true
  apply_immediately          = var.environment != "production"
}
