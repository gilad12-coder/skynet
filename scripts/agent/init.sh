#!/usr/bin/env bash
# Deterministic install for a fresh clone or worktree. Safe to run again.
#
# Runs from `just setup` and from the Claude Code Setup hook (`init` matcher,
# fired by `claude --init-only` or `claude -p --init`). The /install prompt
# reads the log this script writes to .claude/logs/init-latest.log.
#
# Rules: never overwrite an existing .env file, never print a secret value.

# shellcheck source=scripts/agent/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
start_log init
cd "$ROOT" || exit 1

# --- Tools -------------------------------------------------------------------
missing=""
for tool in uv node npm python3; do
  have "$tool" || missing+=" $tool"
done
if [ -n "$missing" ]; then
  record FAIL tools "missing:$missing"
else
  record OK tools "uv $(uv --version | awk '{print $2}'), node $(node --version), python3 $(python3 -c 'import sys;print(sys.version.split()[0])')"
fi
for tool in just docker pg_isready gh; do
  have "$tool" || record WARN "tool:$tool" "not installed (optional)"
done

# --- Git hooks ---------------------------------------------------------------
# .githooks/pre-commit runs gitleaks on staged changes. Keep a hooks path that
# someone set on purpose.
hooks_path="$(git config --get core.hooksPath || true)"
if [ -z "$hooks_path" ]; then
  git config core.hooksPath .githooks
  record OK hooks "core.hooksPath set to .githooks"
elif [ "$hooks_path" = .githooks ]; then
  record OK hooks "core.hooksPath is .githooks"
else
  record WARN hooks "core.hooksPath is $hooks_path, not .githooks; the gitleaks hook is off"
fi
have gitleaks || record WARN "tool:gitleaks" "not installed; the pre-commit hook blocks commits (brew install gitleaks)"

# --- Env files ---------------------------------------------------------------
# A new copy gets random auth secrets, so the backend and frontend agree with
# no human step. An existing file is never changed.
replace_placeholder() {
  local file="$1" key="$2" value="$3"
  python3 - "$file" "$key" "$value" <<'PY'
import sys
path, key, value = sys.argv[1:4]
lines = open(path).read().splitlines(keepends=True)
out = [f"{key}={value}\n" if l.startswith(f"{key}=change-me") else l for l in lines]
open(path, "w").write("".join(out))
PY
}

shared_secret="$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')"
copy_env() {
  local example="$1" target="$2"
  if [ -f "$target" ]; then
    record OK "env:$target" "exists, not changed"
    return
  fi
  cp "$example" "$target"
  replace_placeholder "$target" BACKEND_AUTH_SECRET "$shared_secret"
  replace_placeholder "$target" AUTH_SECRET "$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')"
  record OK "env:$target" "created from $example with new auth secrets"
}
copy_env backend/.env.example backend/.env
copy_env frontend/.env.example frontend/.env.local

# Report only whether each key has a real value. Never print the value.
env_state() {
  local file="$1" key="$2" line
  line="$(grep -E "^$key=" "$file" 2>/dev/null | tail -1)"
  case "${line#*=}" in
    "") echo missing ;;
    *replace-me*|*change-me*|*your-company*) echo placeholder ;;
    *) echo set ;;
  esac
}
for key in REMOTE_DB_URL BACKEND_AUTH_SECRET; do
  state="$(env_state backend/.env "$key")"
  [ "$state" = set ] && record OK "backend:$key" set || record WARN "backend:$key" "$state — edit backend/.env"
done
for key in NEXT_PUBLIC_API_URL AUTH_SECRET BACKEND_AUTH_SECRET; do
  state="$(env_state frontend/.env.local "$key")"
  [ "$state" = set ] && record OK "frontend:$key" set || record WARN "frontend:$key" "$state — edit frontend/.env.local"
done

# --- Dependencies ------------------------------------------------------------
timed "uv sync" bash -c "cd backend && uv sync --extra dev --frozen"

# npm ci deletes node_modules first, so skip it when the install already
# matches the lockfile. Turbopack needs a real node_modules dir, not a symlink.
lock=frontend/package-lock.json
installed=frontend/node_modules/.package-lock.json
if [ -L frontend/node_modules ]; then
  record FAIL "npm ci" "frontend/node_modules is a symlink; remove it and run again"
elif [ -f "$installed" ] && [ "$installed" -nt "$lock" ]; then
  record OK "npm ci" "node_modules matches lockfile, skipped"
else
  timed "npm ci" bash -c "cd frontend && npm ci --no-audit --no-fund --loglevel=error"
fi

# --- Services ----------------------------------------------------------------
pg_up=0
if have pg_isready && pg_isready -q -h localhost -p 5432; then
  pg_up=1
  record OK postgres ":5432 accepts connections"
else
  record WARN postgres ":5432 not reachable — start Postgres (brew services start postgresql@16)"
fi

if curl -fsS -m 3 http://localhost:4000/health/liveliness >/dev/null 2>&1; then
  record OK litellm ":4000 is up"
else
  record WARN litellm ":4000 not reachable — LLM features off; run: cd deploy/litellm && docker compose up -d"
fi

# --- Database ----------------------------------------------------------------
db_state="$(env_state backend/.env REMOTE_DB_URL)"
if [ "$db_state" != set ]; then
  record SKIP migrations "REMOTE_DB_URL is $db_state"
elif [ "$pg_up" -eq 0 ]; then
  record SKIP migrations "Postgres not reachable"
else
  timed migrations bash -c "cd backend && uv run --frozen --env-file .env alembic upgrade head"
fi

# --- i18n --------------------------------------------------------------------
timed "i18n check" python3 scripts/generate_i18n.py --check

finish
