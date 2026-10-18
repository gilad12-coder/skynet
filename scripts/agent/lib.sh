# Shared helpers for scripts/agent/*.sh. Source this file; do not run it.
#
# Each script writes one timestamped log under .claude/logs/ and points the
# link <name>-latest.log at it, so an agent can always read the newest run. Output goes
# through `redact` first, so a secret that a tool prints never reaches the log.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="$ROOT/.claude/logs"
mkdir -p "$LOG_DIR"

STEPS_OK=0
STEPS_WARN=0
STEPS_FAIL=0
SUMMARY=""

# Mask credentials in URLs, common API key shapes and KEY=value secrets.
redact() {
  sed -E \
    -e 's#(://[^:/@[:space:]]+:)[^@[:space:]]+@#\1***@#g' \
    -e 's#(sk|rk|pk)-[A-Za-z0-9_-]{8,}#\1-***#g' \
    -e 's#(gh[pousr]_)[A-Za-z0-9]{16,}#\1***#g' \
    -e 's#((SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z_]*=)[^[:space:]]+#\1***#g'
}

# Start logging: everything this shell prints goes to the terminal and the log.
start_log() {
  local name="$1"
  LOG_FILE="$LOG_DIR/$name-$(date +%Y%m%d-%H%M%S).log"
  LATEST="$LOG_DIR/$name-latest.log"
  ln -sf "$(basename "$LOG_FILE")" "$LATEST"
  exec > >(redact | tee "$LOG_FILE") 2>&1
  echo "# $name run $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# root: $ROOT"
  echo "# branch: $(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null) @ $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null)"
}

# record <OK|WARN|FAIL|SKIP> <step> <detail>
record() {
  local status="$1" step="$2" detail="${3:-}"
  case "$status" in
    OK|SKIP) STEPS_OK=$((STEPS_OK + 1)) ;;
    WARN) STEPS_WARN=$((STEPS_WARN + 1)) ;;
    FAIL) STEPS_FAIL=$((STEPS_FAIL + 1)) ;;
  esac
  SUMMARY+="$(printf '%-5s %-22s %s' "$status" "$step" "$detail")"$'\n'
  echo "==> [$status] $step${detail:+ — $detail}"
}

# timed <step> <command...>: run a command, record OK or FAIL with its time.
timed() {
  local step="$1"; shift
  local start=$SECONDS
  echo "--> $step: $*"
  if "$@"; then
    record OK "$step" "$((SECONDS - start))s"
  else
    record FAIL "$step" "exit $? after $((SECONDS - start))s"
  fi
}

have() { command -v "$1" >/dev/null 2>&1; }

# Print the summary. Return 1 on any FAIL.
finish() {
  echo
  echo "## Summary ($STEPS_OK ok, $STEPS_WARN warn, $STEPS_FAIL fail, ${SECONDS}s)"
  printf '%s' "$SUMMARY"
  echo "# log: $LOG_FILE"
  [ "$STEPS_FAIL" -eq 0 ]
}
