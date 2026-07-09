// queue-poller — auto-spawn agent sessions from Linear tickets.
//
// The published @composio/ao-cli (0.2.x) does NOT ship the queue poller (its
// `queuePoller` config is inert; only an unpublished build has it). This replicates
// that poller's logic on top of the published `ao spawn`: every interval, list
// tracker issues matching the project's label/status filters, dedup against live
// sessions, respect maxSessions, and `ao spawn <issueId>` the new ones. The reaction
// engine (CI/review) is still handled by `ao lifecycle-worker`; this only spawns.
import { execFile } from "node:child_process";
import { writeFileSync, readdirSync } from "node:fs";
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
  // Deliberately NO merged → Done move: a merged PR leaves the ticket at "Ready for
  // review" so a human owns the final Done/QA/release call. It's opt-in — a user can
  // set queuePoller.onDoneStatus later (e.g. via setup) to auto-close on merge.
  if (sessionStatus === "merged" && qp.onDoneStatus) return qp.onDoneStatus;
  return null;
}

async function syncStatuses(teamId, sessions, qp) {
  for (const s of sessions) {
    if (!s.issueId) continue;
    const target = targetStatusFor(s.status, qp);
    if (target) await moveIssue(teamId, String(s.issueId), target);
  }
}

// --- Auto-merge (fully autonomous) -------------------------------------------
// ao's own auto-merge is a reaction keyed to the TRANSITION into approved-and-green,
// which its dual-poller setup misses (the worker adopts the session at "mergeable"
// without firing, then flips it to "stuck" — so the merge trigger never runs). Merge
// from the poller instead: robust + idempotent. For a bot session's PR that GitHub
// reports APPROVED + MERGEABLE + CLEAN, squash-merge it directly via gh. gh is authed
// via GH_CONFIG_DIR (inherited). Gated on queuePoller.autoMerge. NOTE: with CodeRabbit
// auto-approving, this merges to the default branch with no human review — intended
// per the operator's "fully autonomous" choice.
// --- Task-file delivery + comment sync ---------------------------------------
// ao inlines the ticket + ALL comments into the initial prompt and delivers it over
// tmux, which TRUNCATES long prompts — dropping the newest, most-actionable comments
// (a QA follow-up round gets lost and the agent wrongly concludes "already resolved").
// And ao's reaction engine (which should relay post-spawn comments) isn't firing. So
// the poller owns feedback delivery: keep a complete <worktree>/.ao-task.md (ticket +
// all comments, NEWEST FIRST) and nudge the agent with a SHORT pointer (never truncates)
// on first sight and whenever a new comment lands.
const CONTEXT_CHECK_MS = 120_000;
const lastContextCheck = new Map(); // sessionId -> ms (throttle Linear getComments)
const deliveredComments = new Map(); // sessionId -> Set(commentId) already surfaced to the agent

async function fetchIssueContext(identifier) {
  try {
    const data = await linearGraphQL(
      "query($id:String!){ issue(id:$id){ identifier title description comments{ nodes { id body createdAt user{ displayName name } } } } }",
      { id: identifier },
    );
    const iss = data?.issue;
    if (!iss) return null;
    const comments = (iss.comments?.nodes || [])
      .map((c) => ({ id: c.id, body: c.body || "", createdAt: c.createdAt, author: (c.user && (c.user.displayName || c.user.name)) || "Unknown" }))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)); // newest first
    return { identifier: iss.identifier, title: iss.title || "", description: iss.description || "", comments };
  } catch { return null; }
}

function renderTaskFile(iss) {
  const out = [`# ${iss.identifier}: ${iss.title}`, "", "## Description", "", iss.description || "(none)", ""];
  if (iss.comments.length) {
    out.push("## Comments — NEWEST FIRST (the latest comment supersedes earlier rounds)", "");
    for (const c of iss.comments) out.push(`### @${c.author} (${String(c.createdAt).split("T")[0]})`, "", c.body, "");
  }
  return out.join("\n");
}

async function nudge(tmuxName, message) {
  try {
    await execFileAsync("tmux", ["set-buffer", "-b", "aoctx", message], { timeout: 10_000 });
    await execFileAsync("tmux", ["paste-buffer", "-d", "-b", "aoctx", "-t", tmuxName], { timeout: 10_000 });
    await sleep(800);
    await execFileAsync("tmux", ["send-keys", "-t", tmuxName, "Enter"], { timeout: 10_000 });
    return true;
  } catch { return false; }
}

async function syncContext(sessions) {
  for (const s of sessions) {
    const tmuxName = s.metadata?.tmuxName;
    const worktree = s.metadata?.worktree;
    if (!s.issueId || !tmuxName || !worktree || DEAD.has(s.status)) continue; // live sessions only
    if (Date.now() - (lastContextCheck.get(s.id) ?? 0) < CONTEXT_CHECK_MS) continue;
    lastContextCheck.set(s.id, Date.now());

    const iss = await fetchIssueContext(s.issueId);
    if (!iss || !iss.comments.length) continue; // no comments → no truncation risk → nothing to sync

    try { writeFileSync(`${worktree}/.ao-task.md`, renderTaskFile(iss)); } catch { continue; } // keep it current

    const seen = deliveredComments.get(s.id) ?? new Set();
    const firstSight = !deliveredComments.has(s.id);
    const fresh = iss.comments.filter((c) => !seen.has(c.id));
    if (!fresh.length) continue; // agent already knows everything

    const pane = await paneText(tmuxName);
    if (!/bypass permissions|❯/.test(pane)) continue; // UI not up yet — retry next window (comments stay fresh)

    const msg = firstSight
      ? `Your complete task and ALL ticket comments (including the newest) are in ./.ao-task.md — your initial prompt may have been truncated. Read ./.ao-task.md in full before implementing and address the NEWEST comment. Do NOT conclude "already resolved" without handling the latest follow-up. Do not commit .ao-task.md.`
      : `New follow-up comment(s) added to ./.ao-task.md — re-read it (newest first) and address the latest feedback for ${s.issueId}.`;
    if (await nudge(tmuxName, msg)) {
      fresh.forEach((c) => seen.add(c.id));
      deliveredComments.set(s.id, seen);
    }
  }
}

const mergedPRs = new Set();

// Backstop: never let the poller's GitHub writes push us over the API limit. The
// /rate_limit endpoint is itself exempt, so checking is free. Returns remaining
// GraphQL points, or null if the check fails (in which case we proceed — don't block
// on a flaky check).
async function graphqlRemaining() {
  try {
    const { stdout } = await execFileAsync("gh", ["api", "rate_limit", "--jq", ".resources.graphql.remaining"], { env: process.env, timeout: 15_000 });
    const n = parseInt(stdout.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

const prVerifiedAt = new Map(); // pr.url -> last direct gh-check ms (throttle orphan re-checks)

async function autoMergePRs(pid, p, qp, sessions) {
  if (!qp.autoMerge || !p.repo) return;
  // A container recreate (redeploy / nightly) kills live sessions, so a session with an
  // open PR ends up "killed" with STALE cached PR data the lifecycle no longer refreshes.
  // Its PR must still merge once approved — else it's orphaned. So:
  //   • alive sessions: trust the fresh /api/sessions PR data (free, no GitHub read);
  //   • terminal (killed/exited/…) sessions with an open PR: re-check directly via gh,
  //     throttled to once/2min per PR (matches ao's own review cadence).
  const ready = []; // {issueId, url, prNum} — confirmed mergeable
  const verify = []; // terminal sessions whose PR needs a fresh direct check
  for (const s of sessions) {
    if (s.projectId !== pid) continue;
    const pr = s.pr;
    if (!pr || typeof pr !== "object" || !pr.url || mergedPRs.has(pr.url)) continue;
    const m = pr.url.match(/\/pull\/(\d+)/);
    const prNum = pr.number || (m && m[1]);
    if (!prNum) continue;
    const entry = { issueId: s.issueId, url: pr.url, prNum };
    const mg = pr.mergeability || {};
    const cachedReady = pr.reviewDecision === "approved" && mg.mergeable && mg.ciPassing && mg.approved && mg.noConflicts && (mg.blockers?.length ?? 0) === 0;
    if (cachedReady) ready.push(entry);
    else if (DEAD.has(s.status) && s.status !== "merged" && s.status !== "cleanup") {
      const last = prVerifiedAt.get(pr.url) ?? 0;
      if (Date.now() - last >= 120_000) verify.push(entry); // orphaned PR — re-check
    }
  }
  if (!ready.length && !verify.length) return; // nothing to do — zero GitHub API this tick
  // Gate all GitHub work on the rate-limit backstop (the /rate_limit check is exempt).
  const floor = qp.rateLimitFloor ?? 500;
  const remaining = await graphqlRemaining();
  if (remaining != null && remaining < floor) {
    console.log(`[queue-poller] skipping auto-merge — GitHub GraphQL remaining ${remaining} < ${floor}`);
    return;
  }
  // Fresh-check orphaned PRs (killed sessions); promote to `ready` if now mergeable.
  for (const e of verify) {
    prVerifiedAt.set(e.url, Date.now());
    try {
      const { stdout } = await execFileAsync("gh", ["pr", "view", String(e.prNum), "--repo", p.repo, "--json", "state,reviewDecision,mergeable,mergeStateStatus"], { env: process.env, timeout: 30_000 });
      const i = JSON.parse(stdout);
      if (i.state === "MERGED") { mergedPRs.add(e.url); continue; }
      if (i.state === "OPEN" && i.reviewDecision === "APPROVED" && i.mergeable === "MERGEABLE" && i.mergeStateStatus === "CLEAN") ready.push(e);
    } catch { /* transient — retry next window */ }
  }
  for (const r of ready) {
    try {
      console.log(`[queue-poller] auto-merge: ${r.issueId} PR #${r.prNum} (approved+green+clean) — squash merging`);
      await execFileAsync("gh", ["pr", "merge", String(r.prNum), "--repo", p.repo, "--squash"], { env: process.env, timeout: 60_000 });
      mergedPRs.add(r.url);
    } catch (e) {
      console.log(`[queue-poller] auto-merge failed for #${r.prNum}: ${String(e.stderr || e.message).slice(0, 300)}`);
    }
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

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || "/root/.agent-orchestrator/claude";
// claude-code encodes a workspace path to its transcript dir by replacing / and . with -.
function hasTranscript(worktree) {
  try {
    const dir = `${CLAUDE_DIR}/projects/${worktree.replace(/[/.]/g, "-")}`;
    return readdirSync(dir).some((f) => f.endsWith(".jsonl") && !f.startsWith("agent-"));
  } catch { return false; }
}
async function tmuxAlive(tmuxName) {
  try { await execFileAsync("tmux", ["has-session", "-t", tmuxName], { timeout: 10_000 }); return true; }
  catch { return false; }
}

async function recoverStuck(sessions) {
  for (const s of sessions) {
    const tmuxName = s.metadata?.tmuxName;
    const worktree = s.metadata?.worktree;
    if (!s.issueId || !tmuxName || !worktree || nudged.has(s.id)) continue;
    const createdMs = Date.parse(s.createdAt || s.metadata?.createdAt || "");
    if (!Number.isFinite(createdMs) || Date.now() - createdMs < STUCK_AGE_MS) continue;
    // Status-AGNOSTIC: ao often MISCLASSIFIES a launch-stuck session as killed/exited/stuck
    // even though claude is alive at an unsubmitted/empty prompt, so keying off s.status
    // misses those. The real signal for "stuck at launch" is: tmux alive + NO transcript
    // (claude never processed anything). A session that got going has a transcript → skip.
    if (!(await tmuxAlive(tmuxName))) continue; // genuinely gone — can't recover via tmux
    if (hasTranscript(worktree)) continue; // it processed something — working/done/waiting; leave it
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
  await syncContext(sessions); // keep .ao-task.md current + surface new/truncated comments to the agent
  await autoMergePRs(pid, p, qp, sessions); // squash-merge approved+green+clean PRs (if autoMerge)

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
