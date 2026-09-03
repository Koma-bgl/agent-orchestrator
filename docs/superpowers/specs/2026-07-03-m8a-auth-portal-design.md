# M8a — Fleet auth portal on Cloud Run — Design

**Date:** 2026-07-03
**Status:** Draft for spec review
**Builds on:** M7 (live-validated VM lifecycle) + the M8 architecture notes
(`2026-07-02-m8-fleet-architecture-notes.md`). Domain `binary-badger.xyz` is
delegated to the `ao-fleet` Cloud DNS zone in `cloudbet-native` (verified live:
NS + record automation proven).

## Problem

Every bot currently runs its own caddy-security **portal**, so every bot hostname
must be manually registered in the Google OAuth client's redirect list (Console-
only; no API). One sign-in also only covers one bot. With a fleet domain we can
centralize authentication so the redirect URI is registered **once, ever**, and
one sign-in works on every bot.

## Goals

- One Google sign-in at `auth.binary-badger.xyz` → access to **every** bot
  (fleet-wide access: any allowlisted member can open any bot's panel — user
  decision 2026-07-03).
- **Zero per-bot OAuth steps.** New bot = DNS record + VM; never touches the
  Google Console.
- Bots keep enforcing the allowlist; the portal only authenticates.
- Delete-often unchanged: bots stay ephemeral; the portal is the only always-on
  piece (Cloud Run, scale-to-zero, ~$0).

## Non-Goals (M8b/M8c)

- The provisioning broker / server-side quota (M8b).
- The guided setup skill (M8c).
- Per-bot / owner-managed allowlists (explicitly rejected in favor of fleet-wide).

## Key decisions

| Decision                         | Choice                                                                                                                               | Rationale                                                                                                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Portal engine                    | **caddy-security on Cloud Run** (our existing custom image)                                                                          | The bots' `authorize` policies already validate exactly the JWT this portal mints (same `jwt-shared-key`); AuthCrunch's documented multi-subdomain SSO pattern; zero new auth code                                   |
| Session sharing                  | JWT cookie with **`cookie domain binary-badger.xyz`**                                                                                | All `*.binary-badger.xyz` hosts receive it; bots validate it statelessly with the shared key                                                                                                                         |
| Allowlist enforcement            | **Bot-side, unchanged** — every bot fetches the same `dashboard-allowlist` secret                                                    | Fleet-wide by construction (shared list); portal authenticates, bots authorize; no new moving part                                                                                                                   |
| Portal TLS/ingress               | Cloud Run (terminates TLS) + **domain mapping** for `auth.binary-badger.xyz`                                                         | Managed cert, no Caddy-ACME on the portal. Domain verification TXT is automatable via our own Cloud DNS zone. Fallback if domain mapping fights us: serverless-NEG LB (~$18/mo) — decide at plan time only if needed |
| Portal listener                  | Caddy `http_port 8080`, `auto_https off`, site `:8080`                                                                               | Cloud Run provides `$PORT`/TLS; Caddy serves plain HTTP internally                                                                                                                                                   |
| Portal secrets                   | `GOOGLE_CLIENT_ID/SECRET` split from `google-oauth-client`, `JWT_SHARED_KEY` — via Cloud Run's native Secret Manager env integration | Same source of truth as the bots; no new secrets                                                                                                                                                                     |
| Bot hostnames                    | `<user>.binary-badger.xyz` (sanitized account, same `gcp-lib` derivation), A-record automated in `deploy-gcp.sh`                     | Replaces sslip.io; per-bot Let's Encrypt via the bot's own Caddy (unchanged mechanism, real hostname)                                                                                                                |
| One-time manual step (last ever) | Register `https://auth.binary-badger.xyz/<callback-path>` in the OAuth client                                                        | The single Console visit for the fleet's lifetime                                                                                                                                                                    |

## Architecture

```
                          ┌────────────────────────────────────────────┐
 browser ── sign in ────▶ │ Cloud Run: caddy-security PORTAL           │
          (once)          │  auth.binary-badger.xyz (domain-mapped)    │
                          │  Google OIDC → JWT cookie                  │
                          │  Set-Cookie: domain=binary-badger.xyz      │
                          └────────────────────────────────────────────┘
 browser ── any bot ────▶ koma.binary-badger.xyz  (GCE VM, Caddy 80/443, LE cert)
             cookie sent   │  authorize policy: validate JWT (shared key)
             automatically │  + match email against dashboard-allowlist
                           │  → /api /admin/api /srv exactly as today
                           └─ unauthenticated? 302 → auth.binary-badger.xyz
```

**Flow:** unauthenticated request to a bot → bot's `authorize` 302s to the portal
(`set auth url https://auth.binary-badger.xyz/...`) → Google login (redirect URI
is the portal's own, registered once) → portal sets the domain-wide JWT cookie →
back to the bot → `authorize` validates the JWT + allowlist → in. Every other
`*.binary-badger.xyz` bot now admits the same cookie with no further login.

## Changes by component

### New: `deploy/portal/`

- `Caddyfile.portal` — global: `http_port 8080`, `auto_https off`,
  `order authenticate before respond`, the `security` block (Google OIDC provider
  - `authentication portal` with `cookie domain binary-badger.xyz`,
    `cookie samesite lax`, `crypto key sign-verify {env.JWT_SHARED_KEY}`, **and a
    trusted-redirect rule** — reviewer-confirmed against the AuthCrunch source that
    cross-host `redirect_url` values are IGNORED unless trusted, which would strand
    users on the portal welcome page instead of returning them to the bot. Scope it
    tightly to the fleet domain (suffix match on `binary-badger.xyz`), never a
    permissive wildcard — this directive is exactly the open-redirect guard);
    site `:8080` → `authenticate with myportal`. No authorization policy here.
- `Dockerfile` — tiny portal image: the existing `ao-caddy` base + the portal
  Caddyfile baked in + an **entrypoint that splits the pipe-joined
  `google-oauth-client` secret** into `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`
  (Cloud Run's native secret-env injection can't split; the raw secret is mounted
  and the entrypoint derives the two vars).
- `deploy-portal.sh` — idempotent: `gcloud run deploy ao-auth-portal`
  with `--min-instances=0` **and `--max-instances=1`** (reviewer-confirmed: the
  OAuth `state`/`nonce`/PKCE handshake lives in a per-process in-memory map, so a
  callback landing on a different instance than initiated the dance fails —
  max-instances=1 removes the race; portal traffic is trivial at fleet scale),
  region `us-central1`, secrets wired from Secret Manager; domain-mapping for
  `auth.binary-badger.xyz` + the required DNS records created in the `ao-fleet`
  zone; prints the **one-time** OAuth redirect URI.
- Callback path (reviewer-verified from source): root mount → **no `/auth`
  prefix** — `https://auth.binary-badger.xyz/oauth2/google/authorization-code-callback`.
  Still `caddy validate`-gated at plan time (DSL-drift guard).
- **Domain-verification nuance:** creating the TXT record is automatable via our
  zone, but Search Console _verification itself_ is a once-ever browser step for
  the verifying account — it joins the OAuth-URI registration in the "one-time
  manual" bucket (not claimed as fully automatic).

### Modified: `deploy/Caddyfile.public` (bot side)

- **Remove** the `authentication portal` block and the `handle /auth*` route
  (bots no longer authenticate anyone).
- Authorization policies gain `set auth url https://auth.binary-badger.xyz/...`
  (from env `AO_AUTH_URL`) and keep JWT validation + email-allowlist ACL.
- Multi-email allowlist: the ACL grows to match a **list** (the
  `dashboard-allowlist` secret becomes comma/space-separated). Mechanism (multi-
  value `match email` vs entrypoint-generated ACL rules) pinned at plan time by
  `caddy validate`.

### Modified: `deploy/deploy-gcp.sh` + `deploy/gcp-lib.mjs`

- `create`: derive `<user>.binary-badger.xyz`, create/update the A-record in the
  `ao-fleet` zone → the VM's reserved IP; set `AO_SITE_ADDRESS`/`AO_SITE_URL`/
  `AO_AUTH_URL` in the remote `.env`. Drop the printed per-bot redirect-URI step.
- `destroy`: also delete the bot's A-record (instance-only ethos otherwise
  unchanged; the record is free to recreate).
- `init`: no longer prints a redirect URI (portal owns it).
- **Full sslip sweep:** remove sslip assumptions from _all_ call sites — `init`,
  `create`, `destroy`, **`status`**, and `gcp-lib.mjs` (`sslipHost`/`redirectUri`
  helpers + their tests become `botHost(account)`/fleet equivalents).
- **Same-project assumption stated:** the `ao-fleet` DNS zone lives in the same
  project as the bots (`cloudbet-native`); if bots ever land in another project,
  the DNS calls need a `--dns-project` parameter (not built now).

### Unchanged

- The daemon image/stack, admin backend, Watchtower, secrets fetch via SA,
  quotas + admin visibility, the `valhalla-dev-bot` local skill (still uses the
  local portal mode — local dev doesn't traverse the fleet portal; noted as a
  future alignment item for M8c).

## Security notes

- The JWT cookie is set on the **apex** (`binary-badger.xyz`), wider than the M8
  notes' `.bots.<domain>` sketch — **intentional**: the future broker at
  `api.binary-badger.xyz` (M8b) authenticates with the same session. Consequence:
  any `*.binary-badger.xyz` host receives the cookie → **only fleet-controlled
  services may ever exist under the domain** (we control the zone; hard invariant).
- Cookie flags: `Secure` (default, `cookie insecure off`) + explicit
  `cookie samesite lax`; combined with the fleet-only-subdomains invariant this is
  the CSRF posture for the cookie-authenticated APIs. Token lifetime 3600s = the
  fleet-wide re-login cadence.
- Portal is authentication-only: **any Google account can sign in and mint a
  fleet cookie** — only the bot-side allowlist ACL gates access. This is the
  chosen "portal authenticates, bots authorize" split; optionally add the same
  allowlist at the portal later as defense in depth (keeps strangers off even the
  logged-in portal page).
- `jwt-shared-key` rotation invalidates all sessions fleet-wide (portal + bots
  read the same secret; rotate → restart portal revision + bots).
- Cloud Run ingress: public (it must be, for browsers). **No state post-login**
  (sessions are JWT cookies); the OAuth _handshake_ state is in-memory per
  process, hence the `--max-instances=1` pin above.

## Verification (tiers)

1. **Local/validate:** portal Caddyfile passes `caddy validate` in the portal
   image; bot Caddyfile (retrofitted) passes; unit tests for new `gcp-lib`
   helpers (`botHost(account)`, allowlist parsing if needed).
2. **Portal live (pennies):** `deploy-portal.sh` → `https://auth.binary-badger.xyz`
   serves the login page with a managed cert; `/oauth2/google` 302s to
   `accounts.google.com` with the real client_id — **and assert the `redirect_uri`
   param is `https://auth.binary-badger.xyz/...`** (proves caddy-security built
   its absolute URLs correctly from Cloud Run's `X-Forwarded-*` headers — the
   behind-TLS-proxy pitfall, confirmed handled in-library but verified live).
3. **Fleet live (VM cost, operator-run):** `create` a bot →
   `https://<user>.binary-badger.xyz` has a LE cert; unauthenticated → 302 to the
   portal; sign in once → bot dashboard loads; a **second bot** (or a teammate)
   admits the same session with **zero** Console steps — the M8a acceptance test.
4. `destroy` removes VM + A-record; portal unaffected.

## Risks / open questions

- **Cloud Run domain mapping is Preview** ("not production-ready" per Google —
  acceptable for a login page); managed cert can take up to ~~24h on first issue.
  LB fallback (~~$18/mo serverless NEG) documented if it fights us. Search Console
  domain verification is a once-ever browser step (see the one-time bucket).
- **Cross-host redirects: both directions now specified** — bot→portal via
  `set auth url`, portal→bot via the **trusted-redirect rule** (B1, reviewer-
  verified against source). `caddy validate` remains the DSL authority at plan
  time (M3's drift guard applies).
- **Multi-email ACL mechanics**: multi-value `match email a@x b@y` is supported,
  but `{env.VAR}` won't splat a list — use `{$VAR}` parse-time substitution or
  entrypoint-generated rules; pinned at plan time (validate-gated).
- **Cookie security invariant**: nothing untrusted may ever be hosted under
  `binary-badger.xyz` (README + notes).
- **Local-dev divergence**: the local skill keeps its own portal (localhost
  redirect URI stays on the OAuth client); aligning local dev with the fleet
  portal is an M8c item.
