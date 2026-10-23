#!/usr/bin/env bash
# The five credentials the API Worker needs that cannot be copied from the app, asked one at a time. Values are typed or pasted at a
# prompt (hidden), go straight to `wrangler secret put` and are never printed. Everything that is not a credential is set by
# scripts/set-api-secrets.sh (or by hand). Press Enter on a prompt to skip it: a missing one fails only the routes that use it.
#   bash scripts/set-api-tokens.sh us eu
set -u
cd "$(dirname "$0")/.."
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-fe96ffccbfec88e9c8516169adb1fee2}"

ask() { # region, name, what -> reads one hidden value and puts it, or skips
  local region=$1 name=$2 what=$3 value
  local extra=(--config workers/api/wrangler.jsonc); [ "$region" = eu ] && extra+=(--env eu)
  read -r -s -p "[$region] $name ($what), then Enter (Enter alone skips): " value; echo
  if [ -z "$value" ]; then echo "  skipped $name"; return; fi
  printf %s "$value" | npx wrangler secret put "$name" "${extra[@]}" 2>&1 | grep -E "Success|ERROR" | head -1 | sed 's/^/  /'
  unset value
}

for region in "$@"; do
  case "$region" in us|eu) ;; *) echo "region must be us or eu" >&2; exit 1 ;; esac
  echo; echo "=== $region ==="
  ask "$region" QSTASH_TOKEN "the $region QStash instance's token, as in the schedule commands"
  ask "$region" SES_ACCESS_KEY_ID "the IAM access key id of the SES user"
  ask "$region" SES_SECRET_ACCESS_KEY "the matching secret access key"
  ask "$region" POLAR_ACCESS_TOKEN "the full-scope Polar token"
  ask "$region" CLOUDFLARE_API_TOKEN "the Cloudflare API token the app uses for custom domains"
done
echo; echo "Names now on the API Workers:"
for region in "$@"; do
  extra=(--config workers/api/wrangler.jsonc); [ "$region" = eu ] && extra+=(--env eu)
  printf "  %s: " "$region"; npx wrangler secret list "${extra[@]}" 2>&1 | grep -o '"name": "[A-Z_0-9]*"' | sed 's/"name": //' | tr -d '"' | tr '\n' ' '; echo
done
