# Scope Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent agents from making changes outside the ticket's stated scope. Primary defense: a new `ao scope-check` CLI command the agent runs **before** `gh pr create` — it exits non-zero on violation and lists offending files, forcing the agent to revert before opening a PR. Safety net: an orchestrator-side post-PR check that catches cases where the agent skipped the pre-check or force-pushed out-of-scope changes; violations fire a `pr.scope_violation` event that `send-to-agent` (with retries + human escalation) handles.

**Architecture:** Two enforcement layers:

1. **Pre-PR (primary, agent-driven):** `ao scope-check` reads scope from a `.ao/scope` file written into the workspace at spawn, runs `git diff --name-only $(git merge-base HEAD <base>)..HEAD`, and calls `checkScope()`. Exit non-zero ⇒ agent must revert. Mirrors the existing `ao verify` pattern.
2. **Post-PR (safety net, orchestrator-side):** lifecycle manager runs the same `checkScope()` on every PR poll using `SCM.getChangedFiles()`, idempotent on PR HEAD SHA. Violations emit `pr.scope_violation` → existing reaction system (`send-to-agent`, retries: 2, escalateAfter: 30m).

Scope is sourced from a `<!-- ao-scope: globA, globB -->` marker in the issue body (parsed by tracker plugins into `Issue.scope`), falling back to a per-project `scope.defaultAllow`. Resolved scope is persisted to `metadata.scopeGlobs` and `<workspace>/.ao/scope` at spawn. `BASE_AGENT_PROMPT` is strengthened with scope-discipline rules and correction-handling rules (re-verify, not defend) — and instructs the agent to run `ao scope-check` before `gh pr create`.

**Tech Stack:** TypeScript (ESM), Node 20+, vitest, Zod, micromatch (new dep), Commander.js (CLI).

**Out of scope (future plans):**
- LLM-derived scope inference at spawn time when no marker is present.
- Reviewer-agent that reads ticket text + diff and flags semantic creep within in-scope files.
- Pre-commit / pre-push git hooks installed via `setupWorkspaceHooks` (hard mechanical bound the agent cannot bypass).
- Machine-parsed scope-expansion request flow (`ao-scope-expand: <reason>` markers in PR comments).

---

## File Structure

**New files:**
- `packages/core/src/scope-marker.ts` — parser for `<!-- ao-scope: globs -->` markers in issue bodies.
- `packages/core/src/scope-marker.test.ts`
- `packages/core/src/scope-checker.ts` — glob-based diff guard (pure function over file lists).
- `packages/core/src/scope-checker.test.ts`
- `packages/cli/src/commands/scope-check.ts` — `ao scope-check` command (primary pre-PR check).
- `packages/cli/src/commands/__tests__/scope-check.test.ts`

**Modified files:**
- `packages/core/src/types.ts` — add `ScopeConfig`, `ScopeViolation`, extend `ProjectConfig.scope`, `Issue.scope`, `SessionMetadata.scopeGlobs` & `scopeCheckedSha`, add `pr.scope_violation` event type, add optional `SCM.getPRHeadSha`.
- `packages/core/src/config.ts` — Zod schema for `ScopeConfig`.
- `packages/core/src/lifecycle-manager.ts` — wire post-PR scope check, emit `pr.scope_violation`, map to reaction key.
- `packages/core/src/prompt-builder.ts` — strengthen `BASE_AGENT_PROMPT` (scope discipline + correction-handling, instruct `ao scope-check` before PR), append per-session scope info when present.
- `packages/core/src/session-manager.ts` — when spawning, resolve scope (issue marker → project default), persist to `metadata.scopeGlobs`, and write `<workspace>/.ao/scope` for the CLI command to read.
- `packages/core/src/index.ts` — re-export `parseScopeMarker`, `checkScope`, scope types for CLI/plugin use.
- `packages/cli/src/index.ts` — register the `scope-check` command.
- `packages/plugins/tracker-github/src/index.ts` — parse `<!-- ao-scope -->` marker in `getIssue`, populate `Issue.scope`.
- `packages/plugins/tracker-linear/src/index.ts` — same.
- `packages/plugins/scm-github/src/index.ts` — implement `getPRHeadSha`.
- `packages/core/package.json` — add `micromatch` + `@types/micromatch`.
- `agent-orchestrator.yaml.example` — document the new `scope` block and the `pr-scope-violation` reaction.
- `CLAUDE.md` — add a "Scope Guard" section.

**Test layout:** co-located `*.test.ts` next to module + integration test in `packages/core/src/__tests__/`.

---

## Task 1: Add scope types to `types.ts`

**Files:**
- Modify: `packages/core/src/types.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/scope-types.test.ts`:

```typescript
import { describe, it, expectTypeOf } from "vitest";
import type { ScopeConfig, ScopeViolation, ProjectConfig, Issue, SessionMetadata, EventType } from "../types.js";

describe("scope types", () => {
  it("ScopeConfig has expected shape", () => {
    const c: ScopeConfig = {
      defaultAllow: ["src/**"],
      alwaysDeny: ["**/.github/**"],
      onViolation: "ask-agent-to-revert",
      maxFiles: 50,
      maxLines: 2000,
    };
    expectTypeOf(c.onViolation).toEqualTypeOf<"block" | "warn" | "ask-agent-to-revert">();
  });

  it("ProjectConfig.scope is optional ScopeConfig", () => {
    expectTypeOf<ProjectConfig["scope"]>().toEqualTypeOf<ScopeConfig | undefined>();
  });

  it("Issue.scope is optional string array", () => {
    expectTypeOf<Issue["scope"]>().toEqualTypeOf<string[] | undefined>();
  });

  it("SessionMetadata has scopeGlobs and scopeCheckedSha", () => {
    expectTypeOf<SessionMetadata["scopeGlobs"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<SessionMetadata["scopeCheckedSha"]>().toEqualTypeOf<string | undefined>();
  });

  it("EventType includes pr.scope_violation", () => {
    const e: EventType = "pr.scope_violation";
    expectTypeOf(e).toEqualTypeOf<EventType>();
  });

  it("ScopeViolation shape", () => {
    const v: ScopeViolation = {
      offending: ["src/a.ts"],
      allowed: ["src/sports/**"],
      reason: "out-of-scope-files",
    };
    expectTypeOf(v.reason).toEqualTypeOf<"out-of-scope-files" | "always-denied" | "too-many-files" | "too-many-lines">();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @composio/ao-core test -- scope-types`
Expected: FAIL — `ScopeConfig`, `ScopeViolation`, etc. not exported.

- [ ] **Step 3: Add types to `types.ts`**

(Note: line numbers may drift. Use anchor strings — search for the named markers — rather than line numbers.)

Add near the existing `VerifyConfig` block (search for `export interface VerifyConfig`):

```typescript
/** Scope enforcement: bound where agents may make changes. */
export interface ScopeConfig {
  /** Globs of files agents may change by default (overridden by issue scope when present). */
  defaultAllow?: string[];
  /** Globs always blocked regardless of issue scope (CI configs, lockfiles, infra). */
  alwaysDeny?: string[];
  /** What to do on violation. v1 supports "ask-agent-to-revert" only; "block" / "warn" reserved. */
  onViolation: "block" | "warn" | "ask-agent-to-revert";
  /** Max changed files; exceed → violation. */
  maxFiles?: number;
  /** Max added+removed lines; exceed → violation. */
  maxLines?: number;
}

export interface ScopeViolation {
  /** Files (or counts) that violated scope. */
  offending: string[];
  /** Globs that were enforced. */
  allowed: string[];
  /** Why this is a violation. */
  reason: "out-of-scope-files" | "always-denied" | "too-many-files" | "too-many-lines";
  /** When `reason` is too-many-*, the actual count. */
  count?: number;
  /** When `reason` is too-many-*, the limit that was exceeded. */
  limit?: number;
}
```

Then (search-by-anchor):

1. Add `scope?: ScopeConfig;` to `ProjectConfig` (search `verify?: VerifyConfig`).
2. Add `scope?: string[];` to `Issue` (search `priority?: number;` inside `export interface Issue`).
3. Add `scopeGlobs?: string;` and `scopeCheckedSha?: string;` to `SessionMetadata` (search `worktreeCleanedAt?:`).
4. Add `| "pr.scope_violation"` to `EventType` (search the `// PR lifecycle` comment in the union).
5. Add `getPRHeadSha?(pr: PRInfo): Promise<string | null>;` to the `SCM` interface (search `getChangedFiles?(pr: PRInfo)` and add next to it):
   ```typescript
   /** Get the current HEAD commit SHA of the PR branch. Used for idempotent scope checks. */
   getPRHeadSha?(pr: PRInfo): Promise<string | null>;
   ```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @composio/ao-core test -- scope-types && pnpm --filter @composio/ao-core typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/__tests__/scope-types.test.ts
git commit -m "feat(core): add scope guard types (ScopeConfig, ScopeViolation, EventType, SCM.getPRHeadSha)"
```

---

## Task 2: Scope marker parser

**Files:**
- Create: `packages/core/src/scope-marker.ts`
- Create: `packages/core/src/scope-marker.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { parseScopeMarker } from "./scope-marker.js";

describe("parseScopeMarker", () => {
  it("returns null when no marker present", () => {
    expect(parseScopeMarker("Just a regular issue body.")).toBeNull();
    expect(parseScopeMarker("")).toBeNull();
    expect(parseScopeMarker(undefined as unknown as string)).toBeNull();
  });

  it("parses a single glob", () => {
    expect(parseScopeMarker("Body\n<!-- ao-scope: src/sports/** -->\nMore"))
      .toEqual(["src/sports/**"]);
  });

  it("parses multiple comma-separated globs", () => {
    expect(parseScopeMarker("<!-- ao-scope: src/sports/**, !src/sports/apis/** -->"))
      .toEqual(["src/sports/**", "!src/sports/apis/**"]);
  });

  it("trims whitespace inside the marker", () => {
    expect(parseScopeMarker("<!--   ao-scope:   src/a/**  ,   src/b/**   -->"))
      .toEqual(["src/a/**", "src/b/**"]);
  });

  it("ignores marker content that is empty", () => {
    expect(parseScopeMarker("<!-- ao-scope: -->")).toBeNull();
    expect(parseScopeMarker("<!-- ao-scope:    -->")).toBeNull();
  });

  it("returns the first marker when multiple present", () => {
    expect(parseScopeMarker("<!-- ao-scope: src/a/** -->\n<!-- ao-scope: src/b/** -->"))
      .toEqual(["src/a/**"]);
  });

  it("is case-insensitive on the keyword", () => {
    expect(parseScopeMarker("<!-- AO-SCOPE: src/x/** -->"))
      .toEqual(["src/x/**"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @composio/ao-core test -- scope-marker`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the parser**

Create `packages/core/src/scope-marker.ts`:

```typescript
const MARKER_RE = /<!--\s*ao-scope\s*:\s*([^>]*?)\s*-->/i;

/**
 * Parse a `<!-- ao-scope: globA, globB -->` marker out of free-form text.
 * Returns the list of trimmed, non-empty globs, or null if no marker / empty marker.
 */
export function parseScopeMarker(body: string | null | undefined): string[] | null {
  if (!body) return null;
  const m = MARKER_RE.exec(body);
  if (!m) return null;
  const globs = m[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return globs.length > 0 ? globs : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @composio/ao-core test -- scope-marker`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/scope-marker.ts packages/core/src/scope-marker.test.ts
git commit -m "feat(core): add scope marker parser for issue bodies"
```

---

## Task 3: Scope checker (diff guard)

**Files:**
- Create: `packages/core/src/scope-checker.ts`
- Create: `packages/core/src/scope-checker.test.ts`
- Modify: `packages/core/package.json` (add `micromatch`, `@types/micromatch`)

- [ ] **Step 1: Add the dependency**

Run from repo root:

```bash
pnpm --filter @composio/ao-core add micromatch
pnpm --filter @composio/ao-core add -D @types/micromatch
```

Expected: `packages/core/package.json` gains `"micromatch"` in dependencies and `"@types/micromatch"` in devDependencies. Lockfile updated.

- [ ] **Step 2: Write the failing test**

Create `packages/core/src/scope-checker.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { checkScope } from "./scope-checker.js";

describe("checkScope", () => {
  it("returns null when all files match allowed globs", () => {
    expect(checkScope({
      changedFiles: ["src/sports/foo.ts", "src/sports/bar.tsx"],
      allowed: ["src/sports/**"],
    })).toBeNull();
  });

  it("flags out-of-scope files", () => {
    const v = checkScope({
      changedFiles: ["src/sports/foo.ts", "src/admin/bar.ts"],
      allowed: ["src/sports/**"],
    });
    expect(v).not.toBeNull();
    expect(v!.reason).toBe("out-of-scope-files");
    expect(v!.offending).toEqual(["src/admin/bar.ts"]);
    expect(v!.allowed).toEqual(["src/sports/**"]);
  });

  it("supports negation in allowed globs", () => {
    const v = checkScope({
      changedFiles: ["src/sports/apis/x.ts"],
      allowed: ["src/sports/**", "!src/sports/apis/**"],
    });
    expect(v?.reason).toBe("out-of-scope-files");
    expect(v?.offending).toEqual(["src/sports/apis/x.ts"]);
  });

  it("alwaysDeny wins over allowed", () => {
    const v = checkScope({
      changedFiles: ["src/sports/foo.ts", ".github/workflows/ci.yml"],
      allowed: ["**"],
      alwaysDeny: ["**/.github/**"],
    });
    expect(v?.reason).toBe("always-denied");
    expect(v?.offending).toEqual([".github/workflows/ci.yml"]);
  });

  it("flags too-many-files", () => {
    const files = Array.from({ length: 60 }, (_, i) => `src/sports/f${i}.ts`);
    const v = checkScope({
      changedFiles: files,
      allowed: ["src/sports/**"],
      maxFiles: 50,
    });
    expect(v?.reason).toBe("too-many-files");
    expect(v?.count).toBe(60);
    expect(v?.limit).toBe(50);
  });

  it("flags too-many-lines when totalLines provided", () => {
    const v = checkScope({
      changedFiles: ["src/sports/foo.ts"],
      allowed: ["src/sports/**"],
      maxLines: 100,
      totalLines: 500,
    });
    expect(v?.reason).toBe("too-many-lines");
    expect(v?.count).toBe(500);
    expect(v?.offending).toEqual(["src/sports/foo.ts"]);
  });

  it("returns null when no allowed globs (scope guard disabled)", () => {
    expect(checkScope({
      changedFiles: ["anything.ts"],
      allowed: [],
    })).toBeNull();
  });

  it("normalizes leading ./ in changed files", () => {
    expect(checkScope({
      changedFiles: ["./src/sports/foo.ts"],
      allowed: ["src/sports/**"],
    })).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @composio/ao-core test -- scope-checker`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the checker**

Create `packages/core/src/scope-checker.ts`:

```typescript
import micromatch from "micromatch";
import type { ScopeViolation } from "./types.js";

export interface CheckScopeInput {
  changedFiles: string[];
  allowed: string[];
  alwaysDeny?: string[];
  maxFiles?: number;
  maxLines?: number;
  /** Total added+removed lines; only enforced if maxLines also set. */
  totalLines?: number;
}

/**
 * Pure function. Returns the first violation found, or null if scope is satisfied.
 * Order of precedence: alwaysDeny > out-of-scope-files > too-many-files > too-many-lines.
 */
export function checkScope(input: CheckScopeInput): ScopeViolation | null {
  const { allowed, alwaysDeny, maxFiles, maxLines, totalLines } = input;
  const changedFiles = input.changedFiles.map((f) => f.replace(/^\.\//, ""));

  if (allowed.length === 0) return null; // disabled

  // IMPORTANT: use the array-filter form `micromatch(files, patterns)`, NOT
  // `micromatch.isMatch(file, patterns)`. The latter evaluates each pattern
  // independently against a single file and does not compose `!negation`
  // patterns correctly (a positive followed by a negation gets ignored).
  // The array form applies all patterns as a pipeline (positives include,
  // negations exclude), which is what we want.

  if (alwaysDeny && alwaysDeny.length > 0) {
    const denied = micromatch(changedFiles, alwaysDeny);
    if (denied.length > 0) {
      return { offending: denied, allowed, reason: "always-denied" };
    }
  }

  const matchedSet = new Set(micromatch(changedFiles, allowed));
  const offending = changedFiles.filter((f) => !matchedSet.has(f));
  if (offending.length > 0) {
    return { offending, allowed, reason: "out-of-scope-files" };
  }

  if (maxFiles !== undefined && changedFiles.length > maxFiles) {
    return {
      offending: changedFiles,
      allowed,
      reason: "too-many-files",
      count: changedFiles.length,
      limit: maxFiles,
    };
  }

  if (maxLines !== undefined && totalLines !== undefined && totalLines > maxLines) {
    return {
      offending: changedFiles,
      allowed,
      reason: "too-many-lines",
      count: totalLines,
      limit: maxLines,
    };
  }

  return null;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @composio/ao-core test -- scope-checker`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/scope-checker.ts packages/core/src/scope-checker.test.ts \
        packages/core/package.json pnpm-lock.yaml
git commit -m "feat(core): add scope checker (glob-based diff guard)"
```

---

## Task 4: Wire scope into Zod config schema

**Files:**
- Modify: `packages/core/src/config.ts`
- Modify: `packages/core/src/__tests__/config-validation.test.ts`

- [ ] **Step 1: Read the existing config schema**

Run: `grep -n "VerifyConfig\|ProjectConfig\|z.object" packages/core/src/config.ts | head -30`
Identify where `verify:` is parsed in the project schema (mirror that pattern).

- [ ] **Step 2: Write the failing test**

Append to `packages/core/src/__tests__/config-validation.test.ts`:

```typescript
const VALID_SCOPE_YAML = `
defaults: { runtime: tmux, agent: claude-code, workspace: worktree, notifiers: [] }
projects:
  app:
    name: app
    repo: foo/bar
    path: /tmp/x
    defaultBranch: main
    sessionPrefix: a
    scope:
      defaultAllow: ["src/**"]
      alwaysDeny: ["**/.github/**"]
      onViolation: ask-agent-to-revert
      maxFiles: 50
notifiers: {}
notificationRouting: {}
reactions: {}
`;

const INVALID_SCOPE_YAML = `
defaults: { runtime: tmux, agent: claude-code, workspace: worktree, notifiers: [] }
projects:
  app:
    name: app
    repo: foo/bar
    path: /tmp/x
    defaultBranch: main
    sessionPrefix: a
    scope:
      onViolation: nuke
notifiers: {}
notificationRouting: {}
reactions: {}
`;

describe("ScopeConfig validation", () => {
  it("accepts a valid scope block", () => {
    expect(() => parseConfig(VALID_SCOPE_YAML, "/tmp/agent-orchestrator.yaml")).not.toThrow();
  });

  it("rejects unknown onViolation value", () => {
    expect(() => parseConfig(INVALID_SCOPE_YAML, "/tmp/agent-orchestrator.yaml"))
      .toThrow(/onViolation/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @composio/ao-core test -- config-validation`
Expected: FAIL.

- [ ] **Step 4: Add the schema**

In `packages/core/src/config.ts`, add a `ScopeConfigSchema`:

```typescript
const ScopeConfigSchema = z.object({
  defaultAllow: z.array(z.string()).optional(),
  alwaysDeny: z.array(z.string()).optional(),
  onViolation: z.enum(["block", "warn", "ask-agent-to-revert"]),
  maxFiles: z.number().int().positive().optional(),
  maxLines: z.number().int().positive().optional(),
}).strict();
```

Add `scope: ScopeConfigSchema.optional()` to the `ProjectConfigSchema`.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @composio/ao-core test -- config-validation && pnpm --filter @composio/ao-core typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/config.ts packages/core/src/__tests__/config-validation.test.ts
git commit -m "feat(core): validate scope block in project config (Zod)"
```

---

## Task 5: Tracker plugins parse scope marker

**Files:**
- Modify: `packages/plugins/tracker-github/src/index.ts`
- Modify: `packages/plugins/tracker-linear/src/index.ts`
- Modify: `packages/core/src/index.ts` (re-export `parseScopeMarker`)
- Test: existing test files for each plugin (or create `__tests__/` if not present)

- [ ] **Step 1: Re-export `parseScopeMarker` from core**

In `packages/core/src/index.ts` add:

```typescript
export { parseScopeMarker } from "./scope-marker.js";
```

- [ ] **Step 2: Write the failing tests**

For `tracker-github`, create or extend `packages/plugins/tracker-github/src/__tests__/getIssue.test.ts`. Mirror the existing mock pattern — read another test in the same plugin first to see how `execFile` / `gh` is currently stubbed.

Use these concrete fixture bodies:

```typescript
const BODY_WITH_MARKER = "Closes SPOR-2921\n\n<!-- ao-scope: src/sports/** -->\n\nDescription...";
const BODY_NO_MARKER   = "Closes SPOR-2921\n\nDescription with no marker.";

it("populates Issue.scope from <!-- ao-scope --> marker in body", async () => {
  // arrange: stub gh to return BODY_WITH_MARKER
  // act:
  const issue = await tracker.getIssue("1", project);
  // assert
  expect(issue.scope).toEqual(["src/sports/**"]);
});

it("leaves Issue.scope undefined when no marker", async () => {
  // arrange: stub gh to return BODY_NO_MARKER
  expect(issue.scope).toBeUndefined();
});
```

For `tracker-linear`, mirror the same shape — stub the Linear SDK's issue fetch with an issue whose `description` is `BODY_WITH_MARKER` / `BODY_NO_MARKER`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @composio/ao-tracker-github test && pnpm --filter @composio/ao-tracker-linear test`
Expected: FAIL — `result.scope` undefined when marker present.

- [ ] **Step 4: Wire the parser into both plugins**

In each plugin's `getIssue`, do **not** rewrite the return literal — read the existing return statement and spread it, only adding `scope`:

```typescript
import { parseScopeMarker } from "@composio/ao-core";

// inside getIssue, after the existing issue object is computed:
const scope = parseScopeMarker(issue.description) ?? undefined;
return { ...issue, scope };
```

If the existing implementation builds the object inline (no intermediate variable), refactor it minimally — assign to `const issue = {...}` first, then return `{ ...issue, scope }`. Avoid copy-pasting an explicit field list, which would silently drop fields if `Issue` gains new optional fields later.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm -r test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/index.ts \
        packages/plugins/tracker-github/src/index.ts packages/plugins/tracker-github/src/__tests__/ \
        packages/plugins/tracker-linear/src/index.ts packages/plugins/tracker-linear/src/__tests__/
git commit -m "feat(trackers): parse ao-scope marker from issue bodies"
```

---

## Task 6: Persist scope in metadata + workspace at spawn

**Files:**
- Modify: `packages/core/src/session-manager.ts`
- Modify: `packages/core/src/__tests__/session-manager.test.ts`

**Important coupling notes:**
- The resolved `string[]` of scope globs is needed in **three** places at spawn time: written to metadata (this task), written to `<workspace>/.ao/scope` for the CLI (this task), and passed into `buildPrompt` (Task 8). Compute it **once** as a `string[]` and reuse for all three. Do not derive the array elsewhere by re-splitting the comma-joined metadata string.

- [ ] **Step 1: Write the failing tests**

```typescript
it("persists scope to metadata.scopeGlobs when issue has scope", async () => {
  // arrange: mock tracker.getIssue to return Issue with scope: ["src/sports/**"]
  // act: sessionManager.spawn({ projectId, issueId: "1" })
  // assert: written metadata file contains scopeGlobs="src/sports/**"
});

it("falls back to project.scope.defaultAllow when issue has no scope", async () => {
  // arrange: issue without scope, project with scope.defaultAllow: ["src/**"]
  // assert: scopeGlobs="src/**"
});

it("leaves scopeGlobs unset when neither issue nor project specifies scope", async () => {
  // assert: metadata.scopeGlobs is undefined
});

it("writes resolved globs to <workspace>/.ao/scope (newline-separated)", async () => {
  // arrange: issue scope ["src/sports/**", "!src/sports/apis/**"]
  // act: spawn
  // assert: read <workspace>/.ao/scope, expect "src/sports/**\n!src/sports/apis/**\n"
});

it("does not write .ao/scope when no scope is resolved", async () => {
  // arrange: no issue scope, no project default
  // assert: <workspace>/.ao/scope does not exist
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @composio/ao-core test -- session-manager`
Expected: FAIL.

- [ ] **Step 3: Wire scope resolution into spawn**

In `session-manager.ts` `spawn()`, after the tracker fetch and after the workspace exists:

```typescript
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

// ... after issue and workspace.path are available:
const issueScope = issue?.scope;
const projectScope = project.scope?.defaultAllow;
const resolvedScope: string[] | undefined = issueScope ?? projectScope;

if (resolvedScope && resolvedScope.length > 0) {
  // 1. metadata (comma-joined string for flat-file format)
  metadata.scopeGlobs = resolvedScope.join(",");

  // 2. workspace .ao/scope file (newline-separated, agent-readable via `ao scope-check`)
  const scopeFilePath = join(workspace.path, ".ao", "scope");
  mkdirSync(dirname(scopeFilePath), { recursive: true });
  writeFileSync(scopeFilePath, resolvedScope.join("\n") + "\n", "utf8");
}

// `resolvedScope` is also passed into buildPrompt — see Task 8.
```

(Issue scope wins over project default. Keep `,`-joined metadata for flat-file format; newline-separated `.ao/scope` for human/CLI readability.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @composio/ao-core test -- session-manager`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/session-manager.ts packages/core/src/__tests__/session-manager.test.ts
git commit -m "feat(core): persist resolved scope to metadata + <workspace>/.ao/scope at spawn"
```

---

## Task 7: `ao scope-check` CLI command (PRIMARY pre-PR check)

**Files:**
- Create: `packages/cli/src/commands/scope-check.ts`
- Create: `packages/cli/src/commands/__tests__/scope-check.test.ts`
- Modify: `packages/cli/src/index.ts` (register the command)
- Modify: `packages/core/src/index.ts` (re-export `checkScope`, `ScopeViolation`)

The agent calls this before `gh pr create`. It exits 0 if scope is satisfied, 1 if violated (with a clear message listing offending files).

- [ ] **Step 0: Read `packages/cli/src/commands/verify.ts` for the registration pattern**

The verify command is the closest analog (also called by the agent inside a worktree, also takes `-p, --project`). Mirror its structure exactly:
- A `register<Name>(program: Command)` function exported from the file.
- Auto-detection of project from CWD.
- Errors via `chalk.red` to stderr, success info to stdout.
- `process.exit(1)` on violation, `process.exit(0)` on success (or let Commander handle it).

- [ ] **Step 1: Re-export from core for CLI use**

In `packages/core/src/index.ts`:

```typescript
export { checkScope } from "./scope-checker.js";
export type { ScopeViolation, ScopeConfig } from "./types.js";
```

- [ ] **Step 2: Write the failing tests**

Create `packages/cli/src/commands/__tests__/scope-check.test.ts`. The command involves filesystem and git, so use a temp-dir + `simple-git` or shell out to git. Patterns to mirror: see how `verify.test.ts` (if present) or other command tests stub things.

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { runScopeCheck } from "../scope-check.js"; // exported helper for testing
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

function setupRepo(): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), "ao-scope-check-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# x\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: dir });
  return { dir, base: "main" };
}

describe("ao scope-check", () => {
  it("returns 0 when no .ao/scope file exists (no scope to enforce)", async () => {
    const { dir, base } = setupRepo();
    writeFileSync(join(dir, "src.ts"), "x\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "add"], { cwd: dir });

    const result = await runScopeCheck({ workspace: dir, baseBranch: base });
    expect(result.exitCode).toBe(0);
    expect(result.violation).toBeNull();
  });

  it("returns 0 when all changed files match scope", async () => {
    const { dir, base } = setupRepo();
    mkdirSync(join(dir, ".ao"), { recursive: true });
    writeFileSync(join(dir, ".ao", "scope"), "src/**\n");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "x.ts"), "x\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "add"], { cwd: dir });

    const result = await runScopeCheck({ workspace: dir, baseBranch: base });
    expect(result.exitCode).toBe(0);
  });

  it("returns 1 with violation when changed files are out of scope", async () => {
    const { dir, base } = setupRepo();
    mkdirSync(join(dir, ".ao"), { recursive: true });
    writeFileSync(join(dir, ".ao", "scope"), "src/**\n");
    writeFileSync(join(dir, "out-of-scope.ts"), "x\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "out"], { cwd: dir });

    const result = await runScopeCheck({ workspace: dir, baseBranch: base });
    expect(result.exitCode).toBe(1);
    expect(result.violation?.reason).toBe("out-of-scope-files");
    expect(result.violation?.offending).toContain("out-of-scope.ts");
  });

  it("auto-detects base branch from project config when not provided", async () => {
    // arrange: write a minimal agent-orchestrator.yaml at workspace parent / a known location
    // act: runScopeCheck without explicit baseBranch
    // assert: it picks up project.defaultBranch
  });

  it("returns 1 when scope file exists but is empty", async () => {
    // edge case: empty .ao/scope means "no globs" — treat as 0 (disabled) per checkScope semantics
    // confirm exitCode 0 and a clear message
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @composio/ao-cli test -- scope-check`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the command**

Create `packages/cli/src/commands/scope-check.ts`:

```typescript
/**
 * `ao scope-check` — verify the current branch only changed files within the ticket's scope.
 *
 * Designed to be called by the agent INSIDE the worktree, BEFORE `gh pr create`.
 * Exits 0 if scope is satisfied or no scope is configured. Exits 1 with a clear
 * message listing offending files if violation is found.
 *
 * Usage:
 *   ao scope-check                 # auto-detect project from CWD, base from config
 *   ao scope-check --base develop  # explicit base branch
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { checkScope, loadConfig, type ScopeViolation } from "@composio/ao-core";

const execFileAsync = promisify(execFile);

export interface RunScopeCheckOpts {
  workspace: string;
  baseBranch?: string;
  projectId?: string;
}

export interface ScopeCheckResult {
  exitCode: 0 | 1;
  violation: ScopeViolation | null;
  message: string;
}

/** Testable core (no process.exit, no console output). */
export async function runScopeCheck(opts: RunScopeCheckOpts): Promise<ScopeCheckResult> {
  const scopeFilePath = join(opts.workspace, ".ao", "scope");
  if (!existsSync(scopeFilePath)) {
    return { exitCode: 0, violation: null, message: "No .ao/scope file — scope check skipped." };
  }

  const allowed = readFileSync(scopeFilePath, "utf8")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  if (allowed.length === 0) {
    return { exitCode: 0, violation: null, message: ".ao/scope file is empty — scope check skipped." };
  }

  // Resolve base branch: explicit > project config > "main"
  let baseBranch = opts.baseBranch;
  if (!baseBranch) {
    try {
      const config = loadConfig();
      const project = opts.projectId
        ? config.projects[opts.projectId]
        : Object.values(config.projects).find((p) => p.path === opts.workspace);
      baseBranch = project?.defaultBranch ?? "main";
    } catch {
      baseBranch = "main";
    }
  }

  // Compute changed files vs the merge-base with base branch.
  const { stdout: mergeBase } = await execFileAsync(
    "git",
    ["merge-base", "HEAD", baseBranch],
    { cwd: opts.workspace, timeout: 30_000 },
  );
  const { stdout: filesOut } = await execFileAsync(
    "git",
    ["diff", "--name-only", `${mergeBase.trim()}..HEAD`],
    { cwd: opts.workspace, timeout: 30_000 },
  );
  const changedFiles = filesOut.split("\n").map((s) => s.trim()).filter(Boolean);

  const violation = checkScope({ changedFiles, allowed });
  if (!violation) {
    return {
      exitCode: 0,
      violation: null,
      message: `Scope OK — ${changedFiles.length} changed file(s) all within ${allowed.length} allowed glob(s).`,
    };
  }

  const offendingList = violation.offending.slice(0, 20).join("\n  ");
  const more = violation.offending.length > 20 ? `\n  … (+${violation.offending.length - 20} more)` : "";
  const msg = [
    `Scope violation (${violation.reason}).`,
    ``,
    `Allowed globs:`,
    ...allowed.map((g) => `  ${g}`),
    ``,
    `Out-of-scope files:`,
    `  ${offendingList}${more}`,
    ``,
    `Revert these changes before opening a PR. If they are genuinely required to`,
    `satisfy the ticket, post a PR comment explaining why and ask the human to`,
    `expand the scope.`,
  ].join("\n");

  return { exitCode: 1, violation, message: msg };
}

export function registerScopeCheck(program: Command): void {
  program
    .command("scope-check")
    .description("Verify the current branch only modifies files within the ticket's scope (run before `gh pr create`)")
    .option("-p, --project <id>", "Project ID (auto-detected from CWD if omitted)")
    .option("--base <branch>", "Base branch to diff against (default: project.defaultBranch or 'main')")
    .action(async (opts: { project?: string; base?: string }) => {
      const result = await runScopeCheck({
        workspace: process.cwd(),
        baseBranch: opts.base,
        projectId: opts.project,
      });
      if (result.exitCode === 0) {
        console.log(chalk.green(result.message));
      } else {
        console.error(chalk.red(result.message));
      }
      process.exit(result.exitCode);
    });
}
```

- [ ] **Step 5: Register the command**

In `packages/cli/src/index.ts`, mirror how `registerVerify` is registered:

```typescript
import { registerScopeCheck } from "./commands/scope-check.js";
// ... later, alongside other registrations:
registerScopeCheck(program);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @composio/ao-cli test -- scope-check`
Expected: PASS.

- [ ] **Step 7: Smoke test on real CLI**

```bash
pnpm build
cd /tmp && mkdir -p ao-scope-smoke && cd ao-scope-smoke
git init -b main && echo x > a && git add . && git commit -m init
git checkout -b feature
mkdir -p .ao && echo "src/**" > .ao/scope
echo y > out-of-scope.txt && git add . && git commit -m out
node /path/to/agent-orchestrator/packages/cli/dist/index.js scope-check --base main
# Expected: exit code 1, red message listing out-of-scope.txt
```

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/commands/scope-check.ts \
        packages/cli/src/commands/__tests__/scope-check.test.ts \
        packages/cli/src/index.ts \
        packages/core/src/index.ts
git commit -m "feat(cli): add 'ao scope-check' command (primary pre-PR scope guard)"
```

---

## Task 8: Strengthen `BASE_AGENT_PROMPT` and inject scope into prompt

**Files:**
- Modify: `packages/core/src/prompt-builder.ts`
- Modify: `packages/core/src/__tests__/prompt-builder.test.ts`
- Modify: every call site of `buildPrompt` (find with grep — see Step 4)

- [ ] **Step 1: Write the failing tests**

```typescript
it("BASE_AGENT_PROMPT includes scope discipline rules", () => {
  expect(BASE_AGENT_PROMPT).toMatch(/out of scope/i);
  expect(BASE_AGENT_PROMPT).toMatch(/do not bundle/i);
});

it("BASE_AGENT_PROMPT instructs running ao scope-check before PR", () => {
  expect(BASE_AGENT_PROMPT).toMatch(/ao scope-check/);
  expect(BASE_AGENT_PROMPT).toMatch(/before.*gh pr create/i);
});

it("BASE_AGENT_PROMPT includes correction-handling rules", () => {
  expect(BASE_AGENT_PROMPT).toMatch(/re-verify, not defend/i);
});

it("buildPrompt appends scope info when scopeGlobs is provided", () => {
  const out = buildPrompt({
    /* minimal config */
    scopeGlobs: ["src/sports/**"],
  });
  expect(out).toContain("src/sports/**");
  expect(out).toMatch(/scope/i);
});

it("buildPrompt omits scope section when scopeGlobs is empty/undefined", () => {
  const out = buildPrompt({ /* minimal config, no scopeGlobs */ });
  expect(out).not.toMatch(/^## Scope \(this session\)/m);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @composio/ao-core test -- prompt-builder`
Expected: FAIL.

- [ ] **Step 3: Update `BASE_AGENT_PROMPT`**

Append two new sections to `BASE_AGENT_PROMPT` (between "PR Best Practices" and "Visual Verification"):

```markdown
## Scope Discipline
- Stay strictly inside the scope of the assigned ticket. Do not bundle unrelated cleanup, refactors, or fixes — even if the change "feels right" or "is on the way."
- If you find adjacent issues worth fixing, list them in the PR description under a "Follow-ups" section. Do not commit them.
- BEFORE running `gh pr create`, run `ao scope-check`. If it exits non-zero, revert the out-of-scope changes (use `git restore` or `git revert`) and re-run until it passes.
- The orchestrator also runs a scope check on the PR after creation as a safety net. If it flags anything, you'll be asked to revert.

## Handling Disagreement
- When a human disagrees with you (in chat or in a PR comment), your default response is to re-verify, not defend.
- State explicitly what you re-checked, what you found, and only then restate or revise your prior position.
- If you still disagree after re-verifying, ask a clarifying question — do not assert correctness.
- Performative confidence is a failure mode. Performative agreement is also a failure mode. The goal is calibrated, evidence-backed responses.
```

- [ ] **Step 4: Add `scopeGlobs` to `PromptBuildConfig` and inject it everywhere `buildPrompt` is called**

```typescript
export interface PromptBuildConfig {
  // ... existing fields ...
  /** Glob list this session is scoped to. Rendered into the prompt when present. */
  scopeGlobs?: string[];
}
```

In `buildPrompt`, after the existing config-derived context block, append:

```typescript
if (config.scopeGlobs && config.scopeGlobs.length > 0) {
  sections.push(`## Scope (this session)
You are scoped to the following paths. Do not modify files outside these globs:
${config.scopeGlobs.map((g) => `- \`${g}\``).join("\n")}

Run \`ao scope-check\` before \`gh pr create\` to verify your changes stay in bounds.`);
}
```

Then update **every** call site of `buildPrompt`:

```bash
grep -rn "buildPrompt(" packages/ --include="*.ts" | grep -v "\.test\.ts"
```

Expect at least: spawn path in `session-manager.ts`, restore/respawn path. For each:

- **Spawn path:** pass the resolved `string[]` from Task 6 directly. Do not re-parse the comma-joined `metadata.scopeGlobs` here — Task 6 already has the array in scope.
- **Restore/respawn path:** split `metadata.scopeGlobs` here:
  ```typescript
  const scopeGlobs = session.metadata.scopeGlobs
    ? session.metadata.scopeGlobs.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  ```

Add a test that verifies the restore path also injects scope:

```typescript
it("buildPrompt includes scope when restoring a session with metadata.scopeGlobs set", () => {
  // Mirror the restore code path's call shape.
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @composio/ao-core test -- prompt-builder`
Expected: PASS — all 5 cases.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/prompt-builder.ts \
        packages/core/src/__tests__/prompt-builder.test.ts \
        packages/core/src/session-manager.ts
git commit -m "feat(core): scope discipline + correction-handling in BASE_AGENT_PROMPT, inject scopeGlobs"
```

---

## Task 9: Lifecycle safety-net check (post-PR)

**Files:**
- Modify: `packages/plugins/scm-github/src/index.ts` (implement `getPRHeadSha`)
- Modify: `packages/core/src/lifecycle-manager.ts`
- Modify: `packages/core/src/__tests__/lifecycle-manager.test.ts`

This is the **safety net**, not the primary defense — Task 7's `ao scope-check` is the primary. This task catches:
- Agents that didn't run `ao scope-check` (older sessions, non-claude-code agents, agents that skipped the step).
- Force-pushes that introduce out-of-scope changes after a clean pre-check.
- Direct human pushes to the agent's branch.

- [ ] **Step 0: Prep — understand the existing emission and side-effect pattern**

Read these in `lifecycle-manager.ts`:

1. How status transitions emit events — search for `statusToEventType` and find the call site that turns the result into an `OrchestratorEvent`. Note the helper name (e.g. `emitEvent`, `emit`, `recordEvent`) and how `event.data` is constructed via `buildEventData`.
2. Whether `determineStatus` performs any *side effects* today — search for `updateMetadata` inside the function. The PR-detection block already calls `updateMetadata(sessionsDir, session.id, { pr: detectedPR.url })`, so adding another side-effect call here is consistent with the existing pattern. If your read says otherwise, put the scope-check side effect in `determineStatus`'s **caller** instead.
3. How `config.configPath` and `getSessionsDir` are reached from inside the polling loop — they're already used for the existing `updateMetadata` call. Reuse that exact reference style.

Write yourself a note before continuing:
- Helper name for emission: `__________`
- Where the scope check goes: inside `determineStatus` / inside the caller (pick one).
- Reaction-message templating helper name (you'll use this in Task 10): `__________` — also identify exact placeholder syntax (`{key}` vs `${key}` vs handlebars).

- [ ] **Step 1: Implement `SCM.getPRHeadSha` in scm-github**

The interface field was added in Task 1. Now implement it in `packages/plugins/scm-github/src/index.ts`:

```typescript
async getPRHeadSha(pr: PRInfo): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["pr", "view", String(pr.number), "--json", "headRefOid", "-q", ".headRefOid"],
      { timeout: 30_000 },
    );
    const sha = stdout.trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}
```

(Use the existing `execFileAsync` pattern in this file — no shell interpolation, pass `pr.number` as an array arg.)

- [ ] **Step 2: Map event → reaction key**

In `eventToReactionKey()` add:

```typescript
case "pr.scope_violation":
  return "pr-scope-violation";
```

- [ ] **Step 3: Write the failing integration tests**

In the lifecycle-manager test file:

```typescript
it("emits pr.scope_violation when PR touches out-of-scope files", async () => {
  // arrange:
  //   - session with metadata.scopeGlobs = "src/sports/**"
  //   - session.pr present
  //   - mock SCM.getChangedFiles → ["src/sports/foo.ts", "src/admin/bar.ts"]
  //   - mock SCM.getPRHeadSha → "abc123"
  //   - mock other SCM methods to return non-failing states
  // act: trigger one poll cycle
  // assert: events recorded include type: "pr.scope_violation" with data.offendingFiles: ["src/admin/bar.ts"]
});

it("does not re-emit pr.scope_violation when PR HEAD sha is unchanged", async () => {
  // arrange: same as above, but session.metadata.scopeCheckedSha === "abc123"
  // act: poll
  // assert: no pr.scope_violation event emitted
});

it("does not emit pr.scope_violation when scopeGlobs is not set", async () => {
  // arrange: session.metadata.scopeGlobs undefined
  // act: poll
  // assert: no scope event regardless of files
});

it("re-emits when SHA changes (force-push scenario)", async () => {
  // arrange: scopeCheckedSha = "old-sha", getPRHeadSha returns "new-sha"
  //          getChangedFiles returns same out-of-scope list
  // act: poll
  // assert: event fires; metadata.scopeCheckedSha updated to "new-sha"
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm --filter @composio/ao-core test -- lifecycle-manager`
Expected: FAIL.

- [ ] **Step 5: Add the scope check at the location identified in Step 0**

The check is a *side effect* — it does not change the returned status, but it emits a `pr.scope_violation` event when a violation is observed against a SHA we haven't checked before. Use the **emission helper name and `event.data` construction style identified in Step 0**:

```typescript
// Inside the PR-state polling block (or its caller — per Step 0).
const scopeGlobsRaw = session.metadata["scopeGlobs"];
if (session.pr && scopeGlobsRaw && scm?.getChangedFiles) {
  const scopeGlobs = scopeGlobsRaw.split(",").map((s) => s.trim()).filter(Boolean);
  const headSha = scm.getPRHeadSha
    ? await scm.getPRHeadSha(session.pr).catch(() => null)
    : null;
  const lastChecked = session.metadata["scopeCheckedSha"];

  if (headSha && lastChecked !== headSha) {
    const files = await scm.getChangedFiles(session.pr).catch(() => null);
    if (files) {
      const violation = checkScope({
        changedFiles: files,
        allowed: scopeGlobs,
        alwaysDeny: project.scope?.alwaysDeny,
        maxFiles: project.scope?.maxFiles,
        maxLines: project.scope?.maxLines,
      });
      if (violation) {
        const data = {
          ...buildEventData(session.status, session.status, session),
          violation,
          allowedGlobs: scopeGlobs,
          offendingFiles: violation.offending,
        };
        await /* emission helper */({
          type: "pr.scope_violation",
          priority: "action",
          sessionId: session.id,
          projectId: session.projectId,
          message: `${session.id} touched ${violation.offending.length} out-of-scope file(s)`,
          data,
        });
      }
      // Persist whether or not there was a violation. Semantics:
      //   - No violation: this SHA is clean; don't re-check it on every poll.
      //   - Violation: we've already emitted; don't re-fire until a new push (= new SHA).
      // A subsequent partial-revert push produces a new SHA and gets re-checked.
      const sessionsDir = getSessionsDir(config.configPath, project.path);
      updateMetadata(sessionsDir, session.id, { scopeCheckedSha: headSha });
    }
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @composio/ao-core test -- lifecycle-manager`
Expected: PASS — all 4 cases.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/lifecycle-manager.ts \
        packages/core/src/__tests__/lifecycle-manager.test.ts \
        packages/plugins/scm-github/src/index.ts
git commit -m "feat(core): post-PR scope safety net — emit pr.scope_violation on SHA change"
```

---

## Task 10: Wire scope-violation reaction (send-to-agent + escalation)

**Files:**
- Modify: `packages/core/src/lifecycle-manager.ts` (only the message-templating helper — `eventToReactionKey` was already updated in Task 9 Step 2)
- Modify: `agent-orchestrator.yaml.example`

- [ ] **Step 1: Identify the templating helper and its placeholder syntax**

Use the helper name and placeholder syntax recorded in Task 9 Step 0. Confirm by reading the existing reactions for `ci-failed` and `changes-requested` — those messages also interpolate dynamic data.

- [ ] **Step 2: Add default reaction config**

In `agent-orchestrator.yaml.example`, in the global `reactions:` block, add — using the **same placeholder syntax** as existing reactions:

```yaml
  pr-scope-violation:
    auto: true
    action: send-to-agent
    message: |
      Your PR touches files outside this ticket's scope (this is the post-PR safety
      net — you should have caught this with `ao scope-check` before opening the PR).

      Allowed: {allowedGlobs}
      Out of scope: {offendingFiles}

      Revert those changes and force-push. If they are genuinely required to
      satisfy the ticket, post a PR comment explaining why and a human will
      decide whether to expand the scope.
    retries: 2
    escalateAfter: "30m"
    priority: action
```

(v1 has no machine-parsed scope-expansion flow; the message refers to a human-mediated escalation.)

- [ ] **Step 3: Extend the templating helper**

Extend the helper identified in Step 1 so it renders two new placeholders:
- `{allowedGlobs}` → join `event.data.allowedGlobs` with `, `.
- `{offendingFiles}` → join `event.data.offendingFiles` with `, `, truncated at 20 entries followed by `, … (+N more)`.

Add a unit test asserting both substitutions and the truncation behavior at 20 entries.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @composio/ao-core test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/lifecycle-manager.ts agent-orchestrator.yaml.example \
        packages/core/src/__tests__/
git commit -m "feat(core): pr-scope-violation reaction (send-to-agent + escalation)"
```

---

## Task 11: End-to-end integration test

**Files:**
- Create: `packages/core/src/__tests__/scope-guard-e2e.test.ts`

Validate that the pre-PR (CLI) and post-PR (lifecycle) layers compose correctly.

- [ ] **Step 1: Write the test**

```typescript
describe("scope guard end-to-end", () => {
  it("pre-PR path: ticket marker → metadata + .ao/scope → ao scope-check exits 1 on violation", async () => {
    // 1. Mock tracker.getIssue → body contains <!-- ao-scope: src/sports/** -->
    // 2. sessionManager.spawn({ projectId, issueId })
    // 3. Assert metadata.scopeGlobs === "src/sports/**"
    // 4. Assert <workspace>/.ao/scope exists with content "src/sports/**\n"
    // 5. Make a commit in the worktree that touches src/admin/foo.ts (out of scope)
    // 6. Run runScopeCheck({ workspace, baseBranch })
    // 7. Assert exitCode === 1, violation.offending includes "src/admin/foo.ts"
  });

  it("post-PR safety net: out-of-scope PR triggers reaction even if pre-check was skipped", async () => {
    // 1. Spawn session with scope (as above), but skip the ao scope-check step
    // 2. Set session.pr to a fake PR; mock SCM:
    //    - getChangedFiles → ["src/sports/foo.ts", "src/admin/bar.ts"]
    //    - getPRHeadSha → "deadbeef"
    // 3. Run one lifecycle poll
    // 4. Assert pr.scope_violation event with offendingFiles: ["src/admin/bar.ts"]
    // 5. Assert reaction-tracker recorded one send-to-agent attempt
    // 6. Run another poll with same SHA → assert no duplicate event
    // 7. Run another poll with new SHA + same out-of-scope file → assert event fires again
  });

  it("clean PR: in-scope changes do not trigger any violation event", async () => {
    // sanity: only src/sports/** files changed, no event fires, scopeCheckedSha persists.
  });
});
```

- [ ] **Step 2: Run test**

Run: `pnpm --filter @composio/ao-core test -- scope-guard-e2e`
Expected: PASS.

- [ ] **Step 3: Lint + typecheck the whole repo**

```bash
pnpm lint && pnpm typecheck && pnpm test
```

Expected: clean across all packages.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/__tests__/scope-guard-e2e.test.ts
git commit -m "test(core): scope guard end-to-end (pre-PR + post-PR safety net)"
```

---

## Task 12: Documentation

**Files:**
- Modify: `agent-orchestrator.yaml.example`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Document the `scope` block**

In `agent-orchestrator.yaml.example`, add a commented example showing all sources (project default, ticket marker, alwaysDeny) with concrete globs and a short note that issue-level marker wins.

- [ ] **Step 2: Add a "Scope Guard" section to `CLAUDE.md`**

Add after the "Auto-Merge" section:

```markdown
## Scope Guard

Bounds the files an agent is allowed to modify. Two enforcement layers:

1. **Pre-PR (primary):** the agent runs `ao scope-check` before `gh pr create`. The command reads `<workspace>/.ao/scope`, diffs against the base branch, and exits non-zero with a list of out-of-scope files if violation is found. The agent must revert before retrying.
2. **Post-PR (safety net):** the lifecycle manager runs `checkScope()` against `SCM.getChangedFiles()` on every PR poll, idempotent on PR HEAD SHA. Violations fire `pr.scope_violation` → `pr-scope-violation` reaction (send-to-agent, retries: 2, escalate after 30m).

Scope is sourced from (in priority order):
1. **Per-issue marker** — `<!-- ao-scope: glob1, glob2 -->` anywhere in the issue body. Wins over project default.
2. **Project default** — `projects.<id>.scope.defaultAllow` in config.

`alwaysDeny` globs (e.g. `**/.github/**`, `**/pnpm-lock.yaml`) override both.

Resolved scope is persisted to `metadata.scopeGlobs` (comma-joined) and `<workspace>/.ao/scope` (newline-separated, read by the CLI).

Implementation: `packages/core/src/scope-checker.ts`, `packages/core/src/scope-marker.ts`, `packages/cli/src/commands/scope-check.ts`, scope wiring in `packages/core/src/lifecycle-manager.ts`.
```

- [ ] **Step 3: Commit**

```bash
git add agent-orchestrator.yaml.example CLAUDE.md
git commit -m "docs: scope guard config, marker syntax, CLI command, and reaction"
```

---

## Verification Checklist (run after Task 12)

- [ ] `pnpm lint && pnpm typecheck && pnpm test` clean
- [ ] Spawn a test session locally with a mock issue containing `<!-- ao-scope: src/foo/** -->` — confirm `metadata.scopeGlobs` is written AND `<workspace>/.ao/scope` exists with the expected content
- [ ] Inside the worktree, make an in-scope edit, commit, run `ao scope-check` — expect exit 0 with green "Scope OK" message
- [ ] Make an out-of-scope edit, commit, re-run `ao scope-check` — expect exit 1 with red message listing the offending file
- [ ] Bypass the CLI, push directly, open a PR — confirm the post-PR safety net fires `pr.scope_violation` and the agent gets the message
- [ ] Confirm idempotency: a second poll with the same SHA does not double-fire; a force-push (new SHA) re-checks
- [ ] Confirm escalation: after 2 retries, a notification reaches the configured notifier(s)
- [ ] Read the rendered prompt for a session and confirm: scope-discipline section, correction-handling section, `ao scope-check` instruction, and per-session scope block all present

---

## Risks & Tradeoffs (recap)

- **Glob coverage gaps:** if a PR touches in-scope files but with semantic creep (e.g. an unrelated refactor inside an allowed path), neither layer catches it. Follow-up plan: scope-reviewer agent.
- **Pre-PR check can be skipped by the agent:** the prompt instructs running `ao scope-check`, but the agent can ignore the instruction. The post-PR safety net is the answer to that — at the cost of a force-push to clean up. A pre-commit/pre-push git hook (out of scope for v1) would be the hard mechanical bound the agent cannot bypass.
- **False positives on legitimate cross-cutting work:** when scope expansion is genuinely needed, the agent has no automated escape hatch in v1 — the user must manually expand scope (edit `.ao/scope` in the worktree, or update the issue marker and respawn). Acceptable for v1; revisit if it bites in practice.
- **`SCM.getPRHeadSha` is implemented for github only:** other SCM plugins won't get idempotency keyed on SHA — the safety net will fire on every poll for those. Mitigated by retry caps in the reaction config; revisit when adding GitLab/etc.
- **Marker syntax in issue bodies:** users (or AI ticket-writers) may forget the marker. Project-level `defaultAllow` is the safety net at config level; in repos with broad project scope, expect more LLM-derived-scope work in a follow-up plan.
