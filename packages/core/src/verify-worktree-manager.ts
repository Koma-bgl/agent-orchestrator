/**
 * VerifyWorktreeManager
 *
 * Manages the single shared verify worktree used by the MCP-driven visual
 * verification flow. Callers `acquire()` an exclusive handle for a project +
 * branch; the manager serializes concurrent acquires with an in-process
 * mutex so only one verification run touches the worktree at a time.
 *
 * This module is deliberately minimal — Task 2.1 covers only:
 *   - Serialized acquire
 *   - Ensuring the git worktree exists (create if missing)
 *   - Fetching origin and checking out the requested branch
 *
 * `pnpm install` and dev-server spawn land in Tasks 2.2 and 2.3.
 */

import { execFile } from "node:child_process";
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
 */
function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolveRun, rejectRun) => {
    execFile(cmd, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
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
   * bad branch during checkout), the mutex is automatically advanced and
   * the error is re-thrown — callers do not need to release in that case.
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

        return {
          path,
          baseUrl: deps.config.baseUrl,
          async release() {
            release();
          },
        };
      } catch (err) {
        // Advance the mutex even on failure so subsequent acquires aren't
        // blocked forever. Without this, a single failed fetch/checkout/
        // ambiguous-tilde/etc deadlocks the manager for its lifetime.
        release();
        throw err;
      }
    },
  };
}
