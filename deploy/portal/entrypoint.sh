#!/bin/sh
# Portal entrypoint. POSIX sh — the caddy base image is Alpine (no bash).
# Cloud Run injects the raw pipe-joined google-oauth-client secret as
# GOOGLE_OAUTH_CLIENT ("CLIENT_ID|CLIENT_SECRET"); Cloud Run's native secret-env
# integration cannot split it, so we derive the two vars the Caddyfile reads.
set -eu

: "${GOOGLE_OAUTH_CLIENT:?GOOGLE_OAUTH_CLIENT is required (ID|SECRET)}"
: "${JWT_SHARED_KEY:?JWT_SHARED_KEY is required}"

# Trim CR/LF from injected secrets. Cloud Run's --set-secrets injects raw bytes
# (a secret created via `openssl … | gcloud secrets create` carries a trailing
# newline), whereas the bots read the same secrets through shell command-
# substitution, which strips it. Untrimmed, the portal would sign JWTs with a
# key the bots can't verify → cross-service login loop. Trim so both sides agree.
GOOGLE_OAUTH_CLIENT="$(printf '%s' "$GOOGLE_OAUTH_CLIENT" | tr -d '\r\n')"
JWT_SHARED_KEY="$(printf '%s' "$JWT_SHARED_KEY" | tr -d '\r\n')"
export JWT_SHARED_KEY

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
