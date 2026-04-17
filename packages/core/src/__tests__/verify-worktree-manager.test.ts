import { describe, it, expect, vi, beforeEach } from "vitest";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { McpVerifyConfig } from "../types.js";

// Mock child_process.execFile
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
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
});
