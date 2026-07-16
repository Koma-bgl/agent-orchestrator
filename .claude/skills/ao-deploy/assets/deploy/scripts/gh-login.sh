#!/usr/bin/env bash
# Runs inside the setup ttyd/tmux session so the operator can auth GitHub CLI with
# gh's OWN web/device flow — no OAuth App to register. gh stores the token under
# GH_CONFIG_DIR (on the volume), then we install it as git's credential helper.
clear 2>/dev/null || true
cat <<'BANNER'
============================================================
  GitHub login for this bot
============================================================
When prompted, choose "Login with a web browser".
gh prints a one-time code + the URL https://github.com/login/device
Open that URL in your browser, enter the code, and approve.
------------------------------------------------------------
BANNER
echo
gh auth login --hostname github.com --git-protocol https --web || true
echo
if gh auth status >/dev/null 2>&1; then
  gh auth setup-git 2>/dev/null || true
  echo "✓ GitHub connected as $(gh api user --jq .login 2>/dev/null). Go back to the setup page — it detects this automatically."
else
  echo "Not logged in yet. Run:  gh auth login --web   to retry."
fi
echo
exec bash
