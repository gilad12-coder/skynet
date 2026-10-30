output "alb_dns_name" {
  description = "ALB DNS name. Point the site and API host names here (CNAME, or an alias at the apex)."
  value       = aws_lb.this.dns_name
}

output "alb_zone_id" {
  description = "ALB hosted zone ID (for an alias record)."
  value       = aws_lb.this.zone_id
}

output "acm_validation_records" {
  description = "DNS records that ACM needs before it issues the certificate. Create them by hand."
  value = {
    for o in aws_acm_certificate.this.domain_validation_options : o.domain_name => {
      name  = o.resource_record_name
      type  = o.resource_record_type
      value = o.resource_record_value
    }
  }
}

output "certificate_arn" {
  description = "ACM certificate ARN."
  value       = aws_acm_certificate.this.arn
}

output "cluster_name" {
  description = "ECS cluster name."
  value       = aws_ecs_cluster.this.name
}

output "db_endpoint" {
  description = "RDS endpoint (private; reach it through scripts/db-tunnel.sh)."
  value       = aws_db_instance.this.address
}

output "valkey_endpoint" {
  description = "Valkey primary endpoint (private)."
  value       = aws_elasticache_replication_group.this.primary_endpoint_address
}

output "secret_names" {
  description = "Secrets Manager secret names to fill by hand."
  value       = { for k, s in aws_secretsmanager_secret.manual : k => s.name }
}

output "alarm_topic_arn" {
  description = "SNS topic for alarms."
  value       = aws_sns_topic.alarms.arn
}

output "nat_public_ips" {
  description = "Outbound IP addresses of the tasks (for provider allow lists)."
  value       = aws_eip.nat[*].public_ip
}
