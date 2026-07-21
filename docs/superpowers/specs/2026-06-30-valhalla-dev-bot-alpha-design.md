# valhalla-dev-bot (alpha) — Design & Plan

**Date:** 2026-06-30
**Status:** Design — pending live validation against the operator's GCP account
**Name:** `valhalla-dev-bot` · **Version:** alpha

## Purpose

One command to exercise the **complete _real_ deploy flow locally** — reading the
operator's real secrets from their GCP project's Secret Manager — so they can see
the actual gated dashboard, real Google sign-in, and real agents **on their laptop,
before any VM and with no cloud spend.** It is the rehearsal of the eventual M8
setup skill and the proof that Phase 1 works end-to-end with production-shaped
credentials (not the dummy values used in the M1–M6 mechanics tier).

## What this is NOT (scope guard)

- Not the VM provisioner (that's M7).
- Not a secret _writer_ — it **reads** existing secrets. It guides creation of any
  missing ones but does not own writing them (rotation stays in the M5 admin UI).
- Not a new auth model — it reuses the committed deploy kit (`deploy/`) verbatim.

## Credential model (the crux)

Two independent planes, stored in **two different places** by design:

1. **Dashboard access (humans).** Google sign-in at the Caddy gate. A short-lived
   JWT cookie; **nothing stored** but the email allowlist. Who gets in = the
   **allowlist**, not Secret Manager IAM.
2. **Agent identity (per-user, per-box).** The GitHub/Claude credentials the agents
   act under are **not** centralized in Secret Manager — they are **per-user and
   per-VM**, established by the operator logging in **on the box itself** and stored
   in the box's own persisted volume.

### Secret Manager holds only the THREE shared gate secrets

| Secret                              | Consumed by                     |
| ----------------------------------- | ------------------------------- |
| `google-oauth-client` (id + secret) | Caddy — powers the sign-in gate |
| `jwt-shared-key`                    | Caddy — signs the session JWT   |
| `dashboard-allowlist`               | Caddy — permitted Google emails |

These are **deployment-level, shared, create-once-read-many**. The Google OAuth
client is tied to the **domain + project**, not a VM instance — recreate the box, it
re-reads the same client. A new client is only needed for a _separate_ deployment on
a _different_ domain.

### Agent credentials live on the box, NOT in Secret Manager

GitHub and Claude tokens are per-user identity creds; centralizing powerful tokens
gives them a needless blast radius. Instead:

- The operator logs in **on the box**: `docker compose exec ao gh auth login` and
  `claude setup-token` (or via the M5 admin "connect" flow). `gh` and `claude` use
  their own on-disk credential storage.
- AO's agents inherit that login state directly — **no `GITHUB_TOKEN` /
  `CLAUDE_CODE_OAUTH_TOKEN` injected from Secret Manager.** The secret resolver
  drops both.
- This also **resolves the PAT/SSO question** — a normal interactive `gh` login
  inherits the operator's SSO automatically; no PAT or org-approval dance.

**Required wiring (persistence):** so the logins survive Watchtower recreates, the
CLI config dirs must live on the persisted volume — e.g. `GH_CONFIG_DIR=/root/.ao/gh`
and `CLAUDE_CONFIG_DIR=/root/.ao/claude` (only `/root/.ao` is volume-backed today).
Without this, a nightly update wipes the login. **This is a deploy-kit change to
make in M7** (not yet implemented).

### The bootstrap credential (cannot live in Secret Manager)

The GCP identity that _reads_ Secret Manager can't itself be stored there
(chicken-and-egg). It comes from the environment:

- **VM (Phase 2):** the attached **service account** (metadata token). Nothing stored.
- **Local (this skill):** resolved in order — `AO_GCP_ACCESS_TOKEN` → `GOOGLE_APPLICATION_CREDENTIALS` (a key file) → **ADC impersonating the SA** → plain ADC.

### Keyless SA use — what the skill embeds

- **Embed (identifiers, not secrets):** the SA **email** (e.g.
  `ao-deploy@valhalla.iam.gserviceaccount.com`) and the **project id**.
- **Never embed:** the SA key JSON, any token, any secret value.
- **Authenticate by impersonation:** the skill runs as the invoker's ADC and
  impersonates the SA (`--impersonate-service-account=<email>`) — keyless,
  short-lived tokens, and the _exact_ identity the VM will use (true rehearsal).
  The ability to impersonate is governed by `roles/iam.serviceAccountTokenCreator`
  on the SA — so the skill is safe to share; GCP IAM gates who can actually use it.

### IAM — secure default

- Grant `roles/secretmanager.secretAccessor` **only** to the deployment SA + the
  operator — **not** the org/domain. Then a shared org project does not leak the
  values (other members get permission-denied on the payload).
- Org membership / `Viewer` does **not** grant secret-payload reads; `secretAccessor`
  (or Owner) is required. Teammates use the product via the **allowlist**, never by
  reading secrets.
- The skill's preflight can warn if the secrets are world/org-readable.

## Flow when invoked

1. **Preflight** — confirm `docker` is running; resolve a usable GCP credential
   (token → key file → ADC+impersonation → ADC); confirm the project
   (`gcloud config get-value project`, echo it back).
2. **Check the three gate secrets exist** — `gcloud secrets describe` for
   `google-oauth-client`, `jwt-shared-key`, `dashboard-allowlist`. Missing → stop
   with a per-secret message + the exact one-time create command. **Read-only.**
3. **Fetch + materialize** — read the three via the resolved credential; write a
   **transient, gitignored `deploy/.env`** (values never leave the machine). Agent
   tokens are left unset — they're established on the box (step 5b).
4. **Bring up + verify** — `docker compose up -d --build`; run the mechanics suite
   (healthy; `/` → 302 gated; `/api/v1/sessions`; spawn + SSE; Watchtower scheduled;
   `/admin/api/*` responds) and report pass/fail.
5. **Optional live tier** — offer to open `https://localhost:8443` for a _real_
   Google sign-in (real client + localhost redirect) → populated dashboard.
   - **5b. On-box agent auth:** `docker compose exec ao gh auth login` and
     `claude setup-token` so agents can do real work — stored on the box's volume,
     not in Secret Manager.
6. **Teardown** — `docker compose down` (keep or wipe state).

## Missing-secret guidance (one-time creation — the 3 gate secrets only)

| Secret                | Suggested create                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| `jwt-shared-key`      | `openssl rand -hex 32 \| gcloud secrets create jwt-shared-key --data-file=-`                   |
| `dashboard-allowlist` | `printf '%s' you@org.com \| gcloud secrets create dashboard-allowlist --data-file=-`           |
| `google-oauth-client` | Console-created OAuth Web client (id+secret); store as JSON/`id\|secret` — the one manual step |

Agent creds (`github-pat`/`claude-oauth-token`) are **not** created here — they're
on-box auth (`gh auth login` / `claude setup-token`), see the credential model.

## Verification (acceptance)

- Preflight resolves a GCP credential and the right project.
- The three gate secrets are found (or the operator is told exactly which to create).
- Stack comes up healthy; the full mechanics suite passes against **real** secrets.
- (Optional, operator-driven) a real Google sign-in reaches the populated dashboard,
  and on-box `gh`/`claude` login lets an agent do real work.

## Deferred / out of scope

- VM provisioning + the SA + IAM bindings creation (M7).
- "Connect GitHub/Claude via login button" in the admin UI (M5 polish; paste exists).
- Allowlist editor + instant restart (post-Phase-1).

## Implementation note

The alpha can start as a **documented runbook + a thin wrapper script**
(`deploy/scripts/valhalla-dev-bot.mjs` or a skill `SKILL.md`) that performs the
flow above. First, validate the flow **manually against the operator's account**
(this session) — that live run is the real test and informs whether to harden it
into a packaged skill.
