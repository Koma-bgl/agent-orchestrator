#!/usr/bin/env bash
# Watchtower pre-update lifecycle hook. Runs INSIDE the ao container just before an
# image update. A non-zero exit ABORTS the update (Watchtower retries on its next
# scheduled poll), so a nightly/auto update never kills an in-flight coding session —
# it simply waits for an idle window. Exit 0 allows the update.
#
# Requires WATCHTOWER_LIFECYCLE_HOOKS=true on the watchtower service and the label
# com.centurylinklabs.watchtower.lifecycle.pre-update=/app/scripts/drain-check.sh on ao.
#
# "Active" = a session mid-work (agent coding / waiting on input / just spawned / stuck).
# PRs waiting on review/merge are NOT counted — the poller (status write-back, auto-merge,
# orphan re-check) carries those to completion even across a recreate, so they're safe to
# interrupt.
set -uo pipefail
PORT="${PORT:-3000}"

active="$(curl -fsS "http://127.0.0.1:${PORT}/api/sessions" 2>/dev/null | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  try {
    const busy = (JSON.parse(s).sessions || []).filter((x) =>
      ["working", "needs_input", "spawning", "stuck"].includes(x.status),
    );
    process.stdout.write(String(busy.length));
  } catch {
    process.stdout.write("0");
  }
});' 2>/dev/null || echo 0)"

if [ "${active:-0}" != "0" ]; then
  echo "[drain-check] ${active} active session(s) — deferring image update until idle"
  exit 1
fi
echo "[drain-check] idle — allowing image update"
exit 0
