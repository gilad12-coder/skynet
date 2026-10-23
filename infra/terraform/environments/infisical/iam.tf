# Roles:
#   skynet-infisical-exec         ECS execution role of the Infisical task:
#                                 pulls the image, writes logs, reads the three
#                                 skynet/infisical/* secrets for the container.
#   skynet-infisical-task         The running Infisical code. It may only
#                                 assume the secret sync role.
#   skynet-infisical-secret-sync  Assumed by Infisical (AWS app connection,
#                                 with the project ID as external ID). It may
#                                 read and write skynet/staging/app and
#                                 skynet/production/app only.
#   skynet-infisical-tunnel-*     The tunnel task: ECS Exec only, no secrets.

data "aws_iam_policy_document" "ecs_tasks_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

# ---------------------------------------------------------------- Infisical task

resource "aws_iam_role" "exec" {
  name               = "${local.name}-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}

resource "aws_iam_role_policy_attachment" "exec_managed" {
  role       = aws_iam_role.exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "exec_secrets" {
  statement {
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.bootstrap.arn,
      aws_secretsmanager_secret.datastore.arn,
      aws_secretsmanager_secret.smtp.arn,
    ]
  }

  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.this.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "exec_secrets" {
  name   = "read-secrets"
  role   = aws_iam_role.exec.id
  policy = data.aws_iam_policy_document.exec_secrets.json
}

resource "aws_iam_role" "task" {
  name               = "${local.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}

# Built from the name, so the task role does not depend on the sync role
# (which waits for infisical_project_id).
data "aws_iam_policy_document" "task" {
  statement {
    sid       = "AssumeSecretSyncRole"
    actions   = ["sts:AssumeRole"]
    resources = ["arn:aws:iam::${local.account_id}:role/${local.name}-secret-sync"]
  }
}

resource "aws_iam_role_policy" "task" {
  name   = "assume-secret-sync"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task.json
}

# ---------------------------------------------------------------- secret sync

data "aws_iam_policy_document" "sync_trust" {
  count = var.infisical_project_id == "" ? 0 : 1

  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.task.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "sts:ExternalId"
      values   = [var.infisical_project_id]
    }
  }
}

# Infisical "Many-To-One" sync to one secret per environment calls
# DescribeSecret, GetSecretValue and UpdateSecret (source:
# backend/src/services/secret-sync/aws-secrets-manager/aws-secrets-manager-sync-fns.ts,
# v0.166.8). The explicit deny blocks every other write, so a wrong sync
# setting (One-To-One, "Remove secrets", a new secret name) fails instead of
# deleting or creating secrets.
data "aws_iam_policy_document" "sync" {
  statement {
    sid = "SyncAppSecrets"
    actions = [
      "secretsmanager:DescribeSecret",
      "secretsmanager:GetSecretValue",
      "secretsmanager:PutSecretValue",
      "secretsmanager:UpdateSecret",
    ]
    resources = local.sync_secret_arns
  }

  statement {
    sid    = "DenyOtherSecretWrites"
    effect = "Deny"
    actions = [
      "secretsmanager:CreateSecret",
      "secretsmanager:DeleteSecret",
      "secretsmanager:RestoreSecret",
      "secretsmanager:RotateSecret",
      "secretsmanager:CancelRotateSecret",
      "secretsmanager:UpdateSecretVersionStage",
      "secretsmanager:TagResource",
      "secretsmanager:UntagResource",
      "secretsmanager:PutResourcePolicy",
      "secretsmanager:DeleteResourcePolicy",
      "secretsmanager:ReplicateSecretToRegions",
      "secretsmanager:RemoveRegionsFromReplication",
      "secretsmanager:StopReplicationToReplica",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role" "sync" {
  count = var.infisical_project_id == "" ? 0 : 1

  name                 = "${local.name}-secret-sync"
  assume_role_policy   = data.aws_iam_policy_document.sync_trust[0].json
  max_session_duration = 3600
}

resource "aws_iam_role_policy" "sync" {
  count = var.infisical_project_id == "" ? 0 : 1

  name   = "sync-app-secrets"
  role   = aws_iam_role.sync[0].id
  policy = data.aws_iam_policy_document.sync.json
}

# ---------------------------------------------------------------- tunnel task

resource "aws_iam_role" "tunnel_exec" {
  name               = "${local.name}-tunnel-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}

resource "aws_iam_role_policy_attachment" "tunnel_exec_managed" {
  role       = aws_iam_role.tunnel_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "tunnel_task" {
  name               = "${local.name}-tunnel-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}

# ECS Exec for the port forward. Sessions are logged.
data "aws_iam_policy_document" "tunnel_task" {
  statement {
    actions = [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
    ]
    resources = ["*"]
  }

  statement {
    actions = [
      "logs:CreateLogStream",
      "logs:DescribeLogStreams",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.exec.arn}:*"]
  }

  statement {
    actions   = ["logs:DescribeLogGroups"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "tunnel_task" {
  name   = "ecs-exec"
  role   = aws_iam_role.tunnel_task.id
  policy = data.aws_iam_policy_document.tunnel_task.json
}
