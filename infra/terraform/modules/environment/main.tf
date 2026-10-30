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
}

data "aws_caller_identity" "current" {}

locals {
  name       = "skynet-${var.environment}"
  account_id = data.aws_caller_identity.current.account_id

  # Container ports. The backend image defaults to 8000 when PORT is unset;
  # we set PORT=8080 explicitly.
  ports = {
    backend  = 8080
    frontend = 3001
    litellm  = 4000
  }

  site_url      = "https://${var.frontend_domains[0]}"
  site_origins  = [for d in var.frontend_domains : "https://${d}"]
  api_url       = "https://${var.api_domain}"
  internal_zone = "${var.environment}.skynet.internal"
  litellm_url   = "http://litellm.${local.internal_zone}:${local.ports.litellm}"
}
