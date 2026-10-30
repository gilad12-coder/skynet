# One execution role (pull image, write logs, read secrets) and one task role
# (what the running code may call) per task family. Each execution role reads
# only the secrets its family needs.

locals {
  families = toset(["backend", "worker", "frontend", "litellm", "migrate", "dbadmin"])

  family_secret_arns = {
    backend  = [aws_secretsmanager_secret.manual["app"].arn, aws_secretsmanager_secret.app_generated.arn]
    worker   = [aws_secretsmanager_secret.manual["app"].arn, aws_secretsmanager_secret.app_generated.arn]
    migrate  = [aws_secretsmanager_secret.manual["app"].arn, aws_secretsmanager_secret.app_generated.arn]
    frontend = [aws_secretsmanager_secret.manual["frontend"].arn]
    litellm  = [aws_secretsmanager_secret.manual["litellm"].arn, aws_secretsmanager_secret.litellm_generated.arn]
    dbadmin  = [aws_secretsmanager_secret.db_admin.arn, aws_secretsmanager_secret.app_generated.arn, aws_secretsmanager_secret.litellm_generated.arn]
  }
}

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

resource "aws_iam_role" "execution" {
  for_each = local.families

  name               = "${local.name}-${each.key}-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  for_each = local.families

  role       = aws_iam_role.execution[each.key].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  for_each = local.families

  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = local.family_secret_arns[each.key]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  for_each = local.families

  name   = "read-secrets"
  role   = aws_iam_role.execution[each.key].id
  policy = data.aws_iam_policy_document.execution_secrets[each.key].json
}

resource "aws_iam_role" "task" {
  for_each = local.families

  name               = "${local.name}-${each.key}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}

# ECS Exec (debug shells and the dbadmin port forward). Sessions are logged.
data "aws_iam_policy_document" "task_exec" {
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

resource "aws_iam_role_policy" "task_exec" {
  for_each = local.families

  name   = "ecs-exec"
  role   = aws_iam_role.task[each.key].id
  policy = data.aws_iam_policy_document.task_exec.json
}
