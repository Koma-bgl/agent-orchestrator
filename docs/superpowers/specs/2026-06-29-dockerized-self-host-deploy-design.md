# Dockerized Self-Host & Skill-Guided GCP Deploy — Design

**Date:** 2026-06-29
**Status:** Approved for spec review
**Author:** brainstorming session (Koma + Claude)

## Problem

Agent Orchestrator (AO) today is installed via npm and run with `ao start` on a
machine the operator manages by hand (the current production box uses SSH +
`git checkout` + `pnpm build` + `pm2`). There is no turnkey way for a
**non-technical user** to stand up their own always-on AO instance.

We want a **skill** that hand-holds a non-technical user through:

1. Gathering the credentials AO needs (Claude, GitHub, Linear).
2. Deploying AO as a container to a cloud VM.
3. Keeping that instance updated automatically as we ship new releases.

Plus a small **ops UI** to check status/version and rotate tokens after deploy.

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
| Packaging | Single AO container + Caddy + Watchtower (docker compose) | Matches AO's single-process tmux/worktree model |
| Self-update | **Watchtower on a midnight cron** (`--schedule "0 0 0 * * *"` — Watchtower's 6-field cron: `sec min hr dom mon dow`, i.e. 00:00:00 daily), pinned to `:stable` | Zero custom code, predictable, no daytime surprises |
| Agent auth | **Claude OAuth token** via `claude setup-token` (`CLAUDE_CODE_OAUTH_TOKEN`) | Headless-friendly, uses the user's subscription, no device-code dance |
| Deploy structure | **Approach B** — committed deploy kit + thin skill wrapper; image built in CI → `ghcr.io` | Idempotent, reviewable, version-controlled, keeps skill thin |
| Ops UI | New `/admin` route in the existing Next.js dashboard | Reuses server, design tokens, API-route pattern; one port to secure |
| Access control | **App-level Google sign-in + email allowlist; zero passwords stored** | User explicitly wants to avoid storing/rotating passwords |
| Domain/TLS | **Bring a domain + Caddy auto-TLS (Let's Encrypt)** | Google OAuth rejects bare IPs; needs a real domain over HTTPS |
| VM size | `e2-standard-4` default (~$105/mo all-in), `e2-standard-2` budget (~$50/mo) | Builds/tests are RAM-hungry; Claude Code itself is light |

## Architecture

### Compose stack (3 services)

```
docker-compose.yml
├── ao         # the AO container: Node 20 + pnpm + tmux + git + gh + claude CLI + ao CLI + Next.js dashboard
│              # runs `ao start`; agents run as tmux sessions + git worktrees INSIDE the container
│              # volume: ~/.agent-orchestrator  (sessions, worktrees, config) -> survives image swaps
├── caddy      # terminates HTTPS (Let's Encrypt for the user's domain), reverse-proxies to the ao web app
└── watchtower # polls the registry on a midnight cron, pulls :stable, restarts ao, prunes old image
```

- **Single AO container.** Agents (Claude Code etc.) run inside it via the
  existing tmux runtime + git worktrees — no change to AO's execution model.
- **State on a mounted volume** (`~/.agent-orchestrator`). Midnight image swaps
  and restarts never lose sessions or PR-tracking metadata.
- **Image** is multi-stage, built in CI on release, pushed to
  `ghcr.io/composiohq/agent-orchestrator` with `:stable` + version tags.
  Watchtower watches `:stable`.

### Secrets & runtime credential flow

Secrets live in **Google Secret Manager**, never baked into the image:

- `claude-oauth-token` — `CLAUDE_CODE_OAUTH_TOKEN`
- `github-pat` — `GH_TOKEN` (`repo` + `workflow` scopes)
- `linear-api-key` — `LINEAR_API_KEY` (only if Linear tracker is used)
- `google-oauth-client` — OAuth client id + secret for dashboard sign-in
- `dashboard-allowlist` — newline/comma list of permitted Google emails

The container **entrypoint fetches these at startup** and exports them as env
for AO + spawned agents. Two credential sources, same code path:

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

- **Caddy** auto-provisions a Let's Encrypt cert for the user's domain (one
  DNS A-record → the VM's static IP) and reverse-proxies to the Next.js app.
  **Local mode (Phase 1): plain `http://localhost`** — Google OAuth permits
  `http://localhost` redirects, so no local cert is needed; real TLS is first
  exercised in M6. (Pin this single local mode at plan time; do not leave a
  self-signed-vs-http fork.)
- **App-level Google sign-in.** A lightweight Google OAuth 2.0 code flow
  (hand-rolled or Auth.js — decided at plan time, no new *UI* libs either way)
  gates the entire dashboard. Only emails on the allowlist receive a session
  cookie. **No passwords stored.** Adding/removing a user = editing the
  allowlist (from `/admin`), not provisioning credentials.
- OAuth redirect URI is the user's domain over HTTPS (Phase 2) or `localhost`
  (Phase 1) — both are accepted by Google; bare IPs are not.

### `/admin` ops UI

New route in `packages/web/src/app` reusing existing design tokens + API-route
pattern (builds on existing `api/version` and `api/update` routes):

| Panel | Content | Backing API |
|---|---|---|
| Status | container up, agent count, AO health | new `api/admin/status` |
| Version | running AO version vs latest `:stable` in registry → "up to date" / "update pending (applies tonight)" + **Update now** | extend existing `api/version` (confirm shape at plan time); `api/admin/update-now` |
| Tokens | paste new Claude OAuth / GitHub PAT / Linear key → writes a new Secret Manager version → optional immediate restart | new `api/admin/secrets` |
| Access | add/remove allowlisted Google emails | new `api/admin/allowlist` |

All `/admin` APIs require an authenticated, allowlisted session.

### Deploy kit (committed to repo)

```
deploy/
├── Dockerfile              # multi-stage AO image
├── docker-compose.yml      # ao + caddy + watchtower
├── Caddyfile               # domain -> reverse proxy, auto-TLS
├── entrypoint.sh           # fetch secrets (SA metadata OR ADC OR .env) -> export env -> ao start
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
| M1 | 1 (local) | Dockerfile + compose; AO runs in-container; CI publishes image to ghcr | `docker compose up` → dashboard reachable, an agent spawns |
| M2 | 1 (local) | Secret-fetch entrypoint via ADC + `.env` fallback | container boots with secrets from Secret Manager using local ADC |
| M3 | 1 (local) | Caddy + Google sign-in + email allowlist (localhost redirect) | only allowlisted Google account can load the dashboard |
| M4 | 1 (local) | `/admin` UI: status / version / token rotation / allowlist | rotate a secret version from UI; "update pending" reflects a pushed tag |
| M5 | 1 (local) | Watchtower midnight self-update | push a new `:stable` → container swaps on schedule / forced run |
| M6 | 2 (cloud) | `deploy-gcp.sh` + startup script + metadata SA + real domain TLS | **deferred** — run only after Phase 1 is solid |
| M7 | 2 (cloud) | The setup skill tying it all together | non-tech user dry-run from zero |

## Risks & Open Questions

- **`claude setup-token` lifetime** — long-lived but not infinite. The `/admin`
  token-update flow is the escape hatch when it expires. Monitor for expiry UX.
- **Caddy TLS can't be fully tested locally** — Let's Encrypt needs a public
  domain. Phase 1 uses self-signed/localhost; real TLS is first exercised in M6.
- **Secret rotation write scope** — granting the container `secretVersionAdder`
  means the box can rewrite its own creds. Acceptable for single-tenant
  self-host; document the trust boundary.
- **Image build in CI** — the public repo creates GitHub releases; npm publish
  is a private cron. Decide at plan time whether image build/push lives in the
  release workflow or a dedicated `image.yml` triggered on release tag.
- **OAuth library choice** — hand-rolled flow (~100 lines, zero deps) vs Auth.js.
  Resolve in the implementation plan; neither adds a *UI* component library.
- **Resource sizing** — several parallel agents may exceed 16 GB; machine type
  is a skill prompt so the user can size up.

## Cost (reference)

`e2-standard-4` (4 vCPU / 16 GB), us-central1, 24/7:
- On-demand all-in ≈ **$105/mo** (E2 has no sustained-use discount).
- 1-year committed use ≈ **$70/mo**.
- Budget `e2-standard-2` (2 vCPU / 8 GB) ≈ **$50/mo all-in**.
- Spot (~$29/mo) rejected — preemption is unsafe for a mid-PR orchestrator.
