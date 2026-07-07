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

async function linearGraphQL(query, variables) {
  const r = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: LINEAR_KEY },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 300));
  return j.data;
}

async function linearIssues(teamId, labels, statusName) {
  const filter = { team: { id: { eq: teamId } } };
  if (labels && labels.length) filter.labels = { name: { in: labels } };
  if (statusName) filter.state = { name: { eq: statusName } };
  const data = await linearGraphQL("query($f: IssueFilter){ issues(first:50, filter:$f){ nodes { identifier } } }", { f: filter });
  return (data?.issues?.nodes || []).map((n) => n.identifier);
}

// --- Linear status write-back ------------------------------------------------
// The pinned @composio/ao-cli@0.2.2 ships NO status sync (no lifecycle
// syncIssueStatus, no built-in poller — verified against the git tag), so tickets
// never leave the trigger column on their own. We mirror the upstream semantics
// here: a session that reaches `working` moves the ticket to "In Progress"; one
// that reaches `pr_open`/`review_pending` moves it to "Ready for review". Names are
// per-team, so they're configurable (queuePoller.onStartStatus / onReviewStatus)
// with defaults that match the current board. A status NAME is resolved to a
// workflow-state id via workflowStates (cached), then set with issueUpdate.
const stateIdCache = new Map(); // `${teamId}::${nameLower}` -> stateId | null
const syncedStatus = new Map(); // issueId(lower) -> last status NAME we wrote (dedup writes)

async function resolveStateId(teamId, name) {
  const key = `${teamId}::${String(name).toLowerCase()}`;
  if (stateIdCache.has(key)) return stateIdCache.get(key);
  let id = null;
  try {
    const data = await linearGraphQL("query($t:ID!){ workflowStates(filter:{team:{id:{eq:$t}}}){ nodes { id name } } }", { t: teamId });
    const nodes = data?.workflowStates?.nodes || [];
    const match = nodes.find((n) => n.name.toLowerCase() === String(name).toLowerCase());
    if (match) id = match.id;
    else console.log(`[queue-poller] status "${name}" not found for team ${teamId}; available: ${nodes.map((n) => n.name).join(", ")}`);
  } catch (e) {
    console.log(`[queue-poller] workflowStates lookup failed for team ${teamId}: ${e.message}`);
    return null; // transient — don't cache a miss
  }
  stateIdCache.set(key, id);
  return id;
}

// Move an issue to a named status, at most once per (issue, status). issueUpdate's
// `id` accepts the short identifier (e.g. SPOR-3220) directly.
async function moveIssue(teamId, identifier, statusName) {
  if (!teamId || !identifier || !statusName) return;
  const seenKey = String(identifier).toLowerCase();
  if (syncedStatus.get(seenKey) === statusName) return;
  const stateId = await resolveStateId(teamId, statusName);
  if (!stateId) return;
  try {
    const data = await linearGraphQL("mutation($id:String!,$s:String!){ issueUpdate(id:$id, input:{stateId:$s}){ success } }", { id: identifier, s: stateId });
    if (data?.issueUpdate?.success) {
      syncedStatus.set(seenKey, statusName);
      console.log(`[queue-poller] ${identifier} -> "${statusName}"`);
    }
  } catch (e) {
    console.log(`[queue-poller] failed to move ${identifier} -> "${statusName}": ${e.message}`);
  }
}

// Reconcile live session states -> Linear ticket status (best-effort, non-fatal).
function targetStatusFor(sessionStatus, qp) {
  if (sessionStatus === "working") return qp.onStartStatus || "In Progress";
  if (sessionStatus === "pr_open" || sessionStatus === "review_pending") return qp.onReviewStatus || "Ready for review";
  return null;
}

async function syncStatuses(teamId, sessions, qp) {
  for (const s of sessions) {
    if (!s.issueId) continue;
    const target = targetStatusFor(s.status, qp);
    if (target) await moveIssue(teamId, String(s.issueId), target);
  }
}

// --- Stuck-session watchdog --------------------------------------------------
// ao@0.2.2 delivers the task prompt by typing it into the fresh claude pane AFTER
// launch; that send races claude's startup and is occasionally lost, leaving the
// agent idle at an empty prompt forever (status needs_input, and — since nothing was
// ever processed — no transcript, so activity is null). This is the "handshake before
// payload" fix: once a session has sat stuck past a grace window (claude is provably
// ready by then), re-deliver the task by pasting it into the pane. Nudge each session
// at most once. Only the exact "never got its prompt" shape qualifies: a genuinely
// waiting agent has a transcript, so its activity would be ready/idle, not null.
// A successful delivery flips the session to working within a poll cycle (claude
// writes a transcript the instant it receives the prompt → activity null→active), so
// 90s cleanly separates "genuinely stuck" from "mid-delivery". The `esc to interrupt`
// pane guard below makes double-delivery impossible even inside that window.
const STUCK_AGE_MS = 90_000;
const nudged = new Set();

async function fetchIssueForPrompt(identifier) {
  try {
    const data = await linearGraphQL("query($id:String!){ issue(id:$id){ identifier title description } }", { id: identifier });
    return data?.issue || null;
  } catch { return null; }
}

function buildNudgePrompt(issue, identifier) {
  const title = issue?.title || "";
  const desc = (issue?.description || "").replace(/\s+/g, " ").trim();
  // Single line on purpose: newlines in a tmux paste would submit the prompt early.
  return `Please work on Linear ticket ${identifier}: ${title}. ${desc} Follow your standard workflow: create a feature branch, implement the change, run the fast local checks (type-check + lint), commit, push, and open a PR — CI runs the full build + tests on the PR.`
    .replace(/\s+/g, " ")
    .trim();
}

async function paneText(tmuxName) {
  try {
    const { stdout } = await execFileAsync("tmux", ["capture-pane", "-t", tmuxName, "-p"], { timeout: 10_000 });
    return stdout;
  } catch { return ""; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function recoverStuck(sessions) {
  for (const s of sessions) {
    const tmuxName = s.metadata?.tmuxName;
    if (!s.issueId || !tmuxName) continue;
    if (s.status !== "needs_input" || s.activity != null) continue; // only the "never got prompt" shape
    if (nudged.has(s.id)) continue;
    const createdMs = Date.parse(s.createdAt || s.metadata?.createdAt || "");
    if (!Number.isFinite(createdMs) || Date.now() - createdMs < STUCK_AGE_MS) continue;
    const pane = await paneText(tmuxName);
    if (!/bypass permissions|❯/.test(pane)) continue; // claude UI not up yet — wait for a later tick
    if (/esc to interrupt/.test(pane)) continue; // claude has an active turn (processing) — not stuck; never double-deliver
    try {
      if (/\[Pasted text/.test(pane)) {
        // Failure mode A: ao pasted the prompt but the submit Enter was lost — the box
        // already holds the real task, so just press Enter. Do NOT re-paste (that would
        // concatenate a second prompt onto the first).
        console.log(`[queue-poller] watchdog: ${s.id} (${s.issueId}) has an unsubmitted prompt — submitting`);
        await execFileAsync("tmux", ["send-keys", "-t", tmuxName, "Enter"], { timeout: 10_000 });
      } else {
        // Failure mode B: nothing landed (empty box / placeholder) — re-deliver the task.
        console.log(`[queue-poller] watchdog: ${s.id} (${s.issueId}) stuck with no prompt — re-delivering`);
        const prompt = buildNudgePrompt(await fetchIssueForPrompt(s.issueId), s.issueId);
        await execFileAsync("tmux", ["set-buffer", "-b", "aonudge", prompt], { timeout: 10_000 });
        await execFileAsync("tmux", ["paste-buffer", "-d", "-b", "aonudge", "-t", tmuxName], { timeout: 10_000 });
        await sleep(800);
        await execFileAsync("tmux", ["send-keys", "-t", tmuxName, "Enter"], { timeout: 10_000 });
      }
      nudged.add(s.id);
    } catch (e) {
      console.log(`[queue-poller] watchdog: recover failed for ${s.id}: ${e.message}`);
    }
  }
}

async function listSessions() {
  try { const r = await fetch(DASH + "/api/sessions"); return (await r.json()).sessions || []; }
  catch { return []; }
}

async function pollProject(pid, p) {
  const qp = p.queuePoller;
  if (!qp?.enabled || p.tracker?.plugin !== "linear" || !p.tracker?.teamId) return;
  const maxSessions = qp.maxSessions || 5;

  // Reconcile live sessions -> ticket status FIRST, before the trigger-issue query.
  // A ticket moved to In Progress leaves the trigger column, so `issues` no longer
  // contains it — its later pr_open/review transition must be driven off the live
  // session list, which is independent of whether anything new is waiting to spawn.
  const sessions = await listSessions();
  await syncStatuses(p.tracker.teamId, sessions, qp);
  await recoverStuck(sessions); // re-deliver the prompt to any session ao left stuck at launch

  let issues;
  try { issues = await linearIssues(p.tracker.teamId, qp.filters?.labels, qp.filters?.statusName); }
  catch (e) { console.log(`[queue-poller] ${pid} linear error: ${e.message}`); return; }
  if (!issues.length) return;

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
      // Immediate feedback: the agent is starting work, so move the ticket out of the
      // trigger column now rather than waiting for the session to report `working`.
      await moveIssue(p.tracker.teamId, issue, qp.onStartStatus || "In Progress");
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
