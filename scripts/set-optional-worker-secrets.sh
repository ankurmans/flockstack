#!/usr/bin/env bash
# Sets what the optional services need on the Workers that already run, one region at a time, from the owner's terminal. Nothing it
# handles is printed, put in a command line or written to a file: values go to `wrangler secret put` on its standard input.
# docs/OPTIONAL-WORKERS-RUNBOOK.md says when to run it; the Workers it sets values on must exist first.
#   bash scripts/set-optional-worker-secrets.sh replies us            # or eu
#       REPLY_INGEST_SECRET on the app, the API Worker and the replies Worker (one value; Enter at its prompt makes a random one nobody sees),
#       then REPLIES_DOMAIN on the app and the API Worker. The domain goes last: it is what makes the app write reply addresses.
#   bash scripts/set-optional-worker-secrets.sh replies us --off      # deletes REPLIES_DOMAIN and REPLY_INGEST_SECRET again (wrangler asks to confirm)
#   bash scripts/set-optional-worker-secrets.sh collaboration us      # COLLABORATION_ENABLED=true on the API Worker, then the app (the app's is what shows
#                                                                     # the button), after you type the region
#   bash scripts/set-optional-worker-secrets.sh collaboration us --off   # the app first, then the API Worker
#   bash scripts/set-optional-worker-secrets.sh briefings us          # a new random CREDENTIALS_ENCRYPTION_KEY (32 bytes, never shown), the same value on the
#       briefings Worker, the API Worker and the app. Refuses when any of them has one already: that key also encrypts PostShiba's SMTP passwords and
#       the Postmaster Tools connection, so it is never replaced by accident.
#   bash scripts/set-optional-worker-secrets.sh briefings us --existing   # the app has the key already: type that value (hidden, twice) and it is put on
#       the API Worker and the briefings Worker only
#   bash scripts/set-optional-worker-secrets.sh briefings us --rotate     # replaces it everywhere with a new value, after a warning and the region typed:
#       everything encrypted with the old value (stored AI keys, PostShiba SMTP passwords, the Postmaster Tools connection) can no longer be read
#   --dry-run     says what it would do, asks for nothing and changes nothing
# The collaboration Worker's own flag is a variable of its wrangler.jsonc, not a secret: scripts/deploy-all.mjs sets it with `wrangler deploy --var` while the region is "enabled" in the optional Workers setting (docs/OPTIONAL-WORKERS-RUNBOOK.md).
# bash 3.2 (macOS) is enough.
set -u
cd "$(dirname "$0")/.."
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-fe96ffccbfec88e9c8516169adb1fee2}"

usage() { echo "usage: bash scripts/set-optional-worker-secrets.sh replies|collaboration|briefings us|eu [--off] [--rotate|--existing] [--dry-run]" >&2; exit 1; }
service=""; region=""; off=0; dry=0; rotate=0; existing=0
for arg in "$@"; do
  case "$arg" in
    replies|collaboration|briefings) service="$arg" ;;
    us|eu) region="$arg" ;;
    --off) off=1 ;;
    --rotate) rotate=1 ;;
    --existing) existing=1 ;;
    --dry-run) dry=1 ;;
    *) usage ;;
  esac
done
[ -z "$service" ] || [ -z "$region" ] && usage
# --rotate and --existing are the briefings key's only; the key has no --off (switching briefings off is the deploy setting).
if [ "$service" = briefings ]; then { [ "$off" = 1 ] || { [ "$rotate" = 1 ] && [ "$existing" = 1 ]; }; } && usage
else [ "$rotate" = 1 ] || [ "$existing" = 1 ] && usage
fi

suffix=""; [ "$region" = eu ] && suffix="-eu"
worker_name() { case "$1" in app) echo "flockstack$suffix" ;; api) echo "flockstack-api$suffix" ;; replies) echo "flockstack-replies$suffix" ;; briefings) echo "flockstack-briefings$suffix" ;; esac; }
config_args() { # the app is the root config; the lean Workers have a config of their own. EU is env.eu in each.
  local args=""
  case "$1" in api) args="--config workers/api/wrangler.jsonc" ;; replies) args="--config workers/replies/wrangler.jsonc" ;; briefings) args="--config workers/briefings/wrangler.jsonc" ;; esac
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

echo "=== $region: $service$([ "$off" = 1 ] && echo " (switching off)")$([ "$rotate" = 1 ] && echo " (rotating)") ==="
[ "$dry" = 1 ] && echo "(dry run: nothing is asked and nothing changes)"

if [ "$service" = collaboration ]; then
  if [ "$off" = 1 ]; then
    delete_secret COLLABORATION_ENABLED app; delete_secret COLLABORATION_ENABLED api
    echo "Off on the app and the API Worker. The collaboration Worker keeps answering 503 once its own COLLABORATION_ENABLED is false: set the region back to \"provisioned\" in the optional Workers setting and redeploy it without --var."
    exit 0
  fi
  if [ "$dry" = 0 ]; then
    echo "This turns realtime editing on for every account of $region as soon as the app and the API Worker both have it, and the router and the app"
    echo "have their COLLABORATION_SOCKET binding. Do it only after the checks of docs/OPTIONAL-WORKERS-RUNBOOK.md before this step."
    read -r -p "Type the region ($region) to go on: " confirm
    [ "$confirm" = "$region" ] || { echo "Nothing is changed."; exit 1; }
  fi
  VALUE=true
  # The API Worker answers for every editing session, so it is ready first; the app's flag is what shows the button.
  put_secret COLLABORATION_ENABLED api || { echo "The API Worker does not have it, so the app was not changed: nothing is on. Run this again." >&2; exit 1; }
  put_secret COLLABORATION_ENABLED app || { echo "The app does not have it: nobody sees the button. Run this again, or: bash scripts/set-optional-worker-secrets.sh collaboration $region --off" >&2; exit 1; }
  echo; echo "Done. Switch it off again with: bash scripts/set-optional-worker-secrets.sh collaboration $region --off"
  exit 0
fi

if [ "$service" = briefings ]; then
  NAME=CREDENTIALS_ENCRYPTION_KEY
  # has_secret KIND: whether that Worker lists the name (names only; wrangler never shows a value). 2 when it cannot tell.
  has_secret() {
    local out
    out=$(npx wrangler secret list $(config_args "$1") --format json </dev/null 2>/dev/null) || return 2
    printf %s "$out" | grep -Eq "\"name\"[[:space:]]*:[[:space:]]*\"$NAME\"" && return 0
    return 1
  }
  if [ "$dry" = 1 ]; then
    echo "  would check whether $(worker_name app), $(worker_name api) and $(worker_name briefings) have $NAME"
    if [ "$existing" = 1 ]; then echo "  would ask for the app's value and set it on $(worker_name api) and $(worker_name briefings)"
    else echo "  would make a random 32-byte value and set it on $(worker_name briefings), $(worker_name api) and $(worker_name app)"; fi
    exit 0
  fi
  found=""
  for kind in app api briefings; do
    has_secret "$kind"; status=$?
    if [ "$status" = 2 ]; then echo "Could not list the secrets of $(worker_name "$kind") (does it exist? are you logged in?). Nothing is changed." >&2; exit 1; fi
    [ "$status" = 0 ] && found="$found $kind"
  done
  if [ "$existing" = 1 ]; then
    case " $found " in *" app "*) ;; *) echo "$(worker_name app) has no $NAME: run this without --existing to make one. Nothing is changed." >&2; exit 1 ;; esac
    read -r -s -p "$NAME of $(worker_name app) (hidden): " VALUE; echo
    read -r -s -p "  again, to be sure it is the same: " AGAIN; echo
    if [ "$VALUE" != "$AGAIN" ]; then unset VALUE AGAIN; echo "  the two did not match. Nothing is changed." >&2; exit 1; fi
    unset AGAIN
    if ! printf %s "$VALUE" | grep -Eq '^([0-9a-fA-F]{64}|[A-Za-z0-9+/_-]{43}=?)$'; then unset VALUE; echo "That is not 32 bytes in base64 or hex. Nothing is changed." >&2; exit 1; fi
    for kind in api briefings; do
      put_secret "$NAME" "$kind" || { unset VALUE; echo "Stopped: $(worker_name "$kind") does not have it. Run this again with --existing." >&2; exit 1; }
    done
    unset VALUE
    echo; echo "Done: $(worker_name api) and $(worker_name briefings) have the app's value."
    exit 0
  fi
  if [ -n "$found" ] && [ "$rotate" = 0 ]; then
    echo "$NAME is already set on:$(for kind in $found; do printf ' %s' "$(worker_name "$kind")"; done). Nothing is changed." >&2
    echo "It also encrypts PostShiba's SMTP passwords and the Postmaster Tools connection, so it is never replaced without --rotate." >&2
    echo "If the app has it and the others do not: bash scripts/set-optional-worker-secrets.sh briefings $region --existing" >&2
    echo "If a run of this script stopped part way, nothing was encrypted with that value yet: run it again with --rotate." >&2
    exit 1
  fi
  if [ "$rotate" = 1 ]; then
    echo "WARNING: a new $NAME makes everything encrypted with the old one unreadable on $region: every stored AI provider key (their"
    echo "briefings stop until the keys are added again), PostShiba's SMTP passwords and the Postmaster Tools connection. There is no undo."
    read -r -p "Type the region ($region) to replace it: " confirm
    [ "$confirm" = "$region" ] || { echo "Nothing is changed."; exit 1; }
  fi
  VALUE=$(openssl rand -base64 32 | tr -d '\n')
  [ -z "$VALUE" ] && { echo "openssl gave no random value" >&2; exit 1; }
  echo "  made a random one"
  # The briefings Worker first and the app last: until the app has it, nothing in the dashboard encrypts with it.
  for kind in briefings api app; do
    put_secret "$NAME" "$kind" || { unset VALUE; echo "Stopped: $(worker_name "$kind") does not have it. Run this again with --rotate: it sets one new value everywhere." >&2; exit 1; }
  done
  unset VALUE
  echo; echo "Done: one value on $(worker_name briefings), $(worker_name api) and $(worker_name app). It was never shown and is not kept anywhere else."
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
