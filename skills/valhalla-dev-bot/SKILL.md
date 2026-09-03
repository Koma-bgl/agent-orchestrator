---
name: valhalla-dev-bot
description: Create and manage your own dev-bot on the GCP fleet — a Google-gated AO instance at <you>.binary-badger.xyz, provisioned with one command (DNS, TLS, and SSO all automated). Also runs a free local smoke-test of the same stack.
trigger: User wants to create / spin up / deploy / manage their dev bot, run valhalla-dev-bot, or locally test the AO self-host stack.
---

# valhalla-dev-bot

Provision and manage **your own dev-bot** on the shared GCP fleet: a Google-gated
Agent Orchestrator instance at **`https://<you>.binary-badger.xyz`**, created with
one command — the VM, per-bot DNS, Let's Encrypt cert, and single-sign-on are all
automated. Authentication is handled by the always-on fleet portal
(`auth.binary-badger.xyz`), so **no OAuth / Console steps are ever needed per bot**.

Two modes:

- **Fleet (default)** — create/manage a real bot on GCP. Costs money while the VM
  runs (~$0.15/hr for `e2-standard-4`); `destroy` stops it.
- **Local** — a free docker-compose smoke-test of the same stack on your laptop
  (its own localhost portal). Use it to rehearse or test changes before deploying.

Uses **your own `gcloud` creds**; embeds no secrets. Default project
`cloudbet-native` (override `--project=`).

## Credential model (read this first)

- **Fleet gate secrets (Secret Manager, shared):** `jwt-shared-key`,
  `dashboard-allowlist` (multi-email). The portal owns `google-oauth-client`. The
  VM's service account reads them on boot — you never handle them.
- **Agent creds (per-user, on the box, NEVER centralized):** GitHub + Claude. Set
  them by logging in _inside the running bot_ (SSH step below). The bot boots fine
  without them; it just can't do agent work until you log in.

---

## Mode 1 — Fleet: create & manage your bot (default)

Run from `deploy/`. Everything is `deploy-gcp.sh <cmd> [--project=<id>] [--index=N]`.

**Prerequisites (one-time, fleet-wide — normally already done):**

- `gcloud auth login` and a project selected.
- The fleet portal is deployed (`./deploy-portal.sh`) and `jwt-shared-key` +
  `dashboard-allowlist` exist in Secret Manager. If unsure, `./deploy-gcp.sh status`
  and a quick `gcloud secrets describe jwt-shared-key` confirm it.

**Create your bot:**

1. `./deploy-gcp.sh init` — one-time per user: reserves a static IP + SA/IAM/firewall.
2. `./deploy-gcp.sh create` — provisions the VM (quota-gated, **max 1/user** by
   default), creates the `<you>.binary-badger.xyz` A-record, fetches gate secrets via
   the SA, and brings the stack up. ~5–10 min (first build compiles Caddy on the VM).
   → prints your URL: `https://<you>.binary-badger.xyz`.
3. **Sign in (human):** open the URL → you're bounced to `auth.binary-badger.xyz` →
   sign in with an allowlisted Google account → you land back on your bot's dashboard.
   (Fleet SSO — no per-bot OAuth. `403` after login = your email isn't in
   `dashboard-allowlist`.)
4. **Agent auth (human, so agents can work)** — SSH in and log in on the box:
   ```
   gcloud compute ssh ao-<you> --zone=us-central1-a
   sudo docker compose -f /opt/ao/deploy/docker-compose.yml exec ao gh auth login
   sudo docker compose -f /opt/ao/deploy/docker-compose.yml exec ao claude setup-token
   ```
   (On-box by design; a VM recreate may drop these until config-dir persistence
   lands — just re-auth.)

**Manage:**

- `./deploy-gcp.sh status` — your bot's URL, VM state, quota usage.
- `./deploy-gcp.sh destroy` — deletes the VM **and its DNS record**; the reserved
  IP/SA/secrets persist so recreate is cheap. **Stops the billing.**
- Quota reached? The message names the admin to ask; more via `--index=N` if your
  quota allows.
- Admin (needs perms): `./deploy-gcp.sh admin-list` (all bots by owner) /
  `admin-audit` (authoritative creator log).

---

## Mode 2 — Local: free smoke-test

A docker-compose run of the same stack on `https://localhost:8443` with its **own**
localhost portal (independent of the fleet). Needs Docker running + the 3 gate
secrets readable (incl. `google-oauth-client` for the local portal).

```
node skills/valhalla-dev-bot/run.mjs preflight            # docker + gcloud creds
node skills/valhalla-dev-bot/run.mjs check --project=<id> # 3 gate secrets present?
node skills/valhalla-dev-bot/run.mjs up --project=<id>    # fetch secrets, compose up
node skills/valhalla-dev-bot/run.mjs verify              # gated 302s, healthz, oauth
# → open https://localhost:8443 (accept the internal-cert warning), sign in
node skills/valhalla-dev-bot/run.mjs down [--wipe]       # stop (and wipe volumes)
```

Local uses the localhost OAuth redirect (`https://localhost:8443/auth/oauth2/google/authorization-code-callback`) — a separate registered URI from the fleet portal's, left intact for local dev.

> **Allowlist caveat (local only):** local mode matches a **single** email
> (`ALLOWED_EMAIL_1` — the whole `dashboard-allowlist` secret stuffed into one
> match), _not_ the fleet's multi-email splat. If `dashboard-allowlist` holds
> several emails, local sign-in only works for a single-email secret; the fleet
> path handles the multi-email list correctly. (Aligning local with the fleet
> multi-email + shared portal is the M8c cleanup.)

---

## Notes

- Images are `linux/amd64` (the `ao` binary is x64-only) — native on the VM/CI,
  emulated on Apple Silicon locally (first build slow).
- Fleet DNS/TLS/SSO are fully automated (Cloud DNS zone `ao-fleet` +
  the Cloud Run portal). The **only** hard invariant: nothing untrusted may ever be
  hosted under `binary-badger.xyz` (the SSO cookie is domain-wide).
- Specs/plans: `docs/superpowers/specs/2026-07-03-m8a-auth-portal-design.md`,
  `docs/superpowers/plans/2026-06-30-m7-gcp-vm-single-bot.md`.
