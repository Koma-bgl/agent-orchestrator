# Auto-Restore on Auth Error

## Problem

When `CLAUDE_CODE_OAUTH_TOKEN` expires mid-session:

1. Claude Code reports a 401 error in the terminal
2. `classifyTerminalOutput()` in `agent-claude-code` correctly returns `"blocked"`
3. `determineStatus()` in the lifecycle manager ignores `blocked` — it only checks for `waiting_input`
4. The session stays as `"working"` forever, effectively dead

Even after the user updates the token (via `claude setup-token` or env var), running sessions don't pick up the new value because the tmux session's environment was set at spawn time.

## Solution

Lifecycle auto-restore: detect auth errors via the `blocked` activity state, kill the dead session, and call `restore()` which creates a fresh tmux session with a fresh `getEnvironment()` call — picking up the updated token from the orchestrator's process environment.

## Design

### 1. Detect `blocked` activity in `determineStatus()`

**File:** `packages/core/src/lifecycle-manager.ts`

In the activity detection block (step 2, around line 306), track `blocked` alongside `waiting_input`:

```typescript
let agentBlocked = false;

// existing code...
const activity = agent.detectActivity(terminalOutput);
if (activity === "waiting_input") {
  agentWaitingInput = true;
}
if (activity === "blocked") {
  agentBlocked = true;
}
```

After PR state checks (step 4), before the `agentWaitingInput` return (step 5), add:

```typescript
// 4.5 Agent is blocked (auth error, etc.) — return errored
if (agentBlocked) return "errored";
```

### 2. Add `session.auth_failed` event type

**File:** `packages/core/src/types.ts`

Add to `EventType`:
- `session.auth_failed`

Add to reaction key mapping:
- `session.auth_failed` → `agent-auth-failed`

Add to reaction actions:
- `restore-session`

### 3. Distinguish auth errors from generic errors

**File:** `packages/core/src/lifecycle-manager.ts`

When a session transitions to `errored` and the `blocked` flag is set, emit `session.auth_failed` instead of `session.errored`. This allows config to have separate reactions:

```typescript
// In status transition handling:
if (agentBlocked) {
  // Emit auth-specific event instead of generic error
  eventType = "session.auth_failed";
}
```

### 4. Add `restore-session` reaction handler

**File:** `packages/core/src/lifecycle-manager.ts`

New reaction action that:
1. Calls `restore()` from session-manager (kills old tmux, creates new one)
2. `restore()` calls `getEnvironment()` which re-reads `CLAUDE_CODE_OAUTH_TOKEN` from `process.env`
3. Agent relaunches with the fresh token

Retry cap via `escalateAfter` prevents infinite restart loops.

### 5. Export `restore()` from session-manager

**File:** `packages/core/src/session-manager.ts`

`restore()` is currently a private function inside `createSessionManager()`. Expose it via the returned object (or add a `restoreSession()` public method) so the lifecycle manager can call it.

## Config Example

```yaml
reactions:
  agent-auth-failed:
    action: restore-session
    escalateAfter: 2  # notify human after 2 failed restores
```

Default behavior (no config): escalate to human notification immediately (existing `session.errored` behavior).

## Flow

```
Token expires
  → Claude shows 401 in terminal
  → detectActivity() returns "blocked"
  → determineStatus() returns "errored"
  → lifecycle emits "session.auth_failed"
  → reaction "agent-auth-failed" fires
  → restore() kills tmux + creates new session
  → getEnvironment() reads fresh CLAUDE_CODE_OAUTH_TOKEN from process.env
  → Agent relaunches with valid token
  → If still failing after escalateAfter attempts → notify human
```

## Context Preservation

The agent loses its in-flight conversation, but `restore()` supports `getRestoreCommand()` which uses `claude --resume` to pick up the last session. The agent should continue roughly where it left off.

## Files Changed

| File | Change |
|------|--------|
| `packages/core/src/lifecycle-manager.ts` | Detect `blocked` → `errored`, emit `session.auth_failed`, add `restore-session` reaction handler |
| `packages/core/src/types.ts` | Add `session.auth_failed` event type, `agent-auth-failed` reaction key, `restore-session` action |
| `packages/core/src/session-manager.ts` | Expose `restore()` as a public method |

## Risks

- **Infinite restart loop:** Mitigated by `escalateAfter` retry cap (default: 2)
- **Token still expired after restore:** If the user hasn't updated the token, the restore will fail again — escalation to human handles this
- **Context loss:** Acceptable — 401 means the agent is dead anyway. `--resume` recovers most context.
