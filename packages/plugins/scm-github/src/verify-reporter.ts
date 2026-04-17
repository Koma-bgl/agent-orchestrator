import type { VerifierResult } from "@composio/ao-core";
import { AO_VERIFY_MARKER } from "./comment-filter.js";

const STATUS_BEGIN = "<!-- ao-verify-status -->";
const STATUS_END = "<!-- /ao-verify-status -->";
// Matches the whole delimited block (non-greedy, multiline DOT).
const STATUS_RE = new RegExp(
  `${escapeRegex(STATUS_BEGIN)}[\\s\\S]*?${escapeRegex(STATUS_END)}`,
);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace the delimited `<!-- ao-verify-status -->…<!-- /ao-verify-status -->`
 * block in the PR body with a new single-line status. If the block is absent,
 * append it to the end of the body.
 *
 * Pure function — does not mutate the input.
 */
export function updatePrBodyStatusLine(body: string, statusLine: string): string {
  const block = `${STATUS_BEGIN}${statusLine}${STATUS_END}`;
  if (STATUS_RE.test(body)) {
    return body.replace(STATUS_RE, block);
  }
  if (body.length === 0) return block;
  return `${body.trimEnd()}\n\n${block}\n`;
}

interface OctokitLike {
  rest: {
    issues: {
      createComment: (args: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }) => Promise<unknown>;
    };
  };
}

interface PostVerifierCommentArgs {
  owner: string;
  repo: string;
  prNumber: number;
  result: VerifierResult;
}

/**
 * Post a new PR comment reporting a verifier run's result. The posted body
 * always begins with the `AO_VERIFY_MARKER` so it's excluded from the
 * review-comment ingestion pipeline (see comment-filter.ts).
 */
export async function postVerifierComment(
  octokit: OctokitLike,
  args: PostVerifierCommentArgs,
): Promise<void> {
  const body = renderBody(args.result);
  await octokit.rest.issues.createComment({
    owner: args.owner,
    repo: args.repo,
    issue_number: args.prNumber,
    body,
  });
}

function renderBody(r: VerifierResult): string {
  const icon = r.verdict === "pass" ? "✅" : "❌";
  const verdict = r.verdict.toUpperCase();
  const lines: string[] = [
    `${AO_VERIFY_MARKER}result -->`,
    `${icon} **UI Verification: ${verdict}**`,
    "",
    r.summary,
    "",
  ];
  for (const s of r.screenshots) {
    lines.push(`![${s.label}](${s.path})`);
  }
  if (r.observations.consoleErrors.length > 0) {
    lines.push(
      "",
      "<details>",
      "<summary>Console errors</summary>",
      "",
      ...r.observations.consoleErrors,
      "</details>",
    );
  }
  if (r.observations.networkFailures.length > 0) {
    lines.push(
      "",
      "<details>",
      "<summary>Network failures</summary>",
      "",
      ...r.observations.networkFailures,
      "</details>",
    );
  }
  lines.push(
    "",
    "<details>",
    "<summary>Steps taken</summary>",
    "",
    ...r.observations.stepsTaken,
    "</details>",
  );
  return lines.join("\n");
}
