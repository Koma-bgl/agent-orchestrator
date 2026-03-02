import { type NextRequest, NextResponse } from "next/server";
import { validateIdentifier, validateString, stripControlChars } from "@/lib/validation";
import { getServices } from "@/lib/services";
import type { Agent, Runtime } from "@composio/ao-core";

const MAX_MESSAGE_LENGTH = 10_000;

/**
 * POST /api/sessions/:id/restore-and-send
 *
 * Atomically restore a terminated session and send a message once the agent
 * is ready.  This avoids the race condition where a client restores and then
 * immediately tries to send a message before the agent process has finished
 * loading.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const idErr = validateIdentifier(id, "id");
  if (idErr) {
    return NextResponse.json({ error: idErr }, { status: 400 });
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const messageErr = validateString(body?.message, "message", MAX_MESSAGE_LENGTH);
  if (messageErr) {
    return NextResponse.json({ error: messageErr }, { status: 400 });
  }

  const message = stripControlChars(String(body?.message ?? ""));
  if (message.trim().length === 0) {
    return NextResponse.json(
      { error: "message must not be empty after sanitization" },
      { status: 400 },
    );
  }

  try {
    const { sessionManager, registry, config } = await getServices();

    // 1. Restore the session
    const restored = await sessionManager.restore(id);

    if (!restored.runtimeHandle) {
      return NextResponse.json({ error: "Restored session has no runtime handle" }, { status: 500 });
    }

    // 2. Wait for the agent process to be running and ready (up to 30s)
    const project = config.projects[restored.projectId];
    const agentName = project?.agent ?? config.defaults.agent;
    const agent = registry.get<Agent>("agent", agentName);
    const runtimeName = restored.runtimeHandle.runtimeName;
    const runtime = registry.get<Runtime>("runtime", runtimeName);

    if (!runtime) {
      return NextResponse.json({ error: `Runtime plugin '${runtimeName}' not found` }, { status: 500 });
    }

    const MAX_WAIT_MS = 30_000;
    const POLL_MS = 2_000;
    const start = Date.now();

    while (Date.now() - start < MAX_WAIT_MS) {
      // Re-read session to get latest runtime handle
      const current = await sessionManager.get(id);
      if (!current?.runtimeHandle) {
        await sleep(POLL_MS);
        continue;
      }

      // Check if agent process is running
      if (agent?.isProcessRunning) {
        const isRunning = await agent.isProcessRunning(current.runtimeHandle);
        if (!isRunning) {
          await sleep(POLL_MS);
          continue;
        }
      }

      // Check if agent has reached a ready/waiting state (not still loading)
      if (agent?.getActivityState) {
        const activity = await agent.getActivityState(current);
        if (activity && (activity.state === "ready" || activity.state === "waiting_input")) {
          // Agent is ready — send the message
          await runtime.sendMessage(current.runtimeHandle, message);
          return NextResponse.json({ ok: true, sessionId: id, restored: true });
        }

        // If agent is active (still loading/resuming), keep waiting
        if (activity && activity.state === "active") {
          await sleep(POLL_MS);
          continue;
        }
      }

      // Fallback: if no getActivityState, wait a fixed delay after process is detected
      await sleep(5_000);
      const fallbackSession = await sessionManager.get(id);
      if (fallbackSession?.runtimeHandle) {
        await runtime.sendMessage(fallbackSession.runtimeHandle, message);
        return NextResponse.json({ ok: true, sessionId: id, restored: true });
      }

      break;
    }

    // Last resort: try to send anyway
    const finalSession = await sessionManager.get(id);
    if (finalSession?.runtimeHandle) {
      await runtime.sendMessage(finalSession.runtimeHandle, message);
      return NextResponse.json({ ok: true, sessionId: id, restored: true });
    }

    return NextResponse.json(
      { error: "Agent did not become ready within 30 seconds" },
      { status: 504 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to restore and send";
    const status = msg.includes("not found") ? 404 : msg.includes("not restorable") ? 409 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
