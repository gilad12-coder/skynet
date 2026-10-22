# Production: two tasks per service, Multi-AZ RDS, two Valkey nodes with
# automatic failover, one NAT gateway per AZ.

module "env" {
  source = "../../modules/environment"

  environment = "production"
  region      = var.region
  image_tag   = var.image_tag

  services_enabled = var.services_enabled

  vpc_cidr           = "10.50.0.0/16"
  az_count           = 2
  nat_gateway_per_az = true

  frontend_domains = ["skynetml.com", "www.skynetml.com"]
  api_domain       = "api.skynetml.com"
  enable_https     = var.enable_https

  db_instance_class        = "db.t4g.medium"
  db_multi_az              = true
  db_backup_retention_days = 14
  db_deletion_protection   = true

  cache_node_count = 2

  ecr_repository_urls = local.ecr_repository_urls

  # Railway production memory (7 days, summed over 3/3/2/2 replicas):
  # backend 1.6 GB, worker 1.3 GB, litellm 1.3 GB, frontend 0.3 GB.
  services = {
    backend  = { cpu = 1024, memory = 2048, desired_count = 2 }
    worker   = { cpu = 1024, memory = 2048, desired_count = 2 }
    frontend = { cpu = 512, memory = 1024, desired_count = 2 }
    litellm  = { cpu = 512, memory = 2048, desired_count = 2 }
  }

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
