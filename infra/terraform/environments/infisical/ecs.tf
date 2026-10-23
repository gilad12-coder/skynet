# ECS cluster, the Infisical service and the tunnel task definition.
#
# Image pins (tag for the reader, digest for the pull). Both are multi-arch
# OCI indexes; ECS pulls the linux/arm64 image.
#   infisical/infisical:v0.166.8 - GitHub release v0.166.8 (2026-10-15, not a
#     pre-release). Digest read on 2026-10-22 from the Docker Hub API
#     (hub.docker.com/v2/namespaces/infisical/repositories/infisical/tags) and
#     from `docker buildx imagetools inspect`; the two agree.
#   alpine:3.22 (ECR Public mirror of the Docker official image) - digest
#     read on 2026-10-22 with `docker buildx imagetools inspect`.

locals {
  image = {
    infisical = "infisical/infisical:v0.166.8@sha256:bb8352b71cea9e329af1216f7d43804598ede5208c5dd427fcd38bc26c098505"
    tunnel    = "public.ecr.aws/docker/library/alpine:3.22@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f"
  }

  datastore_arn = aws_secretsmanager_secret.datastore.arn
  bootstrap_arn = aws_secretsmanager_secret.bootstrap.arn
}

resource "aws_cloudwatch_log_group" "infisical" {
  name              = "/ecs/${local.name}/infisical"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "tunnel" {
  name              = "/ecs/${local.name}/tunnel"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "exec" {
  name              = "/ecs/${local.name}/exec-sessions"
  retention_in_days = 90
}

resource "aws_ecs_cluster" "this" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  configuration {
    execute_command_configuration {
      logging = "OVERRIDE"

      log_configuration {
        cloud_watch_log_group_name = aws_cloudwatch_log_group.exec.name
      }
    }
  }
}

resource "aws_ecs_task_definition" "infisical" {
  family                   = "${local.name}-infisical"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  # 0.5 vCPU / 2 GB: Infisical runs its database migrations at start-up and
  # the Node process needs more than 1 GB then.
  cpu                = 512
  memory             = 2048
  execution_role_arn = aws_iam_role.exec.arn
  task_role_arn      = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([{
    name      = "infisical"
    image     = local.image.infisical
    essential = true

    portMappings = [{ containerPort = local.infisical_port, protocol = "tcp" }]

    # Names verified in backend/src/lib/config/env.ts (v0.166.8).
    environment = [
      { name = "HOST", value = "0.0.0.0" },
      { name = "PORT", value = tostring(local.infisical_port) },
      { name = "SITE_URL", value = local.site_url },
      { name = "TELEMETRY_ENABLED", value = "false" },
      { name = "DB_HOST", value = aws_db_instance.this.address },
      { name = "DB_PORT", value = tostring(aws_db_instance.this.port) },
      { name = "DB_USER", value = aws_db_instance.this.username },
      { name = "DB_NAME", value = aws_db_instance.this.db_name },
      # Public RDS CA bundle (truststore.pki.rds.amazonaws.com, us-east-2).
      # With it, Infisical connects with TLS and checks the server certificate.
      { name = "DB_ROOT_CERT", value = filebase64("${path.module}/rds-ca-us-east-2.pem") },
      { name = "SMTP_HOST", value = "smtp.resend.com" },
      { name = "SMTP_PORT", value = "587" },
      { name = "SMTP_USERNAME", value = "resend" },
      { name = "SMTP_REQUIRE_TLS", value = "true" },
      { name = "SMTP_FROM_ADDRESS", value = var.smtp_from_address },
      { name = "SMTP_FROM_NAME", value = "Skynet Infisical" },
    ]

    secrets = [
      { name = "ENCRYPTION_KEY", valueFrom = "${local.bootstrap_arn}:ENCRYPTION_KEY::" },
      { name = "AUTH_SECRET", valueFrom = "${local.bootstrap_arn}:AUTH_SECRET::" },
      { name = "DB_PASSWORD", valueFrom = "${local.datastore_arn}:DB_PASSWORD::" },
      { name = "REDIS_URL", valueFrom = "${local.datastore_arn}:REDIS_URL::" },
      { name = "SMTP_PASSWORD", valueFrom = "${aws_secretsmanager_secret.smtp.arn}:SMTP_PASSWORD::" },
    ]

    # The image has node; GET /api/status returns 200 when the API is up.
    healthCheck = {
      command     = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:${local.infisical_port}/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
      interval    = 30
      timeout     = 10
      retries     = 3
      startPeriod = 300
    }

    readonlyRootFilesystem = false

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.infisical.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "infisical"
      }
    }
  }])
}

resource "aws_ecs_service" "infisical" {
  name            = "infisical"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.infisical.arn
  desired_count   = var.service_running ? 1 : 0
  launch_type     = "FARGATE"

  # No ECS Exec into Infisical: a shell there could read its environment
  # (ENCRYPTION_KEY). The tunnel task is the only Exec target.
  enable_execute_command = false

  # One task: stop the old task before the new one starts, so two Infisical
  # versions never run migrations at the same time.
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.this["infisical"].id]
    assign_public_ip = false
  }

  depends_on = [
    aws_iam_role_policy.exec_secrets,
    aws_secretsmanager_secret_version.datastore,
    aws_secretsmanager_secret_version.bootstrap,
  ]
}

# Tunnel task (scripts/infisical-tunnel.sh runs it on demand). It holds no
# secrets and sleeps; ECS Exec forwards localhost:18080 through it to the
# Infisical task on port 8080. It stops itself after 4 hours.
resource "aws_ecs_task_definition" "tunnel" {
  #checkov:skip=CKV_AWS_336:ECS Exec (the SSM agent) needs a writable root filesystem; the task holds no secrets.
  family                   = "${local.name}-tunnel"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.tunnel_exec.arn
  task_role_arn            = aws_iam_role.tunnel_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([{
    name                   = "tunnel"
    image                  = local.image.tunnel
    essential              = true
    command                = ["sleep", "14400"]
    readonlyRootFilesystem = false
    linuxParameters        = { initProcessEnabled = true }

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.tunnel.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "tunnel"
      }
    }
  }])
}

# Names and IDs for the scripts (no secrets), like /skynet/<env>/deploy.
resource "aws_ssm_parameter" "config" {
  #checkov:skip=CKV2_AWS_34:Names and IDs only, no secret.
  name = "/skynet/infisical/config"
  type = "String"
  value = jsonencode({
    cluster            = aws_ecs_cluster.this.name
    service            = aws_ecs_service.infisical.name
    tunnel_family      = aws_ecs_task_definition.tunnel.family
    subnets            = aws_subnet.private[*].id
    tunnel_sg          = aws_security_group.this["tunnel"].id
    postgres_sg        = aws_security_group.this["postgres"].id
    db_instance        = aws_db_instance.this.identifier
    db_subnet_group    = aws_db_subnet_group.this.name
    kms_key_arn        = aws_kms_key.this.arn
    infisical_port     = local.infisical_port
    tunnel_port        = local.tunnel_port
    site_url           = local.site_url
    sync_role_arn      = "arn:aws:iam::${local.account_id}:role/${local.name}-secret-sync"
    sync_secret_prefix = "skynet/<env>/app"
  })
}
