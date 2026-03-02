/**
 * Simple TTL cache with in-flight request deduplication.
 * Zero external dependencies — Map-based, closure-friendly.
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class TTLCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly evictTimer: ReturnType<typeof setInterval>;

  constructor(evictIntervalMs = 60_000) {
    this.evictTimer = setInterval(() => this.evictExpired(), evictIntervalMs);
    this.evictTimer.unref(); // Don't prevent process exit
  }

  /**
   * Return cached value if present and not expired, otherwise run `fetcher`,
   * cache the result, and return it. Concurrent calls with the same key
   * share a single in-flight promise (deduplication).
   */
  async getOrFetch<T>(
    key: string,
    fetcher: () => Promise<T>,
    ttlMs: number,
  ): Promise<T> {
    // 1. Check cache
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > Date.now()) {
      return entry.value as T;
    }

    // 2. Deduplicate concurrent fetches
    const pending = this.inflight.get(key);
    if (pending) {
      return pending as Promise<T>;
    }

    // 3. Fetch, cache on success, clean up on either outcome
    const promise = fetcher()
      .then((value) => {
        this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
        this.inflight.delete(key);
        return value;
      })
      .catch((err: unknown) => {
        // Don't cache errors — next call will retry
        this.inflight.delete(key);
        throw err;
      });

    this.inflight.set(key, promise);
    return promise;
  }

  /** Remove all expired entries. */
  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }

  /** Clear everything and stop the eviction timer. */
  clear(): void {
    clearInterval(this.evictTimer);
    this.entries.clear();
    this.inflight.clear();
  }
}
