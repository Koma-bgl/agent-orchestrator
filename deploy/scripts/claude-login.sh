#!/usr/bin/env bash
# Runs inside the setup ttyd/tmux session so the operator can sign in to Claude with
# the claude CLI's own OAuth flow — no API key to paste. Creds land in
# CLAUDE_CONFIG_DIR (on the volume), which spawned agent sessions inherit.
clear 2>/dev/null || true
cat <<'BANNER'
============================================================
  Claude login for this bot
============================================================
Runs `claude auth login`. Follow the prompts and approve in
your browser. (Prefer API billing? Cancel with Ctrl-C and paste
your ANTHROPIC_API_KEY in the wizard instead.)
------------------------------------------------------------
BANNER
echo
claude auth login || true
echo
if claude auth status 2>/dev/null | grep -q '"loggedIn": *true'; then
  echo "✓ Claude connected. Go back to the setup page — it detects this automatically."
else
  echo "Not logged in yet. Run:  claude auth login   to retry."
fi
echo
exec bash
