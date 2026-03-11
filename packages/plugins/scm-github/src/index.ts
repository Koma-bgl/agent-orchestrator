/**
 * scm-github plugin — GitHub PRs, CI checks, reviews, merge readiness.
 *
 * Uses the `gh` CLI for all GitHub API interactions.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  CI_STATUS,
  type PluginModule,
  type SCM,
  type Session,
  type ProjectConfig,
  type PRInfo,
  type PRState,
  type MergeMethod,
  type CICheck,
  type CIStatus,
  type Review,
  type ReviewDecision,
  type ReviewComment,
  type AutomatedComment,
  type MergeReadiness,
} from "@composio/ao-core";
import { TTLCache } from "./cache.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Rate-limit-aware retry
// ---------------------------------------------------------------------------

/** Shared backoff state across all gh() calls in this process. */
let rateLimitResetAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Detect GitHub rate limit errors from `gh` CLI stderr.
 * Returns the number of milliseconds to wait, or 0 if not rate-limited.
 */
function detectRateLimit(message: string): number {
  // gh CLI outputs messages like:
  //   "API rate limit exceeded" / "rate limit" / "secondary rate limit"
  //   "retry after N seconds" / "Retry-After: N"
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

  // Try to extract a retry-after value (seconds)
  const retryMatch = message.match(/retry[\s-]*after[:\s]*(\d+)/i);
  if (retryMatch) {
    return parseInt(retryMatch[1], 10) * 1000;
  }

  // Try to extract reset timestamp (epoch seconds) from gh CLI output
  const resetMatch = message.match(/resets?\s+(?:at|in)\s+(\d{10,})/i);
  if (resetMatch) {
    const resetEpochMs = parseInt(resetMatch[1], 10) * 1000;
    const waitMs = resetEpochMs - Date.now();
    return waitMs > 0 ? waitMs : 60_000;
  }

  // Default backoff for rate limit errors without explicit timing
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

/** Known bot logins that produce automated review comments */
const BOT_AUTHORS = new Set([
  "cursor[bot]",
  "github-actions[bot]",
  "codecov[bot]",
  "sonarcloud[bot]",
  "dependabot[bot]",
  "renovate[bot]",
  "codeclimate[bot]",
  "deepsource-autofix[bot]",
  "snyk-bot",
  "lgtm-com[bot]",
]);

/**
 * Signature appended to comments posted by the AI agent.
 * Used to filter out agent-authored comments in getPendingComments() so the
 * agent doesn't waste tokens re-processing its own replies. This is necessary
 * because the agent uses the user's GitHub account, not a bot account.
 */
export const AGENT_COMMENT_SIGNATURE = "\n\n---\n*— replied by AI agent (ao)*";

/** Check whether a comment body contains the agent signature. */
function isAgentComment(body: string): boolean {
  return body.includes("— replied by AI agent (ao)");
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
    // Wait if we know we're rate-limited from a previous call
    const waitUntil = rateLimitResetAt - Date.now();
    if (waitUntil > 0) {
      await sleep(Math.min(waitUntil, 120_000)); // Cap at 2 minutes
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
        // Set shared backoff so concurrent calls also wait
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

  // Unreachable, but TypeScript needs it
  throw new Error(`gh ${args.slice(0, 3).join(" ")} failed after ${MAX_RETRIES} retries`);
}

function repoFlag(pr: PRInfo): string {
  return `${pr.owner}/${pr.repo}`;
}

function parseDate(val: string | undefined | null): Date {
  if (!val) return new Date(0);
  const d = new Date(val);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

// ---------------------------------------------------------------------------
// SCM implementation
// ---------------------------------------------------------------------------

/** Cache TTLs in milliseconds — tuned per method based on data volatility.
 *  Increased from original values to reduce GitHub API call volume and
 *  avoid hitting rate limits with many concurrent sessions.
 */
const CACHE_TTL = {
  getPRState: 120_000, // 2min — changes only on merge/close
  getCISummary: 60_000, // 1min — changes with CI runs
  getReviewDecision: 120_000, // 2min — changes on review action
  getMergeability: 120_000, // 2min — changes with pushes/merges
  getPendingComments: 300_000, // 5min — GraphQL, most expensive, changes slowly
  getAutomatedComments: 300_000, // 5min — bot comments are append-only
} as const;

function cacheKey(pr: PRInfo, method: string): string {
  return `${pr.owner}/${pr.repo}#${pr.number}:${method}`;
}

// ---------------------------------------------------------------------------
// Comment fetching helpers
// ---------------------------------------------------------------------------

/** Fetch unresolved inline review thread comments (code-level comments). */
async function fetchReviewThreadComments(pr: PRInfo): Promise<ReviewComment[]> {
  try {
    const raw = await gh([
      "api",
      "graphql",
      "-f",
      `owner=${pr.owner}`,
      "-f",
      `name=${pr.repo}`,
      "-F",
      `number=${pr.number}`,
      "-f",
      `query=query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            reviewThreads(first: 100) {
              nodes {
                id
                isResolved
                comments(first: 1) {
                  nodes {
                    id
                    author { login }
                    body
                    path
                    line
                    url
                    createdAt
                  }
                }
              }
            }
          }
        }
      }`,
    ]);

    const data: {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: Array<{
                id: string;
                isResolved: boolean;
                comments: {
                  nodes: Array<{
                    id: string;
                    author: { login: string } | null;
                    body: string;
                    path: string | null;
                    line: number | null;
                    url: string;
                    createdAt: string;
                  }>;
                };
              }>;
            };
          };
        };
      };
    } = JSON.parse(raw);

    const threads = data.data.repository.pullRequest.reviewThreads.nodes;

    return threads
      .filter((t) => {
        if (t.isResolved) return false;
        const c = t.comments.nodes[0];
        if (!c) return false;
        const author = c.author?.login ?? "";
        if (BOT_AUTHORS.has(author)) return false;
        // Skip comments posted by the AI agent (uses user's account, not a bot)
        if (isAgentComment(c.body)) return false;
        return true;
      })
      .map((t) => {
        const c = t.comments.nodes[0];
        return {
          id: c.id,
          threadId: t.id,
          author: c.author?.login ?? "unknown",
          body: c.body,
          path: c.path || undefined,
          line: c.line ?? undefined,
          isResolved: t.isResolved,
          createdAt: parseDate(c.createdAt),
          url: c.url,
          commentType: "review_comment" as const,
        };
      });
  } catch {
    return [];
  }
}

/** Fetch general PR conversation comments (issue comments, not inline review).
 *  Filters out comments that already have an 👀 reaction (meaning we've already
 *  picked them up and sent to the agent). */
async function fetchIssueComments(pr: PRInfo): Promise<ReviewComment[]> {
  try {
    const raw = await gh([
      "api",
      `repos/${repoFlag(pr)}/issues/${pr.number}/comments?per_page=100`,
    ]);

    const comments: Array<{
      id: number;
      user: { login: string } | null;
      body: string;
      created_at: string;
      html_url: string;
      reactions?: Record<string, number>;
    }> = JSON.parse(raw);

    const filtered = comments.filter((c) => {
      const author = c.user?.login ?? "";
      // Filter out bots
      if (BOT_AUTHORS.has(author)) return false;
      // Filter out [bot] suffix accounts not in the explicit list
      if (author.endsWith("[bot]")) return false;
      // Skip comments posted by the AI agent (uses user's account, not a bot)
      if (isAgentComment(c.body)) return false;
      // Skip comments we've already picked up (marked with 👀 reaction)
      if (c.reactions?.eyes && c.reactions.eyes > 0) return false;
      return true;
    });

    console.log(
      `[scm-github] fetchIssueComments PR #${pr.number}: ${comments.length} total, ${filtered.length} after bot filter` +
        (filtered.length > 0
          ? ` — authors: ${filtered.map((c) => c.user?.login).join(", ")}`
          : ""),
    );

    return filtered.map((c) => ({
      id: String(c.id),
      author: c.user?.login ?? "unknown",
      body: c.body,
      isResolved: false,
      createdAt: parseDate(c.created_at),
      url: c.html_url,
      commentType: "issue_comment" as const,
    }));
  } catch (err) {
    console.error(`[scm-github] fetchIssueComments PR #${pr.number} failed:`, err);
    return [];
  }
}

function createGitHubSCM(): SCM {
  const cache = new TTLCache();

  return {
    name: "github",

    async detectPR(session: Session, project: ProjectConfig): Promise<PRInfo | null> {
      if (!session.branch) return null;

      const parts = project.repo.split("/");
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(`Invalid repo format "${project.repo}", expected "owner/repo"`);
      }
      const [owner, repo] = parts;
      try {
        // Fetch up to 5 PRs to detect duplicates on the same branch
        const raw = await gh([
          "pr",
          "list",
          "--repo",
          project.repo,
          "--head",
          session.branch,
          "--json",
          "number,url,title,headRefName,baseRefName,isDraft",
          "--limit",
          "5",
        ]);

        const prs: Array<{
          number: number;
          url: string;
          title: string;
          headRefName: string;
          baseRefName: string;
          isDraft: boolean;
        }> = JSON.parse(raw);

        if (prs.length === 0) return null;

        if (prs.length > 1) {
          console.warn(
            `[scm-github] Multiple open PRs found for branch "${session.branch}": ${prs.map((p) => `#${p.number}`).join(", ")}. Using #${prs[0].number}.`,
          );
        }

        // If the session already has a PR number recorded, prefer that one
        // to avoid switching between PRs on the same branch.
        let pr = prs[0];
        if (session.pr?.number) {
          const match = prs.find((p) => p.number === session.pr!.number);
          if (match) pr = match;
        }

        return {
          number: pr.number,
          url: pr.url,
          title: pr.title,
          owner,
          repo,
          branch: pr.headRefName,
          baseBranch: pr.baseRefName,
          isDraft: pr.isDraft,
        };
      } catch {
        return null;
      }
    },

    async getPRState(pr: PRInfo): Promise<PRState> {
      return cache.getOrFetch<PRState>(
        cacheKey(pr, "getPRState"),
        async () => {
          const raw = await gh([
            "pr",
            "view",
            String(pr.number),
            "--repo",
            repoFlag(pr),
            "--json",
            "state",
          ]);
          const data: { state: string } = JSON.parse(raw);
          const s = data.state.toUpperCase();
          if (s === "MERGED") return "merged";
          if (s === "CLOSED") return "closed";
          return "open";
        },
        CACHE_TTL.getPRState,
      );
    },

    async getPRSummary(pr: PRInfo) {
      const raw = await gh([
        "pr",
        "view",
        String(pr.number),
        "--repo",
        repoFlag(pr),
        "--json",
        "state,title,additions,deletions",
      ]);
      const data: {
        state: string;
        title: string;
        additions: number;
        deletions: number;
      } = JSON.parse(raw);
      const s = data.state.toUpperCase();
      const state: PRState = s === "MERGED" ? "merged" : s === "CLOSED" ? "closed" : "open";
      return {
        state,
        title: data.title ?? "",
        additions: data.additions ?? 0,
        deletions: data.deletions ?? 0,
      };
    },

    async mergePR(pr: PRInfo, method: MergeMethod = "squash"): Promise<void> {
      const flag = method === "rebase" ? "--rebase" : method === "merge" ? "--merge" : "--squash";

      // Do NOT use --delete-branch here. When multiple PRs share the same
      // branch, deleting the branch closes ALL other PRs on that branch.
      // Branch cleanup is handled separately by worktree cleanup.
      await gh(["pr", "merge", String(pr.number), "--repo", repoFlag(pr), flag]);

      // Invalidate cached mergeability/PR state for ALL PRs in this repo.
      // After a merge, other PRs become behind the base branch, so their
      // cached "mergeable" status is stale. Without this, the next poll
      // cycle would still see them as mergeable and attempt (and fail) to merge.
      const repoPrefix = `${pr.owner}/${pr.repo}#`;
      cache.invalidatePrefix(repoPrefix);
    },

    async rebasePR(pr: PRInfo): Promise<void> {
      // Use GitHub's "update branch" API to update server-side.
      // `merge` method adds a merge commit from the base branch — avoids
      // rewriting commit SHAs which would force-push the PR branch, re-trigger
      // all CI checks, and send noisy notifications. Since PRs are squash-merged,
      // the merge commit doesn't affect the final result on the base branch.
      await gh([
        "api",
        "--method",
        "PUT",
        `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/update-branch`,
      ]);
    },

    async closePR(pr: PRInfo): Promise<void> {
      await gh(["pr", "close", String(pr.number), "--repo", repoFlag(pr)]);
    },

    async getCIChecks(pr: PRInfo): Promise<CICheck[]> {
      try {
        const raw = await gh([
          "pr",
          "checks",
          String(pr.number),
          "--repo",
          repoFlag(pr),
          "--json",
          "name,state,link,startedAt,completedAt",
        ]);

        const checks: Array<{
          name: string;
          state: string;
          link: string;
          startedAt: string;
          completedAt: string;
        }> = JSON.parse(raw);

        return checks.map((c) => {
          let status: CICheck["status"];
          const state = c.state?.toUpperCase();

          // gh pr checks returns state directly: SUCCESS, FAILURE, PENDING, QUEUED, etc.
          if (state === "PENDING" || state === "QUEUED") {
            status = "pending";
          } else if (state === "IN_PROGRESS") {
            status = "running";
          } else if (state === "SUCCESS") {
            status = "passed";
          } else if (
            state === "FAILURE" ||
            state === "TIMED_OUT" ||
            state === "CANCELLED" ||
            state === "ACTION_REQUIRED"
          ) {
            status = "failed";
          } else if (state === "SKIPPED" || state === "NEUTRAL") {
            status = "skipped";
          } else {
            // Unknown state on a check — fail closed for safety
            status = "failed";
          }

          return {
            name: c.name,
            status,
            url: c.link || undefined,
            conclusion: state || undefined, // Store original state for debugging
            startedAt: c.startedAt ? new Date(c.startedAt) : undefined,
            completedAt: c.completedAt ? new Date(c.completedAt) : undefined,
          };
        });
      } catch (err) {
        // Propagate so callers (getCISummary) can decide how to handle.
        // Do NOT silently return [] — that causes a fail-open where CI
        // appears healthy when we simply failed to fetch check status.
        throw new Error("Failed to fetch CI checks", { cause: err });
      }
    },

    async getCISummary(pr: PRInfo): Promise<CIStatus> {
      return cache.getOrFetch<CIStatus>(
        cacheKey(pr, "getCISummary"),
        async () => {
          let checks: CICheck[];
          try {
            checks = await this.getCIChecks(pr);
          } catch {
            // Before fail-closing, check if the PR is merged/closed —
            // GitHub may not return check data for those, and reporting
            // "failing" for a merged PR is wrong.
            try {
              const state = await this.getPRState(pr);
              if (state === "merged" || state === "closed") return "none";
            } catch {
              // Can't determine state either; fall through to fail-closed.
            }
            // Fail closed for open PRs: report as failing rather than
            // "none" (which getMergeability treats as passing).
            return "failing";
          }
          if (checks.length === 0) return "none";

          const hasFailing = checks.some((c) => c.status === "failed");
          if (hasFailing) return "failing";

          const hasPending = checks.some(
            (c) => c.status === "pending" || c.status === "running",
          );
          if (hasPending) return "pending";

          // Only report passing if at least one check actually passed
          // (not all skipped)
          const hasPassing = checks.some((c) => c.status === "passed");
          if (!hasPassing) return "none";

          return "passing";
        },
        CACHE_TTL.getCISummary,
      );
    },

    async getReviews(pr: PRInfo): Promise<Review[]> {
      const raw = await gh([
        "pr",
        "view",
        String(pr.number),
        "--repo",
        repoFlag(pr),
        "--json",
        "reviews",
      ]);
      const data: {
        reviews: Array<{
          author: { login: string };
          state: string;
          body: string;
          submittedAt: string;
        }>;
      } = JSON.parse(raw);

      return data.reviews.map((r) => {
        let state: Review["state"];
        const s = r.state?.toUpperCase();
        if (s === "APPROVED") state = "approved";
        else if (s === "CHANGES_REQUESTED") state = "changes_requested";
        else if (s === "DISMISSED") state = "dismissed";
        else if (s === "PENDING") state = "pending";
        else state = "commented";

        return {
          author: r.author?.login ?? "unknown",
          state,
          body: r.body || undefined,
          submittedAt: parseDate(r.submittedAt),
        };
      });
    },

    async getReviewDecision(pr: PRInfo): Promise<ReviewDecision> {
      return cache.getOrFetch<ReviewDecision>(
        cacheKey(pr, "getReviewDecision"),
        async () => {
          const raw = await gh([
            "pr",
            "view",
            String(pr.number),
            "--repo",
            repoFlag(pr),
            "--json",
            "reviewDecision",
          ]);
          const data: { reviewDecision: string } = JSON.parse(raw);

          const d = (data.reviewDecision ?? "").toUpperCase();
          if (d === "APPROVED") return "approved";
          if (d === "CHANGES_REQUESTED") return "changes_requested";
          if (d === "REVIEW_REQUIRED") return "pending";
          return "none";
        },
        CACHE_TTL.getReviewDecision,
      );
    },

    async getPendingComments(pr: PRInfo): Promise<ReviewComment[]> {
      return cache.getOrFetch<ReviewComment[]>(
        cacheKey(pr, "getPendingComments"),
        async () => {
          // Fetch inline review threads and general PR comments in parallel
          const [reviewComments, issueComments] = await Promise.all([
            fetchReviewThreadComments(pr),
            fetchIssueComments(pr),
          ]);

          return [...reviewComments, ...issueComments];
        },
        CACHE_TTL.getPendingComments,
      );
    },

    async getAutomatedComments(pr: PRInfo): Promise<AutomatedComment[]> {
      return cache.getOrFetch<AutomatedComment[]>(
        cacheKey(pr, "getAutomatedComments"),
        async () => {
          try {
            // Fetch all review comments with max page size (100 is GitHub's limit)
            const raw = await gh([
              "api",
              `repos/${repoFlag(pr)}/pulls/${pr.number}/comments?per_page=100`,
            ]);

            const comments: Array<{
              id: number;
              user: { login: string };
              body: string;
              path: string;
              line: number | null;
              original_line: number | null;
              created_at: string;
              html_url: string;
            }> = JSON.parse(raw);

            return comments
              .filter((c) => BOT_AUTHORS.has(c.user?.login ?? ""))
              .map((c) => {
                // Determine severity from body content
                let severity: AutomatedComment["severity"] = "info";
                const bodyLower = c.body.toLowerCase();
                if (
                  bodyLower.includes("error") ||
                  bodyLower.includes("bug") ||
                  bodyLower.includes("critical") ||
                  bodyLower.includes("potential issue")
                ) {
                  severity = "error";
                } else if (
                  bodyLower.includes("warning") ||
                  bodyLower.includes("suggest") ||
                  bodyLower.includes("consider")
                ) {
                  severity = "warning";
                }

                return {
                  id: String(c.id),
                  botName: c.user?.login ?? "unknown",
                  body: c.body,
                  path: c.path || undefined,
                  line: c.line ?? c.original_line ?? undefined,
                  severity,
                  createdAt: parseDate(c.created_at),
                  url: c.html_url,
                };
              });
          } catch {
            return [];
          }
        },
        CACHE_TTL.getAutomatedComments,
      );
    },

    async getChangedFiles(pr: PRInfo): Promise<string[]> {
      const raw = await gh([
        "pr",
        "diff",
        String(pr.number),
        "--repo",
        repoFlag(pr),
        "--name-only",
      ]);
      return raw
        .split("\n")
        .map((f) => f.trim())
        .filter(Boolean);
    },

    async postComment(pr: PRInfo, body: string, images?: string[]): Promise<string> {
      // If images are provided, upload them first and embed in the body
      // Append agent signature so getPendingComments() can filter out our own replies
      let commentBody = body + AGENT_COMMENT_SIGNATURE;

      if (images && images.length > 0) {
        // GitHub doesn't support direct image upload via gh CLI.
        // We use the gh api to upload images as PR comment attachments.
        // Workaround: embed images as base64 data URIs or use repo assets.
        // For now, we upload via gh issue comment which supports markdown images
        // if the images are accessible via URL. For local files, we note the paths.
        const imageMarkdown = images
          .map((imgPath, i) => {
            // Use relative path as alt text
            const name = imgPath.split("/").pop() ?? `screenshot-${i + 1}`;
            // GitHub PR comments can reference images uploaded to the repo
            // For local files, we'll note them — the caller can upload separately
            return `![${name}](${imgPath})`;
          })
          .join("\n");
        commentBody = `${body}\n\n${imageMarkdown}`;
      }

      const result = await gh([
        "pr",
        "comment",
        String(pr.number),
        "--repo",
        repoFlag(pr),
        "--body",
        commentBody,
      ]);

      return result;
    },

    async addReaction(
      commentId: string,
      pr: PRInfo,
      reaction: string,
      commentType: "issue_comment" | "review_comment",
    ): Promise<void> {
      const endpoint =
        commentType === "issue_comment"
          ? `repos/${repoFlag(pr)}/issues/comments/${commentId}/reactions`
          : `repos/${repoFlag(pr)}/pulls/comments/${commentId}/reactions`;

      await gh(["api", "--method", "POST", "-f", `content=${reaction}`, endpoint]);
    },

    async resolveThread(threadId: string, pr: PRInfo): Promise<void> {
      await gh([
        "api",
        "graphql",
        "-f",
        `threadId=${threadId}`,
        "-f",
        `query=mutation($threadId: ID!) {
          resolveReviewThread(input: { threadId: $threadId }) {
            thread { isResolved }
          }
        }`,
      ]);
      // Invalidate cached pending comments so the next poll sees resolved state
      cache.invalidatePrefix(cacheKey(pr, "getPendingComments"));
    },

    async getMergeability(pr: PRInfo): Promise<MergeReadiness> {
      return cache.getOrFetch<MergeReadiness>(
        cacheKey(pr, "getMergeability"),
        async () => {
          const blockers: string[] = [];

          // First, check if the PR is merged
          // GitHub returns mergeable=null for merged PRs, which is not useful
          // Note: We only skip checks for merged PRs. Closed PRs still need accurate status.
          const state = await this.getPRState(pr);
          if (state === "merged") {
            return {
              mergeable: true,
              ciPassing: true,
              approved: true,
              noConflicts: true,
              blockers: [],
            };
          }

          // Fetch PR details with merge state
          const raw = await gh([
            "pr",
            "view",
            String(pr.number),
            "--repo",
            repoFlag(pr),
            "--json",
            "mergeable,reviewDecision,mergeStateStatus,isDraft",
          ]);

          const data: {
            mergeable: string;
            reviewDecision: string;
            mergeStateStatus: string;
            isDraft: boolean;
          } = JSON.parse(raw);

          // CI
          const ciStatus = await this.getCISummary(pr);
          const ciPassing =
            ciStatus === CI_STATUS.PASSING || ciStatus === CI_STATUS.NONE;
          if (!ciPassing) {
            blockers.push(`CI is ${ciStatus}`);
          }

          // Reviews
          const reviewDecision = (data.reviewDecision ?? "").toUpperCase();
          const approved = reviewDecision === "APPROVED";
          if (reviewDecision === "CHANGES_REQUESTED") {
            blockers.push("Changes requested in review");
          } else if (reviewDecision === "REVIEW_REQUIRED") {
            blockers.push("Review required");
          }

          // Conflicts / merge state
          //
          // IMPORTANT: With "require branches to be up to date" branch protection,
          // GitHub returns mergeable="CONFLICTING" even when the branch is simply
          // behind (no actual file conflicts). We distinguish the two cases using
          // mergeStateStatus: "BEHIND" means just outdated, while real conflicts
          // will have mergeStateStatus "DIRTY" or mergeable "CONFLICTING" without
          // being merely "BEHIND".
          const mergeable = (data.mergeable ?? "").toUpperCase();
          const mergeState = (data.mergeStateStatus ?? "").toUpperCase();
          const isBehind = mergeState === "BEHIND";
          // noConflicts means "no actual file-level merge conflicts".
          // UNKNOWN/empty means GitHub is still computing — NOT evidence of conflicts.
          // CONFLICTING + BEHIND means the branch is just outdated, not conflicting.
          const noConflicts =
            mergeable === "MERGEABLE" ||
            mergeable === "UNKNOWN" ||
            mergeable === "" ||
            (mergeable === "CONFLICTING" && isBehind);
          if (mergeable === "CONFLICTING" && !isBehind) {
            blockers.push("Merge conflicts");
          } else if (
            (mergeable === "UNKNOWN" || mergeable === "") &&
            !isBehind
          ) {
            blockers.push("Merge status unknown (GitHub is computing)");
          }
          // When branch is behind AND GitHub reports CONFLICTING, the branch
          // needs updating. We add it as a blocker so the lifecycle manager
          // knows WHY the PR isn't mergeable and can take targeted action
          // (e.g. rebase) instead of blindly retrying merge.
          if (isBehind && mergeable === "CONFLICTING") {
            blockers.push("Branch is behind the base branch");
          }
          if (mergeState === "BLOCKED") {
            blockers.push("Merge is blocked by branch protection");
          } else if (mergeState === "UNSTABLE") {
            blockers.push("Required checks are failing");
          }

          // Draft
          if (data.isDraft) {
            blockers.push("PR is still a draft");
          }

          return {
            mergeable: blockers.length === 0,
            ciPassing,
            approved,
            noConflicts,
            blockers,
          };
        },
        CACHE_TTL.getMergeability,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "github",
  slot: "scm" as const,
  description: "SCM plugin: GitHub PRs, CI checks, reviews, merge readiness",
  version: "0.1.0",
};

export function create(): SCM {
  return createGitHubSCM();
}

export default { manifest, create } satisfies PluginModule<SCM>;
