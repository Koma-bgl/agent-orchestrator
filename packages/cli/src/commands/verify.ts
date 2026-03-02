/**
 * `ao verify` — Run visual verification screenshots before creating a PR.
 *
 * Designed to be called by the agent from within a worktree session.
 * Launches Playwright, authenticates, captures configured pages, and
 * prints results to stdout so the agent can see them.
 *
 * Usage:
 *   ao verify                     # auto-detect project from CWD
 *   ao verify -p valhalla          # explicit project
 *   ao verify --output ./shots     # custom output dir
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig, runVerification } from "@composio/ao-core";

export function registerVerify(program: Command): void {
  program
    .command("verify")
    .description(
      "Capture verification screenshots of the app (run before creating a PR)",
    )
    .option("-p, --project <id>", "Project ID (auto-detected from CWD if omitted)")
    .option("-o, --output <dir>", "Output directory for screenshots")
    .option("--base-url <url>", "Override base URL from config")
    .action(
      async (opts: {
        project?: string;
        output?: string;
        baseUrl?: string;
      }) => {
        let config;
        try {
          config = loadConfig();
        } catch {
          console.error(
            chalk.red("No agent-orchestrator.yaml found. Run `ao init` first."),
          );
          process.exit(1);
        }

        // Resolve project — explicit flag or auto-detect from CWD
        let projectId = opts.project;
        if (!projectId) {
          const cwd = process.cwd();
          for (const [id, proj] of Object.entries(config.projects)) {
            if (cwd.startsWith(proj.path) || cwd.includes(id)) {
              projectId = id;
              break;
            }
          }
        }

        if (!projectId) {
          console.error(
            chalk.red(
              "Could not determine project. Use --project <id> or run from a project directory.",
            ),
          );
          console.error(
            chalk.dim(
              `Available: ${Object.keys(config.projects).join(", ")}`,
            ),
          );
          process.exit(1);
        }

        const project = config.projects[projectId];
        if (!project) {
          console.error(chalk.red(`Unknown project: ${projectId}`));
          process.exit(1);
        }

        if (!project.verify) {
          console.error(
            chalk.red(
              `No verify config for project "${projectId}". Add a 'verify' section to agent-orchestrator.yaml.`,
            ),
          );
          process.exit(1);
        }

        if (!project.verify.enabled) {
          console.log(chalk.dim("Visual verification is disabled for this project."));
          process.exit(0);
        }

        if (!project.verify.paths.length) {
          console.log(chalk.dim("No pages configured for verification."));
          process.exit(0);
        }

        // Build verify config with optional overrides
        const verifyConfig = {
          ...project.verify,
          ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
        };

        const outputDir =
          opts.output ??
          join(tmpdir(), "ao-verify", projectId, String(Date.now()));

        console.log(chalk.bold("\n📸 Visual Verification\n"));
        console.log(chalk.dim(`  Project:  ${projectId}`));
        console.log(chalk.dim(`  Base URL: ${verifyConfig.baseUrl}`));
        console.log(
          chalk.dim(
            `  Pages:    ${verifyConfig.paths.map((p) => p.name).join(", ")}`,
          ),
        );
        console.log(chalk.dim(`  Output:   ${outputDir}`));
        console.log();

        const result = await runVerification(verifyConfig, outputDir);

        if (result.success) {
          console.log(
            chalk.green(
              `✅ Verification complete — ${result.screenshots.length} screenshot(s) captured:\n`,
            ),
          );
          for (const shot of result.screenshots) {
            console.log(`  ${chalk.cyan(shot.name)}`);
            console.log(chalk.dim(`    URL:  ${shot.url}`));
            console.log(chalk.dim(`    File: ${shot.filePath}`));
            console.log();
          }
          console.log(
            chalk.dim(
              "Review the screenshots above. If they look correct, proceed to create the PR.",
            ),
          );
        } else {
          console.error(
            chalk.red(`❌ Verification failed: ${result.error ?? "unknown error"}\n`),
          );

          if (result.screenshots.length > 0) {
            console.log(chalk.dim("Partial screenshots captured:"));
            for (const shot of result.screenshots) {
              console.log(`  ${shot.name}: ${shot.filePath || "(failed)"}`);
            }
            console.log();
          }

          process.exit(1);
        }
      },
    );
}
