# Production. Sizing comes from terraform.tfvars (lean) or full.tfvars (full).

module "env" {
  source = "../../modules/environment"

  environment = "production"
  region      = var.region
  image_tag   = var.image_tag

  services_enabled = var.services_enabled

  # ALB and RDS subnet groups need subnets in two AZs, so the VPC always
  # spans two. The single-AZ choices are NAT, RDS and Valkey (tfvars).
  vpc_cidr    = "10.50.0.0/16"
  az_count    = 2
  egress_mode = var.egress_mode

  frontend_domains = ["skynetml.com", "www.skynetml.com"]
  api_domain       = "api.skynetml.com"
  enable_https     = var.enable_https

  db_instance_class        = var.db_instance_class
  db_multi_az              = var.db_multi_az
  db_backup_retention_days = 35
  db_deletion_protection   = true

  cache_node_count = var.cache_node_count

  ecr_repository_urls = local.ecr_repository_urls

  services = var.services

  # Production-only names from the Railway export.
  app_secret_keys_extra = [
    "OPENROUTER_FLOAT_ALERT_EMAIL",
    "POSTHOG_HOST",
    "POSTHOG_PROJECT_API_KEY",
  ]

  enable_waf         = false
  log_retention_days = 30
  alert_email        = var.alert_email
}
