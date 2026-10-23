# RDS PostgreSQL and ElastiCache Valkey for Infisical. Both sit in the
# isolated subnets (no route to the internet) and accept only the Infisical
# task security group.
#
# Single-AZ RDS: Multi-AZ doubles the instance cost (about +$13 per month)
# and protects only against an AZ outage. The apps do not call Infisical at
# run time (they read Secrets Manager), so an Infisical outage blocks only
# secret edits. Data safety comes from 14-day automated backups
# (point-in-time restore), a final snapshot, deletion protection and
# prevent_destroy.

resource "aws_db_subnet_group" "this" {
  name       = local.name
  subnet_ids = aws_subnet.isolated[*].id
}

resource "aws_db_parameter_group" "this" {
  name_prefix = "${local.name}-pg17-"
  family      = "postgres17"

  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_db_instance" "this" {
  #checkov:skip=CKV_AWS_157:Single-AZ by cost choice; see the file header.
  #checkov:skip=CKV_AWS_118:Enhanced monitoring costs more than its value for one small internal instance; CloudWatch basic metrics stay on.
  #checkov:skip=CKV_AWS_226:Minor upgrades go through a reviewed change of engine_version.
  #checkov:skip=CKV_AWS_161:Infisical connects with a password from Secrets Manager; IAM auth tokens are not supported by Infisical.
  #checkov:skip=CKV_AWS_353:Performance Insights is not needed for one small internal instance.
  identifier     = local.name
  engine         = "postgres"
  engine_version = "17.6"
  instance_class = "db.t4g.micro"

  db_name  = "infisical"
  username = "infisical"
  # Write-only: sent to RDS only when the version changes; never in state.
  password_wo         = ephemeral.random_bytes.db_password.hex
  password_wo_version = var.datastore_credentials_version

  allocated_storage     = 20
  max_allocated_storage = 50
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.this.arn

  multi_az               = false
  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.this["postgres"].id]
  parameter_group_name   = aws_db_parameter_group.this.name
  publicly_accessible    = false

  backup_retention_period   = 14
  backup_window             = "08:00-08:30"
  maintenance_window        = "sun:09:00-sun:10:00"
  copy_tags_to_snapshot     = true
  delete_automated_backups  = false
  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.name}-final"

  auto_minor_version_upgrade      = false
  allow_major_version_upgrade     = false
  apply_immediately               = false
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_elasticache_subnet_group" "this" {
  name       = local.name
  subnet_ids = aws_subnet.isolated[*].id
}

# Infisical keeps only queues and caches in Redis; losing it loses no secret.
resource "aws_elasticache_replication_group" "this" {
  #checkov:skip=CKV2_AWS_50:One node; the cache holds no durable data.
  #checkov:skip=CKV_AWS_31:TLS is on and the AUTH token is set through auth_token_wo, which checkov does not read.
  replication_group_id = local.name
  description          = "Skynet Infisical queues and cache"

  engine               = "valkey"
  engine_version       = "8.1"
  node_type            = "cache.t4g.micro"
  num_cache_clusters   = 1
  parameter_group_name = "default.valkey8"
  port                 = 6379

  subnet_group_name  = aws_elasticache_subnet_group.this.name
  security_group_ids = [aws_security_group.this["valkey"].id]

  automatic_failover_enabled = false
  multi_az_enabled           = false

  at_rest_encryption_enabled = true
  kms_key_id                 = aws_kms_key.this.arn
  transit_encryption_enabled = true
  # Write-only: never in state. SET replaces the token in one step.
  auth_token_wo              = ephemeral.random_bytes.valkey_token.hex
  auth_token_wo_version      = var.datastore_credentials_version
  auth_token_update_strategy = "SET"
  snapshot_retention_limit   = 1
  snapshot_window            = "07:00-08:00"
  maintenance_window         = "sun:10:00-sun:11:00"
  auto_minor_version_upgrade = true
  apply_immediately          = true
}
