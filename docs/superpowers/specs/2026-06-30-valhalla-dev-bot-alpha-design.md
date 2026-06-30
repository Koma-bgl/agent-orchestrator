# valhalla-dev-bot (alpha) — Design & Plan

**Date:** 2026-06-30
**Status:** Design — pending live validation against the operator's GCP account
**Name:** `valhalla-dev-bot` · **Version:** alpha

## Purpose

One command to exercise the **complete *real* deploy flow locally** — reading the
operator's real secrets from their GCP project's Secret Manager — so they can see
the actual gated dashboard, real Google sign-in, and real agents **on their laptop,
before any VM and with no cloud spend.** It is the rehearsal of the eventual M8
setup skill and the proof that Phase 1 works end-to-end with production-shaped
credentials (not the dummy values used in the M1–M6 mechanics tier).

## What this is NOT (scope guard)

- Not the VM provisioner (that's M7).
- Not a secret *writer* — it **reads** existing secrets. It guides creation of any
  missing ones but does not own writing them (rotation stays in the M5 admin UI).
- Not a new auth model — it reuses the committed deploy kit (`deploy/`) verbatim.

## Credential model (the crux)

Two independent planes — they do not substitute for each other:

1. **Dashboard access (humans).** Google sign-in at the Caddy gate. A short-lived
   JWT cookie; **nothing stored** but the email allowlist. Who gets in = the
   **allowlist**, not Secret Manager IAM.
2. **Machine credentials (the daemon/agents).** The daemon runs autonomously 24/7
   with no human present, so it needs its own stored tokens. These live in
   **Secret Manager** and are **read** on boot.

### The five secrets (all read-only at runtime)

| Secret | Consumed by |
|---|---|
| `google-oauth-client` (id + secret) | Caddy — powers the sign-in gate |
| `jwt-shared-key` | Caddy — signs the session JWT |
| `dashboard-allowlist` | Caddy — permitted Google emails |
| `claude-oauth-token` | daemon/agents — Anthropic API |
| `github-pat` | daemon/agents — push, PRs, CI |

**Create-once, read-many.** The Google OAuth client is tied to the **domain +
project**, not a VM instance — recreate the box, it re-reads the same client. A new
client is only needed for a *separate* deployment on a *different* domain.

### The bootstrap credential (cannot live in Secret Manager)

The GCP identity that *reads* Secret Manager can't itself be stored there
(chicken-and-egg). It comes from the environment:

- **VM (Phase 2):** the attached **service account** (metadata token). Nothing stored.
- **Local (this skill):** resolved in order — `AO_GCP_ACCESS_TOKEN` → `GOOGLE_APPLICATION_CREDENTIALS` (a key file) → **ADC impersonating the SA** → plain ADC.

### Keyless SA use — what the skill embeds

- **Embed (identifiers, not secrets):** the SA **email** (e.g.
  `ao-deploy@valhalla.iam.gserviceaccount.com`) and the **project id**.
- **Never embed:** the SA key JSON, any token, any secret value.
- **Authenticate by impersonation:** the skill runs as the invoker's ADC and
  impersonates the SA (`--impersonate-service-account=<email>`) — keyless,
  short-lived tokens, and the *exact* identity the VM will use (true rehearsal).
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
2. **Check the five secrets exist** — `gcloud secrets describe` (or `versions
   access` dry probe) for each. Missing → stop with a per-secret message + the exact
   one-time create command (login-not-paste where possible), e.g.
   `gh auth token | gcloud secrets create github-pat --data-file=-`. **Read-only.**
3. **Fetch + materialize** — read the five via the resolved credential; write a
   **transient, gitignored `deploy/.env`** (values never leave the machine).
4. **Bring up + verify** — `docker compose up -d --build`; run the mechanics suite
   (healthy; `/` → 302 gated; `/api/v1/sessions`; spawn + SSE; Watchtower scheduled;
   `/admin/api/*` responds) and report pass/fail.
5. **Optional live tier** — offer to open `https://localhost:8443` for a *real*
   Google sign-in (real client + localhost redirect) → populated dashboard → a real
   agent session.
6. **Teardown** — `docker compose down` (keep or wipe state).

## Missing-secret guidance (one-time creation)

| Secret | Suggested create (login-not-paste) |
|---|---|
| `github-pat` | `gh auth login` then `gh auth token \| gcloud secrets create github-pat --data-file=-` |
| `claude-oauth-token` | `claude setup-token` → `gcloud secrets create claude-oauth-token --data-file=-` |
| `jwt-shared-key` | `openssl rand -hex 32 \| gcloud secrets create jwt-shared-key --data-file=-` |
| `dashboard-allowlist` | `printf '%s' you@org.com \| gcloud secrets create dashboard-allowlist --data-file=-` |
| `google-oauth-client` | Console-created OAuth Web client (id+secret); store as JSON/`id\|secret` — the one manual step |

## Verification (acceptance)

- Preflight resolves a GCP credential and the right project.
- All five secrets are found (or the operator is told exactly which to create).
- Stack comes up healthy; the full mechanics suite passes against **real** secrets.
- (Optional, operator-driven) a real Google sign-in reaches the populated dashboard.

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
