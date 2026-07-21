import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPrTitle, parseSessionRecord } from "./queue-poller.mjs";

test("formatPrTitle: conventional fix -> [Bugfix][TICKET]", () => {
  assert.equal(
    formatPrTitle("fix: sidesheet toggle re-renders SGP grid", "SPOR-3272"),
    "[Bugfix][SPOR-3272] Sidesheet toggle re-renders SGP grid",
  );
});

test("formatPrTitle: conventional feat with scope -> [Feat][TICKET]", () => {
  assert.equal(
    formatPrTitle("feat(sports): add cashout card", "SPOR-1"),
    "[Feat][SPOR-1] Add cashout card",
  );
});

test("formatPrTitle: perf/chore/refactor mapped", () => {
  assert.equal(formatPrTitle("perf: memoize selector", "T-1"), "[Perf][T-1] Memoize selector");
  assert.equal(formatPrTitle("chore: bump deps", "T-2"), "[Chore][T-2] Bump deps");
  assert.equal(formatPrTitle("refactor: split module", "T-3"), "[Refactor][T-3] Split module");
});

test("formatPrTitle: strips a trailing [TICKET] suffix", () => {
  assert.equal(
    formatPrTitle("fix(sports): avoid per-key RegExp compilation [SPOR-3266]", "SPOR-3266"),
    "[Bugfix][SPOR-3266] Avoid per-key RegExp compilation",
  );
});

test("formatPrTitle: already-correct title is left unchanged (null)", () => {
  assert.equal(formatPrTitle("[Bugfix][SPOR-3272] Stop the re-render", "SPOR-3272"), null);
  assert.equal(formatPrTitle("[Feat][BALI-1] Do the thing", "BALI-1"), null);
});

test("formatPrTitle: ticket match is case-insensitive but output uppercases", () => {
  assert.equal(formatPrTitle("fix: thing", "spor-9"), "[Bugfix][SPOR-9] Thing");
});

test("formatPrTitle: existing [type] bracket but missing ticket gets ticket injected", () => {
  assert.equal(formatPrTitle("[Fix] Some bug", "T-5"), "[Bugfix][T-5] Some bug");
});

test("formatPrTitle: leading bare [TICKET] gets a type + reorder", () => {
  assert.equal(formatPrTitle("[SPOR-7] Fix the grid", "SPOR-7"), "[Chore][SPOR-7] Fix the grid");
});

test("formatPrTitle: unknown/no type defaults to Chore but always carries the ticket", () => {
  assert.equal(formatPrTitle("just some words", "T-8"), "[Chore][T-8] Just some words");
});

test("formatPrTitle: no ticket -> null (cannot format)", () => {
  assert.equal(formatPrTitle("fix: whatever", ""), null);
  assert.equal(formatPrTitle("fix: whatever", null), null);
});

test("parseSessionRecord: extracts status + worktree from the line-based store file", () => {
  const rec = parseSessionRecord(
    "worktree=/root/.worktrees/valhalla/val-1\nbranch=feat/SPOR-3256\nstatus=merged\nissue=SPOR-3256\n" +
      'runtimeHandle={"id":"x","data":{"workspacePath":"/root/.worktrees/valhalla/val-1"}}\n' +
      "pr=https://github.com/bitgaming/valhalla/pull/10605\n",
  );
  assert.equal(rec.status, "merged");
  assert.equal(rec.worktree, "/root/.worktrees/valhalla/val-1");
  assert.equal(rec.branch, "feat/SPOR-3256");
});

test("parseSessionRecord: a killed session with no pr line has status=killed and no pr key", () => {
  const rec = parseSessionRecord("worktree=/root/.worktrees/valhalla/val-13\nbranch=feat/SPOR-3266\nstatus=killed\n");
  assert.equal(rec.status, "killed"); // reclaim keys off status===merged, so this is never touched
  assert.equal(rec.pr, undefined);
});

test("parseSessionRecord: tolerates blank lines / junk", () => {
  const rec = parseSessionRecord("\nstatus=merged\n\n# not a pair\nworktree=/x\n");
  assert.equal(rec.status, "merged");
  assert.equal(rec.worktree, "/x");
});
