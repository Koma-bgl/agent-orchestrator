import { describe, it, expect } from "vitest";
import {
  filterAoVerifyComments,
  AO_VERIFY_MARKER,
} from "../comment-filter.js";

describe("filterAoVerifyComments", () => {
  it("filters out comments containing the ao-verify marker", () => {
    const comments = [
      { body: "This is a normal comment" },
      { body: "This has <!-- ao-verify: some data --> in it" },
      { body: "Another normal comment" },
    ];
    const result = filterAoVerifyComments(comments);
    expect(result).toHaveLength(2);
    expect(result[0].body).toBe("This is a normal comment");
    expect(result[1].body).toBe("Another normal comment");
  });

  it("preserves input immutability (does not mutate original array)", () => {
    const comments = [
      { body: "Normal comment" },
      { body: "<!-- ao-verify: marker --> in comment" },
    ];
    const originalLength = comments.length;
    filterAoVerifyComments(comments);
    expect(comments).toHaveLength(originalLength);
  });

  it("matches marker anywhere in the body string", () => {
    const comments = [
      { body: "<!-- ao-verify: at start" },
      { body: "in the middle <!-- ao-verify: here" },
      { body: "at the end <!-- ao-verify:" },
    ];
    const result = filterAoVerifyComments(comments);
    expect(result).toHaveLength(0);
  });

  it("preserves all fields of non-filtered comments", () => {
    const comments = [
      {
        body: "A comment",
        id: "123",
        author: "bot",
        createdAt: "2024-01-01",
      },
    ];
    const result = filterAoVerifyComments(comments);
    expect(result[0]).toEqual(comments[0]);
  });

  it("returns an empty array when given an empty array", () => {
    const result = filterAoVerifyComments([]);
    expect(result).toEqual([]);
  });

  it("exports AO_VERIFY_MARKER constant with correct value", () => {
    expect(AO_VERIFY_MARKER).toBe("<!-- ao-verify:");
  });

  it("differentiates between similar but non-matching strings", () => {
    const comments = [
      { body: "<!-- ao-verify: this matches" },
      { body: "<!-- ao-verify this does NOT match (space instead of colon)" },
      { body: "<!--ao-verify: no space before" },
      { body: "Normal comment about verification" },
    ];
    const result = filterAoVerifyComments(comments);
    expect(result).toHaveLength(3);
    expect(result[0].body).toBe(
      "<!-- ao-verify this does NOT match (space instead of colon)"
    );
    expect(result[1].body).toBe("<!--ao-verify: no space before");
    expect(result[2].body).toBe("Normal comment about verification");
  });
});
