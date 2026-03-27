"use client";

import { useState } from "react";
import type { DashboardSession, AttentionLevel } from "@/lib/types";
import { getSessionTitle } from "@/lib/format";
import { SessionCard } from "./SessionCard";
import { CIBadge } from "./CIBadge";

interface AttentionZoneProps {
  level: AttentionLevel;
  sessions: DashboardSession[];
  variant?: "column" | "grid";
  progressMap?: Record<string, string | null>;
  onSend?: (sessionId: string, message: string) => void;
  onKill?: (sessionId: string) => void;
  onMerge?: (prNumber: number) => void;
  onRestore?: (sessionId: string) => void;
}

const zoneConfig: Record<
  AttentionLevel,
  {
    label: string;
    color: string;
    defaultCollapsed: boolean;
  }
> = {
  merge: {
    label: "Merge",
    color: "var(--color-status-ready)",
    defaultCollapsed: false,
  },
  respond: {
    label: "Respond",
    color: "var(--color-status-error)",
    defaultCollapsed: false,
  },
  review: {
    label: "Review",
    color: "var(--color-accent-orange)",
    defaultCollapsed: false,
  },
  pending: {
    label: "Pending",
    color: "var(--color-status-attention)",
    defaultCollapsed: false,
  },
  working: {
    label: "Working",
    color: "var(--color-status-working)",
    defaultCollapsed: false,
  },
  done: {
    label: "Done",
    color: "var(--color-text-tertiary)",
    defaultCollapsed: true,
  },
};

export function AttentionZone({
  level,
  sessions,
  variant = "grid",
  progressMap,
  onSend,
  onKill,
  onMerge,
  onRestore,
}: AttentionZoneProps) {
  const config = zoneConfig[level];
  const [collapsed, setCollapsed] = useState(config.defaultCollapsed);

  if (sessions.length === 0) return null;

  if (variant === "column") {
    return (
      <div className="flex flex-col">
        {/* Column header */}
        <button
          className="mb-2.5 flex items-center gap-2 py-0.5 text-left"
          onClick={() => setCollapsed(!collapsed)}
        >
          <div
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: config.color }}
          />
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
            {config.label}
          </span>
          <span
            className="rounded-full px-1.5 py-0 text-[10px] font-medium tabular-nums text-[var(--color-text-muted)]"
            style={{ background: "var(--color-bg-subtle)" }}
          >
            {sessions.length}
          </span>
          <div className="flex-1" />
          <svg
            className="h-3 w-3 shrink-0 text-[var(--color-text-muted)] transition-transform duration-150"
            style={{ transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)" }}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <path d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {!collapsed && (
          <div className="flex flex-col gap-2">
            {sessions.map((session) => (
              <SessionCard
                key={session.id}
                session={session}
                progressText={progressMap?.[session.id] ?? session.progressText}
                onSend={onSend}
                onKill={onKill}
                onMerge={onMerge}
                onRestore={onRestore}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mb-7">
      {/* Zone header: [●] LABEL ──────────────────────────────── count [▾] */}
      <button
        className="mb-3 flex w-full items-center gap-2.5 py-0.5 text-left"
        onClick={() => setCollapsed(!collapsed)}
      >
        {/* Semantic dot — only zone-colored element */}
        <div
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: config.color }}
        />
        {/* Label — neutral, not zone-colored */}
        <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
          {config.label}
        </span>
        {/* Divider */}
        <div className="h-px flex-1 bg-[var(--color-border-subtle)]" />
        {/* Count — plain */}
        <span className="tabular-nums text-[11px] text-[var(--color-text-muted)]">
          {sessions.length}
        </span>
        {/* Collapse chevron */}
        <svg
          className="h-3 w-3 shrink-0 text-[var(--color-text-muted)] transition-transform duration-150"
          style={{ transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)" }}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <path d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {!collapsed && (
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {sessions.map((session) => (
            <SessionCard
              key={session.id}
              session={session}
              onSend={onSend}
              onKill={onKill}
              onMerge={onMerge}
              onRestore={onRestore}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ActionBar — compact notification strip for merge/respond/review/pending
// ---------------------------------------------------------------------------

const ACTION_LEVELS = ["merge", "respond", "review", "pending"] as const;

interface ActionBarProps {
  grouped: Record<AttentionLevel, DashboardSession[]>;
  progressMap?: Record<string, string | null>;
  onMerge?: (prNumber: number) => void;
  onRestore?: (sessionId: string) => void;
}

export function ActionBar({ grouped, onMerge, onRestore }: ActionBarProps) {
  return (
    <div className="mb-8 overflow-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-subtle)]">
      {ACTION_LEVELS.map((level) => {
        const sessions = grouped[level];
        if (sessions.length === 0) return null;
        const cfg = zoneConfig[level];
        return (
          <div key={level}>
            {sessions.map((s, i) => (
              <div
                key={s.id}
                className="border-l-4 px-5 py-4"
                style={{
                  borderLeftColor: cfg.color,
                  borderBottom: i < sessions.length - 1 ? "1px solid var(--color-border-subtle)" : undefined,
                }}
              >
                {/* Top row: dot + ID + title + action */}
                <div className="flex items-center gap-3">
                  <div
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: cfg.color }}
                  />
                  <span className="shrink-0 font-[var(--font-mono)] text-[13px] text-[var(--color-text-muted)]">
                    {s.id}
                  </span>
                  <a
                    href={`/sessions/${encodeURIComponent(s.id)}`}
                    className="min-w-0 flex-1 truncate text-[15px] font-medium text-[var(--color-text-primary)] hover:underline"
                  >
                    {getSessionTitle(s)}
                  </a>
                  {/* Inline action */}
                  {level === "merge" && s.pr?.mergeability.mergeable && s.pr.state === "open" && (
                    <button
                      onClick={() => { if (s.pr) onMerge?.(s.pr.number); }}
                      className="shrink-0 rounded-md bg-[var(--color-status-ready)] px-3.5 py-1.5 text-[13px] font-semibold text-[var(--color-text-inverse)] transition-[filter] hover:brightness-110"
                    >
                      Merge
                    </button>
                  )}
                  {level === "respond" && (
                    <button
                      onClick={() => onRestore?.(s.id)}
                      className="shrink-0 rounded-md border border-[rgba(88,166,255,0.35)] px-3 py-1.5 text-[13px] text-[var(--color-accent)] transition-colors hover:bg-[rgba(88,166,255,0.1)]"
                    >
                      restore
                    </button>
                  )}
                </div>
                {/* Bottom row: PR status details */}
                {s.pr && (
                  <div className="mt-2 flex flex-wrap items-center gap-3 pl-5 text-[13px]">
                    <a
                      href={s.pr.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-semibold text-[var(--color-accent)] hover:underline"
                    >
                      #{s.pr.number}
                    </a>
                    <span className="text-[var(--color-text-muted)]">
                      <span className="text-[var(--color-status-ready)]">+{s.pr.additions}</span>
                      {" "}
                      <span className="text-[var(--color-status-error)]">-{s.pr.deletions}</span>
                    </span>
                    <CIBadge status={s.pr.ciStatus} checks={s.pr.ciChecks} compact />
                    <span className={
                      s.pr.reviewDecision === "approved"
                        ? "text-[var(--color-status-ready)]"
                        : s.pr.reviewDecision === "changes_requested"
                          ? "text-[var(--color-accent-orange)]"
                          : "text-[var(--color-text-muted)]"
                    }>
                      {s.pr.reviewDecision === "approved" ? "approved" :
                       s.pr.reviewDecision === "changes_requested" ? "changes requested" :
                       s.pr.reviewDecision === "pending" ? "review pending" : "no review"}
                    </span>
                    {s.pr.unresolvedThreads > 0 && (
                      <span className="text-[var(--color-accent-orange)]">
                        {s.pr.unresolvedThreads} unresolved
                      </span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
