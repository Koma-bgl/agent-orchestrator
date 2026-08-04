import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPrTitle, parseSessionRecord, pickOrphanPr, upsertRecordField } from "./queue-poller.mjs";

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

// --- orphan-PR linking (killed-before-link sessions) ---------------------------

test("pickOrphanPr: prefers the first OPEN PR", () => {
  const pr = pickOrphanPr([
    { number: 5, url: "u5", state: "MERGED" },
    { number: 7, url: "u7", state: "OPEN" },
    { number: 8, url: "u8", state: "OPEN" },
  ]);
  assert.deepEqual(pr, { number: 7, url: "u7", state: "OPEN" });
});

test("pickOrphanPr: falls back to the first MERGED when nothing is open", () => {
  const pr = pickOrphanPr([
    { number: 3, url: "u3", state: "CLOSED" },
    { number: 5, url: "u5", state: "MERGED" },
  ]);
  assert.deepEqual(pr, { number: 5, url: "u5", state: "MERGED" });
});

test("pickOrphanPr: closed-only or empty -> null", () => {
  assert.equal(pickOrphanPr([{ number: 1, url: "u1", state: "CLOSED" }]), null);
  assert.equal(pickOrphanPr([]), null);
  assert.equal(pickOrphanPr(null), null);
});

test("upsertRecordField: appends a missing key with trailing newline preserved", () => {
  const next = upsertRecordField("branch=feat/X\nstatus=killed\n", "pr", "https://g/pull/1");
  assert.equal(next, "branch=feat/X\nstatus=killed\npr=https://g/pull/1\n");
});

test("upsertRecordField: appends when the file lacks a trailing newline", () => {
  const next = upsertRecordField("branch=feat/X\nstatus=killed", "pr", "https://g/pull/1");
  assert.equal(next, "branch=feat/X\nstatus=killed\npr=https://g/pull/1\n");
});

test("upsertRecordField: replaces an existing key in place", () => {
  const next = upsertRecordField("branch=feat/X\nstatus=killed\npr=old\n", "status", "merged");
  assert.equal(next, "branch=feat/X\nstatus=merged\npr=old\n");
});

test("upsertRecordField: round-trips through parseSessionRecord", () => {
  let text = "worktree=/w\nbranch=feat/SPOR-3349\nstatus=killed\n";
  text = upsertRecordField(text, "pr", "https://github.com/bitgaming/valhalla/pull/10993");
  text = upsertRecordField(text, "status", "merged");
  const rec = parseSessionRecord(text);
  assert.equal(rec.pr, "https://github.com/bitgaming/valhalla/pull/10993");
  assert.equal(rec.status, "merged");
  assert.equal(rec.branch, "feat/SPOR-3349");
});
