output "cluster" {
  description = "ECS cluster of Infisical."
  value       = aws_ecs_cluster.this.name
}

output "site_url" {
  description = "Infisical address through scripts/infisical-tunnel.sh."
  value       = local.site_url
}

output "task_role_arn" {
  description = "Role that Infisical runs as. It is the principal of the AWS app connection (assume-role)."
  value       = aws_iam_role.task.arn
}

output "secret_sync_role_arn" {
  description = "Role for the Infisical AWS app connection (empty until infisical_project_id is set)."
  value       = one(aws_iam_role.sync[*].arn)
}

output "bootstrap_secret" {
  description = "Secrets Manager name of ENCRYPTION_KEY and AUTH_SECRET (name only)."
  value       = aws_secretsmanager_secret.bootstrap.name
}

output "alarm_topic_arn" {
  description = "SNS topic for secret-change alarms."
  value       = aws_sns_topic.alarms.arn
}
