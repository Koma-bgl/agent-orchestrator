import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TTLCache } from "../src/cache.js";

describe("TTLCache", () => {
  let cache: TTLCache;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new TTLCache();
  });

  afterEach(() => {
    cache.clear();
    vi.useRealTimers();
  });

  it("returns fetched value on cache miss", async () => {
    const fetcher = vi.fn().mockResolvedValue("hello");
    const result = await cache.getOrFetch("key", fetcher, 1000);

    expect(result).toBe("hello");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("returns cached value on cache hit (no re-fetch)", async () => {
    const fetcher = vi.fn().mockResolvedValue("hello");

    await cache.getOrFetch("key", fetcher, 5000);
    const result = await cache.getOrFetch("key", fetcher, 5000);

    expect(result).toBe("hello");
    expect(fetcher).toHaveBeenCalledTimes(1); // Only called once
  });

  it("re-fetches after TTL expires", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce("first")
      .mockResolvedValueOnce("second");

    const r1 = await cache.getOrFetch("key", fetcher, 1000);
    expect(r1).toBe("first");

    // Advance past TTL
    vi.advanceTimersByTime(1001);

    const r2 = await cache.getOrFetch("key", fetcher, 1000);
    expect(r2).toBe("second");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent in-flight requests", async () => {
    let resolvePromise: (v: string) => void;
    const fetcher = vi.fn().mockReturnValue(
      new Promise<string>((resolve) => {
        resolvePromise = resolve;
      }),
    );

    // Start two concurrent fetches for the same key
    const p1 = cache.getOrFetch("key", fetcher, 5000);
    const p2 = cache.getOrFetch("key", fetcher, 5000);

    // Resolve the single in-flight request
    resolvePromise!("shared");

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe("shared");
    expect(r2).toBe("shared");
    expect(fetcher).toHaveBeenCalledTimes(1); // Only one fetch
  });

  it("does NOT cache errors — next call retries", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("network fail"))
      .mockResolvedValueOnce("recovered");

    await expect(cache.getOrFetch("key", fetcher, 5000)).rejects.toThrow(
      "network fail",
    );

    const result = await cache.getOrFetch("key", fetcher, 5000);
    expect(result).toBe("recovered");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("uses separate entries for different keys", async () => {
    const fetcherA = vi.fn().mockResolvedValue("A");
    const fetcherB = vi.fn().mockResolvedValue("B");

    const a = await cache.getOrFetch("key-a", fetcherA, 5000);
    const b = await cache.getOrFetch("key-b", fetcherB, 5000);

    expect(a).toBe("A");
    expect(b).toBe("B");
    expect(fetcherA).toHaveBeenCalledTimes(1);
    expect(fetcherB).toHaveBeenCalledTimes(1);
  });

  it("clear() removes all entries and stops eviction timer", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce("before")
      .mockResolvedValueOnce("after");

    await cache.getOrFetch("key", fetcher, 60_000);
    cache.clear();

    // After clear, next call should fetch fresh
    const result = await cache.getOrFetch("key", fetcher, 60_000);
    expect(result).toBe("after");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
