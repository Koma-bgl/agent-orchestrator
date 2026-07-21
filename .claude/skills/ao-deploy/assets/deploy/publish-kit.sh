#!/usr/bin/env bash
# publish-kit.sh — publish the deploy kit + bootstrap to the fleet kit bucket so
# self-served VMs (vending function) can provision without SSH or repo access.
# Admin-run, idempotent. Re-run after any deploy/ change you want new VMs to get.
#
#   ./publish-kit.sh --project=cloudbet-native
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PROJECT=""; for a in "$@"; do case "$a" in --project=*) PROJECT="${a#--project=}";; esac; done
PROJECT="${PROJECT:-${AO_PROJECT:-$(gcloud config get-value project 2>/dev/null)}}"
[ -n "$PROJECT" ] || { echo "no project (pass --project=)"; exit 1; }
BUCKET="gs://${PROJECT}-ao-kit"
SA="ao-deploy@${PROJECT}.iam.gserviceaccount.com"

# Bucket (idempotent) — uniform access; the ao-deploy SA (VMs + vending fn) reads.
if ! gcloud storage buckets describe "$BUCKET" --project="$PROJECT" >/dev/null 2>&1; then
  echo "==> creating $BUCKET"
  gcloud storage buckets create "$BUCKET" --project="$PROJECT" \
    --location=us-central1 --uniform-bucket-level-access
fi
gcloud storage buckets add-iam-policy-binding "$BUCKET" \
  --member="serviceAccount:$SA" --role="roles/storage.objectViewer" >/dev/null

# Kit tarball: deploy/ minus secrets + local bulk. Never ship .env.
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
tar -czf "$STAGE/kit.tgz" -C "$SCRIPT_DIR" \
  --exclude='.env' --exclude='node_modules' --exclude='kit.tgz' .
STAMP="$(date -u +%Y%m%d-%H%M%S)"

echo "==> publishing kit ($STAMP) + bootstrap to $BUCKET"
gcloud storage cp "$STAGE/kit.tgz" "$BUCKET/kit-$STAMP.tgz"
gcloud storage cp "$STAGE/kit.tgz" "$BUCKET/kit-latest.tgz"
gcloud storage cp "$SCRIPT_DIR/bootstrap-gcs.sh" "$BUCKET/bootstrap-$STAMP.sh"
gcloud storage cp "$SCRIPT_DIR/bootstrap-gcs.sh" "$BUCKET/bootstrap-latest.sh"
echo "✓ published — new self-served VMs boot from kit-latest.tgz"
