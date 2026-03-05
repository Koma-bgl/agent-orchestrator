import {
  shellEscape,
  readLastJsonlEntry,
  DEFAULT_READY_THRESHOLD_MS,
  type Agent,
  type AgentSessionInfo,
  type AgentLaunchConfig,
  type ActivityDetection,
  type ActivityState,
  type CostEstimate,
  type PluginModule,
  type ProjectConfig,
  type RuntimeHandle,
  type Session,
  type WorkspaceHooksConfig,
} from "@composio/ao-core";
import { execFile } from "node:child_process";
import { readdir, readFile, stat, open, writeFile, mkdir, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// =============================================================================
// Metadata Updater Hook Script
// =============================================================================

/** Hook script content that updates session metadata on git/gh commands */
const METADATA_UPDATER_SCRIPT = `#!/usr/bin/env bash
# Metadata Updater Hook for Agent Orchestrator
#
# This PostToolUse hook automatically updates session metadata when:
# - gh pr create: extracts PR URL and writes to metadata
# - git checkout -b / git switch -c: extracts branch name and writes to metadata
# - gh pr merge: updates status to "merged"

set -euo pipefail

# Configuration
AO_DATA_DIR="\${AO_DATA_DIR:-$HOME/.ao-sessions}"

# Read hook input from stdin
input=$(cat)

# Extract fields from JSON (using jq if available, otherwise basic parsing)
if command -v jq &>/dev/null; then
  tool_name=$(echo "$input" | jq -r '.tool_name // empty')
  command=$(echo "$input" | jq -r '.tool_input.command // empty')
  output=$(echo "$input" | jq -r '.tool_response // empty')
  exit_code=$(echo "$input" | jq -r '.exit_code // 0')
else
  # Fallback: basic JSON parsing without jq
  tool_name=$(echo "$input" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4 || echo "")
  command=$(echo "$input" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4 || echo "")
  output=$(echo "$input" | grep -o '"tool_response"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4 || echo "")
  exit_code=$(echo "$input" | grep -o '"exit_code"[[:space:]]*:[[:space:]]*[0-9]*' | grep -o '[0-9]*$' || echo "0")
fi

# Only process successful commands (exit code 0)
if [[ "$exit_code" -ne 0 ]]; then
  echo '{}'
  exit 0
fi

# Only process Bash tool calls
if [[ "$tool_name" != "Bash" ]]; then
  echo '{}' # Empty JSON output
  exit 0
fi

# Validate AO_SESSION is set
if [[ -z "\${AO_SESSION:-}" ]]; then
  echo '{"systemMessage": "AO_SESSION environment variable not set, skipping metadata update"}'
  exit 0
fi

# Construct metadata file path
# AO_DATA_DIR is already set to the project-specific sessions directory
metadata_file="$AO_DATA_DIR/$AO_SESSION"

# Ensure metadata file exists
if [[ ! -f "$metadata_file" ]]; then
  echo '{"systemMessage": "Metadata file not found: '"$metadata_file"'"}'
  exit 0
fi

# Update a single key in metadata
update_metadata_key() {
  local key="$1"
  local value="$2"

  # Create temp file
  local temp_file="\${metadata_file}.tmp"

  # Escape special sed characters in value (& | / \\)
  local escaped_value=$(echo "$value" | sed 's/[&|\\/]/\\\\&/g')

  # Check if key already exists
  if grep -q "^$key=" "$metadata_file" 2>/dev/null; then
    # Update existing key
    sed "s|^$key=.*|$key=$escaped_value|" "$metadata_file" > "$temp_file"
  else
    # Append new key
    cp "$metadata_file" "$temp_file"
    echo "$key=$value" >> "$temp_file"
  fi

  # Atomic replace
  mv "$temp_file" "$metadata_file"
}

# ============================================================================
# Command Detection and Parsing
# ============================================================================

# Detect: gh pr create
if [[ "$command" =~ ^gh[[:space:]]+pr[[:space:]]+create ]]; then
  # Extract PR URL from output
  pr_url=$(echo "$output" | grep -Eo 'https://github[.]com/[^/]+/[^/]+/pull/[0-9]+' | head -1)

  if [[ -n "$pr_url" ]]; then
    update_metadata_key "pr" "$pr_url"
    update_metadata_key "status" "pr_open"
    echo '{"systemMessage": "Updated metadata: PR created at '"$pr_url"'"}'
    exit 0
  fi
fi

# Detect: git checkout -b <branch> or git switch -c <branch>
if [[ "$command" =~ ^git[[:space:]]+checkout[[:space:]]+-b[[:space:]]+([^[:space:]]+) ]] || \\
   [[ "$command" =~ ^git[[:space:]]+switch[[:space:]]+-c[[:space:]]+([^[:space:]]+) ]]; then
  branch="\${BASH_REMATCH[1]}"

  if [[ -n "$branch" ]]; then
    update_metadata_key "branch" "$branch"
    echo '{"systemMessage": "Updated metadata: branch = '"$branch"'"}'
    exit 0
  fi
fi

# Detect: git checkout <branch> (without -b) or git switch <branch> (without -c)
# Only update if the branch name looks like a feature branch (contains / or -)
if [[ "$command" =~ ^git[[:space:]]+checkout[[:space:]]+([^[:space:]-]+[/-][^[:space:]]+) ]] || \\
   [[ "$command" =~ ^git[[:space:]]+switch[[:space:]]+([^[:space:]-]+[/-][^[:space:]]+) ]]; then
  branch="\${BASH_REMATCH[1]}"

  # Avoid updating for checkout of commits/tags, remote refs, or base branches
  if [[ -n "$branch" && "$branch" != "HEAD" && \
        ! "$branch" =~ ^origin/ && \
        "$branch" != "main" && "$branch" != "master" && \
        "$branch" != "develop" && "$branch" != "dev" ]]; then
    update_metadata_key "branch" "$branch"
    echo '{"systemMessage": "Updated metadata: branch = '"$branch"'"}'
    exit 0
  fi
fi

# Detect: gh pr merge
if [[ "$command" =~ ^gh[[:space:]]+pr[[:space:]]+merge ]]; then
  update_metadata_key "status" "merged"
  echo '{"systemMessage": "Updated metadata: status = merged"}'
  exit 0
fi

# No matching command, exit silently
echo '{}'
exit 0
`;

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "claude-code",
  slot: "agent" as const,
  description: "Agent plugin: Claude Code CLI",
  version: "0.1.0",
};

// =============================================================================
// JSONL Helpers
// =============================================================================

/**
 * Convert a workspace path to Claude's project directory path.
 * Claude stores sessions at ~/.claude/projects/{encoded-path}/
 *
 * Verified against Claude Code's actual encoding (as of v1.x):
 * the path has its leading / stripped, then all / and . are replaced with -.
 * e.g. /Users/dev/.worktrees/ao → Users-dev--worktrees-ao
 *
 * If Claude Code changes its encoding scheme this will silently break
 * introspection. The path can be validated at runtime by checking whether
 * the resulting directory exists.
 *
 * Exported for testing purposes.
 */
export function toClaudeProjectPath(workspacePath: string): string {
  // Handle Windows drive letters (C:\Users\... → C-Users-...)
  const normalized = workspacePath.replace(/\\/g, "/");
  // Claude Code replaces / and . with - (keeping the leading slash as a leading -)
  return normalized.replace(/:/g, "").replace(/[/.]/g, "-");
}

/** Find the most recently modified .jsonl session file in a directory */
async function findLatestSessionFile(projectDir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    return null;
  }

  const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl") && !f.startsWith("agent-"));
  if (jsonlFiles.length === 0) return null;

  // Sort by mtime descending
  const withStats = await Promise.all(
    jsonlFiles.map(async (f) => {
      const fullPath = join(projectDir, f);
      try {
        const s = await stat(fullPath);
        return { path: fullPath, mtime: s.mtimeMs };
      } catch {
        return { path: fullPath, mtime: 0 };
      }
    }),
  );
  withStats.sort((a, b) => b.mtime - a.mtime);
  return withStats[0]?.path ?? null;
}

interface JsonlLine {
  type?: string;
  summary?: string;
  message?: { content?: string; role?: string };
  // Tool use fields (for progress extraction)
  tool?: string;
  name?: string;
  input?: Record<string, unknown>;
  // Cost/usage fields
  costUSD?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
}

/**
 * Read only the last chunk of a JSONL file to extract the last entry's type
 * and the file's modification time. This is optimized for polling — it avoids
 * reading the entire file (which `getSessionInfo()` does for full cost/summary).
 * Now uses the shared readLastJsonlEntry utility from @composio/ao-core.
 */

/**
 * Parse only the last `maxBytes` of a JSONL file.
 * Summaries and recent activity are always near the end, so reading the whole
 * file (which can be 100MB+) is wasteful. For files smaller than maxBytes,
 * readFile is used directly. For large files, only the tail is read via a
 * file handle to avoid loading the entire file into memory.
 */
async function parseJsonlFileTail(filePath: string, maxBytes = 131_072): Promise<JsonlLine[]> {
  let content: string;
  let offset: number;
  try {
    const { size = 0 } = await stat(filePath);
    offset = Math.max(0, size - maxBytes);
    if (offset === 0) {
      // Small file (or unknown size) — read it whole
      content = await readFile(filePath, "utf-8");
    } else {
      // Large file — read only the tail via a file handle
      const handle = await open(filePath, "r");
      try {
        const length = size - offset;
        const buffer = Buffer.allocUnsafe(length);
        await handle.read(buffer, 0, length, offset);
        content = buffer.toString("utf-8");
      } finally {
        await handle.close();
      }
    }
  } catch {
    return [];
  }
  // Skip potentially truncated first line only when we started mid-file.
  // If offset === 0 we read from the start so the first line is complete.
  const firstNewline = content.indexOf("\n");
  const safeContent =
    offset > 0 && firstNewline >= 0 ? content.slice(firstNewline + 1) : content;
  const lines: JsonlLine[] = [];
  for (const line of safeContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        lines.push(parsed as JsonlLine);
      }
    } catch {
      // Skip malformed lines
    }
  }
  return lines;
}

/** Extract auto-generated summary from JSONL (last "summary" type entry) */
function extractSummary(
  lines: JsonlLine[],
): { summary: string; isFallback: boolean } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line?.type === "summary" && line.summary) {
      return { summary: line.summary, isFallback: false };
    }
  }
  // Fallback: first user message truncated to 120 chars
  for (const line of lines) {
    if (
      line?.type === "user" &&
      line.message?.content &&
      typeof line.message.content === "string"
    ) {
      const msg = line.message.content.trim();
      if (msg.length > 0) {
        return {
          summary: msg.length > 120 ? msg.substring(0, 120) + "..." : msg,
          isFallback: true,
        };
      }
    }
  }
  return null;
}

/** Aggregate cost estimate from JSONL usage events */
function extractCost(lines: JsonlLine[]): CostEstimate | undefined {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalCost = 0;

  for (const line of lines) {
    // Handle direct cost fields — prefer costUSD; only use estimatedCostUsd
    // as fallback to avoid double-counting when both are present.
    if (typeof line.costUSD === "number") {
      totalCost += line.costUSD;
    } else if (typeof line.estimatedCostUsd === "number") {
      totalCost += line.estimatedCostUsd;
    }
    // Handle token counts — prefer the structured `usage` object when present;
    // only fall back to flat `inputTokens`/`outputTokens` fields to avoid
    // double-counting if a line contains both.
    if (line.usage) {
      inputTokens += line.usage.input_tokens ?? 0;
      inputTokens += line.usage.cache_read_input_tokens ?? 0;
      inputTokens += line.usage.cache_creation_input_tokens ?? 0;
      outputTokens += line.usage.output_tokens ?? 0;
    } else {
      if (typeof line.inputTokens === "number") {
        inputTokens += line.inputTokens;
      }
      if (typeof line.outputTokens === "number") {
        outputTokens += line.outputTokens;
      }
    }
  }

  if (inputTokens === 0 && outputTokens === 0 && totalCost === 0) {
    return undefined;
  }

  // Rough estimate when no direct cost data — uses Sonnet 4.5 pricing as a
  // baseline. Will be inaccurate for other models (Opus, Haiku) but provides
  // a useful order-of-magnitude signal. TODO: make pricing configurable or
  // infer from model field in JSONL.
  if (totalCost === 0 && (inputTokens > 0 || outputTokens > 0)) {
    totalCost = (inputTokens / 1_000_000) * 3.0 + (outputTokens / 1_000_000) * 15.0;
  }

  return { inputTokens, outputTokens, estimatedCostUsd: totalCost };
}

/**
 * Extract a human-readable progress description from the last few JSONL entries.
 * Scans backwards to find the most recent actionable entry (tool_use, assistant thinking, etc.)
 * and produces a short description like "Reading src/index.ts" or "Running tests".
 */
function extractProgressText(lines: JsonlLine[]): string | null {
  // Scan backwards to find last meaningful entry
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line?.type) continue;

    if (line.type === "tool_use") {
      const toolName = line.tool ?? line.name ?? "tool";
      return formatToolProgress(toolName, line.input);
    }

    if (line.type === "tool_result") {
      // Look further back for the tool_use that triggered this result
      continue;
    }

    if (line.type === "assistant") {
      // Agent is thinking / composing a response
      return "Thinking…";
    }

    if (line.type === "progress") {
      // Direct progress message from Claude Code
      const msg =
        typeof line.message?.content === "string" ? line.message.content : null;
      return msg ? truncateProgress(msg) : "Working…";
    }

    if (line.type === "summary") {
      return null; // Session is done, no active progress
    }

    if (line.type === "result") {
      return null; // Agent completed
    }
  }
  return null;
}

/** Format a tool use into a human-readable progress string */
function formatToolProgress(
  toolName: string,
  input?: Record<string, unknown>,
): string {
  const name = toolName.toLowerCase();

  if (name === "read" || name === "read_file") {
    const path = typeof input?.file_path === "string" ? shortenPath(input.file_path) : null;
    return path ? `Reading ${path}` : "Reading file…";
  }

  if (name === "write" || name === "write_file") {
    const path = typeof input?.file_path === "string" ? shortenPath(input.file_path) : null;
    return path ? `Writing ${path}` : "Writing file…";
  }

  if (name === "edit" || name === "edit_file") {
    const path = typeof input?.file_path === "string" ? shortenPath(input.file_path) : null;
    return path ? `Editing ${path}` : "Editing file…";
  }

  if (name === "bash" || name === "execute_command") {
    const cmd = typeof input?.command === "string" ? input.command : null;
    if (cmd) {
      // Extract first meaningful word(s) from command
      const short = cmd.split("\n")[0]?.trim() ?? cmd;
      return `Running: ${truncateProgress(short, 60)}`;
    }
    return "Running command…";
  }

  if (name === "glob" || name === "search" || name === "grep") {
    return "Searching files…";
  }

  if (name === "task" || name === "todowrite") {
    return "Planning…";
  }

  // Generic fallback: capitalize tool name
  const display = toolName.charAt(0).toUpperCase() + toolName.slice(1);
  return `Using ${display}…`;
}

/** Shorten a file path to just the last 2 segments */
function shortenPath(filePath: string): string {
  const parts = filePath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= 2) return parts.join("/");
  return "…/" + parts.slice(-2).join("/");
}

/** Truncate a progress string to a max length */
function truncateProgress(text: string, maxLen = 80): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen - 1) + "…";
}

// =============================================================================
// Process Detection
// =============================================================================

/**
 * Check if a process named "claude" is running in the given runtime handle's context.
 * Uses ps to find processes by TTY (for tmux) or by PID.
 */
async function findClaudeProcess(handle: RuntimeHandle): Promise<number | null> {
  try {
    // For tmux runtime, get the pane TTY and find claude on it
    if (handle.runtimeName === "tmux" && handle.id) {
      const { stdout: ttyOut } = await execFileAsync(
        "tmux",
        ["list-panes", "-t", handle.id, "-F", "#{pane_tty}"],
        { timeout: 30_000 },
      );
      // Iterate all pane TTYs (multi-pane sessions) — succeed on any match
      const ttys = ttyOut
        .trim()
        .split("\n")
        .map((t) => t.trim())
        .filter(Boolean);
      if (ttys.length === 0) return null;

      // Use `args` instead of `comm` so we can match the CLI name even when
      // the process runs via a wrapper (e.g. node, python).  `comm` would
      // report "node" instead of "claude" in those cases.
      const { stdout: psOut } = await execFileAsync("ps", ["-eo", "pid,tty,args"], {
        timeout: 30_000,
      });
      const ttySet = new Set(ttys.map((t) => t.replace(/^\/dev\//, "")));
      // Match "claude" as a word boundary — prevents false positives on
      // names like "claude-code" or paths that merely contain the substring.
      const processRe = /(?:^|\/)claude(?:\s|$)/;
      for (const line of psOut.split("\n")) {
        const cols = line.trimStart().split(/\s+/);
        if (cols.length < 3 || !ttySet.has(cols[1] ?? "")) continue;
        const args = cols.slice(2).join(" ");
        if (processRe.test(args)) {
          return parseInt(cols[0] ?? "0", 10);
        }
      }
      return null;
    }

    // For process runtime, check if the PID stored in handle data is alive
    const rawPid = handle.data["pid"];
    const pid = typeof rawPid === "number" ? rawPid : Number(rawPid);
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0); // Signal 0 = check existence
        return pid;
      } catch (err: unknown) {
        // EPERM means the process exists but we lack permission to signal it
        if (err instanceof Error && "code" in err && err.code === "EPERM") {
          return pid;
        }
        return null;
      }
    }

    // No reliable way to identify the correct process for this session
    return null;
  } catch {
    return null;
  }
}

// =============================================================================
// Terminal Output Patterns for detectActivity
// =============================================================================

/** Classify Claude Code's activity state from terminal output (pure, sync). */
function classifyTerminalOutput(terminalOutput: string): ActivityState {
  // Empty output — can't determine state
  if (!terminalOutput.trim()) return "idle";

  const lines = terminalOutput.trim().split("\n");
  const lastLine = lines[lines.length - 1]?.trim() ?? "";

  // Check the last line FIRST — if the prompt is visible, the agent is idle
  // regardless of historical output (e.g. "Reading file..." from earlier).
  // The ❯ is Claude Code's prompt character.
  if (/^[❯>$#]\s*$/.test(lastLine)) return "idle";

  // Check the bottom of the buffer for permission prompts BEFORE checking
  // full-buffer active indicators. Historical "Thinking"/"Reading" text in
  // the buffer must not override a current permission prompt at the bottom.
  const tail = lines.slice(-5).join("\n");
  if (/Do you want to proceed\?/i.test(tail)) return "waiting_input";
  if (/\(Y\)es.*\(N\)o/i.test(tail)) return "waiting_input";
  if (/bypass.*permissions/i.test(tail)) return "waiting_input";

  // Check for OAuth/auth errors — these mean the session is dead and needs
  // human intervention (token refresh or `claude setup-token`).
  if (/OAuth token has expired/i.test(tail)) return "blocked";
  if (/authentication_error/i.test(tail)) return "blocked";
  if (/Please run \/login/i.test(tail)) return "blocked";

  // Everything else is "active" — the agent is processing, waiting for
  // output, or showing content. Specific patterns (e.g. "esc to interrupt",
  // "Thinking", "Reading") all map to "active" so no need to check them
  // individually.
  return "active";
}

// =============================================================================
// Hook Setup Helper
// =============================================================================

/**
 * Shared helper to setup PostToolUse hooks in a workspace.
 * Writes metadata-updater.sh script and updates settings.json.
 *
 * @param workspacePath - Path to the workspace directory
 * @param hookCommand - Command string for the hook (can use variables like $CLAUDE_PROJECT_DIR)
 */
async function setupHookInWorkspace(workspacePath: string, hookCommand: string): Promise<void> {
  const claudeDir = join(workspacePath, ".claude");
  const settingsPath = join(claudeDir, "settings.json");
  const hookScriptPath = join(claudeDir, "metadata-updater.sh");

  // Create .claude directory if it doesn't exist
  try {
    await mkdir(claudeDir, { recursive: true });
  } catch {
    // Directory might already exist
  }

  // Write the metadata updater script
  await writeFile(hookScriptPath, METADATA_UPDATER_SCRIPT, "utf-8");
  await chmod(hookScriptPath, 0o755); // Make executable

  // Read existing settings if present
  let existingSettings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      const content = await readFile(settingsPath, "utf-8");
      existingSettings = JSON.parse(content) as Record<string, unknown>;
    } catch {
      // Invalid JSON or read error — start fresh
    }
  }

  // Merge hooks configuration
  const hooks = (existingSettings["hooks"] as Record<string, unknown>) ?? {};
  const postToolUse = (hooks["PostToolUse"] as Array<unknown>) ?? [];

  // Check if our hook is already configured
  let hookIndex = -1;
  let hookDefIndex = -1;
  for (let i = 0; i < postToolUse.length; i++) {
    const hook = postToolUse[i];
    if (typeof hook !== "object" || hook === null || Array.isArray(hook)) continue;
    const h = hook as Record<string, unknown>;
    const hooksList = h["hooks"];
    if (!Array.isArray(hooksList)) continue;
    for (let j = 0; j < hooksList.length; j++) {
      const hDef = hooksList[j];
      if (typeof hDef !== "object" || hDef === null || Array.isArray(hDef)) continue;
      const def = hDef as Record<string, unknown>;
      if (typeof def["command"] === "string" && def["command"].includes("metadata-updater.sh")) {
        hookIndex = i;
        hookDefIndex = j;
        break;
      }
    }
    if (hookIndex >= 0) break;
  }

  // Add or update our hook
  if (hookIndex === -1) {
    // No metadata hook exists, add it
    postToolUse.push({
      matcher: "Bash",
      hooks: [
        {
          type: "command",
          command: hookCommand,
          timeout: 5000,
        },
      ],
    });
  } else {
    // Hook exists, update the command
    const hook = postToolUse[hookIndex] as Record<string, unknown>;
    const hooksList = hook["hooks"] as Array<Record<string, unknown>>;
    hooksList[hookDefIndex]["command"] = hookCommand;
  }

  hooks["PostToolUse"] = postToolUse;
  existingSettings["hooks"] = hooks;

  // Write updated settings
  await writeFile(settingsPath, JSON.stringify(existingSettings, null, 2) + "\n", "utf-8");
}

/**
 * Default allowed tools for automated agent sessions.
 * These are written to settings.local.json in the workspace so that
 * --permission-mode dontAsk doesn't deny critical commands like gh, git, npm.
 */
/**
 * Tools to auto-allow when running in --permission-mode dontAsk.
 *
 * We use "Bash" (no pattern) to allow ALL bash commands because:
 *  1. Pattern matching breaks on complex shell constructs (heredocs, subshells,
 *     env-var prefixes like GIT_AUTHOR_NAME=... git commit)
 *  2. The agent is a trusted automated process — restricting specific command
 *     prefixes adds no real security since git/gh/npm are all equally powerful
 *  3. Playing whack-a-mole with patterns is fragile and causes CI/PR failures
 */
const DEFAULT_ALLOWED_TOOLS: string[] = [
  // Allow all bash commands — agent is trusted, pattern matching is too fragile
  "Bash",
  // File editing tools
  "Edit",
  "Write",
  "Read",
  "Glob",
  "Grep",
  "NotebookEdit",
  // Agent delegation
  "Task",
  // Web tools
  "WebFetch",
  "WebSearch",
];

/**
 * Merge DEFAULT_ALLOWED_TOOLS into a settings.local.json file.
 * Creates the file if missing, or adds new tools to the existing allowlist
 * (preserves any user-added entries while ensuring required tools are present).
 */
async function mergeAllowlistInto(settingsPath: string): Promise<void> {
  const dir = dirname(settingsPath);
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    // Directory might already exist
  }

  // Read existing settings if present
  let existing: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      existing = JSON.parse(await readFile(settingsPath, "utf-8")) as Record<string, unknown>;
    } catch {
      // Corrupted file — overwrite
    }
  }

  // Merge: ensure all DEFAULT_ALLOWED_TOOLS are in the allowlist
  const perms = (existing.permissions ?? {}) as Record<string, unknown>;
  const currentAllow = Array.isArray(perms.allow) ? (perms.allow as string[]) : [];
  const merged = [...new Set([...currentAllow, ...DEFAULT_ALLOWED_TOOLS])];

  // Skip write if nothing changed
  if (merged.length === currentAllow.length && merged.every((t) => currentAllow.includes(t))) {
    return;
  }

  const settings = {
    ...existing,
    permissions: {
      ...perms,
      allow: merged,
    },
  };

  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

/**
 * Resolve the git repo root from a path (handles worktrees).
 * In a worktree, `git rev-parse --show-toplevel` returns the worktree root,
 * but `git rev-parse --git-common-dir` returns the main repo's .git dir,
 * from which we can derive the main repo root.
 */
async function resolveGitRepoRoot(workspacePath: string): Promise<string | null> {
  try {
    // Get the common .git directory (shared across worktrees)
    const { stdout } = await execFileAsync("git", ["rev-parse", "--git-common-dir"], {
      cwd: workspacePath,
      timeout: 5000,
    });
    const gitCommonDir = stdout.trim();
    if (!gitCommonDir || gitCommonDir === ".git") {
      // Not a worktree — return the workspace path itself
      return workspacePath;
    }
    // gitCommonDir is something like /Users/x/repo/.git — parent is the repo root
    const resolved = resolve(workspacePath, gitCommonDir);
    return dirname(resolved);
  } catch {
    return null;
  }
}

/**
 * Ensure permissions allowlist for --permission-mode dontAsk.
 * Writes to ALL relevant locations so Claude Code finds it:
 *   1. Global:    ~/.claude/settings.local.json — always found
 *   2. Repo root: {mainRepo}/.claude/settings.local.json — where Claude Code looks
 *   3. Workspace: {workspacePath}/.claude/settings.local.json — if different from repo root
 *
 * Claude Code merges allow lists from all levels, so all contribute.
 */
async function ensureLocalSettings(workspacePath: string): Promise<void> {
  // 1. Global settings — always found by Claude Code
  const globalSettingsPath = join(homedir(), ".claude", "settings.local.json");
  await mergeAllowlistInto(globalSettingsPath);

  // 2. Main git repo root — where Claude Code determines the project
  const repoRoot = await resolveGitRepoRoot(workspacePath);
  if (repoRoot && repoRoot !== workspacePath) {
    try {
      await mergeAllowlistInto(join(repoRoot, ".claude", "settings.local.json"));
    } catch {
      // Non-fatal
    }
  }

  // 3. Per-workspace settings — belt-and-suspenders for worktrees
  try {
    await mergeAllowlistInto(join(workspacePath, ".claude", "settings.local.json"));
  } catch {
    // Non-fatal — global + repo root settings should suffice
  }
}

// =============================================================================
// Agent Implementation
// =============================================================================

function createClaudeCodeAgent(): Agent {
  return {
    name: "claude-code",
    processName: "claude",

    getLaunchCommand(config: AgentLaunchConfig): string {
      // Note: CLAUDECODE is unset via getEnvironment() (set to ""), not here.
      // This command must be safe for both shell and execFile contexts.
      const parts: string[] = ["claude"];

      if (config.permissions === "skip") {
        parts.push("--dangerously-skip-permissions");
      } else if (config.permissions === "dontAsk" || config.permissions === "acceptEdits") {
        parts.push("--permission-mode", config.permissions);
      }

      if (config.model) {
        parts.push("--model", shellEscape(config.model));
      }

      if (config.systemPromptFile) {
        // Use shell command substitution to read from file at launch time.
        // This avoids tmux truncation when inlining 2000+ char prompts.
        // The double quotes allow $() expansion; inner path is single-quoted for safety.
        parts.push("--append-system-prompt", `"$(cat ${shellEscape(config.systemPromptFile)})"`);
      } else if (config.systemPrompt) {
        parts.push("--append-system-prompt", shellEscape(config.systemPrompt));
      }

      if (config.prompt) {
        parts.push("-p", shellEscape(config.prompt));
      }

      return parts.join(" ");
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};

      // Unset CLAUDECODE to avoid nested agent conflicts
      env["CLAUDECODE"] = "";

      // Set session info for introspection
      env["AO_SESSION_ID"] = config.sessionId;

      // NOTE: AO_PROJECT_ID is NOT set here - it's the caller's responsibility
      // to set it based on their metadata path scheme:
      // - spawn.ts sets it to projectId for project-specific directories
      // - start.ts omits it for orchestrator (flat directories)
      // - session manager omits it (flat directories)

      if (config.issueId) {
        env["AO_ISSUE_ID"] = config.issueId;
      }

      // Pass OAuth token for headless/server use (avoids daily re-login).
      // Priority: config oauthToken > existing CLAUDE_CODE_OAUTH_TOKEN env var.
      // Supports ${ENV_VAR} syntax for referencing environment variables.
      const oauthToken = config.projectConfig.agentConfig?.oauthToken as
        | string
        | undefined;
      if (oauthToken) {
        const resolved = oauthToken.replace(
          /\$\{(\w+)\}/g,
          (_match: string, varName: string) => process.env[varName] ?? "",
        );
        if (resolved) {
          env["CLAUDE_CODE_OAUTH_TOKEN"] = resolved;
        }
      } else if (process.env["CLAUDE_CODE_OAUTH_TOKEN"]) {
        // Forward existing env var if no config override
        env["CLAUDE_CODE_OAUTH_TOKEN"] = process.env["CLAUDE_CODE_OAUTH_TOKEN"];
      }

      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      return classifyTerminalOutput(terminalOutput);
    },

    async isProcessRunning(handle: RuntimeHandle): Promise<boolean> {
      const pid = await findClaudeProcess(handle);
      return pid !== null;
    },

    async getActivityState(
      session: Session,
      readyThresholdMs?: number,
    ): Promise<ActivityDetection | null> {
      const threshold = readyThresholdMs ?? DEFAULT_READY_THRESHOLD_MS;

      // Check if process is running first
      const exitedAt = new Date();
      if (!session.runtimeHandle) return { state: "exited", timestamp: exitedAt };
      const running = await this.isProcessRunning(session.runtimeHandle);
      if (!running) return { state: "exited", timestamp: exitedAt };

      // Process is running - check JSONL session file for activity
      if (!session.workspacePath) {
        // No workspace path — cannot determine activity without it
        return null;
      }

      const projectPath = toClaudeProjectPath(session.workspacePath);
      const projectDir = join(homedir(), ".claude", "projects", projectPath);

      const sessionFile = await findLatestSessionFile(projectDir);
      if (!sessionFile) {
        // No session file found — cannot determine activity
        return null;
      }

      const entry = await readLastJsonlEntry(sessionFile);
      if (!entry) {
        // Empty file or read error — cannot determine activity
        return null;
      }

      const ageMs = Date.now() - entry.modifiedAt.getTime();
      const timestamp = entry.modifiedAt;

      switch (entry.lastType) {
        case "user":
        case "tool_use":
        case "progress":
          return { state: ageMs > threshold ? "idle" : "active", timestamp };

        case "assistant":
        case "system":
        case "summary":
        case "result":
          return { state: ageMs > threshold ? "idle" : "ready", timestamp };

        case "permission_request":
          return { state: "waiting_input", timestamp };

        case "error":
          return { state: "blocked", timestamp };

        default:
          return { state: ageMs > threshold ? "idle" : "active", timestamp };
      }
    },

    async getSessionInfo(session: Session): Promise<AgentSessionInfo | null> {
      if (!session.workspacePath) return null;

      // Build the Claude project directory path
      const projectPath = toClaudeProjectPath(session.workspacePath);
      const projectDir = join(homedir(), ".claude", "projects", projectPath);

      // Find the latest session JSONL file
      const sessionFile = await findLatestSessionFile(projectDir);
      if (!sessionFile) return null;

      // Parse only the tail — summaries are always near the end, files can be 100MB+
      const lines = await parseJsonlFileTail(sessionFile);
      if (lines.length === 0) return null;

      // Extract session ID from filename
      const agentSessionId = basename(sessionFile, ".jsonl");

      const summaryResult = extractSummary(lines);
      return {
        summary: summaryResult?.summary ?? null,
        summaryIsFallback: summaryResult?.isFallback,
        agentSessionId,
        cost: extractCost(lines),
        progressText: extractProgressText(lines),
      };
    },

    async getRestoreCommand(session: Session, project: ProjectConfig): Promise<string | null> {
      if (!session.workspacePath) return null;

      // Find Claude's project directory for this workspace
      const projectPath = toClaudeProjectPath(session.workspacePath);
      const projectDir = join(homedir(), ".claude", "projects", projectPath);

      // Find the latest session JSONL file
      const sessionFile = await findLatestSessionFile(projectDir);
      if (!sessionFile) return null;

      // Extract session UUID from filename (e.g. "abc123-def456.jsonl" → "abc123-def456")
      const sessionUuid = basename(sessionFile, ".jsonl");
      if (!sessionUuid) return null;

      // Build resume command
      const parts: string[] = ["claude", "--resume", shellEscape(sessionUuid)];

      if (project.agentConfig?.permissions === "skip") {
        parts.push("--dangerously-skip-permissions");
      } else if (
        project.agentConfig?.permissions === "dontAsk" ||
        project.agentConfig?.permissions === "acceptEdits"
      ) {
        parts.push("--permission-mode", project.agentConfig.permissions);
      }

      if (project.agentConfig?.model) {
        parts.push("--model", shellEscape(project.agentConfig.model as string));
      }

      return parts.join(" ");
    },

    async preLaunchSetup(workspacePath: string): Promise<void> {
      // Write permissions allowlist BEFORE agent starts — avoids race condition
      // where agent tries gh/git commands before settings.local.json exists
      await ensureLocalSettings(workspacePath);
    },

    async setupWorkspaceHooks(workspacePath: string, _config: WorkspaceHooksConfig): Promise<void> {
      // Use absolute path for hook command (specific to this workspace)
      const hookScriptPath = join(workspacePath, ".claude", "metadata-updater.sh");
      await setupHookInWorkspace(workspacePath, hookScriptPath);
      // Also ensure permissions (belt-and-suspenders)
      await ensureLocalSettings(workspacePath);
    },

    async postLaunchSetup(session: Session): Promise<void> {
      if (!session.workspacePath) return;

      // Use absolute path for hook command (specific to this workspace)
      const hookScriptPath = join(session.workspacePath, ".claude", "metadata-updater.sh");
      await setupHookInWorkspace(session.workspacePath, hookScriptPath);
    },
  };
}

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createClaudeCodeAgent();
}

export default { manifest, create } satisfies PluginModule<Agent>;
