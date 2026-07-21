# TS agent-orchestrator bot swap + config wizard — Design

**Date:** 2026-07-03
**Status:** Draft for spec review
**Supersedes:** `2026-07-03-m8c-bot-setup-wizard-design.md` (that spec targeted the Go
daemon `@aoagents/ao`, which has **no** tracker/reactions automation — see below).
**Builds on:** M8a (fleet SSO, live-verified). **Fleet layer unchanged** (portal,
Caddy authorize-only, DNS, quota, deploy-gcp.sh). Only the **bot engine** swaps.

## Why (the pivot)

The deploy kit was built around the **Go daemon** (`@aoagents/ao`, `ao daemon` @
127.0.0.1:3001). The Go daemon has **no Linear tracker, no queue-poller, no
reactions** — `ao import` drops `tracker`/`reactions`/`rules` (`backend/internal/
legacyimport/project.go`). The product the user wants — tickets → auto-spawned
agent sessions → PRs, with CI/review reactions — lives only in the **TS
agent-orchestrator**.

**The real TS AO is published on public npm as `@composio/ao-cli`** (latest `0.2.2`).
Not to be confused with two namesakes we ruled out:

- bare `agent-orchestrator` npm pkg (v1.0.0-beta.1) — unrelated project, no Linear.
- `@aoagents/ao` — the Go daemon (current bot image), no automation.

`@composio/ao-cli` depends on (verified via `npm view`): `@composio/ao-core`
(queue-poller + reactions + lifecycle-manager), `@composio/ao-web` (Next.js
dashboard), `@composio/ao-plugin-tracker-linear`, `-scm-github`, `-runtime-tmux`,
`-agent-claude-code`, `-workspace-worktree`, `-terminal-web`. Everything the fleet
bot needs installs from npm — **no source build**.

## Run model (verified against compiled `packages/*/dist` + npm; spec-review confirmed)

- **Launch (from a published npm install — verified against the 0.2.2 tarballs):**
  `ao dashboard` is **dev-only** (`next dev`, needs absent app source) — do NOT use it.
  The prod dashboard is **`node <ao-web>/dist-server/start-all.js`** → `next start`
  (off the shipped prebuilt `.next`, no build) + terminal WS servers, binds `0.0.0.0:3000`,
  **boots on empty `projects: {}`**. The **automation** (Linear poll → spawn → reactions)
  is a **separate `ao lifecycle-worker <project>` process** (`getLifecycleManager(...)
.start(30_000)`, PID-guarded). `ao start <project>` bundles start-all + lifecycle-worker
  - a tmux orchestrator agent but **throws on empty config** → it's the Milestone-B
    "project configured" entry, not the empty-bot boot. So: **Milestone A runs start-all
    (dashboard, idle, no creds); Milestone B writes the yaml + starts `ao lifecycle-worker`.**
- **ao-web ships a PREBUILT `.next`** (tarball `files` include `.next/server|static|
BUILD_ID`, no `output: standalone`). ⇒ **run `next start` off the shipped build; do
  NOT pass `--prod`** (that re-runs `next build` at every boot — minutes wasted + needs
  build-time devDeps). Corrects the earlier `--prod` plan.
- **Terminals need the external `ttyd` binary** (compiled C, **not** an npm pkg).
  `ao-web/.../terminal-websocket.js` spawns `ttyd` on a **7800–7900 port range** and
  the dashboard embeds each via **iframe**. Must be installed in the image + reachable
  through Caddy, or terminals silently break (dashboard still boots). A secondary
  node-pty "direct terminal" WS exists but is **optional** (`direct-terminal-ws.js`
  `await import("node-pty")` in try/catch → "disabled" if the native build is absent).
- **Config** (`packages/core/dist/config.js`): resolution = **`AO_CONFIG_PATH`** →
  cwd `agent-orchestrator.yaml` → `~/.agent-orchestrator.yaml` → `~/.config/…`. Schema
  (`:159`) `projects: z.record(ProjectConfigSchema)` — a **required map keyed by
  project id**, NOT an array. Minimal valid skeleton is **`projects: {}`** (`port`
  defaults 3000). `projects: []` and `{}`-with-no-projects-key both **fail Zod**
  (verified by running the compiled validator). `ao init` is interactive — bake the yaml.
- **No config hot-reload**: `loadConfig()` runs once (`dashboard.js:18`) and
  `createLifecycleManager` closes over it; no file-watch. ⇒ the wizard (Milestone B)
  **must bounce `ao dashboard`** after writing a real yaml. Mandatory, not optional.
- **`ao start`** also spawns an orchestrator LLM session in tmux — heavier, not needed.
- Runtime deps: **Node 20.x** (ao-web bakes "requires Node 20.x"; node-pty 1.1.0
  incompatible with Node ≥25 — so keep `node:20-bookworm`, not 22), `git`, `tmux`,
  **`ttyd`**, `gh` CLI, `claude` CLI. `python3/make/g++` are **optional** — needed only
  to build node-pty for the _direct_ terminal; ttyd is the primary terminal and needs
  no toolchain. `better-sqlite3` is **not** used (ao-core persists to files).
- Cred env: **`LINEAR_API_KEY`**, **`GH_TOKEN`/`GITHUB_TOKEN`**, **`ANTHROPIC_API_KEY`**.
  None required to _boot_ an empty bot — only once a project with a tracker is added.

## Scope

**Two milestones.** This spec covers the design of both; plans are separate.

### Milestone A — engine swap (container)

Make the bot run `ao dashboard` (TS AO) instead of the Go daemon, behind the
existing portal, booting cleanly with an empty skeleton config.

| Item                            | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy/Dockerfile`             | Keep base **`node:20-bookworm`** (vendor bakes "requires Node 20.x"; node-pty breaks on ≥25 — do NOT jump to 22). Install **`ttyd`** (primary terminal — external binary; via apt/`tsl0922/ttyd` release) + keep `tmux git curl ca-certificates gh`. `python3 make g++` **optional** — add only if we want the node-pty _direct_ terminal; ttyd needs no toolchain and `better-sqlite3` is not used. Line 21: `@aoagents/ao@0.10.0` → **`@composio/ao-cli@0.2.2 @anthropic-ai/claude-code`**; `ao --version` sanity. Replace `ENV AO_PORT=3001` with **`AO_CONFIG_PATH=/root/.ao/agent-orchestrator.yaml`**; `EXPOSE 3001`→**`3000`**. Fix the `--platform=linux/amd64` **comment** (ao-cli is not x64-only) but keep the pin (GCE VM is x64).                                                                                                                                                                                                 |
| `deploy/entrypoint.sh`          | **Delete the Go-binary-resolve+exec block** (`entrypoint.sh:77-80`) and the **socat loopback bridge** (`:53-55`, existed only because the Go daemon bound 127.0.0.1; `next start` binds 0.0.0.0 — but confirm the WS/ttyd bind host first, see risks). After secret-load: **ensure `/root/.ao/agent-orchestrator.yaml` exists** — write skeleton **`projects: {}`** (map, not array; `port`/dirs default) if absent so a fresh bot boots. Then `exec node <ao-web>/dist-server/start-all.js` (webDir via `require.resolve('@composio/ao-web/package.json')`; **not `ao dashboard`** — that's dev-only) with `PORT=3000`. start-all runs `next start` off the prebuilt `.next` + terminal servers, installs its own SIGTERM cleanup; compose `init: true` reaps ttyd grandchildren. Background the admin/wizard backend as today; keep `GH_CONFIG_DIR` on the volume. (Milestone B adds `ao lifecycle-worker <project>` once a project exists.) |
| `deploy/Caddyfile.public`       | Retarget `reverse_proxy ao:8080`(socat) → **`ao:3000`**. **Also proxy the terminal surfaces**: the **`ttyd` iframe range 7800–7900** and the WS servers (`terminalPort`/`directTerminalPort`, default 14800/14801 — pin explicit ports in the yaml so the Caddy config is static). WebSocket `Upgrade` must survive the caddy-security **authorize** gate — **live-test** (cookie JWT on the WS handshake is exactly what silently 401s). Authorize-only gate otherwise unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Compose (`docker-compose*.yml`) | `AO_PORT`→remove; add `AO_CONFIG_PATH`, `LINEAR_API_KEY`/`ANTHROPIC_API_KEY` passthrough. Keep `init: true`. Volume `/root/.ao` unchanged. Expose the ttyd/WS ports to the caddy sibling.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `HEALTHCHECK`                   | No health route exists on the dashboard (routes: projects/sessions/spawn/… no `/healthz`, no `/api/health`). Use **`GET http://127.0.0.1:3000/`** (renders 200 with empty projects) or a TCP liveness on 3000.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `deploy-gcp.sh`                 | `.env` template: drop Go-only vars, add `LINEAR_API_KEY=`/`ANTHROPIC_API_KEY=` empties. `AO_AUTH_URL`/`ALLOWED_EMAILS` unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

**Verify (A):** local compose bot boots `ao dashboard` off the `projects: {}` skeleton
(no Zod crash, no creds), dashboard reachable through the portal gate, empty-project
state renders. **Open a terminal panel through the gate** (ttyd iframe + WS upgrade
must pass caddy-security — the load-bearing unknown). Then a fresh VM `create` serves
the TS dashboard behind SSO with a working terminal.

### Milestone B — config wizard (reshaped M8c, now real)

A **Setup page on the bot** (behind the SSO gate) that takes the empty bot to a
working one by writing a **real `agent-orchestrator.yaml`** + on-box tokens, then
restarting the engine. Chosen over create-time baking because the fleet invariant is
**per-user, on-box creds that never route through the admin** who runs `create`.

Steps (checklist, each row reads real state + acts):

1. **Connect GitHub** — paste PAT → `gh auth login --with-token --insecure-storage`
   (GH_CONFIG_DIR on volume). State from `gh auth status` (never echo token).
2. **Pick repo** — `gh repo list --json nameWithOwner,url` picker + paste-URL fallback.
3. **Clone + 30-min auto-pull** — clone to `/root/.ao/projects/<repo>`; timer does
   `git -C <repo> fetch --prune` (worktrees cut from `origin/<branch>`), record
   `lastPull`/`lastError`.
4. **Linear** — paste `LINEAR_API_KEY` (+ pick `teamId` via Linear API), on-box.
5. **Claude** — paste `ANTHROPIC_API_KEY`, on-box.
6. **Write the yaml** — generate `agent-orchestrator.yaml` with a **map** entry:
   `projects: { <id>: { repo, path, tracker: {plugin: linear, teamId}, queuePoller: {enabled, filters, onSpawn}, reactions } }`, then **start `ao lifecycle-worker <id>`** (the poller+reactions engine — PID-guarded, so safe to (re)invoke). Since Next API routes `loadConfig()` per-request, the dashboard reflects the new project without a restart; only the lifecycle-worker process must be (re)started to pick up config changes (no hot-reload).

Tokens live **on-box** (env passed into the dashboard process / spawned sessions),
persisted on the `/root/.ao` volume so they survive restart + Watchtower recreate.

**Verify (B):** on a fresh bot, walk the wizard → yaml written → dashboard shows the
project → a matching Linear ticket auto-spawns a claude-code session in a worktree
(the automation the Go daemon could never do).

## Non-goals (later)

- Device-flow GitHub/Claude login (PAT paste now; documented drop-in upgrade).
- Multi-repo per bot (one repo per bot; matches max-1 quota).
- M8b self-serve provisioning broker (separate milestone).
- Rich reactions/queuePoller tuning UI (sane defaults now, advanced knobs later).

## Risks / open questions

**Resolved by spec review (were open, now answered):**

- ~~Native-build~~ — `better-sqlite3` not used; node-pty **optional** (graceful-disable),
  so no toolchain is _required_. Add `python3/make/g++` only to keep the direct terminal.
- ~~`--prod`/next build~~ — ao-web ships a prebuilt `.next`; **skip `--prod`**, `next start`
  runs off it. No runtime build.
- ~~Health endpoint~~ — none exists; use `GET /` or TCP on 3000.
- ~~Config reload~~ — no hot-reload; **wizard must bounce `ao dashboard`** (Milestone B).
- ~~Skeleton config~~ — must be **`projects: {}`** (map); `[]` crashes Zod.

**Still to pin at plan/verify time:**

- **`ttyd` install + 7800–7900 proxying** — the terminal depends on the external `ttyd`
  binary; confirm the apt/release install and how the iframe range is proxied/gated.
- **WS/ttyd bind host** — do the WS servers + ttyd bind `0.0.0.0` or `localhost`? If
  `localhost`, the caddy sibling container can't reach them (decides whether the socat
  bridge can really be removed). **Verify before deleting the bridge.**
- **WS upgrade through the SSO gate** — cookie-JWT on `Upgrade: websocket` through
  caddy-security must be live-tested; this is the highest-risk unknown for A.
- **Node 20 vs 22** — spec pins **20** (vendor guidance + node-pty ≤24). Revisit only
  if a dep forces it.
- **Self-update** — pin `@composio/ao-cli` exact; Watchtower recreates on a new image.
- **git identity for worktrees/push** — bot needs a git author + push auth (GH_TOKEN
  HTTPS) to open PRs; set in entrypoint/wizard.
