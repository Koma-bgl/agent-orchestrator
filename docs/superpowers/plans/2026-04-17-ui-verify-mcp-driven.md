# UI Verify (MCP-Driven) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an MCP-driven, adaptive UI verification flow: a single shared verify worktree, a Claude sub-agent driving a real Chrome browser via MCP, triggered by a configurable tracker label, with results posted to the PR and auto-merge gated on verification passing.

**Architecture:** Async reaction in the existing lifecycle state machine. Eight components: (1) eligibility check, (2) verify worktree manager, (3) verifier agent plugin, (4) `ao_verify_login` helper, (5) reaction handler, (6) result reporter, (7) auto-merge gate, (8) review-comment ingestion filter. Serial queue of 1. All verifier PR comments carry an HTML marker; the scm-github comment-ingestion pipeline filters them out to prevent feedback loops. Failure notifications bypass GitHub and flow through the orchestrator's in-session message API.

**Tech Stack:** TypeScript (ESM), Node 20+, pnpm workspaces, Zod, vitest, Playwright (dynamically imported), Octokit via `gh` CLI, tmux runtime, MCP browser tools.

**Reference spec:** `docs/superpowers/specs/2026-04-17-ui-verify-mcp-driven-design.md`

---

## File Structure

**New files:**
- `packages/core/src/verify-worktree-manager.ts` — shared verify worktree owner; serialized acquire/release; dev-server lifecycle; lockfile-gated install
- `packages/core/src/__tests__/verify-worktree-manager.test.ts` — unit tests (mocked `execFile`)
- `packages/core/src/verify-eligibility.ts` — pure function: `isEligibleForVerify(config, issue)`; re-used by reaction and poller
- `packages/core/src/__tests__/verify-eligibility.test.ts` — unit tests
- `packages/plugins/agent-claude-code-verifier/` — new plugin package
  - `package.json`, `tsconfig.json`
  - `src/index.ts` — the `Agent` plugin manifest + `create()`; wraps claude-code with verifier persona and MCP tools
  - `src/__tests__/index.test.ts`
- `packages/plugins/scm-github/src/verify-reporter.ts` — post/update verifier PR comment + body status line; all comments carry `<!-- ao-verify:result -->` marker
- `packages/plugins/scm-github/src/__tests__/verify-reporter.test.ts`
- `packages/plugins/scm-github/src/comment-filter.ts` — single pure function filtering ao-verify comments from review ingestion
- `packages/plugins/scm-github/src/__tests__/comment-filter.test.ts`
- `packages/cli/src/commands/verify-login.ts` — `ao verify-login <role>` CLI subcommand
- `packages/cli/src/commands/__tests__/verify-login.test.ts`
- `personas/ui-verifier.md` — verifier persona (behavior profile + output contract instructions)

**Modified files:**
- `packages/core/src/types.ts` — add `McpVerifyConfig` (new fields `triggerLabel`, `verifyWorktreeDir`, `accounts`, `maxRetries`, `timeoutSec`, `uiVerifierPersona`); add `session.verifyStatus` + `session.verifyAttempts` to existing session metadata type
- `packages/core/src/config.ts` — extend Zod schema with new verify fields (keep existing `VerifyConfigSchema` untouched; add the new MCP-specific subfields alongside)
- `packages/core/src/lifecycle-manager.ts` — register `verify-ui` reaction; extend auto-merge gate; dispatch in-session failure message
- `packages/plugins/scm-github/src/index.ts` — wire `comment-filter` into the PR-comment ingestion path
- `packages/cli/src/index.ts` (or wherever commands are registered) — register `verify-login` command
- `agent-orchestrator.yaml.example` — add example `verify:` block with new fields

**Out of scope for this plan** (explicit non-goals):
- Replacing or breaking the existing headless `ao verify` flow — the new MCP flow lives alongside it under a new config namespace.
- Any change to `runVerification()` in `verify-runner.ts`.
- Visual regression / pixel-diff testing.
- Running the verifier headless in CI (v1 = local Chrome on the user's machine).

---

## Phase 1 — Config Schema + Eligibility Check (Plumbing)

Lands the config surface and the pure eligibility function. Nothing runs yet, but the config loads and the check returns correct booleans.

### Task 1.1: Extend types for the new verify config

**Files:**
- Modify: `packages/core/src/types.ts` (append near existing `VerifyConfig` around lines 1072–1098)

- [ ] **Step 1: Add the new type alongside the existing one**

```typescript
// --- New MCP-driven verify config (lives alongside the existing headless VerifyConfig) ---
export interface VerifyAccount {
  email: string;
  password: string;
}

export interface McpVerifyReadyProbe {
  url: string;
  timeoutSec: number;
}

export interface McpVerifyConfig {
  enabled: boolean;
  triggerLabel: string;                       // default "ui-verify"
  baseUrl: string;                            // e.g. "http://localhost:3100"
  verifyWorktreeDir: string;                  // supports ~ expansion
  startCommand: string;                       // e.g. "pnpm dev"
  readyProbe: McpVerifyReadyProbe;
  accounts: Record<string, VerifyAccount>;    // role-name → credentials
  loginSelectors?: LoginSelectors;            // reuse existing type
  maxRetries: number;                         // default 2
  timeoutSec: number;                         // default 300
  uiVerifierPersona: string;                  // default "ui-verifier"
}

export type VerifyStatus = "not-required" | "pending" | "passed" | "failed";

export interface VerifierResult {
  verdict: "pass" | "fail";
  summary: string;
  screenshots: Array<{ label: string; path: string }>;
  observations: {
    consoleErrors: string[];
    networkFailures: string[];
    stepsTaken: string[];
  };
}
```

- [ ] **Step 2: Extend the session metadata type to carry verify state**

Locate the existing session metadata type in `packages/core/src/types.ts` (grep for `verifyStatus` to confirm it does not yet exist). Add:

```typescript
// Inside the existing SessionMetadata / Session interface:
verifyStatus?: VerifyStatus;       // absent = not-required by default
verifyAttempts?: number;           // number of verification runs so far
```

- [ ] **Step 3: Typecheck**

```bash
pnpm typecheck
```
Expected: no errors. If errors reference missing `LoginSelectors` import, add it to the re-export list if needed.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/types.ts
git commit -m "feat(types): add McpVerifyConfig and session verifyStatus"
```

### Task 1.2: Extend the Zod schema in `config.ts`

**Files:**
- Modify: `packages/core/src/config.ts` (near `VerifyConfigSchema` around lines 86–99)
- Test: `packages/core/src/__tests__/config.test.ts` (or create if absent)

- [ ] **Step 1: Write the failing schema test**

```typescript
// packages/core/src/__tests__/config.test.ts
import { describe, it, expect } from "vitest";
import { McpVerifyConfigSchema } from "../config.js";

describe("McpVerifyConfigSchema", () => {
  it("accepts a minimal valid config with defaults filled in", () => {
    const parsed = McpVerifyConfigSchema.parse({
      enabled: true,
      baseUrl: "http://localhost:3100",
      verifyWorktreeDir: "~/ao-verify-worktrees",
      startCommand: "pnpm dev",
      readyProbe: { url: "http://localhost:3100", timeoutSec: 60 },
      accounts: {
        default: { email: "a@b.com", password: "pw" },
      },
    });
    expect(parsed.triggerLabel).toBe("ui-verify");
    expect(parsed.maxRetries).toBe(2);
    expect(parsed.timeoutSec).toBe(300);
    expect(parsed.uiVerifierPersona).toBe("ui-verifier");
  });

  it("resolves ${ENV_VAR} placeholders in account passwords", () => {
    process.env.VERIFY_TEST_PW = "sekret";
    const parsed = McpVerifyConfigSchema.parse({
      enabled: true,
      baseUrl: "http://localhost:3100",
      verifyWorktreeDir: "~/ao",
      startCommand: "pnpm dev",
      readyProbe: { url: "http://localhost:3100", timeoutSec: 60 },
      accounts: {
        default: { email: "a@b.com", password: "${VERIFY_TEST_PW}" },
      },
    });
    expect(parsed.accounts.default.password).toBe("sekret");
    delete process.env.VERIFY_TEST_PW;
  });

  it("rejects empty accounts map", () => {
    expect(() => McpVerifyConfigSchema.parse({
      enabled: true,
      baseUrl: "http://localhost:3100",
      verifyWorktreeDir: "~/ao",
      startCommand: "pnpm dev",
      readyProbe: { url: "http://localhost:3100", timeoutSec: 60 },
      accounts: {},
    })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @composio/ao-core test -- config.test
```
Expected: FAIL with "`McpVerifyConfigSchema` is not exported".

- [ ] **Step 3: Add the schema**

In `packages/core/src/config.ts`, near the existing `VerifyConfigSchema`:

```typescript
const VerifyAccountSchema = z.object({
  email: z.string().min(1).transform(resolveEnvVars),
  password: z.string().min(1).transform(resolveEnvVars),
});

const McpVerifyReadyProbeSchema = z.object({
  url: z.string().url(),
  timeoutSec: z.number().int().positive().default(60),
});

export const McpVerifyConfigSchema = z.object({
  enabled: z.boolean(),
  triggerLabel: z.string().default("ui-verify"),
  baseUrl: z.string().url(),
  verifyWorktreeDir: z.string().min(1),
  startCommand: z.string().min(1),
  readyProbe: McpVerifyReadyProbeSchema,
  accounts: z.record(z.string(), VerifyAccountSchema).refine(
    (accs) => Object.keys(accs).length > 0,
    { message: "at least one account is required" },
  ),
  loginSelectors: LoginSelectorsSchema.optional(),   // reuse existing
  maxRetries: z.number().int().min(0).default(2),
  timeoutSec: z.number().int().positive().default(300),
  uiVerifierPersona: z.string().default("ui-verifier"),
});
```

Wire this into the project-level schema: add `mcpVerify: McpVerifyConfigSchema.optional()` alongside the existing `verify: VerifyConfigSchema.optional()` on the project schema.

- [ ] **Step 4: Run tests, verify pass + no typecheck regressions**

```bash
pnpm --filter @composio/ao-core test -- config.test
pnpm typecheck
```
Expected: PASS, no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config.ts packages/core/src/__tests__/config.test.ts
git commit -m "feat(config): add McpVerifyConfigSchema with Zod validation"
```

### Task 1.3: Implement `verify-eligibility.ts`

**Files:**
- Create: `packages/core/src/verify-eligibility.ts`
- Test: `packages/core/src/__tests__/verify-eligibility.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/__tests__/verify-eligibility.test.ts
import { describe, it, expect } from "vitest";
import { isEligibleForVerify } from "../verify-eligibility.js";
import type { McpVerifyConfig, TrackerIssue } from "../types.js";

const cfg: McpVerifyConfig = {
  enabled: true,
  triggerLabel: "ui-verify",
  baseUrl: "http://localhost:3100",
  verifyWorktreeDir: "~/ao",
  startCommand: "pnpm dev",
  readyProbe: { url: "http://localhost:3100", timeoutSec: 60 },
  accounts: { default: { email: "a@b", password: "p" } },
  maxRetries: 2,
  timeoutSec: 300,
  uiVerifierPersona: "ui-verifier",
};

const issue = (labels: string[]): TrackerIssue => ({
  id: "1",
  title: "t",
  description: "",
  labels,
  status: "in-progress",
} as TrackerIssue);

describe("isEligibleForVerify", () => {
  it("returns true when label present", () => {
    expect(isEligibleForVerify(cfg, issue(["ui-verify"]))).toBe(true);
  });
  it("returns false when label absent", () => {
    expect(isEligibleForVerify(cfg, issue(["backend"]))).toBe(false);
  });
  it("returns false when mcpVerify is disabled", () => {
    expect(isEligibleForVerify({ ...cfg, enabled: false }, issue(["ui-verify"]))).toBe(false);
  });
  it("uses the configured trigger label, not the hardcoded default", () => {
    expect(isEligibleForVerify({ ...cfg, triggerLabel: "needs-browser" }, issue(["needs-browser"]))).toBe(true);
    expect(isEligibleForVerify({ ...cfg, triggerLabel: "needs-browser" }, issue(["ui-verify"]))).toBe(false);
  });
  it("handles null/undefined labels safely", () => {
    expect(isEligibleForVerify(cfg, issue([]))).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify fails**

```bash
pnpm --filter @composio/ao-core test -- verify-eligibility.test
```
Expected: FAIL with "Cannot find module ../verify-eligibility.js".

- [ ] **Step 3: Implement**

```typescript
// packages/core/src/verify-eligibility.ts
import type { McpVerifyConfig, TrackerIssue } from "./types.js";

/**
 * Pure function — given config + issue, returns whether MCP verify should run.
 * No side effects. Safe to call from anywhere in the lifecycle.
 */
export function isEligibleForVerify(
  config: McpVerifyConfig | undefined,
  issue: Pick<TrackerIssue, "labels"> | undefined,
): boolean {
  if (!config?.enabled) return false;
  const labels = issue?.labels ?? [];
  return labels.includes(config.triggerLabel);
}
```

- [ ] **Step 4: Run, verify passes**

```bash
pnpm --filter @composio/ao-core test -- verify-eligibility.test
```
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/verify-eligibility.ts packages/core/src/__tests__/verify-eligibility.test.ts
git commit -m "feat(core): add pure isEligibleForVerify helper"
```

### Task 1.4: Wire eligibility into `lifecycle-manager` (dry-run log only)

Goal: on `pr_open`, if eligible, emit an event that the verify reaction *would* fire. No verification actually runs yet — this is the plumbing.

**Files:**
- Modify: `packages/core/src/lifecycle-manager.ts` (in the reaction registration area and `executeReaction`)

- [ ] **Step 1: Add a new reaction key to `eventToReactionKey()`**

Add `"verify-ui"` to the reaction-key enum/union and map `pr_open` events to also enqueue `"verify-ui"` when the project has an `mcpVerify` config.

- [ ] **Step 2: Implement the reaction as a log-only stub**

```typescript
// Inside executeReaction(), add a new case:
case "verify-ui": {
  const issue = await tracker.getIssue(session.issueId);
  const cfg = projectConfig.mcpVerify;
  if (!isEligibleForVerify(cfg, issue)) {
    logger.info(`verify-ui: skipped (not eligible) session=${session.id}`);
    return;
  }
  logger.info(`verify-ui: would verify session=${session.id} pr=${session.prUrl ?? "?"}`);
  // Real implementation lands in Phase 5.
  return;
}
```

- [ ] **Step 3: Write an integration-ish test that the reaction is enqueued on pr_open with label**

```typescript
// In packages/core/src/__tests__/lifecycle-manager.test.ts (or create)
it("enqueues verify-ui reaction on pr_open when issue has trigger label", async () => {
  // ... set up lifecycle manager with a mock tracker returning issue with "ui-verify" label
  // ... simulate pr_open event
  // ... assert the "verify-ui" reaction was executed (spy on executeReaction)
});
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @composio/ao-core test
pnpm typecheck
pnpm lint
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/lifecycle-manager.ts packages/core/src/__tests__/lifecycle-manager.test.ts
git commit -m "feat(lifecycle): enqueue verify-ui reaction on pr_open (log-only stub)"
```

---

## Phase 2 — VerifyWorktreeManager

Lands the shared worktree owner with real git + server lifecycle. Can be driven from a test or ad-hoc script.

### Task 2.1: VerifyWorktreeManager — acquire (serialized) + checkout

**Files:**
- Create: `packages/core/src/verify-worktree-manager.ts`
- Test: `packages/core/src/__tests__/verify-worktree-manager.test.ts`

- [ ] **Step 1: Write failing tests for acquire serialization**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
// Mock execFile so we don't actually run git
vi.mock("node:child_process", () => ({
  execFile: vi.fn((cmd: string, args: string[], opts: unknown, cb: Function) => {
    cb(null, { stdout: "", stderr: "" });
  }),
}));

import { createVerifyWorktreeManager } from "../verify-worktree-manager.js";

describe("VerifyWorktreeManager.acquire", () => {
  it("serializes concurrent acquires — second waits for first.release()", async () => {
    const mgr = createVerifyWorktreeManager({ /* test config */ });
    const a = await mgr.acquire("my-app", "feat/a");
    let bResolved = false;
    const bPromise = mgr.acquire("my-app", "feat/b").then((h) => {
      bResolved = true;
      return h;
    });
    // Wait a tick; b should NOT be resolved yet
    await new Promise((r) => setTimeout(r, 10));
    expect(bResolved).toBe(false);
    await a.release();
    const b = await bPromise;
    expect(bResolved).toBe(true);
    await b.release();
  });

  it("runs git fetch + git checkout <branch> during acquire", async () => {
    const { execFile } = await import("node:child_process");
    const mgr = createVerifyWorktreeManager({ /* ... */ });
    const h = await mgr.acquire("my-app", "feat/x");
    const calls = (execFile as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.some((c) => c[0] === "git" && (c[1] as string[]).includes("fetch"))).toBe(true);
    expect(calls.some((c) => c[0] === "git" && (c[1] as string[])[0] === "checkout")).toBe(true);
    await h.release();
  });
});
```

- [ ] **Step 2: Run, verify fails**

```bash
pnpm --filter @composio/ao-core test -- verify-worktree-manager.test
```

- [ ] **Step 3: Implement with promise-chain mutex**

```typescript
// packages/core/src/verify-worktree-manager.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type { McpVerifyConfig } from "./types.js";

const execFileAsync = promisify(execFile);

export interface VerifyWorktreeHandle {
  path: string;
  baseUrl: string;
  release(): Promise<void>;
}

export interface VerifyWorktreeManager {
  acquire(projectId: string, branch: string): Promise<VerifyWorktreeHandle>;
}

interface Deps {
  projectPath: string;
  config: McpVerifyConfig;
}

export function createVerifyWorktreeManager(deps: Deps): VerifyWorktreeManager {
  let lock: Promise<void> = Promise.resolve();

  return {
    async acquire(projectId, branch) {
      // Chain onto the lock; our release() resolves the next waiter.
      let release!: () => void;
      const ours = new Promise<void>((r) => (release = r));
      const prev = lock;
      lock = lock.then(() => ours);
      await prev;

      const wtRoot = deps.config.verifyWorktreeDir.startsWith("~")
        ? resolve(homedir(), deps.config.verifyWorktreeDir.slice(2))
        : resolve(deps.config.verifyWorktreeDir);
      const path = resolve(wtRoot, projectId);

      // Ensure worktree exists; create it if first-time setup.
      // CHECK existence explicitly — don't swallow legitimate fetch errors.
      const worktrees = (
        await execFileAsync("git", ["-C", deps.projectPath, "worktree", "list", "--porcelain"], { timeout: 10_000 })
      ).stdout;
      const worktreeExists = worktrees.split("\n").some((line) => line === `worktree ${path}`);
      if (!worktreeExists) {
        await execFileAsync(
          "git",
          ["-C", deps.projectPath, "worktree", "add", path, branch],
          { timeout: 60_000 },
        );
      }
      // Fetch + checkout — errors here are real (network, bad branch name) and should propagate.
      await execFileAsync("git", ["-C", path, "fetch", "origin"], { timeout: 60_000 });
      await execFileAsync("git", ["-C", path, "checkout", branch], { timeout: 30_000 });

      return {
        path,
        baseUrl: deps.config.baseUrl,
        async release() {
          release();
        },
      };
    },
  };
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @composio/ao-core test -- verify-worktree-manager.test
pnpm typecheck
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/verify-worktree-manager.ts packages/core/src/__tests__/verify-worktree-manager.test.ts
git commit -m "feat(core): add VerifyWorktreeManager with serialized acquire"
```

### Task 2.2: Lockfile-gated install

**Files:**
- Modify: `packages/core/src/verify-worktree-manager.ts`
- Modify: `packages/core/src/__tests__/verify-worktree-manager.test.ts`

- [ ] **Step 1: Write failing test — install skipped when hash unchanged**

```typescript
it("runs pnpm install on first acquire, skips on second when lockfile hash unchanged", async () => {
  // ... mock fs.readFileSync for pnpm-lock.yaml to return the same content twice
  // ... acquire twice
  // ... assert pnpm install was called exactly once
});

it("runs pnpm install again when lockfile hash changes between acquires", async () => {
  // ... mock fs.readFileSync to return different content on 2nd call
  // ... assert pnpm install called twice
});
```

- [ ] **Step 2: Run, verify fails**

- [ ] **Step 3: Implement lockfile hash caching**

```typescript
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Module-level cache: projectId → last installed lockfile hash
const installedHashCache = new Map<string, string>();

// Inside acquire, after checkout:
const lockPath = resolve(path, "pnpm-lock.yaml");
let currentHash = "";
try {
  currentHash = createHash("sha256").update(readFileSync(lockPath)).digest("hex");
} catch {
  // No lockfile — force install
}
if (currentHash === "" || installedHashCache.get(projectId) !== currentHash) {
  await execFileAsync("pnpm", ["install"], { cwd: path, timeout: 300_000 });
  if (currentHash !== "") {
    installedHashCache.set(projectId, currentHash);
  }
}
```

- [ ] **Step 4: Run tests, pass**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(verify-worktree): lockfile-gated install"
```

### Task 2.3: Dev server start + ready probe + crash-tolerant release

**Files:**
- Modify: `packages/core/src/verify-worktree-manager.ts`
- Modify: `packages/core/src/__tests__/verify-worktree-manager.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
it("starts dev server via startCommand and waits for readyProbe to respond", async () => { /* ... */ });
it("release() stops the dev server process", async () => { /* ... */ });
it("release() does NOT throw when dev server has already exited", async () => {
  // Simulate process already dead before release() is called.
  // Assert release() resolves without error.
});
```

- [ ] **Step 2: Run, verify fails**

- [ ] **Step 3: Implement**

Use `spawn` (not `execFile`) for the dev server so we can kill it later. Poll the readyProbe URL until 200 OK or timeout. In `release()`, check `child.exitCode` before calling `child.kill()` — if already exited, just log and move on.

```typescript
import { spawn } from "node:child_process";
// ...
// Inside acquire:
// Use shell:true so `startCommand` can include env vars or quoted args
// (e.g. "PORT=3100 pnpm dev"). Config is user-controlled, not agent input,
// so shell invocation is acceptable here.
const server = spawn(deps.config.startCommand, {
  cwd: path,
  stdio: ["ignore", "pipe", "pipe"],
  shell: true,
});

// Poll readyProbe
const start = Date.now();
while (Date.now() - start < deps.config.readyProbe.timeoutSec * 1000) {
  try {
    const res = await fetch(deps.config.readyProbe.url);
    if (res.ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
}

return {
  path,
  baseUrl: deps.config.baseUrl,
  async release() {
    if (server.exitCode === null) {
      server.kill("SIGTERM");
      // Allow up to 5s for graceful shutdown, then SIGKILL
      await new Promise((r) => setTimeout(r, 5000));
      if (server.exitCode === null) server.kill("SIGKILL");
    } else {
      console.log(`verify dev server already exited (code=${server.exitCode})`);
    }
    release();
  },
};
```

- [ ] **Step 4: Run tests, pass**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(verify-worktree): dev server lifecycle with crash-tolerant release"
```

---

## Phase 3 — Verifier Agent Plugin + Persona

Ships the plugin scaffolding and persona. Does not yet run verification end-to-end — that lands in Phase 5.

### Task 3.1: Scaffold `packages/plugins/agent-claude-code-verifier/`

**Files:**
- Create: `packages/plugins/agent-claude-code-verifier/package.json`
- Create: `packages/plugins/agent-claude-code-verifier/tsconfig.json`
- Create: `packages/plugins/agent-claude-code-verifier/src/index.ts`

- [ ] **Step 1: Copy structure from `agent-claude-code` as the template**

```bash
cp -r packages/plugins/agent-claude-code packages/plugins/agent-claude-code-verifier
```

- [ ] **Step 2: Rename package in package.json**

```json
{
  "name": "@composio/ao-plugin-agent-claude-code-verifier",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": { ".": "./dist/index.js" },
  "scripts": { "build": "tsc -p .", "test": "vitest run" },
  "dependencies": {
    "@composio/ao-core": "workspace:*"
  }
}
```

- [ ] **Step 3: Replace src/index.ts with a thin wrapper**

```typescript
import type { Agent, PluginModule } from "@composio/ao-core";
import claudeCodePlugin from "@composio/ao-plugin-agent-claude-code";

export const manifest = {
  name: "claude-code-verifier",
  slot: "agent" as const,
  description: "Agent plugin: Claude Code configured as a UI verifier with MCP browser tools",
  version: "0.1.0",
};

export function create(): Agent {
  const base = claudeCodePlugin.create();
  return {
    ...base,
    name: "claude-code-verifier",
    // Override any agent-specific behavior here (persona forced, MCP tools bound, maxSessions: 1)
    // The real MCP tool binding lands in Task 3.3.
  };
}

export default { manifest, create } satisfies PluginModule<Agent>;
```

- [ ] **Step 4: Add to workspace and typecheck**

```bash
pnpm install   # picks up the new workspace package
pnpm --filter @composio/ao-plugin-agent-claude-code-verifier build
pnpm typecheck
```

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/agent-claude-code-verifier
git commit -m "feat(plugin): scaffold agent-claude-code-verifier"
```

### Task 3.2: Write the verifier persona

**Files:**
- Create: `personas/ui-verifier.md`

- [ ] **Step 1: Write the persona**

```markdown
# UI Verifier

You are a UI verification agent. Your job is to verify that a specific Pull Request's UI changes actually work in a real browser — not that the code compiles, but that the feature behaves correctly from a user's perspective.

## What you receive
- **PR title, body, and diff.** Read the diff to understand which routes/components changed.
- **Route hints.** Specific paths that the diff likely affects.
- **Verification section (optional).** If the PR body contains a `## Verification` section, treat it as the authoritative test plan — prioritize the scenarios it lists.
- **Available account roles** (e.g. `default`, `admin`). You do NOT see passwords; use the `ao_verify_login` MCP tool with the role name to log in.

## What you can do
- MCP browser tools: navigate, click, fill forms, read console, read network, screenshot.
- `ao_verify_login <role>` — log in as a named role. Call this before interacting with authenticated routes.

## What you must produce
Write the following JSON file and then exit your session:

**Path:** `{verifyWorktreeDir}/{project}/.ao-verify-result.json`

**Schema:**
```json
{
  "verdict": "pass" | "fail",
  "summary": "one paragraph, human-readable — what you tested and what you found",
  "screenshots": [{ "label": "string", "path": "absolute path to PNG" }],
  "observations": {
    "consoleErrors": ["string"],
    "networkFailures": ["string"],
    "stepsTaken": ["string"]
  }
}
```

## Verdict guidance
- `pass` — you were able to exercise the changed behavior and it worked as expected. No unhandled console errors. No critical network failures (4xx/5xx on requests the PR added).
- `fail` — either the change did not work as described, OR the browser surfaced errors that a user would notice. Include concrete details in `summary`.

## Style
- Be thorough but not wasteful. Screenshot meaningful states, not every click.
- Your summary is shown to humans and to the implementing agent. Be specific.
```

- [ ] **Step 2: Commit**

```bash
git add personas/ui-verifier.md
git commit -m "feat(persona): add ui-verifier persona"
```

### Task 3.3: Bind MCP browser tools + `ao_verify_login` to the verifier agent

**Files:**
- Modify: `packages/plugins/agent-claude-code-verifier/src/index.ts`

Scope: this wires the tool list the verifier agent exposes. Implementation of `ao_verify_login` itself lands in Phase 4 (Task 4.1). For now, the tool list just references the CLI subcommand we'll build next.

- [ ] **Step 1: Extend the plugin to write an MCP config into the VERIFY worktree**

The existing `agent-claude-code` plugin configures MCP servers via the `.mcp.json` file in the workspace. Extend the verifier variant to write an additional entry for the MCP browser tool and for the `ao_verify_login` shim.

**Important:** Write `.mcp.json` to the verify worktree path (the `VerifyWorktreeHandle.path` from Phase 2), **not** the implementing session's workspace. Sessions that use `claude-code` (not verifier) must not have their MCP config overwritten. The verifier session's workspace path (passed to `preLaunchSetup(workspacePath)`) should already be the verify worktree by the time this runs (the reaction handler passes `handle.path` as the session's workspace in Task 5.4).

**Note on `Agent` interface:** the actual interface exposes `preLaunchSetup(workspacePath: string): Promise<void>` (not a generic `setup(ctx)`). The verifier plugin overrides `preLaunchSetup` and chains `await base.preLaunchSetup?.(workspacePath)` before writing `.mcp.json`. The session manager (`packages/core/src/session-manager.ts`) invokes `preLaunchSetup` at spawn/restore time.

```typescript
// Inside create():
async preLaunchSetup(workspacePath) {
  await base.preLaunchSetup?.(workspacePath);
  // workspacePath is the verify worktree (handle.path), passed by the reaction handler
  const mcpConfigPath = resolve(workspacePath, ".mcp.json");
  const mcpConfig = {
    mcpServers: {
      "browser": {
        // TODO(before impl): confirm the actual MCP browser package name.
        // Candidates: Playwright-MCP (deterministic) or Claude-in-Chrome (richer events).
        // Spec §11 recommends Claude-in-Chrome for v1. Verify the published npm name
        // or binary path before committing this line.
        command: "npx",
        args: ["-y", "<mcp-browser-package-name>"],
      },
      "ao-verify-login": {
        command: "ao",
        args: ["verify-login"],    // thin shim, Task 4.1
      },
    },
  };
  await writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
},
```

- [ ] **Step 2: Enforce `maxSessions: 1` via manifest**

Add a plugin-level config field and have the session manager respect it. (If the session manager doesn't yet read a `maxSessions` field from plugins, add it — grep for existing `maxSessions` usage first.)

- [ ] **Step 3: Commit**

```bash
git commit -am "feat(verifier-agent): bind MCP browser + ao_verify_login tools"
```

---

## Phase 4 — Login Helper

### Task 4.1: `ao verify-login <role>` CLI subcommand

**Files:**
- Create: `packages/cli/src/commands/verify-login.ts`
- Modify: `packages/cli/src/index.ts` (register command)
- Test: `packages/cli/src/commands/__tests__/verify-login.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect, vi } from "vitest";
import { verifyLoginHandler } from "../verify-login.js";

describe("verify-login", () => {
  it("reads credentials from config for the requested role", async () => {
    const loadConfig = vi.fn().mockReturnValue({
      projects: {
        "my-app": {
          mcpVerify: {
            enabled: true,
            accounts: { admin: { email: "a@b", password: "pw" } },
            /* ... */
          },
        },
      },
    });
    const runLogin = vi.fn().mockResolvedValue({ success: true });
    await verifyLoginHandler({ role: "admin", project: "my-app", loadConfig, runLogin });
    expect(runLogin).toHaveBeenCalledWith(
      expect.objectContaining({ email: "a@b", password: "pw" }),
    );
  });

  it("never prints the password to stdout/stderr", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args) => logs.push(args.join(" "));
    console.error = (...args) => logs.push(args.join(" "));
    try {
      const loadConfig = vi.fn().mockReturnValue({
        projects: { p: { mcpVerify: { enabled: true, accounts: { default: { email: "e", password: "test-pw-sentinel" } } } } },
      });
      const runLogin = vi.fn().mockResolvedValue({ success: true });
      await verifyLoginHandler({ role: "default", project: "p", loadConfig, runLogin });
      expect(logs.join("\n")).not.toContain("test-pw-sentinel");
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  });

  it("returns exit code 1 and error message if role not found", async () => {
    // ...
  });
});
```

- [ ] **Step 2: Run, fail**

- [ ] **Step 3: Implement**

```typescript
// packages/cli/src/commands/verify-login.ts
import type { Command } from "commander";
import { loadConfig as realLoadConfig } from "@composio/ao-core";

interface Deps {
  role: string;
  project: string;
  loadConfig?: typeof realLoadConfig;
  runLogin?: (creds: { email: string; password: string }) => Promise<{ success: boolean; error?: string }>;
}

export async function verifyLoginHandler(deps: Deps): Promise<{ success: boolean; error?: string }> {
  const config = (deps.loadConfig ?? realLoadConfig)();
  const proj = config.projects[deps.project];
  const acct = proj?.mcpVerify?.accounts[deps.role];
  if (!acct) {
    return { success: false, error: `Role "${deps.role}" not configured for project "${deps.project}"` };
  }
  const runLogin = deps.runLogin ?? (async (creds) => {
    // Real implementation: drive the browser session via Playwright/MCP to perform login
    // For now, defer to the existing verify-runner login flow helpers
    return { success: true };
  });
  return runLogin(acct);
}

export function registerVerifyLogin(program: Command): void {
  program
    .command("verify-login <role>")
    .description("Log in as a named role in the current MCP Chrome session")
    .option("-p, --project <id>", "Project ID (auto-detected from CWD if omitted)")
    .action(async (role: string, opts: { project?: string }) => {
      const projectId = opts.project ?? detectProjectFromCwd();
      const result = await verifyLoginHandler({ role, project: projectId });
      // Print only success/failure, never credentials
      if (result.success) {
        console.log(`logged in as ${role}`);
        process.exit(0);
      } else {
        console.error(`login failed: ${result.error ?? "unknown"}`);
        process.exit(1);
      }
    });
}
```

- [ ] **Step 4: Tests pass**

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/verify-login.ts packages/cli/src/commands/__tests__/verify-login.test.ts packages/cli/src/index.ts
git commit -m "feat(cli): add verify-login subcommand with credential safety"
```

---

## Phase 5 — Result Reporter + Review-Comment Filter + Reaction Implementation

### Task 5.1: `comment-filter.ts` — exclude verifier comments from ingestion

**Files:**
- Create: `packages/plugins/scm-github/src/comment-filter.ts`
- Test: `packages/plugins/scm-github/src/__tests__/comment-filter.test.ts`

- [ ] **Step 1: Failing test**

```typescript
import { describe, it, expect } from "vitest";
import { filterAoVerifyComments } from "../comment-filter.js";

describe("filterAoVerifyComments", () => {
  it("excludes comments containing <!-- ao-verify: marker", () => {
    const comments = [
      { body: "LGTM!" },
      { body: "<!-- ao-verify:result -->\n✅ Verified\n" },
      { body: "please fix the bug" },
    ];
    expect(filterAoVerifyComments(comments)).toHaveLength(2);
  });
  it("does not mutate the input", () => {
    const comments = [{ body: "hi" }];
    filterAoVerifyComments(comments);
    expect(comments).toEqual([{ body: "hi" }]);
  });
  it("matches the marker anywhere in the body (not just prefix)", () => {
    expect(filterAoVerifyComments([{ body: "some text\n<!-- ao-verify:result --> trailing" }])).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run, fail**

- [ ] **Step 3: Implement**

```typescript
// packages/plugins/scm-github/src/comment-filter.ts
export const AO_VERIFY_MARKER = "<!-- ao-verify:";

export function filterAoVerifyComments<T extends { body: string }>(comments: readonly T[]): T[] {
  return comments.filter((c) => !c.body.includes(AO_VERIFY_MARKER));
}
```

- [ ] **Step 4: Pass**

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/scm-github/src/comment-filter.ts packages/plugins/scm-github/src/__tests__/comment-filter.test.ts
git commit -m "feat(scm-github): add comment-filter to exclude verifier comments"
```

### Task 5.2: Wire `comment-filter` into the review-comment ingestion pipeline

**Files:**
- Modify: `packages/plugins/scm-github/src/index.ts`

- [ ] **Step 1: Find the comment-ingestion entry point**

Grep for `listComments`, `getReviewComments`, or the function that feeds comments into the lifecycle's review-comment reaction. The exact entry point should be the method that returns comments to the lifecycle-manager.

- [ ] **Step 2: Add the filter at the earliest point — right after the Octokit call, before returning**

```typescript
import { filterAoVerifyComments } from "./comment-filter.js";

// Inside the comment-ingestion method, after fetching comments:
const raw = await octokit.rest.issues.listComments({ /* ... */ });
const filtered = filterAoVerifyComments(raw.data);
return filtered;
```

- [ ] **Step 3: Write a regression test asserting verifier comments do not reach downstream reactions**

- [ ] **Step 4: Commit**

```bash
git commit -am "feat(scm-github): filter ao-verify comments out of review ingestion"
```

### Task 5.3: `verify-reporter.ts` — post PR comment + update body status line

**Files:**
- Create: `packages/plugins/scm-github/src/verify-reporter.ts`
- Test: `packages/plugins/scm-github/src/__tests__/verify-reporter.test.ts`

- [ ] **Step 1: Failing tests**

```typescript
import { describe, it, expect, vi } from "vitest";
import { postVerifierComment, updatePrBodyStatusLine } from "../verify-reporter.js";
import { AO_VERIFY_MARKER } from "../comment-filter.js";

describe("postVerifierComment", () => {
  it("always starts the posted body with the ao-verify marker", async () => {
    const octokit = { rest: { issues: { createComment: vi.fn().mockResolvedValue({ data: { id: 1 } }) } } };
    await postVerifierComment(octokit as never, {
      owner: "o", repo: "r", prNumber: 1,
      result: { verdict: "pass", summary: "ok", screenshots: [], observations: { consoleErrors: [], networkFailures: [], stepsTaken: [] } },
    });
    const body = octokit.rest.issues.createComment.mock.calls[0][0].body as string;
    expect(body.startsWith(AO_VERIFY_MARKER)).toBe(true);
  });
});

describe("updatePrBodyStatusLine", () => {
  it("replaces existing <!-- ao-verify-status -->...<!-- /ao-verify-status --> block", async () => {
    const existing = "Some description\n\n<!-- ao-verify-status -->⏳ Pending<!-- /ao-verify-status -->\n\nMore text";
    const updated = updatePrBodyStatusLine(existing, "✅ Verified by ao at 12:34");
    expect(updated).toContain("✅ Verified by ao at 12:34");
    expect(updated).not.toContain("⏳ Pending");
    expect(updated).toContain("Some description");
    expect(updated).toContain("More text");
  });
  it("appends the block when not present", async () => {
    const existing = "Just description";
    const updated = updatePrBodyStatusLine(existing, "✅ Verified");
    expect(updated).toContain("Just description");
    expect(updated).toContain("<!-- ao-verify-status -->✅ Verified<!-- /ao-verify-status -->");
  });
});
```

- [ ] **Step 2: Run, fail**

- [ ] **Step 3: Implement**

```typescript
// packages/plugins/scm-github/src/verify-reporter.ts
import type { VerifierResult } from "@composio/ao-core";
import { AO_VERIFY_MARKER } from "./comment-filter.js";

const STATUS_BEGIN = "<!-- ao-verify-status -->";
const STATUS_END = "<!-- /ao-verify-status -->";
const STATUS_RE = new RegExp(`${STATUS_BEGIN}.*?${STATUS_END}`, "s");

export function updatePrBodyStatusLine(body: string, statusLine: string): string {
  const block = `${STATUS_BEGIN}${statusLine}${STATUS_END}`;
  if (STATUS_RE.test(body)) return body.replace(STATUS_RE, block);
  return `${body.trimEnd()}\n\n${block}\n`;
}

export async function postVerifierComment(
  octokit: /* Octokit instance */ unknown,
  args: { owner: string; repo: string; prNumber: number; result: VerifierResult },
): Promise<void> {
  const r = args.result;
  const icon = r.verdict === "pass" ? "✅" : "❌";
  const body = [
    `${AO_VERIFY_MARKER}result -->`,
    `${icon} **UI Verification: ${r.verdict.toUpperCase()}**`,
    "",
    r.summary,
    "",
    ...r.screenshots.map((s) => `![${s.label}](${s.path})`),
    r.observations.consoleErrors.length > 0 ? "<details><summary>Console errors</summary>\n\n" + r.observations.consoleErrors.join("\n") + "\n</details>" : "",
    r.observations.networkFailures.length > 0 ? "<details><summary>Network failures</summary>\n\n" + r.observations.networkFailures.join("\n") + "\n</details>" : "",
    "<details><summary>Steps taken</summary>\n\n" + r.observations.stepsTaken.join("\n") + "\n</details>",
  ].filter(Boolean).join("\n");

  await (octokit as { rest: { issues: { createComment: Function } } }).rest.issues.createComment({
    owner: args.owner,
    repo: args.repo,
    issue_number: args.prNumber,
    body,
  });
}
```

- [ ] **Step 4: Tests pass**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(scm-github): add verify-reporter with marker + status-line block"
```

### Task 5.4: Implement the real `verify-ui` reaction

Replaces the log-only stub from Task 1.4.

**Carryover notes from Task 1.4 code review** (address or explicitly defer — don't inherit silently):
- **Synthetic `ReactionConfig` at the enqueue site.** Task 1.4 bolted a parallel dispatch call onto `pr.created` with an inline `{ auto: true, action: "notify" }` config. Decide: (a) promote `"verify-ui"` into the normal `eventToReactionKey` + `config.reactions` pipeline so users can override it, or (b) keep `mcpVerify` as its own config surface and document the rationale. If (a), consider extending `eventToReactionKey` to return an array or adding `eventToReactionKeys`.
- **`action: "notify"` is a placeholder.** The real reaction spawns a sub-agent, which is closer to `send-to-agent`. Extend the `action` union (e.g. add `"verify-ui"`) or pick a reused value consciously.
- **Retry/escalation semantics.** The stub returns before `reactionTrackers` escalation logic, but `reactionTrackers` still accumulates `attempts` on every poll. Either use the standard escalation machinery for `verify-ui` (move the early return) OR maintain `session.verifyAttempts` independently (per plan Task 6.2) and reset/ignore the `reactionTrackers` entry.
- **Parallelism.** Once verify-ui does real work, consider whether it should run in parallel with the primary `pr-created` reaction (currently awaited sequentially).
- **Grep target.** Both stub sites are fenced with `// --- STUB: Task 1.4 ...` / `// --- end STUB ---` — find them via `grep -n "STUB: Task 1.4" packages/core/src/lifecycle-manager.ts`.

**Files:**
- Modify: `packages/core/src/lifecycle-manager.ts`

- [ ] **Step 1: Wire components together in the reaction**

```typescript
case "verify-ui": {
  const issue = await tracker.getIssue(session.issueId);
  const cfg = projectConfig.mcpVerify;
  if (!isEligibleForVerify(cfg, issue)) {
    session.verifyStatus = "not-required";
    await persistSession(session);
    return;
  }
  session.verifyStatus = "pending";
  session.verifyAttempts = (session.verifyAttempts ?? 0) + 1;
  await persistSession(session);

  const mgr = createVerifyWorktreeManager({ projectPath: projectConfig.path, config: cfg! });
  const handle = await mgr.acquire(projectId, session.branch!);
  try {
    // Compute diff + route hints
    const diff = await scm.getPrDiff(session.prNumber!);
    const routeHints = computeRouteHints(diff);
    const verificationSection = extractVerificationSection(session.prBody ?? "");

    // Spawn the verifier agent session
    const verifierSession = await sessionManager.spawn({
      projectId,
      agent: "claude-code-verifier",
      runtime: projectConfig.runtime,
      prompt: buildVerifierPrompt({
        prNumber: session.prNumber!,
        prTitle: session.prTitle!,
        prBody: session.prBody!,
        diff: truncateDiff(diff, 200_000),
        routeHints,
        verificationSection,
        baseUrl: handle.baseUrl,
        availableRoles: Object.keys(cfg!.accounts),
        timeoutSec: cfg!.timeoutSec,
      }),
      timeoutSec: cfg!.timeoutSec,
    });
    await verifierSession.wait();

    // Read the result JSON — guarded. Missing file or parse errors → treat as fail.
    const resultPath = resolve(handle.path, ".ao-verify-result.json");
    let result: VerifierResult;
    try {
      const raw = JSON.parse(readFileSync(resultPath, "utf8"));
      result = VerifierResultSchema.parse(raw);  // Zod-validate
    } catch (err) {
      logger.warn(`verify-ui: could not read/parse result at ${resultPath}: ${err}`);
      result = {
        verdict: "fail",
        summary: `Verifier exited without a valid result file. Error: ${err instanceof Error ? err.message : String(err)}`,
        screenshots: [],
        observations: { consoleErrors: [], networkFailures: [], stepsTaken: [] },
      };
    }

    session.verifyStatus = result.verdict === "pass" ? "passed" : "failed";
    await persistSession(session);

    // Post PR comment + update body status line
    await postVerifierComment(octokit, { owner, repo, prNumber: session.prNumber!, result });
    const prBody = await scm.getPrBody(session.prNumber!);
    await scm.updatePrBody(session.prNumber!, updatePrBodyStatusLine(prBody, `${result.verdict === "pass" ? "✅" : "❌"} Verified by ao at ${new Date().toISOString()}`));

    if (result.verdict === "fail" && (session.verifyAttempts ?? 0) < cfg!.maxRetries) {
      // Dispatch in-session message to the implementing agent (NOT a PR comment)
      await sessionManager.sendMessage(session.id, `UI verification failed (attempt ${session.verifyAttempts}/${cfg!.maxRetries}):\n\n${result.summary}\n\nSee PR comment for details. Fix and push.`);
    } else if (result.verdict === "fail") {
      await notifier.notify({ title: "UI verification failed", body: result.summary, url: session.prUrl });
    }
  } catch (err) {
    session.verifyStatus = "failed";
    await persistSession(session);
    logger.error(`verify-ui reaction errored: ${err}`);
  } finally {
    await handle.release();
  }
  return;
}
```

Note: helper functions (`computeRouteHints`, `extractVerificationSection`, `truncateDiff`, `buildVerifierPrompt`, `VerifierResultSchema`) should be small private functions in this file or a sibling `verify-reaction-helpers.ts`. Write them with unit tests.

- [ ] **Step 2: Write unit tests for each helper**

- [ ] **Step 3: Write an integration test of the full reaction using mocked dependencies**

- [ ] **Step 4: Run all tests**

```bash
pnpm test
pnpm typecheck
pnpm lint
```

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(lifecycle): implement verify-ui reaction end-to-end"
```

---

## Phase 6 — Auto-Merge Gate + Retry-on-Push + Notifier Escalation

### Task 6.1: Gate auto-merge on `verifyStatus`

**Files:**
- Modify: `packages/core/src/lifecycle-manager.ts` (auto-merge logic)

- [ ] **Step 1: Failing test**

```typescript
it("auto-merge blocks when verifyStatus is pending or failed", async () => { /* ... */ });
it("auto-merge proceeds when verifyStatus is passed or not-required", async () => { /* ... */ });
```

- [ ] **Step 2: Run, fail**

- [ ] **Step 3: Extend the auto-merge gate**

In the auto-merge branch, add:
```typescript
if (session.verifyStatus && session.verifyStatus !== "passed" && session.verifyStatus !== "not-required") {
  logger.info(`auto-merge blocked: verifyStatus=${session.verifyStatus}`);
  return;
}
```

- [ ] **Step 4: Pass**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(lifecycle): gate auto-merge on verifyStatus"
```

### Task 6.2: Re-run verify on new push after failure

**Files:**
- Modify: `packages/core/src/lifecycle-manager.ts` (push-to-pr event handler)

- [ ] **Step 1: Failing test**

```typescript
it("enqueues verify-ui again when a push lands on a PR whose last verifyStatus was failed", async () => { /* ... */ });
it("does NOT re-enqueue when attempts == maxRetries", async () => { /* ... */ });
```

- [ ] **Step 2: Run, fail**

- [ ] **Step 3: Implement**

On the `push_detected` / PR update event, if `session.verifyStatus === "failed"` and `session.verifyAttempts < cfg.maxRetries`:

1. **Reset `session.verifyStatus` to `"pending"`** and persist (so the auto-merge gate does not see a stale `failed` while the re-run is in flight, and any dashboard polling reflects the fresh run).
2. Enqueue `"verify-ui"` again.

```typescript
if (session.verifyStatus === "failed" && (session.verifyAttempts ?? 0) < cfg.maxRetries) {
  session.verifyStatus = "pending";
  await persistSession(session);
  await enqueueReaction(session, "verify-ui");
}
```

- [ ] **Step 4: Pass**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(lifecycle): re-run verify on push after failure"
```

### Task 6.3: Notifier escalation on final failure

**Files:**
- Modify: `packages/core/src/lifecycle-manager.ts` (inside the verify-ui reaction's fail branch)

- [ ] **Step 1: Failing test asserting notifier called when attempts == maxRetries**

- [ ] **Step 2: Wire**

Already stubbed in Task 5.4. Verify the call to `notifier.notify()` happens when `session.verifyAttempts >= cfg.maxRetries`.

- [ ] **Step 3: Commit**

```bash
git commit -am "feat(lifecycle): escalate UI verify failure to notifier after maxRetries"
```

---

## Phase 7 — Docs, example config, agent prompt nudge

### Task 7.1: Update `agent-orchestrator.yaml.example`

- [ ] Add an example `mcpVerify:` block mirroring the config schema in the spec.
- [ ] Commit: `docs(config): example mcpVerify block`

### Task 7.2: Nudge in `BASE_AGENT_PROMPT` to write `## Verification`

**Files:**
- Modify: `packages/core/src/prompt-builder.ts` (`BASE_AGENT_PROMPT`)

- [ ] Add a short instruction: *"If your change is user-visible in the UI, include a `## Verification` section in the PR body listing concrete scenarios a reviewer should check in a browser."*
- [ ] Commit: `feat(prompt): nudge agents to author PR Verification sections`

### Task 7.3: README / docs section

- [ ] Add a short section to the top-level README (or a new `docs/ui-verify.md`) covering: what it does, how to enable (label + config), how to customize persona.
- [ ] Commit: `docs: add UI verify guide`

---

## Running the Full Suite

Before marking the plan done:

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

All green.

## Manual Smoke Test

1. Configure a local project with `mcpVerify` in `agent-orchestrator.yaml`.
2. Create a test ticket with the `ui-verify` label.
3. Spawn a session, let it open a PR.
4. Watch the verifier session spawn in the dashboard.
5. Watch Chrome drive itself.
6. Confirm PR comment appears with the marker, PR body status line updates, auto-merge blocks until verdict passes.
7. Confirm the verifier's own comment does NOT appear as a reviewer-feedback event for the implementing agent (check session event log).
