# Account-wide resources shared by staging and production:
# - ECR repositories (one image is built once and promoted by tag).
# - The GitHub Actions OIDC provider and the deploy role (no static AWS keys).

terraform {
  required_version = ">= 1.11.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.70"
    }
  }

  # Partial configuration: pass the bucket at init time.
  #   terraform init -backend-config="bucket=<bootstrap output state_bucket>"
  backend "s3" {
    key          = "global/terraform.tfstate"
    region       = "us-east-2"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "skynet"
      ManagedBy = "terraform"
      Stack     = "global"
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

variable "github_repository" {
  description = "GitHub repository (owner/name) that may assume the deploy role."
  type        = string
  default     = "gilad12-coder/skynet"
}

variable "enable_github_oidc" {
  description = <<-EOT
    Create the GitHub Actions OIDC provider and the deploy role. Keep false:
    the managed SCP of this AWS account (free and paid plan) denies
    iam:*Provider*, so CreateOpenIDConnectProvider fails. Set true only after
    "Activate advanced AWS features" removes that deny.
  EOT
  type        = bool
  default     = false
}

variable "image_repositories" {
  description = "ECR repositories to create."
  type        = set(string)
  default     = ["backend", "frontend", "litellm"]
}

data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
}

resource "aws_ecr_repository" "this" {
  for_each = var.image_repositories

  name = "skynet/${each.key}"
  # Tags are commit SHAs (plus an environment suffix for the frontend), so a
  # tag never moves. Immutable tags make a rollback point at exactly the image
  # that ran before.
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
  }
}

resource "aws_ecr_lifecycle_policy" "this" {
  for_each   = aws_ecr_repository.this
  repository = each.value.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Delete untagged images after 7 days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 7
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the newest 100 tagged images"
        selection = {
          tagStatus      = "tagged"
          tagPatternList = ["*"]
          countType      = "imageCountMoreThan"
          countNumber    = 100
        }
        action = { type = "expire" }
      },
    ]
  })
}

resource "aws_iam_openid_connect_provider" "github" {
  count = var.enable_github_oidc ? 1 : 0

  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_policy_document" "github_trust" {
  count = var.enable_github_oidc ? 1 : 0

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github[0].arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # Only the deploy workflow's GitHub environments may assume the role.
    # Add required reviewers to these environments in GitHub settings.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "repo:${var.github_repository}:environment:aws-staging",
        "repo:${var.github_repository}:environment:aws-production",
      ]
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  count = var.enable_github_oidc ? 1 : 0

  name                 = "skynet-github-deploy"
  description          = "Assumed by GitHub Actions (OIDC) to push images and deploy ECS services."
  assume_role_policy   = data.aws_iam_policy_document.github_trust[0].json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "github_deploy" {
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "EcrPush"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeImages",
      "ecr:DescribeRepositories",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = [for r in aws_ecr_repository.this : r.arn]
  }

  statement {
    sid = "EcsTaskDefinitions"
    # These actions do not support resource-level permissions.
    actions = [
      "ecs:DescribeTaskDefinition",
      "ecs:RegisterTaskDefinition",
    ]
    resources = ["*"]
  }

  statement {
    sid = "EcsDeploy"
    actions = [
      "ecs:DescribeServices",
      "ecs:DescribeTasks",
      "ecs:RunTask",
      "ecs:UpdateService",
      "ecs:TagResource",
    ]
    resources = [
      "arn:aws:ecs:${var.region}:${local.account_id}:cluster/skynet-*",
      "arn:aws:ecs:${var.region}:${local.account_id}:service/skynet-*/*",
      "arn:aws:ecs:${var.region}:${local.account_id}:task/skynet-*/*",
      "arn:aws:ecs:${var.region}:${local.account_id}:task-definition/skynet-*:*",
    ]
  }

  statement {
    sid       = "PassTaskRoles"
    actions   = ["iam:PassRole"]
    resources = ["arn:aws:iam::${local.account_id}:role/skynet-*"]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }

  statement {
    sid       = "ReadMigrationLogs"
    actions   = ["logs:GetLogEvents", "logs:FilterLogEvents"]
    resources = ["arn:aws:logs:${var.region}:${local.account_id}:log-group:/ecs/skynet-*:*"]
  }

  statement {
    sid       = "ReadDeployParameters"
    actions   = ["ssm:GetParameter", "ssm:GetParameters"]
    resources = ["arn:aws:ssm:${var.region}:${local.account_id}:parameter/skynet/*"]
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  count = var.enable_github_oidc ? 1 : 0

  name   = "deploy"
  role   = aws_iam_role.github_deploy[0].id
  policy = data.aws_iam_policy_document.github_deploy.json
}

output "ecr_repository_urls" {
  description = "ECR repository URL per image."
  value       = { for k, r in aws_ecr_repository.this : k => r.repository_url }
}

output "github_deploy_role_arn" {
  description = "Role ARN for aws-actions/configure-aws-credentials in the deploy workflow (null while enable_github_oidc is false)."
  value       = one(aws_iam_role.github_deploy[*].arn)
}
