import { getServices } from "@/lib/services";
import { sessionToDashboard } from "@/lib/serialize";
import { getAttentionLevel } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/events — SSE stream for real-time lifecycle events
 *
 * Sends session state updates to connected clients.
 * Polls SessionManager.list() on an interval (no SSE push from core yet).
 */
export async function GET(): Promise<Response> {
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let updates: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  /** Safe enqueue — silently drops writes after the stream is closed. */
  function safeEnqueue(controller: ReadableStreamDefaultController, data: Uint8Array): boolean {
    if (closed) return false;
    try {
      controller.enqueue(data);
      return true;
    } catch {
      // Stream closed between our check and the enqueue call — clean up
      closed = true;
      clearInterval(heartbeat);
      clearInterval(updates);
      return false;
    }
  }

  const stream = new ReadableStream({
    start(controller) {
      // Send initial snapshot
      void (async () => {
        try {
          const { sessionManager } = await getServices();
          const sessions = await sessionManager.list();
          const dashboardSessions = sessions.map(sessionToDashboard);

          const initialEvent = {
            type: "snapshot",
            sessions: dashboardSessions.map((s) => ({
              id: s.id,
              status: s.status,
              activity: s.activity,
              attentionLevel: getAttentionLevel(s),
              lastActivityAt: s.lastActivityAt,
              progressText: s.progressText,
            })),
          };
          safeEnqueue(controller, encoder.encode(`data: ${JSON.stringify(initialEvent)}\n\n`));
        } catch {
          // If services aren't available, send empty snapshot
          safeEnqueue(
            controller,
            encoder.encode(`data: ${JSON.stringify({ type: "snapshot", sessions: [] })}\n\n`),
          );
        }
      })();

      // Send periodic heartbeat
      heartbeat = setInterval(() => {
        safeEnqueue(controller, encoder.encode(`: heartbeat\n\n`));
      }, 15000);

      // Poll for session state changes every 5 seconds
      updates = setInterval(() => {
        void (async () => {
          let dashboardSessions;
          try {
            const { sessionManager } = await getServices();
            const sessions = await sessionManager.list();
            dashboardSessions = sessions.map(sessionToDashboard);
          } catch {
            // Transient service error — skip this poll, retry on next interval
            return;
          }

          const event = {
            type: "snapshot",
            sessions: dashboardSessions.map((s) => ({
              id: s.id,
              status: s.status,
              activity: s.activity,
              attentionLevel: getAttentionLevel(s),
              lastActivityAt: s.lastActivityAt,
              progressText: s.progressText,
            })),
          };
          safeEnqueue(controller, encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        })();
      }, 5000);
    },
    cancel() {
      closed = true;
      clearInterval(heartbeat);
      clearInterval(updates);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
