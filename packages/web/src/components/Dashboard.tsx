"use client";

import { useMemo, useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  type DashboardSession,
  type DashboardStats,
  type AttentionLevel,
  type AnalyticsData,
  getAttentionLevel,
  isPRRateLimited,
} from "@/lib/types";
import { AttentionZone, ActionBar } from "./AttentionZone";
import { SessionCard } from "./SessionCard";
import { DynamicFavicon } from "./DynamicFavicon";

interface DashboardProps {
  sessions: DashboardSession[];
  stats: DashboardStats;
  orchestratorId?: string | null;
  projectName?: string;
  version?: string;
}

interface SSESessionSnapshot {
  id: string;
  status: string;
  activity: string | null;
  attentionLevel: string;
  progressText?: string | null;
}

/**
 * Connect to the /api/events SSE stream.
 * When session count or any session's status/activity changes, trigger
 * router.refresh() to re-fetch server-rendered data with full enrichment.
 */
function useAutoRefresh(
  sessions: DashboardSession[],
  setProgressMap: (map: Record<string, string | null>) => void,
) {
  const router = useRouter();
  const lastSnapshotRef = useRef<string>("");

  // Build a fingerprint from current sessions so we can detect changes
  useEffect(() => {
    const fingerprint = sessions
      .map((s) => `${s.id}:${s.status}:${s.activity}`)
      .sort()
      .join("|");
    lastSnapshotRef.current = fingerprint;
  }, [sessions]);

  const handleSnapshot = useCallback(
    (sseSessions: SSESessionSnapshot[]) => {
      // Update progress text from SSE (lightweight, no full refresh)
      const newProgressMap: Record<string, string | null> = {};
      for (const s of sseSessions) {
        newProgressMap[s.id] = s.progressText ?? null;
      }
      setProgressMap(newProgressMap);

      const newFingerprint = sseSessions
        .map((s) => `${s.id}:${s.status}:${s.activity ?? ""}`)
        .sort()
        .join("|");

      if (newFingerprint !== lastSnapshotRef.current) {
        lastSnapshotRef.current = newFingerprint;
        router.refresh();
      }
    },
    [router, setProgressMap],
  );

  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      es = new EventSource("/api/events");

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as {
            type: string;
            sessions?: SSESessionSnapshot[];
          };
          if (data.type === "snapshot" && data.sessions) {
            handleSnapshot(data.sessions);
          }
        } catch {
          // Malformed SSE payload — ignore
        }
      };

      es.onerror = () => {
        es?.close();
        // Reconnect after 5 seconds
        reconnectTimer = setTimeout(connect, 5000);
      };
    }

    connect();

    return () => {
      es?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [handleSnapshot]);
}

export function Dashboard({ sessions, stats: _stats, orchestratorId, projectName, version }: DashboardProps) {
  const [progressMap, setProgressMap] = useState<Record<string, string | null>>({});
  useAutoRefresh(sessions, setProgressMap);
  const [rateLimitDismissed, setRateLimitDismissed] = useState(false);
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [analyticsOpen, setAnalyticsOpen] = useState(false);

  // Fetch analytics on first expand
  useEffect(() => {
    if (!analyticsOpen || analytics) return;
    fetch("/api/analytics")
      .then((r) => r.json())
      .then((data: AnalyticsData) => setAnalytics(data))
      .catch(() => {/* ignore */});
  }, [analyticsOpen, analytics]);
  const grouped = useMemo(() => {
    const zones: Record<AttentionLevel, DashboardSession[]> = {
      merge: [],
      respond: [],
      review: [],
      pending: [],
      working: [],
      done: [],
    };
    for (const session of sessions) {
      zones[getAttentionLevel(session)].push(session);
    }
    return zones;
  }, [sessions]);

  const handleSend = async (sessionId: string, message: string) => {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) {
      console.error(`Failed to send message to ${sessionId}:`, await res.text());
    }
  };

  const handleKill = async (sessionId: string) => {
    if (!confirm(`Kill session ${sessionId}?`)) return;
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/kill`, {
      method: "POST",
    });
    if (!res.ok) {
      console.error(`Failed to kill ${sessionId}:`, await res.text());
    }
  };

  const handleMerge = async (prNumber: number) => {
    const res = await fetch(`/api/prs/${prNumber}/merge`, { method: "POST" });
    if (!res.ok) {
      console.error(`Failed to merge PR #${prNumber}:`, await res.text());
    }
  };

  const handleRestore = async (sessionId: string) => {
    if (!confirm(`Restore session ${sessionId}?`)) return;
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/restore`, {
      method: "POST",
    });
    if (!res.ok) {
      console.error(`Failed to restore ${sessionId}:`, await res.text());
    }
  };

  const anyRateLimited = useMemo(
    () => sessions.some((s) => s.pr && isPRRateLimited(s.pr)),
    [sessions],
  );

  const hasActions = ["merge", "respond", "review", "pending"].some(
    (l) => grouped[l as AttentionLevel].length > 0,
  );

  return (
    <div className="px-8 py-7">
      <DynamicFavicon sessions={sessions} projectName={projectName} />
      {/* Header */}
      <div className="mb-8 flex items-center justify-between border-b border-[var(--color-border-subtle)] pb-6">
        <div className="flex items-center gap-6">
          <h1 className="text-[22px] font-bold tracking-[-0.02em] text-[var(--color-text-primary)]">
            Orchestrator
            {version && (
              <span className="ml-2 text-[11px] font-normal text-[var(--color-text-muted)]">
                v{version}
              </span>
            )}
          </h1>
          <StatusLine grouped={grouped} />
        </div>
        {orchestratorId && (
          <a
            href={`/sessions/${encodeURIComponent(orchestratorId)}`}
            className="orchestrator-btn flex items-center gap-2 rounded-[7px] px-4 py-2 text-[12px] font-semibold hover:no-underline"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)] opacity-80" />
            orchestrator
            <svg className="h-3 w-3 opacity-70" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
            </svg>
          </a>
        )}
      </div>

      {/* Rate limit notice */}
      {anyRateLimited && !rateLimitDismissed && (
        <div className="mb-6 flex items-center gap-2.5 rounded border border-[rgba(245,158,11,0.25)] bg-[rgba(245,158,11,0.05)] px-3.5 py-2.5 text-[11px] text-[var(--color-status-attention)]">
          <svg className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
          <span className="flex-1">
            GitHub API rate limited — PR data (CI status, review state, sizes) may be stale.
            {" "}Will retry automatically on next refresh.
          </span>
          <button
            onClick={() => setRateLimitDismissed(true)}
            className="ml-1 shrink-0 opacity-60 hover:opacity-100"
            aria-label="Dismiss"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Action bar: merge + respond + review + pending as compact strip */}
      {hasActions && (
        <ActionBar
          grouped={grouped}
          progressMap={progressMap}
          onMerge={handleMerge}
          onRestore={handleRestore}
        />
      )}

      {/* Hero area: working agents with large cards */}
      {grouped.working.length > 0 && (
        <div className="mb-8">
          <div className="mb-4 flex items-center gap-2.5">
            <div className="h-2 w-2 shrink-0 rounded-full bg-[var(--color-status-working)]" />
            <span className="text-[13px] font-semibold uppercase tracking-[0.10em] text-[var(--color-text-secondary)]">
              Working
            </span>
            <span className="text-[13px] tabular-nums text-[var(--color-text-muted)]">
              {grouped.working.length}
            </span>
          </div>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {grouped.working.map((session) => (
              <SessionCard
                key={session.id}
                session={session}
                variant="hero"
                progressText={progressMap[session.id] ?? session.progressText}
                onSend={handleSend}
                onKill={handleKill}
              />
            ))}
          </div>
        </div>
      )}

      {/* Empty state when nothing is active */}
      {grouped.working.length === 0 && !hasActions && grouped.done.length === 0 && (
        <div className="flex items-center justify-center py-20 text-[13px] text-[var(--color-text-muted)]">
          No active sessions
        </div>
      )}

      {/* Done — collapsed by default */}
      {grouped.done.length > 0 && (
        <AttentionZone
          level="done"
          sessions={grouped.done}
          variant="grid"
          progressMap={progressMap}
          onSend={handleSend}
          onKill={handleKill}
          onMerge={handleMerge}
          onRestore={handleRestore}
        />
      )}

      {/* Analytics — collapsible */}
      <div className="mt-6 border-t border-[var(--color-border-subtle)] pt-4">
        <button
          onClick={() => setAnalyticsOpen(!analyticsOpen)}
          className="flex items-center gap-2 text-[13px] font-semibold uppercase tracking-[0.10em] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
        >
          <svg
            className={`h-3 w-3 transition-transform ${analyticsOpen ? "rotate-90" : ""}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <path d="M9 5l7 7-7 7" />
          </svg>
          Analytics
        </button>
        {analyticsOpen && analytics && <AnalyticsSummary data={analytics} />}
        {analyticsOpen && !analytics && (
          <div className="mt-3 text-[13px] text-[var(--color-text-muted)]">Loading…</div>
        )}
      </div>
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  const hours = Math.floor(ms / 3_600_000);
  const mins = Math.round((ms % 3_600_000) / 60_000);
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function AnalyticsSummary({ data }: { data: AnalyticsData }) {
  return (
    <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
      {/* Effectiveness */}
      <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-4">
        <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
          Completion Rate
        </div>
        <div className="mt-1 text-[24px] font-bold text-[var(--color-text-primary)]">
          {(data.completionRate * 100).toFixed(0)}%
        </div>
        <div className="mt-1 text-[12px] text-[var(--color-text-secondary)]">
          {data.completedSessions} merged · {data.killedSessions} killed · {data.totalSessions} total
        </div>
      </div>

      {/* Speed */}
      <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-4">
        <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
          Avg Cycle Time
        </div>
        <div className="mt-1 text-[24px] font-bold text-[var(--color-text-primary)]">
          {data.avgEndToEnd ? formatDuration(data.avgEndToEnd) : "—"}
        </div>
        <div className="mt-1 text-[12px] text-[var(--color-text-secondary)]">
          spawn → merge
        </div>
      </div>

      {/* Cost */}
      <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-4">
        <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
          Total Cost
        </div>
        <div className="mt-1 text-[24px] font-bold text-[var(--color-text-primary)]">
          ${data.totalCostUsd.toFixed(2)}
        </div>
        <div className="mt-1 text-[12px] text-[var(--color-text-secondary)]">
          {data.avgCostPerMergedPR !== null ? `$${data.avgCostPerMergedPR.toFixed(2)}/merged PR` : "—"}
          {" · "}
          {formatTokens(data.totalInputTokens)} in · {formatTokens(data.totalOutputTokens)} out
        </div>
      </div>

      {/* Cache & Intervention */}
      <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-4">
        <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
          Efficiency
        </div>
        <div className="mt-1 text-[24px] font-bold text-[var(--color-text-primary)]">
          {(data.cacheHitRatio * 100).toFixed(0)}% cache
        </div>
        <div className="mt-1 text-[12px] text-[var(--color-text-secondary)]">
          {data.totalRestores} restores · {data.sessionsNeedingInput} needed input
        </div>
      </div>
    </div>
  );
}

function StatusLine({ grouped }: { grouped: Record<AttentionLevel, DashboardSession[]> }) {
  const parts: string[] = [];
  if (grouped.working.length > 0) parts.push(`${grouped.working.length} working`);
  if (grouped.merge.length > 0) parts.push(`${grouped.merge.length} ready to merge`);
  if (grouped.respond.length > 0) parts.push(`${grouped.respond.length} need response`);
  if (grouped.review.length > 0) parts.push(`${grouped.review.length} need review`);
  if (grouped.pending.length > 0) parts.push(`${grouped.pending.length} pending`);
  if (grouped.done.length > 0) parts.push(`${grouped.done.length} done`);

  if (parts.length === 0) {
    return <span className="text-[13px] text-[var(--color-text-muted)]">no sessions</span>;
  }

  return (
    <span className="text-[15px] text-[var(--color-text-secondary)]">
      {parts.join(" · ")}
    </span>
  );
}
