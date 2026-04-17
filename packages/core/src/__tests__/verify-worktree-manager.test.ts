import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { McpVerifyConfig } from "../types.js";

// Hoisted spawn mock — must be defined before the vi.mock() call below because
// vi.mock() is itself hoisted. The runtime-process tests use the same pattern.
const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

// Mock child_process.execFile + spawn. execFile is used for one-shot git/pnpm
// commands; spawn is used for the long-lived dev server in Task 2.3.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  spawn: mockSpawn,
}));

// Mock node:fs — readFileSync is used for lockfile hashing. We only mock the
// functions we reference in production code under test; this keeps other
// modules (which import readFileSync from node:fs at module load time) from
// breaking. At runtime the production module only uses readFileSync, so a
// partial mock is sufficient here.
const readFileSyncMock = vi.fn();
vi.mock("node:fs", () => ({
  readFileSync: (p: string) => readFileSyncMock(p),
}));

const mockExecFile = vi.mocked(childProcess.execFile);

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

interface ExecFileCall {
  cmd: string;
  args: string[];
}

/**
 * Builds a mock execFile implementation that routes calls to handlers
 * based on the git subcommand (e.g. "worktree list", "fetch", "checkout").
 *
 * Each handler can return { stdout } or { error }. If a call doesn't match
 * any handler, it resolves with empty stdout.
 */
function mockGitCommands(
  handlers: Array<{
    match: (call: ExecFileCall) => boolean;
    respond: () => { stdout?: string; error?: string };
  }>,
  calls: ExecFileCall[],
): void {
  mockExecFile.mockImplementation((cmd, args, _opts, callback) => {
    const call: ExecFileCall = {
      cmd: cmd as string,
      args: (args as string[]) ?? [],
    };
    calls.push(call);
    const handler = handlers.find((h) => h.match(call));
    const result = handler ? handler.respond() : { stdout: "" };
    if (result.error) {
      (callback as ExecFileCallback)(new Error(result.error), "", result.error);
    } else {
      (callback as ExecFileCallback)(null, result.stdout ?? "", "");
    }
    return {} as ReturnType<typeof childProcess.execFile>;
  });
}

function isWorktreeListCall(call: ExecFileCall): boolean {
  return (
    call.cmd === "git" &&
    call.args.includes("worktree") &&
    call.args.includes("list") &&
    call.args.includes("--porcelain")
  );
}

function isWorktreeAddCall(call: ExecFileCall): boolean {
  return call.cmd === "git" && call.args.includes("worktree") && call.args.includes("add");
}

function isFetchCall(call: ExecFileCall): boolean {
  return call.cmd === "git" && call.args.includes("fetch");
}

function isCheckoutCall(call: ExecFileCall): boolean {
  return call.cmd === "git" && call.args.includes("checkout");
}

function isPnpmInstallCall(call: ExecFileCall): boolean {
  return call.cmd === "pnpm" && call.args.includes("install");
}

const baseConfig: McpVerifyConfig = {
  enabled: true,
  triggerLabel: "ui-verify",
  baseUrl: "http://localhost:3100",
  verifyWorktreeDir: "/tmp/verify-worktrees",
  startCommand: "pnpm dev",
  readyProbe: { url: "http://localhost:3100/", timeoutSec: 30 },
  accounts: {},
  maxRetries: 2,
  timeoutSec: 300,
  uiVerifierPersona: "ui-verifier",
};

/**
 * Minimal ChildProcess-like mock. Extends EventEmitter so tests can emit
 * "exit" / "error" at will. `exitCode` starts null (running); set to a number
 * and emit "exit" to simulate termination.
 */
class MockChildProcess extends EventEmitter {
  pid = 12345;
  exitCode: number | null = null;
  signalCode: string | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn((_signal?: string) => true);
}

function createMockChild(): MockChildProcess {
  return new MockChildProcess();
}

/**
 * Default spawn factory used across most tests — returns a child that
 * emits "exit" on the next tick after receiving any kill signal. Tests that
 * want to assert on SIGTERM→SIGKILL escalation, or on already-exited
 * behavior, override this with their own child.
 */
function createWellBehavedChild(): MockChildProcess {
  const child = createMockChild();
  child.kill = vi.fn((signal?: string) => {
    // Simulate a cooperative process that terminates on signal. Using
    // setImmediate (rather than synchronous emit) mirrors the real node
    // behavior where "exit" fires on a future tick.
    setImmediate(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.signalCode = signal ?? "SIGTERM";
        child.emit("exit", null, signal ?? "SIGTERM");
      }
    });
    return true;
  });
  return child;
}

beforeEach(async () => {
  vi.clearAllMocks();
  // Default: any readFileSync call returns the same lockfile content. Individual
  // tests override with mockReturnValueOnce / mockImplementation for differing
  // behavior (missing file, changed content, etc.).
  readFileSyncMock.mockReturnValue(Buffer.from("lockfile-content-v1"));
  // Clear the module-level install hash cache so tests don't see each other's
  // state. The cache is process-global by design (it models "what this process
  // last installed"), so tests must reset it explicitly.
  const { __clearInstalledHashCacheForTests } = await import("../verify-worktree-manager.js");
  __clearInstalledHashCacheForTests();

  // Default spawn: returns a well-behaved child that cooperatively exits on
  // any kill signal. Tests that care about the spawn details (early-exit,
  // SIGKILL escalation, already-dead) override this per-test.
  mockSpawn.mockImplementation(() => createWellBehavedChild());

  // Default fetch: resolves with ok:true on the very first call so the ready
  // probe succeeds immediately. Tests that care about probe behavior override.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createVerifyWorktreeManager", () => {
  describe("serialization", () => {
    it("serializes concurrent acquires — second waits for first.release()", async () => {
      const { createVerifyWorktreeManager } = await import("../verify-worktree-manager.js");
      const calls: ExecFileCall[] = [];
      mockGitCommands(
        [
          { match: isWorktreeListCall, respond: () => ({ stdout: "" }) },
          { match: isWorktreeAddCall, respond: () => ({ stdout: "" }) },
          { match: isFetchCall, respond: () => ({ stdout: "" }) },
          { match: isCheckoutCall, respond: () => ({ stdout: "" }) },
        ],
        calls,
      );

      const mgr = createVerifyWorktreeManager({
        projectPath: "/repo/my-app",
        config: baseConfig,
      });

      let secondResolved = false;
      const firstPromise = mgr.acquire("my-app", "feature-branch");
      const secondPromise = mgr.acquire("my-app", "other-branch").then((h) => {
        secondResolved = true;
        return h;
      });

      const firstHandle = await firstPromise;

      // Give the event loop a chance to resolve the second promise if the mutex is broken.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      expect(secondResolved).toBe(false);

      await firstHandle.release();

      const secondHandle = await secondPromise;
      expect(secondResolved).toBe(true);
      await secondHandle.release();
    });
  });

  describe("git commands", () => {
    it("runs git fetch + git checkout during acquire", async () => {
      const { createVerifyWorktreeManager } = await import("../verify-worktree-manager.js");
      const calls: ExecFileCall[] = [];
      const expectedPath = resolve("/tmp/verify-worktrees", "my-app");
      mockGitCommands(
        [
          { match: isWorktreeListCall, respond: () => ({ stdout: "" }) },
          { match: isWorktreeAddCall, respond: () => ({ stdout: "" }) },
          { match: isFetchCall, respond: () => ({ stdout: "" }) },
          { match: isCheckoutCall, respond: () => ({ stdout: "" }) },
        ],
        calls,
      );

      const mgr = createVerifyWorktreeManager({
        projectPath: "/repo/my-app",
        config: baseConfig,
      });

      const handle = await mgr.acquire("my-app", "feature-branch");

      const fetchCall = calls.find(isFetchCall);
      expect(fetchCall).toBeDefined();
      // fetch must target origin and run inside the worktree path
      expect(fetchCall?.args).toContain("fetch");
      expect(fetchCall?.args).toContain("origin");
      // -C <worktree-path> ensures the fetch runs inside the worktree
      const cIndex = fetchCall?.args.indexOf("-C") ?? -1;
      expect(cIndex).toBeGreaterThanOrEqual(0);
      expect(fetchCall?.args[cIndex + 1]).toBe(expectedPath);

      const checkoutCall = calls.find(isCheckoutCall);
      expect(checkoutCall).toBeDefined();
      expect(checkoutCall?.args).toContain("checkout");
      expect(checkoutCall?.args).toContain("feature-branch");

      await handle.release();
    });

    it("runs git worktree add when worktree doesn't yet exist", async () => {
      const { createVerifyWorktreeManager } = await import("../verify-worktree-manager.js");
      const calls: ExecFileCall[] = [];
      mockGitCommands(
        [
          // Empty porcelain output — no worktrees present
          { match: isWorktreeListCall, respond: () => ({ stdout: "" }) },
          { match: isWorktreeAddCall, respond: () => ({ stdout: "" }) },
          { match: isFetchCall, respond: () => ({ stdout: "" }) },
          { match: isCheckoutCall, respond: () => ({ stdout: "" }) },
        ],
        calls,
      );

      const mgr = createVerifyWorktreeManager({
        projectPath: "/repo/my-app",
        config: baseConfig,
      });

      const handle = await mgr.acquire("my-app", "feature-branch");

      const addCall = calls.find(isWorktreeAddCall);
      expect(addCall).toBeDefined();
      // worktree add must run in the main repo (-C /repo/my-app)
      const cIndex = addCall?.args.indexOf("-C") ?? -1;
      expect(cIndex).toBeGreaterThanOrEqual(0);
      expect(addCall?.args[cIndex + 1]).toBe("/repo/my-app");

      await handle.release();
    });

    it("does NOT run git worktree add when worktree already exists", async () => {
      const { createVerifyWorktreeManager } = await import("../verify-worktree-manager.js");
      const calls: ExecFileCall[] = [];
      const expectedPath = resolve("/tmp/verify-worktrees", "my-app");
      const porcelain = `worktree ${expectedPath}\nHEAD abcdef\nbranch refs/heads/main\n`;
      mockGitCommands(
        [
          { match: isWorktreeListCall, respond: () => ({ stdout: porcelain }) },
          { match: isWorktreeAddCall, respond: () => ({ stdout: "" }) },
          { match: isFetchCall, respond: () => ({ stdout: "" }) },
          { match: isCheckoutCall, respond: () => ({ stdout: "" }) },
        ],
        calls,
      );

      const mgr = createVerifyWorktreeManager({
        projectPath: "/repo/my-app",
        config: baseConfig,
      });

      const handle = await mgr.acquire("my-app", "feature-branch");

      const addCall = calls.find(isWorktreeAddCall);
      expect(addCall).toBeUndefined();

      await handle.release();
    });
  });

  describe("path handling", () => {
    it("expands leading `~` in verifyWorktreeDir to the user's home directory", async () => {
      const { createVerifyWorktreeManager } = await import("../verify-worktree-manager.js");
      const calls: ExecFileCall[] = [];
      mockGitCommands(
        [
          { match: isWorktreeListCall, respond: () => ({ stdout: "" }) },
          { match: isWorktreeAddCall, respond: () => ({ stdout: "" }) },
          { match: isFetchCall, respond: () => ({ stdout: "" }) },
          { match: isCheckoutCall, respond: () => ({ stdout: "" }) },
        ],
        calls,
      );

      const mgr = createVerifyWorktreeManager({
        projectPath: "/repo/my-app",
        config: { ...baseConfig, verifyWorktreeDir: "~/ao-verify" },
      });

      const handle = await mgr.acquire("my-app", "feature-branch");

      const expectedPath = resolve(homedir(), "ao-verify", "my-app");
      expect(handle.path).toBe(expectedPath);

      // The worktree add should have been invoked with the home-expanded path
      const addCall = calls.find(isWorktreeAddCall);
      expect(addCall?.args).toContain(expectedPath);

      await handle.release();
    });
  });

  describe("error propagation", () => {
    it("propagates errors from git fetch (does NOT fall through to worktree add)", async () => {
      const { createVerifyWorktreeManager } = await import("../verify-worktree-manager.js");
      const calls: ExecFileCall[] = [];
      // Worktree already exists → we skip worktree add. Then fetch fails.
      const expectedPath = resolve("/tmp/verify-worktrees", "my-app");
      const porcelain = `worktree ${expectedPath}\nHEAD abcdef\nbranch refs/heads/main\n`;
      mockGitCommands(
        [
          { match: isWorktreeListCall, respond: () => ({ stdout: porcelain }) },
          { match: isWorktreeAddCall, respond: () => ({ stdout: "" }) },
          { match: isFetchCall, respond: () => ({ error: "could not resolve host: github.com" }) },
          { match: isCheckoutCall, respond: () => ({ stdout: "" }) },
        ],
        calls,
      );

      const mgr = createVerifyWorktreeManager({
        projectPath: "/repo/my-app",
        config: baseConfig,
      });

      await expect(mgr.acquire("my-app", "feature-branch")).rejects.toThrow(
        /could not resolve host/,
      );

      // Ensure no worktree add call was issued as a recovery attempt
      expect(calls.filter(isWorktreeAddCall)).toHaveLength(0);
    });

    it("advances the mutex when the acquire body throws (does not deadlock subsequent acquires)", async () => {
      const { createVerifyWorktreeManager } = await import("../verify-worktree-manager.js");

      const mgr = createVerifyWorktreeManager({
        projectPath: "/repo/my-app",
        config: baseConfig,
      });

      // First acquire: worktree exists, fetch fails → body throws.
      const expectedPath = resolve("/tmp/verify-worktrees", "my-app");
      const porcelain = `worktree ${expectedPath}\nHEAD abcdef\nbranch refs/heads/main\n`;
      const firstCalls: ExecFileCall[] = [];
      mockGitCommands(
        [
          { match: isWorktreeListCall, respond: () => ({ stdout: porcelain }) },
          { match: isFetchCall, respond: () => ({ error: "network unreachable" }) },
        ],
        firstCalls,
      );

      await expect(mgr.acquire("my-app", "feat/a")).rejects.toThrow(/network unreachable/);

      // Second acquire: all git commands succeed. If the mutex deadlocks,
      // this hangs forever and the test times out.
      mockExecFile.mockReset();
      const secondCalls: ExecFileCall[] = [];
      mockGitCommands(
        [
          { match: isWorktreeListCall, respond: () => ({ stdout: porcelain }) },
          { match: isWorktreeAddCall, respond: () => ({ stdout: "" }) },
          { match: isFetchCall, respond: () => ({ stdout: "" }) },
          { match: isCheckoutCall, respond: () => ({ stdout: "" }) },
        ],
        secondCalls,
      );

      const handle = await mgr.acquire("my-app", "feat/b");
      expect(handle).toBeDefined();
      expect(handle.path).toBe(expectedPath);
      await handle.release();
    });

    it("includes command context and stderr in run() error messages", async () => {
      const { createVerifyWorktreeManager } = await import("../verify-worktree-manager.js");

      // Make the first git call (worktree list) fail with a specific stderr.
      mockExecFile.mockImplementation((cmd, args, _opts, callback) => {
        const stderr = "fatal: not a git repository";
        (callback as ExecFileCallback)(new Error("Command failed"), "", stderr);
        return {} as ReturnType<typeof childProcess.execFile>;
      });

      const mgr = createVerifyWorktreeManager({
        projectPath: "/repo/my-app",
        config: baseConfig,
      });

      let caught: Error | undefined;
      try {
        await mgr.acquire("my-app", "feature-branch");
      } catch (e) {
        caught = e as Error;
      }

      expect(caught).toBeDefined();
      // Error message must include the command string...
      expect(caught?.message).toContain("git");
      expect(caught?.message).toContain("worktree");
      expect(caught?.message).toContain("list");
      // ...and the stderr content.
      expect(caught?.message).toContain("fatal: not a git repository");
    });
  });

  describe("expandHome path validation", () => {
    it("throws on bare `~` (ambiguous)", async () => {
      const { createVerifyWorktreeManager } = await import("../verify-worktree-manager.js");
      const mgr = createVerifyWorktreeManager({
        projectPath: "/repo/my-app",
        config: { ...baseConfig, verifyWorktreeDir: "~" },
      });
      await expect(mgr.acquire("my-app", "feature-branch")).rejects.toThrow(/ambiguous/);
    });

    it("throws on `~otheruser/foo` (we do not resolve other users' homes)", async () => {
      const { createVerifyWorktreeManager } = await import("../verify-worktree-manager.js");
      const mgr = createVerifyWorktreeManager({
        projectPath: "/repo/my-app",
        config: { ...baseConfig, verifyWorktreeDir: "~otheruser/foo" },
      });
      await expect(mgr.acquire("my-app", "feature-branch")).rejects.toThrow(/ambiguous/);
    });

    it("accepts absolute paths and `~/subdir`", async () => {
      const { createVerifyWorktreeManager } = await import("../verify-worktree-manager.js");

      // Absolute path case
      {
        const calls: ExecFileCall[] = [];
        mockGitCommands(
          [
            { match: isWorktreeListCall, respond: () => ({ stdout: "" }) },
            { match: isWorktreeAddCall, respond: () => ({ stdout: "" }) },
            { match: isFetchCall, respond: () => ({ stdout: "" }) },
            { match: isCheckoutCall, respond: () => ({ stdout: "" }) },
          ],
          calls,
        );
        const mgr = createVerifyWorktreeManager({
          projectPath: "/repo/my-app",
          config: { ...baseConfig, verifyWorktreeDir: "/abs/path" },
        });
        const handle = await mgr.acquire("my-app", "feature-branch");
        expect(handle.path).toBe(resolve("/abs/path", "my-app"));
        await handle.release();
      }

      // `~/x` case
      mockExecFile.mockReset();
      {
        const calls: ExecFileCall[] = [];
        mockGitCommands(
          [
            { match: isWorktreeListCall, respond: () => ({ stdout: "" }) },
            { match: isWorktreeAddCall, respond: () => ({ stdout: "" }) },
            { match: isFetchCall, respond: () => ({ stdout: "" }) },
            { match: isCheckoutCall, respond: () => ({ stdout: "" }) },
          ],
          calls,
        );
        const mgr = createVerifyWorktreeManager({
          projectPath: "/repo/my-app",
          config: { ...baseConfig, verifyWorktreeDir: "~/x" },
        });
        const handle = await mgr.acquire("my-app", "feature-branch");
        expect(handle.path).toBe(resolve(homedir(), "x", "my-app"));
        await handle.release();
      }
    });
  });

  describe("lockfile-gated install", () => {
    // Helper: configure execFile mock to answer all git commands happily and
    // also record pnpm install calls. Returns the shared `calls` array.
    function mockHappyGitAndPnpm(): ExecFileCall[] {
      const calls: ExecFileCall[] = [];
      mockGitCommands(
        [
          { match: isWorktreeListCall, respond: () => ({ stdout: "" }) },
          { match: isWorktreeAddCall, respond: () => ({ stdout: "" }) },
          { match: isFetchCall, respond: () => ({ stdout: "" }) },
          { match: isCheckoutCall, respond: () => ({ stdout: "" }) },
          { match: isPnpmInstallCall, respond: () => ({ stdout: "" }) },
        ],
        calls,
      );
      return calls;
    }

    it("runs pnpm install on first acquire when lockfile exists", async () => {
      const { createVerifyWorktreeManager } = await import("../verify-worktree-manager.js");
      const calls = mockHappyGitAndPnpm();

      const mgr = createVerifyWorktreeManager({
        projectPath: "/repo/my-app",
        config: baseConfig,
      });

      const handle = await mgr.acquire("my-app", "feature-branch");

      const installCalls = calls.filter(isPnpmInstallCall);
      expect(installCalls).toHaveLength(1);

      await handle.release();
    });

    it("skips pnpm install on second acquire when lockfile hash unchanged", async () => {
      const { createVerifyWorktreeManager } = await import("../verify-worktree-manager.js");
      const calls = mockHappyGitAndPnpm();

      const mgr = createVerifyWorktreeManager({
        projectPath: "/repo/my-app",
        config: baseConfig,
      });

      // First acquire — install runs.
      const first = await mgr.acquire("my-app", "feature-branch");
      await first.release();

      // Second acquire — lockfile unchanged (default mock), install must NOT run again.
      const second = await mgr.acquire("my-app", "other-branch");
      await second.release();

      const installCalls = calls.filter(isPnpmInstallCall);
      expect(installCalls).toHaveLength(1);
    });

    it("runs pnpm install again when lockfile hash changes between acquires", async () => {
      const { createVerifyWorktreeManager } = await import("../verify-worktree-manager.js");
      const calls = mockHappyGitAndPnpm();

      // First call: v1. Second call: v2.
      readFileSyncMock.mockReset();
      readFileSyncMock
        .mockReturnValueOnce(Buffer.from("lockfile-content-v1"))
        .mockReturnValueOnce(Buffer.from("lockfile-content-v2"));

      const mgr = createVerifyWorktreeManager({
        projectPath: "/repo/my-app",
        config: baseConfig,
      });

      const first = await mgr.acquire("my-app", "feature-branch");
      await first.release();

      const second = await mgr.acquire("my-app", "other-branch");
      await second.release();

      const installCalls = calls.filter(isPnpmInstallCall);
      expect(installCalls).toHaveLength(2);
    });

    it("forces install when pnpm-lock.yaml is missing (ENOENT)", async () => {
      const { createVerifyWorktreeManager } = await import("../verify-worktree-manager.js");
      const calls = mockHappyGitAndPnpm();

      readFileSyncMock.mockReset();
      readFileSyncMock.mockImplementation(() => {
        const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      });

      const mgr = createVerifyWorktreeManager({
        projectPath: "/repo/my-app",
        config: baseConfig,
      });

      const handle = await mgr.acquire("my-app", "feature-branch");

      const installCalls = calls.filter(isPnpmInstallCall);
      expect(installCalls).toHaveLength(1);

      await handle.release();
    });

    it("install cache is keyed by projectId (project-a install does not satisfy project-b)", async () => {
      const { createVerifyWorktreeManager } = await import("../verify-worktree-manager.js");
      const calls = mockHappyGitAndPnpm();

      const mgr = createVerifyWorktreeManager({
        projectPath: "/repo/shared",
        config: baseConfig,
      });

      // project-a, first acquire → install runs.
      const a1 = await mgr.acquire("project-a", "main");
      await a1.release();

      // project-b, first acquire → install must run again (different cache key).
      const b1 = await mgr.acquire("project-b", "main");
      await b1.release();

      // project-a, second acquire → cache hit, install must NOT run.
      const a2 = await mgr.acquire("project-a", "main");
      await a2.release();

      const installCalls = calls.filter(isPnpmInstallCall);
      expect(installCalls).toHaveLength(2);
    });

    it("runs pnpm install in the worktree path (cwd)", async () => {
      const { createVerifyWorktreeManager } = await import("../verify-worktree-manager.js");
      const calls: ExecFileCall[] = [];
      const capturedOpts: Array<{ cwd?: string; timeout?: number }> = [];
      mockExecFile.mockImplementation((cmd, args, opts, callback) => {
        const call: ExecFileCall = {
          cmd: cmd as string,
          args: (args as string[]) ?? [],
        };
        calls.push(call);
        if (call.cmd === "pnpm" && call.args.includes("install")) {
          capturedOpts.push(opts as { cwd?: string; timeout?: number });
        }
        (callback as ExecFileCallback)(null, "", "");
        return {} as ReturnType<typeof childProcess.execFile>;
      });

      const mgr = createVerifyWorktreeManager({
        projectPath: "/repo/my-app",
        config: baseConfig,
      });

      const handle = await mgr.acquire("my-app", "feature-branch");

      const expectedWorktreePath = resolve("/tmp/verify-worktrees", "my-app");
      expect(capturedOpts).toHaveLength(1);
      expect(capturedOpts[0]?.cwd).toBe(expectedWorktreePath);

      await handle.release();
    });

    it("throws when lockfile read fails with permission denied (EACCES)", async () => {
      const { __clearInstalledHashCacheForTests, createVerifyWorktreeManager } = await import(
        "../verify-worktree-manager.js"
      );
      __clearInstalledHashCacheForTests();

      vi.mocked(childProcess.execFile).mockImplementation((cmd, args, opts, callback) => {
        // Happy path for all git commands
        (callback as ExecFileCallback)(null, "", "");
        return {} as ReturnType<typeof childProcess.execFile>;
      });

      readFileSyncMock.mockImplementation((path: string) => {
        // Simulate permission denied when reading pnpm-lock.yaml
        if (path.includes("pnpm-lock.yaml")) {
          const err = new Error("Permission denied") as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        }
        return Buffer.from("");
      });

      const mgr = createVerifyWorktreeManager({
        projectPath: "/repo/my-app",
        config: baseConfig,
      });

      await expect(mgr.acquire("my-app", "feature-branch")).rejects.toThrow(
        /Failed to read pnpm-lock.yaml.*Permission denied/,
      );
    });
  });

  describe("return value", () => {
    it("returns a handle with baseUrl from config", async () => {
      const { createVerifyWorktreeManager } = await import("../verify-worktree-manager.js");
      const calls: ExecFileCall[] = [];
      mockGitCommands(
        [
          { match: isWorktreeListCall, respond: () => ({ stdout: "" }) },
          { match: isWorktreeAddCall, respond: () => ({ stdout: "" }) },
          { match: isFetchCall, respond: () => ({ stdout: "" }) },
          { match: isCheckoutCall, respond: () => ({ stdout: "" }) },
        ],
        calls,
      );

      const mgr = createVerifyWorktreeManager({
        projectPath: "/repo/my-app",
        config: baseConfig,
      });

      const handle = await mgr.acquire("my-app", "feature-branch");
      expect(handle.baseUrl).toBe("http://localhost:3100");
      await handle.release();
    });
  });

  // ===========================================================================
  // Task 2.3 — Dev server lifecycle
  // ===========================================================================
  describe("dev server lifecycle", () => {
    /**
     * Configure execFile to happily answer all git + pnpm commands so the
     * tests can focus on spawn/fetch behavior without redefining the git
     * plumbing for every test.
     */
    function mockHappyGitAndPnpm(): void {
      const calls: ExecFileCall[] = [];
      mockGitCommands(
        [
          { match: isWorktreeListCall, respond: () => ({ stdout: "" }) },
          { match: isWorktreeAddCall, respond: () => ({ stdout: "" }) },
          { match: isFetchCall, respond: () => ({ stdout: "" }) },
          { match: isCheckoutCall, respond: () => ({ stdout: "" }) },
          { match: isPnpmInstallCall, respond: () => ({ stdout: "" }) },
        ],
        calls,
      );
    }

    it("spawns startCommand via shell:true so env-prefixed commands work", async () => {
      const { createVerifyWorktreeManager } = await import("../verify-worktree-manager.js");
      mockHappyGitAndPnpm();
      const child = createWellBehavedChild();
      mockSpawn.mockReturnValue(child);

      const mgr = createVerifyWorktreeManager({
        projectPath: "/repo/my-app",
        config: { ...baseConfig, startCommand: "PORT=3100 pnpm dev" },
      });

      const handle = await mgr.acquire("my-app", "feature-branch");

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(mockSpawn).toHaveBeenCalledWith(
        "PORT=3100 pnpm dev",
        expect.objectContaining({
          cwd: resolve("/tmp/verify-worktrees", "my-app"),
          shell: true,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );

      await handle.release();
    });

    it("polls readyProbe.url until it responds with 2xx, then resolves", async () => {
      const { createVerifyWorktreeManager } = await import("../verify-worktree-manager.js");
      mockHappyGitAndPnpm();
      const child = createWellBehavedChild();
      mockSpawn.mockReturnValue(child);

      // First two fetches reject (connection refused while server boots),
      // third fetch resolves ok. The loop must keep polling through errors.
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", fetchMock);

      const mgr = createVerifyWorktreeManager({
        projectPath: "/repo/my-app",
        config: baseConfig,
      });

      const handle = await mgr.acquire("my-app", "feature-branch");

      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
      // All probes hit the configured URL
      for (const call of fetchMock.mock.calls) {
        expect(call[0]).toBe("http://localhost:3100/");
      }

      await handle.release();
    });

    it("throws when ready probe times out without ever succeeding", async () => {
      const { createVerifyWorktreeManager } = await import("../verify-worktree-manager.js");
      mockHappyGitAndPnpm();
      const child = createWellBehavedChild();
      mockSpawn.mockReturnValue(child);

      const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      vi.stubGlobal("fetch", fetchMock);

      const mgr = createVerifyWorktreeManager({
        projectPath: "/repo/my-app",
        // 1-second timeout keeps the test fast. Implementation polls every
        // 500ms so we'll get 2-3 attempts before timing out.
        config: { ...baseConfig, readyProbe: { url: "http://localhost:3100/", timeoutSec: 1 } },
      });

      await expect(mgr.acquire("my-app", "feature-branch")).rejects.toThrow(/did not become ready/);

      // The dev server must have been killed on timeout (cleanup path).
      expect(child.kill).toHaveBeenCalled();
    });

    it("throws when dev server exits during ready-probe polling", async () => {
      const { createVerifyWorktreeManager } = await import("../verify-worktree-manager.js");
      mockHappyGitAndPnpm();
      const child = createMockChild();
      mockSpawn.mockImplementation(() => {
        // Schedule the child to crash very shortly after spawn returns.
        setTimeout(() => {
          child.exitCode = 1;
          child.emit("exit", 1, null);
        }, 20);
        return child;
      });

      // Fetch always rejects — if early-exit detection fails, the test would
      // hang until the probe timeout and then fail with "did not become ready".
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

      const mgr = createVerifyWorktreeManager({
        projectPath: "/repo/my-app",
        // Generous timeout so the early-exit path is what wins the race.
        config: { ...baseConfig, readyProbe: { url: "http://localhost:3100/", timeoutSec: 30 } },
      });

      await expect(mgr.acquire("my-app", "feature-branch")).rejects.toThrow(/dev server exited/);
    });

    it("release() stops the dev server via SIGTERM then SIGKILL if it doesn't exit", async () => {
      vi.useFakeTimers();
      try {
        const { createVerifyWorktreeManager } = await import("../verify-worktree-manager.js");
        mockHappyGitAndPnpm();

        const child = createMockChild();
        // Child exits ONLY on SIGKILL. SIGTERM is ignored so the grace
        // window elapses and the implementation must escalate.
        child.kill = vi.fn((signal?: string) => {
          if (signal === "SIGKILL") {
            setImmediate(() => {
              child.exitCode = 137; // 128 + 9
              child.emit("exit", null, "SIGKILL");
            });
          }
          return true;
        });
        mockSpawn.mockReturnValue(child);

        const mgr = createVerifyWorktreeManager({
          projectPath: "/repo/my-app",
          config: baseConfig,
        });

        // The acquire() call awaits fetch/setTimeout — under fake timers
        // we need to flush microtasks + advance any pending timers.
        const acquirePromise = mgr.acquire("my-app", "feature-branch");
        await vi.runAllTimersAsync();
        const handle = await acquirePromise;

        // Fire release in the background; advance past the 5s SIGTERM grace
        // so the implementation escalates to SIGKILL.
        const releasePromise = handle.release();
        await vi.advanceTimersByTimeAsync(5_100);
        await releasePromise;

        const signals = child.kill.mock.calls.map((c) => c[0]);
        expect(signals).toContain("SIGTERM");
        expect(signals).toContain("SIGKILL");
      } finally {
        vi.useRealTimers();
      }
    });

    it("release() does NOT throw when the dev server has already exited (crash-tolerant)", async () => {
      const { createVerifyWorktreeManager } = await import("../verify-worktree-manager.js");
      mockHappyGitAndPnpm();

      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const mgr = createVerifyWorktreeManager({
        projectPath: "/repo/my-app",
        config: baseConfig,
      });

      const handle = await mgr.acquire("my-app", "feature-branch");

      // Simulate the process dying on its own (crash / OOM / user-killed).
      // exitCode is no longer null — release() must treat this as "already
      // stopped" and return cleanly without throwing.
      child.exitCode = 0;

      await expect(handle.release()).resolves.toBeUndefined();
      // kill() must not be invoked on a process that has already exited.
      expect(child.kill).not.toHaveBeenCalled();

      // And — critically — the mutex must have advanced, so a subsequent
      // acquire can proceed. Use a fresh child for the second acquire.
      const child2 = createMockChild();
      mockSpawn.mockReturnValue(child2);
      const handle2 = await mgr.acquire("my-app", "other-branch");
      expect(handle2).toBeDefined();
      child2.exitCode = 0;
      await handle2.release();
    });

    it("probes with a short per-request timeout so a hanging server doesn't stall the loop", async () => {
      const { createVerifyWorktreeManager } = await import("../verify-worktree-manager.js");
      mockHappyGitAndPnpm();
      const child = createWellBehavedChild();
      mockSpawn.mockReturnValue(child);

      // Capture the signal passed to fetch so we can assert the impl attached
      // an AbortSignal (i.e., is using AbortController).
      const fetchMock = vi.fn(async (_url: unknown, opts?: { signal?: AbortSignal }) => {
        expect(opts?.signal).toBeDefined();
        return { ok: true, status: 200 } as unknown as Response;
      });
      vi.stubGlobal("fetch", fetchMock);

      const mgr = createVerifyWorktreeManager({
        projectPath: "/repo/my-app",
        config: baseConfig,
      });

      const handle = await mgr.acquire("my-app", "feature-branch");
      expect(fetchMock).toHaveBeenCalled();
      await handle.release();
    });
  });
});
