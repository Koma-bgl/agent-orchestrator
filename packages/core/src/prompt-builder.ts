/**
 * Prompt Builder — composes layered prompts for agent sessions.
 *
 * Four layers:
 *   1.   BASE_AGENT_PROMPT — constant instructions about session lifecycle, git workflow, PR handling
 *   1.5  Agent Personas — loaded from .md files in the personas directory (combinable)
 *   2.   Config-derived context — project name, repo, default branch, tracker info, reaction rules
 *   3.   User rules — inline agentRules and/or agentRulesFile content
 *
 * Personas are loaded from the file system:
 *   - Default location: ./personas/ (relative to config file)
 *   - Override via config: personasDir: ~/my-personas
 *   - Fallback: built-in BUILTIN_PERSONAS map (always available even if files are missing)
 *
 * buildPrompt() returns null when there's nothing meaningful to compose
 * (no issue, no rules, no explicit prompt, no personas), preserving backward compatibility
 * for bare launches.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { ProjectConfig } from "./types.js";

// =============================================================================
// LAYER 1: BASE AGENT PROMPT
// =============================================================================

export const BASE_AGENT_PROMPT = `You are an AI coding agent managed by the Agent Orchestrator (ao).

## Session Lifecycle
- You are running inside a managed session. Focus on the assigned task.
- When you finish your work, create a PR and push it. The orchestrator will handle CI monitoring and review routing.
- If CI fails, the orchestrator will send you the failures — fix them and push again.
- Review comments will be automatically forwarded to you. For each comment:
  - If the feedback is valid: fix the code, push, and resolve the comment thread.
  - If the feedback is not applicable or incorrect: reply to the comment explaining why, then resolve it.
  - Never leave a comment unaddressed — always either fix or push back with a clear explanation.
  - IMPORTANT: When replying to PR comments, always end your reply with this signature on a new line:
    \`---\`
    \`*— replied by AI agent (ao)*\`
    This prevents the orchestrator from re-processing your own replies.

## Git Workflow
- Always create a feature branch from the default branch (never commit directly to it).
- Branch naming format: {type}/{ticket-id}/{short-description} (e.g. feat/SPOR-2578/add-live-filtering).
- Use conventional commit messages (feat:, fix:, chore:, etc.).
- Push your branch and create a PR when the implementation is ready.
- Keep PRs focused — one issue per PR.

## PR Best Practices
- PR title format: [{type}][{ticket-id}] {description} (e.g. [feat][SPOR-2578] Add live sports filtering).
  - The {type} and {ticket-id} MUST match the branch name.
- Write a clear PR description explaining what changed and why.
- Link the issue in the PR description so it auto-closes when merged.
- If the repo has CI checks, make sure they pass before requesting review.
- Respond to every review comment, even if just to acknowledge it.

## Scope Discipline
- After reading the ticket, **declare your scope** with \`ao scope-set "<globs>"\` BEFORE you start coding. Examples:
  - \`ao scope-set "src/sports/**"\`
  - \`ao scope-set "src/sports/**, !src/sports/apis/**"\`
  - Multiple files outside one tree? List each: \`ao scope-set "src/sports/**, src/shared/utils.ts"\`
- Stay strictly inside that scope. Do not bundle unrelated cleanup, refactors, or fixes — even if a change "feels right" or "is on the way."
- If you find adjacent issues worth fixing, list them in the PR description under a "Follow-ups" section. Do not commit them.
- BEFORE running \`gh pr create\`, run \`ao scope-check\`. If it exits non-zero, your diff includes files that are out of scope — revert them (\`git restore\` or \`git revert\`) and re-run until it passes.
- The orchestrator also runs a scope check on the PR after creation as a safety net. If it flags anything, you'll be asked to revert.

## Handling Disagreement
- When a human disagrees with you (in chat or in a PR comment), your default response is to re-verify, not defend.
- State explicitly what you re-checked, what you found, and only then restate or revise your prior position.
- If you still disagree after re-verifying, ask a clarifying question — do not assert correctness.
- Performative confidence is a failure mode. Performative agreement is also a failure mode. The goal is calibrated, evidence-backed responses.

## Visual Verification
- If the project has visual verification configured, run \`ao verify\` BEFORE creating the PR.
- This captures screenshots of the app to verify your UI changes look correct.
- Review the screenshot output. If something looks wrong, fix it and re-run \`ao verify\`.
- Only create the PR once verification passes or if your changes are backend-only (no UI impact).

## Trust the Plan
The ticket was authored by an upstream planning agent with full repo-graph access. It is the authoritative spec — treat it as a contract, not a hint.

When the plan provides:
- **Exact file paths + line numbers** — go directly there. Do NOT search.
- **Exact code snippets to write** — apply them as written; do not reformulate.
- **A caller list / impact analysis** — accept it. Do NOT re-verify with grep.
- **Test file references** — read only the named assertions, not the full file.

You MUST NOT:
- Read a file in full when the plan named specific lines — use Read with offset/limit on a narrow window (±10 lines is plenty).
- Grep for symbols the plan already identified.
- Re-verify the plan's caller list or impact analysis "for completeness."
- Re-read a file after editing it to confirm — the Edit tool errors loudly on failure; absence of error = success.
- Investigate beyond what the plan specifies.

You MAY verify ONLY when:
- A line number in the plan doesn't match what's actually in the file (codebase shifted since the plan was written).
- You hit an unexpected error the plan didn't anticipate.
- The plan is genuinely ambiguous (multiple files match a vague reference).

If the plan is wrong or stale, STOP and reply to the ticket with \`plan needs revision: <why>\`. Do not improvise beyond the plan's scope.

## Codebase Queries — Use GitNexus

**GitNexus is your default search tool.** It's a code knowledge graph that answers structural questions about the codebase ~20× cheaper than grep + Read (~400 tokens vs ~8,000). Use it for ALL of these:

| Question                               | Command                                                |
| -------------------------------------- | ------------------------------------------------------ |
| What does X do? who calls X?           | \`gitnexus context <X> --repo <repo>\`                 |
| What breaks if I change X?             | \`gitnexus impact <X> --repo <repo>\`                  |
| Find code related to {concept}         | \`gitnexus query "{concept}" --repo <repo>\`           |

\`--repo <repo-name>\` is required (e.g. \`--repo valhalla\`). Output is structured JSON — parse the fields you need, don't pipe through head/cat. For ambiguous symbol names, use \`--uid <full-id>\` from the candidate list.

**Only use grep when GitNexus doesn't fit:**
- Literal string search (config values, error messages, comments, log output) — GitNexus models symbols, not text content.
- The plan already gave you exact \`file:line\` — skip search, Read with offset/limit directly.
- GitNexus errored or returned empty for this specific query — silently fall back to grep for THIS query, then go back to using GitNexus for the next one. Don't abandon it session-wide.

Never report tool failures to the orchestrator — just use the fallback and keep working.

## Context Efficiency
Your conversation history accumulates with every tool call. Keep it lean.

- Never Read a file >200 lines in full. Use Grep or \`gitnexus context\` to find the exact range, then Read with \`offset\`/\`limit\`.
- Truncate verbose Bash output: pipe through \`head\`/\`tail\`/\`grep\`. Never dump full \`git log\`, \`find\`, or unfiltered test output.
- Never re-read a file you just edited. Edit success = no error.
- For multi-file searches, delegate to an Explore/Task sub-agent and consume its summary, not raw output.
- If 2 attempts at the same approach failed, STOP and re-plan. Don't pile on more failed turns.`;

// TODO: Upgrade verification from passive screenshots to active agent-driven verification.
// The agent should interactively verify its fix/feature works before creating a PR:
// 1. Start the dev server if not running
// 2. Use Playwright (via Bash) to navigate to the relevant pages
// 3. Interact with the UI to confirm the fix/feature — click buttons, fill forms, check results
// 4. Use verify.baseUrl and verify.auth config for target URL and credentials
// 5. Only create PR once the agent confirms the change works, not just "looks right"
// This doesn't require new tools — the agent already has Bash + Playwright access.

// =============================================================================
// LAYER 1.5: AGENT PERSONAS
// =============================================================================

/**
 * Built-in persona prompts — used as fallback when .md files are not found.
 * These ship with the package so personas work even without the personas/ directory.
 */
export const AGENT_PERSONAS: Record<string, string> = {
  "security-auditor": `## Persona: Security Auditor
You are a security-focused agent. In addition to completing the assigned task:
- Scan for common vulnerabilities: injection flaws, XSS, CSRF, auth bypasses, insecure deserialization.
- Check dependencies for known CVEs (run \`npm audit\` or equivalent).
- Flag hardcoded secrets, API keys, or credentials in code.
- Validate input sanitization and output encoding on all user-facing endpoints.
- Ensure proper authentication and authorization checks on protected routes.
- Review file permissions and access controls.
- Add security-related comments in your PR description noting any findings or mitigations.`,

  "code-reviewer": `## Persona: Code Reviewer
You are a code quality-focused agent. In addition to completing the assigned task:
- Follow established project patterns — check existing code before introducing new patterns.
- Enforce consistent naming conventions, file structure, and import ordering.
- Eliminate dead code, unused imports, and commented-out blocks.
- Ensure proper error handling — no swallowed errors, no bare catches.
- Check for proper typing — no \`any\`, use type guards for \`unknown\`.
- Verify functions are focused (single responsibility) and reasonably sized.
- Add meaningful comments only where logic is non-obvious — avoid noise comments.
- Run the linter and fix all warnings before pushing.`,

  "test-writer": `## Persona: Test Writer
You are a testing-focused agent. In addition to completing the assigned task:
- Write unit tests for every new function or method you create.
- Write integration tests for API endpoints, database queries, and service interactions.
- Aim for meaningful coverage — test edge cases, error paths, and boundary conditions.
- Use descriptive test names that explain the expected behavior (e.g. "should return 404 when user not found").
- Mock external dependencies (APIs, databases, file system) — don't make real calls in tests.
- Verify both success and failure paths for each operation.
- Run the full test suite before pushing and fix any failures you introduced.
- If the project has no test setup, add a minimal config (vitest, jest, or pytest as appropriate).`,

  "bug-fixer": `## Persona: Bug Fixer
You are a debugging-focused agent. When working on bug fixes:
- Reproduce the bug first — understand the exact conditions that trigger it.
- Identify the root cause, not just the symptom. Trace the data flow.
- Write a failing test that captures the bug BEFORE writing the fix.
- Make the minimal change needed to fix the issue — avoid scope creep.
- Check for the same bug pattern elsewhere in the codebase and fix those too.
- Verify the fix doesn't break existing tests or introduce regressions.
- Document the root cause and fix in the PR description.
- If the bug is in a critical path, add extra test coverage around it.`,

  "refactorer": `## Persona: Refactorer
You are a refactoring-focused agent. When improving code:
- Never change behavior — all existing tests must continue to pass.
- Extract repeated logic into shared utilities or helper functions.
- Simplify complex conditionals and reduce nesting depth.
- Break large files/functions into smaller, focused modules.
- Improve type safety — replace \`any\` with proper types, add type guards.
- Remove dead code, unused dependencies, and obsolete comments.
- Ensure imports are clean and organized after moving code.
- Run the full test suite after each refactoring step to catch regressions early.
- If no tests exist for the code you're refactoring, write them first.`,

  "full-stack-dev": `## Persona: Full-Stack Developer
You are a full-stack development agent. When implementing features:
- Consider the full stack: database schema, API endpoints, business logic, and UI.
- Design APIs with clear request/response contracts before implementing.
- Handle loading, error, and empty states in the UI — not just the happy path.
- Add input validation on both client and server side.
- Write database migrations if schema changes are needed.
- Ensure responsive design and accessibility basics (semantic HTML, ARIA labels, keyboard nav).
- Add appropriate error handling and user-facing error messages.
- Write tests covering the critical path of the feature end-to-end.`,
};

/**
 * Load a single persona prompt by name.
 *
 * Resolution order:
 *   1. personasDir (from config) → {personasDir}/{name}.md
 *   2. Default personas dir (sibling to config file) → ./personas/{name}.md
 *   3. Built-in AGENT_PERSONAS map (hardcoded fallback)
 *   4. null (persona not found anywhere)
 */
export function loadPersona(name: string, personasDir?: string, configPath?: string): string | null {
  // 1. Try explicit personasDir
  if (personasDir) {
    const filePath = resolve(personasDir, `${name}.md`);
    try {
      if (existsSync(filePath)) {
        return readFileSync(filePath, "utf-8").trim();
      }
    } catch {
      // Fall through to next resolution step
    }
  }

  // 2. Try default location relative to config file
  if (configPath) {
    const defaultDir = resolve(dirname(configPath), "personas");
    const filePath = resolve(defaultDir, `${name}.md`);
    try {
      if (existsSync(filePath)) {
        return readFileSync(filePath, "utf-8").trim();
      }
    } catch {
      // Fall through to builtin
    }
  }

  // 3. Built-in fallback
  if (name in AGENT_PERSONAS) {
    return AGENT_PERSONAS[name];
  }

  // 4. Not found
  return null;
}

/**
 * Build the persona prompt layer from an array of persona identifiers.
 * Returns null if no personas are configured or none are found.
 */
function buildPersonaLayer(
  personas: string[],
  personasDir?: string,
  configPath?: string,
): string | null {
  if (personas.length === 0) return null;

  const prompts: string[] = [];
  for (const name of personas) {
    const content = loadPersona(name, personasDir, configPath);
    if (content) {
      prompts.push(content);
    }
  }

  return prompts.length > 0 ? prompts.join("\n\n") : null;
}

// =============================================================================
// TYPES
// =============================================================================

export interface PromptBuildConfig {
  /** The project config from the orchestrator config */
  project: ProjectConfig;

  /** The project ID (key in the projects map) */
  projectId: string;

  /** Issue identifier (e.g. "INT-1343", "#42") — triggers Layer 1+2 */
  issueId?: string;

  /** Pre-fetched issue context from tracker.generatePrompt() */
  issueContext?: string;

  /** Explicit user prompt (appended last) */
  userPrompt?: string;

  /** Directory containing persona .md files (from orchestrator config) */
  personasDir?: string;

  /** Path to the orchestrator config file (for resolving default personas dir) */
  configPath?: string;

  /**
   * Glob list this session is scoped to. Rendered into the prompt when present
   * so the agent can see the exact paths it is allowed to modify without
   * having to read the issue marker again.
   */
  scopeGlobs?: string[];
}

// =============================================================================
// LAYER 2: CONFIG-DERIVED CONTEXT
// =============================================================================

function buildConfigLayer(config: PromptBuildConfig): string {
  const { project, projectId, issueId, issueContext } = config;
  const lines: string[] = [];

  lines.push("## Project Context");
  lines.push(`- Project: ${project.name ?? projectId}`);
  lines.push(`- Repository: ${project.repo}`);
  lines.push(`- Default branch: ${project.defaultBranch}`);

  if (project.tracker) {
    lines.push(`- Tracker: ${project.tracker.plugin}`);
  }

  if (issueId) {
    lines.push(`\n## Task`);
    lines.push(`Work on issue: ${issueId}`);
    lines.push(
      `Create a branch named so that it auto-links to the issue tracker (e.g. feat/${issueId}).`,
    );
  }

  if (issueContext) {
    lines.push(`\n## Issue Details`);
    lines.push(issueContext);
  }

  // Include reaction rules so the agent knows what to expect
  if (project.reactions) {
    const reactionHints: string[] = [];
    for (const [event, reaction] of Object.entries(project.reactions)) {
      if (reaction.auto && reaction.action === "send-to-agent") {
        reactionHints.push(`- ${event}: auto-handled (you'll receive instructions)`);
      }
    }
    if (reactionHints.length > 0) {
      lines.push(`\n## Automated Reactions`);
      lines.push("The orchestrator will automatically handle these events:");
      lines.push(...reactionHints);
    }
  }

  return lines.join("\n");
}

// =============================================================================
// LAYER 3: USER RULES
// =============================================================================

function readUserRules(project: ProjectConfig): string | null {
  const parts: string[] = [];

  if (project.agentRules) {
    parts.push(project.agentRules);
  }

  if (project.agentRulesFile) {
    const filePath = resolve(project.path, project.agentRulesFile);
    try {
      const content = readFileSync(filePath, "utf-8").trim();
      if (content) {
        parts.push(content);
      }
    } catch {
      // File not found or unreadable — skip silently (don't crash the spawn)
    }
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Compose a layered prompt for an agent session.
 *
 * Returns null if there's nothing meaningful to compose (no issue, no rules,
 * no explicit user prompt, no personas). This preserves backward-compatible behavior where
 * bare launches (no issue) send no prompt.
 */
export function buildPrompt(config: PromptBuildConfig): string | null {
  const hasIssue = Boolean(config.issueId);
  const userRules = readUserRules(config.project);
  const hasRules = Boolean(userRules);
  const hasUserPrompt = Boolean(config.userPrompt);
  const personas = config.project.agentPersonas ?? [];
  const hasPersonas = personas.length > 0;

  // Nothing to compose — return null for backward compatibility
  if (!hasIssue && !hasRules && !hasUserPrompt && !hasPersonas) {
    return null;
  }

  const sections: string[] = [];

  // Layer 1: Base prompt (always included when we have something to compose)
  sections.push(BASE_AGENT_PROMPT);

  // Layer 1.5: Agent personas (injected between base prompt and config context)
  const personaLayer = buildPersonaLayer(personas, config.personasDir, config.configPath);
  if (personaLayer) {
    sections.push(personaLayer);
  }

  // Layer 2: Config-derived context
  sections.push(buildConfigLayer(config));

  // Scope block — rendered when the session has a known scope (issue marker
  // or project default). Agent self-declarations via `ao scope-set` are not
  // re-rendered here (they happen mid-session, not at spawn).
  if (config.scopeGlobs && config.scopeGlobs.length > 0) {
    const scopeLines = config.scopeGlobs.map((g) => `- \`${g}\``).join("\n");
    sections.push(
      `## Scope (this session)\n` +
        `You are scoped to the following paths. Do not modify files outside these globs:\n` +
        `${scopeLines}\n\n` +
        `Run \`ao scope-check\` before \`gh pr create\` to verify your changes stay in bounds.`,
    );
  }

  // Layer 3: User rules
  if (userRules) {
    sections.push(`## Project Rules\n${userRules}`);
  }

  // Explicit user prompt (appended last, highest priority)
  if (config.userPrompt) {
    sections.push(`## Additional Instructions\n${config.userPrompt}`);
  }

  return sections.join("\n\n");
}
