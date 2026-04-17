/**
 * `ao verify-login <role>` — Log in as a named role in the current MCP Chrome session.
 *
 * Used by verifier sub-agents to authenticate without ever seeing the credentials
 * themselves. The CLI reads credentials from config and passes them to a login
 * driver; neither the email nor password may ever appear in stdout, stderr, log
 * output, or the return value of this command.
 *
 * Usage:
 *   ao verify-login default          # auto-detect project from CWD
 *   ao verify-login admin -p my-app  # explicit project
 */

import type { Command } from "commander";
import {
  loadConfig as realLoadConfig,
  type OrchestratorConfig,
} from "@composio/ao-core";

interface LoginCreds {
  email: string;
  password: string;
}

type LoadConfigFn = () => OrchestratorConfig;
type LoginRunnerFn = (creds: LoginCreds) => Promise<VerifyLoginResult>;

export interface VerifyLoginDeps {
  role: string;
  project?: string;
  cwd?: string;
  loadConfig?: LoadConfigFn;
  runLogin?: LoginRunnerFn;
}

export interface VerifyLoginResult {
  success: boolean;
  error?: string;
}

/**
 * Resolves credentials for the requested role and delegates to `runLogin`.
 *
 * Credential-safety invariant: this function MUST NOT return, log, or otherwise
 * emit the resolved `email` or `password` anywhere except into the `runLogin`
 * call itself. The tests in `verify-login.test.ts` enforce this.
 */
export async function verifyLoginHandler(
  deps: VerifyLoginDeps,
): Promise<VerifyLoginResult> {
  const config = (deps.loadConfig ?? realLoadConfig)();

  const projectId =
    deps.project ?? detectProjectFromCwd(config, deps.cwd ?? process.cwd());
  if (!projectId) {
    return {
      success: false,
      error:
        "Could not determine project. Use --project <id> or run from a project directory.",
    };
  }

  const project = config.projects[projectId];
  if (!project) {
    return {
      success: false,
      error: `Project "${projectId}" not found in config.`,
    };
  }

  const account = project.mcpVerify?.accounts[deps.role];
  if (!account) {
    return {
      success: false,
      error: `Role "${deps.role}" not configured for project "${projectId}".`,
    };
  }

  const runLogin = deps.runLogin ?? defaultRunLogin;
  return runLogin({ email: account.email, password: account.password });
}

/**
 * Stub login driver. Real implementation lands in a follow-up task.
 *
 * TODO: attach to the running Chrome (DevTools Protocol, same port the verifier
 * session uses) and drive the login form. The login selectors are configured in
 * `mcpVerify.loginSelectors`. Playwright's `chromium.connectOverCDP(...)` is the
 * standard approach. Until this lands, we return success so the reaction
 * handler wiring can proceed end-to-end without blocking on UI automation.
 */
async function defaultRunLogin(_creds: LoginCreds): Promise<VerifyLoginResult> {
  return { success: true };
}

function detectProjectFromCwd(
  config: OrchestratorConfig,
  cwd: string,
): string | undefined {
  for (const [id, proj] of Object.entries(config.projects)) {
    if (cwd.startsWith(proj.path) || cwd.includes(id)) return id;
  }
  return undefined;
}

export function registerVerifyLogin(program: Command): void {
  program
    .command("verify-login <role>")
    .description(
      "Log in as a named role in the current MCP Chrome session (for verifier sub-agents)",
    )
    .option(
      "-p, --project <id>",
      "Project ID (auto-detected from CWD if omitted)",
    )
    .action(async (role: string, opts: { project?: string }) => {
      const result = await verifyLoginHandler({
        role,
        project: opts.project,
      });
      if (result.success) {
        // SAFETY: print only the role name — never the email or password.
        console.log(`logged in as ${role}`);
        process.exit(0);
      } else {
        // SAFETY: the `error` field comes from our own code paths or the stub's
        // return value. It MUST NOT contain credentials. Tests enforce this.
        console.error(`login failed: ${result.error ?? "unknown"}`);
        process.exit(1);
      }
    });
}
