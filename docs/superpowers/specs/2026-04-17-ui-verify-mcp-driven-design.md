# UI Verify — MCP-Driven Browser Verification

**Status:** Draft
**Date:** 2026-04-17
**Owner:** Koma
**Supersedes:** extends existing `ao verify` (headless Playwright screenshots)

## 1. Problem

`agent-orchestrator` today runs a headless, scripted Playwright flow (`packages/core/src/verify-runner.ts`) that authenticates, navigates to configured URLs, and posts screenshots to a PR. It cannot explore, interact, observe console/network output, or reason about whether the UI actually works. It catches "did a page render" but not "does the feature behave correctly."

Staging deploys are a poor substitute — a single staging deploy takes ~9 minutes per run, making iteration painful and discouraging verification altogether.

We want **adaptive, behavior-driven verification** using a real browser controlled by a Claude sub-agent through MCP, executed against a live local dev server of the PR's code, triggered automatically when a PR is opened for a ticket explicitly marked for UI verification.

## 2. Goals / Non-Goals

**Goals**
- Run a real Chrome browser against the PR's code, driven by Claude via MCP.
- Trigger automatically when a tracker ticket carries a configurable label (default `ui-verify`).
- Serialize through a single Chrome instance to avoid concurrent UI test flakiness.
- Post results to the PR as a new comment per run plus a compact status line in the PR body.
- Block auto-merge until verification passes.
- Reuse existing plugin/lifecycle/runtime/persona infrastructure as much as possible.

**Non-Goals**
- Replacing the existing `ao verify` headless screenshot flow — it stays as a separate, simpler option.
- Running verification in CI/headless/server environments (v1 is local Chrome on the user's machine).
- Parallelism / multiple concurrent verifications.
- Deploying to staging or spinning up cloud previews.
- Visual regression (pixel-diff) testing.

## 3. High-Level Architecture

Triggered asynchronously as a **reaction** in the existing lifecycle state machine. When a PR opens for an eligible ticket, the orchestrator acquires a shared verify worktree, starts a dev server on a fixed port, spawns a Claude sub-agent session with MCP browser tools, waits for completion, posts results, releases resources. Serial by construction — only one verification active at a time.

Eight components:

1. **Verify-eligibility check** (in `packages/core/src/lifecycle-manager.ts`) — on `pr_open`, read the ticket's labels via `Tracker.getIssue()`. If the configured trigger label is present → enqueue a verify reaction. Re-checked each poll cycle so the label can be added mid-flight.

2. **Verify worktree manager** (new: `packages/core/src/verify-worktree-manager.ts`) — owns the single shared `<project>-verify` worktree at a configurable path. Responsible for: fetching origin, checking out the target branch, lockfile-gated `pnpm install`, starting and stopping the dev server on a fixed port (`verify.baseUrl`). Serializes access via an in-process mutex. **Release path is crash-tolerant**: if the dev server process has already exited when `release()` is called (crash, OOM, user-killed), the manager logs and proceeds rather than throwing.

3. **Verifier agent plugin** (new: `packages/plugins/agent-claude-code-verifier/`) — a new `Agent` plugin implementing the existing `Agent` interface from `types.ts` (not a parallel session type). Wraps `claude-code` with: a verifier persona (new file `personas/ui-verifier.md`), MCP browser tools bound (Playwright-MCP or Claude-in-Chrome), the `ao_verify_login` helper exposed as an MCP tool, and `maxSessions: 1` enforced at the plugin level. Uses the existing `Runtime` (tmux) and session metadata plumbing unchanged.

4. **`ao_verify_login` helper** (new: `packages/cli/src/commands/verify-login.ts`) — a CLI subcommand. The verifier plugin registers a thin MCP tool shim that invokes this subcommand via `execFile` and returns the result, so the CLI stays the single source of truth. Args: role name (e.g., `default`, `admin`). Reads credentials from `verify.accounts.<role>` in the orchestrator config, drives the login flow through the already-open Chrome session, reports success/failure. **Credentials never enter Claude's context.**

5. **Verify reaction handler** (extension to `lifecycle-manager`) — acquires the verify worktree, spawns the verifier agent session with context (PR title, body, diff, route hints, optional `## Verification` section from PR body), waits for completion, posts result, releases worktree.

6. **Result reporter** (new: `packages/plugins/scm-github/src/verify-reporter.ts`) — posts a new PR comment per run (screenshots + console observations + network observations + summary), updates a single delimited status block in the PR body (`<!-- ao-verify-status -->✅ Verified by ao at 12:34<!-- /ao-verify-status -->`). **Every verifier-posted comment starts with the HTML marker `<!-- ao-verify:result -->`** so the review-comment ingestion pipeline (see component 8) can exclude it from the agent-facing review stream.

8. **Review-comment ingestion filter** (extension to `packages/plugins/scm-github/src/`) — the existing pipeline that fetches PR comments and forwards reviewer input to the implementing agent gains a single-line filter: **any comment whose body contains `<!-- ao-verify:` is skipped**. Prevents the verifier's own output from being re-ingested as review feedback, which would cause feedback loops or noise the implementing agent reacts to. The filter is applied at the earliest point in the ingestion pipeline so downstream stages never see verifier comments.

   **Failure notifications bypass GitHub entirely.** When verification fails, the verify reaction handler (component 5) does **not** post an @mention comment to the PR. Instead, it dispatches a notification directly to the implementing agent's session via the orchestrator's internal session API — same channel used today for CI-failure reactions (per CLAUDE.md's two-tier reaction model). The implementing agent sees the failure as an in-session message, not as a GitHub round-trip that could be re-ingested. The single verifier-posted PR comment remains the rich status artifact; it carries the marker and is not treated as reviewer input.

7. **Auto-merge gate** (extension to `lifecycle-manager`) — before auto-merging, consult `session.verifyStatus`. States: `not-required | pending | passed | failed`. Only `passed` and `not-required` clear the gate. **Persistence**: `verifyStatus` lives in the flat session metadata file (same file that already tracks `prUrl`, `branch`, etc., per CLAUDE.md's "stateless orchestrator, flat metadata files" principle). Transitions also emit events to the JSONL log (`verify.started`, `verify.passed`, `verify.failed`, `verify.skipped`) for observability, but metadata is authoritative for gating decisions.

## 4. Data Flow (Happy Path)

```
tracker issue (labeled ui-verify)
  → agent session spawns, does work, opens PR
  → lifecycle-manager detects pr_open
  → reads Tracker.getIssue(id).labels, finds configured trigger label → eligible
  → enqueues verify reaction
  → verify-worktree-manager acquires lock (serial across project)
      → git fetch origin
      → git checkout <pr-branch> in <verifyWorktreeDir>/<project>
      → if pnpm-lock.yaml hash changed since last install → pnpm install
      → start dev server on verify.baseUrl port; wait for port to respond (ready probe)
  → spawn verifier agent session (S3)
      → prompt: PR title + body + diff + route hints (I3) + verification section if present (I4)
      → tools: MCP Chrome (navigate, click, fill, screenshot, console, network), ao_verify_login
      → persona: ui-verifier.md
  → sub-agent navigates, interacts, screenshots, observes
  → sub-agent writes structured output: { verdict, summary, screenshots[], observations[] }
  → verify-reporter posts PR comment (R3) + updates PR body status line (R3)
  → lifecycle-manager updates session.verifyStatus
  → kill dev server, release worktree lock
  → if verdict == pass → clear auto-merge gate
  → if verdict == fail and attempts < maxRetries → dispatch in-session message to implementing agent via orchestrator API (NOT a PR comment), containing failure summary + link to rich PR comment
  → if verdict == fail and attempts == maxRetries → escalate to human via notifier (Tier 2)
  (Note: the single verifier-posted PR comment carries the `<!-- ao-verify:result -->` marker and is filtered out of review-comment ingestion, so it cannot re-enter the agent's inbox as reviewer feedback.)
```

### Re-Verify Triggers

- **First verify** — on `pr_open` with the configured label present.
- **Automatic re-run** — on new push to a PR whose last `verifyStatus` was `failed`, up to `verify.maxRetries` (default 2).
- **Manual** — `ao verify --pr <n>` CLI enqueues a run on demand.

### Eligibility — What Pauses Verification

- Ticket does **not** carry the configured trigger label → skipped, no status recorded on GitHub, session metadata flags `verify: not-required`.
- Label is added to the ticket after PR opens → picked up on next poll cycle, verify enqueues.
- Label is removed → in-flight verify continues; future runs skip.

## 5. Configuration

Added under each project in `agent-orchestrator.yaml`:

```yaml
projects:
  my-app:
    verify:
      enabled: true
      triggerLabel: "ui-verify"                # label name on tracker ticket; configurable per project
      baseUrl: "http://localhost:3100"         # fixed port; where MCP Chrome points
      verifyWorktreeDir: "~/ao-verify-worktrees"  # shared root; one subdir per project
      startCommand: "pnpm dev"                 # command to start the dev server in the worktree
      readyProbe:
        url: "http://localhost:3100"
        timeoutSec: 60
      accounts:
        default:
          email: "${VERIFY_DEFAULT_EMAIL}"
          password: "${VERIFY_DEFAULT_PASSWORD}"
        admin:
          email: "${VERIFY_ADMIN_EMAIL}"
          password: "${VERIFY_ADMIN_PASSWORD}"
      loginSelectors:                          # optional; defaults to common patterns
        loginButton: 'button:has-text("Log in")'
        emailInput: 'input[type="email"]'
        passwordInput: 'input[type="password"]'
        submitButton: 'button[type="submit"]'
      maxRetries: 2
      timeoutSec: 300                          # kill sub-agent session after this
      uiVerifierPersona: "ui-verifier"         # persona file name (without .md)
```

Env var placeholders (`${VAR}`) are resolved at config load, matching the existing `verify-runner` pattern (`resolveEnvVars` in `verify-runner.ts`). The `verify` block gains a Zod schema in the existing config module (`packages/core/src/config.ts` or wherever the project-level Zod schema currently lives), validated at load time alongside the rest of the config.

## 6. Component Interfaces (Sketch)

### `VerifyWorktreeManager`

```typescript
interface VerifyWorktreeManager {
  /** Acquire exclusive access to the verify worktree for a project. Blocks if busy. */
  acquire(projectId: string, branch: string): Promise<VerifyWorktreeHandle>;
}

interface VerifyWorktreeHandle {
  path: string;
  baseUrl: string;
  /** Release the lock and stop the dev server. */
  release(): Promise<void>;
}
```

### Verifier session input

```typescript
interface VerifierSessionInput {
  prNumber: number;
  prTitle: string;
  prBody: string;
  diff: string;                    // bounded; truncate at ~200 KB
  routeHints: string[];            // computed from diff file paths (I3)
  verificationSection?: string;    // if agent wrote `## Verification` (I4)
  baseUrl: string;
  availableRoles: string[];        // e.g. ["default", "admin"]
  timeoutSec: number;
}
```

### Verifier session output

```typescript
interface VerifierResult {
  verdict: "pass" | "fail";
  summary: string;                 // one paragraph, human-readable
  screenshots: Array<{
    label: string;
    path: string;                  // local file path; uploaded by reporter
  }>;
  observations: {
    consoleErrors: string[];
    networkFailures: string[];
    stepsTaken: string[];
  };
}
```

**Output contract.** The sub-agent is instructed (via its persona) to write this structure as JSON to a well-known path in the verify worktree — `<verifyWorktreeDir>/<project>/.ao-verify-result.json` — and then exit its session. The orchestrator polls for the file's existence (or session exit, whichever comes first), then reads and validates the JSON against a Zod schema. Validation failures are treated as `fail` with the parse error included in the reported summary.

## 7. Security Considerations

- **Credentials never enter Claude's context.** The sub-agent only sees role names. The `ao_verify_login` helper reads secrets from the orchestrator's config (env vars), drives the login flow directly in Chrome, and returns a boolean.
- **Passwords still traverse the browser form fields** controlled by MCP. A compromised MCP stack could observe them. Acceptable for test-account credentials; **do not use production credentials in `verify.accounts`**.
- **Verify worktree is gitignored in intent** — it sits at `verifyWorktreeDir`, outside the main project. No risk of accidentally committing verify artifacts.
- **Shell invocations** (git fetch/checkout, pnpm install, dev server) use `execFile` not `exec`, per `CLAUDE.md` security conventions.
- **Dev server port binds to localhost only** — `verify.baseUrl` defaults to `http://localhost:3100`. Never exposed on a public interface.

## 8. Trade-offs and Risks

- **Serial queue is a throughput ceiling.** One verification at a time across the whole project. Heavy PR days could create a backlog. Mitigation: per-session timeout (default 5 min) prevents stuck verifications. If this becomes a real pain point, a second Chrome instance on a different port is a straightforward extension.
- **Chrome running locally on the user's machine** means verification halts when the user's laptop sleeps or `ao` isn't running. Acceptable for v1; v2 can add a headless/server mode.
- **Shared verify worktree churn** on rapid branch switches triggers `pnpm install` whenever the lockfile changes. Mitigated by lockfile hash caching — only reinstall if `pnpm-lock.yaml` hash differs from last install.
- **Claude judgment is non-deterministic.** Same PR verified twice may produce slightly different summary text. Acceptable — the verdict (pass/fail) is what matters; seeding with deterministic context (diff + route hints) reduces variance.
- **"Smart" verification can miss scenarios.** Claude might not know to test edge cases unless the agent writes a `## Verification` section (I4). Docs will recommend agents write this block when their change is user-visible; `BASE_AGENT_PROMPT` gets a nudge.

## 9. Testing Strategy

- **Unit**
  - `VerifyWorktreeManager` — mock `execFile`, verify checkout + lockfile hash + install sequencing.
  - Eligibility check — mock `Tracker.getIssue`, assert enqueue behavior for labeled/unlabeled/label-added-later tickets.
  - `verify-reporter` — mock Octokit, verify comment creation + PR body delimited-block replacement. Assert every posted comment body starts with `<!-- ao-verify:result -->`.
  - Review-comment ingestion filter — feed a mix of user comments and verifier-marked comments through the ingestion pipeline, assert verifier-marked comments are excluded from the agent-facing review stream (regression guard against feedback loops).
  - `verify-login` helper — mock Playwright page, verify credentials never appear in stdout/stderr.
- **Integration**
  - Test project in the repo (a tiny web app) with a real tracker issue; full loop from PR open → verify session → comment posted.
  - Lockfile-unchanged case should skip `pnpm install` (assert via install command call count).
- **Manual smoke**
  - Open a PR in `packages/web` for an issue labeled `ui-verify`; watch Chrome drive itself; inspect PR comment and body status line.

## 10. Phased Rollout

Each phase is independently landable.

1. **Phase 1 — Plumbing.** `VerifyWorktreeManager` (without running verification), eligibility check, verify reaction enqueueing. Assertion: on PR open with label, a "would verify" log line appears.
2. **Phase 2 — Verifier agent plugin.** New plugin, persona file, scaffolding to spawn a Claude session with MCP tools bound. Run manually against a fixture PR.
3. **Phase 3 — Login helper.** `ao_verify_login` CLI subcommand. Wire as an MCP tool. Verify credentials stay out of Claude's context.
4. **Phase 4 — Result reporting.** `verify-reporter`: PR comment + PR body status line. Auto-merge gate extension.
5. **Phase 5 — Retry + escalation.** Automatic re-run on push after failure. Notifier escalation after `maxRetries`.
6. **Phase 6 — Docs and prompt tweaks.** Agent prompt nudge to write `## Verification`. Example config in `agent-orchestrator.yaml.example`. README section.

## 11. Open Questions

- **MCP browser tool choice** — Playwright-MCP or Claude-in-Chrome? Both work; Claude-in-Chrome gives a richer event model (network/console streams), Playwright-MCP is more deterministic. Recommend Claude-in-Chrome for v1; allow override via plugin config.
- **Screenshot storage** — attached to the comment via GitHub Issue attachments (upload as image), or committed to a branch and linked? Recommend: upload via the existing GitHub upload endpoint used by the current `verify-runner`.
- **Diff size budget** — very large PRs could blow the sub-agent's context. Current cap ~200 KB; if exceeded, truncate with a note and rely on route hints + verification section.
- **Manual `ao verify --pr <n>` ergonomics** — should it bypass the serial queue or respect it? Recommend respect it; if the user wants "right now," they can kill any in-flight verify.

## 12. Success Criteria

- On opening a PR for an issue labeled with the configured trigger label, a verifier session spawns within one poll cycle.
- Verifier session navigates a real Chrome, interacts with the app, captures screenshots, reports a verdict.
- PR receives a new comment per run; PR body status line reflects current state.
- Auto-merge of a labeled PR is blocked until verifier verdict == `pass`.
- Failed verification triggers an agent-facing comment; after 2 retries, a human notification.
- Tickets *without* the trigger label never spawn a verifier session and are not blocked from auto-merge.
