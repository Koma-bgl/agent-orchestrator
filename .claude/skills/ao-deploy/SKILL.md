---
name: ao-deploy
description: Provision, update, verify, or tear down a self-hosted AO fleet VM on GCE. Use when the user wants to create a new bot VM ("new fleet VM", "deploy a bot for <account>"), redeploy/update the stack on an existing VM, verify a deployment is healthy, or tear one down. Self-contained — the deploy sources are embedded in the skill; works from any directory with no repo or GitHub access.
---

# ao-deploy — fleet VM lifecycle (GCE)

Deploys a bot VM running three containers via docker compose: `ao` (dashboard +
agents + admin + queue-poller), `caddy` (TLS + auth gateway), `watchtower`
(nightly updates, drain-gated). Reusable by any operator: it does NOT assume
you're inside the agent-orchestrator repo.

## 0. Get the deploy sources (skip if `deploy/deploy-gcp.sh` exists in cwd)

The full deploy tree is **embedded in this skill** at `assets/deploy/` — no
GitHub access needed. Copy it to a writable working dir and run from there
(`.env` and VM state live in the copy, never in the skill folder):

```bash
DEPLOY_HOME="$HOME/.ao-fleet/deploy"
mkdir -p "$HOME/.ao-fleet"
rsync -a <this-skill-directory>/assets/deploy/ "$DEPLOY_HOME/"
cat <this-skill-directory>/assets/VERSION   # what snapshot you're deploying
cd "$DEPLOY_HOME"
```

If you ARE inside an agent-orchestrator checkout, prefer its `deploy/` (it's
fresher than the snapshot). All later steps run from the deploy directory.

## Which VM? (resolve this FIRST — never guess)

Every operator owns exactly the VM named after their **active gcloud
account**. Derive it — do not search for it:

```bash
ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)')"
VM_NAME="$(node gcp-lib.mjs vmName "$ACCOUNT")"        # e.g. nt@chaostheory.hk -> ao-nt-chaostheory-hk
```

All ssh/verify/update/teardown steps target `$VM_NAME` and nothing else.
**Never** list `ao-*` VMs and pick one: other operators' bots live in the same
project, and SSHing into someone else's VM silently adds your key to project
SSH metadata. If `$VM_NAME` doesn't exist, this operator simply hasn't
deployed yet — offer to create it (step 2), don't fall back to another VM.

## 1. Preflight (resolve each ✗ before creating anything)

- `gcloud auth list` — an active account. The VM is named `ao-<account>` from
  this identity, so each operator gets their own VM namespace.
- GCP project — there is no default. Ask the operator which project to use and
  pass it explicitly as `--project=<id>` everywhere.
- `deploy/.env` — if missing, bootstrap it and have the operator fill it in:
  ```bash
  cp .env.example .env
  # Required: GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET (OAuth web client;
  #   redirect URI is printed by deploy-gcp.sh), ALLOWED_EMAIL_1 (their email),
  #   JWT_SHARED_KEY (openssl rand -hex 32), WATCHTOWER_TOKEN (openssl rand -hex 24).
  # Agent credentials (LINEAR_API_KEY etc.) can go here (AO_SECRET_SOURCE=env)
  # or in GCP Secret Manager (AO_SECRET_SOURCE=gcp + AO_GCP_PROJECT).
  ```
  `.env` holds secrets — never commit it, never echo its values.

## 2. Create the VM

```bash
./deploy-gcp.sh up --project=<gcp-project>            # first bot for this account
./deploy-gcp.sh up --project=<gcp-project> --index=2  # additional bot (2..quota)
```

Creates VM `ao-<account>[-N]` (default `e2-standard-4`, `us-central1-a`,
override zone via `AO_ZONE`), reserves a static IP, writes an A-record in the
`ao-fleet` DNS zone, waits for SSH, stages `deploy/` onto the VM, bootstraps
docker compose. Naming/quota logic: `gcp-lib.mjs`.

**Sizing rule**: `maxSessions: 1` per e2-standard-4 (16 GB) — one agent build
eats 5–7 GB RAM. Size the VM up before raising `maxSessions`.

## 3. Post-create (on-box, per-user auth — tokens never leave the box)

The script prints these; walk the operator through them:
1. `gcloud compute ssh ao-<account> --zone=us-central1-a --project=<gcp-project>`
2. Inside the container: `gh auth login` and `claude auth login` (or the
   setup-terminal ttyds on ports 7990/7991 through the dashboard).
3. Open the dashboard (Caddy URL from the script output) and run the setup
   wizard: it writes `agent-orchestrator.yaml` (project, repo, teamId, trigger
   label + `Ready to start` status) via `admin/config-writer.mjs`.

## 4. Verify (after any create or update)

```bash
gcloud compute ssh ao-<account> --zone=us-central1-a --project=<gcp-project> --command='
  sudo docker ps --format "{{.Names}} {{.Status}}"
  sudo docker logs --tail 20 deploy-ao-1 2>&1 | grep queue-poller
  sudo docker exec deploy-ao-1 gh api rate_limit --jq .resources.graphql.remaining'
```
Healthy = 3 containers up; poller logging `starting (interval 30000ms)`;
dashboard reachable over HTTPS; terminal connects (WS is `:14801 /ws` via the
`/terminal-ws*` Caddy rewrite — NOT `:14800`).

## 5. Update an existing VM

Pick the lightest path that ships the change:
- **Poller/admin `.mjs` change only** → hot-swap, zero session impact:
  `gcloud compute scp` the file → `docker cp` into `deploy-ao-1` →
  `node --check` it → `pkill -f queue-poller.mjs` → relaunch:
  `docker exec -d deploy-ao-1 sh -c 'set -a; . /root/.agent-orchestrator/agent-secrets.env; set +a; node /app/admin/queue-poller.mjs >>/proc/1/fd/1 2>&1'`
- **Dockerfile / entrypoint / image change** → needs a container recreate,
  which **kills live agent sessions**. Never recreate manually while sessions
  are working — let Watchtower's nightly (00:00) do it: `drain-check.sh`
  defers the update until no session is working/spawning/stuck.
- State survives recreates on volumes: `ao-state` (config, sessions, repos,
  tokens), `ao-worktrees`, `ao-npm-cache`. PRs/branches are never lost.

## 6. Tear down

```bash
./deploy-gcp.sh down --project=<gcp-project>   # deletes VM + DNS record
```
Confirm with the operator first — on-box auth tokens and any un-pushed session
work are destroyed with the VM.

## Gotchas (hard-won)

- The queue-poller (`admin/queue-poller.mjs`) owns the reliability layer:
  spawn, Linear status write-back, stuck-launch watchdog, `.ao-task.md`
  context sync, PR title normalization, CI-failure relay, auto-merge,
  merged-session reclaim, orphan-tmux reaper. ao's built-in reaction engine
  does NOT dispatch in this deploy — don't rely on it.
- GitHub identity is the on-box `gh` login; a personal token shared with other
  machines will rate-limit the dashboard's PR enrichment. Prefer a dedicated
  machine user / GitHub App per fleet.
- Never `ao spawn` manually on a fleet box — only the poller spawns (tickets
  enter via the Linear trigger column/label).

## Sharing & maintaining this skill

- **Share**: copy this whole directory (including `assets/`) to a teammate's
  `~/.claude/skills/ao-deploy/`. Fully self-contained — the only prerequisite
  on a fresh machine is an authed `gcloud`. No repo or GitHub access needed.
- **Maintain**: the embedded `assets/deploy/` is a snapshot (provenance in
  `assets/VERSION`). After changing the repo's `deploy/` tree, run
  `./sync-assets.sh` (in this skill dir) and commit, so shared copies pick up
  the current stack on their next update.
