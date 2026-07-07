import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readConfig,
  getFirstProject,
  addProject,
  projectBaseDir,
  workerStatus,
} from "./config-writer.mjs";

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "ao-cfg-"));
  const configPath = join(dir, "agent-orchestrator.yaml");
  writeFileSync(configPath, "projects: {}\n");
  return { dir, configPath };
}

test("readConfig: empty skeleton yields projects:{}", () => {
  const { configPath } = scratch();
  assert.deepEqual(readConfig(configPath).projects, {});
});

test("getFirstProject: null on empty bot", () => {
  const { configPath } = scratch();
  assert.equal(getFirstProject(configPath), null);
});

test("addProject: writes a schema-valid linear project with queuePoller enabled", () => {
  const { configPath } = scratch();
  addProject(configPath, { id: "myrepo", repo: "owner/myrepo", path: "/data/projects/myrepo", teamId: "TEAM123" });
  const p = readConfig(configPath).projects.myrepo;
  assert.equal(p.repo, "owner/myrepo");
  assert.equal(p.path, "/data/projects/myrepo");
  assert.deepEqual(p.tracker, { plugin: "linear", teamId: "TEAM123" });
  assert.equal(p.queuePoller.enabled, true);
});

test("addProject: writes queuePoller.filters.labels when a trigger tag is given", () => {
  const { configPath } = scratch();
  addProject(configPath, { id: "myrepo", repo: "owner/myrepo", path: "/data/projects/myrepo", teamId: "T1", labels: ["agent", " "] });
  const qp = readConfig(configPath).projects.myrepo.queuePoller;
  assert.equal(qp.enabled, true);
  assert.deepEqual(qp.filters.labels, ["agent"]); // trimmed, blanks dropped
});

test("addProject: no filters key when no label/status given (watches all tickets)", () => {
  const { configPath } = scratch();
  addProject(configPath, { id: "myrepo", repo: "owner/myrepo", path: "/data/projects/myrepo", teamId: "T1" });
  assert.equal(readConfig(configPath).projects.myrepo.queuePoller.filters, undefined);
});

test("addProject: writes label + statusName filters together", () => {
  const { configPath } = scratch();
  addProject(configPath, { id: "myrepo", repo: "owner/myrepo", path: "/data/projects/myrepo", teamId: "T1", labels: ["agent"], statusName: "Todo" });
  const f = readConfig(configPath).projects.myrepo.queuePoller.filters;
  assert.deepEqual(f, { labels: ["agent"], statusName: "Todo" });
});

test("addProject: statusName only (no label)", () => {
  const { configPath } = scratch();
  addProject(configPath, { id: "myrepo", repo: "owner/myrepo", path: "/data/projects/myrepo", teamId: "T1", statusName: "In Progress" });
  const f = readConfig(configPath).projects.myrepo.queuePoller.filters;
  assert.deepEqual(f, { statusName: "In Progress" });
});

test("addProject: idempotent overwrite (one entry, updated teamId)", () => {
  const { configPath } = scratch();
  addProject(configPath, { id: "myrepo", repo: "owner/myrepo", path: "/data/projects/myrepo", teamId: "T1" });
  addProject(configPath, { id: "myrepo", repo: "owner/myrepo", path: "/data/projects/myrepo", teamId: "T2" });
  const cfg = readConfig(configPath);
  assert.deepEqual(Object.keys(cfg.projects), ["myrepo"]);
  assert.equal(cfg.projects.myrepo.tracker.teamId, "T2");
});

test("addProject: rejects missing fields", () => {
  const { configPath } = scratch();
  assert.throws(() => addProject(configPath, { id: "x", repo: "r", path: "p" }), /requires/);
});

test("getFirstProject: returns the added project", () => {
  const { configPath } = scratch();
  addProject(configPath, { id: "myrepo", repo: "owner/myrepo", path: "/data/projects/myrepo", teamId: "T1" });
  assert.equal(getFirstProject(configPath).id, "myrepo");
});

test("projectBaseDir: uses basename(project.path), not the map key", () => {
  const { dir, configPath } = scratch();
  const base = projectBaseDir(configPath, "/somewhere/else/actualname", dir);
  assert.match(base, /-actualname$/);
  assert.ok(base.startsWith(dir));
});

test("workerStatus: false when no pid file", () => {
  const { dir, configPath } = scratch();
  assert.deepEqual(workerStatus(configPath, "/data/projects/myrepo", dir), { running: false, pid: null });
});

test("workerStatus: true for a live pid, false for a dead one", () => {
  const { dir, configPath } = scratch();
  const projectPath = "/data/projects/myrepo";
  const base = projectBaseDir(configPath, projectPath, dir);
  mkdirSync(base, { recursive: true });
  // live: our own pid
  writeFileSync(join(base, "lifecycle-worker.pid"), String(process.pid));
  assert.deepEqual(workerStatus(configPath, projectPath, dir), { running: true, pid: process.pid });
  // dead: an almost-certainly-unused pid
  writeFileSync(join(base, "lifecycle-worker.pid"), "2147480000");
  assert.deepEqual(workerStatus(configPath, projectPath, dir), { running: false, pid: 2147480000 });
});
