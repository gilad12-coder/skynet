#!/usr/bin/env bash
# Restore drill for the Infisical database. It restores the latest restorable
# time (point-in-time) to a temporary instance, checks that it is available
# and encrypted with the Infisical KMS key, then deletes it. Production data
# is not touched. Cost: about $0.02 per drill hour (db.t4g.micro).
#
#   infra/terraform/scripts/infisical-restore-drill.sh
#
# The temporary instance has no public access and uses the isolated subnets
# and the Postgres security group. To test a login, open the Infisical
# tunnel task and connect from it; this script does not read the password.

source "$(dirname "$0")/lib.sh"
source "$(dirname "$0")/infisical-lib.sh"
need aws jq

cfg="$(infisical_config)"
src="$(jq -r .db_instance <<<"$cfg")"
subnet_group="$(jq -r .db_subnet_group <<<"$cfg")"
sg="$(jq -r .postgres_sg <<<"$cfg")"
kms="$(jq -r .kms_key_arn <<<"$cfg")"
drill="${src}-drill-$(date -u +%Y%m%d%H%M)"

latest="$(aws rds describe-db-instances --db-instance-identifier "$src" \
  --query 'DBInstances[0].LatestRestorableTime' --output text)"
echo "restoring $src at $latest to $drill"
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier "$src" \
  --target-db-instance-identifier "$drill" \
  --use-latest-restorable-time \
  --db-instance-class db.t4g.micro \
  --db-subnet-group-name "$subnet_group" \
  --vpc-security-group-ids "$sg" \
  --no-publicly-accessible \
  --no-multi-az \
  --no-deletion-protection \
  --tags Key=Project,Value=skynet Key=Environment,Value=infisical Key=Purpose,Value=restore-drill \
  --query DBInstance.DBInstanceIdentifier --output text >/dev/null
trap 'echo "deleting $drill"; aws rds delete-db-instance --db-instance-identifier "$drill" --skip-final-snapshot --delete-automated-backups --query DBInstance.DBInstanceStatus --output text || echo "DELETE FAILED: delete $drill by hand"' EXIT

echo "waiting until $drill is available (10-20 minutes)"
aws rds wait db-instance-available --db-instance-identifier "$drill"
info="$(aws rds describe-db-instances --db-instance-identifier "$drill" --output json | jq '.DBInstances[0]')"
jq -r '"status=\(.DBInstanceStatus) engine=\(.Engine) \(.EngineVersion) encrypted=\(.StorageEncrypted) public=\(.PubliclyAccessible)"' <<<"$info"
[[ "$(jq -r .StorageEncrypted <<<"$info")" == "true" ]] || die "restored instance is not encrypted"
[[ "$(jq -r .KmsKeyId <<<"$info")" == "$kms" ]] || die "restored instance uses another KMS key"
[[ "$(jq -r .PubliclyAccessible <<<"$info")" == "false" ]] || die "restored instance is public"
echo "drill passed: the latest backup restores to an encrypted private instance"
