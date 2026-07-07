// Co-located admin backend. Binds 0.0.0.0:AO_ADMIN_PORT (compose-net only);
// Caddy gates /admin/api/* with Google auth before it reaches here.
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chooseSource, secretNames } from "../scripts/resolve-secrets.mjs";
import { buildAddVersionRequest, isValidSecret } from "./secrets-writer.mjs";
import {
  setupState, githubConnect, githubRepos, githubOwners, githubDeviceStart, githubDevicePoll, shellStart,
  linearTeams, linearLabels, linearStatuses, writeTokens, saveDraft, startBot,
} from "./wizard.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.AO_ADMIN_PORT || 8090);
const REPO = process.env.AO_RELEASES_REPO || "ComposioHQ/agent-orchestrator";

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(body);
}
async function readBody(req) {
  let s = ""; for await (const c of req) s += c;
  return s ? JSON.parse(s) : {};
}
async function gcpToken() {
  if (process.env.AO_GCP_ACCESS_TOKEN) return process.env.AO_GCP_ACCESS_TOKEN;
  try {
    const { stdout } = await execFileAsync("gcloud", ["auth", "print-access-token"], { timeout: 15000 });
    if (stdout.trim()) return stdout.trim();
  } catch { /* fall through */ }
  const r = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } });
  if (!r.ok) throw new Error("no GCP token available");
  return (await r.json()).access_token;
}

async function getVersion() {
  let running = "unknown";
  try { const { stdout } = await execFileAsync("ao", ["--version"], { timeout: 10000 }); running = stdout.trim(); } catch {}
  let latest = null;
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`,
      { headers: { "accept": "application/vnd.github+json", "user-agent": "ao-admin" } });
    if (r.ok) latest = (await r.json()).tag_name || null;
  } catch {}
  // Normalize the release tag (strip a leading "v") before the substring check,
  // since `ao --version` may print the bare number while the tag is "vX.Y.Z".
  const normLatest = latest ? latest.replace(/^v/, "") : null;
  const updateAvailable = normLatest && !running.includes(normLatest) ? true : (latest ? false : null);
  return { running, latest, updateAvailable };
}

async function triggerUpdate() {
  const token = process.env.WATCHTOWER_TOKEN || "changeme-local";
  // Watchtower's /v1/update requires POST + Bearer (a GET is rejected).
  const r = await fetch("http://watchtower:8080/v1/update",
    { method: "POST", headers: { "Authorization": `Bearer ${token}` } });
  return { status: r.status, ok: r.ok };
}

async function rotateSecret(body) {
  const { secret, value } = body || {};
  if (!isValidSecret(secret)) { const e = new Error(`unknown secret (valid: ${secretNames().join(", ")})`); e.code = 400; throw e; }
  if (chooseSource(process.env) !== "gcp") { const e = new Error("rotation requires the gcp secret source (AO_GCP_PROJECT)"); e.code = 400; throw e; }
  const project = process.env.AO_GCP_PROJECT;
  const { url, body: reqBody } = buildAddVersionRequest(project, secret, value);
  const token = await gcpToken();
  const r = await fetch(url, { method: "POST", headers: { "Authorization": `Bearer ${token}`, "content-type": "application/json" }, body: reqBody });
  if (!r.ok) { const e = new Error(`Secret Manager addVersion failed: HTTP ${r.status}`); e.code = 502; throw e; }
  const j = await r.json();
  return { secret, version: j.name || null, note: "applies on next restart" };
}

// After a successful project apply we bounce the container: `ao start`'s dashboard
// (start-all, PID 1) reads LINEAR_API_KEY at request time and the entrypoint starts
// the lifecycle-worker on boot, so a restart is how new config+tokens take effect.
// restart: unless-stopped brings the container back. Delay so the HTTP response
// flushes first. SIGTERM PID 1 → start-all's own cleanup → clean exit → restart.
function scheduleRestart() {
  setTimeout(() => { try { process.kill(1, "SIGTERM"); } catch {} }, 750);
}

function serveSetupPage(res) {
  try {
    const html = readFileSync(join(__dirname, "setup.html"), "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  } catch {
    send(res, 500, { error: "setup page missing" });
  }
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const { pathname } = url;
    const GET = req.method === "GET", POST = req.method === "POST";

    // --- ops (M5) ---
    if (GET && pathname === "/admin/api/version") return send(res, 200, await getVersion());
    if (POST && pathname === "/admin/api/update") return send(res, 200, await triggerUpdate());
    if (POST && pathname === "/admin/api/secrets") return send(res, 200, await rotateSecret(await readBody(req)));

    // --- setup wizard (M-B) ---
    if (GET && pathname === "/admin/api/setup") return send(res, 200, await setupState());
    if (POST && pathname === "/admin/api/github/connect") return send(res, 200, await githubConnect(await readBody(req)));
    if (POST && pathname === "/admin/api/github/device/start") return send(res, 200, await githubDeviceStart());
    if (POST && pathname === "/admin/api/github/device/poll") return send(res, 200, await githubDevicePoll());
    if (POST && pathname === "/admin/api/shell/start") return send(res, 200, shellStart(await readBody(req)));
    if (GET && pathname === "/admin/api/github/owners") return send(res, 200, await githubOwners());
    if (GET && pathname === "/admin/api/github/repos") return send(res, 200, await githubRepos({ search: url.searchParams.get("search") || undefined, owner: url.searchParams.get("owner") || undefined }));
    if (POST && pathname === "/admin/api/linear/teams") return send(res, 200, await linearTeams(await readBody(req)));
    if (POST && pathname === "/admin/api/linear/labels") return send(res, 200, await linearLabels(await readBody(req)));
    if (POST && pathname === "/admin/api/linear/statuses") return send(res, 200, await linearStatuses(await readBody(req)));
    if (POST && pathname === "/admin/api/tokens") return send(res, 200, writeTokens(await readBody(req)));
    if (POST && pathname === "/admin/api/draft") return send(res, 200, saveDraft(await readBody(req)));
    // Save & start: validate everything, write tokens + yaml + clone, THEN restart.
    // scheduleRestart runs only after a 200 — a failed pre-flight throws → no restart.
    if (POST && pathname === "/admin/api/start") {
      const result = await startBot(await readBody(req));
      send(res, 200, { ...result, restarting: true });
      return scheduleRestart();
    }

    // --- the wizard page itself (Caddy routes /setup* here, gated) ---
    if (GET && (pathname === "/setup" || pathname === "/setup/")) return serveSetupPage(res);

    return send(res, 404, { error: "not found" });
  } catch (e) {
    // e.code may be a subprocess EXIT code (e.g. git=128) or a string (ENOENT) —
    // never a valid HTTP status. Only honor a real 4xx/5xx; else 500. (An invalid
    // status made res.writeHead emit a broken response → Caddy 502 "unexpected EOF".)
    const code = Number.isInteger(e.code) && e.code >= 400 && e.code <= 599 ? e.code : 500;
    return send(res, code, { error: String(e.message || e) });
  }
}).listen(PORT, "0.0.0.0", () => console.log(`[admin] listening on :${PORT}`));
