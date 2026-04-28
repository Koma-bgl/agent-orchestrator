import { describe, it, expect } from "vitest";
import { checkScope } from "./scope-checker.js";

describe("checkScope", () => {
  it("returns null when all files match allowed globs", () => {
    expect(checkScope({
      changedFiles: ["src/sports/foo.ts", "src/sports/bar.tsx"],
      allowed: ["src/sports/**"],
    })).toBeNull();
  });

  it("flags out-of-scope files", () => {
    const v = checkScope({
      changedFiles: ["src/sports/foo.ts", "src/admin/bar.ts"],
      allowed: ["src/sports/**"],
    });
    expect(v).not.toBeNull();
    expect(v!.reason).toBe("out-of-scope-files");
    expect(v!.offending).toEqual(["src/admin/bar.ts"]);
    expect(v!.allowed).toEqual(["src/sports/**"]);
  });

  it("supports negation in allowed globs", () => {
    const v = checkScope({
      changedFiles: ["src/sports/apis/x.ts"],
      allowed: ["src/sports/**", "!src/sports/apis/**"],
    });
    expect(v?.reason).toBe("out-of-scope-files");
    expect(v?.offending).toEqual(["src/sports/apis/x.ts"]);
  });

  it("alwaysDeny wins over allowed", () => {
    const v = checkScope({
      changedFiles: ["src/sports/foo.ts", ".github/workflows/ci.yml"],
      allowed: ["**"],
      alwaysDeny: ["**/.github/**"],
    });
    expect(v?.reason).toBe("always-denied");
    expect(v?.offending).toEqual([".github/workflows/ci.yml"]);
  });

  it("flags too-many-files", () => {
    const files = Array.from({ length: 60 }, (_, i) => `src/sports/f${i}.ts`);
    const v = checkScope({
      changedFiles: files,
      allowed: ["src/sports/**"],
      maxFiles: 50,
    });
    expect(v?.reason).toBe("too-many-files");
    expect(v?.count).toBe(60);
    expect(v?.limit).toBe(50);
  });

  it("flags too-many-lines when totalLines provided", () => {
    const v = checkScope({
      changedFiles: ["src/sports/foo.ts"],
      allowed: ["src/sports/**"],
      maxLines: 100,
      totalLines: 500,
    });
    expect(v?.reason).toBe("too-many-lines");
    expect(v?.count).toBe(500);
    expect(v?.offending).toEqual(["src/sports/foo.ts"]);
  });

  it("returns null when no allowed globs (scope guard disabled)", () => {
    expect(checkScope({
      changedFiles: ["anything.ts"],
      allowed: [],
    })).toBeNull();
  });

  it("normalizes leading ./ in changed files", () => {
    expect(checkScope({
      changedFiles: ["./src/sports/foo.ts"],
      allowed: ["src/sports/**"],
    })).toBeNull();
  });
});
