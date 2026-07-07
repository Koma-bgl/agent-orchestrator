// queue-poller — auto-spawn agent sessions from Linear tickets.
//
// The published @composio/ao-cli (0.2.x) does NOT ship the queue poller (its
// `queuePoller` config is inert; only an unpublished build has it). This replicates
// that poller's logic on top of the published `ao spawn`: every interval, list
// tracker issues matching the project's label/status filters, dedup against live
// sessions, respect maxSessions, and `ao spawn <issueId>` the new ones. The reaction
// engine (CI/review) is still handled by `ao lifecycle-worker`; this only spawns.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readConfig } from "./config-writer.mjs";

const execFileAsync = promisify(execFile);
const CONFIG_PATH = process.env.AO_CONFIG_PATH || "/root/.agent-orchestrator/agent-orchestrator.yaml";
const DASH = "http://127.0.0.1:" + (process.env.PORT || "3000");
const LINEAR_KEY = process.env.LINEAR_API_KEY || "";

// Mirrors the upstream poller: finished sessions ignored for dedup; idle (waiting on
// review) sessions exist but don't count toward the maxSessions working cap.
const DEAD = new Set(["killed", "done", "exited", "errored", "terminated", "merged", "cleanup"]);
const IDLE = new Set(["review_pending", "changes_requested", "approved", "mergeable", "pr_open"]);

function parseInterval(v) {
  if (typeof v === "number") return v;
  const m = String(v || "").match(/^(\d+)(s|m|h)$/);
  if (!m) return 30_000;
  const n = parseInt(m[1], 10);
  return m[2] === "s" ? n * 1000 : m[2] === "m" ? n * 60_000 : n * 3_600_000;
}

async function linearIssues(teamId, labels, statusName) {
  const filter = { team: { id: { eq: teamId } } };
  if (labels && labels.length) filter.labels = { name: { in: labels } };
  if (statusName) filter.state = { name: { eq: statusName } };
  const r = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: LINEAR_KEY },
    body: JSON.stringify({ query: "query($f: IssueFilter){ issues(first:50, filter:$f){ nodes { identifier } } }", variables: { f: filter } }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 200));
  return (j.data?.issues?.nodes || []).map((n) => n.identifier);
}

async function listSessions() {
  try { const r = await fetch(DASH + "/api/sessions"); return (await r.json()).sessions || []; }
  catch { return []; }
}

async function pollProject(pid, p) {
  const qp = p.queuePoller;
  if (!qp?.enabled || p.tracker?.plugin !== "linear" || !p.tracker?.teamId) return;
  const maxSessions = qp.maxSessions || 5;

  let issues;
  try { issues = await linearIssues(p.tracker.teamId, qp.filters?.labels, qp.filters?.statusName); }
  catch (e) { console.log(`[queue-poller] ${pid} linear error: ${e.message}`); return; }
  if (!issues.length) return;

  const sessions = await listSessions();
  const live = new Set(sessions.filter((s) => s.issueId && !DEAD.has(s.status)).map((s) => String(s.issueId).toLowerCase()));
  let active = sessions.filter((s) => !DEAD.has(s.status) && !IDLE.has(s.status)).length;

  for (const issue of issues) {
    if (live.has(issue.toLowerCase())) continue;               // already has a live session
    if (active >= maxSessions) { console.log(`[queue-poller] ${pid} maxSessions ${maxSessions} reached — skipping ${issue}`); break; }
    try {
      console.log(`[queue-poller] ${pid} spawning ${issue}`);
      await execFileAsync("ao", ["spawn", issue], { cwd: p.path, timeout: 180_000, maxBuffer: 32 * 1024 * 1024, env: process.env });
      active++;
      live.add(issue.toLowerCase());
    } catch (e) {
      // `ao spawn` drives an ora spinner on stderr, so a naive stderr slice just
      // echoes "Creating session". Surface message + stdout + stderr (generously
      // truncated) so a real spawn failure is diagnosable from the logs.
      const detail = [`msg=${e.message}`, `stdout=${String(e.stdout || "")}`, `stderr=${String(e.stderr || "")}`].join(" || ");
      console.log(`[queue-poller] ${pid} spawn failed for ${issue}: ${detail.slice(0, 2000)}`);
    }
  }
}

async function pollOnce() {
  const cfg = readConfig(CONFIG_PATH);
  for (const [pid, p] of Object.entries(cfg.projects || {})) await pollProject(pid, p);
}

let interval = 30_000;
try { const c = readConfig(CONFIG_PATH); const p = c.projects[Object.keys(c.projects)[0]]; interval = parseInterval(p?.queuePoller?.interval); } catch {}
if (!LINEAR_KEY) console.log("[queue-poller] warning: LINEAR_API_KEY not set — polls will fail until it is");
console.log(`[queue-poller] starting (interval ${interval}ms)`);

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try { await pollOnce(); } catch (e) { console.log(`[queue-poller] error: ${e.message}`); } finally { running = false; }
}
tick();
setInterval(tick, interval);
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
