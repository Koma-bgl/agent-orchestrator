/**
 * VerifyWorktreeManager
 *
 * Manages the single shared verify worktree used by the MCP-driven visual
 * verification flow. Callers `acquire()` an exclusive handle for a project +
 * branch; the manager serializes concurrent acquires with an in-process
 * mutex so only one verification run touches the worktree at a time.
 *
 * The acquire pipeline, in order:
 *   1. Ensure the git worktree exists (create if missing)
 *   2. Fetch origin and checkout the requested branch
 *   3. Lockfile-gated `pnpm install` (only when lockfile hash changed)
 *   4. Spawn the dev server and wait for the ready probe to respond
 *
 * `release()` stops the dev server cleanly (SIGTERM → 5s grace → SIGKILL) and
 * advances the mutex. It is crash-tolerant: if the dev server has already
 * exited on its own, release() logs and returns without throwing.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { McpVerifyConfig } from "./types.js";

/**
 * Run an external command via execFile with a timeout and return its stdout.
 * Uses the callback form directly (matches the tmux.ts pattern in this package)
 * so unit tests can mock `execFile` via the standard `(err, stdout, stderr)`
 * callback signature without tripping on `util.promisify`'s custom symbol.
 *
 * Rejection messages include the command + args (for triage) and flag
 * timeout failures explicitly (execFile signals timeout via SIGTERM kill).
 *
 * The optional `opts.cwd` is forwarded to execFile — required for commands
 * that must run inside the verify worktree (e.g. `pnpm install`) rather
 * than inheriting the orchestrator's cwd.
 */
function run(
  cmd: string,
  args: string[],
  timeoutMs: number,
  opts?: { cwd?: string },
): Promise<string> {
  return new Promise((resolveRun, rejectRun) => {
    execFile(cmd, args, { timeout: timeoutMs, cwd: opts?.cwd }, (error, stdout, stderr) => {
      if (error) {
        const ctx = `${cmd} ${args.join(" ")}`;
        const nodeErr = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
        const wasTimeout = nodeErr.killed === true && nodeErr.signal === "SIGTERM";
        const suffix = wasTimeout ? ` (timed out after ${timeoutMs}ms)` : "";
        const msg = (stderr || error.message).trim();
        rejectRun(new Error(`${ctx} failed${suffix}: ${msg}`));
        return;
      }
      resolveRun(stdout);
    });
  });
}

/**
 * Module-level cache of the last successfully-installed lockfile hash per
 * projectId. Used to gate `pnpm install` so it only runs when the lockfile
 * actually changed since the last acquire for that project.
 *
 * This cache is intentionally in-process only; it's reset on orchestrator
 * restart, at which point the next acquire will run `pnpm install` once to
 * reseed the cache. That is the correct behavior — we cannot safely assume
 * the worktree's node_modules match the lockfile across restarts.
 */
const installedHashCache = new Map<string, string>();

/**
 * Test-only hook to clear the module-level install-hash cache between tests.
 * The leading `__` signals "not part of the public API" — production code
 * must not call this.
 */
export function __clearInstalledHashCacheForTests(): void {
  installedHashCache.clear();
}

/**
 * Compute the sha256 hash of `pnpm-lock.yaml` inside the worktree. Returns
 * an empty string if the file is missing (ENOENT) — callers treat that as "force
 * install" since we can't prove node_modules is in sync with a lockfile
 * that doesn't exist. Throws for other errors (e.g. EACCES permission denied).
 */
function computeLockfileHash(worktreePath: string): string {
  try {
    const lockPath = resolve(worktreePath, "pnpm-lock.yaml");
    return createHash("sha256").update(readFileSync(lockPath)).digest("hex");
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") {
      return "";
    }
    throw new Error(
      `Failed to read pnpm-lock.yaml at ${resolve(worktreePath, "pnpm-lock.yaml")}: ${nodeErr.message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Dev server lifecycle
// ---------------------------------------------------------------------------

/**
 * Polling interval for the ready probe, in ms. Fixed rather than configurable
 * because the useful range is narrow — sub-100ms hammers a booting server,
 * multi-second misses fast-boot dev servers.
 */
const READY_PROBE_POLL_MS = 500;

/**
 * Per-request AbortController timeout for ready-probe fetches, in ms. Without
 * this, a hanging server that accepts the TCP connection but never responds
 * would stall the probe loop entirely — we'd never notice the overall timeout.
 */
const READY_PROBE_PER_REQUEST_TIMEOUT_MS = 2_000;

/**
 * Grace period after SIGTERM before escalating to SIGKILL in stopDevServer.
 * Matches the convention used by runtime-process for destroy().
 */
const SIGTERM_GRACE_MS = 5_000;

interface DevServerHandle {
  child: ChildProcess;
  /** Resolves when the child emits "exit" (or already resolved if it has exited). */
  exited: Promise<void>;
}

/**
 * Spawn the configured dev server in `worktreePath`, then poll
 * `config.readyProbe.url` until the server responds 2xx or the configured
 * timeout elapses.
 *
 * Returns `[handle, null]` on success. Returns `[handle, error]` if the
 * probe times out or the server exits early — in both error cases the handle
 * is still returned so the caller can pass it to `stopDevServer()` for
 * cleanup (a no-op if the child is already dead).
 *
 * `shell: true` is a deliberate deviation from the project convention of
 * `execFile`. `startCommand` is operator-configured YAML (e.g.
 * `"PORT=3100 pnpm dev"`) and needs shell interpretation for env-prefix and
 * quoting. It is NEVER derived from agent/user input, so the shell-injection
 * threat model does not apply.
 */
async function startAndProbeDevServer(
  worktreePath: string,
  config: McpVerifyConfig,
): Promise<[DevServerHandle, Error | null]> {
  const child = spawn(config.startCommand, {
    cwd: worktreePath,
    shell: true,
    // "ignore" for stdin (we never write to the dev server). "pipe" for
    // stdout/stderr so (a) the pipes stay open (preventing the child from
    // blocking on a full buffer) and (b) future iterations can tail logs.
    // We deliberately avoid "inherit" — that would merge the dev server's
    // output into the orchestrator's own stdout, which is noisy and makes
    // it impossible to cleanly stop the server later.
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Track the exit so both the early-exit race and stopDevServer() can await
  // it without re-registering listeners. Using `once()` avoids a leaked
  // listener if the child outlives the probe loop.
  let exitedResolve!: () => void;
  const exited = new Promise<void>((r) => {
    exitedResolve = r;
  });
  child.once("exit", () => {
    exitedResolve();
  });

  const handle: DevServerHandle = { child, exited };

  const timeoutMs = config.readyProbe.timeoutSec * 1000;
  const url = config.readyProbe.url;
  const deadline = Date.now() + timeoutMs;

  // Race loop: each iteration either (a) observes ready, (b) observes
  // early-exit, (c) hits the overall timeout, or (d) sleeps and retries.
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return [
        handle,
        new Error(
          `dev server exited during ready probe (exitCode=${child.exitCode}, signal=${child.signalCode ?? "none"})`,
        ),
      ];
    }

    // Per-request abort prevents a hanging server from stalling the loop.
    const reqController = new AbortController();
    const reqTimer = setTimeout(
      () => reqController.abort(),
      READY_PROBE_PER_REQUEST_TIMEOUT_MS,
    );
    try {
      const res = await fetch(url, { signal: reqController.signal });
      if (res.ok) {
        return [handle, null];
      }
    } catch {
      // Expected while the server boots: ECONNREFUSED, DNS errors, aborted
      // requests, etc. Swallow and retry after the poll interval.
    } finally {
      clearTimeout(reqTimer);
    }

    await new Promise<void>((r) => setTimeout(r, READY_PROBE_POLL_MS));
  }

  return [
    handle,
    new Error(
      `dev server did not become ready within ${config.readyProbe.timeoutSec}s (probe url=${url})`,
    ),
  ];
}

/**
 * Stop a dev server started by `startAndProbeDevServer`. Crash-tolerant:
 *   - If the child has already exited (exitCode or signalCode non-null),
 *     log and return without throwing.
 *   - Otherwise send SIGTERM, wait up to SIGTERM_GRACE_MS for exit, then
 *     escalate to SIGKILL if still alive.
 */
async function stopDevServer(handle: DevServerHandle): Promise<void> {
  const { child, exited } = handle;

  if (child.exitCode !== null || child.signalCode !== null) {
    console.log(
      `[verify-worktree] dev server already exited (exitCode=${child.exitCode}, signal=${child.signalCode ?? "none"}); skipping stop`,
    );
    return;
  }

  child.kill("SIGTERM");

  // Wait up to SIGTERM_GRACE_MS for the child to exit cleanly, then SIGKILL.
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise<boolean>((r) => setTimeout(() => r(true), SIGTERM_GRACE_MS)),
  ]);

  if (timedOut && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    // Wait for the kernel to reap the process so callers know the handle is
    // truly gone. If this hangs for some reason, the caller's own timeout
    // is the only backstop — by design, we don't add a second layer here.
    await exited;
  }
}

export interface VerifyWorktreeHandle {
  /** Absolute path to the verify worktree on disk */
  path: string;
  /** Base URL of the verify dev server (from config) */
  baseUrl: string;
  /** Release the acquire lock so the next waiter can proceed */
  release(): Promise<void>;
}

export interface VerifyWorktreeManager {
  /**
   * Acquire exclusive access to the shared verify worktree for `projectId`,
   * checked out to `branch`. Acquires are serialized by an in-process mutex:
   * the returned promise does not resolve until any prior acquire's handle
   * has been released.
   *
   * **Contract:** the caller MUST invoke `handle.release()` (ideally in a
   * `try { ... } finally { handle.release(); }` block). A missed `release`
   * blocks every subsequent `acquire()` on this manager for the lifetime
   * of the process — there is no timeout, no watchdog, and no way to
   * recover short of recreating the manager.
   *
   * If the acquire body itself throws (e.g. network failure during fetch,
   * bad branch during checkout, dev server crash), the mutex is automatically
   * advanced and the error is re-thrown — callers do not need to release in
   * that case.
   */
  acquire(projectId: string, branch: string): Promise<VerifyWorktreeHandle>;
}

interface Deps {
  /** Absolute path to the main project repo (source of the worktree) */
  projectPath: string;
  config: McpVerifyConfig;
}

/**
 * Expand a leading `~/` to the user's home directory.
 *
 * Rejects ambiguous forms explicitly:
 *   - `"~"` alone (would resolve to a literal filename "~")
 *   - `"~user/foo"` (we do not resolve other users' home directories)
 *
 * Both are silent footguns if we silently resolve() them.
 */
function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    return resolve(homedir(), p.slice(2));
  }
  if (p === "~" || p.startsWith("~")) {
    throw new Error(
      `verifyWorktreeDir=${JSON.stringify(p)} is ambiguous; use "~/<subdir>" or an absolute path`,
    );
  }
  return resolve(p);
}

export function createVerifyWorktreeManager(deps: Deps): VerifyWorktreeManager {
  // In-process mutex. Each acquire() chains a promise that resolves when
  // the returned handle's release() is called.
  let lock: Promise<void> = Promise.resolve();

  return {
    async acquire(projectId, branch) {
      let release!: () => void;
      const ours = new Promise<void>((r) => {
        release = r;
      });
      const prev = lock;
      lock = lock.then(() => ours);
      await prev;

      // Track the dev server handle separately so we can kill it if any step
      // between "spawn" and "return" throws. Without this, a failed ready
      // probe would leave an orphaned server process behind.
      let devServer: DevServerHandle | undefined;

      try {
        const wtRoot = expandHome(deps.config.verifyWorktreeDir);
        const path = resolve(wtRoot, projectId);

        // Check existence explicitly — don't swallow legitimate fetch errors below.
        const worktreeList = await run(
          "git",
          ["-C", deps.projectPath, "worktree", "list", "--porcelain"],
          10_000,
        );
        const worktreeExists = worktreeList
          .split("\n")
          .some((line) => line === `worktree ${path}`);

        if (!worktreeExists) {
          await run("git", ["-C", deps.projectPath, "worktree", "add", path, branch], 60_000);
        }

        // Fetch + checkout — errors here are real and should propagate.
        await run("git", ["-C", path, "fetch", "origin"], 60_000);
        await run("git", ["-C", path, "checkout", branch], 30_000);

        // Lockfile-gated install: run `pnpm install` only when the lockfile
        // hash differs from what we last installed for this project. A missing
        // lockfile (hash === "") forces install — we don't cache "" so a
        // subsequent acquire that still lacks a lockfile will re-install,
        // which is the conservative choice.
        const currentHash = computeLockfileHash(path);
        const cachedHash = installedHashCache.get(projectId);
        if (currentHash === "" || cachedHash !== currentHash) {
          const reason =
            currentHash === ""
              ? "no-lockfile"
              : cachedHash === undefined
                ? "first-acquire"
                : "hash-changed";
          const hashDisplay = currentHash.slice(0, 8) || "none";
          console.log(
            `[verify-worktree] ${projectId}: pnpm install (${reason}, hash=${hashDisplay})`,
          );
          await run("pnpm", ["install"], 300_000, { cwd: path });
          console.log(`[verify-worktree] ${projectId}: pnpm install complete`);
          if (currentHash !== "") {
            installedHashCache.set(projectId, currentHash);
          }
        }

        // Spawn dev server + probe. On failure we still hold a handle so we
        // can attempt to kill the child before re-throwing.
        const [handle, readyErr] = await startAndProbeDevServer(path, deps.config);
        devServer = handle;
        if (readyErr) {
          throw readyErr;
        }

        return {
          path,
          baseUrl: deps.config.baseUrl,
          async release() {
            // Stop the dev server first (crash-tolerant — never throws), then
            // advance the mutex. Ordering matters: if stopDevServer throws in
            // the future, we still want release() to run so we don't deadlock.
            try {
              await stopDevServer(handle);
            } finally {
              release();
            }
          },
        };
      } catch (err) {
        // Best-effort cleanup of any spawned dev server so we don't leak a
        // process when the acquire body throws. stopDevServer is already
        // crash-tolerant, but we wrap in try/catch defensively — the mutex
        // advance below is the load-bearing part.
        if (devServer) {
          try {
            await stopDevServer(devServer);
          } catch (stopErr) {
            console.log(
              `[verify-worktree] ${projectId}: stopDevServer during error cleanup failed: ${(stopErr as Error).message}`,
            );
          }
        }
        // Advance the mutex even on failure so subsequent acquires aren't
        // blocked forever. Without this, a single failed fetch/checkout/
        // ambiguous-tilde/install/ready-probe deadlocks the manager for its
        // lifetime.
        release();
        throw err;
      }
    },
  };
}
