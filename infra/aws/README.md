# Skynet on AWS (SKY-156)

Terraform for Skynet on AWS: ECS on Fargate (ARM64 / Graviton), RDS PostgreSQL 18,
ElastiCache Valkey, ALB with ACM, Secrets Manager, ECR and CloudWatch.
Region: `us-east-2`. AWS CLI profile: `skynet`.

Nobody ran `terraform apply` yet. Read-only plans of every stack pass (see
"Plan" below). The first apply needs Gilad's approval through the orchestrator.

## Account prerequisites

- The `skynet` account is on the AWS **paid plan** (`aws freetier
  get-account-plan-state` shows `PAID` / `ACTIVE`, 2026-10-21). Set a spend
  limit in AWS Settings before the first apply.
- "Advanced AWS features" are on, so the managed SCP no longer denies
  `iam:*Provider*`. A read-only `aws iam list-open-id-connect-providers` works
  and returns an empty list. `global` creates the GitHub Actions OIDC provider
  and the deploy role (`enable_github_oidc` defaults to `true`).

## Layout

| Path | Stack | Creates |
|------|-------|---------|
| `bootstrap/` | local state | The S3 state bucket (versioned, encrypted, TLS only). |
| `global/` | `global/terraform.tfstate` | ECR repos `skynet/backend`, `skynet/frontend`, `skynet/litellm`. GitHub OIDC provider and the `skynet-github-deploy` role (`enable_github_oidc`, default `true`). |
| `environments/staging/` | `staging/terraform.tfstate` | One environment from `modules/environment`. Sizing in `terraform.tfvars` (lean) and `full.tfvars`. |
| `environments/production/` | `production/terraform.tfstate` | The same module. Sizing in `terraform.tfvars` (lean) and `full.tfvars`. |
| `modules/environment/` | module | VPC, ALB, ACM, ECS cluster, services, task definitions, RDS, Valkey, secrets, logs, alarms. |
| `scripts/` | shell | Build and push, deploy (migrate first), secrets, litellm database, DB tunnel, Railway restore. |

Remote state uses the S3 backend with native S3 locking (`use_lockfile = true`).
There is no DynamoDB table.

### One environment

- VPC with 2 AZs: public subnets (ALB, NAT), private subnets (tasks), isolated
  subnets (RDS, Valkey, no internet route). S3 gateway endpoint. VPC flow logs.
  With `egress_mode = "public_ip"` the tasks run in the public subnets instead
  and there is no NAT gateway.
- ALB: HTTP redirects to HTTPS. Idle timeout 120 s (Railway SSE streams need >= 60 s).
  The API host goes to the backend. Every other host goes to the frontend.
- ECS services: `backend` (8080), `worker`, `frontend` (3001), `litellm` (4000).
  The backend and the worker reach litellm at `litellm.<env>.skynet.internal:4000`
  (Cloud Map). ECS Exec is on. Deployment circuit breaker with rollback is on.
- One-off task families: `migrate` (`python manage.py migrate`) and `dbadmin`
  (psql tools, for the litellm database, the tunnel and the restore).
- RDS PostgreSQL 18.6 (`rds.force_ssl=1`, gp3, encrypted, Performance Insights).
  pgvector is an RDS extension; `create-litellm-db.sh` enables it.
- ElastiCache Valkey 8.1 (TLS, AUTH token). One shared cache for app and litellm,
  as on Railway.
- CloudWatch log group per family. Alarms go to one SNS topic: ALB 5xx, unhealthy
  targets, backend latency, ECS CPU, memory and running < desired, RDS CPU, memory,
  free storage and connections, Valkey CPU and memory, error lines in the logs.

### Choices

- **One RDS instance holds two databases** (`skynet` and `litellm`), with a
  separate owner role for litellm. It saves the cost of a second instance
  (about $25 per month in staging, about $95 in production) and keeps backups and
  maintenance in one place. The databases and roles stay separate, so a split
  later is a `pg_dump` / `pg_restore`.
- **No RDS Proxy and no PgBouncer.** At 2 to 4 app tasks the SQLAlchemy pools stay
  well below `max_connections`. Direct connections keep advisory locks and session
  state unchanged. Add RDS Proxy if the task count grows.
- **Valkey, not Redis OSS.** It is protocol compatible and about 20% cheaper.
- **ARM64 tasks.** Images build natively on Apple silicon.
- **The frontend image is built per environment** (tag `<sha>-staging` or
  `<sha>-production`). Next.js puts `NEXT_PUBLIC_*` values into the bundle.
- Port numbers avoid 3000 and 8000.

## Lean and full variants

Every cost choice is a variable of the environment stack. `terraform.tfvars`
holds the **lean** variant and Terraform loads it automatically. `full.tfvars`
holds the **full** variant. To scale up, add `-var-file=full.tfvars` to every
`plan` and `apply`, or copy single values into `terraform.tfvars`. No `.tf`
file changes.

| Variable | Staging lean | Staging full | Production lean | Production full |
|----------|--------------|--------------|-----------------|-----------------|
| `egress_mode` | `public_ip` (no NAT) | `nat_single` | `nat_single` | `nat_per_az` |
| `db_instance_class` / `db_multi_az` | db.t4g.small / false | db.t4g.small / false | db.t4g.small / false | db.t4g.medium / true |
| `cache_node_count` | 1 | 1 | 1 | 2 (failover) |
| backend | 1 x 0.5 vCPU / 3 GB, Spot | 1 x 0.5 / 3 GB | 1 x 0.5 / 3 GB | 2 x 1 / 2 GB |
| worker | 1 x 0.5 / 3 GB, Spot | 1 x 0.5 / 3 GB | 1 x 0.5 / 3 GB | 2 x 1 / 2 GB |
| frontend | 1 x 0.25 / 0.5 GB, Spot | 1 x 0.25 / 0.5 GB | 1 x 0.25 / 1 GB | 2 x 0.5 / 1 GB |
| litellm | 1 x 0.5 / 3 GB, Spot | 1 x 0.5 / 3 GB | 1 x 0.5 / 3 GB | 2 x 0.5 / 2 GB |

Railway ran backend 3, worker 3, frontend 2 and litellm 2 replicas in
production. Their summed memory was backend 1.6 GB, worker 1.3 GB, litellm
1.3 GB and frontend 0.3 GB, and staging CPU stayed below 0.02 vCPU. One task
per service carries that load. A second task buys availability, not capacity.
`backend` and `frontend` still scale out to 3 tasks on CPU (target 60%).
The worker queue (`FOR UPDATE SKIP LOCKED`) lets more workers join at any time.

What each lean cut costs in availability:

| Cut | Saves per month | Availability trade-off |
|-----|-----------------|------------------------|
| 1 task per service, 0.5 vCPU tasks (production) | ~$111 | A task crash or an AZ outage stops that service for 1-3 minutes until ECS starts a replacement. Deploys stay zero-downtime. A single litellm task stops all LLM calls while it restarts. |
| Single-AZ RDS (production) | ~$73 with the class change | An instance failure or OS patch means minutes of database downtime. An AZ outage means a point-in-time restore into the other AZ (about 30-60 minutes, up to 5 minutes of writes lost). Deletion protection and 14-day backups stay. |
| db.t4g.small in place of medium (production) | included above | 2 GB RAM, about 200 connections. The burstable CPU bills extra credits under sustained load. |
| 1 Valkey node (production) | ~$9 | A node failure loses the cache and stops Valkey for minutes until ElastiCache replaces the node. App sessions and rate limits in Valkey reset. |
| 1 NAT gateway (production) | ~$37 | All egress goes through one AZ. If that AZ fails, tasks in the other AZ lose internet access (LLM providers, Stripe, OAuth). |
| No NAT, public task IPs (staging) | ~$22 net | No availability loss. Tasks have public IPv4 addresses; security groups still accept inbound traffic only from the ALB. Egress IPs change per task, so no third party can allowlist them. |
| Fargate Spot (staging) | ~$46 | AWS may stop a task with a 2-minute warning. A one-task service is down until Spot capacity returns. An interrupted worker job goes through orphan recovery. |

Options that the lean variant does not use:

- `spot = true` on the production worker saves about $14 per month. A Spot stop
  interrupts running optimization jobs; orphan recovery then retries or fails
  them, and the user waits. Not worth $14 for paid customer jobs.
- `egress_mode = "public_ip"` in production saves about $22 per month, at the
  cost of public IPs on production tasks.
- db.t4g.micro (1 GB RAM, about 80 connections) saves about $12 per month. The
  pools allow 40 connections per task, so it is not sensible.
- Interface VPC endpoints do not replace NAT. The tasks call third-party APIs on
  the internet, and 7 endpoints in 2 AZs cost about $100 per month.

Scale-up order when traffic or risk grows: `desired_count = 2` for backend and
frontend (about $28), then `nat_per_az` (about $37), then `db_multi_az = true`
(about $26), then `cache_node_count = 2` (about $9).

Changes apply in place. RDS class and Multi-AZ changes in production wait for
the Sunday maintenance window (`apply_immediately` is false there); add the
change in the console with "apply immediately" if it cannot wait. A
`spot` or `egress_mode` change starts a new deployment of the affected services.

## Secrets

Terraform creates these Secrets Manager secrets per environment. The task
definitions read single JSON keys by ARN (`<arn>:<KEY>::`).

| Secret | Values | Read by |
|--------|--------|---------|
| `skynet/<env>/app` | You fill them | backend, worker, migrate |
| `skynet/<env>/frontend` | You fill them | frontend |
| `skynet/<env>/litellm` | You fill them | litellm |
| `skynet/<env>/app-generated` | Terraform (`REMOTE_DB_URL`, `REDIS_URL`) | backend, worker, migrate |
| `skynet/<env>/litellm-generated` | Terraform (`LITELLM_DATABASE_URL`, `REDIS_PASSWORD`) | litellm |
| `skynet/<env>/db-admin` | Terraform (master and litellm passwords) | dbadmin |

The key names come from the Railway export (SKY-155). ECS does not start a task
when a referenced key is missing. An empty string is allowed.

Load the values (key names only pass through the script, never values):

```bash
cd infra/aws
scripts/secrets.sh template staging app      > ~/skynet-secrets/staging-app.json
scripts/secrets.sh template staging frontend > ~/skynet-secrets/staging-frontend.json
scripts/secrets.sh template staging litellm  > ~/skynet-secrets/staging-litellm.json
# Fill the values in those files. Keep them outside the repo.
scripts/secrets.sh put staging app      ~/skynet-secrets/staging-app.json
scripts/secrets.sh put staging frontend ~/skynet-secrets/staging-frontend.json
scripts/secrets.sh put staging litellm  ~/skynet-secrets/staging-litellm.json
scripts/secrets.sh check staging
```

Delete the local JSON files after `put`. The generated values are also in the
Terraform state; the state bucket is private and encrypted.

## Build and push images

```bash
aws login --profile skynet
infra/aws/scripts/build-push.sh staging <git-sha>
```

The script runs `docker buildx build --platform linux/arm64 --push` for
`backend` (`backend/`), `frontend` (`frontend/`) and `litellm` (`deploy/litellm/`). ECR tags are
immutable; the script skips a tag that exists. Frontend build values
(`NEXT_PUBLIC_SENTRY_DSN` and others) come from the shell. `SENTRY_AUTH_TOKEN`
goes in as a BuildKit secret, not a build argument.

Manual equivalent for one image:

```bash
REG=<account>.dkr.ecr.us-east-2.amazonaws.com
aws ecr get-login-password --profile skynet --region us-east-2 | docker login --username AWS --password-stdin "$REG"
docker buildx build --platform linux/arm64 -t "$REG/skynet/backend:<sha>" --push backend
```

## First apply (staging, then production)

Prerequisites: Terraform >= 1.11, AWS CLI v2, Docker with buildx, `jq`,
the Session Manager plugin (`brew install --cask session-manager-plugin`) and
`postgresql@18` for `pg_restore`.

```bash
aws login --profile skynet
export AWS_PROFILE=skynet AWS_REGION=us-east-2
cd infra/aws

# 1. State bucket (local state, once per account).
terraform -chdir=bootstrap init
terraform -chdir=bootstrap apply
BUCKET=$(terraform -chdir=bootstrap output -raw state_bucket)

# 2. Global: ECR repos, the GitHub OIDC provider and the deploy role.
terraform -chdir=global init -backend-config="bucket=$BUCKET"
terraform -chdir=global apply

# 3. Images.
SHA=$(git rev-parse HEAD)
scripts/build-push.sh staging "$SHA"

# 4. Environment, pass 1: network, ALB (HTTP only), RDS, Valkey, secrets,
#    task definitions. No ECS services yet (services_enabled=false).
terraform -chdir=environments/staging init -backend-config="bucket=$BUCKET"
#    terraform.tfvars (lean) loads automatically; add -var-file=full.tfvars
#    to every apply for the full variant.
terraform -chdir=environments/staging apply -var image_tag="$SHA"
terraform -chdir=environments/staging output acm_validation_records

# 5. Give the ACM validation records to Gilad. He creates them by hand.

# 6. Secrets (see "Secrets"), then the litellm role and database, and pgvector.
scripts/secrets.sh put staging app      ~/skynet-secrets/staging-app.json
scripts/secrets.sh put staging frontend ~/skynet-secrets/staging-frontend.json
scripts/secrets.sh put staging litellm  ~/skynet-secrets/staging-litellm.json
scripts/secrets.sh check staging
scripts/create-litellm-db.sh staging

# 7. Restore the Railway data (see "Restore"). Then migrate.
scripts/deploy.sh staging "$SHA" --migrate-only

# 8. Environment, pass 2: services on, HTTPS on (after ACM shows ISSUED).
aws acm list-certificates --query 'CertificateSummaryList[].[DomainName,Status]' --output table
terraform -chdir=environments/staging apply -var image_tag="$SHA" \
  -var services_enabled=true -var enable_https=true

# 9. Check: ECS services stable, targets healthy, then the DNS cutover.
```

For production, repeat steps 3 to 9 with `production`. Build the production
frontend image separately: `scripts/build-push.sh production "$SHA"`.
Optional: `-var alert_email=<address>` subscribes an email to the alarms.

## Deploys after the first apply

```bash
infra/aws/scripts/build-push.sh staging <sha>
infra/aws/scripts/deploy.sh staging <sha>
```

`deploy.sh` registers new task definition revisions with the new image,
runs the `migrate` task, stops if it fails, then updates the services and waits.
Rollback: run `deploy.sh` with the previous SHA. Migrations do not roll back.

Terraform ignores the service `task_definition` and `desired_count`. A Terraform
change to a task definition (for example a new secret key) takes effect at the
next `deploy.sh` run.

`.github/workflows/aws-deploy.yml` does the same with the OIDC role. It runs on
`workflow_dispatch` only. After `global` is applied, set the repository variable
`AWS_DEPLOY_ROLE_ARN` (output `github_deploy_role_arn` of `global`) and create
the GitHub environments `aws-staging` and `aws-production`.

## Restore the Railway backups

The pg_dump files (custom format, from PostgreSQL 18.6) are in
`~/Library/Application Support/Skynet Backups/railway-2026-10-21/`.
The script expects `<env>-Postgres.dump` (app) and `<env>-Postgres-ZPeG.dump`
(litellm). Restore into empty databases, before the first migration and before
the services start.

```bash
brew install postgresql@18
export PATH="/opt/homebrew/opt/postgresql@18/bin:$PATH"

# Terminal 1: tunnel localhost:15432 to RDS through a dbadmin task.
infra/aws/scripts/db-tunnel.sh staging

# Terminal 2:
infra/aws/scripts/restore-railway.sh staging
```

The script restores with `--no-owner --no-acl`, so the objects belong to the
restoring role. It then runs a row count check. After the restore, run
`deploy.sh <env> <sha> --migrate-only`; it applies only newer migrations.

## DNS cutover

DNS changes are manual and need Gilad's approval. Terraform does not touch DNS.

1. Lower the TTL of the current records to 60 s one day before.
2. Create the ACM validation CNAMEs (output `acm_validation_records`). Keep them;
   ACM uses them for renewal.
3. Point the hosts at the ALB (`terraform output alb_dns_name`):
   - staging: `staging.skynetml.com` and `api-staging.skynetml.com` -> CNAME.
   - production: `www.skynetml.com` and `api.skynetml.com` -> CNAME.
     `skynetml.com` (apex) needs an ALIAS / ANAME / CNAME-flattening record, or
     Route 53 with an alias to `alb_dns_name` / `alb_zone_id`.
4. Check `https://<host>/` and the backend health check through the new names.
5. Update the OAuth redirect URIs and the Stripe webhook endpoint only if the
   host names change. They do not change in this plan.

## Monthly cost estimate (us-east-2, October 2026 list prices)

Prices from the AWS Price List API: Fargate ARM $0.03238 per vCPU-hour and
$0.00356 per GB-hour, NAT gateway $0.045 per hour, public IPv4 $0.005 per hour,
db.t4g.small $0.032 per hour (Multi-AZ medium $0.129), cache.t4g.micro Valkey
$0.0128 per hour, gp3 $0.115 per GB-month, 730 hours per month. Fargate Spot is
not in the Price List API; the estimate assumes 70% off (AWS: "up to 70%").

| Item | Staging lean | Staging full | Production lean | Production full |
|------|--------------|--------------|-----------------|-----------------|
| Fargate ARM64 tasks | ~$20 (4 Spot tasks) | ~$66 (4 tasks) | ~$67 (4 tasks, 1.75 vCPU) | ~$178 (8 tasks, 6 vCPU) |
| RDS PostgreSQL, 20 GB gp3 | ~$26 (small, single-AZ) | ~$26 | ~$26 (small, single-AZ) | ~$99 (medium, Multi-AZ) |
| ElastiCache Valkey | ~$9 (1 node) | ~$9 | ~$9 (1 node) | ~$19 (2 nodes) |
| ALB (hours + LCU) | ~$20 | ~$20 | ~$25 | ~$25 |
| NAT gateway hours | $0 | ~$33 (1) | ~$33 (1) | ~$66 (2) |
| Public IPv4 | ~$22 (2 ALB + 4 tasks) | ~$11 (3) | ~$11 (3) | ~$15 (4) |
| CloudWatch (logs, alarms, Container Insights, monitoring) | ~$10 | ~$10 | ~$20 | ~$20 |
| Secrets Manager, S3, ECR storage | ~$5 | ~$5 | ~$5 | ~$5 |
| **Total** | **~$112** | **~$180** | **~$196** | **~$426** |

Lean total: about $308 per month. Full total: about $606 per month.

Not included: data transfer out, NAT data processing ($0.045 per GB), LLM provider
costs, RDS CPU credits beyond the baseline, WAF (off by default; about $10 per
month plus requests when on). Autoscaled tasks add about $20 (backend) or $9
(frontend) per task-month, plus $3.65 per public IP in `public_ip` mode.
If Spot is only 50% off, staging lean costs about $125. The ECR repos and the
state bucket are shared and cost a few dollars per month. A Compute Savings
Plan cuts on-demand Fargate by about 20% to 50%.

## Not in this stack

- PR previews (SKY-164): out of scope. The module can serve a third
  environment later.
- The app code changes for `APP_GIT_SHA`, `APP_ENVIRONMENT`, `APP_SERVICE_NAME`
  and `FORWARDED_ALLOW_IPS` are in PR #788 (SKY-161). The task definitions set
  these variables already.
- DNS, OAuth and Stripe configuration.

## Plan

The environment stacks build the ECR URLs from the account ID, so they plan
before `global` exists. To plan without the state bucket, copy `infra/aws` to a
temporary folder, add `backend_override.tf` with `terraform { backend "local" {} }`
to each stack, then run `terraform init` and `terraform plan -var image_tag=<sha>`.

Results on 2026-10-21 (account 669242775630, us-east-2, empty account):

| Stack | Pass 1 | Pass 2 (`services_enabled`, `enable_https`) |
|-------|--------|------|
| bootstrap | 7 to add | - |
| global | 9 to add (3 ECR repos, 3 lifecycle policies, OIDC provider, deploy role, role policy) | - |
| staging lean | 151 to add | 172 to add |
| staging full (`-var-file=full.tfvars`) | 155 to add | 176 to add |
| production lean | 155 to add | 176 to add |
| production full (`-var-file=full.tfvars`) | 157 to add | 178 to add |

Staging lean has no NAT gateway, Elastic IP or NAT routes (4 fewer). Production
lean has one NAT gateway and one Elastic IP (2 fewer than full). Pass 2 adds 21
resources in every variant: 4 services, 2 scaling targets, 2 scaling policies,
12 service alarms and the HTTPS listener.

## Checks

```bash
cd infra/aws
terraform fmt -recursive -check
for d in bootstrap global environments/staging environments/production; do
  terraform -chdir=$d init -backend=false && terraform -chdir=$d validate
done
tflint --init && tflint --recursive --config "$PWD/.tflint.hcl"
trivy config --severity HIGH,CRITICAL .
```

Trivy findings that the design accepts carry a `#trivy:ignore` comment with the
reason: open task egress (LLM providers, OAuth, Stripe, webhooks), the public ALB,
the HTTP listener (redirect only), and AWS-managed KMS keys in place of CMKs.
