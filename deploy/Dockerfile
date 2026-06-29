# syntax=docker/dockerfile:1
FROM node:20-bookworm

# OS deps: agent runtime (tmux/git/gh), node-pty build toolchain, curl for Secret Manager.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tmux git curl ca-certificates python3 make g++ \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# Claude Code CLI on PATH (agents spawn `claude`).
RUN npm install -g @anthropic-ai/claude-code

ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app
COPY . /app

# Install (runs node-pty postinstall rebuild) and build all packages.
# NOTE: scripts/rebuild-node-pty.js catches its own failure and exits 0, so the
# build will NOT fail if the native rebuild fails — the in-container terminal
# would just be broken. Verify the build log shows "node-pty rebuilt
# successfully"; if node-pty drifts from 1.1.0 the hardcoded path in that script
# must be updated.
RUN pnpm install --frozen-lockfile && pnpm build

# Provision a git-initialized sample project + baked config so `ao start` boots
# without user config (autoCreateConfig throws on a non-git workdir).
RUN git config --global user.email "ao@example.com" \
 && git config --global user.name "Agent Orchestrator" \
 && git config --global init.defaultBranch main \
 && mkdir -p /workspace/sample \
 && cd /workspace/sample \
 && git init -q \
 && cp /app/deploy/default-config/agent-orchestrator.default.yaml /workspace/sample/agent-orchestrator.yaml \
 && git add -A && git commit -q -m "chore: bootstrap sample project"

ENV PORT=3000
ENV AO_PROJECT_DIR=/workspace/sample
EXPOSE 3000

# Make crash-loops observable rather than silent under restart policies.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS "http://localhost:${PORT}/api/version" || exit 1

ENTRYPOINT ["/app/deploy/entrypoint.sh"]
