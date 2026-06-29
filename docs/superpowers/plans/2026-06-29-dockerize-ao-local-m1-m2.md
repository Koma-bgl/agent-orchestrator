# Dockerize AO — Local Run + Secret Loading (M1–M2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package Agent Orchestrator as a Docker image that boots `ao start` and serves the dashboard, with credentials loaded at startup from a `.env` file or Google Secret Manager (via local Application Default Credentials) — all runnable and verifiable on a laptop with `docker compose up`.

**Architecture:** A `deploy/` kit holds a Dockerfile (Debian-based; bundles Node 20, pnpm, tmux, git, gh, the Claude Code CLI, and the built monorepo), an `entrypoint.sh` that resolves secrets via a small unit-tested Node resolver and execs the AO CLI, and a `docker-compose.yml` with a single `ao` service plus a persistent volume for `~/.agent-orchestrator`. Caddy, Google sign-in, the `/admin` UI, and Watchtower are deliberately out of scope (later plans).

**Tech Stack:** Docker + docker compose, Debian `node:20-bookworm`, pnpm 9.15.4, Node's built-in `node:test` runner (no new deps), Google Secret Manager REST API (accessed via ADC token), GitHub Actions + `ghcr.io`.

**Scope boundary (from the design spec, `docs/superpowers/specs/2026-06-29-dockerized-self-host-deploy-design.md`):** This plan covers **M1 (containerize + CI publish)** and **M2 (secret-fetch entrypoint via ADC + `.env`)** only. No reverse proxy, no auth, no admin UI, no Watchtower, no GCP VM.

---

## Grounding facts (verified in the codebase)

- Monorepo: pnpm `9.15.4`, Node `>=20.18.3`, ESM (`"type": "module"`). Build: `pnpm build` (= `pnpm -r build`).
- CLI bin `ao` → `packages/cli/dist/index.js`. The CLI depends on `@aoagents/ao-web` (`workspace:*`).
- In a monorepo checkout, `ao start` runs the web via `packages/web/dist-server/start-all.js` (see `packages/cli/src/commands/start.ts:822-838`). Default port `3000` (`packages/cli/src/lib/constants.ts:2`).
- `node-pty@1.1.0` is a native dep rebuilt from source by `scripts/rebuild-node-pty.js` (postinstall) → the build image **must** have `python3`, `make`, `g++`/`build-essential`, and `node-gyp` toolchain.
- `GET /api/version` already returns `{ current, latest, channel, isOutdated, checkedAt }` (`packages/web/src/app/api/version/route.ts`) — used here only as a cheap liveness probe.
- Agents are spawned as `claude` via the tmux runtime → the image needs the `claude` binary on PATH and `tmux`, `git`, `gh`.

## File structure

| File | Responsibility |
|---|---|
| `deploy/Dockerfile` | Build the monorepo, provision a sample git project, produce a runnable AO image |
| `deploy/.dockerignore` | Keep build context small + deterministic |
| `deploy/entrypoint.sh` | Resolve secrets → export env → `cd` into the project dir → `exec` the AO CLI `start --no-restore` |
| `deploy/default-config/agent-orchestrator.yaml` | Baked minimal config so the container boots with no user config |
| `deploy/scripts/resolve-secrets.mjs` | Pure secret-source resolution + env mapping (unit-tested) |
| `deploy/scripts/resolve-secrets.test.mjs` | `node:test` unit tests for the resolver |
| `deploy/docker-compose.yml` | Single `ao` service, volume, env wiring for local run |
| `deploy/.env.example` | Documented template of the secrets/env the container reads |
| `deploy/README.md` | How to build, configure, and run locally |
| `.github/workflows/image.yml` | Build + push image to `ghcr.io` on release |

> **Why a baked config + sample git repo?** `ao start` calls `autoCreateConfig`
> when no `agent-orchestrator.yaml` is found, which **throws if the working dir
> is not a git repo** (`packages/cli/src/commands/start.ts:507`). The image has
> no `.git` (excluded by `.dockerignore`), so the container must ship its own
> minimal config pointing at a git-initialized directory, and start with
> `--no-restore` (no `last-stop.json` to restore in a fresh container). For
> M1 this just needs the dashboard to boot; wiring the user's *real* project(s)
> comes in the Phase 2 skill.

> **No secrets in the image.** `deploy/.env` (real values) is gitignored; only `.env.example` is committed.

---

### Task 1: Build context hygiene — `.dockerignore`

**Files:**
- Create: `deploy/.dockerignore`

- [ ] **Step 1: Write `deploy/.dockerignore`**

```
# Build context is the repo root (see compose `context: ..`).
**/node_modules
**/.next
**/dist
**/dist-server
**/.turbo
.git
**/*.log
deploy/.env
**/coverage
**/.vitest
```

- [ ] **Step 2: Commit**

```bash
git add deploy/.dockerignore
git commit -m "chore(deploy): add docker build context ignore"
```

---

### Task 2: Secret resolver — pure function with unit tests (M2 core)

The entrypoint must decide where secrets come from and map them to the env names AO/agents expect. Keep that decision logic pure and tested; keep I/O (actual Secret Manager calls) in the shell entrypoint.

**Env mapping (the only secrets this plan handles):**

| Secret Manager name | Env var | Consumer |
|---|---|---|
| `claude-oauth-token` | `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code agent |
| `github-pat` | `GH_TOKEN` | `gh`/`git` in agents |
| `linear-api-key` | `LINEAR_API_KEY` | Linear tracker (optional) |

**Source selection precedence:** `AO_SECRET_SOURCE` env wins if set (`env` | `gcp`); otherwise `gcp` when `AO_GCP_PROJECT` is set, else `env`.

**Files:**
- Create: `deploy/scripts/resolve-secrets.mjs`
- Test: `deploy/scripts/resolve-secrets.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// deploy/scripts/resolve-secrets.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseSource, SECRET_ENV_MAP, secretNames } from "./resolve-secrets.mjs";

test("chooseSource honors explicit AO_SECRET_SOURCE", () => {
  assert.equal(chooseSource({ AO_SECRET_SOURCE: "gcp" }), "gcp");
  assert.equal(chooseSource({ AO_SECRET_SOURCE: "env" }), "env");
});

test("chooseSource defaults to gcp when project is set", () => {
  assert.equal(chooseSource({ AO_GCP_PROJECT: "my-proj" }), "gcp");
});

test("chooseSource defaults to env when nothing is set", () => {
  assert.equal(chooseSource({}), "env");
});

test("explicit env source overrides project presence", () => {
  assert.equal(chooseSource({ AO_SECRET_SOURCE: "env", AO_GCP_PROJECT: "p" }), "env");
});

test("secret env map covers the three M2 secrets", () => {
  assert.deepEqual(secretNames(), ["claude-oauth-token", "github-pat", "linear-api-key"]);
  assert.equal(SECRET_ENV_MAP["claude-oauth-token"], "CLAUDE_CODE_OAUTH_TOKEN");
  assert.equal(SECRET_ENV_MAP["github-pat"], "GH_TOKEN");
  assert.equal(SECRET_ENV_MAP["linear-api-key"], "LINEAR_API_KEY");
});

test("chooseSource throws on an unknown explicit source", () => {
  assert.throws(() => chooseSource({ AO_SECRET_SOURCE: "vault" }), /AO_SECRET_SOURCE/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test deploy/scripts/resolve-secrets.test.mjs`
Expected: FAIL — `Cannot find module './resolve-secrets.mjs'` (file not created yet).

- [ ] **Step 3: Write minimal implementation**

```js
// deploy/scripts/resolve-secrets.mjs
// Pure secret-source resolution + env mapping for the AO container entrypoint.
// I/O (the actual Secret Manager fetch) lives in entrypoint.sh, not here.

export const SECRET_ENV_MAP = {
  "claude-oauth-token": "CLAUDE_CODE_OAUTH_TOKEN",
  "github-pat": "GH_TOKEN",
  "linear-api-key": "LINEAR_API_KEY",
};

export function secretNames() {
  return Object.keys(SECRET_ENV_MAP);
}

/**
 * Decide the secret source. Explicit AO_SECRET_SOURCE wins; otherwise infer.
 * @param {Record<string,string|undefined>} env
 * @returns {"env"|"gcp"}
 */
export function chooseSource(env) {
  const explicit = env.AO_SECRET_SOURCE;
  if (explicit) {
    if (explicit !== "env" && explicit !== "gcp") {
      throw new Error(`AO_SECRET_SOURCE must be 'env' or 'gcp', got '${explicit}'`);
    }
    return explicit;
  }
  return env.AO_GCP_PROJECT ? "gcp" : "env";
}

// When invoked directly, print the resolved plan as shell-evalable lines so
// entrypoint.sh can consume it: `SOURCE=gcp` then one `MAP <secret> <ENV>` per line.
if (import.meta.url === `file://${process.argv[1]}`) {
  const source = chooseSource(process.env);
  process.stdout.write(`SOURCE=${source}\n`);
  for (const name of secretNames()) {
    process.stdout.write(`MAP ${name} ${SECRET_ENV_MAP[name]}\n`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test deploy/scripts/resolve-secrets.test.mjs`
Expected: PASS — 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add deploy/scripts/resolve-secrets.mjs deploy/scripts/resolve-secrets.test.mjs
git commit -m "feat(deploy): add unit-tested secret-source resolver"
```

---

### Task 3: Entrypoint — load secrets and start AO

`entrypoint.sh` runs the resolver, then fetches each secret either from env (already present — no-op) or from Secret Manager using an access token (ADC locally via `gcloud auth print-access-token`, or the VM metadata server later — both produce a bearer token, so the same `curl` path works). It exports the mapped env vars and execs the AO CLI.

**Files:**
- Create: `deploy/entrypoint.sh`

- [ ] **Step 1: Write `deploy/entrypoint.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

# Resolve the secret-loading plan (source + name→env mapping) from the pure resolver.
PLAN="$(node /app/deploy/scripts/resolve-secrets.mjs)"
SOURCE="$(printf '%s\n' "$PLAN" | sed -n 's/^SOURCE=//p')"
echo "[entrypoint] secret source: ${SOURCE}"

# Obtain a Secret Manager bearer token only when using gcp.
get_token() {
  if command -v gcloud >/dev/null 2>&1 && gcloud auth print-access-token >/dev/null 2>&1; then
    gcloud auth print-access-token
  else
    # VM/metadata fallback (Phase 2): the metadata server issues a token.
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

# Start AO from a git-initialized project dir so autoCreateConfig never trips
# the "not a git repository" guard. The baked config lives in this dir.
# --no-restore: a fresh container has no last-stop.json to restore.
cd "${AO_PROJECT_DIR:-/workspace/sample}"
exec node /app/packages/cli/dist/index.js start --no-restore "$@"
```

> **bash, not sh.** This script uses `set -euo pipefail` and `< <(...)`
> process substitution — bash features. The shebang is `#!/usr/bin/env bash`
> and the `ENTRYPOINT ["/app/deploy/entrypoint.sh"]` exec form runs it directly,
> so this is fine. Do **not** invoke it via `sh entrypoint.sh`.

- [ ] **Step 2: Make it executable + commit**

```bash
chmod +x deploy/entrypoint.sh
git update-index --chmod=+x deploy/entrypoint.sh 2>/dev/null || true
git add deploy/entrypoint.sh
git commit -m "feat(deploy): add container entrypoint with secret loading"
```

> Note: the resolver's pure logic is unit-tested in Task 2; the shell I/O here is verified end-to-end by the container smoke test in Task 6 (env source) — GCP-source fetch is exercised manually with ADC per `deploy/README.md`.

---

### Task 3.5: Baked default config (so the container boots with no user config)

**Files:**
- Create: `deploy/default-config/agent-orchestrator.yaml`

- [ ] **Step 1: Write `deploy/default-config/agent-orchestrator.yaml`**

```yaml
# Minimal config baked into the AO image so `ao start` boots the dashboard
# without any user config. The Dockerfile copies this into the sample project
# dir (a git-initialized directory). Real projects are configured later (the
# Phase 2 skill); a mounted config/volume can override this.
port: 3000

defaults:
  runtime: tmux
  agent: claude-code      # pinned — do not rely on non-interactive auto-detect
  workspace: worktree
  notifiers: []           # headless container: no desktop notifier

projects:
  sample:
    name: Sample (container smoke test)
    path: /workspace/sample
    defaultBranch: main
    sessionPrefix: sample
    scm:
      plugin: github
```

- [ ] **Step 2: Commit**

```bash
git add deploy/default-config/agent-orchestrator.yaml
git commit -m "feat(deploy): add baked default config for container boot"
```

---

### Task 4: Dockerfile — build the monorepo into a runnable image

A single Debian build stage keeps `node-pty`'s native rebuild reliable (slimming to multi-stage is a deliberate later optimization, not M1 scope — YAGNI).

**Files:**
- Create: `deploy/Dockerfile`

- [ ] **Step 1: Write `deploy/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1
FROM node:20-bookworm

# OS deps: agent runtime (tmux/git/gh), node-pty build toolchain, curl for Secret Manager.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tmux git curl ca-certificates python3 make g++ \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# Claude Code CLI on PATH (agents spawn `claude`).
RUN npm install -g @anthropic-ai/claude-code

ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app
COPY . /app

# Install (runs node-pty postinstall rebuild) and build all packages.
# NOTE: scripts/rebuild-node-pty.js catches its own failure and exits 0, so the
# build will NOT fail if the native rebuild fails — the in-container terminal
# would just be broken. Verify the build log shows "node-pty rebuilt
# successfully"; if node-pty drifts from 1.1.0 the hardcoded path in that script
# must be updated.
RUN pnpm install --frozen-lockfile && pnpm build

# Provision a git-initialized sample project + baked config so `ao start` boots
# without user config (autoCreateConfig throws on a non-git workdir).
RUN git config --global user.email "ao@example.com" \
 && git config --global user.name "Agent Orchestrator" \
 && git config --global init.defaultBranch main \
 && mkdir -p /workspace/sample \
 && cd /workspace/sample \
 && git init -q \
 && cp /app/deploy/default-config/agent-orchestrator.yaml /workspace/sample/agent-orchestrator.yaml \
 && git add -A && git commit -q -m "chore: bootstrap sample project"

ENV PORT=3000
ENV AO_PROJECT_DIR=/workspace/sample
EXPOSE 3000

# Make crash-loops observable rather than silent under restart policies.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS "http://localhost:${PORT}/api/version" || exit 1

ENTRYPOINT ["/app/deploy/entrypoint.sh"]
```

- [ ] **Step 2: Build the image**

Run: `docker build -f deploy/Dockerfile -t ao-local:dev .`
Expected: build completes; final line shows the image tagged `ao-local:dev`. (First build is slow — installs + builds the whole monorepo.)

- [ ] **Step 3: Verify the CLI is runnable inside the image**

Run: `docker run --rm --entrypoint node ao-local:dev /app/packages/cli/dist/index.js --version`
Expected: prints the AO version (e.g. `0.x.y`) with exit code 0.

- [ ] **Step 4: Commit**

```bash
git add deploy/Dockerfile
git commit -m "feat(deploy): add AO container image"
```

---

### Task 5: docker-compose — local run with persistent state

**Files:**
- Create: `deploy/docker-compose.yml`
- Create: `deploy/.env.example`

- [ ] **Step 1: Write `deploy/.env.example`**

```bash
# Copy to deploy/.env and fill in. deploy/.env is gitignored.
#
# Secret source: "env" (use the values below) or "gcp" (fetch from Secret Manager).
AO_SECRET_SOURCE=env

# --- env source: paste secrets directly (local testing only) ---
CLAUDE_CODE_OAUTH_TOKEN=
GH_TOKEN=
LINEAR_API_KEY=

# --- gcp source: set the project; secrets are read from Secret Manager ---
# AO_SECRET_SOURCE=gcp
# AO_GCP_PROJECT=your-gcp-project
# (mount ADC: see deploy/README.md)
```

- [ ] **Step 2: Write `deploy/docker-compose.yml`**

```yaml
services:
  ao:
    build:
      context: ..
      dockerfile: deploy/Dockerfile
    image: ao-local:dev
    env_file:
      - .env
    ports:
      - "3000:3000"
    volumes:
      # Persistent AO state (sessions, worktrees, config) survives restarts/rebuilds.
      - ao-state:/root/.agent-orchestrator
      # For gcp source locally: mount your ADC (read-only). Harmless if unused.
      - ${HOME}/.config/gcloud:/root/.config/gcloud:ro
    restart: unless-stopped

volumes:
  ao-state:
```

- [ ] **Step 3: Boot it (env source) and verify the dashboard responds**

```bash
cp deploy/.env.example deploy/.env   # AO_SECRET_SOURCE=env is the default
docker compose -f deploy/docker-compose.yml up -d --build
# Poll until the web server is up (cold start can take 20-40s). Fails after ~60s.
for i in $(seq 1 30); do
  if curl -fsS http://localhost:3000/api/version; then echo " <- OK"; break; fi
  sleep 2
done
```
Expected: JSON like `{"current":"0.x.y","latest":...,"channel":...,"isOutdated":...}` and HTTP 200. The container boots from the baked sample project (`AO_PROJECT_DIR=/workspace/sample`), so `ao start` does not crash on a missing config/git repo.

- [ ] **Step 4: Confirm secret loading ran (env source)**

Run: `docker compose -f deploy/docker-compose.yml logs ao | grep entrypoint`
Expected: a line `[entrypoint] secret source: env` and `[entrypoint] using env/.env secrets as-is`.

- [ ] **Step 5: Tear down**

Run: `docker compose -f deploy/docker-compose.yml down`
Expected: container stops; `ao-state` volume persists.

- [ ] **Step 6: Commit**

```bash
git add deploy/docker-compose.yml deploy/.env.example
git commit -m "feat(deploy): add local docker-compose run with persistent state"
```

---

### Task 6: gitignore the real `.env`

**Files:**
- Modify: `.gitignore` (append)

> The repo is mid-merge with conflicts in `.gitignore`. Only append the single line below; do not touch conflict markers — if the file still has unresolved `<<<<<<<` markers, stop and surface to the human first.

- [ ] **Step 1: Append the ignore rule**

Add to `.gitignore`:
```
deploy/.env
```

- [ ] **Step 2: Verify it's ignored**

Run: `git check-ignore deploy/.env`
Expected: prints `deploy/.env`.

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore(deploy): gitignore deploy/.env"
```

---

### Task 7: README — how to build and run locally

**Files:**
- Create: `deploy/README.md`

- [ ] **Step 1: Write `deploy/README.md`** covering:
  - Prereqs: Docker + docker compose; (optional) `gcloud` for the gcp source.
  - **env source (default):** `cp deploy/.env.example deploy/.env`, paste tokens, `docker compose -f deploy/docker-compose.yml up --build`, open `http://localhost:3000`.
  - **gcp source (validate the Secret Manager path without a VM):**
    1. `gcloud auth application-default login`
    2. Create secrets: `printf %s "$TOKEN" | gcloud secrets create claude-oauth-token --data-file=- --project PROJECT` (repeat for `github-pat`, `linear-api-key`).
    3. In `deploy/.env`: set `AO_SECRET_SOURCE=gcp` and `AO_GCP_PROJECT=PROJECT`.
    4. `docker compose -f deploy/docker-compose.yml up --build` — logs should show `[entrypoint] loaded claude-oauth-token -> CLAUDE_CODE_OAUTH_TOKEN`.
  - How to get each token: `claude setup-token`; GitHub PAT (`repo`+`workflow`); Linear Settings → API.
  - State lives in the `ao-state` volume; how to reset (`docker compose ... down -v`).
  - Note: a missing/empty/invalid `CLAUDE_CODE_OAUTH_TOKEN` does **not** crash the
    container — the dashboard still serves; only the agent can't do work until a
    valid token is provided. So `/api/version` liveness is independent of token validity.
  - Explicit note: TLS, Google sign-in, the `/admin` UI, Watchtower, and GCP VM provisioning are **not** in this image yet — later milestones.

- [ ] **Step 2: Commit**

```bash
git add deploy/README.md
git commit -m "docs(deploy): document local build and secret sources"
```

---

### Task 8: CI — build and publish the image to ghcr on release (M1)

Mirrors the existing release model: the public repo builds + pushes the image to GitHub Container Registry, tagged `:stable` (Watchtower's channel, used by a later plan) and the release version. Triggered on published release; also `workflow_dispatch` for manual builds.

**Files:**
- Create: `.github/workflows/image.yml`

- [ ] **Step 1: Write `.github/workflows/image.yml`**

```yaml
name: Build Image

on:
  release:
    types: [published]
  workflow_dispatch:
    inputs:
      tag:
        description: Extra tag to push (e.g. a version). Defaults to 'manual'.
        required: false
        type: string

permissions:
  contents: read
  packages: write

concurrency:
  group: build-image
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Compute tags
        id: tags
        run: |
          IMG="ghcr.io/${{ github.repository }}"
          IMG="$(printf '%s' "$IMG" | tr '[:upper:]' '[:lower:]')"
          if [ "${{ github.event_name }}" = "release" ]; then
            VER="${{ github.event.release.tag_name }}"
            echo "tags=${IMG}:stable,${IMG}:${VER}" >> "$GITHUB_OUTPUT"
          else
            EXTRA="${{ inputs.tag }}"; EXTRA="${EXTRA:-manual}"
            echo "tags=${IMG}:${EXTRA}" >> "$GITHUB_OUTPUT"
          fi

      - uses: docker/setup-buildx-action@v3

      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          context: .
          file: deploy/Dockerfile
          push: true
          tags: ${{ steps.tags.outputs.tags }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

- [ ] **Step 2: Lint the workflow locally (if `actionlint` available) and sanity-check YAML**

Run: `node -e "require('fs').readFileSync('.github/workflows/image.yml','utf8')" && echo OK`
Expected: `OK` (file readable). If `actionlint` is installed: `actionlint .github/workflows/image.yml` → no errors.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/image.yml
git commit -m "ci: build and push AO image to ghcr on release"
```

> The `workflow_dispatch` path lets you push a one-off tag and confirm a real image lands in GHCR before a release ever runs. Pinning third-party actions to commit SHAs (as the rest of this repo does) is a recommended hardening follow-up.

---

## Done criteria for M1–M2

- [ ] `node --test deploy/scripts/resolve-secrets.test.mjs` passes.
- [ ] `docker build -f deploy/Dockerfile -t ao-local:dev .` succeeds.
- [ ] `docker compose -f deploy/docker-compose.yml up --build` serves `http://localhost:3000/api/version` (HTTP 200).
- [ ] Logs show the entrypoint resolved the secret source and loaded mapped env vars.
- [ ] gcp source validated once via ADC per `deploy/README.md` (manual).
- [ ] `image.yml` produces an image in GHCR via `workflow_dispatch`.

## Explicitly deferred (later plans)

- **M3:** Caddy reverse proxy + Google sign-in + email allowlist (local mode: plain `http://localhost`).
- **M4:** `/admin` UI — status / version / token rotation / allowlist.
- **M5:** Watchtower midnight self-update on `:stable`.
- **M6–M7 (Phase 2):** `deploy-gcp.sh`, GCE VM + startup script + metadata service account, real domain TLS, and the guided setup skill.
