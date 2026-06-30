---
name: valhalla-dev-bot
description: Stand up and verify the dockerized self-host AO deploy LOCALLY, reading real secrets from GCP Secret Manager — gated Google sign-in, monitoring dashboard, admin ops, self-update — with no VM. Alpha rehearsal of the cloud setup flow.
trigger: User wants to test the dockerized self-host deploy locally, run valhalla-dev-bot, or rehearse the deploy/sign-in flow before provisioning a VM.
---

# valhalla-dev-bot (alpha)

Brings up the committed deploy stack in `deploy/` (the AO Go daemon + Caddy auth
gate + Watchtower) on **localhost**, reading the real **gate secrets** from your
GCP Secret Manager, and verifies the whole chain — so you can exercise a real
gated sign-in and the dashboard **before** any VM. It's the local rehearsal of the
eventual cloud setup; see the design at
`docs/superpowers/specs/2026-06-30-valhalla-dev-bot-alpha-design.md`.

This skill embeds **no secrets** — only a GCP project (default `cloudbet-native`,
override with `--project=`). It uses **your own** `gcloud` credentials.

## Credential model (read this first)

Two planes, two homes — do not try to fetch agent creds from Secret Manager:

- **Gate secrets (shared, in Secret Manager)** — `google-oauth-client`
  (`CLIENT_ID|CLIENT_SECRET`), `jwt-shared-key`, `dashboard-allowlist`. The skill
  reads these and writes `deploy/.env` (gitignored).
- **Agent creds (per-user, on the box, NOT in Secret Manager)** — GitHub and
  Claude. Set them by logging in *inside the container* (see step 5). The daemon
  boots fine without them (it just can't do agent work until you log in).

## Run order

Run from the repo root.

1. **Preflight** — `node skills/valhalla-dev-bot/run.mjs preflight`
   Confirms docker is up, a GCP credential resolves, and echoes the project.
2. **Check secrets** — `node skills/valhalla-dev-bot/run.mjs check --project=<id>`
   Verifies the 3 gate secrets exist. If any are missing it prints the exact
   one-time `gcloud secrets create …` command (incl. the Console step for
   `google-oauth-client`). Create the missing ones, then re-run `check`.
3. **Up** — `node skills/valhalla-dev-bot/run.mjs up --project=<id>`
   Fetches the gate secrets, writes `deploy/.env`, `docker compose up -d --build`.
   (Prints only key lengths, never secret values.)
4. **Verify** — `node skills/valhalla-dev-bot/run.mjs verify`
   Pass/fail table: dashboard gated (302), admin gated (302), daemon `/healthz`,
   and a real (non-dummy) Google OAuth initiation. Exits non-zero on failure.
5. Report the verify table to the user, then offer the live tier below.

## Human-guided steps (the agent cannot do these)

- **Live sign-in:** open `https://localhost:8443` in a browser, accept Caddy's
  internal-cert warning, and sign in with an **allowlisted** Google account
  (whatever is in `dashboard-allowlist`). You land on the gated dashboard.
  - `redirect_uri_mismatch` → the OAuth client must register exactly
    `https://localhost:8443/auth/oauth2/google/authorization-code-callback`.
  - "Access blocked / test user" → the OAuth **consent screen** is in *Testing*
    (add the email as a test user) or *Internal* (same-Workspace only).
  - `403` after login → the email isn't in `dashboard-allowlist`.
- **On-box agent auth** (so agents can do real work):
  - `docker compose -f deploy/docker-compose.yml exec ao gh auth login`
  - `docker compose -f deploy/docker-compose.yml exec ao claude setup-token`
  - These persist on the box; agent creds are intentionally NOT centralized.
    (Note: until the M7 config-dir persistence wiring lands, a container recreate
    may drop these — re-auth if so.)

## Teardown

- `node skills/valhalla-dev-bot/run.mjs down` — stop, keep state.
- `node skills/valhalla-dev-bot/run.mjs down --wipe` — stop and wipe volumes.

## Notes / known wrinkles

- The image is `linux/amd64` (the `ao` binary is x64-only) — on Apple Silicon it
  runs under emulation; first build is slow.
- Reading secrets uses a file-redirect (shell `$(gcloud …)` capture was flaky).
- Scope: this is the **local** alpha. The VM, service-account impersonation, and
  the guided cloud setup are later milestones (M7/M8).
