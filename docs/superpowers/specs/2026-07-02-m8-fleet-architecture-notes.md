# M8 — Fleet architecture (working notes, pre-spec)

**Date:** 2026-07-02
**Status:** Direction agreed; full brainstorm/spec pending. Captures decisions made
across the M7 sessions so M8 starts from here, not from scratch.

## The shape (agreed)

```
                    ┌─ Cloud Run: auth portal   auth.<domain>      (stateless SSO gate)
one domain ─────────┼─ Cloud Run: broker        api.<domain>       (VM provisioning + quota)
                    └─ GCE VMs: the bots        <user>.<domain>    (AO daemon + agents)
```

| Component               | Platform            | Why                                                                                                                                                                                                                                                                              |
| ----------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Auth portal**         | Cloud Run           | Stateless (JWT cookies, no server state). One sign-in for the whole fleet; **one OAuth redirect URI registered once, ever** — kills the per-bot Console step. Managed TLS + custom domain; scales to zero (~$0). Replaces per-bot Caddy/Let's Encrypt/sslip.io at the auth tier. |
| **Provisioning broker** | Cloud Run           | The "autoprovisioning" service: creates/destroys per-user bot VMs, enforces quotas **server-side** (users get no direct `compute.instances.create` — this is the non-bypassable version of M7's cooperative quota). Owns the audit trail.                                        |
| **Bots**                | GCE VMs (unchanged) | The AO daemon is stateful and long-lived: SQLite needs a real local disk (network FS = corruption risk), and agents run for hours in tmux — Cloud Run instance recycling would kill them mid-PR. Exactly the workload VMs are for.                                               |

**Explicitly rejected:** bots on Cloud Run (blockers above; only viable via an
upstream AO redesign where agent tasks become Cloud Run Jobs — not a deploy choice).

## Hard requirement: a real domain

Shared SSO = one session cookie on a parent domain (`.bots.<domain>`) that only our
hosts share. sslip.io cannot do this safely (anyone can host under it → cookie
leaks to strangers). ~$10/yr, ideally parked in **Cloud DNS** so per-bot A-records
are fully automated. The domain is the _only_ new prerequisite; everything else
automates once it exists.

## What carries over from M7 (built + live-validated)

- The deploy kit (`deploy/`): daemon image, compose, public-mode Caddyfile — bots
  keep serving their own app tier; only the _auth_ moves to the portal (bot Caddy
  then validates the shared JWT instead of running its own portal — the
  `jwt-shared-key`-from-Secret-Manager and no-hardcoded-cookie-domain choices were
  made for exactly this).
- `deploy-gcp.sh` create/destroy logic → becomes the broker's engine.
- `ao-vm-quotas` doc (with `admin` contact) → the broker's quota source.
- `admin-list` / `admin-audit` → broker endpoints / stay as CLI.
- The `valhalla-dev-bot` skill → grows into the M8 guided setup skill (the
  original product ask).

## Open questions for the M8 brainstorm

1. **The domain** — which one, and is its DNS in Cloud DNS (→ full automation)?
2. Portal implementation: caddy-security image on Cloud Run vs a small purpose-built
   OIDC service. (Cross-host token handoff details decide this.)
3. Broker auth: who may call it (the portal's session? IAM?) and where its audit UI lives.
4. Per-bot TLS on `<user>.<domain>`: Caddy per-VM (as now, needs per-bot A-record)
   vs a shared L7 LB (cost) — leaning per-VM Caddy + Cloud DNS automation.
5. Bot lifecycle economics: idle bots — stop (disk kept, ~$0.65/day) vs destroy
   (recreate via broker). The broker can do scheduled stop/start.
6. When to build: parked until the fleet need is real (more users/bots). Model A
   (M7 as-is) remains livable meanwhile — once-per-user Console step.

## Cost sketch (fleet of N users)

- Portal + broker: ~$0 (scale-to-zero, per-request pennies)
- Domain: ~$10/yr; Cloud DNS zone ~$0.20/mo
- Per bot VM: ~$105/mo running 24/7 (e2-standard-4) — dominates; broker-driven
  stop/start of idle bots is the lever that matters.
