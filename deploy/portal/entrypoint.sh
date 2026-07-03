#!/bin/sh
# Portal entrypoint. POSIX sh — the caddy base image is Alpine (no bash).
# Cloud Run injects the raw pipe-joined google-oauth-client secret as
# GOOGLE_OAUTH_CLIENT ("CLIENT_ID|CLIENT_SECRET"); Cloud Run's native secret-env
# integration cannot split it, so we derive the two vars the Caddyfile reads.
set -eu

: "${GOOGLE_OAUTH_CLIENT:?GOOGLE_OAUTH_CLIENT is required (ID|SECRET)}"
: "${JWT_SHARED_KEY:?JWT_SHARED_KEY is required}"

GOOGLE_CLIENT_ID="${GOOGLE_OAUTH_CLIENT%%|*}"
GOOGLE_CLIENT_SECRET="${GOOGLE_OAUTH_CLIENT#*|}"
export GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET

if [ -z "$GOOGLE_CLIENT_ID" ] || [ -z "$GOOGLE_CLIENT_SECRET" ]; then
  echo "[portal] google-oauth-client is not 'ID|SECRET'" >&2
  exit 1
fi

# AO_PORTAL_VALIDATE=1 -> validate the config and exit (used by local CI checks).
if [ "${AO_PORTAL_VALIDATE:-}" = "1" ]; then
  exec caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
fi

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
