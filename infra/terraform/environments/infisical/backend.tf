terraform {
  # Write-only attributes need Terraform 1.11 or later.
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
    key          = "infisical/terraform.tfstate"
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
      Environment = "infisical"
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

variable "service_running" {
  description = "Run the Infisical service (desired count 1). Keep false for the first apply: the service cannot start until skynet/infisical/smtp has a value (INFISICAL.md step 2)."
  type        = bool
  default     = false
}

variable "infisical_project_id" {
  description = "ID of the Infisical project \"skynet\". It is the external ID of the secret sync role. Empty = do not create the sync role yet."
  type        = string
  default     = ""

  validation {
    condition     = var.infisical_project_id == "" || can(regex("^[0-9a-f-]{36}$", var.infisical_project_id))
    error_message = "infisical_project_id must be the project UUID shown in Infisical (Project Settings)."
  }
}

variable "datastore_credentials_version" {
  description = "Raise by 1 to generate a new database password and Valkey token in one apply (rotation, or recovery after a partial first apply). The ECS service must then be redeployed."
  type        = number
  default     = 1
}

variable "smtp_from_address" {
  description = "Sender address for Infisical email (invites, verification codes). Its domain must be verified in Resend."
  type        = string
}

variable "alert_email" {
  description = "Email for the secret-change alarm (empty = none; subscribe later)."
  type        = string
  default     = ""
}
