# syntax=docker/dockerfile:1
# Pin linux/amd64: the GCE fleet VM is x86_64 and the ttyd static binary below is
# x86_64. ao-cli is portable Node, but its native dep node-pty (which powers the
# in-dashboard terminal) IS compiled below, so the pin also fixes the ABI target.
# Native on the x86 VM + CI; emulated on arm64 dev.
FROM --platform=linux/amd64 node:20-bookworm-slim

# Node 20 is deliberate: @composio/ao-web bakes "requires Node 20.x" and node-pty
# 1.1.0 breaks on Node >= 25 — do not bump without re-verifying the terminals.

# OS deps: agent runtime (tmux/git), curl+ca-certificates+gnupg (Secret Manager
# fetch + gh apt repo), procps (the agent-claude-code plugin runs `ps -eo pid,tty,args`
# to detect the live claude process per session — WITHOUT it every session is
# misreported as "exited"/killed), the GitHub CLI, then ttyd (the dashboard's terminal —
# an external C binary spawned per session; installed as a static release binary so we
# depend on neither the (missing) Debian package nor a build toolchain).
RUN apt-get update && apt-get install -y --no-install-recommends \
      tmux git curl ca-certificates gnupg procps \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && curl -fsSL https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 \
      -o /usr/local/bin/ttyd && chmod +x /usr/local/bin/ttyd && ttyd --version \
 && rm -rf /var/lib/apt/lists/*

# The TS agent-orchestrator engine (@composio/ao-cli — pulls ao-web = the prebuilt
# Next.js dashboard, ao-core = poller/reactions/lifecycle, and the tracker-linear /
# scm-github / runtime-tmux / agent-claude-code plugins) + the Claude Code CLI that
# spawned agent sessions drive. Pin BOTH exactly so every update is deliberate:
# claude-code's own auto-updater once ran `npm install -g` mid-flight on a live VM
# (2026-08-12) — the bin symlink vanished for minutes (a concurrent `ao spawn` hit
# "claude: command not found" and the session died at launch) and the finished
# install replaced the wrapper below with npm's plain symlink, dropping every
# headless dialog gate for subsequent spawns. See DISABLE_UPDATES in the ENV block.
RUN npm install -g @composio/ao-cli@0.2.2 @anthropic-ai/claude-code@2.1.228 \
 && ao --version \
 # Sanity-check that ao-web's prod entry resolves relative to the `ao` bin (it is
 # a nested dep, not resolvable from the global root — mirrors the entrypoint).
 && AO_SHIM="$(readlink -f "$(command -v ao)")" \
 && WEBDIR="$(node -e 'const p=require("path");process.stdout.write(p.dirname(require.resolve("@composio/ao-web/package.json",{paths:[p.dirname(process.argv[1])]})))' "$AO_SHIM")" \
 && test -f "$WEBDIR/dist-server/start-all.js"

# node-pty powers the in-dashboard terminal (direct-terminal-ws.js on :14801). It's an
# OPTIONAL dep of ao-web with no prebuilt binary for this platform, so the global
# install skips it silently — then the WS server boots "node-pty not available" and
# closes every /ws upgrade with 1011, which the browser shows as a connect→"connecting"
# flap. Compile it into ao-web's OWN node_modules (where import("node-pty") resolves),
# assert the binary exists (do NOT execute it — node-pty load can SIGILL under arm64
# qemu at build time), then drop the toolchain so it doesn't bloat the image.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && AO_SHIM="$(readlink -f "$(command -v ao)")" \
 && WEBDIR="$(node -e 'const p=require("path");process.stdout.write(p.dirname(require.resolve("@composio/ao-web/package.json",{paths:[p.dirname(process.argv[1])]})))' "$AO_SHIM")" \
 && npm install --prefix "$WEBDIR" --no-save --no-audit --no-fund node-pty@1.1.0 \
 && test -f "$WEBDIR/node_modules/node-pty/build/Release/pty.node" \
 && apt-get purge -y python3 make g++ && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# Secret-loading entrypoint + the pure resolver it shells out to.
WORKDIR /app
COPY entrypoint.sh /app/entrypoint.sh
COPY scripts /app/scripts
COPY admin /app/admin
# The admin/setup-wizard backend's only dep (yaml). node_modules is dockerignored,
# so this installs cleanly in-image (pure JS, no native build).
RUN chmod +x /app/entrypoint.sh \
 && cd /app/admin && npm install --omit=dev --no-audit --no-fund \
 # Shadow `claude` with the headless trust/onboarding wrapper. `command -v claude`
 # is npm's SYMLINK into the package (…/bin/claude.exe = the real binary). Point
 # claude.real AND /usr/local/libexec/claude at that resolved target, then `rm -f` the
 # PATH symlink BEFORE copying the wrapper — otherwise `cp` follows the symlink and
 # overwrites the real binary in place, so it execs itself forever (SIGILL/hang).
 # The wrapper execs /usr/local/libexec/claude (basename "claude") so the running
 # process matches the plugin's /(?:^|\/)claude(?:\s|$)/ liveness regex; claude.real
 # (same target) is kept only for the anti-loop guard below.
 && CLAUDE_REAL="$(readlink -f "$(command -v claude)")" \
 && ln -sf "$CLAUDE_REAL" /usr/local/bin/claude.real \
 && mkdir -p /usr/local/libexec && ln -sf "$CLAUDE_REAL" /usr/local/libexec/claude \
 && rm -f /usr/local/bin/claude \
 && cp /app/scripts/claude-wrapper.sh /usr/local/bin/claude \
 && chmod +x /usr/local/bin/claude /app/scripts/*.sh \
 # Verify wiring WITHOUT executing claude: invoking node/claude here runs under
 # qemu on arm64 dev machines and intermittently SIGILLs (exit 132). The real
 # `claude --version` smoke test happens at runtime on the native-amd64 VM. Assert
 # the real-binary targets are NOT the wrapper (the infinite-loop regression guard).
 && test -x /usr/local/bin/claude.real && test -x /usr/local/bin/claude \
 && test -x /usr/local/libexec/claude \
 && head -1 /usr/local/bin/claude | grep -q bash \
 && ! grep -q "Headless claude shim" /usr/local/bin/claude.real \
 && ! grep -q "Headless claude shim" /usr/local/libexec/claude \
 # Shadow `gh` with the read-caching shim (/usr/local/bin precedes /usr/bin in
 # PATH): ao's dual 30s lifecycle pollers otherwise burn the whole 5000/hr
 # GraphQL quota on identical PR reads (~5 reads x open PRs x 2 pollers / 30s).
 # The shim execs /usr/bin/gh directly for everything non-cacheable.
 && cp /app/scripts/gh-cache-shim.sh /usr/local/bin/gh \
 && chmod +x /usr/local/bin/gh \
 && test -x /usr/bin/gh

# The dashboard (Next.js) binds 0.0.0.0:3000; the terminal WS servers bind
# 0.0.0.0:14800/14801 and ttyd 7800+. State consolidates under /root/.agent-orchestrator
# (config, gh config dir, cloned repos, on-box secrets, session metadata), the mounted
# ao-state volume, so it survives restarts + Watchtower recreate. NOTE: ao-cli@0.2.2
# puts session WORKTREES at $HOME/.worktrees (NOT under the data dir), so compose mounts
# a SEPARATE ao-worktrees volume there — otherwise a recreate orphans them and wedges
# `ao spawn`, and a symlink would break claude's transcript-path encoding (activity
# misread as needs_input). Only Caddy is ever the public surface.
# NEXT_PUBLIC_TERMINAL_WS_PATH makes the terminal client build a same-origin
# wss://<host>/terminal-ws URL (gateable by Caddy) instead of a raw :14800 hop.
# IS_SANDBOX=1: the container runs as root, and `claude --dangerously-skip-permissions`
# (what the agent plugin uses) refuses to run as root UNLESS this sandbox flag is set.
# The container is an isolated sandbox, so this is the intended escape hatch.
# HUSKY=0 disables the repo's git hooks for the bot. The valhalla pre-commit
# (format+lint+types) and pre-push (FULL test suite via `turbo test-ci` + a full Next
# `build:local`) hooks re-run exactly what the PR's CI (pr-checks.yml) already runs,
# and blocked every push for 7-15 min while the session sat idle. The agent still runs
# its own fast checks for self-correction; CI is the authoritative gate (a failing PR
# never merges). It also no-ops `husky install` (npm ci's prepare step), so
# core.hooksPath is never set. npm_config_cache pins npm's cache to the mounted
# ao-npm-cache volume so `npm ci --prefer-offline` survives worktrees + recreates.
# DISABLE_AUTOUPDATER/DISABLE_UPDATES: claude-code must NEVER update itself inside
# the image — its updater runs `npm install -g`, which (a) leaves a window with no
# `claude` on PATH (spawns launched then die with "command not found" and ao marks
# them killed) and (b) overwrites the /usr/local/bin/claude WRAPPER with npm's raw
# symlink, silently dropping the headless dialog gates. AUTOUPDATER kills the
# background check; UPDATES also blocks an agent running `claude update` by hand.
# Version bumps happen by editing the pin above and republishing the image.
ENV AO_CONFIG_PATH=/root/.agent-orchestrator/agent-orchestrator.yaml \
    IS_SANDBOX=1 \
    DISABLE_AUTOUPDATER=1 \
    DISABLE_UPDATES=1 \
    HUSKY=0 \
    npm_config_cache=/root/.npm \
    GH_CONFIG_DIR=/root/.agent-orchestrator/gh \
    CLAUDE_CONFIG_DIR=/root/.agent-orchestrator/claude \
    NEXT_PUBLIC_TERMINAL_WS_PATH=/terminal-ws \
    PORT=3000 \
    TERMINAL_PORT=14800 \
    DIRECT_TERMINAL_PORT=14801
EXPOSE 3000

# Liveness against the dashboard root (the TS AO has no /healthz). Runs INSIDE the
# container. Longer start-period: `next start` boot is slower than the Go daemon.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/" || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
