import { describe, it, expect, vi, beforeEach } from "vitest";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import type { RuntimeHandle } from "@composio/ao-core";

// Mock node:child_process with custom promisify support
vi.mock("node:child_process", () => {
  const mockExecFile = vi.fn();
  // promisify(execFile) checks for a custom promisify symbol. Set it so
  // await execFileAsync(...) returns { stdout, stderr } properly.
  (mockExecFile as any)[Symbol.for("nodejs.util.promisify.custom")] = vi.fn();
  return { execFile: mockExecFile };
});

// Mock node:crypto for deterministic UUIDs
vi.mock("node:crypto", () => ({
  randomUUID: () => "test-uuid-1234",
}));

// Mock node:fs for writeFileSync / unlinkSync
vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// Get reference to the promisify-custom mock — this is what the plugin actually calls
const mockExecFileCustom = (childProcess.execFile as any)[
  Symbol.for("nodejs.util.promisify.custom")
] as ReturnType<typeof vi.fn>;

/** Queue a successful tmux command with the given stdout. */
function mockTmuxSuccess(stdout = "") {
  mockExecFileCustom.mockResolvedValueOnce({ stdout: stdout + "\n", stderr: "" });
}

/** Queue a failed tmux command. */
function mockTmuxError(message: string) {
  mockExecFileCustom.mockRejectedValueOnce(new Error(message));
}

/** Create a RuntimeHandle for testing. */
function makeHandle(id: string, createdAt?: number): RuntimeHandle {
  return {
    id,
    runtimeName: "tmux",
    data: {
      createdAt: createdAt ?? 1000,
      workspacePath: "/tmp/workspace",
    },
  };
}

// Import after mocks are set up
import tmuxPlugin, { manifest, create } from "../index.js";

beforeEach(() => {
  vi.clearAllMocks();
  // Speed up the launch-verification loop in runtime.create() tests.
  process.env["AO_TMUX_LAUNCH_VERIFY_ATTEMPTS"] = "3";
  process.env["AO_TMUX_LAUNCH_VERIFY_POLL_MS"] = "1";
});

describe("manifest", () => {
  it("has name 'tmux' and slot 'runtime'", () => {
    expect(manifest.name).toBe("tmux");
    expect(manifest.slot).toBe("runtime");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.description).toBe("Runtime plugin: tmux sessions");
  });

  it("default export includes manifest and create", () => {
    expect(tmuxPlugin.manifest).toBe(manifest);
    expect(tmuxPlugin.create).toBe(create);
  });
});

describe("create()", () => {
  it("returns a Runtime with name 'tmux'", () => {
    const runtime = create();
    expect(runtime.name).toBe("tmux");
  });
});

describe("runtime.create()", () => {
  /**
   * Standard call sequence for a successful short-command create:
   * 1: new-session, 2: capture-pane (shell-ready probe — return a prompt),
   * 3: send-keys (launch command + Enter), 4: display-message (launch
   * verification — return a non-shell foreground command).
   */
  function mockCreateSequence() {
    mockTmuxSuccess(); // new-session
    mockTmuxSuccess("user@host dir %"); // capture-pane — shell prompt visible
    mockTmuxSuccess(); // send-keys launch command
    mockTmuxSuccess("node"); // display-message — agent process running
  }

  it("calls new-session with correct args", async () => {
    const runtime = create();

    mockCreateSequence();

    const handle = await runtime.create({
      sessionId: "test-session",
      workspacePath: "/tmp/workspace",
      launchCommand: "echo hello",
      environment: {},
    });

    expect(handle.id).toBe("test-session");
    expect(handle.runtimeName).toBe("tmux");
    expect(handle.data.workspacePath).toBe("/tmp/workspace");

    // First call: new-session — implementation also injects parent PATH via -e
    expect(mockExecFileCustom).toHaveBeenCalledWith("tmux", [
      "new-session",
      "-d",
      "-s",
      "test-session",
      "-c",
      "/tmp/workspace",
      "-e",
      expect.stringMatching(/^PATH=/),
    ]);
  });

  it("includes -e KEY=VALUE flags for environment variables", async () => {
    const runtime = create();

    mockCreateSequence();

    await runtime.create({
      sessionId: "env-session",
      workspacePath: "/tmp/ws",
      launchCommand: "bash",
      environment: { AO_SESSION: "env-session", FOO: "bar" },
    });

    // First call: new-session with env args
    const firstCallArgs = mockExecFileCustom.mock.calls[0];
    const args = firstCallArgs[1] as string[];
    expect(args).toContain("-e");
    expect(args).toContain("AO_SESSION=env-session");
    expect(args).toContain("FOO=bar");
  });

  it("sends launch command via send-keys", async () => {
    const runtime = create();

    mockCreateSequence();

    await runtime.create({
      sessionId: "launch-test",
      workspacePath: "/tmp/ws",
      launchCommand: "claude --session abc",
      environment: {},
    });

    // send-keys with the launch command (after the shell-ready probe)
    expect(mockExecFileCustom).toHaveBeenCalledWith("tmux", [
      "send-keys",
      "-t",
      "launch-test",
      "claude --session abc",
      "Enter",
    ]);
  });

  it("uses load-buffer + paste-buffer for long launch commands (> 200 chars)", async () => {
    const runtime = create();
    const longCommand = "claude -p '" + "x".repeat(250) + "'";

    mockTmuxSuccess(); // new-session
    mockTmuxSuccess("user@host dir %"); // capture-pane — shell ready
    mockTmuxSuccess(); // load-buffer
    mockTmuxSuccess(); // paste-buffer
    mockTmuxSuccess(); // send-keys Enter
    mockTmuxSuccess("node"); // display-message — agent running

    await runtime.create({
      sessionId: "long-launch",
      workspacePath: "/tmp/ws",
      launchCommand: longCommand,
      environment: {},
    });

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("ao-launch-test-uuid-1234.txt"),
      longCommand,
      { encoding: "utf-8", mode: 0o600 },
    );
    // Buffer name is ao-launch-<first 8 chars of uuid>
    expect(mockExecFileCustom).toHaveBeenCalledWith("tmux", [
      "paste-buffer",
      "-b",
      "ao-launch-test-uui",
      "-t",
      "long-launch",
      "-d",
    ]);
    expect(mockExecFileCustom).toHaveBeenCalledWith("tmux", [
      "send-keys",
      "-t",
      "long-launch",
      "Enter",
    ]);
  });

  it("waits for a shell prompt before sending the launch command", async () => {
    const runtime = create();

    mockTmuxSuccess(); // new-session
    mockTmuxSuccess(""); // capture-pane — shell not ready yet (blank pane)
    mockTmuxSuccess("Last login: today"); // capture-pane — rc output, no prompt
    mockTmuxSuccess("user@host dir %"); // capture-pane — prompt appeared
    mockTmuxSuccess(); // send-keys launch command
    mockTmuxSuccess("node"); // display-message — agent running

    await runtime.create({
      sessionId: "wait-ready",
      workspacePath: "/tmp/ws",
      launchCommand: "claude go",
      environment: {},
    });

    // Three capture-pane probes before the launch command was sent
    const calls = mockExecFileCustom.mock.calls.map((c) => (c[1] as string[])[0]);
    expect(calls).toEqual([
      "new-session",
      "capture-pane",
      "capture-pane",
      "capture-pane",
      "send-keys",
      "display-message",
    ]);
  });

  it("retries Enter when the pane is still at a shell after launch", async () => {
    const runtime = create();

    mockTmuxSuccess(); // new-session
    mockTmuxSuccess("user@host dir %"); // capture-pane — ready
    mockTmuxSuccess(); // send-keys launch command
    mockTmuxSuccess("zsh"); // display-message — Enter was swallowed, still at shell
    mockTmuxSuccess(); // send-keys Enter (retry)
    mockTmuxSuccess("node"); // display-message — agent started

    await runtime.create({
      sessionId: "retry-enter",
      workspacePath: "/tmp/ws",
      launchCommand: "claude go",
      environment: {},
    });

    expect(mockExecFileCustom).toHaveBeenCalledWith("tmux", [
      "send-keys",
      "-t",
      "retry-enter",
      "Enter",
    ]);
  });

  it("kills the session and throws when the launch command never starts", async () => {
    const runtime = create();

    mockTmuxSuccess(); // new-session
    mockTmuxSuccess("user@host dir %"); // capture-pane — ready
    mockTmuxSuccess(); // send-keys launch command
    // 3 verification attempts (AO_TMUX_LAUNCH_VERIFY_ATTEMPTS=3), each:
    // display-message says "zsh", then an Enter retry.
    for (let i = 0; i < 3; i++) {
      mockTmuxSuccess("zsh");
      mockTmuxSuccess(); // send-keys Enter
    }
    mockTmuxSuccess(); // kill-session (cleanup)

    await expect(
      runtime.create({
        sessionId: "never-starts",
        workspacePath: "/tmp/ws",
        launchCommand: "claude go",
        environment: {},
      }),
    ).rejects.toThrow("launch command never started");

    expect(mockExecFileCustom).toHaveBeenCalledWith("tmux", ["kill-session", "-t", "never-starts"]);
  });

  it("cleans up session if send-keys fails", async () => {
    const runtime = create();

    // 1: new-session succeeds
    mockTmuxSuccess();
    // 2: capture-pane — shell ready
    mockTmuxSuccess("user@host dir %");
    // 3: send-keys fails
    mockTmuxError("send-keys failed");
    // 4: kill-session (cleanup attempt)
    mockTmuxSuccess();

    await expect(
      runtime.create({
        sessionId: "fail-session",
        workspacePath: "/tmp/ws",
        launchCommand: "bad-command",
        environment: {},
      }),
    ).rejects.toThrow('Failed to send launch command to session "fail-session"');

    // Verify kill-session was called for cleanup
    expect(mockExecFileCustom).toHaveBeenCalledWith("tmux", ["kill-session", "-t", "fail-session"]);
  });

  it("rejects invalid session IDs with special characters", async () => {
    const runtime = create();

    await expect(
      runtime.create({
        sessionId: "bad session!",
        workspacePath: "/tmp/ws",
        launchCommand: "echo",
        environment: {},
      }),
    ).rejects.toThrow('Invalid session ID "bad session!"');
  });

  it("rejects session IDs with dots", async () => {
    const runtime = create();

    await expect(
      runtime.create({
        sessionId: "bad.session",
        workspacePath: "/tmp/ws",
        launchCommand: "echo",
        environment: {},
      }),
    ).rejects.toThrow("Invalid session ID");
  });

  it("accepts valid session IDs with hyphens and underscores", async () => {
    const runtime = create();

    mockCreateSequence();

    const handle = await runtime.create({
      sessionId: "valid-session_123",
      workspacePath: "/tmp/ws",
      launchCommand: "echo",
      environment: {},
    });

    expect(handle.id).toBe("valid-session_123");
  });

  it("handles no environment (undefined)", async () => {
    const runtime = create();

    mockCreateSequence();

    await runtime.create({
      sessionId: "no-env",
      workspacePath: "/tmp/ws",
      launchCommand: "echo hi",
    } as any);

    // First call: implementation always injects parent PATH via -e PATH=... when
    // env doesn't already define PATH (including when environment is undefined).
    const firstCallArgs = mockExecFileCustom.mock.calls[0][1] as string[];
    expect(firstCallArgs).toEqual([
      "new-session",
      "-d",
      "-s",
      "no-env",
      "-c",
      "/tmp/ws",
      "-e",
      expect.stringMatching(/^PATH=/),
    ]);
  });
});

describe("runtime.destroy()", () => {
  it("calls kill-session with the handle id", async () => {
    const runtime = create();
    const handle = makeHandle("destroy-test");

    mockTmuxSuccess();

    await runtime.destroy(handle);

    expect(mockExecFileCustom).toHaveBeenCalledWith("tmux", ["kill-session", "-t", "destroy-test"]);
  });

  it("does not throw if session is already gone", async () => {
    const runtime = create();
    const handle = makeHandle("already-dead");

    mockTmuxError("session not found: already-dead");

    // Should not throw
    await expect(runtime.destroy(handle)).resolves.toBeUndefined();
  });
});

describe("runtime.sendMessage()", () => {
  /**
   * Every sendMessage call begins with a `display-message` query for the
   * pane's foreground command (the shell-guard). Tests that expect the agent
   * to be alive should queue a non-shell value (e.g. "node") here first.
   */
  function mockForegroundOk(command = "node") {
    mockTmuxSuccess(command);
  }

  it("sends short text with send-keys -l (literal) + Enter", async () => {
    const runtime = create();
    const handle = makeHandle("msg-short");

    // 1: display-message (foreground), 2: send-keys C-u, 3: send-keys -l text, 4: send-keys Enter
    mockForegroundOk();
    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();

    await runtime.sendMessage(handle, "hello world");

    expect(mockExecFileCustom).toHaveBeenCalledTimes(4);

    // Call 0: foreground-command probe
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(1, "tmux", [
      "display-message",
      "-t",
      "msg-short",
      "-p",
      "#{pane_current_command}",
    ]);

    // Call 1: Clear partial input
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(2, "tmux", [
      "send-keys",
      "-t",
      "msg-short",
      "C-u",
    ]);

    // Call 2: Literal text
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(3, "tmux", [
      "send-keys",
      "-t",
      "msg-short",
      "-l",
      "hello world",
    ]);

    // Call 3: Enter
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(4, "tmux", [
      "send-keys",
      "-t",
      "msg-short",
      "Enter",
    ]);
  });

  it("throws AgentExitedDuringSendError when the pane has fallen back to a shell", async () => {
    const runtime = create();
    const handle = makeHandle("msg-shell");

    // Foreground process is zsh — the val-113 failure mode.
    mockTmuxSuccess("zsh");

    await expect(runtime.sendMessage(handle, "fix the build")).rejects.toThrow(
      /AgentExitedDuringSendError|foreground process is "zsh"/,
    );

    // Critically, no send-keys / paste-buffer call must have run after the probe.
    expect(mockExecFileCustom).toHaveBeenCalledTimes(1);
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(1, "tmux", [
      "display-message",
      "-t",
      "msg-shell",
      "-p",
      "#{pane_current_command}",
    ]);
  });

  it("sends anyway when the foreground-command probe fails (best-effort)", async () => {
    const runtime = create();
    const handle = makeHandle("msg-probefail");

    // Probe fails (e.g. transient tmux error) — we should NOT block sends.
    mockTmuxError("display-message: connection lost");
    mockTmuxSuccess(); // C-u
    mockTmuxSuccess(); // -l text
    mockTmuxSuccess(); // Enter

    await runtime.sendMessage(handle, "hello");

    expect(mockExecFileCustom).toHaveBeenCalledTimes(4);
  });

  it("uses load-buffer + paste-buffer for long text (> 200 chars)", async () => {
    const runtime = create();
    const handle = makeHandle("msg-long");
    const longText = "x".repeat(250);

    // 1: display-message (foreground probe), 2: C-u, 3: load-buffer,
    // 4: paste-buffer, 5: delete-buffer (finally), 6: Enter,
    // 7: capture-pane (post-send verify — returns pane without
    // a "[Pasted text" marker so the retry loop exits immediately).
    mockForegroundOk();
    mockTmuxSuccess(); // C-u
    mockTmuxSuccess(); // load-buffer
    mockTmuxSuccess(); // paste-buffer
    mockTmuxSuccess(); // delete-buffer (finally block)
    mockTmuxSuccess(); // Enter
    mockTmuxSuccess("❯"); // capture-pane — prompt is empty, submission confirmed

    await runtime.sendMessage(handle, longText);

    expect(mockExecFileCustom).toHaveBeenCalledTimes(7);

    // Call 0: foreground probe
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(1, "tmux", [
      "display-message",
      "-t",
      "msg-long",
      "-p",
      "#{pane_current_command}",
    ]);

    // Call 1: clear
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(2, "tmux", [
      "send-keys",
      "-t",
      "msg-long",
      "C-u",
    ]);

    // Call 2: load-buffer with named buffer
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(3, "tmux", [
      "load-buffer",
      "-b",
      "ao-test-uuid-1234",
      expect.stringContaining("ao-send-test-uuid-1234.txt"),
    ]);

    // Call 3: paste-buffer
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(4, "tmux", [
      "paste-buffer",
      "-b",
      "ao-test-uuid-1234",
      "-t",
      "msg-long",
      "-d",
    ]);

    // Verify writeFileSync was called with the message
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("ao-send-test-uuid-1234.txt"),
      longText,
      { encoding: "utf-8", mode: 0o600 },
    );

    // Verify unlinkSync was called for cleanup
    expect(fs.unlinkSync).toHaveBeenCalledWith(
      expect.stringContaining("ao-send-test-uuid-1234.txt"),
    );
  });

  it("uses load-buffer for multiline text", async () => {
    const runtime = create();
    const handle = makeHandle("msg-multi");

    mockForegroundOk();
    mockTmuxSuccess(); // C-u
    mockTmuxSuccess(); // load-buffer
    mockTmuxSuccess(); // paste-buffer
    mockTmuxSuccess(); // delete-buffer (finally)
    mockTmuxSuccess(); // Enter
    mockTmuxSuccess("❯"); // capture-pane — submission confirmed

    await runtime.sendMessage(handle, "line1\nline2\nline3");

    // Should use buffer path, not send-keys -l
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(3, "tmux", [
      "load-buffer",
      "-b",
      "ao-test-uuid-1234",
      expect.stringContaining("ao-send-test-uuid-1234.txt"),
    ]);

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("ao-send-test-uuid-1234.txt"),
      "line1\nline2\nline3",
      { encoding: "utf-8", mode: 0o600 },
    );
  });

  it("cleans up buffer and temp file on paste failure", async () => {
    const runtime = create();
    const handle = makeHandle("msg-fail");
    const longText = "y".repeat(250);

    mockForegroundOk();
    mockTmuxSuccess(); // C-u
    mockTmuxSuccess(); // load-buffer succeeds
    mockTmuxError("paste-buffer failed"); // paste-buffer fails
    // finally block:
    // unlinkSync is sync (mocked)
    mockTmuxSuccess(); // delete-buffer in finally
    // After finally, the error propagates — no Enter call

    await expect(runtime.sendMessage(handle, longText)).rejects.toThrow("paste-buffer failed");

    // unlinkSync should still be called for temp file cleanup
    expect(fs.unlinkSync).toHaveBeenCalledWith(
      expect.stringContaining("ao-send-test-uuid-1234.txt"),
    );

    // delete-buffer should be called in finally block
    expect(mockExecFileCustom).toHaveBeenCalledWith("tmux", [
      "delete-buffer",
      "-b",
      "ao-test-uuid-1234",
    ]);
  });
});

describe("runtime.getOutput()", () => {
  it("calls capture-pane with correct args and default lines", async () => {
    const runtime = create();
    const handle = makeHandle("output-test");

    mockTmuxSuccess("some output\nfrom tmux");

    const output = await runtime.getOutput(handle);

    expect(output).toBe("some output\nfrom tmux");
    expect(mockExecFileCustom).toHaveBeenCalledWith("tmux", [
      "capture-pane",
      "-t",
      "output-test",
      "-p",
      "-S",
      "-50",
    ]);
  });

  it("passes custom line count", async () => {
    const runtime = create();
    const handle = makeHandle("output-custom");

    mockTmuxSuccess("output");

    await runtime.getOutput(handle, 100);

    expect(mockExecFileCustom).toHaveBeenCalledWith("tmux", [
      "capture-pane",
      "-t",
      "output-custom",
      "-p",
      "-S",
      "-100",
    ]);
  });

  it("returns empty string on error", async () => {
    const runtime = create();
    const handle = makeHandle("output-err");

    mockTmuxError("session not found");

    const output = await runtime.getOutput(handle);

    expect(output).toBe("");
  });
});

describe("runtime.isAlive()", () => {
  it("returns true when has-session succeeds", async () => {
    const runtime = create();
    const handle = makeHandle("alive-test");

    mockTmuxSuccess();

    const alive = await runtime.isAlive(handle);

    expect(alive).toBe(true);
    expect(mockExecFileCustom).toHaveBeenCalledWith("tmux", ["has-session", "-t", "alive-test"]);
  });

  it("returns false when has-session fails", async () => {
    const runtime = create();
    const handle = makeHandle("dead-test");

    mockTmuxError("session not found");

    const alive = await runtime.isAlive(handle);

    expect(alive).toBe(false);
  });
});

describe("runtime.getMetrics()", () => {
  it("returns uptimeMs based on createdAt", async () => {
    const runtime = create();
    const now = Date.now();
    const handle = makeHandle("metrics-test", now - 5000);

    const metrics = await runtime.getMetrics!(handle);

    // uptimeMs should be approximately 5000ms (allow some wiggle room)
    expect(metrics.uptimeMs).toBeGreaterThanOrEqual(5000);
    expect(metrics.uptimeMs).toBeLessThan(6000);
  });

  it("handles missing createdAt by using Date.now()", async () => {
    const runtime = create();
    const handle: RuntimeHandle = {
      id: "metrics-no-created",
      runtimeName: "tmux",
      data: {},
    };

    const metrics = await runtime.getMetrics!(handle);

    // uptimeMs should be very close to 0 since createdAt defaults to Date.now()
    expect(metrics.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(metrics.uptimeMs).toBeLessThan(1000);
  });
});

describe("runtime.getAttachInfo()", () => {
  it("returns tmux type and attach command", async () => {
    const runtime = create();
    const handle = makeHandle("attach-test");

    const info = await runtime.getAttachInfo!(handle);

    expect(info).toEqual({
      type: "tmux",
      target: "attach-test",
      command: "tmux attach -t attach-test",
    });
  });
});
