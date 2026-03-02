<div align="center">

# Agent Orchestrator — The Orchestration Layer for Parallel AI Agents

Spawn parallel AI coding agents, each in its own git worktree. Agents autonomously fix CI failures, address review comments, and open PRs — you supervise from one dashboard.

[![GitHub stars](https://img.shields.io/github/stars/ComposioHQ/agent-orchestrator?style=flat-square)](https://github.com/ComposioHQ/agent-orchestrator/stargazers)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![PRs merged](https://img.shields.io/badge/PRs_merged-61-brightgreen?style=flat-square)](https://github.com/ComposioHQ/agent-orchestrator/pulls?q=is%3Amerged)
[![Tests](https://img.shields.io/badge/test_cases-3%2C288-blue?style=flat-square)](https://github.com/ComposioHQ/agent-orchestrator/releases/tag/metrics-v1)

</div>

---

Agent Orchestrator manages fleets of AI coding agents working in parallel on your codebase. Each agent gets its own git worktree, its own branch, and its own PR. When CI fails, the agent fixes it. When reviewers leave comments, the agent addresses them. You only get pulled in when human judgment is needed.

**Agent-agnostic** (Claude Code, Codex, Aider) · **Runtime-agnostic** (tmux, Docker) · **Tracker-agnostic** (GitHub, Linear)

<!-- TODO: Add dashboard screenshot or terminal GIF showing 10+ sessions with attention zones -->

## Quick Start

```bash
# Install
git clone https://github.com/ComposioHQ/agent-orchestrator.git
cd agent-orchestrator && bash scripts/setup.sh

# Configure your project
cd ~/your-project && ao init --auto

# Launch and spawn an agent
ao start
ao spawn my-project 123    # GitHub issue, Linear ticket, or ad-hoc
```

Dashboard opens at `http://localhost:3000`. Run `ao status` for the CLI view.

## How It Works

```
ao spawn my-project 123
```

1. **Workspace** creates an isolated git worktree with a feature branch
2. **Runtime** starts a tmux session (or Docker container)
3. **Agent** launches Claude Code (or Codex, or Aider) with issue context + persona behavior
4. Agent works autonomously — reads code, writes tests, creates PR
5. **Lifecycle** monitors CI, reviews, merge conflicts — auto-handles or escalates
6. **Reactions** auto-fix CI failures, forward review comments, auto-merge when approved
7. **Visual Verification** captures screenshots before PR creation (optional, Playwright-based)
8. **Notifier** pings you only when judgment is needed

### Plugin Architecture

Eight slots. Every abstraction is swappable.

| Slot | Default | Alternatives |
|------|---------|-------------|
| Runtime | tmux | docker, k8s, process |
| Agent | claude-code | codex, aider, opencode |
| Workspace | worktree | clone |
| Tracker | github | linear |
| SCM | github | — |
| Notifier | desktop | slack, composio, webhook |
| Terminal | iterm2 | web |
| Lifecycle | core | — |

All interfaces defined in [`packages/core/src/types.ts`](packages/core/src/types.ts). A plugin implements one interface and exports a `PluginModule`. That's it.

## Configuration

```yaml
# agent-orchestrator.yaml
port: 3000

defaults:
  runtime: tmux
  agent: claude-code
  workspace: worktree
  notifiers: [desktop]

projects:
  my-app:
    repo: owner/my-app
    path: ~/my-app
    defaultBranch: main
    sessionPrefix: app
    agentPersonas: [test-writer, security-auditor]  # combinable behavior profiles

    # Auto-spawn agents from issue tracker
    queuePoller:
      enabled: true
      interval: 30s
      maxSessions: 5
      filters:
        labels: [agent]
        statusName: "Ready to start"

    # Visual verification (Playwright screenshots before PR)
    # verify:
    #   enabled: true
    #   baseUrl: http://localhost:3000
    #   paths: [{ url: "/dashboard", name: "Dashboard" }]

reactions:
  ci-failed:
    auto: true
    action: send-to-agent
    retries: 2
  changes-requested:
    auto: true
    action: send-comments-to-agent
    escalateAfter: 30m
  approved-and-green:
    auto: true
    action: auto-merge      # squash-merges when CI green + approved
```

CI fails → agent gets the logs and fixes it. Reviewer requests changes → agent addresses them. PR approved with green CI → auto-merge (or notify, your choice).

### Agent Personas

Personas are pre-built behavior profiles that shape how agents approach their work. Combine multiple personas per project — they stack.

| Persona | Focus |
|---------|-------|
| `security-auditor` | Vulnerability scanning, dependency audits, secrets detection |
| `code-reviewer` | Code quality, patterns, linting, dead code removal |
| `test-writer` | Unit/integration/E2E tests, coverage, mocking |
| `bug-fixer` | Root cause analysis, minimal fixes, regression tests |
| `refactorer` | Behavior-preserving cleanup, type safety, modularity |
| `full-stack-dev` | End-to-end feature implementation, API design, UI states |

**Custom personas:** drop a `.md` file in the `personas/` directory (or set `personasDir` in config) and reference it by filename. No code changes needed.

### Queue Poller

Automatically spawn agent sessions from your issue tracker — no manual intervention needed. Configure filters (labels, status, assignee) and the poller picks up matching issues, spawns sessions, and moves issues to "In Progress".

```yaml
queuePoller:
  enabled: true
  interval: 30s
  maxSessions: 5
  filters:
    labels: [agent]
    statusName: "Ready to start"
  onSpawn:
    moveToStatus: "In Progress"
```

### Visual Verification

Capture screenshots of your running app after agent changes — before the PR is even created. Supports authentication (Firebase, stored auth state), smart file-pattern matching (only runs when UI files are touched), and auto-posts screenshots as PR comments.

```bash
ao verify INT-123    # Run verification manually
```

### Auto-Merge & Lifecycle

The lifecycle manager tracks every session through a full state machine: `spawning → working → pr_open → ci_failed/ci_passing → review_pending → approved → merged`. At each stage, configurable reactions handle the routine work:

- **CI failures** → send logs to agent for auto-fix (with retry + escalation)
- **Review comments** → forward to agent with file/line context
- **Merge conflicts** → agent rebases and resolves
- **Approved + CI green** → auto-merge (squash, merge, or rebase)

Rate-limited GitHub API calls with exponential backoff and PR state caching for efficient polling.

See [`agent-orchestrator.yaml.example`](agent-orchestrator.yaml.example) for the full reference.

## CLI

```bash
ao status                              # Overview of all sessions
ao spawn <project> [issue]             # Spawn an agent
ao send <session> "Fix the tests"      # Send instructions
ao session ls                          # List sessions
ao session kill <session>              # Kill a session
ao session restore <session>           # Revive a crashed agent
ao verify <issue>                      # Run visual verification
ao dashboard                           # Open web dashboard
```

## Why Agent Orchestrator?

Running one AI agent in a terminal is easy. Running 30 across different issues, branches, and PRs is a coordination problem.

**Without orchestration**, you manually: create branches, start agents, check if they're stuck, read CI failures, forward review comments, track which PRs are ready to merge, clean up when done.

**With Agent Orchestrator**, you: `ao spawn` and walk away. The system handles isolation, feedback routing, and status tracking. You review PRs and make decisions — the rest is automated.

## Prerequisites

- Node.js 20+
- Git 2.25+
- tmux (for default runtime)
- `gh` CLI (for GitHub integration)

## Development

```bash
pnpm install && pnpm build    # Install and build all packages
pnpm test                      # Run tests (3,288 test cases)
pnpm dev                       # Start web dashboard dev server
```

See [CLAUDE.md](CLAUDE.md) for code conventions and architecture details.

## Documentation

| Doc | What it covers |
|-----|---------------|
| [Setup Guide](SETUP.md) | Detailed installation and configuration |
| [Examples](examples/) | Config templates (GitHub, Linear, multi-project, auto-merge) |
| [CLAUDE.md](CLAUDE.md) | Architecture, conventions, plugin pattern |
| [Troubleshooting](TROUBLESHOOTING.md) | Common issues and fixes |

## Contributing

Contributions welcome. The plugin system makes it straightforward to add support for new agents, runtimes, trackers, and notification channels. Every plugin is an implementation of a TypeScript interface — see [CLAUDE.md](CLAUDE.md) for the pattern.

## License

MIT
