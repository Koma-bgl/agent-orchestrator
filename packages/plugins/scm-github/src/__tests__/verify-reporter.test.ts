import { describe, it, expect, vi } from "vitest";
import type { VerifierResult } from "@composio/ao-core";
import { postVerifierComment, updatePrBodyStatusLine } from "../verify-reporter.js";
import { AO_VERIFY_MARKER } from "../comment-filter.js";

const makeResult = (verdict: "pass" | "fail"): VerifierResult => ({
  verdict,
  summary: "Tested the dashboard; loaded and responded to clicks.",
  screenshots: [
    { label: "dashboard", path: "/tmp/dashboard.png" },
  ],
  observations: {
    consoleErrors: [],
    networkFailures: [],
    stepsTaken: ["navigate /dashboard", "click Refresh"],
  },
});

describe("postVerifierComment", () => {
  it("always starts the posted body with the ao-verify marker", async () => {
    const createComment = vi.fn().mockResolvedValue({ data: { id: 1 } });
    const octokit = { rest: { issues: { createComment } } };
    await postVerifierComment(octokit as never, {
      owner: "o", repo: "r", prNumber: 42, result: makeResult("pass"),
    });
    const body = createComment.mock.calls[0][0].body as string;
    expect(body.startsWith(AO_VERIFY_MARKER)).toBe(true);
  });

  it("passes owner/repo/issue_number through to Octokit", async () => {
    const createComment = vi.fn().mockResolvedValue({ data: { id: 1 } });
    const octokit = { rest: { issues: { createComment } } };
    await postVerifierComment(octokit as never, {
      owner: "octo-org", repo: "my-app", prNumber: 7, result: makeResult("pass"),
    });
    const call = createComment.mock.calls[0][0];
    expect(call.owner).toBe("octo-org");
    expect(call.repo).toBe("my-app");
    expect(call.issue_number).toBe(7);
  });

  it("renders a pass verdict with a green check icon", async () => {
    const createComment = vi.fn().mockResolvedValue({ data: { id: 1 } });
    await postVerifierComment({ rest: { issues: { createComment } } } as never, {
      owner: "o", repo: "r", prNumber: 1, result: makeResult("pass"),
    });
    const body = createComment.mock.calls[0][0].body as string;
    expect(body).toMatch(/✅/);
    expect(body).toMatch(/PASS/i);
  });

  it("renders a fail verdict with a red X icon", async () => {
    const createComment = vi.fn().mockResolvedValue({ data: { id: 1 } });
    await postVerifierComment({ rest: { issues: { createComment } } } as never, {
      owner: "o", repo: "r", prNumber: 1, result: makeResult("fail"),
    });
    const body = createComment.mock.calls[0][0].body as string;
    expect(body).toMatch(/❌/);
    expect(body).toMatch(/FAIL/i);
  });

  it("includes the summary text in the body", async () => {
    const createComment = vi.fn().mockResolvedValue({ data: { id: 1 } });
    await postVerifierComment({ rest: { issues: { createComment } } } as never, {
      owner: "o", repo: "r", prNumber: 1, result: makeResult("pass"),
    });
    const body = createComment.mock.calls[0][0].body as string;
    expect(body).toContain("Tested the dashboard");
  });

  it("includes screenshots as markdown images", async () => {
    const createComment = vi.fn().mockResolvedValue({ data: { id: 1 } });
    await postVerifierComment({ rest: { issues: { createComment } } } as never, {
      owner: "o", repo: "r", prNumber: 1, result: makeResult("pass"),
    });
    const body = createComment.mock.calls[0][0].body as string;
    expect(body).toContain("![dashboard](/tmp/dashboard.png)");
  });

  it("includes steps-taken as a collapsed details block", async () => {
    const createComment = vi.fn().mockResolvedValue({ data: { id: 1 } });
    await postVerifierComment({ rest: { issues: { createComment } } } as never, {
      owner: "o", repo: "r", prNumber: 1, result: makeResult("pass"),
    });
    const body = createComment.mock.calls[0][0].body as string;
    expect(body).toContain("<details>");
    expect(body).toContain("<summary>Steps taken</summary>");
    expect(body).toContain("navigate /dashboard");
    expect(body).toContain("click Refresh");
  });

  it("omits empty console/network sections", async () => {
    const createComment = vi.fn().mockResolvedValue({ data: { id: 1 } });
    await postVerifierComment({ rest: { issues: { createComment } } } as never, {
      owner: "o", repo: "r", prNumber: 1, result: makeResult("pass"),
    });
    const body = createComment.mock.calls[0][0].body as string;
    // makeResult has no console or network errors
    expect(body).not.toContain("Console errors");
    expect(body).not.toContain("Network failures");
  });

  it("renders console errors when present", async () => {
    const createComment = vi.fn().mockResolvedValue({ data: { id: 1 } });
    const result = makeResult("fail");
    result.observations.consoleErrors = ["TypeError: x is undefined at app.js:42"];
    await postVerifierComment({ rest: { issues: { createComment } } } as never, {
      owner: "o", repo: "r", prNumber: 1, result,
    });
    const body = createComment.mock.calls[0][0].body as string;
    expect(body).toContain("<summary>Console errors</summary>");
    expect(body).toContain("TypeError: x is undefined at app.js:42");
  });

  it("renders network failures when present", async () => {
    const createComment = vi.fn().mockResolvedValue({ data: { id: 1 } });
    const result = makeResult("fail");
    result.observations.networkFailures = ["GET /api/users → 500"];
    await postVerifierComment({ rest: { issues: { createComment } } } as never, {
      owner: "o", repo: "r", prNumber: 1, result,
    });
    const body = createComment.mock.calls[0][0].body as string;
    expect(body).toContain("<summary>Network failures</summary>");
    expect(body).toContain("GET /api/users → 500");
  });
});

describe("updatePrBodyStatusLine", () => {
  it("replaces an existing status block in place", () => {
    const body = "Some description\n\n<!-- ao-verify-status -->⏳ Pending<!-- /ao-verify-status -->\n\nMore text";
    const updated = updatePrBodyStatusLine(body, "✅ Verified by ao at 12:34");
    expect(updated).toContain("✅ Verified by ao at 12:34");
    expect(updated).not.toContain("⏳ Pending");
    expect(updated).toContain("Some description");
    expect(updated).toContain("More text");
  });

  it("appends a status block when none exists", () => {
    const body = "Just a plain description";
    const updated = updatePrBodyStatusLine(body, "✅ Verified");
    expect(updated).toContain("Just a plain description");
    expect(updated).toContain("<!-- ao-verify-status -->✅ Verified<!-- /ao-verify-status -->");
  });

  it("handles an empty body by producing just the status block", () => {
    const updated = updatePrBodyStatusLine("", "❌ Failed");
    expect(updated).toContain("<!-- ao-verify-status -->❌ Failed<!-- /ao-verify-status -->");
  });

  it("replaces status block that spans multiple lines", () => {
    const body = "<!-- ao-verify-status -->\n⏳ Pending with\nmulti-line content\n<!-- /ao-verify-status -->";
    const updated = updatePrBodyStatusLine(body, "✅ Done");
    expect(updated).not.toContain("multi-line content");
    expect(updated).toContain("✅ Done");
  });

  it("does not mutate the input", () => {
    const body = "original";
    updatePrBodyStatusLine(body, "new status");
    expect(body).toBe("original");
  });

  it("handles only one status block even if marker appears multiple times", () => {
    // Defensive: we only replace the FIRST occurrence, since there should be exactly one.
    const body = "<!-- ao-verify-status -->A<!-- /ao-verify-status --> and <!-- ao-verify-status -->B<!-- /ao-verify-status -->";
    const updated = updatePrBodyStatusLine(body, "NEW");
    expect(updated).toContain("NEW");
    // At least the first one should be replaced
    expect(updated).not.toContain("ao-verify-status -->A<!--");
  });
});
