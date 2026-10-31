#!/usr/bin/env bash
# Works with the hand-filled secrets skynet/<env>/{app,frontend,litellm}.
# It prints key NAMES only, never values.
#
#   secrets.sh template <env> <app|frontend|litellm>  > file.json
#       Prints a JSON object with every key the task definitions read, each
#       set to "". Fill the values in the file (keep it outside the repo).
#   secrets.sh put <env> <app|frontend|litellm> <file.json>
#       Stores the file as the secret value. Fails if a key is missing.
#   secrets.sh check <env>
#       Lists the keys that the task definitions read but the secrets lack.
#   secrets.sh check-empty <env>
#       Lists the keys of app, frontend and litellm whose value is empty or
#       only spaces (a template placeholder). Prints names only.
#   secrets.sh set <env|dev> <app|frontend|litellm> <KEY>
#       Reads one value from a hidden prompt (or the first line of stdin when
#       stdin is not a terminal) and stores it under KEY. All other keys stay
#       as they are. The value never goes on a command line or to the screen.
#       env "dev" is the local development secret skynet/dev/<name>.
#
# The key list comes from the latest task definitions, so run Terraform first.

source "$(dirname "$0")/lib.sh"
need aws jq

cmd="${1:-}"
env="${2:-}"
if [[ "$cmd" == set && "$env" == dev ]]; then
  :
else
  check_env "$env"
fi

# Families that read each secret.
families_for() {
  case "$1" in
    app) echo "backend worker migrate" ;;
    frontend) echo "frontend" ;;
    litellm) echo "litellm" ;;
    *) die "secret must be app, frontend or litellm" ;;
  esac
}

# Prints the sorted key names that task definitions read from skynet/<env>/<name>.
keys_for() {
  local name="$1" arn f
  arn="$(aws secretsmanager describe-secret --secret-id "skynet/$env/$name" --query ARN --output text)"
  for f in $(families_for "$name"); do
    aws ecs describe-task-definition --task-definition "skynet-$env-$f" \
      --query 'taskDefinition.containerDefinitions[0].secrets[].valueFrom' --output json |
      jq -r --arg a "$arn:" '.[] | select(startswith($a)) | ltrimstr($a) | split(":")[0]'
  done | sort -u
}

# Prints the key names that the stored secret value has (values are dropped in jq).
stored_keys() {
  aws secretsmanager get-secret-value --secret-id "skynet/$env/$1" --query SecretString --output text 2>/dev/null |
    jq -r 'keys[]' 2>/dev/null | sort -u || true
}

case "$cmd" in
  template)
    keys_for "${3:-}" | jq -R . | jq -s 'map({(.): ""}) | add'
    ;;
  put)
    name="${3:-}"
    file="${4:-}"
    [[ -f "$file" ]] || die "file not found: $file"
    jq -e 'type == "object" and all(.[]; type == "string")' "$file" >/dev/null ||
      die "$file must be a JSON object of string values"
    missing="$(comm -23 <(keys_for "$name") <(jq -r 'keys[]' "$file" | sort -u))"
    [[ -z "$missing" ]] || die "missing keys in $file: $(tr '\n' ' ' <<<"$missing")"
    aws secretsmanager put-secret-value --secret-id "skynet/$env/$name" \
      --secret-string "file://$file" --query VersionId --output text >/dev/null
    echo "stored skynet/$env/$name ($(jq 'length' "$file") keys)"
    ;;
  check)
    ok=1
    for name in app frontend litellm; do
      missing="$(comm -23 <(keys_for "$name") <(stored_keys "$name"))"
      if [[ -n "$missing" ]]; then
        ok=0
        echo "skynet/$env/$name is missing: $(tr '\n' ' ' <<<"$missing")"
      else
        echo "skynet/$env/$name: all keys present"
      fi
    done
    [[ "$ok" == 1 ]] || exit 1
    ;;
  check-empty)
    ok=1
    for name in app frontend litellm; do
      # jq stderr is dropped and the error text is fixed: a jq message can
      # quote part of a value.
      empty="$(aws secretsmanager get-secret-value --secret-id "skynet/$env/$name" \
        --query SecretString --output text |
        jq -r 'if type == "object" then to_entries[] | select(.value | tostring | test("^\\s*$")) | .key
               else error("not a JSON object") end' 2>/dev/null)" || {
        ok=0
        echo "skynet/$env/$name: cannot read it, or it is not a JSON object"
        continue
      }
      if [[ -n "$empty" ]]; then
        ok=0
        echo "skynet/$env/$name has empty values: $(sort <<<"$empty" | tr '\n' ' ')"
      else
        echo "skynet/$env/$name: no empty values"
      fi
    done
    [[ "$ok" == 1 ]] || exit 1
    ;;
  set)
    name="${3:-}"
    key="${4:-}"
    families_for "$name" >/dev/null
    [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || die "KEY must be upper case letters, digits and _"
    id="skynet/$env/$name"

    # The value stays in shell variables and pipes from builtins (printf,
    # read), so it is never in a process argument list.
    value=""
    if [[ -t 0 ]]; then
      IFS= read -r -s -p "value for $key in $id (hidden): " value || true
      echo >&2
    else
      IFS= read -r value || true
    fi
    [[ -n "$value" ]] || die "empty value; $id not changed"

    # A secret that Terraform just created has no version yet: start from {}.
    # Any read error stops the script (set -e), so a failed read can never
    # turn into a write that drops the other keys.
    stages="$(aws secretsmanager describe-secret --secret-id "$id" --query VersionIdsToStages --output json)"
    has_current="$(printf '%s' "$stages" | jq 'any((. // {})[]; index("AWSCURRENT") != null)')"
    current="{}"
    if [[ "$has_current" == true ]]; then
      current="$(aws secretsmanager get-secret-value --secret-id "$id" --query SecretString --output text)"
    fi

    # Read-modify-write of one key. jq fails (stderr dropped: it can quote a
    # value) unless the old value is an object of strings and every old key
    # is still in the new object.
    new="$({
      printf '%s\n' "$current"
      printf '%s' "$value" | jq -Rs .
    } | jq -nc --arg k "$key" '
      input as $old | input as $v
      | if ($old | type) == "object" and ($old | all(.[]; type == "string"))
        then . else error("bad") end
      | ($old + {($k): $v}) as $new
      | if (($old | keys) - ($new | keys)) != [] then error("bad") else $new end
    ' 2>/dev/null)" || die "$id is not a JSON object of string values; not changed"

    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    (
      umask 077
      printf '%s' "$new" >"$tmp/secret.json"
    )
    aws secretsmanager put-secret-value --secret-id "$id" \
      --secret-string "file://$tmp/secret.json" --query VersionId --output text >/dev/null
    echo "set $key in $id ($(printf '%s' "$new" | jq 'length') keys)"
    ;;
  *)
    die "usage: secrets.sh template|put|check|check-empty|set <env> ..."
    ;;
esac
