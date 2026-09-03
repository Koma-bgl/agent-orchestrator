#!/usr/bin/env bash
# bootstrap-gcs.sh — self-bootstrap the AO stack on a fresh VM from the kit
# bucket. Published to gs://<project>-ao-kit/bootstrap-latest.sh by
# publish-kit.sh; fetched + run by the vending function's tiny startup-script
# loader (cloudbetnative functions/src/ao_vending). Replaces deploy-gcp.sh's
# scp/SSH provisioning for self-served VMs — nobody SSHes at all.
#
# Inputs (env, set by the loader): AO_HOST, AO_KIT (gs:// tarball), AO_PROJECT.
# Idempotent: re-runs on every boot; a running stack makes this a no-op.
set -euo pipefail
log() { echo "[ao-bootstrap] $*"; }

: "${AO_HOST:?AO_HOST required}"; : "${AO_KIT:?AO_KIT required}"; : "${AO_PROJECT:?AO_PROJECT required}"

# --- Docker Engine + compose plugin (idempotent, mirrors startup-script.sh) ---
if ! command -v docker >/dev/null 2>&1; then
  log "installing Docker…"
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

# --- kit: fetch + extract (fresh copy each boot; state lives in volumes) ---
mkdir -p /opt/ao
log "fetching kit $AO_KIT…"
gcloud storage cp "$AO_KIT" /opt/ao/kit.tgz
rm -rf /opt/ao/deploy
mkdir -p /opt/ao/deploy
tar -xzf /opt/ao/kit.tgz -C /opt/ao/deploy
cd /opt/ao/deploy

# --- .env from Secret Manager (VM runs as the ao-deploy SA = secretAccessor).
# Generate ONCE: a reboot must not rotate WATCHTOWER_TOKEN or clobber values the
# operator may have adjusted. Mirrors deploy-gcp.sh remote_up_script exactly.
if [ ! -f .env ]; then
  log "generating .env from gate secrets…"
  sec() { gcloud secrets versions access latest --secret="$1" --project="$AO_PROJECT"; }
  JWT="$(sec jwt-shared-key)"
  # Fleet allowlist + this VM's owner: a domain-vended operator (not in the
  # central secret) must still be able to sign in to their OWN dashboard.
  ALLOW="$(sec dashboard-allowlist | tr ',\n' '  ') ${AO_OWNER:-}"
  WT="$(openssl rand -hex 24 2>/dev/null || head -c24 /dev/urandom | xxd -p)"
  cat > .env <<ENV
AO_SECRET_SOURCE=env
JWT_SHARED_KEY=${JWT}
ALLOWED_EMAILS=${ALLOW}
# Agent creds — EMPTY on purpose: the operator fills these on-box via the setup
# wizard; the vending path never handles anyone's tokens.
GITHUB_TOKEN=
LINEAR_API_KEY=
ANTHROPIC_API_KEY=
CLAUDE_CODE_OAUTH_TOKEN=
AO_SITE_ADDRESS=${AO_HOST}
AO_SITE_URL=https://${AO_HOST}
AO_AUTH_URL=https://auth.binary-badger.xyz/
GITHUB_OAUTH_CLIENT_ID=${GH_OAUTH_CLIENT_ID:-}
WATCHTOWER_TOKEN=${WT}
ENV
else
  log ".env exists — keeping it"
fi

# --- Artifact Registry auth: images come from the fleet registry so nightly
# Watchtower can actually pull updates (a locally-built image never updates).
# SA access tokens live ~1h, so a systemd timer re-logins every 45 min — the
# watchtower container reads the mounted /root/.docker (see compose.vm). The unit
# install is shared with deploy-gcp.sh; keeping it in one script is what stops a
# provisioning path from silently shipping a VM that can never update itself.
registry_login() {
  gcloud auth print-access-token 2>/dev/null \
    | docker login -u oauth2accesstoken --password-stdin https://us-central1-docker.pkg.dev >/dev/null 2>&1
}
bash /opt/ao/deploy/scripts/install-registry-login.sh

log "starting the stack…"
# Registry-first: pull the fleet images so this VM runs (and Watchtower tracks)
# the published build. Fall back to a local build if the registry is empty or
# unreachable — the build tags the same registry ref, so Watchtower converges
# it once images are published.
if registry_login && docker compose -f docker-compose.yml -f docker-compose.vm.yml pull ao caddy; then
  docker compose -f docker-compose.yml -f docker-compose.vm.yml up -d --no-build
else
  log "registry pull failed — building locally (Watchtower converges later)"
  docker compose -f docker-compose.yml -f docker-compose.vm.yml up -d --build
fi
touch /opt/ao/.startup-done
log "done — https://${AO_HOST}"
