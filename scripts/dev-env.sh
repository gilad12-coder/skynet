#!/usr/bin/env bash
# Copies the local development keys from AWS Secrets Manager into this
# worktree's git-ignored env files (SKY-186):
#
#   skynet/dev/app       -> backend/.env
#   skynet/dev/frontend  -> frontend/.env.local
#   skynet/dev/litellm   -> deploy/litellm/.env
#
# It reads skynet/dev/* only, never staging or production secrets. For each
# key with a non-empty value it replaces the KEY= line in the file, or adds
# one. Other lines stay as they are. It prints key names only, never values.
# Run `just setup` first: it creates backend/.env and frontend/.env.local.
#
# Usage: scripts/dev-env.sh            (AWS profile `skynet`, us-east-2)

# shellcheck source=infra/terraform/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../infra/terraform/scripts/lib.sh"
need aws jq python3

root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"

# Reads the secret JSON on stdin and writes the keys into the file in argv[1]
# (argv[2] is its name for messages).
# Values that a .env parser could misread are single-quoted; a value with a
# newline or a single quote is skipped (its name is printed).
read -r -d '' merge_py <<'PY' || true
import json, os, re, sys, tempfile

path, label = sys.argv[1], sys.argv[2]
data = json.load(sys.stdin)
if not isinstance(data, dict):
    sys.exit("not a JSON object")

def render(value):
    if re.fullmatch(r"[A-Za-z0-9_./:@+=,%~-]*", value):
        return value
    return "'" + value + "'"

with open(path) as f:
    lines = f.read().splitlines(keepends=True)

done, skipped = [], []
for key in sorted(data):
    value = data[key]
    if not isinstance(value, str) or value == "" or not re.fullmatch(r"[A-Z][A-Z0-9_]*", key):
        continue
    if "\n" in value or "\r" in value or "'" in value:
        skipped.append(key)
        continue
    line = f"{key}={render(value)}\n"
    hits = [i for i, l in enumerate(lines) if l.startswith(f"{key}=")]
    for i in hits:
        lines[i] = line
    if not hits:
        if lines and not lines[-1].endswith("\n"):
            lines[-1] += "\n"
        lines.append(line)
    done.append(key)

fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".dev-env-")
with os.fdopen(fd, "w") as f:
    f.write("".join(lines))
os.replace(tmp, path)

print(f"{label}: set {len(done)} keys: {' '.join(done) or '-'}")
if skipped:
    print(f"{label}: skipped (newline or ' in the value, edit by hand): {' '.join(skipped)}")
PY

pull() {
  local name="$1" file="$root/$2" hint="$3" id="skynet/dev/$1" stages has_current
  if [[ ! -f "$file" ]]; then
    echo "$2: missing, skipped ($hint)"
    return
  fi
  stages="$(aws secretsmanager describe-secret --secret-id "$id" --query VersionIdsToStages --output json)"
  has_current="$(printf '%s' "$stages" | jq 'any((. // {})[]; index("AWSCURRENT") != null)')"
  if [[ "$has_current" != true ]]; then
    echo "$id: no value yet, skipped (secrets.sh set dev $name <KEY>)"
    return
  fi
  aws secretsmanager get-secret-value --secret-id "$id" --query SecretString --output text |
    python3 -c "$merge_py" "$file" "$2"
}

pull app backend/.env "run just setup"
pull frontend frontend/.env.local "run just setup"
pull litellm deploy/litellm/.env "cp deploy/litellm/.env.example deploy/litellm/.env"
