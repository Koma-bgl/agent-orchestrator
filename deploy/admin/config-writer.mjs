// config-writer — the setup wizard's read/write layer for agent-orchestrator.yaml
// plus lifecycle-worker status. Pure/injectable so it is unit-testable off-box.
//
// The dashboard + worker read config via @composio/ao-core; this module only needs
// to (a) add a project map entry the schema accepts, and (b) tell whether the
// worker is running. It uses the same `yaml` lib + the same hash-dir algorithm as
// ao-core (documented in core/dist/paths.js) so the paths line up exactly.
import { createHash } from "node:crypto";
import { realpathSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { homedir } from "node:os";
import { parse, parseDocument } from "yaml";

const DEFAULT_DATA_DIR = join(homedir(), ".agent-orchestrator");

/** Parse the config (or an empty skeleton if absent). */
export function readConfig(configPath) {
  if (!existsSync(configPath)) return { projects: {} };
  return parse(readFileSync(configPath, "utf8")) || { projects: {} };
}

/** First configured project as {id, project}, or null on an empty bot. */
export function getFirstProject(configPath) {
  const cfg = readConfig(configPath);
  const ids = Object.keys(cfg.projects || {});
  if (ids.length === 0) return null;
  return { id: ids[0], project: cfg.projects[ids[0]] };
}

/**
 * Add/overwrite a project map entry. Writes only the keys the schema needs beyond
 * the defaults: repo+path (required), an explicit linear tracker (else it defaults
 * to github), and queuePoller.enabled:true (defaults false). reactions get rich
 * load-time defaults, so we don't write them. Idempotent — re-apply overwrites.
 * Uses parseDocument so any surrounding structure/comments are preserved.
 */
export function addProject(configPath, { id, repo, path, teamId, labels, statusName }) {
  if (!id || !repo || !path || !teamId) {
    throw new Error("addProject requires id, repo, path, teamId");
  }
  const src = existsSync(configPath) ? readFileSync(configPath, "utf8") : "projects: {}\n";
  const doc = parseDocument(src);
  if (!doc.has("projects")) doc.set("projects", {});
  // The poller matches Linear labels + status by NAME. With no filter it would pick
  // up ALL of the team's tickets, so a trigger label and/or status scope which
  // tickets this bot acts on. maxSessions:1 serializes agents — a single agent
  // session (esp. one running `npm run build`) can use 5-7GB RAM + all cores, so
  // concurrent builds would OOM the default e2-standard-4 (16GB) VM. Raise only
  // after sizing the VM (RAM is the binding constraint) + boot disk accordingly.
  const queuePoller = { enabled: true, maxSessions: 1 };
  const filters = {};
  const labelList = (labels || []).map((l) => String(l).trim()).filter(Boolean);
  if (labelList.length) filters.labels = labelList;
  const status = statusName && String(statusName).trim();
  if (status) filters.statusName = status;
  if (Object.keys(filters).length) queuePoller.filters = filters;
  doc.setIn(["projects", id], {
    repo,
    path,
    tracker: { plugin: "linear", teamId },
    queuePoller,
  });
  // Force block style: a `projects: {}` skeleton is a flow map, so setIn'd children
  // inherit flow (valid but unreadable). Flip the relevant nodes to block style.
  const toBlock = (node) => {
    if (node && typeof node === "object" && "flow" in node) node.flow = false;
    if (node?.items) for (const it of node.items) toBlock(it.value ?? it);
  };
  toBlock(doc.get("projects", true));
  writeFileSync(configPath, String(doc));
  return { id, project: readConfig(configPath).projects[id] };
}

// --- lifecycle-worker status (mirrors ao-core getProjectBaseDir) -------------

/** 12-char sha256 of the config file's resolved parent dir (ao-core algorithm). */
export function generateConfigHash(configPath) {
  return createHash("sha256").update(dirname(realpathSync(configPath))).digest("hex").slice(0, 12);
}

/**
 * ~/.agent-orchestrator/{hash}-{basename(projectPath)} — NOTE the instance id uses
 * basename(project.path), NOT the yaml map key. dataDir is injectable for tests;
 * production uses ao-core's hardcoded ~/.agent-orchestrator.
 */
export function projectBaseDir(configPath, projectPath, dataDir = DEFAULT_DATA_DIR) {
  return join(dataDir, `${generateConfigHash(configPath)}-${basename(projectPath)}`);
}

/** {running, pid} from the worker PID file + a kill(pid,0) liveness probe. */
export function workerStatus(configPath, projectPath, dataDir) {
  try {
    const pidFile = join(projectBaseDir(configPath, projectPath, dataDir), "lifecycle-worker.pid");
    if (!existsSync(pidFile)) return { running: false, pid: null };
    const pid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    if (!Number.isFinite(pid)) return { running: false, pid: null };
    try {
      process.kill(pid, 0);
      return { running: true, pid };
    } catch {
      return { running: false, pid };
    }
  } catch {
    return { running: false, pid: null };
  }
}
