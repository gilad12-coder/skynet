variable "environment" {
  description = "Environment name: staging or production."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "region" {
  description = "AWS Region."
  type        = string

  # The AWS account (new "project" experience) may create Regional resources
  # only in us-east-2.
  validation {
    condition     = var.region == "us-east-2"
    error_message = "This AWS account allows Regional resources only in us-east-2."
  }
}

# ---------------------------------------------------------------- network

variable "vpc_cidr" {
  description = "CIDR block of the VPC. Use a different block per environment."
  type        = string
}

variable "az_count" {
  description = "Number of Availability Zones to use (2 or 3)."
  type        = number
  default     = 3

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "az_count must be 2 or 3."
  }
}

variable "nat_gateway_per_az" {
  description = "One NAT gateway per AZ (true) or one shared NAT gateway (false)."
  type        = bool
}

variable "flow_log_retention_days" {
  description = "Retention of the VPC flow log group."
  type        = number
  default     = 30
}

# ---------------------------------------------------------------- domains

variable "frontend_domains" {
  description = "Host names served by the frontend. The first one is the canonical site URL."
  type        = list(string)
}

variable "api_domain" {
  description = "Host name served by the backend API."
  type        = string
}

variable "enable_https" {
  description = <<-EOT
    Create the HTTPS listener. Keep false on the first apply: the ACM
    certificate stays PENDING_VALIDATION until the DNS validation records
    (output acm_validation_records) exist. Set true after ACM shows ISSUED.
  EOT
  type        = bool
  default     = false
}

variable "alb_idle_timeout" {
  description = "ALB idle timeout in seconds. Agent turns stream SSE keepalives every 15 s; responses end within 600 s."
  type        = number
  default     = 120
}

variable "enable_waf" {
  description = "Attach AWS WAF (managed rule groups and a rate rule) to the ALB."
  type        = bool
  default     = false
}

variable "waf_rate_limit_per_5m" {
  description = "Requests per 5 minutes per client IP before WAF blocks."
  type        = number
  default     = 3000
}

# ---------------------------------------------------------------- database

variable "postgres_engine_version" {
  description = "RDS PostgreSQL engine version. 18.6 is the newest RDS 18.x (2026-10) and matches Railway's 18.6. Raise it to upgrade the minor version."
  type        = string
  default     = "18.6"
}

variable "db_instance_class" {
  description = "RDS instance class (Graviton)."
  type        = string
}

variable "db_allocated_storage_gb" {
  description = "Initial gp3 storage in GB."
  type        = number
  default     = 20
}

variable "db_max_allocated_storage_gb" {
  description = "Storage autoscaling ceiling in GB."
  type        = number
  default     = 100
}

variable "db_multi_az" {
  description = "Run RDS as Multi-AZ (standby in a second AZ)."
  type        = bool
}

variable "db_backup_retention_days" {
  description = "Automated backup and point-in-time recovery window in days."
  type        = number
}

variable "db_deletion_protection" {
  description = "Block deletion of the RDS instance."
  type        = bool
}

# ---------------------------------------------------------------- cache

variable "valkey_engine_version" {
  description = "ElastiCache Valkey engine version."
  type        = string
  default     = "8.1"
}

variable "cache_node_type" {
  description = "ElastiCache node type."
  type        = string
  default     = "cache.t4g.micro"
}

variable "cache_node_count" {
  description = "Number of cache nodes (1 = no replica; 2+ = automatic failover across AZs)."
  type        = number
}

# ---------------------------------------------------------------- services

variable "image_tag" {
  description = <<-EOT
    Image tag (git SHA) that Terraform writes into the task definitions it
    creates. scripts/deploy.sh registers newer revisions; the ECS services
    ignore Terraform's revision after they exist. Pass the SHA that runs now
    on every apply, so a Terraform revision never points at an older image.
  EOT
  type        = string
}

variable "services_enabled" {
  description = <<-EOT
    Create the ECS services. Keep false on the first apply: the tasks cannot
    start before the secrets are filled, the litellm database exists and the
    migration has run. Set true for the second apply.
  EOT
  type        = bool
  default     = false
}

variable "ecr_repository_urls" {
  description = "ECR repository URL per image (backend, frontend, litellm), from the global stack."
  type        = map(string)
}

variable "services" {
  description = "Size and count per ECS service."
  type = map(object({
    cpu           = number
    memory        = number
    desired_count = number
  }))

  validation {
    condition     = alltrue([for k in ["backend", "worker", "frontend", "litellm"] : contains(keys(var.services), k)])
    error_message = "services must define backend, worker, frontend and litellm."
  }
}

variable "migrate_task" {
  description = "Size of the one-off migration task."
  type = object({
    cpu    = number
    memory = number
  })
  default = {
    cpu    = 1024
    memory = 3072
  }
}

variable "log_retention_days" {
  description = "Retention of the ECS service log groups."
  type        = number
  default     = 30
}

# ---------------------------------------------------------------- secrets

variable "app_secret_keys_extra" {
  description = "Secret keys of the backend/worker that exist only in this environment."
  type        = list(string)
  default     = []
}

variable "worker_secret_keys_extra" {
  description = "Of app_secret_keys_extra, the keys the worker also reads."
  type        = list(string)
  default     = []
}

# ---------------------------------------------------------------- alerts

variable "alert_email" {
  description = "Email address subscribed to the alarm SNS topic. Empty = no subscription. AWS sends a confirmation email."
  type        = string
  default     = ""
}
