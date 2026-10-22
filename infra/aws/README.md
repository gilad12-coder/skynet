# Skynet on AWS (SKY-156)

Terraform for Skynet on AWS: ECS on Fargate (ARM64 / Graviton), RDS PostgreSQL 18,
ElastiCache Valkey, ALB with ACM, Secrets Manager, ECR and CloudWatch.
Region: `us-east-2`. AWS CLI profile: `skynet`.

Nobody ran `terraform apply` yet. Read-only plans of every stack pass (see
"Plan" below). The first apply needs Gilad's approval through the orchestrator.

## Account prerequisites

- The `skynet` account is on the AWS **free plan** today
  (`aws freetier get-account-plan-state`). Free-plan credits and the plan end
  date do not cover about $625 per month. Upgrade to the paid plan in
  AWS Settings before the first apply, and set a spend limit.
- The managed SCP (free and paid plan) denies `iam:*Provider*`. Terraform
  therefore cannot create the GitHub Actions OIDC provider. `global` creates it
  only with `-var enable_github_oidc=true`, after "Activate advanced AWS
  features". Until then, deploy from a laptop with `scripts/deploy.sh`.
- Every other service in the stack is on the free-plan allow list: ECS, ECR,
  RDS, ElastiCache, Elastic Load Balancing, ACM, Cloud Map, Secrets Manager,
  SSM, CloudWatch, SNS, WAF, Application Auto Scaling, VPC, S3, IAM roles.

## Layout

| Path | Stack | Creates |
|------|-------|---------|
| `bootstrap/` | local state | The S3 state bucket (versioned, encrypted, TLS only). |
| `global/` | `global/terraform.tfstate` | ECR repos `skynet/backend`, `skynet/frontend`, `skynet/litellm`. GitHub OIDC provider and deploy role only with `enable_github_oidc=true` (blocked today, see above). |
| `environments/staging/` | `staging/terraform.tfstate` | One environment from `modules/environment`, small sizes. |
| `environments/production/` | `production/terraform.tfstate` | The same module, production sizes. |
| `modules/environment/` | module | VPC, ALB, ACM, ECS cluster, services, task definitions, RDS, Valkey, secrets, logs, alarms. |
| `scripts/` | shell | Build and push, deploy (migrate first), secrets, litellm database, DB tunnel, Railway restore. |

Remote state uses the S3 backend with native S3 locking (`use_lockfile = true`).
There is no DynamoDB table.

### One environment

- VPC with 2 AZs: public subnets (ALB, NAT), private subnets (tasks), isolated
  subnets (RDS, Valkey, no internet route). S3 gateway endpoint. VPC flow logs.
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

# 2. Global: ECR repos (the OIDC role stays off, see "Account prerequisites").
terraform -chdir=global init -backend-config="bucket=$BUCKET"
terraform -chdir=global apply

# 3. Images.
SHA=$(git rev-parse HEAD)
scripts/build-push.sh staging "$SHA"

# 4. Environment, pass 1: network, ALB (HTTP only), RDS, Valkey, secrets,
#    task definitions. No ECS services yet (services_enabled=false).
terraform -chdir=environments/staging init -backend-config="bucket=$BUCKET"
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
`workflow_dispatch` only. It cannot run until `enable_github_oidc=true` can be
applied (the SCP blocks the OIDC provider today). Then set the repository variable
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

## Monthly cost estimate (us-east-2, on-demand, October 2026 list prices)

| Item | Staging | Production |
|------|---------|------------|
| Fargate ARM64 tasks | ~$66 (4 tasks, 1.75 vCPU, 9.5 GB) | ~$178 (8 tasks, 6 vCPU, 14 GB) |
| RDS PostgreSQL | ~$27 (db.t4g.small, single-AZ, 20 GB gp3) | ~$105 (db.t4g.medium, Multi-AZ, 20 GB gp3) |
| ElastiCache Valkey | ~$9 (1 x cache.t4g.micro) | ~$19 (2 x cache.t4g.micro) |
| ALB (hours + LCU) | ~$20 | ~$25 |
| NAT gateway (hours, low traffic) | ~$35 (1) | ~$70 (2) |
| Public IPv4 addresses | ~$11 (3) | ~$15 (4) |
| CloudWatch (logs, alarms, Performance Insights, monitoring) | ~$10 | ~$20 |
| Secrets Manager, S3, ECR storage | ~$5 | ~$5 |
| **Total** | **~$185 per month** | **~$440 per month** |

Not included: data transfer out, NAT data processing ($0.045 per GB), LLM provider
costs, WAF (off by default; about $10 per month plus requests when on).
The ECR repos and the state bucket are shared and cost a few dollars per month.
A Compute Savings Plan cuts Fargate by about 20% to 50%.

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
| global | 6 to add (3 ECR repos, 3 lifecycle policies) | - |
| staging | 155 to add | 176 to add |
| production | 157 to add | 178 to add |

Production adds one more NAT gateway and one more Elastic IP than staging.

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
