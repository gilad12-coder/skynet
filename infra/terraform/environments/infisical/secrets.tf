# Generated values never enter Terraform state or plan files:
#   - "ephemeral" random values exist only while Terraform runs;
#   - they reach AWS only through write-only arguments (*_wo), which
#     Terraform does not store;
#   - the provider refreshes a write-only secret version with
#     ListSecretVersionIds, never GetSecretValue, and stores no value.
# A write-only argument is sent only when its *_version changes. Each later
# plan makes new ephemeral values and discards them unused.
#
# Three secrets, all with the customer managed key:
#   skynet/infisical/bootstrap  ENCRYPTION_KEY, AUTH_SECRET (written once, locked)
#   skynet/infisical/datastore  DB_PASSWORD, REDIS_URL (rotatable together)
#   skynet/infisical/smtp       SMTP_PASSWORD (the Resend key; Gilad copies it
#                               from skynet/staging/app, INFISICAL.md step 2)

# ---------------------------------------------------------------- bootstrap

# Infisical docs: ENCRYPTION_KEY = 16 random bytes as hex (openssl rand -hex 16),
# AUTH_SECRET = 32 random bytes as base64 (openssl rand -base64 32).
ephemeral "random_bytes" "encryption_key" {
  length = 16
}

ephemeral "random_bytes" "auth_secret" {
  length = 32
}

# If ENCRYPTION_KEY is lost, every secret stored in Infisical is lost. So:
# customer managed key, 30-day recovery window, prevent_destroy, a deny
# policy against writes and deletes, and an offline copy that Gilad keeps
# (INFISICAL.md "Break-glass copy").
resource "aws_secretsmanager_secret" "bootstrap" {
  #checkov:skip=CKV2_AWS_57:ENCRYPTION_KEY must never rotate; rotating it makes the stored data unreadable.
  name                    = "skynet/infisical/bootstrap"
  description             = "Infisical ENCRYPTION_KEY and AUTH_SECRET. Written once by Terraform. Never rotate, never delete."
  kms_key_id              = aws_kms_key.this.arn
  recovery_window_in_days = 30

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_secretsmanager_secret_version" "bootstrap" {
  secret_id = aws_secretsmanager_secret.bootstrap.id
  secret_string_wo = jsonencode({
    ENCRYPTION_KEY = ephemeral.random_bytes.encryption_key.hex
    AUTH_SECRET    = ephemeral.random_bytes.auth_secret.base64
  })
  # Keep this at 1. Any other value writes NEW keys over the old ones, and
  # Infisical can then no longer decrypt its data. The resource policy below
  # also denies that write.
  secret_string_wo_version = 1

  lifecycle {
    prevent_destroy = true
  }
}

# Deny writes and deletes for every principal, the account admin included.
# Created after the first version, so Terraform can write that version once.
# Break-glass: an admin removes this policy (DeleteResourcePolicy) first.
data "aws_iam_policy_document" "bootstrap_lock" {
  statement {
    sid    = "LockBootstrapValue"
    effect = "Deny"
    actions = [
      "secretsmanager:PutSecretValue",
      "secretsmanager:UpdateSecret",
      "secretsmanager:UpdateSecretVersionStage",
      "secretsmanager:RotateSecret",
      "secretsmanager:DeleteSecret",
    ]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
  }
}

resource "aws_secretsmanager_secret_policy" "bootstrap" {
  secret_arn = aws_secretsmanager_secret.bootstrap.arn
  policy     = data.aws_iam_policy_document.bootstrap_lock.json

  depends_on = [aws_secretsmanager_secret_version.bootstrap]
}

# ---------------------------------------------------------------- datastore

ephemeral "random_bytes" "db_password" {
  length = 24
}

ephemeral "random_bytes" "valkey_token" {
  length = 32
}

resource "aws_secretsmanager_secret" "datastore" {
  #checkov:skip=CKV2_AWS_57:Rotation is a reviewed apply (raise datastore_credentials_version), not a Lambda rotator.
  name                    = "skynet/infisical/datastore"
  description             = "Infisical DB_PASSWORD and REDIS_URL (with the Valkey AUTH token). Written by Terraform."
  kms_key_id              = aws_kms_key.this.arn
  recovery_window_in_days = 30
}

# The same apply writes the same ephemeral values here, into RDS
# (password_wo) and into Valkey (auth_token_wo).
resource "aws_secretsmanager_secret_version" "datastore" {
  secret_id = aws_secretsmanager_secret.datastore.id
  secret_string_wo = jsonencode({
    DB_PASSWORD = ephemeral.random_bytes.db_password.hex
    # ioredis ignores REDIS_PASSWORD when REDIS_URL is set, so the token
    # goes into the URL. rediss = TLS.
    REDIS_URL = "rediss://:${ephemeral.random_bytes.valkey_token.hex}@${aws_elasticache_replication_group.this.primary_endpoint_address}:6379"
  })
  secret_string_wo_version = var.datastore_credentials_version
}

# ---------------------------------------------------------------- smtp

# Terraform creates the container only. INFISICAL.md step 2 copies the
# Resend key from skynet/staging/app with a pipe that never prints it.
resource "aws_secretsmanager_secret" "smtp" {
  #checkov:skip=CKV2_AWS_57:Third-party key (Resend); rotated in Resend, then copied again.
  name                    = "skynet/infisical/smtp"
  description             = "Infisical SMTP_PASSWORD (Resend API key). Set by INFISICAL.md step 2."
  kms_key_id              = aws_kms_key.this.arn
  recovery_window_in_days = 30
}
