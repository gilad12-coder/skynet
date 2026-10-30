# Basic alarms. All go to one SNS topic per environment.

# CloudWatch and RDS cannot publish to a topic under the AWS managed SNS key
# (its policy cannot grant them the key), so the topic uses its own key.
resource "aws_kms_key" "alarms" {
  description             = "${local.name} alarm topic"
  deletion_window_in_days = 7
  enable_key_rotation     = true

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AccountAdmin"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${local.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid    = "AlarmPublishers"
        Effect = "Allow"
        Principal = {
          Service = ["cloudwatch.amazonaws.com", "events.rds.amazonaws.com"]
        }
        Action   = ["kms:Decrypt", "kms:GenerateDataKey*"]
        Resource = "*"
      },
    ]
  })
}

resource "aws_kms_alias" "alarms" {
  name          = "alias/${local.name}-alarms"
  target_key_id = aws_kms_key.alarms.key_id
}

resource "aws_sns_topic" "alarms" {
  name              = "${local.name}-alarms"
  kms_master_key_id = aws_kms_key.alarms.arn
}

resource "aws_sns_topic_subscription" "email" {
  count = var.alert_email == "" ? 0 : 1

  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

locals {
  alarm_actions = [aws_sns_topic.alarms.arn]
  alb_suffix    = aws_lb.this.arn_suffix

  target_groups = {
    backend  = aws_lb_target_group.backend.arn_suffix
    frontend = aws_lb_target_group.frontend.arn_suffix
  }
}

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  for_each = local.target_groups

  alarm_name          = "${local.name}-${each.key}-5xx"
  alarm_description   = "${each.key} returns 5xx responses."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 20
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  dimensions = {
    LoadBalancer = local.alb_suffix
    TargetGroup  = each.value
  }
}

resource "aws_cloudwatch_metric_alarm" "unhealthy_hosts" {
  for_each = local.target_groups

  alarm_name          = "${local.name}-${each.key}-unhealthy"
  alarm_description   = "${each.key} has fewer healthy targets than tasks for 3 minutes."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  dimensions = {
    LoadBalancer = local.alb_suffix
    TargetGroup  = each.value
  }
}

resource "aws_cloudwatch_metric_alarm" "backend_latency" {
  alarm_name          = "${local.name}-backend-p95-latency"
  alarm_description   = "Backend p95 response time is above 5 s. Streaming agent turns are long by design; tune if noisy."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  extended_statistic  = "p95"
  period              = 300
  evaluation_periods  = 3
  threshold           = 5
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions

  dimensions = {
    LoadBalancer = local.alb_suffix
    TargetGroup  = local.target_groups.backend
  }
}

resource "aws_cloudwatch_metric_alarm" "service_cpu" {
  for_each = aws_ecs_service.this

  alarm_name          = "${local.name}-${each.key}-cpu"
  alarm_description   = "${each.key} average CPU is above 85 % for 15 minutes."
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 85
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions

  dimensions = {
    ClusterName = aws_ecs_cluster.this.name
    ServiceName = aws_ecs_service.this[each.key].name
  }
}

resource "aws_cloudwatch_metric_alarm" "service_memory" {
  for_each = aws_ecs_service.this

  alarm_name          = "${local.name}-${each.key}-memory"
  alarm_description   = "${each.key} average memory is above 85 % for 15 minutes."
  namespace           = "AWS/ECS"
  metric_name         = "MemoryUtilization"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 85
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions

  dimensions = {
    ClusterName = aws_ecs_cluster.this.name
    ServiceName = aws_ecs_service.this[each.key].name
  }
}

# Fires when a service runs fewer tasks than desired, or none at all (crash
# loop, failed start, image pull failure, scale to 0). "running - desired"
# alone misses a scale to 0: desired falls too. The floor of 1 catches it.
# Container Insights (enabled) sends no data while a service has no tasks.
# FILL turns each missing minute into a breaching point: treat_missing_data
# alone keeps using older real points while the look-back range has enough
# of them, which delays the alarm. Desired is the live ECS value, not the
# tfvars count: the service ignores desired_count changes after create.
# Deploys keep running at or above desired (minimum healthy percent 100).
# 3 of 5 one-minute points: ALARM about 3 to 5 minutes after the outage.
resource "aws_cloudwatch_metric_alarm" "service_running" {
  for_each = { for k, v in aws_ecs_service.this : k => v if var.services[k].desired_count > 0 }

  alarm_name          = "${local.name}-${each.key}-tasks-missing"
  alarm_description   = "${each.key} ran fewer tasks than desired, or none, in 3 of the last 5 minutes."
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  threshold           = 0
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  metric_query {
    id          = "gap"
    expression  = "FILL(MIN([running - desired, running - 1]), -1)"
    label       = "running minus max(desired, 1)"
    return_data = true
  }

  metric_query {
    id = "running"
    metric {
      namespace   = "ECS/ContainerInsights"
      metric_name = "RunningTaskCount"
      period      = 60
      stat        = "Minimum"
      dimensions = {
        ClusterName = aws_ecs_cluster.this.name
        ServiceName = each.value.name
      }
    }
  }

  metric_query {
    id = "desired"
    metric {
      namespace   = "ECS/ContainerInsights"
      metric_name = "DesiredTaskCount"
      period      = 60
      stat        = "Maximum"
      dimensions = {
        ClusterName = aws_ecs_cluster.this.name
        ServiceName = each.value.name
      }
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "${local.name}-rds-cpu"
  alarm_description   = "RDS CPU is above 80 % for 15 minutes."
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = local.alarm_actions
  dimensions          = { DBInstanceIdentifier = aws_db_instance.this.identifier }
}

resource "aws_cloudwatch_metric_alarm" "rds_storage" {
  alarm_name          = "${local.name}-rds-free-storage"
  alarm_description   = "RDS free storage is below 5 GB."
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5 * 1024 * 1024 * 1024
  comparison_operator = "LessThanThreshold"
  alarm_actions       = local.alarm_actions
  dimensions          = { DBInstanceIdentifier = aws_db_instance.this.identifier }
}

resource "aws_cloudwatch_metric_alarm" "rds_memory" {
  alarm_name          = "${local.name}-rds-freeable-memory"
  alarm_description   = "RDS freeable memory is below 100 MB."
  namespace           = "AWS/RDS"
  metric_name         = "FreeableMemory"
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 3
  threshold           = 100 * 1024 * 1024
  comparison_operator = "LessThanThreshold"
  alarm_actions       = local.alarm_actions
  dimensions          = { DBInstanceIdentifier = aws_db_instance.this.identifier }
}

resource "aws_cloudwatch_metric_alarm" "rds_connections" {
  alarm_name          = "${local.name}-rds-connections"
  alarm_description   = "RDS has more than 300 connections."
  namespace           = "AWS/RDS"
  metric_name         = "DatabaseConnections"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 300
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = local.alarm_actions
  dimensions          = { DBInstanceIdentifier = aws_db_instance.this.identifier }
}

resource "aws_cloudwatch_metric_alarm" "valkey_memory" {
  alarm_name          = "${local.name}-valkey-memory"
  alarm_description   = "Valkey memory use is above 80 %."
  namespace           = "AWS/ElastiCache"
  metric_name         = "DatabaseMemoryUsagePercentage"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = local.alarm_actions
  dimensions          = { ReplicationGroupId = aws_elasticache_replication_group.this.id }
}

resource "aws_cloudwatch_metric_alarm" "valkey_cpu" {
  alarm_name          = "${local.name}-valkey-cpu"
  alarm_description   = "Valkey engine CPU is above 80 %."
  namespace           = "AWS/ElastiCache"
  metric_name         = "EngineCPUUtilization"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = local.alarm_actions
  dimensions          = { ReplicationGroupId = aws_elasticache_replication_group.this.id }
}

# Error lines in service logs (LOG_FORMAT=json writes "level": "ERROR").
resource "aws_cloudwatch_log_metric_filter" "errors" {
  for_each = toset(["backend", "worker"])

  name           = "${local.name}-${each.key}-errors"
  log_group_name = aws_cloudwatch_log_group.service[each.key].name
  pattern        = "{ $.level = \"ERROR\" || $.level = \"CRITICAL\" }"

  metric_transformation {
    name          = "${each.key}-error-lines"
    namespace     = "Skynet/${var.environment}"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "log_errors" {
  for_each = aws_cloudwatch_log_metric_filter.errors

  alarm_name          = "${local.name}-${each.key}-error-logs"
  alarm_description   = "${each.key} wrote more than 50 error lines in 5 minutes."
  namespace           = "Skynet/${var.environment}"
  metric_name         = each.value.metric_transformation[0].name
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 50
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}

# ---------------------------------------------------------------- backups
# RDS sends no "backup failed" event, so the check is freshness: every
# automated backup ends with RDS-EVENT-0002, and no such event for 30 hours
# (backups run daily at 08:00 UTC) raises the alarm.
resource "aws_db_event_subscription" "rds_failure" {
  name             = "${local.name}-rds-failure"
  sns_topic        = aws_sns_topic.alarms.arn
  source_type      = "db-instance"
  source_ids       = [aws_db_instance.this.identifier]
  event_categories = ["failure"]
}

resource "aws_cloudwatch_event_rule" "rds_backup_done" {
  name        = "${local.name}-rds-backup-done"
  description = "Automated RDS backup finished."

  event_pattern = jsonencode({
    source        = ["aws.rds"]
    "detail-type" = ["RDS DB Instance Event"]
    detail = {
      EventID          = ["RDS-EVENT-0002"]
      SourceIdentifier = [aws_db_instance.this.identifier]
    }
  })
}

# The log keeps a record of each backup. The alarm reads the rule's own
# MatchedEvents metric, so it does not depend on log delivery.
resource "aws_cloudwatch_log_group" "rds_backups" {
  name              = "/aws/events/${local.name}-rds-backups"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_resource_policy" "rds_backups" {
  policy_name = "${local.name}-rds-backups"

  policy_document = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = ["events.amazonaws.com", "delivery.logs.amazonaws.com"] }
      Action    = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource  = "${aws_cloudwatch_log_group.rds_backups.arn}:*"
      Condition = {
        ArnEquals = { "aws:SourceArn" = aws_cloudwatch_event_rule.rds_backup_done.arn }
      }
    }]
  })
}

resource "aws_cloudwatch_event_target" "rds_backup_done" {
  rule = aws_cloudwatch_event_rule.rds_backup_done.name
  arn  = aws_cloudwatch_log_group.rds_backups.arn
}

resource "aws_cloudwatch_metric_alarm" "rds_backup_missing" {
  alarm_name          = "${local.name}-rds-backup-missing"
  alarm_description   = "No automated RDS backup finished in 30 hours. Check RDS events and the automated backups of ${aws_db_instance.this.identifier}."
  namespace           = "AWS/Events"
  metric_name         = "MatchedEvents"
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 30
  datapoints_to_alarm = 30
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
  dimensions          = { RuleName = aws_cloudwatch_event_rule.rds_backup_done.name }

  # A new rule has no data yet. Without a warm-up the alarm fires right after
  # create; with it, evaluation starts at the first backup (or after 2 days).
  warm_up_configuration {
    warm_up_period_duration_in_minutes = 2880
  }
}
