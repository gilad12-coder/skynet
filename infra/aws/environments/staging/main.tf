# Staging: one task per service, single-AZ RDS, one Valkey node, one NAT.

module "env" {
  source = "../../modules/environment"

  environment = "staging"
  region      = var.region
  image_tag   = var.image_tag

  services_enabled = var.services_enabled

  vpc_cidr           = "10.40.0.0/16"
  az_count           = 2
  nat_gateway_per_az = false

  frontend_domains = ["staging.skynetml.com"]
  api_domain       = "api-staging.skynetml.com"
  enable_https     = var.enable_https

  db_instance_class        = "db.t4g.small"
  db_multi_az              = false
  db_backup_retention_days = 3
  db_deletion_protection   = false

  cache_node_count = 1

  ecr_repository_urls = local.ecr_repository_urls

  # Railway staging memory peaks (7 days): backend 3.0 GB, worker 2.3 GB,
  # litellm 2.6 GB, frontend 0.3 GB. CPU stayed below 0.02 vCPU.
  services = {
    backend  = { cpu = 512, memory = 3072, desired_count = 1 }
    worker   = { cpu = 512, memory = 3072, desired_count = 1 }
    frontend = { cpu = 256, memory = 512, desired_count = 1 }
    litellm  = { cpu = 512, memory = 3072, desired_count = 1 }
  }

  # Staging-only name from the Railway export.
  app_secret_keys_extra    = ["PREVIEW_GRANT_CENTS"]
  worker_secret_keys_extra = ["PREVIEW_GRANT_CENTS"]

  log_retention_days = 14
  alert_email        = var.alert_email
}
