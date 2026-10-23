# TEMPORARY (SKY-156): carries the final Railway staging dumps into AWS for
# the restore. The SSM port forward through the dbadmin task stalled during
# pg_restore, so the dbadmin task reads the dumps from this private bucket
# instead. Only the dbadmin task role may read it. Objects expire after one
# day. Remove this file and apply again after the restore.

resource "aws_s3_bucket" "restore_transfer" {
  bucket        = "skynet-staging-restore-${data.aws_caller_identity.current.account_id}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "restore_transfer" {
  bucket                  = aws_s3_bucket.restore_transfer.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "restore_transfer" {
  bucket = aws_s3_bucket.restore_transfer.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

#trivy:ignore:AWS-0132
resource "aws_s3_bucket_server_side_encryption_configuration" "restore_transfer" {
  bucket = aws_s3_bucket.restore_transfer.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "restore_transfer" {
  bucket = aws_s3_bucket.restore_transfer.id

  rule {
    id     = "expire"
    status = "Enabled"
    filter {}
    expiration {
      days = 1
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

data "aws_iam_policy_document" "restore_transfer_bucket" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.restore_transfer.arn, "${aws_s3_bucket.restore_transfer.arn}/*"]

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

resource "aws_s3_bucket_policy" "restore_transfer" {
  bucket = aws_s3_bucket.restore_transfer.id
  policy = data.aws_iam_policy_document.restore_transfer_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.restore_transfer]
}

data "aws_iam_role" "dbadmin_task" {
  name = "skynet-staging-dbadmin-task"
}

data "aws_iam_policy_document" "dbadmin_restore_read" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.restore_transfer.arn}/*"]
  }
}

resource "aws_iam_role_policy" "dbadmin_restore_read" {
  name   = "read-restore-transfer"
  role   = data.aws_iam_role.dbadmin_task.id
  policy = data.aws_iam_policy_document.dbadmin_restore_read.json
}
