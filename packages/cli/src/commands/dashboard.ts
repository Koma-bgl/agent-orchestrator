import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig, createLifecycleManager } from "@composio/ao-core";
import { findWebDir, buildDashboardEnv } from "../lib/web-dir.js";
import { getSessionManagerWithRegistry } from "../lib/create-session-manager.js";
import { cleanNextCache, findRunningDashboardPid, findProcessWebDir, waitForPortFree } from "../lib/dashboard-rebuild.js";

export function registerDashboard(program: Command): void {
  program
    .command("dashboard")
    .description("Start the web dashboard")
    .option("-p, --port <port>", "Port to listen on")
    .option("--no-open", "Don't open browser automatically")
    .option("--rebuild", "Clean stale build artifacts and rebuild before starting")
    .action(async (opts: { port?: string; open?: boolean; rebuild?: boolean }) => {
      const config = loadConfig();
      const port = opts.port ? parseInt(opts.port, 10) : (config.port ?? 3000);

      if (isNaN(port) || port < 1 || port > 65535) {
        console.error(chalk.red("Invalid port number. Must be 1-65535."));
        process.exit(1);
      }

      const localWebDir = findWebDir();

      if (!existsSync(resolve(localWebDir, "package.json"))) {
        console.error(
          chalk.red(
            "Could not find @composio/ao-web package.\n" + "Ensure it is installed: pnpm install",
          ),
        );
        process.exit(1);
      }

      if (opts.rebuild) {
        // Check if a dashboard is already running on this port.
        const runningPid = await findRunningDashboardPid(port);
        const runningWebDir = runningPid ? await findProcessWebDir(runningPid) : null;
        const targetWebDir = runningWebDir ?? localWebDir;

        if (runningPid) {
          // Kill the running server, clean .next, then start fresh below.
          console.log(
            chalk.dim(`Stopping dashboard (PID ${runningPid}) on port ${port}...`),
          );
          try {
            process.kill(parseInt(runningPid, 10), "SIGTERM");
          } catch {
            // Process already exited (ESRCH) — that's fine
          }
          // Wait for port to be released
          await waitForPortFree(port, 5000);
        }

        await cleanNextCache(targetWebDir);
        // Fall through to start the dashboard on this port.
      }

      const webDir = localWebDir;

      console.log(chalk.bold(`Starting dashboard on http://localhost:${port}\n`));

      const env = await buildDashboardEnv(
        port,
        config.configPath,
        config.terminalPort,
        config.directTerminalPort,
      );

      const terminalPort = env["TERMINAL_PORT"] ?? "14800";
      const directTerminalPort = env["DIRECT_TERMINAL_PORT"] ?? "14801";

      console.log(
        chalk.dim(
          `Terminal servers: ws://localhost:${terminalPort} (ttyd), ws://localhost:${directTerminalPort} (direct)\n`,
        ),
      );

      // Spawn all three processes: Next.js + terminal WebSocket server + direct terminal WebSocket server
      const serverDir = resolve(webDir, "server");

      const nextChild = spawn("npx", ["next", "dev", "-p", String(port)], {
        cwd: webDir,
        stdio: ["inherit", "inherit", "pipe"],
        env,
      });

      const terminalChild = spawn("npx", ["tsx", resolve(serverDir, "terminal-websocket.ts")], {
        cwd: webDir,
        stdio: ["ignore", "inherit", "inherit"],
        env,
      });

      const directTerminalChild = spawn("npx", ["tsx", resolve(serverDir, "direct-terminal-ws.ts")], {
        cwd: webDir,
        stdio: ["ignore", "inherit", "inherit"],
        env,
      });

      const children: ChildProcess[] = [nextChild, terminalChild, directTerminalChild];

      // Start lifecycle manager for session polling + notifications
      let lifecycleManager: ReturnType<typeof createLifecycleManager> | null = null;
      const POLL_INTERVAL_MS = 30_000;

      getSessionManagerWithRegistry(config)
        .then(({ sessionManager, registry }) => {
          lifecycleManager = createLifecycleManager({
            config,
            registry,
            sessionManager,
          });
          lifecycleManager.start(POLL_INTERVAL_MS);
          console.log(
            chalk.dim(`Lifecycle manager started (polling every ${POLL_INTERVAL_MS / 1000}s)\n`),
          );
        })
        .catch((err) => {
          console.error(
            chalk.yellow("Lifecycle manager failed to start (notifications disabled):"),
            chalk.dim(err instanceof Error ? err.message : String(err)),
          );
        });

      // Kill all child processes on exit
      function killAll(exitCode: number): void {
        if (lifecycleManager) {
          lifecycleManager.stop();
        }
        for (const c of children) {
          try {
            c.kill("SIGTERM");
          } catch {
            // Already dead — ignore
          }
        }
        process.exit(exitCode);
      }

      process.on("SIGINT", () => killAll(0));
      process.on("SIGTERM", () => killAll(0));

      const stderrChunks: string[] = [];

      const MAX_STDERR_CHUNKS = 100;

      nextChild.stderr?.on("data", (data: Buffer) => {
        const text = data.toString();
        if (stderrChunks.length < MAX_STDERR_CHUNKS) {
          stderrChunks.push(text);
        }
        // Still show stderr to the user
        process.stderr.write(data);
      });

      nextChild.on("error", (err) => {
        console.error(chalk.red("Could not start dashboard. Ensure Next.js is installed."));
        console.error(chalk.dim(String(err)));
        killAll(1);
      });

      terminalChild.on("error", (err) => {
        console.error(chalk.yellow("Terminal WebSocket server failed to start:"), chalk.dim(String(err)));
      });

      directTerminalChild.on("error", (err) => {
        console.error(chalk.yellow("Direct terminal WebSocket server failed to start:"), chalk.dim(String(err)));
      });

      let browserTimer: ReturnType<typeof setTimeout> | undefined;

      if (opts.open !== false) {
        browserTimer = setTimeout(() => {
          const browser = spawn("open", [`http://localhost:${port}`], {
            stdio: "ignore",
          });
          browser.on("error", () => {
            // Ignore — browser open is best-effort
          });
        }, 3000);
      }

      nextChild.on("exit", (code) => {
        if (browserTimer) clearTimeout(browserTimer);

        if (code !== 0 && code !== null && !opts.rebuild) {
          const stderr = stderrChunks.join("");
          if (looksLikeStaleBuild(stderr)) {
            console.error(
              chalk.yellow(
                "\nThis looks like a stale build cache issue. Try:\n\n" +
                  `  ${chalk.cyan("ao dashboard --rebuild")}\n`,
              ),
            );
          }
        }

        killAll(code ?? 0);
      });
    });
}

/**
 * Check if stderr output suggests stale build artifacts.
 */
function looksLikeStaleBuild(stderr: string): boolean {
  const patterns = [
    /Cannot find module.*vendor-chunks/,
    /Cannot find module.*\.next/,
    /Module not found.*\.next/,
    /ENOENT.*\.next/,
    /Could not find a production build/,
  ];
  return patterns.some((p) => p.test(stderr));
}
