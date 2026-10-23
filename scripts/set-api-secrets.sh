#!/usr/bin/env bash
# Sets the secrets the lean API Worker needs, region by region, by asking for each value. Values are typed or pasted at a prompt, go
# straight to `wrangler secret put` and are never printed. BETTER_AUTH_SECRET and SUPPRESSION_HASH_KEY are not asked for here: they
# were rotated on the app and the API Worker together (docs/ARCHITECTURE-WORKERS.md, section 5).
#   bash scripts/set-api-secrets.sh us      # or eu, or: bash scripts/set-api-secrets.sh us eu
# Press Enter on a prompt to skip it (a missing one fails only the routes that use it). A value in [brackets] is a suggestion: Enter accepts it.
set -u
cd "$(dirname "$0")/.."
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-fe96ffccbfec88e9c8516169adb1fee2}"

# name|kind|what it is. kind: plain (shown as you type) or secret (hidden).
NAMES="ADMIN_EMAILS|plain|comma-separated emails of the FlockStack admins
APP_URL|plain|the region's address
ARCHIVE_CNAME_TARGET|plain|where customers point their newsletter subdomain
ARCHIVE_TRUSTED_HOSTS|plain|hosts this Worker answers for itself, comma-separated (newsletter.ankur.works)
EMAIL_FROM|plain|the From address of FlockStack's own emails
EMAIL_PROVIDER|plain|ses
IMAGES_CDN_URL|plain|the public address of the region's images bucket
SENDING_ENABLED|plain|true when the region may send
SES_REGION|plain|the AWS region of this FlockStack region's SES
SES_AWS_ACCOUNT_ID|plain|the AWS account id
SES_SNS_TOPIC_ARN|plain|the SNS topic ARN of this region's SES events
QSTASH_URL|plain|the region's QStash address
QSTASH_TOKEN|secret|the region's QStash token
SES_ACCESS_KEY_ID|secret|the IAM access key id for SES
SES_SECRET_ACCESS_KEY|secret|the IAM secret access key for SES
POLAR_ACCESS_TOKEN|secret|the full-scope Polar token
CLOUDFLARE_API_TOKEN|secret|the Cloudflare token the app uses for custom domains
CLOUDFLARE_SAAS_ZONE_ID|plain|the zone id of the SaaS zone (custom hostnames)"

suggest() { # region, name -> a suggestion or nothing
  case "$1:$2" in
    us:APP_URL) echo "https://flockstack.io" ;;
    eu:APP_URL) echo "https://eu.flockstack.io" ;;
    us:ARCHIVE_CNAME_TARGET) echo "sites.flockstack.io" ;;
    eu:ARCHIVE_CNAME_TARGET) echo "sites-eu.flockstack.io" ;;
    us:QSTASH_URL) echo "https://qstash-us-east-1.upstash.io" ;;
    eu:QSTASH_URL) echo "https://qstash-eu-central-1.upstash.io" ;;
    *:EMAIL_PROVIDER) echo "ses" ;;
    *:SENDING_ENABLED) echo "true" ;;
    eu:SES_REGION) echo "eu-west-1" ;;
    *:SES_AWS_ACCOUNT_ID) echo "979604620339" ;;
  esac
}

# Answers that are the same in every region are kept in KEEP_<name> variables and offered again for the next region (bash 3.2 has no arrays by name).
for region in "$@"; do
  case "$region" in us|eu) ;; *) echo "region must be us or eu" >&2; exit 1 ;; esac
  extra=(--config workers/api/wrangler.jsonc); [ "$region" = eu ] && extra+=(--env eu)
  echo; echo "=== $region: flockstack-api$([ "$region" = eu ] && echo -eu) ==="
  while IFS='|' read -r -u 3 name kind note; do
    [ -z "$name" ] && continue
    default=$(suggest "$region" "$name"); keepvar="KEEP_$name"; [ -z "$default" ] && default="${!keepvar:-}"
    prompt="$name ($note)"; [ -n "$default" ] && [ "$kind" = plain ] && prompt="$prompt [$default]"
    [ -n "$default" ] && [ "$kind" = secret ] && prompt="$prompt [Enter reuses the one you gave for the other region]"
    if [ "$kind" = secret ]; then read -r -s -p "$prompt: " value; echo; else read -r -p "$prompt: " value; fi
    [ -z "$value" ] && value="$default"
    if [ -z "$value" ]; then echo "  skipped $name"; continue; fi
    printf %s "$value" | npx wrangler secret put "$name" "${extra[@]}" 2>&1 | grep -E "Success|ERROR" | sed "s/^/  /"
    case "$name" in ADMIN_EMAILS|EMAIL_FROM|EMAIL_PROVIDER|SENDING_ENABLED|SES_ACCESS_KEY_ID|SES_SECRET_ACCESS_KEY|SES_AWS_ACCOUNT_ID|POLAR_ACCESS_TOKEN|CLOUDFLARE_API_TOKEN|CLOUDFLARE_SAAS_ZONE_ID|ARCHIVE_TRUSTED_HOSTS) printf -v "KEEP_$name" %s "$value" ;; esac
    unset value
  done 3<<< "$NAMES"
done
echo; echo "Done. Names now on the API Worker:"
for region in "$@"; do
  extra=(--config workers/api/wrangler.jsonc); [ "$region" = eu ] && extra+=(--env eu)
  printf "  %s: " "$region"; npx wrangler secret list "${extra[@]}" 2>&1 | grep -o '"name": "[A-Z_0-9]*"' | sed 's/"name": //' | tr -d '"' | tr '\n' ' '; echo
done
