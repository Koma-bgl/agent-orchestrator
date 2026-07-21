# Dockerized Self-Host & Skill-Guided GCP Deploy — Design

**Date:** 2026-06-29
**Status:** Revised for Go-daemon architecture (re-review pending)
**Author:** brainstorming session (Koma + Claude)

> **Architecture note (2026-06-29 revision):** the upstream rewrite ships AO as a
> **headless Go daemon** (`ao daemon`), distributed as a prebuilt binary, with the
> desktop UI moved into Electron. This replaces the earlier Node/pnpm-monorepo +
> Next.js dashboard assumption. The daemon binds **loopback only with zero auth**,
> which makes Caddy's Google sign-in load-bearing security, and removes the
> baked-config / git-repo-guard problem entirely. The design below reflects this.

## Problem

Agent Orchestrator (AO) ships as a **headless Go daemon** (`ao daemon`) plus an
Electron desktop app. The daemon is the engine: it spawns coding agents in tmux
sessions + git worktrees and exposes a loopback HTTP API. There is no turnkey way
for a **non-technical user** to stand up their own always-on, *remotely accessible*
AO instance — the desktop app assumes a local machine with a display.

We want a **skill** that hand-holds a non-technical user through:

1. Gathering the credentials AO needs (Claude, GitHub, Linear).
2. Deploying the AO daemon as a container to a cloud VM, reachable over the web.
3. Keeping that instance updated automatically as we ship new releases.

Plus a small **monitoring web UI** (the daemon has no built-in remote UI) to watch
sessions/status, check version, and rotate tokens after deploy.

## Goals

- A non-technical user can go from zero to a running, authenticated, HTTPS AO
  instance by following a guided skill conversation.
- The deployed instance **updates itself nightly** with no user action.
- The user can check status, see version / pending updates, rotate credentials,
  and manage who can access the box — from a web UI.
- **No passwords are stored anywhere.** Identity is delegated to Google.
- The whole stack is **testable locally** (`docker compose up`) before any cloud
  VM is created.

## Non-Goals

- Multi-VM / fleet orchestration, autoscaling, or HA. One box, one operator org.
- Supporting cloud providers other than GCP in this iteration.
- Terraform / declarative IaC (revisit only if fleet-scale becomes a need).
- Replacing the existing session-supervision dashboard — the ops UI is additive.

## Key Decisions (resolved during brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Audience | Skill-guided self-host for non-technical users | The skill is the product; Docker is the vehicle |
| Cloud | GCP — GCE VM via `gcloud`, secrets in Secret Manager | User's chosen platform |
| Engine | **`ao daemon`** — the headless Go daemon (not `ao start`, which launches Electron) | The only headless entry point; no display required |
| Binary | **`npm i -g @aoagents/ao`** pulls the platform Go binary (`@aoagents/ao-linux-x64`) | One install line; no monorepo/pnpm/node-pty build |
| Packaging | AO daemon container + Caddy + Watchtower (docker compose) | Matches the daemon's single-process tmux/worktree model |
| Self-update | **Watchtower on a midnight cron** (`--schedule "0 0 0 * * *"` — Watchtower's 6-field cron: `sec min hr dom mon dow`, i.e. 00:00:00 daily), pinned to `:stable` | Zero custom code, predictable, no daytime surprises |
| Agent auth | **Claude OAuth token** via `claude setup-token` (`CLAUDE_CODE_OAUTH_TOKEN`), inherited by agents from the daemon env | Headless-friendly, uses the user's subscription, no device-code dance |
| Deploy structure | **Approach B** — committed deploy kit + thin skill wrapper; image built in CI → `ghcr.io` | Idempotent, reviewable, version-controlled, keeps skill thin |
| Remote UI | **New standalone monitoring SPA** built on the daemon's `/api/v1` + SSE; the daemon ships no remote web UI | Read-only monitoring + admin; the real net-new build |
| Access control | **Caddy-level Google sign-in + email allowlist; zero passwords stored** — load-bearing, since the daemon itself has no auth | Daemon trusts loopback fully; the edge is the only security boundary |
| Domain/TLS | **Bring a domain + Caddy auto-TLS (Let's Encrypt)** | Google OAuth rejects bare IPs; needs a real domain over HTTPS |
| VM size | `e2-standard-4` default (~$105/mo all-in), `e2-standard-2` budget (~$50/mo) | Builds/tests are RAM-hungry; Claude Code itself is light |

## Architecture

### Compose stack (3 services)

```
docker-compose.yml
├── ao         # ONE container running TWO processes (tini-supervised):
│              #   - `ao daemon`  -> headless Go daemon, binds 127.0.0.1:3001 (zero auth)
│              #   - web backend  -> Google OAuth gate + daemon API proxy + admin ops, binds 0.0.0.0:8080
│              # also: ao Go binary + tmux + git + gh + claude CLI; agents run as
│              # tmux sessions + git worktrees INSIDE this container
│              # volume: /root/.ao (AO_DATA_DIR: SQLite store, worktrees) -> survives image swaps
│              # exposes :8080 to the compose network only; healthcheck: GET /healthz
├── caddy      # terminates HTTPS (Let's Encrypt for the user's domain); serves the SPA;
│              # enforces Google sign-in; reverse-proxies to ao:8080; publishes :80 + :443 only
└── watchtower # polls the registry on a midnight cron, pulls :stable, recreates ao, prunes old images
```

- **Daemon + web backend co-located in one container (default).** The daemon
  binds `127.0.0.1` with **no `AO_HOST` override**, so anything talking to it must
  share its network namespace. Co-locating the small web backend in the same
  container is the simplest way to get `127.0.0.1:3001` reachability — and it
  avoids the Watchtower-recreate fragility of a separate namespace-sharing
  container (see Risks). A minimal init (`tini`) supervises both processes so
  signals and zombie-reaping are correct; the daemon is the primary process.
  (A separate `web` container via `network_mode: "service:ao"` remains a valid
  alternative, but is **not** the default precisely because Watchtower *recreates*
  `ao` — destroying the namespace the sidecar is bound to.)
- **Daemon is fully headless** — no Electron, no display. Agents (Claude Code
  etc.) run via the daemon's tmux runtime + git worktrees. It has **zero auth** —
  every loopback caller is trusted, which is why Caddy is the sole security gate.
- **No config file / git-repo guard.** The Go daemon's `config.Load()` reads only
  env vars (with defaults) — it never consults a YAML config or requires a git
  repo to start. It boots clean with zero projects; projects are registered on
  demand via `ao project add <path>` or `POST /api/v1/projects`. The image needs
  no config and no sample repo to boot.
- **State on a mounted volume** (`AO_DATA_DIR=/root/.ao`). Midnight image swaps
  and restarts never lose sessions, worktrees, or PR-tracking state (SQLite).
- **Only Caddy is published** (`:80` for the Let's Encrypt HTTP-01 challenge +
  HTTP→HTTPS redirect, `:443` for traffic). The daemon's `3001` and the web
  backend's `:8080` are never published to the host — release-blocking invariant.
- **Image** is built in CI on release, pushed to
  `ghcr.io/composiohq/agent-orchestrator` with `:stable` + version tags.
  Watchtower watches `:stable`.

### Secrets & runtime credential flow

Secrets live in **Google Secret Manager**, never baked into the image:

- `claude-oauth-token` — `CLAUDE_CODE_OAUTH_TOKEN` (inherited by spawned agents)
- `github-pat` — `GITHUB_TOKEN` (`repo` + `workflow` scopes; the daemon's SCM
  observer reads `AO_GITHUB_TOKEN`/`GITHUB_TOKEN`, and `gh` reads `GITHUB_TOKEN` —
  setting `GITHUB_TOKEN` covers both)
- `linear-api-key` — Linear tracker key (env var name to confirm at plan time
  against the Go tracker adapter)
- `google-oauth-client` — OAuth client id + secret for the web UI sign-in
- `dashboard-allowlist` — newline/comma list of permitted Google emails

The daemon container **entrypoint fetches these at startup** and exports them as
env for `ao daemon` + spawned agents (the daemon forwards its env to agents). Two
credential sources, same code path:

- **On the VM (Phase 2):** the VM's attached **service account** (metadata
  token) → Secret Manager. SA roles: `secretmanager.secretAccessor` (read) +
  `secretmanager.secretVersionAdder` (write, for UI rotation).
- **Locally (Phase 1):** **Application Default Credentials** (`gcloud auth
  application-default login`) → same Secret Manager API. This proves the
  secret-fetch path without a VM. A pure-offline `.env` fallback also works.

Because Watchtower restarts the container nightly, **rotation is automatic**: a
new secret version is picked up on the next restart, and the `/admin` UI can
force an immediate restart for "apply now".

### Domain, TLS & access control

- **Caddy is the only security boundary.** The daemon has zero auth, so Caddy
  (or its forward-auth helper) must authenticate every request before it reaches
  the web backend / daemon. It auto-provisions a Let's Encrypt cert for the
  user's domain (one DNS A-record → the VM's static IP).
  **Local mode (Phase 1): plain `http://localhost`** — Google OAuth permits
  `http://localhost` redirects, so no local cert is needed; real TLS is first
  exercised in M6. (Pin this single local mode at plan time; do not leave a
  self-signed-vs-http fork.)
- **Google sign-in.** A Google OAuth 2.0 code flow (in the web backend, or a
  Caddy `forward_auth` helper — decided at plan time) gates the entire UI and the
  proxied daemon API. Only emails on the allowlist receive a session cookie.
  **No passwords stored.** Adding/removing a user = editing the allowlist (from
  the UI), not provisioning credentials.
- OAuth redirect URI is the user's domain over HTTPS (Phase 2) or `localhost`
  (Phase 1) — both are accepted by Google; bare IPs are not.

### Monitoring web UI

A **new standalone SPA + small backend** (the daemon ships no remote web UI). The
SPA is read-only monitoring over the daemon's documented API; the backend adds the
auth gate, a daemon-API proxy, and the admin operations that act on *our* infra
(Secret Manager, Watchtower, allowlist) rather than the daemon.

Read-only monitoring is built on the daemon's existing endpoints:
- `GET /api/v1/sessions`, `GET /api/v1/sessions/{id}` — sessions + derived status
- `GET /api/v1/projects` — registered projects
- `GET /api/v1/sessions/{id}/pr` — PR facts (read path only; PR *action*
  endpoints are a 501 stub in this build — don't plan admin PR-actions on them)
- `GET /api/v1/events` (SSE) — live change stream for the UI
- `GET /api/v1/notifications`, `/api/v1/notifications/stream` — needs-input /
  ready-to-merge (these are under `/api/v1`, **not** root `/notifications`)
- `GET /healthz`, `/readyz` — health (at root); `GET /api/v1/openapi.yaml` — the contract

| Panel | Content | Backing API |
|---|---|---|
| Sessions | live session list + derived status (working / needs_input / ci_failed / mergeable …), via SSE | daemon `GET /api/v1/sessions` + `/api/v1/events` |
| Status | daemon health, agent/session counts | daemon `/healthz` + `/api/v1/sessions` |
| Version | running AO version vs latest `:stable` in registry → "up to date" / "update pending (applies tonight)" + **Update now** | web backend `api/admin/version` + `api/admin/update-now` |
| Tokens | paste new Claude OAuth / GitHub PAT / Linear key → writes a new Secret Manager version → optional immediate restart | web backend `api/admin/secrets` |
| Access | add/remove allowlisted Google emails | web backend `api/admin/allowlist` |

The monitoring panels proxy the daemon; the admin panels (version/update, tokens,
access) are web-backend operations on the deployment infra. All require an
authenticated, allowlisted session.

### Deploy kit (committed to repo)

```
deploy/
├── Dockerfile              # image: slim base + npm i -g @aoagents/ao + tmux/git/gh/claude + web backend + tini
├── docker-compose.yml      # ao (daemon + web backend, one container) + caddy + watchtower
├── Caddyfile               # domain -> Google auth -> reverse proxy to ao:8080, auto-TLS
├── entrypoint.sh           # fetch secrets (SA metadata OR ADC OR .env) -> export env -> tini: web backend + ao daemon
├── secret-resolver.mjs     # resolve secrets from GCP Secret Manager or .env (shared, testable)
├── web/                    # the monitoring SPA + backend (auth gate, daemon proxy, admin ops); built into the image
├── startup-script.sh       # GCE startup: install Docker + compose, pull repo deploy/, compose up
└── deploy-gcp.sh           # idempotent: enable APIs, create SA + roles, write secrets,
                            #   reserve static IP, create VM w/ startup script, open 80/443, print IP
```

### The setup skill

A guided conversation under `skills/` that:

1. Checks prereqs — `gcloud` authed, project selected, `docker` available.
2. Walks the user through obtaining each credential with copy-paste steps:
   - Linear: Settings → API → personal key
   - GitHub: PAT page with `repo` + `workflow` scopes
   - Claude: run `claude setup-token` locally, paste the token
   - Google: create an OAuth client (console walkthrough), paste id/secret
3. Collects the domain + allowlist emails + machine type (default
   `e2-standard-4`, budget `e2-standard-2`).
4. Writes all secrets to Secret Manager, runs `deploy-gcp.sh`, then tells the
   user the **one DNS A-record** to set and waits for TLS to come up.
5. Offers re-run / update / teardown paths.

## Build Sequence

Phase 1 is fully testable on a laptop with `docker compose up`. Phase 2 (actual
VM creation) is deferred until the local stack is validated.

| Milestone | Phase | Deliverable | How it's verified |
|---|---|---|---|
| M1 | 1 (local) | Dockerfile (binary install) + compose; `ao daemon` runs headless in-container; CI publishes image to ghcr | `docker compose up` → `/healthz` 200, `GET /api/v1/sessions` returns |
| M2 | 1 (local) | Secret-fetch entrypoint via ADC + `.env` fallback → daemon env | container boots with secrets from Secret Manager using local ADC |
| M3 | 1 (local) | Caddy + Google sign-in + email allowlist (localhost redirect) | only allowlisted Google account can reach the UI / proxied daemon API |
| M4 | 1 (local) | Monitoring SPA: live sessions + status over `/api/v1` + SSE | spawn a session → it appears live in the UI with correct derived status |
| M5 | 1 (local) | Admin ops: version / token rotation / allowlist | rotate a secret version from UI; "update pending" reflects a pushed tag |
| M6 | 1 (local) | Watchtower midnight self-update | push a new `:stable` → containers swap on schedule / forced run |
| M7 | 2 (cloud) | `deploy-gcp.sh` + startup script + metadata SA + real domain TLS | **deferred** — run only after Phase 1 is solid |
| M8 | 2 (cloud) | The setup skill tying it all together | non-tech user dry-run from zero |

## Risks & Open Questions

- **Daemon zero-auth is a hard dependency on Caddy.** The daemon trusts every
  loopback caller and offers no auth/CORS/TLS. If the daemon's port or the web
  backend's port is ever published to the host/internet without the auth layer in
  front, it's a wide-open RCE surface (it spawns agents with the user's creds).
  The compose file must publish **only** Caddy's `:80` (ACME challenge + redirect)
  and `:443`; the daemon's `3001` and the web backend's `:8080` stay internal.
  Treat this as a release-blocking invariant.
- **Loopback bind → co-location (resolved).** Because the daemon binds
  `127.0.0.1` with no `AO_HOST` override, the web backend is **co-located in the
  daemon's container** (default). The rejected alternative — a separate container
  with `network_mode: "service:ao"` — is fragile under Watchtower: Watchtower
  *recreates* the `ao` container with the new image, destroying its network
  namespace; a namespace-sharing sidecar is bound to the *old* namespace and will
  not auto-follow, so it must be recreated after `ao` (ordering dependency) and
  fails to start if `ao` isn't up yet. Co-location sidesteps this entirely.
- **Binary via npm + hook PATH naming.** The daemon pins its own binary dir on
  agent PATH so agents can call `ao hooks …`; this requires the on-PATH binary to
  be named `ao`. Confirm `npm i -g @aoagents/ao` yields an `ao` on PATH that the
  daemon resolves correctly (the npm shim execs the platform binary); pin the
  version to match `:stable`.
- **Linear may not be wired in this Go build.** The GitHub token env is confirmed
  (`AO_GITHUB_TOKEN`/`GITHUB_TOKEN`), but the Go code currently has **only a
  GitHub tracker/SCM adapter** — there is no Linear credential path yet. Before
  the skill's credential walkthrough promises Linear, the plan must verify
  whether Linear is even available in this build; if not, drop it from the
  credential set for now.
- **`claude setup-token` lifetime** — long-lived but not infinite. The admin
  token-update flow is the escape hatch when it expires. Monitor for expiry UX.
- **Caddy TLS can't be fully tested locally** — Let's Encrypt needs a public
  domain. Phase 1 uses localhost http; real TLS is first exercised in M7.
- **Secret rotation write scope** — granting the container `secretVersionAdder`
  means the box can rewrite its own creds. Acceptable for single-tenant
  self-host; document the trust boundary.
- **Image build in CI** — the public repo creates GitHub releases; npm publish
  is a private cron. Decide at plan time whether image build/push lives in the
  release workflow or a dedicated `image.yml` triggered on release tag.
- **Auth placement** — Google OAuth in the web backend vs a Caddy `forward_auth`
  helper. Resolve in the implementation plan.
- **Resource sizing** — several parallel agents may exceed 16 GB; machine type
  is a skill prompt so the user can size up.

## Cost (reference)

`e2-standard-4` (4 vCPU / 16 GB), us-central1, 24/7:
- On-demand all-in ≈ **$105/mo** (E2 has no sustained-use discount).
- 1-year committed use ≈ **$70/mo**.
- Budget `e2-standard-2` (2 vCPU / 8 GB) ≈ **$50/mo all-in**.
- Spot (~$29/mo) rejected — preemption is unsafe for a mid-PR orchestrator.
