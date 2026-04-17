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
 */
function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolveRun, rejectRun) => {
    execFile(cmd, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        rejectRun(new Error(stderr || error.message));
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
  acquire(projectId: string, branch: string): Promise<VerifyWorktreeHandle>;
}

interface Deps {
  /** Absolute path to the main project repo (source of the worktree) */
  projectPath: string;
  config: McpVerifyConfig;
}

/** Expand a leading `~/` to the user's home directory */
function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    return resolve(homedir(), p.slice(2));
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
    },
  };
}
