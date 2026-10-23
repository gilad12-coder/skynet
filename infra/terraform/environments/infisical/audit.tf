# Audit and alarm for secret changes.
#
# The account had no CloudTrail trail (checked 2026-10-22), and EventBridge
# sees "AWS API Call via CloudTrail" events only when a trail exists. This
# trail records write management events in us-east-2 only (the account may
# not use other Regions). The first trail copy of management events has no
# CloudTrail charge; S3 storage is a few cents per month.
#
# The rule sends an email (SNS) for every write or delete on a secret whose
# name starts with skynet/: Infisical syncs, deploy scripts, Terraform and
# console edits all show up.

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
      values   = ["arn:aws:cloudtrail:${var.region}:${local.account_id}:trail/${local.name}-audit"]
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
      values   = ["arn:aws:cloudtrail:${var.region}:${local.account_id}:trail/${local.name}-audit"]
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
  #checkov:skip=CKV_AWS_144:Single-Region account; cross-Region replication is not allowed.
  #checkov:skip=CKV_AWS_18:Access logging of the audit bucket adds a second bucket and no value here.
  #checkov:skip=CKV2_AWS_62:No event notifications needed; EventBridge reads the events directly.
  bucket = "${local.name}-audit-${local.account_id}"
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
      kms_master_key_id = aws_kms_key.this.arn
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
  name                          = "${local.name}-audit"
  s3_bucket_name                = aws_s3_bucket.trail.id
  kms_key_id                    = aws_kms_key.this.arn
  is_multi_region_trail         = false
  include_global_service_events = false
  enable_log_file_validation    = true

  event_selector {
    read_write_type           = "WriteOnly"
    include_management_events = true
  }

  depends_on = [aws_s3_bucket_policy.trail]
}

resource "aws_sns_topic" "alarms" {
  name              = "${local.name}-alarms"
  kms_master_key_id = aws_kms_key.this.arn
}

resource "aws_sns_topic_subscription" "email" {
  count = var.alert_email == "" ? 0 : 1

  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

data "aws_iam_policy_document" "alarms_topic" {
  statement {
    sid       = "EventBridgePublish"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alarms.arn]
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

resource "aws_sns_topic_policy" "alarms" {
  arn    = aws_sns_topic.alarms.arn
  policy = data.aws_iam_policy_document.alarms_topic.json
}

resource "aws_cloudwatch_event_rule" "secret_changes" {
  name        = "${local.name}-secret-changes"
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
# time. CloudTrail never records secret values for these calls.
resource "aws_cloudwatch_event_target" "secret_changes" {
  rule      = aws_cloudwatch_event_rule.secret_changes.name
  target_id = "sns"
  arn       = aws_sns_topic.alarms.arn

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
