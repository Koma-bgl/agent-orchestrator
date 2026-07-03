import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentExitedDuringSendError,
  type PluginModule,
  type Runtime,
  type RuntimeCreateConfig,
  type RuntimeHandle,
  type RuntimeMetrics,
  type AttachInfo,
} from "@composio/ao-core";

const execFileAsync = promisify(execFile);

export const manifest = {
  name: "tmux",
  slot: "runtime" as const,
  description: "Runtime plugin: tmux sessions",
  version: "0.1.0",
};

/** Only allow safe characters in session IDs */
const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]+$/;

function assertValidSessionId(id: string): void {
  if (!SAFE_SESSION_ID.test(id)) {
    throw new Error(`Invalid session ID "${id}": must match ${SAFE_SESSION_ID}`);
  }
}

/** Run a tmux command and return stdout */
async function tmux(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("tmux", args);
  return stdout.trimEnd();
}

/**
 * Shell program names we recognize as "the agent has exited and the pane
 * has fallen back to a login shell." If `pane_current_command` is one of
 * these, refusing to paste prevents leaking the prompt to the shell — the
 * exact failure mode that left val-113 sending review comments to zsh.
 */
const SHELL_COMMANDS = new Set(["zsh", "bash", "sh", "fish", "dash", "ksh", "tcsh", "csh"]);

/**
 * Returns the foreground command in the (first) pane, or null if it can't
 * be determined. Best-effort — failure does not block sends.
 */
async function getPaneForegroundCommand(handleId: string): Promise<string | null> {
  try {
    const out = await tmux(
      "display-message",
      "-t",
      handleId,
      "-p",
      "#{pane_current_command}",
    );
    const trimmed = out.trim();
    return trimmed === "" ? null : trimmed;
  } catch {
    return null;
  }
}

/** How long to wait for a fresh pane's shell to draw its first prompt. */
const SHELL_READY_TIMEOUT_MS = 15_000;
const SHELL_READY_POLL_MS = 250;

/** Common interactive prompt endings: zsh/bash/sh `%` `$` `#`, powerlevel10k/starship `❯`, generic `>`. */
const SHELL_PROMPT_RE = /[%$#>❯]\s*$/;

/**
 * Wait for the pane's shell to finish initializing and draw its prompt.
 * Pasting the launch command into a shell that is still sourcing rc files
 * races cooked-mode tty input: the command text survives, but the trailing
 * Enter sent 300ms later can be swallowed, leaving the entire command fully
 * typed but unexecuted at a zsh `quote>` continuation prompt. The session
 * then reports `working` while no agent ever started (val-337/338/339).
 * Best-effort: on timeout we proceed and rely on verifyLaunchStarted() to
 * recover via Enter retries.
 */
async function waitForShellPrompt(sessionName: string): Promise<void> {
  const deadline = Date.now() + SHELL_READY_TIMEOUT_MS;
  for (;;) {
    try {
      const pane = await tmux("capture-pane", "-t", sessionName, "-p");
      const lastLine = pane
        .split("\n")
        .filter((line) => line.trim() !== "")
        .pop();
      if (lastLine !== undefined && SHELL_PROMPT_RE.test(lastLine)) return;
    } catch {
      // Transient capture failure — keep polling until the deadline.
    }
    if (Date.now() >= deadline) return;
    await sleep(SHELL_READY_POLL_MS);
  }
}

/** Overridable via env for ops tuning and fast tests. */
function launchVerifyAttempts(): number {
  const n = Number(process.env["AO_TMUX_LAUNCH_VERIFY_ATTEMPTS"]);
  return Number.isInteger(n) && n > 0 ? n : 15;
}
function launchVerifyPollMs(): number {
  const n = Number(process.env["AO_TMUX_LAUNCH_VERIFY_POLL_MS"]);
  return Number.isInteger(n) && n > 0 ? n : 600;
}

/**
 * Verify the launch command actually executed: the pane's foreground process
 * must stop being a login shell. If the submitting Enter was lost during
 * shell startup, the command sits fully typed at the prompt — re-sending
 * Enter is exactly the missing keystroke, and harmless otherwise (an empty
 * prompt line or the agent's own input box). Throws if the pane never leaves
 * the shell, so a dead-on-arrival session fails the spawn loudly instead of
 * sitting in `working` forever.
 */
async function verifyLaunchStarted(sessionName: string): Promise<void> {
  const attempts = launchVerifyAttempts();
  for (let attempt = 0; attempt < attempts; attempt++) {
    await sleep(launchVerifyPollMs());
    const foreground = await getPaneForegroundCommand(sessionName);
    // null = probe failed; don't block the spawn on transient tmux errors.
    if (foreground === null || !SHELL_COMMANDS.has(foreground)) return;
    await tmux("send-keys", "-t", sessionName, "Enter");
  }
  throw new Error(
    `launch command never started (pane still at a shell after ${attempts} Enter retries)`,
  );
}

export function create(): Runtime {
  return {
    name: "tmux",

    async create(config: RuntimeCreateConfig): Promise<RuntimeHandle> {
      assertValidSessionId(config.sessionId);
      const sessionName = config.sessionId;

      // Build environment flags: -e KEY=VALUE for each env var.
      // Always forward PATH from the parent process so spawned sessions can
      // find CLI tools like `gh`, `git`, etc. — especially important when
      // the tmux server was started from a non-login context (SSH, launchd).
      const envArgs: string[] = [];
      const env = config.environment ?? {};
      if (!env["PATH"] && process.env["PATH"]) {
        envArgs.push("-e", `PATH=${process.env["PATH"]}`);
      }
      for (const [key, value] of Object.entries(env)) {
        envArgs.push("-e", `${key}=${value}`);
      }

      // Create tmux session in detached mode
      await tmux("new-session", "-d", "-s", sessionName, "-c", config.workspacePath, ...envArgs);

      // Send the launch command — clean up the session if this fails.
      // Use load-buffer + paste-buffer for long commands to avoid tmux/zsh
      // truncation issues (commands >200 chars get mangled by send-keys).
      try {
        // Don't type into the pane until the shell has drawn its prompt —
        // see waitForShellPrompt for the failure mode this prevents.
        await waitForShellPrompt(sessionName);
        if (config.launchCommand.length > 200) {
          const bufferName = `ao-launch-${randomUUID().slice(0, 8)}`;
          const tmpPath = join(tmpdir(), `ao-launch-${randomUUID()}.txt`);
          writeFileSync(tmpPath, config.launchCommand, { encoding: "utf-8", mode: 0o600 });
          try {
            await tmux("load-buffer", "-b", bufferName, tmpPath);
            await tmux("paste-buffer", "-b", bufferName, "-t", sessionName, "-d");
          } finally {
            try {
              unlinkSync(tmpPath);
            } catch {
              /* ignore cleanup errors */
            }
          }
          await sleep(300);
          await tmux("send-keys", "-t", sessionName, "Enter");
        } else {
          await tmux("send-keys", "-t", sessionName, config.launchCommand, "Enter");
        }
        await verifyLaunchStarted(sessionName);
      } catch (err: unknown) {
        try {
          await tmux("kill-session", "-t", sessionName);
        } catch {
          // Best-effort cleanup
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to send launch command to session "${sessionName}": ${msg}`, {
          cause: err,
        });
      }

      return {
        id: sessionName,
        runtimeName: "tmux",
        data: {
          createdAt: Date.now(),
          workspacePath: config.workspacePath,
        },
      };
    },

    async destroy(handle: RuntimeHandle): Promise<void> {
      try {
        await tmux("kill-session", "-t", handle.id);
      } catch {
        // Session may already be dead — that's fine
      }
    },

    async sendMessage(handle: RuntimeHandle, message: string): Promise<void> {
      // Defense-in-depth: refuse to send if the pane has fallen back to a
      // shell. The agent plugin's isProcessRunning check (in session-manager)
      // is the primary guard, but a TOCTOU window remains between that check
      // and the actual paste — and a buggy plugin could return a false
      // positive. This check is run inline with the paste, and protects
      // against the val-113 failure mode where each line of a multi-line
      // prompt was interpreted by zsh as a separate shell command.
      //
      // Best-effort: if we can't determine the foreground command, we send
      // anyway rather than blocking on transient tmux errors.
      const foreground = await getPaneForegroundCommand(handle.id);
      if (foreground !== null && SHELL_COMMANDS.has(foreground)) {
        throw new AgentExitedDuringSendError(handle.id, foreground);
      }

      // Clear any partial input
      await tmux("send-keys", "-t", handle.id, "C-u");

      // For long or multiline messages, use load-buffer + paste-buffer
      // Use randomUUID to avoid temp file collisions on concurrent sends
      const isPaste = message.includes("\n") || message.length > 200;
      if (isPaste) {
        const bufferName = `ao-${randomUUID()}`;
        const tmpPath = join(tmpdir(), `ao-send-${randomUUID()}.txt`);
        writeFileSync(tmpPath, message, { encoding: "utf-8", mode: 0o600 });
        try {
          await tmux("load-buffer", "-b", bufferName, tmpPath);
          await tmux("paste-buffer", "-b", bufferName, "-t", handle.id, "-d");
        } finally {
          // Clean up temp file and tmux buffer (in case paste-buffer failed
          // and the -d flag didn't delete it)
          try {
            unlinkSync(tmpPath);
          } catch {
            // ignore cleanup errors
          }
          try {
            await tmux("delete-buffer", "-b", bufferName);
          } catch {
            // Buffer may already be deleted by -d flag — that's fine
          }
        }
      } else {
        // Use -l (literal) so text like "Enter" or "Space" isn't interpreted
        // as tmux key names
        await tmux("send-keys", "-t", handle.id, "-l", message);
      }

      // Small delay to let tmux process the pasted text before pressing Enter.
      // Without this, Enter can arrive before the text is fully rendered.
      await sleep(300);
      await tmux("send-keys", "-t", handle.id, "Enter");

      // Verify the Enter actually submitted. Claude Code renders a multi-line
      // paste as `[Pasted text #N +M lines]` on the prompt line; if the TUI
      // was still initializing (e.g. SessionStart:resume hook running), the
      // Enter can be swallowed and the paste stays in the input buffer.
      // Detect that case and retry Enter up to a few times.
      if (isPaste) {
        for (let attempt = 0; attempt < 3; attempt++) {
          await sleep(500);
          let pane: string;
          try {
            pane = await tmux("capture-pane", "-t", handle.id, "-p", "-S", "-5");
          } catch {
            return; // pane gone — best-effort
          }
          if (!/\[Pasted text\b/.test(pane)) return;
          await tmux("send-keys", "-t", handle.id, "Enter");
        }
      }
    },

    async sendKeys(handle: RuntimeHandle, keys: string): Promise<void> {
      await tmux("send-keys", "-t", handle.id, keys);
    },

    async getOutput(handle: RuntimeHandle, lines = 50): Promise<string> {
      try {
        return await tmux("capture-pane", "-t", handle.id, "-p", "-S", `-${lines}`);
      } catch {
        return "";
      }
    },

    async isAlive(handle: RuntimeHandle): Promise<boolean> {
      try {
        await tmux("has-session", "-t", handle.id);
        return true;
      } catch {
        return false;
      }
    },

    async getMetrics(handle: RuntimeHandle): Promise<RuntimeMetrics> {
      const createdAt = (handle.data.createdAt as number) ?? Date.now();
      return {
        uptimeMs: Date.now() - createdAt,
      };
    },

    async getAttachInfo(handle: RuntimeHandle): Promise<AttachInfo> {
      return {
        type: "tmux",
        target: handle.id,
        command: `tmux attach -t ${handle.id}`,
      };
    },
  };
}

export default { manifest, create } satisfies PluginModule<Runtime>;
