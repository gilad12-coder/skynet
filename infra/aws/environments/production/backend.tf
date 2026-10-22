terraform {
  required_version = ">= 1.11.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.70"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
  }

  # Partial configuration: pass the bucket at init time.
  #   terraform init -backend-config="bucket=<bootstrap output state_bucket>"
  backend "s3" {
    key          = "production/terraform.tfstate"
    region       = "us-east-2"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "skynet"
      Environment = "production"
      ManagedBy   = "terraform"
    }
  }
}

variable "region" {
  description = "AWS Region."
  type        = string
  default     = "us-east-2"

  # The AWS account (new "project" experience) may create Regional resources
  # only in us-east-2.
  validation {
    condition     = var.region == "us-east-2"
    error_message = "This AWS account allows Regional resources only in us-east-2."
  }
}

variable "image_tag" {
  description = "Image tag (git SHA) for the task definitions Terraform creates. Later image changes go through scripts/deploy.sh."
  type        = string
}

variable "enable_https" {
  description = "Create the HTTPS listener. Set true after ACM shows the certificate as ISSUED."
  type        = bool
  default     = false
}

variable "services_enabled" {
  description = "Create the ECS services (second apply, after secrets, litellm database and migration)."
  type        = bool
  default     = false
}

variable "alert_email" {
  description = "Email for alarm notifications (empty = none)."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------- sizing
# Sizing lives in tfvars, so scaling up or down changes no .tf file:
#   terraform.tfvars - lean variant (loaded automatically)
#   full.tfvars      - full variant: add -var-file=full.tfvars to plan/apply

variable "egress_mode" {
  description = "Task egress: nat_per_az, nat_single or public_ip (see the module variable)."
  type        = string
}

variable "db_instance_class" {
  description = "RDS instance class (Graviton)."
  type        = string
}

variable "db_multi_az" {
  description = "Run RDS as Multi-AZ (standby in a second AZ)."
  type        = bool
}

variable "cache_node_count" {
  description = "Valkey nodes: 1 = no replica; 2+ = automatic failover across AZs."
  type        = number
}

variable "services" {
  description = "cpu, memory, desired_count and spot per ECS service (backend, worker, frontend, litellm)."
  type = map(object({
    cpu           = number
    memory        = number
    desired_count = number
    spot          = optional(bool, false)
  }))
}

# ECR repositories come from the global stack. The URLs follow a fixed
# pattern, so this stack does not read the global state and can be planned
# before the global stack exists. scripts/deploy.sh checks that the images exist.
data "aws_caller_identity" "current" {}

locals {
  ecr_repository_urls = {
    for k in ["backend", "frontend", "litellm"] :
    k => "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.region}.amazonaws.com/skynet/${k}"
  }
}
