# Shared pieces of the PR preview environments (SKY-164). scripts/preview.sh
# creates and deletes the per-PR pieces (ECS services, task definitions,
# target groups, listener rules, database) at run time; they are not in
# Terraform state.
#
# Previews run in this environment's cluster with its secrets, task roles and
# security groups, behind its ALB, and share its RDS instance, Valkey and
# LiteLLM.

locals {
  preview_enabled = var.preview_domain != ""
}

# ACM issues the wildcard with the same DNS validation record as the
# certificate for var.preview_domain itself, so no new record is needed when
# var.preview_domain is one of var.frontend_domains.
resource "aws_acm_certificate" "preview" {
  count = local.preview_enabled ? 1 : 0

  domain_name       = "*.${var.preview_domain}"
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_acm_certificate_validation" "preview" {
  count = local.preview_enabled ? 1 : 0

  certificate_arn         = aws_acm_certificate.preview[0].arn
  validation_record_fqdns = [for o in aws_acm_certificate.preview[0].domain_validation_options : o.resource_record_name]
}

resource "aws_lb_listener_certificate" "preview" {
  count = local.preview_enabled && var.enable_https ? 1 : 0

  listener_arn    = aws_lb_listener.https[0].arn
  certificate_arn = aws_acm_certificate_validation.preview[0].certificate_arn
}

# One group for every preview. The environment's error alarms watch only the
# service groups, so preview errors do not page.
resource "aws_cloudwatch_log_group" "preview" {
  count = local.preview_enabled ? 1 : 0

  name              = "/ecs/${local.name}/preview"
  retention_in_days = 7
}

# Values that scripts/preview.sh needs. Not secret.
resource "aws_ssm_parameter" "preview" {
  count = local.preview_enabled ? 1 : 0

  name = "/skynet/${var.environment}/preview"
  type = "String"
  value = jsonencode({
    cluster          = aws_ecs_cluster.this.name
    vpc_id           = aws_vpc.this.id
    subnets          = local.tasks_public ? aws_subnet.public[*].id : aws_subnet.private[*].id
    assign_public_ip = local.tasks_public
    security_groups  = { for k in ["backend", "worker", "frontend", "migrate"] : k => aws_security_group.this[k].id }
    families         = { for k in ["backend", "worker", "frontend", "migrate"] : k => aws_ecs_task_definition.this[k].family }
    listener_arn     = local.routing_listener_arn
    domain           = var.preview_domain
    ports            = { backend = local.ports.backend, frontend = local.ports.frontend }
    log_group        = aws_cloudwatch_log_group.preview[0].name
  })
}
