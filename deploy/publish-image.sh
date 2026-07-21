#!/usr/bin/env bash
# publish-image.sh — build + push the fleet images so EVERY VM's nightly
# Watchtower picks them up (drain-gated). This is THE fleet-wide release
# path: commit deploy/ changes → run this → all VMs converge within 24h
# (or immediately via each bot's "update now" admin API).
#
#   ./publish-image.sh --project=cloudbet-native
#
# One-time side effects (idempotent): creates the ao-fleet Artifact Registry
# repo and grants the VM runtime SA (ao-deploy@) pull access.
set -euo pipefail
cd "$(dirname "$0")"

PROJECT=""
for a in "$@"; do case "$a" in --project=*) PROJECT="${a#--project=}";; esac; done
[ -n "$PROJECT" ] || { echo "usage: $0 --project=<gcp-project>" >&2; exit 1; }

REGION=us-central1
REPO=ao-fleet
SA="ao-deploy@${PROJECT}.iam.gserviceaccount.com"

if ! gcloud artifacts repositories describe "$REPO" --location="$REGION" --project="$PROJECT" >/dev/null 2>&1; then
  echo "[publish-image] creating Artifact Registry repo ${REPO} (${REGION})…"
  gcloud artifacts repositories create "$REPO" --repository-format=docker \
    --location="$REGION" --project="$PROJECT" \
    --description="AO fleet images (pulled nightly by Watchtower on every bot VM)"
  echo "[publish-image] granting ${SA} pull access…"
  gcloud artifacts repositories add-iam-policy-binding "$REPO" \
    --location="$REGION" --project="$PROJECT" \
    --member="serviceAccount:${SA}" --role="roles/artifactregistry.reader" >/dev/null
fi

echo "[publish-image] submitting Cloud Build (ao + caddy)…"
gcloud builds submit . --config=cloudbuild.yaml --project="$PROJECT"

echo "[publish-image] done — VMs pull ${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/{ao,caddy}:latest"
echo "  nightly: Watchtower 00:00 (drain-gated)   now: POST /admin/api/update on a bot"
