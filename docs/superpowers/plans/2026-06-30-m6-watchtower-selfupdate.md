# M6 — Watchtower self-update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Watchtower service that auto-updates the AO stack (`ao` + `caddy`) from the registry on a midnight cron — pulling `:stable`, recreating the containers, and pruning old images — with its HTTP update API enabled so M5's "update now" can trigger it on demand.

**Architecture:** A label-scoped `containrrr/watchtower` container with the Docker socket mounted (required to recreate sibling containers). It runs on a 6-field cron schedule and also exposes an internal-only HTTP API (token-guarded) for on-demand updates. Only containers labelled `com.centurylinklabs.watchtower.enable=true` (the `ao` and `caddy` services) are watched; Watchtower does not update itself.

**Tech Stack:** `containrrr/watchtower` (pinned), docker compose, Docker socket.

> **Scope (M6):** scheduled + on-demand image self-update of the running stack. NOT in scope: the admin UI/backend that calls the update API (M5), secret-rotation restarts (M5), the GCP VM (M7), the setup skill (M8).

> **Verification reality:** locally the stack runs `:dev` images that are not in any registry, so Watchtower has nothing to pull — the mechanics tier verifies Watchtower **starts, picks up the schedule, watches exactly the `ao`+`caddy` containers, and a forced `--run-once` completes gracefully** (reporting no update for local images, not crashing). The real "push a new `:stable` → containers swap" is a registry/VM-tier test, documented for M7.

---

### Grounding facts (verified)

- M1–M4 committed: `deploy/docker-compose.yml` has `ao` (image `ao-local:dev`, `init: true`, `expose: 8080`, `restart: unless-stopped`) and `caddy` (image `ao-caddy:dev`, publishes `8443`, mounts Caddyfile + `./web` + data volumes, `restart: unless-stopped`); top-level `volumes:` has `ao-state`, `caddy-data`, `caddy-config`.
- On the deployed VM the images will be `ghcr.io/composiohq/agent-orchestrator:stable` (the publish workflow tags `:stable`). Watchtower watches whatever image tag the running container uses, so on the VM it watches `:stable`.
- Watchtower's schedule is a **6-field cron** (`sec min hr dom mon dow`); `"0 0 0 * * *"` = 00:00:00 daily.
- Watchtower's HTTP API listens on container port **8080**; `--http-api-update` enables the on-demand `/v1/update` endpoint (token via `WATCHTOWER_HTTP_API_TOKEN`). To keep the schedule running *and* enable the API, set `WATCHTOWER_HTTP_API_PERIODIC_POLLS=true`.
- `--label-enable` restricts Watchtower to containers labelled `com.centurylinklabs.watchtower.enable=true`; `--cleanup` removes the old image after an update.

### File structure

- Modify `deploy/docker-compose.yml` — label `ao` + `caddy`; add the `watchtower` service.
- Modify `deploy/.env.example` — add `WATCHTOWER_TOKEN`.
- Modify `deploy/README.md` — M6 self-update section (behavior, schedule, docker-socket trust boundary, local limits).

---

## Task 1: Label the watched services

**Files:**
- Modify: `deploy/docker-compose.yml`

- [ ] **Step 1: Add the watchtower-enable label to `ao` and `caddy`**

Add to BOTH the `ao` and `caddy` services:

```yaml
    labels:
      com.centurylinklabs.watchtower.enable: "true"
```

- [ ] **Step 2: Validate compose**

Run: `cd deploy && docker compose config >/dev/null && echo OK`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add deploy/docker-compose.yml
git commit -m "feat(deploy): label ao + caddy for watchtower"
```

---

## Task 2: Add the Watchtower service

**Files:**
- Modify: `deploy/docker-compose.yml`

- [ ] **Step 1: Add the `watchtower` service**

```yaml
  watchtower:
    image: containrrr/watchtower:1.7.1
    restart: unless-stopped
    volumes:
      # Required: Watchtower recreates sibling containers via the Docker API.
      # This is root-equivalent on the host — the documented trust boundary.
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      # 6-field cron (sec min hr dom mon dow) = 00:00:00 daily.
      WATCHTOWER_SCHEDULE: "0 0 0 * * *"
      # Only touch containers we labelled; never update Watchtower itself.
      WATCHTOWER_LABEL_ENABLE: "true"
      # Remove the old image after a successful update.
      WATCHTOWER_CLEANUP: "true"
      # On-demand update API (M5 "update now" calls this); keep the schedule too.
      WATCHTOWER_HTTP_API_UPDATE: "true"
      WATCHTOWER_HTTP_API_TOKEN: ${WATCHTOWER_TOKEN:-changeme-local}
      WATCHTOWER_HTTP_API_PERIODIC_POLLS: "true"
    # API on container :8080 — exposed to the compose network for M5 only,
    # NOT published to the host.
    expose:
      - "8080"
```

- [ ] **Step 2: Validate compose**

Run: `cd deploy && docker compose config >/dev/null && echo OK`
Expected: `OK`.

- [ ] **Step 3: Confirm Watchtower's API port is not published**

Run: `cd deploy && docker compose config | grep -A3 -i 'published'`
Expected: only Caddy's `8443` appears as published — Watchtower's `8080` is `expose` only.

- [ ] **Step 4: Commit**

```bash
git add deploy/docker-compose.yml
git commit -m "feat(deploy): add Watchtower — midnight self-update + on-demand API"
```

---

## Task 3: .env.example — Watchtower token

**Files:**
- Modify: `deploy/.env.example`

- [ ] **Step 1: Append**

```bash
# --- M6: Watchtower self-update ---
# Token guarding Watchtower's on-demand update API (used by M5 "update now").
# Generate: openssl rand -hex 24
WATCHTOWER_TOKEN=
```

- [ ] **Step 2: Commit**

```bash
git add deploy/.env.example
git commit -m "docs(deploy): add WATCHTOWER_TOKEN env var"
```

---

## Task 4: README — self-update section

**Files:**
- Modify: `deploy/README.md`

- [ ] **Step 1: Add an "M6: self-update" section** covering:
  - Watchtower checks the registry nightly (00:00) and, when a new `:stable` is published, pulls it, recreates `ao`/`caddy`, and prunes the old image — no operator action.
  - It only watches the labelled `ao`/`caddy` containers and never updates itself.
  - **Trust boundary:** Watchtower mounts the Docker socket (required to recreate containers) — root-equivalent on the host; acceptable for a single-tenant self-host box, called out explicitly.
  - The on-demand HTTP API (token-guarded, internal-only) is the hook M5's "update now" will call.
  - **Local note:** with locally-built `:dev` images (no registry), Watchtower has nothing to pull; the real swap happens on the VM where the images are `:stable` from ghcr.
  - **Maintenance note:** `containrrr/watchtower` was archived upstream (Dec 2025); `1.7.1` is the final release — the pin is stable but won't get future fixes. Revisit (e.g. a maintained fork) if that becomes a concern.

- [ ] **Step 2: Commit**

```bash
git add deploy/README.md
git commit -m "docs(deploy): document Watchtower self-update + trust boundary"
```

---

## Task 5: Live verification (mechanics tier)

- [ ] **Step 1: Bring up the stack incl. Watchtower**

```bash
cd deploy
docker compose up -d 2>&1 | tail -5
sleep 6
docker compose ps --format '{{.Name}}: {{.Status}}'
```
Expected: `ao` healthy, `caddy` up, `watchtower` up.

- [ ] **Step 2: Watchtower scheduled + watching the right containers**

```bash
docker compose logs --no-color watchtower | tail -20
```
Expected: logs show it started, the **schedule / next run** time, and that it is **watching 2 containers** (ao + caddy) — not watchtower itself. No fatal errors.

- [ ] **Step 3: Forced run-once completes gracefully**

```bash
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  containrrr/watchtower:1.7.1 --run-once --label-enable 2>&1 | tail -20
```
Expected: it inspects the labelled containers and reports **no update / unable to resolve registry for the local `:dev` images** — gracefully (exit without crash). This proves the mechanism runs; the actual pull is a registry-tier behavior. (Acceptable outcomes: "Found 0 containers to update" / "no registry" / "Session done" — what matters is it does not crash and does not tear down the running stack.)

- [ ] **Step 4: Running stack undisturbed**

```bash
docker compose ps --format '{{.Name}}: {{.Status}}'
curl -sk -o /dev/null -w "caddy 8443 -> HTTP %{http_code}\n" https://localhost:8443/
```
Expected: `ao`/`caddy` still up; Caddy still answers (302). Watchtower's run-once did not disrupt the stack.

- [ ] **Step 5: (optional) On-demand API reachable from the compose network**

```bash
# From the caddy container (a compose-network sibling), the API requires the token:
docker compose exec -T caddy sh -c 'wget -qO- --header="Authorization: Bearer ${WATCHTOWER_TOKEN:-changeme-local}" http://watchtower:8080/v1/update 2>&1 | head -3 || echo "(api reachable check)"'
```
Expected: best-effort **reachability probe only** (is `watchtower:8080` reachable on the compose net) — NOT an auth-success check: `${WATCHTOWER_TOKEN}` expands in the caddy shell where it's likely unset, falling back to `changeme-local`, which matches the watchtower default only when no real token is set. A 401 here is fine; M5 will own the real authenticated call. Non-blocking.

- [ ] **Step 6: Tear down**

```bash
docker compose down
```

---

## Done criteria (M6, mechanics tier)

- `docker compose config` valid; `ao`/`caddy` labelled; `watchtower` service added.
- Watchtower's API port (`8080`) is **not** published; only Caddy's `8443` is.
- Watchtower starts, picks up the midnight schedule, and watches exactly the `ao`+`caddy` containers (not itself).
- A forced `--run-once` completes gracefully (no update for local images, no crash) and leaves the running stack intact.
- README documents the self-update behavior, the Docker-socket trust boundary, the on-demand API (for M5), and the local-vs-registry testing note.
- Real "new `:stable` → swap" is documented as a registry/VM-tier test (M7).
