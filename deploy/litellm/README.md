# Managed-inference gateway (LiteLLM proxy)

The self-hosted [LiteLLM proxy](https://docs.litellm.ai/docs/simple_proxy) that
fronts Skynet's **managed** inference. It routes all managed runs through one
OpenRouter master account, meters them, and enforces per-key spend caps. This is
**Phase E** of the provider-connections plan — additive and last: managed + BYOK
both work without it, and turning it on is a single backend config change.

## What it is (and isn't)

- **Managed runs** flow `backend → LiteLLM proxy → OpenRouter → provider`. One
  master account, 0% inference markup + the 5.5% deposit fee folded into the
  credit markup.
- **BYOK runs never touch this proxy.** The run-path bridge
  (`backend/core/billing/byok_bridge.py`) stamps the user's own key onto the
  request, which goes straight to the provider. The proxy only ever sees managed
  traffic.
- **The Skynet credit ledger stays the source of truth** for billing
  (`backend/core/billing/service.py`). The proxy's budgets are a *backstop* —
  a circuit breaker against runaway upstream spend — not the accounting system.
  Reconcile periodically: the proxy's `/spend/logs` should track the ledger's
  managed debits; a sustained divergence means a metering bug to investigate.

## Deploy

```bash
cd deploy/litellm
cp .env.example .env        # fill in OPENROUTER_API_KEY, LITELLM_MASTER_KEY, …
docker compose up -d --build
curl -s http://localhost:4000/health   # should report healthy
```

The image is built from the MIT-licensed `litellm` wheel pinned in
`requirements.txt`, not the upstream `ghcr.io/berriai/litellm` image, which ships
LiteLLM's proprietary `enterprise/` code. `litellm[proxy]` depends on the
proprietary `litellm-enterprise` package, so the proxy extra is listed by hand
without it; keep those pins in step with litellm's own when upgrading.

## Deploy on AWS ECS (hosted)

The same `config.yaml` runs unchanged on AWS ECS Fargate. ECS can't bind-mount
a file, so the `Dockerfile` here also bakes `config.yaml` in; the proxy still
listens on a fixed `4000`. Terraform (`infra/terraform`, see its README) builds
everything around it:

- `infra/terraform/scripts/build-push.sh` builds this directory into the
  `skynet/litellm` ECR image, and `deploy.sh` rolls it out with the other
  services.
- The proxy keeps its own `litellm` database on the shared RDS instance,
  separate from the Skynet app database, and uses the shared Valkey cache
  (TLS and AUTH). `LITELLM_DATABASE_URL` and `REDIS_PASSWORD` come from the
  `skynet/<env>/litellm-generated` secret; `LITELLM_MASTER_KEY`,
  `OPENROUTER_API_KEY` and `LITELLM_SEED_KEY` come from `skynet/<env>/litellm`.
- The proxy is private: it has no public host. The backend and the worker reach
  it at `http://litellm.<env>.skynet.internal:4000` (Cloud Map), and Terraform
  sets their `LITELLM_PROXY_URL` to that address.

The proxy binds `0.0.0.0` (see the Dockerfile). Admin endpoints
(`/key/generate`, `/spend/logs`) take the master key. Call them from inside the
litellm task (`aws ecs execute-command --cluster skynet-<env> --container
litellm ...`), never through a public host. The image has Python but no
`curl`.

The backend's virtual key must exist in the proxy database. `start.py`
registers `LITELLM_SEED_KEY` at boot, so put the same value in
`skynet/<env>/app` as `LITELLM_PROXY_API_KEY` and in `skynet/<env>/litellm` as
`LITELLM_SEED_KEY` (`infra/terraform/scripts/secrets.sh`), then redeploy.

## Enable it on the backend

The backend stays dormant toward the proxy until both env vars are set:

| Env var | Value |
|---|---|
| `LITELLM_PROXY_URL` | The proxy base URL, e.g. `http://litellm-proxy:4000/v1` |
| `LITELLM_PROXY_API_KEY` | A **virtual key** minted from the master key (below) |

Mint a virtual key (optionally per-user or per-job, with its own budget):

```bash
curl -s http://localhost:4000/key/generate \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"max_budget": 50, "duration": "30d"}'
```

Once `LITELLM_PROXY_URL` is set, `build_language_model`
(`backend/core/service_gateway/language_models.py::_apply_managed_gateway`)
points every managed call at the proxy and authenticates with the virtual key.
BYOK calls (which already carry the user's `api_key`) and endpoint-pinned calls
are never rerouted.

## Rollback

Unset `LITELLM_PROXY_URL` on the backend and redeploy. Managed runs immediately
revert to calling providers directly via process env keys; no data migration,
no code change.
