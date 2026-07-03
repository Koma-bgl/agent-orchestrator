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

# Ensure a valid config exists so the dashboard boots on a fresh (idle) bot. The
# schema requires `projects` as a MAP (z.record) — an empty map is valid and
# `port` defaults to 3000. `projects: []` (array) or a missing key FAIL Zod, so
# the skeleton must be exactly `projects: {}`. Milestone B's wizard rewrites this
# with a real project (repo + tracker + queuePoller + reactions).
mkdir -p "$(dirname "${AO_CONFIG_PATH}")"
if [ ! -f "${AO_CONFIG_PATH}" ]; then
  echo "[entrypoint] writing skeleton config -> ${AO_CONFIG_PATH}"
  printf 'projects: {}\n' > "${AO_CONFIG_PATH}"
fi

# A git identity is needed once a project is cloned and worktrees are committed
# (Milestone B). Set a harmless default now if the operator hasn't configured one.
git config --global --get user.email >/dev/null 2>&1 || git config --global user.email "bot@binary-badger.xyz"
git config --global --get user.name  >/dev/null 2>&1 || git config --global user.name  "agent-orchestrator bot"

# Admin backend (version / update-now / setup wizard). Bound to the compose
# network only; Caddy gates /admin/api/* with Google auth before reaching it.
AO_ADMIN_PORT="${AO_ADMIN_PORT:-8090}"
echo "[entrypoint] starting admin backend on :${AO_ADMIN_PORT}"
node /app/admin/server.mjs &

# Launch the TS agent-orchestrator dashboard (Next.js + terminal servers) via
# ao-web's production entry `dist-server/start-all.js` — NOT `ao dashboard` (that
# is dev-only: `next dev` needs app source ao-web does not ship). start-all runs
# `next start` off the prebuilt .next (no build) + the terminal WS servers, binds
# 0.0.0.0:${PORT}, boots on the empty `projects: {}` skeleton, and installs its own
# SIGINT/SIGTERM cleanup. It is PID 1; compose `init: true` reaps ttyd grandchildren.
# The Linear poller/reactions run as a SEPARATE `ao lifecycle-worker <project>`
# process, started by Milestone B's wizard once a project is configured.
# ao-web is a NESTED dep of the globally-installed ao-cli
# (.../@composio/ao-cli/node_modules/@composio/ao-web), so it is NOT resolvable
# from /app or the global root. Resolve it relative to the `ao` bin's own dir
# (follow the PATH symlink, then require.resolve ao-web with that dir as the base).
AO_SHIM="$(readlink -f "$(command -v ao)")"
WEBDIR="$(node -e 'const path=require("path");const pj=require.resolve("@composio/ao-web/package.json",{paths:[path.dirname(process.argv[1])]});process.stdout.write(path.dirname(pj))' "$AO_SHIM")"
echo "[entrypoint] starting dashboard (start-all) on 0.0.0.0:${PORT} (webdir ${WEBDIR})"
exec node "${WEBDIR}/dist-server/start-all.js"
