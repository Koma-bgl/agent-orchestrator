# M8c — Bot Setup wizard (idle → working) — Design

> ⚠️ **SUPERSEDED (2026-07-03)** by
> [`2026-07-03-ts-ao-bot-swap-design.md`](2026-07-03-ts-ao-bot-swap-design.md).
> This spec targeted the **Go daemon** (`@aoagents/ao`, `ao project add`, no yaml),
> which has no Linear tracker/reactions. The fleet bot now runs the **TS AO**
> (`@composio/ao-cli`), where "setup the yaml" is a real `agent-orchestrator.yaml`.
> Kept for history; do not build against this.

**Date:** 2026-07-03
**Status:** Superseded
**Builds on:** M8a (fleet SSO, live-verified). Solves the gap surfaced on the live
bot: a freshly-created bot runs the daemon but has **no repo, no GitHub/Claude
auth, no registered project** → "No active sessions" forever.

## Problem

A fleet bot boots the daemon (gated, healthy) but is **idle** — nothing to work
on. Making it useful today requires manual SSH + `gh auth login` + clone +
`ao project add`. We want an **admin-UI wizard on the bot itself** that walks the
operator through onboarding a repo, entirely from the browser (the setup *state*
lives on the bot, so the UI that reads/writes it belongs on the bot).

## Goals

- From the bot's dashboard, a **Setup page** takes an idle bot to a working one:
  1. **Connect GitHub** (paste a PAT — device-flow "click" is a later upgrade)
  2. **Pick a repo** (listed via the token)
  3. **Clone it** into the bot's workspace + a **30-min auto-pull** to stay fresh
  4. **Register the project** with the daemon (`ao project add` — the "yaml")
  5. **Other tokens** (Claude, Linear) — paste, stored on-box
- The page is **stateful**: it reads real bot state (GitHub connected? repo cloned?
  project registered?) and shows each step done/pending.
- Agent creds live **on-box** (per the fleet model), **persisted** so they survive
  restarts/recreates.

## Non-Goals (later)

- **Device-flow "click" login** for GitHub/Claude (paste-a-PAT now; documented
  drop-in upgrade — the "Connect" button gains the device path without other rework).
- Multi-repo per bot (one repo per bot for now — matches the max-1 quota).
- Rich per-project config (reactions, tracker rules) — register with sane defaults;
  advanced knobs later.
- M8b provisioning broker (separate milestone).

## Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| Surface | **Admin-UI wizard** (Setup page in the bot dashboard) + admin-backend endpoints | Setup state lives on the bot; user picked UI over a laptop skill |
| GitHub auth | **Paste a PAT** (v1); device flow deferred | ~4× less build, no GitHub OAuth App to register; delivers the value (usable bot) now |
| Where creds live | **On-box** — `gh`/`claude` config dirs on the `/root/.ao` volume | Matches the fleet "agent creds are per-user, on-box, never centralized" model |
| Persistence (prereq) | `GH_CONFIG_DIR=/root/.ao/gh` via **Dockerfile `ENV`** (uniform across daemon/agents/admin, zero per-deploy wiring); `gh auth login --with-token --insecure-storage` so the PAT persists as plaintext `hosts.yml` on the volume (no keyring in the slim image — assert it). **Claude/Linear tokens persist via the daemon's project config** (`set-config --env`, stored in the daemon's on-box state on the volume), NOT a config dir. | So Connect-GitHub survives restart + Watchtower recreate; agent tokens ride the daemon's persisted project env |
| Repo location | Clone to `/root/.ao/projects/<repo>` (on the volume) | Survives restarts; `ao project add --path` points here |
| Auto-pull | Admin backend **30-min timer**; the load-bearing step is **`git -C <repo> fetch --prune origin`** (new session worktrees are cut from `origin/<branch>` — reviewer-confirmed — so freshness comes from the fetch, not the local checkout), then `--ff-only` update of the checked-out branch. Record `lastPull`/`lastError` in state. | Fetch feeds worktrees; a fetch failure (expired PAT) must be visible, not a silent stall |
| Project register | `ao project add --path <repo> --worker-agent claude-code` (confirm flags at plan time) | The Go daemon has no yaml; a project == a daemon registration |

## Architecture

Extends the co-located admin backend (`deploy/admin/server.mjs`) and the SPA
(`deploy/web/`). All endpoints are behind the fleet auth gate already.

### New admin endpoints (on-box actions in the `ao` container)
| Endpoint | Does |
|---|---|
| `GET /admin/api/setup` | The wizard's state: `{github:{connected,login}, repo:{name,path}|null, project:{registered,id}|null, autopull:{enabled,lastPull,lastError}, claude:bool, linear:bool}` — derive `github` from **`gh auth status`** (never read/echo `hosts.yml` or the token), project from the daemon's `GET /api/v1/projects`, and the rest from `/root/.ao/setup-state.json`. Surface **auto-pull last-run status/error** so a stalled pull (e.g. expired PAT) is visible, not silent. |
| `POST /admin/api/github/connect` | body `{pat}` → `gh auth login --with-token` (writes to `GH_CONFIG_DIR`) → verify `gh auth status`; never echo the PAT |
| `GET /admin/api/github/repos` | `gh repo list --json nameWithOwner,url,updatedAt` for the picker (paginate/search) |
| `POST /admin/api/project/setup` | body `{repo, autopull}` → clone to `/root/.ao/projects/<repo>` (skip if present), enable the auto-pull timer, `ao project add`, persist `setup-state.json` |
| `POST /admin/api/agent-token` | body `{which:"claude"\|"linear", value}` → store as a **project env var** via `ao project set-config --env KEY=VALUE` (the daemon forwards it into spawned sessions and persists it in its on-box state) — NOT a config-dir file, NOT Secret Manager. **Claude → `CLAUDE_CODE_OAUTH_TOKEN`** (the agent's actual auth is this env var, NOT a `CLAUDE_CONFIG_DIR` file — reviewer-confirmed); Linear → its confirmed env var (from the capabilities investigation). Never log the body. |

### The Setup page (SPA)
A dedicated **`/setup` view** (also answers the earlier "admin on its own page"
ask — move Version/Update there too, off the session list). A 5-step checklist,
each row showing state + its action:
1. **GitHub** — “Connected as `<login>`” or a PAT paste box + Connect.
2. **Repo** — the picked repo, or a searchable list (from `/github/repos`) + paste-URL fallback.
3. **Clone & auto-pull** — clone status + a 30-min-refresh toggle.
4. **Project** — “Registered as `<id>`” or an Add-project button.
5. **Tokens** — Claude / Linear connected badges + paste boxes.
Reads `GET /admin/api/setup` on load; each action re-fetches to update state.

### Prerequisite wiring (this milestone)
- **Dockerfile `ENV GH_CONFIG_DIR=/root/.ao/gh`** (reviewer's recommendation — set
  it in the image so the daemon, its spawned agents, and the admin backend all
  agree with zero per-deploy wiring; env → `entrypoint.sh` → both the exec'd daemon
  and the backgrounded admin backend). Create the dir on the volume at startup.
  (No `CLAUDE_CONFIG_DIR` needed for auth — the Claude token is an env var carried
  via project config, not a config-dir file.)
- `gh` writes the PAT plaintext to `$GH_CONFIG_DIR/hosts.yml` (no keyring in the
  slim image); use `--insecure-storage` explicitly so a future base-image change
  can't silently break volume persistence.
- `git` + `gh` already in the image and usable by the admin backend.

## Reconciliations (leftovers to fix here)
- **The M5 "Rotate credential" panel targets Secret Manager** (`claude-oauth-token`,
  `github-pat`, `linear-api-key`) — but the fleet model keeps agent creds **on-box**,
  so those Secret-Manager entries are unused by fleet bots. M8c should **repoint
  agent-cred handling to on-box** (the Setup page) and drop/relabel the old
  Secret-Manager rotation for agent creds (keep SM only for the gate secrets).
- **"Setup the yaml"** = `ao project add` (no yaml file in the Go daemon); the page
  exposes the common knob (worker agent) and defaults the rest.

## Risks / open questions
- **`ao project add` exact flags + whether it needs a remote/branch** — confirm
  against the daemon CLI/API at plan time (I saw `--path/--name/--worker-agent/
  --orchestrator-agent/--as-workspace`).
- **PAT SSO** — org/private repos with SSO need the PAT authorized for the org
  (a GitHub-side step); surface a clear error if `gh repo list`/clone 403s.
- **Auto-pull vs active worktrees** — pulling the default branch is safe; but if the
  base branch is checked out in the primary clone and a session shares it, prefer a
  bare/`--ff-only` pull. Pin the exact git strategy at plan time.
- **PAT at rest on-box** — `gh` stores it in its config dir on the volume (host-only
  to the bot, behind the gate). Acceptable per the on-box model; document it.
- **Idempotency** — every endpoint must be safe to re-run (re-connect, re-pick,
  re-clone, re-register) since the wizard is stateful and re-entrant.

## Verification
1. **Local (Mode-2 stack):** the Setup endpoints + page work against the local
   docker-compose bot — connect a PAT, list repos, clone a small test repo, register
   it, confirm `GET /api/v1/sessions`/`projects` reflects it. Persistence: restart the
   container → GitHub still connected (config-dir on the volume).
2. **Fleet (operator-run, VM):** on a fresh `create`d bot, walk the wizard in the
   browser end-to-end → the bot goes from "No active sessions / no project" to a
   registered repo an agent can spawn against; auto-pull refreshes on schedule.
