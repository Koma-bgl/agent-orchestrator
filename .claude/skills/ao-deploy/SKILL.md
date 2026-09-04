---
name: ao-deploy
description: Provision, update, verify, or tear down a self-hosted AO fleet VM on GCE. Use when the user wants to create a new bot VM ("new fleet VM", "deploy a bot for <account>"), deploy on behalf of a teammate, redeploy/update the stack on an existing VM, verify a deployment is healthy, or tear one down. Self-contained — the deploy sources are embedded in the skill; works from any directory with no repo or GitHub access.
---

# ao-deploy — fleet VM lifecycle (GCE)

Deploys a bot VM running three containers via docker compose: `ao` (dashboard +
agents + admin + queue-poller), `caddy` (TLS + auth gateway), `watchtower`
(nightly updates, drain-gated). Script verbs: `init | create | destroy | status |
admin-list | admin-audit`, flags `--project=ID [--index=N] [--for=email]`.

## 0. Get the deploy sources (skip if `deploy/deploy-gcp.sh` exists in cwd)

The full deploy tree is **embedded in this skill** at `assets/deploy/` — no
GitHub access needed. Copy it to a writable working dir and run from there:

```bash
DEPLOY_HOME="$HOME/.ao-fleet/deploy"
mkdir -p "$HOME/.ao-fleet"
rsync -a <this-skill-directory>/assets/deploy/ "$DEPLOY_HOME/"
cat <this-skill-directory>/assets/VERSION   # what snapshot you're deploying
cd "$DEPLOY_HOME"
```

If you ARE inside an agent-orchestrator checkout, prefer its `deploy/` (fresher
than the snapshot). All later steps run from the deploy directory.

## Which VM? (resolve this FIRST — never guess)

Every VM is owned by an operator email. Default = the **active gcloud
account**; deploying for a teammate overrides it with `--for=`:

```bash
OPERATOR="${FOR_EMAIL:-$(gcloud auth list --filter=status:ACTIVE --format='value(account)')}"
VM_NAME="$(node gcp-lib.mjs vmName "$OPERATOR")"   # nt@chaostheory.hk -> ao-nt-chaostheory-hk
```

Target `$VM_NAME` and nothing else. **Never** list `ao-*` VMs and pick one:
other operators' bots share the project, and SSHing into someone else's VM
silently adds your key to project SSH metadata. If `$VM_NAME` doesn't exist,
the operator hasn't deployed yet — offer to create it, don't fall back to
another VM.

`--for` rules: only an **admin** passes it, and only to deploy a VM _owned by
the named teammate_. Never pass `--for` with someone else's email to work
around a permission error — it changes whose name goes on the VM, not whose
credentials are used, so it can't fix permissions and risks colliding with
that person's real VM. If you lack GCP permissions, use the self-service
vending endpoint (step 2) — it needs none; escalate to the fleet admin only
if that returns 403 (not allowlisted).

## 1. Preflight

**Self-service create (the default for operators): SKIP this section.** The
vending endpoint needs only an authed `gcloud` — no project ID, no gate
secrets, no local `.env`. Don't ask the operator for a GCP project on that
path. If the vending call returns 403, the ONLY correct move is asking the
fleet admin to allowlist their email — never partial/manual provisioning
(reserving IPs by hand, etc.), which leaves half-created resources.

The checks below apply to the **admin path** (`deploy-gcp.sh`) only:

- `gcloud auth list` — an active account with compute + DNS + Secret Manager
  permissions on the target project (the _deployer's_ perms; the operator
  needs none — see "Deploying for a teammate").
- GCP project — there is no default. Ask which project and pass
  `--project=<id>` on every command.
- **Gate secrets** must exist in the project (Secret Manager):
  `google-oauth-client`, `jwt-shared-key`, `dashboard-allowlist` (and
  optionally `ao-vm-quotas` for per-user VM quotas). The VM generates its own
  `.env` from these at bootstrap — **no local `.env` is needed for a VM
  deploy** (`deploy/.env` is only for running compose locally).
- The operator's email must be in the `dashboard-allowlist` secret, or they
  won't be able to sign in to their own dashboard.

## 2. Create the VM

**Self-service (any operator — no GCP permissions needed).** The fleet vending
function creates YOUR VM (identity comes from your verified Google token, so it
can only ever vend for the caller):

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  https://us-central1-cloudbet-native.cloudfunctions.net/ao_vending-create
```

Responses: `201 provisioning` (VM created; stack self-installs ~10 min — then
open the returned `url`), `200 exists` (you already have one), `403` (only
non-Workspace accounts hit this — chaostheory.hk members are auto-admitted;
others need the admin to allowlist them), `409` (quota reached). After a 201,
skip to step 3 once `https://<host>` responds.

**Admin path (deploy-gcp.sh — needs GCP permissions).** Also how an admin
deploys on a teammate's behalf:

```bash
./deploy-gcp.sh init   --project=<gcp-project> [--for=operator@email]  # once: SA, secret IAM, static IP, firewall
./deploy-gcp.sh create --project=<gcp-project> [--for=operator@email]  # quota check, VM, DNS, stage, bootstrap
./deploy-gcp.sh status --project=<gcp-project> [--for=operator@email]  # URL, quota, instance state
```

Creates VM `ao-<operator>[-N]` (default `e2-standard-4`, `us-central1-a`;
override `AO_ZONE`/`AO_MACHINE_TYPE`), reserves a static IP, writes the DNS
A-record (`<operator>.binary-badger.xyz` in the `ao-fleet` zone), stages
`deploy/` onto the VM, and bootstraps docker compose. Per-operator VM quota
comes from the `ao-vm-quotas` secret (default 1; `--index=N` for extra VMs).

**Sizing rule**: `maxSessions: 1` per e2-standard-4 (16 GB) — one agent build
eats 5–7 GB RAM. Size the VM up before raising `maxSessions`.

## Deploying for a teammate (admin model)

Teammates usually lack GCP permissions — that's fine and by design:

1. Admin adds the operator's email to the `dashboard-allowlist` secret.
2. Admin runs `init` + `create` with `--for=teammate@email` using their own
   gcloud creds. VM name, owner label, hostname, and quota all follow the
   teammate.
3. Send the teammate their dashboard URL (from `status`). They sign in with
   Google, run the setup wizard, and do `gh` / `claude` auth in the wizard's
   setup terminals themselves.

The generated `.env` ships with agent credentials **empty by design** — the
admin never handles the operator's tokens, and the operator never needs
gcloud. SSH access stays admin-only.

## 3. Post-create (operator, via dashboard — no GCP access needed)

1. Open **`https://<host>/setup`** — NOT the bare dashboard URL: a fresh bot's
   dashboard is the stock board with no link to the wizard, so `/setup` is the
   only way in. Sign in with your Google account.
2. The wizard walks through: connect GitHub (device flow) and Claude (setup
   terminals, proxied through Caddy), then configure the project (repo, Linear
   teamId, trigger label + `Ready to start` status) and start the bot.
3. Tokens are stored on the box only (`agent-secrets.env` on the ao-state
   volume) — they never pass through the admin or the deploy machine.

## 4. Verify (after any create or update)

```bash
gcloud compute ssh "$VM_NAME" --zone=us-central1-a --project=<gcp-project> --command='
  sudo docker ps --format "{{.Names}} {{.Status}}"
  sudo docker logs --tail 20 deploy-ao-1 2>&1 | grep queue-poller
  sudo docker exec deploy-ao-1 gh api rate_limit --jq .resources.graphql.remaining'
```

Healthy = 3 containers up; poller active in logs; dashboard reachable over
HTTPS; terminal connects (WS is `:14801 /ws` via the `/terminal-ws*` Caddy
rewrite — NOT `:14800`).

## 5. Update VMs

**Fleet-wide (the default release path — updates EVERY VM, admin-run):**

```bash
./publish-image.sh --project=<gcp-project>   # build + push ao/caddy images to Artifact Registry
```

Every VM's nightly Watchtower (00:00, drain-gated — waits until no session is
working) pulls the new images and recreates. All VMs converge within 24h with
zero SSH. For an immediate update on one bot: `POST /admin/api/update` (the
dashboard's "update now"), same drain gate. Also run `./publish-kit.sh` when
`bootstrap-gcs.sh` / compose files changed, so NEW VMs bootstrap current.

**Single VM, same-day hot fix** — pick the lightest path that ships the change:

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
./deploy-gcp.sh destroy --project=<gcp-project> [--for=operator@email] [--index=N]
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
