#!/usr/bin/env bash
# Copies the Resend API key (SMTP_PASSWORD) from skynet/staging/app to
# skynet/infisical/smtp, so Infisical can send email through Resend. The
# value goes from one AWS call to the next through a pipe; it is never
# printed, put on the command line or written to a file.
#
#   infra/terraform/scripts/infisical-smtp-copy.sh
#
# Run once after the first apply (INFISICAL.md step 2). Gilad runs it.

source "$(dirname "$0")/lib.sh"
need aws jq

aws secretsmanager get-secret-value --secret-id skynet/staging/app --query SecretString --output text |
  jq -ce 'if (.SMTP_PASSWORD // "") == "" then error("SMTP_PASSWORD is missing in skynet/staging/app") else {SMTP_PASSWORD} end' |
  aws secretsmanager put-secret-value --secret-id skynet/infisical/smtp --secret-string file:///dev/stdin \
    --query VersionId --output text >/dev/null
echo "skynet/infisical/smtp now has SMTP_PASSWORD (value not shown)"
