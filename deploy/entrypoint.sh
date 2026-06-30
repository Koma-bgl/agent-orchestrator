#!/usr/bin/env bash
set -euo pipefail

# Resolve the secret-loading plan (source + name->env mapping) from the pure resolver.
PLAN="$(node /app/scripts/resolve-secrets.mjs)"
SOURCE="$(printf '%s\n' "$PLAN" | sed -n 's/^SOURCE=//p')"
echo "[entrypoint] secret source: ${SOURCE}"

# Obtain a Secret Manager bearer token. Precedence:
#   1. AO_GCP_ACCESS_TOKEN  -> local testing without gcloud-in-container
#      (host runs: export AO_GCP_ACCESS_TOKEN="$(gcloud auth print-access-token)")
#   2. gcloud               -> if the SDK happens to be present
#   3. metadata server      -> on the GCE VM (Phase 2), the attached SA
get_token() {
  if [ -n "${AO_GCP_ACCESS_TOKEN:-}" ]; then
    printf '%s' "${AO_GCP_ACCESS_TOKEN}"
  elif command -v gcloud >/dev/null 2>&1 && gcloud auth print-access-token >/dev/null 2>&1; then
    gcloud auth print-access-token
  else
    curl -s -H "Metadata-Flavor: Google" \
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).access_token))'
  fi
}

fetch_gcp_secret() {
  local name="$1" token="$2"
  curl -s -H "Authorization: Bearer ${token}" \
    "https://secretmanager.googleapis.com/v1/projects/${AO_GCP_PROJECT}/secrets/${name}/versions/latest:access" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!j.payload){process.exit(3)}process.stdout.write(Buffer.from(j.payload.data,"base64").toString("utf8"))})'
}

if [ "${SOURCE}" = "gcp" ]; then
  : "${AO_GCP_PROJECT:?AO_GCP_PROJECT must be set when secret source is gcp}"
  TOKEN="$(get_token)"
  while read -r kind name envvar; do
    [ "${kind}" = "MAP" ] || continue
    if value="$(fetch_gcp_secret "${name}" "${TOKEN}")"; then
      export "${envvar}=${value}"
      echo "[entrypoint] loaded ${name} -> ${envvar}"
    else
      echo "[entrypoint] skip ${name} (no version / not found)"
    fi
  done < <(printf '%s\n' "$PLAN")
else
  echo "[entrypoint] using env/.env secrets as-is"
fi

# Loopback bridge: the daemon binds 127.0.0.1:${AO_PORT} only, so a sibling
# container (Caddy) cannot reach it. socat relays 0.0.0.0:8080 -> the loopback
# daemon (compose-network only; never published to the host). Backgrounded; tini
# (init: true) reaps it. It is a dumb TCP relay, so SSE passes through untouched.
AO_BRIDGE_PORT="${AO_BRIDGE_PORT:-8080}"
echo "[entrypoint] starting loopback bridge :${AO_BRIDGE_PORT} -> 127.0.0.1:${AO_PORT:-3001}"
socat "TCP-LISTEN:${AO_BRIDGE_PORT},fork,reuseaddr" "TCP:127.0.0.1:${AO_PORT:-3001}" &

# Launch the headless Go daemon. It binds 127.0.0.1:${AO_PORT}, reads state from
# $HOME/.ao, and blocks until SIGTERM/SIGINT.
#
# IMPORTANT: do NOT `exec ao daemon`. The npm `ao` is a Node shim that runs the
# Go binary via spawnSync (a *child*, not execve). Under `exec ao daemon`, node
# would be PID 1 and would not forward SIGTERM to the Go child, so `docker stop`
# would SIGKILL after the timeout instead of shutting down gracefully.
# Resolve the real platform binary and exec IT directly, so the Go daemon is PID
# 1 and its own signal.NotifyContext(SIGINT,SIGTERM) handles graceful shutdown.
#
# The platform binary (@aoagents/ao-<platform>-<arch>) is a NESTED optional dep of
# the globally-installed `ao` shim package, so it is NOT resolvable from /app.
# Resolve it relative to the shim's own directory (follow the PATH symlink to the
# shim, then require.resolve the platform package with that dir as the search base).
AO_SHIM_DIR="$(dirname "$(readlink -f "$(command -v ao)")")"
AO_BIN="$(node -e 'const path=require("path");const pkg=`@aoagents/ao-${process.platform}-${process.arch}`;const pj=require.resolve(pkg+"/package.json",{paths:[process.argv[1]]});process.stdout.write(path.join(path.dirname(pj),"bin","ao"))' "$AO_SHIM_DIR")"
echo "[entrypoint] starting ao daemon (${AO_BIN}) on 127.0.0.1:${AO_PORT:-3001}"
exec "${AO_BIN}" daemon "$@"
