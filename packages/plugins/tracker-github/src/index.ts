/**
 * tracker-github plugin — GitHub Issues as an issue tracker.
 *
 * Uses the `gh` CLI for all GitHub API interactions.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  PluginModule,
  Tracker,
  Issue,
  IssueFilters,
  IssueUpdate,
  CreateIssueInput,
  ProjectConfig,
} from "@composio/ao-core";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Rate-limit-aware retry
// ---------------------------------------------------------------------------

let rateLimitResetAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function detectRateLimit(message: string): number {
  const lower = message.toLowerCase();
  if (
    !lower.includes("rate limit") &&
    !lower.includes("abuse detection") &&
    !lower.includes("secondary rate") &&
    !lower.includes("api rate limit") &&
    !lower.includes("403") &&
    !lower.includes("429")
  ) {
    return 0;
  }
  const retryMatch = message.match(/retry[\s-]*after[:\s]*(\d+)/i);
  if (retryMatch) {
    return parseInt(retryMatch[1], 10) * 1000;
  }
  return 60_000;
}

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 5_000;

// ---------------------------------------------------------------------------
// Concurrency limiter — prevents API stampede on laptop wake / reconnect
// ---------------------------------------------------------------------------

const MAX_CONCURRENT_GH = 4;
let activeGhCalls = 0;
const ghQueue: Array<() => void> = [];

function acquireGhSlot(): Promise<void> {
  if (activeGhCalls < MAX_CONCURRENT_GH) {
    activeGhCalls++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    ghQueue.push(() => {
      activeGhCalls++;
      resolve();
    });
  });
}

function releaseGhSlot(): void {
  activeGhCalls--;
  const next = ghQueue.shift();
  if (next) next();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function gh(args: string[]): Promise<string> {
  await acquireGhSlot();
  try {
    return await ghInner(args);
  } finally {
    releaseGhSlot();
  }
}

async function ghInner(args: string[]): Promise<string> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const waitUntil = rateLimitResetAt - Date.now();
    if (waitUntil > 0) {
      await sleep(Math.min(waitUntil, 120_000));
    }

    try {
      const { stdout } = await execFileAsync("gh", args, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 60_000,
      });
      return stdout.trim();
    } catch (err) {
      const message = (err as Error).message ?? "";
      const rateLimitWait = detectRateLimit(message);

      if (rateLimitWait > 0 && attempt < MAX_RETRIES) {
        rateLimitResetAt = Date.now() + rateLimitWait;
        const backoff = Math.min(
          rateLimitWait,
          BASE_BACKOFF_MS * Math.pow(2, attempt),
        );
        await sleep(backoff);
        continue;
      }

      throw new Error(
        `gh ${args.slice(0, 3).join(" ")} failed: ${message}`,
        { cause: err },
      );
    }
  }

  throw new Error(`gh ${args.slice(0, 3).join(" ")} failed after ${MAX_RETRIES} retries`);
}

function mapState(ghState: string, stateReason?: string | null): Issue["state"] {
  const s = ghState.toUpperCase();
  if (s === "CLOSED") {
    if (stateReason?.toUpperCase() === "NOT_PLANNED") return "cancelled";
    return "closed";
  }
  return "open";
}

// ---------------------------------------------------------------------------
// Tracker implementation
// ---------------------------------------------------------------------------

function createGitHubTracker(): Tracker {
  return {
    name: "github",

    async getIssue(identifier: string, project: ProjectConfig): Promise<Issue> {
      const raw = await gh([
        "issue",
        "view",
        identifier,
        "--repo",
        project.repo,
        "--json",
        "number,title,body,url,state,stateReason,labels,assignees",
      ]);

      const data: {
        number: number;
        title: string;
        body: string;
        url: string;
        state: string;
        stateReason: string | null;
        labels: Array<{ name: string }>;
        assignees: Array<{ login: string }>;
      } = JSON.parse(raw);

      return {
        id: String(data.number),
        title: data.title,
        description: data.body ?? "",
        url: data.url,
        state: mapState(data.state, data.stateReason),
        labels: data.labels.map((l) => l.name),
        assignee: data.assignees[0]?.login,
      };
    },

    async isCompleted(identifier: string, project: ProjectConfig): Promise<boolean> {
      const raw = await gh([
        "issue",
        "view",
        identifier,
        "--repo",
        project.repo,
        "--json",
        "state",
      ]);
      const data: { state: string } = JSON.parse(raw);
      return data.state.toUpperCase() === "CLOSED";
    },

    issueUrl(identifier: string, project: ProjectConfig): string {
      const num = identifier.replace(/^#/, "");
      return `https://github.com/${project.repo}/issues/${num}`;
    },

    issueLabel(url: string, _project: ProjectConfig): string {
      // Extract issue number from GitHub URL
      // Example: https://github.com/owner/repo/issues/42 → "#42"
      const match = url.match(/\/issues\/(\d+)/);
      if (match) {
        return `#${match[1]}`;
      }
      // Fallback: return the last segment of the URL
      const parts = url.split("/");
      const lastPart = parts[parts.length - 1];
      return lastPart ? `#${lastPart}` : url;
    },

    branchName(identifier: string, _project: ProjectConfig): string {
      const num = identifier.replace(/^#/, "");
      return `feat/issue-${num}`;
    },

    async generatePrompt(identifier: string, project: ProjectConfig): Promise<string> {
      const issue = await this.getIssue(identifier, project);
      const lines = [
        `You are working on GitHub issue #${issue.id}: ${issue.title}`,
        `Issue URL: ${issue.url}`,
        "",
      ];

      if (issue.labels.length > 0) {
        lines.push(`Labels: ${issue.labels.join(", ")}`);
      }

      if (issue.description) {
        lines.push("## Description", "", issue.description);
      }

      lines.push(
        "",
        "Please implement the changes described in this issue. When done, commit and push your changes.",
      );

      return lines.join("\n");
    },

    async listIssues(filters: IssueFilters, project: ProjectConfig): Promise<Issue[]> {
      const args = [
        "issue",
        "list",
        "--repo",
        project.repo,
        "--json",
        "number,title,body,url,state,stateReason,labels,assignees",
        "--limit",
        String(filters.limit ?? 30),
      ];

      if (filters.state === "closed") {
        args.push("--state", "closed");
      } else if (filters.state === "all") {
        args.push("--state", "all");
      } else {
        args.push("--state", "open");
      }

      if (filters.labels && filters.labels.length > 0) {
        args.push("--label", filters.labels.join(","));
      }

      if (filters.assignee) {
        args.push("--assignee", filters.assignee);
      }

      const raw = await gh(args);
      const issues: Array<{
        number: number;
        title: string;
        body: string;
        url: string;
        state: string;
        stateReason: string | null;
        labels: Array<{ name: string }>;
        assignees: Array<{ login: string }>;
      }> = JSON.parse(raw);

      return issues.map((data) => ({
        id: String(data.number),
        title: data.title,
        description: data.body ?? "",
        url: data.url,
        state: mapState(data.state, data.stateReason),
        labels: data.labels.map((l) => l.name),
        assignee: data.assignees[0]?.login,
      }));
    },

    async updateIssue(
      identifier: string,
      update: IssueUpdate,
      project: ProjectConfig,
    ): Promise<void> {
      // Handle state change — GitHub Issues only supports open/closed.
      // "in_progress" is not a GitHub state, so it is intentionally a no-op.
      if (update.state === "closed") {
        await gh(["issue", "close", identifier, "--repo", project.repo]);
      } else if (update.state === "open") {
        await gh(["issue", "reopen", identifier, "--repo", project.repo]);
      }

      // Handle label changes
      if (update.labels && update.labels.length > 0) {
        await gh([
          "issue",
          "edit",
          identifier,
          "--repo",
          project.repo,
          "--add-label",
          update.labels.join(","),
        ]);
      }

      // Handle assignee changes
      if (update.assignee) {
        await gh([
          "issue",
          "edit",
          identifier,
          "--repo",
          project.repo,
          "--add-assignee",
          update.assignee,
        ]);
      }

      // Handle comment
      if (update.comment) {
        await gh([
          "issue",
          "comment",
          identifier,
          "--repo",
          project.repo,
          "--body",
          update.comment,
        ]);
      }
    },

    async createIssue(input: CreateIssueInput, project: ProjectConfig): Promise<Issue> {
      const args = [
        "issue",
        "create",
        "--repo",
        project.repo,
        "--title",
        input.title,
        "--body",
        input.description ?? "",
      ];

      if (input.labels && input.labels.length > 0) {
        args.push("--label", input.labels.join(","));
      }

      if (input.assignee) {
        args.push("--assignee", input.assignee);
      }

      // gh issue create outputs the URL of the new issue
      const url = await gh(args);

      // Extract issue number from URL and fetch full details
      const match = url.match(/\/issues\/(\d+)/);
      if (!match) {
        throw new Error(`Failed to parse issue URL from gh output: ${url}`);
      }
      const number = match[1];

      return this.getIssue(number, project);
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "github",
  slot: "tracker" as const,
  description: "Tracker plugin: GitHub Issues",
  version: "0.1.0",
};

export function create(): Tracker {
  return createGitHubTracker();
}

export default { manifest, create } satisfies PluginModule<Tracker>;
