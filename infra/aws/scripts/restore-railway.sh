#!/usr/bin/env bash
# Restores the Railway pg_dump backups (custom format) into RDS.
#
#   1. In one terminal:     infra/aws/scripts/db-tunnel.sh <env>
#   2. In another terminal: infra/aws/scripts/restore-railway.sh <env> [backup-dir] [local-port=15432]
#
# backup-dir defaults to ~/Library/Application Support/Skynet Backups/railway-2026-10-21
# and must hold <env>-Postgres.dump (app) and <env>-Postgres-ZPeG.dump (litellm).
# Run create-litellm-db.sh first. Restore into empty databases only: run this
# before the first migration and before the services start.
#
# Needs pg_restore 18 (the dumps come from pg_dump 18.6):
#   brew install postgresql@18 && export PATH="/opt/homebrew/opt/postgresql@18/bin:$PATH"

source "$(dirname "$0")/lib.sh"
need aws jq pg_restore psql shasum

env="${1:-}"
dir="${2:-$HOME/Library/Application Support/Skynet Backups/railway-2026-10-21}"
port="${3:-15432}"
check_env "$env"

major="$(pg_restore --version | sed -E 's/.* ([0-9]+)\..*/\1/')"
((major >= 18)) || die "pg_restore $major cannot read pg_dump 18 archives; install postgresql@18"

app_dump="$dir/$env-Postgres.dump"
llm_dump="$dir/$env-Postgres-ZPeG.dump"
for f in "$app_dump" "$llm_dump"; do
  [[ -f "$f" ]] || die "missing $f"
done
(cd "$dir" && grep -E " ($env-Postgres.dump|$env-Postgres-ZPeG.dump)\$" SHA256SUMS | shasum -a 256 -c -) ||
  die "checksum mismatch in $dir"

secret() {
  aws secretsmanager get-secret-value --secret-id "$1" --query SecretString --output text
}

export PGHOST=127.0.0.1 PGPORT="$port" PGSSLMODE=require
admin="$(secret "skynet/$env/db-admin")"
llm="$(secret "skynet/$env/litellm-generated")"

# Non-superusers on RDS cannot COMMENT ON EXTENSION; drop those entries.
restore() {
  local dump="$1" db="$2" user="$3" pw="$4" list
  list="$(mktemp)"
  pg_restore -l "$dump" | grep -v 'COMMENT - EXTENSION' >"$list"
  echo "restoring $(basename "$dump") into $db as $user"
  PGUSER="$user" PGPASSWORD="$pw" PGDATABASE="$db" pg_restore \
    --dbname="$db" --no-owner --no-acl --single-transaction --exit-on-error \
    --use-list="$list" "$dump"
  PGUSER="$user" PGPASSWORD="$pw" psql -d "$db" -v ON_ERROR_STOP=1 -qc 'ANALYZE;'
  rm -f "$list"
}

restore "$app_dump" skynet "$(jq -r .PGUSER <<<"$admin")" "$(jq -r .PGPASSWORD <<<"$admin")"
restore "$llm_dump" litellm litellm "$(jq -r .LITELLM_DB_PASSWORD <<<"$llm")"

echo "row counts (compare with $env-Postgres.info.json):"
PGUSER="$(jq -r .PGUSER <<<"$admin")" PGPASSWORD="$(jq -r .PGPASSWORD <<<"$admin")" psql -d skynet -Atc \
  "SELECT 'users=' || count(*) FROM users UNION ALL SELECT 'jobs=' || count(*) FROM jobs;"
echo "next: infra/aws/scripts/deploy.sh $env <sha> --migrate-only"
