# AGENTS.md — Skynet Codebase Index

> Full-stack optimization platform for prompts, programs, agents, workflows,
> datasets, and other user-supplied artifacts.

## Product and runtime model

- **DSPy** is the structured program/prompt optimization path.
- **Optimize Anything** is the black-box path. Its native engines come from the
  pinned upstream GEPA implementation and include GEPA, Best-of-N,
  Meta-Harness, and AutoResearch. `Auto` composes eligible engines without
  redefining their algorithms.
- **Vercel Sandbox** is the production execution boundary for user workloads,
  including optimization setup, runs, recovery, and completed-run
  interactions. Workers are the control plane: they orchestrate jobs, reserve
  and settle budgets, broker scoped credentials, persist checkpoints, and
  dispatch sandbox work.
- **Protected execution** reserves wallet and run-budget headroom before paid
  work. Managed model usage, Skynet fees, and sandbox usage are metered. For
  BYOK model routes, the Skynet budget covers the platform fee and sandbox
  usage; the model provider charges the user's key directly.

## Tech stack

- **Backend**: Python 3.11+, FastAPI, Pydantic, SQLAlchemy, Alembic, DSPy,
  pinned GEPA, LiteLLM/OpenRouter, Vercel Sandbox, PostgreSQL/pgvector, optional
  Redis, and Stripe.
- **Frontend**: Node 22, Next.js 16 App Router, React 19, TypeScript,
  Tailwind CSS 4, Radix/shadcn primitives, Framer Motion, and NextAuth.
- **Dependency management**: `uv` is authoritative for backend development and
  CI; compiled `requirements*.txt` files support the pip/Docker paths. The
  frontend uses npm and a committed lockfile.
- **Deployment**: backend containers, Helm manifests, a LiteLLM gateway, and a
  pinned Vercel Container Registry sandbox image.

## Project layout

```text
├── backend/
│   ├── main.py                  FastAPI process entry point
│   ├── worker_main.py           Background worker entry point
│   ├── manage.py                Administrative CLI
│   ├── pyproject.toml           Python package, dependencies, Ruff/Pytest config
│   ├── uv.lock                  Authoritative resolved dependency graph
│   ├── requirements*.txt        Reproducible pip/Docker dependency paths
│   ├── Dockerfile               API/worker and native optimizer runtime image
│   ├── SANDBOX_RUNTIME.md       Pinned sandbox image build/publish contract
│   ├── alembic/                 PostgreSQL schema migrations
│   ├── sandbox-runtime/         Node harness runtime and lockfile
│   ├── load_tests/              Locust/SLO release-gate tooling
│   ├── core/
│   │   ├── api/
│   │   │   ├── app.py           App factory, middleware, and router wiring
│   │   │   ├── auth.py          Backend token verification
│   │   │   ├── rate_limit.py    Redis-backed/fail-open request limiting
│   │   │   ├── static/scalar/   Bundled offline API-reference assets
│   │   │   └── routers/         Account, billing, dataset, job, sandbox,
│   │   │                        sharing, telemetry, wizard, and workflow APIs
│   │   ├── billing/             Shared budgets, atomic reservations,
│   │   │                        metering, BYOK vault/bridge, model gateway,
│   │   │                        MCP broker, and Vercel reconciliation
│   │   ├── models/              Pydantic API/domain models
│   │   ├── notifications/       Preferences and webhook/chat notifications
│   │   ├── registry/            DSPy module and optimizer registration
│   │   ├── service_gateway/
│   │   │   ├── agents/          Code/generalist agent services
│   │   │   ├── datasets/        Dataset planning and profiling
│   │   │   ├── embedding_pipeline/ Conversation embedding and summarization
│   │   │   └── optimization/    DSPy workflow, metrics, artifacts, and limits
│   │   │       ├── blackbox/    Pinned Optimize Anything engines, harnesses,
│   │   │       │                scorers, sandbox broker, and remote evaluator
│   │   │       └── training_ground/ Benchmark/training adapters
│   │   ├── storage/             ORM, migrations, job/checkpoint/dataset stores
│   │   ├── telemetry/           Server-side telemetry events
│   │   └── worker/              Job orchestration, preflight, recovery,
│   │                            scoped relay, and Vercel DSPy dispatch
│   ├── tests/                   Integration, load, and release-gate tests
│   └── usage_guide/             Notebooks and API-client examples
│
├── frontend/
│   ├── package.json             Dev/build/typecheck/lint/unit commands
│   ├── next.config.ts           Standalone build, headers, image/bundle config
│   ├── public/                  Static assets and local font subsets
│   ├── scripts/                 Frontend-specific validation utilities
│   └── src/
│       ├── app/                 Thin App Router entry points and layouts
│       │   ├── (dashboard)/      Authenticated dashboard home
│       │   ├── api/              NextAuth and account-security proxy routes
│       │   ├── datasets/         Dataset list/detail/share routes
│       │   ├── optimizations/    Job detail route
│       │   ├── share/            Shared optimization route
│       │   ├── submit/           Optimization submission route
│       │   ├── tagger/           Tagging session and share routes
│       │   ├── explore/          Public dataset discovery
│       │   ├── storage/          Account storage management
│       │   ├── login/            Sign-in and account recovery UI
│       │   └── privacy/ terms/   Public legal pages
│       ├── features/             Product feature slices
│       │   ├── submit/           DSPy/Anything wizard, drafts, substeps,
│       │   │                    preflight, budget UI, and workflow canvas
│       │   ├── optimizations/    Results, logs, compare, export, and serve UI
│       │   ├── dashboard/        Job list, analytics, and bulk actions
│       │   ├── datasets/         Dataset library and editor
│       │   ├── tagger/           Assisted tagging sessions
│       │   ├── storage/          Storage usage and quota controls
│       │   ├── explore/          Dataset discovery experience
│       │   ├── auth/ billing/ settings/
│       │   ├── agent-panel/ trajectory/
│       │   └── sidebar/ tutorial/
│       ├── shared/               Charts, hooks, layout, providers, types,
│       │                        API/auth/i18n utilities, and UI primitives
│       └── types/                App-wide ambient/shared TypeScript declarations
│
├── deploy/
│   ├── helm/skynet/             Kubernetes chart and environment values
│   └── litellm/                 Gateway image, config, callbacks, and local stack
├── docs/                        Auth, Stripe, and upstream-optimizer guides
├── i18n/                        Locale source catalogs, schema, and glossary
├── scripts/                     i18n generation, air-gap migration, sample data
├── data/                        Repository datasets/fixtures
├── submission-wizard-implementation-spec.md
├── Justfile                     Canonical local task shortcuts
└── README.md                    Product setup and API usage
```

Backend tests are primarily co-located under `core/**/tests/`; do not assume
that `backend/tests/unit/` is the complete unit-test suite. FastAPI route files
under `core/api/routers/optimizations/` are split further by lifecycle concern.

## Key local URLs

- **Frontend**: http://localhost:3000
- **Backend API**: http://localhost:8000
- **API reference**: http://localhost:8000/reference
- **OpenAPI document**: http://localhost:8000/openapi.json

## Running locally

```bash
# Install backend development dependencies.
just install

# Run both processes, or use `just backend` and `just frontend` separately.
just dev
```

Direct equivalents are `cd backend && uv run python main.py` and
`cd frontend && npm run dev`. Turbopack requires `frontend/node_modules` to be
a real directory inside the current worktree. Do not symlink that directory to
a sibling checkout; run `npm ci` in the worktree instead.

## Validation

```bash
# Backend lint and credential-free core/unit tests.
just lint-backend
cd backend && uv run --extra dev pytest core/ tests/unit/ -v

# Frontend CI gates.
cd frontend && npm run typecheck && npm run lint && npm run test:unit

# Production frontend build and generated-catalog drift.
cd frontend && npm run build
just check-i18n
```

`backend/tests/test_llm_integration.py` requires a running server and paid model
credentials; it is not part of the credential-free PR gate. Billing changes
must also pass `core/billing/tests/test_budgets_postgres.py` against a real
PostgreSQL URL in `SKYNET_BUDGET_TEST_DB_URL`. Backend dependency/runtime
changes must keep `uv.lock` and the pip requirements files aligned and pass both
stable and preview Docker build paths.

## Persistence and infrastructure

- PostgreSQL is authoritative for jobs, accounts, datasets, shares, billing,
  budgets, checkpoints, attempts, and usage. Configure it with `REMOTE_DB_URL`.
- Alembic owns schema changes under `backend/alembic/versions/`.
- Redis is optional and configured with `REDIS_URL`; distributed throttles fail
  open when it is absent.
- User workloads must not receive provider or MCP secrets. The control plane
  brokers only the selected credentials/tools and meters protected work before
  dispatch.

## Authentication

- There is no auth-off mode. Hosted deployments support backend-verified local
  accounts plus optional Google and GitHub OAuth.
- Setting `AUTH_SSO_ISSUER`, `AUTH_SSO_CLIENT_ID`, and
  `AUTH_SSO_CLIENT_SECRET` switches the frontend to the single on-prem OIDC/ADFS
  path.
- The frontend and backend share `BACKEND_AUTH_SECRET`; backend identity is the
  user's email across local, OAuth, and SSO providers.
- See `docs/AUTH_SETUP.md` and both `.env.example` files before changing auth.

## Internationalization and direction

- English is the default locale. Hebrew, Arabic, and Persian render RTL; the
  remaining supported locales render LTR.
- `i18n/locales/*.json` and `i18n/schema.json` are the source catalogs. Run
  `python3 scripts/generate_i18n.py` after catalog changes and
  `just check-i18n` before committing.
- Preserve direction, alignment, Unicode text, and locale-aware formatting in
  every shared component; do not hard-code Hebrew-only layout assumptions.

## Commenting, docstring & import style (MANDATORY — apply to all backend Python, every session)

These rules are durable. They apply to every backend Python file (under `backend/`, excluding `.venv/`, `__pycache__/`, and `alembic/versions/`) and to every future change. New code follows them; existing code is brought into compliance whenever it is touched.

- **Google-style docstrings on every function and method (public and private).** Format: a one-line imperative summary, then `Args:`, `Returns:`, and (only when the failure mode is non-obvious) `Raises:`. Skip the `Args:` / `Returns:` blocks only when **both** are trivially typed and the summary already covers them (e.g. tests that take no args and assert; private one-liners). Module docstrings are required at the top of every file.
- **Imports only at the top of the file. No exceptions.** No `import` inside a function, method, or conditional block anywhere except module top. Optional deps go in a module-level `try/except ImportError` that aliases the symbol to ``None``; tests that need fresh re-imports use ``importlib.import_module`` (a function call, not an ``import`` statement); circular imports are resolved structurally (slim `__init__.py`, leaf-module splits, `TYPE_CHECKING` blocks) — never with inline imports.
- **No WHAT-comments.** Don't restate what code does, label sections, or echo identifiers ("# loop over users", "# call API"). If a competent reader can understand the line by reading the line, the comment is dead weight — delete it.
- **WHY-comments only.** Comments are reserved for non-obvious intent: a hidden constraint, a workaround for a specific bug, surprising behavior, a subtle invariant, a non-trivial design decision, or a tracking ticket. If deleting the comment wouldn't confuse a future reader, the comment shouldn't exist.
- **Pydantic class docstrings are part of the OpenAPI contract** — see "Backend — Pydantic docstring OpenAPI drift" below before adding/removing them on `BaseModel` subclasses.

## Refactoring rules

### Backend — Pydantic docstring OpenAPI drift

When extracting a FastAPI route from `app.py` into a domain router, any
inline `class FooRequest(BaseModel)` you move must **keep or drop docstrings
exactly as in the source**. Pydantic emits the class docstring into the
OpenAPI schema as `components.schemas.FooRequest.description` — add one
where there wasn't one (or remove one that existed) and the `openapi.json`
hash drifts, failing the regression gate. If you need to document the
class for readers, use a comment above the class, not a docstring.

### Backend — domain router factory pattern

Extracted routers live under `backend/core/api/routers/`. Each exposes a
`create_<domain>_router(*, deps...) -> APIRouter` factory. `create_app`
wires them via `app.include_router(create_<domain>_router(...))`. Use
closures over factory parameters, not module-level globals, so the routes
can be tested in isolation with mocked dependencies.

### Frontend — feature slice pattern

Per-feature code lives under `frontend/src/features/<feature>/`:
- `components/` — presentational + orchestrator
- `hooks/` — state machines and data fetching
- `lib/` — pure functions (validators, formatters, builders)
- `constants.ts` — feature-local constants
- `index.ts` — public API; other features import only from here

`app/<feature>/page.tsx` should be a thin wrapper over the feature slice's
orchestrator component.
