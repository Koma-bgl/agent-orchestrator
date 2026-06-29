# AO container — local run (M1–M2)

This directory packages the Agent Orchestrator **Go daemon** as a Docker image
you can run on your laptop with `docker compose up`. It boots `ao daemon`
headless, serves the REST API + `/healthz`, and loads agent credentials at
startup — no cloud VM required.

> **Scope:** TLS, Google sign-in, the `/admin` UI, Watchtower self-update, and
> GCP VM provisioning are **not** in this image yet — they are later milestones
> (M3–M7). This is the "test the setup locally" slice.

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
