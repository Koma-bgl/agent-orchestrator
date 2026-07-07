// Setup-wizard logic: GitHub (PAT) connect, repo list, token storage, Linear teams,
// and project apply. Pure-ish handlers importing config-writer; the HTTP routing +
// the post-apply container restart live in server.mjs. Gated by Caddy upstream.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { addProject, getFirstProject, workerStatus } from "./config-writer.mjs";

const execFileAsync = promisify(execFile);

const CONFIG_PATH = process.env.AO_CONFIG_PATH || "/root/.agent-orchestrator/agent-orchestrator.yaml";
const DATA_DIR = dirname(CONFIG_PATH);
const SECRETS_FILE = join(DATA_DIR, "agent-secrets.env");
const PROJECTS_DIR = join(DATA_DIR, "projects");
const DRAFT_FILE = join(DATA_DIR, "setup-draft.json");

// In-progress wizard selections (owner/repo/team/label/status), persisted on the
// volume so a refresh (or our rebuilds) restores them. Not secrets.
function readDraft() { try { return JSON.parse(readFileSync(DRAFT_FILE, "utf8")); } catch { return {}; } }
export function saveDraft(d = {}) {
  const clean = {};
  for (const k of ["owner", "repo", "teamId", "label", "statusName"]) if (d[k] != null && d[k] !== "") clean[k] = String(d[k]);
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(DRAFT_FILE, JSON.stringify(clean));
  return { ok: true };
}

// --- GitHub (gh CLI; GH_CONFIG_DIR is set in the image ENV) ------------------

/** Run a gh command feeding `input` on stdin (keeps the PAT off the process table). */
function ghWithStdin(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { env: process.env });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `gh exited ${code}`))));
    child.stdin.write(input);
    child.stdin.end();
  });
}

export async function githubStatus() {
  try {
    // `gh api user` is a stable way to read the authenticated login as JSON.
    const { stdout } = await execFileAsync("gh", ["api", "user", "--jq", ".login"], { timeout: 15000 });
    const login = stdout.trim();
    return login ? { connected: true, login } : { connected: false, login: null };
  } catch {
    return { connected: false, login: null };
  }
}

// --- GitHub device-flow login (no PAT) ---------------------------------------
// Needs a GitHub OAuth App client_id (device flow enabled, NO secret). Public value.
const GH_CLIENT_ID = process.env.GITHUB_OAUTH_CLIENT_ID || "";
let deviceFlow = null; // single in-flight flow: { device_code, interval }

/** Start device flow: returns the user_code + verification_uri to show the user. */
export async function githubDeviceStart() {
  if (!GH_CLIENT_ID) { const e = new Error("GITHUB_OAUTH_CLIENT_ID is not set on this bot. Register a GitHub OAuth App (device flow enabled) and set its client id."); e.code = 400; throw e; }
  const r = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: GH_CLIENT_ID, scope: "repo" }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.device_code) { const e = new Error(`GitHub device/code failed: ${j.error_description || j.error || `HTTP ${r.status}`}`); e.code = 502; throw e; }
  deviceFlow = { device_code: j.device_code, interval: j.interval || 5 };
  return { user_code: j.user_code, verification_uri: j.verification_uri, interval: j.interval || 5, expires_in: j.expires_in };
}

/** Poll for approval. status: pending | connected | expired | denied. On connected,
 *  stores the token via gh (same place a PAT would go) + sets up the git helper. */
export async function githubDevicePoll() {
  if (!GH_CLIENT_ID) { const e = new Error("GITHUB_OAUTH_CLIENT_ID is not set."); e.code = 400; throw e; }
  if (!deviceFlow) { const e = new Error("no device-login in progress — start one first"); e.code = 400; throw e; }
  const r = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: GH_CLIENT_ID, device_code: deviceFlow.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
  });
  const j = await r.json().catch(() => ({}));
  if (j.access_token) {
    await ghWithStdin(["auth", "login", "--hostname", "github.com", "--with-token", "--insecure-storage"], j.access_token + "\n");
    await execFileAsync("gh", ["auth", "setup-git"], { timeout: 15000 });
    deviceFlow = null;
    const st = await githubStatus();
    return { status: "connected", login: st.login };
  }
  switch (j.error) {
    case "authorization_pending": return { status: "pending" };
    case "slow_down": return { status: "pending", slowDown: true };
    case "expired_token": deviceFlow = null; return { status: "expired" };
    case "access_denied": deviceFlow = null; return { status: "denied" };
    default: return { status: "pending" };
  }
}

export function githubDeviceConfigured() {
  return { configured: !!GH_CLIENT_ID };
}

// --- setup terminals (ttyd → tmux → gh/claude login) -------------------------
// Reuses the bot's ttyd + tmux. Each target serves a gated web terminal running the
// tool's OWN login flow (no PAT / no API key). github → gh auth login; claude →
// claude auth login. Distinct ports/base-paths so both can coexist.
const SHELLS = {
  github: { port: 7990, base: "/shell",        session: "ao-github", script: "gh-login.sh" },
  claude: { port: 7991, base: "/shell-claude", session: "ao-claude", script: "claude-login.sh" },
};
const shellProcs = {}; // which -> ChildProcess

export function shellStart({ which = "github" } = {}) {
  const cfg = SHELLS[which] || SHELLS.github;
  const existing = shellProcs[which];
  if (existing && existing.exitCode === null) return { ok: true, path: cfg.base, reused: true };
  const proc = spawn("ttyd", [
    "-W", "-p", String(cfg.port), "-b", cfg.base,
    "tmux", "new-session", "-A", "-s", cfg.session, "bash", "/app/scripts/" + cfg.script,
  ], { detached: true, stdio: "ignore", env: process.env });
  proc.on("error", () => { shellProcs[which] = null; });
  proc.on("exit", () => { shellProcs[which] = null; });
  proc.unref();
  shellProcs[which] = proc;
  return { ok: true, path: cfg.base };
}

/** claude CLI auth status ({loggedIn, authMethod}) — for the Claude step badge. */
export async function claudeStatus() {
  try {
    const { stdout } = await execFileAsync("claude", ["auth", "status"], { timeout: 10000 });
    const j = JSON.parse(stdout);
    return { loggedIn: !!j.loggedIn, method: j.authMethod || null };
  } catch {
    return { loggedIn: false, method: null };
  }
}

export async function githubConnect({ pat }) {
  if (!pat || !pat.trim()) { const e = new Error("pat required"); e.code = 400; throw e; }
  // --with-token reads the PAT from stdin; --insecure-storage persists it plaintext
  // under GH_CONFIG_DIR (no keyring in the slim image).
  await ghWithStdin(["auth", "login", "--hostname", "github.com", "--with-token", "--insecure-storage"], pat.trim() + "\n");
  // Install gh as git's credential helper so agent `git push` over HTTPS works.
  await execFileAsync("gh", ["auth", "setup-git"], { timeout: 15000 });
  const st = await githubStatus();
  if (!st.connected) { const e = new Error("gh auth did not persist"); e.code = 502; throw e; }
  return st;
}

// Owners the operator can list repos under: their own login + the orgs they belong to.
export async function githubOwners() {
  const me = await execFileAsync("gh", ["api", "user", "--jq", ".login"], { timeout: 15000 });
  const login = me.stdout.trim();
  let orgs = [];
  try {
    const r = await execFileAsync("gh", ["api", "user/orgs", "--jq", ".[].login"], { timeout: 15000 });
    orgs = r.stdout.trim().split("\n").filter(Boolean);
  } catch { /* no orgs / no read:org — just personal */ }
  return { owners: [login, ...orgs], login };
}

export async function githubRepos({ search, owner } = {}) {
  const args = ["repo", "list"];
  if (owner) args.push(owner);        // gh repo list <owner> — omit = personal repos
  args.push("--json", "nameWithOwner,url,updatedAt", "--limit", "200");
  if (search) args.push("--search", search);
  try {
    const { stdout } = await execFileAsync("gh", args, { timeout: 20000 });
    return { repos: JSON.parse(stdout || "[]") };
  } catch (e) {
    const msg = String(e.stderr || e.message || e);
    if (/SAML|SSO|401|403/i.test(msg)) { const err = new Error(`GitHub 403 — your login likely needs SSO authorization for ${owner || "this org"} (authorize it in the org's settings, then retry).`); err.code = 403; throw err; }
    const err = new Error(`gh repo list failed: ${msg}`); err.code = 502; throw err;
  }
}

// --- on-box tokens (agent-secrets.env, 0600) ---------------------------------

function readSecretsFile() {
  const out = {};
  if (!existsSync(SECRETS_FILE)) return out;
  for (const line of readFileSync(SECRETS_FILE, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0) out[t.slice(0, i)] = t.slice(i + 1);
  }
  return out;
}

/** Merge-write on-box tokens. The Claude credential is ROUTED by prefix to the var
 *  claude-code actually reads: sk-ant-oat… → CLAUDE_CODE_OAUTH_TOKEN (subscription,
 *  from `claude setup-token`), sk-ant-api… → ANTHROPIC_API_KEY (API billing). A
 *  non-sk-ant value is rejected (that's how a mangled paste silently broke the agent).
 *  Values are raw (entrypoint reads KEY=VALUE without shell-sourcing) → no newlines. */
export function writeTokens({ linear, anthropic, claude } = {}) {
  const cur = readSecretsFile();
  const clean = (v) => {
    const val = String(v ?? "").trim();
    if (val && /[\r\n]/.test(val)) { const e = new Error("token must not contain newlines"); e.code = 400; throw e; }
    return val;
  };
  const lin = clean(linear);
  if (lin) cur.LINEAR_API_KEY = lin;

  // Accept the Claude token under either param name (UI sends one field).
  const tok = clean(claude) || clean(anthropic);
  if (tok) {
    if (tok.startsWith("sk-ant-oat")) {
      cur.CLAUDE_CODE_OAUTH_TOKEN = tok;
      delete cur.ANTHROPIC_API_KEY;           // OAuth-only: clear any stale/wrong API key
    } else if (tok.startsWith("sk-ant-api")) {
      cur.ANTHROPIC_API_KEY = tok;
      delete cur.CLAUDE_CODE_OAUTH_TOKEN;
    } else {
      const e = new Error("Claude token must start with sk-ant-oat… (from `claude setup-token`) or sk-ant-api… (API key). That doesn't look like either — re-copy the full token.");
      e.code = 400; throw e;
    }
  }
  mkdirSync(DATA_DIR, { recursive: true });
  const body = Object.entries(cur).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  writeFileSync(SECRETS_FILE, body, { mode: 0o600 });
  return tokensPresent();
}

export function tokensPresent() {
  const s = readSecretsFile();
  return { linear: !!s.LINEAR_API_KEY, claude: !!(s.ANTHROPIC_API_KEY || s.CLAUDE_CODE_OAUTH_TOKEN) };
}

// --- Linear teams (for the teamId picker) ------------------------------------

async function linearQuery(key, query, variables) {
  const r = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: key },
    body: JSON.stringify({ query, variables }),
  });
  if (!r.ok) { const e = new Error(`Linear API HTTP ${r.status} (key invalid?)`); e.code = 400; throw e; }
  const j = await r.json();
  if (j.errors) { const e = new Error("Linear API error (key invalid?)"); e.code = 400; throw e; }
  return j.data;
}

export async function linearTeams({ apiKey } = {}) {
  const key = (apiKey && apiKey.trim()) || readSecretsFile().LINEAR_API_KEY;
  if (!key) { const e = new Error("no LINEAR_API_KEY (save it first or pass apiKey)"); e.code = 400; throw e; }
  const data = await linearQuery(key, "{ teams { nodes { id name key } } }");
  return { teams: data?.teams?.nodes || [] };
}

// Labels for the trigger-tag picker. Team-scoped when teamId is given (the poller
// matches by NAME), else the workspace set. Deduped by name.
export async function linearLabels({ apiKey, teamId } = {}) {
  const key = (apiKey && apiKey.trim()) || readSecretsFile().LINEAR_API_KEY;
  if (!key) { const e = new Error("no LINEAR_API_KEY (save it first or pass apiKey)"); e.code = 400; throw e; }
  const ALL = "{ issueLabels(first: 250) { nodes { name } } }";
  let nodes = [];
  try {
    // Team-scoped via issueLabels filter (matches the tracker; avoids team(id:) arg typing).
    const data = teamId
      ? await linearQuery(key, "query($f: IssueLabelFilter) { issueLabels(first: 250, filter: $f) { nodes { name } } }", { f: { team: { id: { eq: teamId } } } })
      : await linearQuery(key, ALL);
    nodes = data?.issueLabels?.nodes || [];
  } catch {
    // Fall back to all workspace labels if the team filter shape is rejected.
    const data = await linearQuery(key, ALL);
    nodes = data?.issueLabels?.nodes || [];
  }
  return { labels: [...new Set(nodes.map((n) => n.name))].sort() };
}

// Workflow states (statuses) for the trigger-status picker. The poller matches by
// NAME. Team-scoped when teamId given; returns {name,type} in Linear's board order.
export async function linearStatuses({ apiKey, teamId } = {}) {
  const key = (apiKey && apiKey.trim()) || readSecretsFile().LINEAR_API_KEY;
  if (!key) { const e = new Error("no LINEAR_API_KEY (save it first or pass apiKey)"); e.code = 400; throw e; }
  const ALL = "{ workflowStates(first: 100) { nodes { name type position } } }";
  let raw = [];
  try {
    const data = teamId
      ? await linearQuery(key, "query($f: WorkflowStateFilter) { workflowStates(first: 100, filter: $f) { nodes { name type position } } }", { f: { team: { id: { eq: teamId } } } })
      : await linearQuery(key, ALL);
    raw = data?.workflowStates?.nodes || [];
  } catch {
    const data = await linearQuery(key, ALL);
    raw = data?.workflowStates?.nodes || [];
  }
  const nodes = raw.slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  // Dedup by name (a team's states are unique by name).
  const seen = new Set();
  const statuses = [];
  for (const n of nodes) { if (!seen.has(n.name)) { seen.add(n.name); statuses.push({ name: n.name, type: n.type }); } }
  return { statuses };
}

// --- project apply (clone + write config; the RESTART is server.mjs's job) ---

function hasOriginClone(dir) {
  try { return statSync(join(dir, ".git")).isDirectory(); } catch { return false; }
}

export async function applyProject({ repo, teamId, label, labels, statusName } = {}) {
  if (!repo || !teamId) { const e = new Error("repo and teamId required"); e.code = 400; throw e; }
  const name = basename(repo);
  const path = join(PROJECTS_DIR, name);
  mkdirSync(PROJECTS_DIR, { recursive: true });
  // Ensure git has gh's credential helper so later fetch/worktree/push (agent PRs)
  // authenticate — the terminal login may not have run this reliably. Idempotent.
  try { await execFileAsync("gh", ["auth", "setup-git"], { timeout: 15000 }); } catch { /* best effort */ }
  if (!hasOriginClone(path)) {
    // `gh repo clone` uses gh's stored token directly (works for SSO org repos,
    // no dependence on the credential helper being pre-configured). Big maxBuffer
    // for clone progress; generous timeout for large repos.
    await execFileAsync("gh", ["repo", "clone", repo, path], { timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
  }
  // Trigger filters: label tag(s) and/or a status name. Without any, the bot would
  // act on every ticket in the team.
  const labelList = labels || (label ? [label] : []);
  const { id } = addProject(CONFIG_PATH, { id: name, repo, path, teamId, labels: labelList, statusName });
  return { id, path, labels: labelList, statusName: statusName || null };
}

/**
 * One-shot "Save & start": pre-flight validate EVERYTHING, then persist tokens +
 * write the yaml + clone. The caller (server.mjs) only restarts the bot on success,
 * so a failed check never restarts into a broken state. Cheap checks first, then
 * network (Linear), then the slow clone.
 */
export async function startBot({ repo, teamId, label, labels, statusName, linear, anthropic } = {}) {
  const bad = (m) => { const e = new Error(m); e.code = 400; throw e; };
  const gh = await githubStatus();
  if (!gh.connected) bad("Connect GitHub first.");
  if (!repo) bad("Pick a repository.");
  if (!teamId) bad("Pick a Linear team.");

  const stored = readSecretsFile();
  const linearKey = (linear && linear.trim()) || stored.LINEAR_API_KEY;
  if (!linearKey) bad("Linear API key required.");
  const claudeKey = (anthropic && anthropic.trim()) || stored.ANTHROPIC_API_KEY || stored.CLAUDE_CODE_OAUTH_TOKEN;
  const claudeLoggedIn = (await claudeStatus()).loggedIn;
  if (!claudeKey && !claudeLoggedIn) bad("Sign in to Claude (or paste an Anthropic API key).");

  // Validate the Linear key + that the chosen team actually exists under it.
  const { teams } = await linearTeams({ apiKey: linearKey });
  if (!teams.some((t) => t.id === teamId)) bad("That team isn't in this Linear workspace — re-check the key/team.");

  // All checks passed → persist tokens, then clone + write the yaml.
  writeTokens({ linear, anthropic });
  const res = await applyProject({ repo, teamId, label, labels, statusName });
  return { ...res, ok: true };
}

// --- aggregate wizard state --------------------------------------------------

export async function setupState() {
  const github = await githubStatus();
  github.deviceConfigured = !!GH_CLIENT_ID;
  const first = getFirstProject(CONFIG_PATH);
  const tokens = tokensPresent();
  const claudeAuth = await claudeStatus();
  const worker = first?.project?.path ? workerStatus(CONFIG_PATH, first.project.path) : { running: false, pid: null };
  return {
    github,
    linear: tokens.linear,
    claude: tokens.claude || claudeAuth.loggedIn,
    project: first ? { id: first.id, repo: first.project.repo, path: first.project.path } : null,
    worker,
    draft: readDraft(),
  };
}

export const paths = { CONFIG_PATH, DATA_DIR, SECRETS_FILE, PROJECTS_DIR };
