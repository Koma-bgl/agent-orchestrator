import type { Agent } from "@composio/ao-core";
import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import {
  sessionToDashboard,
  resolveProject,
  enrichSessionAgentSummary,
} from "@/lib/serialize";
import type { AnalyticsData, SessionMetric } from "@/lib/types";

/**
 * GET /api/analytics — Compute aggregate metrics from all sessions.
 *
 * Scans session metadata + agent JSONL files to produce effectiveness,
 * speed, cost, and human-intervention metrics. No database — computed
 * on the fly from flat files.
 */
export async function GET() {
  try {
    const { config, registry, sessionManager } = await getServices();
    const coreSessions = await sessionManager.list();

    // Filter out orchestrator sessions
    const workerSessions = coreSessions.filter((s) => !s.id.endsWith("-orchestrator"));

    // Enrich with cost data from agent JSONL files (parallel, capped at 5s)
    const dashboardSessions = workerSessions.map(sessionToDashboard);
    const costPromises = workerSessions.map((core, i) => {
      const project = resolveProject(core, config.projects);
      const agentName = project?.agent ?? config.defaults.agent;
      if (!agentName) return Promise.resolve();
      const agent = registry.get<Agent>("agent", agentName);
      if (!agent) return Promise.resolve();
      return enrichSessionAgentSummary(dashboardSessions[i], core, agent);
    });
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5_000));
    await Promise.race([Promise.allSettled(costPromises), timeout]);

    // Compute per-session metrics
    const sessionMetrics: SessionMetric[] = dashboardSessions.map((ds) => {
      const mergedAt = ds.metadata["mergedAt"] ?? null;
      const createdAt = ds.createdAt;
      const cycleTimeMs =
        mergedAt && createdAt
          ? new Date(mergedAt).getTime() - new Date(createdAt).getTime()
          : null;

      // Working time: spawn → agent exit (or merge if no exit recorded)
      const agentExitedAt = ds.metadata["agentExitedAt"] ?? null;
      const endTime = agentExitedAt ?? mergedAt;
      const workingTimeMs =
        endTime && createdAt
          ? (typeof endTime === "string" && /^\d+$/.test(endTime)
              ? parseInt(endTime, 10)
              : new Date(endTime).getTime()) - new Date(createdAt).getTime()
          : null;

      return {
        id: ds.id,
        status: ds.status,
        issueId: ds.issueId,
        summary: ds.summary,
        createdAt: ds.createdAt,
        mergedAt,
        cycleTimeMs,
        workingTimeMs: workingTimeMs && workingTimeMs > 0 ? workingTimeMs : null,
        costUsd: ds.cost?.estimatedCostUsd ?? null,
        inputTokens: ds.cost
          ? ds.cost.inputTokens + ds.cost.cacheReadTokens + ds.cost.cacheCreationTokens
          : 0,
        outputTokens: ds.cost?.outputTokens ?? 0,
      };
    });

    // Aggregate metrics
    const merged = sessionMetrics.filter((s) => s.status === "merged");
    const killed = sessionMetrics.filter((s) => s.status === "killed");
    const total = sessionMetrics.length;

    // Effectiveness
    const completedSessions = merged.length;
    const killedSessions = killed.length;
    const decidedSessions = completedSessions + killedSessions;
    const completionRate = decidedSessions > 0 ? completedSessions / decidedSessions : 0;

    // Speed — only from sessions that completed the full cycle
    const cycleTimes = merged
      .map((s) => s.cycleTimeMs)
      .filter((t): t is number => t !== null && t > 0);
    const avgEndToEnd =
      cycleTimes.length > 0
        ? cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length
        : null;

    // Working time — across all decided sessions (merged + killed)
    const workingTimes = sessionMetrics
      .map((s) => s.workingTimeMs)
      .filter((t): t is number => t !== null && t > 0);
    const avgWorkingTime =
      workingTimes.length > 0
        ? workingTimes.reduce((a, b) => a + b, 0) / workingTimes.length
        : null;

    // Cost
    const allCosts = sessionMetrics.map((s) => s.costUsd).filter((c): c is number => c !== null);
    const totalCostUsd = allCosts.reduce((a, b) => a + b, 0);
    const avgCostPerTask =
      allCosts.length > 0 ? totalCostUsd / allCosts.length : null;
    const mergedCosts = merged.map((s) => s.costUsd).filter((c): c is number => c !== null);
    const killedCosts = killed.map((s) => s.costUsd).filter((c): c is number => c !== null);
    const avgCostPerMergedPR =
      mergedCosts.length > 0
        ? mergedCosts.reduce((a, b) => a + b, 0) / mergedCosts.length
        : null;
    const avgCostPerKilledSession =
      killedCosts.length > 0
        ? killedCosts.reduce((a, b) => a + b, 0) / killedCosts.length
        : null;

    const totalInputTokens = sessionMetrics.reduce((a, s) => a + s.inputTokens, 0);
    const totalOutputTokens = sessionMetrics.reduce((a, s) => a + s.outputTokens, 0);

    // Cache hit ratio from raw cost data
    const totalCacheRead = dashboardSessions.reduce(
      (a, s) => a + (s.cost?.cacheReadTokens ?? 0),
      0,
    );
    const totalAllInput = dashboardSessions.reduce(
      (a, s) =>
        a +
        (s.cost
          ? s.cost.inputTokens + s.cost.cacheReadTokens + s.cost.cacheCreationTokens
          : 0),
      0,
    );
    const cacheHitRatio = totalAllInput > 0 ? totalCacheRead / totalAllInput : 0;

    // Trends: compare recent half vs older half (sorted by createdAt)
    // Positive = metric is going up, negative = going down
    const sorted = [...sessionMetrics].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    const mid = Math.floor(sorted.length / 2);
    const olderHalf = sorted.slice(0, mid);
    const recentHalf = sorted.slice(mid);

    function avgOf(arr: SessionMetric[], fn: (s: SessionMetric) => number | null): number | null {
      const vals = arr.map(fn).filter((v): v is number => v !== null && v > 0);
      return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    }

    function trendDelta(older: number | null, recent: number | null): number | null {
      if (older === null || recent === null || older === 0) return null;
      return (recent - older) / older; // e.g. 0.15 = 15% increase
    }

    const olderCompletion = olderHalf.length > 0
      ? olderHalf.filter((s) => s.status === "merged").length /
        Math.max(olderHalf.filter((s) => s.status === "merged" || s.status === "killed").length, 1)
      : null;
    const recentCompletion = recentHalf.length > 0
      ? recentHalf.filter((s) => s.status === "merged").length /
        Math.max(recentHalf.filter((s) => s.status === "merged" || s.status === "killed").length, 1)
      : null;

    const trends = {
      completionRate: trendDelta(olderCompletion, recentCompletion),
      avgWorkingTime: trendDelta(
        avgOf(olderHalf, (s) => s.workingTimeMs),
        avgOf(recentHalf, (s) => s.workingTimeMs),
      ),
      avgCostPerTask: trendDelta(
        avgOf(olderHalf, (s) => s.costUsd),
        avgOf(recentHalf, (s) => s.costUsd),
      ),
    };

    // Human intervention
    const sessionsNeedingInput = sessionMetrics.filter(
      (s) => s.status === "needs_input" || s.status === "stuck",
    ).length;
    const escalationRate = total > 0 ? sessionsNeedingInput / total : 0;
    const totalRestores = workerSessions.filter((s) => s.restoredAt).length;

    const analytics: AnalyticsData = {
      totalSessions: total,
      completedSessions,
      killedSessions,
      completionRate,
      avgSpawnToPR: null, // TODO: requires event log timestamps
      avgPRToMerge: null, // TODO: requires PR creation timestamp
      avgEndToEnd,
      avgWorkingTime,
      totalCostUsd,
      avgCostPerTask,
      avgCostPerMergedPR,
      avgCostPerKilledSession,
      totalInputTokens,
      totalOutputTokens,
      cacheHitRatio,
      trends,
      sessionsNeedingInput,
      escalationRate,
      totalRestores,
      sessions: sessionMetrics,
    };

    return NextResponse.json(analytics);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to compute analytics" },
      { status: 500 },
    );
  }
}
