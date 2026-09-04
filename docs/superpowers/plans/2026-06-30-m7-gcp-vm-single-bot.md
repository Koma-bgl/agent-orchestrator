# M7 — GCP VM (single public bot, sslip.io) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provision the AO stack as a **public, Google-gated bot on a GCE VM** reachable at `https://<reserved-ip>.sslip.io`, with idempotent `create`/`destroy` (delete-often friendly), **max 1 VM per user**, and all config fetched on the VM from Secret Manager via its attached service account.

**Architecture:** `deploy-gcp.sh` (operator-run, uses the operator's gcloud) provisions: a per-user **reserved static IP** + **service account** + **firewall** (one-time `init`), then a VM (`create`) named deterministically per user. Because the deploy branch is **unpushed**, `create` **`scp`s the local `deploy/` dir to the VM** and runs the stack there (the image installs the `ao` binary via npm — no source build needed). The VM's startup-script installs Docker + gcloud; the stack runs in **public mode** (Caddy on 80/443, auto-TLS for the sslip.io host) via a `docker-compose.vm.yml` override. `destroy` deletes **only the instance**; the IP/SA/secrets/firewall persist so recreate is cheap.

**Tech Stack:** `gcloud` (compute, IAM, secrets), GCE Debian VM, Docker + compose, Caddy auto-TLS, sslip.io, bash.

> **Cost/verification note:** actually creating a VM costs money (≈e2-standard-4). This plan's automated verification is **syntax + dry-validation only** (`bash -n`, `shellcheck` if present, `docker compose config`, `caddy validate` on the public Caddyfile, unit tests for the pure helpers). The **real `init`→`create`→sign-in→`destroy`** is an **operator-run runbook** (Task 7), executed when the operator chooses to spend.

> **Model-B compatibility (future fleet SSO, M8):** keep `jwt-shared-key` sourced from Secret Manager (shared) and do **not** hardcode a cookie domain — M7 uses a host-only cookie (single host), M8 will switch to `.<domain>` + a central portal. Nothing here should block that.

### Key decisions (resolved in brainstorming)

- **Hostname:** `<ip-dashed>.sslip.io` off a **reserved** static IP (stable across recreate). DNS automation deferred (sslip.io needs none).
- **Max 1/user:** deterministic VM name `ao-<sanitized-account>` + label `ao-owner=<account>`; `create` refuses if one exists.
- **Ephemeral:** `destroy` = instance only; IP/SA/secrets/firewall persist.
- **Deploy delivery:** `scp` the local `deploy/` (branch unpushed). Upgrade path (push/clone or pull ghcr `:stable`) noted, not built.
- **Secrets:** the 3 gate secrets fetched **on the VM** via the SA (metadata → gcloud). Agent creds remain **on-box** (operator `gh auth login` / `claude setup-token` via SSH after sign-in).
- **One-time manual:** add `https://<ip>.sslip.io/auth/oauth2/google/authorization-code-callback` to the OAuth client (printed by `init`).

### File structure

- Create `deploy/deploy-gcp.sh` — `init | create | destroy | status` (+ pure helpers).
- Create `deploy/deploy-gcp.test.mjs` — unit tests for the pure helpers (sanitize, ip→host).
- Create `deploy/startup-script.sh` — VM boot: install Docker + gcloud.
- Create `deploy/Caddyfile.public` — public mode (80/443, auto-TLS, no `tls internal`).
- Create `deploy/docker-compose.vm.yml` — override: caddy 80/443, mount `Caddyfile.public`, public env.
- Modify `deploy/README.md` — M7 runbook.

---

## Task 1: Pure helpers + tests (TDD)

**Files:** Create `deploy/deploy-gcp.test.mjs`; create `deploy/deploy-gcp.sh` (helpers section sourced/echoed for test).

The name/host derivation is error-prone, so extract it as a tiny testable shell function set and mirror it in a Node test via `execFileSync('bash', ['-c', ...])`, OR (simpler) put the pure logic in a `deploy/gcp-lib.mjs` and have `deploy-gcp.sh` call `node gcp-lib.mjs <fn> <arg>`. **Use the `gcp-lib.mjs` approach** (testable, no bash-quoting pain).

- [ ] **Step 1: Write failing tests** (`deploy/gcp-lib.test.mjs`):

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { vmName, ownerLabel, sslipHost, redirectUri } from "./gcp-lib.mjs";

test("vmName sanitizes a gcloud account to a valid GCE name", () => {
	assert.equal(vmName("ky@chaostheory.hk"), "ao-ky-chaostheory-hk");
	// GCE names: lowercase, [a-z0-9-], start with a letter, <=63 chars
	assert.match(vmName("A.B+C@x"), /^ao-[a-z0-9-]+$/);
});
test("ownerLabel is gcloud-label-safe", () => {
	assert.match(ownerLabel("ky@chaostheory.hk"), /^[a-z0-9_-]+$/);
});
test("sslipHost turns an IP into a dashed sslip.io host", () => {
	assert.equal(sslipHost("34.12.34.56"), "34-12-34-56.sslip.io");
});
test("redirectUri builds the OAuth callback for the host", () => {
	assert.equal(
		redirectUri("34-12-34-56.sslip.io"),
		"https://34-12-34-56.sslip.io/auth/oauth2/google/authorization-code-callback",
	);
});
```

- [ ] **Step 2: Run — expect FAIL.** `node --test deploy/gcp-lib.test.mjs`
- [ ] **Step 3: Implement `deploy/gcp-lib.mjs`** with `vmName`, `ownerLabel`, `sslipHost`, `redirectUri`, plus a tiny CLI tail (`if invoked as main: print fn(arg)`) so bash can call `node gcp-lib.mjs sslipHost 1.2.3.4`. GCE name rules: lowercase, replace non-`[a-z0-9-]` with `-`, collapse repeats, trim to 63, ensure leading letter (the `ao-` prefix guarantees it).
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** (`feat(deploy): gcp-lib pure helpers (TDD)`).

---

## Task 2: `deploy-gcp.sh init` (one-time persistent resources)

**Files:** Create `deploy/deploy-gcp.sh`

- [ ] **Step 1: Implement the script skeleton + `init`.** `set -euo pipefail`. Resolve `PROJECT` (`--project` | `$AO_PROJECT` | `gcloud config get-value project`), `ACCOUNT` (`gcloud config get-value account`), `REGION`/`ZONE` (defaults `us-central1`/`us-central1-a`, overridable). Derive `SA="ao-deploy@<project>.iam.gserviceaccount.com"`, IP name `ao-<sanitized>-ip`.

  `init` is **idempotent** and does:
  1. Ensure SA exists (`gcloud iam service-accounts describe || create`).
  2. Grant the SA `roles/secretmanager.secretAccessor` + `roles/secretmanager.secretVersionAdder` on the **3 gate secrets** (per-secret bindings, secure default — not project-wide).
  3. Reserve the static IP (`gcloud compute addresses describe <ip-name> --region || create`). Read its address.
  4. Ensure a firewall rule `ao-allow-web` allowing tcp:80,443 to target tag `ao-bot` (describe || create).
  5. Compute `HOST=$(node gcp-lib.mjs sslipHost <ip>)` and print the **one-time OAuth redirect URI** + the Console credentials link.

- [ ] **Step 2: Validate** `bash -n deploy/deploy-gcp.sh`; `shellcheck deploy/deploy-gcp.sh` if available (fix warnings).
- [ ] **Step 3: Commit** (`feat(deploy): deploy-gcp.sh init — IP/SA/IAM/firewall`).

---

## Task 3: Public-mode stack config

**Files:** Create `deploy/Caddyfile.public`, `deploy/docker-compose.vm.yml`

- [ ] **Step 1: `Caddyfile.public`** — copy `deploy/Caddyfile` and **remove** the local-only bits: drop `http_port 8080` / `https_port 8443` (use default 80/443) and drop `tls internal` (Caddy auto-provisions Let's Encrypt for `{$AO_SITE_ADDRESS}`). Everything else (security block, the `/auth* / /api/* / /admin/api/* / SPA` handles) is identical.

- [ ] **Step 2: `docker-compose.vm.yml`** (override on top of the base file).
      **⚠️ Compose merges `ports`/`volumes` lists by APPENDING, not replacing** — a naive
      override would publish `8443` _and_ `80/443`, and mount **two** Caddyfiles at
      `/etc/caddy/Caddyfile`. Use the Compose **`!override` tag** to REPLACE the whole
      list (requires a modern compose plugin — the VM installs latest):
  - `caddy.ports`: `!override ["80:80", "443:443"]`
  - `caddy.volumes`: `!override` re-listing **all** caddy mounts with the public
    Caddyfile: `./Caddyfile.public:/etc/caddy/Caddyfile:ro`, `./web:/srv:ro`,
    `caddy-data:/data`, `caddy-config:/config`.
  - `caddy.environment`: `AO_SITE_ADDRESS=${AO_SITE_ADDRESS}`, `AO_SITE_URL=https://${AO_SITE_ADDRESS}` (map-merge is fine; the sslip.io host is supplied by `create`).
  - (`ao`/`watchtower` services need no override.)

- [ ] **Step 3: Validate** the public Caddyfile against the custom image (dummy env, `AO_SITE_ADDRESS=test.example.com`): `caddy validate` → `Valid configuration`. Then validate the merge produces the REPLACED lists (not appended): `docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.vm.yml config` and confirm caddy shows **only** `80`/`443` published (no `8443`) and **exactly one** `/etc/caddy/Caddyfile` mount (the public one). If `8443` or a double-mount appears, the `!override` tags aren't taking — fix before proceeding.
- [ ] **Step 4: Commit** (`feat(deploy): public-mode Caddyfile + VM compose override`).

---

## Task 4: `startup-script.sh`

**Files:** Create `deploy/startup-script.sh`

- [ ] **Step 1: Implement** — runs as root on first boot. `set -euo pipefail`. Install Docker Engine + compose plugin (official convenience script or apt), enable the service, and ensure `gcloud` is present (Google Debian images ship the CLI; otherwise `apt-get install -y google-cloud-cli`). Create `/opt/ao` for the deploy kit. **Idempotent** (guard each install). It does NOT fetch secrets or start the stack — that's driven by `create` over SSH (Task 5), so the kit (unpushed) can be `scp`ed up first.
- [ ] **Step 2: Validate** `bash -n deploy/startup-script.sh` (+ shellcheck).
- [ ] **Step 3: Commit** (`feat(deploy): VM startup-script — docker + gcloud`).

---

## Task 5: `create` / `destroy` / `status`

**Files:** Modify `deploy/deploy-gcp.sh`

- [ ] **Step 1: `create`** (idempotent, enforces max-1):
  1. **Max-1 check:** `gcloud compute instances list --filter="labels.ao-owner=<label>"` — if a VM exists, print it + its URL and exit non-zero ("you already have a bot; `destroy` first").
  2. Require `init` ran: the reserved IP must exist (else tell them to run `init`).
  3. Create the VM: name `ao-<sanitized>`, `--zone`, `--machine-type=${AO_MACHINE_TYPE:-e2-standard-4}`, `--address=<reserved-ip>`, `--service-account=<SA>`, `--scopes=cloud-platform`, `--tags=ao-bot`, `--labels=ao-owner=<label>`, `--metadata-from-file=startup-script=deploy/startup-script.sh`, a Debian image.
  4. **Wait for SSH** (`gcloud compute ssh … --command=true` retry loop) and for the startup-script to finish (poll for docker ready).
  5. **`scp` the kit:** `gcloud compute scp --recurse deploy/ <vm>:/opt/ao/` (the unpushed branch's files).
  6. **Remote bring-up over SSH:** on the VM, fetch the 3 gate secrets via the SA and write `/opt/ao/deploy/.env`. Use the metadata token + Secret Manager REST (or `gcloud secrets versions access`), parse `google-oauth-client` `id|secret`, generate `WATCHTOWER_TOKEN`, set `AO_SITE_ADDRESS=<host>`, `AO_SITE_URL=https://<host>`, agent tokens empty. Then `docker compose -f docker-compose.yml -f docker-compose.vm.yml up -d --build` from `/opt/ao/deploy`.
  7. Print the URL `https://<host>` + reminder to add the redirect URI (if not done) and to `gh auth login`/`claude setup-token` via SSH.

- [ ] **Step 2: `destroy`** — `gcloud compute instances delete ao-<sanitized> --zone --quiet` (idempotent: succeed if already absent). Explicitly **does not** touch the IP/SA/secrets/firewall. Print confirmation that recreate is cheap.

- [ ] **Step 3: `status`** — show the user's VM (if any), its external IP, the sslip.io URL, and whether it's running.

- [ ] **Step 4: Validate** `bash -n` + shellcheck. (No live create here — that's Task 7.)
- [ ] **Step 5: Commit** (`feat(deploy): deploy-gcp.sh create/destroy/status`).

---

## Task 6: README — M7 runbook

**Files:** Modify `deploy/README.md`

- [ ] **Step 1: Add an "M7: deploy to a GCE VM (single public bot)" section:** prerequisites (gcloud authed, the 3 gate secrets exist — point at valhalla-dev-bot's `check`); the flow `init` (one-time: reserve IP, print the redirect URI to add to the OAuth client) → `create` → open `https://<ip>.sslip.io` → sign in → SSH in for `gh auth login`/`claude setup-token` → `destroy` when done; the cost note; the max-1 rule; that `destroy` keeps IP/secrets so recreate is cheap; the unpushed-branch `scp` delivery + the future push/`:stable` upgrade.
- [ ] **Step 2: Commit** (`docs(deploy): M7 GCE VM runbook`).

---

## Task 7: Operator-run live provision (the real test — costs money)

Not automated (spends real GCP money); run by the operator when ready. Documented acceptance:

- [ ] `node --test deploy/gcp-lib.test.mjs` green; `bash -n` clean on both scripts; `caddy validate` ok on `Caddyfile.public`; `docker compose … config` ok with the override.
- [ ] `deploy-gcp.sh init` reserves the IP and prints the redirect URI; operator adds it to the OAuth client (once).
- [ ] `deploy-gcp.sh create` brings up the VM; `https://<ip>.sslip.io` serves a **valid Let's Encrypt cert** and redirects unauthenticated users to Google.
- [ ] An allowlisted Google account signs in and reaches the dashboard; a second `create` is **refused** (max-1).
- [ ] After SSH `gh auth login` + `claude setup-token`, a spawned session does real agent work.
- [ ] `deploy-gcp.sh destroy` removes the instance; `create` again reuses the same IP/host/redirect with no re-setup.

---

## Done criteria

- `deploy/`: `deploy-gcp.sh` (`init`/`create`/`destroy`/`status`), `gcp-lib.mjs` (+ tests), `startup-script.sh`, `Caddyfile.public`, `docker-compose.vm.yml`, README runbook.
- Helpers unit-tested; scripts pass `bash -n`/shellcheck; public Caddyfile validates; override merges.
- `create` enforces max-1 and is idempotent; `destroy` is instance-only and idempotent; reserved IP/SA/secrets persist.
- Secrets fetched on the VM via the SA; agent creds remain on-box.
- Live provision is a documented operator runbook (Task 7), Model-B-compatible for the M8 fleet.

## Out of scope (→ M8 fleet)

Central auth portal, per-user subdomains, shared-SSO cookie, Cloud DNS automation, real-domain TLS, pulling prebuilt `:stable` (vs scp). M7 is the reusable single-bot foundation.
