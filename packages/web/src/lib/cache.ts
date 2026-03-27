/**
 * Simple in-memory TTL cache for SCM API data.
 *
 * Reduces GitHub API rate limit exhaustion by caching PR enrichment data.
 * Default TTL: 60 seconds (data is fresh enough for dashboard refresh).
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 5 * 60_000; // 5 minutes

/**
 * Simple TTL cache backed by a Map.
 * Automatically evicts stale entries on get() and periodically cleans up.
 */
export class TTLCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private readonly ttlMs: number;
  private cleanupInterval?: ReturnType<typeof setInterval>;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
    // Run cleanup every TTL period to prevent memory leaks from unread keys
    this.cleanupInterval = setInterval(() => this.evictExpired(), ttlMs);
    // Ensure cleanup interval doesn't prevent Node process from exiting
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  /** Get a cached value if it exists and isn't stale */
  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return entry.value;
  }

  /** Set a cache entry with TTL (optional override) */
  set(key: string, value: T, ttlMs?: number): void {
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.ttlMs),
    });
  }

  /** Evict all expired entries */
  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }

  /** Clear all entries and stop cleanup interval */
  clear(): void {
    this.cache.clear();
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
  }

  /** Get cache size (includes stale entries) */
  size(): number {
    return this.cache.size;
  }
}

/**
 * Enrichment data for a single PR.
 * Cached by PR number (key: `owner/repo#123`).
 */
export interface PREnrichmentData {
  state: "open" | "merged" | "closed";
  title: string;
  additions: number;
  deletions: number;
  ciStatus: "none" | "pending" | "passing" | "failing";
  ciChecks: Array<{ name: string; status: "pending" | "running" | "passed" | "failed" | "skipped"; url?: string }>;
  reviewDecision: "none" | "pending" | "approved" | "changes_requested";
  mergeability: {
    mergeable: boolean;
    ciPassing: boolean;
    approved: boolean;
    noConflicts: boolean;
    blockers: string[];
  };
  unresolvedThreads: number;
  unresolvedComments: Array<{
    url: string;
    path: string;
    author: string;
    body: string;
  }>;
}

/** Global PR enrichment cache (5 min TTL) */
export const prCache = new TTLCache<PREnrichmentData>();

/** Generate cache key for a PR: `owner/repo#123` */
export function prCacheKey(owner: string, repo: string, number: number): string {
  return `${owner}/${repo}#${number}`;
}

// ---------------------------------------------------------------------------
// Disk-backed PR cache — persists last-known-good data across restarts
// and rate-limit windows. Fresh API data always overwrites.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PR_CACHE_DIR = join(homedir(), ".agent-orchestrator", ".pr-cache");

function prDiskPath(key: string): string {
  // key is "owner/repo#123" — sanitize for filesystem
  const safe = key.replace(/[/\\#]/g, "_");
  return join(PR_CACHE_DIR, `${safe}.json`);
}

/** Save PR enrichment data to disk (fire-and-forget, never throws). */
export function savePRToDisk(key: string, data: PREnrichmentData): void {
  try {
    mkdirSync(PR_CACHE_DIR, { recursive: true });
    writeFileSync(prDiskPath(key), JSON.stringify(data), "utf-8");
  } catch {
    // Non-fatal — disk cache is best-effort
  }
}

/** Load PR enrichment data from disk. Returns null if not found or corrupted. */
export function loadPRFromDisk(key: string): PREnrichmentData | null {
  try {
    const raw = readFileSync(prDiskPath(key), "utf-8");
    return JSON.parse(raw) as PREnrichmentData;
  } catch {
    return null;
  }
}
