"""Check that production's pgBackRest repository is still receiving backups.

Railway archives the production Postgres with pgBackRest into an S3-compatible
bucket. Nothing inside Railway alerts when that stops, so the backup-freshness
workflow runs this script on a schedule and fails (which is the alert) when:

- the newest backup in ``backup.info`` is older than ``BACKUP_MAX_AGE_HOURS``,
- that backup recorded an error, or
- the newest archived WAL segment is older than ``WAL_MAX_AGE_MINUTES``.

Configuration comes from the environment: ``BACKUP_S3_ENDPOINT``,
``BACKUP_S3_REGION``, ``BACKUP_S3_BUCKET``, ``BACKUP_S3_PATH``,
``BACKUP_S3_KEY_ID`` and ``BACKUP_S3_SECRET``. It only lists and reads objects.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import UTC, datetime, timedelta

import boto3


def _client():
    """Build an S3 client from the ``BACKUP_S3_*`` environment variables.

    Returns:
        A boto3 S3 client pointed at the backup repository's endpoint.
    """
    return boto3.client(
        "s3",
        endpoint_url=os.environ["BACKUP_S3_ENDPOINT"],
        region_name=os.environ.get("BACKUP_S3_REGION") or None,
        aws_access_key_id=os.environ["BACKUP_S3_KEY_ID"],
        aws_secret_access_key=os.environ["BACKUP_S3_SECRET"],
    )


def _prefixes(s3, bucket: str, prefix: str) -> list[str]:
    """List the immediate "subdirectories" under ``prefix``.

    Args:
        s3: S3 client.
        bucket: Bucket name.
        prefix: Key prefix ending in ``/``.

    Returns:
        Child prefixes, sorted.
    """
    found: list[str] = []
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix, Delimiter="/"):
        found.extend(p["Prefix"] for p in page.get("CommonPrefixes", []))
    return sorted(found)


def latest_backup(info_text: str) -> tuple[str, datetime, bool]:
    """Find the newest backup recorded in a pgBackRest ``backup.info`` file.

    Args:
        info_text: Contents of ``backup.info``.

    Returns:
        The backup label, when it finished, and whether it recorded an error.

    Raises:
        ValueError: The file lists no backups.
    """
    newest: tuple[str, datetime, bool] | None = None
    in_current = False
    for line in info_text.splitlines():
        if line.startswith("["):
            in_current = line.strip() == "[backup:current]"
            continue
        if not in_current or "=" not in line:
            continue
        label, _, raw = line.partition("=")
        entry = json.loads(raw)
        stopped = datetime.fromtimestamp(entry["backup-timestamp-stop"], tz=UTC)
        if newest is None or stopped > newest[1]:
            newest = (label, stopped, bool(entry.get("backup-error")))
    if newest is None:
        raise ValueError("backup.info lists no backups")
    return newest


def newest_wal(s3, bucket: str, archive_prefix: str) -> datetime:
    """Find when the newest WAL segment was archived.

    pgBackRest stores segments under ``<db-version>-<id>/<timeline+log>/``,
    and both levels sort by hex name, so only the last directory is listed.

    Args:
        s3: S3 client.
        bucket: Bucket name.
        archive_prefix: The stanza's ``archive/<stanza>/`` prefix.

    Returns:
        Last-modified time of the newest segment.

    Raises:
        ValueError: No archived segments were found.
    """
    versions = _prefixes(s3, bucket, archive_prefix)
    if not versions:
        raise ValueError(f"no WAL archive under {archive_prefix}")
    segment_dirs = _prefixes(s3, bucket, versions[-1])
    if not segment_dirs:
        raise ValueError(f"no WAL segments under {versions[-1]}")
    newest: datetime | None = None
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=segment_dirs[-1]):
        for obj in page.get("Contents", []):
            if newest is None or obj["LastModified"] > newest:
                newest = obj["LastModified"]
    if newest is None:
        raise ValueError(f"no WAL segments under {segment_dirs[-1]}")
    return newest


def check(s3, bucket: str, root: str, max_backup_age: timedelta, max_wal_age: timedelta,
          now: datetime) -> list[str]:
    """Check every pgBackRest stanza under ``root``.

    Args:
        s3: S3 client.
        bucket: Bucket name.
        root: Repository path inside the bucket, ending in ``/``.
        max_backup_age: Oldest acceptable newest backup.
        max_wal_age: Oldest acceptable newest WAL segment.
        now: Current time.

    Returns:
        Human-readable problems; empty when everything is fresh.
    """
    problems: list[str] = []
    stanzas = [
        stanza
        for cluster in _prefixes(s3, bucket, root)
        for stanza in _prefixes(s3, bucket, f"{cluster}backup/")
    ]
    if not stanzas:
        return [f"no pgBackRest stanza found under s3://{bucket}/{root}"]
    for backup_prefix in stanzas:
        name = backup_prefix[len(root):].rstrip("/")
        try:
            body = s3.get_object(Bucket=bucket, Key=f"{backup_prefix}backup.info")["Body"].read().decode()
            label, stopped, errored = latest_backup(body)
            age = now - stopped
            print(f"{name}: last backup {label} finished {stopped:%Y-%m-%d %H:%M} UTC ({age.total_seconds() / 3600:.1f}h ago)")
            if errored:
                problems.append(f"{name}: last backup {label} recorded an error")
            if age > max_backup_age:
                problems.append(f"{name}: last backup is {age.total_seconds() / 3600:.0f}h old")

            archive_prefix = backup_prefix.replace("/backup/", "/archive/", 1)
            wal_at = newest_wal(s3, bucket, archive_prefix)
            wal_age = now - wal_at
            print(f"{name}: newest WAL archived {wal_at:%Y-%m-%d %H:%M} UTC ({wal_age.total_seconds() / 60:.0f}m ago)")
            if wal_age > max_wal_age:
                problems.append(f"{name}: no WAL archived for {wal_age.total_seconds() / 60:.0f} minutes")
        except (ValueError, KeyError, s3.exceptions.NoSuchKey) as exc:
            problems.append(f"{name}: could not read the repository ({exc})")
    return problems


def main() -> int:
    """Run the check and print the result.

    Returns:
        Process exit code: 0 when backups are fresh, 1 otherwise.
    """
    bucket = os.environ["BACKUP_S3_BUCKET"]
    root = os.environ.get("BACKUP_S3_PATH", "pgbackrest").strip("/") + "/"
    problems = check(
        _client(),
        bucket,
        root,
        timedelta(hours=float(os.environ.get("BACKUP_MAX_AGE_HOURS", "26"))),
        timedelta(minutes=float(os.environ.get("WAL_MAX_AGE_MINUTES", "60"))),
        datetime.now(UTC),
    )
    for problem in problems:
        print(f"PROBLEM: {problem}")
    if not problems:
        print("Backups are fresh")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
