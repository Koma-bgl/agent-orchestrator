# M3 — Caddy + Google sign-in + email allowlist (local) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a Google sign-in + email-allowlist gate in front of the AO daemon's HTTP API, terminated by Caddy over TLS — fully exercisable on a laptop at `https://localhost:8443` with no VM.

**Architecture:** A custom Caddy image (xcaddy + `caddy-security`) terminates TLS and runs an authentication portal (Google OIDC) + an authorization policy (email allowlist). Authenticated requests are reverse-proxied to `ao:8080`. Because the daemon binds `127.0.0.1:3001` only, a `socat` relay inside the `ao` container bridges `0.0.0.0:8080 → 127.0.0.1:3001` (compose-network-only; never published), keeping the daemon's loopback-trusted path intact and passing SSE through untouched.

**Tech Stack:** Caddy `2.8.4` + `caddy-security@v1.1.64` (AuthCrunch), `socat`, docker compose, Google OAuth 2.0 / OIDC.

> **⚠️ Top risk — caddy-security DSL drift.** The `security {}` Caddyfile DSL is version-specific. Every Caddyfile change in this plan MUST be validated with `caddy validate` against the pinned custom image before proceeding. If a keyword errors (`crypto key sign-verify`, `transform user`, `acl rule`, `set auth url`, `inject headers with claims`), consult the v1.1.64 docs (authcrunch.com / greenpau/caddy-auth-docs) and adjust — do not guess past a validation failure.

> **Live-verification amendments (applied during execution):**
>
> 1. **Caddy version:** `caddy-security@v1.1.64` actually requires **Caddy `v2.11.4`** (+ Go ≥ 1.25.8), not `2.8.4` as the research suggested. The custom image pins `2.11.4` and sets `GOTOOLCHAIN=auto`.
> 2. **Caddyfile mount:** the compose `caddy` service must mount `./Caddyfile:/etc/caddy/Caddyfile:ro` — without it Caddy runs the stock image's default (file-server welcome page), not our auth+proxy config. Added to Task 4.
>    Both were caught only by the live build/run; verified end-to-end (302→portal, daemon unreachable from host).

> **Scope (M3, local only):** raw daemon API behind the auth gate at `https://localhost:8443`. NOT in scope: the monitoring SPA (M4), admin ops (M5), Watchtower (M6), real domain + Let's Encrypt TLS (M7). The Caddyfile is parameterized by `{$AO_SITE_ADDRESS}` so M7 swaps localhost→domain with minimal change.

---

### Grounding facts (verified)

- M1/M2 are committed; the `ao` image runs `ao daemon` headless on `127.0.0.1:3001`, healthcheck `GET /healthz`, state on the `ao-state` volume. The entrypoint resolves the real Go binary and `exec`s it as PID 1; compose sets `init: true` (tini).
- The daemon binds `127.0.0.1` only with **no `AO_HOST` override** and **zero auth** — every loopback caller is trusted. Confirmed in M1/M2.
- The daemon serves SSE on `GET /api/v1/events`; it sets `Content-Type: text/event-stream`.
- caddy-security build: `xcaddy build v2.8.4 --with github.com/greenpau/caddy-security@v1.1.64`; the custom binary must overwrite `/usr/bin/caddy` in the stock image.
- caddy-security callback path (single-host, portal mounted at `/auth*`): `<site>/auth/oauth2/google/authorization-code-callback`; login entry: `<site>/auth/oauth2/google`.
- Google permits `https://localhost:PORT` redirect URIs (port must match exactly). Caddy `tls internal` serves a self-signed cert on `localhost`.
- Single-host path-split means a **host-only cookie** works — no `cookie domain` needed (that's only for cross-subdomain SSO).
- `JWT_SHARED_KEY` must be identical in the portal (`sign-verify`) and the policy (`verify`); generate with `openssl rand -hex 32`.

### File structure

- Create `deploy/caddy/Dockerfile` — custom Caddy image (xcaddy + caddy-security).
- Create `deploy/Caddyfile` — security block (Google OIDC + allowlist) + path-split site.
- Modify `deploy/Dockerfile` — add `socat` to the `ao` image.
- Modify `deploy/entrypoint.sh` — start the `socat` relay, then `exec` the daemon.
- Modify `deploy/docker-compose.yml` — add the `caddy` service; expose (not publish) `ao:8080`; mount Caddy `/data`.
- Modify `deploy/.env.example` — add Google / JWT / allowlist / site-address vars.
- Modify `deploy/README.md` — Google OAuth client setup + local test walkthrough.

---

## Task 1: socat loopback bridge in the `ao` container

**Files:**

- Modify: `deploy/Dockerfile` (apt install `socat`)
- Modify: `deploy/entrypoint.sh` (launch socat before the daemon)

- [ ] **Step 1: Add `socat` to the `ao` image**

In `deploy/Dockerfile`, add `socat` to the existing `apt-get install` line (alongside `tmux git curl ca-certificates`). Keep one layer; no new RUN.

- [ ] **Step 2: Launch the relay in the entrypoint, before the daemon exec**

In `deploy/entrypoint.sh`, immediately before the `AO_SHIM_DIR=...` / `exec "${AO_BIN}" daemon` block, add:

```bash
# Loopback bridge: the daemon binds 127.0.0.1:${AO_PORT} only, so a sibling
# container (Caddy) cannot reach it. socat relays 0.0.0.0:8080 -> the loopback
# daemon (compose-network only; never published to the host). Backgrounded; tini
# (init: true) reaps it. It is a dumb TCP relay, so SSE passes through untouched.
AO_BRIDGE_PORT="${AO_BRIDGE_PORT:-8080}"
echo "[entrypoint] starting loopback bridge :${AO_BRIDGE_PORT} -> 127.0.0.1:${AO_PORT:-3001}"
socat "TCP-LISTEN:${AO_BRIDGE_PORT},fork,reuseaddr" "TCP:127.0.0.1:${AO_PORT:-3001}" &
```

(The daemon remains the foreground `exec`'d PID-1 child of tini; socat is a background child. On shutdown tini SIGTERMs the daemon, the container exits, socat is torn down with it. socat is a stable relay; if it ever dies it is not auto-restarted — acceptable for M3, revisit if it proves flaky.)

- [ ] **Step 3: Syntax-check the entrypoint**

Run: `bash -n deploy/entrypoint.sh`
Expected: no output.

- [ ] **Step 4: Build and verify the bridge serves the daemon**

```bash
cd deploy
cp .env.example .env   # if not already present
docker compose up -d --build ao
sleep 8
# the bridge port reaches the daemon's API (via socat -> loopback):
docker compose exec -T ao curl -fsS http://127.0.0.1:8080/healthz
```

Expected: `{"status":"ok",...}` (same payload as `:3001/healthz`).

- [ ] **Step 5: Commit**

```bash
git add deploy/Dockerfile deploy/entrypoint.sh
git commit -m "feat(deploy): socat loopback bridge so Caddy can reach the daemon"
```

---

## Task 2: Custom Caddy image with caddy-security

**Files:**

- Create: `deploy/caddy/Dockerfile`

- [ ] **Step 1: Write the custom Caddy Dockerfile**

`deploy/caddy/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1
# Custom Caddy with the caddy-security (AuthCrunch) plugin baked in.
# Pin both Caddy and the plugin for reproducibility.
FROM caddy:2.8.4-builder AS builder
RUN xcaddy build v2.8.4 \
    --with github.com/greenpau/caddy-security@v1.1.64

FROM caddy:2.8.4
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
```

- [ ] **Step 2: Build the image and confirm the security modules are present**

```bash
docker build -t ao-caddy:dev deploy/caddy
docker run --rm ao-caddy:dev caddy list-modules | grep -Ei 'security|authenticate|authorize'
```

Expected: lists `security` (app) + `http.handlers.authenticator`/`authorizer` (or similar `authcrunch`/`authp` modules). If empty, the plugin did not compile in — stop and fix before continuing.

- [ ] **Step 3: Commit**

```bash
git add deploy/caddy/Dockerfile
git commit -m "feat(deploy): custom Caddy image with caddy-security plugin"
```

---

## Task 3: Caddyfile — Google OIDC portal + email allowlist + proxy

**Files:**

- Create: `deploy/Caddyfile`

- [ ] **Step 1: Write the Caddyfile (local-first, env-parameterized)**

`deploy/Caddyfile`:

```caddyfile
{
	# Local mode: serve TLS on 8443 (Caddy internal cert). M7 removes these two
	# lines and switches to the bare domain for automatic Let's Encrypt.
	http_port 8080
	https_port 8443

	order authenticate before respond
	order authorize before basicauth

	security {
		oauth identity provider google {
			realm google
			driver google
			client_id {env.GOOGLE_CLIENT_ID}
			client_secret {env.GOOGLE_CLIENT_SECRET}
			scopes openid email profile
		}

		authentication portal myportal {
			crypto default token lifetime 3600
			crypto key sign-verify {env.JWT_SHARED_KEY}
			enable identity provider google
			# Conventional role grant; NOT load-bearing for the allowlist below
			# (the policy gates on the `email` claim directly, not on role).
			transform user {
				match realm google
				action add role authp/user
			}
		}

		authorization policy mypolicy {
			set auth url {$AO_SITE_URL}/auth/oauth2/google
			crypto key verify {env.JWT_SHARED_KEY}

			# EMAIL ALLOWLIST — acl default is deny-unless-allowed. One rule per
			# allowed Google email (extend as needed). Trailing deny is explicit.
			acl rule {
				comment allowlisted operator 1
				match email {env.ALLOWED_EMAIL_1}
				allow stop log info
			}
			acl rule {
				comment default deny
				match any
				deny log warn
			}

			validate bearer header
			inject headers with claims
		}
	}
}

{$AO_SITE_ADDRESS} {
	# Local: Caddy internal self-signed cert. M7 removes `tls internal` for ACME.
	tls internal

	route /auth* {
		authenticate with myportal
	}

	route /* {
		authorize with mypolicy
		reverse_proxy ao:8080 {
			# SSE belt-and-suspenders: stream /api/v1/events without buffering.
			flush_interval -1
		}
	}
}
```

- [ ] **Step 2: Validate the Caddyfile against the custom image**

```bash
docker run --rm \
  -e GOOGLE_CLIENT_ID=dummy -e GOOGLE_CLIENT_SECRET=dummy \
  -e JWT_SHARED_KEY=0000000000000000000000000000000000000000000000000000000000000000 \
  -e ALLOWED_EMAIL_1=test@example.com \
  -e AO_SITE_ADDRESS=localhost:8443 -e AO_SITE_URL=https://localhost:8443 \
  -v "$PWD/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" \
  ao-caddy:dev caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

Expected: `Valid configuration`. **If a keyword errors, this is the DSL-drift risk** — consult the v1.1.64 docs and fix the offending directive, then re-run. Do not proceed past a validation error.

- [ ] **Step 3: Commit**

```bash
git add deploy/Caddyfile
git commit -m "feat(deploy): Caddyfile with Google OIDC portal + email allowlist"
```

---

## Task 4: docker-compose — add Caddy, expose the bridge

**Files:**

- Modify: `deploy/docker-compose.yml`

- [ ] **Step 1: Expose the bridge port on the `ao` service (compose-network only)**

In the `ao` service, add (do NOT add a `ports:` mapping — `expose` keeps it off the host):

```yaml
expose:
  - "8080"
```

- [ ] **Step 2: Add the `caddy` service**

```yaml
caddy:
  build:
    context: ./caddy
  image: ao-caddy:dev
  depends_on:
    - ao
  env_file:
    - .env
  environment:
    # Local defaults; M7 overrides AO_SITE_ADDRESS/AO_SITE_URL with the domain.
    AO_SITE_ADDRESS: ${AO_SITE_ADDRESS:-localhost:8443}
    AO_SITE_URL: ${AO_SITE_URL:-https://localhost:8443}
  ports:
    - "8443:8443" # local HTTPS (M7: 80:80 + 443:443)
  volumes:
    - caddy-data:/data # cert/ACME storage; persists internal CA locally
    - caddy-config:/config
  restart: unless-stopped
```

And add to the top-level `volumes:`:

```yaml
caddy-data:
caddy-config:
```

- [ ] **Step 2b: Confirm the daemon port stays unpublished**

Verify the `ao` service still has **no** `ports:` key (only `expose`). Only Caddy publishes a port. This is the release-blocking invariant.

- [ ] **Step 3: Validate compose config**

Run: `cd deploy && docker compose config >/dev/null && echo OK`
Expected: `OK` (no YAML/interpolation errors).

- [ ] **Step 4: Commit**

```bash
git add deploy/docker-compose.yml
git commit -m "feat(deploy): add Caddy service, expose ao bridge on compose net only"
```

---

## Task 5: .env.example — auth secrets

**Files:**

- Modify: `deploy/.env.example`

- [ ] **Step 1: Append the M3 variables with guidance**

```bash
# --- M3: Caddy + Google sign-in (local testing at https://localhost:8443) ---
# Create an OAuth 2.0 Client (type: Web application) in Google Cloud Console.
# Authorized redirect URI (local): https://localhost:8443/auth/oauth2/google/authorization-code-callback
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
# Shared signing key for the session JWT — generate: openssl rand -hex 32
JWT_SHARED_KEY=
# Allowlisted Google account(s). Only these emails can sign in.
ALLOWED_EMAIL_1=
# Site address Caddy serves on. Local default below; M7 sets your domain.
AO_SITE_ADDRESS=localhost:8443
AO_SITE_URL=https://localhost:8443
```

- [ ] **Step 2: Commit**

```bash
git add deploy/.env.example
git commit -m "docs(deploy): add Google auth / JWT / allowlist env vars"
```

---

## Task 6: README — Google OAuth setup + local test

**Files:**

- Modify: `deploy/README.md`

- [ ] **Step 1: Add an "M3: authenticated access (local)" section** covering:
  - Creating a Google OAuth 2.0 **Web application** client in Google Cloud Console.
  - The exact local redirect URI: `https://localhost:8443/auth/oauth2/google/authorization-code-callback` (register it under the same client that prod will use; Google allows multiple redirect URIs).
  - Generating `JWT_SHARED_KEY` (`openssl rand -hex 32`) and filling `.env` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_EMAIL_1`).
  - Running `docker compose up -d --build`, then opening `https://localhost:8443` (accept Caddy's internal-CA warning), signing in with the allowlisted Google account, and landing on the daemon API.
  - Note: a non-allowlisted account is denied (403). Note the localhost cert warning is expected; real TLS is M7.

- [ ] **Step 2: Commit**

```bash
git add deploy/README.md
git commit -m "docs(deploy): Google OAuth client setup + local auth test"
```

---

## Task 7: Live verification — mechanics tier (no Google creds)

This tier needs **no real Google client** and is fully controller-runnable. The full-login tier (allowlisted email reaches the daemon; non-allowlisted denied) requires a real Google OAuth client and is deferred to whoever has one (the operator, at setup time).

- [ ] **Step 1: Bring up the full stack**

```bash
cd deploy
# .env may have dummy Google values for the mechanics tier:
#   GOOGLE_CLIENT_ID=dummy GOOGLE_CLIENT_SECRET=dummy
#   JWT_SHARED_KEY=$(openssl rand -hex 32) ALLOWED_EMAIL_1=test@example.com
docker compose up -d --build
sleep 10
docker compose ps
```

Expected: `ao` healthy, `caddy` running.

- [ ] **Step 2: Daemon port is NOT reachable from the host**

```bash
curl -s -m 3 http://127.0.0.1:3001/healthz; echo "exit=$?"
curl -s -m 3 http://127.0.0.1:8080/healthz; echo "exit=$?"
```

Expected: both fail to connect (non-zero exit / empty) — neither the daemon nor the bridge is published. Only Caddy's 8443 is.

- [ ] **Step 3: Unauthenticated request is bounced to Google sign-in**

```bash
curl -sk -i https://localhost:8443/api/v1/sessions | head -20
```

Expected: a **302** whose `Location` points at the portal login path (`https://localhost:8443/auth/oauth2/google`) — NOT a `200 {"sessions":...}`. (The redirect is to the portal, not `accounts.google.com` directly; the portal initiates the Google dance only after you follow it, which is why dummy Google creds are fine for this check.) This proves the authorize policy gates the proxied daemon API.

- [ ] **Step 4: The portal route is served**

```bash
curl -sk -i https://localhost:8443/auth | head -20
```

Expected: the authentication portal responds (200 / login UI), not a proxy error.

- [ ] **Step 5: Caddy logs show the security app loaded**

```bash
docker compose logs --no-color caddy | grep -Ei 'security|authp|authcrunch|provisioned' | head
```

Expected: evidence the security app/portal/policy provisioned without error.

- [ ] **Step 6: Tear down**

```bash
docker compose down
```

- [ ] **Step 7 (deferred — operator with a real Google client): full login**

Document, do not block on: with real `GOOGLE_CLIENT_ID/SECRET` and `ALLOWED_EMAIL_1` set to a real account, opening `https://localhost:8443` → Google sign-in → allowlisted account reaches the daemon API; a non-allowlisted account gets 403.

---

## Done criteria (M3, mechanics tier)

- Custom Caddy image builds and reports the `security` modules.
- `caddy validate` passes against the pinned image (no DSL drift).
- `docker compose up` brings up `ao` (healthy) + `caddy`.
- Neither `:3001` nor `:8080` is reachable from the host; only Caddy's `:8443` is.
- An unauthenticated request to a proxied daemon path is redirected to sign-in (not served).
- The auth portal route responds; Caddy logs show the security app provisioned.
- Full-login verification is documented for an operator with a real Google client (deferred, not blocking).
