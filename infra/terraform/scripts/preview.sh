#!/usr/bin/env bash
# PR preview environments (SKY-164). .github/workflows/preview.yml and
# preview-cleanup.yml run this script; an operator runs setup-db once.
#
#   preview.sh claim <pr> <sha>    take a slot (exit 3 when all are taken)
#   preview.sh build <pr> <sha>    build and push the preview images
#   preview.sh deploy <pr> <sha>   migrate, then create or update the services
#   preview.sh delete <pr>         delete everything the preview owns
#   preview.sh list                print "<pr> <sha> <last-push-epoch>" per slot
#   preview.sh setup-db            once, as an operator (skynet profile)
#
# A preview runs in the staging cluster with the staging secrets, task roles
# and security groups. It shares the staging ALB, RDS, Valkey and LiteLLM:
#   https://pr-<n>.<domain>      frontend   (target group skynet-pr-<n>-frontend)
#   https://api-pr-<n>.<domain>  backend    (target group skynet-pr-<n>-backend)
#   services pr-<n>-backend, pr-<n>-worker, pr-<n>-frontend (on-demand FARGATE)
#   database skynet_pr_<n> (copied from skynet_preview_template), Redis DB <slot>
#
# Slots: SSM parameters /skynet/preview/slots/1..4. A PR claims a free slot
# with PutParameter without overwrite, so two PRs never get the same slot.
# The slot picks the Redis DB index and the listener rule priorities, and it
# holds the PR's last push time for the 48-hour cleanup.
#
# The tasks get the staging REMOTE_DB_URL and REDIS_URL. A wrapper command
# points them at the preview database and Redis DB before the app starts, so
# no secret passes through this script or the task definition.

source "$(dirname "$0")/lib.sh"
need aws jq

env=staging
max_slots=4
slot_prefix=/skynet/preview/slots
repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"

cmd="${1:-}"
pr="${2:-}"
sha="${3:-}"

check_pr() {
  [[ "$pr" =~ ^[1-9][0-9]{0,5}$ ]] || die "PR number must be a positive integer"
}

check_sha() {
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "third argument must be a full git SHA"
}

preview_config() {
  aws ssm get-parameter --name "/skynet/$env/preview" --query Parameter.Value --output text
}

# Prints one JSON object per held slot: {"slot":k,"pr":n,"sha":"...","at":epoch}.
slots() {
  local names=() k
  for ((k = 1; k <= max_slots; k++)); do names+=("$slot_prefix/$k"); done
  aws ssm get-parameters --names "${names[@]}" --query 'Parameters[].[Name,Value]' --output json |
    jq -c '.[] | (.[1] | fromjson) + {slot: (.[0] | split("/") | last | tonumber)}'
}

slot_of() {
  slots | jq -r --argjson pr "$1" 'select(.pr == $pr) | .slot' | sed -n 1p
}

slot_value() {
  jq -cn --argjson pr "$pr" --arg sha "$sha" --argjson at "$(date +%s)" '{pr: $pr, sha: $sha, at: $at}'
}

claim() {
  check_pr
  check_sha
  local k err
  k="$(slot_of "$pr")"
  if [[ -n "$k" ]]; then
    aws ssm put-parameter --name "$slot_prefix/$k" --type String --overwrite --value "$(slot_value)" >/dev/null
    echo "PR $pr keeps slot $k"
    return 0
  fi
  for ((k = 1; k <= max_slots; k++)); do
    if err="$(aws ssm put-parameter --name "$slot_prefix/$k" --type String --value "$(slot_value)" 2>&1 >/dev/null)"; then
      echo "PR $pr took slot $k"
      return 0
    fi
    [[ "$err" == *ParameterAlreadyExists* ]] || die "cannot claim slot $k: $err"
  done
  echo "all $max_slots preview slots are taken"
  exit 3
}

ecr_uri() {
  aws ecr describe-repositories --repository-names "skynet/preview-$1" \
    --query 'repositories[0].repositoryUri' --output text
}

build() {
  check_pr
  check_sha
  need docker
  local cfg domain tag backend frontend
  cfg="$(preview_config)"
  domain="$(jq -r .domain <<<"$cfg")"
  tag="$sha-pr-$pr"
  backend="$(ecr_uri backend)"
  frontend="$(ecr_uri frontend)"
  aws ecr get-login-password | docker login --username AWS --password-stdin "${backend%%/*}" >/dev/null

  if aws ecr describe-images --repository-name skynet/preview-backend --image-ids "imageTag=$tag" >/dev/null 2>&1; then
    echo "skip: $backend:$tag exists"
  else
    docker buildx build --platform linux/arm64 --provenance=false \
      -t "$backend:$tag" --push --build-arg "GIT_SHA=$sha" "$repo_root/backend"
  fi

  # Next.js bakes NEXT_PUBLIC_* into the bundle, so each PR gets its own build.
  if aws ecr describe-images --repository-name skynet/preview-frontend --image-ids "imageTag=$tag" >/dev/null 2>&1; then
    echo "skip: $frontend:$tag exists"
  else
    docker buildx build --platform linux/arm64 --provenance=false \
      -t "$frontend:$tag" --push \
      --build-arg "NEXT_PUBLIC_SITE_URL=https://pr-$pr.$domain" \
      --build-arg "NEXT_PUBLIC_SENTRY_DSN=${NEXT_PUBLIC_SENTRY_DSN:-}" \
      --build-arg "NEXT_PUBLIC_SENTRY_ENVIRONMENT=skynet-pr-$pr" \
      --build-arg "NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE=${NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE:-}" \
      --build-arg "NEXT_PUBLIC_FEATURE_GENERALIST_AGENT=${NEXT_PUBLIC_FEATURE_GENERALIST_AGENT:-}" \
      --build-arg "APP_GIT_SHA=$sha" \
      --build-arg "APP_ENVIRONMENT=skynet-pr-$pr" \
      "$repo_root/frontend"
  fi
  echo "pushed: preview-backend:$tag preview-frontend:$tag"
}

# Runs before the app in the backend, worker and migrate containers. The
# shape checks stop a preview from ever using the staging database or Redis
# DB 0 if the generated URLs change form.
read -r -d '' url_wrapper <<'SH' || true
set -eu
case "$REMOTE_DB_URL" in */skynet\?*) ;; *) echo "preview: unexpected REMOTE_DB_URL form" >&2; exit 1 ;; esac
case "$REDIS_URL" in */0) ;; *) echo "preview: unexpected REDIS_URL form" >&2; exit 1 ;; esac
case "$PREVIEW_REDIS_DB" in [1-9]) ;; *) echo "preview: bad PREVIEW_REDIS_DB" >&2; exit 1 ;; esac
REMOTE_DB_URL="${REMOTE_DB_URL%/skynet\?*}/$PREVIEW_DB?${REMOTE_DB_URL##*\?}"
REDIS_URL="${REDIS_URL%/0}/$PREVIEW_REDIS_DB"
export REMOTE_DB_URL REDIS_URL
exec "$@"
SH

# The migrate container first creates the preview database, connected to the
# staging database as skynet_app (setup-db gave it CREATEDB). The connection
# limit keeps a preview from using up the shared RDS connections.
read -r -d '' create_db <<'SH' || true
set -eu
python - <<'PY'
import os

import psycopg2
from psycopg2 import sql

name = os.environ["PREVIEW_DB"]
conn = psycopg2.connect(os.environ["REMOTE_DB_URL"])
conn.autocommit = True
cur = conn.cursor()
cur.execute("SELECT 1 FROM pg_database WHERE datname = %s", (name,))
if cur.fetchone() is None:
    cur.execute(sql.SQL("CREATE DATABASE {} TEMPLATE skynet_preview_template CONNECTION LIMIT 20").format(sql.Identifier(name)))
    cur.execute(sql.SQL("REVOKE ALL ON DATABASE {} FROM PUBLIC").format(sql.Identifier(name)))
    print(f"created database {name}")
PY
SH

# Delete: drop the database and empty the PR's Redis DB. It runs with the
# raw staging URLs, so it checks the Redis DB index itself.
read -r -d '' drop_db <<'SH' || true
set -eu
python - <<'PY'
import os

import psycopg2
import redis
from psycopg2 import sql

name = os.environ["PREVIEW_DB"]
slot = int(os.environ["PREVIEW_REDIS_DB"])
conn = psycopg2.connect(os.environ["REMOTE_DB_URL"])
conn.autocommit = True
conn.cursor().execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(name)))
print(f"dropped database {name}")
url = os.environ["REDIS_URL"]
if not 1 <= slot <= 9 or not url.endswith("/0"):
    raise SystemExit("preview: refusing to flush this Redis DB")
redis.Redis.from_url(url.removesuffix("/0") + f"/{slot}").flushdb()
print(f"flushed Redis DB {slot}")
PY
SH

account() {
  aws sts get-caller-identity --query Account --output text
}

# Prints the newest ACTIVE staging revision of a family whose roles are the
# staging roles for that family and whose tag is Environment=staging (the
# same rule as deploy.sh).
staging_revision() {
  local key="$1" family="$2" acct="$3" arn roles want
  want="arn:aws:iam::$acct:role/skynet-$env-$key-exec"$'\t'"arn:aws:iam::$acct:role/skynet-$env-$key-task"$'\t'"$env"
  for arn in $(aws ecs list-task-definitions --family-prefix "$family" --status ACTIVE \
    --sort DESC --max-items 20 --query 'taskDefinitionArns[]' --output text); do
    [[ "${arn##*/}" == "$family:"* ]] || continue
    roles="$(aws ecs describe-task-definition --task-definition "$arn" --include TAGS \
      --query "[taskDefinition.executionRoleArn, taskDefinition.taskRoleArn, tags[?key=='Environment'].value | [0]]" --output text)"
    if [[ "$roles" == "$want" ]]; then
      echo "$arn"
      return 0
    fi
  done
  die "no revision of $family with the $env roles and tag in the 20 newest"
}

# Registers skynet-pr-<n>-<key> from the staging revision and prints its ARN.
# Args: key image env-json slot cfg acct
register() {
  local key="$1" image="$2" env_json="$3" slot="$4" cfg="$5" acct="$6" src td args
  src="$(staging_revision "$key" "$(jq -r --arg k "$key" '.families[$k]' <<<"$cfg")" "$acct")"
  td="$(aws ecs describe-task-definition --task-definition "$src" --query taskDefinition --output json)"
  args='null'
  if [[ "$key" != frontend ]]; then
    # The wrapper runs the command the container would run without it.
    args="$(jq -c '.containerDefinitions[0].command // empty' <<<"$td")"
    [[ -n "$args" ]] || args="$(sed -n 's/^CMD //p' "$repo_root/backend/Dockerfile" | tail -n1 | jq -c .)"
    if [[ "$key" == migrate ]]; then
      args="$(jq -c --arg w "$create_db"$'\n'"$url_wrapper" '["sh", "-c", $w, "preview"] + .' <<<"$args")"
    else
      args="$(jq -c --arg w "$url_wrapper" '["sh", "-c", $w, "preview"] + .' <<<"$args")"
    fi
    env_json="$(jq -c --arg db "skynet_pr_$pr" --arg slot "$slot" '. + {PREVIEW_DB: $db, PREVIEW_REDIS_DB: $slot}' <<<"$env_json")"
  fi
  td="$(jq --arg family "skynet-pr-$pr-$key" --arg img "$image" --argjson env "$env_json" --argjson cmd "$args" \
    --arg group "$(jq -r .log_group <<<"$cfg")" --arg prefix "pr-$pr" '
      .family = $family
      | .containerDefinitions[0].image = $img
      | .containerDefinitions[0].environment =
          ([.containerDefinitions[0].environment[] | select(.name as $n | $env | has($n) | not)]
           + ($env | to_entries | map({name: .key, value: .value})))
      | .containerDefinitions[0].secrets |= map(select(.name as $n | $env | has($n) | not))
      | .containerDefinitions[0].logConfiguration.options["awslogs-group"] = $group
      | .containerDefinitions[0].logConfiguration.options["awslogs-stream-prefix"] = $prefix
      | (if $cmd == null then . else .containerDefinitions[0].command = $cmd end)
      | .tags = [{key: "Environment", value: "preview"}, {key: "Project", value: "skynet"}, {key: "ManagedBy", value: "preview.sh"}]
      | del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities,
            .registeredAt, .registeredBy, .deregisteredAt)' <<<"$td")"
  td="$(aws ecs register-task-definition --cli-input-json "$td" \
    --query taskDefinition.taskDefinitionArn --output text)"
  echo "registered $td" >&2
  echo "$td"
}

network_config() {
  local cfg="$1" key="$2"
  jq -r --arg k "$key" '"awsvpcConfiguration={subnets=[\(.subnets | join(","))],securityGroups=[\(.security_groups[$k])],assignPublicIp=\(if .assign_public_ip then "ENABLED" else "DISABLED" end)}"' <<<"$cfg"
}

wait_task() {
  local cluster="$1" arn="$2" i status code reason
  for ((i = 0; i < 180; i++)); do
    status="$(aws ecs describe-tasks --cluster "$cluster" --tasks "$arn" --query 'tasks[0].lastStatus' --output text)"
    [[ "$status" == "STOPPED" ]] && break
    sleep 10
  done
  [[ "$status" == "STOPPED" ]] || die "task $arn still $status after 30 minutes"
  code="$(aws ecs describe-tasks --cluster "$cluster" --tasks "$arn" --query 'tasks[0].containers[0].exitCode' --output text)"
  reason="$(aws ecs describe-tasks --cluster "$cluster" --tasks "$arn" --query 'tasks[0].stoppedReason' --output text)"
  [[ "$code" == "0" ]] || die "task $arn failed (exit=$code, reason=$reason). Logs: CloudWatch /ecs/skynet-$env/preview, streams pr-$pr/*"
}

run_migrate_task() {
  local cfg="$1" td="$2" overrides="${3:-}" cluster arn args
  cluster="$(jq -r .cluster <<<"$cfg")"
  args=(
    --cluster "$cluster" --task-definition "$td" --launch-type FARGATE
    --network-configuration "$(network_config "$cfg" migrate)"
    --query 'tasks[0].taskArn' --output text
  )
  [[ -z "$overrides" ]] || args+=(--overrides "$overrides")
  arn="$(aws ecs run-task "${args[@]}")"
  [[ "$arn" == arn:* ]] || die "run-task did not start a task"
  wait_task "$cluster" "$arn"
}

# Prints the target group ARN, creating the group when it is missing.
target_group() {
  local cfg="$1" key="$2" path="$3" arn
  arn="$(aws elbv2 create-target-group --name "skynet-pr-$pr-$key" --protocol HTTP \
    --port "$(jq -r --arg k "$key" '.ports[$k]' <<<"$cfg")" --target-type ip \
    --vpc-id "$(jq -r .vpc_id <<<"$cfg")" --health-check-path "$path" --matcher HttpCode=200 \
    --health-check-interval-seconds 15 --health-check-timeout-seconds 10 \
    --healthy-threshold-count 2 --unhealthy-threshold-count 4 \
    --tags Key=Environment,Value=preview Key=Project,Value=skynet Key=ManagedBy,Value=preview.sh \
    --query 'TargetGroups[0].TargetGroupArn' --output text)"
  aws elbv2 modify-target-group-attributes --target-group-arn "$arn" \
    --attributes Key=deregistration_delay.timeout_seconds,Value=30 >/dev/null
  echo "$arn"
}

# Prints the ARN of the listener rule for a host, or nothing.
rule_for() {
  local listener="$1" host="$2"
  aws elbv2 describe-rules --listener-arn "$listener" --output json |
    jq -r --arg h "$host" '.Rules[] | select(any(.Conditions[]?; .Field == "host-header" and (.Values // [] | index($h)))) | .RuleArn' |
    sed -n 1p
}

route() {
  local listener="$1" host="$2" tg="$3" priority="$4" arn
  arn="$(rule_for "$listener" "$host")"
  if [[ -n "$arn" ]]; then
    aws elbv2 modify-rule --rule-arn "$arn" --actions "Type=forward,TargetGroupArn=$tg" >/dev/null
  else
    aws elbv2 create-rule --listener-arn "$listener" --priority "$priority" \
      --conditions "Field=host-header,Values=$host" --actions "Type=forward,TargetGroupArn=$tg" \
      --tags Key=Environment,Value=preview Key=Project,Value=skynet Key=ManagedBy,Value=preview.sh >/dev/null
  fi
  echo "routing $host"
}

service_active() {
  [[ "$(aws ecs describe-services --cluster "$1" --services "$2" \
    --query 'services[0].status' --output text 2>/dev/null)" == "ACTIVE" ]]
}

# Args: cfg key td [target-group-arn port]
upsert_service() {
  local cfg="$1" key="$2" td="$3" tg="${4:-}" port="${5:-}" cluster name args
  cluster="$(jq -r .cluster <<<"$cfg")"
  name="pr-$pr-$key"
  if service_active "$cluster" "$name"; then
    aws ecs update-service --cluster "$cluster" --service "$name" --task-definition "$td" >/dev/null
    echo "updating $name"
    return 0
  fi
  args=(
    --cluster "$cluster" --service-name "$name" --task-definition "$td" --desired-count 1
    --capacity-provider-strategy "capacityProvider=FARGATE,weight=1" --platform-version LATEST
    --network-configuration "$(network_config "$cfg" "$key")"
    --deployment-configuration "deploymentCircuitBreaker={enable=true,rollback=true},maximumPercent=200,minimumHealthyPercent=100"
    --propagate-tags SERVICE
    --tags "key=Environment,value=preview" "key=Project,value=skynet" "key=ManagedBy,value=preview.sh"
  )
  if [[ -n "$tg" ]]; then
    args+=(--load-balancers "targetGroupArn=$tg,containerName=$key,containerPort=$port" --health-check-grace-period-seconds 180)
  fi
  aws ecs create-service "${args[@]}" >/dev/null
  echo "creating $name"
}

# Waits until the newest deployment of each service completes. Fails at once
# when ECS marks one FAILED (the circuit breaker gave up).
wait_services() {
  local cluster="$1" i states
  shift
  for ((i = 0; i < 120; i++)); do
    states="$(aws ecs describe-services --cluster "$cluster" --services "$@" --output json |
      jq -r '[.services[] | (.deployments[] | select(.status == "PRIMARY") | .rolloutState)] | join(" ")')"
    [[ "$states" == *FAILED* ]] && die "a preview service failed to start ($states). See the ECS service events."
    [[ "$states" =~ ^(COMPLETED ?)+$ ]] && return 0
    sleep 15
  done
  die "preview services not stable after 30 minutes ($states)"
}

deploy() {
  check_pr
  check_sha
  local cfg slot acct domain app api tag backend_img frontend_img app_env backend_env frontend_env
  local migrate_td listener cluster tg_backend tg_frontend
  slot="$(slot_of "$pr")"
  [[ -n "$slot" ]] || die "PR $pr holds no preview slot; run claim first"
  cfg="$(preview_config)"
  acct="$(account)"
  domain="$(jq -r .domain <<<"$cfg")"
  app="pr-$pr.$domain"
  api="api-pr-$pr.$domain"
  tag="$sha-pr-$pr"
  backend_img="$(ecr_uri backend):$tag"
  frontend_img="$(ecr_uri frontend):$tag"
  app_env="skynet-pr-$pr"

  backend_env="$(jq -cn --arg e "$app_env" --arg sha "$sha" --arg app "https://$app" '{
    APP_ENVIRONMENT: $e, APP_GIT_SHA: $sha, SENTRY_ENVIRONMENT: $e, ALERT_ENVIRONMENT: $e,
    ALLOWED_ORIGINS: $app, APP_PUBLIC_URL: $app, FRONTEND_URL: $app,
    DB_POOL_SIZE: "3", DB_POOL_MAX_OVERFLOW: "2"}')"
  frontend_env="$(jq -cn --arg e "$app_env" --arg sha "$sha" --arg app "https://$app" --arg api "https://$api" '{
    APP_ENVIRONMENT: $e, APP_GIT_SHA: $sha, SENTRY_ENVIRONMENT: $e, NEXT_PUBLIC_SENTRY_ENVIRONMENT: $e,
    API_URL: $api, NEXT_PUBLIC_API_URL: $api, NEXT_PUBLIC_SITE_URL: $app, AUTH_URL: $app}')"

  migrate_td="$(register migrate "$backend_img" "$backend_env" "$slot" "$cfg" "$acct")"
  echo "creating the database if needed, then migrating"
  run_migrate_task "$cfg" "$migrate_td"
  echo "migration ok"

  listener="$(jq -r .listener_arn <<<"$cfg")"
  cluster="$(jq -r .cluster <<<"$cfg")"
  tg_backend="$(target_group "$cfg" backend /health)"
  tg_frontend="$(target_group "$cfg" frontend /api/version)"
  route "$listener" "$api" "$tg_backend" $((100 + 2 * slot))
  route "$listener" "$app" "$tg_frontend" $((101 + 2 * slot))

  upsert_service "$cfg" backend \
    "$(register backend "$backend_img" "$(jq -c --arg app "$app" '. + {WEBAUTHN_RP_ID: $app, WEBAUTHN_ORIGINS: .ALLOWED_ORIGINS}' <<<"$backend_env")" "$slot" "$cfg" "$acct")" \
    "$tg_backend" "$(jq -r .ports.backend <<<"$cfg")"
  upsert_service "$cfg" worker "$(register worker "$backend_img" "$backend_env" "$slot" "$cfg" "$acct")"
  upsert_service "$cfg" frontend "$(register frontend "$frontend_img" "$frontend_env" "$slot" "$cfg" "$acct")" \
    "$tg_frontend" "$(jq -r .ports.frontend <<<"$cfg")"

  echo "waiting for the preview services"
  wait_services "$cluster" "pr-$pr-backend" "pr-$pr-worker" "pr-$pr-frontend"
  echo "preview of PR $pr is live: https://$app (API https://$api)"
}

delete() {
  check_pr
  local cfg cluster listener slot s arn names=() fam tds batch repo tags migrate_td host
  cfg="$(preview_config)"
  cluster="$(jq -r .cluster <<<"$cfg")"
  listener="$(jq -r .listener_arn <<<"$cfg")"
  slot="$(slot_of "$pr")"

  for s in backend worker frontend; do
    if service_active "$cluster" "pr-$pr-$s"; then
      aws ecs delete-service --cluster "$cluster" --service "pr-$pr-$s" --force >/dev/null
      names+=("pr-$pr-$s")
      echo "deleting service pr-$pr-$s"
    fi
  done
  if ((${#names[@]} > 0)); then
    aws ecs wait services-inactive --cluster "$cluster" --services "${names[@]}"
  fi

  for host in "api-pr-$pr" "pr-$pr"; do
    arn="$(rule_for "$listener" "$host.$(jq -r .domain <<<"$cfg")")"
    if [[ -n "$arn" ]]; then
      aws elbv2 delete-rule --rule-arn "$arn"
      echo "deleted the rule for $host"
    fi
  done

  for s in backend frontend; do
    arn="$(aws elbv2 describe-target-groups --names "skynet-pr-$pr-$s" \
      --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || true)"
    if [[ "$arn" == arn:* ]]; then
      aws elbv2 delete-target-group --target-group-arn "$arn"
      echo "deleted target group skynet-pr-$pr-$s"
    fi
  done

  # The newest migrate revision carries the database name and Redis DB.
  migrate_td="$(aws ecs list-task-definitions --family-prefix "skynet-pr-$pr-migrate" --status ACTIVE \
    --sort DESC --max-items 1 --query 'taskDefinitionArns[0]' --output text)"
  if [[ "$migrate_td" == arn:* ]]; then
    echo "dropping database skynet_pr_$pr"
    run_migrate_task "$cfg" "$migrate_td" \
      "$(jq -cn --arg s "$drop_db" '{containerOverrides: [{name: "migrate", command: ["sh", "-c", $s]}]}')"
  fi

  for fam in backend worker frontend migrate; do
    for arn in $(aws ecs list-task-definitions --family-prefix "skynet-pr-$pr-$fam" --status ACTIVE \
      --query 'taskDefinitionArns[]' --output text); do
      [[ "${arn##*/}" == "skynet-pr-$pr-$fam:"* ]] || continue
      aws ecs deregister-task-definition --task-definition "$arn" >/dev/null
    done
    tds="$(aws ecs list-task-definitions --family-prefix "skynet-pr-$pr-$fam" --status INACTIVE --output json |
      jq -c --arg f "skynet-pr-$pr-$fam:" '[.taskDefinitionArns[] | select(split("/") | last | startswith($f))]')"
    while [[ "$(jq length <<<"$tds")" -gt 0 ]]; do
      mapfile -t batch < <(jq -r '.[:10][]' <<<"$tds")
      aws ecs delete-task-definitions --task-definitions "${batch[@]}" >/dev/null
      tds="$(jq -c '.[10:]' <<<"$tds")"
    done
  done
  echo "deleted the task definitions"

  for repo in skynet/preview-backend skynet/preview-frontend; do
    tags="$(aws ecr list-images --repository-name "$repo" --filter tagStatus=TAGGED --output json |
      jq -c --arg sfx "-pr-$pr" '[.imageIds[] | select(.imageTag | endswith($sfx)) | {imageTag}]')"
    while [[ "$(jq length <<<"$tags")" -gt 0 ]]; do
      aws ecr batch-delete-image --repository-name "$repo" --image-ids "$(jq -c '.[:100]' <<<"$tags")" >/dev/null
      tags="$(jq -c '.[100:]' <<<"$tags")"
    done
  done
  echo "deleted the images"

  # Last, so a failed delete keeps the slot and the next run retries.
  if [[ -n "$slot" ]]; then
    aws ssm delete-parameter --name "$slot_prefix/$slot"
    echo "released slot $slot"
  fi
  echo "preview of PR $pr deleted"
}

list() {
  slots | jq -r '"\(.pr) \(.sha) \(.at)"'
}

# Once per environment, as an operator: lets skynet_app create the preview
# databases, and makes the template they copy (with pgvector, which only the
# master may create). Runs as the dbadmin task, like create-db-roles.sh.
setup_db() {
  local script overrides task
  read -r -d '' script <<'SH' || true
set -eu
psql -v ON_ERROR_STOP=1 <<'SQL'
ALTER ROLE skynet_app CREATEDB;
SELECT 'CREATE DATABASE skynet_preview_template OWNER skynet_app' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'skynet_preview_template') \gexec
REVOKE ALL ON DATABASE skynet_preview_template FROM PUBLIC;
SQL
psql -v ON_ERROR_STOP=1 -d skynet_preview_template -c 'CREATE EXTENSION IF NOT EXISTS vector'
psql -v ON_ERROR_STOP=1 -c 'ALTER DATABASE skynet_preview_template IS_TEMPLATE true'
echo "skynet_app may create databases; skynet_preview_template is ready"
SH
  overrides="$(jq -n --arg s "$script" '{containerOverrides: [{name: "dbadmin", command: ["sh", "-c", $s]}]}')"
  task="$(run_task "$env" dbadmin "$overrides")"
  echo "started $task"
  wait_task_ok "$env" "$task"
  echo "done. Output: CloudWatch log group /ecs/skynet-$env/dbadmin"
}

case "$cmd" in
  claim) claim ;;
  build) build ;;
  deploy) deploy ;;
  delete) delete ;;
  list) list ;;
  setup-db) setup_db ;;
  *) die "usage: preview.sh claim|build|deploy <pr> <sha> | delete <pr> | list | setup-db" ;;
esac
