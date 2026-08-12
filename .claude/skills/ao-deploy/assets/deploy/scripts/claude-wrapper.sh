#!/usr/bin/env bash
# Headless claude shim. Newer claude-code (2.1.x) gates a session behind THREE
# interactive prompts that --dangerously-skip-permissions does NOT bypass, so an
# agent session launched in a fresh git worktree tmux hangs and dies:
#   1. first-run login/onboarding picker  -> hasCompletedOnboarding (global)
#   2. "trust this folder?" dialog        -> per-CWD hasTrustDialogAccepted
#   3. "Bypass Permissions mode" accept   -> bypassPermissionsModeAccepted (global)
#      + migrationVersion pinned high (a config migration re-shows #3 otherwise)
# This wrapper pre-seeds all of them in CLAUDE_CONFIG_DIR/.claude.json, then execs
# the real claude (claude.real). Auth still comes from CLAUDE_CODE_OAUTH_TOKEN.
CFG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.claude.json"
node -e '
const fs = require("fs"), path = require("path");
const f = process.argv[1], cwd = process.cwd();
let j = {};
try { j = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
j.hasCompletedOnboarding = true;
j.theme = j.theme || "dark";
// GLOBAL (top-level) flag: claude reads it as Pt().bypassPermissionsModeAccepted,
// NOT from the per-project entry. Without it, `claude --dangerously-skip-permissions`
// shows the interactive "Bypass Permissions mode — Yes, I accept" dialog on every
// fresh config and dies in a headless tmux. Set per-project it has NO effect.
j.bypassPermissionsModeAccepted = true;
// Pin migrationVersion high. claude runs config migrations when
// migrationVersion < its current version, and one of those migrations RE-SHOWS the
// bypass dialog even when bypassPermissionsModeAccepted is already true (verified:
// migrationVersion:13 → dialog; absent or high → no dialog). Setting it above any
// real version makes claude skip migrations entirely, so the accept flag sticks.
j.migrationVersion = 9999;
j.projects = j.projects || {};
j.projects[cwd] = Object.assign({}, j.projects[cwd], {
  hasTrustDialogAccepted: true,
  hasCompletedProjectOnboarding: true,
  projectOnboardingSeenCount: 1,
});
try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(j)); } catch {}
' "$CFG" 2>/dev/null || true
# Never let claude update itself: its updater runs `npm install -g`, which yanks
# the bin symlink mid-install (concurrent spawns die with "command not found") and
# then replaces this wrapper with npm's raw symlink. The Dockerfile ENV already sets
# both; re-export here so the guarantee survives any launch path that loses the
# container env. Version bumps go through the image pin, not self-update.
export DISABLE_AUTOUPDATER=1 DISABLE_UPDATES=1
# exec the real binary via /usr/local/libexec/claude — a path whose BASENAME is
# "claude". The agent-claude-code plugin finds the live process by matching `ps` args
# against /(?:^|\/)claude(?:\s|$)/; if it can't, it reports the session "exited" and
# the poller respawns it forever. Invoking through a "/…/claude" path puts a matching
# "/claude " token in the args on BOTH native amd64 AND under Rosetta (which prints
# the emulated binary path). Execing "claude.real" directly fails the regex (".real").
exec /usr/local/libexec/claude "$@"
