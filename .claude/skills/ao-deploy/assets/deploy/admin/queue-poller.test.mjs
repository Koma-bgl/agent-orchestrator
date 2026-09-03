import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveSessionRecord,
  classifyPane,
  formatPrTitle,
  isReapableRecord,
  parseSessionRecord,
  pickOrphanPr,
  upsertRecordField,
} from "./queue-poller.mjs";

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

test("archiveSessionRecord: copies the record into sessions/archive/<id>_<timestamp>", () => {
  const sessDir = mkdtempSync(join(tmpdir(), "ao-sess-"));
  const content = "worktree=/w\nbranch=feat/SPOR-1\nstatus=merged\npr=https://g/pull/1\n";
  writeFileSync(join(sessDir, "val-3"), content);
  const archived = archiveSessionRecord(sessDir, "val-3");
  assert.ok(archived, "returns the archive path");
  assert.equal(readFileSync(archived, "utf8"), content);
  const names = readdirSync(join(sessDir, "archive"));
  assert.equal(names.length, 1);
  assert.match(names[0], /^val-3_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
  // Archiving must not remove the live record — deletion stays the caller's job.
  assert.ok(existsSync(join(sessDir, "val-3")));
});

test("archiveSessionRecord: missing record -> null, no archive dir created", () => {
  const sessDir = mkdtempSync(join(tmpdir(), "ao-sess-"));
  assert.equal(archiveSessionRecord(sessDir, "val-9"), null);
  assert.ok(!existsSync(join(sessDir, "archive")));
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

// --- classifyPane (watchdog: what is actually on the agent's screen?) ---------

test("classifyPane: a live claude session with an in-flight turn is busy", () => {
  assert.equal(
    classifyPane("⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for age…"),
    "busy",
  );
});

test("classifyPane: an idle claude session at its prompt is claude", () => {
  assert.equal(classifyPane("❯ \n  ⏵⏵ bypass permissions on (shift+tab to cycle)"), "claude");
});

test("classifyPane: a bash prompt with no claude UI is shell", () => {
  // The SPOR-3537 shape (2026-09-03): claude was missing from PATH mid-self-update,
  // so ao's launch fell through to bash and typed the whole ticket in as commands.
  const pane = [
    "claude --dangerously-skip-permissions",
    "-bash: claude: command not found",
    "root@df0fbb736e9e:~/.worktrees/valhalla/val-18# You are an AI coding agent",
    "-bash: syntax error near unexpected token `('",
    "root@df0fbb736e9e:~/.worktrees/valhalla/val-18#",
  ].join("\n");
  assert.equal(classifyPane(pane), "shell");
});

test("classifyPane: shell detection needs a prompt, not just the words", () => {
  // An agent legitimately discussing a failed command must never read as a dead shell.
  assert.equal(
    classifyPane("❯ I ran it and got `command not found`, installing now\n  ⏵⏵ bypass permissions on"),
    "claude",
  );
});

test("classifyPane: an empty / not-yet-painted pane is unknown", () => {
  assert.equal(classifyPane(""), "unknown");
  assert.equal(classifyPane("   \n \n"), "unknown");
});

test("classifyPane: busy wins over shell — never touch a pane mid-turn", () => {
  assert.equal(
    classifyPane("root@host:~/w# something\nesc to interrupt"),
    "busy",
  );
});

// --- isReapableRecord (freeing a branch a dead session is squatting) ----------

const EMPTY = { ahead: 0, dirty: false, remoteBranch: false };

test("isReapableRecord: dead session, no PR, nothing committed -> reap", () => {
  const rec = { status: "killed", branch: "feat/SPOR-3537", worktree: "/w/val-18" };
  assert.equal(isReapableRecord(rec, EMPTY), true);
});

test("isReapableRecord: a live session is never reaped", () => {
  const rec = { status: "working", branch: "feat/SPOR-3537", worktree: "/w/val-18" };
  assert.equal(isReapableRecord(rec, EMPTY), false);
});

test("isReapableRecord: a linked PR is never reaped", () => {
  const rec = {
    status: "killed",
    branch: "feat/SPOR-3537",
    worktree: "/w/val-18",
    pr: "https://github.com/bitgaming/valhalla/pull/1",
  };
  assert.equal(isReapableRecord(rec, EMPTY), false);
});

test("isReapableRecord: commits, dirt, or a pushed branch all block the reap", () => {
  const rec = { status: "killed", branch: "feat/SPOR-3537", worktree: "/w/val-18" };
  assert.equal(isReapableRecord(rec, { ...EMPTY, ahead: 1 }), false);
  assert.equal(isReapableRecord(rec, { ...EMPTY, dirty: true }), false);
  assert.equal(isReapableRecord(rec, { ...EMPTY, remoteBranch: true }), false);
});

test("isReapableRecord: merged/cleanup belong to the reclaim path, not this one", () => {
  for (const status of ["merged", "cleanup"]) {
    assert.equal(isReapableRecord({ status, branch: "b", worktree: "/w" }, EMPTY), false);
  }
});

test("isReapableRecord: a record with no branch or no worktree has nothing to free", () => {
  assert.equal(isReapableRecord({ status: "killed", worktree: "/w" }, EMPTY), false);
  assert.equal(isReapableRecord({ status: "killed", branch: "b" }, EMPTY), false);
});

test("isReapableRecord: unknown git state is treated as unsafe", () => {
  const rec = { status: "killed", branch: "feat/SPOR-3537", worktree: "/w/val-18" };
  assert.equal(isReapableRecord(rec, null), false);
});
