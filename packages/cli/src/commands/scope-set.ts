/**
 * `ao scope set` — agent self-declares the file scope of the current session.
 *
 * Writes the comma-joined glob list to `metadata.scopeGlobs` for the session
 * whose `worktree` matches the current working directory. The agent is expected
 * to call this immediately after reading the ticket, before it starts coding,
 * so that `ao scope-check` can verify the diff before `gh pr create`.
 *
 * Usage:
 *   ao scope set "src/sports/**"
 *   ao scope set "src/sports/**, !src/sports/apis/**"
 *   ao scope set src/sports/** '!src/sports/apis/**'
 */

import chalk from "chalk";
import type { Command } from "commander";
import {
  loadConfig,
  findSessionByCwd,
  updateMetadata,
  type FoundSession,
  type OrchestratorConfig,
} from "@composio/ao-core";

export interface RunScopeSetOpts {
  cwd: string;
  globs: string[];
  /** Test injection — defaults to loadConfig + findSessionByCwd. */
  resolveSession?: (cwd: string) => FoundSession | null;
  /** Test injection — defaults to writing into metadata.scopeGlobs. */
  writeScope?: (session: FoundSession, scopeGlobs: string) => void;
}

export interface ScopeSetResult {
  exitCode: 0 | 1;
  message: string;
}

function defaultResolver(cwd: string): FoundSession | null {
  let config: OrchestratorConfig;
  try {
    config = loadConfig();
  } catch {
    return null;
  }
  return findSessionByCwd(config, cwd);
}

function defaultWriter(session: FoundSession, scopeGlobs: string): void {
  updateMetadata(session.sessionsDir, session.sessionId, { scopeGlobs });
}

/** Testable core (no process.exit, no console output). */
export async function runScopeSet(opts: RunScopeSetOpts): Promise<ScopeSetResult> {
  const cleaned = Array.from(
    new Set(opts.globs.map((g) => g.trim()).filter((g) => g.length > 0)),
  );

  if (cleaned.length === 0) {
    return {
      exitCode: 1,
      message: "scope set requires at least one glob argument.",
    };
  }

  const resolveSession = opts.resolveSession ?? defaultResolver;
  const writeScope = opts.writeScope ?? defaultWriter;

  const session = resolveSession(opts.cwd);
  if (!session) {
    return {
      exitCode: 1,
      message:
        `No session found for current directory: ${opts.cwd}\n` +
        `Run this from inside a session worktree.`,
    };
  }

  const scopeGlobs = cleaned.join(",");
  writeScope(session, scopeGlobs);

  return {
    exitCode: 0,
    message:
      `Scope set for session ${session.sessionId}:\n` +
      cleaned.map((g) => `  ${g}`).join("\n") +
      `\n\nNow code, then run \`ao scope-check\` before \`gh pr create\`.`,
  };
}

export function registerScopeSet(program: Command): void {
  program
    .command("scope-set <globs...>")
    .description(
      "Declare the scope this session is allowed to modify. Sets metadata.scopeGlobs. " +
        "Pass multiple space-separated globs or one comma-joined string. Negation supported with leading `!`.",
    )
    .action(async (globs: string[]) => {
      // Allow either: ao scope-set "src/foo/**, !src/bar/**"
      //         or:   ao scope-set src/foo/** '!src/bar/**'
      const flat = globs
        .flatMap((g) => g.split(","))
        .map((g) => g.trim())
        .filter(Boolean);
      const result = await runScopeSet({ cwd: process.cwd(), globs: flat });
      if (result.exitCode === 0) {
        console.log(chalk.green(result.message));
      } else {
        console.error(chalk.red(result.message));
      }
      process.exit(result.exitCode);
    });
}
