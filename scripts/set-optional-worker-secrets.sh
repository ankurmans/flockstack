#!/usr/bin/env bash
# Sets what the two optional services need on the Workers that already run, one region at a time, from the owner's terminal. Nothing it
# handles is printed, put in a command line or written to a file: values go to `wrangler secret put` on its standard input.
# docs/OPTIONAL-WORKERS-RUNBOOK.md says when to run it; the Workers it sets values on must exist first.
#   bash scripts/set-optional-worker-secrets.sh replies us            # or eu
#       REPLY_INGEST_SECRET on the app, the API Worker and the replies Worker (one value; Enter at its prompt makes a random one nobody sees),
#       then REPLIES_DOMAIN on the app and the API Worker. The domain goes last: it is what makes the app write reply addresses.
#   bash scripts/set-optional-worker-secrets.sh replies us --off      # deletes REPLIES_DOMAIN and REPLY_INGEST_SECRET again (wrangler asks to confirm)
#   bash scripts/set-optional-worker-secrets.sh collaboration us      # COLLABORATION_ENABLED=true on the app and the API Worker, after you type the region
#   bash scripts/set-optional-worker-secrets.sh collaboration us --off
#   --dry-run     says what it would do, asks for nothing and changes nothing
# The collaboration Worker's own flag is a variable of its wrangler.jsonc, not a secret: the runbook sets it with `wrangler deploy --var`.
# bash 3.2 (macOS) is enough.
set -u
cd "$(dirname "$0")/.."
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-fe96ffccbfec88e9c8516169adb1fee2}"

usage() { echo "usage: bash scripts/set-optional-worker-secrets.sh replies|collaboration us|eu [--off] [--dry-run]" >&2; exit 1; }
service=""; region=""; off=0; dry=0
for arg in "$@"; do
  case "$arg" in
    replies|collaboration) service="$arg" ;;
    us|eu) region="$arg" ;;
    --off) off=1 ;;
    --dry-run) dry=1 ;;
    *) usage ;;
  esac
done
[ -z "$service" ] || [ -z "$region" ] && usage

suffix=""; [ "$region" = eu ] && suffix="-eu"
worker_name() { case "$1" in app) echo "flockstack$suffix" ;; api) echo "flockstack-api$suffix" ;; replies) echo "flockstack-replies$suffix" ;; esac; }
config_args() { # the app is the root config; the lean Workers have a config of their own. EU is env.eu in each.
  local args=""
  case "$1" in api) args="--config workers/api/wrangler.jsonc" ;; replies) args="--config workers/replies/wrangler.jsonc" ;; esac
  [ "$region" = eu ] && args="$args --env eu"
  echo "$args"
}

# put_secret NAME KIND: the value is in $VALUE, goes in on standard input and is never shown. Tries three times.
put_secret() {
  local name="$1" kind="$2" try out status
  if [ "$dry" = 1 ]; then echo "  would set $name on $(worker_name "$kind")"; return 0; fi
  for try in 1 2 3; do
    out=$(printf %s "$VALUE" | npx wrangler secret put "$name" $(config_args "$kind") 2>&1); status=$?
    if [ "$status" = 0 ]; then echo "  set $name on $(worker_name "$kind")"; return 0; fi
    echo "  could not set $name on $(worker_name "$kind") (try $try of 3): $(echo "$out" | grep -E "ERROR|error" | head -1)" >&2
    sleep "${FLOCKSTACK_OPTIONAL_RETRY_SLEEP:-2}"
  done
  return 1
}

delete_secret() { # NAME KIND: wrangler asks you to confirm
  local name="$1" kind="$2"
  if [ "$dry" = 1 ]; then echo "  would delete $name from $(worker_name "$kind")"; return 0; fi
  npx wrangler secret delete "$name" $(config_args "$kind") 2>&1 | grep -E "Success|ERROR|not found" | sed "s/^/  $(worker_name "$kind"): /"
}

echo "=== $region: $service$([ "$off" = 1 ] && echo " (switching off)") ==="
[ "$dry" = 1 ] && echo "(dry run: nothing is asked and nothing changes)"

if [ "$service" = collaboration ]; then
  if [ "$off" = 1 ]; then
    delete_secret COLLABORATION_ENABLED app; delete_secret COLLABORATION_ENABLED api
    echo "Off on the app and the API Worker. The collaboration Worker keeps answering 503 once its own COLLABORATION_ENABLED is false: redeploy it without --var."
    exit 0
  fi
  if [ "$dry" = 0 ]; then
    echo "This turns realtime editing on for every account of $region as soon as the app and the API Worker both have it, and the router and the app"
    echo "have their COLLABORATION_SOCKET binding. Do it only after the checks of docs/OPTIONAL-WORKERS-RUNBOOK.md before this step."
    read -r -p "Type the region ($region) to go on: " confirm
    [ "$confirm" = "$region" ] || { echo "Nothing is changed."; exit 1; }
  fi
  VALUE=true
  put_secret COLLABORATION_ENABLED app || exit 1
  put_secret COLLABORATION_ENABLED api || { echo "The API Worker does not have it: editing stays refused (it checks the session). Run this again, or: bash scripts/set-optional-worker-secrets.sh collaboration $region --off" >&2; exit 1; }
  echo; echo "Done. Switch it off again with: bash scripts/set-optional-worker-secrets.sh collaboration $region --off"
  exit 0
fi

# replies
if [ "$off" = 1 ]; then
  for name in REPLIES_DOMAIN REPLY_INGEST_SECRET; do delete_secret "$name" app; delete_secret "$name" api; done
  delete_secret REPLY_INGEST_SECRET replies
  echo "Off. Newsletters keep their reply inbox setting, but their next emails carry the direct reply-to again and the app answers 404 to the replies Worker."
  exit 0
fi

DOMAIN=""
if [ "$dry" = 0 ]; then
  echo "REPLIES_DOMAIN is the incoming subdomain of this region that Cloudflare Email Routing sends to $(worker_name replies), for example"
  echo "$([ "$region" = eu ] && echo "replies-eu.flockstack.io" || echo "replies.flockstack.io"). Not the apex of a domain that already receives mail."
  read -r -p "REPLIES_DOMAIN of $region: " DOMAIN
  DOMAIN=$(printf %s "$DOMAIN" | tr 'A-Z' 'a-z')
  if ! printf %s "$DOMAIN" | grep -Eq '^([a-z0-9-]+\.)+[a-z]{2,}$'; then echo "That is not a domain name. Nothing is changed." >&2; exit 1; fi
  case "$DOMAIN" in flockstack.io|eu.flockstack.io|www.flockstack.io) echo "That is the address of the app itself, not an incoming subdomain. Nothing is changed." >&2; exit 1 ;; esac
  read -r -s -p "REPLY_INGEST_SECRET (hidden; Enter makes a random one that is never shown): " SECRET; echo
  if [ -n "$SECRET" ]; then
    read -r -s -p "  again, to be sure it is the same: " AGAIN; echo
    if [ "$SECRET" != "$AGAIN" ]; then echo "  the two did not match. Nothing is changed." >&2; exit 1; fi
    unset AGAIN
  else
    SECRET=$(openssl rand -base64 48 | tr -d '\n')
    [ -z "$SECRET" ] && { echo "openssl gave no random value" >&2; exit 1; }
    echo "  made a random one"
  fi
fi

# The secret first, on the three Workers that check it; the domain last, because it is what starts the app writing reply addresses.
VALUE="${SECRET:-}"
for kind in app api replies; do
  put_secret REPLY_INGEST_SECRET "$kind" || { unset VALUE SECRET; echo "Stopped: $(worker_name "$kind") does not have it. Nothing writes reply addresses yet (no REPLIES_DOMAIN). Run this again: it sets one new value everywhere." >&2; exit 1; }
done
unset VALUE SECRET
VALUE="$DOMAIN"
for kind in app api; do
  put_secret REPLIES_DOMAIN "$kind" || { echo "Stopped: $(worker_name "$kind") does not have REPLIES_DOMAIN. Run this again." >&2; exit 1; }
done
unset VALUE
echo
echo "Done. Next: Email Routing for $([ "$dry" = 1 ] && echo "the domain" || echo "$DOMAIN"), then a test reply (docs/OPTIONAL-WORKERS-RUNBOOK.md). Switch off: bash scripts/set-optional-worker-secrets.sh replies $region --off"
