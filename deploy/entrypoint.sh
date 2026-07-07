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

# Install gh as git's credential helper on EVERY boot. It writes to the ephemeral
# /root/.gitconfig (not the volume), so a restart drops it — re-apply so spawned
# sessions' `git fetch`/`worktree add`/`push` against origin authenticate. Harmless
# before GitHub login (the helper just returns nothing until gh is authed).
command -v gh >/dev/null 2>&1 && gh auth setup-git 2>/dev/null || true

# On-box agent secrets (LINEAR_API_KEY / ANTHROPIC_API_KEY), written by the setup
# wizard onto the volume. Read KEY=VALUE lines WITHOUT executing the file (no
# sourcing — a token must never be interpreted as shell), and export so BOTH the
# dashboard (it reads LINEAR_API_KEY at request time) and the lifecycle-worker see
# them. The wizard writes raw values (no quoting); split on the FIRST '=' only.
AO_SECRETS_FILE="$(dirname "${AO_CONFIG_PATH}")/agent-secrets.env"
if [ -f "${AO_SECRETS_FILE}" ]; then
  echo "[entrypoint] loading on-box agent secrets"
  while IFS='=' read -r k v; do
    case "$k" in ''|\#*) continue ;; esac
    export "${k}=${v}"
  done < "${AO_SECRETS_FILE}"
fi

# Claude writes its per-session JSONL transcripts under
# ${CLAUDE_CONFIG_DIR}/projects (on the volume), but the agent-claude-code plugin
# reads activity from a HARDCODED ~/.claude/projects (homedir(), ignoring
# CLAUDE_CONFIG_DIR). Bridge them with a symlink so the dashboard can classify
# session activity (active/idle/ready) instead of seeing no transcript. Keeps the
# real files on the volume; only the lookup path is redirected.
if [ -n "${CLAUDE_CONFIG_DIR:-}" ] && [ "${CLAUDE_CONFIG_DIR}" != "/root/.claude" ]; then
  mkdir -p "${CLAUDE_CONFIG_DIR}/projects" /root/.claude
  rm -rf /root/.claude/projects 2>/dev/null || true
  ln -sfn "${CLAUDE_CONFIG_DIR}/projects" /root/.claude/projects
fi

# Standing local-verification policy for every agent session. claude-code reads user
# memory from ~/.claude/CLAUDE.md (HOME-based; verified against the binary — NOT
# CLAUDE_CONFIG_DIR). ao@0.2.2 exposes no per-session systemPrompt for normal spawns, so
# this file is how we steer the fleet agent: keep local verification to the FAST checks
# and let the PR's CI run the heavy build + test suite (it does anyway), instead of the
# agent re-running them locally and blocking the session. Rewritten every boot (this dir
# is ephemeral), so it stays in sync with the image.
mkdir -p /root/.claude
cat > /root/.claude/CLAUDE.md <<'AOCLAUDE'
# Fleet agent — local verification policy

You run as an automated fleet agent. Every PR you open is validated by the repository's
CI (GitHub Actions, e.g. `pr-checks.yml`) plus a preview deploy. **CI is the authoritative
gate** — it runs the full type-check, lint, build, and test suite on your PR.

Keep LOCAL verification to the fast checks only:
- Run type-check and lint (e.g. `npm run check-types`, `npm run lint`) to catch obvious
  breakage before pushing.
- Do NOT run the full production build (`npm run build` / `build:local`) or the full test
  suite (`turbo test-ci` / `vitest run`) locally. They take many minutes and CI runs them
  on your PR regardless — running them locally only slows your session, it does not add a
  gate.
- Git hooks are intentionally disabled for this bot (`HUSKY=0`). Do not re-enable or work
  around them.

When your change is ready: commit, push, and open the PR — then STOP. Do not sit waiting
for CI to finish. The orchestrator monitors CI and will send you any failures to fix.
AOCLAUDE

# Worktrees: @composio/ao-cli@0.2.2 creates them at $HOME/.worktrees — OUTSIDE the
# data dir — which compose backs with its own persistent ao-worktrees volume (a REAL
# mount, so claude's realpath cwd == the recorded workspacePath and transcript-path
# encoding stays consistent; a symlink here misreads activity as needs_input). A
# container recreate still kills live tmux sessions and can leave a worktree record
# pointing at a now-missing dir, so self-heal on boot: prune stale records per repo so
# an orphaned checkout never wedges `ao spawn` with "already checked out". Idempotent —
# prune only drops records whose working dir is gone; it never touches a live worktree
# or a branch.
# Hard-disable git hooks for the bot. HUSKY=0 (Dockerfile env) skips husky at run +
# install time, but an EXISTING clone still carries core.hooksPath=.husky in its
# .git/config from a pre-HUSKY=0 `npm ci`, and a committed hook that doesn't honor
# HUSKY=0 would silently re-run the 7-15 min pre-push build+test. Point core.hooksPath
# (global + per existing repo, which overrides the local .husky) at an empty dir so git
# finds NO hooks regardless of husky version/state. CI (pr-checks.yml) is the gate.
mkdir -p /root/.no-git-hooks
git config --global core.hooksPath /root/.no-git-hooks
for gitdir in "$(dirname "${AO_CONFIG_PATH}")"/projects/*/.git; do
  [ -e "${gitdir}" ] || continue
  repo="$(dirname "${gitdir}")"
  git -C "${repo}" config --local core.hooksPath /root/.no-git-hooks 2>/dev/null || true
  git -C "${repo}" worktree prune 2>/dev/null || true
done

# Resolve the `ao` bin + ao-web (a NESTED dep of the global ao-cli, so not
# resolvable from /app or the global root) relative to the bin's own dir.
AO_SHIM="$(readlink -f "$(command -v ao)")"
WEBDIR="$(node -e 'const path=require("path");const pj=require.resolve("@composio/ao-web/package.json",{paths:[path.dirname(process.argv[1])]});process.stdout.write(path.dirname(pj))' "$AO_SHIM")"

# Lifecycle worker (Linear poll -> spawn -> reactions) runs as a SEPARATE process,
# NOT part of the dashboard. Its PID is container-ephemeral, so the ENTRYPOINT owns
# starting it on every boot: if the config already has a project, (re)start it here
# (it is PID-guarded, so a stale run is a silent no-op). A fresh idle bot has an
# empty `projects: {}` -> no worker until the wizard configures + restarts. Resolve
# the first project id via the `yaml` lib (also a nested dep of ao-cli).
FIRST_PROJECT="$(node -e 'const path=require("path");const fs=require("fs");try{const yaml=require(require.resolve("yaml",{paths:[path.dirname(process.argv[2])]}));const doc=yaml.parse(fs.readFileSync(process.argv[1],"utf8"))||{};process.stdout.write(Object.keys(doc.projects||{})[0]||"")}catch(e){process.stdout.write("")}' "$AO_CONFIG_PATH" "$AO_SHIM")"
if [ -n "${FIRST_PROJECT}" ]; then
  # Clear any stale worker PID from a prior boot. The PID file lives on the volume,
  # so after a restart a REUSED pid (e.g. the dashboard's) makes the worker's
  # kill(pid,0) dup-guard think it's "already running" → it silently refuses to
  # start. On a fresh boot nothing is running yet, so removing it is safe.
  rm -f "$(dirname "${AO_CONFIG_PATH}")"/*/lifecycle-worker.pid 2>/dev/null || true
  echo "[entrypoint] starting lifecycle-worker for project '${FIRST_PROJECT}'"
  ao lifecycle-worker "${FIRST_PROJECT}" &
  # Queue poller: the published ao-cli has no issue→spawn poller, so we run our own
  # (label/status filter → ao spawn). lifecycle-worker above handles reactions.
  echo "[entrypoint] starting queue-poller"
  node /app/admin/queue-poller.mjs &
fi

# Admin backend (version / update-now / setup wizard). Bound to the compose
# network only; Caddy gates /admin/api/* with Google auth before reaching it.
AO_ADMIN_PORT="${AO_ADMIN_PORT:-8090}"
echo "[entrypoint] starting admin backend on :${AO_ADMIN_PORT}"
node /app/admin/server.mjs &

# Launch the TS agent-orchestrator dashboard (Next.js + terminal servers) via
# ao-web's production entry `dist-server/start-all.js` — NOT `ao dashboard` (dev-only:
# `next dev` needs app source ao-web does not ship). start-all runs `next start` off
# the prebuilt .next + the terminal WS servers, binds 0.0.0.0:${PORT}, boots on the
# empty `projects: {}` skeleton, installs its own SIGINT/SIGTERM cleanup. It is PID 1;
# compose `init: true` reaps ttyd grandchildren (and the backgrounded worker/admin).
echo "[entrypoint] starting dashboard (start-all) on 0.0.0.0:${PORT} (webdir ${WEBDIR})"
exec node "${WEBDIR}/dist-server/start-all.js"
