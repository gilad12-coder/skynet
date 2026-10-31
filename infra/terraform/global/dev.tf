# Local development keys (SKY-186): skynet/dev/{app,frontend,litellm}.
#
# scripts/dev-env.sh copies their keys into a worktree's git-ignored env
# files, so agents and local runs use dev keys only, never staging or
# production keys. Fill them with:
#   infra/terraform/scripts/secrets.sh set dev <app|frontend|litellm> <KEY>
#
# Terraform creates the empty secrets only. It writes no secret version, so
# no value is ever in code or in the Terraform state, and the plan role needs
# no read access to them. The first `secrets.sh set` writes the first version.

resource "aws_secretsmanager_secret" "dev" {
  for_each = toset(["app", "frontend", "litellm"])

  name        = "skynet/dev/${each.key}"
  description = "Local development keys for ${each.key} (scripts/dev-env.sh). Never staging or production values."
}
