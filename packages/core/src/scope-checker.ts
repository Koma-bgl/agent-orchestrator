import micromatch from "micromatch";
import type { ScopeViolation } from "./types.js";

export interface CheckScopeInput {
  changedFiles: string[];
  allowed: string[];
  alwaysDeny?: string[];
  maxFiles?: number;
  maxLines?: number;
  /** Total added+removed lines; only enforced if maxLines also set. */
  totalLines?: number;
}

/**
 * Pure function. Returns the first violation found, or null if scope is satisfied.
 * Order of precedence: alwaysDeny > out-of-scope-files > too-many-files > too-many-lines.
 */
export function checkScope(input: CheckScopeInput): ScopeViolation | null {
  const { allowed, alwaysDeny, maxFiles, maxLines, totalLines } = input;
  const changedFiles = input.changedFiles.map((f) => f.replace(/^\.\//, ""));

  if (allowed.length === 0) return null; // disabled

  if (alwaysDeny && alwaysDeny.length > 0) {
    const denied = micromatch(changedFiles, alwaysDeny);
    if (denied.length > 0) {
      return { offending: denied, allowed, reason: "always-denied" };
    }
  }

  const allowedSet = new Set(micromatch(changedFiles, allowed));
  const offending = changedFiles.filter((f) => !allowedSet.has(f));
  if (offending.length > 0) {
    return { offending, allowed, reason: "out-of-scope-files" };
  }

  if (maxFiles !== undefined && changedFiles.length > maxFiles) {
    return {
      offending: changedFiles,
      allowed,
      reason: "too-many-files",
      count: changedFiles.length,
      limit: maxFiles,
    };
  }

  if (maxLines !== undefined && totalLines !== undefined && totalLines > maxLines) {
    return {
      offending: changedFiles,
      allowed,
      reason: "too-many-lines",
      count: totalLines,
      limit: maxLines,
    };
  }

  return null;
}
