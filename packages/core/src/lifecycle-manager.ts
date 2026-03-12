/**
 * Lifecycle Manager — state machine + polling loop + reaction engine.
 *
 * Periodically polls all sessions and:
 * 1. Detects state transitions (spawning → working → pr_open → etc.)
 * 2. Emits events on transitions
 * 3. Triggers reactions (auto-handle CI failures, review comments, etc.)
 * 4. Escalates to human notification when auto-handling fails
 *
 * Reference: scripts/claude-session-status, scripts/claude-review-check
 */

import { randomUUID } from "node:crypto";
import {
  SESSION_STATUS,
  PR_STATE,
  CI_STATUS,
  type LifecycleManager,
  type SessionManager,
  type SessionId,
  type SessionStatus,
  type EventType,
  type OrchestratorEvent,
  type OrchestratorConfig,
  type ReactionConfig,
  type ReactionResult,
  type PluginRegistry,
  type Runtime,
  type Agent,
  type SCM,
  type Tracker,
  type Notifier,
  type Session,
  type EventPriority,
  type Workspace,
  type ProjectConfig as _ProjectConfig,
} from "./types.js";
import { updateMetadata, readMetadataRaw } from "./metadata.js";
import { getSessionsDir } from "./paths.js";
import { createQueuePoller } from "./queue-poller.js";

/** Parse a duration string like "10m", "30s", "1h", "1d" to milliseconds. */
function parseDuration(str: string): number {
  const match = str.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return 0;
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case "s":
      return value * 1000;
    case "m":
      return value * 60_000;
    case "h":
      return value * 3_600_000;
    case "d":
      return value * 86_400_000;
    default:
      return 0;
  }
}

/** Infer a reasonable priority from event type. */
function inferPriority(type: EventType): EventPriority {
  if (type.includes("stuck") || type.includes("needs_input") || type.includes("errored")) {
    return "urgent";
  }
  if (type.startsWith("summary.")) {
    return "info";
  }
  if (
    type.includes("approved") ||
    type.includes("ready") ||
    type.includes("merged") ||
    type.includes("completed") ||
    type === "pr.created"
  ) {
    return "action";
  }
  if (type.includes("fail") || type.includes("changes_requested") || type.includes("conflicts")) {
    return "warning";
  }
  return "info";
}

/** Create an OrchestratorEvent with defaults filled in. */
function createEvent(
  type: EventType,
  opts: {
    sessionId: SessionId;
    projectId: string;
    message: string;
    priority?: EventPriority;
    data?: Record<string, unknown>;
  },
): OrchestratorEvent {
  return {
    id: randomUUID(),
    type,
    priority: opts.priority ?? inferPriority(type),
    sessionId: opts.sessionId,
    projectId: opts.projectId,
    timestamp: new Date(),
    message: opts.message,
    data: opts.data ?? {},
  };
}

/** Determine which event type corresponds to a status transition. */
function statusToEventType(_from: SessionStatus | undefined, to: SessionStatus): EventType | null {
  switch (to) {
    case "working":
      return "session.working";
    case "pr_open":
      return "pr.created";
    case "ci_failed":
      return "ci.failing";
    case "review_pending":
      return "review.pending";
    case "changes_requested":
      return "review.changes_requested";
    case "approved":
      return "review.approved";
    case "mergeable":
      return "merge.ready";
    case "merge_conflicts":
      return "merge.conflicts";
    case "merged":
      return "merge.completed";
    case "needs_input":
      return "session.needs_input";
    case "stuck":
      return "session.stuck";
    case "errored":
      return "session.errored";
    case "killed":
      return "session.killed";
    default:
      return null;
  }
}

/** Map event type to reaction config key. */
function eventToReactionKey(eventType: EventType): string | null {
  switch (eventType) {
    case "ci.failing":
      return "ci-failed";
    case "review.changes_requested":
      return "changes-requested";
    case "automated_review.found":
      return "bugbot-comments";
    case "merge.conflicts":
      return "merge-conflicts";
    case "merge.ready":
      return "approved-and-green";
    case "review.approved":
      return "approved-behind";
    case "session.stuck":
      return "agent-stuck";
    case "session.needs_input":
      return "agent-needs-input";
    case "session.killed":
      return "agent-exited";
    case "summary.all_complete":
      return "all-complete";
    case "pr.created":
      return "pr-created";
    default:
      return null;
  }
}

/** Build a human-readable notification message for a status transition. */
function buildTransitionMessage(
  sessionId: SessionId,
  oldStatus: SessionStatus,
  newStatus: SessionStatus,
  session: Session,
): string {
  const pr = session.pr;
  const prTag = pr ? ` (PR #${pr.number})` : "";
  const issueTag = session.issueId ? ` [${session.issueId}]` : "";

  switch (newStatus) {
    case "working":
      return `${sessionId}${issueTag} is now working`;
    case "pr_open":
      return `${sessionId}${issueTag} opened a PR${prTag}`;
    case "ci_failed":
      return `CI is failing on ${sessionId}${prTag}`;
    case "review_pending":
      return `${sessionId}${prTag} is waiting for review`;
    case "changes_requested":
      return `Changes requested on ${sessionId}${prTag}`;
    case "approved":
      return `${sessionId}${prTag} has been approved`;
    case "mergeable":
      return `${sessionId}${prTag} is ready to merge — CI green + approved`;
    case "merge_conflicts":
      return `${sessionId}${prTag} has merge conflicts — agent needs to rebase`;
    case "merged":
      return `${sessionId}${prTag} has been merged`;
    case "needs_input":
      return `${sessionId} needs your input — agent is waiting for a response`;
    case "stuck":
      return `${sessionId} appears stuck — no progress detected`;
    case "errored":
      return `${sessionId} hit an error`;
    case "killed":
      return oldStatus === "spawning"
        ? `${sessionId} failed to start`
        : `${sessionId} agent process exited`;
    default:
      return `${sessionId}: ${oldStatus} → ${newStatus}`;
  }
}

/** Build enriched event data including PR URL, CI status, etc. */
function buildEventData(
  oldStatus: SessionStatus,
  newStatus: SessionStatus,
  session: Session,
): Record<string, unknown> {
  const data: Record<string, unknown> = { oldStatus, newStatus };

  if (session.pr) {
    data["prUrl"] = session.pr.url;
    data["prNumber"] = session.pr.number;
    data["prTitle"] = session.pr.title;
    data["branch"] = session.pr.branch;
  } else if (session.branch) {
    data["branch"] = session.branch;
  }

  if (session.issueId) {
    data["issueId"] = session.issueId;
  }

  // Add status-specific context
  if (newStatus === "ci_failed") {
    data["ciStatus"] = "failing";
  } else if (newStatus === "mergeable" || newStatus === "approved") {
    data["ciStatus"] = "passing";
  }

  if (session.agentInfo?.summary) {
    data["summary"] = session.agentInfo.summary;
  }

  return data;
}

export interface LifecycleManagerDeps {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  sessionManager: SessionManager;
}

/** Track attempt counts for reactions per session. */
interface ReactionTracker {
  attempts: number;
  firstTriggered: Date;
}

/** Create a LifecycleManager instance. */
export function createLifecycleManager(deps: LifecycleManagerDeps): LifecycleManager {
  const { config, registry, sessionManager } = deps;

  const states = new Map<SessionId, SessionStatus>();
  const reactionTrackers = new Map<string, ReactionTracker>(); // "sessionId:reactionKey"
  // Per-project merge lock: only one merge/rebase operation at a time per project.
  // When one PR merges, all other PRs in the project become behind and need updating.
  // Processing them one at a time avoids cascading rebase storms.
  const projectMergeLocks = new Map<string, boolean>();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let polling = false; // re-entrancy guard
  let allCompleteEmitted = false; // guard against repeated all_complete

  // Queue poller — auto-spawn sessions from tracker issues
  const queuePoller = createQueuePoller({ config, registry, sessionManager });

  /** Determine current status for a session by polling plugins. */
  async function determineStatus(session: Session): Promise<SessionStatus> {
    const project = config.projects[session.projectId];
    if (!project) return session.status;

    const agentName = session.metadata["agent"] ?? project.agent ?? config.defaults.agent;
    const agent = registry.get<Agent>("agent", agentName);
    const scm = project.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;

    // 1. Check if runtime is alive
    // Track whether the agent/runtime has exited — we defer returning "killed"
    // until after the PR state check (step 4), because an exited agent with
    // an open PR that has changes_requested or failing CI should not be "killed".
    let agentExited = false;

    if (session.runtimeHandle) {
      const runtime = registry.get<Runtime>("runtime", project.runtime ?? config.defaults.runtime);
      if (runtime) {
        const alive = await runtime.isAlive(session.runtimeHandle).catch(() => true);
        if (!alive) {
          agentExited = true;
        }
      }
    }

    // 2. Check agent activity via terminal output + process liveness
    //    NOTE: We detect waiting_input here but defer returning it until AFTER
    //    the PR state check (step 4). PR-level states like merge_conflicts and
    //    ci_failed take priority — the merge-conflicts reaction will restore
    //    the agent and handle any stuck prompt automatically.
    let agentWaitingInput = false;

    if (!agentExited && agent && session.runtimeHandle) {
      try {
        const runtime = registry.get<Runtime>(
          "runtime",
          project.runtime ?? config.defaults.runtime,
        );
        const terminalOutput = runtime ? await runtime.getOutput(session.runtimeHandle, 10) : "";
        // Only trust detectActivity when we actually have terminal output;
        // empty output means the runtime probe failed, not that the agent exited.
        if (terminalOutput) {
          const activity = agent.detectActivity(terminalOutput);
          if (activity === "waiting_input") {
            agentWaitingInput = true;
            // Don't return here — check PR state first (step 4)
          }

          // Check whether the agent process is still alive. Some agents
          // (codex, aider, opencode) return "active" for any non-empty
          // terminal output, including the shell prompt visible after exit.
          // Checking isProcessRunning for both "idle" and "active" ensures
          // exit detection works regardless of the agent's classifier.
          const processAlive = await agent.isProcessRunning(session.runtimeHandle);
          if (!processAlive) {
            agentExited = true;
          }
        }
      } catch {
        // On probe failure, preserve current stuck/needs_input state rather
        // than letting the fallback at the bottom coerce them to "working"
        if (
          session.status === SESSION_STATUS.STUCK ||
          session.status === SESSION_STATUS.NEEDS_INPUT
        ) {
          return session.status;
        }
      }
    }

    // 2.5 Check for new tracker comments (e.g., QA feedback on Linear) when no PR exists.
    //     Once a PR exists, SCM-level comments (step 4) take over.
    if (!session.pr && session.issueId && project.tracker) {
      try {
        const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
        if (tracker?.getComments) {
          const comments = await tracker.getComments(session.issueId, project);
          // Only consider comments posted after session creation to avoid
          // re-sending comments already included in the initial prompt.
          const sentIds = new Set(
            (session.metadata["trackerCommentsSent"] ?? "").split(",").filter(Boolean),
          );
          const newComments = comments.filter(
            (c) => c.createdAt > session.createdAt && !sentIds.has(c.id),
          );
          if (newComments.length > 0) {
            return "changes_requested";
          }
        }
      } catch {
        // Non-fatal — will retry next poll
      }
    }

    // 3. Auto-detect PR by branch if metadata.pr is missing.
    //    This is critical for agents without auto-hook systems (Codex, Aider,
    //    OpenCode) that can't reliably write pr=<url> to metadata on their own.
    if (!session.pr && scm && session.branch) {
      try {
        const detectedPR = await scm.detectPR(session, project);
        if (detectedPR) {
          session.pr = detectedPR;
          // Persist PR URL so subsequent polls don't need to re-query.
          // Don't write status here — step 4 below will determine the
          // correct status (merged, ci_failed, etc.) on this same cycle.
          const sessionsDir = getSessionsDir(config.configPath, project.path);
          updateMetadata(sessionsDir, session.id, { pr: detectedPR.url });
        }
      } catch {
        // SCM detection failed — will retry next poll
      }
    }

    // 4. Check PR state if PR exists
    //    PR-level states take priority over terminal-detected needs_input
    if (session.pr && scm) {
      try {
        // Must check PR state first — merged/closed PRs short-circuit everything
        const prState = await scm.getPRState(session.pr);
        if (prState === PR_STATE.MERGED) return "merged";
        if (prState === PR_STATE.CLOSED) return "killed";

        // Fetch CI, merge readiness, comments, and review decision in parallel
        // to reduce sequential API calls and rate limit pressure.
        const [ciStatus, mergeReady, pendingComments, reviewDecision] =
          await Promise.all([
            scm.getCISummary(session.pr),
            scm.getMergeability(session.pr),
            scm.getPendingComments(session.pr),
            scm.getReviewDecision(session.pr),
          ]);

        // Check CI
        if (ciStatus === CI_STATUS.FAILING) return "ci_failed";

        // Check merge conflicts early — regardless of review status.
        if (!mergeReady.noConflicts) return "merge_conflicts";

        // Check for unresolved review comments first — regardless of the
        // formal review decision. Reviewers often leave comments using
        // "Comment" instead of "Request changes", so the review decision
        // may be "pending" or "none" even when there's actionable feedback.
        console.log(
          `[lifecycle] ${session.id}: pendingComments=${pendingComments.length}, reviewDecision=${reviewDecision}, ci=${ciStatus}` +
            (pendingComments.length > 0
              ? ` — comments: ${pendingComments.map((c) => `${c.commentType}:@${c.author}`).join(", ")}`
              : ""),
        );
        if (pendingComments.length > 0) return "changes_requested";

        // Check formal review decision
        if (reviewDecision === "changes_requested") return "changes_requested";
        if (reviewDecision === "approved") {
          if (mergeReady.mergeable) return "mergeable";
          return "approved";
        }
        if (reviewDecision === "pending") return "review_pending";

        return "pr_open";
      } catch {
        // SCM check failed — keep current status
      }
    }

    // 5. Agent is waiting for input and no PR-level issue was found
    if (agentWaitingInput) return "needs_input";

    // 6. If agent exited and PR check didn't provide a better status, it's killed
    if (agentExited) return "killed";

    // 7. Default: if agent is active, it's working
    if (
      session.status === "spawning" ||
      session.status === SESSION_STATUS.STUCK ||
      session.status === SESSION_STATUS.NEEDS_INPUT
    ) {
      return "working";
    }
    return session.status;
  }

  /** Execute a reaction for a session. */
  async function executeReaction(
    sessionId: SessionId,
    projectId: string,
    reactionKey: string,
    reactionConfig: ReactionConfig,
  ): Promise<ReactionResult> {
    const trackerKey = `${sessionId}:${reactionKey}`;
    let tracker = reactionTrackers.get(trackerKey);

    if (!tracker) {
      tracker = { attempts: 0, firstTriggered: new Date() };
      reactionTrackers.set(trackerKey, tracker);
    }

    // Increment attempts before checking escalation
    tracker.attempts++;

    // Check if we should escalate
    const maxRetries = reactionConfig.retries ?? Infinity;
    const escalateAfter = reactionConfig.escalateAfter;
    let shouldEscalate = false;

    if (tracker.attempts > maxRetries) {
      shouldEscalate = true;
    }

    if (typeof escalateAfter === "string") {
      const durationMs = parseDuration(escalateAfter);
      if (durationMs > 0 && Date.now() - tracker.firstTriggered.getTime() > durationMs) {
        shouldEscalate = true;
      }
    }

    if (typeof escalateAfter === "number" && tracker.attempts > escalateAfter) {
      shouldEscalate = true;
    }

    if (shouldEscalate) {
      // Escalate to human
      const event = createEvent("reaction.escalated", {
        sessionId,
        projectId,
        message: `Reaction '${reactionKey}' escalated after ${tracker.attempts} attempts`,
        data: { reactionKey, attempts: tracker.attempts },
      });
      await notifyHuman(event, reactionConfig.priority ?? "urgent");
      return {
        reactionType: reactionKey,
        success: true,
        action: "escalated",
        escalated: true,
      };
    }

    // Execute the reaction action
    const action = reactionConfig.action ?? "notify";

    switch (action) {
      case "send-to-agent": {
        if (reactionConfig.message) {
          try {
            await sessionManager.send(sessionId, reactionConfig.message);

            return {
              reactionType: reactionKey,
              success: true,
              action: "send-to-agent",
              message: reactionConfig.message,
              escalated: false,
            };
          } catch {
            // Send failed — allow retry on next poll cycle (don't escalate immediately)
            return {
              reactionType: reactionKey,
              success: false,
              action: "send-to-agent",
              escalated: false,
            };
          }
        }
        break;
      }

      case "send-comments-to-agent": {
        try {
          const session = await sessionManager.get(sessionId);
          if (!session) {
            return { reactionType: reactionKey, success: false, action, escalated: false };
          }

          const project = config.projects[projectId];

          // --- PR comments (post-PR flow via SCM) ---
          if (session.pr) {
            const scm = project?.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;
            if (!scm) {
              return { reactionType: reactionKey, success: false, action, escalated: false };
            }

            const comments = await scm.getPendingComments(session.pr);
            console.log(
              `[lifecycle] ${sessionId}: getPendingComments returned ${comments.length} comment(s)` +
                (comments.length > 0
                  ? ` — types: ${comments.map((c) => `${c.commentType}:@${c.author}`).join(", ")}`
                  : ""),
            );
            if (comments.length === 0) {
              return { reactionType: reactionKey, success: true, action, escalated: false };
            }

            // React with 👀 on each comment to signal we're on it
            const pr = session.pr;
            if (scm.addReaction && pr) {
              const addReaction = scm.addReaction.bind(scm);
              await Promise.all(
                comments.map((c) =>
                  addReaction(c.id, pr, "eyes", c.commentType).catch(() => {
                    // Non-fatal — don't block on reaction failures
                  }),
                ),
              );
            }

            const notifyEvent = createEvent("reaction.triggered", {
              sessionId,
              projectId,
              message: `Picking up ${comments.length} review comment${comments.length !== 1 ? "s" : ""} on ${session.id} (PR #${session.pr.number}) — sending to agent`,
            });
            await notifyHuman(notifyEvent, "info");

            const commentLines = comments.map((c, i) => {
              const location = c.path
                ? `File: ${c.path}${c.line ? `:${c.line}` : ""}`
                : "General";
              return `### Comment ${i + 1} (by @${c.author})\n${location}\n${c.body}\nURL: ${c.url}`;
            });

            const message = [
              `There are ${comments.length} unresolved review comment${comments.length !== 1 ? "s" : ""} on your PR. Please address each one:`,
              "",
              ...commentLines,
              "",
              "For each comment:",
              "- If the feedback is valid, fix the code and push.",
              "- If the feedback is not applicable or incorrect, reply to the comment explaining why and resolve it.",
              "- After addressing all comments, push your changes.",
            ].join("\n");

            await sessionManager.send(sessionId, message);

            // Resolve the review threads now that we've sent them to the agent.
            // This prevents the same comments from being picked up again on the
            // next poll cycle and avoids the "1 unresolved comment" stale state.
            const resolvable = comments.filter(
              (c) => c.threadId && c.commentType === "review_comment",
            );
            const unresolvable = comments.filter(
              (c) => !c.threadId || c.commentType !== "review_comment",
            );
            if (unresolvable.length > 0) {
              console.log(
                `[lifecycle] ${sessionId}: ${unresolvable.length} comment(s) cannot be auto-resolved (issue_comment or missing threadId): ${unresolvable.map((c) => `@${c.author}:${c.commentType}`).join(", ")}`,
              );
            }
            if (scm.resolveThread && pr && resolvable.length > 0) {
              const resolveThread = scm.resolveThread.bind(scm);
              console.log(
                `[lifecycle] ${sessionId}: resolving ${resolvable.length} review thread(s)`,
              );
              await Promise.all(
                resolvable.map((c) =>
                  resolveThread(c.threadId!, pr).catch((err: unknown) => {
                    console.error(
                      `[lifecycle] ${sessionId}: failed to resolve thread ${c.threadId}: ${err instanceof Error ? err.message : String(err)}`,
                    );
                  }),
                ),
              );
            }

            return {
              reactionType: reactionKey,
              success: true,
              action: "send-comments-to-agent",
              message: `Sent ${comments.length} review comments to agent`,
              escalated: false,
            };
          }

          // --- Tracker comments (pre-PR flow, e.g. QA feedback on Linear) ---
          if (session.issueId && project?.tracker) {
            const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
            if (!tracker?.getComments) {
              return { reactionType: reactionKey, success: false, action, escalated: false };
            }

            const allComments = await tracker.getComments(session.issueId, project);
            const sentIds = new Set(
              (session.metadata["trackerCommentsSent"] ?? "").split(",").filter(Boolean),
            );
            const newComments = allComments.filter(
              (c) => c.createdAt > session.createdAt && !sentIds.has(c.id),
            );

            console.log(
              `[lifecycle] ${sessionId}: tracker comments — total=${allComments.length}, new=${newComments.length}`,
            );

            if (newComments.length === 0) {
              return { reactionType: reactionKey, success: true, action, escalated: false };
            }

            const notifyEvent = createEvent("reaction.triggered", {
              sessionId,
              projectId,
              message: `Picking up ${newComments.length} tracker comment${newComments.length !== 1 ? "s" : ""} on ${session.id} [${session.issueId}] — sending to agent`,
            });
            await notifyHuman(notifyEvent, "info");

            const commentLines = newComments.map((c, i) => {
              const timestamp = c.createdAt.toISOString().split("T")[0];
              return `### Comment ${i + 1} (by @${c.author}, ${timestamp})\n${c.body}\nURL: ${c.url}`;
            });

            const message = [
              `There ${newComments.length === 1 ? "is" : "are"} ${newComments.length} new comment${newComments.length !== 1 ? "s" : ""} on the issue tracker. Please address the feedback:`,
              "",
              ...commentLines,
              "",
              "For each comment:",
              "- If the feedback is valid (e.g., a bug report from QA), fix the code and push.",
              "- After addressing all comments, push your changes.",
            ].join("\n");

            await sessionManager.send(sessionId, message);

            // Track sent comment IDs in metadata to avoid re-sending
            const updatedSentIds = [...sentIds, ...newComments.map((c) => c.id)].join(",");
            const sessionsDir = getSessionsDir(config.configPath, project.path);
            updateMetadata(sessionsDir, session.id, {
              trackerCommentsSent: updatedSentIds,
            });

            return {
              reactionType: reactionKey,
              success: true,
              action: "send-comments-to-agent",
              message: `Sent ${newComments.length} tracker comments to agent`,
              escalated: false,
            };
          }

          return { reactionType: reactionKey, success: false, action, escalated: false };
        } catch {
          return {
            reactionType: reactionKey,
            success: false,
            action: "send-comments-to-agent",
            escalated: false,
          };
        }
      }

      case "notify": {
        const event = createEvent("reaction.triggered", {
          sessionId,
          projectId,
          message: `Reaction '${reactionKey}' triggered notification`,
          data: { reactionKey },
        });
        await notifyHuman(event, reactionConfig.priority ?? "info");
        return {
          reactionType: reactionKey,
          success: true,
          action: "notify",
          escalated: false,
        };
      }

      case "auto-merge": {
        try {
          const session = await sessionManager.get(sessionId);
          if (!session?.pr) {
            return { reactionType: reactionKey, success: false, action, escalated: false };
          }

          const project = config.projects[projectId];
          const scm = project?.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;
          if (!scm) {
            return { reactionType: reactionKey, success: false, action, escalated: false };
          }

          // Check if PR needs a rebase first (behind base branch)
          const mergeReady = await scm.getMergeability(session.pr);

          // Guard: verify the PR is actually approved before taking any
          // merge/rebase action. The "approved" status may have been set
          // from a previous poll cycle with stale or rate-limited data.
          if (!mergeReady.approved) {
            console.log(`[lifecycle] ${sessionId}: skipping auto-merge — PR is not approved (stale status?)`);
            return { reactionType: reactionKey, success: false, action, escalated: false };
          }

          if (!mergeReady.noConflicts) {
            // Real merge conflicts — can't auto-merge, escalate
            const event = createEvent("reaction.triggered", {
              sessionId,
              projectId,
              message: `Cannot auto-merge ${sessionId}: merge conflicts`,
              data: { reactionKey },
            });
            await notifyHuman(event, "urgent");
            return { reactionType: reactionKey, success: false, action, escalated: true };
          }

          // Per-project merge lock: only one merge/rebase at a time per project.
          // When one PR merges, all other PRs become behind. Processing them
          // sequentially avoids cascading rebase storms where every PR updates
          // its branch simultaneously, only to become behind again after the next merge.
          if (projectMergeLocks.get(projectId)) {
            console.log(
              `[lifecycle] ${sessionId}: skipping auto-merge — another merge/rebase in progress for project "${projectId}"`,
            );
            return { reactionType: reactionKey, success: false, action, escalated: false };
          }

          projectMergeLocks.set(projectId, true);
          try {
            if (!mergeReady.mergeable) {
              // Approved but not yet mergeable. Trigger a branch update if the
              // blockers indicate the branch is behind OR GitHub is still computing
              // merge status (common after another PR just merged into the base branch).
              // Other blockers (branch protection, draft, failing CI) should NOT
              // trigger a rebase — just wait for the next cycle.
              const updatableBlockers = [
                "branch is behind",
                "branch is not up to date",
                "merge status unknown", // GitHub still computing — often just behind
              ];
              const canUpdateBranch =
                mergeReady.ciPassing &&
                mergeReady.blockers.length > 0 &&
                mergeReady.blockers.every(
                  (b) => updatableBlockers.some((pat) => b.toLowerCase().includes(pat)),
                );

              if (!canUpdateBranch) {
                console.log(
                  `[lifecycle] ${sessionId}: approved but not mergeable (blockers: ${mergeReady.blockers.join(", ") || "unknown"}), waiting`,
                );
                return { reactionType: reactionKey, success: false, action, escalated: false };
              }

              console.log(`[lifecycle] ${sessionId}: approved + CI green but branch needs update, attempting update via SCM`);

              // Use SCM rebasePR if available (non-destructive GitHub API rebase),
              // otherwise fall back to sending an instruction to the agent.
              if (typeof scm.rebasePR === "function") {
                try {
                  await scm.rebasePR(session.pr);
                  console.log(`[lifecycle] ${sessionId}: SCM rebase succeeded, will retry merge next cycle`);
                } catch (rebaseErr) {
                  console.error(`[lifecycle] ${sessionId}: SCM rebase failed:`, rebaseErr);
                }
              } else {
                await sessionManager.send(
                  sessionId,
                  "Your PR is approved but the branch is behind the base branch. " +
                    "Please run `git fetch origin && git rebase origin/main && git push` so CI can run, then it will be auto-merged. " +
                    "Do NOT close or recreate the PR.",
                );
              }
              return {
                reactionType: reactionKey,
                success: true,
                action: "auto-merge",
                message: "Sent rebase instruction before merge",
                escalated: false,
              };
            }

            // All clear — squash merge
            console.log(`[lifecycle] ${sessionId}: auto-merging PR #${session.pr.number}`);
            try {
              await scm.mergePR(session.pr, "squash");
            } catch (mergeErr: unknown) {
              // Merge can fail if the branch is behind (stale cache said mergeable).
              // Try updating the branch so the next cycle can merge.
              const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
              console.log(`[lifecycle] ${sessionId}: merge failed (${msg}), attempting branch update`);
              if (typeof scm.rebasePR === "function") {
                try {
                  await scm.rebasePR(session.pr);
                  console.log(`[lifecycle] ${sessionId}: branch update succeeded after merge failure, will retry next cycle`);
                } catch {
                  console.error(`[lifecycle] ${sessionId}: branch update also failed after merge failure`);
                }
              }
              return {
                reactionType: reactionKey,
                success: false,
                action: "auto-merge",
                message: `Merge failed, attempted branch update: ${msg}`,
                escalated: false,
              };
            }

            const event = createEvent("merge.completed", {
              sessionId,
              projectId,
              message: `Auto-merged ${sessionId} PR #${session.pr.number}`,
              data: { reactionKey, prNumber: session.pr.number },
            });
            await notifyHuman(event, "info");

            return {
              reactionType: reactionKey,
              success: true,
              action: "auto-merge",
              message: `Squash-merged PR #${session.pr.number}`,
              escalated: false,
            };
          } finally {
            // NOTE: Lock is intentionally NOT released here. It persists for
            // the remainder of this poll cycle so that only one merge/rebase
            // operation runs per project per cycle. The lock is cleared at the
            // start of the next pollAll() call. This prevents cascading rebases
            // where all behind PRs update their branches simultaneously after
            // a single merge, only to become behind again when the next one merges.
          }
        } catch (err) {
          console.error(`[lifecycle] auto-merge failed for ${sessionId}:`, err);
          return {
            reactionType: reactionKey,
            success: false,
            action: "auto-merge",
            escalated: false,
          };
        }
      }
    }

    return {
      reactionType: reactionKey,
      success: false,
      action,
      escalated: false,
    };
  }

  /** Send a notification to all configured notifiers. */
  async function notifyHuman(event: OrchestratorEvent, priority: EventPriority): Promise<void> {
    const eventWithPriority = { ...event, priority };
    const notifierNames = config.notificationRouting[priority] ?? config.defaults.notifiers;
    console.log(`[lifecycle] notifyHuman: priority=${priority}, notifiers=${JSON.stringify(notifierNames)}`);

    for (const name of notifierNames) {
      const notifier = registry.get<Notifier>("notifier", name);
      console.log(`[lifecycle] notifyHuman: notifier "${name}" resolved=${!!notifier}`);
      if (notifier) {
        try {
          await notifier.notify(eventWithPriority);
        } catch (err: unknown) {
          console.error(
            `[lifecycle] notifier "${name}" failed for ${event.type}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }
  }

  /** Post a simple PR message ("{PR URL} - {PR title}") to all notifiers that support post(). */
  async function postPrCreated(session: Session): Promise<void> {
    if (!session.pr?.url) {
      console.log(`[lifecycle] postPrCreated: skipped — no PR URL for ${session.id}`);
      return;
    }

    const message = `${session.pr.url} - ${session.pr.title ?? session.id}`;
    const notifierNames = config.notificationRouting["info"] ?? config.defaults.notifiers;
    console.log(`[lifecycle] postPrCreated: message="${message}", notifiers=${JSON.stringify(notifierNames)}`);

    for (const name of notifierNames) {
      const notifier = registry.get<Notifier>("notifier", name);
      if (notifier?.post) {
        try {
          await notifier.post(message, {
            sessionId: session.id,
            projectId: session.projectId,
            prUrl: session.pr.url,
          });
        } catch (err: unknown) {
          console.error(
            `[lifecycle] notifier "${name}" post failed for ${session.id}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }
  }

  /**
   * Sync issue tracker status when session transitions to key states.
   *
   * Only two transitions are synced:
   * 1. working → "In Progress" (agent started coding)
   * 2. pr_open / review_pending → "Ready for review" (PR created, needs human review)
   *
   * All other transitions (merged, ci_failed, etc.) do NOT move the issue —
   * those are handled manually by the team.
   */
  async function syncIssueStatus(session: Session, newStatus: SessionStatus): Promise<void> {
    if (!session.issueId) return;

    const project = config.projects[session.projectId];
    if (!project?.tracker) return;

    const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
    if (!tracker?.updateIssue) return;

    // Map session status → exact workflow state name.
    // Using statusName (exact name) instead of generic state type to avoid
    // landing on the wrong status (e.g. QA instead of In Progress).
    let statusName: string;
    switch (newStatus) {
      case "working":
        statusName = "In Progress";
        break;
      case "pr_open":
      case "review_pending":
        statusName = "Ready for review";
        break;
      default:
        return; // No issue update needed for other transitions
    }

    try {
      await tracker.updateIssue(session.issueId, { statusName }, project);
    } catch {
      // Non-fatal — don't block lifecycle on tracker failures
    }
  }

  /** Poll a single session and handle state transitions. */
  async function checkSession(session: Session): Promise<void> {
    // Use tracked state if available; otherwise use the persisted metadata status
    // (not session.status, which list() may have already overwritten for dead runtimes).
    // This ensures transitions are detected after a lifecycle manager restart.
    const tracked = states.get(session.id);
    const oldStatus =
      tracked ?? ((session.metadata?.["status"] as SessionStatus | undefined) || session.status);
    const newStatus = await determineStatus(session);
    console.log(`[lifecycle] checkSession ${session.id}: old=${oldStatus} new=${newStatus} tracked=${tracked ?? "none"}`);

    if (newStatus !== oldStatus) {
      // State transition detected
      states.set(session.id, newStatus);

      // Update metadata — session.projectId is the config key (e.g., "my-app")
      const project = config.projects[session.projectId];
      if (project) {
        const sessionsDir = getSessionsDir(config.configPath, project.path);
        const metadataUpdates: Record<string, string> = { status: newStatus };

        // Record merge timestamp for delayed worktree cleanup
        if (newStatus === "merged") {
          metadataUpdates["mergedAt"] = new Date().toISOString();
        }

        updateMetadata(sessionsDir, session.id, metadataUpdates);
      }

      // Update tracker issue status on key transitions
      await syncIssueStatus(session, newStatus);

      // Reset allCompleteEmitted when any session becomes active again
      if (newStatus !== "merged" && newStatus !== "killed") {
        allCompleteEmitted = false;
      }

      // Clear reaction trackers for the old status so retries reset on state changes
      const oldEventType = statusToEventType(undefined, oldStatus);
      if (oldEventType) {
        const oldReactionKey = eventToReactionKey(oldEventType);
        if (oldReactionKey) {
          reactionTrackers.delete(`${session.id}:${oldReactionKey}`);
        }
      }

      // Handle transition: notify humans and/or trigger reactions
      const eventType = statusToEventType(oldStatus, newStatus);
      console.log(`[lifecycle] transition ${session.id}: ${oldStatus} → ${newStatus} (event=${eventType})`);
      if (eventType) {
        let reactionHandledNotify = false;
        const reactionKey = eventToReactionKey(eventType);
        console.log(`[lifecycle] reactionKey=${reactionKey}`);

        if (reactionKey) {
          // Merge project-specific overrides with global defaults
          const project = config.projects[session.projectId];
          const globalReaction = config.reactions[reactionKey];
          const projectReaction = project?.reactions?.[reactionKey];
          const reactionConfig = projectReaction
            ? { ...globalReaction, ...projectReaction }
            : globalReaction;

          if (reactionConfig && reactionConfig.action) {
            // auto: false skips automated agent actions but still allows notifications
            if (reactionConfig.auto !== false || reactionConfig.action === "notify") {
              await executeReaction(
                session.id,
                session.projectId,
                reactionKey,
                reactionConfig as ReactionConfig,
              );
              // Reaction is handling this event — suppress immediate human notification.
              // "send-to-agent" retries + escalates on its own; "notify"/"auto-merge"
              // already call notifyHuman internally. Notifying here would bypass the
              // delayed escalation behaviour configured via retries/escalateAfter.
              reactionHandledNotify = true;
            }
          }
        }

        // For significant transitions not already notified by a reaction, notify humans
        if (!reactionHandledNotify) {
          const priority = inferPriority(eventType);
          console.log(`[lifecycle] ${session.id}: reactionHandledNotify=false, priority=${priority}`);
          if (priority !== "info") {
            const event = createEvent(eventType, {
              sessionId: session.id,
              projectId: session.projectId,
              message: buildTransitionMessage(session.id, oldStatus, newStatus, session),
              data: buildEventData(oldStatus, newStatus, session),
            });
            console.log(`[lifecycle] ${session.id}: calling notifyHuman for ${eventType}`);
            await notifyHuman(event, priority);
          } else {
            console.log(`[lifecycle] ${session.id}: skipped notifyHuman (priority=info)`);
          }
        } else {
          console.log(`[lifecycle] ${session.id}: skipped notifyHuman (reaction handled)`);
        }

        // Post simple "{PR URL} - {PR title}" message when a PR is created
        if (eventType === "pr.created") {
          console.log(`[lifecycle] ${session.id}: calling postPrCreated, pr=${session.pr?.url}`);
          await postPrCreated(session);
        }

        // NOTE: Visual verification is now handled by the agent via `ao verify`
        // before PR creation, not auto-triggered here. The runVisualVerification()
        // function is kept available for programmatic use (e.g. `ao start` orchestrator).
      }
    } else {
      // No transition — but check if the session is stuck in a state that
      // has a retryable reaction (e.g. merge_conflicts, ci_failed, mergeable).
      // This handles two scenarios:
      //   a) Lifecycle manager restart — session was already in this state
      //   b) Previous action didn't resolve the issue — retry on the next poll
      // The reaction tracker + escalateAfter prevents infinite retries.
      const eventType = statusToEventType(undefined, newStatus);
      const reactionKey = eventType ? eventToReactionKey(eventType) : null;

      if (reactionKey) {
        const project = config.projects[session.projectId];
        const globalReaction = config.reactions[reactionKey];
        const projectReaction = project?.reactions?.[reactionKey];
        const reactionConfig = projectReaction
          ? { ...globalReaction, ...projectReaction }
          : globalReaction;

        if (
          reactionConfig?.auto !== false &&
          (reactionConfig?.action === "send-to-agent" ||
            reactionConfig?.action === "send-comments-to-agent" ||
            reactionConfig?.action === "auto-merge")
        ) {
          // Check if this reaction was already escalated — don't keep retrying
          const trackerKey = `${session.id}:${reactionKey}`;
          const existingTracker = reactionTrackers.get(trackerKey);
          const rc = reactionConfig as ReactionConfig;
          const maxRetries = rc.retries ?? Infinity;
          let alreadyEscalated = existingTracker && existingTracker.attempts > maxRetries;
          if (!alreadyEscalated && existingTracker && typeof rc.escalateAfter === "string") {
            const durationMs = parseDuration(rc.escalateAfter);
            if (durationMs > 0 && Date.now() - existingTracker.firstTriggered.getTime() > durationMs) {
              alreadyEscalated = true;
            }
          }
          if (!alreadyEscalated && existingTracker && typeof rc.escalateAfter === "number") {
            alreadyEscalated = existingTracker.attempts > rc.escalateAfter;
          }

          if (!alreadyEscalated) {
            console.log(
              `[lifecycle] Session ${session.id} still in "${newStatus}" — retrying "${reactionKey}" reaction`,
            );
            const result = await executeReaction(
              session.id,
              session.projectId,
              reactionKey,
              reactionConfig as ReactionConfig,
            );
            if (result.escalated) {
              console.log(
                `[lifecycle] Session ${session.id} reaction "${reactionKey}" escalated — stopping retries`,
              );
            }
          }
        }
      }

      states.set(session.id, newStatus);
    }
  }

  /**
   * Clean up worktrees for merged sessions after the configured grace period.
   * Only destroys the worktree — metadata is preserved so sessions remain in the dashboard.
   */
  async function cleanupMergedWorktrees(sessions: Session[]): Promise<void> {
    const now = Date.now();

    for (const session of sessions) {
      if (session.status !== "merged") continue;

      const project = config.projects[session.projectId];
      if (!project) continue;

      // Check if worktree cleanup is enabled for this project
      const cleanupConfig = project.worktreeCleanup;
      if (!cleanupConfig?.enabled) continue;

      const sessionsDir = getSessionsDir(config.configPath, project.path);
      const raw = readMetadataRaw(sessionsDir, session.id);
      if (!raw) continue;

      // Skip if already cleaned
      if (raw["worktreeCleanedAt"]) continue;

      // Skip if no worktree path or worktree is the project path (no isolation)
      const worktreePath = raw["worktree"];
      if (!worktreePath || worktreePath === project.path) continue;

      // Check if grace period has elapsed
      // Backfill mergedAt for sessions merged before this feature was deployed
      let mergedAt = raw["mergedAt"];
      if (!mergedAt) {
        mergedAt = new Date().toISOString();
        updateMetadata(sessionsDir, session.id, { mergedAt });
        continue; // Start grace period from now — will be cleaned on a future poll
      }

      const mergedTime = new Date(mergedAt).getTime();
      if (Number.isNaN(mergedTime)) continue;

      const delay =
        typeof cleanupConfig.delayAfterMerge === "number"
          ? cleanupConfig.delayAfterMerge
          : parseDuration(cleanupConfig.delayAfterMerge);

      if (now - mergedTime < delay) continue;

      // Grace period elapsed — destroy the worktree
      const workspaceName = project.workspace ?? config.defaults.workspace;
      const workspacePlugin = registry.get<Workspace>("workspace", workspaceName);
      if (!workspacePlugin) continue;

      try {
        await workspacePlugin.destroy(worktreePath);
        updateMetadata(sessionsDir, session.id, {
          worktreeCleanedAt: new Date().toISOString(),
          worktree: "",
        });
        console.log(
          `[lifecycle] Cleaned up worktree for merged session ${session.id} (merged ${mergedAt})`,
        );
      } catch {
        // Non-fatal — will retry on next poll
        console.log(
          `[lifecycle] Failed to clean worktree for ${session.id}, will retry`,
        );
      }
    }
  }

  /** Run one polling cycle across all sessions. */
  async function pollAll(): Promise<void> {
    // Re-entrancy guard: skip if previous poll is still running
    if (polling) return;
    polling = true;

    // Reset per-project merge locks at the start of each poll cycle.
    // Within a single cycle, once a session acquires the lock (for merge or
    // rebase), no other session in the same project can acquire it. This
    // ensures only ONE branch update per project per cycle, preventing
    // cascading rebases where all behind PRs update simultaneously — only
    // to become behind again when the first one merges.
    projectMergeLocks.clear();

    try {
      const sessions = await sessionManager.list();

      // Include sessions that are active OR whose status changed from what we last saw
      // (e.g., list() detected a dead runtime and marked it "killed" — we need to
      // process that transition even though the new status is terminal)
      const sessionsToCheck = sessions.filter((s) => {
        if (s.status !== "merged" && s.status !== "killed") return true;
        const tracked = states.get(s.id);
        return tracked !== undefined && tracked !== s.status;
      });

      // Poll all sessions concurrently
      await Promise.allSettled(sessionsToCheck.map((s) => checkSession(s)));

      // Delayed worktree cleanup for merged sessions
      await cleanupMergedWorktrees(sessions);

      // Prune stale entries from states and reactionTrackers for sessions
      // that no longer appear in the session list (e.g., after kill/cleanup)
      const currentSessionIds = new Set(sessions.map((s) => s.id));
      for (const trackedId of states.keys()) {
        if (!currentSessionIds.has(trackedId)) {
          states.delete(trackedId);
        }
      }
      for (const trackerKey of reactionTrackers.keys()) {
        const sessionId = trackerKey.split(":")[0];
        if (sessionId && !currentSessionIds.has(sessionId)) {
          reactionTrackers.delete(trackerKey);
        }
      }

      // Check if all sessions are complete (trigger reaction only once)
      const activeSessions = sessions.filter((s) => s.status !== "merged" && s.status !== "killed");
      if (sessions.length > 0 && activeSessions.length === 0 && !allCompleteEmitted) {
        allCompleteEmitted = true;

        // Execute all-complete reaction if configured
        const reactionKey = eventToReactionKey("summary.all_complete");
        if (reactionKey) {
          const reactionConfig = config.reactions[reactionKey];
          if (reactionConfig && reactionConfig.action) {
            if (reactionConfig.auto !== false || reactionConfig.action === "notify") {
              await executeReaction("system", "all", reactionKey, reactionConfig as ReactionConfig);
            }
          }
        }
      }
    } catch {
      // Poll cycle failed — will retry next interval
    } finally {
      polling = false;
    }
  }

  return {
    start(intervalMs = 30_000): void {
      if (pollTimer) return; // Already running
      pollTimer = setInterval(() => void pollAll(), intervalMs);
      // Run immediately on start
      void pollAll();

      // Start queue poller if any project has it enabled
      const hasQueue = Object.values(config.projects).some(
        (p) => p.queuePoller?.enabled,
      );
      if (hasQueue) {
        queuePoller.start();
      }
    },

    stop(): void {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      queuePoller.stop();
    },

    getStates(): Map<SessionId, SessionStatus> {
      return new Map(states);
    },

    async check(sessionId: SessionId): Promise<void> {
      const session = await sessionManager.get(sessionId);
      if (!session) throw new Error(`Session ${sessionId} not found`);
      await checkSession(session);
    },
  };
}
