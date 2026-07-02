#!/usr/bin/env bash
# deploy-gcp.sh — provision the AO stack as a single public Google-gated bot on a
# GCE VM at https://<reserved-ip>.sslip.io.  Operator-run; uses YOUR gcloud creds.
#
#   init     one-time: reserve static IP, create SA + IAM, firewall; print the
#            OAuth redirect URI to add to your Google client (once).
#   create   create the VM (max 1 per user), scp the deploy kit, bring the stack up.
#   destroy  delete the VM instance only (IP/SA/secrets persist — recreate is cheap).
#   status   show your bot's VM + URL.
#
# Env/flags: --project=ID | $AO_PROJECT (else active gcloud project);
#            $AO_REGION (us-central1), $AO_ZONE (us-central1-a),
#            $AO_MACHINE_TYPE (e2-standard-4).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE_SECRETS=(google-oauth-client jwt-shared-key dashboard-allowlist)

# ---- config resolution ----
PROJECT=""; for a in "$@"; do case "$a" in --project=*) PROJECT="${a#--project=}";; esac; done
PROJECT="${PROJECT:-${AO_PROJECT:-$(gcloud config get-value project 2>/dev/null)}}"
ACCOUNT="$(gcloud config get-value account 2>/dev/null)"
REGION="${AO_REGION:-us-central1}"
ZONE="${AO_ZONE:-us-central1-a}"
MACHINE_TYPE="${AO_MACHINE_TYPE:-e2-standard-4}"
[ -n "$PROJECT" ] || { echo "no project (pass --project= or set one with gcloud)"; exit 1; }
[ -n "$ACCOUNT" ] || { echo "no active gcloud account (run: gcloud auth login)"; exit 1; }

VM_NAME="$(node "$SCRIPT_DIR/gcp-lib.mjs" vmName "$ACCOUNT")"
OWNER_LABEL="$(node "$SCRIPT_DIR/gcp-lib.mjs" ownerLabel "$ACCOUNT")"
SA_NAME="ao-deploy"
SA="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
IP_NAME="ao-${OWNER_LABEL}-ip"
FW_RULE="ao-allow-web"
NET_TAG="ao-bot"

# Prints the reserved IP, or nothing if it doesn't exist yet (absence is a valid
# state — callers check for empty; don't let set -e kill us on describe's exit).
ip_address() { gcloud compute addresses describe "$IP_NAME" --project="$PROJECT" --region="$REGION" --format='value(address)' 2>/dev/null || true; }

cmd_init() {
  echo "==> init for $ACCOUNT in project $PROJECT ($REGION/$ZONE)"

  # Service account (idempotent)
  gcloud iam service-accounts describe "$SA" --project="$PROJECT" >/dev/null 2>&1 \
    || gcloud iam service-accounts create "$SA_NAME" --project="$PROJECT" --display-name="AO deploy bot"

  # Per-secret IAM (secure default: SA + you, not the whole org)
  for s in "${GATE_SECRETS[@]}"; do
    gcloud secrets describe "$s" --project="$PROJECT" >/dev/null 2>&1 \
      || { echo "  ! gate secret '$s' missing — create it first (see valhalla-dev-bot check)"; continue; }
    gcloud secrets add-iam-policy-binding "$s" --project="$PROJECT" \
      --member="serviceAccount:$SA" --role="roles/secretmanager.secretAccessor" >/dev/null
    gcloud secrets add-iam-policy-binding "$s" --project="$PROJECT" \
      --member="serviceAccount:$SA" --role="roles/secretmanager.secretVersionAdder" >/dev/null
  done
  echo "  ✓ SA + secretAccessor/secretVersionAdder on gate secrets"

  # Reserved static IP (idempotent)
  gcloud compute addresses describe "$IP_NAME" --project="$PROJECT" --region="$REGION" >/dev/null 2>&1 \
    || gcloud compute addresses create "$IP_NAME" --project="$PROJECT" --region="$REGION"
  local ip; ip="$(ip_address)"
  echo "  ✓ reserved IP: $ip ($IP_NAME)"

  # Firewall: 80/443 to tagged instances (idempotent)
  gcloud compute firewall-rules describe "$FW_RULE" --project="$PROJECT" >/dev/null 2>&1 \
    || gcloud compute firewall-rules create "$FW_RULE" --project="$PROJECT" \
         --allow=tcp:80,tcp:443 --direction=INGRESS --target-tags="$NET_TAG"
  echo "  ✓ firewall $FW_RULE (tcp:80,443 → tag:$NET_TAG)"

  local host redirect
  host="$(node "$SCRIPT_DIR/gcp-lib.mjs" sslipHost "$ip")"
  redirect="$(node "$SCRIPT_DIR/gcp-lib.mjs" redirectUri "$host")"
  echo
  echo "ONE-TIME: add this Authorized redirect URI to your OAuth client:"
  echo "    $redirect"
  echo "  Console: https://console.cloud.google.com/apis/credentials?project=$PROJECT"
  echo "Then run: $0 create"
}

# Build the remote bring-up script (runs on the VM; fetches secrets via the SA).
remote_up_script() {
  local host="$1" project="$2"
  cat <<REMOTE
set -euo pipefail
cd /opt/ao/deploy
sec() { gcloud secrets versions access latest --secret="\$1" --project="$project"; }
GOC="\$(sec google-oauth-client)"; GID="\${GOC%%|*}"; GSEC="\${GOC#*|}"
JWT="\$(sec jwt-shared-key)"; ALLOW="\$(sec dashboard-allowlist)"
WT="\$(openssl rand -hex 24 2>/dev/null || head -c24 /dev/urandom | xxd -p)"
cat > .env <<ENV
AO_SECRET_SOURCE=env
GOOGLE_CLIENT_ID=\${GID}
GOOGLE_CLIENT_SECRET=\${GSEC}
JWT_SHARED_KEY=\${JWT}
ALLOWED_EMAIL_1=\${ALLOW}
GITHUB_TOKEN=
CLAUDE_CODE_OAUTH_TOKEN=
AO_SITE_ADDRESS=$host
AO_SITE_URL=https://$host
WATCHTOWER_TOKEN=\${WT}
ENV
sudo docker compose -f docker-compose.yml -f docker-compose.vm.yml up -d --build
REMOTE
}

cmd_create() {
  # Max 1 per user
  local existing; existing="$(gcloud compute instances list --project="$PROJECT" \
    --filter="labels.ao-owner=$OWNER_LABEL" --format='value(name)' 2>/dev/null || true)"
  if [ -n "$existing" ]; then
    echo "You already have a bot: $existing. Run '$0 destroy' first (max 1 per user)."; exit 1
  fi
  local ip; ip="$(ip_address)"
  [ -n "$ip" ] || { echo "no reserved IP — run '$0 init' first."; exit 1; }
  local host; host="$(node "$SCRIPT_DIR/gcp-lib.mjs" sslipHost "$ip")"

  echo "==> creating VM $VM_NAME ($MACHINE_TYPE) with IP $ip → https://$host"
  gcloud compute instances create "$VM_NAME" --project="$PROJECT" --zone="$ZONE" \
    --machine-type="$MACHINE_TYPE" \
    --image-family=debian-12 --image-project=debian-cloud \
    --address="$ip" --service-account="$SA" --scopes=cloud-platform \
    --tags="$NET_TAG" --labels="ao-owner=$OWNER_LABEL" \
    --metadata-from-file=startup-script="$SCRIPT_DIR/startup-script.sh"

  echo "==> waiting for startup-script (Docker + gcloud)…"
  until gcloud compute ssh "$VM_NAME" --project="$PROJECT" --zone="$ZONE" \
        --command="test -f /opt/ao/.startup-done" >/dev/null 2>&1; do sleep 10; done

  echo "==> uploading the deploy kit (excluding local .env)…"
  local stage; stage="$(mktemp -d)"; cp -R "$SCRIPT_DIR/." "$stage/"; rm -f "$stage/.env"
  gcloud compute scp --recurse --project="$PROJECT" --zone="$ZONE" "$stage/." "$VM_NAME:/opt/ao/deploy/"
  rm -rf "$stage"

  echo "==> bringing the stack up on the VM…"
  remote_up_script "$host" "$PROJECT" | gcloud compute ssh "$VM_NAME" --project="$PROJECT" --zone="$ZONE" --command="bash -s"

  echo
  echo "✓ bot up at: https://$host"
  echo "  - if you haven't: add the redirect URI from '$0 init' to the OAuth client."
  echo "  - sign in with an allowlisted Google account."
  echo "  - agent auth (on-box): gcloud compute ssh $VM_NAME --zone=$ZONE then:"
  echo "      sudo docker compose -f /opt/ao/deploy/docker-compose.yml exec ao gh auth login"
  echo "      sudo docker compose -f /opt/ao/deploy/docker-compose.yml exec ao claude setup-token"
}

cmd_destroy() {
  if gcloud compute instances describe "$VM_NAME" --project="$PROJECT" --zone="$ZONE" >/dev/null 2>&1; then
    gcloud compute instances delete "$VM_NAME" --project="$PROJECT" --zone="$ZONE" --quiet
    echo "✓ deleted instance $VM_NAME. Reserved IP, SA, and secrets kept — recreate with '$0 create'."
  else
    echo "no instance $VM_NAME (already gone). IP/SA/secrets untouched."
  fi
}

cmd_status() {
  local ip; ip="$(ip_address)"
  echo "project: $PROJECT  account: $ACCOUNT"
  echo "reserved IP: ${ip:-<none — run init>}"
  [ -n "$ip" ] && echo "URL: https://$(node "$SCRIPT_DIR/gcp-lib.mjs" sslipHost "$ip")"
  echo "instance:"
  gcloud compute instances list --project="$PROJECT" --filter="labels.ao-owner=$OWNER_LABEL" \
    --format='table(name,zone,status,EXTERNAL_IP)' 2>/dev/null || echo "  (none)"
}

case "${1:-}" in
  init) cmd_init;;
  create) cmd_create;;
  destroy) cmd_destroy;;
  status) cmd_status;;
  *) echo "usage: $0 {init|create|destroy|status} [--project=ID]"; exit 2;;
esac
