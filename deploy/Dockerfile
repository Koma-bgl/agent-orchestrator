# syntax=docker/dockerfile:1
# Pin linux/amd64: the GCE fleet VM is x86_64 and the ttyd static binary below is
# x86_64. ao-cli itself is portable Node (its only native dep, node-pty, is optional
# and we don't build it), so the pin is about matching the VM + ttyd, not a hard
# requirement of the npm package. Native on the x86 VM + CI; emulated on arm64 dev.
FROM --platform=linux/amd64 node:20-bookworm-slim

# Node 20 is deliberate: @composio/ao-web bakes "requires Node 20.x" and node-pty
# 1.1.0 breaks on Node >= 25 — do not bump without re-verifying the terminals.

# OS deps: agent runtime (tmux/git), curl+ca-certificates+gnupg (Secret Manager
# fetch + gh apt repo), the GitHub CLI, then ttyd (the dashboard's terminal — an
# external C binary spawned per session; installed as a static release binary so we
# depend on neither the (missing) Debian package nor a build toolchain).
RUN apt-get update && apt-get install -y --no-install-recommends \
      tmux git curl ca-certificates gnupg \
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
RUN chmod +x /app/entrypoint.sh

# The dashboard (Next.js) binds 0.0.0.0:3000; the terminal WS servers bind
# 0.0.0.0:14800/14801 and ttyd 7800+. Config lives at AO_CONFIG_PATH on the
# mounted volume ($HOME/.ao). Only Caddy is ever the public surface.
ENV AO_CONFIG_PATH=/root/.ao/agent-orchestrator.yaml \
    PORT=3000 \
    TERMINAL_PORT=14800 \
    DIRECT_TERMINAL_PORT=14801
EXPOSE 3000

# Liveness against the dashboard root (the TS AO has no /healthz). Runs INSIDE the
# container. Longer start-period: `next start` boot is slower than the Go daemon.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/" || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
