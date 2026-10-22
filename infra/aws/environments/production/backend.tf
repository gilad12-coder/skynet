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
