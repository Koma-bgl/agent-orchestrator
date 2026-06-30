# syntax=docker/dockerfile:1
# Pin linux/amd64: @aoagents/ao ships a linux-x64 binary only (no linux-arm64).
# Native on the x86 GCE VM and CI's ubuntu runner; emulated on arm64 dev machines
# (e.g. Apple Silicon) — correct everywhere given the x64-only binary.
FROM --platform=linux/amd64 node:20-bookworm-slim

# OS deps: agent runtime (tmux/git), curl+ca-certificates (Secret Manager fetch
# + gh apt repo), then the GitHub CLI. No build toolchain — we install a prebuilt
# Go binary, not source.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tmux git curl ca-certificates gnupg socat \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# The AO daemon binary (prebuilt Go, via npm platform package) and the Claude
# Code CLI agents spawn. Pin ao to match the :stable image tag so they never drift.
RUN npm install -g @aoagents/ao@0.10.0 @anthropic-ai/claude-code \
 && ao --version

# Secret-loading entrypoint + the pure resolver it shells out to.
WORKDIR /app
COPY entrypoint.sh /app/entrypoint.sh
COPY scripts /app/scripts
RUN chmod +x /app/entrypoint.sh

# Daemon binds 127.0.0.1:AO_PORT; state lives under $HOME/.ao (mounted volume).
ENV AO_PORT=3001
EXPOSE 3001

# Liveness against the daemon's own /healthz. Runs INSIDE the container, so the
# 127.0.0.1 bind is reachable (a host port-map would not be).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${AO_PORT}/healthz" || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
