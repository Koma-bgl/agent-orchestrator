# TS AO bot — Milestone B (setup wizard) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An on-box, SSO-gated **setup wizard** that takes a Milestone-A idle bot to a working one: connect GitHub (PAT), pick + clone a repo (30-min auto-pull), enter Linear + Claude tokens, then write a real `agent-orchestrator.yaml` project and run `ao lifecycle-worker` — so a matching Linear ticket auto-spawns an agent session that opens a PR. Creds stay **on-box**; the admin who runs `create` never handles them.

**Architecture:** Extend the co-located admin backend (`deploy/admin/server.mjs`, Node http, already gated by Caddy at `/admin/api/*`) with wizard endpoints, plus a **single HTML page served by that backend**. **The entrypoint owns all process lifecycle** (single source of truth): on every boot it sources the on-box secrets, and if a project exists it starts `ao lifecycle-worker <id>` before `exec`ing the dashboard (`start-all.js`, PID 1). The wizard's **`apply`** writes config + tokens + clones, then **triggers a container restart** (kill PID 1; `restart: unless-stopped` brings it back) so the dashboard picks up `LINEAR_API_KEY` (it reads it at request time) and the entrypoint starts the worker. All state consolidates on the **`/root/.agent-orchestrator`** volume (where ao-core actually writes).

**Tech Stack:** Node (`server.mjs`), the `yaml` lib (`parseDocument`), `gh` CLI, `git`, `ao lifecycle-worker`, Caddy + caddy-security v1.1.31, docker-compose.

**Spec:** `docs/superpowers/specs/2026-07-03-ts-ao-bot-setup-wizard-milestone-b-design.md` (spec-review-approved; state-dir blocker + corrections folded).

> **⚠️ This milestone REVISES the committed Milestone A** (state-dir consolidation + entrypoint worker-on-boot). Re-run the M-A boot verification after Task 0.

> **⚠️ DSL-drift guard (binding):** every Caddyfile change MUST pass `caddy validate` against the pinned v1.1.31 image before proceeding.

### Grounding facts (spec-review-verified)

- Minimal project entry: `{repo, path}` required; wizard MUST also write `tracker: {plugin: linear, teamId(string)}` (else defaults to github) and `queuePoller: {enabled: true, …}` (defaults false); `reactions` get rich load-time defaults — skip. `workspace` unset = worktree (needs an `origin` clone at `path`).
- ao-core state dir is hardcoded `~/.agent-orchestrator` (no `AO_DATA_DIR` override); worker PID lives at `<dataDir>/{hash}-{basename(path)}/lifecycle-worker.pid` (`lifecycle-service.js`), `lastPoll` is in-memory only.
- Dashboard reads `LINEAR_API_KEY` at request time (`/api/issues|backlog|setup-labels`, chunk 420) → token apply MUST bounce the dashboard.
- `ao lifecycle-worker <id> [--interval-ms]`: PID-guarded, detached, inherits `process.env`, independent of the dashboard.
- Terminal client supports same-origin `NEXT_PUBLIC_TERMINAL_WS_PATH` → `wss://<host><path>?session=<id>`; WS server on 14800 reads `?session=`. Gating = one gated `reverse_proxy ao:14800` block, no client patch.
- `gh auth login --with-token` reads the PAT from **stdin**; `--insecure-storage` + `GH_CONFIG_DIR` persist plaintext; `gh auth setup-git` installs the git credential helper (needed for agent `git push`).
- Current `server.mjs`: `createServer` + `send`/`readBody`/`gcpToken` helpers + routes `/admin/api/{version,update,secrets}`; extend the same way.

### File structure
- Modify `deploy/Dockerfile` — repoint `AO_CONFIG_PATH` + add `GH_CONFIG_DIR`/`NEXT_PUBLIC_TERMINAL_WS_PATH` under `/root/.agent-orchestrator`.
- Modify `deploy/docker-compose.yml` (+ `.vm.yml` if needed) — volume `ao-state:/root/.agent-orchestrator`.
- Modify `deploy/entrypoint.sh` — source `agent-secrets.env`; start `ao lifecycle-worker <id>` if a project exists; (paths follow `$AO_CONFIG_PATH`).
- Modify `deploy/admin/server.mjs` — wizard endpoints + serve the setup page.
- Create `deploy/admin/setup.html` (or reuse `deploy/web/index.html`) — the wizard SPA.
- Create `deploy/admin/config-writer.mjs` (+ test) — yaml read/add-project/write; worker PID/instance-dir resolution.
- Modify `deploy/Caddyfile` + `deploy/Caddyfile.public` — gated `reverse_proxy ao:14800` terminal block.
- Modify `deploy/README.md` — wizard section.

---

## Task 0: Revise Milestone A — consolidate state on `/root/.agent-orchestrator` + entrypoint lifecycle
- [ ] `Dockerfile`: `AO_CONFIG_PATH=/root/.agent-orchestrator/agent-orchestrator.yaml`; add `ENV GH_CONFIG_DIR=/root/.agent-orchestrator/gh` and `NEXT_PUBLIC_TERMINAL_WS_PATH=/terminal-ws`. (Keep `PORT`/`TERMINAL_PORT`/`DIRECT_TERMINAL_PORT`.)
- [ ] `docker-compose.yml`: volume `ao-state:/root/.agent-orchestrator` (was `/root/.ao`). Keep the ADC mount. `docker-compose.vm.yml` unchanged unless it references the old path.
- [ ] `entrypoint.sh`: after secret-load, `mkdir -p` the dirs; write the `projects: {}` skeleton if absent (unchanged, follows `$AO_CONFIG_PATH`); **source `/root/.agent-orchestrator/agent-secrets.env` if present** (export tokens); **if the config has ≥1 project, start `ao lifecycle-worker <id>` (backgrounded, tokens in env) before exec**; then `exec node <webdir>/dist-server/start-all.js`. Derive `<id>` from the config (first project key).
- [ ] **Verify:** rebuild `ao-local:dev`; standalone boot on empty skeleton still healthy (`GET /` 200, `/api/projects` `{"projects":[]}`, no worker started); logs show the new paths.

## Task 1: config-writer helper (TDD)
- [ ] `deploy/admin/config-writer.mjs`: `readConfig()`, `addProject({id, repo, path, teamId})` via `parseDocument`+`setIn`+`writeFileSync` (writes tracker linear + `queuePoller.enabled:true`), `getProject()`, and `workerStatus()` (compute `{hash}-{basename(path)}` instance dir, read `lifecycle-worker.pid`, `kill(pid,0)`). Hash algorithm must match ao-core's `getProjectBaseDir` — read `packages/core/dist/paths.js` and replicate exactly.
- [ ] Tests: empty `projects: {}` → add → valid map entry; idempotent re-add; workerStatus with/without a live PID.
- [ ] **Verify:** `node --test` (or the repo's runner) green.

## Task 2: GitHub endpoints
- [ ] `POST /admin/api/github/connect` `{pat}` → `gh auth login --with-token` piping the PAT via **stdin** (`execFile` + `child.stdin.write`), `GH_CONFIG_DIR` from env, `--insecure-storage`; then `gh auth setup-git`; verify `gh auth status`. Never log/echo the PAT.
- [ ] `GET /admin/api/github/repos` → `gh repo list --json nameWithOwner,url,updatedAt --limit 100` (+ optional `?search=`). Surface a clear 403 hint for SSO-protected orgs.
- [ ] **Verify:** local — connect a real PAT, list repos; `gh auth status` persists across a container restart (volume).

## Task 3: token + Linear endpoints
- [ ] `POST /admin/api/tokens` `{linear?, anthropic?}` → merge-write `/root/.agent-orchestrator/agent-secrets.env` (mode 0600, `KEY=value` lines: `LINEAR_API_KEY`, `ANTHROPIC_API_KEY`). Never log values.
- [ ] `GET /admin/api/linear/teams` → Linear GraphQL `teams{nodes{id,name,key}}` using the stored/posted `LINEAR_API_KEY`; for the teamId picker. Clear error if the key is missing/invalid.
- [ ] **Verify:** tokens file written 0600; teams list returns for a valid key.

## Task 4: project/apply (the pivot)
- [ ] `POST /admin/api/project/apply` `{repo, teamId, autopull}`:
  1. Clone `https://github.com/<repo>.git` → `/root/.agent-orchestrator/projects/<repo-basename>` (skip if a valid clone with `origin` exists); the stored gh credential helper authenticates.
  2. If `autopull`: register a 30-min timer (in the admin process) doing `git -C <path> fetch --prune`; record `lastPull`/`lastError`.
  3. `addProject({id, repo, path, teamId})` into the yaml.
  4. Respond `{applied:true, restarting:true}` **first**, then trigger a container restart (kill PID 1 after flushing) — `restart: unless-stopped` brings it back; the entrypoint re-sources tokens + starts `ao lifecycle-worker <id>`.
- [ ] **Verify:** after apply, container bounces; on return `agent-orchestrator.yaml` has the project, `/api/projects` shows it, `/api/issues` renders (dashboard has LINEAR_API_KEY), `workerStatus()` shows running.

## Task 5: GET /admin/api/setup (aggregate state)
- [ ] Return `{github:{connected,login}, repo, autopull:{lastPull,lastError}, linear:bool, claude:bool, project:{id}|null, worker:{running,pid}}` — github from `gh auth status`, tokens from the presence of keys in `agent-secrets.env` (bool only, never values), project from the config, worker from `config-writer.workerStatus()`. Omit `lastPoll` (not on disk).
- [ ] **Verify:** reflects real state at each wizard step.

## Task 6: wizard UI + terminal gating
- [ ] `deploy/admin/setup.html` — a single page (5-step checklist reading `GET /admin/api/setup`, each row → its action; poll through the apply/restart blip). Served by `server.mjs` at `/setup` (and `/` under the admin origin). No Caddy `/srv` remount.
- [ ] `Caddyfile.public` + `Caddyfile`: add a gated terminal block — `handle /terminal-ws* { authorize with mypolicy; reverse_proxy ao:14800 }` (Caddy proxies the WS `Upgrade` automatically). Confirm the setup page is reachable (route `/setup`/`/admin/*` to `ao:8090`, or keep the catch-all → :3000 and serve setup under `/admin/`).
- [ ] **Verify:** `caddy validate` (v1.1.31) both files.

## Task 7: LOCAL end-to-end verification (laptop)
- [ ] Fresh stack → walk the wizard: connect PAT → list/pick a small test repo → paste Linear key + pick team → paste Claude key → Apply. After the bounce: project present, dashboard shows it + issues.
- [ ] `ao lifecycle-worker` running (PID present); create a matching Linear ticket → a session auto-spawns in a worktree.
- [ ] **Terminal-through-gate:** open the spawned session's terminal in the dashboard → the `wss://<host>/terminal-ws?session=…` upgrade passes the caddy-security gate (the deferred M-A risk — resolve here).
- [ ] Restart the container → GitHub still connected, tokens intact, worker restarts, project persists (all on the `/root/.agent-orchestrator` volume).

## Task 8: FLEET verification (operator-run, VM)
- [ ] On a fresh `create`d bot, walk the wizard end-to-end → a Linear ticket → auto-spawned agent session → PR. `destroy` when done.

## Task 9: docs
- [ ] `README.md`: add the setup-wizard section; update the state-dir path; drop remaining Go-daemon leftovers surfaced during the work.

---

### Open decisions folded in (from spec review)
- **State on `/root/.agent-orchestrator`** (user-confirmed) — one volume, matches ao-core.
- **Apply bounces the container** (not an in-place dashboard restart) — simplest given start-all is PID 1 + `restart: unless-stopped`; entrypoint owns worker lifecycle.
- **Terminal gating = same-origin path** (`NEXT_PUBLIC_TERMINAL_WS_PATH` + one gated proxy block) — no client patch, no extra TLS listener.
