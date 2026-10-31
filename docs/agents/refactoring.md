# Refactoring rules

Reference for coding agents. The always-on rules are in `AGENTS.md`.

## Backend — Pydantic docstring OpenAPI drift

When extracting a FastAPI route from `app.py` into a domain router, any
inline `class FooRequest(BaseModel)` you move must **keep or drop docstrings
exactly as in the source**. Pydantic emits the class docstring into the
OpenAPI schema as `components.schemas.FooRequest.description` — add one
where there wasn't one (or remove one that existed) and the published
`openapi.json` changes. No test guards this any more (the old schema-hash
regression test was removed), so compare the schema before and after by hand,
e.g. with `.claude/skills/verify-skynet-api/scripts/openapi-hash.sh`. If you
need to document the class for readers, use a comment above the class, not a
docstring.

## Backend — domain router factory pattern

Extracted routers live under `backend/core/api/routers/`. Each exposes a
`create_<domain>_router(*, deps...) -> APIRouter` factory. `create_app`
wires them via `app.include_router(create_<domain>_router(...))`. Use
closures over factory parameters, not module-level globals, so the routes
can be tested in isolation with mocked dependencies.

## Frontend — feature slice pattern

Per-feature code lives under `frontend/src/features/<feature>/`:
- `components/` — presentational + orchestrator
- `hooks/` — state machines and data fetching
- `lib/` — pure functions (validators, formatters, builders)
- `constants.ts` — feature-local constants
- `index.ts` — public API; other features import only from here

`app/<feature>/page.tsx` should be a thin wrapper over the feature slice's
orchestrator component.
