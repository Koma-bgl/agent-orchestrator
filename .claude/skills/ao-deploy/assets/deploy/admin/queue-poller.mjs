// queue-poller — auto-spawn agent sessions from Linear tickets.
//
// The published @composio/ao-cli (0.2.x) does NOT ship the queue poller (its
// `queuePoller` config is inert; only an unpublished build has it). This replicates
// that poller's logic on top of the published `ao spawn`: every interval, list
// tracker issues matching the project's label/status filters, dedup against live
// sessions, respect maxSessions, and `ao spawn <issueId>` the new ones. The reaction
// engine (CI/review) is still handled by `ao lifecycle-worker`; this only spawns.
import { execFile } from "node:child_process";
import { writeFileSync, readdirSync, readFileSync, existsSync, rmSync, mkdirSync, statSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { readConfig, projectBaseDir, generateConfigHash } from "./config-writer.mjs";

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
	const data = await linearGraphQL("query($f: IssueFilter){ issues(first:50, filter:$f){ nodes { identifier } } }", {
		f: filter,
	});
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
		const data = await linearGraphQL(
			"query($t:ID!){ workflowStates(filter:{team:{id:{eq:$t}}}){ nodes { id name } } }",
			{ t: teamId },
		);
		const nodes = data?.workflowStates?.nodes || [];
		const match = nodes.find((n) => n.name.toLowerCase() === String(name).toLowerCase());
		if (match) id = match.id;
		else
			console.log(
				`[queue-poller] status "${name}" not found for team ${teamId}; available: ${nodes.map((n) => n.name).join(", ")}`,
			);
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
		const data = await linearGraphQL(
			"mutation($id:String!,$s:String!){ issueUpdate(id:$id, input:{stateId:$s}){ success } }",
			{ id: identifier, s: stateId },
		);
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
			.map((c) => ({
				id: c.id,
				body: c.body || "",
				createdAt: c.createdAt,
				author: (c.user && (c.user.displayName || c.user.name)) || "Unknown",
			}))
			.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)); // newest first
		return { identifier: iss.identifier, title: iss.title || "", description: iss.description || "", comments };
	} catch {
		return null;
	}
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
	} catch {
		return false;
	}
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

		try {
			writeFileSync(`${worktree}/.ao-task.md`, renderTaskFile(iss));
		} catch {
			continue;
		} // keep it current

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
		const { stdout } = await execFileAsync("gh", ["api", "rate_limit", "--jq", ".resources.graphql.remaining"], {
			env: process.env,
			timeout: 15_000,
		});
		const n = parseInt(stdout.trim(), 10);
		return Number.isFinite(n) ? n : null;
	} catch {
		return null;
	}
}

const prVerifiedAt = new Map(); // pr.url -> last direct gh-check ms (throttle orphan re-checks)

// --- PR title format ---------------------------------------------------------
// The repo convention is `[Type][TICKET-ID] Description` (e.g. "[Bugfix][SPOR-3272]
// …"). The agent writes conventional-commit titles ("fix(sports): …"), so we rewrite
// them deterministically. This matters twice: reviewers/Linear see the right title on
// the open PR, and `gh pr merge --squash` uses the PR title as the squashed commit
// subject — so a correct title fixes the merge commit too.
const TYPE_MAP = {
	feat: "Feat",
	feature: "Feat",
	fix: "Bugfix",
	bugfix: "Bugfix",
	bug: "Bugfix",
	perf: "Perf",
	chore: "Chore",
	refactor: "Refactor",
	docs: "Docs",
	doc: "Docs",
	test: "Test",
	tests: "Test",
	build: "Build",
	ci: "CI",
	style: "Style",
	revert: "Revert",
};

/**
 * Normalize a PR title to `[Type][TICKET] Description`. Pure + exported for tests.
 * Returns the corrected title, or null when no change is needed / no ticket to key on.
 */
export function formatPrTitle(title, ticket) {
	const tk = String(ticket || "")
		.trim()
		.toUpperCase();
	if (!tk) return null; // without a ticket we can't (and shouldn't) reformat
	let body = String(title || "").trim();
	// Already `[Anything][TICKET] …`? Leave it — don't churn a hand-correct title.
	if (new RegExp(`^\\[[^\\]]+\\]\\[${tk}\\]\\s*\\S`, "i").test(body)) return null;
	// Drop a trailing " [TICKET]" suffix (the conventional-with-suffix style we also emit).
	body = body.replace(new RegExp(`\\s*\\[${tk}\\]\\s*$`, "i"), "").trim();
	let type = null;
	// Prefer a conventional-commit prefix: type(scope)?!?: desc
	const cc = body.match(/^([a-zA-Z]+)(?:\([^)]*\))?!?:\s*(.*)$/);
	if (cc && TYPE_MAP[cc[1].toLowerCase()]) {
		type = TYPE_MAP[cc[1].toLowerCase()];
		body = cc[2].trim();
	}
	// Else an existing leading [Type] bracket (already-tagged but missing the ticket) —
	// but not when that leading bracket is the ticket itself.
	if (!type) {
		const lead = body.match(/^\[([^\]]+)\]\s*(.*)$/);
		if (lead && lead[1].trim().toUpperCase() !== tk) {
			type = TYPE_MAP[lead[1].toLowerCase()] || lead[1].trim();
			body = lead[2].trim();
		}
	}
	// Strip a leftover leading [TICKET] if the title led with it.
	body = body.replace(new RegExp(`^\\[${tk}\\]\\s*`, "i"), "").trim();
	const desc = body ? body.charAt(0).toUpperCase() + body.slice(1) : "";
	return `[${type || "Chore"}][${tk}] ${desc}`.trim();
}

const titledPRs = new Set(); // pr.url -> normalized (or confirmed-correct) once; dedup edits

// Rewrite non-conforming PR titles to `[Type][TICKET] …`, once per PR. Uses the PR
// title from /api/sessions when present (free); falls back to one `gh pr view` read.
async function normalizePrTitles(p, qp, sessions) {
	if (!p.repo) return;
	// Only PRs we haven't handled and that carry a ticket are candidates. If none need a
	// (possible) GitHub read, do nothing — and never add GitHub pressure while the budget
	// is low (the /rate_limit probe itself is exempt).
	const candidates = sessions.filter((s) => s.pr?.url && s.issueId && !titledPRs.has(s.pr.url));
	if (!candidates.length) return;
	// A title read (gh pr view) and edit (gh pr edit) are both GraphQL — never add
	// pressure while the budget is low (the /rate_limit probe itself is exempt).
	const remaining = await graphqlRemaining();
	if (remaining != null && remaining < (qp.rateLimitFloor ?? 500)) {
		console.log(`[queue-poller] skipping title normalize — GitHub GraphQL remaining ${remaining} < floor`);
		return;
	}
	for (const s of candidates) {
		const pr = s.pr;
		const m = pr.url.match(/\/pull\/(\d+)/);
		const prNum = pr.number || (m && m[1]);
		if (!prNum) continue;
		try {
			let current = pr.title;
			if (!current) {
				const { stdout } = await execFileAsync(
					"gh",
					["pr", "view", String(prNum), "--repo", p.repo, "--json", "title", "--jq", ".title"],
					{ env: process.env, timeout: 30_000 },
				);
				current = stdout.trim();
			}
			const fixed = formatPrTitle(current, s.issueId);
			titledPRs.add(pr.url); // mark handled regardless — one attempt per PR
			if (fixed && fixed !== current) {
				await execFileAsync("gh", ["pr", "edit", String(prNum), "--repo", p.repo, "--title", fixed], {
					env: process.env,
					timeout: 30_000,
				});
				console.log(`[queue-poller] PR #${prNum} title -> "${fixed}"`);
			}
		} catch (e) {
			titledPRs.delete(pr.url); // transient — retry next window
			console.log(
				`[queue-poller] title normalize failed for #${prNum}: ${String(e.stderr || e.message).slice(0, 200)}`,
			);
		}
	}
}

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
		const entry = { issueId: s.issueId, url: pr.url, prNum, sid: s.id, dead: DEAD.has(s.status) };
		const mg = pr.mergeability || {};
		const cachedReady =
			pr.reviewDecision === "approved" &&
			mg.mergeable &&
			mg.ciPassing &&
			mg.approved &&
			mg.noConflicts &&
			(mg.blockers?.length ?? 0) === 0;
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
			const { stdout } = await execFileAsync(
				"gh",
				["pr", "view", String(e.prNum), "--repo", p.repo, "--json", "state,reviewDecision,mergeable,mergeStateStatus"],
				{ env: process.env, timeout: 30_000 },
			);
			const i = JSON.parse(stdout);
			if (i.state === "MERGED") {
				mergedPRs.add(e.url);
				continue;
			}
			if (
				i.state === "OPEN" &&
				i.reviewDecision === "APPROVED" &&
				i.mergeable === "MERGEABLE" &&
				i.mergeStateStatus === "CLEAN"
			)
				ready.push(e);
		} catch {
			/* transient — retry next window */
		}
	}
	for (const r of ready) {
		try {
			console.log(`[queue-poller] auto-merge: ${r.issueId} PR #${r.prNum} (approved+green+clean) — squash merging`);
			await execFileAsync("gh", ["pr", "merge", String(r.prNum), "--repo", p.repo, "--squash"], {
				env: process.env,
				timeout: 60_000,
			});
			mergedPRs.add(r.url);
			if (r.dead) {
				// A dead session's status is never refreshed by the lifecycle, so nothing would
				// ever flip it to merged — write it ourselves so reclaimRetired can reclaim the
				// worktree + record instead of leaving them behind forever.
				try {
					const f = join(projectBaseDir(CONFIG_PATH, p.path), "sessions", r.sid);
					writeFileSync(f, upsertRecordField(readFileSync(f, "utf8"), "status", "merged"));
				} catch {
					/* record already gone — reclaim has nothing to do */
				}
			}
		} catch (e) {
			console.log(`[queue-poller] auto-merge failed for #${r.prNum}: ${String(e.stderr || e.message).slice(0, 300)}`);
		}
	}
}

// --- CI-failure relay ----------------------------------------------------------
// Agents are told to STOP after opening their PR and rely on the orchestrator to
// forward CI failures. ao's lifecycle-manager does detect the review_pending →
// ci_failed transition (it logs it), but the reaction that should deliver the failure
// to the agent's pane never dispatches in this deploy (same dead reaction engine as
// auto-merge / comment relay). Net effect: the agent idles at its prompt forever while
// its PR sits red. So the poller relays it: on ci_failed, fetch the failing check
// names and paste a fix-it prompt into the pane — once per head SHA, so a re-push that
// fails differently gets a fresh nudge but the same failure is never repeated.
const ciNudged = new Map(); // pr.url -> head SHA already relayed

async function relayCiFailures(p, qp, sessions) {
	if (!p.repo) return;
	const failed = sessions.filter((s) => s.status === "ci_failed" && s.pr?.url && s.metadata?.tmuxName);
	if (!failed.length) return;
	const remaining = await graphqlRemaining();
	if (remaining != null && remaining < (qp.rateLimitFloor ?? 500)) return; // never add pressure while throttled
	for (const s of failed) {
		const m = s.pr.url.match(/\/pull\/(\d+)/);
		const prNum = s.pr.number || (m && m[1]);
		if (!prNum) continue;
		try {
			const { stdout } = await execFileAsync(
				"gh",
				["pr", "view", String(prNum), "--repo", p.repo, "--json", "headRefOid,statusCheckRollup"],
				{ env: process.env, timeout: 30_000 },
			);
			const info = JSON.parse(stdout);
			if (ciNudged.get(s.pr.url) === info.headRefOid) continue; // this SHA's failure already relayed
			const failing = (info.statusCheckRollup || [])
				.filter((c) => ["FAILURE", "ERROR", "TIMED_OUT"].includes(String(c.conclusion || "").toUpperCase()))
				.map((c) => c.name);
			if (!failing.length) continue; // rollup lagging the status (e.g. checks re-running) — retry next tick
			const pane = await paneText(s.metadata.tmuxName);
			if (pane.includes("esc to interrupt")) continue; // agent mid-task — retry next tick
			const ok = await nudge(
				s.metadata.tmuxName,
				`CI failed on your PR #${prNum} — failing checks: ${failing.join(", ")}. In this worktree: run \`gh pr checks ${prNum}\` and \`gh run view --log-failed\` on the failing run to see why, fix it, run the fast local checks, then commit and push to the same branch. After pushing, stop again — the orchestrator keeps monitoring CI.`,
			);
			if (ok) {
				ciNudged.set(s.pr.url, info.headRefOid);
				console.log(`[queue-poller] relayed CI failure to ${s.id} (PR #${prNum}: ${failing.join(", ")})`);
			}
		} catch (e) {
			console.log(`[queue-poller] CI relay failed for ${s.id}: ${String(e.stderr || e.message).slice(0, 200)}`);
		}
	}
}

// --- Merge-conflict relay ------------------------------------------------------
// Same dead-reaction story as CI failures: when the base branch moves and a live
// session's PR goes CONFLICTING, nothing tells the agent — it idles at its prompt
// while the dashboard shows the "merge conflict / ask to fix" badge waiting for a
// human click. Candidates come from ao-web's cached mergeability (free); a direct
// gh read confirms before nudging. Re-nudge on a new head SHA (agent pushed but
// conflict remains) or after 30 min (base moved again under the same head).
const conflictNudged = new Map(); // pr.url -> { sha, at }

async function relayMergeConflicts(p, qp, sessions) {
	if (!p.repo) return;
	const candidates = sessions.filter(
		(s) =>
			s.pr?.url &&
			s.metadata?.tmuxName &&
			!DEAD.has(s.status) &&
			s.pr.mergeability?.noConflicts === false &&
			!mergedPRs.has(s.pr.url),
	);
	if (!candidates.length) return;
	const remaining = await graphqlRemaining();
	if (remaining != null && remaining < (qp.rateLimitFloor ?? 500)) return; // never add pressure while throttled
	for (const s of candidates) {
		const m = s.pr.url.match(/\/pull\/(\d+)/);
		const prNum = s.pr.number || (m && m[1]);
		if (!prNum) continue;
		try {
			const { stdout } = await execFileAsync(
				"gh",
				["pr", "view", String(prNum), "--repo", p.repo, "--json", "state,mergeable,headRefOid,baseRefName"],
				{ env: process.env, timeout: 30_000 },
			);
			const info = JSON.parse(stdout);
			if (info.state === "MERGED") {
				mergedPRs.add(s.pr.url);
				continue;
			}
			if (info.state !== "OPEN" || info.mergeable !== "CONFLICTING") continue; // cached badge was stale
			const prev = conflictNudged.get(s.pr.url);
			if (prev && prev.sha === info.headRefOid && Date.now() - prev.at < 30 * 60_000) continue;
			const pane = await paneText(s.metadata.tmuxName);
			if (pane.includes("esc to interrupt")) continue; // agent mid-task — retry next tick
			const base = info.baseRefName || "the base branch";
			const ok = await nudge(
				s.metadata.tmuxName,
				`Your PR #${prNum} has merge conflicts with ${base}. In this worktree: run \`git fetch origin\` and \`git merge origin/${base}\`, resolve every conflict (keep both sides' intent — check the conflicting commits with \`git log --merge\`), run the fast local checks, then commit the merge and push to the same branch. After pushing, stop again — the orchestrator keeps monitoring the PR.`,
			);
			if (ok) {
				conflictNudged.set(s.pr.url, { sha: info.headRefOid, at: Date.now() });
				console.log(`[queue-poller] relayed merge conflict to ${s.id} (PR #${prNum} vs ${base})`);
			}
		} catch (e) {
			console.log(`[queue-poller] conflict relay failed for ${s.id}: ${String(e.stderr || e.message).slice(0, 200)}`);
		}
	}
}

// --- Merged-session reclaim --------------------------------------------------
// Nothing retires a session after its PR merges in this deploy (the ao reaction that
// should do it isn't firing; the poller only merged the PR). So merged sessions pile
// up: their worktrees eat disk (~1GB each) and ao-web keeps cold-refreshing their PR
// data every cache-TTL (~6 GraphQL calls / 5 min each) → the GitHub rate-limit banner.
// Killing them doesn't help — ao-web still enriches terminal sessions on a cold cache,
// and killing leaves the worktree behind. Only REMOVING the record + worktree does.
// The store is one line-based `key=value` file per session under <base>/sessions/<id>;
// there is no index, so deleting the file removes the record cleanly.
const SESSION_KV = /^([a-zA-Z0-9_]+)=(.*)$/;

/** Parse a session store file (line-based key=value). Pure + exported for tests. */
export function parseSessionRecord(text) {
	const rec = {};
	for (const line of String(text || "").split("\n")) {
		const m = line.match(SESSION_KV);
		if (m) rec[m[1]] = m[2].trim();
	}
	return rec;
}

// Dedup key is "id:issueId", NOT the bare session id: ids are RECYCLED (ao's
// next-id is max(existing records)+1, and reclaim removes records), so a bare-id
// set would permanently skip the next ticket that lands on a freed id — its
// merged session then lingers forever (worktree disk + PR enrichment rate burn).
const reclaimed = new Set();

// Preserve a retired session's record before deletion: copy it to
// sessions/archive/<id>_<timestamp> (same convention as ao-core's deleteMetadata,
// which the reclaim path bypasses). Session ids are reused lowest-free after the
// record is removed, so without this the archive file is the ONLY surviving link
// from issue -> branch -> PR. Returns the archive path, or null if no record.
// Exported for tests.
export function archiveSessionRecord(sessDir, sessionId) {
	const src = join(sessDir, sessionId);
	if (!existsSync(src)) return null;
	const archiveDir = join(sessDir, "archive");
	mkdirSync(archiveDir, { recursive: true });
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const dest = join(archiveDir, `${sessionId}_${timestamp}`);
	writeFileSync(dest, readFileSync(src, "utf8"));
	return dest;
}

// Which retirement path a session qualifies for, or null. Pure + exported for tests.
//   • "merged": status===merged in BOTH the live list and the authoritative store file.
//   • "closed": a dead (killed/exited/…) session whose linked PR GitHub reports CLOSED
//     (rejected/abandoned, never merged). Nothing else ever retires these, so their
//     worktrees (~2.4GB each with node_modules) accumulate until the disk fills —
//     observed 2026-09-04: ao-ky at 100% with 3 closed-PR worktrees from August.
// A live session is never a candidate, whatever its PR says.
export function retireReason(liveStatus, rec, prState) {
	if (liveStatus === "merged") return rec?.status === "merged" ? "merged" : null;
	if (!DEAD.has(liveStatus) || liveStatus === "cleanup") return null;
	if (!rec || !DEAD.has(rec.status) || !rec.pr) return null;
	return prState === "CLOSED" ? "closed" : null;
}

// A closed PR's worktree may only go if it holds nothing the branch on GitHub doesn't:
// clean tree (the orchestrator's own untracked .ao-task.md excepted) and zero unpushed
// commits. `unpushed` null (no upstream / git error) is treated as unsafe.
export function isWorktreeSafeToDrop(porcelain, unpushed) {
	if (typeof unpushed !== "number" || unpushed !== 0) return false;
	const lines = String(porcelain || "")
		.split("\n")
		.map((l) => l.trimEnd())
		.filter(Boolean);
	return lines.every((l) => /^\?\? \.ao-task\.md$/.test(l));
}

// ao-core writes session records atomically (write <id>.tmp.<pid>.<ts>, rename). When
// the rename fails (ENOSPC) the tmp file is left behind — hundreds of them once the disk
// is full. Anything older than an hour is not an in-flight write.
const TMP_RECORD = /^[^/]+\.tmp\.\d+\.\d+$/;
export function isStaleTmpRecord(name, mtimeMs, nowMs, maxAgeMs = 3_600_000) {
	return TMP_RECORD.test(name) && nowMs - mtimeMs > maxAgeMs;
}

function pruneStaleTmpRecords(sessDir) {
	let names;
	try {
		names = readdirSync(sessDir);
	} catch {
		return;
	}
	let n = 0;
	for (const name of names) {
		const f = join(sessDir, name);
		try {
			if (!isStaleTmpRecord(name, statSync(f).mtimeMs, Date.now())) continue;
			rmSync(f);
			n++;
		} catch {
			/* raced with ao — fine */
		}
	}
	if (n) console.log(`[queue-poller] removed ${n} stale session tmp file(s) from ${sessDir}`);
}

const CLOSED_CHECK_WINDOW_MS = 600_000; // one `gh pr view` per dead-with-PR session per 10 min
const closedCheckedAt = new Map(); // `${id}:${issueId}` -> last lookup ms

async function retireSession(p, sessDir, s, rec, reason) {
	// Kill the tmux session FIRST. Leaving it running leaks an idle claude (RAM)
	// and — worse — deadlocks spawning: with the record gone, ao reuses this
	// session id and `tmux new-session` fails with "duplicate session" forever.
	const tmuxName = rec.tmuxName || s.tmuxName;
	if (tmuxName)
		await execFileAsync("tmux", ["kill-session", "-t", tmuxName], { env: process.env, timeout: 15_000 }).catch(
			() => {},
		);
	const wt = rec.worktree;
	if (wt && existsSync(wt)) {
		// --force: merged → nothing is lost; closed → gated on isWorktreeSafeToDrop above.
		// Either way force clears the untracked .ao-task.md that would block removal.
		await execFileAsync("git", ["-C", p.path, "worktree", "remove", "--force", wt], {
			env: process.env,
			timeout: 60_000,
		}).catch(async (e) => {
			// A worktree git no longer tracks (record drifted) — just delete the dir.
			if (/not a working tree|is not a working tree/i.test(String(e.stderr || e.message)))
				rmSync(wt, { recursive: true, force: true });
			else throw e;
		});
	}
	archiveSessionRecord(sessDir, s.id); // keep history: sessions/archive/<id>_<ts>
	rmSync(join(sessDir, s.id)); // remove the session record → ao-web stops listing/enriching it
	console.log(
		`[queue-poller] reclaimed ${reason} session ${s.id} (${s.issueId}) — worktree + record removed (record archived)`,
	);
}

// Retire sessions whose PR has merged OR closed: remove the git worktree (frees disk)
// and the store record (stops ao-web enriching it). Merged is gated STRICTLY on
// status===merged from BOTH the live list AND the authoritative store file; closed is
// gated on a dead status in both, a fresh `gh pr view` saying CLOSED, and a worktree
// with nothing unpushed. A live session — or a killed one whose PR is still open — is
// never touched, so this can run every tick without interrupting work.
async function reclaimRetired(pid, p, qp, sessions) {
	const sessDir = join(projectBaseDir(CONFIG_PATH, p.path), "sessions");
	pruneStaleTmpRecords(sessDir);
	let rateChecked = false,
		rateOk = true;
	for (const s of sessions) {
		const key = `${s.id}:${s.issueId}`;
		if (s.projectId !== pid || reclaimed.has(key) || !DEAD.has(s.status)) continue;
		const f = join(sessDir, s.id);
		try {
			if (!existsSync(f)) {
				if (s.status === "merged") reclaimed.add(key);
				continue;
			}
			const rec = parseSessionRecord(readFileSync(f, "utf8"));
			let reason = retireReason(s.status, rec, undefined);
			if (!reason) {
				// Closed-PR path: needs one GitHub read, throttled + rate-limit gated.
				if (retireReason(s.status, rec, "CLOSED") !== "closed" || !p.repo) continue;
				const m = String(rec.pr).match(/\/pull\/(\d+)/);
				if (!m || Date.now() - (closedCheckedAt.get(key) ?? 0) < CLOSED_CHECK_WINDOW_MS) continue;
				if (!rateChecked) {
					rateChecked = true;
					const r = await graphqlRemaining();
					rateOk = r == null || r >= (qp?.rateLimitFloor ?? 500);
				}
				if (!rateOk) continue;
				closedCheckedAt.set(key, Date.now());
				const { stdout } = await execFileAsync(
					"gh",
					["pr", "view", m[1], "--repo", p.repo, "--json", "state", "--jq", ".state"],
					{ env: process.env, timeout: 30_000 },
				);
				reason = retireReason(s.status, rec, stdout.trim());
				if (!reason) continue;
				if (rec.worktree && existsSync(rec.worktree)) {
					const porcelain = await execFileAsync("git", ["-C", rec.worktree, "status", "--porcelain"], {
						env: process.env,
						timeout: 30_000,
					})
						.then((r) => r.stdout)
						.catch(() => null);
					const unpushed = await execFileAsync("git", ["-C", rec.worktree, "rev-list", "--count", "@{u}..HEAD"], {
						env: process.env,
						timeout: 30_000,
					})
						.then((r) => Number(r.stdout.trim()))
						.catch(() => null);
					if (porcelain == null || !isWorktreeSafeToDrop(porcelain, unpushed)) {
						console.log(
							`[queue-poller] not reclaiming ${s.id} (${s.issueId}): PR closed but worktree has local changes/unpushed commits`,
						);
						reclaimed.add(key); // don't re-check every window; a human owns this one
						continue;
					}
				}
			}
			await retireSession(p, sessDir, s, rec, reason);
			reclaimed.add(key);
		} catch (e) {
			console.log(`[queue-poller] reclaim failed for ${s.id}: ${String(e.stderr || e.message).slice(0, 200)}`);
		}
	}
	await execFileAsync("git", ["-C", p.path, "worktree", "prune"], { env: process.env, timeout: 30_000 }).catch(
		() => {},
	);
}

// --- Disk-pressure gate ---------------------------------------------------------
// Every spawn costs ~2.4GB (worktree + node_modules) and a full disk kills the sessions
// already running (claude can't write its transcript — ENOSPC — and ao's atomic record
// writes fail). So before spawning: if free space on the project volume is under
// qp.minFreeGb (default 5), first drop the npm cache (safe: only makes the next
// `npm ci` slower; it was 7GB on ao-ky), and if that's still not enough, skip spawning
// this tick and say so. Running sessions are never touched.
export function isLowDisk(freeBytes, minFreeGb) {
	if (typeof freeBytes !== "number" || !(minFreeGb > 0)) return false;
	return freeBytes < minFreeGb * 1024 ** 3;
}

async function freeBytesAt(path) {
	try {
		const st = await statfs(path);
		return Number(st.bavail) * Number(st.bsize);
	} catch {
		return null;
	}
}

let npmCacheCleanedAt = 0;
async function diskHasRoomToSpawn(pid, p, qp) {
	const minFreeGb = qp.minFreeGb ?? 5;
	let free = await freeBytesAt(p.path);
	if (!isLowDisk(free, minFreeGb)) return true;
	if (Date.now() - npmCacheCleanedAt > 3_600_000) {
		npmCacheCleanedAt = Date.now();
		console.log(
			`[queue-poller] ${pid} low disk (${(free / 1024 ** 3).toFixed(1)}GB free < ${minFreeGb}GB) — clearing npm cache`,
		);
		await execFileAsync("npm", ["cache", "clean", "--force"], { env: process.env, timeout: 120_000 }).catch(() => {});
		free = await freeBytesAt(p.path);
		if (!isLowDisk(free, minFreeGb)) return true;
	}
	console.log(
		`[queue-poller] ${pid} low disk (${(free / 1024 ** 3).toFixed(1)}GB free < ${minFreeGb}GB) — not spawning this tick`,
	);
	return false;
}

// --- Orphan-PR linking -----------------------------------------------------------
// ao can misclassify a launch as dead within seconds of spawn (record status=killed)
// while the agent in tmux is actually fine — it finishes the ticket and opens its PR
// AFTER the record went terminal (observed: val-20/val-21 killed at spawn+3s, PRs
// opened 17 min later). The lifecycle never refreshes terminal sessions, so no pr=
// is ever written, and every downstream reaction (auto-merge's orphan-verify path,
// reclaim, status write-back) skips a record with no pr — the approved PR then sits
// open forever with nothing watching it. Heal it here: for a terminal session with
// no pr= but a branch=, look the PR up by head branch via gh.
//   • OPEN PR   -> write pr= into the record; ao-web serves it next tick and the
//     normal orphan-verify path in autoMergePRs takes over.
//   • MERGED PR -> write pr= AND status=merged, so reclaimRetired reclaims the
//     worktree + record on its next pass.
// Throttled per session; candidates are rare (a handful of terminal records), so
// this adds at most one gh call per candidate per window.
const ORPHAN_LINK_WINDOW_MS = 600_000; // PRs can appear long after the kill — keep re-checking, slowly
const orphanCheckedAt = new Map(); // `${id}:${issueId}` -> last lookup ms (id:issue — ids are recycled)

/** From `gh pr list --json number,url,state`: first OPEN, else first MERGED, else null. */
export function pickOrphanPr(items) {
	if (!Array.isArray(items)) return null;
	return items.find((i) => i.state === "OPEN") || items.find((i) => i.state === "MERGED") || null;
}

/** Replace `key=` line in a line-based session record, or append it. Always newline-terminated. */
export function upsertRecordField(text, key, value) {
	const line = `${key}=${value}`;
	const re = new RegExp(`^${key}=.*$`, "m");
	if (re.test(text)) return text.replace(re, line);
	return (text === "" || text.endsWith("\n") ? text : text + "\n") + line + "\n";
}

async function linkOrphanPrs(pid, p, qp, sessions, sessDir) {
	if (!p.repo) return;
	const candidates = [];
	for (const s of sessions) {
		if (s.projectId !== pid || s.pr || !DEAD.has(s.status)) continue;
		if (s.status === "merged" || s.status === "cleanup") continue; // reclaim owns these
		const key = `${s.id}:${s.issueId}`;
		if (Date.now() - (orphanCheckedAt.get(key) ?? 0) < ORPHAN_LINK_WINDOW_MS) continue;
		candidates.push({ s, key });
	}
	if (!candidates.length) return; // zero GitHub API this tick
	const remaining = await graphqlRemaining();
	if (remaining != null && remaining < (qp.rateLimitFloor ?? 500)) return;
	for (const { s, key } of candidates) {
		orphanCheckedAt.set(key, Date.now());
		const f = join(sessDir, s.id);
		let text, rec;
		try {
			text = readFileSync(f, "utf8");
			rec = parseSessionRecord(text);
		} catch {
			continue;
		}
		if (rec.pr || !rec.branch) continue; // already linked (live list stale) / nothing to look up
		try {
			const { stdout } = await execFileAsync(
				"gh",
				[
					"pr",
					"list",
					"--repo",
					p.repo,
					"--head",
					rec.branch,
					"--state",
					"all",
					"--limit",
					"10",
					"--json",
					"number,url,state",
				],
				{ env: process.env, timeout: 30_000 },
			);
			const pr = pickOrphanPr(JSON.parse(stdout));
			if (!pr) continue; // no PR for this branch (yet) — re-check next window
			let next = upsertRecordField(text, "pr", pr.url);
			if (pr.state === "MERGED") next = upsertRecordField(next, "status", "merged");
			writeFileSync(f, next);
			console.log(
				`[queue-poller] linked orphan PR #${pr.number} (${pr.state}) to ${s.id} (${s.issueId}) via branch ${rec.branch}`,
			);
		} catch (e) {
			console.log(`[queue-poller] orphan PR lookup failed for ${s.id}: ${String(e.stderr || e.message).slice(0, 200)}`);
		}
	}
}

// --- Branch-drift repair -------------------------------------------------------
// Repo pre-push hooks can reject ao's spawn-time branch name (valhalla's rejects
// `feat/…`), so the agent renames its branch before pushing. ao's record keeps the
// old name, so the session's PR is never matched: no pr= link, status decays to
// "stuck", the active count stays inflated, and spawning starves. The worktree's
// actual HEAD is the truth — rewrite the record's branch to it and let the next
// lifecycle pass link the PR and heal the status.
async function repairBranchDrift(sessions, sessDir) {
	for (const s of sessions) {
		if (DEAD.has(s.status)) continue;
		const f = join(sessDir, s.id);
		let text, rec;
		try {
			text = readFileSync(f, "utf8");
			rec = parseSessionRecord(text);
		} catch {
			continue;
		}
		if (!rec.branch || !rec.worktree || !existsSync(rec.worktree)) continue;
		let actual;
		try {
			({ stdout: actual } = await execFileAsync("git", ["-C", rec.worktree, "rev-parse", "--abbrev-ref", "HEAD"], {
				env: process.env,
				timeout: 15_000,
			}));
		} catch {
			continue;
		}
		actual = actual.trim();
		if (!actual || actual === "HEAD" || actual === rec.branch) continue; // detached HEAD (mid-rebase): skip
		writeFileSync(f, text.replace(/^branch=.*$/m, `branch=${actual}`));
		console.log(`[queue-poller] repaired branch drift for ${s.id}: ${rec.branch} -> ${actual}`);
	}
}

// --- Dead-branch reaper --------------------------------------------------------
// `ao spawn <TICKET>` derives its branch name from the ticket, so a dead session that
// still holds that branch in a worktree makes `git worktree add` fail — and the poller
// retries the same doomed spawn every interval, forever, with the ticket parked in the
// trigger column. Observed 2026-09-03: SPOR-3537 failed ~1000 times over 8h because
// val-18 (whose agent never started; see classifyPane) never let go of feat/SPOR-3537.
//
// Free the branch so the next tick's spawn succeeds. Only provably-empty sessions
// qualify (see isReapableRecord) — anything with a commit, a dirty tree, a pushed
// branch, or a linked PR is left strictly alone. The record is archived first, exactly
// like the reclaim path, so the issue -> branch trail survives.
async function gitState(rec) {
	const wt = rec.worktree;
	if (!wt || !existsSync(wt)) return null;
	const git = async (args, cwd = wt) =>
		(await execFileAsync("git", ["-C", cwd, ...args], { env: process.env, timeout: 30_000 })).stdout.trim();
	try {
		let base;
		try {
			base = await git(["rev-parse", "--abbrev-ref", "origin/HEAD"]);
		} catch {
			base = "origin/main";
		} // no origin/HEAD ref in this worktree
		const ahead = parseInt(await git(["rev-list", "--count", `${base}..HEAD`]), 10);
		const dirty = (await git(["status", "--porcelain"])).length > 0;
		const remoteBranch = (await git(["ls-remote", "--heads", "origin", rec.branch])).length > 0;
		return { ahead: Number.isFinite(ahead) ? ahead : NaN, dirty, remoteBranch };
	} catch {
		return null; // unreadable git state — isReapableRecord treats null as unsafe
	}
}

async function reapDeadBranches(p, sessions, sessDir) {
	for (const s of sessions) {
		const f = join(sessDir, s.id);
		let rec;
		try {
			rec = parseSessionRecord(readFileSync(f, "utf8"));
		} catch {
			continue;
		}
		// Trust the RECORD's status, not the live one: ao's lifecycle never refreshes a
		// terminal session, and its live status flaps under PR-poll rate limiting.
		if (!isReapableRecord(rec, await gitState(rec))) continue;
		try {
			const tmuxName = rec.tmuxName || s.metadata?.tmuxName;
			if (tmuxName) await execFileAsync("tmux", ["kill-session", "-t", tmuxName], { timeout: 15_000 }).catch(() => {});
			archiveSessionRecord(sessDir, s.id);
			await execFileAsync("git", ["-C", p.path, "worktree", "remove", "--force", rec.worktree], {
				env: process.env,
				timeout: 60_000,
			});
			await execFileAsync("git", ["-C", p.path, "branch", "-D", rec.branch], {
				env: process.env,
				timeout: 30_000,
			}).catch(() => {});
			rmSync(f, { force: true });
			console.log(
				`[queue-poller] reaped empty dead session ${s.id} (${s.issueId || "no issue"}) — freed ${rec.branch}`,
			);
		} catch (e) {
			console.log(`[queue-poller] reap failed for ${s.id}: ${String(e.stderr || e.message).slice(0, 200)}`);
		}
	}
}

// --- Orphan tmux reaper --------------------------------------------------------
// A tmux session whose store record is gone (reclaimed, or ao lost it) is invisible
// to ao but still squats its name: ao's next-id picks max(existing records)+1, so a
// freed id gets reused and `tmux new-session` dies with "duplicate session" — every
// subsequent spawn deadlocks. It also leaks an idle claude per orphan. Reap tmux
// sessions that (a) carry this config's hash prefix, (b) match no record's tmuxName
// across ANY project (the hash is per-config, shared by all its projects), and
// (c) are >10 min old — `ao spawn` creates tmux moments before the record, so age
// guards against reaping an in-flight spawn.
const REAP_MIN_AGE_S = 600;

async function reapOrphanTmux(cfg) {
	let hash;
	try {
		hash = generateConfigHash(CONFIG_PATH);
	} catch {
		return;
	}
	const known = new Set();
	for (const p of Object.values(cfg.projects || {})) {
		const sessDir = join(projectBaseDir(CONFIG_PATH, p.path), "sessions");
		try {
			for (const f of readdirSync(sessDir)) {
				try {
					known.add(parseSessionRecord(readFileSync(join(sessDir, f), "utf8")).tmuxName || `${hash}-${f}`);
				} catch {
					/* unreadable record: skip */
				}
			}
		} catch {
			/* project has no sessions dir yet */
		}
	}
	let out;
	try {
		({ stdout: out } = await execFileAsync("tmux", ["ls", "-F", "#{session_name} #{session_created}"], {
			env: process.env,
			timeout: 15_000,
		}));
	} catch {
		return;
	} // no tmux server running — nothing to reap
	const now = Math.floor(Date.now() / 1000);
	for (const line of out.trim().split("\n")) {
		const [name, created] = line.split(" ");
		if (!name || !name.startsWith(`${hash}-`) || known.has(name)) continue;
		if (!(now - parseInt(created, 10) >= REAP_MIN_AGE_S)) continue;
		try {
			await execFileAsync("tmux", ["kill-session", "-t", name], { env: process.env, timeout: 15_000 });
			console.log(`[queue-poller] reaped orphan tmux ${name} (no session record)`);
		} catch {
			/* raced with something else killing it — fine */
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

// What is actually on an agent's screen. Exported for tests.
//   busy    — claude has an in-flight turn. NEVER touch this pane.
//   claude  — claude's UI is up and idle at its prompt.
//   shell   — claude is NOT running: a bare shell prompt owns the pane. ao launched
//             the agent and the launch fell through to bash, so the task prompt was
//             typed in as shell commands (see SPOR-3537, 2026-09-03: claude-code's
//             self-updater had yanked the bin from PATH mid-install, so `claude` was
//             "command not found" at spawn). Unrecoverable in place — the session has
//             no agent to nudge, and re-pasting just runs the ticket as more commands.
//   unknown — nothing painted yet; wait for a later tick.
// Order matters: `busy` is checked first so a live agent merely *discussing* a shell
// prompt or a "command not found" can never be misread as a dead shell.
export function classifyPane(text) {
	const pane = String(text || "");
	if (!pane.trim()) return "unknown";
	if (/esc to interrupt/.test(pane)) return "busy";
	if (/bypass permissions|❯/.test(pane)) return "claude";
	// A shell prompt at the START of a line (`root@host:/path#` or `$ `) is the tell.
	// Requiring line-start plus the trailing #/$ keeps prose about prompts from matching.
	if (/^[^\s@]+@[^\s:]+:[^\s#$]*[#$]\s*$/m.test(pane)) return "shell";
	return "unknown";
}

// Is this record's branch safe to free? A session that died before producing anything
// still squats its worktree + branch, and `ao spawn` derives the SAME branch name from
// the ticket — so `git worktree add` fails and the ticket can never be picked up again
// (observed: SPOR-3537 retried every 30s for 8h). Freeing it lets the normal spawn path
// re-create the session from scratch.
//
// Deliberately paranoid — this deletes a branch, so every one of these must hold:
//   • the session is DEAD (a live agent owns its worktree)
//   • ...but not merged/cleanup: those belong to reclaimRetired, which archives first
//   • no pr= linked (linkOrphanPrs runs FIRST, so a real PR is already attached)
//   • zero commits ahead of the base, clean tree, and no branch on the remote
// `git` is the authority on the last three; an unreadable git state (null) is unsafe.
export function isReapableRecord(rec, git) {
	if (!rec || !git) return false;
	if (!rec.branch || !rec.worktree) return false; // nothing to free
	if (rec.pr) return false; // has a PR — never touch
	if (rec.status === "merged" || rec.status === "cleanup") return false; // reclaim owns these
	if (!DEAD.has(rec.status)) return false; // a live agent is using it
	return git.ahead === 0 && !git.dirty && !git.remoteBranch;
}

async function fetchIssueForPrompt(identifier) {
	try {
		const data = await linearGraphQL("query($id:String!){ issue(id:$id){ identifier title description } }", {
			id: identifier,
		});
		return data?.issue || null;
	} catch {
		return null;
	}
}

function buildNudgePrompt(issue, identifier) {
	const title = issue?.title || "";
	const desc = (issue?.description || "").replace(/\s+/g, " ").trim();
	// Single line on purpose: newlines in a tmux paste would submit the prompt early.
	return `Please work on Linear ticket ${identifier}: ${title}. ${desc} Follow your standard workflow: create a feature branch, implement the change, run the fast local checks (type-check + lint), commit, push, and open a PR — CI runs the full build + tests on the PR. Title the PR "[Type][${identifier}] Description" where Type is Feat/Bugfix/Perf/Chore/Refactor.`
		.replace(/\s+/g, " ")
		.trim();
}

async function paneText(tmuxName) {
	try {
		const { stdout } = await execFileAsync("tmux", ["capture-pane", "-t", tmuxName, "-p"], { timeout: 10_000 });
		return stdout;
	} catch {
		return "";
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || "/root/.agent-orchestrator/claude";
// claude-code encodes a workspace path to its transcript dir by replacing / and . with -.
function hasTranscript(worktree) {
	try {
		const dir = `${CLAUDE_DIR}/projects/${worktree.replace(/[/.]/g, "-")}`;
		return readdirSync(dir).some((f) => f.endsWith(".jsonl") && !f.startsWith("agent-"));
	} catch {
		return false;
	}
}
async function tmuxAlive(tmuxName) {
	try {
		await execFileAsync("tmux", ["has-session", "-t", tmuxName], { timeout: 10_000 });
		return true;
	} catch {
		return false;
	}
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
		const state = classifyPane(pane);
		if (state === "busy") continue; // claude has an active turn — not stuck; never double-deliver
		if (state === "unknown") continue; // claude UI not up yet — wait for a later tick
		if (state === "shell") {
			// claude is not running at all: the launch fell through to bash and ao typed the
			// ticket in as shell commands. There is no agent here to nudge — re-pasting would
			// just execute more of the ticket. Kill the pane so reapDeadBranches can free the
			// branch on a later tick and the ticket gets a clean, fresh spawn.
			console.log(`[queue-poller] watchdog: ${s.id} (${s.issueId}) fell through to a shell — killing for respawn`);
			await execFileAsync("tmux", ["kill-session", "-t", tmuxName], { timeout: 10_000 }).catch(() => {});
			nudged.add(s.id);
			continue;
		}
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
	try {
		const r = await fetch(DASH + "/api/sessions");
		return (await r.json()).sessions || [];
	} catch {
		return [];
	}
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
	const sessDir = join(projectBaseDir(CONFIG_PATH, p.path), "sessions");
	await repairBranchDrift(sessions, sessDir); // fix record<->worktree branch drift BEFORE any PR matching
	await linkOrphanPrs(pid, p, qp, sessions, sessDir); // sessions ao killed before their PR opened: find + link the PR by branch
	await syncStatuses(p.tracker.teamId, sessions, qp);
	await recoverStuck(sessions); // re-deliver the prompt to any session ao left stuck at launch
	await syncContext(sessions); // keep .ao-task.md current + surface new/truncated comments to the agent
	await normalizePrTitles(p, qp, sessions); // enforce [Type][TICKET] title before it can merge
	await autoMergePRs(pid, p, qp, sessions); // squash-merge approved+green+clean PRs (if autoMerge)
	await relayCiFailures(p, qp, sessions); // ao's ci_failed reaction never dispatches — tell the agent ourselves
	await relayMergeConflicts(p, qp, sessions); // conflicted PRs otherwise idle until a human clicks "ask to fix"
	await reclaimRetired(pid, p, qp, sessions); // retire merged/closed-PR sessions: free the worktree + stop enrichment
	await reapDeadBranches(p, sessions, sessDir); // LAST before spawning: free branches dead sessions squat, else their ticket can never respawn

	let issues;
	try {
		issues = await linearIssues(p.tracker.teamId, qp.filters?.labels, qp.filters?.statusName);
	} catch (e) {
		console.log(`[queue-poller] ${pid} linear error: ${e.message}`);
		return;
	}
	if (!issues.length) return;
	if (!(await diskHasRoomToSpawn(pid, p, qp))) return; // a full disk kills the sessions already running

	const live = new Set(
		sessions.filter((s) => s.issueId && !DEAD.has(s.status)).map((s) => String(s.issueId).toLowerCase()),
	);
	// ao's live status flaps when its PR polling is rate-limited (review_pending
	// sessions get re-reported as working/stuck), which inflates a naive status
	// count and starves spawning for days. Authoritative "busy" instead: a session
	// with NO PR linked in the store is still building (or launch-stuck — the
	// watchdog owns that); one WITH a PR is only busy while claude has an in-flight
	// turn (reacting to CI/review feedback). Idle-at-prompt + PR open = waiting on
	// review, never a slot-holder.
	let active = 0;
	for (const s of sessions) {
		if (DEAD.has(s.status) || IDLE.has(s.status)) continue;
		let rec = null;
		try {
			rec = parseSessionRecord(readFileSync(join(sessDir, s.id), "utf8"));
		} catch {
			/* no record: trust live status */
		}
		if (rec && rec.pr) {
			const tmuxName = rec.tmuxName || s.tmuxName;
			const busy = tmuxName ? /esc to interrupt/.test(await paneText(tmuxName)) : false;
			if (!busy) continue;
		}
		active++;
	}

	for (const issue of issues) {
		if (live.has(issue.toLowerCase())) continue; // already has a live session
		if (active >= maxSessions) {
			console.log(`[queue-poller] ${pid} maxSessions ${maxSessions} reached — skipping ${issue}`);
			break;
		}
		try {
			console.log(`[queue-poller] ${pid} spawning ${issue}`);
			await execFileAsync("ao", ["spawn", issue], {
				cwd: p.path,
				timeout: 180_000,
				maxBuffer: 32 * 1024 * 1024,
				env: process.env,
			});
			active++;
			live.add(issue.toLowerCase());
			// Immediate feedback: the agent is starting work, so move the ticket out of the
			// trigger column now rather than waiting for the session to report `working`.
			await moveIssue(p.tracker.teamId, issue, qp.onStartStatus || "In Progress");
		} catch (e) {
			// `ao spawn` drives an ora spinner on stderr, so a naive stderr slice just
			// echoes "Creating session". Surface message + stdout + stderr (generously
			// truncated) so a real spawn failure is diagnosable from the logs.
			const detail = [`msg=${e.message}`, `stdout=${String(e.stdout || "")}`, `stderr=${String(e.stderr || "")}`].join(
				" || ",
			);
			console.log(`[queue-poller] ${pid} spawn failed for ${issue}: ${detail.slice(0, 2000)}`);
		}
	}
}

async function pollOnce() {
	const cfg = readConfig(CONFIG_PATH);
	await reapOrphanTmux(cfg); // BEFORE spawning: frees squatted session names so `ao spawn` can reuse the id
	for (const [pid, p] of Object.entries(cfg.projects || {})) await pollProject(pid, p);
}

// Only start the poll loop when run as a script — importing this module (e.g. from a
// unit test for formatPrTitle) must not spin up polling.
if (import.meta.url === `file://${process.argv[1]}`) {
	let interval = 30_000;
	try {
		const c = readConfig(CONFIG_PATH);
		const p = c.projects[Object.keys(c.projects)[0]];
		interval = parseInterval(p?.queuePoller?.interval);
	} catch {}
	if (!LINEAR_KEY) console.log("[queue-poller] warning: LINEAR_API_KEY not set — polls will fail until it is");
	console.log(`[queue-poller] starting (interval ${interval}ms)`);

	let running = false;
	const tick = async () => {
		if (running) return;
		running = true;
		try {
			await pollOnce();
		} catch (e) {
			console.log(`[queue-poller] error: ${e.message}`);
		} finally {
			running = false;
		}
	};
	tick();
	setInterval(tick, interval);
	process.on("SIGTERM", () => process.exit(0));
	process.on("SIGINT", () => process.exit(0));
}
