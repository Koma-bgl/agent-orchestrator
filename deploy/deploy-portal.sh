#!/usr/bin/env bash
# deploy-portal.sh — deploy the fleet SSO portal to Cloud Run at
# https://auth.binary-badger.xyz (idempotent; safe to re-run for updates).
#
# One-time steps it may ask of you (once EVER for the fleet):
#   1. Search Console domain verification (if domain mapping demands it).
#   2. Registering the portal's OAuth redirect URI in the Google Console.
#
# The caller needs roles/iam.serviceAccountUser on the ao-deploy SA to deploy
# with --service-account (a project owner has it implicitly).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PROJECT=""; for a in "$@"; do case "$a" in --project=*) PROJECT="${a#--project=}";; esac; done
PROJECT="${PROJECT:-${AO_PROJECT:-$(gcloud config get-value project 2>/dev/null)}}"
[ -n "$PROJECT" ] || { echo "no project (pass --project= or set one with gcloud)"; exit 1; }
REGION="${AO_REGION:-us-central1}"
SERVICE="ao-auth-portal"
SA="ao-deploy@${PROJECT}.iam.gserviceaccount.com"
AUTH_HOST="$(node "$SCRIPT_DIR/gcp-lib.mjs" authHost)"
ZONE_NAME="ao-fleet"

echo "==> enabling required APIs (idempotent)"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  --project="$PROJECT"

echo "==> deploying $SERVICE to Cloud Run ($REGION) from source"
# --max-instances=1 is LOAD-BEARING: the OAuth handshake state (state/nonce/PKCE)
# lives in a per-process in-memory map; a callback landing on a second instance
# would fail. Sessions after login are stateless JWTs, so one instance is plenty.
gcloud run deploy "$SERVICE" \
  --source "$SCRIPT_DIR/portal" \
  --project="$PROJECT" --region="$REGION" \
  --allow-unauthenticated \
  --port=8080 \
  --min-instances=0 --max-instances=1 \
  --service-account="$SA" \
  --set-secrets "GOOGLE_OAUTH_CLIENT=google-oauth-client:latest,JWT_SHARED_KEY=jwt-shared-key:latest"

echo "==> domain mapping: $AUTH_HOST"
if ! gcloud beta run domain-mappings describe --domain="$AUTH_HOST" \
       --project="$PROJECT" --region="$REGION" >/dev/null 2>&1; then
  if ! gcloud beta run domain-mappings create --service="$SERVICE" --domain="$AUTH_HOST" \
         --project="$PROJECT" --region="$REGION"; then
    cat <<EOF

✗ Domain mapping failed — most likely the once-ever domain verification.
  Verify ownership of binary-badger.xyz for your account, then re-run:
    https://search.google.com/search-console/welcome  (add + verify the domain;
    the TXT record can go in our own zone:
      gcloud dns record-sets create binary-badger.xyz. --zone=$ZONE_NAME --type=TXT ...)
EOF
    exit 1
  fi
fi

echo "==> upserting the mapping's DNS records into the $ZONE_NAME zone"
# For a subdomain mapping this is typically one CNAME (ghs.googlehosted.com.).
gcloud beta run domain-mappings describe --domain="$AUTH_HOST" \
  --project="$PROJECT" --region="$REGION" \
  --format="value(status.resourceRecords[].type,status.resourceRecords[].rrdata)" \
| while read -r rtype rdata; do
    [ -n "$rtype" ] || continue
    if gcloud dns record-sets describe "$AUTH_HOST." --type="$rtype" \
         --zone="$ZONE_NAME" --project="$PROJECT" >/dev/null 2>&1; then
      gcloud dns record-sets update "$AUTH_HOST." --type="$rtype" \
        --zone="$ZONE_NAME" --project="$PROJECT" --ttl=300 --rrdatas="$rdata"
    else
      gcloud dns record-sets create "$AUTH_HOST." --type="$rtype" \
        --zone="$ZONE_NAME" --project="$PROJECT" --ttl=300 --rrdatas="$rdata"
    fi
  done

cat <<EOF

✓ portal deployed: https://$AUTH_HOST
  (managed cert provisions after DNS is live — typically ~15 min, up to 24 h)

ONE-TIME (once ever, if not done): add this Authorized redirect URI to the
OAuth client — after this, NO bot ever needs a Console step:
    https://$AUTH_HOST/oauth2/google/authorization-code-callback
  Console: https://console.cloud.google.com/apis/credentials?project=$PROJECT

Verify when the cert is live:
    curl -s -i https://$AUTH_HOST/oauth2/google | grep -i '^location:'
  → expect a 302 to accounts.google.com with redirect_uri=https://$AUTH_HOST/...
EOF
