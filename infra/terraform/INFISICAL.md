# Infisical for Skynet secrets (SKY-186)

Infisical is the place where people edit the Skynet app secrets.
A Secret Sync in Infisical writes them into AWS Secrets Manager.
The ECS tasks continue to read Secrets Manager. No app code changes.

```
Gilad (browser) --SSM tunnel--> Infisical (ECS, private) --Secret Sync--> skynet/<env>/app --> ECS tasks
```

- Terraform root: `environments/infisical/` (state key `infisical/terraform.tfstate`).
- Scripts: `scripts/infisical-*.sh`, `scripts/rotate-secret.sh`, `scripts/secret-rollback.sh`.
- Image: `infisical/infisical:v0.166.8`, pinned by digest in `ecs.tf`.
- Region `us-east-2`, AWS CLI profile `skynet`.

## Safety rules

1. Do not put a secret value in a file, a command line, a chat, a log or a screenshot.
   The scripts move values only through pipes.
2. A sync is always created **disabled**. Enable it only with
   `scripts/infisical-sync-guard.sh <env> --enable`.
3. Do not rotate or delete `skynet/infisical/bootstrap`. If `ENCRYPTION_KEY`
   is lost, all data in Infisical is lost. Keep the break-glass copy (step 7).
4. Do not change Cloudflare DNS for Infisical. Infisical has no public address.
5. Use local port 18080 only. Do not use ports 3000 or 8000.

## What the sync does to keys it does not manage

The sync uses the **Many-To-One** mapping: all keys of the Infisical
environment go into one JSON secret, `skynet/<env>/app`.

- The sync **replaces the full JSON**. A key that is only in Secrets Manager
  is **dropped** from the new version. The sync does not merge.
- The option "Disable Secret Deletion" applies only to One-To-One mapping.
  It does not protect a Many-To-One secret.
- Each sync writes a new secret version. The earlier version stays in
  Secrets Manager, so a rollback is possible.
- Sources: [Infisical docs, AWS Secrets Manager sync](https://infisical.com/docs/integrations/secret-syncs/aws-secrets-manager)
  and [source v0.166.8, lines 463-519](https://github.com/Infisical/infisical/blob/v0.166.8/backend/src/services/secret-sync/aws-secrets-manager/aws-secrets-manager-sync-fns.ts#L463-L519).

Because of this, `infisical-sync-guard.sh` compares the key names before it
enables a sync. It refuses when the names are different.

## Free self-hosted limits

- Organization "Enforce MFA" needs a paid license. Each user turns on
  personal MFA (step 6).
- Infisical audit logs need a paid license. AWS CloudTrail and the
  EventBridge alarm (below) record each change to `skynet/*` secrets.
- Secret Syncs to AWS Secrets Manager are free.

## Why the syncs are not in Terraform

The Infisical Terraform provider needs an Infisical token in Terraform and in
CI, and it would write the sync settings into Terraform state. A Terraform
apply could also enable a sync without the name check. Gilad creates the
syncs by hand, disabled, and only the guard script enables them.

## Runbook

All commands run from `infra/terraform`. Export the profile first:

```bash
export AWS_PROFILE=skynet AWS_REGION=us-east-2
```

### 1. First apply (after the PR is approved)

`terraform.tfvars` has `service_running = false`. The first apply creates
the network, the database, the cache, the secrets and the alarms. It does
not start Infisical, because the SMTP secret is still empty.

```bash
cd environments/infisical
terraform init -backend-config="bucket=skynet-tfstate-669242775630-us-east-2"
terraform plan -out=tfplan      # expect: 0 to change, 0 to destroy
terraform apply tfplan
```

If `alert_email` is set, AWS sends a confirmation email. Click the link.

### 2. Copy the SMTP key

Infisical sends email through Resend, with the same key as staging.

```bash
scripts/infisical-smtp-copy.sh
```

### 3. Start Infisical

Set `service_running = true` in `terraform.tfvars`, then plan and apply.
The first start runs the database migrations. It can take 5 minutes.

```bash
aws ecs wait services-stable --cluster skynet-infisical --services infisical
```

### 4. Open the tunnel

Install the Session Manager plugin once:
`brew install --cask session-manager-plugin`.

```bash
scripts/infisical-tunnel.sh
```

Open <http://localhost:18080>. Keep the terminal open. Ctrl-C closes the
tunnel and stops the tunnel task. The tunnel task stops itself after 4 hours.

### 5. Create the first admin (Gilad)

In the browser, sign up. The first account becomes the server admin.
Use a strong password from your password manager.

### 6. Close sign-up and turn on MFA (Gilad)

1. Open **Server Admin Console > General**. Turn off **Allow user signups**.
   Save. Sign out and check that the sign-up page refuses a new account.
2. Open **Personal Settings > Authentication**. Turn on MFA (authenticator
   app). Save the recovery codes in your password manager.
3. Each later user also turns on personal MFA. The free license cannot
   enforce it for the organization.

### 7. Break-glass copy of the bootstrap secret (Gilad)

`skynet/infisical/bootstrap` holds `ENCRYPTION_KEY` and `AUTH_SECRET`.
AWS protects it (KMS key, 30-day recovery window, deny policy against writes
and deletes, `prevent_destroy`). Keep one more copy outside AWS:

```bash
aws secretsmanager get-secret-value --secret-id skynet/infisical/bootstrap \
  --query SecretString --output text | pbcopy
```

Paste it into a new secure note in your password manager (or print it and
store the paper offline). Then clear the clipboard: `pbcopy </dev/null`.
Do not save it in a file on disk.

### 8. Create the project and set its ID

1. Create the project **skynet** (Secrets Management).
2. Keep the environments **staging** and **production** (slugs `staging`,
   `production`). Delete the default `dev` environment.
3. Copy the project ID from **Project Settings**.
4. Set `infisical_project_id = "<project id>"` in `terraform.tfvars`.
   Plan and apply. This creates the IAM role `skynet-infisical-secret-sync`.

```bash
terraform output secret_sync_role_arn
```

### 9. Create the machine identity for the scripts

1. **Organization > Access Control > Identities**: create `skynet-ops`
   with **Universal Auth**. Give it the project role **Admin** in `skynet`.
2. Create a client secret. Keep the client ID and secret in your password
   manager.
3. For each session, get a token into your shell without echo:

```bash
read -rs INFISICAL_CLIENT_SECRET   # paste, then Enter
export INFISICAL_TOKEN="$(curl -s -X POST http://localhost:18080/api/v1/auth/universal-auth/login \
  -H 'Content-Type: application/json' \
  --data-binary @<(jq -n --arg id "<client id>" --arg s "$INFISICAL_CLIENT_SECRET" '{clientId:$id,clientSecret:$s}') |
  jq -r .accessToken)"
unset INFISICAL_CLIENT_SECRET
export INFISICAL_PROJECT_ID="<project id>"
```

### 10. Create the AWS app connection

In the **skynet** project (not at organization level, so the external ID is
the project ID): **Integrations > App Connections > Add > AWS**.

- Method: **Assume Role**.
- Role ARN: the `secret_sync_role_arn` output.
- Name: `skynet-aws`.

Infisical assumes the role from its task role. The role allows only
Describe, Get, Put and UpdateSecret on `skynet/staging/app` and
`skynet/production/app`. It cannot create, delete, restore or tag a secret.

### 11. Create the two syncs, disabled

**Integrations > Secret Syncs > Add > AWS Secrets Manager**, one for each
environment:

| Field | staging | production |
|-------|---------|------------|
| Name | `skynet-staging-app` | `skynet-production-app` |
| Source | environment `staging`, path `/` | environment `production`, path `/` |
| Connection | `skynet-aws` | `skynet-aws` |
| Region | `us-east-2` | `us-east-2` |
| Mapping | **Many-To-One** | **Many-To-One** |
| Secret name | `skynet/staging/app` | `skynet/production/app` |
| Initial sync behavior | Overwrite destination | Overwrite destination |
| KMS key | empty (AWS managed key) | empty |
| Tags | none (the role cannot tag) | none |
| **Auto-sync** | **OFF** | **OFF** |

Do not click "Sync now". Do not add secret imports to `/`.

`skynet/production/app` does not exist yet. The sync role cannot create it.
Create the production sync only after the production Terraform root is
applied and its app secret is filled.

### 12. Import the current values

```bash
scripts/infisical-import.sh staging
```

The script refuses if the Infisical environment already has secrets.
Repeat for production after its secret exists. The production values are
now only in your local folder. Load them first with
`scripts/secrets.sh put production app <file>` (README "Secrets"), then run
`scripts/infisical-import.sh production`.

### 13. Check, then enable the sync

```bash
scripts/infisical-sync-guard.sh staging            # check only
scripts/infisical-sync-guard.sh staging --enable   # check, label, confirm, enable
```

The guard checks the sync settings, the key names and the values. It prints
only key names. On `--enable` it labels the current Secrets Manager version
`PRE_INFISICAL`, asks you to type the environment name, enables the sync,
waits for it, and checks the key names again.

If values differ on purpose, add `--accept-changed-values`.

### 14. Change a secret

1. Edit the value in Infisical. The sync writes `skynet/<env>/app`.
2. Run:

```bash
scripts/rotate-secret.sh staging SOME_KEY
```

The script syncs, checks the key names, and redeploys only the ECS services
that read the key. It waits until they are stable and their targets are
healthy. This step does not rotate the third-party key itself.

### 15. Roll back

1. In Infisical, turn **Auto-sync OFF** for the sync.
2. Run:

```bash
scripts/secret-rollback.sh staging                 # back to PRE_INFISICAL
scripts/secret-rollback.sh staging AWSPREVIOUS     # back one version
```

The script moves the `AWSCURRENT` label. It does not read or print values.
It redeploys every service that reads `skynet/<env>/app`.

### 16. Restore drill (each quarter)

```bash
scripts/infisical-restore-drill.sh
```

It restores the latest backup to a temporary instance, checks it, and
deletes it. It takes 15-30 minutes and costs a few cents.

### 17. Local copies (Gilad)

After both syncs run and the apps are healthy, delete your local production
secret folder yourself. The agents do not delete local files.

### 18. Agents

Agents continue to read secret names and values from Secrets Manager as
before. They do not get Infisical access.

## Alarms and audit

- CloudTrail trail `skynet-infisical-audit` records write events (KMS-encrypted
  S3 bucket, 365 days, log file validation).
- The EventBridge rule `skynet-infisical-secret-changes` sends each
  PutSecretValue, UpdateSecret, DeleteSecret, RestoreSecret,
  UpdateSecretVersionStage, RotateSecret and resource policy change on a
  `skynet/*` secret to the SNS topic `skynet-infisical-alarms`.
  Set `alert_email` to get the alarms by email.
- Infisical logs: CloudWatch `/ecs/skynet-infisical/infisical` (30 days).
  ECS Exec sessions of the tunnel: 90 days.

## Failure isolation

- The apps read Secrets Manager only when a task starts. They never call
  Infisical.
- If Infisical, its database or its cache stops, secret edits and syncs stop.
  Running and new app tasks continue with the last synced values.
- Infisical has its own VPC (10.60.0.0/16), cluster, KMS key and IAM roles.
  It shares nothing with the staging or production stacks.
- The sync role can write only the two app secrets. A bad sync is undone with
  `secret-rollback.sh`.

## Threat model

| Threat | Control |
|--------|---------|
| Internet access to Infisical | No public IP, no load balancer. The security group allows port 8080 only from the tunnel task. Access needs AWS credentials for ECS Exec and SSM. |
| Stranger signs up | Sign-up is off after the first admin (step 6). |
| Stolen password | Personal MFA (step 6). |
| Infisical compromise | The sync role writes only `skynet/staging/app` and `skynet/production/app`. It cannot create, delete or tag secrets. The EventBridge alarm reports each write. Rollback with `secret-rollback.sh`. |
| Sync drops keys | The guard compares key names before enable. `PRE_INFISICAL` keeps the old version. |
| Loss of ENCRYPTION_KEY | CMK, 30-day recovery window, deny policy, `prevent_destroy`, break-glass copy. |
| Database loss | KMS encryption, 14-day backups, deletion protection, final snapshot, `prevent_destroy`, restore drill. |
| Secret values in Terraform state | Ephemeral values and write-only arguments. The plan role reads state, and state holds no values. |
| Image tampering | The image is pinned by digest. |
| Secrets in git | gitleaks pre-commit hook and a CI scan of the full history. |

## Monthly cost (us-east-2, October 2026 list prices)

| Item | USD per month |
|------|---------------|
| Fargate ARM64, 0.5 vCPU / 2 GB, always on | ~17 |
| RDS db.t4g.micro single-AZ + 20 GB gp3 + backups | ~14 |
| ElastiCache Valkey cache.t4g.micro, 1 node | ~9.3 |
| NAT gateway + Elastic IP (no traffic) | ~36.5 |
| KMS key | 1 |
| Secrets Manager, 3 secrets | ~1.2 |
| CloudWatch logs, CloudTrail, S3, SNS | ~2-3 |
| **Total** | **~82-85** |

The tunnel task costs about $0.01 per hour while it runs. The NAT gateway is
the largest item. A NAT instance (fck-nat, about $3) or VPC endpoints
without NAT would cut about $30, with more parts to maintain.
