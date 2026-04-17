import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Regression test for Task 5.2: verify-marked comments must be dropped at the
// earliest point in the review-comment ingestion pipeline, so no downstream
// code (lifecycle reactions, notifier, dashboard) ever sees them.
//
// Mocks node:child_process exactly like test/index.test.ts so that
// promisify(execFile) resolves to our ghMock fn.
// ---------------------------------------------------------------------------

const { ghMock } = vi.hoisted(() => ({ ghMock: vi.fn() }));

vi.mock("node:child_process", () => {
  const execFile = Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: ghMock,
  });
  return { execFile };
});

import { create } from "../index.js";
import type { PRInfo } from "@composio/ao-core";

const pr: PRInfo = {
  number: 42,
  url: "https://github.com/acme/repo/pull/42",
  title: "feat: add feature",
  owner: "acme",
  repo: "repo",
  branch: "feat/my-feature",
  baseBranch: "main",
  isDraft: false,
};

function mockGhOnce(result: unknown): void {
  ghMock.mockResolvedValueOnce({ stdout: JSON.stringify(result) });
}

function makeReviewThreads(
  threads: Array<{
    isResolved: boolean;
    id: string;
    author: string | null;
    body: string;
  }>,
): unknown {
  return {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: threads.map((t) => ({
              isResolved: t.isResolved,
              comments: {
                nodes: [
                  {
                    databaseId: Number(t.id.replace(/\D/g, "")) || 1,
                    author: t.author ? { login: t.author } : null,
                    body: t.body,
                    path: "a.ts",
                    line: 1,
                    url: "https://github.com/c/" + t.id,
                    createdAt: "2025-01-01T00:00:00Z",
                  },
                ],
              },
            })),
          },
        },
      },
    },
  };
}

describe("scm-github ingestion — ao-verify filter", () => {
  let scm: ReturnType<typeof create>;

  beforeEach(() => {
    vi.clearAllMocks();
    scm = create();
  });

  it("drops ao-verify-marked review-thread comments from getPendingComments", async () => {
    // First gh() call → review threads (GraphQL). Second → issue comments.
    mockGhOnce(
      makeReviewThreads([
        {
          isResolved: false,
          id: "C1",
          author: "alice",
          body: "Please fix this bug on line 10",
        },
        {
          isResolved: false,
          id: "C2",
          author: "alice",
          body: "<!-- ao-verify:result -->\nVerification screenshots attached",
        },
      ]),
    );
    // Issue comments REST response — empty
    mockGhOnce([]);

    const comments = await scm.getPendingComments(pr);

    expect(comments).toHaveLength(1);
    expect(comments[0].id).toBe("1");
    expect(comments[0].body).not.toContain("<!-- ao-verify:");
  });

  it("drops ao-verify-marked issue comments from getPendingComments", async () => {
    // Review threads — empty
    mockGhOnce(makeReviewThreads([]));
    // Issue comments — mixed
    mockGhOnce([
      {
        id: 101,
        user: { login: "alice" },
        body: "Looks good overall, one nit below",
        created_at: "2025-01-01T00:00:00Z",
        html_url: "https://github.com/c/101",
      },
      {
        id: 102,
        user: { login: "alice" },
        body: "<!-- ao-verify:summary -->\nVerifier posted screenshots",
        created_at: "2025-01-01T00:00:01Z",
        html_url: "https://github.com/c/102",
      },
    ]);

    const comments = await scm.getPendingComments(pr);

    expect(comments).toHaveLength(1);
    expect(comments[0].id).toBe("101");
    expect(comments.some((c) => c.body.includes("<!-- ao-verify:"))).toBe(false);
  });

  it("drops ao-verify-marked comments from getAutomatedComments", async () => {
    // getAutomatedComments makes a single REST call for /pulls/:n/comments
    mockGhOnce([
      {
        id: 1,
        user: { login: "cursor[bot]" },
        body: "Found a potential issue on line 5",
        path: "a.ts",
        line: 5,
        original_line: null,
        created_at: "2025-01-01T00:00:00Z",
        html_url: "https://github.com/c/1",
      },
      {
        id: 2,
        user: { login: "cursor[bot]" },
        body: "<!-- ao-verify:result -->\nShould never reach here",
        path: "a.ts",
        line: 10,
        original_line: null,
        created_at: "2025-01-01T00:00:00Z",
        html_url: "https://github.com/c/2",
      },
    ]);

    const comments = await scm.getAutomatedComments(pr);

    expect(comments).toHaveLength(1);
    expect(comments[0].id).toBe("1");
    expect(comments.some((c) => c.body.includes("<!-- ao-verify:"))).toBe(false);
  });
});
