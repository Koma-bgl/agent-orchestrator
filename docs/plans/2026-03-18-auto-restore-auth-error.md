# Auto-Restore on Auth Error — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Automatically restore agent sessions when OAuth token expires mid-session, picking up the fresh token from the orchestrator's environment.

**Architecture:** Lifecycle manager detects `blocked` activity state (auth error) → transitions session to `errored` → emits `session.auth_failed` event → `restore-session` reaction calls `sessionManager.restore()` which creates a fresh tmux session with fresh `getEnvironment()` → agent relaunches with valid token. Retry cap prevents infinite loops.

**Tech Stack:** TypeScript (ESM), vitest for tests.

---

### Task 1: Add `session.auth_failed` event type and `restore-session` action to types

**Files:**
- Modify: `packages/core/src/types.ts:753-798` (EventType union)
- Modify: `packages/core/src/types.ts:822` (ReactionConfig action union)

**Step 1: Write the failing test**

Create test file `packages/core/src/__tests__/auth-error-types.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import type { EventType, ReactionConfig } from "../types.js";

describe("auth error types", () => {
  it("session.auth_failed is a valid EventType", () => {
    const event: EventType = "session.auth_failed";
    expect(event).toBe("session.auth_failed");
  });

  it("restore-session is a valid ReactionConfig action", () => {
    const reaction: ReactionConfig = {
      auto: true,
      action: "restore-session",
      escalateAfter: 2,
    };
    expect(reaction.action).toBe("restore-session");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm vitest run src/__tests__/auth-error-types.test.ts`
Expected: TypeScript compilation error — `"session.auth_failed"` is not assignable to `EventType`, `"restore-session"` is not assignable to action union.

**Step 3: Add `session.auth_failed` to EventType union**

In `packages/core/src/types.ts`, find the `EventType` union (line 753). Add after `"session.errored"` (line 761):

```typescript
  | "session.auth_failed"
```

**Step 4: Add `restore-session` to ReactionConfig action union**

In `packages/core/src/types.ts`, find the `action` field on `ReactionConfig` (line 822). Change:

```typescript
  action: "send-to-agent" | "send-comments-to-agent" | "notify" | "auto-merge";
```

to:

```typescript
  action: "send-to-agent" | "send-comments-to-agent" | "notify" | "auto-merge" | "restore-session";
```

**Step 5: Run test to verify it passes**

Run: `cd packages/core && pnpm vitest run src/__tests__/auth-error-types.test.ts`
Expected: PASS

**Step 6: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS (no other code references these new values yet)

**Step 7: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/__tests__/auth-error-types.test.ts
git commit -m "feat(types): add session.auth_failed event type and restore-session reaction action"
```

---

### Task 2: Wire `session.auth_failed` into lifecycle event/reaction mappings

**Files:**
- Modify: `packages/core/src/lifecycle-manager.ts:102-163` (statusToEventType + eventToReactionKey)

**Step 1: Write the failing test**

Add to `packages/core/src/__tests__/lifecycle-manager.test.ts`:

```typescript
describe("auth error event mapping", () => {
  it("transitions blocked agent to errored status", async () => {
    // Agent reports blocked (auth error in terminal)
    (mockAgent.detectActivity as ReturnType<typeof vi.fn>).mockReturnValue("blocked");
    (mockAgent.isProcessRunning as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const session = makeSession({ status: "working" });
    (mockSessionManager.list as ReturnType<typeof vi.fn>).mockResolvedValue([session]);
    writeMetadata(sessionsDir, session.id, {
      worktree: "/tmp/ws",
      branch: "feat/test",
      status: "working",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check(session.id);

    // Verify status transitioned to errored
    const raw = readMetadataRaw(sessionsDir, session.id);
    expect(raw?.["status"]).toBe("errored");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm vitest run src/__tests__/lifecycle-manager.test.ts -t "transitions blocked agent to errored"`
Expected: FAIL — `blocked` is not handled, status stays `working`.

**Step 3: Detect blocked activity in determineStatus**

In `packages/core/src/lifecycle-manager.ts`, find the activity detection block (around line 304). Add a `let agentBlocked = false;` alongside `agentWaitingInput`, and detect it:

After line 304 (`let agentWaitingInput = false;`), add:

```typescript
    let agentBlocked = false;
```

After the `waiting_input` check (line 317-319), add:

```typescript
          if (activity === "blocked") {
            agentBlocked = true;
          }
```

Before the `agentWaitingInput` return (line 445), insert:

```typescript
    // 4.5 Agent is blocked (auth error, etc.) — treat as errored
    if (agentBlocked) return "errored";
```

**Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm vitest run src/__tests__/lifecycle-manager.test.ts -t "transitions blocked agent to errored"`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/core/src/lifecycle-manager.ts packages/core/src/__tests__/lifecycle-manager.test.ts
git commit -m "feat(lifecycle): detect blocked activity state and transition to errored"
```

---

### Task 3: Emit `session.auth_failed` event (distinct from `session.errored`)

**Files:**
- Modify: `packages/core/src/lifecycle-manager.ts` — status transition handling + event emission

**Context:** The lifecycle manager needs to distinguish auth failures from generic errors so config can have separate reactions. We need to thread the `agentBlocked` flag into the event emission logic.

**Step 1: Understand the transition flow**

In `lifecycle-manager.ts`, after `determineStatus()` returns a new status, the main poll loop calls `statusToEventType()` to get the event type. We need to override this for auth-blocked sessions.

Find the section where status transitions are handled (search for `statusToEventType` calls in the poll loop). The key is: when `newStatus === "errored"` AND the agent was blocked (auth error), emit `session.auth_failed` instead of `session.errored`.

**Step 2: Write the failing test**

Add to `packages/core/src/__tests__/lifecycle-manager.test.ts`:

```typescript
  it("emits session.auth_failed event and triggers restore-session reaction", async () => {
    // Agent reports blocked (auth error)
    (mockAgent.detectActivity as ReturnType<typeof vi.fn>).mockReturnValue("blocked");
    (mockAgent.isProcessRunning as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const session = makeSession({ status: "working" });
    (mockSessionManager.list as ReturnType<typeof vi.fn>).mockResolvedValue([session]);
    (mockSessionManager.restore as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeSession({ status: "spawning" }),
    );
    writeMetadata(sessionsDir, session.id, {
      worktree: "/tmp/ws",
      branch: "feat/test",
      status: "working",
      project: "my-app",
    });

    // Configure the restore-session reaction
    config.reactions = {
      "agent-auth-failed": {
        auto: true,
        action: "restore-session",
        escalateAfter: 2,
      },
    };

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check(session.id);

    // Verify restore was called
    expect(mockSessionManager.restore).toHaveBeenCalledWith(session.id);
  });
```

**Step 3: Run test to verify it fails**

Run: `cd packages/core && pnpm vitest run src/__tests__/lifecycle-manager.test.ts -t "emits session.auth_failed"`
Expected: FAIL — `restore` is not called because `session.auth_failed` event type and `agent-auth-failed` reaction key are not wired up.

**Step 4: Wire up event type and reaction key mappings**

In `lifecycle-manager.ts`:

1. Add to `statusToEventType()` — this function maps status → event type. But we can't distinguish auth errors here since it only sees the status string. Instead, we'll override the event type in the poll loop.

2. Add to `eventToReactionKey()` (around line 136):

```typescript
    case "session.auth_failed":
      return "agent-auth-failed";
```

3. In the poll loop where transitions are handled, track whether the session was blocked. The lifecycle manager needs to pass the `agentBlocked` context from `determineStatus` to the event emission.

**Approach:** Have `determineStatus` return additional context alongside the status. Since changing the return type of `determineStatus` is invasive, use a simpler approach: store `agentBlocked` state on the session metadata so the transition handler can read it.

In `determineStatus`, before `return "errored"` in the blocked branch, write a metadata flag:

```typescript
    if (agentBlocked) {
      const sessionsDir = getSessionsDir(config.configPath, project.path);
      updateMetadata(sessionsDir, session.id, { blockedReason: "auth_error" });
      return "errored";
    }
```

In the transition handling section, when `newStatus === "errored"`, check the metadata flag:

```typescript
    // Override event type for auth errors
    if (newStatus === "errored") {
      const sessionsDir = getSessionsDir(config.configPath, project.path);
      const raw = readMetadataRaw(sessionsDir, session.id);
      if (raw?.["blockedReason"] === "auth_error") {
        eventType = "session.auth_failed";
        // Clear the flag so it doesn't persist across restores
        updateMetadata(sessionsDir, session.id, { blockedReason: "" });
      }
    }
```

**Step 5: Run test to verify it passes**

Run: `cd packages/core && pnpm vitest run src/__tests__/lifecycle-manager.test.ts -t "emits session.auth_failed"`
Expected: FAIL — still need the `restore-session` handler (Task 4).

**Step 6: Commit (partial — wiring only)**

```bash
git add packages/core/src/lifecycle-manager.ts packages/core/src/__tests__/lifecycle-manager.test.ts
git commit -m "feat(lifecycle): wire session.auth_failed event type and agent-auth-failed reaction key"
```

---

### Task 4: Implement `restore-session` reaction handler

**Files:**
- Modify: `packages/core/src/lifecycle-manager.ts:550` (executeReaction switch statement)

**Step 1: Add the restore-session case to executeReaction**

In the `switch (action)` block in `executeReaction()` (around line 550), add a new case before the default/closing:

```typescript
      case "restore-session": {
        try {
          const restored = await sessionManager.restore(sessionId);
          const event = createEvent("reaction.triggered", {
            sessionId,
            projectId,
            message: `Session ${sessionId} auto-restored after auth error`,
          });
          await notifyHuman(event, "info");
          return {
            reactionType: reactionKey,
            success: true,
            action: "restore-session",
            message: `Restored as ${restored.id}`,
            escalated: false,
          };
        } catch (err) {
          console.error(`[lifecycle] ${sessionId}: restore-session failed:`, err);
          return {
            reactionType: reactionKey,
            success: false,
            action: "restore-session",
            escalated: false,
          };
        }
      }
```

**Step 2: Run the test from Task 3 to verify it passes**

Run: `cd packages/core && pnpm vitest run src/__tests__/lifecycle-manager.test.ts -t "emits session.auth_failed"`
Expected: PASS — restore is called.

**Step 3: Run all lifecycle tests**

Run: `cd packages/core && pnpm vitest run src/__tests__/lifecycle-manager.test.ts`
Expected: All PASS

**Step 4: Commit**

```bash
git add packages/core/src/lifecycle-manager.ts
git commit -m "feat(lifecycle): add restore-session reaction handler for auth error recovery"
```

---

### Task 5: Add escalation test (retry cap)

**Files:**
- Modify: `packages/core/src/__tests__/lifecycle-manager.test.ts`

**Step 1: Write test for escalation after N failures**

```typescript
  it("escalates to human after escalateAfter restore attempts", async () => {
    (mockAgent.detectActivity as ReturnType<typeof vi.fn>).mockReturnValue("blocked");
    (mockAgent.isProcessRunning as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const session = makeSession({ status: "working" });
    (mockSessionManager.list as ReturnType<typeof vi.fn>).mockResolvedValue([session]);
    // restore keeps failing (token still bad)
    (mockSessionManager.restore as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Auth still expired"),
    );

    writeMetadata(sessionsDir, session.id, {
      worktree: "/tmp/ws",
      branch: "feat/test",
      status: "working",
      project: "my-app",
    });

    const mockNotifier: Notifier = {
      name: "mock-notifier",
      send: vi.fn().mockResolvedValue(undefined),
    };
    (mockRegistry.get as ReturnType<typeof vi.fn>).mockImplementation((slot: string) => {
      if (slot === "runtime") return mockRuntime;
      if (slot === "agent") return mockAgent;
      if (slot === "notifier") return mockNotifier;
      return null;
    });

    config.reactions = {
      "agent-auth-failed": {
        auto: true,
        action: "restore-session",
        escalateAfter: 2,
      },
    };
    config.notifiers = { desktop: {} };

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    // First two attempts — restore tries (and fails)
    await lm.check(session.id);
    // Reset status back to working for next cycle
    writeMetadata(sessionsDir, session.id, { status: "working", blockedReason: "" });
    await lm.check(session.id);
    writeMetadata(sessionsDir, session.id, { status: "working", blockedReason: "" });

    // Third attempt — should escalate
    await lm.check(session.id);

    // Verify notification was sent (escalation)
    expect(mockNotifier.send).toHaveBeenCalled();
  });
```

**Step 2: Run test**

Run: `cd packages/core && pnpm vitest run src/__tests__/lifecycle-manager.test.ts -t "escalates to human"`
Expected: PASS (escalation logic is already in `executeReaction` via the existing tracker/escalateAfter mechanism).

**Step 3: Commit**

```bash
git add packages/core/src/__tests__/lifecycle-manager.test.ts
git commit -m "test(lifecycle): add escalation test for auth error retry cap"
```

---

### Task 6: Typecheck, lint, full test suite

**Files:** None (verification only)

**Step 1: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

**Step 2: Run lint**

Run: `pnpm lint`
Expected: PASS (fix any issues with `pnpm lint:fix` if needed)

**Step 3: Run full test suite**

Run: `pnpm test`
Expected: All PASS

**Step 4: Commit any lint fixes**

```bash
git add -A
git commit -m "chore: lint fixes"
```

---

### Task 7: Update config example and docs

**Files:**
- Modify: `agent-orchestrator.yaml.example` — add `agent-auth-failed` reaction example
- Modify: `docs/DEVELOPMENT.md` — document the auth error recovery flow

**Step 1: Add reaction example to YAML**

Find the reactions section in `agent-orchestrator.yaml.example` and add:

```yaml
    # Auto-restore sessions when OAuth token expires (picks up fresh token from env)
    agent-auth-failed:
      auto: true
      action: restore-session
      escalateAfter: 2  # notify human after 2 failed restores
```

**Step 2: Add auth recovery docs**

Add a section to `docs/DEVELOPMENT.md` under the token section explaining:
- What happens when a token expires mid-session
- The `agent-auth-failed` reaction and how to configure it
- That updating `CLAUDE_CODE_OAUTH_TOKEN` env var is sufficient — the next restore will pick it up

**Step 3: Commit**

```bash
git add agent-orchestrator.yaml.example docs/DEVELOPMENT.md
git commit -m "docs: add auth error auto-recovery config and documentation"
```

---

## Summary of Changes

| Task | Files | Description |
|------|-------|-------------|
| 1 | `types.ts` | Add `session.auth_failed` event type + `restore-session` action |
| 2 | `lifecycle-manager.ts` | Detect `blocked` → `errored` in `determineStatus` |
| 3 | `lifecycle-manager.ts` | Wire `session.auth_failed` event + `agent-auth-failed` reaction key |
| 4 | `lifecycle-manager.ts` | Implement `restore-session` case in `executeReaction` |
| 5 | Tests | Escalation test for retry cap |
| 6 | — | Typecheck, lint, full test suite |
| 7 | Config + docs | Example config + documentation |
