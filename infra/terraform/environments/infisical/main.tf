# Self-hosted Infisical (SKY-186). Infisical is the place where a human edits
# a secret. Infisical Secret Syncs write the values into the existing Secrets
# Manager secrets skynet/<env>/app, and ECS keeps reading Secrets Manager.
# The running apps never call Infisical. See INFISICAL.md.
#
# This root creates new resources only. It reads nothing from the staging or
# production roots and changes none of their resources.
#
# Access is internal only: no load balancer, no public IP, no DNS name.
# scripts/infisical-tunnel.sh forwards http://localhost:18080 to the task.

data "aws_caller_identity" "current" {}

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  name       = "skynet-infisical"
  account_id = data.aws_caller_identity.current.account_id

  # RDS and ElastiCache subnet groups need two AZs. Only the NAT gateway,
  # RDS and Valkey stay in one AZ (see the cost notes in INFISICAL.md).
  azs      = slice(data.aws_availability_zones.available.names, 0, 2)
  vpc_cidr = "10.60.0.0/16"

  public_cidrs   = [for i in range(2) : cidrsubnet(local.vpc_cidr, 4, i)]
  private_cidrs  = [for i in range(2) : cidrsubnet(local.vpc_cidr, 4, i + 4)]
  isolated_cidrs = [for i in range(2) : cidrsubnet(local.vpc_cidr, 4, i + 8)]

  # The port the Infisical container listens on. The local tunnel port is
  # 18080. Never 3000 or 8000 (they collide with local dev servers).
  infisical_port = 8080
  tunnel_port    = 18080
  site_url       = "http://localhost:${local.tunnel_port}"

  # The secrets that Infisical Secret Syncs may write. The production secret
  # comes from the production root (module.env, manual["app"]); this root
  # does not create it.
  sync_secret_arns = [
    for e in ["staging", "production"] :
    "arn:aws:secretsmanager:${var.region}:${local.account_id}:secret:skynet/${e}/app-??????"
  ]
}

# ---------------------------------------------------------------- KMS

# One customer managed key for this stack: the bootstrap secrets
# (ENCRYPTION_KEY, AUTH_SECRET), the datastore and SMTP secrets, RDS storage,
# Valkey at rest, the alarm topic and the audit trail. Deleting this key
# makes the encrypted Infisical data unreadable, so it is protected.
data "aws_iam_policy_document" "kms" {
  #checkov:skip=CKV_AWS_109:Key policies must name the key itself as "*"; the account root statement delegates to IAM.
  #checkov:skip=CKV_AWS_111:Key policies must name the key itself as "*"; the account root statement delegates to IAM.
  #checkov:skip=CKV_AWS_356:Key policies must name the key itself as "*".
  statement {
    sid       = "AccountAdmin"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${local.account_id}:root"]
    }
  }

  statement {
    sid       = "CloudTrailEncrypt"
    actions   = ["kms:GenerateDataKey*", "kms:DescribeKey"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = ["arn:aws:cloudtrail:${var.region}:${local.account_id}:trail/${local.name}-audit"]
    }
  }

  statement {
    sid       = "EventBridgeToSns"
    actions   = ["kms:GenerateDataKey*", "kms:Decrypt"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_kms_key" "this" {
  description             = "Skynet Infisical: bootstrap secrets, database, cache, audit"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.kms.json

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "this" {
  name          = "alias/${local.name}"
  target_key_id = aws_kms_key.this.key_id
}

# ---------------------------------------------------------------- network
# A small VPC of its own. The staging VPC has no NAT gateway (its tasks get
# public IPs), and Infisical must not have a public IP. A dedicated VPC also
# keeps the secrets store apart from the app tasks.

resource "aws_vpc" "this" {
  cidr_block           = local.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = { Name = local.name }
}

# Remove all rules from the default security group so nothing uses it by accident.
resource "aws_default_security_group" "this" {
  vpc_id = aws_vpc.this.id
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = local.name }
}

resource "aws_subnet" "public" {
  count             = 2
  vpc_id            = aws_vpc.this.id
  cidr_block        = local.public_cidrs[count.index]
  availability_zone = local.azs[count.index]

  tags = { Name = "${local.name}-public-${local.azs[count.index]}", Tier = "public" }
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.this.id
  cidr_block        = local.private_cidrs[count.index]
  availability_zone = local.azs[count.index]

  tags = { Name = "${local.name}-private-${local.azs[count.index]}", Tier = "private" }
}

resource "aws_subnet" "isolated" {
  count             = 2
  vpc_id            = aws_vpc.this.id
  cidr_block        = local.isolated_cidrs[count.index]
  availability_zone = local.azs[count.index]

  tags = { Name = "${local.name}-isolated-${local.azs[count.index]}", Tier = "isolated" }
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "${local.name}-nat" }
}

# One NAT gateway: the tasks need outbound HTTPS (ECR, Secrets Manager, STS,
# Logs, SSM) and SMTP to Resend without a public IP.
resource "aws_nat_gateway" "this" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id
  tags          = { Name = "${local.name}-nat" }

  depends_on = [aws_internet_gateway.this]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${local.name}-public" }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${local.name}-private" }
}

resource "aws_route" "private_nat" {
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this.id
}

resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

resource "aws_route_table" "isolated" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${local.name}-isolated" }
}

resource "aws_route_table_association" "isolated" {
  count          = 2
  subnet_id      = aws_subnet.isolated[count.index].id
  route_table_id = aws_route_table.isolated.id
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]
  tags              = { Name = "${local.name}-s3" }
}

resource "aws_cloudwatch_log_group" "flow_logs" {
  name              = "/vpc/${local.name}/flow-logs"
  retention_in_days = 30
}

data "aws_iam_policy_document" "flow_logs_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["vpc-flow-logs.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "flow_logs" {
  name               = "${local.name}-flow-logs"
  assume_role_policy = data.aws_iam_policy_document.flow_logs_trust.json
}

data "aws_iam_policy_document" "flow_logs" {
  statement {
    actions = [
      "logs:CreateLogStream",
      "logs:DescribeLogStreams",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.flow_logs.arn}:*"]
  }
}

resource "aws_iam_role_policy" "flow_logs" {
  name   = "write-flow-logs"
  role   = aws_iam_role.flow_logs.id
  policy = data.aws_iam_policy_document.flow_logs.json
}

resource "aws_flow_log" "this" {
  vpc_id               = aws_vpc.this.id
  traffic_type         = "ALL"
  log_destination_type = "cloud-watch-logs"
  log_destination      = aws_cloudwatch_log_group.flow_logs.arn
  iam_role_arn         = aws_iam_role.flow_logs.arn
}

# ---------------------------------------------------------------- security groups

resource "aws_security_group" "this" {
  for_each = toset(["infisical", "tunnel", "postgres", "valkey"])

  name        = "${local.name}-${each.key}"
  description = "Skynet Infisical ${each.key}"
  vpc_id      = aws_vpc.this.id
  tags        = { Name = "${local.name}-${each.key}" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "infisical_from_tunnel" {
  security_group_id            = aws_security_group.this["infisical"].id
  description                  = "Infisical HTTP from the tunnel task only"
  referenced_security_group_id = aws_security_group.this["tunnel"].id
  ip_protocol                  = "tcp"
  from_port                    = local.infisical_port
  to_port                      = local.infisical_port
}

#trivy:ignore:AWS-0104
resource "aws_vpc_security_group_egress_rule" "infisical_https" {
  security_group_id = aws_security_group.this["infisical"].id
  description       = "HTTPS to AWS APIs (ECR, Secrets Manager, STS, Logs) through NAT"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

#trivy:ignore:AWS-0104
resource "aws_vpc_security_group_egress_rule" "infisical_smtp" {
  security_group_id = aws_security_group.this["infisical"].id
  description       = "SMTP submission (STARTTLS) to Resend through NAT"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 587
  to_port           = 587
}

resource "aws_vpc_security_group_egress_rule" "infisical_postgres" {
  security_group_id            = aws_security_group.this["infisical"].id
  description                  = "To RDS"
  referenced_security_group_id = aws_security_group.this["postgres"].id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_vpc_security_group_egress_rule" "infisical_valkey" {
  security_group_id            = aws_security_group.this["infisical"].id
  description                  = "To Valkey"
  referenced_security_group_id = aws_security_group.this["valkey"].id
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
}

resource "aws_vpc_security_group_egress_rule" "tunnel_to_infisical" {
  security_group_id            = aws_security_group.this["tunnel"].id
  description                  = "Forward to Infisical HTTP"
  referenced_security_group_id = aws_security_group.this["infisical"].id
  ip_protocol                  = "tcp"
  from_port                    = local.infisical_port
  to_port                      = local.infisical_port
}

#trivy:ignore:AWS-0104
resource "aws_vpc_security_group_egress_rule" "tunnel_https" {
  security_group_id = aws_security_group.this["tunnel"].id
  description       = "HTTPS to ECR Public and the SSM endpoints (ECS Exec) through NAT"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_ingress_rule" "postgres_from_infisical" {
  security_group_id            = aws_security_group.this["postgres"].id
  description                  = "From Infisical tasks"
  referenced_security_group_id = aws_security_group.this["infisical"].id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_vpc_security_group_ingress_rule" "valkey_from_infisical" {
  security_group_id            = aws_security_group.this["valkey"].id
  description                  = "From Infisical tasks"
  referenced_security_group_id = aws_security_group.this["infisical"].id
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
}
