#!/usr/bin/env bash
# Install the ao-docker-prune systemd timer: weekly `docker image prune -a` +
# `docker builder prune -a` on the VM host.
#
# Nothing else reclaims host-side Docker disk. Watchtower (WATCHTOWER_CLEANUP) only
# removes the image it just replaced; a `compose up --build` at provision time leaves
# build cache behind, and any hand-built/tagged image stays forever. Observed
# 2026-09-04: ao-ky at 100% of its 50GB disk with 5.7GB of unused images + 5.6GB of
# build cache that nothing would ever touch.
#
# Safe for running work: image/builder prune never touch a running container, its
# image, or any volume (worktrees, npm cache, ao state live in volumes and are
# governed by the queue-poller's reclaim + disk-pressure gate instead).
#
# Idempotent: safe to re-run on every boot / every provision. Both provisioning
# paths (bootstrap-gcs.sh and deploy-gcp.sh) call this.
set -euo pipefail

cat > /usr/local/bin/ao-docker-prune <<'SH'
#!/bin/sh
docker image prune -af
docker builder prune -af
SH
chmod +x /usr/local/bin/ao-docker-prune

cat > /etc/systemd/system/ao-docker-prune.service <<'UNIT'
[Unit]
Description=Reclaim unused Docker images and build cache on the AO fleet VM
[Service]
Type=oneshot
ExecStart=/usr/local/bin/ao-docker-prune
UNIT

cat > /etc/systemd/system/ao-docker-prune.timer <<'UNIT'
[Unit]
Description=Weekly Docker image/build-cache prune (AO fleet)
[Timer]
OnCalendar=weekly
Persistent=true
RandomizedDelaySec=1h
[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now ao-docker-prune.timer
