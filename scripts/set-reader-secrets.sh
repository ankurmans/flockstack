#!/usr/bin/env bash
# Sets the secrets and variables the lean readers Worker (workers/readers) needs, region by region, by asking for each value. Values are
# typed or pasted at a prompt, go straight to `wrangler secret put` and are never printed. `node scripts/readers-env.mjs` says which
# endpoint reads which name. Deploy the Worker first (`node scripts/deploy-all.mjs --only us`): it answers nothing until the router's
# READERS_ENABLED switches it on, so there is time to do this.
#   bash scripts/set-reader-secrets.sh us      # or eu, or: bash scripts/set-reader-secrets.sh us eu
#
# BETTER_AUTH_SECRET and SUPPRESSION_HASH_KEY are asked for here, hidden and twice: their values cannot be read back from the app, and
# they have to be the app's own values for that region. BETTER_AUTH_SECRET signs the tokens in the links of emails already sent (open
# pixel, click, unsubscribe, confirm): with another value every one of those links fails (an open is not counted, a click is refused
# as unsigned and shows the "Continue" page, an unsubscribe says the link is invalid). SUPPRESSION_HASH_KEY hashes addresses for the
# suppression lists: with another value a suppressed address no longer matches. The two prompts accept nothing but a matching pair.
# The regions' values are asked for separately and never offered for the other region (rotating them is per region).
#
# Press Enter on a prompt to skip it (a missing one fails only what uses it). A value in [brackets] is a suggestion: Enter accepts it.
# bash 3.2 (macOS) is enough: the list of questions is read from file descriptor 3, so each answer is read from the keyboard.
set -u
cd "$(dirname "$0")/.."
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-fe96ffccbfec88e9c8516169adb1fee2}"

# name|kind|what it is. kind: plain (shown as you type), secret (hidden) or pair (hidden, asked twice). Keep in step with
# VARIABLES in scripts/readers-env.mjs (tests/readers-secrets.test.mjs checks it).
NAMES="BETTER_AUTH_SECRET|pair|the region's app value; signs the links of emails already sent
SUPPRESSION_HASH_KEY|pair|the region's app value; hashes addresses for the suppression lists
APP_URL|plain|the region's address
SHARED_DOMAIN|plain|the shared newsletter domain of the region
ARCHIVE_CNAME_TARGET|plain|where customers point their newsletter subdomain
ARCHIVE_TRUSTED_HOSTS|plain|hosts this Worker answers for itself, comma-separated (newsletter.ankur.works)
ADMIN_EMAILS|plain|comma-separated emails of the FlockStack admins
EMAIL_FROM|plain|the From address of FlockStack's own emails
EMAIL_PROVIDER|plain|ses
SENDING_ENABLED|plain|true when the region may send
SES_AWS_ACCOUNT_ID|plain|the AWS account id
SES_REGION|plain|the AWS region of this FlockStack region's SES
SES_SNS_TOPIC_ARN|plain|the SNS topic ARN of this region's SES events
SEND_RATE_PER_SECOND|plain|the region's SES send rate per second
SES_ACCESS_KEY_ID|secret|the IAM access key id for SES (the app's)
SES_SECRET_ACCESS_KEY|secret|the IAM secret access key for SES (the app's)
QSTASH_URL|plain|the region's QStash address
QSTASH_TOKEN|secret|the region's QStash token
UPSTASH_REDIS_REST_URL|plain|the region's Upstash Redis address (rate limits), if the app has one
UPSTASH_REDIS_REST_TOKEN|secret|the token for the Upstash Redis above"

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

# Answers that are the same in every region are kept in KEEP_<name> variables and offered again for the next region (bash 3.2 has no
# arrays by name). Never for the two signing values.
for region in "$@"; do
  case "$region" in us|eu) ;; *) echo "region must be us or eu" >&2; exit 1 ;; esac
  extra=(--config workers/readers/wrangler.jsonc); [ "$region" = eu ] && extra+=(--env eu)
  echo; echo "=== $region: flockstack-readers$([ "$region" = eu ] && echo -eu) ==="
  while IFS='|' read -r -u 3 name kind note; do
    [ -z "$name" ] && continue
    default=$(suggest "$region" "$name"); keepvar="KEEP_$name"; [ -z "$default" ] && [ "$kind" != pair ] && default="${!keepvar:-}"
    prompt="$name ($note)"; [ -n "$default" ] && [ "$kind" = plain ] && prompt="$prompt [$default]"
    [ -n "$default" ] && [ "$kind" = secret ] && prompt="$prompt [Enter reuses the one you gave for the other region]"
    if [ "$kind" = plain ]; then
      read -r -p "$prompt: " value
    else
      read -r -s -p "$prompt: " value; echo
      if [ "$kind" = pair ] && [ -n "$value" ]; then
        read -r -s -p "  again, to be sure it is the same: " again; echo
        if [ "$value" != "$again" ]; then echo "  the two did not match: skipped $name, run this again"; unset value again; continue; fi
        unset again
      fi
    fi
    [ -z "$value" ] && value="$default"
    if [ -z "$value" ]; then echo "  skipped $name"; continue; fi
    printf %s "$value" | npx wrangler secret put "$name" "${extra[@]}" 2>&1 | grep -E "Success|ERROR" | sed "s/^/  /"
    case "$name" in ADMIN_EMAILS|EMAIL_FROM|EMAIL_PROVIDER|SENDING_ENABLED|SES_ACCESS_KEY_ID|SES_SECRET_ACCESS_KEY|SES_AWS_ACCOUNT_ID|ARCHIVE_TRUSTED_HOSTS) printf -v "KEEP_$name" %s "$value" ;; esac
    unset value
  done 3<<< "$NAMES"
done
echo; echo "Done. Names now on the readers Worker:"
for region in "$@"; do
  extra=(--config workers/readers/wrangler.jsonc); [ "$region" = eu ] && extra+=(--env eu)
  printf "  %s: " "$region"; npx wrangler secret list "${extra[@]}" 2>&1 | grep -o '"name": "[A-Z_0-9]*"' | sed 's/"name": //' | tr -d '"' | tr '\n' ' '; echo
done
