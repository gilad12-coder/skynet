# Alarm on secret changes (SKY-186).
#
# EventBridge sees "AWS API Call via CloudTrail" events only when a trail
# exists, and the account had none (checked 2026-10-30). This trail records
# write management events in us-east-2 only (the account may not use other
# Regions). The first trail copy of management events has no CloudTrail
# charge; S3 storage and the KMS key cost about $1-2 a month.
#
# The rule sends an email (SNS) for every write or delete on a secret whose
# name starts with skynet/: secrets.sh, Terraform and console edits all
# show up. CloudTrail never records secret values for these calls.

variable "alert_email" {
  description = "Email that gets the secret-change alarm. Confirm the SNS subscription email after apply."
  type        = string
  default     = ""
}

locals {
  audit_name      = "skynet-audit"
  audit_trail_arn = "arn:aws:cloudtrail:${var.region}:${local.account_id}:trail/${local.audit_name}"
}

data "aws_iam_policy_document" "audit_key" {
  #checkov:skip=CKV_AWS_111:A KMS key policy applies to this key only; "*" here means this key.
  #checkov:skip=CKV_AWS_109:A KMS key policy applies to this key only; "*" here means this key.
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
      values   = [local.audit_trail_arn]
    }
  }

  # EventBridge must encrypt the message for the KMS-encrypted SNS topic.
  # No aws:SourceAccount/SourceArn condition: SNS does not support them here
  # for EventBridge, and publishes would fail with no error. The topic policy
  # limits publish to the rule ARN.
  statement {
    sid       = "EventBridgeToSns"
    actions   = ["kms:GenerateDataKey*", "kms:Decrypt"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
  }
}

resource "aws_kms_key" "audit" {
  description             = "Skynet audit trail and secret-change alarm"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.audit_key.json
}

resource "aws_kms_alias" "audit" {
  name          = "alias/${local.audit_name}"
  target_key_id = aws_kms_key.audit.key_id
}

data "aws_iam_policy_document" "trail_bucket" {
  statement {
    sid       = "TrailAclCheck"
    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.trail.arn]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.audit_trail_arn]
    }
  }

  statement {
    sid       = "TrailWrite"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.trail.arn}/AWSLogs/${local.account_id}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.audit_trail_arn]
    }
  }

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.trail.arn, "${aws_s3_bucket.trail.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket" "trail" {
  bucket = "${local.audit_name}-${local.account_id}"
}

resource "aws_s3_bucket_public_access_block" "trail" {
  bucket                  = aws_s3_bucket.trail.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "trail" {
  bucket = aws_s3_bucket.trail.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "trail" {
  bucket = aws_s3_bucket.trail.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.audit.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "trail" {
  bucket = aws_s3_bucket.trail.id

  rule {
    id     = "expire"
    status = "Enabled"
    filter {}

    expiration {
      days = 365
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_policy" "trail" {
  bucket = aws_s3_bucket.trail.id
  policy = data.aws_iam_policy_document.trail_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.trail]
}

resource "aws_cloudtrail" "audit" {
  #checkov:skip=CKV_AWS_67:The account may use us-east-2 only; a multi-Region trail is not allowed.
  #checkov:skip=CKV2_AWS_10:EventBridge reads the events; a CloudWatch Logs copy costs more and adds nothing here.
  #checkov:skip=CKV_AWS_252:The alarm goes through EventBridge to SNS, not trail delivery notices.
  name                          = local.audit_name
  s3_bucket_name                = aws_s3_bucket.trail.id
  kms_key_id                    = aws_kms_key.audit.arn
  is_multi_region_trail         = false
  include_global_service_events = false
  enable_log_file_validation    = true

  event_selector {
    read_write_type           = "WriteOnly"
    include_management_events = true
  }

  depends_on = [aws_s3_bucket_policy.trail]
}

resource "aws_sns_topic" "secret_changes" {
  name              = "skynet-secret-changes"
  kms_master_key_id = aws_kms_key.audit.arn
}

resource "aws_sns_topic_subscription" "secret_changes_email" {
  count = var.alert_email == "" ? 0 : 1

  topic_arn = aws_sns_topic.secret_changes.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# A check block warns at plan and apply; it does not stop them.
check "secret_alarm_receiver" {
  assert {
    condition     = var.alert_email != ""
    error_message = "alert_email is empty: the secret-change alarm has no receiver. Export TF_VAR_alert_email=<address> and confirm the SNS subscription."
  }
}

data "aws_iam_policy_document" "secret_changes_topic" {
  statement {
    sid       = "EventBridgePublish"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.secret_changes.arn]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.secret_changes.arn]
    }
  }
}

resource "aws_sns_topic_policy" "secret_changes" {
  arn    = aws_sns_topic.secret_changes.arn
  policy = data.aws_iam_policy_document.secret_changes_topic.json
}

resource "aws_cloudwatch_event_rule" "secret_changes" {
  name        = "skynet-secret-changes"
  description = "Write or delete on a skynet/* secret in Secrets Manager"

  event_pattern = jsonencode({
    source        = ["aws.secretsmanager"]
    "detail-type" = ["AWS API Call via CloudTrail"]
    detail = {
      eventSource = ["secretsmanager.amazonaws.com"]
      eventName = [
        "PutSecretValue",
        "UpdateSecret",
        "DeleteSecret",
        "RestoreSecret",
        "UpdateSecretVersionStage",
        "RotateSecret",
        "PutResourcePolicy",
        "DeleteResourcePolicy",
      ]
      # secretId is a name or an ARN, so match "skynet/" anywhere in it.
      requestParameters = {
        secretId = [{ wildcard = "*skynet/*" }]
      }
    }
  })
}

# The message carries the event name, the secret ID, the caller ARN and the
# time. It never carries a value.
resource "aws_cloudwatch_event_target" "secret_changes" {
  rule      = aws_cloudwatch_event_rule.secret_changes.name
  target_id = "sns"
  arn       = aws_sns_topic.secret_changes.arn

  input_transformer {
    input_paths = {
      event  = "$.detail.eventName"
      secret = "$.detail.requestParameters.secretId"
      caller = "$.detail.userIdentity.arn"
      time   = "$.time"
    }
    input_template = "\"Secrets Manager <event> on <secret> by <caller> at <time>.\""
  }
}
