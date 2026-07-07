# syntax=docker/dockerfile:1
# Pin linux/amd64: the GCE fleet VM is x86_64 and the ttyd static binary below is
# x86_64. ao-cli itself is portable Node (its only native dep, node-pty, is optional
# and we don't build it), so the pin is about matching the VM + ttyd, not a hard
# requirement of the npm package. Native on the x86 VM + CI; emulated on arm64 dev.
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
# spawned agent sessions drive. Pin ao-cli exactly so self-update is deliberate.
RUN npm install -g @composio/ao-cli@0.2.2 @anthropic-ai/claude-code \
 && ao --version \
 # Sanity-check that ao-web's prod entry resolves relative to the `ao` bin (it is
 # a nested dep, not resolvable from the global root — mirrors the entrypoint).
 && AO_SHIM="$(readlink -f "$(command -v ao)")" \
 && WEBDIR="$(node -e 'const p=require("path");process.stdout.write(p.dirname(require.resolve("@composio/ao-web/package.json",{paths:[p.dirname(process.argv[1])]})))' "$AO_SHIM")" \
 && test -f "$WEBDIR/dist-server/start-all.js"

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
 && ! grep -q "Headless claude shim" /usr/local/libexec/claude

# The dashboard (Next.js) binds 0.0.0.0:3000; the terminal WS servers bind
# 0.0.0.0:14800/14801 and ttyd 7800+. ALL state consolidates under
# /root/.agent-orchestrator (where ao-core hardcodes its data/worktree/worker dirs —
# AO_DATA_DIR is not honored as an override), which is the mounted volume. Config,
# the gh config dir, cloned repos, and the on-box secrets all live there so they
# survive restarts + Watchtower recreate. Only Caddy is ever the public surface.
# NEXT_PUBLIC_TERMINAL_WS_PATH makes the terminal client build a same-origin
# wss://<host>/terminal-ws URL (gateable by Caddy) instead of a raw :14800 hop.
# IS_SANDBOX=1: the container runs as root, and `claude --dangerously-skip-permissions`
# (what the agent plugin uses) refuses to run as root UNLESS this sandbox flag is set.
# The container is an isolated sandbox, so this is the intended escape hatch.
ENV AO_CONFIG_PATH=/root/.agent-orchestrator/agent-orchestrator.yaml \
    IS_SANDBOX=1 \
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
