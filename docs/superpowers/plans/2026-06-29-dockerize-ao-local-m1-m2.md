# Dockerize AO (Go daemon) — Local M1+M2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the AO **Go daemon** as a Docker image that boots `ao daemon` headless and serves `/healthz`, plus a secret-loading entrypoint that feeds credentials from a local `.env` or Google Secret Manager — all verifiable on a laptop with no VM.

**Architecture:** A single slim container installs the prebuilt `ao` binary via `npm i -g @aoagents/ao` (no monorepo build) alongside `tmux`/`git`/`gh`/`claude`. The entrypoint resolves secrets (pure JS resolver decides source + name→env mapping; shell does the I/O) into the daemon's environment, then `exec`s `ao daemon`. The daemon binds `127.0.0.1:3001` with zero auth, so all local verification runs **inside** the container via `docker compose exec` (a published host port cannot reach a loopback-bound listener).

**Tech Stack:** Docker + docker compose, `node:20-bookworm-slim` base, `@aoagents/ao@0.10.0` (linux-x64 binary), `@anthropic-ai/claude-code`, Node's built-in `node:test` for the resolver, GitHub Actions for image publish.

> **Live-verification amendments (applied & committed during M1/M2 execution).**
> Two real defects surfaced only when the image was actually built/run; both
> would also break on the x86 VM, so they are folded into the deploy kit:
>
> 1. **Pin `linux/amd64`.** `@aoagents/ao` ships a `linux-x64` binary only (no
>    `linux-arm64`), so the build fails on arm64 dev machines. The Dockerfile uses
>    `FROM --platform=linux/amd64` and compose sets `platform: linux/amd64` —
>    native on the GCE VM + CI ubuntu runner, emulated on Apple Silicon.
> 2. **Resolve the binary from the shim dir.** The platform binary is a _nested_
>    optional dep of the global `ao` shim package (`.../@aoagents/ao/node_modules/
@aoagents/ao-linux-x64/bin/ao`), not resolvable from `/app`. The entrypoint
>    follows the PATH symlink to the shim and `require.resolve`s with that dir as
>    the base, then `exec`s the real binary (PID 1, graceful SIGTERM).
>
> Verified end-to-end: healthy container; `/healthz` 200 with `executablePath`
> = the real Go binary; `/api/v1/sessions` 200; SQLite state on the volume;
> `docker compose stop` drains in ~0.2s logging `daemon stopped cleanly`;
> env-source `GITHUB_TOKEN` passthrough + correct resolver plan.

### Grounding facts (verified against the branch)

- `@aoagents/ao@0.10.0` is published on npm with `bin.ao = bin/ao.js` and a `@aoagents/ao-linux-x64@0.10.0` optional dep → `npm i -g @aoagents/ao@0.10.0` puts `ao` on PATH in a linux-x64 container.
- `ao daemon` is the headless entry point (`backend/internal/cli/root.go` — hidden `daemon` subcommand → `daemon.Run()`). `ao start` launches Electron — **do not use it.**
- Daemon binds `127.0.0.1` only (`backend/internal/config/config.go:23` `LoopbackHost`), `DefaultPort = 3001` (`:25`), `AO_PORT` overrides (`:139-148`). No `AO_HOST`.
- State dir defaults to `$HOME/.ao` (`config.go:296-302` `defaultStateDir`); `data/` (SQLite) and `running.json` live under it; `AO_DATA_DIR`/`AO_RUN_FILE` override (`:271-294`).
- `GET /healthz` + `/readyz` mounted at root (`backend/internal/httpd/router.go:73-74`); `GET /api/v1/sessions` under `/api/v1`.
- Daemon boots clean with zero projects — no config file, no git-repo guard.
- Existing reusable assets on the branch: `deploy/scripts/resolve-secrets.mjs` + `.test.mjs` (pure resolver, keep & tweak). The rest of `deploy/` was written for the old TS architecture and gets rewritten/removed here.

### Build context decision

The compose `build.context` is set to **`deploy/`** (the directory holding the Dockerfile), not the repo root. The image needs only `entrypoint.sh` + `scripts/`, so a tiny context avoids copying the repo and sidesteps `.git`/`.dockerignore` gymnastics entirely.

---

## Task 1: Update the secret resolver env mapping (TDD)

The Go daemon's SCM/tracker reads `AO_GITHUB_TOKEN`/`GITHUB_TOKEN`; `gh` reads `GITHUB_TOKEN`. Setting `GITHUB_TOKEN` covers both, so the old `GH_TOKEN` mapping must change. Linear is **not wired** in this Go build yet — keep the mapping (harmless, forward-compatible) but annotate it.

**Files:**

- Modify: `deploy/scripts/resolve-secrets.mjs`
- Modify (test): `deploy/scripts/resolve-secrets.test.mjs`

- [ ] **Step 1: Update the failing test first**

In `deploy/scripts/resolve-secrets.test.mjs`, change the `"secret env map covers the three M2 secrets"` assertion to expect `GITHUB_TOKEN` and document Linear's status:

```javascript
test("secret env map covers the three M2 secrets", () => {
	assert.deepEqual(secretNames(), ["claude-oauth-token", "github-pat", "linear-api-key"]);
	assert.equal(SECRET_ENV_MAP["claude-oauth-token"], "CLAUDE_CODE_OAUTH_TOKEN");
	// GITHUB_TOKEN (not GH_TOKEN): the Go daemon reads AO_GITHUB_TOKEN/GITHUB_TOKEN
	// and gh reads GITHUB_TOKEN — one var covers both.
	assert.equal(SECRET_ENV_MAP["github-pat"], "GITHUB_TOKEN");
	// linear-api-key is mapped but NOT yet consumed by the Go build (no Linear
	// adapter). Kept forward-compatible; safe to export, simply unused for now.
	assert.equal(SECRET_ENV_MAP["linear-api-key"], "LINEAR_API_KEY");
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd deploy/scripts && node --test resolve-secrets.test.mjs`
Expected: FAIL — `GH_TOKEN` !== `GITHUB_TOKEN`.

- [ ] **Step 3: Update the resolver map**

In `deploy/scripts/resolve-secrets.mjs`, change the GitHub mapping and add the Linear note:

```javascript
export const SECRET_ENV_MAP = {
	"claude-oauth-token": "CLAUDE_CODE_OAUTH_TOKEN",
	// GITHUB_TOKEN covers both the Go daemon (AO_GITHUB_TOKEN/GITHUB_TOKEN) and gh.
	"github-pat": "GITHUB_TOKEN",
	// Not consumed by the Go build yet (no Linear adapter); mapped for forward-compat.
	"linear-api-key": "LINEAR_API_KEY",
};
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd deploy/scripts && node --test resolve-secrets.test.mjs`
Expected: PASS (all tests green).

- [ ] **Step 5: Commit**

```bash
git add deploy/scripts/resolve-secrets.mjs deploy/scripts/resolve-secrets.test.mjs
git commit -m "fix(deploy): map github-pat to GITHUB_TOKEN for the Go daemon"
```

---

## Task 2: Rewrite the Dockerfile (binary install, no build)

**Files:**

- Replace: `deploy/Dockerfile`
- Delete: `deploy/Dockerfile.dockerignore` (no longer needed — see Step 2)
- Create: `deploy/.dockerignore`

- [ ] **Step 1: Replace `deploy/Dockerfile` with the binary-install image**

```dockerfile
# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim

# OS deps: agent runtime (tmux/git), curl+ca-certificates (Secret Manager fetch
# + gh apt repo), then the GitHub CLI. No build toolchain — we install a prebuilt
# Go binary, not source.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tmux git curl ca-certificates gnupg \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# The AO daemon binary (prebuilt Go, via npm platform package) and the Claude
# Code CLI agents spawn. Pin ao to match the :stable image tag so they never drift.
RUN npm install -g @aoagents/ao@0.10.0 @anthropic-ai/claude-code \
 && ao --version

# Secret-loading entrypoint + the pure resolver it shells out to.
WORKDIR /app
COPY entrypoint.sh /app/entrypoint.sh
COPY scripts /app/scripts
RUN chmod +x /app/entrypoint.sh

# Daemon binds 127.0.0.1:AO_PORT; state lives under $HOME/.ao (mounted volume).
ENV AO_PORT=3001
EXPOSE 3001

# Liveness against the daemon's own /healthz. Runs INSIDE the container, so the
# 127.0.0.1 bind is reachable (a host port-map would not be).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${AO_PORT}/healthz" || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
```

- [ ] **Step 2: Delete the old context-ignore, add a build-context `.dockerignore`**

```bash
git rm deploy/Dockerfile.dockerignore
```

Create `deploy/.dockerignore` (context is `deploy/`, so this keeps the context to just what the image needs):

```
README.md
.env
.env.*
!.env.example
default-config
docs
```

- [ ] **Step 3: Build the image, verify it builds and the binary runs**

Run:

```bash
cd deploy && docker build -t ao-local:dev .
docker run --rm ao-local:dev /bin/sh -c "ao --version && which tmux git gh claude"
```

Expected: image builds; `ao --version` prints a version; all four binaries resolve on PATH.

- [ ] **Step 4: Commit**

```bash
git add deploy/Dockerfile deploy/.dockerignore
git commit -m "feat(deploy): Go-daemon Dockerfile via prebuilt ao binary"
```

---

## Task 3: Rewrite the entrypoint to launch `ao daemon`

Drops all sample-project / baked-config / `--no-restore` logic (Go daemon needs none). Keeps the secret-resolution flow and adds an `AO_GCP_ACCESS_TOKEN` shortcut so the gcp source is testable locally **without** installing gcloud in the image.

**Files:**

- Replace: `deploy/entrypoint.sh`

- [ ] **Step 1: Replace `deploy/entrypoint.sh`**

```bash
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

# Launch the headless Go daemon. It binds 127.0.0.1:${AO_PORT}, reads state from
# $HOME/.ao, and blocks until SIGTERM/SIGINT.
#
# IMPORTANT: do NOT `exec ao daemon`. The npm `ao` is a Node shim that runs the
# Go binary via spawnSync (a *child*, not execve). Under `exec ao daemon`, node
# would be PID 1 and would not forward SIGTERM to the Go child, so `docker stop`
# would SIGKILL after the timeout instead of shutting down gracefully.
# Resolve the real platform binary and exec IT directly, so the Go daemon is PID
# 1 and its own signal.NotifyContext(SIGINT,SIGTERM) handles graceful shutdown.
AO_BIN="$(node -e 'const path=require("path");const pkg=`@aoagents/ao-${process.platform}-${process.arch}`;const dir=path.dirname(require.resolve(pkg+"/package.json"));process.stdout.write(path.join(dir,"bin","ao"))')"
echo "[entrypoint] starting ao daemon (${AO_BIN}) on 127.0.0.1:${AO_PORT:-3001}"
exec "${AO_BIN}" daemon "$@"
```

- [ ] **Step 2: Syntax-check the script**

Run: `bash -n deploy/entrypoint.sh`
Expected: no output (valid bash).

- [ ] **Step 3: Commit**

```bash
git add deploy/entrypoint.sh
git commit -m "feat(deploy): entrypoint launches ao daemon, adds local gcp token path"
```

---

## Task 4: Rewrite docker-compose.yml + .env.example

**Files:**

- Replace: `deploy/docker-compose.yml`
- Replace: `deploy/.env.example`

- [ ] **Step 1: Replace `deploy/docker-compose.yml`**

```yaml
services:
  ao:
    build:
      context: .
      dockerfile: Dockerfile
    image: ao-local:dev
    env_file:
      - .env
    # Defense-in-depth: a tini-equivalent init reaps zombies (agents spawn tmux
    # children later) and forwards signals. The entrypoint already exec's the
    # real Go binary as PID 1, so this is belt-and-suspenders, not load-bearing.
    init: true
    # NOTE: the daemon binds 127.0.0.1 only, so publishing 3001 to the host would
    # NOT reach it (and the deployed stack must never expose 3001 anyway — Caddy,
    # added in M3, is the only public surface). Verify via `docker compose exec`.
    volumes:
      # Durable daemon state (SQLite + running.json) survives restarts/rebuilds.
      - ao-state:/root/.ao
      # For the gcp secret source locally: mount your ADC read-only. Harmless if unused.
      - ${HOME}/.config/gcloud:/root/.config/gcloud:ro
    restart: unless-stopped

volumes:
  ao-state:
```

- [ ] **Step 2: Replace `deploy/.env.example`**

```bash
# Secret source: "env" (use the vars below as-is) or "gcp" (fetch from Secret Manager).
# Defaults to "gcp" when AO_GCP_PROJECT is set, else "env".
AO_SECRET_SOURCE=env

# --- env source: paste credentials directly (local testing only) ---
# CLAUDE_CODE_OAUTH_TOKEN=...     # from `claude setup-token`
# GITHUB_TOKEN=...                # PAT with repo + workflow scopes
# LINEAR_API_KEY=...              # not yet consumed by the Go build

# --- gcp source: fetch from Secret Manager ---
# AO_SECRET_SOURCE=gcp
# AO_GCP_PROJECT=my-gcp-project
# Local testing without gcloud-in-container — mint a token on the host:
#   export AO_GCP_ACCESS_TOKEN="$(gcloud auth print-access-token)"
# AO_GCP_ACCESS_TOKEN=
```

- [ ] **Step 3: Commit**

```bash
git add deploy/docker-compose.yml deploy/.env.example
git commit -m "feat(deploy): compose for the daemon (no published port, .ao volume)"
```

---

## Task 5: Remove obsolete TS-architecture artifacts

**Files:**

- Delete: `deploy/default-config/` (baked `agent-orchestrator.yaml` — Go daemon needs none)

- [ ] **Step 1: Remove the baked-config dir**

```bash
git rm -r deploy/default-config
```

- [ ] **Step 2: Confirm nothing else references it**

Run: `grep -rn "default-config\|agent-orchestrator.default\|AO_PROJECT_DIR\|--no-restore\|pnpm\|node-pty\|packages/cli" deploy/`
Expected: no matches (all TS-era references are gone).

- [ ] **Step 3: Commit**

```bash
git add -A deploy/
git commit -m "chore(deploy): drop baked config + TS-era artifacts"
```

---

## Task 6: Local boot verification (M1)

This is the M1 acceptance gate: the image boots `ao daemon` headless and serves the API. No secrets required (default `env` source with nothing set just logs and starts).

**Files:** none (verification only).

- [ ] **Step 1: Build and start the stack**

```bash
cd deploy
cp .env.example .env   # default AO_SECRET_SOURCE=env, no creds — fine for a boot test
docker compose up -d --build
```

- [ ] **Step 2: Wait for health, confirm the daemon is live**

Run:

```bash
docker compose ps                      # STATUS should reach "healthy"
docker compose exec ao curl -fsS http://127.0.0.1:3001/healthz
```

Expected: a 200 / JSON health body. (Run from `exec`, not the host — the daemon is loopback-bound.)

- [ ] **Step 3: Confirm the REST API serves**

Run: `docker compose exec ao curl -fsS http://127.0.0.1:3001/api/v1/sessions`
Expected: a 200 with a JSON session-list envelope (empty list — no projects yet).

- [ ] **Step 4: Confirm state persists on the volume**

Run: `docker compose exec ao ls -la /root/.ao /root/.ao/data`
Expected: `running.json` present; `data/` exists (SQLite store).

- [ ] **Step 5: Verify graceful shutdown (the B1 fix)**

The Go daemon must be PID 1 and shut down cleanly on `SIGTERM` — not get SIGKILLed after Docker's stop-timeout. Confirm the real binary is PID 1, then stop and watch the logs:

```bash
docker compose exec ao ps -o pid,comm           # PID 1 should be `ao` (the Go binary), not `node`
time docker compose stop ao                      # should return in ~1-2s, well under the 10s SIGKILL timeout
docker compose logs ao | tail -20                # should show the daemon's graceful-shutdown log, no SIGKILL
```

Expected: PID 1 is `ao`; `docker compose stop` returns quickly; logs show graceful shutdown (and `running.json` is cleaned up). If stop takes ~10s and the process is killed, the exec-the-real-binary fix in Task 3 is not working — stop and debug before proceeding.

- [ ] **Step 6: Tear down**

Run: `docker compose down` (keep the volume) — or `docker compose down -v` to reset state.

---

## Task 7: Secret-loading verification (M2)

Proves both secret sources feed the daemon's environment.

**Files:** none (verification only).

- [ ] **Step 1: Verify the `env` source passes vars through**

Set a sentinel in `.env` (e.g. `GITHUB_TOKEN=test-sentinel-123`), then:

```bash
docker compose up -d --build
docker compose exec ao printenv GITHUB_TOKEN
```

Expected: `test-sentinel-123` (the env-source path exports it for the daemon + agents).

- [ ] **Step 2: Verify the resolver plan output**

Run: `docker compose exec ao node /app/scripts/resolve-secrets.mjs`
Expected:

```
SOURCE=env
MAP claude-oauth-token CLAUDE_CODE_OAUTH_TOKEN
MAP github-pat GITHUB_TOKEN
MAP linear-api-key LINEAR_API_KEY
```

- [ ] **Step 3 (optional, requires a real GCP project): verify the `gcp` source**

With a Secret Manager secret `github-pat` created in your project:

```bash
# in .env:  AO_SECRET_SOURCE=gcp  and  AO_GCP_PROJECT=<your-project>
export AO_GCP_ACCESS_TOKEN="$(gcloud auth print-access-token)"
docker compose run --rm -e AO_GCP_ACCESS_TOKEN ao printenv GITHUB_TOKEN
```

Expected: the secret value from Secret Manager, proving the fetch path without a VM. (Skip if no GCP project handy — the `.env` path is sufficient for M2 sign-off; the metadata path is exercised in Phase 2.)

- [ ] **Step 4: Reset `.env`** back to the committed example (don't commit real/sentinel creds).

---

## Task 8: CI image publish to ghcr (M1 deliverable)

Builds and pushes the image on release so Watchtower (M6) has a `:stable` to watch.

**Files:**

- Create: `.github/workflows/image.yml`

- [ ] **Step 1: Create `.github/workflows/image.yml`**

```yaml
name: Publish AO daemon image

on:
  release:
    types: [published]
  workflow_dispatch:
    inputs:
      tag:
        description: Image tag to publish (defaults to the release tag or "manual")
        required: false
        type: string

permissions:
  contents: read
  packages: write

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Log in to ghcr.io
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Set up Buildx
        uses: docker/setup-buildx-action@v3

      - name: Compute tags
        id: tags
        run: |
          REF="${{ inputs.tag || github.event.release.tag_name || 'manual' }}"
          REPO="ghcr.io/${{ github.repository }}"
          echo "tags=${REPO}:stable,${REPO}:${REF}" >> "$GITHUB_OUTPUT"

      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          context: deploy
          file: deploy/Dockerfile
          push: true
          tags: ${{ steps.tags.outputs.tags }}
```

> **Follow-up (advisory, not blocking M1/M2):** the rest of the repo pins
> third-party Actions by commit SHA. Before this lands on `main`, pin
> `docker/login-action`, `docker/setup-buildx-action`, `docker/build-push-action`,
> and `actions/checkout` to SHAs to match repo convention.

- [ ] **Step 2: Validate the workflow YAML**

Run: `docker run --rm -v "$PWD":/w -w /w rhysd/actionlint:latest .github/workflows/image.yml` (or any YAML linter)
Expected: no errors. (Actual push is validated when a release is published / via `workflow_dispatch`.)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/image.yml
git commit -m "ci: publish AO daemon image to ghcr on release"
```

---

## Done criteria (M1 + M2)

- `docker compose up -d --build` brings the `ao` container to **healthy**.
- `docker compose exec ao curl /healthz` → 200; `/api/v1/sessions` → 200 JSON.
- The Go binary is **PID 1** and `docker compose stop` shuts it down **gracefully**
  (fast, no SIGKILL-after-timeout) — the B1 signal-handling fix.
- State persists under the `ao-state` volume (`/root/.ao`).
- `env` secret source passes credentials to the daemon env; resolver maps
  `github-pat → GITHUB_TOKEN`; gcp source path is in place (locally testable via
  `AO_GCP_ACCESS_TOKEN`, fully exercised on the VM in Phase 2).
- `image.yml` publishes `:stable` + a version tag to ghcr on release.

**Out of scope (later milestones):** Caddy + TLS, Google sign-in + allowlist (M3);
the monitoring SPA + admin ops (M4–M5); Watchtower self-update (M6); the GCP VM +
setup skill (M7–M8). The web backend **co-location** (a second process under a
shared init) arrives with M3; M1/M2 run only the daemon (the `init: true` here is
just zombie-reaping/signal insurance, not multi-process supervision).
