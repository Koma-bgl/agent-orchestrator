#!/bin/sh
# Caching shim in front of the real gh (/usr/bin/gh). Installed at
# /usr/local/bin/gh, which precedes /usr/bin in PATH, so every gh subprocess
# spawn resolves here — no process restarts needed to take effect.
#
# Why: ao runs TWO 30s lifecycle pollers (the `ao lifecycle-worker` process AND
# ao-web's in-server lifecycle-manager, whose 30s is hard-coded in the minified
# build), each firing ~5 GitHub reads per open-PR session per tick (pr checks /
# state / reviewDecision / reviewThreads / merge status). With a handful of PRs
# awaiting review that is ~80 GraphQL calls/min — the ENTIRE 5000/hr quota — so
# the dashboard rate-limit banner is permanent. Neither cadence is configurable,
# but both shell out to `gh`, making the binary the one clean choke point:
# memoize identical READ calls for TTL seconds and both pollers (plus ao-web's
# PR enrichment and the queue-poller) share one fetch per window.
#
# Safety: only whitelisted read subcommands are cached, and `gh api graphql` is
# never cached when the args mention a mutation. Writes (pr create/edit/merge,
# push, auth, run rerun, api POST…) always pass straight through. Only exit-0
# responses are cached, so an auth/rate-limit failure is never replayed. Worst
# case a poller acts on data TTL seconds stale — auto-merge and CI relay already
# tolerate ao's own 2-minute review cadence.
REAL=/usr/bin/gh
CACHE_DIR="${GH_SHIM_CACHE_DIR:-/tmp/gh-shim-cache}"
TTL="${GH_SHIM_TTL:-120}"

cacheable() {
  case "$1" in
    pr)
      case "$2" in view|checks|status|list|diff) return 0 ;; esac
      return 1 ;;
    api)
      case "$*" in *mutation*) return 1 ;; esac
      case "$2" in graphql) return 0 ;; esac
      return 1 ;;
  esac
  return 1
}

cacheable "$@" || exec "$REAL" "$@"

mkdir -p "$CACHE_DIR" 2>/dev/null || exec "$REAL" "$@"
# \036 (record separator) between args so "pr view 1" != "pr vie w1".
KEY=$(printf '%s\036' "$@" | md5sum | cut -d' ' -f1)
F="$CACHE_DIR/$KEY"

if [ -f "$F" ]; then
  AGE=$(( $(date +%s) - $(stat -c %Y "$F" 2>/dev/null || echo 0) ))
  if [ "$AGE" -ge 0 ] && [ "$AGE" -lt "$TTL" ]; then
    cat "$F"
    exit 0
  fi
fi

TMP="$F.$$"
if "$REAL" "$@" >"$TMP"; then
  mv "$TMP" "$F"
  cat "$F"
  exit 0
else
  EC=$?
  cat "$TMP"
  rm -f "$TMP"
  exit $EC
fi
