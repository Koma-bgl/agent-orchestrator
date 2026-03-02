/**
 * Queue Poller — auto-spawn agent sessions from tracker issues.
 *
 * Periodically polls the issue tracker for issues matching configured filters
 * (e.g. label "Agent" + status "Ready to start") and spawns agent sessions
 * for new issues, respecting a per-project maxSessions cap.
 *
 * Follows the same patterns as lifecycle-manager.ts:
 * - Re-entrancy guard to prevent overlapping polls
 * - setInterval + immediate first poll
 * - Event emission for notifications/dashboard
 */

import { randomUUID } from "node:crypto";
import type {
  SessionManager,
  OrchestratorConfig,
  PluginRegistry,
  Tracker,
  OrchestratorEvent,
  EventType,
  EventPriority,
  SessionId,
} from "./types.js";

// ---------------------------------------------------------------------------
// Duration parsing (same logic as lifecycle-manager.ts)
// ---------------------------------------------------------------------------

/** Parse a duration string like "10m", "30s", "1h" to milliseconds. */
function parseDuration(value: string | number): number {
  if (typeof value === "number") return value;
  const match = value.match(/^(\d+)(s|m|h)$/);
  if (!match) return 0;
  const num = parseInt(match[1], 10);
  switch (match[2]) {
    case "s":
      return num * 1000;
    case "m":
      return num * 60_000;
    case "h":
      return num * 3_600_000;
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueuePollerDeps {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  sessionManager: SessionManager;
}

/** Per-project poll status tracked by the queue poller. */
export interface QueuePollStatus {
  /** Last time this project was successfully polled. */
  lastPollAt: Date | null;
  /** Last poll error (null if last poll succeeded). */
  lastError: string | null;
  /** Total number of sessions spawned by the queue poller. */
  totalSpawned: number;
}

export interface QueuePoller {
  /** Start the queue polling loop. */
  start(intervalMs?: number): void;
  /** Stop the queue polling loop. */
  stop(): void;
  /** Get poll status per project. */
  getStatus(): Map<string, QueuePollStatus>;
}

// ---------------------------------------------------------------------------
// Event helper
// ---------------------------------------------------------------------------

function createEvent(
  type: EventType,
  opts: {
    sessionId?: SessionId;
    projectId: string;
    message: string;
    priority?: EventPriority;
    data?: Record<string, unknown>;
  },
): OrchestratorEvent {
  const priority = opts.priority ?? "info";
  return {
    id: randomUUID(),
    type,
    priority,
    sessionId: opts.sessionId ?? ("queue" as SessionId),
    projectId: opts.projectId,
    timestamp: new Date(),
    message: opts.message,
    data: opts.data ?? {},
  };
}

// ---------------------------------------------------------------------------
// Queue Poller
// ---------------------------------------------------------------------------

/** Statuses where the session is finished and can be ignored for dedup. */
const DEAD_STATUSES = new Set([
  "killed",
  "done",
  "exited",
  "errored",
  "terminated",
  "merged",
  "cleanup",
]);

/**
 * Statuses where the agent is idle / waiting — these sessions exist but
 * shouldn't block the queue from spawning new work. The lifecycle manager's
 * reaction system will reactivate them when reviews come in.
 */
const IDLE_STATUSES = new Set([
  "review_pending",
  "changes_requested",
  "approved",
  "mergeable",
  "pr_open",
]);

export function createQueuePoller(deps: QueuePollerDeps): QueuePoller {
  const { config, registry, sessionManager } = deps;

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let polling = false; // Re-entrancy guard

  // Per-project poll status tracking
  const pollStatuses = new Map<string, QueuePollStatus>();

  // -------------------------------------------------------------------------
  // Per-project poll
  // -------------------------------------------------------------------------

  async function pollProject(projectId: string): Promise<OrchestratorEvent[]> {
    const events: OrchestratorEvent[] = [];
    const project = config.projects[projectId];
    if (!project?.queuePoller?.enabled) return events;

    const queueConfig = project.queuePoller;

    // Resolve tracker plugin
    const trackerName = project.tracker?.plugin;
    if (!trackerName) return events;
    const tracker = registry.get<Tracker>("tracker", trackerName);
    if (!tracker?.listIssues) return events;

    // 1. Fetch issues matching filters
    const issues = await tracker.listIssues(
      {
        state: "open",
        labels: queueConfig.filters?.labels,
        statusName: queueConfig.filters?.statusName,
        assignee: queueConfig.filters?.assignee,
        limit: queueConfig.limit ?? 50,
      },
      project,
    );

    if (issues.length === 0) return events;

    // 2. Load existing sessions — filter out dead ones for dedup
    const existingSessions = await sessionManager.list(projectId);
    const existingIssueMap = new Map(
      existingSessions
        .filter((s) => s.issueId && !DEAD_STATUSES.has(s.status))
        .map((s) => [s.issueId!.toLowerCase(), s.id]),
    );

    // 3. Count actively-working sessions for maxSessions cap.
    //    Sessions that are idle (waiting for review, approved, etc.) don't
    //    count — the lifecycle manager's reaction system handles those.
    let activeSessions = existingSessions.filter(
      (s) => !DEAD_STATUSES.has(s.status) && !IDLE_STATUSES.has(s.status),
    ).length;

    // 4. Spawn sessions for new issues
    for (const issue of issues) {
      // Skip if already has active session
      if (existingIssueMap.has(issue.id.toLowerCase())) {
        continue;
      }

      // Skip if at max capacity
      if (activeSessions >= queueConfig.maxSessions) {
        events.push(
          createEvent("queue.cap_reached", {
            projectId,
            message: `Queue: max sessions (${queueConfig.maxSessions}) reached — skipping ${issue.id}`,
            priority: "info",
            data: { issueId: issue.id, maxSessions: queueConfig.maxSessions },
          }),
        );
        break; // No point checking more issues
      }

      try {
        // Spawn session
        const session = await sessionManager.spawn({
          projectId,
          issueId: issue.id,
        });

        activeSessions++;

        events.push(
          createEvent("queue.session_spawned", {
            sessionId: session.id,
            projectId,
            message: `Queue: spawned session ${session.id} for ${issue.id} — "${issue.title}"`,
            priority: "action",
            data: {
              sessionId: session.id,
              issueId: issue.id,
              issueTitle: issue.title,
            },
          }),
        );

        // Post-spawn actions: move issue to new status
        if (queueConfig.onSpawn?.moveToStatus && tracker.updateIssue) {
          try {
            await tracker.updateIssue(
              issue.id,
              { statusName: queueConfig.onSpawn.moveToStatus },
              project,
            );
          } catch {
            // Log but don't fail — session is already spawned
          }
        }
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : String(err);
        events.push(
          createEvent("queue.spawn_failed", {
            projectId,
            message: `Queue: failed to spawn session for ${issue.id} — ${message}`,
            priority: "warning",
            data: { issueId: issue.id, error: message },
          }),
        );
      }
    }

    return events;
  }

  // -------------------------------------------------------------------------
  // Poll all projects
  // -------------------------------------------------------------------------

  async function pollAll(): Promise<void> {
    if (polling) return; // Re-entrancy guard
    polling = true;

    try {
      const projectIds = Object.keys(config.projects).filter(
        (id) => config.projects[id].queuePoller?.enabled,
      );

      if (projectIds.length === 0) return;

      const results = await Promise.allSettled(
        projectIds.map((id) => pollProject(id)),
      );

      // Update poll status and log events
      for (let i = 0; i < projectIds.length; i++) {
        const projectId = projectIds[i];
        const result = results[i];
        const existing = pollStatuses.get(projectId) ?? {
          lastPollAt: null,
          lastError: null,
          totalSpawned: 0,
        };

        if (result.status === "fulfilled") {
          const spawnedCount = result.value.filter(
            (e) => e.type === "queue.session_spawned",
          ).length;
          pollStatuses.set(projectId, {
            lastPollAt: new Date(),
            lastError: null,
            totalSpawned: existing.totalSpawned + spawnedCount,
          });
          for (const event of result.value) {
            // eslint-disable-next-line no-console
            console.log(`[queue-poller] ${event.message}`);
          }
        } else {
          const errorMsg =
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason);
          pollStatuses.set(projectId, {
            ...existing,
            lastError: errorMsg,
          });
          // eslint-disable-next-line no-console
          console.error(`[queue-poller] Poll error (${projectId}):`, result.reason);
        }
      }

      // Summary log with timestamp
      const now = new Date().toISOString();
      const statuses = projectIds.map((id) => {
        const s = pollStatuses.get(id);
        return s?.lastError ? `${id}: error` : `${id}: ok`;
      });
      // eslint-disable-next-line no-console
      console.log(`[queue-poller] Poll complete at ${now} — ${statuses.join(", ")}`);
    } finally {
      polling = false;
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  return {
    start(intervalMs?: number): void {
      if (pollTimer) return; // Already running

      // Determine interval: use provided value, or derive from first enabled project
      const resolvedInterval =
        intervalMs ??
        (() => {
          for (const project of Object.values(config.projects)) {
            if (project.queuePoller?.enabled && project.queuePoller.interval) {
              return parseDuration(project.queuePoller.interval);
            }
          }
          return 30_000; // Default 30s
        })();

      const ms = resolvedInterval || 30_000;
      pollTimer = setInterval(() => void pollAll(), ms);
      // Run immediately on start
      void pollAll();
    },

    stop(): void {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    },

    getStatus(): Map<string, QueuePollStatus> {
      return new Map(pollStatuses);
    },
  };
}
