# TS AO bot — Milestone B (setup wizard) — Design

**Date:** 2026-07-03
**Status:** Draft for spec review
**Builds on:** Milestone A (engine swap — VERIFIED: TS AO dashboard boots idle on a
`projects: {}` skeleton behind the fleet SSO gate). Realizes the "provide the yaml"
onboarding against the real TS AO.
**Supersedes the wizard portion of:** `2026-07-03-m8c-bot-setup-wizard-design.md`
(Go-daemon `ao project add`/`set-config` → real `agent-orchestrator.yaml` + `ao
lifecycle-worker`).

## Problem

A Milestone-A bot boots the dashboard **idle**: empty `projects: {}`, no creds, no
automation. Making it work means writing a real `agent-orchestrator.yaml` (a project
with a Linear tracker + queuePoller + reactions) and supplying three per-user tokens
— **on-box**, so the admin who ran `create` never handles anyone's secrets. We build
an **admin-UI setup wizard on the bot** (the setup state + creds live on the bot, so
the UI that reads/writes them belongs there), behind the existing SSO gate.

## Grounding facts (verified from the published 0.2.2 tarballs; spec-review-confirmed)

- **No built-in onboarding**: the dashboard's `/api/projects` is **GET-only**; there
  is no add-project UI and `ao setup` is openclaw-only. The wizard must own this.
- **Minimal project shape** (`config.js:119-145`): only **`repo` + `path` are required**;
  everything else is optional/defaulted. Load-time defaults that matter: `queuePoller.enabled`
  defaults **false** → wizard MUST write `queuePoller.enabled: true`; `tracker` defaults to
  `{plugin: github}` → wizard MUST write `tracker: {plugin: linear, teamId}` explicitly
  (`teamId` is a **string**, passthrough-validated); `reactions` get a rich default set at
  load → wizard need NOT write them. So the minimum entry is `{repo, path, tracker, queuePoller}`.
- **Config is a writable YAML**: edit with the `yaml` lib's `parseDocument` +
  `doc.setIn(["projects","<id>"], {...})` + `writeFileSync` — exactly ao-cli's own
  pattern (`setup.js`). `AO_CONFIG_PATH` is honored by `loadConfig`. No existing runtime
  writer to reuse; `deploy/admin/server.mjs` owns the write.
- **⚠️ State dir is hardcoded to `~/.agent-orchestrator`, NOT `~/.ao`** (`core/dist/paths.js`,
  `running-state.js`; the published core too). **`AO_DATA_DIR` is never read as an override**
  (write-only, injected into sessions). So the worker PID (`{hash}-{basename(path)}/`),
  sessions, and **worktrees** all land under `~/.agent-orchestrator`. The M-A volume is
  `ao-state:/root/.ao` → **worker/session/worktree state is currently OFF-volume and lost on
  recreate.** (This upstream dir is unrelated to the CLAUDE.md `~/.ao` rule, which governs the
  Electron desktop app in this tree, not the containerized upstream server.)
- **Automation = a separate process**: `ao lifecycle-worker <id> [--interval-ms]`
  (`lifecycle-worker.js`) runs the poll→spawn→reactions loop; PID-guarded via a
  `lifecycle-worker.pid` + `kill(pid,0)` liveness (`lifecycle-service.js`), spawned detached
  inheriting `process.env`. Needs `LINEAR_API_KEY` in its env to poll. Independent of the
  dashboard. **`lastPoll` is in-memory only** — not on disk; the state endpoint can read
  `{running,pid}` from the PID file but NOT `lastPoll` (parse the worker log heartbeat, or drop it).
- **No config hot-reload**: `loadConfig()` runs once per process. **The dashboard queries
  Linear at REQUEST time** — `/api/issues`, `/api/backlog`, `/api/setup-labels` read
  `LINEAR_API_KEY` from `process.env` (chunk 420). So applying tokens **MUST bounce the
  dashboard** for those views (not just start the worker). Definitive — no hedge.
- **Cred env**: Linear reads `LINEAR_API_KEY`; `gh` reads `GH_TOKEN`/`GITHUB_TOKEN`;
  claude-code reads `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN`). **`git push` needs a
  credential helper** — run `gh auth setup-git` at connect time (or carry `GH_TOKEN` into the
  session env), else the scm-github plugin's PR push can fail.
- **Terminals — gating is EASIER than first feared (spec-review correction):** the client
  already supports a **same-origin proxy path**: `NEXT_PUBLIC_TERMINAL_WS_PATH` → the client
  builds `wss://<location.host><path>?session=<id>` (`.next/static/chunks/381-*.js`), and the
  WS server on 14800 reads `?session=`. So gating needs **no client patch, no extra TLS
  listener**: set `NEXT_PUBLIC_TERMINAL_WS_PATH=/terminal-ws` + one `authorize` +
  `reverse_proxy ao:14800` (WS upgrade) block in `Caddyfile.public`. ttyd spawns per tmux
  session on 7800+ (behind the 14800 server). First testable here (an idle bot has no sessions).

## Goals

From the bot's browser (behind SSO), a **Setup page** takes an idle bot → working:
1. **Connect GitHub** — paste a PAT → `gh auth login --with-token --insecure-storage`
   (`GH_CONFIG_DIR=/root/.ao/gh` on the volume); state from `gh auth status` (never
   echo the token).
2. **Pick a repo** — `gh repo list --json nameWithOwner,url` picker + paste-URL fallback.
3. **Clone + 30-min auto-pull** — clone to `/root/.ao/projects/<repo>`; a timer runs
   `git -C <repo> fetch --prune` (worktrees are cut from `origin/<branch>`), records
   `lastPull`/`lastError` so an expired PAT is visible, not a silent stall.
4. **Linear** — paste `LINEAR_API_KEY`; pick `teamId` (list teams via the Linear API).
5. **Claude** — paste `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN`).
6. **Apply** — write the project into `agent-orchestrator.yaml` (map entry with
   `tracker: {plugin: linear, teamId}`, `queuePoller.enabled: true` + sane defaults,
   `reactions` defaults), persist the tokens on-box, then **(re)start `ao
   lifecycle-worker <id>`**. State page shows each step done/pending + the worker's
   health/last-poll.

## Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| Surface | **Admin-UI wizard** (Setup page + `deploy/admin/server.mjs` endpoints), behind the fleet gate | Setup state + creds live on the bot; user picked UI; the dashboard has no add-project flow |
| Wizard UI home | **A single HTML page served by the admin backend** (`server.mjs`, same origin, behind `mypolicy`) — NOT a re-added Caddy `/srv` SPA | Fewer moving parts, one less Caddy route to pass `caddy validate`; the dashboard (GET-only) can't host it |
| **State volume (BLOCKER fix)** | **Consolidate the container on `~/.agent-orchestrator`**: mount `ao-state:/root/.agent-orchestrator`, set `AO_CONFIG_PATH=/root/.agent-orchestrator/agent-orchestrator.yaml`, `GH_CONFIG_DIR=/root/.agent-orchestrator/gh`, clone to `/root/.agent-orchestrator/projects/<repo>`, tokens at `/root/.agent-orchestrator/agent-secrets.env`. **Revises M-A** (Dockerfile ENV + compose volume path; entrypoint uses `$AO_CONFIG_PATH` so its code is unchanged). | ao-core hardcodes `~/.agent-orchestrator` with no override, so worker PID/sessions/worktrees only persist if the volume is there. One volume, everything durable across Watchtower recreate. Container-internal path — unrelated to the desktop app's `~/.ao` rule. |
| GitHub auth | **Paste a PAT** (device flow deferred). `gh auth login --with-token` reads the PAT from **stdin** (keep it off the process table); `--insecure-storage` persists plaintext `hosts.yml`; then `gh auth setup-git` so agent `git push` has a credential helper. | ~4× less build; stdin + setup-git close the PR-push gap |
| Where creds live | **On-box** — `gh` config dir + Linear/Claude tokens in an on-box env file, all on the volume | Fleet invariant: per-user, on-box, never centralized/never via the admin |
| Token → process env + **mandatory bounce** | Wizard writes `agent-secrets.env` (0600); **entrypoint sources it** for the dashboard, and the wizard injects it into the `ao lifecycle-worker` spawn. The dashboard queries Linear at request time (`/api/issues|backlog|setup-labels`), so **Apply MUST restart start-all** (brief blip) — not just the worker. | Verified: those routes read `LINEAR_API_KEY` from `process.env` at request time; env is fixed at launch |
| Config write | `parseDocument` + `doc.setIn(["projects","<id>"],{…})` + `writeFileSync` into `AO_CONFIG_PATH` | ao-cli's own pattern; structural, idempotent re-runs |
| Start automation | `ao lifecycle-worker <id>` spawned/supervised by the admin backend (PID-guarded). **Re-apply with changed teamId/token must `stopLifecycleWorker` then `ensure`** (not the idempotent no-op). **The M-A entrypoint must also start the worker on boot if a project already exists** (PID is off-container → dies on recreate) — a definite B task that touches the shipped entrypoint. | The dashboard doesn't start it; the wizard owns the lifecycle; recreate-safety needs the boot check |

## Architecture

Extends the co-located admin backend (`deploy/admin/server.mjs`) + a small setup SPA,
all behind `mypolicy`. New endpoints (each idempotent/re-entrant):

| Endpoint | Does |
|---|---|
| `GET /admin/api/setup` | Wizard state: `{github:{connected,login}, repo, autopull:{lastPull,lastError}, linear:bool, claude:bool, project:{id}|null, worker:{running,pid}}` — github from `gh auth status`, project from `AO_CONFIG_PATH`, worker `{running,pid}` by computing ao-core's `{hash}-{basename(path)}` instance dir and reading its `lifecycle-worker.pid` + `kill(pid,0)`. **No `lastPoll` on disk** — omit it, or parse the worker log's 5-min heartbeat if we want liveness detail. Never echo tokens. |
| `POST /admin/api/github/connect` | `{pat}` → `gh auth login --with-token --insecure-storage`; verify `gh auth status`. |
| `GET /admin/api/github/repos` | `gh repo list --json nameWithOwner,url,updatedAt` (search/paginate). |
| `GET /admin/api/linear/teams` | List Linear teams (GraphQL) using the provided/stored `LINEAR_API_KEY`, for the teamId picker. |
| `POST /admin/api/tokens` | `{linear?, anthropic?}` → write `/root/.ao/agent-secrets.env` (0600). Never log. |
| `POST /admin/api/project/apply` | `{repo, teamId, autopull}` → clone to `/root/.agent-orchestrator/projects/<repo>` (skip if present) with `origin` set (workspace-worktree needs it), enable auto-pull, write the project map entry (`{repo, path, tracker:{plugin:linear,teamId}, queuePoller:{enabled:true,…}}`; `workspace` unset = worktree default), **`stopLifecycleWorker` then `ensureLifecycleWorker`** with tokens in env (restart, so a changed teamId/token takes effect), then **bounce start-all** so the dashboard's request-time Linear reads pick up `LINEAR_API_KEY`. |

## Non-goals (later)
- Device-flow GitHub/Claude login (PAT paste now; documented drop-in upgrade).
- Multi-repo per bot (one repo per bot; matches max-1 quota).
- The tmux **orchestrator agent** (`ao start`'s third process) — the queue-poller
  auto-spawns task sessions; the always-on reasoning orchestrator is optional/deferred.
- Rich reactions/queuePoller tuning UI (sane defaults now; advanced knobs later).

## Verification
1. **Local (compose):** connect a PAT, list repos, clone a small test repo, paste a
   Linear key + pick a team, paste a Claude key, Apply → `agent-orchestrator.yaml`
   has the project, `/api/projects` shows it, the dashboard bounced so `/api/issues`
   renders Linear, `ao lifecycle-worker` running (PID present). Restart the container →
   GitHub still connected + tokens + worker state intact (now on `/root/.agent-orchestrator`
   volume). **Terminal-through-gate**: after a session spawns (poller or `ao spawn`),
   open its terminal through Caddy with `NEXT_PUBLIC_TERMINAL_WS_PATH=/terminal-ws` +
   the gated `reverse_proxy ao:14800` block → confirm the WS upgrade passes the gate.
3. **Fleet (VM, operator):** on a fresh `create`d bot, walk the wizard end-to-end →
   a matching Linear ticket auto-spawns an agent session in a worktree that opens a PR
   — the automation the Go daemon never had.

## Risks / open questions

**Resolved by spec review (were open, now answered):**
- ~~Token propagation~~ — the dashboard queries Linear at request time ⇒ **Apply MUST
  bounce start-all**. Settled.
- ~~Terminal-through-gate~~ — client supports a same-origin path
  (`NEXT_PUBLIC_TERMINAL_WS_PATH`) ⇒ one gated `reverse_proxy ao:14800` block, no client
  patch, no extra TLS. Settled (still needs a live WS-upgrade test through caddy-security).
- ~~workspace expectation~~ — `worktree` (default) needs an `origin` clone at `path`; the
  wizard's clone provides it; leave `workspace` unset. No `workspace: clone` needed.
- ~~lifecycle-worker mechanics~~ — `ao lifecycle-worker <id>`, PID-guarded, detached,
  independent of the dashboard; `lastPoll` in-memory only.

**Still to pin at plan/verify time:**
- **State-dir volume (BLOCKER)** — must remount on `/root/.agent-orchestrator` and repoint
  `AO_CONFIG_PATH`/`GH_CONFIG_DIR`/projects/tokens there (revises M-A Dockerfile ENV +
  compose volume). Verify the M-A boot test still passes with the new path.
- **Worker restart-on-boot** — the M-A entrypoint must start `ao lifecycle-worker <id>` when
  a project already exists (PID is container-ephemeral; dies on recreate). Touches the shipped
  entrypoint — budget it.
- **WS-through-gate live test** — cookie-JWT on the `Upgrade: websocket` handshake through
  caddy-security; only testable once a session (hence a ttyd) exists.
- **`git push` credential helper** — `gh auth setup-git` at connect (or `GH_TOKEN` in the
  session env), else scm-github PR push can fail.
- **PAT at rest / SSO-authorized org repos** — `gh` stores the PAT plaintext on the volume
  (host-only, behind the gate; document it); surface a clear error if `gh repo list`/clone
  403s on an SSO-protected org.
- **Idempotency** — every endpoint safe to re-run; `apply` uses stop→ensure (not no-op) so a
  changed teamId/token actually takes effect.
