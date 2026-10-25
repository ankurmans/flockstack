#!/usr/bin/env bash
# Rotates BETTER_AUTH_SECRET (and with --suppression, SUPPRESSION_HASH_KEY) for one region, on every Worker that holds it: the app, the lean
# API Worker and the lean readers Worker. Nothing it handles is ever printed, put in a command line or written to a file: values go
# to `wrangler secret put` on its standard input.
#   bash scripts/rotate-auth-secret.sh us            # or eu; add --suppression to rotate SUPPRESSION_HASH_KEY too
#   bash scripts/rotate-auth-secret.sh us --finish   # later: takes the _PREVIOUS values off (docs/AUTH-ROTATION.md says when)
#   --dry-run     says what it would do, asks for nothing and changes nothing
#   --no-probe    does not ask the live app whether the old value you typed is the one it runs with
#   --no-previous rotates without carrying the old value forward: every session, every link in an email already sent and the
#                 never-email list's entries are lost. For a secret that leaked, or one nobody has.
#
# Cloudflare never gives a secret's value back, so the old value cannot be read from the Workers: you type it once, hidden and twice, and the
# script puts it on each Worker as BETTER_AUTH_SECRET_PREVIOUS. When it is the app's current value (it asks the live app, which answers
# without learning the value), the order is: PREVIOUS on every Worker, then the new value on the app, the API Worker and the readers Worker.
# A new value that cannot be set on every Worker is rolled back to the old one. If you no longer have the old value, rotate only when losing
# the sessions and the links is acceptable (--no-previous).
#
# bash 3.2 (macOS) is enough.
set -u
cd "$(dirname "$0")/.."
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-fe96ffccbfec88e9c8516169adb1fee2}"

region=""; finish=0; dry=0; probe=1; carry=1; suppression=0
for arg in "$@"; do
  case "$arg" in
    us|eu) region="$arg" ;;
    --finish) finish=1 ;;
    --dry-run) dry=1 ;;
    --no-probe) probe=0 ;;
    --no-previous) carry=0 ;;
    --suppression) suppression=1 ;;
    *) echo "usage: bash scripts/rotate-auth-secret.sh us|eu [--suppression] [--finish] [--dry-run] [--no-probe] [--no-previous]" >&2; exit 1 ;;
  esac
done
[ -z "$region" ] && { echo "region must be us or eu" >&2; exit 1; }

suffix=""; [ "$region" = eu ] && suffix="-eu"
KINDS="app api readers"
worker_name() { case "$1" in app) echo "flockstack$suffix" ;; api) echo "flockstack-api$suffix" ;; readers) echo "flockstack-readers$suffix" ;; esac; }
config_args() { # the app is the root config; the lean Workers have a config of their own. EU is env.eu in each.
  local args=""
  case "$1" in api) args="--config workers/api/wrangler.jsonc" ;; readers) args="--config workers/readers/wrangler.jsonc" ;; esac
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
    sleep "${FLOCKSTACK_ROTATE_RETRY_SLEEP:-2}"
  done
  return 1
}

delete_secret() { # NAME KIND: wrangler asks you to confirm
  local name="$1" kind="$2"
  if [ "$dry" = 1 ]; then echo "  would delete $name from $(worker_name "$kind")"; return 0; fi
  npx wrangler secret delete "$name" $(config_args "$kind") 2>&1 | grep -E "Success|ERROR|not found" | sed "s/^/  $(worker_name "$kind"): /"
}

# ask_hidden PROMPT [twice]: the answer in $ANSWER, never echoed.
ask_hidden() {
  local again
  read -r -s -p "$1: " ANSWER; echo
  if [ "${2:-}" = twice ] && [ -n "$ANSWER" ]; then
    read -r -s -p "  again, to be sure it is the same: " again; echo
    if [ "$ANSWER" != "$again" ]; then echo "  the two did not match" >&2; ANSWER=""; return 1; fi
  fi
  return 0
}

names="BETTER_AUTH_SECRET"; [ "$suppression" = 1 ] && names="BETTER_AUTH_SECRET SUPPRESSION_HASH_KEY"

if [ "$finish" = 1 ]; then
  echo "=== $region: taking the previous values off the app, the API Worker and the readers Worker ==="
  echo "Do this once no session, OAuth connection or email you want to keep working was made with them (docs/AUTH-ROTATION.md):"
  echo "unsubscribe links never expire, so a rotation that kept them keeps its previous value for as long as old emails may be opened."
  for name in $names; do for kind in $KINDS; do delete_secret "${name}_PREVIOUS" "$kind"; done; done
  exit 0
fi

echo "=== $region: rotating $names on $(worker_name app), $(worker_name api) and $(worker_name readers) ==="
[ "$dry" = 1 ] && echo "(dry run: nothing is asked and nothing changes)"

OLD_BETTER_AUTH_SECRET=""; OLD_SUPPRESSION_HASH_KEY=""
if [ "$carry" = 1 ] && [ "$dry" = 0 ]; then
  for name in $names; do
    ask_hidden "The current $name of $region, to carry forward as ${name}_PREVIOUS (hidden)" twice || exit 1
    if [ -z "$ANSWER" ]; then echo "No value: nothing is changed. Type it, or use --no-previous to rotate without carrying it (sessions and links break)." >&2; exit 1; fi
    current="$ANSWER"
    if [ "$name" = BETTER_AUTH_SECRET ] && [ "$probe" = 1 ]; then
      printf %s "$current" | node scripts/probe-auth-secret.mjs "$region" >/dev/null; status=$?
      case "$status" in
        0) echo "  the app of $region accepted it: it is the value it runs with." ;;
        1) echo "  the app of $region REFUSED it: it is not the value the app runs with. Nothing is changed." >&2; exit 1 ;;
        *) echo "  could not ask the app of $region; go on only if you are sure of the value (Ctrl-C to stop)." ;;
      esac
    fi
    ask_hidden "Values from earlier rotations still set as ${name}_PREVIOUS (comma-separated, Enter for none)" || exit 1
    earlier="$ANSWER"
    value="$current"; [ -n "$earlier" ] && value="$current,$earlier"
    printf -v "OLD_$name" %s "$value"
    printf -v "CURRENT_$name" %s "$current"
    unset current earlier value ANSWER
  done
elif [ "$carry" = 0 ] && [ "$dry" = 0 ]; then
  echo "Without the previous value: every session ends, links in emails already sent stop working (unsubscribe, confirmation, tracking)," >&2
  echo "OAuth connections are made again, and the never-email list's earlier entries are not found." >&2
  read -r -p "Type the region ($region) to go on: " confirm
  [ "$confirm" = "$region" ] || { echo "Nothing is changed."; exit 1; }
fi

# 1. The old values, on every Worker that checks them, before anything signs with a new one.
if [ "$carry" = 1 ]; then
  echo; echo "1. Previous values:"
  for name in $names; do
    for kind in $KINDS; do
      VALUE=$(eval "printf %s \"\$OLD_$name\""); put_secret "${name}_PREVIOUS" "$kind" || { echo "Stopped before any new value was set: nothing signs differently yet." >&2; exit 1; }
    done
  done
fi

# 2. The new values: the app first (it checks what the API Worker sends it with both), then the API Worker, then the readers.
echo; echo "2. New values:"
rolled=""
for name in $names; do
  VALUE=$(openssl rand -base64 48 | tr -d '\n')
  [ -z "$VALUE" ] && { echo "openssl gave no random value" >&2; exit 1; }
  for kind in $KINDS; do
    if put_secret "$name" "$kind"; then rolled="$rolled $name:$kind"; continue; fi
    echo "Could not set $name on $(worker_name "$kind"): putting the old value back where the new one went." >&2
    if [ "$carry" = 1 ]; then
      for done_item in $rolled; do
        rname="${done_item%%:*}"; rkind="${done_item##*:}"
        VALUE=$(eval "printf %s \"\$CURRENT_$rname\""); put_secret "$rname" "$rkind" || echo "  ALSO FAILED: set $rname on $(worker_name "$rkind") by hand to the old value." >&2
      done
    else
      echo "  There was no old value to put back: set $name on every Worker by hand, to one value." >&2
    fi
    exit 1
  done
done
unset VALUE
OLD_BETTER_AUTH_SECRET=""; OLD_SUPPRESSION_HASH_KEY=""; CURRENT_BETTER_AUTH_SECRET=""; CURRENT_SUPPRESSION_HASH_KEY=""

echo
if [ "$dry" = 1 ]; then echo "Dry run done."; exit 0; fi
echo "Done. Check sign-in and MCP now:  node scripts/check-mcp-auth.mjs $(node -e 'import("./lib/region.js").then(({ getRegionUrls }) => console.log(getRegionUrls()[process.argv[1]]))' "$region")"
echo "Later, once nothing needs the old value:  bash scripts/rotate-auth-secret.sh $region --finish$([ "$suppression" = 1 ] && echo " --suppression")"
