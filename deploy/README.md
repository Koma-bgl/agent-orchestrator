# AO container — local run (M1–M4)

This directory packages the Agent Orchestrator **Go daemon** as a Docker image
you can run on your laptop with `docker compose up`. It boots `ao daemon`
headless, serves the REST API + `/healthz`, loads agent credentials at startup,
puts a Google sign-in + email-allowlist gate (Caddy) in front, and serves a live
monitoring dashboard — all with no cloud VM required.

> **Scope:** local run with the daemon (M1–M2), Caddy + Google sign-in (M3), and
> the monitoring dashboard (M4) all work here. Still later milestones: admin ops
> (M5), Watchtower self-update (M6), and GCP VM provisioning + the setup skill
> (M7–M8). Real public TLS arrives with the VM (M7); locally Caddy uses a
> self-signed internal cert.

## Prerequisites

- Docker + docker compose.
- (Optional, for the `gcp` secret source) the `gcloud` CLI, authenticated.

## Quick start (env source — default)

Paste your tokens into a local `.env` and run:

```bash
cp deploy/.env.example deploy/.env
# edit deploy/.env: set CLAUDE_CODE_OAUTH_TOKEN, GITHUB_TOKEN, (optional) LINEAR_API_KEY
cd deploy && docker compose up --build
```

The daemon binds `127.0.0.1:3001` inside the container, so it is **not**
reachable from the host. Verify it via `docker compose exec`:

```bash
docker compose exec ao curl -fsS http://127.0.0.1:3001/healthz
```

State persists in the `ao-state` volume (`/root/.ao`).

### How to get each token

| Token | How |
|-------|-----|
| `CLAUDE_CODE_OAUTH_TOKEN` | Run `claude setup-token` locally and paste the long-lived token |
| `GITHUB_TOKEN` | GitHub → Settings → Developer settings → Personal access tokens; scopes `repo` + `workflow` |
| `LINEAR_API_KEY` | Linear → Settings → API → Personal API key (not yet consumed by the Go build) |

## gcp source — validate Secret Manager without a VM

This exercises the same code path the GCE VM will use later, but authenticates
with a local access token instead of a VM service account.

```bash
# 1. Mint an access token on the host
export AO_GCP_ACCESS_TOKEN="$(gcloud auth print-access-token)"

# 2. Create the secrets (repeat for github-pat, linear-api-key)
printf %s "$CLAUDE_CODE_OAUTH_TOKEN" | gcloud secrets create claude-oauth-token \
  --data-file=- --project YOUR_PROJECT

# 3. Point deploy/.env at gcp
#    AO_SECRET_SOURCE=gcp
#    AO_GCP_PROJECT=YOUR_PROJECT

# 4. Run — the token is passed through to the container entrypoint
cd deploy && docker compose run --rm -e AO_GCP_ACCESS_TOKEN ao printenv GITHUB_TOKEN
```

Logs should show:

```
[entrypoint] secret source: gcp
[entrypoint] loaded claude-oauth-token -> CLAUDE_CODE_OAUTH_TOKEN
```

## Useful commands

```bash
# Liveness (run inside the container — the daemon is loopback-bound)
docker compose exec ao curl -fsS http://127.0.0.1:3001/healthz

# REST API
docker compose exec ao curl -fsS http://127.0.0.1:3001/api/v1/sessions

# Logs (entrypoint secret resolution)
docker compose logs ao | grep entrypoint

# Stop (keeps state volume)
docker compose down

# Reset everything including persisted state
docker compose down -v
```

## Notes

- The Go daemon boots clean with zero projects — no config file and no git-repo
  guard. Wiring your real project(s) comes with the Phase 2 setup skill.
- The entrypoint resolves and `exec`s the real platform binary so the Go daemon
  is PID 1 and handles `SIGTERM` gracefully (a fast `docker stop`, no SIGKILL).

## M3: authenticated access (Google sign-in, local)

The daemon has **zero auth** and binds loopback only. Caddy (custom image with the
`caddy-security` plugin) is the security boundary: it terminates TLS, runs a Google
sign-in portal, enforces an email allowlist, and reverse-proxies authenticated
traffic to the daemon (via a `socat` bridge inside the `ao` container). Only Caddy
is published; the daemon's `:3001` and the bridge's `:8080` stay on the compose
network.

You can exercise the whole flow locally at `https://localhost:8443` — Google
permits `localhost` redirect URIs, so no domain or public TLS is needed yet.

### 1. Create a Google OAuth client

In Google Cloud Console → APIs & Services → Credentials → **Create OAuth client ID**:

- Application type: **Web application**
- **Authorized redirect URI** (add this exact value):
  `https://localhost:8443/auth/oauth2/google/authorization-code-callback`
  (You can add your production URI to the same client later — Google allows
  multiple redirect URIs, so one client serves local + prod.)

Copy the generated **Client ID** and **Client secret**.

### 2. Fill `.env`

```bash
GOOGLE_CLIENT_ID=<your client id>
GOOGLE_CLIENT_SECRET=<your client secret>
JWT_SHARED_KEY=$(openssl rand -hex 32)   # paste the result
ALLOWED_EMAIL_1=you@gmail.com            # the Google account allowed to sign in
# AO_SITE_ADDRESS / AO_SITE_URL default to localhost:8443 — leave as-is for local
```

### 3. Run and sign in

```bash
docker compose up -d --build
# open https://localhost:8443 in a browser
```

- The browser will warn about Caddy's **self-signed (internal CA) cert** — expected
  locally; accept it. Real TLS arrives in the Phase 2 (VM) milestone.
- You'll be redirected to Google. Sign in with the **allowlisted** account → you
  land on the daemon API.
- A **non-allowlisted** Google account is denied (403), even after a successful
  Google login — the email allowlist is enforced by Caddy, not Google.

### Notes

- Adding/removing operators = editing the `ALLOWED_EMAIL_*` allowlist, not
  provisioning passwords. No passwords are stored anywhere.
- The session is a signed JWT cookie (`JWT_SHARED_KEY`); there is no server-side
  user database to persist.

## M4: monitoring dashboard

Once signed in (M3), `https://localhost:8443/` serves a live, read-only session
dashboard:

- Sessions grouped by project, each with a derived-status badge (working /
  needs_input / ci_failed / mergeable / merged …).
- Updates **live** via the daemon's SSE stream (`/api/v1/events`); the header
  shows a `live` / `reconnecting…` connection indicator, with a 15s polling
  fallback if the stream drops.
- It **observes** the daemon — it does not control it. Acting on sessions
  (version/update, token rotation, allowlist edits) comes with the M5 admin ops.

The dashboard is a single static file (`deploy/web/index.html`, no build step)
served by Caddy behind the same Google-auth gate; its `/api/v1/*` calls are
proxied to the daemon, so an unauthenticated visitor is bounced to sign-in before
ever loading it.

## M6: self-update (Watchtower)

A `watchtower` container keeps the stack current with no operator action:

- **Nightly (00:00)** it checks the registry; when a new `:stable` is published it
  pulls it, **recreates** the `ao`/`caddy` containers, and prunes the old image.
- It watches **only** the labelled `ao`/`caddy` containers and never updates itself.
- An **on-demand HTTP API** (token-guarded via `WATCHTOWER_TOKEN`, internal to the
  compose network — not published) is the hook M5's "update now" will call.

**Trust boundary:** Watchtower mounts the Docker socket (`/var/run/docker.sock`) —
required to recreate containers, and root-equivalent on the host. Acceptable for a
single-tenant self-host box; set a real `WATCHTOWER_TOKEN` on the VM since the API
triggers container recreation.

**Local note:** with locally-built `:dev` images (no registry) Watchtower has
nothing to pull — it runs but reports no updates. The real swap happens on the VM
where the images are `:stable` from ghcr (M7).

> `containrrr/watchtower` was archived upstream (Dec 2025); `1.7.1` is the final
> release — the pin is stable but unmaintained. Revisit a maintained fork if needed.

## M5: admin ops (version + token rotation)

Signed-in operators get an **Admin** section at the bottom of the dashboard,
backed by a small Node service co-located in the `ao` container (Caddy proxies
`/admin/api/*` to it behind the same Google-auth gate).

- **Version panel** — shows the running AO version (`ao --version`) vs the latest
  GitHub release, and an **Update now** button that calls Watchtower's on-demand
  API (M6) to pull `:stable` and recreate the stack.
- **Token rotation** — paste a new Claude / GitHub / Linear credential; it's written
  as a **new Secret Manager version**. Requires the `gcp` secret source
  (`AO_SECRET_SOURCE=gcp` + `AO_GCP_PROJECT`) and a service account / ADC with
  `roles/secretmanager.secretVersionAdder`. The new value **applies on the next
  restart** (nightly Watchtower, or a manual `docker compose restart ao`) — there
  is intentionally no instant restart-from-UI yet.

**Deferred:** the allowlist editor and instant "apply now" restart are not built —
both would need a new Docker-socket surface on the admin backend or an allowlist
redesign. Edit the allowlist for now by updating `ALLOWED_EMAIL_*` and restarting.

**Trust note:** like the daemon API bridge (`ao:8080`), the admin backend has no
auth of its own — it trusts the compose network and relies on Caddy as the sole
gate. Acceptable for a single-tenant box; don't add other containers to this
network without re-evaluating.

## M7: deploy to a GCE VM (single public bot)

`deploy-gcp.sh` provisions the stack as a public, Google-gated bot at
`https://<reserved-ip>.sslip.io` — no domain needed. Driven from your machine with
your own `gcloud`. **Costs money** (an `e2-standard-4` VM) while it's running.

**Prerequisites:** `gcloud` authed (`gcloud auth login`), a project selected, and
the **3 gate secrets** present (`google-oauth-client`, `jwt-shared-key`,
`dashboard-allowlist`) — check with `valhalla-dev-bot`'s `check`.

```bash
cd deploy
./deploy-gcp.sh init      # one-time: reserves a static IP, SA + IAM, firewall.
                          # Prints a redirect URI — add it to your OAuth client ONCE.
./deploy-gcp.sh create    # creates the VM (max 1 per user), uploads the kit,
                          # fetches secrets via the VM's SA, brings the stack up.
# → open https://<ip>.sslip.io , sign in with an allowlisted Google account
./deploy-gcp.sh status    # show your bot's VM + URL
./deploy-gcp.sh destroy   # delete the VM instance (IP/SA/secrets persist)
```

**Max 1 per user.** The VM is named `ao-<your-account>` and labelled `ao-owner`;
`create` refuses if you already have one. **Delete-often friendly:** `destroy`
removes only the instance — the reserved IP, service account, and secrets persist,
so the sslip.io hostname + OAuth redirect never change and `create` is cheap to
re-run.

**Agent auth (on-box, after sign-in):** GitHub/Claude are NOT stored centrally —
SSH in and log in:
```bash
gcloud compute ssh ao-<account> --zone=us-central1-a
sudo docker compose -f /opt/ao/deploy/docker-compose.yml exec ao gh auth login
sudo docker compose -f /opt/ao/deploy/docker-compose.yml exec ao claude setup-token
```
(Until config-dir persistence lands, a VM recreate may drop these — just re-auth.)

**Notes:** the kit is `scp`'d from your local checkout (the deploy branch is
unpushed); once it's published, the VM can clone or pull `ghcr :stable` instead.
The first `create` builds the images on the VM (the Caddy xcaddy build is slow,
a few minutes). sslip.io + Let's Encrypt is fine for occasional recreates; if you
cycle very frequently you may hit LE rate limits — a real domain (M8) avoids that.
