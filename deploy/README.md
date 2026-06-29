# AO container — local run (M1–M2)

This directory packages Agent Orchestrator as a Docker image you can run on your
laptop with `docker compose up`. It boots the dashboard and loads agent
credentials at startup — no cloud VM required.

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
# edit deploy/.env: set CLAUDE_CODE_OAUTH_TOKEN, GH_TOKEN, (optional) LINEAR_API_KEY
docker compose -f deploy/docker-compose.yml up --build
```

Open <http://localhost:3000>. State persists in the `ao-state` volume.

### How to get each token

| Token | How |
|-------|-----|
| `CLAUDE_CODE_OAUTH_TOKEN` | Run `claude setup-token` locally and paste the long-lived token |
| `GH_TOKEN` | GitHub → Settings → Developer settings → Personal access tokens; scopes `repo` + `workflow` |
| `LINEAR_API_KEY` | Linear → Settings → API → Personal API key (only if you use the Linear tracker) |

> A missing/empty/invalid `CLAUDE_CODE_OAUTH_TOKEN` does **not** crash the
> container — the dashboard still serves; only the agent can't do work until a
> valid token is provided. `/api/version` liveness is independent of token validity.

## gcp source — validate Secret Manager without a VM

This exercises the same code path the GCE VM will use later, but authenticates
with your local Application Default Credentials instead of a VM service account.

```bash
# 1. Authenticate ADC
gcloud auth application-default login

# 2. Create the secrets (repeat for github-pat, linear-api-key)
printf %s "$CLAUDE_CODE_OAUTH_TOKEN" | gcloud secrets create claude-oauth-token \
  --data-file=- --project YOUR_PROJECT

# 3. Point deploy/.env at gcp
#    AO_SECRET_SOURCE=gcp
#    AO_GCP_PROJECT=YOUR_PROJECT

# 4. Run — the ADC volume mount in docker-compose.yml lets the container read it
docker compose -f deploy/docker-compose.yml up --build
```

Logs should show:

```
[entrypoint] secret source: gcp
[entrypoint] loaded claude-oauth-token -> CLAUDE_CODE_OAUTH_TOKEN
```

## Useful commands

```bash
# Liveness
curl -fsS http://localhost:3000/api/version

# Logs (entrypoint secret resolution)
docker compose -f deploy/docker-compose.yml logs ao | grep entrypoint

# Stop (keeps state volume)
docker compose -f deploy/docker-compose.yml down

# Reset everything including persisted state
docker compose -f deploy/docker-compose.yml down -v
```

## Notes

- The image bakes a minimal config (`deploy/default-config/agent-orchestrator.default.yaml`)
  copied into a git-initialized `/workspace/sample`, so `ao start` boots without
  any user config. Wiring your real project(s) comes with the Phase 2 setup skill.
- The container runs `ao start --no-restore` from `$AO_PROJECT_DIR`
  (default `/workspace/sample`).
