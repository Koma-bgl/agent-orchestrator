# TS AO bot swap — Milestone A (engine swap) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Swap the fleet bot's engine from the **Go daemon** (`@aoagents/ao`, 127.0.0.1:3001, no tracker automation) to the **TS agent-orchestrator** (`@composio/ao-cli`, `ao dashboard` on 0.0.0.0:3000, with Linear tracker + queue-poller + reactions). A freshly-`create`d bot boots the TS dashboard behind the existing fleet SSO gate, idle on an empty config, with working terminals. **The entire fleet layer (portal, DNS, quota, `deploy-portal.sh`) is untouched.** The config wizard is Milestone B.

**Architecture:** The `ao` container installs `@composio/ao-cli` from npm (pulls `ao-core` = poller+reactions+lifecycle, `ao-web` = prebuilt Next.js dashboard, and the tracker-linear/scm-github/runtime-tmux/agent-claude-code plugins). Entrypoint writes a minimal `projects: {}` skeleton yaml if absent, then `exec ao dashboard --no-open --port 3000` (no `--prod` — ao-web ships a built `.next`). Caddy retargets from the socat bridge (`ao:8080`) to the dashboard (`ao:3000`), keeps `/admin/api/*` → `ao:8090`, and gains the terminal surfaces (ttyd iframe range + WS servers). The Go-daemon socat bridge and platform-binary exec block are deleted.

**Tech Stack:** `@composio/ao-cli@0.2.2` (pinned), Node 20-bookworm, `ttyd`, tmux/git/gh/`@anthropic-ai/claude-code`, Caddy + caddy-security v1.1.31 (bot image, unchanged), docker-compose.

**Spec:** `docs/superpowers/specs/2026-07-03-ts-ao-bot-swap-design.md` (spec-review-approved; two blockers + should-fixes folded).

> **✅ BUILD + LOCAL BOOT VERIFIED (2026-07-03).** `ao-local:dev` builds clean
> (`@composio/ao-cli@0.2.2` + `@anthropic-ai/claude-code` + ttyd 1.7.7). Container
> boots idle on the `projects: {}` skeleton: entrypoint writes the skeleton →
> `start-all.js` resolves WEBDIR → **Next.js Ready on 0.0.0.0:3000**, terminal-WS on
> :14800, node-pty direct-terminal gracefully disabled (expected — ttyd is primary).
> `GET /` → 200, `GET /api/projects` → `{"projects":[]}` (config loads, no crash),
> HEALTHCHECK → **healthy**. Full compose stack: caddy up, **unauthenticated `GET /`
> → 302 to Google sign-in** (gate + `ao:3000` proxy wired), `/admin/api/*` gated too.
> **Bug found + fixed during Task 1/2:** ao-web is a NESTED dep of the global ao-cli
> (`.../ao-cli/node_modules/@composio/ao-web`), so a bare `require.resolve` fails —
> WEBDIR must resolve relative to the `ao` bin (fixed in Dockerfile + entrypoint).
> **Still human/browser-gated (Task 6 tail + Task 7):** completing OAuth → dashboard
> render, and the terminal-through-gate WS test.

> **⚠️ Two verifications that CANNOT be skipped on paper (spec-review findings):**
>
> 1. **`ttyd` terminal through the gate** — the dashboard embeds `ttyd` (external C binary, ports 7800–7900) via iframe. Must be installed AND reachable through Caddy or terminals silently break.
> 2. **WebSocket `Upgrade` through the caddy-security `authorize` gate** — cookie-JWT on a WS handshake is exactly what silently 401s. Live-test end-to-end, not just HTTP.

> **⚠️ DSL-drift guard (binding since M3):** every Caddyfile change MUST pass `caddy validate` against the **pinned v1.1.31** plugin build before proceeding. Never guess past a validate failure.

### Grounding facts (verified this session against `packages/*/dist` + npm)

- `@composio/ao-cli@0.2.2` deps (via `npm view`) include `@composio/ao-web@0.2.2`, `ao-core@0.2.0`, `ao-plugin-tracker-linear`, `-scm-github`, `-runtime-tmux`, `-terminal-web`, `-workspace-worktree`, `-agent-claude-code`. Latest dist-tag = 0.2.2.
- `ao dashboard` (`packages/cli/dist/commands/dashboard.js`): `port = opts.port ?? config.port ?? 3000` (`:19`); `next start` (binds 0.0.0.0); `createLifecycleManager(...).start(30_000)` (`:87-95`); installs own SIGINT/SIGTERM→`killAll` (`:115`). `--no-open` (`:14`) and `--prod` (`:16`) exist; **do not pass `--prod`** (ao-web ships a prebuilt `.next`; `--prod` re-runs `next build` at boot).
- Config schema (`packages/core/dist/config.js:159`): `projects: z.record(ProjectConfigSchema)` — **required map keyed by id**. Verified by running the compiled validator: `{projects:{}}` → OK (port defaults 3000); `{projects:[]}` and `{}` → Zod FAIL. Resolution: `AO_CONFIG_PATH` → cwd → `~/.agent-orchestrator.yaml`.
- **No hot-reload**: `loadConfig()` runs once; lifecycle-manager closes over it. (Matters for Milestone B, not A.)
- Terminals: `ao-web/.../terminal-websocket.js` spawns external **`ttyd`** on **7800–7900**, embedded via iframe; a secondary node-pty "direct" WS (`terminalPort`/`directTerminalPort`, default 14800/14801, `web-dir.js`) is **optional** (`await import("node-pty")` in try/catch). No `better-sqlite3` anywhere.
- No `/healthz` / `/api/health` route on the dashboard — use `GET /` or TCP:3000.
- Node: ao-web bakes "requires Node 20.x"; node-pty 1.1.0 breaks on Node ≥25 → **stay on `node:20-bookworm`**.
- Current bot wiring being replaced: `entrypoint.sh:49-55` socat bridge, `:63-80` Go platform-binary resolve+exec; `Caddyfile.public:50` `reverse_proxy ao:8080`; `docker-compose.yml:20-21` expose 8080/8090; `Dockerfile:21` `@aoagents/ao@0.10.0`, `:32` `AO_PORT=3001`, `:37-38` `/healthz` healthcheck.

### File structure

- Modify `deploy/Dockerfile` — install `@composio/ao-cli` + ttyd; drop Go-only bits.
- Modify `deploy/entrypoint.sh` — skeleton yaml + `exec ao dashboard`; delete socat + Go exec.
- Modify `deploy/Caddyfile.public` — retarget `ao:3000` + terminal routes (VM/fleet).
- Modify `deploy/Caddyfile` — same retarget for local mode (keeps its `/auth*` portal).
- Modify `deploy/docker-compose.yml` + `deploy/docker-compose.vm.yml` — ports/env/AO_CONFIG_PATH.
- Modify `deploy/deploy-gcp.sh` — `.env` template (drop AO_PORT; add LINEAR/ANTHROPIC).
- Modify `deploy/README.md` — record the engine swap; correct Go-daemon references.

---

## Task 0: Recon — ✅ DONE (findings below; they corrected the launch model)

Inspected the **published npm tarballs** (`@composio/ao-cli@0.2.2`, `@composio/ao-web@0.2.2`) in scratch — NOT the vendored `packages/` (which is a drifted dev copy). Findings:

- **`ao dashboard` is dev-only** — spawns `npx next dev` (needs app source, which ao-web does NOT ship) and `tsx server/*.ts` (ships as `dist-server/*.js`). **Do not use it in the container.**
- **The prod dashboard = `node <webDir>/dist-server/start-all.js`** — starts `next start` (off the shipped prebuilt `.next`, NO build) + `terminal-websocket.js` + `direct-terminal-ws.js`. **Boots fine with empty `projects: {}`** (Next API routes call `loadConfig()` per-request and return empty lists; start-all does no project validation). `<webDir>` = `dirname(require.resolve('@composio/ao-web/package.json'))`.
- **`ao start <project>`** does start-all **+ `ensureLifecycleWorker` (spawns `ao lifecycle-worker <project>` = poller+reactions) + a tmux orchestrator agent** — but **throws on empty config** (`resolveProject`). So it's the Milestone-B "project configured" entry, not the empty-bot boot.
- **Automation engine = `ao lifecycle-worker <project>`** (own command): `getLifecycleManager(config, projectId).start(intervalMs)`, PID-file guarded (no dup pollers), 30s default. This is what does Linear poll → spawn → reactions. Milestone B starts it after writing the yaml.
- **Bind hosts — all `0.0.0.0`** (socat bridge REMOVABLE): `next start` (0.0.0.0); terminal-WS `server.listen(TERMINAL_PORT=14800)` no host → 0.0.0.0; direct-WS `listen(14801)` → 0.0.0.0; `ttyd --writable --port <7800+> --base-path /<sessionId>` (no `-i`) → 0.0.0.0.
- **Terminal reachability (the HIGH-RISK item for Caddy):** `buildDashboardEnv` sets `NEXT_PUBLIC_TERMINAL_PORT`/`NEXT_PUBLIC_DIRECT_TERMINAL_PORT` → the **browser builds terminal URLs with an explicit PORT** (`ws://<host>:14800…`), not a path. ttyd runs per-session on 7800+ behind the 14800 server (`--base-path /<sessionId>`). So through the SSO gate + TLS the browser must reach **:14800** on the bot — a raw cross-port hop with no TLS/JWT-cookie. **This is why terminals-through-the-gate must be live-tested (Task 6)** and may require either publishing 14800/14801 with their own TLS+gate, or patching the client's URL construction to a same-origin Caddy path. If it can't be gated cleanly in budget: ship A with terminals as a known Milestone-B follow-up (dashboard + automation still work).

## Task 1: Dockerfile — install the TS AO engine

- [ ] Keep `FROM --platform=linux/amd64 node:20-bookworm` (NOT slim — need libs for ttyd/native; NOT 22 — vendor pins Node 20). **Fix the `--platform` comment** (ao-cli is not x64-only; pin kept because the GCE VM is x64).
- [ ] apt: keep `tmux git curl ca-certificates gnupg gh`; **drop `socat`**; **add `ttyd`** (Debian bookworm ships `ttyd` in apt — prefer that; if the version is too old for the dashboard, install the static release from `tsl0922/ttyd`). Decide `python3 make g++`: **omit by default** (node-pty is optional; ttyd is the primary terminal) — add only if Task 0 shows the direct terminal is needed.
- [ ] Replace `npm install -g @aoagents/ao@0.10.0 @anthropic-ai/claude-code` with **`npm install -g @composio/ao-cli@0.2.2 @anthropic-ai/claude-code`**; keep `ao --version`.
- [ ] Replace `ENV AO_PORT=3001` with `ENV AO_CONFIG_PATH=/root/.ao/agent-orchestrator.yaml`; `EXPOSE 3001`→`EXPOSE 3000`.
- [ ] Rewrite `HEALTHCHECK` to `curl -fsS http://127.0.0.1:3000/ || exit 1` (or a TCP check).
- [ ] Keep `GH_CONFIG_DIR` env if already present (Milestone B uses it); keep `WORKDIR /app`, the `entrypoint.sh`/`scripts`/`admin` COPYs.
- [ ] **Verify:** `docker build` succeeds; `docker run --rm ao-local:dev ao --version` prints the ao-cli version, `which ttyd` resolves, and `node -e "require.resolve('@composio/ao-web/package.json')"` + `require.resolve('next')` both succeed (start-all needs them).

## Task 2: entrypoint.sh — boot the dashboard, drop the Go plumbing

- [ ] Keep the secret-load block (`:1-47`) unchanged.
- [ ] **Delete** the socat loopback bridge (`:49-55`) — _iff_ Task 0 confirmed WS/ttyd bind 0.0.0.0. If they bind localhost, keep a socat relay for exactly those terminal ports and note why.
- [ ] Keep the admin backend background launch (`:57-61`) — Milestone B builds on it. (Its Go-daemon-facing endpoints are dead until B; acceptable.)
- [ ] **Delete** the Go platform-binary resolve + `exec` block (`:63-80`).
- [ ] Add: ensure the config exists — `if [ ! -f "$AO_CONFIG_PATH" ]; then mkdir -p "$(dirname "$AO_CONFIG_PATH")"; printf 'projects: {}\n' > "$AO_CONFIG_PATH"; fi` (map, NOT `[]`).
- [ ] Add a git identity default (`git config --global user.email/name` if unset) so future worktree commits don't fail — harmless in A, needed in B.
- [ ] Resolve the web dir + launch the **prod dashboard** (NOT `ao dashboard`): `WEBDIR="$(node -e "const p=require('path');process.stdout.write(p.dirname(require.resolve('@composio/ao-web/package.json')))")"` then `exec node "$WEBDIR/dist-server/start-all.js"` with `PORT=3000` in env. This runs `next start` (off the prebuilt `.next`, no build) + both terminal servers; boots on empty `projects: {}`. start-all is PID1 and installs its own SIGINT/SIGTERM→cleanup; compose `init:true` reaps grandchildren (ttyd). Milestone B adds `ao lifecycle-worker <project>` once a project exists.
- [ ] Ensure `PORT`, `TERMINAL_PORT=14800`, `DIRECT_TERMINAL_PORT=14801` are set/exported so ports are deterministic for the Caddy config (start-all reads `PORT`; the terminal servers read `TERMINAL_PORT`/`DIRECT_TERMINAL_PORT`; also set `NEXT_PUBLIC_*` to match — but see Task 0 terminal-reachability risk).
- [ ] **Verify:** `bash -n entrypoint.sh`; `docker compose up` → logs show the skeleton write + `[next]`/`[terminal]` start-all output on :3000.

## Task 3: Caddyfile.public (VM/fleet) — retarget + terminal routes

- [ ] Change the main `handle { … root * /srv; file_server }` block: the TS dashboard now serves the UI **and** its own `/api/*`, so replace the catch-all body with `authorize with mypolicy` + `reverse_proxy ao:3000` (keep `flush_interval -1` for SSE). Drop the `/srv` file_server as the main surface.
- [ ] Keep `handle /admin/api/* { authorize; reverse_proxy ao:8090 }` (our backend, distinct prefix — no collision with the dashboard's `/api/*`).
- [ ] **Delete/replace** the old `handle /api/* → ao:8080` socat route (the dashboard serves `/api/*` itself on :3000; the catch-all now covers it).
- [ ] Add the **terminal routes** per Task 0's findings (path-based `handle /terminal*`→ttyd/WS port, or port exposure). Ensure the `authorize` gate is applied but the **WebSocket `Upgrade`** passes (caddy reverse_proxy handles Upgrade automatically; the risk is the auth gate — test in Task 6).
- [ ] **Verify:** `caddy validate` inside the pinned v1.1.31 image (as M8a did). The authorize policy block itself is unchanged.

## Task 4: Caddyfile (local mode) — mirror the retarget

- [ ] Apply the same catch-all → `ao:3000`, drop `/api/*`→8080, keep `/admin/api/*`→8090, keep the `/auth*` local portal + terminal routes.
- [ ] **Verify:** `caddy validate` (local build).

## Task 5: compose — ports, env, config path

- [ ] `docker-compose.yml` `ao` service: fix the `platform` comment (ao-cli not x64-only); `expose` — replace `8080` with the terminal ports Task 0 requires (+ keep `8090` admin); add `AO_CONFIG_PATH` to env (or rely on the Dockerfile ENV); keep `ao-state:/root/.ao`. Keep `init: true` (now load-bearing — `ao dashboard` is Node PID1 spawning children).
- [ ] `docker-compose.vm.yml`: drop `./web:/srv` as the main mount if unused (Milestone B decides its fate); add `LINEAR_API_KEY`/`ANTHROPIC_API_KEY` passthrough to the `ao` service env (from `.env`); `AO_AUTH_URL`/`ALLOWED_EMAILS` unchanged.
- [ ] Ensure the caddy service can reach the terminal ports on `ao` (compose network `expose`).
- [ ] **Verify:** `docker compose -f docker-compose.yml -f docker-compose.vm.yml config` renders without error.

## Task 6: LOCAL stack verification (laptop) — the load-bearing tests

- [ ] `docker compose up -d --build` → `ao` boots the dashboard off the `projects: {}` skeleton with **no crash and no creds** (`docker compose logs ao`).
- [ ] `GET https://localhost:8443/` through the gate → the **TS dashboard** renders (not the old SPA), empty project list.
- [ ] **Open a terminal panel** in the dashboard through the gate → ttyd iframe loads and the **WebSocket connects** (this is the WS-through-caddy-security test). If it 401s/strips headers, iterate on the Caddy terminal route before declaring Task done.
- [ ] Restart the container → dashboard still boots (skeleton persisted on the volume).

## Task 7: FLEET verification (operator-run, VM — costs VM time)

- [ ] `./deploy-gcp.sh create` a bot → browse `https://<user>.binary-badger.xyz`, pass SSO once at the portal → land on the **TS dashboard**, empty state, working terminal.
- [ ] Confirm self-update path unaffected (Watchtower recreates on a newer image; `@composio/ao-cli` pinned).
- [ ] `destroy` the bot when done (billing back to ~$0).

## Task 8: deploy-gcp.sh + docs

- [ ] `deploy-gcp.sh`: `.env` template — remove `AO_PORT`; add empty `LINEAR_API_KEY=`/`ANTHROPIC_API_KEY=` alongside the existing empty `GITHUB_TOKEN`/`CLAUDE_CODE_OAUTH_TOKEN`. `AO_AUTH_URL`/`ALLOWED_EMAILS` untouched.
- [ ] `README.md`: replace Go-daemon references (port 3001, `ao daemon`, `/healthz`, socat bridge) with the TS AO model; note Milestone B (config wizard) is next.
- [ ] **Verify:** `bash -n deploy-gcp.sh`.

---

### What this plan deliberately does NOT do (Milestone B)

- Writing a **real** `agent-orchestrator.yaml` (repo, `tracker: linear`, `teamId`, `queuePoller`, `reactions`) — the wizard.
- Token entry (`LINEAR_API_KEY`/`ANTHROPIC_API_KEY`/GitHub PAT) via the bot UI + on-box persistence.
- Restarting `ao dashboard` after a config change (no hot-reload).
- Reworking the admin backend's Go-daemon-facing endpoints into TS-AO-facing ones.
