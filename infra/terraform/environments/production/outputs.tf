output "alb_dns_name" {
  description = "ALB DNS name."
  value       = module.env.alb_dns_name
}

output "alb_zone_id" {
  description = "ALB hosted zone ID."
  value       = module.env.alb_zone_id
}

output "acm_validation_records" {
  description = "DNS records to create by hand for ACM validation."
  value       = module.env.acm_validation_records
}

output "cluster_name" {
  description = "ECS cluster name."
  value       = module.env.cluster_name
}

output "db_endpoint" {
  description = "RDS endpoint (private)."
  value       = module.env.db_endpoint
}

output "secret_names" {
  description = "Secrets to fill by hand."
  value       = module.env.secret_names
}

output "nat_public_ips" {
  description = "Outbound IP addresses of the tasks."
  value       = module.env.nat_public_ips
}
