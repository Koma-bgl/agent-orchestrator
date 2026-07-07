#!/usr/bin/env bash
# deploy-gcp.sh — provision the AO stack as a public bot on a GCE VM at
# https://<user>.binary-badger.xyz, authenticated by the fleet SSO portal
# (auth.binary-badger.xyz — see deploy-portal.sh). Operator-run; YOUR gcloud creds.
# No per-bot OAuth/Console steps: DNS A-records are automated in the ao-fleet zone.
#
#   init     one-time: reserve static IP, create SA + IAM, firewall.
#   create   create the VM (quota-gated), DNS A-record, scp the kit, stack up.
#   destroy  delete the VM instance + its A-record (IP/SA/secrets persist).
#   status   show your bot's VM + URL.
#
# Env/flags: --project=ID | $AO_PROJECT (else active gcloud project);
#            $AO_REGION (us-central1), $AO_ZONE (us-central1-a),
#            $AO_MACHINE_TYPE (e2-standard-4), $AO_DISK_SIZE (50GB — a valhalla
#            clone + npm ci + .next + the image overflow the 10GB debian default).
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

# Optional --index=N for a user's Nth VM (default 1; quota permitting).
INDEX=1; for a in "$@"; do case "$a" in --index=*) INDEX="${a#--index=}";; esac; done

VM_NAME="$(node "$SCRIPT_DIR/gcp-lib.mjs" vmName "$ACCOUNT" "$INDEX")"
OWNER_LABEL="$(node "$SCRIPT_DIR/gcp-lib.mjs" ownerLabel "$ACCOUNT")"
SA_NAME="ao-deploy"
SA="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
IP_NAME="$(node "$SCRIPT_DIR/gcp-lib.mjs" ipName "$ACCOUNT" "$INDEX")"
FW_RULE="ao-allow-web"
NET_TAG="ao-bot"
QUOTA_SECRET="ao-vm-quotas"

# Prints the reserved IP, or nothing if it doesn't exist yet (absence is a valid
# state — callers check for empty; don't let set -e kill us on describe's exit).
ip_address() { gcloud compute addresses describe "$IP_NAME" --project="$PROJECT" --region="$REGION" --format='value(address)' 2>/dev/null || true; }

DNS_ZONE="ao-fleet"

# Upsert an A-record (describe → update-else-create: `create` fails if present,
# `update` fails if absent, and delete-then-create opens an NXDOMAIN window that
# resolvers negative-cache).
dns_upsert_a() {
  local fqdn="$1." ip="$2"
  if gcloud dns record-sets describe "$fqdn" --type=A --zone="$DNS_ZONE" --project="$PROJECT" >/dev/null 2>&1; then
    gcloud dns record-sets update "$fqdn" --type=A --zone="$DNS_ZONE" --project="$PROJECT" --ttl=300 --rrdatas="$ip" >/dev/null
  else
    gcloud dns record-sets create "$fqdn" --type=A --zone="$DNS_ZONE" --project="$PROJECT" --ttl=300 --rrdatas="$ip" >/dev/null
  fi
}

dns_delete_a() {
  gcloud dns record-sets delete "$1." --type=A --zone="$DNS_ZONE" --project="$PROJECT" >/dev/null 2>&1 || true
}

# Per-user quota from the central ao-vm-quotas secret (JSON:
#   {"default":1,"admin":"ky@chaostheory.hk","some@user.com":3}).
# Missing secret → default 1. The "admin" field is who users ask for more.
# NOTE: cooperative enforcement — real (non-bypassable) enforcement means taking
# compute.instances.create away from users and brokering creates (M8).
quota_doc() { gcloud secrets versions access latest --secret="$QUOTA_SECRET" --project="$PROJECT" 2>/dev/null || true; }
user_quota() { node "$SCRIPT_DIR/gcp-lib.mjs" quotaFor "$(quota_doc)" "$ACCOUNT"; }

# Count of the caller's live AO VMs (by ao-owner label).
owned_count() {
  gcloud compute instances list --project="$PROJECT" \
    --filter="labels.ao-owner=$OWNER_LABEL" --format='value(name)' 2>/dev/null | grep -c . || true
}

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

  echo
  echo "Auth is fleet-wide (deploy-portal.sh) — no per-bot OAuth steps."
  echo "Next: $0 create   → your bot at https://$(node "$SCRIPT_DIR/gcp-lib.mjs" botHost "$ACCOUNT" "$INDEX")"
}

# Build the remote bring-up script (runs on the VM; fetches secrets via the SA).
remote_up_script() {
  local host="$1" project="$2"
  cat <<REMOTE
set -euo pipefail
# Move the scp'd kit (landed in the SSH user's home — /opt/ao is root-owned)
sudo mkdir -p /opt/ao
sudo rm -rf /opt/ao/deploy
sudo mv "\$HOME/ao-deploy" /opt/ao/deploy
cd /opt/ao/deploy
sec() { gcloud secrets versions access latest --secret="\$1" --project="$project"; }
JWT="\$(sec jwt-shared-key)"
# Fleet allowlist: normalize commas/newlines to spaces (parse-time splat in Caddy).
ALLOW="\$(sec dashboard-allowlist | tr ',\n' '  ')"
WT="\$(openssl rand -hex 24 2>/dev/null || head -c24 /dev/urandom | xxd -p)"
cat > .env <<ENV
AO_SECRET_SOURCE=env
JWT_SHARED_KEY=\${JWT}
ALLOWED_EMAILS=\${ALLOW}
# Agent creds — left EMPTY on purpose. The bot boots idle; each user fills these
# on-box via the setup wizard (Milestone B), so the admin who runs create never
# handles anyone's tokens. gh reads GITHUB_TOKEN; the Linear tracker reads
# LINEAR_API_KEY; claude-code reads ANTHROPIC_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN).
GITHUB_TOKEN=
LINEAR_API_KEY=
ANTHROPIC_API_KEY=
CLAUDE_CODE_OAUTH_TOKEN=
AO_SITE_ADDRESS=$host
AO_SITE_URL=https://$host
AO_AUTH_URL=https://auth.binary-badger.xyz/
# Fleet-wide GitHub OAuth App client id (device-flow login). PUBLIC, not a secret;
# same for every bot. Set GH_OAUTH_CLIENT_ID in the deploy env (or hardcode here)
# once the OAuth App is registered. Empty → the wizard's GitHub login is disabled.
GITHUB_OAUTH_CLIENT_ID=${GH_OAUTH_CLIENT_ID:-}
WATCHTOWER_TOKEN=\${WT}
ENV
sudo docker compose -f docker-compose.yml -f docker-compose.vm.yml up -d --build
REMOTE
}

cmd_create() {
  # Per-user quota (central ao-vm-quotas doc; default 1)
  local doc quota count admin
  doc="$(quota_doc)"
  quota="$(node "$SCRIPT_DIR/gcp-lib.mjs" quotaFor "$doc" "$ACCOUNT")"
  admin="$(node "$SCRIPT_DIR/gcp-lib.mjs" quotaAdmin "$doc")"
  count="$(owned_count)"
  if [ "$count" -ge "$quota" ]; then
    echo "✗ Quota reached: you ($ACCOUNT) have $count of $quota allowed VM(s):"
    gcloud compute instances list --project="$PROJECT" --filter="labels.ao-owner=$OWNER_LABEL" \
      --format='table(name,zone,status)' 2>/dev/null || true
    echo
    echo "Options:"
    echo "  • free a slot:      $0 destroy [--index=N]"
    if [ -n "$admin" ]; then
      echo "  • request a raise:  ask $admin to bump your entry in the '$QUOTA_SECRET' secret, e.g."
      echo "                      {\"default\":1,\"admin\":\"$admin\",\"$ACCOUNT\":2}"
    else
      echo "  • request a raise:  ask your admin to add \"$ACCOUNT\": N to the '$QUOTA_SECRET' secret"
    fi
    exit 1
  fi
  # Refuse a name collision for this index (quota may allow more via --index=N)
  if gcloud compute instances describe "$VM_NAME" --project="$PROJECT" --zone="$ZONE" >/dev/null 2>&1; then
    echo "VM $VM_NAME already exists — pass --index=N (2..$quota) for an additional bot."; exit 1
  fi
  local ip; ip="$(ip_address)"
  [ -n "$ip" ] || { echo "no reserved IP ($IP_NAME) — run '$0 init${INDEX:+ --index=$INDEX}' first."; exit 1; }
  local host; host="$(node "$SCRIPT_DIR/gcp-lib.mjs" botHost "$ACCOUNT" "$INDEX")"

  echo "==> DNS: $host → $ip (ao-fleet zone)"
  dns_upsert_a "$host" "$ip"

  echo "==> creating VM $VM_NAME ($MACHINE_TYPE) with IP $ip → https://$host"
  gcloud compute instances create "$VM_NAME" --project="$PROJECT" --zone="$ZONE" \
    --machine-type="$MACHINE_TYPE" \
    --image-family=debian-12 --image-project=debian-cloud \
    --boot-disk-size="${AO_DISK_SIZE:-50GB}" --boot-disk-type=pd-balanced \
    --address="$ip" --service-account="$SA" --scopes=cloud-platform \
    --tags="$NET_TAG" --labels="ao-owner=$OWNER_LABEL" \
    --metadata-from-file=startup-script="$SCRIPT_DIR/startup-script.sh"

  echo "==> waiting for startup-script (Docker + gcloud)…"
  until gcloud compute ssh "$VM_NAME" --project="$PROJECT" --zone="$ZONE" \
        --command="test -f /opt/ao/.startup-done" >/dev/null 2>&1; do sleep 10; done

  echo "==> uploading the deploy kit (excluding local .env)…"
  # scp to the SSH user's home (writable); the remote script sudo-moves it to
  # /opt/ao/deploy. Staged copy so the local .env never leaves this machine.
  local stage; stage="$(mktemp -d)"; cp -R "$SCRIPT_DIR/." "$stage/"; rm -f "$stage/.env"
  # sshd can reset connections in the window right after the startup-script
  # finishes, so retry the ssh/scp steps rather than aborting the whole create.
  retry() { local n; for n in 1 2 3 4 5; do "$@" && return 0; echo "  (retry $n/5 after transient SSH error…)"; sleep 10; done; return 1; }
  # stdin-aware retry: re-feeds $1 to the command on every attempt (a plain pipe
  # would only feed the first try).
  retry_stdin() { local input="$1"; shift; local n; for n in 1 2 3 4 5; do printf '%s' "$input" | "$@" && return 0; echo "  (retry $n/5 after transient SSH error…)"; sleep 10; done; return 1; }
  retry gcloud compute ssh "$VM_NAME" --project="$PROJECT" --zone="$ZONE" --command="rm -rf ~/ao-deploy && mkdir -p ~/ao-deploy"
  retry gcloud compute scp --recurse --project="$PROJECT" --zone="$ZONE" "$stage/." "$VM_NAME:~/ao-deploy/"
  rm -rf "$stage"

  echo "==> bringing the stack up on the VM…"
  retry_stdin "$(remote_up_script "$host" "$PROJECT")" \
    gcloud compute ssh "$VM_NAME" --project="$PROJECT" --zone="$ZONE" --command="bash -s"

  echo
  echo "✓ bot up at: https://$host"
  echo "  - sign in with an allowlisted Google account (fleet SSO — no OAuth setup needed)."
  echo "  - agent auth (on-box): gcloud compute ssh $VM_NAME --zone=$ZONE then:"
  echo "      sudo docker compose -f /opt/ao/deploy/docker-compose.yml exec ao gh auth login"
  echo "      sudo docker compose -f /opt/ao/deploy/docker-compose.yml exec ao claude setup-token"
}

cmd_destroy() {
  dns_delete_a "$(node "$SCRIPT_DIR/gcp-lib.mjs" botHost "$ACCOUNT" "$INDEX")"
  if gcloud compute instances describe "$VM_NAME" --project="$PROJECT" --zone="$ZONE" >/dev/null 2>&1; then
    gcloud compute instances delete "$VM_NAME" --project="$PROJECT" --zone="$ZONE" --quiet
    echo "✓ deleted instance $VM_NAME (+ its A-record). Reserved IP, SA, and secrets kept — recreate with '$0 create'."
  else
    echo "no instance $VM_NAME (already gone; A-record cleaned). IP/SA/secrets untouched."
  fi
}

cmd_status() {
  local ip; ip="$(ip_address)"
  echo "project: $PROJECT  account: $ACCOUNT"
  echo "quota: $(owned_count)/$(user_quota) VM(s) used"
  echo "reserved IP ($IP_NAME): ${ip:-<none — run init>}"
  [ -n "$ip" ] && echo "URL: https://$(node "$SCRIPT_DIR/gcp-lib.mjs" botHost "$ACCOUNT" "$INDEX")"
  echo "instances:"
  gcloud compute instances list --project="$PROJECT" --filter="labels.ao-owner=$OWNER_LABEL" \
    --format='table(name,zone,status,EXTERNAL_IP)' 2>/dev/null || echo "  (none)"
}

# ---- admin commands (read-only; need compute.instances.list / logging.read) ----

# Every AO bot in the project, by owner label (self-reported but convenient).
cmd_admin_list() {
  echo "AO bots in $PROJECT (by ao-owner label):"
  gcloud compute instances list --project="$PROJECT" --filter="labels.ao-owner:*" \
    --format='table(name, labels.ao-owner, creationTimestamp.date(), status, machineType.basename(), networkInterfaces[0].accessConfigs[0].natIP)'
}

# Authoritative audit trail: who actually called instances.insert (Cloud Audit
# Logs, Admin Activity — immutable, cannot be spoofed by labels).
cmd_admin_audit() {
  echo "instances.insert calls in $PROJECT (last 30 days, authoritative):"
  gcloud logging read \
    'protoPayload.methodName="v1.compute.instances.insert" AND severity>=NOTICE' \
    --project="$PROJECT" --freshness=30d \
    --format='table(timestamp.date(), protoPayload.authenticationInfo.principalEmail, protoPayload.resourceName.basename())'
}

case "${1:-}" in
  init) cmd_init;;
  create) cmd_create;;
  destroy) cmd_destroy;;
  status) cmd_status;;
  admin-list) cmd_admin_list;;
  admin-audit) cmd_admin_audit;;
  *) echo "usage: $0 {init|create|destroy|status|admin-list|admin-audit} [--project=ID] [--index=N]"; exit 2;;
esac
