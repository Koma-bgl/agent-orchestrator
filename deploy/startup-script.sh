#!/usr/bin/env bash
# GCE startup-script: prepare the VM to run the AO stack. Runs as root on first
# boot (and re-runs on reboot — must be idempotent). It only installs Docker +
# ensures gcloud; the deploy kit is scp'd up and the stack started by
# deploy-gcp.sh over SSH (the deploy branch is unpushed, so nothing to clone).
set -euo pipefail

log() { echo "[startup] $*"; }

# --- Docker Engine + compose plugin (official convenience script; idempotent) ---
if ! command -v docker >/dev/null 2>&1; then
  log "installing Docker…"
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

# --- gcloud (Google's Debian images ship it; install only if absent) ---
if ! command -v gcloud >/dev/null 2>&1; then
  log "installing google-cloud-cli…"
  apt-get update
  apt-get install -y --no-install-recommends google-cloud-cli
fi

# --- deploy kit lands here (deploy-gcp.sh scp's into it) ---
mkdir -p /opt/ao

# Readiness marker deploy-gcp.sh polls for before scp + compose up.
touch /opt/ao/.startup-done
log "ready"
