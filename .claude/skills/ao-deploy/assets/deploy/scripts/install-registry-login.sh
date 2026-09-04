#!/usr/bin/env bash
# Install the ao-registry-login systemd timer.
#
# Watchtower pulls the fleet images from Artifact Registry using the credentials in
# /root/.docker/config.json (mounted read-only into the container by
# docker-compose.vm.yml). Those are short-lived SA access tokens — they expire in ~1h —
# so a one-shot `docker login` at provisioning time silently stops working an hour
# later and Watchtower never updates the VM again. Observed 2026-09-03: ao-ky and
# ao-nt had been stranded on their 2026-07-21 image for six weeks, failing every
# nightly run with "Unauthenticated request … downloadArtifacts", because only
# bootstrap-gcs.sh installed this timer and both VMs came from deploy-gcp.sh.
#
# Idempotent: safe to re-run on every boot / every provision. Both provisioning
# paths (bootstrap-gcs.sh and deploy-gcp.sh) MUST call this — a VM without the timer
# looks perfectly healthy while quietly refusing every update.
set -euo pipefail

# The login lives in its own script so the unit file needs no nested quoting (this
# whole file is often piped over SSH inside another quoted string).
cat > /usr/local/bin/ao-registry-login <<'SH'
#!/bin/sh
gcloud auth print-access-token | docker login -u oauth2accesstoken --password-stdin https://us-central1-docker.pkg.dev
SH
chmod +x /usr/local/bin/ao-registry-login

cat > /etc/systemd/system/ao-registry-login.service <<'UNIT'
[Unit]
Description=Refresh Docker credentials for the AO fleet Artifact Registry
[Service]
Type=oneshot
ExecStart=/usr/local/bin/ao-registry-login
UNIT

cat > /etc/systemd/system/ao-registry-login.timer <<'UNIT'
[Unit]
Description=Keep AO registry credentials fresh (SA tokens expire hourly)
[Timer]
OnBootSec=2min
OnUnitActiveSec=45min
[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now ao-registry-login.timer
# Log in right now too: the timer's first OnBootSec fire is 2 min out, but the
# caller is about to `compose pull`.
systemctl start ao-registry-login.service || true
