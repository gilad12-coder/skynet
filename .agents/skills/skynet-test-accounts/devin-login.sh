# Sign in to Skynet staging or a PR preview with a test account from secrets.
# Usage (bash): N=1 APP=https://staging.skynetml.com API=https://api-staging.skynetml.com . ./devin-login.sh
# Sets TOKEN for the devin-$N account (or PREFIX=SKYNET_PR_<n> for a preview account). Prints only the HTTP status of the check.
PREFIX="${PREFIX:-SKYNET_DEVIN_${N}}"; EMAIL_VAR="${PREFIX}_EMAIL"; PASS_VAR="${PREFIX}_PASSWORD"
JAR=$(mktemp); DOH=(--doh-url https://cloudflare-dns.com/dns-query)
CSRF=$(curl -s "${DOH[@]}" -c "$JAR" -b "$JAR" "$APP/api/auth/csrf" | python3 -c 'import sys,json;print(json.load(sys.stdin)["csrfToken"])')
curl -s "${DOH[@]}" -o /dev/null -c "$JAR" -b "$JAR" -H 'X-Auth-Return-Redirect: 1' \
  --data-urlencode "email=$(printenv "$EMAIL_VAR")" --data-urlencode "password=$(printenv "$PASS_VAR")" \
  --data-urlencode "csrfToken=$CSRF" --data-urlencode "callbackUrl=$APP" "$APP/api/auth/callback/credentials"
TOKEN=$(curl -s "${DOH[@]}" -c "$JAR" -b "$JAR" "$APP/api/auth/session" | python3 -c 'import sys,json;print((json.load(sys.stdin) or {}).get("backendAccessToken",""))')
rm -f "$JAR"
curl -s "${DOH[@]}" -o /dev/null -w 'login check: HTTP %{http_code}\n' -H "authorization: Bearer $TOKEN" "$API/account/experience"
