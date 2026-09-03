# M8a — Fleet auth portal (Cloud Run) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the fleet SSO portal at `https://auth.binary-badger.xyz` (Cloud Run, caddy-security) and retrofit the bots to authorize-only — one Google sign-in works on every `<user>.binary-badger.xyz` bot, and the OAuth redirect URI is registered in the Console **once, ever**.

**Architecture:** A self-contained portal image (xcaddy + caddy-security, portal-only Caddyfile, entrypoint that splits the pipe-joined `google-oauth-client` secret) deployed via `gcloud run deploy --source` with `--max-instances=1` (in-memory OAuth handshake state) and domain-mapped to `auth.binary-badger.xyz` (records automated in the `ao-fleet` Cloud DNS zone). Bots drop their local portals: `Caddyfile.public` keeps only `authorize` policies pointing at the portal (`set auth url`), validating the domain-wide JWT cookie (shared `jwt-shared-key`) + the fleet allowlist. `deploy-gcp.sh` automates per-bot A-records and loses every sslip.io assumption.

**Tech Stack:** caddy-security v1.1.64 / Caddy 2.11.4 (as pinned in `deploy/caddy/Dockerfile`), Cloud Run (+ Cloud Build via `--source`), Cloud DNS, bash + `gcp-lib.mjs` (Node, TDD).

**Spec:** `docs/superpowers/specs/2026-07-03-m8a-auth-portal-design.md` (reviewer-approved; B1 trusted-redirect + B2 max-instances folded).

> **✅ VERIFIED LIVE (2026-07-03):** one Google sign-in at `auth.binary-badger.xyz`
> → landed on the bot dashboard at `ky-chaostheory-hk.binary-badger.xyz`, zero
> per-bot OAuth. Three deploy-only bugs surfaced during the live run (none
> catchable by the local single-instance test — they only exist when portal and
> bot are separate services):
>
> 1. **caddy-security pinned v1.1.64 → v1.1.31.** v1.1.32+ carries two SSO-fatal
>    regressions: #471 (portal deletes the `access_token` cookie right after login)
>    and #481 (`cookie domain` stops scoping the token cookie). 1.1.31 predates
>    both. NB: v1.1.31 lacks `trust login redirect uri` (a newer directive) — it
>    was removed; older versions don't need it for same-registrable-domain returns.
> 2. **`set auth url` must target the portal ROOT**, not `/oauth2/google` (else the
>    portal skips cookie issuance / redirect_url handling).
> 3. **JWT-key newline:** `openssl rand | gcloud secrets create` stored a trailing
>    `\n`; Cloud Run `--set-secrets` injects it raw while bots strip it via shell —
>    key mismatch → loop. Fixed the secret (64 bytes) + the portal entrypoint now
>    trims CR/LF from injected secrets.
>    Also: `create`'s ssh/scp now retries (transient post-boot `Connection reset`).

> **⚠️ DSL-drift guard (from M3, still binding):** every Caddyfile change MUST pass `caddy validate` against the pinned plugin build before proceeding. The two directives most at risk here: the **trusted-redirect rule** in the portal (cross-host return leg) and the **multi-value `match email`** line. If validate rejects a keyword, consult the AuthCrunch v1.1.64 docs and adjust — never guess past a failure.

> **Verification split:** Tasks 1–6 are laptop-verifiable (tests, `bash -n`, `caddy validate`, compose config). Task 7 is the operator-run live tier (portal deploy = pennies; the bot test costs VM time). Two once-ever manual steps live in Task 7: Search Console domain verification (if not already verified) and registering the portal's redirect URI.

### Grounding facts (verified this session)

- `binary-badger.xyz` is delegated to the `ao-fleet` Cloud DNS zone in `cloudbet-native` (NS live on 8.8.8.8/1.1.1.1; record create→resolve→delete proven).
- The `ao-deploy` SA already holds `secretAccessor` on the 3 gate secrets (M7 `init` ran) — reuse it as the Cloud Run runtime SA; no new IAM for reads.
- `google-oauth-client` is stored pipe-joined (`ID|SECRET`); `deploy-gcp.sh:110` splits it with `${GOC%%|*}` — the portal entrypoint replicates this.
- Bot-side `authorize` policies already validate a JWT signed with `jwt-shared-key` (`crypto key verify {env.JWT_SHARED_KEY}`) — the portal signs with the same key, so bot validation code is unchanged.
- `deploy/caddy/Dockerfile` pins `caddy:2.11.4-builder` + `caddy-security@v1.1.64` — the portal Dockerfile copies this pattern (self-contained; Cloud Build can't see local images).
- Current sslip call sites to sweep: `gcp-lib.mjs` (`sslipHost`, `redirectUri` + tests), `deploy-gcp.sh` (`init` print, `create` host derivation, `status` URL).
- Reviewer-verified (from go-authcrunch source): callback path at root mount is `/oauth2/google/authorization-code-callback` (no `/auth` prefix); cross-host `redirect_url` requires a trusted-redirect rule; handshake state is per-process in-memory; absolute URLs honor `X-Forwarded-Proto/Host` (Cloud Run sets them).

### File structure

- Modify `deploy/gcp-lib.mjs` + `deploy/gcp-lib.test.mjs` — `botHost`, `AUTH_HOST`/`authUrl`; remove `sslipHost`/`redirectUri`.
- Create `deploy/portal/Dockerfile` — self-contained portal image.
- Create `deploy/portal/Caddyfile.portal` — portal-only security config.
- Create `deploy/portal/entrypoint.sh` — split `GOOGLE_OAUTH_CLIENT` → env, exec caddy.
- Create `deploy/deploy-portal.sh` — Cloud Run deploy + domain mapping + DNS + one-time-step prints.
- Modify `deploy/Caddyfile.public` — authorize-only retrofit.
- Modify `deploy/docker-compose.vm.yml` — pass `AO_AUTH_URL` + `ALLOWED_EMAILS` to caddy.
- Modify `deploy/deploy-gcp.sh` — A-record automation, fleet env, sslip sweep.
- Modify `deploy/README.md` — M8a section; correct the M7 sslip references.

---

## Task 1: Fleet host helpers (TDD)

**Files:** Modify `deploy/gcp-lib.mjs`, `deploy/gcp-lib.test.mjs`

- [ ] **Step 1: Rewrite the affected tests** — remove the `sslipHost`/`redirectUri` tests; add:

```js
test("botHost derives the fleet subdomain from the account", () => {
	assert.equal(botHost("ky@chaostheory.hk"), "ky-chaostheory-hk.binary-badger.xyz");
	assert.equal(botHost("ky@chaostheory.hk", 2), "ky-chaostheory-hk-2.binary-badger.xyz");
	assert.match(botHost("A.B+C@x"), /^[a-z0-9-]+\.binary-badger\.xyz$/);
});
test("FLEET_DOMAIN and AUTH_HOST are consistent", () => {
	assert.equal(FLEET_DOMAIN, "binary-badger.xyz");
	assert.equal(AUTH_HOST, "auth.binary-badger.xyz");
});
```

- [ ] **Step 2: Run — expect FAIL** (`node --test deploy/gcp-lib.test.mjs`).
- [ ] **Step 3: Implement** — `export const FLEET_DOMAIN = "binary-badger.xyz"`, `export const AUTH_HOST = \`auth.${FLEET_DOMAIN}\``, `botHost(account, index=1)` = `` `${ownerLabel-style-sanitized}${idx>1?`-${idx}`:""}.${FLEET_DOMAIN}` `` (reuse the sanitizer; DNS label ≤63 chars). Delete `sslipHost`/`redirectUri`. Keep the CLI tail working (`node gcp-lib.mjs botHost ky@x 2`; also expose `AUTH_HOST` via a `fn` like `authHost`).
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** (`feat(deploy): fleet host helpers; drop sslip (TDD)`).

---

## Task 2: The portal (image + Caddyfile + entrypoint)

**Files:** Create `deploy/portal/Dockerfile`, `deploy/portal/Caddyfile.portal`, `deploy/portal/entrypoint.sh`

- [ ] **Step 1: `Caddyfile.portal`**

```caddyfile
{
	# Cloud Run terminates TLS and provides $PORT (8080). Plain HTTP inside.
	http_port 8080
	auto_https off
	order authenticate before respond

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
			# Fleet-wide session: every *.binary-badger.xyz host receives the cookie.
			cookie domain binary-badger.xyz
			cookie samesite lax
			# Return leg (B1): without this, cross-host redirect_url values are
			# IGNORED (open-redirect guard) and users strand on the portal page.
			# Tightly scoped to the fleet domain — never a permissive wildcard.
			# NOTE: BOTH clauses are required by the DSL (domain AND path).
			trust login redirect uri domain suffix binary-badger.xyz path prefix /
			transform user {
				match realm google
				action add role authp/user
			}
		}
	}
}

:8080 {
	authenticate with myportal
}
```

- [ ] **Step 2: `entrypoint.sh`** — **`#!/bin/sh` + `set -eu`** (the `caddy:2.11.4` base is Alpine — **no bash**; the expansions below are POSIX so sh is sufficient); require `GOOGLE_OAUTH_CLIENT` (the raw pipe-joined secret, injected by Cloud Run) and `JWT_SHARED_KEY`; export `GOOGLE_CLIENT_ID="${GOOGLE_OAUTH_CLIENT%%|*}"` and `GOOGLE_CLIENT_SECRET="${GOOGLE_OAUTH_CLIENT#*|}"`; `exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile`.

- [ ] **Step 3: `Dockerfile`** — self-contained (Cloud Build sees no local images):

```dockerfile
FROM caddy:2.11.4-builder AS builder
RUN xcaddy build v2.11.4 --with github.com/greenpau/caddy-security@v1.1.64

FROM caddy:2.11.4
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
COPY Caddyfile.portal /etc/caddy/Caddyfile
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
```

- [ ] **Step 4: Validate locally** — `sh -n deploy/portal/entrypoint.sh`; build the image locally (`docker build -t ao-portal:dev deploy/portal`) and validate **through the entrypoint** so the shebang/shell path is exercised exactly as Cloud Run will run it:
      `docker run --rm -e GOOGLE_OAUTH_CLIENT='dummy-id|dummy-secret' -e JWT_SHARED_KEY=000…0 --entrypoint /bin/sh ao-portal:dev -c '. /entrypoint.sh 2>/dev/null || true; caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile'` — or simpler: temporarily replace `caddy run` with `caddy validate` via an env guard and `docker run` the image as-is. Expected: `Valid configuration`, and the entrypoint reaches the exec line (no bash-isms). **If the `trust login redirect uri … path prefix /` line errors, this is the DSL-drift case** — check the AuthCrunch trust-login-logout docs for the v1.1.64 form and fix.
- [ ] **Step 5: Commit** (`feat(deploy): fleet auth portal image (caddy-security on Cloud Run)`).

---

## Task 3: `deploy-portal.sh`

**Files:** Create `deploy/deploy-portal.sh`

- [ ] **Step 1: Implement** (idempotent; `set -euo pipefail`; `--project=` | `$AO_PROJECT` | gcloud default; region `us-central1`):
  1. Enable `run.googleapis.com` + `cloudbuild.googleapis.com` + `artifactregistry.googleapis.com` (idempotent — `--source` builds via Cloud Build into an auto-created `cloud-run-source-deploy` Artifact Registry repo; the script must not rely on interactive prompts). Note in a comment: the caller needs `roles/iam.serviceAccountUser` on `ao-deploy` to deploy with `--service-account` (an owner has it implicitly).
  2. `gcloud run deploy ao-auth-portal --source deploy/portal --region us-central1 --allow-unauthenticated --min-instances=0 --max-instances=1 --port 8080 --service-account "ao-deploy@$PROJECT.iam.gserviceaccount.com" --set-secrets "GOOGLE_OAUTH_CLIENT=google-oauth-client:latest,JWT_SHARED_KEY=jwt-shared-key:latest"`.
     (`--max-instances=1` is load-bearing — in-memory OAuth handshake state.)
  3. Domain mapping: `gcloud beta run domain-mappings describe --domain auth.binary-badger.xyz … || create --service ao-auth-portal --domain auth.binary-badger.xyz`. If create fails on domain verification → print the **once-ever** Search Console step and exit non-zero with clear instructions.
  4. Read `resourceRecords` from the mapping and upsert them into the `ao-fleet` zone (`gcloud dns record-sets create … --zone=ao-fleet` — CNAME/A per what the mapping returns).
  5. Print: portal URL, and the **once-ever OAuth step** — add `https://auth.binary-badger.xyz/oauth2/google/authorization-code-callback` to the OAuth client (Console link).
- [ ] **Step 2: `bash -n deploy/deploy-portal.sh`** (+ shellcheck if present).
- [ ] **Step 3: Commit** (`feat(deploy): deploy-portal.sh — Cloud Run + domain mapping + DNS`).

---

## Task 4: Bot retrofit — authorize-only `Caddyfile.public`

**Files:** Modify `deploy/Caddyfile.public`, `deploy/docker-compose.vm.yml`

- [ ] **Step 1: Retrofit `Caddyfile.public`:**
  - Delete the `oauth identity provider` block, the `authentication portal` block, and the `handle /auth*` route; drop `order authenticate before respond` (keep `order authorize before basicauth`).
  - In `authorization policy mypolicy`: `set auth url {$AO_AUTH_URL}`, keep `crypto key verify {env.JWT_SHARED_KEY}`, `validate bearer header`, `inject headers with claims`.
    **`AO_AUTH_URL` = `https://auth.binary-badger.xyz/oauth2/google`** (the login-initiation path, root mount → no `/auth` prefix) — matching today's UX where an unauthenticated user goes _straight into_ the Google flow; the bare portal root would add a "Sign in with Google" click.
  - **Multi-email allowlist:** replace the single-email rule with `match email {$ALLOWED_EMAILS}` — `{$…}` is _parse-time_ substitution, so a space-separated value splats into multi-value match (reviewer-confirmed supported; `{env.…}` would NOT splat). Keep the explicit default-deny rule. Known failure mode (acceptable): an **empty/unset** `ALLOWED_EMAILS` substitutes to zero tokens → `match email` fails parse → the bot's Caddy won't start; the VM `.env` always sets it from the `dashboard-allowlist` secret.
- [ ] **Step 2: `docker-compose.vm.yml`** — add to `caddy.environment`: `AO_AUTH_URL: ${AO_AUTH_URL}`, `ALLOWED_EMAILS: ${ALLOWED_EMAILS}`.
- [ ] **Step 3: Validate** — `caddy validate` on the retrofitted `Caddyfile.public` in `ao-caddy:dev` with dummy env incl. `ALLOWED_EMAILS="a@x.com b@y.com"` and `AO_AUTH_URL=https://auth.binary-badger.xyz`; then `docker compose -f … -f docker-compose.vm.yml config` clean. Expected: valid; the adapted config shows both emails in the ACL (spot-check with `caddy adapt` if in doubt).
- [ ] **Step 4: Commit** (`feat(deploy): bots authorize-only against the fleet portal`).

**Note:** the _local_ `deploy/Caddyfile` (localhost mode, own portal) is intentionally unchanged — local dev alignment is M8c.

---

## Task 5: `deploy-gcp.sh` fleet sweep

**Files:** Modify `deploy/deploy-gcp.sh`

- [ ] **Step 1: `create`:**
  - Host: `HOST="$(node "$SCRIPT_DIR/gcp-lib.mjs" botHost "$ACCOUNT" "$INDEX")"`.
  - After the IP is known, **upsert the A-record with describe → update-else-create** (pinned pattern — `create` fails if present, `update` fails if absent, and delete-then-create opens an NXDOMAIN window that resolvers negative-cache):
    `gcloud dns record-sets describe "$HOST." --type=A --zone=ao-fleet … && gcloud dns record-sets update … || gcloud dns record-sets create … --ttl=300 --rrdatas="$ip"`.
  - Remote `.env`: **replace `ALLOWED_EMAIL_1=…` with** `ALLOWED_EMAILS` = the `dashboard-allowlist` secret normalized to space-separated (`tr ',\n' ' '`) — the old var's only consumer is deleted in Task 4; add `AO_AUTH_URL=https://auth.binary-badger.xyz/oauth2/google`; keep `AO_SITE_ADDRESS=$HOST`.
  - Remove the "add the redirect URI" print (portal owns it); point the sign-in hint at `https://$HOST`.
- [ ] **Step 2: `destroy`:** also delete the bot's A-record (ignore-if-absent).
- [ ] **Step 3: `init` + `status`:** drop sslip/redirect-URI prints; `status` shows `https://$(botHost …)`.
- [ ] **Step 3b: stale-comment sweep** — the code sweep alone misses prose: fix the `deploy-gcp.sh` header (lines 2–8: "sslip.io", "print the OAuth redirect URI"), `docker-compose.vm.yml` ("The sslip.io host" comment), and the `Caddyfile.public` header ("e.g. `<ip>.sslip.io`"). Guard: `grep -rn sslip deploy/ --include='*' | grep -v valhalla` returns nothing (the local-mode skill is M8c's).
- [ ] **Step 4: Validate** — `bash -n`; read-only live smoke: `./deploy-gcp.sh status --project=cloudbet-native` shows the fleet URL.
- [ ] **Step 5: Commit** (`feat(deploy): per-bot fleet DNS + portal auth env; sslip removed`).

---

## Task 6: README

**Files:** Modify `deploy/README.md`

- [ ] **Step 1:** Add an "M8a: fleet SSO" section — the architecture sketch; `deploy-portal.sh` usage; **the two once-ever steps** (Search Console verification, OAuth redirect URI); the invariant _nothing untrusted is ever hosted under `binary-badger.xyz`_ (domain-wide cookie); allowlist = the `dashboard-allowlist` secret (now multi-email, comma/newline/space separated); note bots need no Console steps ever. Update the M7 section's sslip references to the fleet domain.
- [ ] **Step 2: Commit** (`docs(deploy): M8a fleet SSO runbook`).

---

## Task 7: Operator-run live tier

- [ ] **Step 1 (pennies):** `./deploy-portal.sh --project=cloudbet-native`. If domain verification blocks: do the once-ever Search Console step, re-run. Wait for the managed cert (15 min–24 h), then assert: `https://auth.binary-badger.xyz` serves the portal over a valid cert, and `curl -s -i https://auth.binary-badger.xyz/oauth2/google | grep -i location` 302s to `accounts.google.com` **with `redirect_uri=https://auth.binary-badger.xyz/...`** (the X-Forwarded-* proof).
- [ ] **Step 2 (once-ever):** add `https://auth.binary-badger.xyz/oauth2/google/authorization-code-callback` to the OAuth client. The Console era ends here.
- [ ] **Step 3 (VM cost):** `./deploy-gcp.sh init && ./deploy-gcp.sh create` → bot at `https://<user>.binary-badger.xyz` (LE cert, A-record automated). Unauthenticated → 302 to the portal. Sign in with an allowlisted account → **land back on the bot dashboard** (the B1 trusted-redirect proof).
- [ ] **Step 4 (the M8a acceptance):** open the bot in a fresh tab / have a second allowlisted user open it — the session cookie admits without re-login; a **second bot** created later needs zero Console steps.
- [ ] **Step 5:** `./deploy-gcp.sh destroy` (A-record cleaned) — portal unaffected; recreate cheap.

---

## Done criteria

- Unit tests green (fleet helpers; sslip helpers gone).
- Portal image validates locally; `deploy-portal.sh`/`deploy-gcp.sh` pass `bash -n`; retrofitted `Caddyfile.public` validates with multi-email splat confirmed; compose override merges clean.
- Live: portal on managed TLS; correct `redirect_uri`; one sign-in reaches a bot round-trip (portal→bot return leg works); allowlist enforced; `destroy` cleans the A-record; **no per-bot Console steps remain**.

## Out of scope

M8b (broker, server-side quota), M8c (setup skill + local-dev portal alignment), portal-side allowlist defense-in-depth (noted in spec as optional later), multi-project DNS parameterization.
